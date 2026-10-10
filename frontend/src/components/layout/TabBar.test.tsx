// @vitest-environment jsdom
//
// TabBar — the workspace tab strip UI.
//
// The bar is presentational: activation flows through the TabController prop
// (faked here — the engine has its own suite), while add/close hit the real
// tabStore and titles/statuses derive live from the real project/session/
// chat stores by id.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TabBar } from './TabBar'
import { createTab, useTabStore } from '@/stores/tabStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useChatStore } from '@/stores/chatStore'
import { useActiveSessionsStore } from '@/stores/activeSessionsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { TabController } from '@/hooks/useTabController'
import type { ProjectInfo, SessionInfo } from '@/types/models'

// --- fixtures ---

const NO_PROJECT: ProjectInfo = {
  id: 'no-project-id',
  name: 'No Project',
  workspace_path: '',
  is_external: false,
  is_no_project: true,
  created_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
}

const PROJ: ProjectInfo = {
  id: 'proj-1',
  name: 'Demo',
  workspace_path: '/tmp/demo',
  is_external: false,
  is_no_project: false,
  created_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
}

const SESS: SessionInfo = {
  id: 'sess-1',
  project_id: 'proj-1',
  name: 'Fix the bug',
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
}

function fakeController() {
  return {
    activate: vi.fn((_tabId: string) => Promise.resolve()),
    writeBack: vi.fn(),
  } satisfies TabController
}

// --- harness ---

let container: HTMLDivElement
let root: Root

function renderBar(controller = fakeController()): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<TabBar controller={controller} />)
  })
}

function tabRows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'))
}

function rowByLabel(label: string): HTMLElement {
  const row = tabRows().find((r) => r.textContent?.includes(label))
  if (!row) throw new Error(`tab row "${label}" not found`)
  return row
}

function buttonByLabel(label: string): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!btn) throw new Error(`button "${label}" not found`)
  return btn
}

function flush(): Promise<void> {
  return act(async () => {})
}

beforeEach(() => {
  const first = createTab()
  useTabStore.setState({ tabs: [first], activeTabId: first.id })
  useProjectStore.setState({
    projects: [NO_PROJECT, PROJ],
    activeProjectId: PROJ.id,
    lastRealProjectId: PROJ.id,
  })
  useSessionStore.setState({ sessions: [SESS], activeSessionId: SESS.id })
  useChatStore.setState({ taskActive: {}, paused: {}, unfinishedTaskStatus: {} })
  useActiveSessionsStore.setState({ pendingOverride: {} })
  useSettingsStore.setState({ open: false, activeTab: 'general' })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  document.body.innerHTML = ''
})

// --- rendered bar ---

