package core

import (
	"context"

	sdkagents "github.com/v0lka/sp4rk/agents"
)

// Orchestrator-side capability gating for the skill and agent catalogs —
// the mirror of the per-server MCP gating in orchestrator_mcp.go. The mode
// values are the same shared enum ("auto" | "manual" | "disabled",
// mcpModeAuto / mcpModeManual / mcpModeDisabled); the semantics per kind:
//
//   - auto (default, absent entry): implicit discovery works (the router
//     may match a skill; the agent renders in the "Available Subagents"
//     roster) and explicit /-mentions work.
//   - manual: hidden from implicit discovery, but visible to /-autocomplete
//     and activated by an explicit /skill: / /agent: mention.
//   - disabled: fully unavailable — a mention is silently ignored and
//     delegation to the agent is refused fail-closed.
//
// The snapshot rides the task context (attached once at task entry by
// attachCapabilitySnapshots), so reconfiguration cannot change a running
// task's authorization — the same property the MCP gated set has.

// skillModesKey carries the per-task flat skill name→mode snapshot.
type skillModesKey struct{}

// agentModesKey carries the per-task flat agent name→mode snapshot.
type agentModesKey struct{}

// WithSkillCapabilityModes attaches the task's flat skill mode snapshot.
// A nil map is equivalent to no value: every skill is auto.
func WithSkillCapabilityModes(ctx context.Context, modes map[string]string) context.Context {
	return context.WithValue(ctx, skillModesKey{}, modes)
}

// SkillCapabilityModesFromContext extracts the task's flat skill mode
// snapshot. Returns nil when absent (no gating — the default).
func SkillCapabilityModesFromContext(ctx context.Context) map[string]string {
	if v, ok := ctx.Value(skillModesKey{}).(map[string]string); ok {
		return v
	}
	return nil
}

// WithAgentCapabilityModes attaches the task's flat agent mode snapshot.
// A nil map is equivalent to no value: every agent is auto.
func WithAgentCapabilityModes(ctx context.Context, modes map[string]string) context.Context {
	return context.WithValue(ctx, agentModesKey{}, modes)
}

// AgentCapabilityModesFromContext extracts the task's flat agent mode
// snapshot. Returns nil when absent (no gating — the default).
func AgentCapabilityModesFromContext(ctx context.Context) map[string]string {
	if v, ok := ctx.Value(agentModesKey{}).(map[string]string); ok {
		return v
	}
	return nil
}

// currentSkillCapabilityModes returns the orchestrator's current per-skill
// capability snapshot: the resolver's live snapshot when wired, else the
// static map the constructor was built with.
func (o *Orchestrator) currentSkillCapabilityModes() map[string]CapabilityModes {
	if o.config.SkillModesResolver != nil {
		return o.config.SkillModesResolver()
	}
	return o.config.SkillModes
}

// currentAgentCapabilityModes returns the orchestrator's current per-agent
// capability snapshot: the resolver's live snapshot when wired, else the
// static map the constructor was built with.
func (o *Orchestrator) currentAgentCapabilityModes() map[string]CapabilityModes {
	if o.config.AgentModesResolver != nil {
		return o.config.AgentModesResolver()
	}
	return o.config.AgentModes
}

// attachCapabilitySnapshots resolves the session context (o.isNoProject —
// read at task entry, so a CHAT→CODE promotion applies to the NEXT task,
// never mid-task) once for each capability kind and attaches the flat
// projections to the context. Empty projections attach nothing: a missing
// snapshot means every capability is auto (no gating).
func (o *Orchestrator) attachCapabilitySnapshots(ctx context.Context) context.Context {
	sctx := o.sessionCapabilityContext()
	if modes := capabilityModesForSession(o.currentSkillCapabilityModes(), sctx); len(modes) > 0 {
		ctx = WithSkillCapabilityModes(ctx, modes)
	}
	if modes := capabilityModesForSession(o.currentAgentCapabilityModes(), sctx); len(modes) > 0 {
		ctx = WithAgentCapabilityModes(ctx, modes)
	}
	return ctx
}

// mentionedSkillsForTask filters the task's user-mentioned skills for the
// session's capability snapshot: auto and manual pass, disabled is dropped.
func mentionedSkillsForTask(ctx context.Context, userSkills []string) []string {
	return mentionedCapabilityNames(userSkills, SkillCapabilityModesFromContext(ctx))
}

// mentionedAgentsForTask filters the task's user-mentioned agents for the
// session's capability snapshot: auto and manual pass, disabled is dropped.
func mentionedAgentsForTask(ctx context.Context, userAgents []string) []string {
	return mentionedCapabilityNames(userAgents, AgentCapabilityModesFromContext(ctx))
}

// agentDelegationBlocked reports whether delegation to a named agent is
// refused by the task's capability snapshot: only "disabled" blocks (a
// manual agent delegates fine once mentioned or otherwise selected; the
// roster merely stops advertising it). Absent snapshot → nothing blocks.
func agentDelegationBlocked(ctx context.Context, name string) bool {
	return AgentCapabilityModesFromContext(ctx)[name] == mcpModeDisabled
}

// filterRosterAgents applies the implicit-discovery rule to the discovered
// subagent catalog for the task's agent snapshot (auto-only roster).
func filterRosterAgents(ctx context.Context, descriptors []sdkagents.AgentDescriptor) []sdkagents.AgentDescriptor {
	return availableAgentDescriptors(descriptors, AgentCapabilityModesFromContext(ctx))
}
