// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// The engine reports failures through the logger — intercept at the source so
// the suite stays silent and the warn calls are assertable.
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: warnMock, error: vi.fn() },
}))

// sessionStore.selectSession persists through this RPC — keep the boundary
// mocked so activations never touch the Wails runtime.
const { saveProjectActiveSessionMock } = vi.hoisted(() => ({ saveProjectActiveSessionMock: vi.fn() }))
vi.mock('@/api/projects', () => ({ saveProjectActiveSession: saveProjectActiveSessionMock }))

import { captureLiveUI, createTabEngine, type TabEngine } from './tabEngine'
import { useFileViewerStore, getDefaultViewerWidth } from '@/stores/fileViewerStore'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useInputModeStore } from '@/stores/inputModeStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { createTab, useTabStore, type TabInit } from '@/stores/tabStore'
import { useUIStore, getDefaultSidebarWidth } from '@/stores/uiStore'
import type { ProjectInfo, SessionInfo } from '@/types/models'

const NO_PROJECT_ID = '__no_project__'

function makeProject(overrides: Partial<ProjectInfo> & { id: string }): ProjectInfo {
  return {
    name: `project-${overrides.id}`,
    workspace_path: `/ws/${overrides.id}`,
    is_external: false,
    is_no_project: false,
    created_at: '2026-01-01T00:00:00Z',
    last_active_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionInfo> & { id: string; project_id: string }): SessionInfo {
  return {
    name: `session-${overrides.id}`,
    created_at: '2026-01-01T00:00:00Z',
    last_active_at: '2026-01-01T00:00:00Z',
    archived: false,
    pinned: false,
    active: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: 'm',
    family: 'f',
    has_unfinished_task: false,
    ...overrides,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drain the engine's microtask chain (no timers involved anywhere). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

// --- Store resets ---

const realSelectSession = useSessionStore.getState().selectSession

let selectSessionMock: Mock<(id: string | null, projectId?: string) => void>
let engine: TabEngine
const switchMock = vi.fn<(id: string) => Promise<void>>()

function resetStores(): void {
  const tab = createTab()
  useTabStore.setState({ tabs: [tab], activeTabId: tab.id })
  useProjectStore.setState({
    projects: [
      makeProject({ id: NO_PROJECT_ID, is_no_project: true }),
      makeProject({ id: 'p1' }),
      makeProject({ id: 'p2' }),
      makeProject({ id: 'p3' }),
    ],
    activeProjectId: 'p1',
    lastRealProjectId: 'p1',
    createDialogOpen: false,
  })
  useSessionStore.setState({
    sessions: [
      makeSession({ id: 's1', project_id: 'p1' }),
      makeSession({ id: 's2', project_id: 'p1' }),
    ],
    activeSessionId: 's1',
    selectSession: realSelectSession,
  })
  useUIStore.setState({
    workspaceTabByProject: {},
    researchSegmentByProject: {},
    tabsEnabled: false,
    // The scalar shell slices reset to the stores' own boot defaults so a
    // fresh default tab's createDefaultTabUI snapshot stays content-equal
    // with a live capture (the reference-stable no-op contract).
    sidebarCollapsed: false,
    sidebarWidth: getDefaultSidebarWidth(),
    chatSessionListRatio: 0.5,
    showSessionStats: false,
  })
  useInputModeStore.setState({ mode: 'chat', height: 200, collapsedHeight: 200, isExpanded: false })
  useFileViewerStore.setState({
    files: {},
    openTabs: [],
    activeFile: null,
    fileIcons: {},
    width: getDefaultViewerWidth(),
    collapsed: false,
    pinned: false,
  })
  useGitPanelStore.setState({ activeTabByProject: {} })
  selectSessionMock = vi.fn<(id: string | null, projectId?: string) => void>()
  switchMock.mockReset()
  switchMock.mockResolvedValue(undefined)
  warnMock.mockReset()
  saveProjectActiveSessionMock.mockReset()
  saveProjectActiveSessionMock.mockResolvedValue(undefined)
  engine = createTabEngine(switchMock)
}

function tabById(id: string): ReturnType<typeof useTabStore.getState>['tabs'][number] {
  const tab = useTabStore.getState().tabs.find((t) => t.id === id)
  expect(tab).toBeDefined()
  return tab as NonNullable<ReturnType<typeof useTabStore.getState>['tabs'][number]>
}

/** The initial tab plus one background tab with the given init. */
function twoTabs(bInit?: TabInit): { aId: string; bId: string } {
  const aId = useTabStore.getState().tabs[0]!.id
  useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })
  const bId = useTabStore.getState().addTab(bInit)
  useTabStore.getState().activateTab(aId)
  return { aId, bId }
}

/**
 * selectSession spy that ALSO applies the real store effect (activeSessionId
 * move; the RPC persist is the module-level mock). Needed where a test
 * asserts the tab's converged context after activation: the engine's final
 * write-back mirrors the LIVE active id into the tab, so a spy-only
 * selectSession would leave the live session on the switch flow's landed
 * value instead of the re-selected one.
 */
function spyRealSelectSession(): void {
  useSessionStore.setState({
    selectSession: (id: string | null, projectId?: string) => {
      selectSessionMock(id, projectId)
      realSelectSession(id, projectId)
    },
  })
}

// --- Console hygiene: zero console noise across the whole file ---

let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let consoleWarnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetStores()
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  expect(consoleErrorSpy).not.toHaveBeenCalled()
  expect(consoleWarnSpy).not.toHaveBeenCalled()
  consoleErrorSpy.mockRestore()
  consoleWarnSpy.mockRestore()
})

