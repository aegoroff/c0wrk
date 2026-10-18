// @vitest-environment jsdom
// Tests for promptSuggestionsStore — the single-slot active-session
// suggestions snapshot. Covers: load application + immediate switch skeleton
// (session switches AND project switches under the shared '' draft key), the
// sequence guard (a stale in-flight response never overwrites a newer load,
// and a response in flight across a reset is discarded), fail-open
// degradation (null/mismatched responses keep the session's current rows),
// selection clamping with reference-stable no-ops, and the stable-selector
// contract (direct references or primitives — never a fresh
// allocation; see AGENTS.md §2.7).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const getPromptSuggestionsMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/suggestions', () => ({
  getPromptSuggestions: getPromptSuggestionsMock,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { usePromptSuggestionsStore, usePromptSuggestions, usePromptSuggestionsSource, usePromptSelectedIndex, usePromptSelectedSuggestion } from './promptSuggestionsStore'
import type { PromptSuggestionsResponse } from '@/api/suggestions'
import type { PromptSuggestionRow } from '@/types/events'

function makeRow(overrides: Partial<PromptSuggestionRow> = {}): PromptSuggestionRow {
  return {
    id: 'row-1',
    session_id: 'sess-1',
    task_id: '',
    kind: 'goal_advance',
    text: 'Advance the goal',
    status: 'active',
    created_at: '2026-10-17T10:00:00Z',
    ...overrides,
  }
}

function makeResponse(overrides: Partial<PromptSuggestionsResponse> = {}): PromptSuggestionsResponse {
  return {
    session_id: 'sess-1',
    project_id: 'proj-1',
    source: 'continuation',
    suggestions: [makeRow(), makeRow({ id: 'row-2', text: 'Second' })],
    ...overrides,
  }
}

const pristine = (): Partial<ReturnType<typeof usePromptSuggestionsStore.getState>> => ({
  sessionId: null,
  projectId: '',
  source: 'none',
  suggestions: [],
  selectedIndex: -1,
  loading: false,
})

