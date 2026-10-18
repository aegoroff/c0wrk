import { useMemo } from 'react'
import { useSessionStore } from '@/stores/sessionStore'
import type { GitWorktree } from '@/types/models'

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
 *
 * Both outputs are referentially stable for a given (sessions, activeSessionId)
 * snapshot — computed in useMemo over primitives, never inside a Zustand
 * selector (stable-selector rule: no per-call allocations in selectors).
 */
export function useSessionWorktreePin(): {
  pinnedBranch: string | null
  isPinnedWorktree: (worktree: GitWorktree) => boolean
} {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  return useMemo(() => {
    const binding = sessions?.find((s) => s.id === activeSessionId)?.workspace_binding
    if (binding === undefined || binding.kind !== 'managed_worktree') {
      return { pinnedBranch: null, isPinnedWorktree: () => false }
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
    }
  }, [sessions, activeSessionId])
}
