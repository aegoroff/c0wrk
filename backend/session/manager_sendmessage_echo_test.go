package session

import (
	"context"
	"testing"
	"time"

	"github.com/v0lka/sp4rk/llm"
)

// The message_received echo is the UI's delivery notification: every surface
// watching the session renders the user card from it, and the sending surface
// dedupes the echo against its optimistic card by exact content. The persisted
// row stores the RAW user input (FrontendAPI.SendMessage saves Content: text,
// not the preprocessed form) and the optimistic card renders the raw form, so
// the echo must carry the raw input whenever the caller dispatched
// preprocessed text with WithEchoText — otherwise any message whose
// preprocessing actually changed the text (a leading "/skill" mention, an
// @file ref) renders twice on the sending surface: the optimistic card plus a
// ref-less duplicate rendered from the processed echo.

// waitForReceived drains the event channel until message_received arrives and
// returns its typed payload.
func waitForReceived(t *testing.T, events chan Event) MessageReceivedData {
	t.Helper()
	evt, ok := waitForEvent(events, "message_received", 2*time.Second)
	if !ok {
		t.Fatal("timeout waiting for message_received event")
	}
	data, ok := evt.Data.(MessageReceivedData)
	if !ok {
		t.Fatalf("message_received data type = %T, want MessageReceivedData", evt.Data)
	}
	return data
}

func TestSendMessage_EchoCarriesRawText_FreshTask(t *testing.T) {
	const (
		raw       = "/vibespec-explore fix the flaky test"
		processed = "fix the flaky test"
	)
	caller := &scriptedLLM{scripted: []*llm.ChatResponse{
		routingJSONResponse("software_engineering", 1),
		finishResponse("done"),
	}}
	eventChan := make(chan Event, 100)
	mgr := NewManager(routingFunctionalFactory(caller), func(e Event) { eventChan <- e }, runtimeTempDir(t))
	t.Cleanup(mgr.Shutdown)

	info, err := mgr.CreateSession(testProjectID, testWorkspacePath(t))
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	if _, err := mgr.SendMessageClassified(context.Background(), info.ID, processed, nil, nil, nil, "", "", false, "", false, false, WithEchoText(raw)); err != nil {
		t.Fatalf("SendMessageClassified failed: %v", err)
	}

	data := waitForReceived(t, eventChan)
	if data.SessionID != info.ID {
		t.Errorf("echo session_id = %q, want %q", data.SessionID, info.ID)
	}
	if data.Text != raw {
		t.Errorf("echo text = %q, want the RAW input %q (the processed form would duplicate the optimistic card on the sending surface)", data.Text, raw)
	}
}

// Without WithEchoText the echo carries the dispatch text itself — the
// historical behavior every internal caller and existing test relies on.
func TestSendMessage_EchoDefaultsToDispatchText(t *testing.T) {
	const dispatchText = "plain dispatch text"
	caller := &scriptedLLM{scripted: []*llm.ChatResponse{
		routingJSONResponse("software_engineering", 1),
		finishResponse("done"),
	}}
	eventChan := make(chan Event, 100)
	mgr := NewManager(routingFunctionalFactory(caller), func(e Event) { eventChan <- e }, runtimeTempDir(t))
	t.Cleanup(mgr.Shutdown)

	info, err := mgr.CreateSession(testProjectID, testWorkspacePath(t))
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	if _, err := mgr.SendMessageClassified(context.Background(), info.ID, dispatchText, nil, nil, nil, "", "", false, "", false, false); err != nil {
		t.Fatalf("SendMessageClassified failed: %v", err)
	}

	if data := waitForReceived(t, eventChan); data.Text != dispatchText {
		t.Errorf("echo text = %q, want the dispatch text %q", data.Text, dispatchText)
	} else if data.ClientSendID != "" {
		t.Errorf("echo client_send_id = %q, want empty without WithClientMessageID", data.ClientSendID)
	}
}

// The live path queues the PROCESSED text into the running request (what the
// LLM consumes at the next step boundary) while the echo carries the RAW form.
func TestSendMessage_EchoCarriesRawText_LiveInterjection(t *testing.T) {
	manager, sess, orch, events := liveTestSession(t)

	const (
		raw       = "/planner steer left"
		processed = "steer left"
	)
	if _, err := manager.SendMessageClassified(context.Background(), sess.ID, processed, nil, nil, nil, "", "", false, "", false, false, WithEchoText(raw)); err != nil {
		t.Fatalf("live SendMessageClassified returned error: %v", err)
	}

	if got := orch.DrainLiveUserMessages(); got != processed {
		t.Errorf("drained %q, want the PROCESSED text in the LLM queue", got)
	}
	if data := waitForReceived(t, events); data.Text != raw {
		t.Errorf("echo text = %q, want the RAW input %q", data.Text, raw)
	}
}

// The echo carries the sending surface's optimistic-card id back
// (WithClientMessageID): the sender dedups the echo by this id instead of
// content+time-window, so a second surface sending identical text inside the
// dedup window renders its own card instead of being swallowed as the echo.
func TestSendMessage_EchoCarriesClientSendID(t *testing.T) {
	const (
		raw = "identical text on two surfaces"
		id  = "opt-abc123"
	)
	caller := &scriptedLLM{scripted: []*llm.ChatResponse{
		routingJSONResponse("software_engineering", 1),
		finishResponse("done"),
	}}
	eventChan := make(chan Event, 100)
	mgr := NewManager(routingFunctionalFactory(caller), func(e Event) { eventChan <- e }, runtimeTempDir(t))
	t.Cleanup(mgr.Shutdown)

	info, err := mgr.CreateSession(testProjectID, testWorkspacePath(t))
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	if _, err := mgr.SendMessageClassified(context.Background(), info.ID, raw, nil, nil, nil, "", "", false, "", false, false, WithEchoText(raw), WithClientMessageID(id)); err != nil {
		t.Fatalf("SendMessageClassified failed: %v", err)
	}

	data := waitForReceived(t, eventChan)
	if data.Text != raw {
		t.Errorf("echo text = %q, want the raw input %q", data.Text, raw)
	}
	if data.ClientSendID != id {
		t.Errorf("echo client_send_id = %q, want the optimistic-card id %q", data.ClientSendID, id)
	}
}
