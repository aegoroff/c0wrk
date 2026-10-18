// Prompt-suggestions RPC bridge (ADR-088) — thin wrappers over the desktop
// App bindings. Mirrors backend/frontend_api_suggestions.go:
// GetPromptSuggestions(sessionID, projectID) returns the active suggestion
// set the chat input offers for the addressed session; the backend routes by
// session CONTENT (a session with a transcript serves its own goal_advance
// "continuation" set; an empty/new session serves the project's freshest
// next_task "new_session" set; a No-Project window serves nothing). The RPC
// is fail-open on the backend side (never errors) — the only failure mode
// here is the transport itself, which degrades to `null` ("render nothing")
// rather than throwing into a render path.

import { getApp } from './runtime'
import { logger } from '@/lib/logger'
import { isPromptSuggestionRow } from '@/types/events'
import type { PromptSuggestionRow } from '@/types/events'

/** Which context the backend consulted for a response — `source` names the
 *  consulted context even when the returned set is empty. */
export type PromptSuggestionSource = 'continuation' | 'new_session' | 'none'

/** GetPromptSuggestions payload: the active set for the addressed session
 *  plus the routing decision. `project_id` is absent on the wire for
 *  No-Project windows and normalized to '' here. Rows are returned as
 *  persisted and already kind-filtered by the backend's routing decision —
 *  the frontend never re-filters by kind. */
export interface PromptSuggestionsResponse {
  readonly session_id: string
  readonly project_id: string
  readonly source: PromptSuggestionSource
  readonly suggestions: readonly PromptSuggestionRow[]
}

/** Boundary validator for the GetPromptSuggestions payload. The envelope
 *  (session_id, source, suggestions array) must be fully valid — a malformed
 *  envelope is rejected outright (`null`). Individual suggestion rows are
 *  validated per entry: a malformed row is dropped with a warning while the
 *  rest of the set survives, so one bad row cannot erase an otherwise usable
 *  set (mirrors the per-entry tolerance of getMCPServers). */
export function parsePromptSuggestionsResponse(raw: unknown): PromptSuggestionsResponse | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.session_id !== 'string') return null
  if (r.source !== 'continuation' && r.source !== 'new_session' && r.source !== 'none') return null
  if (!Array.isArray(r.suggestions)) return null
  const suggestions: PromptSuggestionRow[] = []
  for (const row of r.suggestions) {
    if (!isPromptSuggestionRow(row)) {
      logger.warn('getPromptSuggestions: dropping malformed suggestion row', row)
      continue
    }
    suggestions.push(row)
  }
  return {
    session_id: r.session_id,
    project_id: typeof r.project_id === 'string' ? r.project_id : '',
    source: r.source,
    suggestions,
  }
}

/**
 * Fetch the active prompt-suggestion set for a session. Returns the parsed
 * response, or `null` on a transport failure or an unexpected shape — the
 * chat input renders nothing; a null must never reject into a caller's render
 * path (fail-open, mirroring the backend read path).
 */
export async function getPromptSuggestions(sessionId: string, projectId: string): Promise<PromptSuggestionsResponse | null> {
  try {
    const app = getApp()
    const result = await app.GetPromptSuggestions(sessionId, projectId)
    const parsed = parsePromptSuggestionsResponse(result)
    if (!parsed) {
      logger.error('getPromptSuggestions: unexpected response shape', result)
    }
    return parsed
  } catch (err) {
    logger.error('Failed to get prompt suggestions:', err)
    return null
  }
}

/**
 * Toggle the prompt_suggestions.enabled gate (Settings surface). Throws on
 * failure — unlike the read path, a rejected toggle must surface to the UI
 * (the config was not persisted and the backend gate was not flipped).
 */
export async function setPromptSuggestionsEnabled(enabled: boolean): Promise<void> {
  try {
    const app = getApp()
    await app.SetPromptSuggestionsEnabled(enabled)
  } catch (err) {
    logger.error('Failed to set prompt suggestions enabled:', err)
    throw err
  }
}
