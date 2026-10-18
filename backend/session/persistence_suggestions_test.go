package session

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"testing"
)

// Fixed RFC3339 pass timestamps: lexicographic TEXT order matches
// chronological order for Z-suffixed UTC strings, so pass recency in
// ListPromptSuggestions is deterministic without sleeping.
const (
	suggTs1 = "2025-06-01T10:00:00Z"
	suggTs2 = "2025-06-01T10:00:05Z"
	suggTs3 = "2025-06-01T10:00:10Z"
)

// createSuggestionSession saves a minimal session row the suggestion FKs and
// the fork test can hang off.
func createSuggestionSession(t *testing.T, store *SQLiteSessionStore, id string) {
	t.Helper()
	err := store.SaveSession(context.Background(), SessionInfo{
		ID:        id,
		ProjectID: testProjectID,
		Name:      "Suggestions " + id,
		CreatedAt: "2025-06-01T09:00:00Z",
	})
	if err != nil {
		t.Fatalf("failed to save session %q: %v", id, err)
	}
}

// saveSuggestionPass persists one generation pass of texts for (sessionID,
// kind) at the given timestamp and returns the rows as persisted.
func saveSuggestionPass(t *testing.T, store *SQLiteSessionStore, sessionID, taskID, kind, createdAt string, texts ...string) []PromptSuggestion {
	t.Helper()
	suggs := make([]PromptSuggestion, 0, len(texts))
	for _, text := range texts {
		suggs = append(suggs, PromptSuggestion{
			SessionID: sessionID,
			TaskID:    taskID,
			Kind:      kind,
			Text:      text,
			CreatedAt: createdAt,
		})
	}
	saved, err := store.SavePromptSuggestions(context.Background(), suggs)
	if err != nil {
		t.Fatalf("SavePromptSuggestions(%s, %s): %v", sessionID, kind, err)
	}
	return saved
}

func suggestionTexts(suggs []PromptSuggestion) []string {
	texts := make([]string, 0, len(suggs))
	for _, sg := range suggs {
		texts = append(texts, sg.Text)
	}
	return texts
}

func listSuggestions(t *testing.T, store *SQLiteSessionStore, sessionID string) []PromptSuggestion {
	t.Helper()
	suggs, err := store.ListPromptSuggestions(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("ListPromptSuggestions(%q): %v", sessionID, err)
	}
	return suggs
}

func countSuggestions(t *testing.T, store *SQLiteSessionStore, where string, args ...any) int {
	t.Helper()
	var n int
	if err := store.db.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM prompt_suggestions WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatalf("failed to count prompt suggestions (%s): %v", where, err)
	}
	return n
}

func suggestionStatus(t *testing.T, store *SQLiteSessionStore, id string) string {
	t.Helper()
	var status string
	if err := store.db.QueryRowContext(context.Background(),
		`SELECT status FROM prompt_suggestions WHERE id = ?`, id).Scan(&status); err != nil {
		t.Fatalf("failed to query status of suggestion %q: %v", id, err)
	}
	return status
}

// assertSuggestionSchema pins the D7 schema shape via pragma_table_info so a
// future accidental column drift fails loudly.
func assertSuggestionSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	rows, err := db.QueryContext(context.Background(),
		`SELECT name FROM pragma_table_info('prompt_suggestions') ORDER BY cid`)
	if err != nil {
		t.Fatalf("failed to query prompt_suggestions columns: %v", err)
	}
	defer func() { _ = rows.Close() }()
	var cols []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("failed to scan column name: %v", err)
		}
		cols = append(cols, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("error iterating prompt_suggestions columns: %v", err)
	}
	want := []string{"id", "session_id", "task_id", "kind", "text", "status", "created_at"}
	if !slices.Equal(cols, want) {
		t.Fatalf("prompt_suggestions columns = %v, want %v", cols, want)
	}
}

