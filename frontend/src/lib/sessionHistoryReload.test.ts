// Tests for lib/sessionHistoryReload — the shared ChatArea/resync loader.
//
// The load is RE-RUNNABLE for the same session (the app-root shallow resync
// re-runs it on WS re-connect / window focus while the user watches the
// session): the merge into chatStore must dedupe by id, preserve live
// messages that arrived during the RPC flight, and leave an in-flight
// stream's tail (chatStore.streamingText) untouched.

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/api/chat', () => ({
  getSessionHistory: vi.fn(),
  getSessionRuntimeStatus: vi.fn(),
  getPendingActions: vi.fn(),
  resolveStalePrompt: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { reloadSessionHistory } from './sessionHistoryReload'
import { getSessionHistory, getSessionRuntimeStatus, getPendingActions } from '@/api/chat'
import { useChatStore } from '@/stores/chatStore'
import type { ChatMessage } from '@/types/models'
import type { ChatMessageUI, MessageType } from '@/types/messages'

const SESSION = 'resync-sess'

/** A persisted history row. metadata is left undefined (plain-object branch
 *  of chatMessageToUI), so the UI id is the deterministic `history-<dbId>`. */
function row(dbId: number, role: string, content: string): ChatMessage {
  return {
    id: dbId,
    session_id: SESSION,
    role,
    content,
    metadata: undefined as unknown as number[],
    created_at: '2026-01-01T00:00:00Z',
  }
}

function liveMsg(id: string, type: MessageType, content: string): ChatMessageUI {
  // A live event's stamp is always >= the reload's loadStartedAt.
  return { id, sessionId: SESSION, type, content, timestamp: Date.now() + 5000 }
}

beforeEach(() => {
  vi.mocked(getSessionHistory).mockReset()
  vi.mocked(getSessionRuntimeStatus).mockResolvedValue(null)
  vi.mocked(getPendingActions).mockResolvedValue(null)
  useChatStore.setState({
    messages: {},
    messageOrder: {},
    streamingText: {},
    runtimeEventAt: {},
    taskActive: {},
    activityStatus: {},
  })
})

describe('reloadSessionHistory', () => {
  it('reloading during an active stream neither duplicates nor loses messages', async () => {
    // The session loaded normally at t0; the task has been streaming since.
    // The backend persists before emitting, so the answer being streamed has
    // already landed in the DB when the resync re-reads the history.
    vi.mocked(getSessionHistory).mockResolvedValue([
      row(1, 'user', 'Do the thing'),
      row(2, 'assistant', 'Working on it…'),
    ])
    const store = useChatStore.getState()
    store.addMessage(SESSION, { id: 'history-1', sessionId: SESSION, type: 'user', content: 'Do the thing', timestamp: 1000 })
    store.setStreamingText(SESSION, 'Working on')
    store.setTaskActive(SESSION, true)

    await reloadSessionHistory(SESSION)

    const state = useChatStore.getState()
    // Exactly one copy of each row: the live history-1 deduped against the
    // snapshot, the persisted answer appended once.
    expect(state.messageOrder[SESSION]).toEqual(['history-1', 'history-2'])
    expect(state.messages[SESSION]!['history-2']!.content).toBe('Working on it…')
    // The in-flight stream's tail and the running flag are untouched.
    expect(state.streamingText[SESSION]).toBe('Working on')
    expect(state.taskActive[SESSION]).toBe(true)
  })

  it('keeps a live message that lands during the reload RPC flight', async () => {
    vi.mocked(getSessionHistory).mockImplementation(async () => {
      // A terminal error event is delivered while the history RPC is in
      // flight (the combined emit reaches the UI before the persist).
      useChatStore.getState().addMessage(SESSION, liveMsg('live-error', 'error', 'boom'))
      return [row(1, 'user', 'hi')]
    })

    await reloadSessionHistory(SESSION)

    expect(useChatStore.getState().messageOrder[SESSION]).toEqual(['history-1', 'live-error'])
  })

  it('does not duplicate a message the store already holds under the same id', async () => {
    vi.mocked(getSessionHistory).mockResolvedValue([row(7, 'assistant', 'final')])
    useChatStore.getState().addMessage(SESSION, liveMsg('history-7', 'assistant', 'final'))

    await reloadSessionHistory(SESSION)

    const order = useChatStore.getState().messageOrder[SESSION] ?? []
    expect(order.filter((id) => id === 'history-7')).toHaveLength(1)
    expect(order).toEqual(['history-7'])
  })

  it('drops an unresolved HITL card from history only when the snapshot carries it, and re-reconciles it via pending actions', async () => {
    // The card arrived live (unpersisted) and the DB snapshot does not carry
    // it: merge must preserve it (HITL preservation) so the prompt does not
    // flicker away until the pending-actions reconcile answers.
    vi.mocked(getSessionHistory).mockResolvedValue([row(1, 'user', 'hi')])
    useChatStore.getState().addMessage(SESSION, {
      id: 'ask_user-req-9', sessionId: SESSION, type: 'ask_user',
      content: 'Pick one', metadata: { request_id: 'req-9', questions: [] }, timestamp: 500,
    })

    await reloadSessionHistory(SESSION)

    const order = useChatStore.getState().messageOrder[SESSION] ?? []
    expect(order).toContain('ask_user-req-9')
  })

  it('stops at the cancellation probe without touching the store', async () => {
    let cancelled = false
    vi.mocked(getSessionHistory).mockImplementation(async () => {
      // The user switched sessions while the RPC was in flight.
      cancelled = true
      return [row(1, 'user', 'hi')]
    })

    await reloadSessionHistory(SESSION, { isCancelled: () => cancelled })

    expect(useChatStore.getState().messageOrder[SESSION]).toBeUndefined()
    expect(useChatStore.getState().messages[SESSION]).toBeUndefined()
  })

  it('rejects when the history RPC fails (the caller owns the error UI)', async () => {
    vi.mocked(getSessionHistory).mockRejectedValue(new Error('rpc down'))
    await expect(reloadSessionHistory(SESSION)).rejects.toThrow('rpc down')
    // Nothing was written.
    expect(useChatStore.getState().messageOrder[SESSION]).toBeUndefined()
  })
})
