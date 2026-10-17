package session

import (
	"context"
	"encoding/json"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/v0lka/c0wrk/backend/project"
	"github.com/v0lka/c0wrk/core"
	"github.com/v0lka/sp4rk/orchestration"
)

// This file owns the backend side of the prompt-suggestion trigger
// (ADR-088): when a task finishes with outcome full or partial, the manager
// fires ONE fail-open generation pass per kind on a tracked background
// goroutine, persists the result through the session store, and announces it
// with the session-scoped "prompt_suggestions" event. The generation itself
// (window caps, the is_nudge filter, prompt→answer pairing, the LLM
// round-trip, parsing) lives in core (core/prompt_suggest.go); triggering,
// persistence, and the event live here.
//
// Fail-open end to end (D9): a disabled feature, a missing generator/store,
// an empty window, a failed gate, an LLM error, or a persistence failure is
// at most a Debug log — the finish path never waits on, observes, or fails
// because of this subsystem.

// promptSuggestWindowSessions is the next_task project window: the last 10
// sessions of the project (ADR-088 D3). Core enforces the same cap
// (nextTaskWindowSessions) on the assembled input, so the two constants only
// need to agree on the budget — the backend keeps the store reads bounded,
// core keeps the generation input bounded.
const promptSuggestWindowSessions = 10

// LLMPromptSuggestCaller is the interface for the one-shot prompt-suggestion
// generation. *core.OrchestratorBuilder implements it; the interface mirrors
// LLMTitleCaller and keeps the trigger path testable without a builder.
type LLMPromptSuggestCaller interface {
	GeneratePromptSuggestions(ctx context.Context, kind core.SuggestionKind, in core.PromptSuggestInput) ([]string, error)
}

// PromptSuggestGenerator is the manager-facing shell around the suggestion
// caller, mirroring TitleGenerator. The caller is fixed at construction;
// logging belongs to the manager (every pass logs through the manager's
// logger), so the shell carries no state of its own.
type PromptSuggestGenerator struct {
	caller LLMPromptSuggestCaller
}

// NewPromptSuggestGenerator creates a new PromptSuggestGenerator. A nil
// caller makes the generator inert (Generate reports an error, which the
// pass treats as "no suggestions").
func NewPromptSuggestGenerator(caller LLMPromptSuggestCaller) *PromptSuggestGenerator {
	return &PromptSuggestGenerator{caller: caller}
}

// Generate runs one generation pass for the given kind. Errors are the
// caller's to fail open on.
func (g *PromptSuggestGenerator) Generate(ctx context.Context, kind core.SuggestionKind, in core.PromptSuggestInput) ([]string, error) {
	if g.caller == nil {
		return nil, errPromptSuggestNoCaller
	}
	return g.caller.GeneratePromptSuggestions(ctx, kind, in)
}

// errPromptSuggestNoCaller reports an inert generator (nil caller).
var errPromptSuggestNoCaller = errPromptSuggestInert{}

type errPromptSuggestInert struct{}

func (errPromptSuggestInert) Error() string { return "prompt suggest: no caller installed" }

// SetPromptSuggestionsGenerator installs the follow-up prompt suggestion
// generator (ADR-088). A nil generator (the default) disables the feature:
// the outcome gate never fires a pass.
func (m *Manager) SetPromptSuggestionsGenerator(gen *PromptSuggestGenerator) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.promptSuggestGen = gen
}

// SetPromptSuggestionsEnabled applies the prompt_suggestions.enabled config
// gate (ADR-088): a disabled feature costs zero LLM calls, zero store
// writes, and zero events — the outcome gate checks the flag before
// anything else.
func (m *Manager) SetPromptSuggestionsEnabled(enabled bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.promptSuggestEnabled = enabled
}

// PromptSuggestionsEnabled reports the manager's current prompt_suggestions
// gate value (ADR-088). The mirror of SetPromptSuggestionsEnabled: the
// config RPC's apply-tail tests read it to verify a persisted toggle reached
// the manager, and diagnostics can dump the live gate. Not consulted on hot
// paths — the outcome gate reads its own snapshot under the manager lock.
func (m *Manager) PromptSuggestionsEnabled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.promptSuggestEnabled
}