describe('tabEngine.activate — guards', () => {
  it('activating the already-active tab is a reference-stable no-op (no RPC, no selectSession)', async () => {
    useSessionStore.setState({ selectSession: selectSessionMock })
    const before = useTabStore.getState()

    await engine.activate(before.activeTabId)

    expect(useTabStore.getState()).toBe(before)
    expect(switchMock).not.toHaveBeenCalled()
    expect(selectSessionMock).not.toHaveBeenCalled()
  })

  it('activating a tab id that no longer exists resolves silently without touching state', async () => {
    useSessionStore.setState({ selectSession: selectSessionMock })
    const before = useTabStore.getState()

    await engine.activate('vanished-tab')

    expect(useTabStore.getState()).toBe(before)
    expect(switchMock).not.toHaveBeenCalled()
    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(warnMock).not.toHaveBeenCalled()
  })
})

describe('tabEngine.activate — same project', () => {
  it('does NOT call the project switcher', async () => {
    useSessionStore.setState({ selectSession: selectSessionMock })
    const { bId } = twoTabs({ projectId: 'p1', sessionId: 's2' })

    await engine.activate(bId)

    expect(switchMock).not.toHaveBeenCalled()
    expect(useTabStore.getState().activeTabId).toBe(bId)
  })

  it('selects a differing session (no RPC through the switcher)', async () => {
    useSessionStore.setState({ selectSession: selectSessionMock })
    const { bId } = twoTabs({ projectId: 'p1', sessionId: 's2' })

    await engine.activate(bId)

    expect(selectSessionMock).toHaveBeenCalledExactlyOnceWith('s2', 'p1')
  })

  it('same project + same session: pure capture/flip/restore — no RPC, no selectSession', async () => {
    useSessionStore.setState({ selectSession: selectSessionMock })
    const { bId } = twoTabs({ projectId: 'p1', sessionId: 's1' })

    await engine.activate(bId)

    expect(switchMock).not.toHaveBeenCalled()
    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(useTabStore.getState().activeTabId).toBe(bId)
  })

  it('drops a deleted session reference instead of selecting it; the live session is untouched', async () => {
    useSessionStore.setState({ selectSession: selectSessionMock })
    const { bId } = twoTabs({ projectId: 'p1', sessionId: 'deleted-session' })

    await engine.activate(bId)

    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(useSessionStore.getState().activeSessionId).toBe('s1')
    // The stale id is gone from the tab; it converges to the live session.
    expect(tabById(bId).sessionId).toBe('s1')
  })

  it('captures the live context + slices into the OUTGOING tab before the flip', async () => {
    useUIStore.setState({ workspaceTabByProject: { p1: 'git' } })
    useInputModeStore.setState({ height: 320, isExpanded: true, collapsedHeight: 320 })
    const { aId, bId } = twoTabs({ projectId: 'p1', sessionId: 's1' })

    await engine.activate(bId)

    const a = tabById(aId)
    expect(a.projectId).toBe('p1')
    expect(a.sessionId).toBe('s1')
    expect(a.ui.workspaceTabByProject).toEqual({ p1: 'git' })
    expect(a.ui.inputMode).toEqual({ mode: 'chat', height: 320, collapsedHeight: 320, isExpanded: true })
  })

  it('restores the incoming tab\'s remembered slices into the live stores', async () => {
    const { bId } = twoTabs({
      projectId: 'p1',
      sessionId: 's1',
      ui: {
        workspaceTabByProject: { p1: 'research' },
        researchSegmentByProject: { p1: 'papers' },
        inputMode: { mode: 'terminal', height: 420, collapsedHeight: 420, isExpanded: true },
      },
    })

    await engine.activate(bId)

    expect(useUIStore.getState().workspaceTabByProject).toEqual({ p1: 'research' })
    expect(useUIStore.getState().researchSegmentByProject).toEqual({ p1: 'papers' })
    expect(useInputModeStore.getState()).toMatchObject({
      mode: 'terminal',
      height: 420,
      collapsedHeight: 420,
      isExpanded: true,
    })
  })

  it('merges remembered per-project maps entry-by-entry without erasing other projects', async () => {
    useUIStore.setState({ workspaceTabByProject: { p1: 'git' } })
    const { bId } = twoTabs({
      projectId: 'p1',
      sessionId: 's1',
      ui: { workspaceTabByProject: { p2: 'semantics' } },
    })

    await engine.activate(bId)

    expect(useUIStore.getState().workspaceTabByProject).toEqual({ p1: 'git', p2: 'semantics' })
  })

  it('selects the session BEFORE restoring the slices (documented order)', async () => {
    useSessionStore.setState({ selectSession: selectSessionMock })
    const setStateSpy = vi.spyOn(useInputModeStore, 'setState')
    const { bId } = twoTabs({
      projectId: 'p1',
      sessionId: 's2',
      ui: { inputMode: { mode: 'terminal', height: 400, collapsedHeight: 400, isExpanded: false } },
    })

    await engine.activate(bId)

    expect(selectSessionMock).toHaveBeenCalledTimes(1)
    expect(setStateSpy).toHaveBeenCalledTimes(1)
    expect(selectSessionMock.mock.invocationCallOrder[0]!).toBeLessThan(
      setStateSpy.mock.invocationCallOrder[0]!,
    )
    setStateSpy.mockRestore()
  })
})

