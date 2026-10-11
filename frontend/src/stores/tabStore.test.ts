// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom in this environment does not expose `window.localStorage`, which
// zustand's `persist` middleware captures at store-creation time (tabStore
// itself is transient, but it transitively imports uiStore via
// lib/tabSnapshot — same pattern as inputModeStore.test.ts).
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  const win = (g.window as Record<string, unknown> | undefined) ?? g
  const map = new Map<string, string>()
  win.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size },
  }
})

import { createTab, selectActiveTab, useTabStore, type Tab } from './tabStore'
import { createDefaultTabUI, defaultTabUIFallback } from '@/lib/tabSnapshot'

function resetStore(): void {
  const initial = createTab()
  useTabStore.setState({ tabs: [initial], activeTabId: initial.id })
}

function activeTab(): Tab {
  const tab = selectActiveTab(useTabStore.getState())
  expect(tab).not.toBeNull()
  return tab as Tab
}

beforeEach(resetStore)

describe('tabStore initial state', () => {
  it('starts with exactly one default tab, already active', () => {
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.id).toBe(state.activeTabId)

    const tab = activeTab()
    expect(tab.projectId).toBeNull()
    expect(tab.sessionId).toBeNull()
    expect(tab.ui).toEqual(createDefaultTabUI())
  })

  it('createTab assigns unique ids', () => {
    expect(createTab().id).not.toBe(createTab().id)
  })
})

describe('tabStore addTab', () => {
  it('appends a tab, activates it, and returns its id', () => {
    const first = activeTab()
    const newId = useTabStore.getState().addTab({ projectId: 'p1', sessionId: 's1' })

    const state = useTabStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual([first.id, newId])
    expect(state.activeTabId).toBe(newId)

    const added = state.tabs.find((t) => t.id === newId)
    expect(added?.projectId).toBe('p1')
    expect(added?.sessionId).toBe('s1')
    // The previously active tab object is untouched.
    expect(state.tabs[0]).toBe(first)
  })

  it('defaults new-tab context to null and discards a garbage ui payload (fail-closed)', () => {
    const newId = useTabStore.getState().addTab({
      ui: {
        workspaceTabByProject: { p1: 'git', p2: 'bogus' },
        researchSegmentByProject: { p1: 'papers', p2: 'reader' },
        inputMode: { mode: 'chat', height: 'wide', collapsedHeight: NaN, isExpanded: 1 },
      },
    })

    const added = useTabStore.getState().tabs.find((t) => t.id === newId)
    // Valid entries survive, unknown values and wrong-typed scalars are dropped.
    expect(added?.ui.workspaceTabByProject).toEqual({ p1: 'git' })
    expect(added?.ui.researchSegmentByProject).toEqual({ p1: 'papers' })
    expect(added?.ui.inputMode).toEqual({
      mode: 'chat',
      height: 200,
      collapsedHeight: 200,
      isExpanded: false,
    })
  })

  it('discards garbage v2 slices on createTab and falls back to boot defaults', () => {
    const newId = useTabStore.getState().addTab({
      ui: {
        sidebar: { collapsed: 'yes', width: 'wide' },
        viewer: { pinned: 1, collapsed: true, width: 500 },
        gitPanelTabByProject: { p1: 'changes', p2: 'graph' },
        chatSessionListRatio: Number.NaN,
        showSessionStats: 7,
      },
    })

    const added = useTabStore.getState().tabs.find((t) => t.id === newId)
    expect(added?.ui.sidebar).toEqual(defaultTabUIFallback().sidebar)
    // Valid v2 fields pass through, garbage siblings fall back per field.
    expect(added?.ui.viewer).toEqual({ pinned: false, collapsed: true, width: 500 })
    expect(added?.ui.gitPanelTabByProject).toEqual({ p1: 'changes' })
    expect(added?.ui.chatSessionListRatio).toBe(0.5)
    expect(added?.ui.showSessionStats).toBe(false)
  })
})

describe('tabStore activateTab', () => {
  it('switches the active tab back and forth', () => {
    const first = activeTab()
    const secondId = useTabStore.getState().addTab()

    useTabStore.getState().activateTab(first.id)
    expect(useTabStore.getState().activeTabId).toBe(first.id)

    useTabStore.getState().activateTab(secondId)
    expect(useTabStore.getState().activeTabId).toBe(secondId)
  })

  it('ignores unknown and already-active ids (reference-stable no-op)', () => {
    const before = useTabStore.getState()
    useTabStore.getState().activateTab('no-such-tab')
    useTabStore.getState().activateTab(before.activeTabId)
    expect(useTabStore.getState()).toBe(before)
  })
})

describe('tabStore closeTab', () => {
  it('removes a background tab and keeps the active tab', () => {
    const first = activeTab()
    const secondId = useTabStore.getState().addTab()

    useTabStore.getState().closeTab(first.id)

    const state = useTabStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual([secondId])
    expect(state.activeTabId).toBe(secondId)
  })

  it('closing the active tab activates the right neighbor', () => {
    const first = activeTab()
    const secondId = useTabStore.getState().addTab()
    const thirdId = useTabStore.getState().addTab()
    useTabStore.getState().activateTab(first.id)

    useTabStore.getState().closeTab(first.id)

    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual([secondId, thirdId])
    expect(useTabStore.getState().activeTabId).toBe(secondId)
  })

  it('closing the rightmost active tab activates the last remaining tab', () => {
    const first = activeTab()
    const secondId = useTabStore.getState().addTab()
    const thirdId = useTabStore.getState().addTab()

    useTabStore.getState().closeTab(thirdId)

    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual([first.id, secondId])
    expect(useTabStore.getState().activeTabId).toBe(secondId)
  })

  it('closing the LAST tab replaces it with a fresh default tab (>= 1 invariant)', () => {
    const first = activeTab()
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })

    useTabStore.getState().closeTab(first.id)

    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(1)
    const fresh = activeTab()
    expect(fresh.id).not.toBe(first.id)
    expect(fresh.projectId).toBeNull()
    expect(fresh.sessionId).toBeNull()
    expect(fresh.ui).toEqual(createDefaultTabUI())
    expect(state.activeTabId).toBe(fresh.id)
  })

  it('ignores unknown ids (reference-stable no-op)', () => {
    useTabStore.getState().addTab()
    const before = useTabStore.getState()

    useTabStore.getState().closeTab('no-such-tab')

    expect(useTabStore.getState()).toBe(before)
  })
})

