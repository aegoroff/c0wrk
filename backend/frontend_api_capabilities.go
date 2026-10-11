package backend

import (
	"errors"
	"fmt"

	"github.com/v0lka/c0wrk/backend/config"
)

// The capabilities section identifiers accepted by UpdateCapabilityModes.
// The per-context MODE values reuse the MCP server enum (config.MCPServerMode*
// via config.ValidMCPServerMode) — the capabilities section deliberately has
// no enum of its own.
const (
	CapabilitySectionSkills = "skills"
	CapabilitySectionAgents = "agents"
	CapabilitySectionMCP    = "mcp"
)

// CapabilityModesInfo is the wire shape of one capability entry: the
// activation mode per context. Both fields are always populated with a
// canonical enum value ("auto" | "manual" | "disabled") — a missing entry
// reads as "auto"/"auto", never as an omitted key.
type CapabilityModesInfo struct {
	ChatMode string `json:"chat_mode"`
	CodeMode string `json:"code_mode"`
}

// CapabilitiesInfo is the GetCapabilityModes wire shape: the three
// capability sections keyed by capability name. The maps are never nil, so
// the frontend receives empty objects rather than nulls.
type CapabilitiesInfo struct {
	Skills map[string]CapabilityModesInfo `json:"skills"`
	Agents map[string]CapabilityModesInfo `json:"agents"`
	MCP    map[string]CapabilityModesInfo `json:"mcp"`
}

// capabilitiesSnapshot is a coherent copy of the config's capabilities
// section plus the configured MCP server names, taken under a single
// configMu read lock so the two views cannot straddle a concurrent
// reconfigure.
type capabilitiesSnapshot struct {
	caps config.CapabilitiesConfig
	// mcpServers carries a copy of the capabilities.mcp section with stale
	// names (servers no longer configured) already removed — the load
	// pipeline keeps the stored section clean, so this only guards against
	// configs built in memory (tests, future in-process writers).
	mcp map[string]config.CapabilityModes
}

// capabilitiesSnapshot returns the deep-copied capabilities view. Safe on a
// nil config: every map comes back empty (never nil).
func (f *FrontendAPI) capabilitiesSnapshot() capabilitiesSnapshot {
	f.configMu.RLock()
	defer f.configMu.RUnlock()
	return capabilitiesSnapshot{
		caps: config.CapabilitiesConfig{
			Skills: copyCapabilityModesMap(f.configCapSkills()),
			Agents: copyCapabilityModesMap(f.configCapAgents()),
		},
		mcp: f.configMCPCapsCopy(),
	}
}

// configMCPCapsCopy returns a copy of the capabilities.mcp section with
// stale names (servers no longer configured) already removed — the same
// staleness rule the load normalization (normalizeCapabilities) applies —
// so the read surface can never resurrect a deleted server's entry.
// Callers MUST hold configMu; reading a nil section yields an empty map.
func (f *FrontendAPI) configMCPCapsCopy() map[string]config.CapabilityModes {
	out := make(map[string]config.CapabilityModes, len(f.configCapMCP()))
	for name, modes := range f.configCapMCP() {
		if _, known := f.configMCPServerNames()[name]; !known {
			continue
		}
		out[name] = modes
	}
	return out
}

// The configCap* accessors read the raw sections. They exist so the snapshot
// builder stays readable; callers MUST hold configMu.

func (f *FrontendAPI) configCapSkills() map[string]config.CapabilityModes {
	if f.config == nil {
		return nil
	}
	return f.config.Capabilities.Skills
}

func (f *FrontendAPI) configCapAgents() map[string]config.CapabilityModes {
	if f.config == nil {
		return nil
	}
	return f.config.Capabilities.Agents
}

func (f *FrontendAPI) configCapMCP() map[string]config.CapabilityModes {
	if f.config == nil {
		return nil
	}
	return f.config.Capabilities.MCP
}

// configMCPServerNames returns the configured MCP server names as a set.
// Callers MUST hold configMu; reading a nil map yields an empty set.
func (f *FrontendAPI) configMCPServerNames() map[string]bool {
	names := make(map[string]bool, len(f.configMCPServers()))
	for name := range f.configMCPServers() {
		names[name] = true
	}
	return names
}

func (f *FrontendAPI) configMCPServers() map[string]config.MCPServerConfig {
	if f.config == nil {
		return nil
	}
	return f.config.MCP.Servers
}

func copyCapabilityModesMap(m map[string]config.CapabilityModes) map[string]config.CapabilityModes {
	out := make(map[string]config.CapabilityModes, len(m))
	for name, modes := range m {
		out[name] = modes
	}
	return out
}

// GetCapabilityModes returns the normalized capabilities section — the
// per-context activation modes for skills, agents and MCP servers. Values
// are canonical enum members (empty resolves to "auto"); capabilities.mcp
// names are always resolvable against mcp.servers. Returns empty (never
// nil) sections if config is not initialized.
func (f *FrontendAPI) GetCapabilityModes() CapabilitiesInfo {
	snap := f.capabilitiesSnapshot()
	return CapabilitiesInfo{
		Skills: capabilityModesInfo(snap.caps.Skills),
		Agents: capabilityModesInfo(snap.caps.Agents),
		MCP:    capabilityModesInfo(snap.mcp),
	}
}

