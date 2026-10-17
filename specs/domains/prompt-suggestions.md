# Prompt Suggestions

## Purpose

Proactive follow-up prompts for the chat input: when a task finishes successfully (`full`) or partially (`partial`), the backend generates a small set of suggested next prompts and the frontend offers them inside the input field, navigated with `↑`/`↓` and inserted with `→`. Two kinds — task follow-ups (`next_task`, project window of 10 sessions) and goal-advance prompts (`goal_advance`, window of 5 sessions on the same goal). The whole subsystem is fail-open: it can never delay, block, or break the chat path. Decisions D1–D9 are recorded in [ADR-088](../decisions/088-prompt-suggestions.md); this document is the behavioral contract.

## Status

Implemented (ADR-088), with two v1 deltas recorded in place: the config gate `prompt_suggestions.enabled` (nil = on) shipped as the documented opt-out the ADR had deferred (see § Configuration), and accept/dismiss reporting is not wired on the frontend (see § UX contract). Generation uses two prompts, one per delivery context (see `core/prompts/` below).

## Key Files

- `backend/session/persistence.go` — the `prompt_suggestions` table + lookup index (schema in ADR-088 D7), CRUD on the shared session store, including the store-level `SetPromptSuggestionStatus` (accept/dismiss persistence; no frontend caller yet)
- `backend/session/prompt_suggest.go` — the trigger: the finish-hook outcome gate (D2), one fail-open generation pass per kind on a tracked background goroutine, atomic persistence of the pass, and the session-scoped `prompt_suggestions` event
- `backend/frontend_api_suggestions.go` — the RPC surface: `GetPromptSuggestions` (restore, routed per § Flow) and `SetPromptSuggestionsEnabled` (the config gate: persist + apply in one call)
- `core/prompt_suggest.go` — the one-shot service call (`ServiceKindPromptSuggest`): input assembly (windows D3/D4, `is_nudge` filter D5, language directive D6), LLM round-trip, response parsing
- `core/prompts/prompt_suggest_continuation.md` + `core/prompts/prompt_suggest_new_session.md` — the two generation prompts (embedded via `prompts.go`; a test pins every `.md` file as referenced): continuation for a session with a transcript, new-session for the project `next_task` hand-off
- `frontend/src/api/suggestions.ts` — RPC wrappers (`@/api/*` only)
- `frontend/src/stores/promptSuggestionsStore.ts` — single-slot active-session suggestion set + position index (`usePromptSuggestions`/`usePromptSelectedIndex` selectors); cleared on session switch/delete
- `frontend/src/hooks/usePromptSuggestionsSync.ts` — refetch wiring: reloads the active session's set on session/project change and on the `prompt_suggestions` event (refetches rather than applies the payload)
- `frontend/src/hooks/useChatInputController.ts` — suggestion mode: the ↑↓→ interception (D8), the hint placeholder
- `frontend/src/components/settings/PromptSuggestionsSettings.tsx` — the Settings → General toggle for the gate

## Core Types

```go
// core/prompt_suggest.go
type SuggestionKind string // "next_task" | "goal_advance"

type PromptSuggestion struct {
    ID        string
    SessionID string
    TaskID    string // triggering task; "" for kind-less/session-level rows
    Kind      SuggestionKind
    Text      string
    Status    string // "active" | "accepted" | "dismissed" | "stale"
    CreatedAt time.Time
}

const (
    nextTaskWindowSessions = 10 // D3
    goalWindowSessions     = 5  // D4
    maxSuggestionsPerPass  = 3  // D7
)
```

```typescript
// frontend/src/stores/promptSuggestionsStore.ts
interface PromptSuggestion { id: string; kind: 'next_task' | 'goal_advance'; text: string }
// store: { sessionId, suggestions: PromptSuggestion[], position: number } | empty
```

## Flow

```
task finishes ──▶ outcome gate (D2): finish ∈ {full, partial}? ──no──▶ stop (silent)
                          │yes
                          ▼
              kind resolve (D1): goal state non-terminal on the task?
                          │            │
                    no    ▼            ▼    yes
                   kind = next_task   kind = goal_advance
                          │            │
                          ▼            ▼
        inputs (D3/D4/D5): triggering task summary
        + last 10 project sessions   + goal condition
          (is_nudge messages           + last 5 sessions
           dropped)                      on the same goal
                          └─────┬──────┘
                                ▼
              async one-shot service call (D9, ServiceKindPromptSuggest,
              serviceLLMRequestTimeout; language = history language, D6)
                                ▼
              parse → atomic replace: prior active rows of
              (session, kind) → stale; insert ≤ 3 rows (D7)
                                ▼
              session event `prompt_suggestions` (full active set)
                                ▼
        ┌── ChatInput suggestion mode (empty input only, D8) ──┐
        │  ↑ previous   ↓ next   → accept (insert as draft)    │
        │  typing clears · Esc dismisses · Enter never captured│
        └──────┬───────────────────────────┬───────────────────┘
        accepted row                     dismissed set
        (SetPromptSuggestionStatus)      (SetPromptSuggestionStatus)
```

## Behavior

### Triggers (D2)

| Task outcome | Generation? |
| --- | --- |
| `full` | yes |
| `partial` | yes |
| `failed` / `aborted` / `cancelled` | no |
| pause / resume | no (resume continues the same task; finish still gated) |

