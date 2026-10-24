# ADR-098: Branch-Scoped Persisted Commit-Message Drafts

## Status

Accepted

## Context

The Git panel's commit box (`frontend/src/components/GitPanel/CommitSection.tsx`) kept its draft message in `gitPanelStore.commitByProject` — a slice keyed by **project id only**, deliberately excluded from the persisted partial under the store-wide rule that live feedback is never rehydrated from a prior run.

That keying predates per-session worktrees ([ADR-080](080-session-worktrees.md), [ADR-082](082-shared-managed-worktrees.md)). Today the Git panel is a **focus-surface**: every project switch and session switch re-applies the session-default focus (`useGitFocusSync` → `SetGitPanelFocus`), and the backend emits `git:status_changed` for the new target, so `gitPanelStore.branch.name` tracks the focused worktree's branch through checkouts and external switches alike. Keying the draft by project alone means two sessions of one project sitting on different worktrees/branches share one draft: switching sessions shows the previous branch's commit message — and a commit typed for branch A can be landed on branch B by accident.

The other half of the old model also no longer fits: a draft is not "live feedback" (like a result banner); it is user-entered work. Losing it to an app restart is a defect, not a feature — the user asked for the draft to be persisted.

## Decision

**The commit-message draft is keyed by (project id, branch name) and persisted across restarts.**

- New store state: `gitPanelStore.commitMessageByBranch: Record<projectId, Record<branch, string>>`. The branch key is the focused worktree's `branch.name` at read/write time — the same signal the rest of the panel already trusts (`getCurrentBranch` on the focus-resolved root, refreshed via `git:status_changed` on every focus/checkout/external switch). Session switch onto another worktree therefore swaps the draft with the branch, and switching back restores it.
- Key edge cases: detached HEAD reports the literal `"HEAD"` (one draft slot per project for detached trees); a not-yet-resolved or unborn branch keys `''` — a per-project fallback slot that never collides with a real branch name. The box does not WRITE while the branch is unresolved: `CommitSection` keeps the textarea read-only and Generate disabled until `branch.name` resolves, so the one-status-RPC window can no longer strand a draft in the `''` slot it would silently vanish from (a legacy `''` slot, if any, stays readable while unresolved and is consumed by its commit).
- Persistence rides the store's existing zustand `persist` pipeline: `partializeGitPanel` includes the map; `mergeGitPanel` validates it entry-by-entry (a project entry must be an object, every draft a string; empty strings, empty records, non-objects, non-strings and a branch literally named `__proto__` — a prototype setter, not an own property — are dropped rather than trusted; the same fail-closed shape `activeTabByProject` uses). Legacy localStorage entries without the map rehydrate to `{}`.
- Lifecycle: a successful commit deletes the branch's key (via `setCommitMessage(projectId, branch, '')`, which also removes the project shell with its last branch); `dropProjectCommitState` removes the project's shell together with the flag slice; a stale key for a deleted branch is harmless until its next commit.
- `CommitDraftState` keeps only the transient flags (`isGenerating`, `isCommitting`, `error`) — per-project, never persisted. Every async write path (commit, AI generation, the suppression-dialog Trust/force re-commit) captures **both** the project id and the branch at click time, extending the existing capture-at-click-time contract, so a focus switch mid-flight can never land a result in the wrong branch's draft.
- The **transient rule keeps a documented exception**: operation records, in-flight flags and result banners are still never rehydrated; the draft message is user work, and is. `commitByProject` remains excluded from the persisted partial.

## Consequences

- Drafts survive session switches (scoped to their branch) and app restarts; the "wrong branch's message" failure mode is gone by construction rather than by discipline.
- The persistence column of `gitPanelStore` grows: a third per-project map joins the persisted partial (`activeTabByProject`, `skipCommitSuppressByProject`, now `commitMessageByBranch`), each with its own rehydrate validation and per-project drop path.
- A pre-existing draft written before this change was transient and is therefore not migrated — after the upgrade every box starts empty once, then persists.
- `branch.name` is a *display-state* signal: a rapid session switch shows the previous branch's draft for the one status-RPC window until `git:status_changed` lands. This matches the branch-info display itself and is bounded by the backend emitting the event directly from `SetGitPanelFocus`.
- localStorage grows with one short string per (project, branch) with an uncommitted draft; cleared on commit and on project deletion, the residue is bounded by the user's actual drafting habits.

## Alternatives Considered

- **Key by worktree path** (the focus target): physically precise — it would also separate two detached-HEAD trees — but a managed worktree is ephemeral ([ADR-080](080-session-worktrees.md)): deleting and recreating a session's tree on the same branch (or adopting a shared tree, [ADR-082](082-shared-managed-worktrees.md)) changes the path and would drop the draft. The branch name is the stable user-facing identity and matches the request.
- **Key by session id**: maximal isolation, but a fresh session continuing the same branch would start from an empty box even though the branch's intent is unchanged.
- **Keep per-project, add a confirmation on switch**: rejected — it punishes the common flow (switching is frequent and legitimate) instead of fixing the collision.
- **Backend-side persistence** (per-branch refs/config): rejected — the draft is UI state with no cross-device or cross-surface consumer; localStorage through the store's existing persist pipeline is the established pattern ([stores.md](../domains/frontend/stores.md)).

## Related Specs

- [domains/frontend/stores.md](../domains/frontend/stores.md) — the `gitPanelStore` catalog entry (`commitMessageByBranch`, `commitByProject`)
- [domains/frontend/git-operation-console.md](../domains/frontend/git-operation-console.md) — commit outcomes still never touch the draft
- [decisions/080-session-worktrees.md](080-session-worktrees.md), [decisions/082-shared-managed-worktrees.md](082-shared-managed-worktrees.md) — the worktree/branch identity model
