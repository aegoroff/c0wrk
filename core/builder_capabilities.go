package core

import (
	"maps"

	sdkagents "github.com/v0lka/sp4rk/agents"
	"github.com/v0lka/sp4rk/skills"
)

// Builder-side capability plumbing for the skill and agent catalogs: the
// same immutable-snapshot pattern the MCP server modes use (b.mcpModes —
// published once at construction, republished by reconfigure paths, read
// only through cloning getters). core never imports backend/config, so the
// enum values arrive as plain strings mirroring config constants.

// capabilityModesFromConfig projects a capabilities section (skills or
// agents) into the builder's immutable snapshot map. Entries whose two
// contexts are BOTH empty are omitted: capabilityModesForSession treats a
// missing entry as auto (always available), and the config load path has
// already normalized every configured entry to canonical mode values
// (backend/config normalizeCapabilities). The input map is never retained —
// the snapshot is a private clone.
func capabilityModesFromConfig(entries map[string]CapabilityModes) map[string]CapabilityModes {
	if len(entries) == 0 {
		return nil
	}
	modes := make(map[string]CapabilityModes, len(entries))
	for name, cm := range entries {
		if cm.ChatMode == "" && cm.CodeMode == "" {
			continue // both auto — absent entry
		}
		modes[name] = CapabilityModes{ChatMode: cm.ChatMode, CodeMode: cm.CodeMode}
	}
	if len(modes) == 0 {
		return nil
	}
	return modes
}

// currentSkillModes returns an independent current policy snapshot for the
// skill catalog. Mirrors currentMCPServerModes.
func (b *OrchestratorBuilder) currentSkillModes() map[string]CapabilityModes {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return maps.Clone(b.skillModes)
}

// currentAgentModes returns an independent current policy snapshot for the
// subagent catalog. Mirrors currentMCPServerModes.
func (b *OrchestratorBuilder) currentAgentModes() map[string]CapabilityModes {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return maps.Clone(b.agentModes)
}

// UpdateCapabilities republishes all three capability mode snapshots (MCP
// servers, skills, agents) from cfg — the runtime-edit counterpart of the
// constructor projection, mirroring the single-line mcpModes republication
// ReconfigureMCP performs. It is a pure in-memory write under b.mu: no
// gateway work, no readiness wait, no network — mode edits are policy, not
// topology (ADR-084), so the gateway keeps its current dial set (a newly
// both-disabled server stays dialed until the next full reconfigure or
// restart, which is that ADR's declared behavior) while live orchestrators
// pick the fresh snapshots up at the next task entry through the resolver
// getters. The snapshots are private clones built by the projection helpers,
// so later mutation of the caller's config maps cannot leak in. A nil skill
// or agent section publishes nil — a cleared section gates nothing.
func (b *OrchestratorBuilder) UpdateCapabilities(cfg *BuilderConfig) {
	b.mu.Lock()
	b.mcpModes = mcpServerModesFromConfig(cfg)
	b.skillModes = capabilityModesFromConfig(cfg.Capabilities.Skills)
	b.agentModes = capabilityModesFromConfig(cfg.Capabilities.Agents)
	b.mu.Unlock()
}

// implicitSkillDescriptors filters the skill catalog down to the skills
// implicit discovery (the router) may see: auto-mode entries and names
// absent from the modes map. Manual skills stay resolvable for explicit
// /-mentions but are invisible to router matching; disabled skills are gone
// entirely. A nil/empty modes map returns the input unchanged (the
// zero-regression default).
func implicitSkillDescriptors(descs []skills.SkillDescriptor, modes map[string]string) []skills.SkillDescriptor {
	if len(modes) == 0 || len(descs) == 0 {
		return descs
	}
	out := make([]skills.SkillDescriptor, 0, len(descs))
	for _, d := range descs {
		switch modes[d.Name] {
		case mcpModeManual, mcpModeDisabled:
			continue // not implicitly discoverable
		}
		out = append(out, d)
	}
	return out
}

// availableAgentDescriptors filters the discovered subagent catalog down to
// the agents implicit discovery (the "Available Subagents" roster) may
// render: auto-mode entries and names absent from the modes map. Manual
// agents stay resolvable for explicit /-mentions but are hidden from the
// roster; disabled agents are gone entirely. A nil/empty modes map returns
// the input unchanged.
func availableAgentDescriptors(descs []sdkagents.AgentDescriptor, modes map[string]string) []sdkagents.AgentDescriptor {
	if len(modes) == 0 || len(descs) == 0 {
		return descs
	}
	out := make([]sdkagents.AgentDescriptor, 0, len(descs))
	for _, d := range descs {
		switch modes[d.Name] {
		case mcpModeManual, mcpModeDisabled:
			continue // not implicitly discoverable
		}
		out = append(out, d)
	}
	return out
}

// implicitCapabilityName reports whether a capability name may enter through
// IMPLICIT discovery given the task's flat mode snapshot: auto (or absent
// from the map) yes; manual and disabled no. Explicit mentions follow a
// different rule (see mentionedCapabilityNames): manual passes, only
// disabled is refused.
func implicitCapabilityName(name string, modes map[string]string) bool {
	switch modes[name] {
	case mcpModeManual, mcpModeDisabled:
		return false
	}
	return true
}

// implicitSkillNames filters routing-derived skill names through the
// implicit-discovery rule: manual and disabled entries are dropped, auto
// (and absent-from-map) names pass. Used on router-matched names (a
// belt-and-braces pass over the already-filtered catalog) and on a RESTORED
// routing decision, whose matched list may predate a capability change. A
// nil/empty modes map returns the input unchanged.
func implicitSkillNames(names []string, modes map[string]string) []string {
	if len(modes) == 0 || len(names) == 0 {
		return names
	}
	out := make([]string, 0, len(names))
	for _, n := range names {
		if implicitCapabilityName(n, modes) {
			out = append(out, n)
		}
	}
	return out
}

// mentionedCapabilityNames filters explicitly-mentioned capability names for
// a task: auto and manual pass (a manual mention is exactly how a manual
// capability activates), disabled is dropped — a mention of a disabled
// capability is ignored, never an error and never an activation. A
// nil/empty modes map returns the input unchanged.
func mentionedCapabilityNames(names []string, modes map[string]string) []string {
	if len(modes) == 0 || len(names) == 0 {
		return names
	}
	out := make([]string, 0, len(names))
	for _, n := range names {
		if modes[n] == mcpModeDisabled {
			continue
		}
		out = append(out, n)
	}
	return out
}
