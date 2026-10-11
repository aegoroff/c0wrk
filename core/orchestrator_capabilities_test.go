package core

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/v0lka/sp4rk/agent"
	"github.com/v0lka/sp4rk/agent/router"
	"github.com/v0lka/sp4rk/agents"
	"github.com/v0lka/sp4rk/llm"
	"github.com/v0lka/sp4rk/skills"
	sdktools "github.com/v0lka/sp4rk/tools"

	"github.com/v0lka/c0wrk/core/tools"
)

// --- pure filter helpers ---

func TestImplicitSkillDescriptors(t *testing.T) {
	catalog := []skills.SkillDescriptor{
		{Name: "auto-skill", Description: "auto"},
		{Name: "manual-skill", Description: "manual"},
		{Name: "disabled-skill", Description: "disabled"},
		{Name: "unlisted-skill", Description: "absent from the map = auto"},
	}
	modes := map[string]string{
		"manual-skill":   mcpModeManual,
		"disabled-skill": mcpModeDisabled,
	}
	got := implicitSkillDescriptors(catalog, modes)
	names := make([]string, 0, len(got))
	for _, d := range got {
		names = append(names, d.Name)
	}
	want := []string{"auto-skill", "unlisted-skill"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Errorf("implicitSkillDescriptors = %v, want %v (manual+disabled hidden, auto+absent kept)", names, want)
	}
	// Zero-regression: no modes → catalog unchanged.
	if got := implicitSkillDescriptors(catalog, nil); len(got) != len(catalog) {
		t.Errorf("nil modes must pass the catalog through, got %d of %d", len(got), len(catalog))
	}
}

func TestAvailableAgentDescriptors(t *testing.T) {
	catalog := []agents.AgentDescriptor{
		{Name: "auto-agent"},
		{Name: "manual-agent"},
		{Name: "disabled-agent"},
	}
	modes := map[string]string{
		"manual-agent":   mcpModeManual,
		"disabled-agent": mcpModeDisabled,
	}
	got := availableAgentDescriptors(catalog, modes)
	if len(got) != 1 || got[0].Name != "auto-agent" {
		t.Errorf("availableAgentDescriptors = %v, want only auto-agent (auto-only roster)", got)
	}
	if got := availableAgentDescriptors(catalog, nil); len(got) != len(catalog) {
		t.Errorf("nil modes must pass the roster through, got %d of %d", len(got), len(catalog))
	}
}

func TestMentionedCapabilityNames(t *testing.T) {
	modes := map[string]string{
		"manual":   mcpModeManual,
		"disabled": mcpModeDisabled,
	}
	got := mentionedCapabilityNames([]string{"manual", "disabled", "auto"}, modes)
	want := []string{"manual", "auto"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("mentionedCapabilityNames = %v, want %v (manual mention passes, disabled dropped)", got, want)
	}
	if got := mentionedCapabilityNames([]string{"x"}, nil); len(got) != 1 {
		t.Errorf("nil modes must pass mentions through, got %v", got)
	}
}

func TestImplicitSkillNames(t *testing.T) {
	modes := map[string]string{
		"manual":   mcpModeManual,
		"disabled": mcpModeDisabled,
	}
	got := implicitSkillNames([]string{"auto", "manual", "disabled", "absent"}, modes)
	want := []string{"auto", "absent"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("implicitSkillNames = %v, want %v", got, want)
	}
	if got := implicitSkillNames([]string{"a"}, nil); len(got) != 1 {
		t.Errorf("nil modes must pass names through, got %v", got)
	}
}

// --- builder-side snapshots ---

