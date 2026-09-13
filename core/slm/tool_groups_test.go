package slm

import "testing"

// TestToolGroupCatalog_Shape verifies the static catalog's invariants:
// non-empty ids/titles/descriptions, at least one member per cluster, unique
// ids, and no tool belonging to two clusters (a tool must have exactly one
// home so the picker's atomicity guarantee is unambiguous).
func TestToolGroupCatalog_Shape(t *testing.T) {
	catalog := ToolGroupCatalog()
	if len(catalog) == 0 {
		t.Fatal("catalog is empty")
	}

	ids := make(map[string]struct{}, len(catalog))
	seenTools := make(map[string]string)
	for _, g := range catalog {
		if g.ID == "" {
			t.Errorf("cluster %+v has an empty ID", g)
		}
		if _, dup := ids[g.ID]; dup {
			t.Errorf("duplicate cluster ID %q", g.ID)
		}
		ids[g.ID] = struct{}{}
		if g.Title == "" {
			t.Errorf("cluster %q has an empty title", g.ID)
		}
		if g.Description == "" {
			t.Errorf("cluster %q has an empty description", g.ID)
		}
		if len(g.Tools) == 0 {
			t.Errorf("cluster %q has no members", g.ID)
		}
		for _, tool := range g.Tools {
			if tool == "" {
				t.Errorf("cluster %q has an empty tool name", g.ID)
			}
			if other, dup := seenTools[tool]; dup {
				t.Errorf("tool %q belongs to both %q and %q", tool, other, g.ID)
			}
			seenTools[tool] = g.ID
		}
	}
}

// TestToolGroupCatalog_WorkflowClusters pins the intended cluster membership:
// the plan cluster must bundle declaring and executing a plan with the step
// tools (the motivating example), and the subagents cluster the delegation and
// reflection tools. Goal-mode tools deliberately have no cluster — they are
// never narrowable, so a cluster around them would be an inert control.
func TestToolGroupCatalog_WorkflowClusters(t *testing.T) {
	byID := make(map[string]ToolGroupDef)
	for _, g := range ToolGroupCatalog() {
		byID[g.ID] = g
	}

	if _, ok := byID["goal"]; ok {
		t.Error("goal cluster must not exist: goal-mode tools are never narrowable")
	}

	want := map[string][]string{
		"plan":      {"declare_plan", "execute_plan", "declare_step_complete", "update_checklist"},
		"subagents": {"delegate", "cancel_delegation", "read_step_output", "list_step_outputs", "read_final_result", "reflect"},
	}
	for id, tools := range want {
		g, ok := byID[id]
		if !ok {
			t.Errorf("cluster %q missing from catalog", id)
			continue
		}
		if len(g.Tools) != len(tools) {
			t.Errorf("cluster %q has %d members, want %d (%v)", id, len(g.Tools), len(tools), tools)
			continue
		}
		for i, tool := range tools {
			if g.Tools[i] != tool {
				t.Errorf("cluster %q member %d = %q, want %q", id, i, g.Tools[i], tool)
			}
		}
	}
}

// TestToolGroupCatalog_ReturnsFreshCopy guards against callers mutating the
// package-level definitions through a returned slice.
func TestToolGroupCatalog_ReturnsFreshCopy(t *testing.T) {
	first := ToolGroupCatalog()
	first[0].Tools[0] = "mutated"
	first[0].Title = "mutated"

	second := ToolGroupCatalog()
	if second[0].Tools[0] == "mutated" || second[0].Title == "mutated" {
		t.Fatal("mutating a returned catalog leaked into the package-level definitions")
	}
}
