import { useMemo } from 'react'
import { useSessionStore } from '@/stores/sessionStore'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import type { GitWorktree } from '@/types/models'

/** Tooltip/blocked reason for a branch switch refused by the managed-focus
 *  gate — the backend answer (ErrPinnedWorktreeBranch) the UI pre-empts.
 *  Exported for the exact-wording assertions in the consumer tests. */
export const MANAGED_FOCUS_BLOCKED_REASON =
  'Branch switching is disabled while the Git panel is focused on a session worktree — switch the focus to the local checkout first'

/**
 * The active session's managed-worktree pin (ADR-080), derived for the Git
 * panel's branch/worktree surfaces.
 *
 * When the active CODE session is bound to a managed worktree
 * (`workspace_binding.kind === 'managed_worktree'`), its branch and tree are
 * pinned: the backend refuses branch checkout/creation/rename targeting the
 * pinned branch (ErrPinnedWorktreeBranch while the Git-panel focus sits on a
 * managed session tree) and the binding itself is immutable. The Git-panel UI
 * renders that pin (a lock instead of the focus/current checkmark) and must
 * not offer deletion of the session's own branch or tree — this hook is the
 * single source of the pin decision for both BranchDropdown and BranchPicker.
 *
 * - `pinnedBranch` — the pinned branch name, or null when the active session
 *   is not managed-worktree-bound (local / CHAT / no active session).
 * - `isPinnedWorktree` — predicate for a `GitWorktree` row: true only for the
 *   session's own managed tree. The match is deliberately triple-barrelled:
 *   `session_id` (the owner decoration from ListProjectWorktrees), the
 *   binding's stored `workspace_path`, and the durable portable
 *   `worktree_name` on a managed row — the listing reports CANONICAL git
 *   paths while a stored binding may keep a non-canonical (symlinked
 *   ancestor) form, and the owner decoration needs a resolvable session row.
 * - `branchSwitchBlockedReason` — the managed-FOCUS gate (ADR-080): while
 *   the Git panel's focus sits on a managed session tree, the backend
 *   refuses CheckoutBranch / CreateBranch / CheckoutRemoteBranch there for
 *   every branch other than the tree's own (refusePinnedBranchSwitch — a
 *   same-branch checkout cannot move the tree off its pin). The pin that
 *   matters is the FOCUSED tree's, not the active session's: the focus can
 *   rest on another session's tree while a local session is active. The
 *   function returns the explaining reason for a refused branch name and
 *   null when the switch is allowed (or the focus is not a managed tree);
 *   consumers surface it as a dimmed row / disabled button instead of a
 *   server-side failure. The server refusal itself stays in place as the
 *   authority over a stale focus snapshot.
 *
 * All outputs are referentially stable for a given
 * (sessions, activeSessionId, worktrees) snapshot — computed in useMemo over
 * primitives, never inside a Zustand selector (stable-selector rule: no
 * per-call allocations in selectors).
 */
export function useSessionWorktreePin(): {
  pinnedBranch: string | null
  isPinnedWorktree: (worktree: GitWorktree) => boolean
  branchSwitchBlockedReason: (branchName: string) => string | null
} {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const worktrees = useGitPanelStore((s) => s.worktrees)

  return useMemo(() => {
    // The managed-focus gate follows the FOCUS, not the active session's
    // binding — it applies with no managed active session too (the focus can
    // rest on another session's tree while a local session is active).
    const focused = worktrees.find((w) => w.is_focus)
    const focusManaged = focused?.kind === 'managed'
    const branchSwitchBlockedReason = (branchName: string): string | null =>
      focusManaged && branchName !== (focused?.branch ?? null)
        ? MANAGED_FOCUS_BLOCKED_REASON
        : null
    const binding = sessions?.find((s) => s.id === activeSessionId)?.workspace_binding
    if (binding === undefined || binding.kind !== 'managed_worktree') {
      return {
        pinnedBranch: null,
        isPinnedWorktree: () => false,
        branchSwitchBlockedReason,
      }
    }
    const pinnedBranch = binding.branch ?? null
    const workspacePath = binding.workspace_path
    const worktreeName = binding.worktree_name ?? null
    return {
      pinnedBranch,
      isPinnedWorktree: (worktree: GitWorktree): boolean =>
        (worktree.session_id !== undefined && worktree.session_id === activeSessionId) ||
        worktree.path === workspacePath ||
        (worktree.managed && worktreeName !== null && worktree.name === worktreeName),
      branchSwitchBlockedReason,
    }
  }, [sessions, activeSessionId, worktrees])
}