func TestCapabilityModesFromConfig(t *testing.T) {
	entries := map[string]CapabilityModes{
		"both":      {ChatMode: mcpModeManual, CodeMode: mcpModeDisabled},
		"all-empty": {},
		"chat-only": {ChatMode: mcpModeManual},
	}
	got := capabilityModesFromConfig(entries)
	if len(got) != 2 {
		t.Fatalf("capabilityModesFromConfig = %v, want 2 entries (the all-empty entry is omitted)", got)
	}
	if got["both"] != (CapabilityModes{ChatMode: mcpModeManual, CodeMode: mcpModeDisabled}) {
		t.Errorf("snapshot[both] = %v, want verbatim {manual, disabled}", got["both"])
	}
	if got["chat-only"] != (CapabilityModes{ChatMode: mcpModeManual}) {
		t.Errorf("snapshot[chat-only] = %v, want {manual, \"\"}", got["chat-only"])
	}
	// The snapshot is a clone: mutating the input afterwards must not leak in.
	entries["both"] = CapabilityModes{ChatMode: mcpModeAuto, CodeMode: mcpModeAuto}
	if got["both"].ChatMode != mcpModeManual {
		t.Error("snapshot must be independent of later input mutation")
	}
	if capabilityModesFromConfig(nil) != nil {
		t.Error("nil input must project to nil")
	}
	if capabilityModesFromConfig(map[string]CapabilityModes{"x": {}}) != nil {
		t.Error("all-empty input must project to nil")
	}
}

func TestCurrentSkillAgentModes_ImmutableSnapshots(t *testing.T) {
	b := &OrchestratorBuilder{
		skillModes: map[string]CapabilityModes{"s": bothCtxModes(mcpModeManual)},
		agentModes: map[string]CapabilityModes{"a": bothCtxModes(mcpModeDisabled)},
	}
	snap := b.currentSkillModes()
	snap["s"] = bothCtxModes(mcpModeAuto)
	if got := b.currentSkillModes()["s"]; got != (CapabilityModes{ChatMode: mcpModeManual, CodeMode: mcpModeManual}) {
		t.Errorf("currentSkillModes after snapshot mutation = %v, want manual", got)
	}
	asnap := b.currentAgentModes()
	asnap["a"] = bothCtxModes(mcpModeAuto)
	if got := b.currentAgentModes()["a"]; got != (CapabilityModes{ChatMode: mcpModeDisabled, CodeMode: mcpModeDisabled}) {
		t.Errorf("currentAgentModes after snapshot mutation = %v, want disabled", got)
	}
	empty := &OrchestratorBuilder{}
	if empty.currentSkillModes() != nil || empty.currentAgentModes() != nil {
		t.Error("no configured modes must read as nil (everything auto)")
	}
}

