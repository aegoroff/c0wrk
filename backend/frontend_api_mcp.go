package backend

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
	sdktools "github.com/v0lka/sp4rk/tools"
	"github.com/v0lka/sp4rk/tools/mcp"
)

// MCPServerStatusInfo is the GetMCPStatus wire shape: the live gateway
// status of one server plus its configured per-context activation modes —
// a c0wrk-level concept the sp4rk ServerStatus does not carry. The embedded
// status keeps its JSON keys (embedding flattens), so chat_mode / code_mode
// are the only additions and existing frontend payloads stay valid.
type MCPServerStatusInfo struct {
	mcp.ServerStatus
	// ChatMode / CodeMode are the normalized capabilities.mcp.<name>
	// activation modes for the two contexts ("auto" | "manual" | "disabled";
	// the legacy single mode folded into both). Always set by the merge;
	// "auto"/"auto" only on the synthetic gateway-starting placeholder,
	// which the frontend renders by its `starting` flag anyway.
	ChatMode string `json:"chat_mode"`
	CodeMode string `json:"code_mode"`
}

// mcpCapabilityModes resolves the normalized per-context activation modes
// for one server name from the capabilities.mcp section. A missing entry or
// empty field resolves to "auto", matching the load pipeline; entries whose
// name is outside mcp.servers cannot reach here (the load path drops them)
// and are treated exactly like a missing entry.
func mcpCapabilityModes(caps map[string]config.CapabilityModes, name string) (chatMode, codeMode string) {
	modes := caps[name]
	return config.NormalizeMCPServerMode(modes.ChatMode), config.NormalizeMCPServerMode(modes.CodeMode)
}

// mcpModesDisabled reports whether BOTH per-context modes are "disabled" —
// the only combination under which the server is never dialed and renders
// neutrally. A single disabled context keeps the server live for the other
// one, so the live status stays meaningful.
func mcpModesDisabled(chatMode, codeMode string) bool {
	return chatMode == config.MCPServerModeDisabled && codeMode == config.MCPServerModeDisabled
}

// GetMCPStatus returns the status of every CONFIGURED MCP server so the
// settings UI always renders the full configuration, unavailable servers
// included (shown with a red indicator). Configured names missing from the
// live gateway status — the gateway is missing entirely, failed to start, or
// dropped a server — are synthesized as disconnected entries. A DISABLED
// server is rendered NEUTRALLY instead: it is intentionally not dialed, so
// it never surfaces as an error/unavailable state (see
// mergeConfiguredMCPServers). While gateway startup is still in flight (the
// "_gateway" starting placeholder) nothing is merged: availability is
// genuinely unknown, and the frontend refreshes on the mcp:ready event once
// startup completes. The configured servers and their modes are captured
// under a single configMu read lock (mcpConfigSnapshot), so the merged
// response always reflects one moment of the config.
// Returns an empty slice if the backend application is not initialized.
func (f *FrontendAPI) GetMCPStatus() []MCPServerStatusInfo {
	if f.appCell() == nil {
		return []MCPServerStatusInfo{}
	}
	status := f.app.GetMCPStatus()
	if isMCPStartupPlaceholder(status) {
		// Preserve the placeholder verbatim (no config merge — availability
		// is unknown while startup is in flight).
		out := make([]MCPServerStatusInfo, len(status))
		for i, s := range status {
			out[i] = MCPServerStatusInfo{ServerStatus: s, ChatMode: config.MCPServerModeAuto, CodeMode: config.MCPServerModeAuto}
		}
		return out
	}
	configured, caps := f.mcpConfigSnapshot()
	return mergeConfiguredMCPServers(status, configured, caps)
}

// isMCPStartupPlaceholder reports whether status is the synthetic
// gateway-starting placeholder Application.GetMCPStatus returns while the MCP
// startup goroutine is still running.
func isMCPStartupPlaceholder(status []mcp.ServerStatus) bool {
	return len(status) == 1 && status[0].Name == "_gateway" && status[0].Starting
}