describe('TabBar', () => {
  it('renders an ARIA tablist with live titles and roving tabindex', () => {
    const chatTab = createTab()
    const projTab = createTab({ projectId: PROJ.id, sessionId: SESS.id })
    useTabStore.setState({ tabs: [chatTab, projTab], activeTabId: projTab.id })
    renderBar()

    const list = container.querySelector('[role="tablist"]')
    expect(list?.getAttribute('aria-label')).toBe('Workspace tabs')

    const rows = tabRows()
    expect(rows).toHaveLength(2)
    // Live titles resolved by id against the stores (CHAT fallback for the
    // null-project tab; project: session for the CODE tab).
    expect(rows[0]?.textContent).toContain('New Tab')
    expect(rows[1]?.textContent).toContain('Demo: Fix the bug')
    // aria-selected + roving tabindex follow the active tab.
    expect(rows[0]?.getAttribute('aria-selected')).toBe('false')
    expect(rows[0]?.getAttribute('tabindex')).toBe('-1')
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true')
    expect(rows[1]?.getAttribute('tabindex')).toBe('0')
  })

  it('activates through the controller on click', () => {
    const t1 = createTab()
    const t2 = createTab({ projectId: PROJ.id })
    useTabStore.setState({ tabs: [t1, t2], activeTabId: t1.id })
    const controller = fakeController()
    renderBar(controller)

    act(() => {
      rowByLabel('Demo').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(controller.activate).toHaveBeenCalledWith(t2.id)
  })

  it('closes an inactive tab directly, without activation', () => {
    const t1 = createTab()
    const t2 = createTab({ projectId: PROJ.id })
    useTabStore.setState({ tabs: [t1, t2], activeTabId: t1.id })
    const controller = fakeController()
    renderBar(controller)

    act(() => {
      buttonByLabel('Close Demo').click()
    })
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual([t1.id])
    expect(controller.activate).not.toHaveBeenCalled()
  })

  it('closes the ACTIVE tab through the engine first, then removes it', async () => {
    const t1 = createTab()
    const t2 = createTab({ projectId: PROJ.id })
    useTabStore.setState({ tabs: [t1, t2], activeTabId: t1.id })
    const controller = fakeController()
    renderBar(controller)

    act(() => {
      buttonByLabel('Close New Tab').click()
    })
    // The neighbor went through the activation path BEFORE removal.
    expect(controller.activate).toHaveBeenCalledWith(t2.id)
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual([t1, t2].map((t) => t.id))
    await flush()
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual([t2.id])
    expect(useTabStore.getState().activeTabId).toBe(t2.id)
  })

  it('closes on middle-click', () => {
    const t1 = createTab()
    const t2 = createTab({ projectId: PROJ.id })
    useTabStore.setState({ tabs: [t1, t2], activeTabId: t1.id })
    renderBar()

    act(() => {
      rowByLabel('Demo').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 }))
    })
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual([t1.id])
  })

  it('replaces the last tab on close and converges it to the live workspace', () => {
    const only = createTab()
    useTabStore.setState({ tabs: [only], activeTabId: only.id })
    const controller = fakeController()
    renderBar(controller)

    act(() => {
      buttonByLabel('Close New Tab').click()
    })
    // Invariant 1: the layer is never empty — a fresh default tab replaced it.
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.id).not.toBe(only.id)
    expect(state.activeTabId).toBe(state.tabs[0]?.id)
    // The fresh active tab was converged immediately (no stale-context lag).
    expect(controller.writeBack).toHaveBeenCalledTimes(1)
  })

  it('«+» appends an active tab and converges it through the controller', () => {
    const t1 = createTab()
    useTabStore.setState({ tabs: [t1], activeTabId: t1.id })
    const controller = fakeController()
    renderBar(controller)

    act(() => {
      buttonByLabel('New tab').click()
    })
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.activeTabId).not.toBe(t1.id)
    expect(controller.activate).toHaveBeenCalledWith(state.activeTabId)
    expect(controller.writeBack).toHaveBeenCalledTimes(1)
  })

  it('opens Settings aimed at the Appearance section', () => {
    renderBar()
    act(() => {
      buttonByLabel('Settings').click()
    })
    const settings = useSettingsStore.getState()
    expect(settings.open).toBe(true)
    expect(settings.activeTab).toBe('appearance')
  })

  it('paints the session status dot from the single shared derivation', () => {
    const projTab = createTab({ projectId: PROJ.id, sessionId: SESS.id })
    const bareTab = createTab()
    useTabStore.setState({ tabs: [projTab, bareTab], activeTabId: projTab.id })
    renderBar()

    // Idle: no dot anywhere.
    expect(rowByLabel('Demo').querySelector('[title="Task running"]')).toBeNull()

    // Active (live chatStore flag).
    act(() => {
      useChatStore.setState({ taskActive: { [SESS.id]: true } })
    })
    expect(rowByLabel('Demo').querySelector('.bg-success')).not.toBeNull()
    expect(rowByLabel('New Tab').querySelector('.bg-success')).toBeNull()

    // Failed (DB snapshot fallback) beats a stale live running flag — the
    // deriveSessionStatus priority, verified through the UI surface.
    act(() => {
      useChatStore.setState({ taskActive: { [SESS.id]: true } })
      useSessionStore.setState({
        sessions: [{ ...SESS, unfinished_task_status: 'failed' }],
      })
    })
    expect(rowByLabel('Demo').querySelector('.bg-destructive')).not.toBeNull()
  })
})

