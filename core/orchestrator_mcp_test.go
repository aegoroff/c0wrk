package core

import (
	"context"
	"testing"

	sdktools "github.com/v0lka/sp4rk/tools"

	coretools "github.com/v0lka/c0wrk/core/tools"
)

// bothCtxModes builds a CapabilityModes entry carrying the same mode in both
// session contexts — the shape a legacy single per-server mode folds into
// (backend/config migrateLegacyMCPServerMode). Tests that exercise the flat
// single-mode semantics use it; context-split behavior has its own entries.
func bothCtxModes(mode string) CapabilityModes {
	return CapabilityModes{ChatMode: mode, CodeMode: mode}
}

func TestGatedMCPServerSet(t *testing.T) {
	modes := map[string]string{
		"auto-srv":   mcpModeAuto,
		"manual-a":   mcpModeManual,
		"manual-b":   mcpModeManual,
		"disabled-s": mcpModeDisabled,
		"":           "", // absent/empty mode → auto
	}
	tests := []struct {
		name      string
		mentioned []string
		want      map[string]bool
	}{
		{"no mentions: manual + disabled gated", nil, map[string]bool{"manual-a": true, "manual-b": true, "disabled-s": true}},
		{"mention unblocks only the mentioned manual server", []string{"manual-a"}, map[string]bool{"manual-b": true, "disabled-s": true}},
		{"mentioning an auto or disabled server changes nothing", []string{"auto-srv", "disabled-s"}, map[string]bool{"manual-a": true, "manual-b": true, "disabled-s": true}},
		{"all manual mentioned: only disabled stays gated", []string{"manual-a", "manual-b"}, map[string]bool{"disabled-s": true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := gatedMCPServerSet(modes, tt.mentioned)
			if len(got) != len(tt.want) {
				t.Fatalf("gatedMCPServerSet(%v) = %v, want %v", tt.mentioned, got, tt.want)
			}
			for name := range tt.want {
				if !got[name] {
					t.Errorf("server %q must be gated, got %v", name, got)
				}
			}
		})
	}
	// No modes configured → nothing gated (zero regression for default config).
	if got := gatedMCPServerSet(nil, nil); got != nil {
		t.Fatalf("gatedMCPServerSet(nil) = %v, want nil", got)
	}
	// Only auto servers → nothing gated even with no mentions.
	if got := gatedMCPServerSet(map[string]string{"a": mcpModeAuto}, nil); got != nil {
		t.Fatalf("auto-only modes must gate nothing, got %v", got)
	}
}

func mcpGateTestDescriptors() []sdktools.ToolDescriptor {
	return []sdktools.ToolDescriptor{
		{Name: "auto_query", Source: "auto-srv", SourceCategory: sdktools.SourceCategoryMCP, Group: sdktools.GroupRemoteMCP},
		{Name: "manual_query", Source: "manual-srv", SourceCategory: sdktools.SourceCategoryMCP, Group: sdktools.GroupRemoteMCP},
		{Name: "stale_query", Source: "disabled-srv", SourceCategory: sdktools.SourceCategoryMCP, Group: sdktools.GroupLocalMCP},
		{Name: "read_file", Source: "core", Group: sdktools.GroupLocalRead},
	}
}

func TestFilterGatedMCPTools(t *testing.T) {
	gated := map[string]bool{"manual-srv": true, "disabled-srv": true}
	got := filterGatedMCPTools(mcpGateTestDescriptors(), gated)
	names := make(map[string]bool, len(got))
	for _, d := range got {
		names[d.Name] = true
	}
	for _, want := range []string{"auto_query", "read_file"} {
		if !names[want] {
			t.Errorf("tool %q must survive the filter, got %v", want, names)
		}
	}
	for _, unwanted := range []string{"manual_query", "stale_query"} {
		if names[unwanted] {
			t.Errorf("tool %q must be filtered out (gated-off server), got %v", unwanted, names)
		}
	}
	// Empty gated set is a passthrough.
	if got := filterGatedMCPTools(mcpGateTestDescriptors(), nil); len(got) != 4 {
		t.Fatalf("nil gated set must be a passthrough, got %d tools", len(got))
	}
}

