// Tests for useShallowResync — the app-root shallow resync triggers.
//
// Coverage: trigger wiring (WS re-connect, window focus, visibilitychange→
// visible), readiness arming (useGitFocusRefresh pattern), the debounce +
// min-interval gates, the three resync legs (session history, session list,
// live-sessions snapshot + pending sweep), and the switch-race guards.

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// --- Mock the backend boundary so tests never touch a real transport/RPC ---
const {
  isWailsReadyMock,
  subscribeMock,
  onWSReconnectedMock,
  listSessionsMock,
  listAllSessionsMock,
  getSessionHistoryMock,
  getPendingActionsMock,
} = vi.hoisted(() => ({
  isWailsReadyMock: vi.fn((): boolean => false),
  subscribeMock: vi.fn((_name: string, _handler: () => void) => () => {}),
  onWSReconnectedMock: vi.fn((_cb: () => void) => () => {}),
  listSessionsMock: vi.fn((): Promise<unknown> => Promise.resolve([])),
  listAllSessionsMock: vi.fn((): Promise<unknown> => Promise.resolve([])),
  getSessionHistoryMock: vi.fn((): Promise<unknown> => Promise.resolve([])),
  getPendingActionsMock: vi.fn((): Promise<null> => Promise.resolve(null)),
}))