// TestUpdateCapabilities_RepublishesAllSnapshots reproduces the MUST FIX
// finding behind UpdateCapabilities: the immutable snapshots are read at
// every task entry through the resolver getters, and before the runtime
// republish existed they only ever reflected the config the builder was
// CONSTRUCTED with (mcpModes got a later refresh from ReconfigureMCP, but
// skillModes/agentModes had none) — so a saved capabilities change stayed
// invisible to live orchestrators until the next app restart. The test
// seeds the stale-snapshot state, republishes from a new BuilderConfig the
// way UpdateCapabilityModes does, and verifies all three snapshots track it:
// new entries appear, dropped (stale) names disappear, the published maps
// are private clones (later input mutation cannot leak in), and a cleared
// section publishes nil (gates nothing).
func TestUpdateCapabilities_RepublishesAllSnapshots(t *testing.T) {
	b := &OrchestratorBuilder{
		mcpModes:   map[string]CapabilityModes{"stale-srv": bothCtxModes(mcpModeManual)},
		skillModes: map[string]CapabilityModes{"stale-skill": bothCtxModes(mcpModeManual)},
		agentModes: map[string]CapabilityModes{"stale-agent": bothCtxModes(mcpModeDisabled)},
	}
	cfg := &BuilderConfig{
		MCP: BuilderMCPConfig{Servers: map[string]BuilderMCPServer{
			"srv": {Transport: "stdio", Command: "cmd", ChatMode: mcpModeManual, CodeMode: mcpModeDisabled},
		}},
		Capabilities: BuilderCapabilitiesConfig{
			Skills: map[string]CapabilityModes{"study": bothCtxModes(mcpModeManual)},
			Agents: map[string]CapabilityModes{"ghost": bothCtxModes(mcpModeDisabled)},
		},
	}

	b.UpdateCapabilities(cfg)

	if got := b.currentMCPServerModes(); len(got) != 1 || got["srv"] != (CapabilityModes{ChatMode: mcpModeManual, CodeMode: mcpModeDisabled}) {
		t.Errorf("currentMCPServerModes() = %v, want only srv {manual, disabled} (stale-srv replaced)", got)
	}
	if got := b.currentSkillModes(); len(got) != 1 || got["study"] != (CapabilityModes{ChatMode: mcpModeManual, CodeMode: mcpModeManual}) {
		t.Errorf("currentSkillModes() = %v, want only study {manual, manual} (stale-skill replaced)", got)
	}
	if got := b.currentAgentModes(); len(got) != 1 || got["ghost"] != (CapabilityModes{ChatMode: mcpModeDisabled, CodeMode: mcpModeDisabled}) {
		t.Errorf("currentAgentModes() = %v, want only ghost {disabled, disabled} (stale-agent replaced)", got)
	}

	// The snapshots are private clones: mutating the caller's config maps
	// after the publish must not leak into the builder's state.
	cfg.Capabilities.Skills["study"] = bothCtxModes(mcpModeAuto)
	cfg.Capabilities.Agents["ghost"] = bothCtxModes(mcpModeAuto)
	cfg.MCP.Servers["srv"] = BuilderMCPServer{Transport: "stdio", Command: "cmd"}
	if got := b.currentSkillModes()["study"]; got.ChatMode != mcpModeManual {
		t.Errorf("skill snapshot leaked later input mutation: %v", got)
	}
	if got := b.currentAgentModes()["ghost"]; got.ChatMode != mcpModeDisabled {
		t.Errorf("agent snapshot leaked later input mutation: %v", got)
	}
	if got := b.currentMCPServerModes()["srv"]; got.CodeMode != mcpModeDisabled {
		t.Errorf("mcp snapshot leaked later input mutation: %v", got)
	}

	// A cleared section publishes nil — the "gates nothing" default — rather
	// than leaving the previous section's entries in place.
	cfg.Capabilities.Skills = nil
	b.UpdateCapabilities(cfg)
	if got := b.currentSkillModes(); got != nil {
		t.Errorf("currentSkillModes() after a cleared section = %v, want nil", got)
	}
}

// TestNewOrchestratorBuilder_CapabilitySnapshots pins the constructor wiring:
// the builder's immutable skill/agent snapshots are projected from
// BuilderConfig.Capabilities at construction (the seam Build() hands the
// orchestrator through the resolvers).
func TestNewOrchestratorBuilder_CapabilitySnapshots(t *testing.T) {
	cfg := &BuilderConfig{
		Capabilities: BuilderCapabilitiesConfig{
			Skills: map[string]CapabilityModes{"study": {ChatMode: mcpModeManual, CodeMode: mcpModeManual}},
			Agents: map[string]CapabilityModes{"ghost": {ChatMode: mcpModeDisabled, CodeMode: mcpModeDisabled}},
		},
		ExpandEnvVars: func(s string) string { return s },
	}
	b, err := NewOrchestratorBuilder(cfg, nil, nil, nil)
	if err != nil {
		t.Fatalf("NewOrchestratorBuilder: %v", err)
	}
	if got := b.currentSkillModes()["study"]; got != (CapabilityModes{ChatMode: mcpModeManual, CodeMode: mcpModeManual}) {
		t.Errorf("currentSkillModes()[study] = %v, want {manual, manual}", got)
	}
	if got := b.currentAgentModes()["ghost"]; got != (CapabilityModes{ChatMode: mcpModeDisabled, CodeMode: mcpModeDisabled}) {
		t.Errorf("currentAgentModes()[ghost] = %v, want {disabled, disabled}", got)
	}
	t.Cleanup(func() { _ = b.StopGateway() })
}

// --- task-entry snapshot + session-context selection ---

