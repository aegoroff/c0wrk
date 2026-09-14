package core

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/core/goal"
	"github.com/v0lka/sp4rk/agent/router"
	"github.com/v0lka/sp4rk/llm"
	"github.com/v0lka/sp4rk/orchestration"
)

// modelProfilesNarrowingOn / modelProfilesNarrowingOff are the two ModelProfilesSettings shapes the goal
// guard keys on: both the master toggle and the essential-tools variant.
func modelProfilesNarrowingOn() ModelProfilesSettings {
	return ModelProfilesSettings{Enabled: true, EssentialTools: ModelProfilesEssentialSettings{Enabled: true}}
}

// TestModelProfilesEssentialToolsEnabled_Combinations pins the predicate the guard uses:
// only master-on AND variant-on is "narrowing active". Every other combination
// leaves goal mode untouched (behavior unchanged).
func TestModelProfilesEssentialToolsEnabled_Combinations(t *testing.T) {
	cases := []struct {
		name          string
		modelProfiles ModelProfilesSettings
		want          bool
	}{
		{"master off, variant on", ModelProfilesSettings{Enabled: false, EssentialTools: ModelProfilesEssentialSettings{Enabled: true}}, false},
		{"master on, variant off", ModelProfilesSettings{Enabled: true, EssentialTools: ModelProfilesEssentialSettings{Enabled: false}}, false},
		{"both off", ModelProfilesSettings{}, false},
		{"both on", modelProfilesNarrowingOn(), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := &Orchestrator{config: OrchestratorConfig{ModelProfiles: tc.modelProfiles}}
			if got := o.modelProfilesEssentialToolsEnabled(); got != tc.want {
				t.Errorf("modelProfilesEssentialToolsEnabled() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestHandleMessage_GoalBlockedByModelProfiles verifies the core defense-in-depth: a
// fresh goal request is refused with ErrGoalBlockedByModelProfiles while the Model Profiles
// essential-tools narrowing is active — before any LLM work runs.
func TestHandleMessage_GoalBlockedByModelProfiles(t *testing.T) {
	mockLLM := &mockLLMCaller{
		callFn: func(_ context.Context, _ llm.ChatRequest) (*llm.ChatResponse, error) {
			return &llm.ChatResponse{Message: llm.Message{Role: "assistant", Content: "should never run"}}, nil
		},
	}
	o := newE2STestOrchestrator(mockLLM, createTestRegistry(), nil, nil)
	o.config.ModelProfiles = modelProfilesNarrowingOn()

	result, err := o.HandleMessage(context.Background(), "achieve something", "session-modelProfiles-goal", HandleOptions{Goal: true})
	if !errors.Is(err, ErrGoalBlockedByModelProfiles) {
		t.Fatalf("HandleMessage error = %v, want ErrGoalBlockedByModelProfiles", err)
	}
	if result != nil {
		t.Errorf("HandleMessage result = %+v, want nil on the block", result)
	}
	mockLLM.mu.Lock()
	calls := len(mockLLM.calls)
	mockLLM.mu.Unlock()
	if calls != 0 {
		t.Errorf("LLM calls = %d, want 0 — the block must precede any goal work", calls)
	}
}

// TestResumeGoalLoop_BlockedByModelProfiles verifies the paused-goal defense-in-depth:
// re-entering the goal loop is refused with ErrGoalBlockedByModelProfiles while the
// narrowing is active, before the turn runner runs or the goal status is
// mutated.
func TestResumeGoalLoop_BlockedByModelProfiles(t *testing.T) {
	o := newGoalTestOrchestrator()
	o.config.ModelProfiles = modelProfilesNarrowingOn()
	recorder := &goalSeedRecorder{}
	o.goalTurnRunner = recorder.run

	pausedGS := &goal.GoalState{
		Condition:    "ship the feature",
		VerifyClause: "go test ./...",
		TurnCount:    2,
		Status:       goal.StatusActive,
		CreatedAt:    time.Now(),
	}

	result, err := o.resumeGoalLoop(
		context.Background(), "resume the goal", orchestration.NewMapBlackboard(), nil, "",
		&router.RoutingDecision{Domain: "general", Complexity: 3}, pausedGS, nil, "", "",
	)
	if !errors.Is(err, ErrGoalBlockedByModelProfiles) {
		t.Fatalf("resumeGoalLoop error = %v, want ErrGoalBlockedByModelProfiles", err)
	}
	if result != nil {
		t.Errorf("resumeGoalLoop result = %+v, want nil on the block", result)
	}
	if recorder.turns != 0 {
		t.Errorf("turn runner invoked %d times, want 0 — the block must precede the loop", recorder.turns)
	}
}

// TestResumeGoalLoop_NarrowingOff_Proceeds pins "behavior unchanged when ModelProfiles
// is off": with the master toggle off (variant on), a paused goal resumes into
// the goal loop exactly as before.
func TestResumeGoalLoop_NarrowingOff_Proceeds(t *testing.T) {
	o := newGoalTestOrchestrator()
	o.config.ModelProfiles = ModelProfilesSettings{Enabled: false, EssentialTools: ModelProfilesEssentialSettings{Enabled: true}}
	recorder := &goalSeedRecorder{}
	o.goalTurnRunner = recorder.run

	pausedGS := &goal.GoalState{
		Condition:    "ship the feature",
		VerifyClause: "go test ./...",
		TurnCount:    2,
		Status:       goal.StatusActive,
		CreatedAt:    time.Now(),
	}
	if _, err := o.resumeGoalLoop(
		context.Background(), "resume the goal", orchestration.NewMapBlackboard(), nil, "",
		nil, pausedGS, nil, "", "",
	); err != nil {
		t.Fatalf("resumeGoalLoop failed: %v", err)
	}
	if recorder.turns != 1 {
		t.Fatalf("turn runner called %d times, want 1 (the loop must re-enter)", recorder.turns)
	}
}

// TestResumeGoalLoop_EssentialToolsOff_Proceeds pins "behavior unchanged when
// the essential-tools variant is off": master on but variant off leaves the
// goal resume path untouched.
func TestResumeGoalLoop_EssentialToolsOff_Proceeds(t *testing.T) {
	o := newGoalTestOrchestrator()
	o.config.ModelProfiles = ModelProfilesSettings{Enabled: true, EssentialTools: ModelProfilesEssentialSettings{Enabled: false}}
	recorder := &goalSeedRecorder{}
	o.goalTurnRunner = recorder.run

	pausedGS := &goal.GoalState{
		Condition:    "ship the feature",
		VerifyClause: "go test ./...",
		TurnCount:    2,
		Status:       goal.StatusActive,
		CreatedAt:    time.Now(),
	}
	if _, err := o.resumeGoalLoop(
		context.Background(), "resume the goal", orchestration.NewMapBlackboard(), nil, "",
		nil, pausedGS, nil, "", "",
	); err != nil {
		t.Fatalf("resumeGoalLoop failed: %v", err)
	}
	if recorder.turns != 1 {
		t.Fatalf("turn runner called %d times, want 1 (the loop must re-enter)", recorder.turns)
	}
}

// TestOrchestrator_SetModelProfilesSettings_OverridesBuildTimeSnapshot pins the runtime
// override contract (mirroring TestOrchestrator_SetE2SSettings_OverridesBuildTimeGate):
// an orchestrator built with the narrowing OFF must honor a later
// SetModelProfilesSettings(narrowing ON) — and, crucially, a later SetModelProfilesSettings(narrowing
// OFF) must clear it again — without a rebuild. This is the recovery path the
// documented error message promises ("disable the Model Profiles profile ... to use
// goal mode") for an already-live session.
func TestOrchestrator_SetModelProfilesSettings_OverridesBuildTimeSnapshot(t *testing.T) {
	o := newGoalTestOrchestrator()
	o.config.ModelProfiles = ModelProfilesSettings{} // built with the narrowing off

	if o.modelProfilesEssentialToolsEnabled() {
		t.Fatal("precondition: narrowing must read off at build time")
	}

	// A runtime toggle turns the narrowing ON: the guard must now fire.
	o.SetModelProfilesSettings(modelProfilesNarrowingOn())
	if !o.modelProfilesEssentialToolsEnabled() {
		t.Fatal("SetModelProfilesSettings did not take effect: narrowing still reads off")
	}
	pausedGS := &goal.GoalState{Condition: "x", Status: goal.StatusActive, CreatedAt: time.Now()}
	if _, err := o.resumeGoalLoop(
		context.Background(), "resume", orchestration.NewMapBlackboard(), nil, "",
		nil, pausedGS, nil, "", "",
	); !errors.Is(err, ErrGoalBlockedByModelProfiles) {
		t.Fatalf("resumeGoalLoop error = %v, want ErrGoalBlockedByModelProfiles after runtime narrowing ON", err)
	}

	// Turning it back OFF must also take effect: the recovery path works for a
	// live orchestrator (no restart, no rebuild).
	o.SetModelProfilesSettings(ModelProfilesSettings{})
	if o.modelProfilesEssentialToolsEnabled() {
		t.Fatal("SetModelProfilesSettings did not clear the narrowing")
	}
}

// TestHandleMessage_GoalBlockedByModelProfiles_RuntimeNarrowingOn verifies HandleMessage's
// goal guard reads the runtime override, not the stale build-time snapshot: an
// orchestrator built with ModelProfiles off that a later SetModelProfilesSettings narrows must
// refuse a goal before any LLM work runs.
func TestHandleMessage_GoalBlockedByModelProfiles_RuntimeNarrowingOn(t *testing.T) {
	mockLLM := &mockLLMCaller{
		callFn: func(_ context.Context, _ llm.ChatRequest) (*llm.ChatResponse, error) {
			return &llm.ChatResponse{Message: llm.Message{Role: "assistant", Content: "should never run"}}, nil
		},
	}
	o := newE2STestOrchestrator(mockLLM, createTestRegistry(), nil, nil)
	// Built with ModelProfiles off (zero value) — goal allowed at build time.
	o.SetModelProfilesSettings(modelProfilesNarrowingOn())

	result, err := o.HandleMessage(context.Background(), "achieve something", "session-modelProfiles-goal-runtime", HandleOptions{Goal: true})
	if !errors.Is(err, ErrGoalBlockedByModelProfiles) {
		t.Fatalf("HandleMessage error = %v, want ErrGoalBlockedByModelProfiles after runtime narrowing ON", err)
	}
	if result != nil {
		t.Errorf("HandleMessage result = %+v, want nil on the block", result)
	}
	mockLLM.mu.Lock()
	calls := len(mockLLM.calls)
	mockLLM.mu.Unlock()
	if calls != 0 {
		t.Errorf("LLM calls = %d, want 0 — the block must precede any goal work", calls)
	}
}

// TestApplyModelProfilesPromptProfile_LiteGatesOnEffectiveSettings pins that the helper
// shared by prepareRequestContext AND Resume (the Issue 7 fix) carries the Lite
// profile into the context from the effective settings — including the runtime
// override — so a resumed goal's specialized verifier run gets the same Lite
// directive the fresh path did.
func TestApplyModelProfilesPromptProfile_LiteGatesOnEffectiveSettings(t *testing.T) {
	o := &Orchestrator{}

	if modelProfilesLiteFromCtx(o.applyModelProfilesPromptProfile(context.Background())) {
		t.Fatal("lite must be off with a zero ModelProfiles config")
	}

	o.SetModelProfilesSettings(ModelProfilesSettings{
		Enabled:      true,
		SystemPrompt: ModelProfilesSystemPromptSettings{Lite: true, FewShot: true, ReasoningScaffold: true},
	})
	ctx := o.applyModelProfilesPromptProfile(context.Background())
	if !modelProfilesLiteFromCtx(ctx) {
		t.Fatal("applyModelProfilesPromptProfile did not set the lite key from the effective settings")
	}
	p, ok := modelProfilesPromptProfileFromCtx(ctx)
	if !ok || !p.FewShot || !p.ReasoningScaffold {
		t.Fatalf("lite sub-toggle flags not carried: %+v (ok=%v)", p, ok)
	}

	// Master off → lite off even with the variant on (defense-in-depth).
	o.SetModelProfilesSettings(ModelProfilesSettings{Enabled: false, SystemPrompt: ModelProfilesSystemPromptSettings{Lite: true}})
	if modelProfilesLiteFromCtx(o.applyModelProfilesPromptProfile(context.Background())) {
		t.Fatal("lite must be off when the master toggle is off")
	}
}