describe('tabEngine.activate — v2 shell slices', () => {
  it('restores the remembered sidebar/viewer/git-panel/chat toggles into the live stores', async () => {
    const { bId } = twoTabs({
      projectId: 'p1',
      sessionId: 's1',
      ui: {
        sidebar: { collapsed: true, width: 300 },
        viewer: { pinned: true, collapsed: false, width: 640 },
        gitPanelTabByProject: { p1: 'history' },
        chatSessionListRatio: 0.3,
        showSessionStats: true,
      },
    })

    await engine.activate(bId)

    const ui = useUIStore.getState()
    expect(ui.sidebarCollapsed).toBe(true)
    expect(ui.sidebarWidth).toBe(300)
    expect(ui.chatSessionListRatio).toBe(0.3)
    expect(ui.showSessionStats).toBe(true)
    const viewer = useFileViewerStore.getState()
    expect(viewer.pinned).toBe(true)
    expect(viewer.collapsed).toBe(false)
    expect(viewer.width).toBe(640)
    expect(useGitPanelStore.getState().activeTabByProject).toEqual({ p1: 'history' })
  })

  it('merges the remembered git-panel map entry-by-entry without erasing other projects', async () => {
    useGitPanelStore.setState({ activeTabByProject: { p1: 'changes' } })
    const { bId } = twoTabs({
      projectId: 'p1',
      sessionId: 's1',
      ui: { gitPanelTabByProject: { p2: 'files' } },
    })

    await engine.activate(bId)

    expect(useGitPanelStore.getState().activeTabByProject).toEqual({ p1: 'changes', p2: 'files' })
  })

  it('the empty-floating invariant outranks the snapshot: an unpinned restore cannot float an empty viewer', async () => {
    // Live viewer: unpinned with NO open tabs (the docked-rail state).
    useFileViewerStore.setState({ openTabs: [], activeFile: null, pinned: false, collapsed: true })
    const { bId } = twoTabs({
      projectId: 'p1',
      sessionId: 's1',
      ui: { viewer: { pinned: false, collapsed: false, width: 640 } },
    })

    await engine.activate(bId)

    const viewer = useFileViewerStore.getState()
    expect(viewer.pinned).toBe(false)
    expect(viewer.width).toBe(640)
    // …but the viewer stays collapsed: an unpinned viewer with zero open tabs
    // recedes to the docked rail, exactly like restoreProjectFiles enforces.
    expect(viewer.collapsed).toBe(true)
  })

  it('restores an expanded viewer when the invariant does not apply (tabs are open)', async () => {
    useFileViewerStore.setState({ openTabs: ['/ws/x.ts'], activeFile: '/ws/x.ts', pinned: false, collapsed: true })
    const { bId } = twoTabs({
      projectId: 'p1',
      sessionId: 's1',
      ui: { viewer: { pinned: false, collapsed: false, width: 640 } },
    })

    await engine.activate(bId)

    expect(useFileViewerStore.getState().collapsed).toBe(false)
  })

  it('captures the live v2 slices into the OUTGOING tab before the flip', async () => {
    useUIStore.setState({ sidebarCollapsed: true, sidebarWidth: 280, chatSessionListRatio: 0.25, showSessionStats: true })
    useFileViewerStore.setState({ pinned: true, collapsed: false, width: 720 })
    useGitPanelStore.setState({ activeTabByProject: { p1: 'changes' } })
    const { aId, bId } = twoTabs({ projectId: 'p1', sessionId: 's1' })

    await engine.activate(bId)

    const a = tabById(aId)
    expect(a.ui.sidebar).toEqual({ collapsed: true, width: 280 })
    expect(a.ui.viewer).toEqual({ pinned: true, collapsed: false, width: 720 })
    expect(a.ui.gitPanelTabByProject).toEqual({ p1: 'changes' })
    expect(a.ui.chatSessionListRatio).toBe(0.25)
    expect(a.ui.showSessionStats).toBe(true)
  })
})

