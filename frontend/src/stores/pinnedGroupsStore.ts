import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Branch names of the worktree groups the user PINNED in the session
 * selector — a GROUP-level pin (the whole branch row floats above the
 * unpinned groups of its section), distinct from the per-session `pinned`
 * flag, which keeps ordering sessions INSIDE its bucket. Worktree groups are
 * a client-side projection (the backend has no branch-group entity), so the
 * pin lives here as the branch name and persists across restarts.
 */
interface PinnedGroupsState {
  pinnedBranches: string[]
}

interface PinnedGroupsActions {
  togglePinnedBranch: (branch: string) => void
}

export type PinnedGroupsStore = PinnedGroupsState & PinnedGroupsActions

/** Storage key mirrors the persisted-store convention (c0wrk-*). */
const STORAGE_KEY = 'c0wrk-pinned-worktree-groups'

export const usePinnedGroupsStore = create<PinnedGroupsStore>()(
  persist(
    (set, get) => ({
      pinnedBranches: [],

      togglePinnedBranch: (branch) => {
        const current = get().pinnedBranches
        set({
          pinnedBranches: current.includes(branch)
            ? current.filter((b) => b !== branch)
            : [...current, branch],
        })
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      partialize: (state) => ({ pinnedBranches: state.pinnedBranches }),
    },
  ),
)
