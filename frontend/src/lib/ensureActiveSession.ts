import type { SessionInfo } from '@/types/models'
import { createSession } from '@/api/sessions'
import { useSessionStore } from '@/stores/sessionStore'
import { useChatStore } from '@/stores/chatStore'
import { logger } from '@/lib/logger'

/**
 * Ensure SOME session exists and is active — the no-session edge of the
 * draft-free creation flow (ADR-091). Every "ensure a session exists" site
 * (send, attachment staging, paste, terminal open) calls this ONLY when no
 * session is active (fresh app start without a saved session, last session
 * deleted, research Shift-click): a plain LOCAL session is created exactly
 * like the CHAT-mode auto-create — fast, never provisioning a worktree. The
 * normal path is "New Session" (eagerly creates the row) followed by sends
 * into the existing session, so this helper is a rare fallback, not a flow.
 *
 * On success the session is added and selected (persisted as the project's
 * saved session, mirroring the previous auto-create sites); on failure the
 * error propagates to the caller's existing handling.
 */
export async function ensureActiveSession(): Promise<SessionInfo> {
  try {
    const session = await createSession()
    useSessionStore.getState().addSession(session)
    // Born confirmed-empty (the workspace picker must arm from birth — same
    // seeding the "New Session" flow does; ADR-091).
    useChatStore.getState().ensureEmptyTranscript(session.id)
    useSessionStore.getState().selectSession(session.id, session.project_id)
    return session
  } catch (err) {
    logger.error('Failed to create session:', err)
    throw err
  }
}