// promptSuggestOutcomeTriggers implements the outcome gate (ADR-088 D2):
// generation fires on full and partial finishes only. It reads the TYPED
// execution status, never the completion string — Cancelled and Paused
// collapse to the same "partial" completion as a degraded outcome in
// taskCompletionInfo, yet must never trigger a pass (a pause/resume
// continues the same task; nothing finished). A nil result is a full
// success by the same contract taskCompletionInfo uses.
func promptSuggestOutcomeTriggers(result *core.HandleResult) bool {
	if result == nil {
		return true
	}
	switch result.Status {
	case orchestration.ExecutionStatusSuccess, orchestration.ExecutionStatusPartial:
		return true
	default:
		return false
	}
}

// maybeSpawnPromptSuggestions spawns the tracked background generation pass
// after a successful emitTaskComplete. Guards (flag, generator, store) are
// checked synchronously so a disabled feature never spawns a goroutine; the
// readiness gate and the LLM call run on the goroutine. Mirrors
// maybeSpawnTitleGeneration: the goroutine derives from the manager's
// shutdown context so Shutdown can join it.
func (m *Manager) maybeSpawnPromptSuggestions(sessionID string, result *core.HandleResult) {
	m.mu.RLock()
	gen := m.promptSuggestGen
	enabled := m.promptSuggestEnabled
	store := m.sessionStore
	serviceLLMTimeout := m.serviceLLMTimeout
	serviceLLMGate := m.serviceLLMGate
	projectID := ""
	if session := m.sessions[sessionID]; session != nil {
		// ProjectID is immutable after creation (no lock needed for reads).
		projectID = session.ProjectID
	}
	m.mu.RUnlock()
	if !enabled || gen == nil || store == nil {
		return
	}

	output, taskID := promptSuggestResultFacts(result)
	m.spawnBackgroundNamed("prompt-suggestions session="+sessionID, func() {
		m.runPromptSuggestionPasses(sessionID, projectID, taskID, output, gen, store, serviceLLMGate, serviceLLMTimeout)
	})
}

// promptSuggestResultFacts extracts the final answer and the triggering task
// id from a completed task's result. The task id rides the persistent
// blackboard (same source warnIfCompletionDidNotPersist uses).
func promptSuggestResultFacts(result *core.HandleResult) (output, taskID string) {
	if result == nil {
		return "", ""
	}
	if pbb, ok := result.Blackboard.(core.PersistableBlackboard); ok {
		taskID = pbb.TaskID()
	}
	return result.Output, taskID
}

// runPromptSuggestionPasses runs the two generation passes for one finished
// task: the continuation pass (goal_advance, the current session's
// transcript) and — for a real project session — the new-session pass
// (next_task, the project window of 10 sessions). Readiness BEFORE the
// budget (ADR-066 D13), the same ordering as the title path: a gate failure
// skips both passes rather than issuing a request against a model that
// cannot answer.
func (m *Manager) runPromptSuggestionPasses(
	sessionID, projectID, taskID, output string,
	gen *PromptSuggestGenerator,
	store SessionStore,
	serviceLLMGate func(context.Context) error,
	serviceLLMTimeout time.Duration,
) {
	// BY DESIGN the gate sits outside the serviceLLMTimeout envelope (see
	// maybeSpawnTitleGeneration for the full derivation): the embedded
	// model's cold load is longer than the service timeout, so arming the
	// timeout first would spend it on the load and lose the suggestions.
	if serviceLLMGate != nil {
		if err := serviceLLMGate(m.shutdownCtx); err != nil {
			m.log().Debug("skipping prompt suggestions: the model is not ready",
				"session", sessionID, "error", err)
			return
		}
	}
	ctx, cancel := context.WithTimeout(m.shutdownCtx, serviceLLMTimeout)
	defer cancel()
	logger := m.log()

	// Continuation pass for the session that just finished (goal_advance):
	// the transcript comes from the persisted history, supplemented with the
	// final answer from the result — the task_complete emission races the
	// event persister's final assistant write, so the transcript may not yet
	// end with the answer the user just saw.
	m.runPromptSuggestPass(ctx, logger, sessionID, taskID, gen, store, core.SuggestionKindGoalAdvance,
		func() ([]core.PromptSuggestSession, error) {
			history, err := store.LoadSessionHistory(ctx, sessionID)
			if err != nil {
				return nil, err
			}
			return []core.PromptSuggestSession{{
				ID:       sessionID,
				Messages: promptSuggestMessagesFromHistory(history, output),
			}}, nil
		})

	// New-session pass over the project window (next_task): real project
	// sessions only. The No-Project sentinel (CHAT mode) and an empty id are
	// both "no project" — there is no project window to draw from.
	if projectID == "" || projectID == project.NoProjectID {
		return
	}
	m.runPromptSuggestPass(ctx, logger, sessionID, taskID, gen, store, core.SuggestionKindNextTask,
		func() ([]core.PromptSuggestSession, error) {
			return promptSuggestProjectWindow(ctx, store, projectID, sessionID, output, logger)
		})
}

