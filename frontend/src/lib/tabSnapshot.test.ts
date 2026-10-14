// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom in this environment does not expose `window.localStorage`; the module
// under test transitively imports uiStore, whose persist middleware captures
// localStorage at store-creation time (same pattern as inputModeStore.test.ts).
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

import {
  DEFAULT_INPUT_SNAPSHOT,
  captureTabUI,
  createDefaultSidebarSnapshot,
  createDefaultTabUI,
  createDefaultViewerSnapshot,
  defaultTabUIFallback,
  fallbackFromTabUI,
  isSameTabUI,
  restoreTabUI,
  sanitizeTabUI,
  type TabUIFallback,
  type TabUISource,
} from './tabSnapshot'

function liveSource(): TabUISource {
  return {
    workspaceTabByProject: { p1: 'git', p2: 'research' },
    researchSegmentByProject: { p1: 'papers' },
    inputMode: { mode: 'terminal', height: 420, collapsedHeight: 380, isExpanded: false },
    sidebar: { collapsed: true, width: 260 },
    viewer: { pinned: true, collapsed: false, width: 700 },
    gitPanelTabByProject: { p1: 'changes', p2: 'history' },
    chatSessionListRatio: 0.4,
    showSessionStats: true,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('createDefaultTabUI', () => {
  it('returns a fully-default state across the v2 slice composition', () => {
    expect(createDefaultTabUI()).toEqual({
      workspaceTabByProject: {},
      researchSegmentByProject: {},
      inputMode: { mode: 'chat', height: 200, collapsedHeight: 200, isExpanded: false },
      sidebar: createDefaultSidebarSnapshot(),
      viewer: createDefaultViewerSnapshot(),
      gitPanelTabByProject: {},
      chatSessionListRatio: 0.5,
      showSessionStats: false,
    })
  })

  it('returns fresh copies each call (mutations never leak between defaults)', () => {
    const a = createDefaultTabUI()
    const b = createDefaultTabUI()
    expect(a).not.toBe(b)
    expect(a.inputMode).not.toBe(b.inputMode)
    expect(a.sidebar).not.toBe(b.sidebar)
    expect(a.viewer).not.toBe(b.viewer)
    a.workspaceTabByProject.p1 = 'git'
    a.sidebar.width = 999
    a.viewer.pinned = true
    expect(b.workspaceTabByProject).toEqual({})
    expect(b.sidebar.width).not.toBe(999)
    expect(b.viewer.pinned).toBe(false)
  })
})

describe('defaultTabUIFallback / fallbackFromTabUI', () => {
  it('defaultTabUIFallback mirrors the store boot defaults', () => {
    expect(defaultTabUIFallback()).toEqual({
      inputMode: DEFAULT_INPUT_SNAPSHOT,
      sidebar: createDefaultSidebarSnapshot(),
      viewer: createDefaultViewerSnapshot(),
      chatSessionListRatio: 0.5,
      showSessionStats: false,
    })
  })

  it('fallbackFromTabUI picks the scalar slices of a validated state', () => {
    const ui = createDefaultTabUI()
    ui.sidebar.width = 300
    ui.viewer.pinned = true
    ui.chatSessionListRatio = 0.25
    ui.showSessionStats = true

    expect(fallbackFromTabUI(ui)).toEqual({
      inputMode: ui.inputMode,
      sidebar: ui.sidebar,
      viewer: ui.viewer,
      chatSessionListRatio: 0.25,
      showSessionStats: true,
    })
  })
})

describe('captureTabUI (pure capture)', () => {
  it('snapshots the live slices across the v2 composition', () => {
    expect(captureTabUI(liveSource())).toEqual({
      workspaceTabByProject: { p1: 'git', p2: 'research' },
      researchSegmentByProject: { p1: 'papers' },
      inputMode: { mode: 'terminal', height: 420, collapsedHeight: 380, isExpanded: false },
      sidebar: { collapsed: true, width: 260 },
      viewer: { pinned: true, collapsed: false, width: 700 },
      gitPanelTabByProject: { p1: 'changes', p2: 'history' },
      chatSessionListRatio: 0.4,
      showSessionStats: true,
    })
  })

  it('defensively copies: later source mutations never leak into the snapshot', () => {
    const source = liveSource()
    const snapshot = captureTabUI(source)

    source.workspaceTabByProject.p1 = 'explorer'
    source.researchSegmentByProject.p2 = 'dashboard'
    source.inputMode.height = 999
    source.sidebar.width = 999
    source.viewer.pinned = false
    source.gitPanelTabByProject.p1 = 'files'

    expect(snapshot.workspaceTabByProject).toEqual({ p1: 'git', p2: 'research' })
    expect(snapshot.researchSegmentByProject).toEqual({ p1: 'papers' })
    expect(snapshot.inputMode.height).toBe(420)
    expect(snapshot.sidebar.width).toBe(260)
    expect(snapshot.viewer.pinned).toBe(true)
    expect(snapshot.gitPanelTabByProject).toEqual({ p1: 'changes', p2: 'history' })
  })

  it('drops garbage entries from the source maps (fail-closed both ways)', () => {
    // Deliberate garbage typed as a live source — capture must sanitize it.
    const polluted = {
      workspaceTabByProject: { p1: 'git', p2: 'bogus', p3: 42 },
      researchSegmentByProject: { p1: 'dashboard', p2: 'reader' },
      inputMode: { mode: 'chat', height: 300, collapsedHeight: 300, isExpanded: true },
      sidebar: { collapsed: 'yes', width: 'wide' },
      viewer: { pinned: 1, collapsed: null, width: NaN },
      gitPanelTabByProject: { p1: 'history', p2: 'graph', p3: 7 },
      chatSessionListRatio: Infinity,
      showSessionStats: 'true',
    } as unknown as TabUISource
    const snapshot = captureTabUI(polluted)

    expect(snapshot.workspaceTabByProject).toEqual({ p1: 'git' })
    expect(snapshot.researchSegmentByProject).toEqual({ p1: 'dashboard' })
    // Impossible corrupted live scalars fail closed to the documented defaults.
    expect(snapshot.sidebar).toEqual(defaultTabUIFallback().sidebar)
    expect(snapshot.viewer).toEqual(defaultTabUIFallback().viewer)
    expect(snapshot.gitPanelTabByProject).toEqual({ p1: 'history' })
    expect(snapshot.chatSessionListRatio).toBe(0.5)
    expect(snapshot.showSessionStats).toBe(false)
  })
})

describe('restoreTabUI (pure restore)', () => {
  const liveFallback: TabUIFallback = {
    inputMode: { mode: 'chat', height: 555, collapsedHeight: 444, isExpanded: true },
    sidebar: { collapsed: false, width: 333 },
    viewer: { pinned: false, collapsed: true, width: 444 },
    chatSessionListRatio: 0.75,
    showSessionStats: false,
  }

  it('round-trips a capture identically', () => {
    const captured = captureTabUI(liveSource())

    // The incoming tab's snapshot is restored against a DIFFERENT live state
    // (the fallback) — the snapshot's own values must win.
    const restored = restoreTabUI(captured, liveFallback)

    expect(restored).toEqual(captured)
    expect(restored).toEqual({
      workspaceTabByProject: { p1: 'git', p2: 'research' },
      researchSegmentByProject: { p1: 'papers' },
      inputMode: { mode: 'terminal', height: 420, collapsedHeight: 380, isExpanded: false },
      sidebar: { collapsed: true, width: 260 },
      viewer: { pinned: true, collapsed: false, width: 700 },
      gitPanelTabByProject: { p1: 'changes', p2: 'history' },
      chatSessionListRatio: 0.4,
      showSessionStats: true,
    })
  })

  it('round-trip is isolated: live mutations between capture and restore do not leak', () => {
    const source = liveSource()
    const captured = captureTabUI(source)

    source.workspaceTabByProject.p1 = 'explorer'
    source.inputMode.mode = 'chat'
    source.sidebar.collapsed = false
    source.viewer.width = 1

    expect(restoreTabUI(captured, fallbackFromTabUI(captureTabUI(source)))).toEqual(captured)
  })

  it('falls back to the caller-supplied live slices for wrong-typed/missing fields', () => {
    expect(restoreTabUI(undefined, liveFallback)).toEqual({
      ...liveFallback,
      workspaceTabByProject: {},
      researchSegmentByProject: {},
      gitPanelTabByProject: {},
    })
    expect(restoreTabUI(null, liveFallback).sidebar).toEqual(liveFallback.sidebar)
    expect(restoreTabUI(42, liveFallback).viewer).toEqual(liveFallback.viewer)
    expect(restoreTabUI({}, liveFallback).chatSessionListRatio).toBe(0.75)
    expect(restoreTabUI({}, liveFallback).showSessionStats).toBe(false)

    // Per-field fallbacks: a valid field passes through, its broken siblings
    // fall back to the live values.
    const partial = restoreTabUI(
      {
        sidebar: { collapsed: true, width: 'wide' },
        viewer: { pinned: NaN, collapsed: false, width: 500 },
        chatSessionListRatio: 2,
        showSessionStats: 'yes',
      },
      liveFallback,
    )
    expect(partial.sidebar).toEqual({ collapsed: true, width: 333 })
    expect(partial.viewer).toEqual({ pinned: false, collapsed: false, width: 500 })
    // A finite (if out-of-range) number passes sanitize — the applying store
    // setter owns the clamping, exactly like the v1 input-panel heights.
    expect(partial.chatSessionListRatio).toBe(2)
    expect(partial.showSessionStats).toBe(false)
  })

  it('discards a non-object map outright and filters invalid entries from object maps', () => {
    const nonObject = restoreTabUI(
      { workspaceTabByProject: 'nope', researchSegmentByProject: 7, gitPanelTabByProject: false },
      liveFallback,
    )
    expect(nonObject.workspaceTabByProject).toEqual({})
    expect(nonObject.researchSegmentByProject).toEqual({})
    expect(nonObject.gitPanelTabByProject).toEqual({})

    const mixed = restoreTabUI(
      {
        workspaceTabByProject: { keep: 'semantics', dropUnknown: 'graph', dropNumber: 3 },
        researchSegmentByProject: { keep: 'papers', dropUnknown: 'reader' },
        gitPanelTabByProject: { keep: 'changes', dropMerged: 'graph', dropNumber: 1 },
      },
      liveFallback,
    )
    expect(mixed.workspaceTabByProject).toEqual({ keep: 'semantics' })
    expect(mixed.researchSegmentByProject).toEqual({ keep: 'papers' })
    expect(mixed.gitPanelTabByProject).toEqual({ keep: 'changes' })
  })
})

describe('sanitizeTabUI', () => {
  it('uses the documented defaults when no fallback is supplied', () => {
    expect(sanitizeTabUI(undefined)).toEqual(createDefaultTabUI())
  })

  it('never returns the input object (fresh allocation on every call)', () => {
    const raw = {
      workspaceTabByProject: { p1: 'git' },
      researchSegmentByProject: {},
      inputMode: { mode: 'chat', height: 300, collapsedHeight: 300, isExpanded: false },
      sidebar: { collapsed: true, width: 280 },
      viewer: { pinned: true, collapsed: false, width: 600 },
      gitPanelTabByProject: { p1: 'files' },
      chatSessionListRatio: 0.3,
      showSessionStats: true,
    }
    const out = sanitizeTabUI(raw)
    expect(out).not.toBe(raw)
    expect(out.workspaceTabByProject).not.toBe(raw.workspaceTabByProject)
    expect(out.inputMode).not.toBe(raw.inputMode)
    expect(out.sidebar).not.toBe(raw.sidebar)
    expect(out.viewer).not.toBe(raw.viewer)
    expect(out.gitPanelTabByProject).not.toBe(raw.gitPanelTabByProject)
    expect(out).toEqual(raw)
  })
})

describe('isSameTabUI', () => {
  it('treats content-equal states as equal regardless of object identity or key order', () => {
    const a = captureTabUI(liveSource())
    const b = restoreTabUI(a, defaultTabUIFallback())
    expect(b).not.toBe(a)
    expect(isSameTabUI(a, b)).toBe(true)

    const reordered = captureTabUI({
      workspaceTabByProject: { p2: 'research', p1: 'git' },
      researchSegmentByProject: { p1: 'papers' },
      inputMode: { mode: 'terminal', height: 420, collapsedHeight: 380, isExpanded: false },
      sidebar: { collapsed: true, width: 260 },
      viewer: { pinned: true, collapsed: false, width: 700 },
      gitPanelTabByProject: { p2: 'history', p1: 'changes' },
      chatSessionListRatio: 0.4,
      showSessionStats: true,
    })
    expect(isSameTabUI(a, reordered)).toBe(true)
  })

  it('detects map and scalar differences', () => {
    const base = captureTabUI(liveSource())

    const otherTabValue = captureTabUI({ ...liveSource(), workspaceTabByProject: { p1: 'explorer', p2: 'research' } })
    const missingEntry = captureTabUI({ ...liveSource(), workspaceTabByProject: { p1: 'git' } })
    const extraSegment = captureTabUI({ ...liveSource(), researchSegmentByProject: { p1: 'papers', p2: 'dashboard' } })
    const otherMode = captureTabUI({ ...liveSource(), inputMode: { mode: 'chat', height: 420, collapsedHeight: 380, isExpanded: false } })
    const otherHeight = captureTabUI({ ...liveSource(), inputMode: { mode: 'terminal', height: 421, collapsedHeight: 380, isExpanded: false } })
    const otherCollapsed = captureTabUI({ ...liveSource(), inputMode: { mode: 'terminal', height: 420, collapsedHeight: 381, isExpanded: false } })
    const otherExpanded = captureTabUI({ ...liveSource(), inputMode: { mode: 'terminal', height: 420, collapsedHeight: 380, isExpanded: true } })
    const otherSidebarCollapsed = captureTabUI({ ...liveSource(), sidebar: { collapsed: false, width: 260 } })
    const otherSidebarWidth = captureTabUI({ ...liveSource(), sidebar: { collapsed: true, width: 261 } })
    const otherViewerPinned = captureTabUI({ ...liveSource(), viewer: { pinned: false, collapsed: false, width: 700 } })
    const otherViewerCollapsed = captureTabUI({ ...liveSource(), viewer: { pinned: true, collapsed: true, width: 700 } })
    const otherViewerWidth = captureTabUI({ ...liveSource(), viewer: { pinned: true, collapsed: false, width: 701 } })
    const otherGitTab = captureTabUI({ ...liveSource(), gitPanelTabByProject: { p1: 'files', p2: 'history' } })
    const missingGitEntry = captureTabUI({ ...liveSource(), gitPanelTabByProject: { p1: 'changes' } })
    const otherRatio = captureTabUI({ ...liveSource(), chatSessionListRatio: 0.41 })
    const otherStats = captureTabUI({ ...liveSource(), showSessionStats: false })

    expect(isSameTabUI(base, otherTabValue)).toBe(false)
    expect(isSameTabUI(base, missingEntry)).toBe(false)
    expect(isSameTabUI(base, extraSegment)).toBe(false)
    expect(isSameTabUI(base, otherMode)).toBe(false)
    expect(isSameTabUI(base, otherHeight)).toBe(false)
    expect(isSameTabUI(base, otherCollapsed)).toBe(false)
    expect(isSameTabUI(base, otherExpanded)).toBe(false)
    expect(isSameTabUI(base, otherSidebarCollapsed)).toBe(false)
    expect(isSameTabUI(base, otherSidebarWidth)).toBe(false)
    expect(isSameTabUI(base, otherViewerPinned)).toBe(false)
    expect(isSameTabUI(base, otherViewerCollapsed)).toBe(false)
    expect(isSameTabUI(base, otherViewerWidth)).toBe(false)
    expect(isSameTabUI(base, otherGitTab)).toBe(false)
    expect(isSameTabUI(base, missingGitEntry)).toBe(false)
    expect(isSameTabUI(base, otherRatio)).toBe(false)
    expect(isSameTabUI(base, otherStats)).toBe(false)
    expect(isSameTabUI(base, base)).toBe(true)
  })
})