describe('promptSuggestionsStore', () => {
  beforeEach(() => {
    getPromptSuggestionsMock.mockReset()
    usePromptSuggestionsStore.setState(pristine())
  })

  describe('load', () => {
    it('applies a valid response (rows, source, project context, loading cleared)', async () => {
      const resp = makeResponse()
      getPromptSuggestionsMock.mockResolvedValue(resp)
      await usePromptSuggestionsStore.getState().load('sess-1', 'proj-1')
      const s = usePromptSuggestionsStore.getState()
      expect(getPromptSuggestionsMock).toHaveBeenCalledWith('sess-1', 'proj-1')
      expect(s.sessionId).toBe('sess-1')
      expect(s.projectId).toBe('proj-1')
      expect(s.source).toBe('continuation')
      expect(s.suggestions).toEqual(resp.suggestions)
      expect(s.selectedIndex).toBe(0) // a fresh set rests ON the top row
      expect(s.loading).toBe(false)
    })

    it('clears the outgoing session rows immediately on a session switch (skeleton)', async () => {
      // First session fully loaded.
      getPromptSuggestionsMock.mockResolvedValueOnce(makeResponse())
      await usePromptSuggestionsStore.getState().load('sess-1', 'proj-1')
      expect(usePromptSuggestionsStore.getState().suggestions).toHaveLength(2)

      // Switching sets the skeleton synchronously — before the fetch lands.
      const pending = new Promise<PromptSuggestionsResponse>(() => {})
      getPromptSuggestionsMock.mockReturnValueOnce(pending)
      void usePromptSuggestionsStore.getState().load('sess-2', 'proj-1')
      const s = usePromptSuggestionsStore.getState()
      expect(s.sessionId).toBe('sess-2')
      expect(s.suggestions).toHaveLength(0)
      expect(s.source).toBe('none')
      expect(s.selectedIndex).toBe(-1)
      expect(s.loading).toBe(true)
    })

    it('skeletons a draft project switch instantly and supersedes the outgoing project in-flight load', async () => {
      // Draft of project A fully loaded — its rows are visible.
      const rowsA = [makeRow({ id: 'a-1', session_id: '' })]
      getPromptSuggestionsMock.mockResolvedValueOnce(
        makeResponse({ session_id: '', project_id: 'proj-a', source: 'new_session', suggestions: rowsA }),
      )
      await usePromptSuggestionsStore.getState().load('', 'proj-a')
      expect(usePromptSuggestionsStore.getState().suggestions).toEqual(rowsA)

      // A same-key refetch of A goes in flight (e.g. a fresh generation).
      let resolveStaleA!: (v: PromptSuggestionsResponse) => void
      getPromptSuggestionsMock.mockImplementationOnce(() => new Promise((res) => { resolveStaleA = res }))
      const staleA = usePromptSuggestionsStore.getState().load('', 'proj-a')

      // The user switches the project while the draft stays armed: the SAME
      // '' session key, a DIFFERENT project. The session id alone cannot see
      // this switch — the project disjunct must skeleton A's rows away
      // synchronously, before the fetch lands.
      let resolveB!: (v: PromptSuggestionsResponse) => void
      getPromptSuggestionsMock.mockImplementationOnce(() => new Promise((res) => { resolveB = res }))
      const projB = usePromptSuggestionsStore.getState().load('', 'proj-b')
      const mid = usePromptSuggestionsStore.getState()
      expect(mid.sessionId).toBe('')
      expect(mid.projectId).toBe('proj-b')
      expect(mid.suggestions).toHaveLength(0) // A's rows never show under B
      expect(mid.source).toBe('none')
      expect(mid.selectedIndex).toBe(-1)
      expect(mid.loading).toBe(true)

      // A's late response echoes the SAME '' key, so the session guard
      // cannot reject it — only the sequence guard can (B superseded it).
      resolveStaleA(makeResponse({ session_id: '', project_id: 'proj-a', source: 'new_session', suggestions: rowsA }))
      await staleA
      const afterStale = usePromptSuggestionsStore.getState()
      expect(afterStale.suggestions).toHaveLength(0)
      expect(afterStale.projectId).toBe('proj-b')
      expect(afterStale.loading).toBe(true) // B's load is still the live one

      resolveB(makeResponse({ session_id: '', project_id: 'proj-b', source: 'new_session', suggestions: [makeRow({ id: 'b-1', session_id: '' })] }))
      await projB
      const done = usePromptSuggestionsStore.getState()
      expect(done.suggestions.map((r) => r.id)).toEqual(['b-1'])
      expect(done.loading).toBe(false)
    })

    it('drops a stale in-flight response (sequence guard: newest load wins)', async () => {
      let resolveA!: (v: PromptSuggestionsResponse) => void
      getPromptSuggestionsMock.mockImplementationOnce(() => new Promise((res) => { resolveA = res }))
      const p1 = usePromptSuggestionsStore.getState().load('sess-1', 'proj-1')

      const respB = makeResponse({ session_id: 'sess-2', suggestions: [makeRow({ id: 'b-1', session_id: 'sess-2' })] })
      getPromptSuggestionsMock.mockResolvedValueOnce(respB)
      const p2 = usePromptSuggestionsStore.getState().load('sess-2', 'proj-1')

      resolveA(makeResponse()) // lands AFTER load('sess-2') started — stale
      await p1
      await p2

      const s = usePromptSuggestionsStore.getState()
      expect(s.sessionId).toBe('sess-2')
      expect(s.suggestions).toEqual(respB.suggestions)
      expect(s.loading).toBe(false)
    })

    it('fails open on a null response after a switch (empty skeleton stands)', async () => {
      getPromptSuggestionsMock.mockResolvedValueOnce(null)
      await usePromptSuggestionsStore.getState().load('sess-1', 'proj-1')
      const s = usePromptSuggestionsStore.getState()
      expect(s.sessionId).toBe('sess-1')
      expect(s.suggestions).toHaveLength(0)
      expect(s.source).toBe('none')
      expect(s.loading).toBe(false)
    })

    it('keeps the current rows when a same-session refetch fails (no blanking)', async () => {
      const resp = makeResponse()
      getPromptSuggestionsMock.mockResolvedValueOnce(resp)
      await usePromptSuggestionsStore.getState().load('sess-1', 'proj-1')

      getPromptSuggestionsMock.mockResolvedValueOnce(null)
      await usePromptSuggestionsStore.getState().refetch()
      const s = usePromptSuggestionsStore.getState()
      expect(s.suggestions).toEqual(resp.suggestions)
      expect(s.source).toBe('continuation')
      expect(s.loading).toBe(false)
    })

    it('drops a response that echoes another session id', async () => {
      getPromptSuggestionsMock.mockResolvedValueOnce(makeResponse({ session_id: 'sess-other' }))
      await usePromptSuggestionsStore.getState().load('sess-1', 'proj-1')
      const s = usePromptSuggestionsStore.getState()
      expect(s.suggestions).toHaveLength(0)
      expect(s.loading).toBe(false)
    })

    it('rests the selection on the top row when a snapshot is applied (-1 only for an empty set)', async () => {
      usePromptSuggestionsStore.setState({ ...pristine(), sessionId: 'sess-1', suggestions: makeResponse().suggestions, selectedIndex: 1 })
      getPromptSuggestionsMock.mockResolvedValueOnce(makeResponse())
      await usePromptSuggestionsStore.getState().refetch()
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(0)

      getPromptSuggestionsMock.mockResolvedValueOnce(makeResponse({ suggestions: [] }))
      await usePromptSuggestionsStore.getState().refetch()
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(-1)
    })
  })

  describe('refetch', () => {
    it('re-loads the stored (sessionId, projectId) context', async () => {
      usePromptSuggestionsStore.setState({ ...pristine(), sessionId: 'sess-1', projectId: 'proj-9' })
      getPromptSuggestionsMock.mockResolvedValueOnce(makeResponse())
      await usePromptSuggestionsStore.getState().refetch()
      expect(getPromptSuggestionsMock).toHaveBeenCalledWith('sess-1', 'proj-9')
    })

    it('re-loads the draft surface (empty session key) like any session', async () => {
      usePromptSuggestionsStore.setState({ ...pristine(), sessionId: '', projectId: 'proj-1' })
      getPromptSuggestionsMock.mockResolvedValueOnce(makeResponse({ session_id: '', source: 'new_session', suggestions: [] }))
      await usePromptSuggestionsStore.getState().refetch()
      expect(getPromptSuggestionsMock).toHaveBeenCalledWith('', 'proj-1')
    })

    it('is a no-op without a loaded session', async () => {
      await usePromptSuggestionsStore.getState().refetch()
      expect(getPromptSuggestionsMock).not.toHaveBeenCalled()
    })
  })

  describe('selection', () => {
    // Mirrors the real load() rest: a fresh non-empty set rests ON the top row.
    const withRows = (): void => {
      usePromptSuggestionsStore.setState({ ...pristine(), sessionId: 'sess-1', suggestions: makeResponse().suggestions, selectedIndex: 0 })
    }

    it('clamps setSelectedIndex to [0, length-1] for a non-empty set (-1 only for an empty set)', () => {
      withRows()
      const store = usePromptSuggestionsStore.getState()
      store.setSelectedIndex(1)
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(1)
      store.setSelectedIndex(99)
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(1)
      store.setSelectedIndex(-5)
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(0)

      usePromptSuggestionsStore.setState({ ...pristine(), sessionId: 'sess-1', suggestions: [] })
      usePromptSuggestionsStore.getState().setSelectedIndex(3)
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(-1)
    })

    it('moveSelection steps and clamps; no-op on an empty set', () => {
      withRows()
      const store = usePromptSuggestionsStore.getState()
      store.moveSelection(1) // 0 → 1
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(1)
      store.moveSelection(1) // clamped at the last row
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(1)
      store.moveSelection(-3) // clamped at the top row (the resting state)
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(0)

      usePromptSuggestionsStore.setState({ ...pristine(), sessionId: 'sess-1', suggestions: [] })
      usePromptSuggestionsStore.getState().moveSelection(1)
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(-1)
    })

    it('clearSelection rests the selection on the top row without touching the rows', () => {
      withRows()
      usePromptSuggestionsStore.getState().setSelectedIndex(1)
      usePromptSuggestionsStore.getState().clearSelection()
      expect(usePromptSuggestionsStore.getState().selectedIndex).toBe(0)
      expect(usePromptSuggestionsStore.getState().suggestions).toHaveLength(2)
    })

    it('unchanged selection is a reference-stable no-op', () => {
      withRows()
      usePromptSuggestionsStore.getState().setSelectedIndex(0)
      const before = usePromptSuggestionsStore.getState()
      usePromptSuggestionsStore.getState().setSelectedIndex(0)
      expect(usePromptSuggestionsStore.getState()).toBe(before)
    })
  })

  describe('reset', () => {
    it('drops the snapshot entirely', async () => {
      getPromptSuggestionsMock.mockResolvedValueOnce(makeResponse())
      await usePromptSuggestionsStore.getState().load('sess-1', 'proj-1')
      usePromptSuggestionsStore.getState().reset()
      const s = usePromptSuggestionsStore.getState()
      expect(s.sessionId).toBeNull()
      expect(s.projectId).toBe('')
      expect(s.suggestions).toHaveLength(0)
      expect(s.selectedIndex).toBe(-1)
      expect(s.loading).toBe(false)
    })

    it('discards a draft-load response that lands after the reset (loadSeq guard)', async () => {
      // A draft load is in flight when the surface is torn down (the user
      // left the armed draft for CHAT — the sync hook calls reset()).
      let resolveDraft!: (v: PromptSuggestionsResponse) => void
      getPromptSuggestionsMock.mockImplementationOnce(() => new Promise((res) => { resolveDraft = res }))
      const draft = usePromptSuggestionsStore.getState().load('', 'proj-a')
      usePromptSuggestionsStore.getState().reset()
      expect(usePromptSuggestionsStore.getState().sessionId).toBeNull()

      // The late response echoes the shared '' key — it would match every
      // later consumer context, so only the loadSeq guard can drop it.
      resolveDraft(makeResponse({ session_id: '', project_id: 'proj-a', source: 'new_session', suggestions: [makeRow({ id: 'late-1', session_id: '' })] }))
      await draft
      const s = usePromptSuggestionsStore.getState()
      expect(s.sessionId).toBeNull()
      expect(s.projectId).toBe('')
      expect(s.suggestions).toHaveLength(0)
      expect(s.source).toBe('none')

      // The unconditional bump must not wedge later loads: a fresh draft
      // load after the reset applies normally.
      getPromptSuggestionsMock.mockResolvedValueOnce(
        makeResponse({ session_id: '', project_id: 'proj-b', source: 'new_session', suggestions: [makeRow({ id: 'fresh-1', session_id: '' })] }),
      )
      await usePromptSuggestionsStore.getState().load('', 'proj-b')
      expect(usePromptSuggestionsStore.getState().suggestions.map((r) => r.id)).toEqual(['fresh-1'])
    })

    it('is a reference-stable no-op when already pristine', () => {
      usePromptSuggestionsStore.setState(pristine())
      const before = usePromptSuggestionsStore.getState()
      usePromptSuggestionsStore.getState().reset()
      expect(usePromptSuggestionsStore.getState()).toBe(before)
    })
  })
})

