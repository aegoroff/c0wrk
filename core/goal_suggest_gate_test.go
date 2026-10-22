package core

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/v0lka/sp4rk/agent/router"
	"github.com/v0lka/sp4rk/orchestration"
)

// stubGoalSuggestionProposer records the proposal and returns scripted answers.
type stubGoalSuggestionProposer struct {
	accepted bool
	err      error
	calls    int
}

func (s *stubGoalSuggestionProposer) ProposeGoalSuggestion(context.Context, string, GoalSuggestion) (bool, error) {
	s.calls++
	return s.accepted, s.err
}

// TestGoalSuggestionApplicable covers the LLM-free preconditions of the
// post-routing gate: only fresh, plain, non-review tasks on an enabled config
// with a wired proposer and no session suppression qualify.
func TestGoalSuggestionApplicable(t *testing.T) {
	base := OrchestratorConfig{GoalLoop: GoalLoopSettings{Suggest: GoalSuggestSettings{Enabled: true, MinComplexity: 2}}}
	wired := &stubGoalSuggestionProposer{accepted: true}

	tests := []struct {
		name string
		mut  func(o *Orchestrator, opts *HandleOptions)
		want bool
	}{
		{"fresh plain task", func(o *Orchestrator, opts *HandleOptions) { o.goalSuggestionProposer = wired }, true},
		{"explicit goal", func(o *Orchestrator, opts *HandleOptions) {
			o.goalSuggestionProposer = wired
			opts.Goal = true
		}, false},
		{"review mode", func(o *Orchestrator, opts *HandleOptions) {
			o.goalSuggestionProposer = wired
			opts.ReviewMode = true
		}, false},
		{"continuation", func(o *Orchestrator, opts *HandleOptions) {
			o.goalSuggestionProposer = wired
			opts.TaskID = "task-1"
		}, false},
		{"feature disabled", func(o *Orchestrator, _ *HandleOptions) {
			o.goalSuggestionProposer = wired
			o.config.GoalLoop.Suggest.Enabled = false
		}, false},
		{"session suppressed", func(o *Orchestrator, _ *HandleOptions) {
			o.goalSuggestionProposer = wired
			o.goalSuggestionDeclined.Store(true)
		}, false},
		{"no proposer wired", func(_ *Orchestrator, _ *HandleOptions) {}, false},
		{"model profiles narrowing", func(o *Orchestrator, _ *HandleOptions) {
			o.goalSuggestionProposer = wired
			o.config.ModelProfiles = ModelProfilesSettings{
				Enabled:        true,
				EssentialTools: ModelProfilesEssentialSettings{Enabled: true},
			}
		}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := &Orchestrator{config: base}
			opts := HandleOptions{}
			tt.mut(o, &opts)
			if got := o.goalSuggestionApplicable(opts); got != tt.want {
				t.Errorf("goalSuggestionApplicable() = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestGoalSuggestRoutingEligible covers the advisory routing preconditions:
// general-domain and below-floor-complexity messages never reach the
// classifier.
func TestGoalSuggestRoutingEligible(t *testing.T) {
	o := &Orchestrator{config: OrchestratorConfig{GoalLoop: GoalLoopSettings{Suggest: GoalSuggestSettings{Enabled: true, MinComplexity: 2}}}}
	tests := []struct {
		name    string
		routing *router.RoutingDecision
		want    bool
	}{
		{"nil routing", nil, false},
		{"general domain", &router.RoutingDecision{Domain: router.DomainGeneral, Complexity: 5}, false},
		{"below floor", &router.RoutingDecision{Domain: router.DomainCode, Complexity: 1}, false},
		{"at floor", &router.RoutingDecision{Domain: router.DomainCode, Complexity: 2}, true},
		{"research high", &router.RoutingDecision{Domain: router.DomainResearch, Complexity: 4}, true},
		{"mixed", &router.RoutingDecision{Domain: router.DomainMixed, Complexity: 3}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := o.goalSuggestRoutingEligible(tt.routing); got != tt.want {
				t.Errorf("goalSuggestRoutingEligible() = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestRunGoalSuggestionGate_Outcomes drives the gate's decision matrix with a
// stubbed classifier and proposer: accept, decline (suppresses), classifier
// failure (fail open, no suppression), proposer failure (fail open, no
// suppression), a not-suited verdict (no suppression), and a suggested
// verdict without explicitly stated criteria (no suppression).
func TestRunGoalSuggestionGate_Outcomes(t *testing.T) {
	routing := &router.RoutingDecision{Domain: router.DomainCode, Complexity: 4}
	tests := []struct {
		name          string
		suggestion    GoalSuggestion
		suggestErr    error
		proposer      *stubGoalSuggestionProposer
		want          goalSuggestGateOutcome
		wantSupressed bool
		wantProposals int
	}{
		{
			name:          "accepted",
			suggestion:    GoalSuggestion{Suggest: true, ExplicitCriteria: true, Reason: "obvious goal"},
			proposer:      &stubGoalSuggestionProposer{accepted: true},
			want:          gateAccepted,
			wantProposals: 1,
		},
		{
			name:          "declined suppresses the session",
			suggestion:    GoalSuggestion{Suggest: true, ExplicitCriteria: true, Reason: "obvious goal"},
			proposer:      &stubGoalSuggestionProposer{accepted: false},
			want:          gateDeclined,
			wantSupressed: true,
			wantProposals: 1,
		},
		{
			name:       "classifier error fails open without suppression",
			suggestErr: errors.New("llm down"),
			proposer:   &stubGoalSuggestionProposer{accepted: true},
			want:       gateNoSuggestion,
		},
		{
			name:          "proposer error fails open without suppression",
			suggestion:    GoalSuggestion{Suggest: true, ExplicitCriteria: true, Reason: "obvious goal"},
			proposer:      &stubGoalSuggestionProposer{err: errors.New("ui gone")},
			want:          gateNoSuggestion,
			wantProposals: 1,
		},
		{
			name:       "not suited never reaches the proposer",
			suggestion: GoalSuggestion{Suggest: false},
			proposer:   &stubGoalSuggestionProposer{accepted: true},
			want:       gateNoSuggestion,
		},
		{
			name:       "suggested without explicit criteria never reaches the proposer",
			suggestion: GoalSuggestion{Suggest: true, ExplicitCriteria: false, Reason: "implicit goal"},
			proposer:   &stubGoalSuggestionProposer{accepted: true},
			want:       gateNoSuggestion,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := newGoalTestOrchestrator()
			o.goalSuggestionProposer = tt.proposer
			o.goalSuggester = func(context.Context, string, *router.RoutingDecision) (GoalSuggestion, error) {
				return tt.suggestion, tt.suggestErr
			}
			if got := o.runGoalSuggestionGate(context.Background(), "sess-1", "build the feature", routing); got != tt.want {
				t.Errorf("gate outcome = %v, want %v", got, tt.want)
			}
			if tt.proposer != nil && tt.proposer.calls != tt.wantProposals {
				t.Errorf("proposer calls = %d, want %d", tt.proposer.calls, tt.wantProposals)
			}
			if o.goalSuggestionDeclined.Load() != tt.wantSupressed {
				t.Errorf("suppression = %v, want %v", o.goalSuggestionDeclined.Load(), tt.wantSupressed)
			}
		})
	}
}

// TestRunGoalLoopRouted_DeriveFailureFork pins the fallbackOnDeriveFailure
// contract: the suggested entry (true) surfaces deriveFailed=true with no
// result and no task-outcome persist, while the explicit entry (false) keeps
// the historical clean-exit result. deriveGoal fails fast on a nil goal
// proposer, which is exactly the deterministic failure this fork branches on.
func TestRunGoalLoopRouted_DeriveFailureFork(t *testing.T) {
	o := newGoalTestOrchestrator()
	routing := &router.RoutingDecision{Domain: router.DomainCode, Complexity: 3}
	bb := orchestration.NewMapBlackboard()

	result, deriveFailed, err := o.runGoalLoopRouted(
		context.Background(), "implement the feature", HandleOptions{}, bb,
		nil, "", routing, true,
	)
	if err != nil {
		t.Fatalf("fallback entry: err = %v, want nil", err)
	}
	if !deriveFailed {
		t.Fatal("fallback entry: deriveFailed = false, want true")
	}
	if result != nil {
		t.Fatalf("fallback entry: result = %+v, want nil (no task-outcome persist before the plain-path fallback)", result)
	}

	result, deriveFailed, err = o.runGoalLoopRouted(
		context.Background(), "implement the feature", HandleOptions{}, bb,
		nil, "", routing, false,
	)
	if err != nil {
		t.Fatalf("explicit entry: err = %v, want nil (clean exit)", err)
	}
	if deriveFailed {
		t.Fatal("explicit entry: deriveFailed = true, want false")
	}
	if result == nil {
		t.Fatal("explicit entry: result = nil, want the historical clean-exit result")
	}
}

// TestClassifyDerivationFailure pins the derivation-failure fork's
// classification — in particular that a USER CANCEL is a clean exit in BOTH
// entry modes, even on the suggested entry whose fallback would otherwise run
// the whole task as a plain Conductor pass after the user just declined the
// goal framing.
func TestClassifyDerivationFailure(t *testing.T) {
	genuine := errors.New("deriveGoal: agent completed without calling propose_goal")
	tests := []struct {
		name     string
		derr     error
		fallback bool
		want     derivationFailureOutcome
	}{
		{"context cancel bubbles", context.Canceled, true, derivationBubble},
		{"deadline exceeds bubbles", context.DeadlineExceeded, false, derivationBubble},
		{"user cancel is a clean exit on the suggested entry", errGoalDerivationCancelled, true, derivationCleanExit},
		{"user cancel is a clean exit on the explicit entry", errGoalDerivationCancelled, false, derivationCleanExit},
		{
			"cancel wrapped by the double-failure wrap still classifies as cancel",
			fmt.Errorf("%w (conductor run also errored: %w)", errGoalDerivationCancelled, errors.New("boom")),
			true, derivationCleanExit,
		},
		{"genuine failure falls back on the suggested entry", genuine, true, derivationFallbackPlain},
		{"genuine failure is a clean exit on the explicit entry", genuine, false, derivationCleanExit},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyDerivationFailure(tt.derr, tt.fallback); got != tt.want {
				t.Errorf("classifyDerivationFailure(%v, %v) = %v, want %v", tt.derr, tt.fallback, got, tt.want)
			}
		})
	}
}