func TestApplyMCPModeGating(t *testing.T) {
	o := &Orchestrator{config: OrchestratorConfig{MCPServerModes: map[string]CapabilityModes{
		"auto-srv":     bothCtxModes(mcpModeAuto),
		"manual-srv":   bothCtxModes(mcpModeManual),
		"disabled-srv": bothCtxModes(mcpModeDisabled),
	}}}
	ctx := context.Background()

	// Without a mention: manual + disabled tools filtered, gated set in ctx.
	got, gatedCtx := o.applyMCPModeGating(ctx, mcpGateTestDescriptors(), nil)
	if len(got) != 2 {
		t.Fatalf("unmentioned run: want 2 surviving tools, got %d", len(got))
	}
	if g := coretools.GatedMCPServersFromContext(gatedCtx); g == nil || !g["manual-srv"] || !g["disabled-srv"] {
		t.Fatalf("gated set must carry manual+disabled servers, got %v", g)
	}

	// With a mention: the manual server survives; only disabled stays gated.
	got, gatedCtx = o.applyMCPModeGating(ctx, mcpGateTestDescriptors(), []string{"manual-srv"})
	names := make(map[string]bool, len(got))
	for _, d := range got {
		names[d.Name] = true
	}
	if !names["manual_query"] || names["stale_query"] {
		t.Fatalf("mentioned run: want manual_query present and stale_query absent, got %v", names)
	}
	if g := coretools.GatedMCPServersFromContext(gatedCtx); g == nil || !g["disabled-srv"] || g["manual-srv"] {
		t.Fatalf("mentioned run: gated set must be {disabled-srv}, got %v", g)
	}

	// Nothing gated (all auto) → list and ctx pass through unchanged.
	oAll := &Orchestrator{config: OrchestratorConfig{MCPServerModes: map[string]CapabilityModes{"auto-srv": bothCtxModes(mcpModeAuto)}}}
	got, gatedCtx = oAll.applyMCPModeGating(ctx, mcpGateTestDescriptors(), nil)
	if len(got) != 4 || gatedCtx != ctx {
		t.Fatalf("auto-only config must be a no-op (got %d tools, ctx changed=%v)", len(got), gatedCtx != ctx)
	}
}

// TestApplyMCPModeGating_SessionContextSelection pins the per-context mode
// split: the session type selects which side of a CapabilityModes entry the
// gating reads — CODE sessions apply code_mode, CHAT (No Project) sessions
// apply chat_mode. A server manual only in CODE is available to a mentioned
// CODE task and gated in CHAT tasks; the complement invariant (auto ∪
// (manual ∩ mentioned)) holds per context, and a mention never overrides the
// mode (a disabled context stays gated, mention or not).
func TestApplyMCPModeGating_SessionContextSelection(t *testing.T) {
	mcpDesc := func(name string) sdktools.ToolDescriptor {
		return sdktools.ToolDescriptor{Name: name + "_query", Source: name, SourceCategory: sdktools.SourceCategoryMCP, Group: sdktools.GroupRemoteMCP}
	}
	sources := func(descs []sdktools.ToolDescriptor) map[string]bool {
		out := make(map[string]bool, len(descs))
		for _, d := range descs {
			out[d.Source] = true
		}
		return out
	}

	modes := map[string]CapabilityModes{
		// manual only in CODE; disabled in CHAT.
		"code-manual": {ChatMode: mcpModeDisabled, CodeMode: mcpModeManual},
		// manual in CHAT; auto in CODE.
		"chat-manual": {ChatMode: mcpModeManual, CodeMode: mcpModeAuto},
	}

	tests := []struct {
		name        string
		isNoProject bool
		mentioned   []string
		wantSources []string
	}{
		{"CODE unmentioned: auto available, manual gated", false, nil, []string{"chat-manual"}},
		{"CODE mentioned: manual∩mention joins the complement", false, []string{"code-manual"}, []string{"code-manual", "chat-manual"}},
		{"CHAT unmentioned: both gated (disabled + unmentioned manual)", true, nil, nil},
		{"CHAT mention cannot override the disabled context", true, []string{"code-manual"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := &Orchestrator{config: OrchestratorConfig{MCPServerModes: modes}, isNoProject: tt.isNoProject}
			descs := []sdktools.ToolDescriptor{mcpDesc("code-manual"), mcpDesc("chat-manual")}
			got, ctx := o.applyMCPModeGating(context.Background(), descs, tt.mentioned)
			gotSources := sources(got)
			if len(gotSources) != len(tt.wantSources) {
				t.Fatalf("available sources = %v, want %v", gotSources, tt.wantSources)
			}
			for _, want := range tt.wantSources {
				if !gotSources[want] {
					t.Errorf("server %q must be available, got %v", want, gotSources)
				}
			}
			// The dispatch gate must mirror the catalog exactly: every server
			// outside the available complement is gated, nothing else is.
			gated := coretools.GatedMCPServersFromContext(ctx)
			for _, server := range []string{"code-manual", "chat-manual"} {
				if gated[server] == gotSources[server] {
					t.Errorf("server %q: gate=%v must be the complement of availability=%v", server, gated[server], gotSources[server])
				}
			}
		})
	}

	// Empty capability map: both session contexts are no-ops (zero regression).
	for _, isNoProject := range []bool{false, true} {
		o := &Orchestrator{config: OrchestratorConfig{}, isNoProject: isNoProject}
		descs := []sdktools.ToolDescriptor{mcpDesc("any")}
		got, ctx := o.applyMCPModeGating(context.Background(), descs, nil)
		if len(got) != 1 || ctx != context.Background() {
			t.Errorf("empty modes (isNoProject=%v) must pass through unchanged, got %v", isNoProject, got)
		}
	}
}