describe('promptSuggestionsStore selectors', () => {
  // Harness pattern (see e2sStore.test.ts): render the selector hooks through
  // a minimal component and capture their results per render.
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  const seen: unknown[] = []
  const last = (): unknown => seen[seen.length - 1]

  function renderHarness(id: string | null, hook: (s: string | null) => unknown): void {
    if (root) {
      act(() => { root!.unmount() })
      root = null
    }
    container?.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root!.render(createElement(function Harness(): null {
        seen.push(hook(id))
        return null
      }))
    })
  }

  beforeEach(() => {
    getPromptSuggestionsMock.mockReset()
    usePromptSuggestionsStore.setState(pristine())
    seen.length = 0
  })

  afterEach(() => {
    act(() => { root?.unmount() })
    root = null
    container?.remove()
    container = null
  })

  it('usePromptSuggestions returns the exact stored rows reference', async () => {
    const resp = makeResponse()
    getPromptSuggestionsMock.mockResolvedValueOnce(resp)
    await usePromptSuggestionsStore.getState().load('sess-1', 'proj-1')
    const stored = usePromptSuggestionsStore.getState().suggestions
    renderHarness('sess-1', usePromptSuggestions)
    expect(last()).toBe(stored)
  })

  it('usePromptSuggestions returns the stable empty set for a foreign/null session', () => {
    usePromptSuggestionsStore.setState({ ...pristine(), sessionId: 'sess-1', suggestions: makeResponse().suggestions })
    renderHarness('sess-other', usePromptSuggestions)
    const foreign = last()
    expect(foreign).toHaveLength(0)
    renderHarness(null, usePromptSuggestions)
    // Same frozen constant across calls — never a fresh allocation.
    expect(last()).toBe(foreign)
    expect(usePromptSuggestionsStore.getState().suggestions).not.toBe(foreign)
  })

  it('usePromptSuggestionsSource returns a primitive and defaults to "none"', () => {
    usePromptSuggestionsStore.setState({ ...pristine(), sessionId: 'sess-1', source: 'new_session' })
    renderHarness('sess-1', usePromptSuggestionsSource)
    expect(last()).toBe('new_session')
    renderHarness('sess-other', usePromptSuggestionsSource)
    expect(last()).toBe('none')
  })

  it('usePromptSelectedIndex returns a primitive and defaults to -1', () => {
    usePromptSuggestionsStore.setState({ ...pristine(), sessionId: 'sess-1', suggestions: makeResponse().suggestions, selectedIndex: 1 })
    renderHarness('sess-1', usePromptSelectedIndex)
    expect(last()).toBe(1)
    renderHarness(null, usePromptSelectedIndex)
    expect(last()).toBe(-1)
  })

  it('usePromptSelectedSuggestion returns the direct selected row (the top row at rest, undefined otherwise)', () => {
    const rows = makeResponse().suggestions
    usePromptSuggestionsStore.setState({ ...pristine(), sessionId: 'sess-1', suggestions: rows, selectedIndex: 1 })
    renderHarness('sess-1', usePromptSelectedSuggestion)
    expect(last()).toBe(rows[1])
    act(() => { usePromptSuggestionsStore.getState().clearSelection() })
    expect(last()).toBe(rows[0]) // clearSelection rests on the top row
    renderHarness('sess-other', usePromptSelectedSuggestion)
    expect(last()).toBeUndefined()
  })
})
