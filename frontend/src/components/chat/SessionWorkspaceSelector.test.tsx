// Tests for SessionWorkspaceSelector — the chat toolbar's workspace selector
// (the draft-free creation flow, ADR-091).
//
// Covers: hidden in CHAT mode / no project; rendered regardless of the
// experimental gate; interactive picker on a FRESH session (confirmed-empty
// transcript, no task; `local` default, branch display, `branch…` opens the
// picker in pick mode, choosing local clears a branch choice, non-git
// projects hide `branch…`); permanently disabled pinned button for existing
// managed and local sessions — the pin ignores the transient selector lock,
// so it stays disabled across chat continuations; a stale pending choice is
// dropped the moment its session stops being fresh.
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'

import { SessionWorkspaceSelector } from './SessionWorkspaceSelector'
import { useSessionWorkspaceStore, type PendingWorkspace } from '@/stores/sessionWorkspaceStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { useChatStore } from '@/stores/chatStore'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useExperimentalStore } from '@/stores/experimentalStore'
import type { ProjectInfo, SessionInfo } from '@/types/models'

let container: HTMLDivElement | null = null
let root: Root | null = null

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: 'proj-1',
    name: 'Proj',
    workspace_path: '/w/proj',
    is_external: false,
    is_no_project: false,
    created_at: '2026-01-01T00:00:00Z',
    last_active_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's-1',
    project_id: 'proj-1',
    name: 'Session',
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

function renderSelector(props: { disabled?: boolean } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  act(() => {
    r.render(
      <TooltipProvider>
        <SessionWorkspaceSelector {...props} />
      </TooltipProvider>,
    )
  })
}

function body(): HTMLElement {
  return document.body
}

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function trigger(): HTMLButtonElement | null {
  return body().querySelector<HTMLButtonElement>('[data-testid="session-workspace-selector"]')
}

function readOnly(): HTMLButtonElement | null {
  return body().querySelector<HTMLButtonElement>('[data-testid="session-workspace-readonly"]')
}

function menuItem(testId: string): HTMLElement | null {
  return body().querySelector<HTMLElement>(`[data-testid="${testId}"]`)
}

async function openMenu() {
  act(() => {
    trigger()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  })
  await flush()
}

/**
 * Arm the ACTIVE session as FRESH: the selector's freshness gate needs a
 * CONFIRMED-empty transcript (the message index must exist and be empty —
 * an absent index means "history not loaded yet") and no running task.
 */
function armFreshSession(id = 's-1', choice?: PendingWorkspace) {
  useSessionStore.setState({
    sessions: [makeSession({ id })],
    activeSessionId: id,
  })
  useChatStore.setState({ messages: { [id]: {} }, taskActive: {}, paused: {} })
  if (choice !== undefined) {
    useSessionWorkspaceStore.getState().setChoice(id, choice)
  }
}

/** Make the session STARTED: a transcript (or a running task) locks the
 *  workspace forever and the selector renders the pinned chip. */
function startSession(id = 's-1', binding?: SessionInfo['workspace_binding'], opts: { taskActive?: boolean } = {}) {
  useSessionStore.setState({
    sessions: [makeSession({ id, workspace_binding: binding })],
    activeSessionId: id,
  })
  useChatStore.setState({
    messages: {
      [id]: { m1: { id: 'm1', sessionId: id, type: 'user', content: 'hi', timestamp: 1 } },
    },
    taskActive: opts.taskActive ? { [id]: true } : {},
    paused: {},
  })
}

function resetStores(opts: { noProject?: boolean; gitRepo?: boolean } = {}) {
  useSessionWorkspaceStore.setState({ choices: {}, consumingFor: null })
  useSessionStore.setState({ sessions: null, activeSessionId: null })
  useChatStore.setState({ messages: {}, taskActive: {}, paused: {} })
  useGitPanelStore.getState().reset()
  const project = opts.noProject
    ? makeProject({ id: '__no_project__', is_no_project: true })
    : makeProject()
  useProjectStore.setState({
    activeProjectId: opts.noProject ? '__no_project__' : 'proj-1',
    projects: [project],
  })
  if (opts.gitRepo) {
    useGitPanelStore.getState().setGitRepo(true, 'proj-1')
  }
}

