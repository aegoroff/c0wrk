// @vitest-environment jsdom
// Tests for usePromptSuggestionsSync — every refetch trigger of the
// promptSuggestionsStore. Session switch / project switch / session creation
// (an activating create is an activeSessionId change) and the session-less
// project surface (the empty session key — fresh start / last session
// deleted) go through the load effect; the session-scoped
// `prompt_suggestions` event goes through
// refetch(). Malformed payloads are dropped at the boundary; the hook never
// applies the event's raw both-kinds set.
//
// Follows the createRoot + jsdom harness pattern (see useE2SStateEvents.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const getPromptSuggestionsMock = vi.hoisted(() => vi.fn())
const runtimeHandlers = vi.hoisted(() => new Map<string, Array<(data: unknown) => void>>())
const reportDroppedEventMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/runtime', () => ({
  onSessionEvent: (sessionId: string, event: string, cb: (data: unknown) => void) => {
    const key = `${sessionId}:${event}`
    const list = runtimeHandlers.get(key) ?? []
    list.push(cb)
    runtimeHandlers.set(key, list)
    return () => {
      runtimeHandlers.set(key, (runtimeHandlers.get(key) ?? []).filter(fn => fn !== cb))
    }
  },
  reportDroppedEvent: reportDroppedEventMock,
}))
vi.mock('@/api/suggestions', () => ({
  getPromptSuggestions: getPromptSuggestionsMock,
}))

import { usePromptSuggestionsSync } from '@/hooks/usePromptSuggestionsSync'
import { usePromptSuggestionsStore } from '@/stores/promptSuggestionsStore'
import { useProjectStore } from '@/stores/projectStore'
import type { ProjectInfo } from '@/types/models'
import type { PromptSuggestionsResponse } from '@/api/suggestions'

const SESSION = 'sess-1'
const OTHER = 'sess-2'

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: 'proj-1',
    name: 'Project One',
    workspace_path: '/tmp/proj-1',
    is_external: false,
    is_no_project: false,
    created_at: '2026-10-17T09:00:00Z',
    last_active_at: '2026-10-17T09:00:00Z',
    ...overrides,
  }
}

