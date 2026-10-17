# ADR-088: Prompt Suggestions (chat-input ↑↓→)

## Status

Accepted

> **Implementation amendment (recorded in place).** The implementation shipped the config gate this ADR had deferred: `prompt_suggestions.enabled` (pointer-bool, absent = on), persisted via `SetPromptSuggestionsEnabled` and toggled from Settings → General. This supersedes only the closing "no config gate in v1" sentence of D9 and the "Deferred" alternative below; everything else — fail-open async generation, the windows, the caps, the UX contract — landed as decided. See [prompt-suggestions.md](../domains/prompt-suggestions.md) § Configuration.

## Context

After a task completes, the chat input sits empty and the user must invent the next request from scratch — even though everything needed to propose good follow-ups is already persisted: full session history (`session_messages`), per-task outcomes (`tasks.status` + the `agent_metrics.finish` values `full|partial|failed|aborted|cancelled`), and goal state (`task_goal_state`). The same gap exists mid-goal: a user driving a goal loop (ADR-019) often does not know what to ask next to keep it moving.

Two constraints shaped the decision:

1. **The feature must be free.** Suggestions are a convenience layer on top of the chat path. Any design that could delay, block, or error a message send or a task-finish bookkeeping step is unacceptable — the established pattern for such side-channel intelligence is the one-shot service call (title, commit message, prompt optimization, goal-suggest classifier in ADR-086) with per-kind telemetry and the dedicated service timeout.
2. **The affordance must never steal input.** The chat input is the most contended surface in the UI (session switch, attachments, paste, `/`-mentions, `#`-files). A suggestion UI that hijacks keys unconditionally or auto-completes silently would break existing muscle memory. The feature therefore needs an explicit, narrow UX contract carved out only for the empty-input state.

This is a design-first ADR: the feature ships behind no config gate in v1 and its behavior is fully fail-open (D9). A companion document, [prompt-suggestions.md](../domains/prompt-suggestions.md), carries the behavioral contract.

## Decision

Nine decisions, referenced as D1–D9 throughout the domain spec:

**D1 — Two suggestion kinds, one store.** The feature produces two kinds of suggestions: `next_task` — follow-up prompts offered after a completed task ("what should I ask next"), and `goal_advance` — prompts for advancing an active goal ("how do I keep driving this goal"). Both kinds share one persistence table, one generation pipeline, and one UX surface; they differ only in trigger context and generation inputs (D3/D4).

**D2 — Triggers: task outcomes success and partial only.** Generation fires exactly once per triggering task, when the task finishes with outcome `full` or `partial` (the success-class values of `agent_metrics.finish`). The failure-class outcomes — `failed`, `aborted`, `cancelled` — never trigger: suggestions after a crashed or cancelled run would be noise on top of an error state. A paused task is not a trigger; it resumes the same task instead of finishing it.

**D3 — `next_task` inputs: the last 10 sessions of the project.** The generation input is the triggering task's trajectory summary plus the recent conversational context of the same project: the last **10 sessions** (their user/assistant message content, most recent first, bounded per session). The window is chronological and project-scoped — no embedding retrieval, no cross-project history.

**D4 — `goal_advance` inputs: the last 5 sessions on the same goal.** When the triggering task carries a non-terminal goal, the goal kind is generated instead from the goal condition plus the last **5 sessions** bound to the same goal (linked through the persisted goal/task state). The narrower window keeps the input anchored to the goal's own recent history rather than the project at large. Both windows (10 and 5) are compile-time constants, not config (v1 has no configuration surface — D9).

**D5 — The `is_nudge` input filter.** Low-content continuation prompts — messages injected mechanically by the resume path's `nudge` parameter (`Step.UserNudge`) and short contentless continuation messages typed by the user ("continue", "продолжай", and kin) — are stamped `is_nudge` on the persisted message metadata at ingestion. The generation-input builder drops every `is_nudge` message from BOTH windows: nudges describe no work and would skew suggestions toward vacuous continuations. The flag is metadata-only; it changes nothing about rendering or the executor.

**D6 — Language follows the history.** Suggestions are written in the dominant language of the conversation history included in the input — the generation prompt instructs the model to match it. No language setting, no detection call: the history itself is the signal, and a project worked in Russian gets Russian suggestions.

**D7 — Persistence: the `prompt_suggestions` table.** One row per suggestion, in the session store's schema (`backend/session/persistence.go`, additive `CREATE TABLE IF NOT EXISTS`, conforming to the store's conventions):

```sql
CREATE TABLE IF NOT EXISTS prompt_suggestions (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    task_id    TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL CHECK (kind IN ('next_task','goal_advance')),
    text       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','accepted','dismissed','stale')),
    created_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_suggestions_session
    ON prompt_suggestions(session_id, status);
```

