package backend

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/backend/project"
	"github.com/v0lka/c0wrk/backend/session"
)

// suggAPITs renders the i-th deterministic hour stamp (2025-06-01T00:00:00Z
// plus i hours): distinct, ordered RFC3339 values so ListSessionsByProject's
// effective-activity order (created_at for sessions without activity) is
// stable without sleeping.
func suggAPITs(i int) string {
	return fmt.Sprintf("2025-06-%02dT%02d:00:00Z", 1+i/24, i%24)
}

// suggestionsAPIHarness wires a FrontendAPI (config part from newTestAPI) to
// a real SQLite project/session store pair sharing one in-memory DB, plus a
// project manager to create the project rows the session FKs hang off.
type suggestionsAPIHarness struct {
	f     *FrontendAPI
	store *session.SQLiteSessionStore
	pm    *project.Manager
}

func newSuggestionsAPIHarness(t *testing.T) *suggestionsAPIHarness {
	t.Helper()
	f, _, _ := newTestAPI(t)
	db := openProjectSwitchTestDB(t)
	t.Cleanup(func() { _ = db.Close() })
	projStore, err := project.NewSQLiteProjectStore(db)
	if err != nil {
		t.Fatalf("project store: %v", err)
	}
	store, err := session.NewSQLiteSessionStore(db)
	if err != nil {
		t.Fatalf("session store: %v", err)
	}
	f.store = store
	return &suggestionsAPIHarness{
		f:     f,
		store: store,
		pm:    project.NewManager(projStore, t.TempDir(), nil),
	}
}

func (h *suggestionsAPIHarness) mustProject(t *testing.T, name string) string {
	t.Helper()
	proj, err := h.pm.CreateProject(name, "")
	if err != nil {
		t.Fatalf("CreateProject(%q): %v", name, err)
	}
	return proj.ID
}

func (h *suggestionsAPIHarness) mustNoProject(t *testing.T) string {
	t.Helper()
	if _, err := h.pm.EnsureNoProject(); err != nil {
		t.Fatalf("EnsureNoProject: %v", err)
	}
	return project.NoProjectID
}

func (h *suggestionsAPIHarness) mustSession(t *testing.T, id, projectID string, tsIdx int) {
	t.Helper()
	err := h.store.SaveSession(context.Background(), session.SessionInfo{
		ID:        id,
		ProjectID: projectID,
		Name:      "Session " + id,
		CreatedAt: suggAPITs(tsIdx),
	})
	if err != nil {
		t.Fatalf("SaveSession(%q): %v", id, err)
	}
}

func (h *suggestionsAPIHarness) mustMessage(t *testing.T, sessionID, role, content string) {
	t.Helper()
	err := h.store.SaveMessage(context.Background(), session.ChatMessage{
		SessionID: sessionID,
		Role:      role,
		Content:   content,
	})
	if err != nil {
		t.Fatalf("SaveMessage(%s/%s): %v", sessionID, role, err)
	}
}

// mustSuggestionPass persists one generation pass (one kind, active status)
// for the session — the store-level shape the manager's passes produce.
func (h *suggestionsAPIHarness) mustSuggestionPass(t *testing.T, sessionID, kind string, texts ...string) {
	t.Helper()
	rows := make([]session.PromptSuggestion, 0, len(texts))
	for _, text := range texts {
		rows = append(rows, session.PromptSuggestion{
			SessionID: sessionID,
			Kind:      kind,
			Text:      text,
		})
	}
	if _, err := h.store.SavePromptSuggestions(context.Background(), rows); err != nil {
		t.Fatalf("SavePromptSuggestions(%s/%s): %v", sessionID, kind, err)
	}
}

func suggestionTextsOf(rows []session.PromptSuggestion) []string {
	texts := make([]string, 0, len(rows))
	for _, row := range rows {
		texts = append(texts, row.Text)
	}
	return texts
}

