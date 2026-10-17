package desktop

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/session"
	core "github.com/v0lka/c0wrk/core"
)

// TestResolveGoalSuggestion_HappyPath verifies a registered pending suggestion
// is resolved: the decision is delivered to the channel and the entry is
// deleted.
func TestResolveGoalSuggestion_HappyPath(t *testing.T) {
	for _, decision := range []string{"accept", "decline"} {
		t.Run(decision, func(t *testing.T) {
			a := &App{}
			ch := make(chan goalSuggestionResponse, 1)
			a.pendingGoalSuggestions.Store("req-1", &pendingGoalSuggestionEntry{
				ch:        ch,
				sessionID: "sess-1",
			})
			t.Cleanup(func() { a.pendingGoalSuggestions.Delete("req-1") })

			ok := a.resolveGoalSuggestion("req-1", decision)
			if !ok {
				t.Fatal("resolveGoalSuggestion returned false for a pending suggestion")
			}
			select {
			case resp := <-ch:
				if resp.Decision != decision {
					t.Errorf("channel received %q, want %q", resp.Decision, decision)
				}
			default:
				t.Error("response was not delivered to the channel")
			}
			// Entry must be deleted after resolution.
			if _, stillThere := a.pendingGoalSuggestions.Load("req-1"); stillThere {
				t.Error("pending suggestion entry was not deleted after resolution")
			}
		})
	}
}

func TestResolveGoalSuggestion_EmptyRequestID(t *testing.T) {
	a := &App{}
	if a.resolveGoalSuggestion("", "accept") {
		t.Error("expected false for empty requestID")
	}
}

func TestResolveGoalSuggestion_UnknownRequestID(t *testing.T) {
	a := &App{}
	if a.resolveGoalSuggestion("nonexistent", "accept") {
		t.Error("expected false for unknown requestID")
	}
}

// TestHandleGoalSuggestionResponse_Dispatches verifies a valid payload
// dispatches to resolveGoalSuggestion on both decisions.
func TestHandleGoalSuggestionResponse_Dispatches(t *testing.T) {
	for _, decision := range []string{"accept", "decline"} {
		t.Run(decision, func(t *testing.T) {
			a := &App{}
			ch := make(chan goalSuggestionResponse, 1)
			a.pendingGoalSuggestions.Store("req-3", &pendingGoalSuggestionEntry{
				ch:        ch,
				sessionID: "sess-3",
			})
			t.Cleanup(func() { a.pendingGoalSuggestions.Delete("req-3") })

			a.handleGoalSuggestionResponse(map[string]any{
				"request_id": "req-3",
				"decision":   decision,
			}, slog.Default().WithGroup("test"))

			resp := <-ch
			if resp.Decision != decision {
				t.Errorf("expected %q dispatched, got %q", decision, resp.Decision)
			}
		})
	}
}

// TestHandleGoalSuggestionResponse_MissingRequestID verifies a payload without
// a request_id is skipped (the handler returns without dispatching).
func TestHandleGoalSuggestionResponse_MissingRequestID(t *testing.T) {
	a := &App{}
	ch := make(chan goalSuggestionResponse, 1)
	a.pendingGoalSuggestions.Store("req-4", &pendingGoalSuggestionEntry{
		ch:        ch,
		sessionID: "sess-4",
	})
	t.Cleanup(func() { a.pendingGoalSuggestions.Delete("req-4") })

	// No request_id in the payload — should be a no-op (channel stays empty).
	a.handleGoalSuggestionResponse(map[string]any{
		"decision": "accept",
	}, expectedDiagnostics(t, diagnosticExpectation{
		level: slog.LevelWarn, message: "goal_suggestion response: missing request_id",
		attrs: map[string]string{"key": "request_id"},
	}))

	select {
	case <-ch:
		t.Error("expected no dispatch for payload missing request_id")
	default:
		// pass: channel empty
	}
}

// TestHandleGoalSuggestionResponse_UnrecognizedDecision verifies a decision
// other than accept/decline is rejected before dispatch — the gate's
// contract has exactly two answers.
func TestHandleGoalSuggestionResponse_UnrecognizedDecision(t *testing.T) {
	a := &App{}
	ch := make(chan goalSuggestionResponse, 1)
	a.pendingGoalSuggestions.Store("req-5", &pendingGoalSuggestionEntry{
		ch:        ch,
		sessionID: "sess-5",
	})
	t.Cleanup(func() { a.pendingGoalSuggestions.Delete("req-5") })

	a.handleGoalSuggestionResponse(map[string]any{
		"request_id": "req-5",
		"decision":   "maybe",
	}, expectedDiagnostics(t, diagnosticExpectation{
		level: slog.LevelWarn, message: "goal suggestion response has unrecognized decision",
		attrs: map[string]string{"request_id": "req-5", "decision": "maybe"},
	}))

	select {
	case <-ch:
		t.Error("expected no dispatch for an unrecognized decision")
	default:
		// pass: channel empty
	}
	// The stale entry must remain resolvable (the user may still answer via
	// the RPC path) — the handler rejected the PAYLOAD, not the pending card.
	if _, stillThere := a.pendingGoalSuggestions.Load("req-5"); !stillThere {
		t.Error("pending suggestion entry was deleted by a rejected payload")
	}
}