// TestMCPModesForSession pins the capability-map projection: the session
// context selects chat_mode vs code_mode per server, empty selections are
// omitted (missing entry = auto downstream), and a fully-empty map projects
// to nil.
func TestMCPModesForSession(t *testing.T) {
	modes := map[string]CapabilityModes{
		"chat-disabled": {ChatMode: mcpModeDisabled, CodeMode: mcpModeManual},
		"code-disabled": {ChatMode: mcpModeManual, CodeMode: mcpModeDisabled},
		"both-empty":    {},
	}
	chat := capabilityModesForSession(modes, mcpSessionChat)
	if chat["chat-disabled"] != mcpModeDisabled || chat["code-disabled"] != mcpModeManual {
		t.Errorf("chat projection = %v, want chat-disabled→disabled, code-disabled→manual", chat)
	}
	if _, ok := chat["both-empty"]; ok {
		t.Error("both-empty entry must be omitted from the projection (absent = auto)")
	}
	code := capabilityModesForSession(modes, mcpSessionCode)
	if code["chat-disabled"] != mcpModeManual || code["code-disabled"] != mcpModeDisabled {
		t.Errorf("code projection = %v, want chat-disabled→manual, code-disabled→disabled", code)
	}
	if got := capabilityModesForSession(nil, mcpSessionChat); got != nil {
		t.Errorf("nil modes must project to nil, got %v", got)
	}
	if got := capabilityModesForSession(map[string]CapabilityModes{"a": {}}, mcpSessionCode); got != nil {
		t.Errorf("all-empty modes must project to nil, got %v", got)
	}
}

// TestMCPServerModesFromConfig_CapabilitySnapshot pins the builder-side
// snapshot: entries with both contexts empty are omitted, mixed entries carry
// their values verbatim, and an empty/absent server map yields nil.
func TestMCPServerModesFromConfig_CapabilitySnapshot(t *testing.T) {
	if got := mcpServerModesFromConfig(&BuilderConfig{}); got != nil {
		t.Errorf("no servers must snapshot nil, got %v", got)
	}
	cfg := &BuilderConfig{MCP: BuilderMCPConfig{Servers: map[string]BuilderMCPServer{
		"empty": {Transport: "stdio", Command: "cmd"},
		"both":  {ChatMode: mcpModeManual, CodeMode: mcpModeDisabled},
		"chat":  {ChatMode: mcpModeManual},
	}}}
	got := mcpServerModesFromConfig(cfg)
	if len(got) != 2 {
		t.Fatalf("snapshot = %v, want 2 entries (the all-empty server is omitted)", got)
	}
	if got["both"] != (CapabilityModes{ChatMode: mcpModeManual, CodeMode: mcpModeDisabled}) {
		t.Errorf("snapshot[both] = %v, want verbatim {manual, disabled}", got["both"])
	}
	if got["chat"] != (CapabilityModes{ChatMode: mcpModeManual}) {
		t.Errorf("snapshot[chat] = %v, want {manual, \"\"}", got["chat"])
	}
}

func TestRecordAndRecallMCPMentions(t *testing.T) {
	o := &Orchestrator{}
	o.recordMCPMentions("task-1", []string{"srv-b", "srv-a"})
	o.recordMCPMentions("task-1", []string{"srv-a", "srv-c"}) // union, no retraction

	got := o.mcpMentionsFor("task-1")
	if len(got) != 3 || got[0] != "srv-a" || got[1] != "srv-b" || got[2] != "srv-c" {
		t.Fatalf("mentions must union task-wide and sort, got %v", got)
	}
	if other := o.mcpMentionsFor("task-2"); other != nil {
		t.Fatalf("task isolation broken: task-2 saw %v", other)
	}
	o.recordMCPMentions("", []string{"srv"}) // no-op on empty task id
	if got := o.mcpMentionsFor(""); got != nil {
		t.Fatalf("empty task id must yield nil, got %v", got)
	}
}

// TestVerifierToolset_InheritsMCPGating pins the verifier composition: the
// goal verifier's toolset is built (verifierToolFilter) from the orchestrator's
// ALREADY-GATED available-tool list, so a manual server without a mention (or
// a disabled server) must not reach the verifier either.
func TestVerifierToolset_InheritsMCPGating(t *testing.T) {
	gated := map[string]bool{"manual-srv": true, "disabled-srv": true}
	filtered := filterGatedMCPTools(mcpGateTestDescriptors(), gated)
	got := verifierToolFilter(filtered, nil)
	names := make(map[string]bool, len(got))
	for _, d := range got {
		names[d.Name] = true
	}
	if names["manual_query"] || names["stale_query"] {
		t.Fatalf("gated-off MCP tools must not reach the verifier, got %v", names)
	}
	if !names["auto_query"] {
		t.Fatalf("auto MCP tools must stay available to the verifier, got %v", names)
	}
}