// --- keyboard interaction on the strip (APG tabs, manual activation) ---

describe('TabBar keyboard', () => {
  /** Dispatch a bubbling, cancelable keydown; false when preventDefaulted. */
  function press(el: Element, key: string): boolean {
    let delivered = true
    act(() => {
      delivered = el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
    return delivered
  }

  function setup(controller = fakeController()) {
    const t1 = createTab()
    const t2 = createTab({ projectId: PROJ.id })
    useTabStore.setState({ tabs: [t1, t2], activeTabId: t1.id })
    renderBar(controller)
    return { controller, t1, t2 }
  }

  it('carries data-tab-id so keyboard activation targets the right tab', () => {
    const { t1, t2 } = setup()
    expect(rowByLabel('New Tab').dataset.tabId).toBe(t1.id)
    expect(rowByLabel('Demo').dataset.tabId).toBe(t2.id)
  })

  it('Enter and Space activate the focused row, default suppressed', () => {
    const { controller, t2 } = setup()
    const row = rowByLabel('Demo')
    act(() => {
      row.focus()
    })
    expect(document.activeElement).toBe(row)

    expect(press(row, 'Enter')).toBe(false)
    expect(press(row, ' ')).toBe(false)
    expect(controller.activate).toHaveBeenNthCalledWith(1, t2.id)
    expect(controller.activate).toHaveBeenNthCalledWith(2, t2.id)
  })

  it('arrows move focus between rows without switching tabs', () => {
    const { controller, t1 } = setup()
    const rows = tabRows()
    act(() => {
      rows[0].focus()
    })

    press(rows[0]!, 'ArrowRight')
    expect(document.activeElement).toBe(rows[1])
    press(rows[1]!, 'ArrowLeft')
    expect(document.activeElement).toBe(rows[0])
    // Manual activation: focus-only arrows never switch.
    expect(controller.activate).not.toHaveBeenCalled()
    expect(useTabStore.getState().activeTabId).toBe(t1.id)
  })

  it('arrow navigation wraps around both ends', () => {
    setup()
    const rows = tabRows()
    act(() => {
      rows[0].focus()
    })
    press(rows[0]!, 'ArrowLeft')
    expect(document.activeElement).toBe(rows[1])
    press(rows[1]!, 'ArrowRight')
    expect(document.activeElement).toBe(rows[0])
  })

  it('Home/End jump to the first/last row', () => {
    setup()
    const rows = tabRows()
    act(() => {
      rows[0].focus()
    })
    press(rows[0]!, 'End')
    expect(document.activeElement).toBe(rows[1])
    press(rows[1]!, 'Home')
    expect(document.activeElement).toBe(rows[0])
  })

  it('keys on the nested close button keep native semantics', () => {
    const { controller } = setup()
    const closeButton = buttonByLabel('Close Demo')
    act(() => {
      closeButton.focus()
    })
    // Not intercepted: no preventDefault, no tab switch, no focus move.
    expect(press(closeButton, 'Enter')).toBe(true)
    expect(press(closeButton, 'ArrowRight')).toBe(true)
    expect(document.activeElement).toBe(closeButton)
    expect(controller.activate).not.toHaveBeenCalled()
  })

  it('unrelated keys are ignored entirely', () => {
    const { controller } = setup()
    const row = rowByLabel('New Tab')
    act(() => {
      row.focus()
    })
    expect(press(row, 'a')).toBe(true)
    expect(document.activeElement).toBe(row)
    expect(controller.activate).not.toHaveBeenCalled()
  })
})