func TestAttachCapabilitySnapshots_ChatCodeSelection(t *testing.T) {
	config := OrchestratorConfig{
		SkillModes: map[string]CapabilityModes{
			"split-skill": {ChatMode: mcpModeManual, CodeMode: mcpModeDisabled},
		},
		AgentModes: map[string]CapabilityModes{
			"split-agent": {ChatMode: mcpModeDisabled, CodeMode: mcpModeManual},
		},
	}

	t.Run("CODE session applies code_mode", func(t *testing.T) {
		o := &Orchestrator{config: config, isNoProject: false}
		ctx := o.attachCapabilitySnapshots(context.Background())
		if got := SkillCapabilityModesFromContext(ctx)["split-skill"]; got != mcpModeDisabled {
			t.Errorf("CODE skill mode = %q, want disabled", got)
		}
		if got := AgentCapabilityModesFromContext(ctx)["split-agent"]; got != mcpModeManual {
			t.Errorf("CODE agent mode = %q, want manual", got)
		}
	})
	t.Run("CHAT session applies chat_mode", func(t *testing.T) {
		o := &Orchestrator{config: config, isNoProject: true}
		ctx := o.attachCapabilitySnapshots(context.Background())
		if got := SkillCapabilityModesFromContext(ctx)["split-skill"]; got != mcpModeManual {
			t.Errorf("CHAT skill mode = %q, want manual", got)
		}
		if got := AgentCapabilityModesFromContext(ctx)["split-agent"]; got != mcpModeDisabled {
			t.Errorf("CHAT agent mode = %q, want disabled", got)
		}
	})
	t.Run("CHAT to CODE promotion changes the NEXT task's selection", func(t *testing.T) {
		o := &Orchestrator{config: config, isNoProject: true}
		chatCtx := o.attachCapabilitySnapshots(context.Background())
		o.isNoProject = false // promotion applied between tasks
		codeCtx := o.attachCapabilitySnapshots(context.Background())
		if SkillCapabilityModesFromContext(chatCtx)["split-skill"] != mcpModeManual ||
			SkillCapabilityModesFromContext(codeCtx)["split-skill"] != mcpModeDisabled {
			t.Error("promotion must flip the selected side on the next attach")
		}
	})
	t.Run("no configured modes attaches nothing", func(t *testing.T) {
		o := &Orchestrator{}
		ctx := o.attachCapabilitySnapshots(context.Background())
		if SkillCapabilityModesFromContext(ctx) != nil || AgentCapabilityModesFromContext(ctx) != nil {
			t.Error("empty config must attach no snapshots (zero regression)")
		}
	})
}

func TestMentionFiltersAtTaskEntry(t *testing.T) {
	o := &Orchestrator{config: OrchestratorConfig{
		SkillModes: map[string]CapabilityModes{
			"manual-skill": bothCtxModes(mcpModeManual),
			"dead-skill":   bothCtxModes(mcpModeDisabled),
		},
		AgentModes: map[string]CapabilityModes{
			"manual-agent": bothCtxModes(mcpModeManual),
			"dead-agent":   bothCtxModes(mcpModeDisabled),
		},
	}}
	ctx := o.attachCapabilitySnapshots(context.Background())
	gotSkills := mentionedSkillsForTask(ctx, []string{"manual-skill", "dead-skill", "auto-skill"})
	if strings.Join(gotSkills, ",") != "manual-skill,auto-skill" {
		t.Errorf("mentionedSkillsForTask = %v, want manual+auto kept, disabled dropped", gotSkills)
	}
	gotAgents := mentionedAgentsForTask(ctx, []string{"manual-agent", "dead-agent"})
	if strings.Join(gotAgents, ",") != "manual-agent" {
		t.Errorf("mentionedAgentsForTask = %v, want only manual-agent (disabled mention ignored)", gotAgents)
	}
}

// --- skill catalog before the router + explicit /skill activation ---

