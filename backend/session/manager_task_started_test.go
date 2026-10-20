package session

import (
	"context"
	"testing"
	"time"

	coretools "github.com/v0lka/c0wrk/core/tools"
	"github.com/v0lka/sp4rk/llm"
)

// TestSendMessage_TaskStartedEmittedOncePerTask pins the start-side task
// lifecycle contract behind the desktop sessions:changed mirror: a real task
// activation emits EXACTLY ONE task_started (the single activation point in
// SendMessage covers the fresh dispatch; goal/E2S/continue-interrupted
// funnel through the same point), a natural termination emits EXACTLY ONE
// terminal task_complete, and the fresh path carries no resume-side events —
// so combined with the desktop layer's 1:1 mirror
// (TestBuildUIEmitFunc_TaskLifecycleEmitsSessionsChanged) every real
// lifecycle transition yields exactly one global sessions:changed push and
// the session-scoped stream stays undoubled.
func TestSendMessage_TaskStartedEmittedOncePerTask(t *testing.T) {
	shared := coretools.NewToolRegistry()
	shared.ApplySecurityState(nil, false, coretools.AutonomyModeStandard, coretools.SilentModeState{})

	caller := &scriptedLLM{scripted: []*llm.ChatResponse{
		routingJSONResponse("general", 3),
		finishResponse("done"),
	}}
	eventChan := make(chan Event, 100)
	mgr := NewManager(posturePinningFactory(caller, shared, nil), func(e Event) { eventChan <- e }, runtimeTempDir(t))
	t.Cleanup(mgr.Shutdown) // stop the manager before its temp dirs are removed

	info, err := mgr.CreateSession(testProjectID, runtimeTempDir(t))
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	if err := mgr.SendMessage(context.Background(), info.ID, "do the thing", nil, nil, nil, "", "", false, "", false, false); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	// Consume the run's events, counting the lifecycle emissions until the
	// terminal task_complete arrives. task_started is emitted synchronously
	// inside SendMessage BEFORE the task goroutine launches, so every copy
	// must already be buffered by the time the terminal event lands.
	started, completed := 0, 0
	deadline := time.After(5 * time.Second)
	for completed == 0 {
		select {
		case e := <-eventChan:
			switch e.Type {
			case EventTaskStarted:
				started++
			case "task_complete":
				completed++
			}
		case <-deadline:
			t.Fatal("timed out waiting for task_complete")
		}
	}

	// Bounded join on the epilogue tail (agent_metrics and friends still land
	// after task_complete): no further lifecycle emission may arrive behind
	// the terminal event. A duplicate here would double the global
	// sessions:changed push for a single transition.
	quiesced := false
	for !quiesced {
		select {
		case e := <-eventChan:
			switch e.Type {
			case EventTaskStarted:
				started++
			case "task_complete", "task_cancelled", "task_resumed", "session_resumed":
				t.Errorf("unexpected lifecycle event after terminal task_complete: %s", e.Type)
			}
		case <-time.After(200 * time.Millisecond):
			// Join window elapsed with no further event: the epilogue is done.
			quiesced = true
		}
	}

	if started != 1 {
		t.Errorf("task_started emissions = %d, want exactly 1", started)
	}
	if completed != 1 {
		t.Errorf("task_complete emissions = %d, want exactly 1", completed)
	}
}
