// @vitest-environment jsdom
//
// Tests for useNotificationClicks — the App-root listener that turns a
// `notification_clicked` global event into navigation (project switch →
// session select, the live-sessions radar's pattern). The store seam and the
// project-switch hook are mocked; the api/notifications subscription is
// captured so each test can push an event through the REAL subscription path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Capture the subscription the hook installs, and drive it manually.
type ClickCallback = (data: { notification_id: string; session_id: string; project_id: string }) => void
let capturedCallback: ClickCallback | null = null
const { switchProjectWithStateMock } = vi.hoisted(() => ({ switchProjectWithStateMock: vi.fn() }))

vi.mock('@/api/notifications', () => ({
  onNotificationClicked: (cb: ClickCallback) => {
    capturedCallback = cb
    return () => {
      capturedCallback = null
    }
  },
  initSystemNotifications: vi.fn(async () => {}),
  sendSystemNotification: vi.fn(async () => {}),
  showTestNotification: vi.fn(async () => {}),
}))
vi.mock('@/hooks/useProjectSwitchState', () => ({
  useProjectSwitchState: () => switchProjectWithStateMock,
}))

import { useNotificationClicks } from '@/hooks/useNotificationClicks'
import { useActiveSessionsStore } from '@/stores/activeSessionsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { useTabStore, createTab } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import { useInputModeStore } from '@/stores/inputModeStore'
import type { SessionInfo } from '@/types/models'

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const ts = new Date(0).toISOString()
  return {
    id: 's1',
    project_id: 'p1',
    name: 'Session',
    created_at: ts,
    last_active_at: ts,
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

const selectSessionMock = vi.fn()
const refreshNowMock = vi.fn(async () => {})

const roots: Root[] = []

function mount(): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<Probe />)
  })
}

function Probe() {
  useNotificationClicks()
  return null
}

/** Push an event through the captured subscription and flush microtasks. */
async function click(payload: Parameters<ClickCallback>[0]): Promise<void> {
  const cb = capturedCallback
  if (!cb) throw new Error('subscription not installed')
  await act(async () => {
    cb(payload)
    // Bounded microtask flush: the flag-on path runs through the tab engine's
    // promise chain (no timers — the switcher is mocked), so draining ticks
    // deterministically settles it. No sleeps.
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve()
    }
  })
}

/** Seed the tab layer with the given contexts; the first tab starts active. */
function seedTabs(defs: Array<{ projectId: string | null; sessionId: string | null }>): string[] {
  const tabs = defs.map((d) => createTab(d))
  useTabStore.setState({ tabs, activeTabId: tabs[0]!.id })
  return tabs.map((t) => t.id)
}

beforeEach(() => {
  capturedCallback = null
  switchProjectWithStateMock.mockReset()
  switchProjectWithStateMock.mockResolvedValue(undefined)
  selectSessionMock.mockReset()
  // Make the mocked selectSession behave like the real store (flip the live
  // session) so the engine's final write-back converges like production.
  selectSessionMock.mockImplementation((sessionId: string) => {
    useSessionStore.setState({ activeSessionId: sessionId })
  })
  refreshNowMock.mockReset()
  refreshNowMock.mockResolvedValue(undefined)
  useActiveSessionsStore.setState({
    sessions: null,
    pendingOverride: {},
    refreshing: false,
    refreshNow: refreshNowMock,
  } as never)
  useSessionStore.setState({ sessions: null, activeSessionId: null, selectSession: selectSessionMock } as never)
  useProjectStore.setState({ projects: null, activeProjectId: 'p-cur', lastRealProjectId: null } as never)
  // Fresh single-tab layer; the flag defaults OFF so the flag-off tests keep
  // today's exact behavior (the hook reads the flag at click time).
  const freshTab = createTab()
  useTabStore.setState({ tabs: [freshTab], activeTabId: freshTab.id })
  useUIStore.setState({ tabsEnabled: false })
  mount()
})

// Every test mounts its own root: unmount them all and clear the body so no
// stale Probe (or accumulated container) survives into a later test — the
// same cleanup contract the sibling harnesses (useTabController, TabBar,
// useWindowTitle) follow.
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount()
    })
  }
  document.body.innerHTML = ''
})

