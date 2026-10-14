// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// --- Mock the Wails boundary so tests never touch the native runtime ---
const { runtimeMocks } = vi.hoisted(() => ({
  runtimeMocks: { setWindowTitle: vi.fn() },
}))

vi.mock('@/api/runtime', () => runtimeMocks)
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { APP_NAME, CHAT_LABEL, buildWindowTitle, selectSessionNameFor, selectTitleScopeFor, useWindowTitle } from './useWindowTitle'
import { useProjectStore, type ProjectState } from '@/stores/projectStore'
import { useSessionStore, type SessionState } from '@/stores/sessionStore'
import { createTab, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import type { ProjectInfo, SessionInfo } from '@/types/models'

const NO_PROJECT_ID = '__no_project__'

function makeProject(overrides: Partial<ProjectInfo> & { id: string }): ProjectInfo {
  return {
    name: overrides.name ?? `Project ${overrides.id}`,
    workspace_path: overrides.workspace_path ?? '/tmp',
    is_external: overrides.is_external ?? false,
    is_no_project: overrides.is_no_project ?? false,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    last_active_at: overrides.last_active_at ?? '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    project_id: overrides.project_id ?? 'proj-a',
    name: overrides.name ?? `Session ${overrides.id}`,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    last_active_at: overrides.last_active_at ?? '2026-01-01T00:00:00Z',
    archived: overrides.archived ?? false,
    pinned: overrides.pinned ?? false,
    active: overrides.active ?? false,
    total_input_tokens: overrides.total_input_tokens ?? 0,
    total_output_tokens: overrides.total_output_tokens ?? 0,
    model: overrides.model ?? 'test-model',
    family: overrides.family ?? 'test',
    has_unfinished_task: overrides.has_unfinished_task ?? false,
    ...overrides,
  }
}

// --- Pure title assembly -----------------------------------------------------

describe('buildWindowTitle', () => {
  it('returns the bare app name when no scope is active', () => {
    expect(buildWindowTitle(null, null)).toBe('c0wrk')
  })

  it('drops a session that has no project scope (no dangling separator)', () => {
    expect(buildWindowTitle(null, 'Refactor auth')).toBe('c0wrk')
  })

  it('renders the app name and project scope without a session', () => {
    expect(buildWindowTitle('MyProject', null)).toBe('c0wrk - MyProject')
  })

  it('renders the full `APP_NAME - <scope>: <session>` template', () => {
    expect(buildWindowTitle('MyProject', 'Refactor auth')).toBe('c0wrk - MyProject: Refactor auth')
  })

  it('renders the CHAT scope the same way', () => {
    expect(buildWindowTitle(CHAT_LABEL, 'Quick question')).toBe('c0wrk - CHAT: Quick question')
  })

  it('treats a blank scope as absent', () => {
    expect(buildWindowTitle('   ', 'Refactor auth')).toBe('c0wrk')
  })

  it('treats a blank session name as absent (no trailing colon)', () => {
    expect(buildWindowTitle('MyProject', '   ')).toBe('c0wrk - MyProject')
  })

  it('trims surrounding whitespace from both segments', () => {
    expect(buildWindowTitle('  MyProject  ', '  Refactor auth  ')).toBe('c0wrk - MyProject: Refactor auth')
  })

  it('exports the app name used as the first segment', () => {
    expect(APP_NAME).toBe('c0wrk')
  })
})

// --- Pure id-keyed lookups -----------------------------------------------------

function projectState(projects: ProjectInfo[] | null): ProjectState {
  return { projects, activeProjectId: null, lastRealProjectId: null, createDialogOpen: false }
}

function sessionState(sessions: SessionInfo[] | null): SessionState {
  return { sessions, activeSessionId: null }
}

describe('selectTitleScopeFor / selectSessionNameFor', () => {
  it('resolves a project id to its name and a session id to its name', () => {
    const projects = projectState([makeProject({ id: 'proj-a', name: 'MyProject' })])
    expect(selectTitleScopeFor(projects, 'proj-a')).toBe('MyProject')
    expect(selectTitleScopeFor(projects, 'missing')).toBeNull()
    expect(selectTitleScopeFor(projects, null)).toBeNull()

    const sessions = sessionState([makeSession({ id: 'sess-1', name: 'Refactor auth' })])
    expect(selectSessionNameFor(sessions, 'sess-1')).toBe('Refactor auth')
    expect(selectSessionNameFor(sessions, 'missing')).toBeNull()
    expect(selectSessionNameFor(sessions, null)).toBeNull()
  })

  it('maps the No Project entry to CHAT and loading stores to null', () => {
    expect(
      selectTitleScopeFor(
        projectState([makeProject({ id: NO_PROJECT_ID, name: 'No Project', is_no_project: true })]),
        NO_PROJECT_ID,
      ),
    ).toBe(CHAT_LABEL)
    expect(selectTitleScopeFor(projectState(null), NO_PROJECT_ID)).toBeNull()
    expect(selectSessionNameFor(sessionState(null), 'sess-1')).toBeNull()
  })
})

// --- Hook wiring -------------------------------------------------------------

let container: HTMLDivElement | null = null
let root: Root | null = null

function Harness() {
  useWindowTitle()
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

/** Title most recently pushed to the native runtime. */
function lastTitle(): string | undefined {
  const calls = runtimeMocks.setWindowTitle.mock.calls
  return calls[calls.length - 1]?.[0] as string | undefined
}

/** Total number of title pushes — the effect-cycle guard metric. */
function pushCount(): number {
  return runtimeMocks.setWindowTitle.mock.calls.length
}

function resetStores() {
  useProjectStore.setState({
    projects: null,
    activeProjectId: null,
    lastRealProjectId: null,
    createDialogOpen: false,
  })
  useSessionStore.setState({ sessions: null, activeSessionId: null })
  // A fresh boot always starts from exactly one default tab (the tab layer's
  // ≥1-tab invariant), mirroring the app's flag-off special case.
  const fresh = createTab()
  useTabStore.setState({ tabs: [fresh], activeTabId: fresh.id })
  useUIStore.setState({ tabsEnabled: false })
}

beforeEach(() => {
  runtimeMocks.setWindowTitle.mockReset()
  resetStores()
})

afterEach(() => {
  if (root) {
    const r = root
    root = null
    act(() => {
      r.unmount()
    })
  }
  container?.remove()
  container = null
})

/**
 * Point the active tab at the given context. In the flag-off special case the
 * single tab mirrors the live project/session context — every test below that
 * activates a project/session mirrors it onto the tab, exactly what the tab
 * wiring does in the real app.
 */
function mirrorActiveTab(projectId: string | null, sessionId: string | null): void {
  useTabStore.getState().updateActiveContext({ projectId, sessionId })
}

describe('useWindowTitle', () => {
  it('sets the bare app name on mount with nothing active', () => {
    renderHook()
    expect(lastTitle()).toBe('c0wrk')
    // Exactly one push for one state — the baseline cycle guard.
    expect(pushCount()).toBe(1)
  })

  it('adds the project segment once a project becomes active', () => {
    const project = makeProject({ id: 'proj-a', name: 'MyProject' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([project])
      useProjectStore.getState().setActiveProjectId('proj-a')
      mirrorActiveTab('proj-a', null)
    })

    expect(lastTitle()).toBe('c0wrk - MyProject')
  })

  it('adds the session segment after the project scope once a session is selected', () => {
    const project = makeProject({ id: 'proj-a', name: 'MyProject' })
    const session = makeSession({ id: 'sess-1', name: 'Refactor auth' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([project])
      useProjectStore.getState().setActiveProjectId('proj-a')
      useSessionStore.getState().setSessions([session])
      useSessionStore.getState().setActiveSessionId('sess-1')
      mirrorActiveTab('proj-a', 'sess-1')
    })

    expect(lastTitle()).toBe('c0wrk - MyProject: Refactor auth')
  })

  it('shows CHAT instead of the No Project name', () => {
    const noProject = makeProject({ id: NO_PROJECT_ID, name: 'No Project', is_no_project: true })
    const session = makeSession({ id: 'sess-1', project_id: NO_PROJECT_ID, name: 'Quick question' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([noProject])
      useProjectStore.getState().setActiveProjectId(NO_PROJECT_ID)
      useSessionStore.getState().setSessions([session])
      useSessionStore.getState().setActiveSessionId('sess-1')
      mirrorActiveTab(NO_PROJECT_ID, 'sess-1')
    })

    expect(lastTitle()).toBe('c0wrk - CHAT: Quick question')
  })

  it('follows the active tab ids even when the stores own active pointers differ', () => {
    const projA = makeProject({ id: 'proj-a', name: 'Alpha' })
    const projB = makeProject({ id: 'proj-b', name: 'Beta' })
    const sessA = makeSession({ id: 'sess-a', project_id: 'proj-a', name: 'Refactor auth' })
    const sessB = makeSession({ id: 'sess-b', project_id: 'proj-b', name: 'Write docs' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([projA, projB])
      useProjectStore.getState().setActiveProjectId('proj-a')
      useSessionStore.getState().setSessions([sessA, sessB])
      useSessionStore.getState().setActiveSessionId('sess-a')
    })
    expect(lastTitle()).toBe('c0wrk')

    // The new tab is activated by addTab and points at project B — the title
    // must show the TAB's context, not the stores' active pointers (which
    // still say proj-a/sess-a).
    act(() => {
      useTabStore.getState().addTab({ projectId: 'proj-b', sessionId: 'sess-b' })
    })

    expect(lastTitle()).toBe('c0wrk - Beta: Write docs')
  })

  it('switching the active tab swaps the title to the incoming tab context', () => {
    const projA = makeProject({ id: 'proj-a', name: 'Alpha' })
    const projB = makeProject({ id: 'proj-b', name: 'Beta' })
    const sessA = makeSession({ id: 'sess-a', project_id: 'proj-a', name: 'Refactor auth' })
    const sessB = makeSession({ id: 'sess-b', project_id: 'proj-b', name: 'Write docs' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([projA, projB])
      useSessionStore.getState().setSessions([sessA, sessB])
      mirrorActiveTab('proj-a', 'sess-a')
    })
    expect(lastTitle()).toBe('c0wrk - Alpha: Refactor auth')
    expect(pushCount()).toBe(2)

    const firstId = useTabStore.getState().activeTabId
    let secondId = ''
    act(() => {
      secondId = useTabStore.getState().addTab({ projectId: 'proj-b', sessionId: 'sess-b' })
    })
    expect(secondId).not.toBe(firstId)
    expect(lastTitle()).toBe('c0wrk - Beta: Write docs')

    act(() => {
      useTabStore.getState().activateTab(firstId)
    })
    expect(lastTitle()).toBe('c0wrk - Alpha: Refactor auth')

    act(() => {
      useTabStore.getState().activateTab(secondId)
    })
    expect(lastTitle()).toBe('c0wrk - Beta: Write docs')

    // Every push corresponds to a real visible change: mount + 4 context
    // states. An effect cycle would blow past this bound.
    expect(pushCount()).toBe(5)
  })

  it('follows a project rename without a project switch (the tab holds only the id)', () => {
    const project = makeProject({ id: 'proj-a', name: 'MyProject' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([project])
      useProjectStore.getState().setActiveProjectId('proj-a')
      mirrorActiveTab('proj-a', null)
    })

    act(() => {
      useProjectStore.getState().updateProject('proj-a', { name: 'Renamed' })
    })

    expect(lastTitle()).toBe('c0wrk - Renamed')
  })

  it('follows a session rename (background auto-titling)', () => {
    const project = makeProject({ id: 'proj-a', name: 'MyProject' })
    const session = makeSession({ id: 'sess-1', name: 'Session sess-1' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([project])
      useProjectStore.getState().setActiveProjectId('proj-a')
      useSessionStore.getState().setSessions([session])
      useSessionStore.getState().setActiveSessionId('sess-1')
      mirrorActiveTab('proj-a', 'sess-1')
    })
    expect(lastTitle()).toBe('c0wrk - MyProject: Session sess-1')

    act(() => {
      useSessionStore.getState().updateSession('sess-1', { name: 'Refactor auth' })
    })

    expect(lastTitle()).toBe('c0wrk - MyProject: Refactor auth')
  })

  it('drops the session segment while a project switch clears session state', () => {
    const project = makeProject({ id: 'proj-a', name: 'MyProject' })
    const next = makeProject({ id: 'proj-b', name: 'OtherProject' })
    const session = makeSession({ id: 'sess-1', name: 'Refactor auth' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([project, next])
      useProjectStore.getState().setActiveProjectId('proj-a')
      useSessionStore.getState().setSessions([session])
      useSessionStore.getState().setActiveSessionId('sess-1')
      mirrorActiveTab('proj-a', 'sess-1')
    })
    expect(lastTitle()).toBe('c0wrk - MyProject: Refactor auth')

    // Mirrors useProjectSwitchState: sessions are cleared before the
    // destination list arrives, so the mirror drops the tab's session id
    // first — the title honestly drops to two segments.
    act(() => {
      useSessionStore.getState().resetForProjectSwitch()
      mirrorActiveTab('proj-a', null)
    })

    expect(lastTitle()).toBe('c0wrk - MyProject')

    act(() => {
      useProjectStore.getState().setActiveProjectId('proj-b')
      mirrorActiveTab('proj-b', null)
    })

    expect(lastTitle()).toBe('c0wrk - OtherProject')
  })

  it('degrades predictably when the tab project is deleted, then follows the engine CHAT fallback', () => {
    const project = makeProject({ id: 'proj-a', name: 'MyProject' })
    const noProject = makeProject({ id: NO_PROJECT_ID, name: 'No Project', is_no_project: true })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([project, noProject])
      useProjectStore.getState().setActiveProjectId('proj-a')
      mirrorActiveTab('proj-a', null)
    })
    expect(lastTitle()).toBe('c0wrk - MyProject')

    // ProjectSelector.handleDelete removes the project from the store BEFORE
    // switching away, so for a moment the active tab still holds the dead id.
    // The live lookup misses; the title degrades to the bare app name — no
    // dangling segment, no stale name.
    act(() => {
      useProjectStore.getState().removeProject('proj-a')
    })
    expect(lastTitle()).toBe('c0wrk')

    // The engine's fallback lands (remaining[0] — the No Project entry sorts
    // first) and the tab context mirrors the switch: the CHAT scope appears.
    act(() => {
      useProjectStore.getState().setActiveProjectId(NO_PROJECT_ID)
      mirrorActiveTab(NO_PROJECT_ID, null)
    })
    expect(lastTitle()).toBe('c0wrk - CHAT')
  })

  it('degrades to the project-only title when the tab session disappears from the list', () => {
    const project = makeProject({ id: 'proj-a', name: 'MyProject' })
    const session = makeSession({ id: 'sess-1', name: 'Refactor auth' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([project])
      useProjectStore.getState().setActiveProjectId('proj-a')
      useSessionStore.getState().setSessions([session])
      useSessionStore.getState().setActiveSessionId('sess-1')
      mirrorActiveTab('proj-a', 'sess-1')
    })
    expect(lastTitle()).toBe('c0wrk - MyProject: Refactor auth')

    // The tab still holds the deleted session's id; the live lookup misses
    // and only the session segment drops.
    act(() => {
      useSessionStore.getState().removeSession('sess-1')
    })

    expect(lastTitle()).toBe('c0wrk - MyProject')
  })

  it('produces identical output with tabsEnabled on or off (no separate branch)', () => {
    const project = makeProject({ id: 'proj-a', name: 'MyProject' })
    const session = makeSession({ id: 'sess-1', name: 'Refactor auth' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([project])
      useProjectStore.getState().setActiveProjectId('proj-a')
      useSessionStore.getState().setSessions([session])
      useSessionStore.getState().setActiveSessionId('sess-1')
      mirrorActiveTab('proj-a', 'sess-1')
    })
    expect(lastTitle()).toBe('c0wrk - MyProject: Refactor auth')
    const pushesWithFlagOff = pushCount()

    // Flipping the persisted flag must neither change the title nor push
    // anything new: the hook never reads the flag.
    act(() => {
      useUIStore.getState().setTabsEnabled(true)
    })
    expect(lastTitle()).toBe('c0wrk - MyProject: Refactor auth')
    expect(pushCount()).toBe(pushesWithFlagOff)
  })

  it('does not touch the runtime when a ui-snapshot-only patch replaces the active tab', () => {
    const project = makeProject({ id: 'proj-a', name: 'MyProject' })
    const session = makeSession({ id: 'sess-1', name: 'Refactor auth' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([project])
      useProjectStore.getState().setActiveProjectId('proj-a')
      useSessionStore.getState().setSessions([session])
      useSessionStore.getState().setActiveSessionId('sess-1')
      mirrorActiveTab('proj-a', 'sess-1')
    })
    const pushesBefore = pushCount()

    act(() => {
      useTabStore.getState().updateActiveContext({
        ui: {
          workspaceTabByProject: { 'proj-a': 'git' },
          researchSegmentByProject: {},
          inputMode: { mode: 'terminal', height: 300, collapsedHeight: 200, isExpanded: true },
        },
      })
    })

    // The tab object was replaced, but its ids did not change — the primitive
    // projections keep the component (and therefore the effect) idle.
    expect(pushCount()).toBe(pushesBefore)
    expect(lastTitle()).toBe('c0wrk - MyProject: Refactor auth')
  })

  it('does not touch the runtime when an activity bump leaves the text unchanged', () => {
    const project = makeProject({ id: 'proj-a', name: 'MyProject' })
    const session = makeSession({ id: 'sess-1', name: 'Refactor auth' })
    renderHook()

    act(() => {
      useProjectStore.getState().setProjects([project])
      useProjectStore.getState().setActiveProjectId('proj-a')
      useSessionStore.getState().setSessions([session])
      useSessionStore.getState().setActiveSessionId('sess-1')
      mirrorActiveTab('proj-a', 'sess-1')
    })
    const pushesBefore = pushCount()

    act(() => {
      useSessionStore.getState().touchSession('sess-1')
    })

    expect(pushCount()).toBe(pushesBefore)
    expect(lastTitle()).toBe('c0wrk - MyProject: Refactor auth')
  })
})