describe('tabEngine.activate — cross project', () => {
  /** Simulate the real switch's store effect: the project (and a session) move. */
  function switchMovesProject(): void {
    switchMock.mockImplementation(async (id: string) => {
      useProjectStore.getState().setActiveProjectId(id)
      useSessionStore.getState().setActiveSessionId(id === NO_PROJECT_ID ? 'np1' : null)
    })
  }

  it('switches the project; a session-less tab keeps the switch flow\'s restore (no selectSession)', async () => {
    switchMovesProject()
    useSessionStore.setState({ selectSession: selectSessionMock })
    const { bId } = twoTabs({ projectId: 'p2', sessionId: null })

    await engine.activate(bId)

    expect(switchMock).toHaveBeenCalledExactlyOnceWith('p2')
    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(useProjectStore.getState().activeProjectId).toBe('p2')
    // Final write-back converges the tab with the (session-less) live context.
    expect(tabById(bId).projectId).toBe('p2')
    expect(tabById(bId).sessionId).toBeNull()
  })

  it('restores the tab\'s OWN remembered session after the switch (the project\'s shared pointer does not win)', async () => {
    // The switch flow lands on the project's SHARED saved-session pointer —
    // deliberately a DIFFERENT session than the tab remembers (the shape
    // behind the same-project tab-convergence bug).
    switchMock.mockImplementation(async (id: string) => {
      useProjectStore.getState().setActiveProjectId(id)
      useSessionStore.getState().setSessions([
        makeSession({ id: 'p2-own', project_id: 'p2' }),
        makeSession({ id: 'p2-pointer', project_id: 'p2' }),
      ])
      useSessionStore.getState().setActiveSessionId('p2-pointer')
    })
    spyRealSelectSession()
    const { bId } = twoTabs({ projectId: 'p2', sessionId: 'p2-own' })

    await engine.activate(bId)

    expect(selectSessionMock).toHaveBeenCalledExactlyOnceWith('p2-own', 'p2')
    expect(useSessionStore.getState().activeSessionId).toBe('p2-own')
    expect(tabById(bId).sessionId).toBe('p2-own')
  })

  it('does NOT re-select when the switch already landed on the remembered session (no redundant persist)', async () => {
    switchMock.mockImplementation(async (id: string) => {
      useProjectStore.getState().setActiveProjectId(id)
      useSessionStore.getState().setSessions([makeSession({ id: 's9', project_id: 'p2' })])
      useSessionStore.getState().setActiveSessionId('s9')
    })
    useSessionStore.setState({ selectSession: selectSessionMock })
    const { bId } = twoTabs({ projectId: 'p2', sessionId: 's9' })

    await engine.activate(bId)

    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(useSessionStore.getState().activeSessionId).toBe('s9')
  })

  it('drops a remembered session that no longer exists in the destination project', async () => {
    switchMock.mockImplementation(async (id: string) => {
      useProjectStore.getState().setActiveProjectId(id)
      useSessionStore.getState().setSessions([makeSession({ id: 'p2-live', project_id: 'p2' })])
      useSessionStore.getState().setActiveSessionId('p2-live')
    })
    useSessionStore.setState({ selectSession: selectSessionMock })
    const { bId } = twoTabs({ projectId: 'p2', sessionId: 'p2-deleted' })

    await engine.activate(bId)

    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(useSessionStore.getState().activeSessionId).toBe('p2-live')
    // The dead id is gone from the tab; it converged with the live session.
    expect(tabById(bId).sessionId).toBe('p2-live')
  })

  it('two same-project tabs keep their own sessions across a CHAT round trip (no convergence onto the shared pointer)', async () => {
    spyRealSelectSession()
    const aId = useTabStore.getState().tabs[0]!.id
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })
    const bId = useTabStore.getState().addTab({ projectId: 'p1', sessionId: 's2' })
    const cId = useTabStore.getState().addTab({ projectId: null, sessionId: null })
    useTabStore.getState().activateTab(aId)

    switchMock.mockImplementation(async (id: string) => {
      useProjectStore.getState().setActiveProjectId(id)
      if (id === NO_PROJECT_ID) {
        useSessionStore.getState().setSessions([makeSession({ id: 'np1', project_id: NO_PROJECT_ID })])
        useSessionStore.getState().setActiveSessionId('np1')
        return
      }
      // Switching BACK to p1: the shared saved-session pointer lands on s2
      // (it was persisted while tab B was last live) — NOT tab A's s1.
      useSessionStore.getState().setSessions([
        makeSession({ id: 's1', project_id: 'p1' }),
        makeSession({ id: 's2', project_id: 'p1' }),
      ])
      useSessionStore.getState().setActiveSessionId('s2')
    })

    await engine.activate(cId)
    await engine.activate(aId)

    // The engine re-selected tab A's OWN session over the landed pointer.
    expect(selectSessionMock).toHaveBeenCalledExactlyOnceWith('s1', 'p1')
    expect(useProjectStore.getState().activeProjectId).toBe('p1')
    expect(useSessionStore.getState().activeSessionId).toBe('s1')
    expect(tabById(aId).sessionId).toBe('s1')
    // Tab B's memory is untouched — activating it later must not land on s1.
    expect(tabById(bId).sessionId).toBe('s2')
  })

  it('two CHAT tabs keep their own sessions (the single CHAT saved-session bucket does not win)', async () => {
    spyRealSelectSession()
    const aId = useTabStore.getState().tabs[0]!.id
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })
    const c1Id = useTabStore.getState().addTab({ projectId: null, sessionId: 'np1' })
    const c2Id = useTabStore.getState().addTab({ projectId: null, sessionId: 'np2' })
    useTabStore.getState().activateTab(aId)

    switchMock.mockImplementation(async (id: string) => {
      useProjectStore.getState().setActiveProjectId(id)
      if (id === NO_PROJECT_ID) {
        useSessionStore.getState().setSessions([
          makeSession({ id: 'np1', project_id: NO_PROJECT_ID }),
          makeSession({ id: 'np2', project_id: NO_PROJECT_ID }),
        ])
        // The single CHAT pointer lands on np1 (the OTHER chat tab's session).
        useSessionStore.getState().setActiveSessionId('np1')
        return
      }
      useSessionStore.getState().setSessions([makeSession({ id: 's1', project_id: 'p1' })])
      useSessionStore.getState().setActiveSessionId('s1')
    })

    await engine.activate(c2Id)

    expect(selectSessionMock).toHaveBeenCalledExactlyOnceWith('np2', NO_PROJECT_ID)
    expect(useSessionStore.getState().activeSessionId).toBe('np2')
    expect(tabById(c2Id).sessionId).toBe('np2')
    // The other CHAT tab's memory is untouched.
    expect(tabById(c1Id).sessionId).toBe('np1')
  })

  it('flips activeTabId optimistically: the tab is active while the switch is still in flight', async () => {
    const d = deferred()
    switchMock.mockImplementation(async (id: string) => {
      useProjectStore.getState().setActiveProjectId(id)
      await d.promise
    })
    const { bId } = twoTabs({ projectId: 'p2' })

    const done = engine.activate(bId)
    await flush()

    expect(useTabStore.getState().activeTabId).toBe(bId)
    expect(switchMock).toHaveBeenCalledTimes(1)

    d.resolve()
    await done
    expect(useProjectStore.getState().activeProjectId).toBe('p2')
  })

  it('restores the remembered slices only AFTER the switch resolves', async () => {
    const d = deferred()
    switchMock.mockImplementation(async (id: string) => {
      useProjectStore.getState().setActiveProjectId(id)
      await d.promise
    })
    const { bId } = twoTabs({
      projectId: 'p2',
      ui: { workspaceTabByProject: { p2: 'research' } },
    })

    const done = engine.activate(bId)
    await flush()
    // Still in flight: the restore has not landed yet.
    expect(useUIStore.getState().workspaceTabByProject).toEqual({})

    d.resolve()
    await done
    expect(useUIStore.getState().workspaceTabByProject).toEqual({ p2: 'research' })
  })

  it('restores the slices AFTER the switch RPC (invocation order)', async () => {
    switchMovesProject()
    const setStateSpy = vi.spyOn(useInputModeStore, 'setState')
    const { bId } = twoTabs({ projectId: 'p2' })

    await engine.activate(bId)

    expect(switchMock).toHaveBeenCalledTimes(1)
    expect(setStateSpy).toHaveBeenCalledTimes(1)
    expect(switchMock.mock.invocationCallOrder[0]!).toBeLessThan(
      setStateSpy.mock.invocationCallOrder[0]!,
    )
    setStateSpy.mockRestore()
  })

  it('a CHAT tab (projectId null) switches to the No Project pseudo-project', async () => {
    switchMovesProject()
    const { bId } = twoTabs({ projectId: null, sessionId: null })

    await engine.activate(bId)

    expect(switchMock).toHaveBeenCalledExactlyOnceWith(NO_PROJECT_ID)
    expect(useProjectStore.getState().activeProjectId).toBe(NO_PROJECT_ID)
    expect(tabById(bId).projectId).toBe(NO_PROJECT_ID)
  })

  it('a tab whose project was deleted is retargeted to the CHAT pseudo-project and activated there', async () => {
    switchMovesProject()
    useSessionStore.setState({ selectSession: selectSessionMock })
    const { bId } = twoTabs({ projectId: 'deleted-project', sessionId: 'ghost' })

    await engine.activate(bId)

    // The retarget clears the remembered session — the ghost id must not be
    // re-selected into the CHAT pseudo-project.
    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(switchMock).toHaveBeenCalledExactlyOnceWith(NO_PROJECT_ID)
    expect(useProjectStore.getState().activeProjectId).toBe(NO_PROJECT_ID)
    // The stale project/session references were reset; the tab converged with CHAT.
    expect(tabById(bId).projectId).toBe(NO_PROJECT_ID)
    expect(tabById(bId).sessionId).toBe('np1')
    expect(warnMock).not.toHaveBeenCalled()
  })

  it('a mid-switch write-back cannot clobber the remembered slices (restore uses the pre-await snapshot)', async () => {
    switchMovesProject()
    const detach = engine.attachWriteBack()
    try {
      const d = deferred()
      switchMock.mockImplementation(async (id: string) => {
        useProjectStore.getState().setActiveProjectId(id)
        // Live map churn while the switch is in flight (e.g. an event lands):
        // the attached write-back re-mirrors live into the active tab.
        useUIStore.getState().setWorkspaceTab('p1', 'semantics')
        await d.promise
      })
      const { bId } = twoTabs({
        projectId: 'p2',
        ui: { workspaceTabByProject: { p2: 'git' } },
      })

      const done = engine.activate(bId)
      await flush()
      // The mid-flight mirror overwrote the stored snapshot with live slices…
      expect(tabById(bId).ui.workspaceTabByProject).toEqual({ p1: 'semantics' })

      d.resolve()
      await done
      // …but the restore still applied what the tab REMEMBERED, and the final
      // write-back stored the merged result.
      expect(useUIStore.getState().workspaceTabByProject).toEqual({ p1: 'semantics', p2: 'git' })
      expect(tabById(bId).ui.workspaceTabByProject).toEqual({ p1: 'semantics', p2: 'git' })
    } finally {
      detach()
    }
  })
})