// TestGetPromptSuggestions_NilStoreIsEmpty pins the uninitialized posture:
// no store is an empty "none" response, not an error.
func TestGetPromptSuggestions_NilStoreIsEmpty(t *testing.T) {
	f := &FrontendAPI{}
	f.seedPublished.Store(true)

	resp := f.GetPromptSuggestions("s1", "p1")
	if resp.Source != promptSuggestionsSourceNone {
		t.Errorf("Source = %q, want %q", resp.Source, promptSuggestionsSourceNone)
	}
	if resp.Suggestions == nil || len(resp.Suggestions) != 0 {
		t.Errorf("Suggestions = %v, want empty non-nil", resp.Suggestions)
	}
	if resp.SessionID != "s1" || resp.ProjectID != "p1" {
		t.Errorf("addressed ids = (%q, %q), want (s1, p1)", resp.SessionID, resp.ProjectID)
	}
}

// TestGetPromptSuggestions_ContinuationForSessionWithContent pins the
// continuation branch: a session with a transcript is served its own active
// goal_advance set, and the next_task rows of the same session do not mix in.
func TestGetPromptSuggestions_ContinuationForSessionWithContent(t *testing.T) {
	h := newSuggestionsAPIHarness(t)
	projID := h.mustProject(t, "Continuation")
	h.mustSession(t, "s-live", projID, 0)
	h.mustMessage(t, "s-live", "user", "почини тесты")
	h.mustMessage(t, "s-live", "assistant", "готово")
	h.mustSuggestionPass(t, "s-live", session.SuggestionKindGoalAdvance, "добавь регрессионный тест", "обнови README")
	h.mustSuggestionPass(t, "s-live", session.SuggestionKindNextTask, "не смешивать виды")

	resp := h.f.GetPromptSuggestions("s-live", projID)
	if resp.Source != promptSuggestionsSourceContinuation {
		t.Errorf("Source = %q, want %q", resp.Source, promptSuggestionsSourceContinuation)
	}
	want := []string{"добавь регрессионный тест", "обнови README"}
	if got := suggestionTextsOf(resp.Suggestions); !slices.Equal(got, want) {
		t.Errorf("texts = %v, want %v", got, want)
	}
	for _, row := range resp.Suggestions {
		if row.Kind != session.SuggestionKindGoalAdvance {
			t.Errorf("row kind = %q, want only %q", row.Kind, session.SuggestionKindGoalAdvance)
		}
		if row.Status != session.SuggestionStatusActive {
			t.Errorf("row status = %q, want active", row.Status)
		}
		if row.SessionID != "s-live" {
			t.Errorf("row session = %q, want s-live", row.SessionID)
		}
	}
	if resp.SessionID != "s-live" || resp.ProjectID != projID {
		t.Errorf("addressed ids = (%q, %q), want (s-live, %q)", resp.SessionID, resp.ProjectID, projID)
	}
}

// TestGetPromptSuggestions_EmptySessionGetsProjectNextTask pins the
// new-session branch: an empty session of a real project is served the
// project's active next_task set; goal_advance rows of the origin session do
// not leak, and the returned rows keep their ORIGINATING session_id.
func TestGetPromptSuggestions_EmptySessionGetsProjectNextTask(t *testing.T) {
	h := newSuggestionsAPIHarness(t)
	projID := h.mustProject(t, "NewSession")
	h.mustSession(t, "s-old", projID, 0)
	h.mustMessage(t, "s-old", "user", "сделай дашборд")
	h.mustMessage(t, "s-old", "assistant", "готово")
	h.mustSuggestionPass(t, "s-old", session.SuggestionKindNextTask, "добавь фильтры", "настрой алерты")
	h.mustSuggestionPass(t, "s-old", session.SuggestionKindGoalAdvance, "не Leak")

	h.mustSession(t, "s-new", projID, 1)

	resp := h.f.GetPromptSuggestions("s-new", projID)
	if resp.Source != promptSuggestionsSourceNewSession {
		t.Errorf("Source = %q, want %q", resp.Source, promptSuggestionsSourceNewSession)
	}
	want := []string{"добавь фильтры", "настрой алерты"}
	if got := suggestionTextsOf(resp.Suggestions); !slices.Equal(got, want) {
		t.Errorf("texts = %v, want %v", got, want)
	}
	for _, row := range resp.Suggestions {
		if row.SessionID != "s-old" {
			t.Errorf("row session = %q, want the originating s-old", row.SessionID)
		}
		if row.Kind != session.SuggestionKindNextTask {
			t.Errorf("row kind = %q, want only %q", row.Kind, session.SuggestionKindNextTask)
		}
	}
}