Exactly one generation pass per triggering task: the outcome gate consumes the finish event once; retries of the bookkeeping path must not double-fire (generation is idempotent per (task, kind) — a second pass replaces the first).

### Generation inputs

| Kind | Window | Extra input | Filter |
| --- | --- | --- | --- |
| `next_task` | last **10** sessions of the project (D3) | triggering task's trajectory summary | `is_nudge` dropped (D5) |
| `goal_advance` | last **5** sessions bound to the same goal (D4) | the goal's success condition | `is_nudge` dropped (D5) |

`is_nudge` (D5): a boolean stamped into the persisted message metadata at ingestion for (a) messages injected by the resume path's `nudge` parameter (`Step.UserNudge`) and (b) short contentless continuation prompts typed by the user ("continue", "продолжай", kin). The flag is metadata-only — rendering and execution never consult it; only the suggestion input builder drops it. Windows are chronological, project-scoped, and per-session bounded; no embedding retrieval in v1.

### Language (D6)

The generation prompt directs the model to write suggestions in the dominant language of the supplied history. No setting, no detector — the history is the signal.

### UX contract (D8)

Suggestion mode is active **only** when the input is empty AND an active set exists; outside it, all keys keep native behavior.

| Key | In suggestion mode | Effect on data |
| --- | --- | --- |
| `↑` | previous suggestion (wraps) | none |
| `↓` | next suggestion (wraps) | none |
| `→` | insert text into the input as an editable draft; exits mode | row → `accepted` |
| any typing | clears the chip, normal typing | none |
| `Esc` | dismisses the set | set rows → `dismissed` |
| `Enter` | never captured (empty input cannot send) | none |

After a send, the UI clears the session's suggestion set. Session open/switch restores the active set via `GetPromptSuggestions`; a fresh set arrives over the session-scoped `prompt_suggestions` event (payload: the full active set for the session, both kinds) and is consumed by refetching, not by applying the payload (`usePromptSuggestionsSync`). **v1 delta:** accept/dismiss reporting is not wired on the frontend — `SetPromptSuggestionStatus` exists only at the store level (`backend/session/persistence.go`), so `→` inserts the draft and exits the mode without marking the row `accepted`, and leaving the mode is a UI-only selection reset; the report RPC is the open D7/D8 follow-up.

## Error Handling

Fail-open at every layer (D9): outcome-gate mismatch, empty window, LLM error/timeout, unparsable response, persistence failure, retrieval failure — each is a Debug log and "no suggestions". The send path and the finish path never wait on, observe, or fail because of this subsystem. A stale `accepted` report for an already-replaced row is a no-op.

## Invariants

- Suggestions are generated only for task outcomes `full` and `partial` — never after `failed`, `aborted`, or `cancelled` (D2).
- At most one `active` suggestion set per (session, kind) exists; a fresh pass atomically stales the previous one (D7).
- `is_nudge` messages never enter a generation window (D5).
- `next_task` never reads beyond 10 sessions; `goal_advance` never beyond 5 (D3/D4).
- Suggestion text matches the language of the history it was generated from (D6).
- `↑`/`↓`/`→` are intercepted only in suggestion mode (empty input + active set); `Enter` is never captured (D8).
- No failure in the subsystem can delay, block, or error a message send or task finish (D9).
- The only config surface is the `prompt_suggestions.enabled` gate (pointer-bool, nil = on); the windows (10/5) and the per-pass cap (3) remain compile-time constants (D3/D4/D7/D9).

## Configuration

One key: `prompt_suggestions.enabled` — the opt-out the ADR deferred, shipped with the implementation. Pointer-bool per the house convention: the section or key absent reads as **on**, an explicit `false` opts out entirely (the outcome gate never fires — no generation pass, no LLM call, no store write, no event). Documented in `config.example.yaml`; toggled at runtime from Settings → General via `SetPromptSuggestionsEnabled` (persist + apply in one call, no restart); the config read path resolves the effective value through `PromptSuggestionsConfig.SuggestionsEnabled()` (nil = on). Windows (10/5), the per-pass cap (3), and the fail-open posture remain compile-time constants — the gate changes nothing about boundedness.

## Extension Points

- **New kind**: add the enum value, a window definition, and a trigger predicate — table, pipeline, and UX are kind-agnostic (D1).
- **Retrieval-backed inputs**: swap the chronological window for embedding retrieval without touching persistence or UX (rejected for v1, kept cheap to add).
- **Per-kind caps**: `maxSuggestionsPerPass` can become per-kind if telemetry shows one kind wants more surface.

## Related Specs

- [ADR-088](../decisions/088-prompt-suggestions.md) — decisions D1–D9 this contract implements
- [goal-mode.md](goal-mode.md) — the goal loop `goal_advance` suggestions feed (ADR-019)
- [ADR-086](../decisions/086-goal-mode-suggestion.md) — the blocking sibling: goal-mode activation offers at routing time
- [session-lifecycle.md](session-lifecycle.md) — task outcomes, the resume/nudge path the `is_nudge` stamp rides, persistence layout
- [event-catalog.md](../contracts/event-catalog.md) — the `prompt_suggestions` session event
- [desktop-frontend.md](../contracts/desktop-frontend.md) — the RPC surface the suggestions methods join via embedding