// runPromptSuggestPass drives one generation pass end to end: assemble the
// window, generate, persist, announce. Every failure is a Debug log and "no
// suggestions" (D9); an empty result never reaches the store.
func (m *Manager) runPromptSuggestPass(
	ctx context.Context,
	logger *slog.Logger,
	sessionID, taskID string,
	gen *PromptSuggestGenerator,
	store SessionStore,
	kind core.SuggestionKind,
	window func() ([]core.PromptSuggestSession, error),
) {
	rowKind := suggestionRowKind(kind)
	if rowKind == "" {
		logger.Debug("prompt suggestions: unknown kind, skipping pass",
			"session", sessionID, "kind", string(kind))
		return
	}
	sessions, err := window()
	if err != nil {
		logger.Debug("prompt suggestion window unavailable",
			"session", sessionID, "kind", rowKind, "error", err)
		return
	}
	texts, err := gen.Generate(ctx, kind, core.PromptSuggestInput{Sessions: sessions})
	if err != nil {
		logger.Debug("prompt suggestion generation failed",
			"session", sessionID, "kind", rowKind, "error", err)
		return
	}
	if len(texts) == 0 {
		return
	}
	rows := make([]PromptSuggestion, 0, len(texts))
	for _, text := range texts {
		rows = append(rows, PromptSuggestion{
			SessionID: sessionID,
			TaskID:    taskID,
			Kind:      rowKind,
			Text:      text,
		})
	}
	saved, err := store.SavePromptSuggestions(ctx, rows)
	if err != nil {
		logger.Debug("failed to persist prompt suggestions",
			"session", sessionID, "kind", rowKind, "error", err)
		return
	}
	m.emitPromptSuggestionsEvent(ctx, sessionID, saved)
}

// suggestionRowKind maps a core suggestion kind onto the backend row-kind
// constant the store validates against. An empty result means the kind is
// unknown and the pass is skipped.
func suggestionRowKind(kind core.SuggestionKind) string {
	switch kind {
	case core.SuggestionKindNextTask:
		return SuggestionKindNextTask
	case core.SuggestionKindGoalAdvance:
		return SuggestionKindGoalAdvance
	default:
		return ""
	}
}

// PromptSuggestSessionsNewestFirst re-orders a project's session list into
// pure effective-activity order — the sessionListOrderSQL order WITHOUT its
// pinned DESC term (ADR-088 D3 recency). ListSessionsByProject serves the
// sidebar, where pinned sessions belong on top; the prompt-suggestion
// consumers need pure recency — a long-idle pinned session must neither
// displace recent sessions from the D3 generation window nor win the
// "freshest active set" scan in GetPromptSuggestions. Ordering mirrors the
// SQL tie-break chain: LastActiveAt (the computed effective activity) DESC,
// CreatedAt DESC, ID ASC — RFC 3339 stamps from this store compare
// lexicographically, exactly as sessionListOrderSQL relies on in SQLite.
// The input slice is not modified.
func PromptSuggestSessionsNewestFirst(infos []SessionInfo) []SessionInfo {
	out := make([]SessionInfo, len(infos))
	copy(out, infos)
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.LastActiveAt != b.LastActiveAt {
			return a.LastActiveAt > b.LastActiveAt
		}
		if a.CreatedAt != b.CreatedAt {
			return a.CreatedAt > b.CreatedAt
		}
		return a.ID < b.ID
	})
	return out
}

