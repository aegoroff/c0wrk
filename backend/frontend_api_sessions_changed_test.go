package backend

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/session"
)

// Tests in this file pin the sessions:changed emission contract: every
// successful session-list mutation goes through emitSessionsChanged so both
// transports (Wails + event tap) can refresh the sidebar lists. Each test
// attaches a promoteEventCapture (shared helper from the promotion tests) to
// the harness's emitEvent and asserts the event's presence after the
// mutation, and — where a failure path is cheap to drive — its absence.

// setActiveProjectForEvents points the API's active-project state at the
// harness project so CreateSession's RPC path has a target.
func setActiveProjectForEvents(h *projectSwitchTestHarness) {
	h.api.activeProjectMu.Lock()
	h.api.activeProjectID = h.projectID
	h.api.activeProjectPath = h.workspace
	h.api.activeProjectMu.Unlock()
}

func TestCreateSession_EmitsSessionsChanged(t *testing.T) {
	h := newProjectSwitchHarness(t)
	defer h.close(t)
	events := &promoteEventCapture{}
	h.api.emitEvent = events.emit
	setActiveProjectForEvents(h)

	info, err := h.api.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if info == nil || info.ID == "" {
		t.Fatalf("invalid session: %+v", info)
	}
	if !events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after CreateSession")
	}
}

func TestCreateSession_ErrorDoesNotEmitSessionsChanged(t *testing.T) {
	h := newProjectSwitchHarness(t)
	defer h.close(t)
	events := &promoteEventCapture{}
	h.api.emitEvent = events.emit
	// No active project → the RPC fails before any mutation.
	h.api.activeProjectMu.Lock()
	h.api.activeProjectID = ""
	h.api.activeProjectPath = ""
	h.api.activeProjectMu.Unlock()

	if _, err := h.api.CreateSession(); err == nil {
		t.Fatal("expected error without an active project")
	}
	if events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must not be emitted on a failed create")
	}
}

func TestForkSessionPlain_EmitsSessionsChanged(t *testing.T) {
	api, sessionStore, _, db := newForkTestAPI(t)
	defer func() { _ = db.Close() }()
	events := &promoteEventCapture{}
	api.emitEvent = events.emit
	ctx := context.Background()

	// A settled session (no unfinished task) is forkable.
	if err := sessionStore.SaveTask(ctx, session.TaskRecord{
		ID: "task-done", SessionID: "fork-src", OriginalRequest: "done",
		RoutingDecision: json.RawMessage(`{}`), Plan: json.RawMessage(`{}`),
		Reflections: json.RawMessage(`[]`), Status: "completed", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	fork, err := api.ForkSession("fork-src")
	if err != nil {
		t.Fatalf("ForkSession: %v", err)
	}
	if fork == nil || fork.ID == "fork-src" {
		t.Fatalf("invalid fork: %+v", fork)
	}
	if !events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after a plain fork")
	}
}

func TestForkSessionManaged_EmitsSessionsChanged(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	defer h.closeDB()
	events := &promoteEventCapture{}
	h.api.emitEvent = events.emit

	src, err := h.api.CreateManagedSession("", true, "")
	if err != nil {
		t.Fatalf("CreateManagedSession: %v", err)
	}
	// Managed creation itself commits a draft (commitManagedDraft), so the
	// event legitimately fires here too; clear the capture so the fork's own
	// emission is what the assertion below observes.
	events.names = nil

	fork, err := h.api.ForkSession(src.ID)
	if err != nil {
		t.Fatalf("ForkSession (managed): %v", err)
	}
	if fork == nil || fork.WorkspaceBinding == nil || fork.ID == src.ID {
		t.Fatalf("invalid managed fork: %+v", fork)
	}
	if !events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after a managed fork")
	}
}

func TestCommitManagedDraft_EmitsSessionsChanged(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	defer h.closeDB()
	events := &promoteEventCapture{}
	h.api.emitEvent = events.emit

	// compensateTreeName "" = adopted-tree semantics: the commit owns no
	// provisioned tree, so a failure would roll back without compensation —
	// the emission must only fire on success.
	draft := session.NewSessionDraft(h.project.ID, nil)
	info, err := h.api.commitManagedDraft(context.Background(), draft, h.repoRoot, "")
	if err != nil {
		t.Fatalf("commitManagedDraft: %v", err)
	}
	if info == nil || info.ID == "" {
		t.Fatalf("invalid session: %+v", info)
	}
	if !events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after commitManagedDraft")
	}
}