describe('tabEngine.activate — rollback & serialization', () => {
  it('a failed switch rolls activeTabId back to the outgoing tab, warns once, and RESOLVES (no rejection)', async () => {
    switchMock.mockRejectedValueOnce(new Error('switch failed'))
    const { aId, bId } = twoTabs({ projectId: 'p2' })

    await expect(engine.activate(bId)).resolves.toBeUndefined()

    expect(useTabStore.getState().activeTabId).toBe(aId)
    expect(warnMock).toHaveBeenCalledTimes(1)
    // The refocused tab mirrors the (unchanged) live context again.
    expect(tabById(aId).projectId).toBe('p1')
    expect(tabById(aId).sessionId).toBe('s1')
  })

  it('parallel activations serialize: the second switch starts only after the first completes', async () => {
    const d = deferred()
    switchMock.mockImplementationOnce(() => d.promise)
    const aId = useTabStore.getState().tabs[0]!.id
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })
    const bId = useTabStore.getState().addTab({ projectId: 'p2' })
    const cId = useTabStore.getState().addTab({ projectId: 'p3' })
    useTabStore.getState().activateTab(aId)

    const first = engine.activate(bId)
    const second = engine.activate(cId)
    await flush()

    expect(switchMock).toHaveBeenCalledTimes(1)
    expect(switchMock).toHaveBeenCalledWith('p2')

    d.resolve()
    await Promise.all([first, second])

    expect(switchMock).toHaveBeenCalledTimes(2)
    expect(switchMock).toHaveBeenLastCalledWith('p3')
    expect(useTabStore.getState().activeTabId).toBe(cId)
  })

  it('parallel activations ACROSS engine instances serialize on the shared chain (banner-click bare engine vs controller)', async () => {
    // Two engines exactly like production: the AppLayout controller and the
    // bare notification-click engine (useNotificationClicks builds its own).
    const controller = createTabEngine(switchMock)
    const bare = createTabEngine(switchMock)
    useSessionStore.setState({ selectSession: selectSessionMock })

    const aId = useTabStore.getState().tabs[0]!.id
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })
    const bId = useTabStore.getState().addTab({ projectId: 'p2' })
    const cId = useTabStore.getState().addTab({ projectId: 'p1', sessionId: 's2' })
    useTabStore.getState().activateTab(aId)

    // Controller: cross-project activation held in flight by a gated switch.
    const gate = deferred()
    switchMock.mockImplementationOnce(() => gate.promise)
    const first = controller.activate(bId)
    await flush()
    expect(useTabStore.getState().activeTabId).toBe(bId)
    expect(switchMock).toHaveBeenCalledTimes(1)

    // The bare engine's SAME-PROJECT activation (no switcher call at all —
    // the switch chain cannot serialize it) must still wait for the
    // controller's in-flight body to complete before touching any store.
    const second = bare.activate(cId)
    await flush()
    expect(useTabStore.getState().activeTabId).toBe(bId)
    expect(selectSessionMock).not.toHaveBeenCalled()

    gate.resolve()
    await Promise.all([first, second])

    expect(useTabStore.getState().activeTabId).toBe(cId)
    expect(selectSessionMock).toHaveBeenCalledExactlyOnceWith('s2', 'p1')
  })

  it('a failed activation does not poison the chain: the next activation still runs', async () => {
    switchMock.mockRejectedValueOnce(new Error('switch failed'))
    const aId = useTabStore.getState().tabs[0]!.id
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })
    const bId = useTabStore.getState().addTab({ projectId: 'p2' })
    const cId = useTabStore.getState().addTab({ projectId: 'p3' })
    useTabStore.getState().activateTab(aId)

    await engine.activate(bId)
    expect(useTabStore.getState().activeTabId).toBe(aId)

    await engine.activate(cId)
    expect(switchMock).toHaveBeenLastCalledWith('p3')
    expect(useTabStore.getState().activeTabId).toBe(cId)
    expect(warnMock).toHaveBeenCalledTimes(1)
  })
})