func TestPromptSuggestions_SaveAndListRoundTrip(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	createSuggestionSession(t, store, "sugg-rt")

	// Caller-set IDs must never leak in and rows get unique uuids.
	p1 := saveSuggestionPass(t, store, "sugg-rt", "task-1", SuggestionKindNextTask, suggTs1, "next A", "next B")
	if len(p1) != 2 {
		t.Fatalf("saved %d rows, want 2", len(p1))
	}
	if p1[0].ID == "" || p1[0].ID == p1[1].ID {
		t.Fatalf("row IDs not freshly generated and unique: %q, %q", p1[0].ID, p1[1].ID)
	}
	for i, sg := range p1 {
		switch {
		case sg.SessionID != "sugg-rt":
			t.Errorf("row %d: SessionID = %q, want %q", i, sg.SessionID, "sugg-rt")
		case sg.TaskID != "task-1":
			t.Errorf("row %d: TaskID = %q, want %q", i, sg.TaskID, "task-1")
		case sg.Kind != SuggestionKindNextTask:
			t.Errorf("row %d: Kind = %q, want %q", i, sg.Kind, SuggestionKindNextTask)
		case sg.Status != SuggestionStatusActive:
			t.Errorf("row %d: Status = %q, want %q", i, sg.Status, SuggestionStatusActive)
		case sg.CreatedAt != suggTs1:
			t.Errorf("row %d: CreatedAt = %q, want the uniform pass timestamp %q", i, sg.CreatedAt, suggTs1)
		}
	}

	p2 := saveSuggestionPass(t, store, "sugg-rt", "task-2", SuggestionKindGoalAdvance, suggTs2, "goal G")

	got := listSuggestions(t, store, "sugg-rt")
	// Newest generation first (goal pass @ts2), insertion order within a pass.
	if want := []string{"goal G", "next A", "next B"}; !slices.Equal(suggestionTexts(got), want) {
		t.Fatalf("ListPromptSuggestions texts = %v, want %v", suggestionTexts(got), want)
	}
	if got[0].Kind != SuggestionKindGoalAdvance || got[0].ID != p2[0].ID {
		t.Errorf("first row = {%s %s}, want the persisted goal_advance row", got[0].Kind, got[0].ID)
	}
	if got[1].ID != p1[0].ID || got[2].ID != p1[1].ID {
		t.Errorf("next_task rows not the same persisted rows: got ids %q, %q", got[1].ID, got[2].ID)
	}
}

func TestPromptSuggestions_AtomicReplacePerKind(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	createSuggestionSession(t, store, "sugg-repl")

	p1 := saveSuggestionPass(t, store, "sugg-repl", "task-1", SuggestionKindNextTask, suggTs1, "A", "B", "C")
	if got := suggestionTexts(listSuggestions(t, store, "sugg-repl")); !slices.Equal(got, []string{"A", "B", "C"}) {
		t.Fatalf("after pass 1: texts = %v, want [A B C]", got)
	}

	// A fresh pass for the same (session, kind) replaces the active set.
	saveSuggestionPass(t, store, "sugg-repl", "task-1", SuggestionKindNextTask, suggTs2, "D", "E")
	if got := suggestionTexts(listSuggestions(t, store, "sugg-repl")); !slices.Equal(got, []string{"D", "E"}) {
		t.Fatalf("after pass 2: texts = %v, want [D E]", got)
	}
	if n := countSuggestions(t, store,
		`session_id = ? AND kind = ? AND status = ?`, "sugg-repl", SuggestionKindNextTask, SuggestionStatusStale); n != len(p1) {
		t.Errorf("stale rows after replace = %d, want %d", n, len(p1))
	}
	if status := suggestionStatus(t, store, p1[0].ID); status != SuggestionStatusStale {
		t.Errorf("replaced row status = %q, want %q", status, SuggestionStatusStale)
	}

	// The other kind is untouched by next_task replaces.
	saveSuggestionPass(t, store, "sugg-repl", "task-2", SuggestionKindGoalAdvance, suggTs1, "G")
	if got := suggestionTexts(listSuggestions(t, store, "sugg-repl")); !slices.Equal(got, []string{"D", "E", "G"}) {
		t.Fatalf("after goal pass 1: texts = %v, want [D E G]", got)
	}
	saveSuggestionPass(t, store, "sugg-repl", "task-2", SuggestionKindGoalAdvance, suggTs2, "H")
	if got := suggestionTexts(listSuggestions(t, store, "sugg-repl")); !slices.Equal(got, []string{"D", "E", "H"}) {
		t.Fatalf("after goal pass 2: texts = %v, want [D E H]", got)
	}
	if n := countSuggestions(t, store,
		`session_id = ? AND kind = ? AND status = ?`, "sugg-repl", SuggestionKindGoalAdvance, SuggestionStatusStale); n != 1 {
		t.Errorf("stale goal_advance rows = %d, want 1", n)
	}
}

