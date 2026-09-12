package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// stubPlanPublisher records Publish calls without touching the filesystem.
type stubPlanPublisher struct {
	publishCalls int
	lastTasks    []PlanTaskInput
}

func (p *stubPlanPublisher) Publish(_ context.Context, tasks []PlanTaskInput) (string, error) {
	p.publishCalls++
	p.lastTasks = tasks
	return "/plans/plan_stub.md", nil
}

func (p *stubPlanPublisher) LastPlanMarkdown() string { return "# stub plan" }

// stubPlanChecker is a fixed PlanChecker.
type stubPlanChecker struct {
	declared bool
}

func (c *stubPlanChecker) HasDeclaredPlan() bool { return c.declared }

// stubContinuationChecker is a PlanChecker that also carries the optional
// PlanContinuation capability (mirrors the core conductorLauncher).
type stubContinuationChecker struct {
	stubPlanChecker
	continuation bool
}

func (c *stubContinuationChecker) PlanContinuation() bool { return c.continuation }

func validDeclarePlanInput(t *testing.T) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"mode": "present",
		"tasks": []map[string]any{{
			"id":          "step_1",
			"summary":     "A",
			"description": "Do A",
		}},
	})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	return raw
}

// TestDeclarePlan_ContinuationSoftHint: on a resumed task whose approved plan
// still has unreached steps, declare_plan returns a soft (non-error) hint
// pointing back to execute_plan and does NOT publish a replacement plan.
func TestDeclarePlan_ContinuationSoftHint(t *testing.T) {
	publisher := &stubPlanPublisher{}
	ctx := WithPlanPublisher(context.Background(), publisher)
	ctx = WithPlanChecker(ctx, &stubContinuationChecker{continuation: true})

	res, err := NewDeclarePlanTool(nil).Execute(ctx, validDeclarePlanInput(t))
	if err != nil {
		t.Fatalf("soft hint must not be a tool error, got: %v", err)
	}
	if res.IsError {
		t.Errorf("hint must be soft (IsError=false), got %+v", res)
	}
	if !strings.Contains(res.Content, "already been declared and approved") {
		t.Errorf("hint should say the plan is already approved, got: %q", res.Content)
	}
	if !strings.Contains(res.Content, "execute_plan") {
		t.Errorf("hint should direct the model to execute_plan, got: %q", res.Content)
	}
	if publisher.publishCalls != 0 {
		t.Errorf("continuation must not publish a replacement plan, got %d publishes", publisher.publishCalls)
	}
}

// TestDeclarePlan_NoContinuation_Publishes: without the continuation flag the
// tool behaves exactly as before — the publisher is invoked.
func TestDeclarePlan_NoContinuation_Publishes(t *testing.T) {
	publisher := &stubPlanPublisher{}
	ctx := WithPlanPublisher(context.Background(), publisher)
	ctx = WithPlanChecker(ctx, &stubContinuationChecker{continuation: false})

	res, err := NewDeclarePlanTool(nil).Execute(ctx, validDeclarePlanInput(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Errorf("unexpected error result: %+v", res)
	}
	if publisher.publishCalls != 1 {
		t.Fatalf("expected exactly 1 publish, got %d", publisher.publishCalls)
	}
	if !strings.Contains(res.Content, "Plan published to") {
		t.Errorf("expected normal publish result, got: %q", res.Content)
	}
}

// TestDeclarePlan_CheckerWithoutCapability_Publishes: a PlanChecker that does
// not implement PlanContinuation (older embedding, plain stub) must not trip
// the hint — the capability is optional, detected via type assertion.
func TestDeclarePlan_CheckerWithoutCapability_Publishes(t *testing.T) {
	publisher := &stubPlanPublisher{}
	ctx := WithPlanPublisher(context.Background(), publisher)
	ctx = WithPlanChecker(ctx, &stubPlanChecker{declared: true})

	if _, err := NewDeclarePlanTool(nil).Execute(ctx, validDeclarePlanInput(t)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if publisher.publishCalls != 1 {
		t.Errorf("expected exactly 1 publish, got %d", publisher.publishCalls)
	}
}

// marshalPlanInput builds a declare_plan JSON input from raw task objects.
func marshalPlanInput(t *testing.T, tasks ...map[string]any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"mode": "present", "tasks": tasks})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	return raw
}

