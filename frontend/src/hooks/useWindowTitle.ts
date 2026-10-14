// Native window title — keeps the OS title bar in sync with the active tab's
// project and session, the way an IDE does:
//
//   c0wrk                              no project active (startup)
//   c0wrk - MyProject                  project active, no session selected
//   c0wrk - MyProject: Refactor auth   full context
//   c0wrk - CHAT: Quick question       No Project pseudo-project (CHAT mode)
//
// Template: APP_NAME - <project scope>: <session>.
//
// The visible context is ALWAYS the ACTIVE TAB's (projectId, sessionId),
// resolved live against the project/session stores on every read: a tab
// stores ids, never names, so project/session renames and deletions are
// picked up without the tab ever holding a stale copy. When the tab layer
// runs its flag-off "exactly one tab" special case, that single tab mirrors
// the live project/session context, so the output is byte-identical to the
// pre-tab implementation — there is deliberately no tabsEnabled branch here.
//
// Driven entirely from the stores rather than from backend events: the
// project/session lifecycle events already land there (project:switched,
// project:renamed, session:renamed and the optimistic local rename in
// ProjectSelector), so a single derived effect covers startup, switching,
// renaming and deletion without any state of its own.

import { useEffect } from 'react'
import { setWindowTitle } from '@/api/runtime'
import type { ProjectState } from '@/stores/projectStore'
import { CHAT_LABEL, useProjectStore } from '@/stores/projectStore'
import type { SessionState } from '@/stores/sessionStore'
import { useSessionStore } from '@/stores/sessionStore'
import { selectActiveTab, useTabStore } from '@/stores/tabStore'

/** Product name — always the first segment. */
export const APP_NAME = 'c0wrk'

/** Re-exported so callers (and tests) can reason about the CHAT segment
 *  without reaching into the project store. */
export { CHAT_LABEL }

/** Separator between the app name and the project scope. */
const SCOPE_SEPARATOR = ' - '

/** Separator between the project scope and the active session name. */
const SESSION_SEPARATOR = ': '

/**
 * Build the window title from the scope segment (project name, or CHAT) and
 * the active session name, following the template:
 *
 *   APP_NAME - <project scope>: <session>
 *
 * Segments that are absent — or blank after trimming — are dropped rather
 * than rendered as empty text, so a session without a project can never
 * produce a dangling separator and a project without a session never leaves
 * a trailing colon.
 */
export function buildWindowTitle(scope: string | null, sessionName: string | null): string {
  const trimmedScope = scope?.trim()
  if (!trimmedScope) return APP_NAME

  const base = `${APP_NAME}${SCOPE_SEPARATOR}${trimmedScope}`
  const trimmedSession = sessionName?.trim()
  return trimmedSession ? `${base}${SESSION_SEPARATOR}${trimmedSession}` : base
}

/**
 * Scope segment for an EXPLICIT project id — the id-keyed counterpart of
 * projectStore's selectTitleScope (which reads the store's own
 * activeProjectId).
 *
 * Returns the literal {@link CHAT_LABEL} for the No Project pseudo-project
 * rather than its stored name ("No Project"), and null while projects are
 * still loading, for a null id, or when the id is not in the current list —
 * e.g. a tab whose project was just deleted, during the window before the
 * engine's switch-away lands. A missing project degrades to the bare app
 * name, never to a dangling segment.
 *
 * Returns a PRIMITIVE, not the ProjectInfo object: the title effect must
 * re-run only when the visible text changes (activity bumps rebuild store
 * entries without touching a name).
 */
export function selectTitleScopeFor(state: ProjectState, projectId: string | null): string | null {
  if (projectId === null || state.projects === null) return null
  const project = state.projects.find((p) => p.id === projectId)
  if (!project) return null
  if (project.is_no_project) return CHAT_LABEL
  const name = project.name.trim()
  return name === '' ? null : name
}

/**
 * Session name for an EXPLICIT session id — the id-keyed counterpart of
 * sessionStore's selectActiveSessionName. Returns null while sessions are not
 * loaded, for a null id, or when the id is not in the current list (e.g. the
 * session was deleted while the tab still holds its id); a blank name counts
 * as absent. Primitive result, same reasoning as selectTitleScopeFor.
 */
export function selectSessionNameFor(state: SessionState, sessionId: string | null): string | null {
  if (sessionId === null || state.sessions === null) return null
  const session = state.sessions.find((sess) => sess.id === sessionId)
  if (!session) return null
  const name = session.name.trim()
  return name === '' ? null : name
}

/**
 * Push the active tab's project/session context into the native window title.
 *
 * Every selector returns a primitive, so the component re-renders — and the
 * effect re-runs — only when the visible text can actually change: a
 * ui-snapshot-only tab replacement (updateActiveContext carrying a new
 * captured panel state) never reaches the runtime, and activity bumps that
 * rebuild store entries without touching a name don't either. The effect
 * only calls into the runtime, never back into a store, so it cannot cycle.
 */
export function useWindowTitle(): void {
  // The ACTIVE TAB owns the visible context — its ids, nothing else.
  const projectId = useTabStore((s) => selectActiveTab(s)?.projectId ?? null)
  const sessionId = useTabStore((s) => selectActiveTab(s)?.sessionId ?? null)
  // Live lookup by those ids: the names are whatever the stores hold right
  // now, so renames and deletions flow through without the tab knowing.
  const scope = useProjectStore((s) => selectTitleScopeFor(s, projectId))
  const sessionName = useSessionStore((s) => selectSessionNameFor(s, sessionId))

  useEffect(() => {
    setWindowTitle(buildWindowTitle(scope, sessionName))
  }, [scope, sessionName])
}