// TestGetPromptSuggestions_NewestActiveSetWins pins the scan order: when
// several project sessions carry active next_task sets, the NEWEST session's
// set is served.
func TestGetPromptSuggestions_NewestActiveSetWins(t *testing.T) {
	h := newSuggestionsAPIHarness(t)
	projID := h.mustProject(t, "Newest")
	h.mustSession(t, "s-a", projID, 0)
	h.mustSuggestionPass(t, "s-a", session.SuggestionKindNextTask, "старый набор")
	h.mustSession(t, "s-b", projID, 1)
	h.mustSuggestionPass(t, "s-b", session.SuggestionKindNextTask, "свежий набор")
	h.mustSession(t, "s-new", projID, 2)

	resp := h.f.GetPromptSuggestions("s-new", projID)
	if resp.Source != promptSuggestionsSourceNewSession {
		t.Errorf("Source = %q, want %q", resp.Source, promptSuggestionsSourceNewSession)
	}
	if got := suggestionTextsOf(resp.Suggestions); !slices.Equal(got, []string{"свежий набор"}) {
		t.Errorf("texts = %v, want the newest session's set", got)
	}
}

// TestGetPromptSuggestions_ProjectWindowBoundsScan pins the bounded scan:
// a next_task set carried by a session outside the 10-session project window
// (ADR-088 D3) is not offered.
func TestGetPromptSuggestions_ProjectWindowBoundsScan(t *testing.T) {
	h := newSuggestionsAPIHarness(t)
	projID := h.mustProject(t, "Window")
	// The oldest session carries the only active set but sits outside the
	// window: s-deep plus s-01..s-10 fill the scan, s-new is the newest.
	h.mustSession(t, "s-deep", projID, 0)
	h.mustSuggestionPass(t, "s-deep", session.SuggestionKindNextTask, "вне окна")
	for i := 1; i <= 10; i++ {
		h.mustSession(t, fmt.Sprintf("s-%02d", i), projID, i)
	}
	h.mustSession(t, "s-new", projID, 11)

	resp := h.f.GetPromptSuggestions("s-new", projID)
	if resp.Source != promptSuggestionsSourceNewSession {
		t.Errorf("Source = %q, want %q (a consulted project window names its context even when empty)", resp.Source, promptSuggestionsSourceNewSession)
	}
	if len(resp.Suggestions) != 0 {
		t.Errorf("texts = %v, want nothing from beyond the window", suggestionTextsOf(resp.Suggestions))
	}
}

// TestGetPromptSuggestions_ChatContentKeepsContinuation pins the branch
// precedence: a CHAT (No-Project) session with a transcript is still served
// its goal_advance set — the CHAT gate only closes the new-session branch.
func TestGetPromptSuggestions_ChatContentKeepsContinuation(t *testing.T) {
	h := newSuggestionsAPIHarness(t)
	chatID := h.mustNoProject(t)
	h.mustSession(t, "s-chat", chatID, 0)
	h.mustMessage(t, "s-chat", "user", "объясни миграции")
	h.mustMessage(t, "s-chat", "assistant", "миграции — это")
	h.mustSuggestionPass(t, "s-chat", session.SuggestionKindGoalAdvance, "покажи пример вниз")

	resp := h.f.GetPromptSuggestions("s-chat", project.NoProjectID)
	if resp.Source != promptSuggestionsSourceContinuation {
		t.Errorf("Source = %q, want %q", resp.Source, promptSuggestionsSourceContinuation)
	}
	if got := suggestionTextsOf(resp.Suggestions); !slices.Equal(got, []string{"покажи пример вниз"}) {
		t.Errorf("texts = %v, want the continuation set", got)
	}
}