describe('tabStore updateActiveContext', () => {
  it('patches the active tab only', () => {
    const first = activeTab()
    const secondId = useTabStore.getState().addTab()
    useTabStore.getState().activateTab(first.id)

    useTabStore.getState().updateActiveContext({ projectId: 'p9' })

    const state = useTabStore.getState()
    expect(state.tabs.find((t) => t.id === first.id)?.projectId).toBe('p9')
    // The background tab is untouched.
    expect(state.tabs.find((t) => t.id === secondId)?.projectId).toBeNull()
  })

  it('leaves fields absent from the patch unchanged and clears on explicit null', () => {
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })
    expect(activeTab().sessionId).toBe('s1')

    useTabStore.getState().updateActiveContext({ projectId: null })
    const tab = activeTab()
    expect(tab.projectId).toBeNull()
    expect(tab.sessionId).toBe('s1')
  })

  it('is a reference-stable no-op when nothing changes', () => {
    useTabStore.getState().updateActiveContext({ projectId: 'p1' })
    const before = useTabStore.getState()

    useTabStore.getState().updateActiveContext({ projectId: 'p1' })
    expect(useTabStore.getState()).toBe(before)
  })

  it('keeps the stored ui reference when a re-captured snapshot is content-equal', () => {
    const before = activeTab()

    // A fresh capture of unchanged slices produces an equal-but-new object —
    // the action must recognize equality and keep the stored reference.
    useTabStore.getState().updateActiveContext({
      ui: {
        workspaceTabByProject: {},
        researchSegmentByProject: {},
        inputMode: { mode: 'chat', height: 200, collapsedHeight: 200, isExpanded: false },
      },
    })

    expect(activeTab()).toBe(before)
  })

  it('sanitizes a garbage ui patch: valid fields update, garbage is discarded', () => {
    const before = activeTab()

    useTabStore.getState().updateActiveContext({
      ui: {
        workspaceTabByProject: { p1: 'semantics', p2: 42 },
        inputMode: { mode: 'terminal', height: 420, collapsedHeight: 420, isExpanded: true },
      },
    })

    const after = activeTab()
    expect(after).not.toBe(before)
    expect(after.ui.workspaceTabByProject).toEqual({ p1: 'semantics' })
    expect(after.ui.researchSegmentByProject).toEqual({})
    expect(after.ui.inputMode).toEqual({
      mode: 'terminal',
      height: 420,
      collapsedHeight: 420,
      isExpanded: true,
    })
  })

  it('falls back to the tab\'s remembered scalar slices for missing v2 fields', () => {
    // Give the active tab a non-default remembered shell.
    useTabStore.getState().updateActiveContext({
      ui: {
        sidebar: { collapsed: true, width: 300 },
        viewer: { pinned: true, collapsed: false, width: 640 },
        gitPanelTabByProject: { p1: 'history' },
        chatSessionListRatio: 0.3,
        showSessionStats: true,
      },
    })
    const remembered = activeTab().ui
    expect(remembered.sidebar.width).toBe(300)

    // A partial payload (scalar v2 fields absent) must keep every remembered
    // scalar — a partial re-capture never wipes a remembered value with a
    // boot default. The per-project MAPS have no fallback (same contract as
    // the v1 maps): an absent map restores to empty, and the engine's
    // write-back always captures the full slice set anyway.
    useTabStore.getState().updateActiveContext({
      ui: { workspaceTabByProject: { p1: 'git' } },
    })
    const after = activeTab()
    expect(after.ui.workspaceTabByProject).toEqual({ p1: 'git' })
    expect(after.ui.sidebar).toEqual(remembered.sidebar)
    expect(after.ui.viewer).toEqual(remembered.viewer)
    expect(after.ui.gitPanelTabByProject).toEqual({})
    expect(after.ui.chatSessionListRatio).toBe(0.3)
    expect(after.ui.showSessionStats).toBe(true)
  })

  it('keeps the stored ui reference when only content-equal v2 slices are re-captured', () => {
    const shell = {
      sidebar: { collapsed: true, width: 300 },
      viewer: { pinned: true, collapsed: false, width: 640 },
      chatSessionListRatio: 0.3,
      showSessionStats: true,
    }
    useTabStore.getState().updateActiveContext({ ui: shell })
    const before = activeTab()

    // A fresh capture of unchanged slices produces an equal-but-new object —
    // the action must recognize equality and keep the stored reference.
    useTabStore.getState().updateActiveContext({ ui: shell })

    expect(activeTab()).toBe(before)
  })
})

describe('tabStore selectors', () => {
  it('selectActiveTab returns the stored element reference without allocating', () => {
    const state = useTabStore.getState()
    const first = selectActiveTab(state)
    expect(first).not.toBeNull()
    expect(selectActiveTab(state)).toBe(first)

    // Activation churn never replaces tab objects: switching away and back
    // yields the identical reference.
    useTabStore.getState().addTab()
    useTabStore.getState().activateTab(first!.id)
    expect(selectActiveTab(useTabStore.getState())).toBe(first)
  })
})
