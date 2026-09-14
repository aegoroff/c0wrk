// Sidebar session status indicator — derives the green/yellow circle state
// for a session from the chat store, which is the single source of truth for
// live execution and pending-action state.
//
// The previous design mirrored `chatStore.taskActive` into
// `sessionStore.sessions[].active` (dual bookkeeping). That mirroring was
// incomplete — several taskActive transitions (task_resumed, background
// completion, runtime reconciliation) never updated `sessionStore.active` —
// so the green circle disappeared in those paths. Instead of patching every
// mirroring site, the indicator now reads `chatStore` directly.

import { useMemo } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useActiveSessionsStore } from '@/stores/activeSessionsStore'
import type { ChatMessageUI } from '@/types/messages'
import { hasUnresolvedHITL } from '@/lib/hitlTypes'
import { deriveSessionStatus, type SessionDisplayStatus } from '@/lib/activeSessions'

// Re-exported for existing importers; the implementation lives in
// lib/hitlTypes.ts so lib/activeSessions.ts can share it without a
// hooks → lib dependency inversion.
export { hasUnresolvedHITL }

/** Sidebar indicator state for a session — an ALIAS of the global
 *  SessionDisplayStatus (lib/activeSessions.ts). Both session-list surfaces now
 *  share ONE derivation (deriveSessionStatus), so their colors can never drift;
 *  `failed` (red) surfaces a resumable failed task. */
export type SessionIndicatorStatus = SessionDisplayStatus

/**
 * Pure derivation of the sidebar indicator from a session's running flag,
 * paused flag, ordered messages, and effective task status. Exported for unit
 * testing without React rendering.
 *
 * A THIN adapter: the priority lives in ONE place — `deriveSessionStatus`
 * (lib/activeSessions.ts), shared with the live-sessions radar badge and its
 * dropdown. This wrapper only folds the message list into the HITL bit.
 *
 * `dbStatus` is the EFFECTIVE unfinished-task status the caller resolved — the
 * live chatStore overlay when known, else the DB snapshot's
 * `unfinished_task_status` (see useSessionStatusIndicator). The DB value is
 * authoritative for states chatStore cannot see: a task that failed (or was
 * interrupted) while the app was closed leaves the live flags untouched, yet
 * must still surface. Archived sessions always render idle.
 */
export function deriveSessionIndicatorStatus(
  isRunning: boolean,
  isPaused: boolean,
  messages: ChatMessageUI[],
  dbStatus = '',
  archived = false,
  hasPendingOverride = false,
): SessionIndicatorStatus {
  return deriveSessionStatus({
    archived,
    hasPendingHITL: hasPendingOverride || hasUnresolvedHITL(messages),
    taskActive: isRunning,
    paused: isPaused,
    unfinishedStatus: dbStatus,
  })
}

/**
 * Derive the sidebar status indicator for a session from the chat store,
 * combined with the session's effective unfinished-task status — the live
 * overlay (`chatStore.unfinishedTaskStatus`) when chatStore has live knowledge
 * of the session, otherwise the persisted snapshot (`dbStatus`, i.e.
 * SessionInfo.unfinished_task_status):
 *
 * - `'pending'` (yellow) — an unresolved HITL prompt is awaiting the user.
 * - `'failed'`  (red)    — a failed (resumable) task, live OR recorded in the DB.
 * - `'active'`  (green)  — a task is currently running (or the status says in_progress).
 * - `'paused'`  (gray)   — a cooperatively paused task (or the status says paused).
 * - `'idle'`             — neither.
 */
export function useSessionStatusIndicator(sessionId: string | null, dbStatus = '', archived = false): SessionIndicatorStatus {
  const isRunning = useChatStore(s => (sessionId ? s.taskActive[sessionId] ?? false : false))
  const isPaused = useChatStore(s => (sessionId ? s.paused[sessionId] ?? false : false))
  // Live unfinished-task overlay (chatStore) — present → authoritative; absent
  // → fall back to the DB snapshot's dbStatus. This is what makes the sidebar
  // dot repaint live on a terminal / resumable / pause / resume event without
  // waiting for a list refresh.
  const liveStatus = useChatStore(s => (sessionId ? s.unfinishedTaskStatus[sessionId] : undefined))
  const messageOrder = useChatStore(s => (sessionId ? s.messageOrder[sessionId] : undefined))
  const messageIndex = useChatStore(s => (sessionId ? s.messages[sessionId] : undefined))
  const hasPendingOverride = useActiveSessionsStore(s => (sessionId ? s.pendingOverride[sessionId] ?? false : false))

  return useMemo(() => {
    const messages: ChatMessageUI[] = []
    if (messageOrder && messageIndex) {
      for (const id of messageOrder) {
        const m = messageIndex[id]
        if (m) messages.push(m)
      }
    }
    return deriveSessionIndicatorStatus(isRunning, isPaused, messages, liveStatus ?? dbStatus, archived, hasPendingOverride)
  }, [messageOrder, messageIndex, isRunning, isPaused, liveStatus, dbStatus, archived, hasPendingOverride])
}

/**
 * Synchronous (non-hook) busy check for non-render code paths (e.g. session
 * action handlers). Mirrors the row's busy flag EXACTLY: a session is busy when
 * it is in ANY non-idle state — a running task, a paused task, a resumable
 * failed task, OR a task blocked on a HITL prompt ('pending'). All of those are
 * destructive to archive/delete (the backend cancels the still-unfinished task
 * first), so those actions request confirmation.
 */
export function isSessionBusy(sessionId: string): boolean {
  const chat = useChatStore.getState()
  const isRunning = chat.taskActive[sessionId] ?? false
  const isPaused = chat.paused[sessionId] ?? false

  const messages: ChatMessageUI[] = []
  const messageOrder = chat.messageOrder[sessionId]
  const messageIndex = chat.messages[sessionId]
  if (messageOrder && messageIndex) {
    for (const id of messageOrder) {
      const m = messageIndex[id]
      if (m) messages.push(m)
    }
  }

  const session = useSessionStore.getState().sessions?.find((s) => s.id === sessionId)
  // SAME single derivation every status surface uses (see deriveSessionStatus):
  // the live unfinished-task overlay first, the DB snapshot as fallback.
  // ANY non-idle status is busy: 'active' (running), 'paused', 'failed'
  // (resumable), and 'pending' (a running task blocked on a HITL prompt — still
  // unfinished, so archiving/deleting it would cancel live work). `archived` is
  // not consulted: this guard exists to protect a still-unfinished task from a
  // destructive archive/delete.
  const status = deriveSessionStatus({
    archived: false,
    hasPendingHITL: hasUnresolvedHITL(messages),
    taskActive: isRunning,
    paused: isPaused,
    unfinishedStatus: chat.unfinishedTaskStatus[sessionId] ?? session?.unfinished_task_status ?? '',
  })
  return status !== 'idle'
}
