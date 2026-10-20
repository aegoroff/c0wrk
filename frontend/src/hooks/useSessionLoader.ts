// Session loader — loads sessions when active project changes.

import { useEffect } from 'react'
import { subscribe } from '@/api/runtime'
import { getProjectSwitchState } from '@/api/projects'
import { listSessions } from '@/api/sessions'
import { resolveRestoreSession } from '@/lib/sessionRestore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { isSessionInfo, isArrayOf, isSessionRenamed } from '@/types/guards'
import type { SessionInfo } from '@/types/models'

/** Trailing-debounce window for the `sessions:changed` re-read: a burst of
 *  list-affecting mutations (fork + pin, a project delete cascade) collapses
 *  into one ListSessions RPC after the last event. */
const SESSIONS_CHANGED_DEBOUNCE_MS = 250

export function useSessionLoader(): void {
  const activeProjectId = useProjectStore(s => s.activeProjectId)

  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    // The project's saved session id, fetched once per activation (below) and
    // shared by the initial load and the sessions:loaded push handler. It is
    // the primary restore candidate — persisted on every explicit selection
    // (selectSession → saveProjectActiveSession) and on switch-away, so it is
    // fresh; latest-by-activity is only the fallback for a missing or
    // archived entry (see lib/sessionRestore).
    let savedSessionId = ''
    // Released once the saved-session pointer has been fetched (successfully
    // or not). The sessions:loaded push handler awaits it before restoring:
    // a push that arrives while the initial fetch is still in flight must not
    // restore the latest-by-activity fallback in place of the saved session.
    let resolveSavedSessionIdReady!: () => void
    const savedSessionIdReady = new Promise<void>((resolve) => {
      resolveSavedSessionIdReady = resolve
    })

    // Monotonic token shared by the initial load and the sessions:changed
    // re-reads. A fetch captures the counter at issuance; a result whose token
    // is stale (a newer fetch was issued since) is dropped instead of
    // clobbering the fresher list — regardless of RPC resolution order.
    let fetchSeq = 0
    // True once THIS activation has applied a session list to the store
    // (initial load, sessions:loaded push, or a sessions:changed re-read).
    // The initial load's deferred restore (below) only trusts the store when
    // this is set, so it can never restore against a leftover list of another
    // project.
    let listApplied = false
    // Pending sessions:changed debounce timer (cleared on teardown).
    let changedTimer: ReturnType<typeof setTimeout> | null = null

    const cleanups: Array<() => void> = []
    const store = () => useSessionStore.getState()

    // Clear stale active session from previous project while destination sessions are loading.
    store().setActiveSessionId(null)

    // Restore only while nothing is active yet: an explicit selection or an
    // already-completed restore must never be overridden.
    const restoreIfIdle = (sessions: SessionInfo[]) => {
      if (store().activeSessionId) return
      const restored = resolveRestoreSession(sessions, savedSessionId)
      if (restored) {
        store().setActiveSessionId(restored.id)
      }
    }

    // Subscribe to sessions:loaded for push updates.
    // Guard against cross-project contamination: only accept sessions whose
    // project_id matches the currently active project.
    cleanups.push(
      subscribe('sessions:loaded', (data: unknown) => {
        if (cancelled) return
        if (!Array.isArray(data) || !isArrayOf(data, isSessionInfo)) return
        // Re-validate activeProjectId at handler time to avoid stale closures.
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return
        // Filter to sessions belonging to the active project.
        const owned = data.filter(s => s.project_id === currentProjectId)
        if (owned.length === 0) return
        // Wait for the saved-session pointer before touching the store: the
        // initial fetch may still be in flight, and restoring now would pick
        // the latest-by-activity fallback instead of the saved session (the
        // fallback then sticks — restoreIfIdle never overrides an active id).
        void savedSessionIdReady.then(() => {
          if (cancelled) return
          store().setSessions(owned)
          listApplied = true
          restoreIfIdle(owned)
        })
      }),
    )

    // Subscribe to sessions:changed — a list-affecting session mutation from
    // any surface (create/fork/delete/archive/pin, CHAT→project promotion,
    // project delete cascade, managed-worktree commit; backend
    // `emitSessionsChanged`). The event carries no payload, so the active
    // project's list is re-read via listSessions() after a short trailing
    // debounce.
    //
    // Deliberately narrower than the sessions:loaded handler above:
    //   - restoreIfIdle is NEVER called: a foreign mutation must not
    //     auto-select a session — the active session and the view stay
    //     untouched (this is a background refresh, not a restore trigger);
    //   - the project guard re-reads the store at event time AND at
    //     fetch-fire time, and the result is dropped when the active project
    //     changed while the RPC was in flight (the backend serves the ACTIVE
    //     project's list, so a mid-flight switch makes the answer foreign —
    //     the new activation's own fetch owns the store then);
    //   - fetchSeq supersedes: a slower older fetch (initial load included)
    //     can never overwrite a newer one.
    cleanups.push(
      subscribe('sessions:changed', () => {
        if (cancelled) return
        // Re-validate at handler time (mirrors the sessions:loaded guard):
        // without an active project there is nothing to refresh.
        if (!useProjectStore.getState().activeProjectId) return
        if (changedTimer !== null) clearTimeout(changedTimer)
        changedTimer = setTimeout(() => {
          changedTimer = null
          if (cancelled) return
          const projectId = useProjectStore.getState().activeProjectId
          if (!projectId) return
          const fetchId = ++fetchSeq
          listSessions()
            .then((sessions) => {
              if (cancelled || fetchId !== fetchSeq) return
              if (useProjectStore.getState().activeProjectId !== projectId) return
              store().setSessions(sessions)
              listApplied = true
            })
            .catch(() => {
              // Already logged by the api wrapper; the current list is kept —
              // the next event (or switch trigger) retries.
            })
        }, SESSIONS_CHANGED_DEBOUNCE_MS)
      }),
    )

    // Fetch sessions for the active project together with its saved-session
    // pointer (read once per activation). Both are best-effort: a failed
    // saved-state read just degrades the restore to the latest-by-activity
    // fallback, a failed session list leaves the store untouched.
    const initialFetchId = ++fetchSeq
    void Promise.all([
      getProjectSwitchState(activeProjectId).catch(() => null),
      listSessions().catch(() => null),
    ]).then(([saved, sessions]) => {
      // Capture the pointer and release the push gate in EVERY outcome —
      // including a failed session-list fetch — so later pushes still
      // restore against the saved pointer.
      savedSessionId = saved?.saved_session_id ?? ''
      resolveSavedSessionIdReady()
      if (cancelled || sessions === null) return
      if (initialFetchId !== fetchSeq) {
        // A sessions:changed re-read was issued while this initial read was
        // in flight: it carries the fresher, post-mutation list and owns the
        // store, so this stale result is dropped. The switch's restore
        // contract still holds, though — restore against the freshest list
        // this activation has applied (listApplied guarantees it belongs to
        // this project; restoreIfIdle itself is a no-op unless idle).
        if (listApplied) restoreIfIdle(store().sessions ?? [])
        return
      }
      store().setSessions(sessions)
      listApplied = true
      restoreIfIdle(sessions)
    })

    // Global session rename (manual or background auto-titling). Updates the
    // session title in the sidebar even when the renamed session is not the
    // active one — the session-scoped `session:{id}:session_renamed` event has
    // no listener for non-active sessions, so without this the title stays
    // stale ("Session <id>") until a project switch or app reload.
    // updateSession is a no-op when the session is not in the current list.
    cleanups.push(
      subscribe('session:renamed', (data: unknown) => {
        if (cancelled) return
        if (!isSessionRenamed(data)) return
        store().updateSession(data.id, { name: data.name })
      }),
    )

    return () => {
      cancelled = true
      if (changedTimer !== null) {
        clearTimeout(changedTimer)
        changedTimer = null
      }
      cleanups.forEach(fn => fn())
    }
  }, [activeProjectId])
}
