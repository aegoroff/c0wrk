// Chat stream & response events: assistant_chunk, assistant_done, thought, error,
// task_complete, task_cancelled, reflection, memory_read, message_received

import { useEffect } from 'react'
import { onSessionEvent, reportDroppedEvent } from '@/api/runtime'
import { isAssistantChunkData, isAssistantDoneData, isThoughtData, isErrorData, isTaskCompleteData, isReflectionData, isMemoryReadData, isMessageReceivedData } from '@/types/events'
import { useChatStore, selectSessionMessages } from '@/stores/chatStore'
import { useReviewStore } from '@/stores/reviewStore'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useFileViewerStore } from '@/stores/fileViewerStore'
import { useProjectStore, selectIsNoProject } from '@/stores/projectStore'
import { isSilentMode } from '@/stores/autonomyStore'
import { generateMessageId } from '@/lib/ids'
import { refreshCompactionAvailability } from '@/lib/sessionRuntime'
import type { ChatMessageUI } from '@/types/messages'
import { handleSessionPausedEvent, handleSessionResumedEvent } from './sessionLifecycleHandlers'

/**
 * Decide whether a task_complete.output should be added as a new assistant
 * message. In the implicit text-only finish path the executor streams the
 * answer via assistant_done (already flushed to a permanent assistant message)
 * AND sets it as Output, so task_complete would otherwise add a duplicate —
 * rendering the final answer twice. Returns false (skip) when the output
 * matches the most recent assistant message scoped after the last user message.
 *
 * Pure + exported so it is unit-testable without the Wails runtime.
 */
export function shouldAddTaskCompleteOutput(messages: ChatMessageUI[], output: string): boolean {
  if (!output) return false
  let lastAssistant: ChatMessageUI | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type === 'user') break
    if (m.type === 'assistant') { lastAssistant = m; break }
  }
  return !lastAssistant || lastAssistant.content !== output
}

/**
 * Whether the post-task review-loop reopen should fire for this
 * task_complete. Review is a CODE-mode-only feature: it
 * must never trigger in CHAT (No Project) mode, even if the git panel store
 * holds stale/leaked entries, and requires uncommitted working-tree changes.
 *
 * Pure + exported so it is unit-testable without the Wails runtime.
 */
export function shouldTriggerReview(isNoProject: boolean, hasChanges: boolean): boolean {
  if (isNoProject) return false
  return hasChanges
}

/** Time window (ms) within which a `message_received` event is treated as
 *  the delivery echo of this surface's own optimistic user card (added by
 *  useMessageSender / useReviewActions right before the send RPC). The echo
 *  follows the RPC within milliseconds; anything older cannot be this
 *  send's optimistic copy. Mirrors mergeHistoryMessages' time-window
 *  preservation of in-flight live messages. */
export const MESSAGE_RECEIVED_ECHO_WINDOW_MS = 10_000

/** How deep into the user-message tail the echo dedup scans. More than one
 *  because an interleaved event from another surface (rendered between this
 *  send's optimistic card and its echo) must not hide the optimistic copy. */
export const MESSAGE_RECEIVED_SCAN_DEPTH = 5

/**
 * Decide whether a `message_received` event should add a user message card.
 * The backend emits the event after persisting every user message, on every
 * surface watching the session. The surface that SENT the message already
 * rendered its own optimistic card, so the event is dropped there (it is the
 * echo of that card); a surface that did not send has no optimistic copy and
 * renders the card from the event.
 *
 * The drop decision: when the echo carries a clientSendId (the sending
 * surface's optimistic-card id), the match is exact identity against the tail
 * of user cards — identical text sent from ANOTHER surface has a different id
 * and must render its own card. Without an id (sends that rendered no
 * optimistic card) the decision falls back to comparing the event text
 * against the tail by content + time window. A card this handler synthesized
 * for a PREVIOUS received event (metadata.received) is never a match target —
 * a repeated identical message is a genuinely new message and must render as
 * its own card, not be glued to the previous one.
 *
 * Pure + exported so it is unit-testable without the Wails runtime.
 */