// TestGetPromptSuggestions_ChatEmptySessionOffersNothing pins the CHAT gate:
// an empty No-Project session (and any session without a project id) gets
// the none source with an empty set.
func TestGetPromptSuggestions_ChatEmptySessionOffersNothing(t *testing.T) {
	h := newSuggestionsAPIHarness(t)
	chatID := h.mustNoProject(t)
	h.mustSession(t, "s-fresh", chatID, 0)

	resp := h.f.GetPromptSuggestions("s-fresh", project.NoProjectID)
	if resp.Source != promptSuggestionsSourceNone {
		t.Errorf("Source = %q, want %q", resp.Source, promptSuggestionsSourceNone)
	}
	if len(resp.Suggestions) != 0 {
		t.Errorf("texts = %v, want none", suggestionTextsOf(resp.Suggestions))
	}

	// A brand-new unsaved session with no project id at all: same posture.
	resp = h.f.GetPromptSuggestions("s-unsaved", "")
	if resp.Source != promptSuggestionsSourceNone {
		t.Errorf("Source = %q, want %q", resp.Source, promptSuggestionsSourceNone)
	}
	if len(resp.Suggestions) != 0 {
		t.Errorf("texts = %v, want none", suggestionTextsOf(resp.Suggestions))
	}
}

// TestGetPromptSuggestions_ContentSessionStaysOnContinuationBranch pins the
// no-fallthrough rule: the branch decision is made by CONTENT, not by row
// availability — a content session with no active continuation set must NOT
// pick up the project's next_task rows.
func TestGetPromptSuggestions_ContentSessionStaysOnContinuationBranch(t *testing.T) {
	h := newSuggestionsAPIHarness(t)
	projID := h.mustProject(t, "NoFallthrough")
	h.mustSession(t, "s-old", projID, 0)
	h.mustMessage(t, "s-old", "user", "работа")
	h.mustMessage(t, "s-old", "assistant", "сделано")
	h.mustSuggestionPass(t, "s-old", session.SuggestionKindNextTask, "проектные строки")
	h.mustSession(t, "s-live", projID, 1)
	h.mustMessage(t, "s-live", "user", "продолжи")

	resp := h.f.GetPromptSuggestions("s-live", projID)
	if resp.Source != promptSuggestionsSourceContinuation {
		t.Errorf("Source = %q, want %q", resp.Source, promptSuggestionsSourceContinuation)
	}
	if len(resp.Suggestions) != 0 {
		t.Errorf("texts = %v, want an empty continuation set (no fallthrough to next_task)", suggestionTextsOf(resp.Suggestions))
	}
}

// TestSetPromptSuggestionsEnabled_PersistsAndApplies verifies the toggle
// round-trip: the flip reaches config.yaml as an explicit value AND the
// session manager's outcome gate in the same call, in both directions.
func TestSetPromptSuggestionsEnabled_PersistsAndApplies(t *testing.T) {
	f, _, cfgPath := newTestAPI(t)
	app := &Application{}
	mgr := session.NewManager(nil, nil, t.TempDir())
	app.manager = mgr
	f.app = app

	if !mgr.PromptSuggestionsEnabled() {
		t.Fatalf("manager must start enabled (nil config = on)")
	}

	if err := f.SetPromptSuggestionsEnabled(false); err != nil {
		t.Fatalf("SetPromptSuggestionsEnabled(false): %v", err)
	}
	if f.config.PromptSuggestions.SuggestionsEnabled() {
		t.Errorf("in-memory config still reports enabled after disabling")
	}
	if mgr.PromptSuggestionsEnabled() {
		t.Errorf("manager gate must flip without a restart")
	}

	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("reload persisted config: %v", err)
	}
	if loaded.PromptSuggestions.Enabled == nil {
		t.Errorf("persisted prompt_suggestions.enabled must be an explicit value, not the nil default")
	}
	if loaded.PromptSuggestions.SuggestionsEnabled() {
		t.Errorf("persisted prompt_suggestions.enabled = on, want explicit off")
	}

	if err := f.SetPromptSuggestionsEnabled(true); err != nil {
		t.Fatalf("SetPromptSuggestionsEnabled(true): %v", err)
	}
	if !mgr.PromptSuggestionsEnabled() {
		t.Errorf("manager gate must flip back on")
	}
	loaded, err = config.Load(cfgPath)
	if err != nil {
		t.Fatalf("reload persisted config: %v", err)
	}
	if !loaded.PromptSuggestions.SuggestionsEnabled() {
		t.Errorf("persisted prompt_suggestions.enabled = off after re-enabling, want on")
	}
}

