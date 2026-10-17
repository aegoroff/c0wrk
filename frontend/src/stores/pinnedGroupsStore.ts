import { useCallback } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Branch names of the worktree groups the user PINNED in the session
 * selector — a GROUP-level pin (the whole branch row floats above the
 * unpinned groups of its section), distinct from the per-session `pinned`
 * flag, which keeps ordering sessions INSIDE its bucket. Worktree groups are
 * a client-side projection (the backend has no branch-group entity), so the
 * pin lives here and persists across restarts.
 *
 * Keyed by PROJECT id: a branch name is only unique within one repository,
 * so `main` pinned in project A must not surface pinned in project B (and
 * unpinning it there must not touch A's pin).
 */
interface PinnedGroupsState {
  /** Pinned branch names, per project id. */
  pinsByProject: Record<string, string[]>
}

interface PinnedGroupsActions {
  togglePinnedBranch: (projectId: string, branch: string) => void
}

export type PinnedGroupsStore = PinnedGroupsState & PinnedGroupsActions

/** Storage key mirrors the persisted-store convention (c0wrk-*). */
const STORAGE_KEY = 'c0wrk-pinned-worktree-groups'

/** Stable empty answer — a fresh array per selector call would break the
 *  Zustand snapshot identity and re-render the selector on every tick. */
const EMPTY: readonly string[] = []

/** The project's pinned branch names — stable reference when nothing is pinned. */
export function pinnedBranchesFor(
  state: PinnedGroupsState,
  projectId: string | null,
): readonly string[] {
  return (projectId !== null && state.pinsByProject[projectId]) || EMPTY
}

/**
 * The active project's group pins, with the toggle bound to that project
 * (call sites pass only the branch name; a null project — CHAT mode — has
 * no groups to pin, so the toggle is a no-op there).
 */
export function useGroupPins(projectId: string | null): {
  pinnedBranches: readonly string[]
  togglePinnedBranch: (branch: string) => void
} {
  const pinnedBranches = usePinnedGroupsStore((s) => pinnedBranchesFor(s, projectId))
  const toggle = usePinnedGroupsStore((s) => s.togglePinnedBranch)
  const togglePinnedBranch = useCallback(
    (branch: string) => {
      if (projectId !== null) toggle(projectId, branch)
    },
    [projectId, toggle],
  )
  return { pinnedBranches, togglePinnedBranch }
}

export const usePinnedGroupsStore = create<PinnedGroupsStore>()(
  persist(
    (set, get) => ({
      pinsByProject: {},

      togglePinnedBranch: (projectId, branch) => {
        const current = get().pinsByProject[projectId] ?? []
        set({
          pinsByProject: {
            ...get().pinsByProject,
            [projectId]: current.includes(branch)
              ? current.filter((b) => b !== branch)
              : [...current, branch],
          },
        })
      },
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      // v1 stored a bare `pinnedBranches` array with no project binding —
      // the (wrong) cross-project pins cannot be attributed, so they drop.
      migrate: () => ({ pinsByProject: {} }),
      partialize: (state) => ({ pinsByProject: state.pinsByProject }),
    },
  ),
)