func TestCreateLocalFallbackSession_EmitsSessionsChanged(t *testing.T) {
	h := newProjectSwitchHarness(t)
	defer h.close(t)
	events := &promoteEventCapture{}
	h.api.emitEvent = events.emit

	info, err := h.api.createLocalFallbackSession(h.projectID, h.workspace, "main")
	if err != nil {
		t.Fatalf("createLocalFallbackSession: %v", err)
	}
	if info == nil || info.ID == "" {
		t.Fatalf("invalid session: %+v", info)
	}
	if !events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after the local fallback creation")
	}
}

func TestDeleteSessionWithOptions_EmitsSessionsChanged(t *testing.T) {
	h := newProjectSwitchHarness(t)
	defer h.close(t)
	events := &promoteEventCapture{}
	h.api.emitEvent = events.emit

	now := time.Now().UTC()
	h.seedSession(t, "del-me", now.Format(time.RFC3339), now.Format(time.RFC3339))

	if err := h.api.DeleteSessionWithOptions("del-me", SessionDeleteOptions{}); err != nil {
		t.Fatalf("DeleteSessionWithOptions: %v", err)
	}
	if !events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after a session deletion")
	}
}

func TestArchiveSession_EmitsSessionsChanged(t *testing.T) {
	h := newProjectSwitchHarness(t)
	defer h.close(t)
	events := &promoteEventCapture{}
	h.api.emitEvent = events.emit

	now := time.Now().UTC()
	h.seedSession(t, "arch-me", now.Format(time.RFC3339), now.Format(time.RFC3339))

	if err := h.api.ArchiveSession("arch-me"); err != nil {
		t.Fatalf("ArchiveSession: %v", err)
	}
	if !events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after an archive toggle")
	}
}

func TestPinSession_EmitsSessionsChanged(t *testing.T) {
	h := newProjectSwitchHarness(t)
	defer h.close(t)
	events := &promoteEventCapture{}
	h.api.emitEvent = events.emit

	now := time.Now().UTC()
	h.seedSession(t, "pin-me", now.Format(time.RFC3339), now.Format(time.RFC3339))

	if err := h.api.PinSession("pin-me"); err != nil {
		t.Fatalf("PinSession: %v", err)
	}
	if !events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after a pin toggle")
	}
}

func TestPromoteSessionToProject_EmitsSessionsChanged(t *testing.T) {
	h := newPromoteTestAPI(t)
	api, sessionStore, agentDir := h.api, h.sessions, h.agentDir
	seedPromotableChatSession(t, sessionStore, agentDir, "s-promote-ev")
	// The promotion harness wires events already; it must not have fired yet.
	if h.events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must not fire before the promotion")
	}

	proj, err := api.PromoteSessionToProject("s-promote-ev", "Promoted Event Project")
	if err != nil {
		t.Fatalf("PromoteSessionToProject: %v", err)
	}
	if proj == nil || proj.ID == "" {
		t.Fatalf("invalid project: %+v", proj)
	}
	if !h.events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after a promotion")
	}
	if !h.events.has(EventProjectCreated) {
		t.Fatal("project:created must still be emitted after a promotion")
	}
}

func TestCreateSessionForProject_EmitsSessionsChanged(t *testing.T) {
	h := newProjectSwitchHarness(t)
	defer h.close(t)
	events := &promoteEventCapture{}
	h.api.emitEvent = events.emit

	// createSessionForProject is the SwitchProject fallback creation
	// (frontend_api_project.go): no session yet → it must create one and emit.
	created := h.api.createSessionForProject(h.ctx, h.projectID)
	if created == "" {
		t.Fatal("expected the fallback creation to return a session id")
	}
	if !events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after the switch fallback creation")
	}
}

func TestDeleteProject_EmitsSessionsChanged(t *testing.T) {
	h := newProjectSwitchHarness(t)
	defer h.close(t)
	events := &promoteEventCapture{}
	h.api.emitEvent = events.emit

	// A live in-memory session in the project cascades away with it.
	if _, err := h.api.app.Manager().CreateSession(h.projectID, h.workspace); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := h.api.DeleteProject(h.projectID); err != nil {
		t.Fatalf("DeleteProject: %v", err)
	}
	if !events.has(EventSessionsChanged) {
		t.Fatal("sessions:changed must be emitted after a project deletion")
	}
	if !events.has(EventProjectDeleted) {
		t.Fatal("project:deleted must still be emitted")
	}
}
