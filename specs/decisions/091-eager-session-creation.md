# ADR-091: Eager Session Creation — the Draft-Free Workspace Flow

## Status

Accepted. Amends [ADR-080](./080-session-worktrees.md) (decision 5's
creation-via-draft flow and the absolute reading of binding immutability —
the fresh-window exception below) and retires the chat-side draft UX the
080 lifecycle steps shipped; [ADR-082](./082-shared-managed-worktrees.md)
(shared trees) stands unchanged and is consumed by the new flow.

## Context

The ADR-080 chat-side draft UX armed a frontend-only "New Session" draft in
CODE projects: no session row existed until the first real action (send /
attachment paste / terminal open) committed it via `CreateManagedSession`.
The draft committed real work as a side effect of unrelated gestures:

- **Attachments provisioned worktrees.** Staging an attachment committed the
  draft, and a branch draft synchronously ran `git worktree add` (a full
  checkout) — a multi-second delay attached to dropping a file on the
  composer.
- **No session meant no per-session state.** Session-scoped auxiliary work
  directories (`AddWorkDirectory(scope=session)`) require a session row; the
  draft's no-session window locked the feature out.

Both problems share one root: the draft made "session does not exist yet" a
first-class state that non-send actions had to resolve. The session row
itself is cheap (a local session has nothing to provision); only the
worktree is expensive — and the worktree is only needed when the session
actually starts running, which is exactly when the first message is sent.

## Decision

1. **Every "New Session" eagerly creates the session row.** CODE projects
   create a plain LOCAL session on the gesture — the same contract CHAT
   (No Project) always had. There is no draft state anywhere: a session
   exists from the click onward, executes in the project checkout, and is
   fast because nothing is provisioned. The rare no-active-session edge
   (fresh start without a saved session, last session deleted, research
   Shift-click) auto-creates a plain local session on demand
   (`lib/ensureActiveSession`) — never a worktree.

2. **The workspace is chosen per fresh session, in the same UX, without a
   draft.** The chat toolbar's `SessionWorkspaceSelector` stays interactive
   while the ACTIVE session is FRESH — its transcript is confirmed empty
   (the message index exists and is empty; an absent index means "history
   not loaded", an unknown state that shows the safe pinned chip) and no
   task is running. The gesture is unchanged: click → `local` / `branch…` →
   the BranchPicker's pick mode (remote-tracking rows pick a create-branch
   choice; the main checkout's own branch and external/detached trees stay
   blocked). The choice is recorded in a transient per-session frontend
   store (`sessionWorkspaceStore`) and displayed by the selector; the
   session-selector's per-branch "+" gesture creates the session eagerly and
   presets its choice.

3. **The worktree is provisioned by the first send, before the task
   starts.** `SendMessage` gained a trailing `workspace` argument
   (`SessionWorkspaceChoice{branch, createBranch, startPoint}`; nil for
   every ordinary send, continuation and nudge — a no-op). A non-nil choice
   on a FRESH session provisions the tree (or ADOPTS the branch's existing
   managed tree per ADR-082, or no-ops when the checkout itself holds the
   branch — the session already executes exactly there), persists the
   binding, and only then dispatches the task; a provisioning failure
   (typed `ErrBranchBusy`, DWIM refusals) rejects the send before any state
   is touched — no activity bump, no persisted message. The former
   `CreateManagedSession` RPC and its frontend draft-commit UX
   (`sessionDraftStore`/`lib/sessionDraft`) are deleted; the send-time path
   reuses the same ownership primitives and the adoption↔deletion critical
   section protocol. `SessionDraft`/`CreateSessionFromDraft` themselves
   SURVIVE as the manager's internal identity seam — the reserved-identity
   path `Manager.CreateSession` builds on (and the managed fork mints its
   identity through) — no longer a user-facing state.

4. **The fresh window is the one sanctioned binding mutation.** ADR-080's
   immutability stands everywhere else. `SessionStore.BindSessionWorkspace`
   writes the binding of a session with NO transcript rows and NO task rows —
   the guard is part of the UPDATE's WHERE, so the check and the write are
   one atomic statement and a send racing a first persisted message cannot
   slip past it; a refusal is the typed `ErrSessionNotFresh`. After the
   write the in-memory session is evicted
   (`Manager.EvictSessionCarryingAttachments`, the promotion flow's
   primitive: refuses an active task/compaction, waits out in-flight
   restores, and hands back the session's staged pending attachments) so
   the send's own session access lazily restores an orchestrator BUILT for
   the new workspace — the orchestrator captures its workspace at
   construction, so a binding write alone cannot retarget execution. The
   returned attachment snapshot is re-staged onto the restored session
   inside the send path; a failed re-stage rejects the send and surfaces
   the staged-attachments-lost event instead of dropping them silently.
   Freshly provisioned trees
   are compensated (released) on every post-write failure; adopted trees are
   never touched.

5. **Attachments, paste and terminal never create worktrees.** They target
   the active session (which now always exists after the gesture); their
   no-session fallback creates a plain local row. WorkDirs and every other
   per-session surface work from the moment the session exists.

## Consequences

- The complained delay moves to where the work belongs: the first send shows
  the toolbar's "Preparing worktree…" hint while provisioning runs
  (the store's consumption window brackets the RPC), and the session's
  binding is mirrored optimistically on success.
- Abandoned "New Session" clicks leave empty local session rows (the CHAT
  precedent); they are inert and deletable, and their pending choices die
  with them.
- A pending choice is transient by design (never persisted): a restart
  leaves the session local, which is what its row already says. A stale
  choice on a session that stopped being fresh is dropped by the selector.
- `GetPromptSuggestions`' empty-session-id surface loses its producer (the
  armed draft): the content-based routing (transcript → continuation set,
  else the project's `next_task`) is unchanged and still covers the
  brand-new-session case via the session's real id.
- The frontend's Wails bindings must be regenerated (`make build` /
  `wails dev`) for the changed `SendMessage` signature and the removed RPC.

## Alternatives Considered

- **Keep the draft, defer only its commit to send** — rejected: the draft's
  no-session state is what broke workdirs and made every first-action site
  commit; the state machine was the bug, not its timing.
- **Provision at branch-pick time (explicit gesture, spinner on the
  selector)** — rejected: it recreates eager expensive work on an abandoned
  intent (pick a branch, never send → an orphaned tree) and the user-facing
  requirement is explicit: the tree exists after the send, before the task.
- **Rebind an existing session's binding in place** — impossible without
  rebuilding the orchestrator (the workspace is a construction-time
  capture); eviction-plus-restore is the rebuild mechanism the manager
  already owns.

## References

- [ADR-080](./080-session-worktrees.md) — typed workspace bindings; the
  fresh window is now their only mutation path.
- [ADR-082](./082-shared-managed-worktrees.md) — shared trees; adoption is
  the branch-holder dispatch of the send-time bind.
- [specs/contracts/desktop-frontend.md](../contracts/desktop-frontend.md)
  § Data Flow Across Boundary — Session creation flow.
