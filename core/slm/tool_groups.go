package slm

// ToolGroupDef describes a functional cluster of orchestration tools offered by
// the always-present picker (settings UI). The picker presents the cluster as a
// single entry that pins every member at once, so a workflow is never added
// only in part — e.g. the plan-step tool without the plan-declaration tool.
// (Individual members can still be removed one chip at a time afterwards; the
// guarantee is about how a cluster is added.)
//
// The catalog is static data (no registry access); every member name is a
// built-in tool the backend validates against the live registry before the
// cluster reaches the UI.
type ToolGroupDef struct {
	// ID is a stable, URL-safe cluster identifier.
	ID string
	// Title is the human-readable cluster name shown in the picker.
	Title string
	// Description explains the capability the cluster grants the agent; the
	// picker renders it (alongside the member list) in the entry's tooltip.
	Description string
	// Tools are the member tool names, in display order. All members are
	// listed in the picker's tooltip; selecting the cluster pins each member
	// that is still selectable.
	Tools []string
}

// toolGroupCatalog is the ordered workflow-cluster catalog. It groups only the
// tools that are useless in isolation — the planning and subagent/reflection
// workflows — so the picker can offer them atomically. Capability areas whose
// tools stand alone (files, search, web, memory, shell) are deliberately left
// ungrouped and offered individually: narrowing a read-only agent to file reads
// without file writes is a legitimate choice.
//
// Goal-mode tools (propose_goal, declare_goal_status, declare_verification) have
// no cluster and are excluded from the picker universe entirely: they are never
// narrowable (they are stripped from every non-goal run before the selection
// runs, and the selection is not applied in goal mode), so a cluster around them
// would be an inert control. See backend/frontend_api_config.go builtinToolInfos.
var toolGroupCatalog = []ToolGroupDef{
	{
		ID:    "plan",
		Title: "Planning & steps",
		Description: "Declare a multi-step plan for complex tasks, execute its " +
			"steps, and mark each step finished (plus checklist progress). " +
			"Selected as a unit so a plan can always be executed and tracked.",
		Tools: []string{"declare_plan", "execute_plan", "declare_step_complete", "update_checklist"},
	},
	{
		ID:    "subagents",
		Title: "Subagents & reflection",
		Description: "Delegate work to isolated subagents, cancel a running " +
			"delegation, read delegated step outputs and final results, and " +
			"reflect on the trajectory. Selected as a unit so delegated work " +
			"can always be read back.",
		Tools: []string{"delegate", "cancel_delegation", "read_step_output", "list_step_outputs", "read_final_result", "reflect"},
	},
}

// ToolGroupCatalog returns the ordered workflow-cluster catalog as a fresh
// copy, so callers cannot mutate the package-level definitions. The result is
// freshly allocated (including each Tools slice).
func ToolGroupCatalog() []ToolGroupDef {
	out := make([]ToolGroupDef, 0, len(toolGroupCatalog))
	for _, g := range toolGroupCatalog {
		cp := g
		cp.Tools = append([]string(nil), g.Tools...)
		out = append(out, cp)
	}
	return out
}
