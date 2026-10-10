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

import { createTabEngine, type TabEngine } from './tabEngine'
import { useInputModeStore } from '@/stores/inputModeStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { createTab, useTabStore, type TabInit } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
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
  useUIStore.setState({ workspaceTabByProject: {}, researchSegmentByProject: {}, tabsEnabled: false })
  useInputModeStore.setState({ mode: 'chat', height: 200, collapsedHeight: 200, isExpanded: false })
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

describe('tabEngine.activate — cross project', () => {
  /** Simulate the real switch's store effect: the project (and a session) move. */
  function switchMovesProject(): void {
    switchMock.mockImplementation(async (id: string) => {
      useProjectStore.getState().setActiveProjectId(id)
      useSessionStore.getState().setActiveSessionId(id === NO_PROJECT_ID ? 'np1' : null)
    })
  }

  it('switches the project and never calls selectSession (the switch flow owns session restore)', async () => {
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
    const { bId } = twoTabs({ projectId: 'deleted-project', sessionId: 'ghost' })

    await engine.activate(bId)

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