describe('tabEngine.createAndActivate', () => {
  /** Simulate the real switch's store effect: the project (and a session) move. */
  function switchMovesProject(): void {
    switchMock.mockImplementation(async (id: string) => {
      useProjectStore.getState().setActiveProjectId(id)
      useSessionStore.getState().setActiveSessionId(id === NO_PROJECT_ID ? 'np1' : null)
    })
  }

  it('seed-less creation inherits the LIVE context (the «+» semantic) — no switch, no select, panel untouched', async () => {
    useSessionStore.setState({ selectSession: selectSessionMock })
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })
    // A non-default live panel: the fresh tab must capture (not reset) it.
    useInputModeStore.setState({ mode: 'terminal', height: 420, collapsedHeight: 96, isExpanded: true })

    await engine.createAndActivate()

    expect(switchMock).not.toHaveBeenCalled()
    expect(selectSessionMock).not.toHaveBeenCalled()
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(2)
    const fresh = state.tabs[1]!
    expect(state.activeTabId).toBe(fresh.id)
    // Same project + same session: the fresh tab rides the clean
    // capture/flip/restore path and converges with the live workspace.
    expect(fresh.projectId).toBe('p1')
    expect(fresh.sessionId).toBe('s1')
    // The captured live slice is what the tab remembers — and the live panel
    // itself survived the creation untouched.
    expect(fresh.ui.inputMode).toEqual({ mode: 'terminal', height: 420, collapsedHeight: 96, isExpanded: true })
    expect(useInputModeStore.getState()).toMatchObject({ mode: 'terminal', height: 420 })
  })

  it('serializes creation behind an in-flight activation: no half-created tab to graft a context onto', async () => {
    switchMovesProject()
    useSessionStore.setState({ selectSession: selectSessionMock })
    const { bId } = twoTabs({ projectId: 'p2', sessionId: 's-p2' })

    // The first activation stalls mid-switch (after its optimistic flip).
    const gate = deferred()
    switchMock.mockImplementationOnce(async (id: string) => {
      await gate.promise
      useProjectStore.getState().setActiveProjectId(id)
      useSessionStore.getState().setActiveSessionId('s-p2')
    })
    const first = engine.activate(bId)
    // The chain link runs on a microtask: drain to the stalled switch, THEN
    // assert the mid-flight state (the optimistic flip has happened, the
    // switch is awaiting the gate).
    await flush()
    expect(useTabStore.getState().activeTabId).toBe(bId)

    // «+» clicked mid-switch: creation enqueues BEHIND the in-flight
    // activation. NOTHING exists yet — an out-of-chain addTab would have
    // already created the tab here, and the resuming activation would graft
    // its restore + write-back onto it.
    const created = engine.createAndActivate()
    expect(useTabStore.getState().tabs).toHaveLength(2)

    gate.resolve()
    await Promise.all([first, created])

    // The in-flight activation completed on ITS tab first; only then did the
    // link create the fresh tab.
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(3)
    const fresh = state.tabs[2]!
    expect(state.activeTabId).toBe(fresh.id)
    // The seed was read at LINK-RUN time — the live, post-switch workspace
    // (b's context), never a's stale click-time context.
    expect(fresh.projectId).toBe('p2')
    expect(fresh.sessionId).toBe('s-p2')
  })

  it('an explicit seed (the banner click) materializes the clicked context through the full path', async () => {
    switchMovesProject()
    spyRealSelectSession()
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 's1', project_id: 'p1' }),
        makeSession({ id: 's2', project_id: 'p1' }),
        makeSession({ id: 's-p2', project_id: 'p2' }),
      ],
    })
    const aId = useTabStore.getState().tabs[0]!.id
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })

    await engine.createAndActivate({ projectId: 'p2', sessionId: 's-p2' })

    expect(switchMock).toHaveBeenCalledExactlyOnceWith('p2')
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(2)
    const fresh = state.tabs[1]!
    expect(state.activeTabId).toBe(fresh.id)
    expect(fresh.projectId).toBe('p2')
    // The tab's own remembered session was selected through the switch flow
    // and converged back into the tab.
    expect(fresh.sessionId).toBe('s-p2')
    expect(useSessionStore.getState().activeSessionId).toBe('s-p2')
    expect(selectSessionMock).toHaveBeenCalledExactlyOnceWith('s-p2', 'p2')
    // The outgoing tab kept the workspace it was showing.
    expect(state.tabs.find((t) => t.id === aId)!.sessionId).toBe('s1')
  })

  it('a failed seeded creation keeps the created tab, rolls the active pointer back, and never rejects', async () => {
    switchMock.mockRejectedValueOnce(new Error('switch failed'))
    const aId = useTabStore.getState().tabs[0]!.id
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })

    await expect(engine.createAndActivate({ projectId: 'p2', sessionId: null })).resolves.toBeUndefined()

    const state = useTabStore.getState()
    // The banner-survival contract: the created tab STAYS in the strip with
    // its clicked context (a re-click finds it via the exact-match lookup).
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs[1]!.projectId).toBe('p2')
    expect(state.tabs[1]!.sessionId).toBeNull()
    // The active pointer rolled back onto the outgoing tab; the engine warned.
    expect(state.activeTabId).toBe(aId)
    expect(warnMock).toHaveBeenCalledTimes(1)
  })
})

