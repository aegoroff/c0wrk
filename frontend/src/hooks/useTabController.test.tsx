// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The engine's project switcher — mocked so activations never reach the Wails
// runtime and the switch RPC is directly assertable.
const { switchMock } = vi.hoisted(() => ({ switchMock: vi.fn<(id: string) => Promise<void>>() }))
vi.mock('@/hooks/useProjectSwitchState', () => ({ useProjectSwitchState: () => switchMock }))

// The engine reports failures through the logger — intercept at the source.
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: warnMock, error: vi.fn() },
}))

// sessionStore.selectSession persists through this RPC — keep it at the boundary.
const { saveProjectActiveSessionMock } = vi.hoisted(() => ({ saveProjectActiveSessionMock: vi.fn() }))
vi.mock('@/api/projects', () => ({ saveProjectActiveSession: saveProjectActiveSessionMock }))

import { useTabController, type TabController } from './useTabController'
import { createTab, useTabStore } from '@/stores/tabStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUIStore } from '@/stores/uiStore'
import { useInputModeStore } from '@/stores/inputModeStore'
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

function resetStores(): void {
  const tab = createTab()
  useTabStore.setState({ tabs: [tab], activeTabId: tab.id })
  useProjectStore.setState({
    projects: [
      makeProject({ id: NO_PROJECT_ID, is_no_project: true }),
      makeProject({ id: 'p1' }),
      makeProject({ id: 'p2' }),
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
  })
  useUIStore.setState({ workspaceTabByProject: {}, researchSegmentByProject: {}, tabsEnabled: false })
  useInputModeStore.setState({ mode: 'chat', height: 200, collapsedHeight: 200, isExpanded: false })
  switchMock.mockReset()
  switchMock.mockResolvedValue(undefined)
  warnMock.mockReset()
  saveProjectActiveSessionMock.mockReset()
  saveProjectActiveSessionMock.mockResolvedValue(undefined)
}

// --- Harness (no @testing-library/react in this repo — raw act + createRoot) ---

let root: Root | null = null
let container: HTMLDivElement | null = null
let captured: TabController | null = null

function Harness(): null {
  captured = useTabController()
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

function unmount(): void {
  if (root !== null) {
    act(() => {
      root?.unmount()
    })
    root = null
  }
  container?.remove()
  container = null
  captured = null
}

beforeEach(() => {
  resetStores()
})

afterEach(() => {
  unmount()
})

// --- Console hygiene: zero console noise across the whole file ---

let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let consoleWarnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  expect(consoleErrorSpy).not.toHaveBeenCalled()
  expect(consoleWarnSpy).not.toHaveBeenCalled()
  consoleErrorSpy.mockRestore()
  consoleWarnSpy.mockRestore()
})

describe('useTabController', () => {
  it('on mount the single tab adopts the live context (write-back attached unconditionally)', () => {
    useUIStore.setState({ workspaceTabByProject: { p1: 'git' } })
    const tabId = useTabStore.getState().tabs[0]!.id

    renderHook()

    const tab = useTabStore.getState().tabs.find((t) => t.id === tabId)
    expect(tab?.projectId).toBe('p1')
    expect(tab?.sessionId).toBe('s1')
    expect(tab?.ui.workspaceTabByProject).toEqual({ p1: 'git' })
    expect(switchMock).not.toHaveBeenCalled()
  })

  it('mirrors live changes while mounted and stops after unmount', () => {
    const tabId = useTabStore.getState().tabs[0]!.id

    renderHook()
    act(() => {
      useSessionStore.getState().setActiveSessionId('s2')
      useInputModeStore.getState().setMode('terminal')
    })
    const tab = useTabStore.getState().tabs.find((t) => t.id === tabId)
    expect(tab?.sessionId).toBe('s2')
    expect(tab?.ui.inputMode.mode).toBe('terminal')

    unmount()
    act(() => {
      useSessionStore.getState().setActiveSessionId('s1')
    })
    const after = useTabStore.getState().tabs.find((t) => t.id === tabId)
    expect(after?.sessionId).toBe('s2')
  })

  it('activate flips the active tab within the same project without any switch RPC', async () => {
    renderHook()
    const aId = useTabStore.getState().tabs[0]!.id
    useTabStore.getState().updateActiveContext({ projectId: 'p1', sessionId: 's1' })
    const bId = useTabStore.getState().addTab({ projectId: 'p1', sessionId: 's2' })
    act(() => {
      useTabStore.getState().activateTab(aId)
    })

    const controller = captured as TabController
    await act(async () => {
      await controller.activate(bId)
    })

    expect(useTabStore.getState().activeTabId).toBe(bId)
    expect(switchMock).not.toHaveBeenCalled()
  })

  it('returns a referentially stable activate across re-renders', () => {
    renderHook()
    const first = (captured as TabController).activate

    act(() => {
      root?.render(createElement(Harness))
    })

    expect((captured as TabController).activate).toBe(first)
  })
})