A generation pass produces up to 3 suggestions for one (session, kind). A fresh pass for a (session, kind) atomically marks the previous `active` rows `stale` and inserts the new set — at most one active set per (session, kind) exists at any time. `accepted`/`dismissed` are terminal per-row outcomes reported by the frontend (D8); `stale` rows are dead weight removed by the same atomic replace and by the session-delete cascade. Project deletion needs no dedicated handling: suggestions hang off sessions, which cascade from projects already.

**D8 — UX contract: the chat input, keys ↑ ↓ →.** Suggestions surface passively inside the existing chat input as a hint chip (current suggestion text + position), never a modal, never a blocking card. The contract is exactly three keys, intercepted **only** while suggestion mode is active (the input is empty AND an active suggestion set exists — in that state the arrows have no native text-editing meaning):

| Key | Action |
| --- | --- |
| `↑` | previous suggestion in the active set (wraps) |
| `↓` | next suggestion in the active set (wraps) |
| `→` | accept: insert the suggestion text into the input as editable draft |

Anything else exits suggestion mode without side effects: typing a character clears the chip, `Esc` dismisses (the set is marked `dismissed`), `Enter` is never captured — an empty input cannot send, so `Enter` in suggestion mode is a no-op, not an auto-send. `→` inserts the text for editing; sending remains a separate, deliberate user action. Accept/dismiss are reported back and persisted per row (D7). After a send, the session's suggestion set is cleared from the UI. On session open or switch, the active set is restored via the suggestions RPC, and a freshly generated set arrives over the session-scoped `prompt_suggestions` event (to be added to the event catalog at implementation time).

**D9 — Fail-open, async, service-call generation.** Generation is a one-shot service LLM call (`ServiceKindPromptSuggest`, a c0wrk-owned prompt under `core/prompts/`) riding the established service-call pipeline — per-kind telemetry, the `timeouts.serviceLLMRequestTimeout` ceiling. It is fired asynchronously AFTER task-finish bookkeeping completes: never in the send path, never awaited by the UI, never blocking. Every failure fails open — outcome-gate mismatch, empty windows, LLM error, parse error, persistence error, retrieval error — with a Debug log and no suggestions; the chat path cannot observe the difference between "feature off" and "feature broken". v1 ships without a config gate: silence IS the off state, and a kill-switch can be added later if telemetry ever demands one.

## Consequences

Positive:

- Good follow-ups become one `→` press away, for both plain tasks and goal loops, at zero cost when nothing fires (generation only runs behind the outcome gate).
- The chat path is structurally untouchable: async generation off the finish path, fail-open everywhere, no config to mis-tune.
- One table, one kind enum, one pipeline for both suggestion kinds; adding a third kind is an enum value + a window definition.

Negative / accepted trade-offs:

- One extra LLM call per qualifying task finish (full/partial).
- The `is_nudge` stamping depends on ingestion marking nudges honestly; unmarked nudges degrade suggestion quality but nothing else.
- The ↑↓→ contract occupies three keys in the empty-input state; a user who wanted arrow-key cursor motion in an empty input loses nothing (there is no text to move through).
- Suggestions may occasionally be generic; bounded windows (D3/D4) and the language rule (D6) keep them cheap and local rather than perfect.

## Alternatives Considered

- **Blocking the task-finish path until suggestions exist** (the ADR-086 goal-suggestion shape). Rejected: that gate offers a mode switch that must precede execution; prompt suggestions have no such ordering requirement, so paying latency per finish for freshness nobody needs is a bad trade — async delivery over an event is enough.
- **Inline ghost-text autocomplete** (type-ahead inside the input). Rejected: ambiguous acceptance semantics on a surface shared with paste/IME/mention completion, and it invites accidental sends; the chip + explicit `→` is unambiguous.
- **Semantic retrieval over past sessions** (embedding search for "similar past work" as input). Rejected for v1: chronological windows are deterministic, cheap, and need no index lifecycle; retrieval can be an extension point later.
- **A config kill-switch (`prompt_suggestions.enabled`)**. Deferred: with fail-open delivery and no blocking anywhere, there is nothing for a user to opt out of except suggestions they can dismiss with one key; add the gate only with evidence. *(No longer deferred: the gate shipped with the implementation — see the Status amendment.)*
- **Generating on the frontend from raw history.** Rejected: the backend already owns persistence, outcome classification, and service-call telemetry; a second generation site would fork the prompt, the windows, and the fail-open contract.

## Related

- [prompt-suggestions.md](../domains/prompt-suggestions.md) — the behavioral contract (triggers, windows, filters, UX, language)
- [ADR-086](./086-goal-mode-suggestion.md) — the sibling suggestion family: blocking goal-mode activation at routing time
- [ADR-019](./019-goal-mode.md) — goal mode, the loop `goal_advance` suggestions feed
- [session-lifecycle.md](../domains/session-lifecycle.md) — task outcomes, resume/nudge path, persistence layout