func TestPromptSuggestions_StaleGenerationPruned(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	createSuggestionSession(t, store, "sugg-prune")

	p1 := saveSuggestionPass(t, store, "sugg-prune", "task-1", SuggestionKindNextTask, suggTs1, "A", "B", "C")
	// Terminal outcomes survive replaces: accept B before it is ever replaced.
	if err := store.SetPromptSuggestionStatus(context.Background(), p1[1].ID, SuggestionStatusAccepted); err != nil {
		t.Fatalf("accept B: %v", err)
	}

	saveSuggestionPass(t, store, "sugg-prune", "task-1", SuggestionKindNextTask, suggTs2, "D")
	saveSuggestionPass(t, store, "sugg-prune", "task-1", SuggestionKindNextTask, suggTs3, "E", "F")

	// The replace prunes the dead stale generation: only pass 2's D stays
	// stale; pass 1's A and C are gone; B keeps its accepted outcome.
	if n := countSuggestions(t, store,
		`session_id = ? AND kind = ? AND status = ?`, "sugg-prune", SuggestionKindNextTask, SuggestionStatusStale); n != 1 {
		t.Errorf("stale rows after two replaces = %d, want 1 (only the previous generation)", n)
	}
	if n := countSuggestions(t, store, `session_id = ?`, "sugg-prune"); n != 4 {
		t.Errorf("total rows = %d, want 4 (D stale + E/F active + B accepted)", n)
	}
	if status := suggestionStatus(t, store, p1[1].ID); status != SuggestionStatusAccepted {
		t.Errorf("accepted row status = %q, want %q (terminal rows survive replaces)", status, SuggestionStatusAccepted)
	}
	if got := suggestionTexts(listSuggestions(t, store, "sugg-prune")); !slices.Equal(got, []string{"E", "F"}) {
		t.Fatalf("active set = %v, want [E F]", got)
	}
}

func TestPromptSuggestions_SetStatus(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	createSuggestionSession(t, store, "sugg-status")
	p := saveSuggestionPass(t, store, "sugg-status", "task-1", SuggestionKindNextTask, suggTs1, "A", "B")

	// Accept: leaves the active set, persists per row (D8).
	if err := store.SetPromptSuggestionStatus(context.Background(), p[0].ID, SuggestionStatusAccepted); err != nil {
		t.Fatalf("accept: %v", err)
	}
	if got := suggestionTexts(listSuggestions(t, store, "sugg-status")); !slices.Equal(got, []string{"B"}) {
		t.Fatalf("active set after accept = %v, want [B]", got)
	}
	// A repeated report is an idempotent no-op, not an error.
	if err := store.SetPromptSuggestionStatus(context.Background(), p[0].ID, SuggestionStatusAccepted); err != nil {
		t.Fatalf("repeated accept: %v", err)
	}
	if status := suggestionStatus(t, store, p[0].ID); status != SuggestionStatusAccepted {
		t.Fatalf("status after repeated accept = %q, want %q", status, SuggestionStatusAccepted)
	}

	// Dismiss: Esc clears the set.
	if err := store.SetPromptSuggestionStatus(context.Background(), p[1].ID, SuggestionStatusDismissed); err != nil {
		t.Fatalf("dismiss: %v", err)
	}
	got := listSuggestions(t, store, "sugg-status")
	if got == nil || len(got) != 0 {
		t.Fatalf("active set after dismiss = %v, want an empty non-nil slice", got)
	}

	// Unknown id: silent no-op (fail-open, D9).
	if err := store.SetPromptSuggestionStatus(context.Background(), "no-such-id", SuggestionStatusAccepted); err != nil {
		t.Fatalf("report for unknown id: %v", err)
	}

	// Only terminal frontend outcomes are reportable; active/stale are
	// generation-owned states.
	for _, status := range []string{SuggestionStatusActive, SuggestionStatusStale, "bogus"} {
		if err := store.SetPromptSuggestionStatus(context.Background(), p[0].ID, status); err == nil {
			t.Errorf("SetPromptSuggestionStatus(%q) = nil, want an error", status)
		}
	}

	// A report racing a fresher pass — the row is already stale — is a no-op:
	// it must neither error nor resurrect the row into the active set.
	replaced := saveSuggestionPass(t, store, "sugg-status", "task-1", SuggestionKindNextTask, suggTs2, "C")
	saveSuggestionPass(t, store, "sugg-status", "task-1", SuggestionKindNextTask, suggTs3, "D")
	if status := suggestionStatus(t, store, replaced[0].ID); status != SuggestionStatusStale {
		t.Fatalf("replaced row status = %q, want %q", status, SuggestionStatusStale)
	}
	if err := store.SetPromptSuggestionStatus(context.Background(), replaced[0].ID, SuggestionStatusAccepted); err != nil {
		t.Fatalf("stale report: %v", err)
	}
	if status := suggestionStatus(t, store, replaced[0].ID); status != SuggestionStatusStale {
		t.Fatalf("status after stale report = %q, want %q (the report must not resurrect the row)", status, SuggestionStatusStale)
	}
	if got := suggestionTexts(listSuggestions(t, store, "sugg-status")); !slices.Equal(got, []string{"D"}) {
		t.Fatalf("active set after stale report = %v, want [D]", got)
	}
}

