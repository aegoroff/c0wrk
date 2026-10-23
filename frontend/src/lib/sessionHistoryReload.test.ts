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

import { reloadSessionHistory, reportHistoryLoadFailure } from './sessionHistoryReload'
import { getSessionHistory, getSessionRuntimeStatus, getPendingActions } from '@/api/chat'
import { logger } from '@/lib/logger'
import { useChatStore } from '@/stores/chatStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { ChatMessage, SessionInfo } from '@/types/models'
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
    historyLoaded: new Set<string>(),
  })
  // The catalog carries the loaded session: the finally's deleted-mid-flight
  // guard (CS #13) marks only sessions the catalog still knows.
  useSessionStore.setState({
    sessions: [{ id: SESSION } as SessionInfo],
    activeSessionId: SESSION,
  })
})

describe('reloadSessionHistory', () => {
  it('does not mark a session deleted mid-flight (the catalog no longer knows it)', async () => {
    vi.mocked(getSessionHistory).mockResolvedValue([row(1, 'user', 'hi')])
    // The session's deletion landed while the history RPC was in flight —
    // dropSessions already cleared the marker; the finally must not
    // resurrect it (a recreated session with a reused id would otherwise
    // skip its history load).
    useSessionStore.setState({ sessions: [] })
    await reloadSessionHistory(SESSION)
    expect(useChatStore.getState().historyLoaded.has(SESSION)).toBe(false)
  })

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

  it('renders the history-load-failure card itself (the caller never owns the error UI)', async () => {
    vi.mocked(getSessionHistory).mockRejectedValue(new Error('rpc down'))
    await expect(reloadSessionHistory(SESSION)).resolves.toBeUndefined()
    // The failure card carries the freshness marker: SessionWorkspaceSelector
    // must never read it as a "confirmed empty" transcript (ADR-091).
    const cards = Object.values(useChatStore.getState().messages[SESSION] ?? {})
    expect(cards).toHaveLength(1)
    expect(cards[0]!.type).toBe('error')
    expect(cards[0]!.metadata).toEqual({ historyLoadFailed: true })
  })

  it('repeated load failures upsert ONE card under the deterministic per-session id', async () => {
    // The resync re-runs the loader on every focus/visibility/WS-reconnect
    // trigger while the history RPC stays down: each attempt must refresh the
    // one card instead of stacking a fresh one per trigger.
    vi.mocked(getSessionHistory).mockRejectedValue(new Error('rpc down'))
    await reloadSessionHistory(SESSION)
    await reloadSessionHistory(SESSION)
    await reloadSessionHistory(SESSION)

    const order = useChatStore.getState().messageOrder[SESSION] ?? []
    expect(order).toEqual([`history-load-failed:${SESSION}`])
  })

  it('a populated transcript never gets the failure card — the failure logs instead', async () => {
    // A resync failure beneath an already rendered transcript is transient:
    // appending the card would plant a false "history failed" card under a
    // fully rendered session.
    vi.mocked(getSessionHistory).mockRejectedValue(new Error('rpc down'))
    useChatStore.getState().addMessage(SESSION, liveMsg('history-1', 'user', 'hi'))

    await reloadSessionHistory(SESSION)

    const order = useChatStore.getState().messageOrder[SESSION] ?? []
    expect(order).toEqual(['history-1'])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('transcript already populated'),
    )
  })

  it('reportHistoryLoadFailure upserts the card for the reconcile phase too', () => {
    reportHistoryLoadFailure(SESSION, 'reconcile phase')
    reportHistoryLoadFailure(SESSION, 'reconcile phase')

    const order = useChatStore.getState().messageOrder[SESSION] ?? []
    expect(order).toEqual([`history-load-failed:${SESSION}`])
  })

  // --- historyLoaded marker (the ChatArea loading spinner) ---

  it('marks the session history-loaded after a successful load', async () => {
    vi.mocked(getSessionHistory).mockResolvedValue([row(1, 'user', 'hi')])

    await reloadSessionHistory(SESSION)

    expect(useChatStore.getState().historyLoaded.has(SESSION)).toBe(true)
  })

  it('marks the session history-loaded when the history RPC fails (the spinner must not hang)', async () => {
    // The load failure is settled inside the helper (the failure card), but
    // the wrapper's finally settles the marker either way.
    vi.mocked(getSessionHistory).mockRejectedValue(new Error('rpc down'))
    await reloadSessionHistory(SESSION)

    expect(useChatStore.getState().historyLoaded.has(SESSION)).toBe(true)
  })

  it('marks the session history-loaded for an empty history (the placeholder may take over)', async () => {
    vi.mocked(getSessionHistory).mockResolvedValue([])

    await reloadSessionHistory(SESSION)

    expect(useChatStore.getState().historyLoaded.has(SESSION)).toBe(true)
  })

  it('does not mark a cancelled attempt (its snapshot never reached the store)', async () => {
    let cancelled = false
    vi.mocked(getSessionHistory).mockImplementation(async () => {
      // The user switched sessions while the RPC was in flight.
      cancelled = true
      return [row(1, 'user', 'hi')]
    })

    await reloadSessionHistory(SESSION, { isCancelled: () => cancelled })

    // The next visit to the session must spin until its own load settles.
    expect(useChatStore.getState().historyLoaded.has(SESSION)).toBe(false)
  })
})
