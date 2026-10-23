// Unit tests for stores/activeSessionsStore.ts — debounced refresh, error
// resilience, in-flight dedup, pending override.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/api/sessions', () => ({
  listAllSessions: vi.fn(),
}))
vi.mock('@/api/chat', () => ({
  getPendingActions: vi.fn(async () => null),
}))

// Minimal chatStore fake: the sweep reads the five live slices via getState();
// tests seed them directly to simulate chatStore-confirmed HITL cards (same
// pattern as useBackgroundSessionWatcher.test.ts).
const chatStoreState = vi.hoisted(
 () =>
   ({
     taskActive: {},
     paused: {},
     messageOrder: {},
     messages: {},
     unfinishedTaskStatus: {},
   }) as {
     taskActive: Record<string, boolean>
     paused: Record<string, boolean>
     messageOrder: Record<string, string[]>
     messages: Record<string, Record<string, ChatMessageUI>>
     unfinishedTaskStatus: Record<string, string>
   },
)
vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => chatStoreState,
    setState: (partial: Partial<typeof chatStoreState>) => Object.assign(chatStoreState, partial),
  },
}))

import { listAllSessions } from '@/api/sessions'
import { getPendingActions } from '@/api/chat'
import {
  useActiveSessionsStore,
  cancelPendingRefresh,
  sweepPendingActions,
} from './activeSessionsStore'
import type { SessionInfo } from '@/types/models'
import type { ChatMessageUI } from '@/types/messages'

const mockedList = vi.mocked(listAllSessions)
const mockedGetPendingActions = vi.mocked(getPendingActions)

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-1',
    project_id: 'p1',
    name: 'Session',
    created_at: new Date(0).toISOString(),
    last_active_at: new Date(0).toISOString(),
    archived: false,
    pinned: false,
    active: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: '',
    family: '',
    has_unfinished_task: false,
    unfinished_task_status: '',
    ...overrides,
  }
}

/** Unresolved HITL card (ask_user) — metadata.resolved is absent, so
 *  hasUnresolvedHITL counts it as pending. */
function hitlCard(sessionId: string, id: string): ChatMessageUI {
  return { id, sessionId, type: 'ask_user', content: '', timestamp: 0 }
}

function resetStore(): void {
  cancelPendingRefresh()
  useActiveSessionsStore.setState({ sessions: null, pendingOverride: {}, refreshing: false })
  chatStoreState.taskActive = {}
  chatStoreState.paused = {}
  chatStoreState.messageOrder = {}
  chatStoreState.messages = {}
  chatStoreState.unfinishedTaskStatus = {}
}

