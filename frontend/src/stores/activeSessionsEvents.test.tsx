// The `sessions:changed` → snapshot-refresh wiring lives in
// useActiveSessionsRefresh (the App-root cross-project snapshot loader), so
// the event has to be exercised through a real React root. jsdom environment;
// mirrors the useSessionLoader.test.tsx harness pattern.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SessionInfo } from '@/types/models'

const mocks = vi.hoisted(() => ({
  listAllSessionsMock: vi.fn<(...args: unknown[]) => Promise<SessionInfo[]>>(),
  // event name → subscribed callbacks, so tests can fire push events.
  subscribers: new Map<string, Array<(data: unknown) => void>>(),
}))

// Expected diagnostics of deliberately exercised failure paths (the api
// wrapper's error report and the store's quiet debug note) are intercepted
// here and asserted in the specific test that triggers them.
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/api/runtime', () => ({
  subscribe: (eventName: string, callback: (data: unknown) => void) => {
    const list = mocks.subscribers.get(eventName) ?? []
    list.push(callback)
    mocks.subscribers.set(eventName, list)
    return () => {
      const current = mocks.subscribers.get(eventName) ?? []
      mocks.subscribers.set(eventName, current.filter(cb => cb !== callback))
    }
  },
}))

vi.mock('@/api/sessions', () => ({
  listAllSessions: mocks.listAllSessionsMock,
}))

vi.mock('@/api/chat', () => ({
  getPendingActions: vi.fn(async () => null),
}))

vi.mock('@/lib/logger', () => ({ logger: loggerMocks, setLogLevel: vi.fn() }))

import {
  useActiveSessionsRefresh,
  useActiveSessionsStore,
  cancelPendingRefresh,
} from './activeSessionsStore'

let root: Root | undefined
let container: HTMLDivElement | undefined

function Harness() {
  useActiveSessionsRefresh()
  return null
}

function renderLoader() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<Harness />)
  })
}

function fireEvent(eventName: string, data: unknown) {
  const callbacks = mocks.subscribers.get(eventName) ?? []
  if (callbacks.length === 0) throw new Error(`no subscribers for ${eventName}`)
  act(() => {
    for (const cb of callbacks) cb(data)
  })
}

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

beforeEach(() => {
  mocks.subscribers.clear()
  mocks.listAllSessionsMock.mockReset()
  mocks.listAllSessionsMock.mockResolvedValue([])
  loggerMocks.debug.mockClear()
  loggerMocks.info.mockClear()
  loggerMocks.warn.mockClear()
  loggerMocks.error.mockClear()
  cancelPendingRefresh()
  useActiveSessionsStore.setState({ sessions: null, pendingOverride: {}, refreshing: false })
})

afterEach(() => {
  vi.useRealTimers()
  cancelPendingRefresh()
  if (root) {
    act(() => {
      root!.unmount()
    })
    root = undefined
  }
  container?.remove()
  container = undefined
})

describe('useActiveSessionsRefresh × sessions:changed', () => {
  it('refreshes the snapshot on sessions:changed through the debounce funnel', async () => {
    vi.useFakeTimers()
    renderLoader()
    // Consume the mount refresh first so the event-triggered one is isolated.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(mocks.listAllSessionsMock).toHaveBeenCalledTimes(1)

    const snapshot = [makeSession({ id: 'fresh', unfinished_task_status: 'in_progress', has_unfinished_task: true })]
    mocks.listAllSessionsMock.mockResolvedValue(snapshot)
    fireEvent('sessions:changed', undefined)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(mocks.listAllSessionsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(mocks.listAllSessionsMock).toHaveBeenCalledTimes(2)
    expect(useActiveSessionsStore.getState().sessions).toEqual(snapshot)
    expect(useActiveSessionsStore.getState().refreshing).toBe(false)
  })

  it('coalesces a burst of events into a single re-read', async () => {
    vi.useFakeTimers()
    renderLoader()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(mocks.listAllSessionsMock).toHaveBeenCalledTimes(1)

    fireEvent('sessions:changed', undefined)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    fireEvent('sessions:changed', undefined)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    fireEvent('sessions:changed', undefined)
    // Each event restarts the window: nothing has fired 400ms after the first
    // event; the single trailing fetch lands 500ms after the LAST one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(mocks.listAllSessionsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(mocks.listAllSessionsMock).toHaveBeenCalledTimes(2)
  })

  it('stops reacting after unmount', async () => {
    vi.useFakeTimers()
    renderLoader()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(mocks.listAllSessionsMock).toHaveBeenCalledTimes(1)

    act(() => {
      root!.unmount()
    })
    root = undefined
    // The subscription is gone: firing the event is a harness-level
    // no-subscribers error rather than a store write.
    expect(() => fireEvent('sessions:changed', undefined)).toThrow('no subscribers for sessions:changed')
    // And no event-triggered timer survives the teardown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(mocks.listAllSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the previous snapshot when the re-read fails, with the expected diagnostics', async () => {
    vi.useFakeTimers()
    const seeded = [makeSession({ id: 'seeded' })]
    mocks.listAllSessionsMock.mockResolvedValue(seeded)
    renderLoader()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(useActiveSessionsStore.getState().sessions).toEqual(seeded)

    mocks.listAllSessionsMock.mockRejectedValueOnce(new Error('rpc down'))
    fireEvent('sessions:changed', undefined)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    // A stale snapshot beats no snapshot: the failed re-read keeps the
    // previous list and clears the in-flight flag.
    expect(useActiveSessionsStore.getState().sessions).toEqual(seeded)
    expect(useActiveSessionsStore.getState().refreshing).toBe(false)
    // Expected diagnostics of the failure path, intercepted at their sources:
    // the store's quiet debug note fires exactly once (the api wrapper's
    // error report lives behind the mocked '@/api/sessions' and is covered by
    // that module's own tests).
    expect(loggerMocks.debug).toHaveBeenCalledTimes(1)
    expect(loggerMocks.debug).toHaveBeenCalledWith(
      'activeSessionsStore: refresh failed, keeping previous snapshot:',
      expect.any(Error),
    )
    expect(loggerMocks.error).not.toHaveBeenCalled()
    expect(loggerMocks.warn).not.toHaveBeenCalled()
  })
})