func TestPromptSuggestions_DeleteSessionCascades(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	createSuggestionSession(t, store, "sugg-cascade")
	saveSuggestionPass(t, store, "sugg-cascade", "task-1", SuggestionKindNextTask, suggTs1, "A", "B", "C")
	saveSuggestionPass(t, store, "sugg-cascade", "task-2", SuggestionKindGoalAdvance, suggTs2, "G", "H")
	if n := countSuggestions(t, store, `session_id = ?`, "sugg-cascade"); n != 5 {
		t.Fatalf("rows before delete = %d, want 5", n)
	}

	if err := store.DeleteSession(context.Background(), "sugg-cascade"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if n := countSuggestions(t, store, `session_id = ?`, "sugg-cascade"); n != 0 {
		t.Errorf("rows after DeleteSession = %d, want 0 (ON DELETE CASCADE)", n)
	}

	// The FK floor is real: suggestions for a nonexistent session are
	// rejected on insert.
	_, err := store.SavePromptSuggestions(context.Background(), []PromptSuggestion{{
		SessionID: "sugg-ghost-session",
		Kind:      SuggestionKindNextTask,
		Text:      "orphan",
		CreatedAt: suggTs1,
	}})
	if err == nil {
		t.Error("SavePromptSuggestions for a nonexistent session = nil error, want an FK violation")
	}
}

func TestPromptSuggestions_ForkDoesNotCopy(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	src := "sugg-fork-src"
	createSuggestionSession(t, store, src)
	p := saveSuggestionPass(t, store, src, "task-1", SuggestionKindNextTask, suggTs1, "A", "B")
	if err := store.SetPromptSuggestionStatus(context.Background(), p[0].ID, SuggestionStatusAccepted); err != nil {
		t.Fatalf("accept: %v", err)
	}
	saveSuggestionPass(t, store, src, "task-2", SuggestionKindGoalAdvance, suggTs2, "G")

	forked, err := store.ForkSession(context.Background(), src, nil)
	if err != nil {
		t.Fatalf("ForkSession: %v", err)
	}
	if n := countSuggestions(t, store, `session_id = ?`, forked.ID); n != 0 {
		t.Errorf("fork carries %d suggestion rows, want 0 (forks never copy suggestions)", n)
	}
	if got := listSuggestions(t, store, forked.ID); len(got) != 0 {
		t.Errorf("ListPromptSuggestions(fork) = %v, want empty", suggestionTexts(got))
	}

	// The source keeps its rows — active and terminal alike.
	if got := suggestionTexts(listSuggestions(t, store, src)); !slices.Equal(got, []string{"G", "B"}) {
		t.Errorf("source active set after fork = %v, want [G B]", got)
	}
	if n := countSuggestions(t, store, `session_id = ?`, src); n != 3 {
		t.Errorf("source total rows after fork = %d, want 3 (2 next_task incl. accepted + 1 goal)", n)
	}
}

func TestPromptSuggestions_MigrationIdempotent(t *testing.T) {
	dbPath := filepath.Join(runtimeTempDir(t), "suggestions-migration.db")
	dsn := "file:" + dbPath + "?_pragma=busy_timeout(2000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)"

	// First open: fresh database, the additive migration creates the table.
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	createProjectsTable(t, db)
	insertTestProject(t, db, testProjectID)
	store, err := NewSQLiteSessionStore(db)
	if err != nil {
		_ = db.Close()
		t.Fatalf("failed to create store: %v", err)
	}
	createSuggestionSession(t, store, "sugg-mig")
	p := saveSuggestionPass(t, store, "sugg-mig", "task-1", SuggestionKindNextTask, suggTs1, "A", "B")
	assertSuggestionSchema(t, db)
	var indexes int
	if err := db.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_prompt_suggestions_session'`).Scan(&indexes); err != nil {
		t.Fatalf("failed to query index: %v", err)
	}
	if indexes != 1 {
		t.Fatalf("idx_prompt_suggestions_session missing")
	}
	if err := db.Close(); err != nil {
		t.Fatalf("failed to close db: %v", err)
	}

	// Second open: createTables re-runs over existing data — IF NOT EXISTS
	// must be a no-op and the rows must survive untouched.
	db, err = sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("failed to reopen db: %v", err)
	}
	defer func() { _ = db.Close() }()
	reopened, err := NewSQLiteSessionStore(db)
	if err != nil {
		t.Fatalf("reopening the store over an existing database failed: %v", err)
	}
	assertSuggestionSchema(t, db)
	got := listSuggestions(t, reopened, "sugg-mig")
	if len(got) != 2 || got[0].ID != p[0].ID || got[1].ID != p[1].ID {
		t.Fatalf("rows after reopen = %v, want the original two rows %q, %q",
			suggestionTexts(got), p[0].ID, p[1].ID)
	}
}