beforeEach(() => {
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

describe('SessionWorkspaceSelector', () => {
  it('renders nothing in CHAT (No Project) mode', () => {
    resetStores({ noProject: true })
    armFreshSession()
    renderSelector()
    expect(trigger()).toBeNull()
    expect(readOnly()).toBeNull()
  })

  it('renders nothing while no project is active', () => {
    useProjectStore.setState({ activeProjectId: null, projects: [] })
    renderSelector()
    expect(trigger()).toBeNull()
  })

  it('renders the picker and the pinned chip regardless of the experimental gate', () => {
    useExperimentalStore.setState({ enabled: false })
    armFreshSession()
    renderSelector()
    expect(trigger()).not.toBeNull()

    resetStores({ gitRepo: true })
    useExperimentalStore.setState({ enabled: false })
    startSession('s-1', { kind: 'managed_worktree', workspace_path: '', worktree_name: '', branch: 'feat/x' })
    renderSelector()
    expect(readOnly()).not.toBeNull()
  })

  it('fresh session: shows the local default and offers local + branch… in a git repo', async () => {
    resetStores({ gitRepo: true })
    armFreshSession()
    renderSelector()
    expect(trigger()!.textContent).toContain('local')

    await openMenu()
    expect(menuItem('workspace-option-local')).not.toBeNull()
    expect(menuItem('workspace-option-branch')).not.toBeNull()
  })

  it('branch choice: the trigger shows the picked branch name', () => {
    armFreshSession('s-1', { kind: 'branch', branch: 'feat/x', createBranch: false, startPoint: '' })
    renderSelector()
    expect(trigger()!.textContent).toContain('feat/x')
  })

  it('picking branch… opens the picker in pick mode (no arming needed)', async () => {
    resetStores({ gitRepo: true })
    armFreshSession()
    renderSelector()

    await openMenu()
    act(() => {
      menuItem('workspace-option-branch')!.click()
    })
    await flush()

    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(true)
    expect(useGitPanelStore.getState().branchPickerMode).toBe('draft')
  })

  it('picking local clears an armed branch choice', async () => {
    resetStores({ gitRepo: true })
    armFreshSession('s-1', { kind: 'branch', branch: 'feat/x', createBranch: false, startPoint: '' })
    renderSelector()

    await openMenu()
    act(() => {
      menuItem('workspace-option-local')!.click()
    })
    await flush()

    expect(useSessionWorkspaceStore.getState().choices['s-1']).toEqual({ kind: 'local' })
  })

  it('hides branch… when the project is not a git repository', async () => {
    armFreshSession()
    renderSelector()

    await openMenu()
    expect(menuItem('workspace-option-local')).not.toBeNull()
    expect(menuItem('workspace-option-branch')).toBeNull()
  })

  it('a session whose history has not loaded yet is NOT fresh — the pinned chip shows', () => {
    // No message index: the transcript state is unknown, the safe display is
    // the session's own binding (local).
    useSessionStore.setState({ sessions: [makeSession()], activeSessionId: 's-1' })
    useChatStore.setState({ messages: {}, taskActive: {}, paused: {} })
    renderSelector()
    expect(trigger()).toBeNull()
    expect(readOnly()!.textContent).toContain('local')
  })

  it('managed session: shows the pinned branch as a permanently disabled button', () => {
    startSession('s-1', { kind: 'managed_worktree', workspace_path: '', worktree_name: '', branch: 'feat/x' })
    renderSelector()
    const chip = readOnly()
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('feat/x')
    expect(chip!.getAttribute('aria-disabled')).toBe('true')
  })

  it('local session: shows local as a permanently disabled button', () => {
    startSession('s-1', { kind: 'local', workspace_path: '/w/proj' })
    renderSelector()
    const chip = readOnly()
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('local')
    expect(chip!.getAttribute('aria-disabled')).toBe('true')
  })

  it('pinned chip is focusable and announces its pin reason to assistive tech', () => {
    startSession('s-1', { kind: 'managed_worktree', workspace_path: '', worktree_name: '', branch: 'feat/x' })
    renderSelector()
    const chip = readOnly()!
    // aria-describedby carries the reason in a visually-hidden element.
    const describedBy = chip.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const description = document.getElementById(describedBy!)
    expect(description).not.toBeNull()
    expect(description!.textContent).toContain('feat/x')
  })

  it('pinned button stays disabled across chat continuations (ignores the transient selector lock)', () => {
    startSession('s-1', { kind: 'managed_worktree', workspace_path: '', worktree_name: '', branch: 'feat/x' })
    renderSelector({ disabled: false })
    expect(readOnly()!.getAttribute('aria-disabled')).toBe('true')
  })

  it('a running task locks the workspace even with a confirmed-empty transcript', () => {
    useSessionStore.setState({ sessions: [makeSession()], activeSessionId: 's-1' })
    useChatStore.setState({ messages: { 's-1': {} }, taskActive: { 's-1': true }, paused: {} })
    renderSelector()
    expect(trigger()).toBeNull()
    expect(readOnly()).not.toBeNull()
  })

  it('a stale pending choice is dropped the moment its session stops being fresh', async () => {
    armFreshSession('s-1', { kind: 'branch', branch: 'feat/x', createBranch: false, startPoint: '' })
    renderSelector()
    expect(useSessionWorkspaceStore.getState().choices['s-1']).toBeDefined()

    // The first message lands (transcript no longer empty): the fresh window
    // closed, so a still-pending choice is a leftover and must be dropped.
    act(() => {
      useChatStore.setState((s) => ({
        messages: {
          ...s.messages,
          's-1': { m1: { id: 'm1', sessionId: 's-1', type: 'user', content: 'hi', timestamp: 1 } },
        },
      }))
    })
    await flush()

    expect(useSessionWorkspaceStore.getState().choices['s-1']).toBeUndefined()
    expect(readOnly()).not.toBeNull()
  })

  it('switching to another session keeps each session\'s own choice', () => {
    armFreshSession('s-1', { kind: 'branch', branch: 'feat/a', createBranch: false, startPoint: '' })
    renderSelector()

    act(() => {
      useSessionStore.setState({
        sessions: [makeSession({ id: 's-1' }), makeSession({ id: 's-2' })],
        activeSessionId: 's-2',
      })
      useChatStore.setState((s) => ({
        messages: { ...s.messages, 's-2': {} },
        taskActive: {},
      }))
    })
    // The other session has no choice of its own — the implicit local
    // default shows, and the first session's choice survives untouched.
    expect(trigger()!.textContent).toContain('local')
    expect(useSessionWorkspaceStore.getState().choices['s-1']).toBeDefined()
  })
})
