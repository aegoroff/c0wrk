// Goal lifecycle RPC wrappers.
//
// Thin wrappers over the desktop App bindings for the goal-mode control flow:
// confirm/cancel a pending proposal. The runtime pause/resume/cancel controls
// are session-level (see api/chat.ts pauseSession/resumeSession/cancelTask),
// not goal-specific. Mirrors backend/frontend_api_goal.go
// (ConfirmGoal(sessionID, requestID, condition, verify, verificationMode),
// CancelGoal(sessionID, requestID)).

import { getApp } from './runtime'
import { logger } from '@/lib/logger'

/** Approve a pending goal proposal, optionally with user edits to the
 *  condition/verify fields and the per-goal verification mode. Unblocks the
 *  derivation agent's propose_goal call. */
export async function confirmGoal(sessionId: string, requestId: string, condition: string, verify: string, verificationMode: string): Promise<void> {
  try {
    const app = getApp()
    await app.ConfirmGoal(sessionId, requestId, condition, verify, verificationMode)
  } catch (err) {
    logger.error('Failed to confirm goal:', err)
    throw err
  }
}

/** Cancel a pending goal proposal. The agent exits the goal loop without
 *  committing to a goal. */
export async function cancelGoal(sessionId: string, requestId: string): Promise<void> {
  try {
    const app = getApp()
    await app.CancelGoal(sessionId, requestId)
  } catch (err) {
    logger.error('Failed to cancel goal:', err)
    throw err
  }
}

/** Accept a pending goal-mode suggestion: the blocked suggestion gate unblocks
 *  and the task enters the goal loop (with the routing decision already
 *  established) before any work starts. Mirrors
 *  backend/frontend_api_goal.go AcceptGoalSuggestion(sessionID, requestID). */
export async function acceptGoalSuggestion(sessionId: string, requestId: string): Promise<void> {
  try {
    const app = getApp()
    await app.AcceptGoalSuggestion(sessionId, requestId)
  } catch (err) {
    logger.error('Failed to accept goal suggestion:', err)
    throw err
  }
}

/** Decline a pending goal-mode suggestion: the task continues as a plain run
 *  and the session suppresses further suggestions. Mirrors
 *  backend/frontend_api_goal.go DeclineGoalSuggestion(sessionID, requestID). */
export async function declineGoalSuggestion(sessionId: string, requestId: string): Promise<void> {
  try {
    const app = getApp()
    await app.DeclineGoalSuggestion(sessionId, requestId)
  } catch (err) {
    logger.error('Failed to decline goal suggestion:', err)
    throw err
  }
}
