// Worktree deletion for the Git panel's worktree lists (the focus switcher
// shared by BranchDropdown and BranchPicker).
//
// Mirrors useBranchActions: one synchronous in-flight gate, every operation
// recorded through runGitOperation (the Git panel's operation console is the
// single surface for results), and a destructive delete gated on mandatory
// confirmation (WorktreeDeleteConfirmDialog). The backend owns the rules —
// the local checkout is refused outright, a dirty tree refuses without
// force, a locked tree refuses without unlock — so the frontend never
// pre-judges a tree's state beyond hiding the action for the checkout.
//
// Delete confirmation flow: requestDelete parks the tree in `pendingDelete`
// (the dialog renders from it); confirmDelete(mode, unlock) runs the RPC —
// safe = plain `git worktree remove`, force = `--force` (discards the tree's
// uncommitted changes), unlock authorizes removing a locked tree (the
// backend unlocks it as part of the removal). On failure the pending tree
// is RESTORED and the backend's message is exposed as `deleteError` so the
// dialog can show it inline: a dirty tree refuses with "worktree has
// uncommitted changes" (retry with Force), a locked tree with "worktree is
// locked" (tick the unlock box). On success the worktree list + focus
// mirror are refreshed (refreshGitFocus) — the deleted tree leaves the
// switcher and a focus pointing at it rolls back to the project checkout
// (the backend's stale-focus fallback).

import { useState, useRef, useCallback } from 'react'
import { deleteWorktree } from '@/api/git'
import { runGitOperation } from '@/lib/gitOperation'
import { refreshGitFocus } from '@/lib/gitFocus'
import { useProjectStore } from '@/stores/projectStore'
import type { GitWorktree } from '@/types/models'

/** A destructive worktree delete held for user confirmation before execution. */
export type PendingWorktreeDelete = { worktree: GitWorktree }

export interface WorktreeActions {
  /** Path of the worktree whose deletion is in flight (spinner row), or null. */
  busyPath: string | null
  /** True while a deletion is in flight. */
  isBusy: boolean
  /** The worktree awaiting delete confirmation (drives the dialog), or null. */
  pendingDelete: PendingWorktreeDelete | null
  /**
   * Backend failure from the last confirmed attempt on `pendingDelete`,
   * shown inline in the dialog. Null after a fresh request or a success.
   */
  deleteError: string | null
  /** Open the confirmation dialog for a worktree (never the checkout). */
  requestDelete: (worktree: GitWorktree) => void
  /** Execute the pending delete. mode 'safe' never discards; 'force' does. */
  confirmDelete: (mode: 'safe' | 'force', unlock: boolean) => Promise<void>
  /** Close the dialog without deleting. */
  cancelDelete: () => void
}

export function useWorktreeActions(): WorktreeActions {
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingWorktreeDelete | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Synchronous re-entrancy guard (mirrors useBranchActions): busy state
  // updates are async, so two same-tick confirmations could otherwise run
  // two removals concurrently.
  const busyRef = useRef(false)

  // Single in-flight gate shared by the one destructive operation. The
  // operation runs through runGitOperation, which records its outcome for
  // the active project's operation console and never throws. `ran: false`
  // means the request was skipped — another operation was in flight or
  // there is no active project to record against.
  const remove = useCallback(
    async (
      worktree: GitWorktree,
      options: { force: boolean; unlock: boolean },
    ): Promise<{ ran: boolean; ok: boolean; error: string | null }> => {
      const projectId = useProjectStore.getState().activeProjectId
      if (!projectId || busyRef.current) return { ran: false, ok: false, error: null }
      busyRef.current = true
      setBusyPath(worktree.path)
      try {
        const outcome = await runGitOperation({
          projectId,
          kind: 'worktree-delete',
          label: `Deleted worktree ${worktree.name}`,
          fn: () => deleteWorktree(worktree.path, options),
        })
        return { ran: true, ok: outcome.ok, error: outcome.error }
      } finally {
        busyRef.current = false
        setBusyPath(null)
      }
    },
    [],
  )

  const requestDelete = useCallback((worktree: GitWorktree) => {
    // The checkout is the project's registration root and is never
    // deletable — fail closed even if a caller leaks the event.
    if (worktree.kind === 'main') return
    setDeleteError(null)
    setPendingDelete({ worktree })
  }, [])

  const confirmDelete = useCallback(
    async (mode: 'safe' | 'force', unlock: boolean) => {
      if (!pendingDelete) return
      const pending = pendingDelete
      setPendingDelete(null)
      setDeleteError(null)
      const result = await remove(pending.worktree, { force: mode === 'force', unlock })
      if (!result.ran || !result.ok) {
        // Skipped (another operation in flight / no active project) or the
        // backend refused (dirty without force, locked without unlock, a
        // git failure). Restore the pending tree and surface the reason in
        // the dialog, where the user can retry with Force / unlock or
        // cancel. A skipped attempt carries no error to show.
        setPendingDelete(pending)
        setDeleteError(result.error)
        return
      }
      // Success: refresh the worktree list + focus mirror. The deleted tree
      // leaves the switcher; a focus pointing at it rolls back to the
      // checkout through the backend's stale-focus fallback.
      await refreshGitFocus()
    },
    [pendingDelete, remove],
  )

  const cancelDelete = useCallback(() => {
    setPendingDelete(null)
    setDeleteError(null)
  }, [])

  return {
    busyPath,
    isBusy: busyPath !== null,
    pendingDelete,
    deleteError,
    requestDelete,
    confirmDelete,
    cancelDelete,
  }
}