// mergeConfiguredMCPServers enriches the live gateway status with the
// configured per-context activation modes (capabilities.mcp.<name>),
// appends a synthesized entry for every configured server absent from
// status, then sorts the result by name. This keeps the settings list a
// mirror of the configuration even when the gateway cannot report a server
// itself (failed startup, gateway missing, config ahead of a failed
// reconfigure).
//
// A server disabled in BOTH contexts is INERT, not broken, and must render
// neutrally:
//   - a configured-but-absent name synthesizes an entry WITHOUT the usual
//     "unavailable" error (absence is exactly what "never dialed" produces);
//   - a name a stale gateway still reports (a reconfigure that failed
//     mid-flight can leave the old connection behind) is neutralized — the
//     config modes are authoritative, so connected/tools/error are cleared
//     and the frontend renders the entry by its modes instead of a
//     live-looking or red state.
func mergeConfiguredMCPServers(status []mcp.ServerStatus, configured map[string]config.MCPServerConfig, caps map[string]config.CapabilityModes) []MCPServerStatusInfo {
	merged := make([]MCPServerStatusInfo, 0, len(status)+len(configured))
	present := make(map[string]bool, len(status))
	for _, s := range status {
		present[s.Name] = true
		chatMode, codeMode := mcpCapabilityModes(caps, s.Name)
		info := MCPServerStatusInfo{ServerStatus: s, ChatMode: chatMode, CodeMode: codeMode}
		if mcpModesDisabled(chatMode, codeMode) {
			info.Connected = false
			info.Unhealthy = false
			info.Starting = false
			info.ToolCount = 0
			info.Tools = []string{}
			info.Error = ""
		}
		merged = append(merged, info)
	}
	for name, cfg := range configured {
		if present[name] {
			continue
		}
		transport := cfg.Transport
		if transport == "" {
			transport = "stdio"
		}
		chatMode, codeMode := mcpCapabilityModes(caps, name)
		entry := mcp.ServerStatus{
			Name:      name,
			Transport: transport,
			Connected: false,
			Tools:     []string{},
			Error:     "unavailable",
		}
		// Intentionally not dialed — absent from the gateway BY DESIGN, so
		// the entry carries no failure state for the UI to render red.
		if mcpModesDisabled(chatMode, codeMode) {
			entry.Error = ""
		}
		merged = append(merged, MCPServerStatusInfo{ServerStatus: entry, ChatMode: chatMode, CodeMode: codeMode})
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].Name < merged[j].Name })
	return merged
}

// GetMCPServers returns the current MCP server configurations.
// Returns an empty map if config is not initialized.
func (f *FrontendAPI) GetMCPServers() map[string]config.MCPServerConfig {
	f.configMu.RLock()
	defer f.configMu.RUnlock()
	return f.configMCPServersCopy()
}

// configMCPServersCopy deep-copies the configured MCP servers (args, env and
// headers cloned) so the map can leave the config lock without exposing the
// live config to external modification. Callers MUST hold configMu; a nil
// config yields an empty map.
func (f *FrontendAPI) configMCPServersCopy() map[string]config.MCPServerConfig {
	servers := f.configMCPServers()
	result := make(map[string]config.MCPServerConfig, len(servers))
	for name, cfg := range servers {
		srv := cfg
		if cfg.Args != nil {
			srv.Args = make([]string, len(cfg.Args))
			copy(srv.Args, cfg.Args)
		}
		if cfg.Env != nil {
			srv.Env = make(map[string]string, len(cfg.Env))
			for ek, ev := range cfg.Env {
				srv.Env[ek] = ev
			}
		}
		if cfg.Headers != nil {
			srv.Headers = make(map[string]string, len(cfg.Headers))
			for hk, hv := range cfg.Headers {
				srv.Headers[hk] = hv
			}
		}
		result[name] = srv
	}
	return result
}

// mcpConfigSnapshot returns a coherent one-lock view of the configured MCP
// servers (deep-copied) and their capabilities.mcp activation modes (stale
// names removed). Both maps are captured under a single configMu read lock,
// so a concurrent UpdateMCPServers / UpdateCapabilityModes cannot land
// between them and make a consumer merge servers from one moment with modes
// from another. Safe on a nil config: both maps come back empty (never nil).
func (f *FrontendAPI) mcpConfigSnapshot() (servers map[string]config.MCPServerConfig, caps map[string]config.CapabilityModes) {
	f.configMu.RLock()
	defer f.configMu.RUnlock()
	return f.configMCPServersCopy(), f.configMCPCapsCopy()
}

// MCPMentionableServer is the minimal identity of one configured MCP server
// for the chat input's @-completion and the send path: name plus the
// per-context activation modes (capabilities.mcp.<name>). It deliberately
// carries NOTHING else — command args, env and headers can embed secrets,
// and none of them is needed to mention a server. The modes let the
// consumer decide mentionability (chat manual servers are the
// mention-triggered ones; disabled in both contexts are inert) without
// another round-trip.
type MCPMentionableServer struct {
	Name     string `json:"name"`
	ChatMode string `json:"chat_mode"`
	CodeMode string `json:"code_mode"`
}

