/**
 * Workspace tab-bar label — the window-title template minus the app name,
 * fed by the same live scope/session selectors (selectTitleScopeFor returns
 * the CHAT literal for the No Project pseudo-project; selectSessionNameFor
 * resolves the session by id):
 *
 *   MyProject: Refactor auth   project + session
 *   MyProject                  project, no session (yet)
 *   CHAT: Quick question       No Project pseudo-project
 *   New Tab                    a tab whose context has not landed yet
 *
 * Absent/blank segments are dropped rather than rendered as empty text, so a
 * dangling separator can never appear. Pure string algebra — no store access.
 */
export function buildTabLabel(scope: string | null, sessionName: string | null): string {
  const trimmedScope = scope?.trim()
  const trimmedSession = sessionName?.trim()
  if (trimmedScope && trimmedSession) return `${trimmedScope}: ${trimmedSession}`
  if (trimmedScope) return trimmedScope
  if (trimmedSession) return trimmedSession
  return 'New Tab'
}
