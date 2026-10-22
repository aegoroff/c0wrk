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
  // A previous root (an earlier render in the same test, or a leaked one)
  // must be torn down BEFORE the next mounts: two live roots subscribe to
  // the stores twice, and mid-test store mutations would then notify the
  // stale subscriber outside act() (React act warnings) — the stale copy
  // also keeps rendering against stores the test has since rewritten.
  if (root) {
    const staleRoot = root
    const staleContainer = container
    root = null
    container = null
    act(() => {
      staleRoot.unmount()
    })
    staleContainer?.remove()
  }
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

function preparingChip(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-testid="session-workspace-preparing"]')
}

function resetStores(opts: { noProject?: boolean; gitRepo?: boolean } = {}) {  useSessionWorkspaceStore.setState({ choices: {}, consumingFor: null })
  useSessionStore.setState({ sessions: null, activeSessionId: null })
  useChatStore.setState({ messages: {}, messageOrder: {}, taskActive: {}, paused: {} })
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

    // The first root is still mounted here, so the re-seed must run inside
    // act(): the store mutations notify its live subscribers.
    act(() => {
      resetStores({ gitRepo: true })
      useExperimentalStore.setState({ enabled: false })
      startSession('s-1', { kind: 'managed_worktree', workspace_path: '', worktree_name: '', branch: 'feat/x' })
    })
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

  it('a stale history-load-failure card is reaped by the successful empty reload — the picker re-arms', () => {
    // A failed history load left its card as the session's ONLY entry. The
    // card never reads as "confirmed empty" (a failed load can be the only
    // entry of a session WITH persisted rows), so the pin branch renders —
    // the backend fresh window is open, but the picker is locked.
    useSessionStore.setState({
      sessions: [makeSession({ id: 's-1' })],
      activeSessionId: 's-1',
    })
    useChatStore.setState({
      messages: {
        's-1': {
          loadfail: {
            id: 'loadfail',
            sessionId: 's-1',
            type: 'error',
            content: 'Failed to load session history. Please try switching sessions.',
            metadata: { historyLoadFailed: true },
            timestamp: 1,
          },
        },
      },
      messageOrder: { 's-1': ['loadfail'] },
      taskActive: {},
      paused: {},
    })
    renderSelector()
    expect(trigger()).toBeNull()
    expect(readOnly()).not.toBeNull()

    // The retrying load succeeds with zero rows: the successful load proves
    // the card stale, so ensureEmptyTranscript reaps it and the confirmed
    // empty index re-arms the picker (the send-time bind stays reachable —
    // and the send path binding an armed choice is no longer contradicted
    // by a locked picker).
    act(() => {
      useChatStore.getState().ensureEmptyTranscript('s-1')
    })
    expect(trigger()).not.toBeNull()
    expect(readOnly()).toBeNull()
  })

  it('ensureEmptyTranscript never reaps live rows: a bare send-refusal card and a real message survive', () => {
    // A rejected first send leaves a BARE error card (no historyLoadFailed
    // stamp) — the fresh-window signal the selector's predicate keeps. The
    // reap must leave it (and any real row) exactly where it is.
    useSessionStore.setState({
      sessions: [makeSession({ id: 's-1' })],
      activeSessionId: 's-1',
    })
    useChatStore.setState({
      messages: {
        's-1': {
          barefail: { id: 'barefail', sessionId: 's-1', type: 'error', content: 'Failed to send message: boom', timestamp: 2 },
          real: { id: 'real', sessionId: 's-1', type: 'user', content: 'hi', timestamp: 3 },
        },
      },
      messageOrder: { 's-1': ['barefail', 'real'] },
      taskActive: {},
      paused: {},
    })
    act(() => {
      useChatStore.getState().ensureEmptyTranscript('s-1')
    })
    const state = useChatStore.getState()
    expect(Object.keys(state.messages['s-1'] ?? {}).sort()).toEqual(['barefail', 'real'])
    expect(state.messageOrder['s-1']).toEqual(['barefail', 'real'])
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
    // The pin stays a real, focusable button (aria-disabled, not the native
    // attribute) so keyboard/screen-reader users can reach its reason.
    expect(chip!.tagName).toBe('BUTTON')
    expect(chip!.disabled).toBe(false)
  })

  it('local session: shows local as a permanently disabled button', () => {
    startSession('s-1', { kind: 'local', workspace_path: '/w/proj' })
    renderSelector()
    const chip = readOnly()
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('local')
    expect(chip!.getAttribute('aria-disabled')).toBe('true')
    expect(chip!.tagName).toBe('BUTTON')
    expect(chip!.disabled).toBe(false)
  })

  it('pinned chip is focusable and announces its pin reason to assistive tech', () => {
    startSession('s-1', { kind: 'managed_worktree', workspace_path: '', worktree_name: '', branch: 'feat/x' })
    renderSelector()
    const chip = readOnly()!
    // The pin stays a real, focusable button (aria-disabled, not the native
    // attribute): a natively disabled control leaves the tab order and its
    // reason becomes unreachable.
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.disabled).toBe(false)
    // aria-describedby carries the reason in a visually-hidden element, and
    // the `title` mirrors it as the mouse tooltip.
    const describedBy = chip.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const description = document.getElementById(describedBy!)
    expect(description).not.toBeNull()
    expect(description!.textContent).toContain('feat/x')
    // The reason's TAIL — not just the branch substring — must survive: it is
    // what tells the user the pin is permanent.
    expect(description!.textContent).toContain('fixed when the session was created')
    expect(description!.className).toContain('sr-only')
    expect(chip.getAttribute('title')).toContain('fixed when the session was created')
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

  it('a transcript of only frontend error cards keeps the selector armed (the backend window is still open)', () => {
    // A rejected first send: the catch rolled the optimistic user message
    // back and left the failure card. The backend refused the bind before
    // persisting anything, so the fresh window is open — the picker must
    // stay armed (with the re-armed choice), not pin a false "fixed when the
    // session was created".
    armFreshSession('s-1', { kind: 'branch', branch: 'feat/x', createBranch: false, startPoint: '' })
    act(() => {
      useChatStore.setState((s) => ({
        ...s,
        messages: {
          ...s.messages,
          's-1': { e1: { id: 'e1', sessionId: 's-1', type: 'error', content: 'boom', timestamp: 1 } },
        },
      }))
    })
    renderSelector()
    expect(trigger()).not.toBeNull()
    expect(trigger()!.textContent).toContain('feat/x')
    expect(readOnly()).toBeNull()
    // The choice survived for the corrected resend.
    expect(useSessionWorkspaceStore.getState().choices['s-1']).toBeDefined()
  })

  it('a failed history load does NOT arm the selector (the session may have persisted rows)', () => {
    // ChatArea stamps its load-failure card with `historyLoadFailed`: it can
    // be the only visible entry of a session whose real rows failed to load,
    // so it must never read as a confirmed-empty transcript — the picker
    // stays locked (pin branch), and the backend would refuse a bind anyway.
    armFreshSession('s-1', { kind: 'branch', branch: 'feat/x', createBranch: false, startPoint: '' })
    act(() => {
      useChatStore.setState((s) => ({
        ...s,
        messages: {
          ...s.messages,
          's-1': {
            e1: {
              id: 'e1',
              sessionId: 's-1',
              type: 'error',
              content: 'Failed to load session history. Please try switching sessions.',
              metadata: { historyLoadFailed: true },
              timestamp: 1,
            },
          },
        },
      }))
    })
    renderSelector()
    expect(readOnly()).not.toBeNull()
    expect(trigger()).toBeNull()
    // The destructive cleanup needs PROOF of closure, which the load-failure
    // card does not carry: the recorded pick must survive the transient
    // failure (and is editable again once the history loads confirmed-empty).
    expect(useSessionWorkspaceStore.getState().choices['s-1']).toEqual({
      kind: 'branch', branch: 'feat/x', createBranch: false, startPoint: '',
    })
  })

  it('a persisted managed binding proves the window closed and drops the stale choice', async () => {
    // Second proof source: the session row itself already carries a managed
    // binding (e.g. a bind-ok-but-dispatch-failed send) — the choice cannot
    // outlive that, whatever the transcript looks like.
    armFreshSession('s-1', { kind: 'branch', branch: 'feat/y', createBranch: false, startPoint: '' })
    act(() => {
      useSessionStore.setState((s) => ({
        ...s,
        sessions: s.sessions?.map((row) =>
          row.id === 's-1'
            ? {
                ...row,
                workspace_binding: {
                  kind: 'managed_worktree' as const,
                  workspace_path: '/w/trees/s-1',
                  worktree_name: 's-abc12345',
                  branch: 'feat/x',
                },
              }
            : row,
        ),
      }))
    })
    renderSelector()
    await flush()
    expect(useSessionWorkspaceStore.getState().choices['s-1']).toBeUndefined()
  })

  it('the consumption window keeps its own pending choice (the cleanup effect skips it)', async () => {
    armFreshSession('s-1', { kind: 'branch', branch: 'feat/x', createBranch: false, startPoint: '' })
    renderSelector()
    act(() => {
      useSessionWorkspaceStore.getState().beginConsumption('s-1')
    })
    // Mid-send the selector is non-fresh (the send activated the task), but
    // the pending entry is the in-flight send's payload — not a leftover —
    // so the cleanup effect must leave it alone.
    act(() => {
      useChatStore.setState((s) => ({ ...s, taskActive: { 's-1': true } }))
    })
    await flush()
    expect(useSessionWorkspaceStore.getState().choices['s-1']).toBeDefined()
    expect(preparingChip()).not.toBeNull()

    // Window settles: the success teardown clears the choice explicitly.
    act(() => {
      useSessionWorkspaceStore.getState().endConsumption()
      useSessionWorkspaceStore.getState().clearChoice('s-1')
      useChatStore.setState((s) => ({ ...s, taskActive: {} }))
    })
    await flush()
    expect(useSessionWorkspaceStore.getState().choices['s-1']).toBeUndefined()
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
