package backend

import (
	"errors"
	"fmt"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/backend/project"
	"github.com/v0lka/c0wrk/backend/session"
)

// This file owns the RPC surface of the prompt-suggestions bridge (ADR-088):
// the read path the chat input uses to restore an active suggestion set on
// session open/switch, and the config gate toggle. Generation, persistence,
// and the session-scoped "prompt_suggestions" event live in backend/session
// (prompt_suggest.go); this layer only READS persisted active sets and
// decides WHICH context the addressed session is served from. Like the rest
// of the subsystem, the read path is fail-open: it never errors the RPC, it
// degrades to an empty set.

// promptSuggestionsProjectScan bounds the new-session lookup: the project's
// newest N sessions are scanned newest-first for an active next_task set —
// the same window ADR-088 D3 generates over (the session package's
// promptSuggestWindowSessions; the two constants only need to agree on the
// budget). A session older than the window carries suggestions from beyond
// the recent project context and is not offered.
const promptSuggestionsProjectScan = 10

// The response source values (PromptSuggestionsResponse.Source): which
// context the backend decided the suggestions belong to.
const (
	// promptSuggestionsSourceContinuation: the addressed session has a
	// transcript — its own goal_advance set is offered.
	promptSuggestionsSourceContinuation = "continuation"
	// promptSuggestionsSourceNewSession: the addressed session is empty or
	// brand-new — the project's freshest next_task set is offered.
	promptSuggestionsSourceNewSession = "new_session"
	// promptSuggestionsSourceNone: nothing to offer (a No-Project/CHAT
	// window, or no store at all).
	promptSuggestionsSourceNone = "none"
)

// PromptSuggestionsResponse is the GetPromptSuggestions payload: the active
// suggestion set the chat input offers for the addressed session, plus the
// backend's routing decision. Rows are returned as persisted — in the
// new_session case their session_id names the ORIGINATING session, not the
// addressed one; the frontend consumes id/kind/text and never re-keys the
// set by row session_id.
type PromptSuggestionsResponse struct {
	// SessionID is the addressed session, verbatim.
	SessionID string `json:"session_id"`
	// ProjectID is the addressed project, verbatim ("" when absent).
	ProjectID string `json:"project_id,omitempty"`
	// Source reports the routing decision: "continuation" (session with
	// content → its own goal_advance set), "new_session" (empty/new session
	// → the project's freshest next_task set) or "none" (No-Project/CHAT
	// window, or no store). Source names the context that was CONSULTED, not
	// the row count — it is set even when Suggestions is empty.
	Source string `json:"source"`
	// Suggestions is the active set as persisted (never nil; empty when
	// nothing is active in the consulted context).
	Suggestions []session.PromptSuggestion `json:"suggestions"`
}

