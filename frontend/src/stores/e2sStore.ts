import { create } from 'zustand'
import type { E2SSigma, E2SStateData } from '@/types/events'

// E2S (execution-state stream) store — per-session snapshots of the execution
// state Σₜ delivered by the dedicated `e2s_state` session event. An E2S
// session has no plan DAG; this snapshot is what the Execution State panel
// renders in place of the plan view.

/** Per-session E2S snapshot — the latest Σ plus loop telemetry. */
export interface E2SSnapshot {
  /** Latest full execution-state snapshot Σ (the backend owns the merge). */
  state: E2SSigma
  /** Completed steps/turns so far within the CURRENT run (a resumed run
   *  restarts at 1 against its fresh budget; mirrors the event's `turn`). */
  turn: number
  /** Cumulative applied patches across ALL runs of the task (resumes continue
   *  the count; mirrors the event's optional `total_turns`, falling back to
   *  the run-local `turn` for older emitters that omit it). */
  totalTurns: number
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
  /** Apply an e2s_state event (full Σ snapshot) to a session's entry. */
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
      // The backend owns the merge and always emits the FULL Σ snapshot
      // (core/e2s emitState); the store keeps only the latest. Arrival of
      // any e2s_state event marks the session E2S-active (gates the panel
      // swap).
      const state = data.state
      return {
        snapshots: {
          ...s.snapshots,
          [sessionId]: {
            state,
            turn: data.turn,
            // Telemetry, not part of Σ, is taken from the event rather than
            // retained: total_turns falls back to the run-local turn for older
            // emitters that omit it, and a missing max_turns means an
            // unbudgeted run → 0 renders "turn N" with no cap.
            status: data.status ?? state.status ?? '',
            totalTurns: data.total_turns ?? data.turn,
            maxSteps: data.max_turns ?? 0,
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