function makeResponse(overrides: Partial<PromptSuggestionsResponse> = {}): PromptSuggestionsResponse {
  return {
    session_id: SESSION,
    project_id: 'proj-1',
    source: 'continuation',
    suggestions: [{
      id: 'row-1',
      session_id: SESSION,
      task_id: '',
      kind: 'goal_advance',
      text: 'Advance the goal',
      status: 'active',
      created_at: '2026-10-17T10:00:00Z',
    }],
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

function Harness({ sessionId, projectId }: { sessionId: string | null; projectId: string | null }): null {
  usePromptSuggestionsSync(sessionId, projectId)
  return null
}

function emit(sessionId: string, data: unknown): void {
  act(() => {
    for (const cb of runtimeHandlers.get(`${sessionId}:prompt_suggestions`) ?? []) {
      cb(data)
    }
  })
}

/** Flush the un-awaited load/refetch promises (act drains microtasks). */
const flush = async (): Promise<void> => { await act(async () => {}) }

beforeEach(() => {
  getPromptSuggestionsMock.mockReset()
  getPromptSuggestionsMock.mockResolvedValue(makeResponse())
  reportDroppedEventMock.mockClear()
  runtimeHandlers.clear()
  useProjectStore.setState({ projects: null, activeProjectId: null })
  usePromptSuggestionsStore.setState({
    sessionId: null,
    projectId: '',
    source: 'none',
    suggestions: [],
    selectedIndex: -1,
    loading: false,
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('usePromptSuggestionsSync triggers', () => {
  it('loads on mount with the (session, project) context', async () => {
    await act(async () => {
      root.render(createElement(Harness, { sessionId: SESSION, projectId: 'proj-1' }))
    })
    expect(getPromptSuggestionsMock).toHaveBeenCalledWith(SESSION, 'proj-1')
    expect(usePromptSuggestionsStore.getState().sessionId).toBe(SESSION)
    expect(usePromptSuggestionsStore.getState().suggestions).toHaveLength(1)
  })

  it('normalizes a null projectId to "" (No-Project/CHAT window)', async () => {
    await act(async () => {
      root.render(createElement(Harness, { sessionId: SESSION, projectId: null }))
    })
    expect(getPromptSuggestionsMock).toHaveBeenCalledWith(SESSION, '')
  })

  it('refetches on session switch — the session-creation path rides this trigger', async () => {
    await act(async () => {
      root.render(createElement(Harness, { sessionId: SESSION, projectId: 'proj-1' }))
    })
    getPromptSuggestionsMock.mockClear()
    getPromptSuggestionsMock.mockResolvedValue(makeResponse({ session_id: OTHER }))
    await act(async () => {
      root.render(createElement(Harness, { sessionId: OTHER, projectId: 'proj-1' }))
    })
    expect(getPromptSuggestionsMock).toHaveBeenCalledTimes(1)
    expect(getPromptSuggestionsMock).toHaveBeenCalledWith(OTHER, 'proj-1')
    expect(usePromptSuggestionsStore.getState().sessionId).toBe(OTHER)
  })

  it('refetches on project switch (same session id)', async () => {
    await act(async () => {
      root.render(createElement(Harness, { sessionId: SESSION, projectId: 'proj-1' }))
    })
    getPromptSuggestionsMock.mockClear()
    await act(async () => {
      root.render(createElement(Harness, { sessionId: SESSION, projectId: 'proj-2' }))
    })
    expect(getPromptSuggestionsMock).toHaveBeenCalledTimes(1)
    expect(getPromptSuggestionsMock).toHaveBeenCalledWith(SESSION, 'proj-2')
  })

  it('resets the store when no session is active', async () => {
    await act(async () => {
      root.render(createElement(Harness, { sessionId: SESSION, projectId: 'proj-1' }))
    })
    expect(usePromptSuggestionsStore.getState().sessionId).toBe(SESSION)
    await act(async () => {
      root.render(createElement(Harness, { sessionId: null, projectId: null }))
    })
    const s = usePromptSuggestionsStore.getState()
    expect(s.sessionId).toBeNull()
    expect(s.suggestions).toHaveLength(0)
    expect(getPromptSuggestionsMock).toHaveBeenCalledTimes(1) // no project window → no load
  })

  it('loads the project surface under the empty session key (the session-less window)', async () => {
    // A CODE project with no active session (fresh start / last session
    // deleted): the hook must address the backend's new_session branch with
    // the EMPTY session id instead of resetting (the per-project next_task
    // surface).
    getPromptSuggestionsMock.mockReset()
    getPromptSuggestionsMock.mockResolvedValue(makeResponse({
      session_id: '',
      source: 'new_session',
      suggestions: [{
        id: 'row-next',
        session_id: 'sess-origin',
        task_id: 't1',
        kind: 'next_task',
        text: 'Project follow-up',
        status: 'active',
        created_at: '2026-10-17T11:00:00Z',
      }],
    }))
    await act(async () => {
      root.render(createElement(Harness, { sessionId: null, projectId: 'proj-1' }))
    })
    expect(getPromptSuggestionsMock).toHaveBeenCalledWith('', 'proj-1')
    const s = usePromptSuggestionsStore.getState()
    expect(s.sessionId).toBe('')
    expect(s.suggestions).toHaveLength(1)
    expect(s.suggestions[0]?.kind).toBe('next_task')
  })

  it('resets instead of loading when the session-less window sits in No-Project', async () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'no-project', name: 'No Project', is_no_project: true })],
      activeProjectId: 'no-project',
    })
    getPromptSuggestionsMock.mockClear()
    await act(async () => {
      root.render(createElement(Harness, { sessionId: null, projectId: 'no-project' }))
    })
    expect(getPromptSuggestionsMock).not.toHaveBeenCalled()
    const s = usePromptSuggestionsStore.getState()
    expect(s.sessionId).toBeNull()
    expect(s.suggestions).toHaveLength(0)
  })

  it('resets when the draft surface loses its project window (CHAT switch)', async () => {
    getPromptSuggestionsMock.mockResolvedValue(makeResponse({ session_id: '', source: 'new_session', suggestions: [] }))
    await act(async () => {
      root.render(createElement(Harness, { sessionId: null, projectId: 'proj-1' }))
    })
    expect(usePromptSuggestionsStore.getState().sessionId).toBe('')
    getPromptSuggestionsMock.mockClear()
    await act(async () => {
      root.render(createElement(Harness, { sessionId: null, projectId: null }))
    })
    const s = usePromptSuggestionsStore.getState()
    expect(s.sessionId).toBeNull()
    expect(s.suggestions).toHaveLength(0)
    expect(getPromptSuggestionsMock).not.toHaveBeenCalled()
  })

  it('refetches on a valid prompt_suggestions event for the active session', async () => {
    await act(async () => {
      root.render(createElement(Harness, { sessionId: SESSION, projectId: 'proj-1' }))
    })
    expect(getPromptSuggestionsMock).toHaveBeenCalledTimes(1)
    emit(SESSION, {
      session_id: SESSION,
      suggestions: [{
        id: 'row-9',
        session_id: SESSION,
        task_id: 't1',
        kind: 'next_task',
        text: 'Fresh generation',
        status: 'active',
        created_at: '2026-10-17T11:00:00Z',
      }],
    })
    await flush()
    expect(getPromptSuggestionsMock).toHaveBeenCalledTimes(2)
    // The refetch reuses the loaded context, and the applied snapshot comes
    // from the RPC re-route — not from the event payload.
    expect(getPromptSuggestionsMock).toHaveBeenLastCalledWith(SESSION, 'proj-1')
    expect(usePromptSuggestionsStore.getState().suggestions[0]?.id).toBe('row-1')
  })

  it('drops a malformed event payload via reportDroppedEvent (no refetch)', async () => {
    await act(async () => {
      root.render(createElement(Harness, { sessionId: SESSION, projectId: 'proj-1' }))
    })
    getPromptSuggestionsMock.mockClear()
    emit(SESSION, { session_id: SESSION, suggestions: 'not-an-array' })
    await flush()
    expect(reportDroppedEventMock).toHaveBeenCalledTimes(1)
    expect(reportDroppedEventMock).toHaveBeenCalledWith('prompt_suggestions', { session_id: SESSION, suggestions: 'not-an-array' })
    expect(getPromptSuggestionsMock).not.toHaveBeenCalled()
  })

  it('ignores an event naming another session (defensive: subscription is scoped)', async () => {
    await act(async () => {
      root.render(createElement(Harness, { sessionId: SESSION, projectId: 'proj-1' }))
    })
    getPromptSuggestionsMock.mockClear()
    emit(SESSION, { session_id: OTHER, suggestions: [] })
    await flush()
    expect(getPromptSuggestionsMock).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', async () => {
    await act(async () => {
      root.render(createElement(Harness, { sessionId: SESSION, projectId: 'proj-1' }))
    })
    const key = `${SESSION}:prompt_suggestions`
    const handlersBefore = runtimeHandlers.get(key)?.length ?? 0
    expect(handlersBefore).toBe(1)
    act(() => { root.unmount() })
    expect((runtimeHandlers.get(key) ?? []).length).toBe(0)
  })
})
