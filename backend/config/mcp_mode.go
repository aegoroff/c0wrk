package config

import (
	"fmt"
	"sort"
)

// Per-server MCP activation modes (`mcp.servers.<name>.mode`).
const (
	// MCPServerModeAuto connects the server whenever the MCP gateway starts
	// or reconfigures — the behavior of every server before the mode existed
	// and the effective value for an omitted or empty key.
	MCPServerModeAuto = "auto"
	// MCPServerModeManual keeps the server's configuration live and surfaces
	// it as mentionable (GetMCPMentionableServers) for the chat-input
	// completion / send flow instead of treating it as always-on.
	MCPServerModeManual = "manual"
	// MCPServerModeDisabled never dials the server: it is skipped entirely
	// when the gateway config is built, so no process is spawned and no
	// connection is opened — neither at startup nor on reconfigure.
	MCPServerModeDisabled = "disabled"
)

// ValidMCPServerMode reports whether raw is a recognized per-server mode.
// Empty is deliberately NOT valid here — it is the "unset, use the default"
// signal that callers resolve to auto themselves (silently on load, as the
// accepted default on the UI save path).
//
// Together with NormalizeMCPServerMode it is the single source of truth for
// the mode enum, shared by the load-time normalization (normalizeCapabilities,
// migrateLegacyMCPServerModes), the UI save-path validations
// (validateMCPServerConfig, ValidateCapabilities) and the status / mentionable
// RPCs, so all of them agree on exactly which values are valid. The
// capabilities section (skills / agents / mcp) reuses this exact enum for
// both of its per-context keys.
func ValidMCPServerMode(raw string) bool {
	switch raw {
	case MCPServerModeAuto, MCPServerModeManual, MCPServerModeDisabled:
		return true
	}
	return false
}

// NormalizeMCPServerMode resolves a raw mode value to the canonical enum:
// a recognized value passes through, empty and unrecognized values resolve
// to the default "auto". It never warns — distinguishing a silent default
// (empty) from a reported fallback (invalid) is the load path's job
// (migrateLegacyMCPServerModes / normalizeCapabilities).
func NormalizeMCPServerMode(raw string) string {
	if !ValidMCPServerMode(raw) {
		return MCPServerModeAuto
	}
	return raw
}

// migrateLegacyMCPServerModes folds the legacy per-server activation key
// (mcp.servers.<name>.mode) into the capabilities section and erases it. For
// every server with a non-empty mode: a recognized value is folded into
// capabilities.mcp.<name> verbatim (both contexts — the legacy key had no
// context split), an unrecognized one is reported as a load warning and
// folds as the default "auto"; an entry that already carries at least one
// explicit capability value outranks the legacy key and is left untouched.
// The Mode field is ALWAYS reset to "" afterwards — once folded (or absent)
// it is dead state, and leaving it set would resurrect the legacy key in
// YAML on the next save right next to the capabilities entry it migrated
// into. It is FAIL-SOFT: a bad legacy value can never prevent a server from
// starting.
//
// Must run after ApplyDefaults and before validate — the pipeline position
// the mode canonicalization held before the capabilities section existed.
// Warnings surface through the load pipeline into the UI's configLoadErrors
// channel, mirroring normalizeMCPTimeouts.
func migrateLegacyMCPServerModes(cfg *Config) []string {
	if len(cfg.MCP.Servers) == 0 {
		return nil
	}
	// Iterate server names in sorted order so the warning order — surfaced
	// verbatim in the UI — is deterministic.
	names := make([]string, 0, len(cfg.MCP.Servers))
	for name := range cfg.MCP.Servers {
		names = append(names, name)
	}
	sort.Strings(names)

	var warnings []string
	for _, name := range names {
		srv := cfg.MCP.Servers[name]
		switch {
		case srv.Mode == "":
			// The config predates the mode key (or has already migrated):
			// nothing to fold; the erase below is a no-op.
		case ValidMCPServerMode(srv.Mode):
			foldLegacyMCPMode(cfg, name, srv.Mode)
		default:
			warnings = append(warnings, fmt.Sprintf(
				"mcp.servers.%s.mode ignored (falling back to %q): unrecognized mode %q",
				name, MCPServerModeAuto, srv.Mode))
			foldLegacyMCPMode(cfg, name, MCPServerModeAuto)
		}
		srv.Mode = ""               // ALWAYS erase the legacy key (see doc comment).
		cfg.MCP.Servers[name] = srv // map values are not addressable
	}
	return warnings
}

// foldLegacyMCPMode copies a legacy per-server mode into
// capabilities.mcp.<name> unless the entry already carries at least one
// explicit value — an operator-authored capability entry always outranks the
// legacy key it coexists with. The fold is all-or-nothing per entry: a
// partially authored entry (one context set) keeps its other context at the
// "auto" default rather than inheriting the legacy mode.
func foldLegacyMCPMode(cfg *Config, name, mode string) {
	if cfg.Capabilities.MCP == nil {
		cfg.Capabilities.MCP = make(map[string]CapabilityModes)
	}
	cur, ok := cfg.Capabilities.MCP[name]
	if ok && (cur.ChatMode != "" || cur.CodeMode != "") {
		return
	}
	cfg.Capabilities.MCP[name] = CapabilityModes{ChatMode: mode, CodeMode: mode}
}