// validTask returns a minimal schema-valid task with the given id.
func validTask(id string) map[string]any {
	return map[string]any{"id": id, "summary": "Step " + id, "description": "Do " + id}
}

// TestDeclarePlan_Validation_MissingRequiredFields: a task without id,
// summary, or description is rejected with an IsError result naming the
// 1-based task number and the missing field; nothing is published.
func TestDeclarePlan_Validation_MissingRequiredFields(t *testing.T) {
	cases := []struct {
		name  string
		field string
		task  map[string]any
	}{
		{"missing id", "id", map[string]any{"summary": "A", "description": "Do A"}},
		{"blank id", "id", map[string]any{"id": "   ", "summary": "A", "description": "Do A"}},
		{"missing summary", "summary", map[string]any{"id": "step_2", "description": "Do A"}},
		{"blank summary", "summary", map[string]any{"id": "step_2", "summary": "  ", "description": "Do A"}},
		{"missing description", "description", map[string]any{"id": "step_2", "summary": "A"}},
		{"blank description", "description", map[string]any{"id": "step_2", "summary": "A", "description": ""}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			publisher := &stubPlanPublisher{}
			ctx := WithPlanPublisher(context.Background(), publisher)

			// Valid task first, invalid second: proves 1-based numbering.
			res, err := NewDeclarePlanTool(nil).Execute(ctx, marshalPlanInput(t, validTask("step_1"), tc.task))
			if err != nil {
				t.Fatalf("validation must be a tool result, not a Go error, got: %v", err)
			}
			if !res.IsError {
				t.Fatalf("expected IsError result, got: %+v", res)
			}
			for _, want := range []string{"task 2", `"` + tc.field + `"`, "declare_plan"} {
				if !strings.Contains(res.Content, want) {
					t.Errorf("error should mention %q, got: %q", want, res.Content)
				}
			}
			if publisher.publishCalls != 0 {
				t.Errorf("invalid plan must not be published, got %d publishes", publisher.publishCalls)
			}
		})
	}
}

// TestDeclarePlan_Validation_DuplicateID: two tasks sharing an id are rejected
// with the duplicated id and the 1-based numbers of both occurrences.
func TestDeclarePlan_Validation_DuplicateID(t *testing.T) {
	publisher := &stubPlanPublisher{}
	ctx := WithPlanPublisher(context.Background(), publisher)

	res, err := NewDeclarePlanTool(nil).Execute(ctx, marshalPlanInput(t,
		validTask("step_1"),
		validTask("step_2"),
		validTask("step_1"),
	))
	if err != nil {
		t.Fatalf("validation must be a tool result, not a Go error, got: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected IsError result, got: %+v", res)
	}
	for _, want := range []string{"step_1", "tasks 1 and 3", "declare_plan"} {
		if !strings.Contains(res.Content, want) {
			t.Errorf("error should mention %q, got: %q", want, res.Content)
		}
	}
	if publisher.publishCalls != 0 {
		t.Errorf("invalid plan must not be published, got %d publishes", publisher.publishCalls)
	}
}

// TestDeclarePlan_Validation_UnknownDependency: depends_on pointing at an id
// that no task declares is rejected with the broken reference and the task
// that carries it.
func TestDeclarePlan_Validation_UnknownDependency(t *testing.T) {
	publisher := &stubPlanPublisher{}
	ctx := WithPlanPublisher(context.Background(), publisher)

	second := map[string]any{
		"id":          "step_2",
		"summary":     "B",
		"description": "Do B",
		"depends_on":  []string{"step_1", "step_9"},
	}
	res, err := NewDeclarePlanTool(nil).Execute(ctx, marshalPlanInput(t, validTask("step_1"), second))
	if err != nil {
		t.Fatalf("validation must be a tool result, not a Go error, got: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected IsError result, got: %+v", res)
	}
	for _, want := range []string{"step_9", "task 2", "declare_plan"} {
		if !strings.Contains(res.Content, want) {
			t.Errorf("error should mention %q, got: %q", want, res.Content)
		}
	}
	if publisher.publishCalls != 0 {
		t.Errorf("invalid plan must not be published, got %d publishes", publisher.publishCalls)
	}
}