vi.mock('@/api/runtime', () => ({
  isWailsReady: isWailsReadyMock,
  subscribe: subscribeMock,
  onWSReconnected: onWSReconnectedMock,
}))
vi.mock('@/api/sessions', () => ({
  listSessions: listSessionsMock,
  listAllSessions: listAllSessionsMock,
}))
vi.mock('@/api/chat', () => ({
  getSessionHistory: getSessionHistoryMock,
  getSessionRuntimeStatus: vi.fn((): Promise<null> => Promise.resolve(null)),
  getPendingActions: getPendingActionsMock,
  resolveStalePrompt: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { useShallowResync } from './useShallowResync'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { useChatStore } from '@/stores/chatStore'
import { useActiveSessionsStore } from '@/stores/activeSessionsStore'
import type { SessionInfo } from '@/types/models'

/** Handlers captured from the runtime subscription mocks. */
const readyHandlers = new Set<() => void>()
let wsReconnectedHandler: (() => void) | null = null

let root: Root | null = null
let container: HTMLDivElement | null = null

function Harness(): null {
  useShallowResync()
  return null
}

function renderHook(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  act(() => {
    r.render(createElement(Harness))
  })
}

function unmountHook(): void {
  if (!root) return
  const r = root
  root = null
  act(() => {
    r.unmount()
  })
  container?.remove()
  container = null
}

/** Let the fire-and-forget promise chains settle past the store writes. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function fireBackendReady(): void {
  act(() => {
    for (const handler of Array.from(readyHandlers)) handler()
  })
}

function fireWSReconnected(): void {
  act(() => {
    wsReconnectedHandler?.()
  })
}

function fireFocus(): void {
  act(() => {
    window.dispatchEvent(new Event('focus'))
  })
}

function fireVisibilityChange(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function makeSession(id: string, project_id: string): SessionInfo {
  return {
    id,
    name: `Session ${id}`,
    project_id,
    created_at: '2026-01-01T00:00:00Z',
    last_active_at: '2026-01-01T00:00:00Z',
    archived: false,
    pinned: false,
    has_unfinished_task: true,
    unfinished_task_status: 'in_progress',
  } as SessionInfo
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  isWailsReadyMock.mockClear()
  subscribeMock.mockClear()
  onWSReconnectedMock.mockClear()
  listSessionsMock.mockClear()
  listAllSessionsMock.mockClear()
  getSessionHistoryMock.mockClear()
  getPendingActionsMock.mockClear()
  isWailsReadyMock.mockReturnValue(false)
  subscribeMock.mockImplementation((_name: string, handler: () => void) => {
    readyHandlers.add(handler)
    return () => {
      readyHandlers.delete(handler)
    }
  })
  onWSReconnectedMock.mockImplementation((cb: () => void) => {
    wsReconnectedHandler = cb
    return () => {
      wsReconnectedHandler = null
    }
  })
  listSessionsMock.mockResolvedValue([])
  listAllSessionsMock.mockResolvedValue([])
  getSessionHistoryMock.mockResolvedValue([])
  getPendingActionsMock.mockResolvedValue(null)

  useSessionStore.setState({ sessions: null, activeSessionId: null })
  useProjectStore.setState({ activeProjectId: null })
  useChatStore.setState({
    messages: {},
    messageOrder: {},
    streamingText: {},
    runtimeEventAt: {},
    taskActive: {},
    activityStatus: {},
    paused: {},
    pausing: {},
  })
  useActiveSessionsStore.setState({ sessions: null, pendingOverride: {} })
})

afterEach(() => {
  unmountHook()
  vi.useRealTimers()
  subscribeMock.mockReset()
  onWSReconnectedMock.mockReset()
  // The debounced resync timer dies with the fake timers; make sure a
  // store-level debounce cannot leak either.
  Reflect.deleteProperty(document, 'visibilityState')
})

describe('useShallowResync', () => {
  it('arms only after runtime readiness; the WS-reconnect trigger works before that', async () => {
    useSessionStore.setState({ activeSessionId: 's1' })
    useProjectStore.setState({ activeProjectId: 'p1' })
    renderHook()

    // Armed but not listening yet: a focus event before backend:ready is a
    // no-op (the RPCs would be guaranteed failures during the splash phase).
    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).not.toHaveBeenCalled()

    // The WS-reconnect trigger needs no arming — it only fires once the
    // event socket exists, which already implies readiness.
    fireWSReconnected()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).toHaveBeenCalledWith('s1')
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(listAllSessionsMock).toHaveBeenCalledTimes(1)

    // backend:ready attaches the focus/visibility listeners.
    expect(subscribeMock).toHaveBeenCalledWith('backend:ready', expect.any(Function))
    // Past the min-interval of the WS-triggered run, focus drives a new one.
    await vi.advanceTimersByTimeAsync(5600)
    fireBackendReady()
    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).toHaveBeenCalledTimes(2)
  })

  it('wires the Wails-ready short-circuit when the bridge is already live', async () => {
    isWailsReadyMock.mockReturnValue(true)
    useSessionStore.setState({ activeSessionId: 's1' })
    renderHook()

    // No backend:ready subscription — the listeners attach immediately.
    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).toHaveBeenCalledWith('s1')
    expect(subscribeMock).not.toHaveBeenCalled()
  })

  it('focus runs all three resync legs and applies the session list', async () => {
    useSessionStore.setState({ activeSessionId: 's1' })
    useProjectStore.setState({ activeProjectId: 'p1' })
    listSessionsMock.mockResolvedValue([makeSession('s1', 'p1')])
    renderHook()
    fireBackendReady()

    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()

    expect(getSessionHistoryMock).toHaveBeenCalledWith('s1')
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().sessions).toEqual([makeSession('s1', 'p1')])
    expect(listAllSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('visibilitychange to visible triggers; hidden does not', async () => {
    useSessionStore.setState({ activeSessionId: 's1' })
    renderHook()
    fireBackendReady()

    fireVisibilityChange('hidden')
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).not.toHaveBeenCalled()

    fireVisibilityChange('visible')
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).toHaveBeenCalledWith('s1')
  })

  it('a trigger burst coalesces into one debounced run', async () => {
    useSessionStore.setState({ activeSessionId: 's1' })
    useProjectStore.setState({ activeProjectId: 'p1' })
    renderHook()
    fireBackendReady()

    fireFocus()
    fireFocus()
    fireWSReconnected()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()

    expect(getSessionHistoryMock).toHaveBeenCalledTimes(1)
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    // A later trigger inside the run's min-interval window is dropped too —
    // no second run either way.
    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).toHaveBeenCalledTimes(1)
  })

  it('drops triggers inside the min-interval after a run, and runs again after it', async () => {
    useSessionStore.setState({ activeSessionId: 's1' })
    renderHook()
    fireBackendReady()

    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).toHaveBeenCalledTimes(1)

    // Well inside the 5s min-interval: dropped entirely.
    await vi.advanceTimersByTimeAsync(500)
    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).toHaveBeenCalledTimes(1)

    // Past the min-interval the next trigger runs again.
    await vi.advanceTimersByTimeAsync(5600)
    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).toHaveBeenCalledTimes(2)
  })

  it('a session switch mid-flight discards the history leg without writing the store', async () => {
    useSessionStore.setState({ activeSessionId: 's1' })
    useProjectStore.setState({ activeProjectId: 'p1' })
    getSessionHistoryMock.mockImplementation(async () => {
      // The user switches away while the RPC is in flight.
      useSessionStore.getState().setActiveSessionId('s2')
      return [
        {
          id: 1, session_id: 's1', role: 'user', content: 'stale',
          metadata: undefined, created_at: '2026-01-01T00:00:00Z',
        },
      ]
    })
    renderHook()
    fireBackendReady()

    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()

    // The load was for s1; the switch to s2 cancelled it — nothing written.
    expect(useChatStore.getState().messageOrder['s1']).toBeUndefined()
  })

  it('a project switch mid-flight keeps the old list off the store', async () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    useSessionStore.setState({ activeSessionId: 's1' })
    listSessionsMock.mockImplementation(async () => {
      useProjectStore.getState().setActiveProjectId('p2')
      return [makeSession('stale', 'p1')]
    })
    renderHook()
    fireBackendReady()

    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()

    expect(useSessionStore.getState().sessions).toBeNull()
  })

  it('sweeps GetPendingActions for live sessions after the snapshot refresh', async () => {
    useSessionStore.setState({ activeSessionId: 's1' })
    useChatStore.setState({ taskActive: { bg: true } })
    listAllSessionsMock.mockResolvedValue([makeSession('bg', 'p1')])
    renderHook()
    fireBackendReady()

    fireFocus()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()

    // The sweep reads the CURRENT snapshot, so the refresh must land first:
    // the pending probe for the live background session proves both the
    // ordering and that the sweep leg is wired.
    expect(getPendingActionsMock).toHaveBeenCalledWith('bg')
  })

  it('unsubscribes everything and drops the pending timer on unmount', async () => {
    useSessionStore.setState({ activeSessionId: 's1' })
    renderHook()
    fireBackendReady()

    const readyUnsubs = subscribeMock.mock.results.filter((r) => r.type === 'return').length
    expect(readyUnsubs).toBeGreaterThan(0)
    const offWS = onWSReconnectedMock.mock.results[0]?.value as (() => void) | undefined
    expect(typeof offWS).toBe('function')

    // A trigger lands inside the debounce window; unmount must cancel it.
    fireFocus()
    unmountHook()
    await vi.advanceTimersByTimeAsync(400)
    await flushMicrotasks()
    expect(getSessionHistoryMock).not.toHaveBeenCalled()
  })
})