describe('useNotificationClicks', () => {
  it('switches project first, then selects the session (radar pattern)', async () => {
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-2', project_id: 'p-2' })],
    } as never)

    await click({ notification_id: 'n1', session_id: 's-2', project_id: 'p-2' })

    expect(switchProjectWithStateMock).toHaveBeenCalledTimes(1)
    expect(switchProjectWithStateMock).toHaveBeenCalledWith('p-2')
    expect(selectSessionMock).toHaveBeenCalledTimes(1)
    expect(selectSessionMock).toHaveBeenCalledWith('s-2', 'p-2')
    // The switch order runs BEFORE the select (invocation call order).
    const switchOrder = switchProjectWithStateMock.mock.invocationCallOrder[0]!
    const selectOrder = selectSessionMock.mock.invocationCallOrder[0]!
    expect(switchOrder).toBeLessThan(selectOrder)
  })

  it('skips the project switch when already on that project', async () => {
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-cur', project_id: 'p-cur' })],
    } as never)

    await click({ notification_id: 'n2', session_id: 's-cur', project_id: 'p-cur' })

    expect(switchProjectWithStateMock).not.toHaveBeenCalled()
    expect(selectSessionMock).toHaveBeenCalledWith('s-cur', 'p-cur')
  })

  it('resolves the project from the snapshot when the payload omits it', async () => {
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-3', project_id: 'p-3' })],
    } as never)

    await click({ notification_id: 'n3', session_id: 's-3', project_id: '' })

    expect(switchProjectWithStateMock).toHaveBeenCalledWith('p-3')
    expect(selectSessionMock).toHaveBeenCalledWith('s-3', 'p-3')
  })

  it('refreshes the snapshot once before declaring a session unknown', async () => {
    // First read: not present. refreshNow then reveals it.
    useActiveSessionsStore.setState({ sessions: [makeSession({ id: 'other', project_id: 'p-1' })] } as never)
    refreshNowMock.mockImplementation(async () => {
      useActiveSessionsStore.setState({
        sessions: [makeSession({ id: 's-late', project_id: 'p-late' })],
      } as never)
    })

    await click({ notification_id: 'n4', session_id: 's-late', project_id: '' })

    expect(refreshNowMock).toHaveBeenCalledTimes(1)
    expect(selectSessionMock).toHaveBeenCalledWith('s-late', 'p-late')
  })

  it('a click on an unknown session id is a logged no-op', async () => {
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 'other', project_id: 'p-1' })],
    } as never)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      await click({ notification_id: 'n5', session_id: 'ghost', project_id: 'p-1' })
    } finally {
      infoSpy.mockRestore()
    }

    expect(refreshNowMock).toHaveBeenCalledTimes(1)
    expect(switchProjectWithStateMock).not.toHaveBeenCalled()
    expect(selectSessionMock).not.toHaveBeenCalled()
  })

  it('an unattributed banner (empty session id) focuses only — no navigation', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      await click({ notification_id: 'n6', session_id: '', project_id: '' })
    } finally {
      debugSpy.mockRestore()
    }

    expect(refreshNowMock).not.toHaveBeenCalled()
    expect(switchProjectWithStateMock).not.toHaveBeenCalled()
    expect(selectSessionMock).not.toHaveBeenCalled()
  })

  it('survives a failed project switch without selecting', async () => {
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-x', project_id: 'p-x' })],
    } as never)
    switchProjectWithStateMock.mockRejectedValue(new Error('switch failed'))

    await click({ notification_id: 'n7', session_id: 's-x', project_id: 'p-x' })

    expect(switchProjectWithStateMock).toHaveBeenCalledTimes(1)
    expect(selectSessionMock).not.toHaveBeenCalled()
  })

  // --- tabsEnabled ON: routing goes through the tab engine ---

  it('flag on: activates the existing exact-match tab instead of switching directly', async () => {
    useUIStore.setState({ tabsEnabled: true })
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-2', project_id: 'p-2' })],
    } as never)
    const [, tabTarget] = seedTabs([
      { projectId: 'p-cur', sessionId: 's-cur' },
      { projectId: 'p-2', sessionId: 's-2' },
    ])
    // Simulate the switch flow's store writes so the engine's final
    // write-back converges like production.
    switchProjectWithStateMock.mockImplementation(async (pid: string) => {
      useProjectStore.setState({ activeProjectId: pid })
      useSessionStore.setState({ activeSessionId: 's-2' })
    })

    await click({ notification_id: 'n10', session_id: 's-2', project_id: 'p-2' })

    // The engine owns navigation: switch happened, no direct selectSession.
    expect(switchProjectWithStateMock).toHaveBeenCalledTimes(1)
    expect(switchProjectWithStateMock).toHaveBeenCalledWith('p-2')
    expect(selectSessionMock).not.toHaveBeenCalled()
    // The pre-existing tab is now active — no tab was created.
    const state = useTabStore.getState()
    expect(state.activeTabId).toBe(tabTarget)
    expect(state.tabs).toHaveLength(2)
    const target = state.tabs.find((t) => t.id === tabTarget)
    expect(target?.projectId).toBe('p-2')
    expect(target?.sessionId).toBe('s-2')
  })

  it('flag on: creates a tab carrying the clicked context and the engine materializes it', async () => {
    useUIStore.setState({ tabsEnabled: true })
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-2', project_id: 'p-2' })],
    } as never)
    useSessionStore.setState({ activeSessionId: 's-cur' })
    const [tabCur] = seedTabs([{ projectId: 'p-cur', sessionId: 's-cur' }])
    switchProjectWithStateMock.mockImplementation(async (pid: string) => {
      useProjectStore.setState({ activeProjectId: pid })
      useSessionStore.setState({ activeSessionId: 's-2' })
    })

    await click({ notification_id: 'n11', session_id: 's-2', project_id: 'p-2' })

    expect(switchProjectWithStateMock).toHaveBeenCalledWith('p-2')
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.activeTabId).not.toBe(tabCur)
    const active = state.tabs.find((t) => t.id === state.activeTabId)
    expect(active?.projectId).toBe('p-2')
    expect(active?.sessionId).toBe('s-2')
    // The outgoing tab kept the workspace it was showing (captured on the way
    // out by the engine).
    const outgoing = state.tabs.find((t) => t.id === tabCur)
    expect(outgoing?.projectId).toBe('p-cur')
    expect(outgoing?.sessionId).toBe('s-cur')
  })

  it('flag on: a created tab carries the live input slice and the panel is left untouched', async () => {
    useUIStore.setState({ tabsEnabled: true })
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-2', project_id: 'p-2' })],
    } as never)
    useSessionStore.setState({ activeSessionId: 's-cur' })
    seedTabs([{ projectId: 'p-cur', sessionId: 's-cur' }])
    // A non-default live panel: the pre-fix default-snapshot path reset it
    // to chat/200/200/false on exactly this click.
    useInputModeStore.setState({ mode: 'terminal', height: 432, collapsedHeight: 96, isExpanded: true })
    switchProjectWithStateMock.mockImplementation(async (pid: string) => {
      useProjectStore.setState({ activeProjectId: pid })
      useSessionStore.setState({ activeSessionId: 's-2' })
    })

    await click({ notification_id: 'n19', session_id: 's-2', project_id: 'p-2' })

    // The live input panel survived the banner click untouched.
    const input = useInputModeStore.getState()
    expect(input.mode).toBe('terminal')
    expect(input.height).toBe(432)
    expect(input.collapsedHeight).toBe(96)
    expect(input.isExpanded).toBe(true)
    // The created tab remembers exactly the panel it materialized from.
    const state = useTabStore.getState()
    const active = state.tabs.find((t) => t.id === state.activeTabId)
    expect(active?.ui.inputMode).toEqual({
      mode: 'terminal',
      height: 432,
      collapsedHeight: 96,
      isExpanded: true,
    })
  })

  it('flag on: a same-project session tab routes through selectSession without a switch', async () => {
    useUIStore.setState({ tabsEnabled: true })
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-9', project_id: 'p-cur' })],
    } as never)
    const [, tabOther] = seedTabs([
      { projectId: 'p-cur', sessionId: 's-cur' },
      { projectId: 'p-cur', sessionId: 's-9' },
    ])

    await click({ notification_id: 'n12', session_id: 's-9', project_id: 'p-cur' })

    expect(switchProjectWithStateMock).not.toHaveBeenCalled()
    expect(selectSessionMock).toHaveBeenCalledTimes(1)
    expect(selectSessionMock).toHaveBeenCalledWith('s-9', 'p-cur')
    const state = useTabStore.getState()
    expect(state.activeTabId).toBe(tabOther)
    expect(state.tabs).toHaveLength(2)
  })

  it('flag on: an exact {project, session} match wins over a session-only match', async () => {
    useUIStore.setState({ tabsEnabled: true })
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-2', project_id: 'p-2' })],
    } as never)
    const [, tabExact, tabLoose] = seedTabs([
      { projectId: 'p-cur', sessionId: 's-cur' },
      { projectId: 'p-2', sessionId: 's-2' },
      { projectId: 'p-stale', sessionId: 's-2' },
    ])

    await click({ notification_id: 'n13', session_id: 's-2', project_id: 'p-2' })

    const state = useTabStore.getState()
    expect(state.activeTabId).toBe(tabExact)
    expect(state.activeTabId).not.toBe(tabLoose)
    expect(state.tabs).toHaveLength(3)
  })

  it('flag on: a session-only match reuses that tab instead of creating one', async () => {
    useUIStore.setState({ tabsEnabled: true })
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-2', project_id: 'p-2' })],
    } as never)
    const [, tabLoose] = seedTabs([
      { projectId: 'p-cur', sessionId: 's-cur' },
      { projectId: 'p-stale', sessionId: 's-2' },
    ])

    await click({ notification_id: 'n14', session_id: 's-2', project_id: 'p-2' })

    const state = useTabStore.getState()
    // The tab is reused (no third tab created); the engine materializes the
    // TAB's own recorded context — its project drives the switch.
    expect(state.activeTabId).toBe(tabLoose)
    expect(state.tabs).toHaveLength(2)
    expect(switchProjectWithStateMock).toHaveBeenCalledWith('p-stale')
  })

  // --- tabsEnabled OFF: today's behavior, the tab store is untouched ---

  it('flag off: direct switch/select navigation and the tab store is untouched', async () => {
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-2', project_id: 'p-2' })],
    } as never)
    const [tabCur, tabExtra] = seedTabs([
      { projectId: 'p-cur', sessionId: 's-cur' },
      { projectId: 'p-2', sessionId: 's-other' },
    ])
    // Seed a live session too, so a stray write-back would be observable.
    useSessionStore.setState({ activeSessionId: 's-cur' })
    const before = useTabStore.getState()

    await click({ notification_id: 'n15', session_id: 's-2', project_id: 'p-2' })

    // Today's radar pattern, byte for byte.
    expect(switchProjectWithStateMock).toHaveBeenCalledTimes(1)
    expect(switchProjectWithStateMock).toHaveBeenCalledWith('p-2')
    expect(selectSessionMock).toHaveBeenCalledTimes(1)
    expect(selectSessionMock).toHaveBeenCalledWith('s-2', 'p-2')
    // The tab layer was not even written to (same state reference).
    const after = useTabStore.getState()
    expect(after).toBe(before)
    expect(after.activeTabId).toBe(tabCur)
    expect(after.tabs.find((t) => t.id === tabExtra)?.sessionId).toBe('s-other')
  })

  // --- negative branches hold under the flag too ---

  it('flag on: an unknown session id stays a no-op — no tab is created', async () => {
    useUIStore.setState({ tabsEnabled: true })
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 'other', project_id: 'p-1' })],
    } as never)
    const before = useTabStore.getState()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      await click({ notification_id: 'n16', session_id: 'ghost', project_id: 'p-1' })
    } finally {
      infoSpy.mockRestore()
    }

    expect(refreshNowMock).toHaveBeenCalledTimes(1)
    expect(switchProjectWithStateMock).not.toHaveBeenCalled()
    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(useTabStore.getState()).toBe(before)
  })

  it('flag on: an unattributed banner (empty session id) focuses only', async () => {
    useUIStore.setState({ tabsEnabled: true })
    const before = useTabStore.getState()
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      await click({ notification_id: 'n17', session_id: '', project_id: '' })
    } finally {
      debugSpy.mockRestore()
    }

    expect(refreshNowMock).not.toHaveBeenCalled()
    expect(switchProjectWithStateMock).not.toHaveBeenCalled()
    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(useTabStore.getState()).toBe(before)
  })

  it('flag on: a failed activation rolls the tab back, warns once, and never rejects', async () => {
    useUIStore.setState({ tabsEnabled: true })
    useActiveSessionsStore.setState({
      sessions: [makeSession({ id: 's-2', project_id: 'p-2' })],
    } as never)
    const [tabCur] = seedTabs([
      { projectId: 'p-cur', sessionId: 's-cur' },
      { projectId: 'p-2', sessionId: 's-2' },
    ])
    switchProjectWithStateMock.mockRejectedValue(new Error('switch failed'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Capture before mockRestore — restoring resets the call history.
    let warnings = 0
    try {
      await click({ notification_id: 'n18', session_id: 's-2', project_id: 'p-2' })
      warnings = warnSpy.mock.calls.length
    } finally {
      warnSpy.mockRestore()
    }

    // The engine rolled the optimistic flip back to the outgoing tab and
    // reported the failure exactly once; the click resolved (await above).
    expect(warnings).toBe(1)
    expect(useTabStore.getState().activeTabId).toBe(tabCur)
  })
})
