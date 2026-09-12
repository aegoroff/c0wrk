import { create } from 'zustand'
import type { E2SSigma, E2SStateData } from '@/types/events'

// E2S (execution-state stream) store — per-session snapshots of the execution
// state Σₜ delivered by the dedicated `e2s_state` session event. An E2S
// session has no plan DAG; this snapshot is what the Execution State panel
// renders in place of the plan view.

/** Per-session E2S snapshot — the latest Σ plus loop telemetry. */
export interface E2SSnapshot {
  /** Latest accumulated execution state (patches merged over snapshots). */
  state: E2SSigma
  /** Completed steps/turns so far. */
  turn: number
  /** Latest session-level status string (e.g. running, done, failed). */
  status: string
  /** Turn budget cap (mirrors max_turns; 0 = unlimited). */
  maxSteps: number
  /** True while the session runs in E2S mode — gates the Execution State
   *  panel replacing the plan view. Set on the first e2s_state event; cleared
   *  together with the snapshot on session switch/delete. */
  active: boolean
}

// --- State types ---

interface E2SState {
  /** sessionId -> latest E2S snapshot. */
  snapshots: Record<string, E2SSnapshot>
}

interface E2SActions {
  /** Apply an e2s_state event (full snapshot or patch) to a session's entry. */
  applySnapshot: (sessionId: string, data: E2SStateData) => void
  /** Clear a session's snapshot (switch away / session delete). */
  clearSession: (sessionId: string) => void
  /** Clear several sessions' snapshots at once (bulk session delete, e.g. a
   *  project deletion cascading over its sessions) in a single store update. */
  dropSessions: (sessionIds: string[]) => void
  /** Clear every session's snapshot. */
  clearAll: () => void
}

// --- Stable selectors ---
//
// Each selector returns a PRIMITIVE or a DIRECT store reference (an existing
// snapshot object or undefined) — never a freshly allocated array/object.
// This honors the React 19 useSyncExternalStore stability contract: a new
// object on every selector call causes an infinite re-render loop (#185).
// Returning `state.snapshots[sessionId]` is safe because it is a direct
// property access whose reference only changes when that entry is replaced.

export function useE2SSnapshot(sessionId: string | null): E2SSnapshot | undefined {
  return useE2SStore((s) => (sessionId ? s.snapshots[sessionId] : undefined))
}

export function useE2SActive(sessionId: string | null): boolean {
  return useE2SStore((s) => (sessionId ? s.snapshots[sessionId]?.active === true : false))
}

// --- Store ---

export const useE2SStore = create<E2SState & E2SActions>((set) => ({
  snapshots: {},

  applySnapshot: (sessionId, data) =>
    set((s) => {
      const prev = s.snapshots[sessionId]
      // A patch event carries only the changed slice — merge it over the
      // previously accumulated Σ. A full snapshot (or a patch with no
      // previous state) replaces the Σ outright. Arrival of any e2s_state
      // event marks the session E2S-active (gates the panel swap).
      const state = data.patch && prev ? mergeSigma(prev.state, data.state) : data.state
      return {
        snapshots: {
          ...s.snapshots,
          [sessionId]: {
            state,
            turn: data.turn,
            // The backend emitter sends {state, turn, max_turns, status}; the
            // fallbacks keep a partial payload renderable. A missing max_turns
            // on a patch retains the previous cap (it is telemetry, not part
            // of Σ, so it is not merged); on a full snapshot it means an
            // unbudgeted run → 0 = "turn N" without a cap.
            status: data.status ?? state.status ?? '',
            maxSteps: data.max_turns ?? (data.patch && prev ? prev.maxSteps : 0),
            active: true,
          },
        },
      }
    }),

  clearSession: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.snapshots)) return s
      const snapshots = { ...s.snapshots }
      delete snapshots[sessionId]
      return { snapshots }
    }),

  dropSessions: (sessionIds) =>
    set((s) => {
      // Collect the ids that actually have an entry first so an all-unknown
      // batch stays a no-op (returns the same state → no subscriber notify).
      const present = sessionIds.filter((id) => id in s.snapshots)
      if (present.length === 0) return s
      const snapshots = { ...s.snapshots }
      for (const id of present) delete snapshots[id]
      return { snapshots }
    }),

  clearAll: () => set({ snapshots: {} }),
}))

/** The eight fixed core Σ keys (core/e2s). A `null` tombstone may delete an
 *  extension key but never a core key. */
const CORE_SIGMA_KEYS = new Set<string>([
  'objective',
  'status',
  'files_touched',
  'findings',
  'decisions',
  'next_steps',
  'done_criteria',
  'checklist',
])

/**
 * Shallow-merge a patch slice over the previous Σ, honoring the domain patch
 * contract (core/e2s/merge.go): a key present in the patch replaces its
 * counterpart, a JSON `null` tombstone deletes it (core keys excepted — they
 * can never be deleted), and keys absent from the patch (including extension
 * keys) survive untouched.
 */
function mergeSigma(prev: E2SSigma, patch: E2SSigma): E2SSigma {
  const merged: Record<string, unknown> = { ...prev }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      if (!CORE_SIGMA_KEYS.has(key)) delete merged[key]
      continue
    }
    merged[key] = value
  }
  return merged as E2SSigma
}