// GetMCPMentionableServers returns every configured MCP server as a
// secret-free {name, chat_mode, code_mode} triple, sorted by name. It is the
// lightweight read behind the chat-input completion and the send path — no
// transport details, no gateway status, no credentials. Modes are normalized
// (empty/invalid resolve to "auto"), matching the load pipeline. Servers and
// modes are captured under a single configMu read lock (mcpConfigSnapshot),
// so the listing always reflects one moment of the config.
// Returns an empty slice if config is not initialized.
func (f *FrontendAPI) GetMCPMentionableServers() []MCPMentionableServer {
	servers, caps := f.mcpConfigSnapshot()
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]MCPMentionableServer, 0, len(names))
	for _, name := range names {
		chatMode, codeMode := mcpCapabilityModes(caps, name)
		out = append(out, MCPMentionableServer{
			Name:     name,
			ChatMode: chatMode,
			CodeMode: codeMode,
		})
	}
	return out
}

// GetToolList returns all registered tools with source, security group, and
// effective policy info. System-group tools (internal orchestration tools)
// are filtered out — classification is by the descriptor's group, never by
// tool name. The policy is read from the LIVE registry group-policy map (the
// same map Execute consults), so the list reflects what is actually enforced
// after runtime updates, not a re-derivation from config.
func (f *FrontendAPI) GetToolList() []ToolInfo {
	if f.appCell() == nil {
		return []ToolInfo{}
	}

	// Descriptors and effective group policies from the backend application.
	return buildToolInfos(f.app.ListTools(), f.app.GroupPolicies())
}

// buildToolInfos converts tool descriptors into frontend ToolInfo entries,
// skipping system-group tools. A group without a configured entry fails safe
// to user_confirm — mirroring the registry's own resolution.
func buildToolInfos(
	descriptors []sdktools.ToolDescriptor,
	policies map[sdktools.ToolGroup]sdktools.ToolPolicy,
) []ToolInfo {
	toolInfos := make([]ToolInfo, 0, len(descriptors))
	for _, desc := range descriptors {
		// Filter out internal (system-group) tools.
		if desc.Group == sdktools.GroupSystem {
			continue
		}

		toolInfos = append(toolInfos, ToolInfo{
			Name:        desc.Name,
			Description: desc.Description,
			Source:      desc.Source,
			Group:       string(desc.Group),
			Policy:      effectiveGroupPolicy(policies, desc.Group),
		})
	}

	return toolInfos
}

// effectiveGroupPolicy renders the effective policy for a tool group as the
// config enum string ("allow"|"user_confirm"|"deny"). Missing entries and
// unrecognized values fail safe to user_confirm, exactly like
// core/tools.ToolRegistry.groupPolicy (a raw map index is NOT enough — the
// ToolPolicy zero value is PolicyAlwaysAllow, so an absent group would
// otherwise render as "allow").
func effectiveGroupPolicy(policies map[sdktools.ToolGroup]sdktools.ToolPolicy, group sdktools.ToolGroup) string {
	if p, ok := policies[group]; ok {
		switch p {
		case sdktools.PolicyAlwaysAllow:
			return config.GroupPolicyAllow
		case sdktools.PolicyAlwaysDeny:
			return config.GroupPolicyDeny
		}
	}
	return config.GroupPolicyUserConfirm
}

// mcpReconfigureTimeout bounds the propagation phase of an MCP server config
// change. It matches the budget proxyRebuildTimeout and runMCPInit give MCP
// work: ReconfigureMCP reconnects every changed server and retries every
// previously-failed one, and a failed HTTP server is retried with no
// deadline of its own.
const mcpReconfigureTimeout = 30 * time.Second

