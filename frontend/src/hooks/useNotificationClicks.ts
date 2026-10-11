import { useEffect, useMemo } from 'react'
import { onNotificationClicked } from '@/api/notifications'
import { useActiveSessionsStore } from '@/stores/activeSessionsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { useProjectSwitchState } from '@/hooks/useProjectSwitchState'
import { useTabStore, type Tab } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import { createTabEngine } from '@/lib/tabEngine'
import { logger } from '@/lib/logger'
import type { SessionInfo } from '@/types/models'

/**
 * Flag-ON routing: prefer a tab that already shows the clicked session —
 * an exact {project, session} match first, then any tab showing the session
 * (its recorded project may trail a retarget). Session ids are globally
 * unique, so a session-only hit is still THE tab for that session.
 */
function findSessionTab(tabs: Tab[], projectId: string, sessionId: string): Tab | undefined {
  return (
    tabs.find((t) => t.sessionId === sessionId && t.projectId === projectId) ??
    tabs.find((t) => t.sessionId === sessionId)
  )
}

/**
 * System-notification click navigation, mounted ONCE at the app root
 * (App.tsx) — the counterpart to the Go click callback
 * (desktop/notifications.go): the backend focuses the window and emits
 * `notification_clicked`; this hook only navigates.
 *
 * Navigation follows the live-sessions radar's exact pattern
 * (ActiveSessionsIndicator.handleSelect): switch project first when the
 * session lives in another one (switchProjectWithState restores that
 * project's UI state), then select the session — with the tab layer
 * disabled (`uiStore.tabsEnabled`, the default).
 *
 * With tabs enabled, this is the ONLY behavioral branch in the hook: the
 * click routes through the tab engine's single activation path instead of
 * the direct switch/select pair. A tab already showing the session is
 * activated; otherwise a fresh tab is created through the engine's shared
 * [create → activate] chain link (the same `createAndActivate` primitive the
 * tab bar's «+» button uses) seeded with the clicked {projectId, sessionId}
 * and a live UI capture taken when the link runs — its activation then
 * restores what the workspace already shows, leaving the input panel
 * untouched — and the engine materializes it (project switch and session
 * restore happen inside the activation). The hook owns a
 * bare engine — write-back mirroring stays the tab-controller's job, so a
 * flag-off click never touches the tab store.
 *
 * An unattributed banner (empty session id — e.g. the Settings preview) or
 * an unknown session id (not in the global session snapshot, even after one
 * immediate refreshNow) is a logged no-op in BOTH modes: the window was
 * already focused by the Go callback, which is all the user asked of that
 * click.
 */
export function useNotificationClicks(): void {
  // Stable across renders (useCallback with [] deps inside), so the effect
  // subscribes exactly once.
  const switchProjectWithState = useProjectSwitchState()
  // Bare engine (no write-back attach): the notification hook only needs the
  // activation path, and `switchProjectWithState` is stable, so the engine —
  // and its serialization chain — lives for the whole app lifetime.
  const engine = useMemo(() => createTabEngine(switchProjectWithState), [switchProjectWithState])

  useEffect(() => {
    return onNotificationClicked((data) => {
      void (async () => {
        if (!data.session_id) {
          logger.debug('[notifications] click without session routing; focus only')
          return
        }

        // Resolve the owning project id: the payload's own value first (our
        // banners always carry it), then the global session snapshot (covers
        // a sender that omits it). The snapshot may be null or stale; one
        // immediate refreshNow covers both before declaring the session
        // unknown. refreshNow never rejects.
        let projectId = data.project_id
        const findSession = (sessions: SessionInfo[] | null): SessionInfo | undefined =>
          sessions?.find((s) => s.id === data.session_id)

        let hit = findSession(useActiveSessionsStore.getState().sessions)
        if (!hit) {
          await useActiveSessionsStore.getState().refreshNow()
          hit = findSession(useActiveSessionsStore.getState().sessions)
        }
        if (hit) {
          projectId = projectId || hit.project_id
        }

        if (!hit || !projectId) {
          logger.info(
            `[notifications] click on unknown session "${data.session_id}"; not navigating`,
          )
          return
        }

        // Click-time flag read: toggling tabs on/off applies to the next
        // click without remounting the hook.
        if (useUIStore.getState().tabsEnabled) {
          const tabLayer = useTabStore.getState()
          const existing = findSessionTab(tabLayer.tabs, projectId, data.session_id)
          if (existing !== undefined) {
            await engine.activate(existing.id)
            return
          }
          // No tab shows the session: create one through the engine's shared
          // [create → activate] chain link — the SAME primitive the tab bar's
          // «+» button uses, so an in-flight activation can never be overtaken
          // by a half-created tab. The clicked {projectId, sessionId} are the
          // fixed seed; the engine captures the live UI slices when the link
          // runs, so the activation's restore re-applies what the workspace
          // already shows and the input panel is left untouched (the bare
          // default snapshot would not do: its input fields are all present
          // and valid, so the restore would apply them as-is and reset the
          // panel). The created tab survives a failed activation — the
          // rollback only reverts the active pointer (see specs tabs.md,
          // Banner-click routing), and a re-click finds it via the exact
          // match above.
          await engine.createAndActivate({ projectId, sessionId: data.session_id })
          return
        }

        try {
          if (projectId !== useProjectStore.getState().activeProjectId) {
            await switchProjectWithState(projectId)
          }
          useSessionStore.getState().selectSession(data.session_id, projectId)
        } catch {
          // A failed project switch surfaces its own toast globally; nothing
          // else to do — the window focus from the Go callback already
          // happened.
        }
      })()
    })
  }, [switchProjectWithState, engine])
}
