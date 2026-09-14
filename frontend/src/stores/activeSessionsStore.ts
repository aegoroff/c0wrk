// Global cross-project session snapshot for the sessions badge / switcher.
//
// Owns the DB-side state only:
//   - `sessions` — the listAllSessions() snapshot (null = never loaded),
//   - `pendingOverride` — authoritative "session X has pending HITL" bits
//     from GetPendingActions (for sessions whose messages chatStore never
//     loaded, the live HITL scan cannot see their blocked prompt).
//
// The LIVE side (taskActive / paused / HITL) is deliberately NOT stored here:
// chatStore is the single source of truth for live execution state (same
// rationale as useSessionStatusIndicator — no dual bookkeeping). Derive it at
// render time with the pure helpers in lib/activeSessions.
//
// Selector stability (React #185): every state field is either a primitive or
// a reference that only changes on real updates (`sessions` is replaced only
// after a successful RPC, `pendingOverride` only when a bit flips). Select
// fields directly — `useActiveSessionsStore(s => s.sessions)` — and do any
// aggregation in useMemo via lib/activeSessions, never inside a selector.

import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { listAllSessions } from '@/api/sessions'
import { getPendingActions, type PendingActionsResponse } from '@/api/chat'
import { logger } from '@/lib/logger'
import {
  deriveLiveSessionFlags,
  hasPendingActions,
  liveSessionsSignature,
  mergePendingOverride,
  sortedLiveRows,
} from '@/lib/activeSessions'
import type { SessionInfo } from '@/types/models'
import { useChatStore } from '@/stores/chatStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'

/** Debounce window for refresh() coalescing (mount + dropdown + live-key
 *  transitions all funnel through here; one RPC per burst is plenty for a
 *  badge that tolerates ~seconds of staleness). */
const REFRESH_DEBOUNCE_MS = 500

interface ActiveSessionsState {
  /** Global cross-project session list, or null before the first successful
   *  load. Kept (never wiped) on refresh errors — a stale snapshot beats no
   *  snapshot for the badge. */
  sessions: SessionInfo[] | null
  /** sessionId → has pending HITL, from GetPendingActions responses. Only
   *  true bits are stored; false deletes the key. */
  pendingOverride: Readonly<Record<string, boolean>>
  /** True while a refresh RPC is in flight (e.g. for a dropdown spinner). */
  refreshing: boolean
  /** Debounced (~500 ms) refresh. Multiple calls inside the window collapse
   *  into one trailing RPC. Fire-and-forget; never throws. */
  refresh: () => void
  /** Immediate, awaited refresh (dropdown open, post-action freshness).
   *  Never rejects — an RPC failure is quietly logged and the previous
   *  snapshot is preserved. Concurrent calls share one in-flight promise. */
  refreshNow: () => Promise<void>
  /** Set / clear one session's authoritative pending-HITL bit. `false`
   *  deletes the key (a "no pending" answer never overrides a live-derived
   *  HITL signal — the merge in lib/activeSessions is OR-only). */
  setPendingOverride: (sessionId: string, pending: boolean) => void
  /** Convenience: apply a raw GetPendingActions response (or null on RPC
   *  failure) as the pending override for one session. */
  applyPendingActions: (sessionId: string, response: PendingActionsResponse | null) => void
  /** Drop one session's DB-derived unfinished-task status from the snapshot in
   *  place, so the live-sessions radar stops surfacing it without waiting for
   *  the debounced refresh. Used after a user action settles the session's
   *  unfinished task on the backend (the resume prompt's Cancel) — that path
   *  emits no terminal event AND leaves no live taskActive/paused flag, so the
   *  store's live-set refresh trigger never fires and the session would keep
   *  showing (red "failed") until the 30s safety poll. No-op (same `sessions`
   *  reference) when the snapshot is unloaded, the session is unknown, or it
   *  carries no unfinished task. The next snapshot refresh re-reads the
   *  authoritative value. */
  clearUnfinishedTask: (sessionId: string) => void
}

// Module-scoped debounce/in-flight bookkeeping (not reactive state).
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let inflight: Promise<void> | null = null

/** Shared fetch path for refresh()/refreshNow(). Deduplicates concurrent
 *  calls into a single RPC so a slow response cannot be clobbered by — or
 *  clobber — an older in-flight one. Always resolves. */
