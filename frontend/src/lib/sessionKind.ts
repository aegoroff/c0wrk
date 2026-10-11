// Session-kind resolution for the /-completion and the send path: which
// capability context ('chat' | 'code') the ACTIVE session belongs to. The
// kind decides which column of the capabilities modes (chat_mode / code_mode)
// gates what the completion offers and what a mention threads — mirroring the
// backend, which resolves the same context from the session's project at task
// entry and drops mentions of capabilities disabled there.

import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { sessionKindFromProjectId } from './capabilityModes'
import type { CapabilityContext } from './capabilityModes'

/**
 * The kind of one session, by id. The session's own `project_id` is the
 * source of record; when the id is unknown to the store (no active session,
 * or the transient window around a project switch where the list has not
 * arrived yet), the ACTIVE PROJECT context stands in — it is exactly the
 * context a session created from the input right now would get.
 */
export function sessionKindForSession(sessionId: string | null): CapabilityContext {
  if (sessionId !== null) {
    const session = useSessionStore.getState().sessions?.find((s) => s.id === sessionId)
    if (session) return sessionKindFromProjectId(session.project_id)
  }
  return sessionKindFromProjectId(useProjectStore.getState().activeProjectId)
}

/**
 * The kind of the CURRENTLY active session (or, with none active, of the
 * context a new session would be created in). Read at completion-trigger
 * time so a session switch flips the offered sets on the very next trigger.
 */
export function activeSessionKind(): CapabilityContext {
  return sessionKindForSession(useSessionStore.getState().activeSessionId)
}