func TestPromptSuggestions_Validation(t *testing.T) {
	store, cleanup := setupTestStore(t)
	defer cleanup()

	createSuggestionSession(t, store, "sugg-valid")

	cases := []struct {
		name  string
		suggs []PromptSuggestion
	}{
		{"empty set", nil},
		{"empty session id", []PromptSuggestion{{Kind: SuggestionKindNextTask, Text: "x", CreatedAt: suggTs1}}},
		{"unknown kind", []PromptSuggestion{{SessionID: "sugg-valid", Kind: "daily_hint", Text: "x", CreatedAt: suggTs1}}},
		{"empty text", []PromptSuggestion{{SessionID: "sugg-valid", Kind: SuggestionKindNextTask, Text: "", CreatedAt: suggTs1}}},
		{"whitespace-only text", []PromptSuggestion{{SessionID: "sugg-valid", Kind: SuggestionKindNextTask, Text: "   ", CreatedAt: suggTs1}}},
		{"mixed sessions", []PromptSuggestion{
			{SessionID: "sugg-valid", Kind: SuggestionKindNextTask, Text: "x", CreatedAt: suggTs1},
			{SessionID: "other-session", Kind: SuggestionKindNextTask, Text: "y", CreatedAt: suggTs1},
		}},
		{"mixed kinds", []PromptSuggestion{
			{SessionID: "sugg-valid", Kind: SuggestionKindNextTask, Text: "x", CreatedAt: suggTs1},
			{SessionID: "sugg-valid", Kind: SuggestionKindGoalAdvance, Text: "y", CreatedAt: suggTs1},
		}},
	}
	for _, tc := range cases {
		if _, err := store.SavePromptSuggestions(context.Background(), tc.suggs); err == nil {
			t.Errorf("%s: SavePromptSuggestions = nil error, want an error", tc.name)
		}
	}

	// The DB CHECK constraints are the floor under Go-side validation: raw
	// inserts with an unknown kind/status must fail.
	for _, stmt := range []string{
		`INSERT INTO prompt_suggestions (id, session_id, kind, text, status, created_at)
		 VALUES ('raw-1', 'sugg-valid', 'daily_hint', 'x', 'active', '` + suggTs1 + `')`,
		`INSERT INTO prompt_suggestions (id, session_id, kind, text, status, created_at)
		 VALUES ('raw-2', 'sugg-valid', 'next_task', 'x', 'vanished', '` + suggTs1 + `')`,
	} {
		if _, err := store.db.ExecContext(context.Background(), stmt); err == nil {
			t.Errorf("raw insert without CHECK violation accepted: %.60s", stmt)
		}
	}

	// Caller-set IDs are ignored — the store always regenerates them.
	saved, err := store.SavePromptSuggestions(context.Background(), []PromptSuggestion{{
		ID:        "caller-id",
		SessionID: "sugg-valid",
		Kind:      SuggestionKindNextTask,
		Text:      "keep",
		CreatedAt: suggTs1,
	}})
	if err != nil {
		t.Fatalf("save with caller-set id: %v", err)
	}
	if len(saved) != 1 || saved[0].ID == "caller-id" || saved[0].ID == "" {
		t.Errorf("saved ID = %q, want a freshly generated uuid", saved[0].ID)
	}

	// Nothing from the failed validation attempts leaked into the table; the
	// one successful save above is the only row.
	if n := countSuggestions(t, store, `session_id = ?`, "sugg-valid"); n != 1 {
		t.Errorf("rows after validation cases = %d, want 1", n)
	}
}