export function shouldAddReceivedUserMessage(
  messages: ChatMessageUI[],
  text: string,
  now: number,
  clientSendId?: string,
  windowMs: number = MESSAGE_RECEIVED_ECHO_WINDOW_MS,
): boolean {
  if (!text) return false
  let scanned = 0
  for (let i = messages.length - 1; i >= 0 && scanned < MESSAGE_RECEIVED_SCAN_DEPTH; i--) {
    const m = messages[i]!
    if (m.type !== 'user') continue
    scanned++
    if (clientSendId) {
      // Id-based dedup: the echo twin is exactly this optimistic card.
      if (m.id === clientSendId) return false
      continue
    }
    // A card rendered from an earlier message_received event is not an
    // optimistic send copy — skip it when hunting for the echo's twin.
    if (m.metadata?.received === true) continue
    if (m.content === text && now - m.timestamp <= windowMs) return false
  }
  return true
}

export function useChatEvents(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return

    const cleanups: Array<() => void> = []

    // --- assistant_chunk ---
    cleanups.push(
      onSessionEvent(sessionId, 'assistant_chunk', (data) => {
        if (!isAssistantChunkData(data)) { reportDroppedEvent('assistant_chunk', data); return }
        const store = useChatStore.getState()
        store.setActivityStatus(sessionId, 'Generating response...')
        // A plan-step/subagent-scoped chunk (plan_step_id set) belongs to that
        // block, never the Conductor's root chat. The scoped emitter flushes
        // chunk+done together as one full-output emission, so nothing needs to
        // stream into the session-global buffer here — the committed message
        // arrives via assistant_done and nests under the block. Streaming it
        // to the root buffer would surface a subagent's answer in the root
        // chat (and it then vanish when the buffer is cleared/overwritten).
        if (data.plan_step_id) return
        if (data.accumulated_content !== undefined) {
          store.setStreamingText(sessionId, data.accumulated_content)
        } else if (data.content) {
          // Ensure streaming session is set before appending
          if (!store.streamingText[sessionId]) {
            store.setStreamingText(sessionId, data.content)
          } else {
            store.appendStreamingText(sessionId, data.content)
          }
        }
      }),
    )

    // --- assistant_done ---
    cleanups.push(
      onSessionEvent(sessionId, 'assistant_done', (data) => {
        const store = useChatStore.getState()
        // A plan-step/subagent-scoped answer (plan_step_id set) belongs to its
        // block: stamp the plan_step_id so groupMessages nests it under the
        // step/subagent. Without this the answer was committed to the root
        // Conductor chat live and then vanished on reload — the persisted
        // assistant row carries plan_step_id and nests, a live/reload mismatch.
        const scoped = isAssistantDoneData(data) ? data : undefined
        if (scoped?.plan_step_id) {
          if (scoped.content) {
            store.addMessage(sessionId, {
              id: generateMessageId(),
              sessionId,
              type: 'assistant',
              content: scoped.content,
              metadata: { plan_step_id: scoped.plan_step_id },
              timestamp: Date.now(),
            })
          }
          return
        }
        const text = store.streamingText[sessionId]
        if (text) {
          store.addMessage(sessionId, {
            id: generateMessageId(),
            sessionId,
            type: 'assistant',
            content: text,
            timestamp: Date.now(),
          })
          store.clearStreamingText(sessionId)
        }
      }),
    )

    // --- thought ---
    cleanups.push(
      onSessionEvent(sessionId, 'thought', (data) => {
        if (!isThoughtData(data)) { reportDroppedEvent('thought', data); return }
        useChatStore.getState().setActivityStatus(sessionId, 'Reasoning...')
        useChatStore.getState().addMessage(sessionId, {
          id: generateMessageId(),
          sessionId,
          type: 'thought',
          content: data.content,
          metadata: { step_num: data.step_num, reasoning: data.reasoning, plan_step_id: data.plan_step_id },
          timestamp: Date.now(),
        })
      }),
    )

    // --- error ---
    cleanups.push(
      onSessionEvent(sessionId, 'error', (data) => {
        if (!isErrorData(data)) { reportDroppedEvent('error', data); return }
        useChatStore.getState().addMessage(sessionId, {
          id: generateMessageId(),
          sessionId,
          type: 'error',
          content: data.error || 'An error occurred',
          timestamp: Date.now(),
        })
        const store = useChatStore.getState()
        store.clearStreamingText(sessionId)
        store.setActivityStatus(sessionId, null)
        store.setTaskActive(sessionId, false)
        store.setPausing(sessionId, false)
        // Terminal event: no unfinished task survives an errored run — clear
        // the single live unfinished-task overlay so every status dot turns
        // idle live (and the busy check stops protecting the session). A
        // failure that stays resumable is immediately followed by the
        // backend's task_failed_resumable event, which re-arms it as 'failed'
        // (see useActionEvents).
        useChatStore.getState().setUnfinishedTaskStatus(sessionId, '')
        // The failed exchange still grew the conversation history — refresh
        // the compaction no-op flag (the compact button's disabled state).
        refreshCompactionAvailability(sessionId)
      }),
    )

    // --- task_complete ---
    cleanups.push(
      onSessionEvent(sessionId, 'task_complete', (data) => {
        if (!isTaskCompleteData(data)) { reportDroppedEvent('task_complete', data); return }
        const store = useChatStore.getState()
        store.clearStreamingText(sessionId)
        store.setActivityStatus(sessionId, null)
        store.setTaskActive(sessionId, false)
        store.setPausing(sessionId, false)
        // The task settled: clear the single live unfinished-task overlay so
        // every status dot repaints idle live. Degraded completions
        // (success === false) are still cleared here — the backend emits its
        // task_failed_resumable event right AFTER this one when the task stays
        // resumable, and that handler re-arms the overlay as 'failed' (see
        // useActionEvents).
        useChatStore.getState().setUnfinishedTaskStatus(sessionId, '')
        // The completed exchange was appended to the conversation history
        // (the orchestrator records the outcome before this event fires), so
        // a previously-no-op session may be compactable again — refresh the
        // compaction no-op flag (the compact button's disabled state).
        refreshCompactionAvailability(sessionId)
        if (data.output) {
          // Dedup: in the implicit text-only finish path the executor streams
          // the answer via assistant_done (already flushed to a permanent
          // assistant message) AND sets it as Output, so task_complete would
          // otherwise add a duplicate assistant message — rendering the final
          // answer twice. Skip when the output matches the most recent
          // assistant message (scoped after the last user message).
          // Imperative read (not a reactive selector) — safe despite the ⚠️
          // in selectSessionMessages, which only applies to useStore(selector).
          const msgs = selectSessionMessages(store, sessionId)
          if (shouldAddTaskCompleteOutput(msgs, data.output)) {
            store.addMessage(sessionId, {
              id: generateMessageId(),
              sessionId,
              type: 'assistant',
              content: data.output,
              timestamp: Date.now(),
            })
          }
        } else {
          // No output — add a "[Task completed]" placeholder to match the
          // backend persister, which persists the same placeholder for empty
          // output. Without this, an empty-output completion is invisible in
          // the live render but appears as "[Task completed]" after reload.
          store.addMessage(sessionId, {
            id: generateMessageId(),
            sessionId,
            type: 'assistant',
            content: '[Task completed]',
            timestamp: Date.now(),
          })
        }
        // Degraded completion (partial/failed/aborted): surface it explicitly
        // instead of letting the task end look like a clean success.
        if (data.success === false) {
          const failed = data.failed_steps
            ? ` (${data.failed_steps} step${data.failed_steps === 1 ? '' : 's'} failed)`
            : ''
          store.addMessage(sessionId, {
            id: generateMessageId(),
            sessionId,
            type: 'error',
            content: `Task finished with ${data.completion ?? 'incomplete'} execution${failed}. The output above may be incomplete.`,
            timestamp: Date.now(),
          })
        }

        // --- Review trigger (auto-review loop reopen only) ---
        // On a successful task_complete with uncommitted changes in a CODE
        // project, reopen the review page when the user previously clicked
        // Submit (reviewLoopActive). Silent mode suppresses this post-task
        // UI interception entirely — there is no user to review when the
        // task runs unattended (this client-side reopen is the one review
        // hook the frontend owns; the other silent-mode sub-policies are
        // enforced entirely in the backend).
        if (data.success !== false) {
          const reviewStore = useReviewStore.getState()
          const isLoopActive = !!reviewStore.reviewLoopActive[sessionId]
          const gitState = useGitPanelStore.getState()
          const projectState = useProjectStore.getState()
          // Pair isGitRepo with the project it was checked against (the store
          // contract): a stale isGitRepo=true from a previously active project
          // must not reopen the review page for the project now active, which
          // may have no changes. Review is also CODE-mode-only: never reopen
          // the review page in CHAT (No Project) mode, even if the git store
          // holds stale/leaked entries.
          const hasChanges =
            gitState.isGitRepo &&
            gitState.gitRepoProjectId === projectState.activeProjectId &&
            gitState.entries.length > 0
          const isNoProject = selectIsNoProject(projectState)

          if (isLoopActive && shouldTriggerReview(isNoProject, hasChanges) && !isSilentMode()) {
            const fvStore = useFileViewerStore.getState()
            fvStore.openFile('c0wrk:review')
            fvStore.setCollapsed(false)
            reviewStore.openReviewPage(sessionId)
            void reviewStore.loadReview(sessionId)
          }
        }
      }),
    )

    // --- task_cancelled ---
    cleanups.push(
      onSessionEvent(sessionId, 'task_cancelled', () => {
        const store = useChatStore.getState()
        store.clearStreamingText(sessionId)
        store.setActivityStatus(sessionId, null)
        store.setTaskActive(sessionId, false)
        store.setPaused(sessionId, false)
        store.setPausing(sessionId, false)
        // A user-initiated cancel persists the task as cancelled in the task
        // store, so no unfinished task survives it — clear the single live
        // unfinished-task overlay so every status dot repaints idle live and
        // the busy check releases the session.
        useChatStore.getState().setUnfinishedTaskStatus(sessionId, '')
        // A cancelled task still records its exchange in the conversation
        // history (the orchestrator's cancellation epilogue appends the user
        // message + cancellation note), so a previously-no-op session may be
        // compactable again — refresh the compaction no-op flag (the compact
        // button's disabled state), mirroring task_complete / error.
        refreshCompactionAvailability(sessionId)
        store.addMessage(sessionId, {
          id: generateMessageId(),
          sessionId,
          type: 'error',
          content: 'Task was cancelled',
          timestamp: Date.now(),
        })
      }),
    )

    // --- session_paused ---
    // A cooperative pause is a clean checkpoint: enter the paused UI state
    // (input unlocked, Resume/Stop). taskActive clears because the task is
    // no longer running — it is suspended, resumable via Resume or a nudge.
    // SUPPRESSED while a manual compaction is in flight: the compaction flow
    // pauses the running task itself, and the paused affordances (unlocked
    // input, Resume/Stop) must not appear — the session stays in the
    // "Compacting" state until compaction_finished, after which the flow
    // auto-resumes and session_resumed clears everything.
    cleanups.push(
      onSessionEvent(sessionId, 'session_paused', () => {
        const chat = useChatStore.getState()
        if (chat.compacting[sessionId]) return
        handleSessionPausedEvent(sessionId)
      }),
    )

    // --- session_resumed ---
    // Resume clears the paused state: input re-locks, Pause/Stop return.
    // Complementary to session_paused and task_resumed (which also fires).
    cleanups.push(
      onSessionEvent(sessionId, 'session_resumed', () => {
        handleSessionResumedEvent(sessionId)
      }),
    )

    // --- reflection ---
    cleanups.push(
      onSessionEvent(sessionId, 'reflection', (data) => {
        if (!isReflectionData(data)) { reportDroppedEvent('reflection', data); return }
        useChatStore.getState().setActivityStatus(sessionId, 'Reflecting on results...')
        useChatStore.getState().addMessage(sessionId, {
          id: generateMessageId(),
          sessionId,
          type: 'reflection',
          content: data.summary,
          metadata: {
            summary: data.summary,
            insights: data.insights,
            suggested_action: data.suggested_action,
            root_cause: data.root_cause,
            failure_analysis: data.failure_analysis,
            action_plan: data.action_plan,
            reasoning: data.reasoning,
            attempt: data.attempt,
            max_attempts: data.max_attempts,
          },
          timestamp: Date.now(),
        })
      }),
    )

    // --- memory_read ---
    // The agent restored facts from its persistent blackboard: render the
    // compact "memory read" card at the moment of the read. The event also
    // persists as a durable role-`memory_read` row whose restored card
    // (chatUtils 'memory_read' case) matches this one — content plus the
    // step_num metadata hint. No stable per-event identity exists to align
    // the live message id with the reloaded row's `history-<dbId>` (same
    // limitation as autonomy_decision), so an event landing exactly during a
    // history RPC can duplicate the card — acceptable; dropping a real read
    // is not.
    cleanups.push(
      onSessionEvent(sessionId, 'memory_read', (data) => {
        if (!isMemoryReadData(data)) { reportDroppedEvent('memory_read', data); return }
        useChatStore.getState().addMessage(sessionId, {
          id: generateMessageId(),
          sessionId,
          type: 'memory_read',
          content: data.content,
          metadata: { step_num: data.step_num },
          timestamp: Date.now(),
        })
      }),
    )

    // --- message_received ---
    // The backend emits this after persisting every user message (normal
    // send, nudge-resume, live interjection) to ALL surfaces watching the
    // session. The event text is the RAW user input (pre-preprocessing) —
    // byte-identical to the optimistic card and the persisted DB row; the
    // orchestrator-facing dispatch text may be the processed form (mention
    // refs stripped), so a content-equality dedup only holds against the raw
    // form. The surface that sent the message already rendered its
    // optimistic card (useMessageSender before the RPC; useReviewActions for
    // a review submit), so its event is the delivery echo — dropped by
    // shouldAddReceivedUserMessage. Every OTHER surface watching the session
    // has no optimistic copy and renders the user card here, so the message
    // is visible without a session switch. The card is stamped
    // metadata.received so the dedup never targets it: a repeated identical
    // message (same text sent again) is a new message and must stay a
    // distinct card. Like the other random-id live cards, a re-emission
    // landing exactly during a history RPC can duplicate — acceptable;
    // hiding a real message is not.
    cleanups.push(
      onSessionEvent(sessionId, 'message_received', (data) => {
        if (!isMessageReceivedData(data)) { reportDroppedEvent('message_received', data); return }
        const store = useChatStore.getState()
        // Imperative read (not a reactive selector) — safe despite the ⚠️
        // in selectSessionMessages, which only applies to useStore(selector).
        const msgs = selectSessionMessages(store, sessionId)
        // The echo carries the sender's optimistic-card id (client_send_id)
        // whenever the send rendered one: the dedup then matches that id
        // exactly, so a second surface sending identical text inside the
        // window keeps its own card instead of being swallowed as the echo.
        if (!shouldAddReceivedUserMessage(msgs, data.text, Date.now(), data.client_send_id)) return
        store.addMessage(sessionId, {
          id: generateMessageId(),
          sessionId,
          type: 'user',
          content: data.text,
          // is_nudge rides the event when the send was a live interjection or
          // a nudge-resume (same rule the persisted row is stamped by), so
          // this card shows the Nudge badge immediately like the sending
          // surface's optimistic copy does. Absent on fresh tasks.
          metadata: data.is_nudge === true ? { received: true, is_nudge: true } : { received: true },
          timestamp: Date.now(),
        })
      }),
    )

    return () => cleanups.forEach(fn => fn())
  }, [sessionId])
}