// TestSetPromptSuggestionsEnabled_NoopWhenUnchanged verifies that a request
// matching the stored EFFECTIVE value is a true no-op: enabling an unset
// (nil = on) config writes nothing, and a second identical disable rewrites
// nothing.
func TestSetPromptSuggestionsEnabled_NoopWhenUnchanged(t *testing.T) {
	f, _, cfgPath := newTestAPI(t)

	// nil default = on: enabling must not create the config file at all.
	if err := f.SetPromptSuggestionsEnabled(true); err != nil {
		t.Fatalf("SetPromptSuggestionsEnabled(true) on nil default: %v", err)
	}
	if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
		t.Errorf("no-op enable must not write the config file (stat err = %v)", err)
	}

	if err := f.SetPromptSuggestionsEnabled(false); err != nil {
		t.Fatalf("SetPromptSuggestionsEnabled(false): %v", err)
	}
	before, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config after disable: %v", err)
	}
	if err := f.SetPromptSuggestionsEnabled(false); err != nil {
		t.Fatalf("second SetPromptSuggestionsEnabled(false): %v", err)
	}
	after, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config after no-op: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Errorf("no-op disable rewrote the config file")
	}
}

// TestSetPromptSuggestionsEnabled_PersistFailureRollsBack verifies a failed
// config.yaml write rolls the in-memory value back and never reaches the
// manager, so the rejected toggle is indistinguishable from a rejected
// request.
func TestSetPromptSuggestionsEnabled_PersistFailureRollsBack(t *testing.T) {
	f, _, _ := newTestAPI(t)
	app := &Application{}
	mgr := session.NewManager(nil, nil, t.TempDir())
	app.manager = mgr
	f.app = app
	f.configPath = filepath.Join(t.TempDir(), "missing", "config.yaml")

	if err := f.SetPromptSuggestionsEnabled(false); err == nil {
		t.Fatal("expected an error when the config persist fails")
	}
	if !f.config.PromptSuggestions.SuggestionsEnabled() {
		t.Errorf("in-memory value must roll back to the previous (on) state")
	}
	if !mgr.PromptSuggestionsEnabled() {
		t.Errorf("a rejected toggle must not reach the manager")
	}
}

// TestSetPromptSuggestionsEnabled_EmptyPathRejected verifies the config-path
// guard precedes any mutation.
func TestSetPromptSuggestionsEnabled_EmptyPathRejected(t *testing.T) {
	f, _, _ := newTestAPI(t)
	f.configPath = ""

	if err := f.SetPromptSuggestionsEnabled(false); err == nil {
		t.Fatal("expected an error when the config path is not set")
	}
	if !f.config.PromptSuggestions.SuggestionsEnabled() {
		t.Errorf("a rejected request must not touch the in-memory value")
	}
}

// TestSetPromptSuggestionsEnabled_EmitsConfigUpdated verifies the
// (asynchronous) config:updated announcement so config consumers re-read the
// value without a restart.
func TestSetPromptSuggestionsEnabled_EmitsConfigUpdated(t *testing.T) {
	f, _, _ := newTestAPI(t)
	updated := make(chan string, 1)
	f.emitEvent = func(name string, _ ...any) { updated <- name }

	if err := f.SetPromptSuggestionsEnabled(false); err != nil {
		t.Fatalf("SetPromptSuggestionsEnabled(false): %v", err)
	}
	select {
	case name := <-updated:
		if name != EventConfigUpdated {
			t.Errorf("announced event = %q, want %q", name, EventConfigUpdated)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("config:updated was not announced")
	}
}

// TestGetConfig_ExposesPromptSuggestionsFlag pins the config-RPC surface:
// the effective gate rides ConfigResponse.prompt_suggestions, reflecting the
// nil default (on) and the persisted toggle.
func TestGetConfig_ExposesPromptSuggestionsFlag(t *testing.T) {
	f, _, _ := newTestAPI(t)

	if got := f.GetConfig().PromptSuggestions.Enabled; !got {
		t.Errorf("GetConfig().prompt_suggestions.enabled = false, want true (nil default = on)")
	}
	if err := f.SetPromptSuggestionsEnabled(false); err != nil {
		t.Fatalf("SetPromptSuggestionsEnabled(false): %v", err)
	}
	if got := f.GetConfig().PromptSuggestions.Enabled; got {
		t.Errorf("GetConfig().prompt_suggestions.enabled = true after disabling, want false")
	}
}