// TestDeclarePlan_Validation_MultipleViolationsTogether: every violation in a
// plan is listed in a single result, not just the first one.
func TestDeclarePlan_Validation_MultipleViolationsTogether(t *testing.T) {
	publisher := &stubPlanPublisher{}
	ctx := WithPlanPublisher(context.Background(), publisher)

	tasks := []map[string]any{
		{"id": "step_1", "description": "Do A"}, // missing summary
		validTask("dupe"),                       // first "dupe" occurrence
		{ // duplicate "dupe" + unknown dependency
			"id":          "dupe",
			"summary":     "C",
			"description": "Do C",
			"depends_on":  []string{"step_missing"},
		},
	}
	res, err := NewDeclarePlanTool(nil).Execute(ctx, marshalPlanInput(t, tasks...))
	if err != nil {
		t.Fatalf("validation must be a tool result, not a Go error, got: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected IsError result, got: %+v", res)
	}
	for _, want := range []string{
		"task 1",        // missing summary in task 1
		`"summary"`,     // ...with the field name
		"tasks 2 and 3", // duplicate id spans both occurrences
		"step_missing",  // unknown dependency
		"task 3",        // ...carried by task 3
		"declare_plan",  // actionable fix instruction
	} {
		if !strings.Contains(res.Content, want) {
			t.Errorf("error should mention %q, got: %q", want, res.Content)
		}
	}
	if publisher.publishCalls != 0 {
		t.Errorf("invalid plan must not be published, got %d publishes", publisher.publishCalls)
	}
}

// TestDeclarePlan_Validation_BeforeContinuationGuard: validation runs before
// the continuation guard, so re-declaring an invalid plan on a resumed task
// yields the validation error instead of the soft continue-with-execute_plan
// hint — a malformed plan must never slip past validation on any path.
func TestDeclarePlan_Validation_BeforeContinuationGuard(t *testing.T) {
	publisher := &stubPlanPublisher{}
	ctx := WithPlanPublisher(context.Background(), publisher)
	ctx = WithPlanChecker(ctx, &stubContinuationChecker{continuation: true})

	res, err := NewDeclarePlanTool(nil).Execute(ctx, marshalPlanInput(t,
		map[string]any{"summary": "A", "description": "Do A"}, // no id
	))
	if err != nil {
		t.Fatalf("validation must be a tool result, not a Go error, got: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected validation IsError even when continuation flag is set, got: %+v", res)
	}
	if !strings.Contains(res.Content, "missing required field") {
		t.Errorf("expected validation error, got: %q", res.Content)
	}
	if publisher.publishCalls != 0 {
		t.Errorf("invalid plan must not be published, got %d publishes", publisher.publishCalls)
	}
}

// TestValidatePlanTasks_ValidPlanPasses: the pure validator returns nil for a
// plan with all fields present, unique ids, and resolvable (including
// transitive) dependencies.
func TestValidatePlanTasks_ValidPlanPasses(t *testing.T) {
	tasks := []PlanTaskInput{
		{ID: "step_1", Summary: "A", Description: "Do A"},
		{ID: "step_2", Summary: "B", Description: "Do B", DependsOn: []string{"step_1"}},
		{ID: "step_3", Summary: "C", Description: "Do C", DependsOn: []string{"step_2"}}, // transitive dep on step_1
	}
	if err := validatePlanTasks(tasks); err != nil {
		t.Fatalf("valid plan must pass validation, got: %v", err)
	}
}