// GetPromptSuggestions returns the active prompt-suggestion set the chat
// input offers for the addressed session (the ADR-088 D8 restore path).
// The backend routes by session content: a session with a transcript offers
// its own goal_advance (continuation) set; an empty or brand-new session
// offers the project's freshest next_task set (newest-first scan over the
// project window, the same 10 sessions D3 generates over); a No-Project
// (CHAT) session offers nothing — CHAT has no project window. The branch
// decision is made by CONTENT, not by row availability: a content session
// with no active continuation set stays on the continuation branch with an
// empty set rather than falling through to the project window.
//
// Read-only getter: returns the response only, no error. Every store read
// failure degrades to "no suggestions" with a Debug log (the subsystem's
// fail-open contract, ADR-088 D9).
func (f *FrontendAPI) GetPromptSuggestions(sessionID, projectID string) PromptSuggestionsResponse {
	f.seedAcquire()
	resp := PromptSuggestionsResponse{
		SessionID:   sessionID,
		ProjectID:   projectID,
		Source:      promptSuggestionsSourceNone,
		Suggestions: []session.PromptSuggestion{},
	}
	if f.store == nil {
		return resp
	}
	ctx, cancel := f.storeOpCtx()
	defer cancel()

	// Continuation branch: the session has a transcript — its own
	// goal_advance set is what the chat input continues from. A transcript
	// read failure is indistinguishable from "no content yet" and falls
	// through to the project branch (fail-open).
	if sessionID != "" {
		history, err := f.store.LoadSessionHistory(ctx, sessionID)
		if err != nil {
			f.log().Debug("prompt suggestions: transcript unavailable, consulting the project window",
				"session", sessionID, "error", err)
		} else if len(history) > 0 {
			resp.Source = promptSuggestionsSourceContinuation
			if rows, err := f.store.ListPromptSuggestions(ctx, sessionID); err != nil {
				f.log().Debug("prompt suggestions: active set unavailable",
					"session", sessionID, "error", err)
			} else {
				// The continuation context serves goal_advance rows only;
				// next_task rows of the same session belong to the
				// new-session surface and are not mixed in.
				resp.Suggestions = promptSuggestionsOfKind(rows, session.SuggestionKindGoalAdvance)
			}
			return resp
		}
	}

	// New-session branch: an empty or brand-new session draws from the
	// project's recent activity. The No-Project sentinel (CHAT mode) and an
	// empty id are both "no project" — there is no project window to draw
	// from.
	if projectID == "" || projectID == project.NoProjectID {
		return resp
	}
	infos, err := f.store.ListSessionsByProject(ctx, projectID)
	if err != nil {
		f.log().Debug("prompt suggestions: project window unavailable",
			"project", projectID, "error", err)
		return resp
	}
	if len(infos) > promptSuggestionsProjectScan {
		infos = infos[:promptSuggestionsProjectScan]
	}
	for _, info := range infos {
		rows, err := f.store.ListPromptSuggestions(ctx, info.ID)
		if err != nil {
			f.log().Debug("prompt suggestions: active set unavailable",
				"session", info.ID, "project", projectID, "error", err)
			continue
		}
		// Newest session with an active next_task set wins; its rows are
		// returned as persisted (the origin session_id rides along).
		if next := promptSuggestionsOfKind(rows, session.SuggestionKindNextTask); len(next) > 0 {
			resp.Source = promptSuggestionsSourceNewSession
			resp.Suggestions = next
			return resp
		}
	}
	// A consulted project window with nothing active: the new_session
	// context is still the answer, just with an empty set.
	resp.Source = promptSuggestionsSourceNewSession
	return resp
}

// promptSuggestionsOfKind filters persisted active rows down to one kind,
// preserving ListPromptSuggestions' order (newest generation first,
// insertion order within a generation). Always returns a non-nil slice.
func promptSuggestionsOfKind(rows []session.PromptSuggestion, kind string) []session.PromptSuggestion {
	out := make([]session.PromptSuggestion, 0, len(rows))
	for _, row := range rows {
		if row.Kind == kind {
			out = append(out, row)
		}
	}
	return out
}

// SetPromptSuggestionsEnabled toggles the prompt_suggestions.enabled gate
// (ADR-088) and persists it to config.yaml. A request matching the stored
// EFFECTIVE value is a no-op (the nil default counts as on, so enabling an
// unset config writes nothing), and a failed disk write rolls the in-memory
// value back so the rejected toggle is indistinguishable from a rejected
// request. On success the session manager's outcome gate is flipped in the
// same beat — the change takes effect without a restart — and the
// config:updated announcement lets config consumers re-read the value.
func (f *FrontendAPI) SetPromptSuggestionsEnabled(enabled bool) error {
	f.configMu.Lock()
	defer f.configMu.Unlock()

	if f.config == nil {
		return errors.New("config not initialized")
	}
	if f.configPath == "" {
		return errors.New("config path not set")
	}
	if f.config.PromptSuggestions.SuggestionsEnabled() == enabled {
		return nil // already in the requested state — no state change
	}

	prev := f.config.PromptSuggestions.Enabled
	f.config.PromptSuggestions.Enabled = &enabled
	if err := config.Save(f.config, f.configPath); err != nil {
		f.config.PromptSuggestions.Enabled = prev
		return fmt.Errorf("failed to persist prompt-suggestions config: %w", err)
	}
	f.applyPromptSuggestionsChange(enabled)
	f.emitConfigUpdated()
	return nil
}

// applyPromptSuggestionsChange pushes a freshly persisted gate value onto
// the session manager so the outcome gate flips without a restart.
// Best-effort by contract: an absent app or manager (early startup, tests)
// skips the push — the persisted config remains the source of truth and is
// re-applied at the next launch (the manager is seeded from config at
// construction). Callers must hold configMu and call it only after a
// successful write.
func (f *FrontendAPI) applyPromptSuggestionsChange(enabled bool) {
	if f.app == nil {
		return
	}
	if mgr := f.app.Manager(); mgr != nil {
		mgr.SetPromptSuggestionsEnabled(enabled)
	}
}
