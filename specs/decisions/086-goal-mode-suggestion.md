# ADR-086: Goal-Mode Suggestion at the Routing Stage

## Status

Accepted

## Context

Goal mode (ADR-019) is a multi-turn loop that pursues a user-approved success condition to completion. Its only entry points are explicit: a leading `/goal` command or the manual toggle in the chat input. Users who do not know the mode exists — or do not recognize that their request fits it — never reach it, even when their message describes exactly the kind of checkable, multi-step objective the loop is built for.

The request pipeline already computes a semantic classification of every fresh message: the routing pass (ADR-012) returns domain/complexity/skills before any execution starts. That classification is the natural evaluation point: it happens BEFORE the Conductor run, so a mode switch there can still happen "before the work begins", which is the hard UX requirement — offering goal mode after the task started would mean either abandoning in-flight work or misapplying the mode mid-task.

Two constraints shaped the decision:

1. **The router's decision shape is closed.** ADR-012 deliberately stripped the execution mode from the sp4rk `RoutingDecision` (the router retains domain, complexity, matched skills, and model selection). Goal mode is a c0wrk-domain feature; a `goal_fit` field on the engine-owned type would leak a c0wrk concept into sp4rk and partially reverse ADR-012.
2. **The offer must block.** A non-blocking toast cannot honor "activate before the task starts": the Conductor would already be running when the user clicks. A blocking pending action is the established pattern (goal proposals, plan approvals, tool confirmations).

## Decision

A **c0wrk-side, post-routing suggestion gate** offers goal-mode activation to the user:

1. **Classifier** — a one-shot service LLM call (`ServiceKindGoalSuggest`, `core/goal_suggest.go`) over a c0wrk-owned prompt (`core/prompts/goal_suggest.md`). It receives the raw message plus the advisory routing context and returns `{suggest, reason}`; `suggest=true` only for an OBVIOUS fit (concrete objective, checkable "done", multi-step, autonomous drive to completion). The classifier rides the session's own LLM caller and the shared `serviceCall` pipeline (per-kind telemetry + the service-call log record), like title/commit-message generation.
2. **Gate position** — in `HandleMessage`, AFTER `routeOrContinue` and BEFORE the continuation commit point / context enrichment, on the plain Conductor path only. Cheap LLM-free preconditions first: fresh task (`TaskID == ""`), no explicit goal, no review mode, feature config enabled, routing eligible (domain ≠ general, complexity ≥ `goal_loop.suggest.min_complexity`), no Model Profiles essential-tools narrowing (goal is hard-blocked there), no session suppression, proposer wired.
3. **Blocking offer** — a desktop `goalSuggestionAdapter` (implements `core.GoalSuggestionProposer`) emits the `goal_suggestion` session event (persisted, pending-action card) and BLOCKS the pipeline until the user answers via the `goal_suggestion_response` event or the `AcceptGoalSuggestion`/`DeclineGoalSuggestion` RPCs — one resolver, two paths, mirroring the goal-proposal flow.
4. **Acceptance re-enters the goal loop with the SAME routing** — `runGoalLoop` is split into the routing head plus `runGoalLoopRouted`; the accepted entry calls the routed variant with the already-established `RoutingDecision`. The one-routing-decision-per-goal-task invariant holds and no second router LLM call is made. The accepted entry passes `fallbackOnDeriveFailure=true`: a GENUINE failed goal derivation falls back to the plain Conductor run instead of ending the just-accepted task with no work (the explicit `/goal` entry keeps its historical clean-exit behavior). A user CANCEL of the `goal_proposal` card is carved out of that fallback in BOTH entry modes (`errGoalDerivationCancelled`, matched with `errors.Is` and classified before the flag): cancelling the framing after accepting the offer must mean the same thing as cancelling one raised by an explicit goal run — the task ends cleanly with the request acknowledged — never a silent plain run of the whole task the user just declined to frame.
5. **Decline suppression** — an explicit user decline sets a session-scoped flag on the per-session Orchestrator; further suggestions stay silent for the rest of the session. Classifier failures, proposer failures, and shutdown drains fail OPEN: the plain path runs and suppression is NOT engaged (an app quit is not a user decline).
6. **Budget** — an accepted suggestion activates the goal with the default unlimited budget (the user can pause/stop at any time); no budget control on the suggestion card. The existing `goal_proposal` sign-off (with condition/verify/mode editing) remains the second touchpoint after acceptance.
7. **Config** — `goal_loop.suggest.enabled` (pointer-bool, nil/unset = on) is the kill-switch; `goal_loop.suggest.min_complexity` (default 2) keeps the classifier away from complexity-1 messages that can never be goals.

## Consequences

Positive:

- Goal mode becomes discoverable exactly when it fits, with zero cost when it does not (the classifier only runs behind the cheap preconditions).
- The router stays a pure engine classifier; the feature is entirely c0wrk policy.
- Fail-open everywhere: the suggestion feature can never break a send.

Negative / accepted trade-offs:

- A high-confidence match adds one blocking user interaction before the task starts (plus the existing goal-proposal sign-off after acceptance — two touchpoints total).
- One extra LLM call per eligible fresh message.
- Continuations (and the routing fast-path) never see suggestions — there is no fresh classification to reason about there.

## Alternatives Considered

- **A `goal_fit` field on the sp4rk `RoutingDecision`** (classify inside the routing call). Rejected: expands the engine-owned decision shape that ADR-012 deliberately closed; couples sp4rk to a c0wrk-domain feature; unknown JSON fields are already dropped by the engine parser, so it requires an engine release cycle.
- **A separate pre-routing classification call.** Rejected: duplicates work the router already did, and the routing result (domain/complexity) is valuable advisory input for the classifier.
- **A non-blocking hint (toast/badge).** Rejected: cannot guarantee activation before the task starts; the Conductor would be mid-run when the user answers.
- **Offering on continuations too.** Rejected for v1: the continuation fast-path skips the router, so there is no fresh classification; an extra classification call there would misclassify continuation messages (the documented reason the fast-path exists).

## Related

- [goal-mode.md](../domains/goal-mode.md) — the goal loop this gate feeds (Suggested Activation section)
- [router.md](../domains/orchestration/router.md) — the routing pass the gate follows
- [ADR-012](./012-conductor-orchestration-pipeline.md) — the router's closed decision shape
- [ADR-019](./019-goal-mode.md) — goal mode itself
