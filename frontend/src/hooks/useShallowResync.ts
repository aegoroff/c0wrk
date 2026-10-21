// Shallow UI resync after connectivity/signal gaps.
//
// Backend events are push-only: a websocket outage (web transport) or a focus
// window during which the webview's event tap missed nothing but state moved
// anyway can leave the UI behind the backend with no event left to repair it
// — the deltas stop, not the state. This hook is the SHALLOW recovery: on a
// WS re-connect (see onWSReconnected in api/runtime) and on window focus /
// tab-visibility return it re-reads the three pieces the chat UI is built
// from, through the exact loaders a session switch uses:
//
//   1. the active session's history (+ its runtime-status and pending-action
//      reconcile) — lib/sessionHistoryReload, the ChatArea loader; the merge
//      into chatStore dedupes by id, so an in-flight stream is neither
//      duplicated nor dropped;
//   2. the active project's session list — the useSessionLoader fetch path
//      (listSessions → sessionStore.setSessions);
//   3. the live-sessions snapshot + the cross-session GetPendingActions sweep
//      — activeSessionsStore.refreshNow() then sweepPendingActions().
//
// Trigger discipline mirrors useGitFocusRefresh (mounted ONCE at the App root,
// armed through the shared armWhenRuntimeReady gate: the desktop attaches at
// mount, a web-transport tab attaches once transport detection resolves 'web',
// 'none' never arms — `backend:ready` cannot be the signal because it is a
// desktop one-shot that a late-joining browser tab never sees), plus two
// frontend-local gates: a debounce collapses a trigger burst (a re-connect
// usually arrives together with a focus/visibility pair) into one run, and a
// min-interval keeps rapid-fire focus flicker from hammering the RPCs. Both
// gates are a courtesy, not correctness: every loader is idempotent, and the
// backstop paths (activeSessionsStore's 30s poll, the next focus) still catch
// up.

import { useEffect } from 'react'
import { onWSReconnected } from '@/api/runtime'
import { listSessions } from '@/api/sessions'
import { reloadSessionHistory } from '@/lib/sessionHistoryReload'
import { armWhenRuntimeReady } from '@/lib/armWhenRuntimeReady'
import { logger } from '@/lib/logger'
import { useActiveSessionsStore, sweepPendingActions } from '@/stores/activeSessionsStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'

/** Triggers arriving within this window of each other coalesce into one run
 *  (the last-scheduled one fires). */
const RESYNC_DEBOUNCE_MS = 400

/** Minimum spacing between two ACTUAL runs. A trigger landing inside the
 *  window is dropped entirely — the state it would refresh is at most
 *  min-interval stale, and the next trigger (or the snapshot safety poll)
 *  catches it. */
const RESYNC_MIN_INTERVAL_MS = 5_000

/** One shallow resync pass. Never throws: each leg is independently
 *  best-effort, so one failed RPC cannot skip the others. */
function runShallowResync(): void {
  const sessionId = useSessionStore.getState().activeSessionId
  const projectId = useProjectStore.getState().activeProjectId

  // Active session history + its runtime-status / pending-action reconcile.
  // The live cancellation probe discards the result when the user switches
  // sessions mid-flight (the new session's own load takes over).
  if (sessionId) {
    void reloadSessionHistory(sessionId, {
      isCancelled: () => useSessionStore.getState().activeSessionId !== sessionId,
    }).catch((err) => {
      logger.warn('[resync] session history reload failed:', err)
    })
  }

  // Active project's session list. The project re-check keeps a switch race
  // from writing the OLD project's list over the new one (useSessionLoader
  // guards its push handler the same way).
  if (projectId) {
    void listSessions()
      .then((sessions) => {
        if (useProjectStore.getState().activeProjectId !== projectId) return
        useSessionStore.getState().setSessions(sessions)
      })
      .catch((err) => {
        logger.warn('[resync] session list refresh failed:', err)
      })
  }

  // Live-sessions snapshot + the cross-session pending-HITL sweep. The sweep
  // reads the CURRENT snapshot directly, so it must follow the refresh; both
  // are best-effort and never reject (quiet logs inside the store).
  void useActiveSessionsStore.getState().refreshNow().then(() => sweepPendingActions())
}

/**
 * Wire the resync triggers. Mount ONCE at the App root (App.tsx), next to
 * useBackgroundSessionWatcher — the triggers are app-global, and a panel- or
 * phase-scoped mount would leave the chat state stale exactly when its host
 * is unmounted.
 */
export function useShallowResync(): void {
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let lastRunStartedAt = 0

    // A bypass trigger (WS re-connect) skips the min-interval gate: the
    // transport keeps no replay, so a reconnect dropped inside the window
    // leaves the missed events unrecoverable — stale until the next trigger.
    const schedule = (bypassMinInterval = false): void => {
      // Debounce: a run is already scheduled — this burst coalesces into it.
      if (debounceTimer !== null) return
      // Min-interval: an actual run just happened; drop this trigger (unless
      // a reconnect is asking).
      if (!bypassMinInterval && Date.now() - lastRunStartedAt < RESYNC_MIN_INTERVAL_MS) return
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        lastRunStartedAt = Date.now()
        runShallowResync()
      }, RESYNC_DEBOUNCE_MS)
    }

    const onFocus = (): void => schedule()
    // A dedicated wrapper: notifyWSReconnected invokes its listeners bare, and
    // the reconnect trigger must always ask for the bypass.
    const onWSReconnect = (): void => schedule(true)
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') schedule()
    }

    // Arm the focus/visibility listeners through the shared readiness gate
    // (useGitFocusRefresh pattern): before a serving transport exists the
    // resync RPCs are guaranteed no-ops, so focus events during the splash
    // phase would be dead weight. The WS re-connect trigger needs no arming —
    // it only fires once the socket exists, which already implies readiness.
    const offArmed = armWhenRuntimeReady(() => {
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisibilityChange)
      return () => {
        window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    })
    const offWSReconnected = onWSReconnected(onWSReconnect)

    return () => {
      offWSReconnected()
      offArmed()
      if (debounceTimer !== null) clearTimeout(debounceTimer)
    }
  }, [])
}