describe('tabEngine write-back', () => {
  it('adopting the live context on attach: the single tab mirrors project, session and slices (flag off)', async () => {
    useUIStore.setState({ workspaceTabByProject: { p1: 'git' } })
    useInputModeStore.setState({ height: 260 })
    const tabId = useTabStore.getState().tabs[0]!.id

    const detach = engine.attachWriteBack()
    try {
      const tab = tabById(tabId)
      expect(tab.projectId).toBe('p1')
      expect(tab.sessionId).toBe('s1')
      expect(tab.ui.workspaceTabByProject).toEqual({ p1: 'git' })
      expect(tab.ui.inputMode.height).toBe(260)
    } finally {
      detach()
    }
  })

  it('mirrors live project/session/ui/input changes into the active tab', async () => {
    const detach = engine.attachWriteBack()
    try {
      const tabId = useTabStore.getState().tabs[0]!.id
      expect(tabById(tabId).projectId).toBe('p1')

      useProjectStore.getState().setActiveProjectId('p2')
      useSessionStore.getState().setActiveSessionId('s2')
      useUIStore.getState().setWorkspaceTab('p2', 'git')
      useInputModeStore.getState().setMode('terminal')

      const tab = tabById(tabId)
      expect(tab.projectId).toBe('p2')
      expect(tab.sessionId).toBe('s2')
      expect(tab.ui.workspaceTabByProject).toEqual({ p2: 'git' })
      expect(tab.ui.inputMode.mode).toBe('terminal')
    } finally {
      detach()
    }
  })

  it('mirrors live sidebar/viewer/git-panel/chat-toggle changes into the active tab', () => {
    const detach = engine.attachWriteBack()
    try {
      const tabId = useTabStore.getState().tabs[0]!.id

      useUIStore.getState().setSidebarCollapsed(true)
      useUIStore.getState().setSidebarWidth(320)
      useUIStore.getState().setChatSessionListRatio(0.2)
      useUIStore.getState().setShowSessionStats(true)
      useFileViewerStore.getState().setPinned(true)
      useFileViewerStore.getState().setWidth(760)
      useGitPanelStore.getState().setActiveTab('p1', 'history')

      const tab = tabById(tabId)
      expect(tab.ui.sidebar).toEqual({ collapsed: true, width: 320 })
      expect(tab.ui.viewer).toEqual({ pinned: true, collapsed: false, width: 760 })
      expect(tab.ui.gitPanelTabByProject).toEqual({ p1: 'history' })
      expect(tab.ui.chatSessionListRatio).toBe(0.2)
      expect(tab.ui.showSessionStats).toBe(true)
    } finally {
      detach()
    }
  })

  it('works with the flag ON too — the write-back never reads tabsEnabled', async () => {
    useUIStore.setState({ tabsEnabled: true })
    const detach = engine.attachWriteBack()
    try {
      const tabId = useTabStore.getState().tabs[0]!.id
      useSessionStore.getState().setActiveSessionId('s2')
      expect(tabById(tabId).sessionId).toBe('s2')
    } finally {
      detach()
    }
  })

  it('writes ONLY the active tab: a background tab keeps its captured snapshot', async () => {
    useUIStore.setState({ workspaceTabByProject: { p1: 'git' } })
    const { aId, bId } = twoTabs({ projectId: 'p1', sessionId: 's2' })
    // Activating B captured the live slices into the outgoing A.
    await engine.activate(bId)
    const detach = engine.attachWriteBack()
    try {
      useUIStore.getState().setWorkspaceTab('p1', 'semantics')

      // The active tab mirrors the live map…
      expect(tabById(bId).ui.workspaceTabByProject).toEqual({ p1: 'semantics' })
      // …the background tab keeps the snapshot it was left with.
      expect(tabById(aId).ui.workspaceTabByProject).toEqual({ p1: 'git' })
    } finally {
      detach()
    }
  })

  it('stops mirroring after detach', async () => {
    const detach = engine.attachWriteBack()
    detach()

    const tabId = useTabStore.getState().tabs[0]!.id
    const before = tabById(tabId)
    useSessionStore.getState().setActiveSessionId('s2')

    expect(tabById(tabId)).toBe(before)
    expect(tabById(tabId).sessionId).toBe('s1')
  })

  it('content-equal mirroring is a reference-stable no-op (no render churn)', async () => {
    const detach = engine.attachWriteBack()
    try {
      const tabId = useTabStore.getState().tabs[0]!.id
      const before = tabById(tabId)
      const storeBefore = useTabStore.getState()

      engine.writeBack()

      expect(useTabStore.getState()).toBe(storeBefore)
      expect(tabById(tabId)).toBe(before)
    } finally {
      detach()
    }
  })
})

describe('captureLiveUI (the banner-click creation seed)', () => {
  it('captures the full v2 composition from the live stores', () => {
    useUIStore.setState({ sidebarCollapsed: true, sidebarWidth: 280, chatSessionListRatio: 0.6, showSessionStats: true })
    useFileViewerStore.setState({ pinned: true, collapsed: false, width: 720 })
    useGitPanelStore.setState({ activeTabByProject: { p1: 'history' } })
    useInputModeStore.setState({ mode: 'terminal', height: 380 })

    const ui = captureLiveUI()

    expect(ui.sidebar).toEqual({ collapsed: true, width: 280 })
    expect(ui.viewer).toEqual({ pinned: true, collapsed: false, width: 720 })
    expect(ui.gitPanelTabByProject).toEqual({ p1: 'history' })
    expect(ui.chatSessionListRatio).toBe(0.6)
    expect(ui.showSessionStats).toBe(true)
    expect(ui.inputMode.mode).toBe('terminal')
    expect(ui.workspaceTabByProject).toEqual({})
  })
})
