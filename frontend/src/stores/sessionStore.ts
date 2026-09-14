import { create } from 'zustand'
import type { SessionInfo } from '@/types/models'
import { saveProjectActiveSession } from '@/api/projects'
import { logger } from '@/lib/logger'

// --- Helpers ---

function sortByActivity(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    // Pinned sessions always surface to the top, mirroring the backend's
    // `ORDER BY pinned DESC, COALESCE(last_active_at, created_at) DESC`.
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const aTime = new Date(a.last_active_at || a.created_at).getTime()
    const bTime = new Date(b.last_active_at || b.created_at).getTime()
    return bTime - aTime
  })
}

/**
 * SessionInfo fields that must NOT, by themselves, force a `setSessions`
 * update. `active` is the live in-memory task flag the backend overlays on the
 * list (Manager.ListSessionsByProject / ListSessionsAll); every consumer reads
 * live task state from `chatStore` instead (see `useSessionStatusIndicator` /
 * `isSessionBusy`), so an active-only change is not worth a store write and the
 * re-render it would trigger.
 */
const IGNORED_SESSION_FIELDS: ReadonlySet<string> = new Set(['active'])

/**
 * Shallow content equality for two sessions, ignoring `IGNORED_SESSION_FIELDS`.
 * Every SessionInfo field is a primitive, so a shallow compare is exact. Used
 * by `setSessions` to tell a genuinely refreshed list from a duplicate
 * delivery of the same list.
 */
function sameSessionContent(a: SessionInfo, b: SessionInfo): boolean {
  if (a === b) return true
  const aRecord = a as unknown as Record<string, unknown>
  const bRecord = b as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(aRecord), ...Object.keys(bRecord)])
  for (const key of keys) {
    if (IGNORED_SESSION_FIELDS.has(key)) continue
    if (aRecord[key] !== bRecord[key]) return false
  }
  return true
}

// --- State types ---

export interface SessionState {
  sessions: SessionInfo[] | null // null = not yet loaded
  activeSessionId: string | null
}

interface SessionActions {
  setSessions: (sessions: SessionInfo[]) => void
  setActiveSessionId: (id: string | null) => void
  selectSession: (id: string | null, projectId?: string) => void
  addSession: (session: SessionInfo) => void
  removeSession: (id: string) => void
  updateSession: (id: string, updates: Partial<SessionInfo>) => void
  touchSession: (id: string) => void
  resetForProjectSwitch: () => void
}

// --- Store ---

export const useSessionStore = create<SessionState & SessionActions>((set, get) => ({
  sessions: null,
  activeSessionId: null,

  setSessions: (sessions) => set((s) => {
    const sorted = sortByActivity(sessions)
    // Skip only when the incoming list is genuinely unchanged (avoids
    // duplicate event/RPC deliveries and the needless re-render each would
    // trigger). The check must compare CONTENT, not just the id list: a reload
    // that returns the same sessions can still carry refreshed fields —
    // `unfinished_task_status` / `has_unfinished_task` in particular — and the
    // former id-only guard silently dropped them, leaving the sidebar's status
    // dot stale until an app restart. `active` is excluded (see
    // IGNORED_SESSION_FIELDS): no consumer reads it, so it must not force an
    // update on its own.
    const current = s.sessions
    const unchanged = current !== null &&
      current.length === sorted.length &&
      current.every((sess, i) => {
        const next = sorted[i]
        return next !== undefined && sameSessionContent(sess, next)
      })
    if (unchanged) return s
    return { sessions: sorted }
  }),

  setActiveSessionId: (id) => set((s) =>
    s.activeSessionId === id ? s : { activeSessionId: id }
  ),

  // User-initiated session selection: updates the in-memory active session AND
  // persists the choice as the project's saved_session_id right away, so the
  // persisted value is authoritative by the time a project switch or app exit
  // snapshots UI state. Restore paths (performSwitch, useSessionLoader) must
  // keep calling setActiveSessionId — they apply an already-persisted value
  // and must not echo it back during the switch.
  //
  // The caller passes the id of the project that OWNS the session (taken from
  // the SessionInfo), never the global activeProjectId: during an in-flight
  // project switch the global already points at the destination while the
  // visible list still shows the source project's sessions, so reading it
  // here could persist a source session id under the destination project.
  selectSession: (id, projectId) => {
    get().setActiveSessionId(id)
    if (!id) return
    if (!projectId) {
      logger.warn(`sessionStore.selectSession: owning project id missing for session ${id}; selection not persisted`)
      return
    }
    // Fire-and-forget: a failed persist must not break selection — the
    // in-memory activeSessionId is already updated, and the next successful
    // selection (or the switch-time save) repairs the persisted value.
    void saveProjectActiveSession(projectId, id).catch((err: unknown) => {
      logger.warn('sessionStore.selectSession: failed to persist active session', err)
    })
  },

  addSession: (session) => set((s) => ({
    sessions: sortByActivity([session, ...(s.sessions ?? [])]),
  })),

  removeSession: (id) => set((s) => ({
    sessions: (s.sessions ?? []).filter(sess => sess.id !== id),
    activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
  })),

  updateSession: (id, updates) => set((s) => ({
    sessions: sortByActivity(
      (s.sessions ?? []).map(sess => sess.id === id ? { ...sess, ...updates } : sess)
    ),
  })),

  // NOTE: there is deliberately no `setUnfinishedTask` mirror here. The live
  // unfinished-task state lives in chatStore.unfinishedTaskStatus — the SINGLE
  // live overlay every session-status surface reads (sidebar list, radar badge,
  // radar dropdown) — and the `sessions` snapshot's `unfinished_task_status` /
  // `has_unfinished_task` fields are DB-side fallbacks only. A per-store mirror
  // here was the second live-update path that drifted from the dots.
  touchSession: (id) => set((s) => {
    const now = new Date().toISOString()
    return {
      sessions: sortByActivity(
        (s.sessions ?? []).map(sess =>
          sess.id === id ? { ...sess, last_active_at: now } : sess
        )
      ),
    }
  }),

  resetForProjectSwitch: () => set((s) => {
    if (s.sessions === null && s.activeSessionId === null) return s
    return {
      sessions: null,
      activeSessionId: null,
    }
  }),
}))

// --- Selectors (pure functions; usable both in render via
// useSessionStore(selector) and in event handlers via selector(getState())) ---

/**
 * Name of the active session, or null when sessions are not loaded yet, no
 * session is selected, or the selected id is not in the current list (the
 * transient state during a project switch, where `resetForProjectSwitch`
 * clears both fields before the destination list arrives).
 *
 * Returns a PRIMITIVE rather than the SessionInfo object so that consumers
 * driven by an effect (the native window title) re-run only on a real name
 * change: `touchSession` rebuilds the entry on every activity bump without
 * touching the name.
 */
export function selectActiveSessionName(state: SessionState): string | null {
  if (state.sessions === null || state.activeSessionId === null) return null
  const active = state.sessions.find((sess) => sess.id === state.activeSessionId)
  if (!active) return null
  const name = active.name.trim()
  return name === '' ? null : name
}
