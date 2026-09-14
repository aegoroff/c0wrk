import { AlertTriangle, RefreshCw, X, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chatStore'
import { useInputModeStore } from '@/stores/inputModeStore'
import { useActiveSessionsStore } from '@/stores/activeSessionsStore'
import { resumeTask, cancelUnfinishedTask } from '@/api/chat'
import { generateMessageId } from '@/lib/ids'
import type { DisplayItem } from '@/types/messages'
import { getResumeResolution, resumeResolved } from '@/types/messages'

type ResumeItem = Extract<DisplayItem, { kind: 'resume_action' }>

export function ResumeActionPanel({ item }: { item: ResumeItem }) {
  const { sessionId, content, metadata } = item.message
  const updateMessage = useChatStore(s => s.updateMessage)

  const decision = getResumeResolution(metadata)

  if (decision === 'resumed') {
    return (
      <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Check className="h-3.5 w-3.5 shrink-0 text-success" />
          <span>Task Failed</span>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Task resumed</p>
      </div>
    )
  }
  if (decision === 'cancelled') {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <X className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <span>Task Failed</span>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Task cancelled</p>
      </div>
    )
  }
  // Resolved without a recorded decision (e.g. stale action reconciled on
  // reload) — render nothing at the stream position.
  if (metadata?.resolved === true) return null

  const handleResume = async () => {
    // Snapshot the original metadata so the optimistic 'resumed' marking can be
    // reverted if the backend rejects the resume (e.g. the session is archived —
    // the manager guard returns ErrSessionArchived). updateMessage shallow-merges
    // at the message level, so restoring the metadata reference replaces it wholesale.
    const originalMetadata = item.message.metadata
    updateMessage(sessionId, item.message.id, { metadata: resumeResolved('resumed') })
    // Read the user's current model/reasoning selection so a model switch made
    // before resuming is honored (same semantics as a fresh SendMessage),
    // instead of silently inheriting the interrupted task's settings.
    const modelOverride = useInputModeStore.getState().selectedModel ?? ''
    const reasoningOverride = useInputModeStore.getState().selectedReasoning ?? ''
    try {
      await resumeTask(sessionId, modelOverride, reasoningOverride)
    } catch (err) {
      // Revert the optimistic 'resumed' state so the panel stays actionable,
      // then surface the failure in the chat (mirrors useMessageSender).
      updateMessage(sessionId, item.message.id, { metadata: originalMetadata })
      const errorMessage = err instanceof Error ? err.message : String(err)
      useChatStore.getState().addMessage(sessionId, {
        id: generateMessageId(),
        sessionId,
        type: 'error',
        content: `Failed to resume task: ${errorMessage}`,
        timestamp: Date.now(),
      })
    }
  }

  const handleCancel = () => {
    updateMessage(sessionId, item.message.id, { metadata: resumeResolved('cancelled') })
    // The backend marks the unfinished task cancelled and emits NO terminal
    // event on this hard-discard path — so clear the SINGLE live unfinished-task
    // overlay (which every status surface reads) to '' immediately: the radar
    // row and every sidebar/radar dot turn idle at once, without waiting for the
    // 30s safety poll. clearUnfinishedTask additionally freshens the DB snapshot
    // in place, and the store drops any fetch that started before the clear
    // (snapshotGeneration) and re-reads, so an in-flight read cannot resurrect
    // the cancelled entry and the authoritative value lands without waiting for
    // the 30s poll. Best-effort: the UI is already dismissed, so a failed RPC
    // stays silent.
    cancelUnfinishedTask(sessionId)
      .then(() => {
        useChatStore.getState().setUnfinishedTaskStatus(sessionId, '')
        useActiveSessionsStore.getState().clearUnfinishedTask(sessionId)
        useActiveSessionsStore.getState().refresh()
      })
      .catch(() => { /* best-effort: UI is already dismissed */ })
  }

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span>Task Failed</span>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{content}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" onClick={handleResume} className="text-xs">
          <RefreshCw className="h-3 w-3 mr-1.5" />Resume
        </Button>
        <Button size="sm" variant="outline" onClick={handleCancel} className="text-xs">
          <X className="h-3 w-3 mr-1.5" />Cancel
        </Button>
      </div>
    </div>
  )
}