// TestGoalSuggestionAdapter_AcceptRoundTrip verifies the adapter maps the
// channel decision onto the core contract: accept → (true, nil). The uiEmit
// stub doubles as the registration signal — the adapter registers the pending
// entry BEFORE emitting, so a fired emit proves the channel is ready.
func TestGoalSuggestionAdapter_AcceptRoundTrip(t *testing.T) {
	a := &App{}
	registered := make(chan struct{})
	adapter := &goalSuggestionAdapter{
		ctx: context.Background(),
		app: a,
		uiEmit: func(session.Event) {
			close(registered)
		},
	}

	type outcome struct {
		accepted bool
		err      error
	}
	done := make(chan outcome, 1)
	go func() {
		accepted, err := adapter.ProposeGoalSuggestion(context.Background(), "sess-rt", core.GoalSuggestion{Suggest: true, Reason: "r"})
		done <- outcome{accepted, err}
	}()

	<-registered
	if !a.resolveGoalSuggestion("req-rt", "accept") {
		// The request ID is generated inside the adapter; resolve whatever
		// entry it registered.
		var found string
		a.pendingGoalSuggestions.Range(func(key, _ any) bool {
			found, _ = key.(string)
			return false
		})
		if found == "" || !a.resolveGoalSuggestion(found, "accept") {
			t.Fatal("no resolvable pending suggestion entry after registration")
		}
	}

	o := <-done
	if o.err != nil || !o.accepted {
		t.Errorf("ProposeGoalSuggestion = (%v, %v), want (true, nil)", o.accepted, o.err)
	}
}

// TestGoalSuggestionAdapter_ShutdownDrainSignalsError pins the drain
// contract end-to-end: a SHUTDOWN resolution surfaces as an error
// (errGoalSuggestionShutdown), never as a (false, nil) user decline — the
// core gate fails open on errors and must not engage session suppression
// because the app quit while the card was open.
func TestGoalSuggestionAdapter_ShutdownDrainSignalsError(t *testing.T) {
	a := &App{}
	registered := make(chan struct{})
	adapter := &goalSuggestionAdapter{
		ctx: context.Background(),
		app: a,
		uiEmit: func(session.Event) {
			close(registered)
		},
	}
	done := make(chan error, 1)
	go func() {
		_, err := adapter.ProposeGoalSuggestion(context.Background(), "sess-sd", core.GoalSuggestion{Suggest: true, Reason: "r"})
		done <- err
	}()

	<-registered
	// Resolve through the drain, exactly the way Shutdown does.
	a.drainPendingGoalSuggestions()

	select {
	case err := <-done:
		if !errors.Is(err, errGoalSuggestionShutdown) {
			t.Errorf("ProposeGoalSuggestion error = %v, want errGoalSuggestionShutdown", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("adapter did not return after the shutdown drain")
	}
}

// TestDrainPendingGoalSuggestionsSignalsShutdown verifies the drain itself:
// every pending entry receives the SHUTDOWN signal (not a synthetic decline)
// and is removed from the pending map.
func TestDrainPendingGoalSuggestionsSignalsShutdown(t *testing.T) {
	a := &App{}
	ch := make(chan goalSuggestionResponse, 1)
	a.pendingGoalSuggestions.Store("req-drain", &pendingGoalSuggestionEntry{
		ch:        ch,
		sessionID: "sess-drain",
	})
	t.Cleanup(func() { a.pendingGoalSuggestions.Delete("req-drain") })

	a.drainPendingGoalSuggestions()

	select {
	case resp := <-ch:
		if !resp.Shutdown {
			t.Errorf("drain delivered Decision=%q Shutdown=%v, want the SHUTDOWN signal", resp.Decision, resp.Shutdown)
		}
		if resp.Decision != "" {
			t.Errorf("drain delivered a synthetic decision %q, want none", resp.Decision)
		}
	default:
		t.Fatal("drain did not deliver a response to the pending entry")
	}
	if _, stillThere := a.pendingGoalSuggestions.Load("req-drain"); stillThere {
		t.Error("drain left the pending entry in the map")
	}
}