// capabilityModesInfo renders a section for the wire: normalized values,
// non-nil map.
func capabilityModesInfo(m map[string]config.CapabilityModes) map[string]CapabilityModesInfo {
	out := make(map[string]CapabilityModesInfo, len(m))
	for name, modes := range m {
		out[name] = CapabilityModesInfo{
			ChatMode: config.NormalizeMCPServerMode(modes.ChatMode),
			CodeMode: config.NormalizeMCPServerMode(modes.CodeMode),
		}
	}
	return out
}

// UpdateCapabilityModes replaces one capabilities section wholesale:
// kind selects skills, agents or mcp, modes maps capability names to their
// per-context activation modes. The section is a REPLACEMENT, not a merge —
// names absent from the payload lose their entry and fall back to "auto".
//
// Validation is the strict save-path gate (config.ValidateCapabilities): any
// non-empty chat_mode / code_mode that is not a recognized enum member
// (config.ValidMCPServerMode — the same constants the load path normalizes
// fail-soft) rejects the whole update, because Save does not run validate()
// and a bad value would otherwise only surface at the next launch.
//
// Structural rules mirror the load normalization rather than erroring:
// capabilities.mcp names outside mcp.servers are trimmed (stale — the
// server was deleted or renamed), and entries whose values are both empty
// are dropped (no explicit value to store). The remainder is normalized
// (empty → "auto") exactly like normalizeCapabilities, then persisted
// through the common config pipeline and republished to the live builder
// (UpdateCapabilities — a pure in-memory snapshot write), so the change
// reaches running orchestrators at their next task entry. No gateway
// reconfiguration: the MCP server SET is unchanged, and mode edits are
// policy, not topology (ADR-084) — a newly both-disabled server stays
// dialed until the next full reconfigure or restart, by design.
func (f *FrontendAPI) UpdateCapabilityModes(kind string, modes map[string]CapabilityModesInfo) error {
	converted := make(map[string]config.CapabilityModes, len(modes))
	for name, m := range modes {
		converted[name] = config.CapabilityModes{ChatMode: m.ChatMode, CodeMode: m.CodeMode}
	}
	var candidate config.CapabilitiesConfig
	switch kind {
	case CapabilitySectionSkills:
		candidate.Skills = converted
	case CapabilitySectionAgents:
		candidate.Agents = converted
	case CapabilitySectionMCP:
		candidate.MCP = converted
	default:
		return fmt.Errorf("unknown capability kind %q: must be %q, %q or %q",
			kind, CapabilitySectionSkills, CapabilitySectionAgents, CapabilitySectionMCP)
	}
	if err := config.ValidateCapabilities(&candidate); err != nil {
		return fmt.Errorf("invalid capability modes for %q: %w", kind, err)
	}

	f.saveMu.Lock()
	defer f.saveMu.Unlock()

	f.configMu.Lock()
	defer f.configMu.Unlock()

	if f.config == nil {
		return errors.New("config not initialized")
	}

	mcpServers := f.configMCPServerNames()
	cleaned := make(map[string]config.CapabilityModes, len(converted))
	for name, m := range converted {
		if kind == CapabilitySectionMCP {
			if _, known := mcpServers[name]; !known {
				continue // stale name: trimmed, mirroring the load path
			}
		}
		if m.ChatMode == "" && m.CodeMode == "" {
			continue // both-empty: no explicit value, dropped
		}
		cleaned[name] = config.CapabilityModes{
			ChatMode: config.NormalizeMCPServerMode(m.ChatMode),
			CodeMode: config.NormalizeMCPServerMode(m.CodeMode),
		}
	}
	if len(cleaned) == 0 {
		cleaned = nil // an empty section disappears from YAML entirely
	}
	switch kind {
	case CapabilitySectionSkills:
		f.config.Capabilities.Skills = cleaned
	case CapabilitySectionAgents:
		f.config.Capabilities.Agents = cleaned
	case CapabilitySectionMCP:
		f.config.Capabilities.MCP = cleaned
	}

	if err := f.persistConfig(); err != nil {
		f.log().Warn("failed to persist capability modes", "error", err)
	}

	// Publish the edited modes to the live builder while configMu is still
	// held — the same discipline as the UpdateSecurityPolicies push in
	// UpdateSecuritySettings. Orchestrators read modes from the builder's
	// immutable snapshots at task entry via the resolver getters, so without
	// this push a saved change would not take effect until the next app
	// restart. The publication is a bounded in-memory write (no network, no
	// readiness wait), so it stays inside the lock; a builder that is not up
	// yet is a no-op — construction projects the same section from the
	// persisted config.
	if b := f.builder(); b != nil {
		b.UpdateCapabilities(f.toBuilderConfigLocked())
	}

	return nil
}