describe('activeSessionsStore', () => {
  beforeEach(() => {
    mockedList.mockReset()
    mockedGetPendingActions.mockReset()
    mockedGetPendingActions.mockResolvedValue(null)
    resetStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with a null snapshot and no override', () => {
    const s = useActiveSessionsStore.getState()
    expect(s.sessions).toBeNull()
    expect(s.pendingOverride).toEqual({})
    expect(s.refreshing).toBe(false)
  })

  describe('refresh (debounced)', () => {
    it('coalesces rapid calls into a single RPC after the window', async () => {
      vi.useFakeTimers()
      mockedList.mockResolvedValue([])

      useActiveSessionsStore.getState().refresh()
      useActiveSessionsStore.getState().refresh()
      useActiveSessionsStore.getState().refresh()

      await vi.advanceTimersByTimeAsync(499)
      expect(mockedList).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(mockedList).toHaveBeenCalledTimes(1)
      expect(useActiveSessionsStore.getState().sessions).toEqual([])
    })

    it('restarts the window on each call (trailing debounce)', async () => {
      vi.useFakeTimers()
      mockedList.mockResolvedValue([])

      useActiveSessionsStore.getState().refresh()
      await vi.advanceTimersByTimeAsync(300)
      useActiveSessionsStore.getState().refresh()
      await vi.advanceTimersByTimeAsync(300)
      // 600 ms since the FIRST call, but only 300 since the last — not yet.
      expect(mockedList).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(200)
      expect(mockedList).toHaveBeenCalledTimes(1)
    })

    it('cancelPendingRefresh drops a scheduled refresh', async () => {
      vi.useFakeTimers()
      mockedList.mockResolvedValue([])

      useActiveSessionsStore.getState().refresh()
      cancelPendingRefresh()
      await vi.advanceTimersByTimeAsync(1000)

      expect(mockedList).not.toHaveBeenCalled()
    })
  })

  describe('refreshNow (immediate)', () => {
    it('loads the snapshot immediately and tracks refreshing', async () => {
      const snapshot = [makeSession({ id: 'a' }), makeSession({ id: 'b' })]
      let resolveList!: (v: SessionInfo[]) => void
      mockedList.mockReturnValue(new Promise<SessionInfo[]>((r) => { resolveList = r }))

      const promise = useActiveSessionsStore.getState().refreshNow()
      expect(useActiveSessionsStore.getState().refreshing).toBe(true)

      resolveList(snapshot)
      await promise

      const s = useActiveSessionsStore.getState()
      expect(s.sessions).toEqual(snapshot)
      expect(s.refreshing).toBe(false)
    })

    it('an RPC error preserves the previous snapshot and never rejects', async () => {
      const previous = [makeSession({ id: 'keep-me' })]
      useActiveSessionsStore.setState({ sessions: previous })
      mockedList.mockRejectedValue(new Error('backend gone'))

      await expect(useActiveSessionsStore.getState().refreshNow()).resolves.toBeUndefined()

      const s = useActiveSessionsStore.getState()
      expect(s.sessions).toEqual(previous)
      expect(s.refreshing).toBe(false)
    })

    it('recovers on the next refresh after a failure', async () => {
      mockedList.mockRejectedValueOnce(new Error('transient'))
      await useActiveSessionsStore.getState().refreshNow()

      const fresh = [makeSession({ id: 'back' })]
      mockedList.mockResolvedValueOnce(fresh)
      await useActiveSessionsStore.getState().refreshNow()

      expect(useActiveSessionsStore.getState().sessions).toEqual(fresh)
    })

    it('deduplicates concurrent calls into one RPC', async () => {
      const snapshot = [makeSession()]
      let resolveList!: (v: SessionInfo[]) => void
      mockedList.mockImplementation(() => new Promise<SessionInfo[]>((r) => { resolveList = r }))

      const first = useActiveSessionsStore.getState().refreshNow()
      const second = useActiveSessionsStore.getState().refreshNow()
      resolveList(snapshot)
      await Promise.all([first, second])

      expect(mockedList).toHaveBeenCalledTimes(1)
      expect(useActiveSessionsStore.getState().sessions).toEqual(snapshot)
    })

    it('a debounced refresh following an in-flight one still runs', async () => {
      vi.useFakeTimers()
      let calls = 0
      let resolveFirst!: (v: SessionInfo[]) => void
      mockedList.mockImplementation(() => {
        calls++
        // Only the FIRST RPC is held; later ones resolve immediately so no
        // in-flight promise leaks into the next test.
        if (calls === 1) return new Promise<SessionInfo[]>((r) => { resolveFirst = r })
        return Promise.resolve([makeSession({ id: 'second' })])
      })

      const immediate = useActiveSessionsStore.getState().refreshNow()
      useActiveSessionsStore.getState().refresh() // scheduled behind the in-flight one
      resolveFirst([makeSession({ id: 'first' })])
      await immediate

      await vi.advanceTimersByTimeAsync(500)
      expect(mockedList).toHaveBeenCalledTimes(2)
      expect(useActiveSessionsStore.getState().sessions).toEqual([makeSession({ id: 'second' })])
    })
  })

  describe('pendingOverride', () => {
    it('setPendingOverride(true) records the bit and is idempotent', () => {
      const { setPendingOverride } = useActiveSessionsStore.getState()
      setPendingOverride('s1', true)
      const afterFirst = useActiveSessionsStore.getState().pendingOverride
      expect(afterFirst).toEqual({ s1: true })

      setPendingOverride('s1', true)
      expect(useActiveSessionsStore.getState().pendingOverride).toBe(afterFirst) // same reference
    })

    it('setPendingOverride(false) deletes the key', () => {
      useActiveSessionsStore.getState().setPendingOverride('s1', true)
      useActiveSessionsStore.getState().setPendingOverride('s1', false)
      expect(useActiveSessionsStore.getState().pendingOverride).toEqual({})
    })

    it('setPendingOverride(false) on an absent key is a no-op (same reference)', () => {
      const before = useActiveSessionsStore.getState().pendingOverride
      useActiveSessionsStore.getState().setPendingOverride('ghost', false)
      expect(useActiveSessionsStore.getState().pendingOverride).toBe(before)
    })

    it('applyPendingActions maps a response with prompts to true', () => {
      useActiveSessionsStore.getState().applyPendingActions('s1', {
        tool_confirms: [],
        step_limits: [],
        plan_approvals: [],
        ask_user: [{ request_id: 'r1', questions: [] }],
        goal_proposals: [],
          goal_suggestions: [],
      })
      expect(useActiveSessionsStore.getState().pendingOverride).toEqual({ s1: true })
    })

    it('applyPendingActions maps an empty response to false (key removed)', () => {
      useActiveSessionsStore.getState().setPendingOverride('s1', true)
      useActiveSessionsStore.getState().applyPendingActions('s1', {
        tool_confirms: [],
        step_limits: [],
        plan_approvals: [],
        ask_user: [],
        goal_proposals: [],
          goal_suggestions: [],
      })
      expect(useActiveSessionsStore.getState().pendingOverride).toEqual({})
    })

    it('applyPendingActions maps a null response (RPC failure) to false', () => {
      useActiveSessionsStore.getState().setPendingOverride('s1', true)
      useActiveSessionsStore.getState().applyPendingActions('s1', null)
      expect(useActiveSessionsStore.getState().pendingOverride).toEqual({})
    })
  })

  describe('clearUnfinishedTask', () => {
    it('clears the matching session status and flag, leaving others untouched', () => {
      useActiveSessionsStore.setState({
        sessions: [
          makeSession({ id: 'a', has_unfinished_task: true, unfinished_task_status: 'failed' }),
          makeSession({ id: 'b', has_unfinished_task: true, unfinished_task_status: 'in_progress' }),
        ],
      })

      useActiveSessionsStore.getState().clearUnfinishedTask('a')

      const sessions = useActiveSessionsStore.getState().sessions!
      expect(sessions.find((s) => s.id === 'a')).toMatchObject({
        has_unfinished_task: false,
        unfinished_task_status: '',
      })
      expect(sessions.find((s) => s.id === 'b')).toMatchObject({
        has_unfinished_task: true,
        unfinished_task_status: 'in_progress',
      })
    })

    it('no-ops (same reference) for an unknown session', () => {
      useActiveSessionsStore.setState({
        sessions: [makeSession({ id: 'a', unfinished_task_status: 'failed' })],
      })
      const before = useActiveSessionsStore.getState().sessions

      useActiveSessionsStore.getState().clearUnfinishedTask('ghost')

      expect(useActiveSessionsStore.getState().sessions).toBe(before)
    })

    it('no-ops (same reference) when the session already carries no unfinished task', () => {
      useActiveSessionsStore.setState({ sessions: [makeSession({ id: 'a' })] })
      const before = useActiveSessionsStore.getState().sessions

      useActiveSessionsStore.getState().clearUnfinishedTask('a')

      expect(useActiveSessionsStore.getState().sessions).toBe(before)
    })

    it('no-ops before the snapshot loads', () => {
      useActiveSessionsStore.getState().clearUnfinishedTask('a')
      expect(useActiveSessionsStore.getState().sessions).toBeNull()
    })

    it('a read that started before the clear is dropped and re-read', async () => {
      // Resume-Cancel path: a snapshot read already in flight (poll / switch)
      // predates the local clear and must not overwrite it; the guard drops it
      // and re-reads, so the caller's await ends on the authoritative value.
      const stale = [makeSession({ id: 'a', has_unfinished_task: true, unfinished_task_status: 'failed' })]
      const fresh = [makeSession({ id: 'a' })]
      useActiveSessionsStore.setState({ sessions: stale })
      let resolveStale!: (v: SessionInfo[]) => void
      mockedList.mockImplementationOnce(() => new Promise<SessionInfo[]>((r) => { resolveStale = r }))
      mockedList.mockResolvedValueOnce(fresh)

      const pendingFetch = useActiveSessionsStore.getState().refreshNow()
      useActiveSessionsStore.getState().clearUnfinishedTask('a')
      resolveStale(stale)
      await pendingFetch

      expect(mockedList).toHaveBeenCalledTimes(2)
      const sessions = useActiveSessionsStore.getState().sessions!
      expect(sessions.find((s) => s.id === 'a')).toMatchObject({
        has_unfinished_task: false,
        unfinished_task_status: '',
      })
      expect(useActiveSessionsStore.getState().refreshing).toBe(false)
    })
  })

  describe('sweepPendingActions', () => {
    it('queries live sessions whose pending state is unknown or override-only', async () => {
      useActiveSessionsStore.setState({
        sessions: [
          makeSession({ id: 'unknown', unfinished_task_status: 'in_progress' }),
          makeSession({ id: 'override-only', unfinished_task_status: 'in_progress' }),
          makeSession({ id: 'idle' }),
        ],
        pendingOverride: { 'override-only': true },
      })

      await sweepPendingActions()

      expect(mockedGetPendingActions).toHaveBeenCalledTimes(2)
      expect(mockedGetPendingActions).toHaveBeenCalledWith('unknown')
      expect(mockedGetPendingActions).toHaveBeenCalledWith('override-only')
    })

    it('skips chatStore-confirmed pending rows — even when an override bit exists', async () => {
      chatStoreState.messageOrder = { live: ['m1'], both: ['m2'] }
      chatStoreState.messages = {
        live: { m1: hitlCard('live', 'm1') },
        both: { m2: hitlCard('both', 'm2') },
      }
      useActiveSessionsStore.setState({
        sessions: [
          makeSession({ id: 'live', unfinished_task_status: 'in_progress' }),
          makeSession({ id: 'both', unfinished_task_status: 'in_progress' }),
        ],
        pendingOverride: { both: true },
      })

      await sweepPendingActions()

      // Both rows settle through hitl_resolved, not this sweep — no RPC.
      expect(mockedGetPendingActions).not.toHaveBeenCalled()
      expect(useActiveSessionsStore.getState().pendingOverride).toEqual({ both: true })
    })

    it('heals a stale override bit when the backend answers a definitive no-pending', async () => {
      useActiveSessionsStore.setState({
        sessions: [makeSession({ id: 's1', unfinished_task_status: 'in_progress' })],
        pendingOverride: { s1: true },
      })
      // A REAL empty response — the genuine all-empty heal case, not an RPC
      // failure wearing its shape.
      mockedGetPendingActions.mockResolvedValue({
        tool_confirms: [],
        step_limits: [],
        plan_approvals: [],
        ask_user: [],
        goal_proposals: [],
        goal_suggestions: [],
      })

      await sweepPendingActions()

      expect(useActiveSessionsStore.getState().pendingOverride).toEqual({})
    })

    it('a failed poll (null) preserves the override bit — it is not an answer', async () => {
      useActiveSessionsStore.setState({
        sessions: [makeSession({ id: 's1', unfinished_task_status: 'in_progress' })],
        pendingOverride: { s1: true },
      })
      mockedGetPendingActions.mockResolvedValue(null)
      const overrideBefore = useActiveSessionsStore.getState().pendingOverride

      await sweepPendingActions()

      // The RPC failed; the sweep applied nothing. Clearing the bit here
      // would flip a genuinely-blocked session's radar dot off, and the
      // signal may not heal until the next sweep or dropdown open.
      expect(useActiveSessionsStore.getState().pendingOverride).toEqual({ s1: true })
      expect(useActiveSessionsStore.getState().pendingOverride).toBe(overrideBefore)
    })

    it('re-confirms a really-pending override-only row without reference flapping', async () => {
      useActiveSessionsStore.setState({
        sessions: [makeSession({ id: 's1', unfinished_task_status: 'in_progress' })],
        pendingOverride: { s1: true },
      })
      mockedGetPendingActions.mockResolvedValue({
        tool_confirms: [],
        step_limits: [],
        plan_approvals: [],
        ask_user: [{ request_id: 'r1', questions: [] }],
        goal_proposals: [],
        goal_suggestions: [],
      })
      const sessionsBefore = useActiveSessionsStore.getState().sessions

      await sweepPendingActions()
      const afterFirst = useActiveSessionsStore.getState().pendingOverride
      await sweepPendingActions()

      // Every sweep re-polled the override-only row and it stayed pending.
      expect(mockedGetPendingActions).toHaveBeenCalledTimes(2)
      expect(afterFirst).toEqual({ s1: true })
      // Re-confirming true is a no-op set — the record reference survives
      // (React #185), and the untouched sessions snapshot does too.
      expect(useActiveSessionsStore.getState().pendingOverride).toBe(afterFirst)
      expect(useActiveSessionsStore.getState().sessions).toBe(sessionsBefore)
    })

    it('applies a pending response as the override for that session', async () => {
      useActiveSessionsStore.setState({
        sessions: [makeSession({ id: 's1', unfinished_task_status: 'in_progress' })],
      })
      mockedGetPendingActions.mockResolvedValue({
        tool_confirms: [],
        step_limits: [],
        plan_approvals: [],
        ask_user: [{ request_id: 'r1', questions: [] }],
        goal_proposals: [],
          goal_suggestions: [],
      })

      await sweepPendingActions()

      expect(useActiveSessionsStore.getState().pendingOverride).toEqual({ s1: true })
    })
  })

  describe('selector stability (React #185)', () => {
    it('state fields are references that only change on real updates', async () => {
      const snapshot = [makeSession()]
      mockedList.mockResolvedValue(snapshot)

      await useActiveSessionsStore.getState().refreshNow()
      const s1 = useActiveSessionsStore.getState()
      const sessionsRef = s1.sessions
      const overrideRef = s1.pendingOverride

      // Unrelated update (pendingOverride) must not touch the sessions ref.
      s1.setPendingOverride('x', true)
      const s2 = useActiveSessionsStore.getState()
      expect(s2.sessions).toBe(sessionsRef)
      expect(s2.pendingOverride).not.toBe(overrideRef)

      // A no-op override update must not allocate a new record either.
      const overrideRef2 = s2.pendingOverride
      s2.setPendingOverride('x', true)
      expect(useActiveSessionsStore.getState().pendingOverride).toBe(overrideRef2)
    })
  })
})