// normalizeCapabilities canonicalizes every capabilities entry in place and
// returns a load warning for each invalid value. It is FAIL-SOFT: an
// unrecognized chat_mode / code_mode is reported, never fatal, and reset to
// the default "auto" — a hand-edited typo can never break a capability. The
// values are REWRITTEN in place (the enum is closed): every consumer
// downstream of the load pipeline sees a canonical value without
// re-normalizing, and the next save stores exactly what the load resolved.
// Empty is the default, not an error — it resolves to "auto" silently; only
// a non-empty unrecognized value warns.
//
// Two structural cleanups run alongside the canonicalization, both silent:
// a capabilities.mcp entry whose name is not in mcp.servers is stale (the
// server was deleted or renamed) and is removed, and an entry whose values
// are BOTH empty carries no information and is removed — in every section,
// so a saved entry always resolves to at least one non-default mode.
//
// Must run after migrateLegacyMCPServerModes (the values it folds are
// already canonical) and after ApplyDefaults, before validate — the same
// pipeline position and surfacing contract as the other MCP normalizations.
func normalizeCapabilities(cfg *Config) []string {
	var warnings []string
	for _, section := range capabilitySections(cfg) {
		if len(section.entries) == 0 {
			continue
		}
		for _, name := range sortedCapabilityNames(section.entries) {
			if section.name == capSectionMCP {
				if _, known := cfg.MCP.Servers[name]; !known {
					delete(section.entries, name) // stale: silently dropped
					continue
				}
			}
			entry := section.entries[name]
			if entry.ChatMode == "" && entry.CodeMode == "" {
				delete(section.entries, name) // meaningless: silently dropped
				continue
			}
			for _, field := range []struct{ key, value string }{
				{"chat_mode", entry.ChatMode},
				{"code_mode", entry.CodeMode},
			} {
				switch {
				case field.value == "":
					// Silent: empty IS the default.
					if field.key == "chat_mode" {
						entry.ChatMode = MCPServerModeAuto
					} else {
						entry.CodeMode = MCPServerModeAuto
					}
				case ValidMCPServerMode(field.value):
					// Already canonical — nothing to do.
				default:
					warnings = append(warnings, fmt.Sprintf(
						"%s.%s.%s ignored (falling back to %q): unrecognized mode %q",
						section.label, name, field.key, MCPServerModeAuto, field.value))
					if field.key == "chat_mode" {
						entry.ChatMode = MCPServerModeAuto
					} else {
						entry.CodeMode = MCPServerModeAuto
					}
				}
			}
			section.entries[name] = entry // map values are not addressable
		}
	}
	return warnings
}

// The capabilities section identifiers, used for both the load-warning paths
// and the save-path validation errors.
const (
	capSectionSkills = "skills"
	capSectionAgents = "agents"
	capSectionMCP    = "mcp"
)

// capabilitySections returns the three capabilities sections in the fixed
// order the load normalization walks them and load warnings surface them.
func capabilitySections(cfg *Config) []struct {
	name    string
	label   string
	entries map[string]CapabilityModes
} {
	return []struct {
		name    string
		label   string
		entries map[string]CapabilityModes
	}{
		{capSectionSkills, "capabilities.skills", cfg.Capabilities.Skills},
		{capSectionAgents, "capabilities.agents", cfg.Capabilities.Agents},
		{capSectionMCP, "capabilities.mcp", cfg.Capabilities.MCP},
	}
}

func sortedCapabilityNames(m map[string]CapabilityModes) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ValidateCapabilities strictly validates a capabilities section for a SAVE
// path: every non-empty chat_mode / code_mode must be a recognized mode
// (ValidMCPServerMode — the same closed enum the load path normalizes
// fail-soft). Empty is allowed everywhere; it IS the "auto" default. The
// structural rules are deliberately NOT save errors — stale capabilities.mcp
// names and both-empty entries are harmless state that the load path's
// normalization (normalizeCapabilities) cleans up, so saving one costs a
// load warning at worst. Invalid enum values are rejected here because Save
// does not run validate(): a value stored past this gate would surface only
// at the next launch, where the failed load discards the whole config.
func ValidateCapabilities(c *CapabilitiesConfig) error {
	for _, section := range capabilitySections(&Config{Capabilities: *c}) {
		for _, name := range sortedCapabilityNames(section.entries) {
			entry := section.entries[name]
			for _, field := range []struct{ key, value string }{
				{"chat_mode", entry.ChatMode},
				{"code_mode", entry.CodeMode},
			} {
				if field.value == "" || ValidMCPServerMode(field.value) {
					continue
				}
				return fmt.Errorf("%s.%s: invalid %s %q: must be %q, %q or %q",
					section.label, name, field.key, field.value,
					MCPServerModeAuto, MCPServerModeManual, MCPServerModeDisabled)
			}
		}
	}
	return nil
}