// promptSuggestProjectWindow assembles the next_task generation window: the
// last promptSuggestWindowSessions sessions of the project (D3) in
// chronological order — the triggering session last — each carrying its
// transcript. ListSessionsByProject serves the sidebar and orders pinned
// sessions first, which would let a long-idle pinned session displace recent
// ones from the window and win the "newest" claim;
// PromptSuggestSessionsNewestFirst re-orders the list into pure activity
// order before the head is taken and reversed. A session whose transcript
// cannot be read is skipped (fail-open); a fully unreadable window surfaces
// its last error.
func promptSuggestProjectWindow(
	ctx context.Context,
	store SessionStore,
	projectID, triggeringSessionID, finalAnswer string,
	logger *slog.Logger,
) ([]core.PromptSuggestSession, error) {
	infos, err := store.ListSessionsByProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	infos = PromptSuggestSessionsNewestFirst(infos)
	if len(infos) > promptSuggestWindowSessions {
		infos = infos[:promptSuggestWindowSessions]
	}
	sessions := make([]core.PromptSuggestSession, 0, len(infos))
	for i := len(infos) - 1; i >= 0; i-- {
		history, err := store.LoadSessionHistory(ctx, infos[i].ID)
		if err != nil {
			logger.Debug("prompt suggestions: skipping unreadable session transcript",
				"session", infos[i].ID, "project", projectID, "error", err)
			continue
		}
		answer := ""
		if infos[i].ID == triggeringSessionID {
			answer = finalAnswer
		}
		sessions = append(sessions, core.PromptSuggestSession{
			ID:       infos[i].ID,
			Messages: promptSuggestMessagesFromHistory(history, answer),
		})
	}
	return sessions, nil
}

// promptSuggestMessagesFromHistory converts a persisted transcript into the
// core generation input. Only user and assistant messages carry a
// prompt→answer signal (other roles are dropped); is_nudge user messages are
// dropped entirely (D5) — they open no prompt→answer pair, and the assistant
// text that interrupted a nudge stays glued to the pair it interrupted, the
// same shape core's own defensive filter produces. finalAnswer supplements
// the transcript when the persisted history does not yet end with it — the
// generation pass runs concurrently with the event persister, so the final
// assistant write may still be in flight when the history is read (the answer
// must not be lost to the race; a transcript that already carries it is
// passed through untouched).
func promptSuggestMessagesFromHistory(history []ChatMessage, finalAnswer string) []core.PromptSuggestMessage {
	msgs := make([]core.PromptSuggestMessage, 0, len(history)+1)
	for _, msg := range history {
		if msg.Role != "user" && msg.Role != "assistant" {
			continue
		}
		if msg.Role == "user" && chatMessageIsNudge(msg) {
			continue
		}
		msgs = append(msgs, core.PromptSuggestMessage{
			Role:    msg.Role,
			Content: msg.Content,
		})
	}
	answer := strings.TrimSpace(finalAnswer)
	if answer == "" {
		return msgs
	}
	supplemented := false
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role != "assistant" {
			continue
		}
		// The transcript's LAST assistant row decides: when it already
		// carries the answer the history is complete; anything else means
		// the final write has not landed yet and the answer is appended.
		if strings.TrimSpace(msgs[i].Content) != answer {
			msgs = append(msgs, core.PromptSuggestMessage{Role: "assistant", Content: answer})
		}
		supplemented = true
		break
	}
	if !supplemented {
		// No assistant row at all — the first finished task of a fresh
		// session whose final write is still in flight. The answer must
		// still land, or the transcript's only prompt→answer pair is lost
		// to the persister race. A dangling assistant tail is harmless
		// downstream: core drops an answer with no open prompt.
		msgs = append(msgs, core.PromptSuggestMessage{Role: "assistant", Content: answer})
	}
	return msgs
}

// chatMessageIsNudge reports whether a persisted message carries the
// is_nudge metadata stamp (ADR-088 D5): metadata-only, meaningful for user
// messages, consulted exclusively by the suggestion input builder.
func chatMessageIsNudge(msg ChatMessage) bool {
	if len(msg.Metadata) == 0 {
		return false
	}
	var meta map[string]any
	if err := json.Unmarshal(msg.Metadata, &meta); err != nil {
		return false
	}
	flag, ok := meta["is_nudge"].(bool)
	return ok && flag
}

// emitPromptSuggestionsEvent announces a fresh generation with the
// session-scoped "prompt_suggestions" event. The payload is the session's
// FULL active set (both kinds) — the frontend replaces its set outright; a
// failed re-read degrades to the just-saved pass rather than dropping the
// event.
func (m *Manager) emitPromptSuggestionsEvent(ctx context.Context, sessionID string, justSaved []PromptSuggestion) {
	active := justSaved
	m.mu.RLock()
	store := m.sessionStore
	m.mu.RUnlock()
	if store != nil {
		if rows, err := store.ListPromptSuggestions(ctx, sessionID); err == nil {
			active = rows
		}
	}
	m.emitFunc(Event{
		SessionID: sessionID,
		Type:      "prompt_suggestions",
		Data: PromptSuggestionsData{
			SessionID:   sessionID,
			Suggestions: active,
		},
	})
}