function fetchSnapshot(): Promise<void> {
  if (inflight) return inflight
  useActiveSessionsStore.setState({ refreshing: true })
  inflight = (async () => {
    try {
      const sessions = await listAllSessions()
      useActiveSessionsStore.setState({ sessions, refreshing: false })
    } catch (err) {
      // Quiet log (the api wrapper already reported the error at error
      // level); badge freshness is best-effort — keep the previous snapshot.
      logger.debug('activeSessionsStore: refresh failed, keeping previous snapshot:', err)
      useActiveSessionsStore.setState({ refreshing: false })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export const useActiveSessionsStore = create<ActiveSessionsState>((set, get) => ({
  sessions: null,
  pendingOverride: {},
  refreshing: false,

  refresh: () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void fetchSnapshot()
    }, REFRESH_DEBOUNCE_MS)
  },

  refreshNow: () => fetchSnapshot(),

  setPendingOverride: (sessionId, pending) => {
    const current = get().pendingOverride
    if (pending) {
      if (current[sessionId] === true) return
      set({ pendingOverride: { ...current, [sessionId]: true } })
      return
    }
    if (!(sessionId in current)) return
    const next: Record<string, boolean> = { ...current }
    delete next[sessionId]
    set({ pendingOverride: next })
  },

  applyPendingActions: (sessionId, response) => {
    get().setPendingOverride(sessionId, hasPendingActions(response))
  },

  clearUnfinishedTask: (sessionId) => {
    set((s) => {
      if (!s.sessions) return s
      const idx = s.sessions.findIndex((sess) => sess.id === sessionId)
      if (idx === -1) return s
      const current = s.sessions[idx]!
      if (current.unfinished_task_status === '' && !current.has_unfinished_task) return s
      const sessions = [...s.sessions]
      sessions[idx] = { ...current, has_unfinished_task: false, unfinished_task_status: '' }
      return { sessions }
    })
  },
}))

/** Cancel a scheduled (debounced) refresh. Public for tests and for teardown
 *  paths that must stop pending timer callbacks. An in-flight RPC is left to
 *  finish on its own (its result is still valid). */
export function cancelPendingRefresh(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/**
 * Ask GetPendingActions for every live session whose pending-HITL state is
 * not already known locally (neither chatStore's messages nor the override
 * report it — status !== 'pending' covers both) and apply each answer as the
 * pending override. This is the restart path: chatStore starts empty, the DB
 * still says in_progress, and only the backend knows the task is actually
 * blocked on a prompt — the answer upgrades the row (and the badge dot) from
 * green to yellow. Best effort: a failed call yields null, which clears
 * nothing.
 *
 * Reads the CURRENT snapshot (and chatStore state) directly — it does not
 * fetch; the caller is responsible for loading/freshness (the mount path
 * waits for the snapshot, the dropdown-open path refreshes it first). Shared
 * by useActiveSessionsRefresh (mount) and ActiveSessionsIndicator (open).
 */
export async function sweepPendingActions(): Promise<void> {
  const store = useActiveSessionsStore.getState()
  const chat = useChatStore.getState()
  const live = mergePendingOverride(
    deriveLiveSessionFlags({
      taskActive: chat.taskActive,
      paused: chat.paused,
      messageOrder: chat.messageOrder,
      messages: chat.messages,
      unfinishedTaskStatus: chat.unfinishedTaskStatus,
    }),
    store.pendingOverride,
  )
  const targets = sortedLiveRows(store.sessions, live).filter((row) => row.status !== 'pending')
  await Promise.all(
    targets.map(async (row) => {
      store.applyPendingActions(row.session.id, await getPendingActions(row.session.id))
    }),
  )
}

/**
 * Safety-poll cadence for the cross-project snapshot while the window is
 * visible. The event-driven triggers below (mount, live-set changes, every
 * project/session switch) cover the normal flows; this poll is the backstop
 * that bounds the worst case after a signal path fails — e.g. the switch-time
 * refresh RPC errored (a stale snapshot beats none, so the old value is kept)
 * or ListAllSessions answered before the session manager was ready. One local
 * SQLite list RPC per 30s is negligible; hidden windows poll nothing.
 */
const SNAPSHOT_POLL_INTERVAL_MS = 30_000

/**
 * Wire the store's refresh triggers: refresh once on mount, then again
 * whenever the SET of live sessions (taskActive or paused, per chatStore)
 * changes — i.e. on task transitions (start / complete / error / cancel /
 * pause / resume / resumable failure), when the DB snapshot has just become
 * stale. Streaming chunks and message appends do not change the set and do
 * not trigger anything.
 *
 * Switch-time refresh: EVERY project/session switch (the CHAT↔CODE toggle
 * included) also triggers a refresh. The live-set trigger is derived from the
 * same chatStore flags the switch dance can corrupt (a cancelled
 * task-flag restore leaves a running session flagged idle), so it alone
 * cannot be trusted to re-arm: after such a dance the live set goes empty and
 * stays empty, and no refresh would ever fire again. The switch trigger makes
 * the watched-set recovery independent of the live flags — listAllSessions
 * re-reads the authoritative unfinished_task_status straight from the DB.
 *
 * Safety poll: while the window is visible, refresh every
 * SNAPSHOT_POLL_INTERVAL_MS as a backstop against refresh-RPC failures and
 * stale-answer races (see the constant's doc). It rides the same 500ms
 * debounce funnel, so a poll colliding with an event-driven refresh coalesces
 * into a single RPC.
 *
 * Mount this ONCE at the App root (App.tsx), not in the sidebar header: the
 * header unmounts when the sidebar is collapsed, which would stop the
 * snapshot from refreshing app-wide. Opening the dropdown additionally calls
 * refreshNow() + sweepPendingActions() for immediate freshness plus the
 * pending-HITL sweep.
 */
export function useActiveSessionsRefresh(): void {
  // Primitive string → referentially stable under Object.is (React #185 safe).
  const liveKeys = useChatStore((s) => liveSessionsSignature(s.taskActive, s.paused))
  const refresh = useActiveSessionsStore((s) => s.refresh)
  // Direct store-field reference (stable) → safe as an effect dependency.
  const sessions = useActiveSessionsStore((s) => s.sessions)
  // Primitives; every switch (project OR session) re-triggers the refresh.
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const swept = useRef(false)
  useEffect(() => {
    void refresh()
  }, [liveKeys, refresh, activeSessionId, activeProjectId])
  // Visible-window safety poll (backstop — see the hook doc). The interval
  // itself always runs while mounted; a tick only refreshes when the document
  // is visible so a hidden/minimized window performs no work.
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
      useActiveSessionsStore.getState().refresh()
    }, SNAPSHOT_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])
  // One-time pending-HITL sweep once the snapshot first loads (the restart
  // path): a task blocked on a prompt is yellow at first render instead of
  // waiting for the dropdown to open. Reads the current snapshot directly —
  // the debounced refresh above owns the load, so no extra RPC here.
  useEffect(() => {
    if (swept.current || sessions === null) return
    swept.current = true
    void sweepPendingActions()
  }, [sessions])
}