// writeCapabilitySkillToDisk creates a minimal skill with a unique body marker.
func writeCapabilitySkillToDisk(t *testing.T, dir, name, bodyMarker string) {
	t.Helper()
	skillDir := filepath.Join(dir, name)
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	md := "---\nname: " + name + "\ndescription: capability test skill " + name + "\n---\n" + bodyMarker + "\n"
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(md), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// capabilitySkillsForTest scans a temp dir holding the two test skills.
func capabilitySkillsForTest(t *testing.T) *skills.SkillManager {
	t.Helper()
	dir := t.TempDir()
	writeCapabilitySkillToDisk(t, dir, "auto-skill", "AUTO-SKILL-BODY-MARKER")
	writeCapabilitySkillToDisk(t, dir, "manual-skill", "MANUAL-SKILL-BODY-MARKER")
	sm := skills.NewSkillManager([]string{dir}, nil)
	if err := sm.Scan(); err != nil {
		t.Fatalf("skill scan: %v", err)
	}
	return sm
}

// newCapabilityRoutingOrchestrator builds a full HandleMessage harness with
// the two test skills, a router whose request is captured, and a spy emitter
// whose SkillsActivated events observe activation. routerJSON is returned as
// the (single) routing decision.
func newCapabilityRoutingOrchestrator(t *testing.T, skillModes map[string]CapabilityModes, routerJSON string) (*Orchestrator, *string, *spyEmitter) {
	t.Helper()
	sm := capabilitySkillsForTest(t)

	routerReq := ""
	mockLLM := &mockLLMCaller{
		callFn: func(_ context.Context, req llm.ChatRequest) (*llm.ChatResponse, error) {
			if routerReq == "" {
				var sb strings.Builder
				for _, m := range req.Messages {
					sb.WriteString(m.Content)
					sb.WriteString("\n")
				}
				routerReq = sb.String()
				return &llm.ChatResponse{
					Message:    llm.Message{Role: "assistant", Content: routerJSON},
					StopReason: "end_turn",
				}, nil
			}
			return &llm.ChatResponse{
				Message: llm.Message{
					Role: "assistant",
					ToolCalls: []llm.ToolCall{{
						ID:    "call_finish",
						Name:  "finish",
						Input: json.RawMessage(`{"answer":"done"}`),
					}},
				},
				StopReason: "tool_use",
			}, nil
		},
	}

	registry := createTestRegistry()
	emitter := &spyEmitter{}
	o := NewOrchestrator(OrchestratorConfig{SkillModes: skillModes}, OrchestratorDeps{
		Router:         newCoreRouter(mockLLM, 5),
		LLM:            mockLLM,
		ToolExec:       registry,
		ToolRegistry:   registry,
		TokenCounter:   llm.NewSimpleTokenCounter(),
		ContextFactory: captureContextFactory(nil),
		CircuitBreaker: defaultCircuitBreakerConfig,
		SkillManager:   sm,
		Emitter:        emitter,
	})
	return o, &routerReq, emitter
}

// activatedSkills extracts the skill names from the emitter's SkillsActivated
// events (empty when none fired).
func activatedSkills(e *spyEmitter) []string {
	var names []string
	for _, c := range e.calls {
		if c.method != "SkillsActivated" {
			continue
		}
		if got, ok := c.args[0].([]string); ok {
			names = append(names, got...)
		}
	}
	return names
}

// TestHandleMessage_ManualSkillHiddenFromRouterButMentionActivates is the
// core AC test: a manual skill is invisible to implicit discovery (the router
// catalog omits it, and even a hallucinated router match is dropped) while an
// explicit /skill: mention still activates it.
func TestHandleMessage_ManualSkillHiddenFromRouterButMentionActivates(t *testing.T) {
	modes := map[string]CapabilityModes{"manual-skill": bothCtxModes(mcpModeManual)}

	t.Run("router catalog hides the manual skill; a matched name is not activated", func(t *testing.T) {
		// The router "hallucinates" a match for the manual skill it was never
		// shown — the implicit-name filter must still drop it.
		o, routerReq, emitter := newCapabilityRoutingOrchestrator(t, modes,
			`{"domain": "general", "complexity": 2, "needs_clarification": false, "matched_skills": ["manual-skill"]}`)
		if _, err := o.HandleMessage(context.Background(), "please review", "session-cap-a", HandleOptions{}); err != nil {
			t.Fatalf("HandleMessage failed: %v", err)
		}
		if strings.Contains(*routerReq, "capability test skill manual-skill") {
			t.Error("router catalog must NOT contain the manual skill (hidden from implicit discovery)")
		}
		if !strings.Contains(*routerReq, "capability test skill auto-skill") {
			t.Error("router catalog must still contain the auto skill")
		}
		if got := activatedSkills(emitter); len(got) != 0 {
			t.Errorf("an unmatched manual skill must not activate without an explicit mention, got %v", got)
		}
	})
	t.Run("explicit /skill mention activates the manual skill", func(t *testing.T) {
		o, _, emitter := newCapabilityRoutingOrchestrator(t, modes,
			`{"domain": "general", "complexity": 2, "needs_clarification": false, "matched_skills": []}`)
		if _, err := o.HandleMessage(context.Background(), "work", "session-cap-b", HandleOptions{UserSkills: []string{"manual-skill"}}); err != nil {
			t.Fatalf("HandleMessage failed: %v", err)
		}
		if got := activatedSkills(emitter); strings.Join(got, ",") != "manual-skill" {
			t.Errorf("activated = %v, want exactly manual-skill (explicit mention passes the capability gate)", got)
		}
	})
	t.Run("auto skill still matches implicitly (zero regression)", func(t *testing.T) {
		o, _, emitter := newCapabilityRoutingOrchestrator(t, modes,
			`{"domain": "general", "complexity": 2, "needs_clarification": false, "matched_skills": ["auto-skill"]}`)
		if _, err := o.HandleMessage(context.Background(), "work", "session-cap-c", HandleOptions{}); err != nil {
			t.Fatalf("HandleMessage failed: %v", err)
		}
		if got := activatedSkills(emitter); strings.Join(got, ",") != "auto-skill" {
			t.Errorf("activated = %v, want exactly auto-skill (implicit matching unchanged)", got)
		}
	})
}

// --- restored-routing rule (reactivateSkills / collectActiveSkillDescriptors) ---

func TestCollectActiveSkillDescriptors_RestoredRoutingRespectsModes(t *testing.T) {
	dir := t.TempDir()
	writeCapabilitySkillToDisk(t, dir, "manual-skill", "BODY")
	writeCapabilitySkillToDisk(t, dir, "gone-skill", "BODY")
	sm := skills.NewSkillManager([]string{dir}, nil)
	if err := sm.Scan(); err != nil {
		t.Fatalf("skill scan: %v", err)
	}

	o := &Orchestrator{skillManager: sm}
	ctx := WithSkillCapabilityModes(context.Background(), map[string]string{
		"manual-skill": mcpModeManual,
		"gone-skill":   mcpModeDisabled,
	})
	routing := &router.RoutingDecision{MatchedSkills: []string{"gone-skill"}}
	if descs := o.collectActiveSkillDescriptors(ctx, routing, nil); len(descs) != 0 {
		t.Errorf("a restored match for a now-disabled skill must not reactivate, got %v", descs)
	}
	// The same restored decision plus an explicit mention of the manual skill:
	// the mention activates, the stale match stays dropped.
	descs := o.collectActiveSkillDescriptors(ctx, routing, []string{"manual-skill"})
	if len(descs) != 1 || descs[0].Name != "manual-skill" {
		t.Errorf("collectActiveSkillDescriptors = %v, want exactly manual-skill (mention passes, restored disabled match dropped)", descs)
	}
}

// --- agent roster + mentions ---

func TestEnrichAgentContext_CapabilityRosterAndMentions(t *testing.T) {
	ws := t.TempDir()
	writeAgentProfileToDisk(t, ws, "auto-agent", "---\nname: auto-agent\ndescription: Auto agent.\n---\nBody.\n")
	writeAgentProfileToDisk(t, ws, "manual-agent", "---\nname: manual-agent\ndescription: Manual agent.\n---\nBody.\n")
	writeAgentProfileToDisk(t, ws, "disabled-agent", "---\nname: disabled-agent\ndescription: Disabled agent.\n---\nBody.\n")
	mgr := agents.NewAgentManager([]string{filepath.Join(ws, AgentsRelativePath)}, nil)
	if err := mgr.Scan(); err != nil {
		t.Fatalf("Scan: %v", err)
	}

	o := &Orchestrator{agentManager: mgr}
	ctx := WithAgentCapabilityModes(context.Background(), map[string]string{
		"manual-agent":   mcpModeManual,
		"disabled-agent": mcpModeDisabled,
	})
	ctx = o.enrichAgentContext(ctx, mentionedAgentsForTask(ctx, []string{"manual-agent", "disabled-agent"}), nil)

	roster := AvailableAgentsFromContext(ctx)
	rosterNames := make([]string, 0, len(roster))
	for _, d := range roster {
		rosterNames = append(rosterNames, d.Name)
	}
	if strings.Join(rosterNames, ",") != "auto-agent" {
		t.Errorf("roster = %v, want only auto-agent (manual hidden from implicit discovery, disabled gone)", rosterNames)
	}
	if mentions := UserAgentsFromContext(ctx); strings.Join(mentions, ",") != "manual-agent" {
		t.Errorf("user mentions = %v, want only manual-agent (disabled mention ignored)", mentions)
	}

	// No snapshot → full roster, zero regression.
	plain := o.enrichAgentContext(context.Background(), nil, nil)
	if got := AvailableAgentsFromContext(plain); len(got) != 3 {
		t.Errorf("no-snapshot roster = %d entries, want all 3", len(got))
	}
}

// --- delegation refusal (fail-closed, mirror of the MCP registry gate) ---

func TestBuildSubAgentTask_DisabledAgentRefused(t *testing.T) {
	profile := testAgentProfile("directive", agents.AgentMetadata{Name: "reviewer"})
	resolver := func(name string) (*agents.Agent, bool) {
		if name == "reviewer" {
			return profile, true
		}
		return nil, false
	}
	newLauncher := func() *conductorLauncher {
		return &conductorLauncher{deps: conductorDeps{
			contextFactory: captureContextFactory(nil),
			toolRegistry:   newSubagentTestRegistry(subagentToolSet()),
		}}
	}
	task := tools.DelegationTask{ID: "d1", Summary: "s", Task: "do work", Agent: "reviewer"}

	t.Run("disabled agent is refused fail-closed", func(t *testing.T) {
		ctx := tools.WithAgentResolver(sdktools.WithWorkspacePath(context.Background(), "/ws"), resolver)
		ctx = WithAgentCapabilityModes(ctx, map[string]string{"reviewer": mcpModeDisabled})
		_, err := newLauncher().buildSubAgentTask(ctx, task, tools.NewDelegationRegistry(), &agent.NoopEvents{})
		if err == nil {
			t.Fatal("expected refusal for a capabilities.agents-disabled agent")
		}
		if !strings.Contains(err.Error(), "disabled by capabilities.agents") {
			t.Errorf("refusal must name the capability gate, got: %v", err)
		}
	})
	t.Run("manual agent still delegates", func(t *testing.T) {
		ctx := tools.WithAgentResolver(sdktools.WithWorkspacePath(context.Background(), "/ws"), resolver)
		ctx = WithAgentCapabilityModes(ctx, map[string]string{"reviewer": mcpModeManual})
		if _, err := newLauncher().buildSubAgentTask(ctx, task, tools.NewDelegationRegistry(), &agent.NoopEvents{}); err != nil {
			t.Fatalf("manual agent must delegate, got: %v", err)
		}
	})
	t.Run("no snapshot delegates as before (zero regression)", func(t *testing.T) {
		ctx := tools.WithAgentResolver(sdktools.WithWorkspacePath(context.Background(), "/ws"), resolver)
		if _, err := newLauncher().buildSubAgentTask(ctx, task, tools.NewDelegationRegistry(), &agent.NoopEvents{}); err != nil {
			t.Fatalf("no-snapshot path must be unchanged, got: %v", err)
		}
	})
}

// --- agentDelegationBlocked ---

func TestAgentDelegationBlocked(t *testing.T) {
	ctx := WithAgentCapabilityModes(context.Background(), map[string]string{
		"dead": mcpModeDisabled, "manual": mcpModeManual,
	})
	if !agentDelegationBlocked(ctx, "dead") {
		t.Error("disabled agent must block delegation")
	}
	if agentDelegationBlocked(ctx, "manual") || agentDelegationBlocked(ctx, "auto") || agentDelegationBlocked(context.Background(), "dead") {
		t.Error("manual/auto/absent-snapshot agents must not block")
	}
}
