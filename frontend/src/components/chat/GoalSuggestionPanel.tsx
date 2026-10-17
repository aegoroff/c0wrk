import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Check, X, Target } from 'lucide-react'
import { goal } from '@/api'
import type { DisplayItem } from '@/types/messages'
import { isResolved } from '@/types/messages'
import { useChatStore } from '@/stores/chatStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useGoalStore } from '@/stores/goalStore'
import { logger } from '@/lib/logger'

interface GoalSuggestionPanelProps {
  item: Extract<DisplayItem, { kind: 'goal_suggestion' }>
}

/**
 * Renders a pending goal-mode suggestion as a decision card: the classifier's
 * reason for the offer plus "Enable goal mode" / "Run as usual". Accepting
 * unblocks the suggestion gate and the task enters the goal loop (with its
 * routing already established) BEFORE any work starts; declining continues the
 * plain run and suppresses further suggestions for the session.
 *
 * Mirrors GoalProposalPanel's resolved-state rendering and optimistic-update
 * pattern so an answered offer collapses to a small settled card.
 */
export function GoalSuggestionPanel({ item }: GoalSuggestionPanelProps) {
  const sessionId = useSessionStore((s) => s.activeSessionId)
  const requestId = item.message.metadata?.request_id as string | undefined
  const decision = item.message.metadata?.decision as 'accept' | 'decline' | undefined
  const error = item.message.metadata?.error as string | undefined
  const [submitting, setSubmitting] = useState(false)

  // --- Resolved (settled) states ---

  if (decision === 'accept') {
    return (
      <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Check className="h-3.5 w-3.5 shrink-0 text-success" />
          <span>Goal mode</span>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Goal mode enabled for this task</p>
      </div>
    )
  }
  if (decision === 'decline') {
    return (
      <div className="rounded-md border border-border bg-background/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Target className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span>Goal mode</span>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Declined — continuing as a regular task</p>
      </div>
    )
  }
  // Resolved without a recorded decision — stale prompt reconciled on reload.
  if (isResolved(item.message.metadata)) {
    return (
      <div className="rounded-md border border-border bg-background/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Target className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span>Goal mode</span>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Dismissed</p>
      </div>
    )
  }

  if (!requestId || !sessionId) return null

  const markResolved = (d: 'accept' | 'decline'): void => {
    useChatStore.getState().updateMessage(sessionId, item.message.id, {
      metadata: { ...item.message.metadata, resolved: true, decision: d },
    })
    // Keep the goal store in sync so the pending suggestion doesn't linger
    // after the user has responded.
    useGoalStore.getState().clearPendingSuggestion(sessionId)
  }

  const onAccept = async (): Promise<void> => {
    setSubmitting(true)
    try {
      await goal.acceptGoalSuggestion(sessionId, requestId)
      markResolved('accept')
    } catch (err) {
      logger.error('Failed to accept goal suggestion:', err)
      useChatStore.getState().updateMessage(sessionId, item.message.id, {
        metadata: { ...item.message.metadata, error: 'Failed to enable goal mode' },
      })
    } finally {
      setSubmitting(false)
    }
  }

  const onDecline = async (): Promise<void> => {
    setSubmitting(true)
    try {
      await goal.declineGoalSuggestion(sessionId, requestId)
      markResolved('decline')
    } catch (err) {
      logger.error('Failed to decline goal suggestion:', err)
      useChatStore.getState().updateMessage(sessionId, item.message.id, {
        metadata: { ...item.message.metadata, error: 'Failed to decline' },
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-md border border-info/30 bg-info/5 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Target className="h-3.5 w-3.5 shrink-0 text-info" />
        <span>Enable goal mode?</span>
      </div>

      <div className="mt-1.5 space-y-1.5">
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        <p className="text-xs text-muted-foreground whitespace-pre-wrap">{item.reason}</p>

        <div className="flex gap-2 pt-0.5">
          <Button variant="default" size="sm" onClick={onAccept} disabled={submitting} title="Enter the goal loop for this task before any work starts">
            <Check className="size-3.5 mr-1" /> Enable goal mode
          </Button>
          <Button variant="ghost" size="sm" onClick={onDecline} disabled={submitting} title="Continue as a regular task (no more suggestions this session)">
            <X className="size-3.5 mr-1" /> Run as usual
          </Button>
        </div>
      </div>
    </div>
  )
}
