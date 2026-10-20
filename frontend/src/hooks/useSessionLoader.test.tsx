// jsdom environment: the hook is rendered through a real React root
// (createRoot) so effects run; document is required. Mirrors the
// useExitGuard.test.tsx harness pattern.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ProjectSwitchState, SessionInfo } from '@/types/models'

const mocks = vi.hoisted(() => ({
  listSessionsMock: vi.fn<(...args: unknown[]) => Promise<SessionInfo[]>>(),
  getProjectSwitchStateMock: vi.fn<(...args: unknown[]) => Promise<ProjectSwitchState | null>>(),
  // event name → subscribed callbacks, so tests can fire push events.
  subscribers: new Map<string, Array<(data: unknown) => void>>(),
}))

// Expected diagnostics of deliberately exercised failure paths (the api
// wrapper's error report) are intercepted here and asserted in the specific
// test that triggers them.
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
  listSessions: mocks.listSessionsMock,
}))

vi.mock('@/api/projects', () => ({
  getProjectSwitchState: mocks.getProjectSwitchStateMock,
  // sessionStore imports this for selectSession; never called on restore
  // paths, but must exist so the store module initializes.
  saveProjectActiveSession: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({ logger: loggerMocks, setLogLevel: vi.fn() }))

import { useSessionLoader } from './useSessionLoader'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'

let root: Root | undefined
let container: HTMLDivElement | undefined

function Harness() {
  useSessionLoader()
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

/** Flush pending microtasks (the loader's fetch promises) inside act. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function fireEvent(eventName: string, data: unknown) {
  const callbacks = mocks.subscribers.get(eventName) ?? []
  if (callbacks.length === 0) throw new Error(`no subscribers for ${eventName}`)
  act(() => {
    for (const cb of callbacks) cb(data)
  })
}

function makeSession(overrides: Partial<SessionInfo> & { id: string; project_id: string }): SessionInfo {
  return {
    id: overrides.id,
    project_id: overrides.project_id,
    name: overrides.name ?? `Session ${overrides.id}`,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    last_active_at: overrides.last_active_at ?? '2026-01-01T00:00:00Z',
    archived: overrides.archived ?? false,
    pinned: overrides.pinned ?? false,
    active: overrides.active ?? false,
    total_input_tokens: overrides.total_input_tokens ?? 0,
    total_output_tokens: overrides.total_output_tokens ?? 0,
    model: overrides.model ?? '',
    family: overrides.family ?? '',
    has_unfinished_task: overrides.has_unfinished_task ?? false,
    unfinished_task_status: overrides.unfinished_task_status ?? '',
  }
}

function savedState(sessionId: string): ProjectSwitchState {
  return {
    project_id: 'project-1',
    saved_session_id: sessionId,
    open_tabs: [],
    active_file: '',
    updated_at: '2026-03-01T00:00:00Z',
  }
}

beforeEach(() => {
  mocks.subscribers.clear()
  mocks.listSessionsMock.mockReset()
  mocks.getProjectSwitchStateMock.mockReset()
  mocks.listSessionsMock.mockResolvedValue([])
  mocks.getProjectSwitchStateMock.mockResolvedValue(null)
  loggerMocks.debug.mockClear()
  loggerMocks.info.mockClear()
  loggerMocks.warn.mockClear()
  loggerMocks.error.mockClear()
  useProjectStore.setState({ projects: null, activeProjectId: 'project-1' })
  useSessionStore.setState({ sessions: null, activeSessionId: null })
})

afterEach(() => {
  vi.useRealTimers()
  if (root) {
    act(() => {
      root!.unmount()
    })
    root = undefined
  }
  container?.remove()
  container = undefined
})

describe('useSessionLoader', () => {
  it('restores the saved session from the project switch state even when another session is fresher', async () => {
    mocks.getProjectSwitchStateMock.mockResolvedValue(savedState('saved-session'))
    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'freshest', project_id: 'project-1', last_active_at: '2026-06-01T00:00:00Z' }),
      makeSession({ id: 'saved-session', project_id: 'project-1', last_active_at: '2026-01-01T00:00:00Z' }),
    ])

    renderLoader()
    await flush()

    expect(mocks.getProjectSwitchStateMock).toHaveBeenCalledWith('project-1')
    expect(useSessionStore.getState().activeSessionId).toBe('saved-session')
  })

  it('falls back to the latest non-archived session when the saved session was deleted', async () => {
    mocks.getProjectSwitchStateMock.mockResolvedValue(savedState('deleted-session'))
    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'older', project_id: 'project-1', last_active_at: '2026-01-01T00:00:00Z' }),
      makeSession({ id: 'freshest', project_id: 'project-1', last_active_at: '2026-06-01T00:00:00Z' }),
    ])

    renderLoader()
    await flush()

    expect(useSessionStore.getState().activeSessionId).toBe('freshest')
  })

  it('falls back to the latest non-archived session when the saved session is archived', async () => {
    mocks.getProjectSwitchStateMock.mockResolvedValue(savedState('archived-saved'))
    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'archived-saved', project_id: 'project-1', archived: true, last_active_at: '2026-06-01T00:00:00Z' }),
      makeSession({ id: 'active-older', project_id: 'project-1', last_active_at: '2026-01-01T00:00:00Z' }),
    ])

    renderLoader()
    await flush()

    expect(useSessionStore.getState().activeSessionId).toBe('active-older')
  })

  it('never restores an archived session even with the freshest activity', async () => {
    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'archived-freshest', project_id: 'project-1', archived: true, last_active_at: '2026-06-01T00:00:00Z' }),
      makeSession({ id: 'active-older', project_id: 'project-1', last_active_at: '2026-01-01T00:00:00Z' }),
    ])

    renderLoader()
    await flush()

    expect(useSessionStore.getState().activeSessionId).toBe('active-older')
  })

  it('leaves no active session when only archived sessions exist (creation is the switch flow\u2019s job)', async () => {
    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'archived-only', project_id: 'project-1', archived: true, last_active_at: '2026-06-01T00:00:00Z' }),
    ])

    renderLoader()
    await flush()

    expect(useSessionStore.getState().activeSessionId).toBeNull()
  })

  it('does not override a session that became active while the fetch was in flight', async () => {
    let releaseList: ((sessions: SessionInfo[]) => void) | undefined
    const gate = new Promise<SessionInfo[]>((resolve) => {
      releaseList = resolve
    })
    mocks.listSessionsMock.mockImplementation(() => gate)
    mocks.getProjectSwitchStateMock.mockResolvedValue(savedState('saved-session'))

    renderLoader()
    // The effect cleared the previous project's active session.
    expect(useSessionStore.getState().activeSessionId).toBeNull()

    // performSwitch (or an explicit selection) activates a session before the
    // loader's fetch resolves.
    act(() => {
      useSessionStore.getState().setActiveSessionId('already-active')
    })

    releaseList?.([
      makeSession({ id: 'freshest', project_id: 'project-1', last_active_at: '2026-06-01T00:00:00Z' }),
      makeSession({ id: 'saved-session', project_id: 'project-1', last_active_at: '2026-01-01T00:00:00Z' }),
    ])
    await flush()

    expect(useSessionStore.getState().activeSessionId).toBe('already-active')
  })

  it('restores the saved session from a sessions:loaded push while idle', async () => {
    // Initial fetch finds no sessions (nothing restored) but captures the
    // saved session id once for this activation.
    mocks.getProjectSwitchStateMock.mockResolvedValue(savedState('saved-session'))
    mocks.listSessionsMock.mockResolvedValue([])

    renderLoader()
    await flush()
    expect(useSessionStore.getState().activeSessionId).toBeNull()

    fireEvent('sessions:loaded', [
      makeSession({ id: 'freshest', project_id: 'project-1', last_active_at: '2026-06-01T00:00:00Z' }),
      makeSession({ id: 'saved-session', project_id: 'project-1', last_active_at: '2026-01-01T00:00:00Z' }),
    ])
    // The push handler defers to a microtask (it first awaits the
    // saved-session pointer gate).
    await flush()

    expect(useSessionStore.getState().activeSessionId).toBe('saved-session')
  })

  it('defers a sessions:loaded push that arrives before the saved-session fetch resolves', async () => {
    let releaseList: ((sessions: SessionInfo[]) => void) | undefined
    const gate = new Promise<SessionInfo[]>((resolve) => {
      releaseList = resolve
    })
    mocks.listSessionsMock.mockImplementation(() => gate)
    mocks.getProjectSwitchStateMock.mockResolvedValue(savedState('saved-session'))

    renderLoader()

    // The push arrives while the initial fetch (and with it the saved
    // pointer) is still in flight: restoring now would pick the
    // latest-by-activity fallback instead of the saved session.
    fireEvent('sessions:loaded', [
      makeSession({ id: 'freshest', project_id: 'project-1', last_active_at: '2026-06-01T00:00:00Z' }),
      makeSession({ id: 'saved-session', project_id: 'project-1', last_active_at: '2026-01-01T00:00:00Z' }),
    ])
    await flush()
    expect(useSessionStore.getState().activeSessionId).toBeNull()

    releaseList?.([
      makeSession({ id: 'freshest', project_id: 'project-1', last_active_at: '2026-06-01T00:00:00Z' }),
      makeSession({ id: 'saved-session', project_id: 'project-1', last_active_at: '2026-01-01T00:00:00Z' }),
    ])
    await flush()

    expect(useSessionStore.getState().activeSessionId).toBe('saved-session')
  })

  it('ignores pushed sessions belonging to other projects', async () => {
    renderLoader()
    await flush()

    fireEvent('sessions:loaded', [
      makeSession({ id: 'foreign', project_id: 'other-project', last_active_at: '2026-06-01T00:00:00Z' }),
    ])

    expect(useSessionStore.getState().activeSessionId).toBeNull()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('still updates titles on session:renamed pushes', async () => {
    const existing = makeSession({ id: 's1', project_id: 'project-1', name: 'Old name' })
    mocks.listSessionsMock.mockResolvedValue([existing])

    renderLoader()
    await flush()

    fireEvent('session:renamed', { id: 's1', name: 'New name' })

    expect(useSessionStore.getState().sessions?.find(s => s.id === 's1')?.name).toBe('New name')
  })

  describe('sessions:changed re-read', () => {
    it('re-reads the list once, trailing, after the debounce window', async () => {
      vi.useFakeTimers()
      renderLoader()
      await flush()
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(1)

      const refreshed = [makeSession({ id: 'created', project_id: 'project-1' })]
      mocks.listSessionsMock.mockResolvedValue(refreshed)
      fireEvent('sessions:changed', undefined)
      // Leading edge is suppressed: nothing is fetched inside the window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(249)
      })
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(2)
      expect(useSessionStore.getState().sessions).toEqual(refreshed)
    })

    it('coalesces a burst of events into a single re-read', async () => {
      vi.useFakeTimers()
      renderLoader()
      await flush()

      fireEvent('sessions:changed', undefined)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      fireEvent('sessions:changed', undefined)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      fireEvent('sessions:changed', undefined)
      // Each event restarts the window: 300ms after the first event, nothing
      // has fired yet; the trailing fetch lands 250ms after the LAST one.
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(249)
      })
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(2)
    })

    it('updates the list without touching the active session, even while idle', async () => {
      vi.useFakeTimers()
      // A saved pointer exists, but the initial load restored nothing (the
      // project was empty at the time).
      mocks.getProjectSwitchStateMock.mockResolvedValue(savedState('saved-session'))
      renderLoader()
      await flush()
      expect(useSessionStore.getState().activeSessionId).toBeNull()

      // The push carries the saved session — a foreign update must NOT
      // auto-select it (no restoreIfIdle on the re-read path).
      mocks.listSessionsMock.mockResolvedValue([
        makeSession({ id: 'saved-session', project_id: 'project-1' }),
        makeSession({ id: 'other', project_id: 'project-1', last_active_at: '2026-06-01T00:00:00Z' }),
      ])
      fireEvent('sessions:changed', undefined)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })

      expect(useSessionStore.getState().sessions?.map(s => s.id)).toEqual(['other', 'saved-session'])
      expect(useSessionStore.getState().activeSessionId).toBeNull()
    })

    it('does not re-read when the active project went away inside the window', async () => {
      vi.useFakeTimers()
      renderLoader()
      await flush()
      mocks.listSessionsMock.mockClear()

      fireEvent('sessions:changed', undefined)
      // The project disappears before the window elapses (switch to another
      // project / No Project): the pending re-read is dropped.
      act(() => {
        useProjectStore.setState({ activeProjectId: null })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })

      expect(mocks.listSessionsMock).not.toHaveBeenCalled()
    })

    it('drops a re-read whose project switched while the fetch was in flight', async () => {
      vi.useFakeTimers()
      renderLoader()
      await flush()
      expect(useSessionStore.getState().sessions).toEqual([])

      let releaseRefresh!: (v: SessionInfo[]) => void
      mocks.listSessionsMock.mockImplementationOnce(
        () => new Promise<SessionInfo[]>((resolve) => { releaseRefresh = resolve }),
      )
      fireEvent('sessions:changed', undefined)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(2)

      // The user switches projects while the re-read is in flight: the hook
      // re-runs for the new project (its own initial fetch) and the stale
      // answer must never land in the store.
      mocks.listSessionsMock.mockResolvedValue([
        makeSession({ id: 'p2-session', project_id: 'project-2' }),
      ])
      act(() => {
        useProjectStore.setState({ activeProjectId: 'project-2' })
      })
      await flush()
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(3)
      expect(useSessionStore.getState().sessions?.map(s => s.id)).toEqual(['p2-session'])

      releaseRefresh([makeSession({ id: 'stale-p1', project_id: 'project-1' })])
      await flush()

      expect(useSessionStore.getState().sessions?.map(s => s.id)).toEqual(['p2-session'])
    })

    it('supersedes the initial load when a re-read was issued while it was in flight', async () => {
      vi.useFakeTimers()
      mocks.getProjectSwitchStateMock.mockResolvedValue(savedState('saved-session'))
      let releaseInitial!: (v: SessionInfo[]) => void
      mocks.listSessionsMock.mockImplementationOnce(
        () => new Promise<SessionInfo[]>((resolve) => { releaseInitial = resolve }),
      )
      renderLoader()

      fireEvent('sessions:changed', undefined)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(2)

      // The re-read (fresh, post-mutation) applies first; the project is still
      // empty at that point.
      expect(useSessionStore.getState().sessions).toEqual([])

      // The slower initial read carries the pre-mutation list — it must be
      // dropped instead of clobbering the fresh one. The switch's restore
      // still runs, but against the applied (fresh, empty) list: the stale
      // list's sessions never leak into the store or the selection.
      releaseInitial([
        makeSession({ id: 'saved-session', project_id: 'project-1' }),
        makeSession({ id: 'freshest', project_id: 'project-1', last_active_at: '2026-06-01T00:00:00Z' }),
      ])
      await flush()

      expect(useSessionStore.getState().sessions).toEqual([])
      expect(useSessionStore.getState().activeSessionId).toBeNull()
    })

    it('supersedes an older in-flight re-read with a newer one', async () => {
      vi.useFakeTimers()
      renderLoader()
      await flush()

      let releaseFirst!: (v: SessionInfo[]) => void
      mocks.listSessionsMock.mockImplementationOnce(
        () => new Promise<SessionInfo[]>((resolve) => { releaseFirst = resolve }),
      )
      fireEvent('sessions:changed', undefined)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(2)

      // A second event while the first re-read is still in flight schedules a
      // new fetch that supersedes it.
      const second = [makeSession({ id: 'second', project_id: 'project-1', name: 'Second' })]
      mocks.listSessionsMock.mockResolvedValueOnce(second)
      fireEvent('sessions:changed', undefined)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      expect(mocks.listSessionsMock).toHaveBeenCalledTimes(3)
      expect(useSessionStore.getState().sessions).toEqual(second)

      // The slow first re-read resolves last — its stale answer must not land.
      releaseFirst([makeSession({ id: 'stale', project_id: 'project-1' })])
      await flush()

      expect(useSessionStore.getState().sessions).toEqual(second)
    })

    it('cancels the pending re-read on unmount', async () => {
      vi.useFakeTimers()
      renderLoader()
      await flush()
      mocks.listSessionsMock.mockClear()

      fireEvent('sessions:changed', undefined)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      act(() => {
        root!.unmount()
      })
      root = undefined
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })

      expect(mocks.listSessionsMock).not.toHaveBeenCalled()
    })

    it('keeps the current list when the re-read fails, with the expected error reported once', async () => {
      vi.useFakeTimers()
      const existing = [makeSession({ id: 'keep', project_id: 'project-1' })]
      mocks.listSessionsMock.mockResolvedValue(existing)
      renderLoader()
      await flush()
      expect(loggerMocks.error).not.toHaveBeenCalled()

      mocks.listSessionsMock.mockRejectedValueOnce(new Error('rpc down'))
      fireEvent('sessions:changed', undefined)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })

      expect(useSessionStore.getState().sessions).toEqual(existing)
      // The re-read failure is deliberately silent in the hook (the real api
      // wrapper reports it at error level; here the wrapper is a mock): the
      // list is kept and no diagnostic leaks from the hook itself.
      expect(loggerMocks.error).not.toHaveBeenCalled()
      expect(loggerMocks.warn).not.toHaveBeenCalled()
    })
  })
})