// UpdateMCPServers updates MCP server configuration and hot-reloads the
// gateway. The payload is a full replacement of mcp.servers; a server absent
// from it is deleted, and its capabilities.mcp entry is trimmed with it so
// no stored modes outlive their server.
//
// Locking contract (mirrors UpdateProxySettings): saveMu serializes whole
// save sequences, while configMu is held only for the field mutation and the
// disk write — never across the ReconfigureMCP propagation. Reconfigure
// reconnects every changed server and retries every previously-failed one
// with no deadline of its own; holding the configMu WRITE lock across it
// blocks every concurrent GetConfig and — because Go's RWMutex stops
// admitting readers once a writer is queued — freezes the whole settings
// dialog for as long as the reconfigure takes (observed at 169 s when an
// unreachable endpoint was retried). The disk write stays inside the lock:
// it is a bounded local atomic rewrite.
func (f *FrontendAPI) UpdateMCPServers(servers map[string]config.MCPServerConfig) error {
	// Validate config first
	for name, cfg := range servers {
		if err := validateMCPServerConfig(name, cfg); err != nil {
			return fmt.Errorf("invalid config for server %q: %w", name, err)
		}
	}

	f.saveMu.Lock()
	defer f.saveMu.Unlock()

	f.configMu.Lock()
	if f.config == nil {
		f.configMu.Unlock()
		return errors.New("config not initialized")
	}

	// Deep-copy the servers map to avoid external modifications
	newMCP := make(map[string]config.MCPServerConfig, len(servers))
	for name, cfg := range servers {
		srv := cfg
		// The wire format no longer carries mode (json:"-"), so a Wails
		// caller cannot set it; wiping it here also keeps a Go-native caller
		// from resurrecting the legacy YAML key — activation modes live in
		// capabilities.mcp now (UpdateCapabilityModes).
		srv.Mode = ""
		if cfg.Args != nil {
			srv.Args = make([]string, len(cfg.Args))
			copy(srv.Args, cfg.Args)
		}
		if cfg.Env != nil {
			srv.Env = make(map[string]string, len(cfg.Env))
			for ek, ev := range cfg.Env {
				srv.Env[ek] = ev
			}
		}
		if cfg.Headers != nil {
			srv.Headers = make(map[string]string, len(cfg.Headers))
			for hk, hv := range cfg.Headers {
				srv.Headers[hk] = hv
			}
		}
		newMCP[name] = srv
	}
	f.config.MCP.Servers = newMCP

	// capabilities.mcp is keyed by server name, and the replacement above
	// orphans the entry of every server the payload dropped (a nil payload
	// orphans all of them). Trim the stale names before persisting — Save
	// writes the section verbatim, so a deleted server's modes would
	// otherwise survive on disk and silently re-attach to a future server
	// of the same name. Survivors keep their stored modes; an emptied
	// section becomes nil so it disappears from the YAML entirely, the same
	// shape the load normalization and UpdateCapabilityModes leave it in.
	validModes := make(map[string]config.CapabilityModes, len(f.config.Capabilities.MCP))
	for name, modes := range f.config.Capabilities.MCP {
		if _, known := newMCP[name]; known {
			validModes[name] = modes
		}
	}
	if len(validModes) == 0 {
		validModes = nil
	}
	f.config.Capabilities.MCP = validModes

	// Persist config
	if err := f.persistConfig(); err != nil {
		f.log().Warn("failed to persist MCP server settings", "error", err)
	}

	// Snapshot what the reconfigure needs while the lock is still held; after
	// the unlock f.config must only be touched under configMu again.
	b := f.builder()
	bcfg := f.toBuilderConfigLocked()
	f.configMu.Unlock()

	// --- Heavy work below runs OUTSIDE configMu (readers stay responsive) ---
	// saveMu is still held, so concurrent UpdateMCPServers calls are
	// serialized and a later save never propagates before an earlier one.
	//
	// The propagation is bounded: ReconfigureMCP hands this context to the
	// gateway reconfigure, whose server.Connect honours it, so one
	// unreachable endpoint can no longer stall the update (and the dialog)
	// indefinitely.
	if b != nil {
		reconfigureCtx, cancel := context.WithTimeout(context.Background(), mcpReconfigureTimeout)
		err := b.ReconfigureMCP(reconfigureCtx, bcfg)
		cancel()
		if err != nil {
			return fmt.Errorf("failed to reconfigure MCP gateway: %w", err)
		}
	}

	return nil
}

// validateMCPServerConfig validates a single MCP server configuration.
func validateMCPServerConfig(name string, cfg config.MCPServerConfig) error {
	transport := cfg.Transport
	if transport == "" {
		transport = "stdio" // default
	}

	switch transport {
	case "stdio":
		if cfg.Command == "" {
			return fmt.Errorf("server %q: stdio transport requires a command", name)
		}
	case "http":
		if cfg.URL == "" {
			return fmt.Errorf("server %q: http transport requires a URL", name)
		}
	default:
		return fmt.Errorf("server %q: unsupported transport: %q", name, transport)
	}

	// Activation modes are not validated here: the wire format no longer
	// carries mode, and the per-context values are validated on their own
	// save path (UpdateCapabilityModes → config.ValidateCapabilities).

	if err := validateMCPTimeout(name, "timeout", cfg.Timeout); err != nil {
		return err
	}
	if err := validateMCPTimeout(name, "call_timeout", cfg.CallTimeout); err != nil {
		return err
	}

	return nil
}

// validateMCPTimeout rejects a non-empty timeout / call_timeout that does not
// parse as a Go duration or is non-positive. Empty is allowed — the server
// falls back to the mcp package default (and call_timeout to timeout). Shares
// the duration rule with the load path and the builder adapter through
// config.ParseMCPDuration, so all three agree on exactly which values are valid.
func validateMCPTimeout(name, field, raw string) error {
	if _, err := config.ParseMCPDuration(raw); err != nil {
		return fmt.Errorf("server %q: invalid %s %q: %w", name, field, raw, err)
	}
	return nil
}
