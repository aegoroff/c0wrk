// Tests for the session-creation gestures of useSessionActions.
//
// Both "New Session" and "new session on branch X" eagerly create the
// session row (ADR-091): a CODE session is born LOCAL and immediately
// active, with a CONFIRMED-EMPTY transcript seeded (the workspace picker's
// freshness contract) and — for the per-branch gesture — the fresh window's
// pending workspace choice preset. In CHAT (No Project) mode the same eager
// creation runs.
//
// No @testing-library/react in this repo; we follow the established
// createRoot + jsdom harness pattern (see useMessageSender.test.tsx).

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { SessionInfo, ProjectInfo } from '@/types/models'

const spies = vi.hoisted(() => ({
  createSession: vi.fn<() => Promise<SessionInfo>>(),
  archiveSession: vi.fn<() => Promise<void>>(),
  deleteSession: vi.fn<() => Promise<void>>(),
  pinSession: vi.fn<() => Promise<void>>(),
  logError: vi.fn(),
}))

vi.mock('@/api/sessions', () => ({
  createSession: spies.createSession,
  renameSession: vi.fn(),
  archiveSession: spies.archiveSession,
  deleteSession: spies.deleteSession,
  forkSession: vi.fn(),
  pinSession: spies.pinSession,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: spies.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/api/projects', () => ({
  saveProjectActiveSession: vi.fn(() => Promise.resolve()),
}))

import { useSessionActions, type PendingSessionAction } from '@/hooks/useSessionActions'
import { SessionActionConfirmDialog } from '@/components/layout/SessionActionConfirmDialog'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionWorkspaceStore } from '@/stores/sessionWorkspaceStore'
import { useChatStore } from '@/stores/chatStore'

let captured: ReturnType<typeof useSessionActions> | null = null
let container: HTMLDivElement | null = null
let root: Root | null = null

function Harness() {
  captured = useSessionActions()
  return null
}

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

function makeSession(id = 's-1', projectId = 'proj-1', overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    project_id: projectId,
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

beforeEach(() => {
  spies.createSession.mockReset()
  spies.archiveSession.mockReset().mockResolvedValue(undefined)
  spies.deleteSession.mockReset().mockResolvedValue(undefined)
  spies.pinSession.mockReset().mockResolvedValue(undefined)
  spies.logError.mockReset()
  useSessionWorkspaceStore.setState({ choices: {}, consumingFor: null })
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  // Group actions consult the live busy overlay — start every test from an
  // idle chat state so busy-ness comes only from the fixture under test.
  useChatStore.setState({ taskActive: {}, paused: {}, unfinishedTaskStatus: {} })
  useProjectStore.setState({ activeProjectId: 'proj-1', projects: [makeProject()] })
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  act(() => {
    r.render(<Harness />)
  })
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
  captured = null
})

describe('handleNewSession — eager creation (ADR-091)', () => {
  it('CODE project: eagerly creates a LOCAL session and selects it', async () => {
    spies.createSession.mockResolvedValue(makeSession('s-new'))
    await act(async () => {
      await captured!.handleNewSession()
    })

    expect(spies.createSession).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().activeSessionId).toBe('s-new')
    expect(useSessionStore.getState().sessions?.some((s) => s.id === 's-new')).toBe(true)
    // No workspace choice is armed by the bare gesture — the session is
    // born local, and a worktree needs an explicit pick.
    expect(useSessionWorkspaceStore.getState().choices).toEqual({})
  })

  it('CODE project: keeps the previously active session in the list', async () => {
    spies.createSession.mockResolvedValue(makeSession('s-new'))
    useSessionStore.setState({ activeSessionId: 's-prev', sessions: [makeSession('s-prev')] })

    await act(async () => {
      await captured!.handleNewSession()
    })

    expect(useSessionStore.getState().activeSessionId).toBe('s-new')
    // The previous session stays in the list — only the selection moved.
    expect(useSessionStore.getState().sessions?.some((s) => s.id === 's-prev')).toBe(true)
  })

  it('CHAT (No Project): the same eager creation', async () => {
    spies.createSession.mockResolvedValue(
      makeSession('s-chat', '__no_project__'),
    )
    useProjectStore.setState({
      activeProjectId: '__no_project__',
      projects: [makeProject({ id: '__no_project__', is_no_project: true })],
    })

    await act(async () => {
      await captured!.handleNewSession()
    })

    expect(spies.createSession).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().activeSessionId).toBe('s-chat')
  })

  it('surfaces a creation failure as createError', async () => {
    spies.createSession.mockRejectedValue(new Error('backend down'))
    await act(async () => {
      await captured!.handleNewSession()
    })

    expect(spies.logError).toHaveBeenCalled()
    expect(useSessionStore.getState().activeSessionId).toBeNull()
  })
})

describe('handleNewSessionOnBranch — grouped-view per-branch gesture', () => {
  it('CODE project: eagerly creates the session and presets its branch choice', async () => {
    spies.createSession.mockResolvedValue(makeSession('s-new'))
    await act(async () => {
      captured!.handleNewSessionOnBranch('feat/a')
    })

    // The row is born immediately (local) — no draft state.
    expect(spies.createSession).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().activeSessionId).toBe('s-new')
    // The fresh window's pending choice pins the branch; createBranch=false
    // because the branch already exists (the first send adopts its tree).
    expect(useSessionWorkspaceStore.getState().choices['s-new']).toEqual({
      kind: 'branch',
      branch: 'feat/a',
      createBranch: false,
      startPoint: '',
    })
    // The transcript is seeded CONFIRMED-EMPTY from birth: the selector's
    // freshness contract needs the index to EXIST — without it the picker
    // stays locked behind the permanent pin and the preset choice is
    // invisible until the history loader settles (the choice itself still
    // rides the first send, but the user cannot see or change it).
    const index = useChatStore.getState().messages['s-new']
    expect(index).toBeDefined()
    expect(Object.keys(index!)).toHaveLength(0)
  })

  it('CODE project: the choice is keyed to the NEW session, not the previous one', async () => {
    spies.createSession.mockResolvedValue(makeSession('s-new'))
    useSessionStore.setState({ activeSessionId: 's-prev', sessions: [makeSession('s-prev')] })

    await act(async () => {
      captured!.handleNewSessionOnBranch('feat/a')
    })

    expect(useSessionWorkspaceStore.getState().choices['s-prev']).toBeUndefined()
    expect(useSessionWorkspaceStore.getState().choices['s-new']).toBeDefined()
  })

  it('CODE project: a creation failure leaves no choice behind', async () => {
    spies.createSession.mockRejectedValue(new Error('backend down'))
    await act(async () => {
      captured!.handleNewSessionOnBranch('feat/a')
    })

    expect(spies.logError).toHaveBeenCalled()
    expect(useSessionWorkspaceStore.getState().choices).toEqual({})
  })

  it('CHAT (No Project): deliberate no-op — no session, no choice', () => {
    useProjectStore.setState({
      activeProjectId: '__no_project__',
      projects: [makeProject({ id: '__no_project__', is_no_project: true })],
    })

    act(() => {
      captured!.handleNewSessionOnBranch('feat/a')
    })

    expect(spies.createSession).not.toHaveBeenCalled()
    expect(useSessionWorkspaceStore.getState().choices).toEqual({})
  })
})

describe('group actions — branch groups', () => {
  it('handleArchiveGroup: a lone, idle member archives immediately, no dialog', async () => {
    // N=1 group = the per-row guard: confirmation only for a busy member.
    useSessionStore.setState({ sessions: [makeSession('s-1')] })

    await act(async () => {
      await captured!.handleArchiveGroup('feat/a', ['s-1'])
    })

    expect(spies.archiveSession).toHaveBeenCalledTimes(1)
    expect(captured!.pendingAction).toBeNull()
    expect(useSessionStore.getState().sessions![0]?.archived).toBe(true)
  })

  it('handleArchiveGroup: multi-member group arms confirmation even when nobody is busy', async () => {
    // Blast radius: one click would archive N sessions — confirm regardless
    // of busy state (the branch-named copy makes no busy claim, see the
    // dialog tests below).
    useSessionStore.setState({ sessions: [makeSession('s-1'), makeSession('s-2')] })

    await act(async () => {
      await captured!.handleArchiveGroup('feat/a', ['s-1', 's-2'])
    })

    expect(spies.archiveSession).not.toHaveBeenCalled()
    expect(captured!.pendingAction).toEqual({
      kind: 'archive',
      sessionId: 's-1',
      sessionName: 'feat/a',
      isArchived: false,
      sessionIds: ['s-1', 's-2'],
    })
  })

  it('handleArchiveGroup: a busy member arms a GROUP confirmation naming the branch', async () => {
    useSessionStore.setState({
      sessions: [makeSession('s-1', 'proj-1', { unfinished_task_status: 'in_progress' }), makeSession('s-2')],
    })

    await act(async () => {
      await captured!.handleArchiveGroup('feat/a', ['s-1', 's-2'])
    })

    expect(spies.archiveSession).not.toHaveBeenCalled()
    expect(captured!.pendingAction).toEqual({
      kind: 'archive',
      sessionId: 's-1',
      sessionName: 'feat/a',
      isArchived: false,
      sessionIds: ['s-1', 's-2'],
    })
  })

  it('confirmPendingAction: group archive applies the operation to EVERY member', async () => {
    useSessionStore.setState({
      sessions: [makeSession('s-1', 'proj-1', { unfinished_task_status: 'in_progress' }), makeSession('s-2')],
    })
    await act(async () => {
      await captured!.handleArchiveGroup('feat/a', ['s-1', 's-2'])
    })

    await act(async () => {
      await captured!.confirmPendingAction()
    })

    expect(spies.archiveSession).toHaveBeenCalledTimes(2)
    expect(captured!.pendingAction).toBeNull()
    for (const s of useSessionStore.getState().sessions!) expect(s.archived).toBe(true)
  })

  it('handleDeleteGroup: ALWAYS arms a group confirmation (even with nobody busy)', async () => {
    useSessionStore.setState({ sessions: [makeSession('s-1'), makeSession('s-2')] })

    await act(async () => {
      await captured!.handleDeleteGroup('feat/a', ['s-1', 's-2'])
    })

    expect(spies.deleteSession).not.toHaveBeenCalled()
    expect(captured!.pendingAction?.kind).toBe('delete')
    expect(captured!.pendingAction?.sessionName).toBe('feat/a')
    expect(captured!.pendingAction?.sessionIds).toEqual(['s-1', 's-2'])
  })

  it('confirmPendingAction: group delete hits EVERY member; a failing member does not break the loop', async () => {
    useSessionStore.setState({ sessions: [makeSession('s-1'), makeSession('s-2')] })
    spies.deleteSession.mockRejectedValueOnce(new Error('boom'))
    await act(async () => {
      await captured!.handleDeleteGroup('feat/a', ['s-1', 's-2'])
    })

    await act(async () => {
      await captured!.confirmPendingAction()
    })

    expect(spies.deleteSession).toHaveBeenCalledTimes(2)
    expect(spies.logError).toHaveBeenCalledWith('Failed to delete session:', expect.any(Error))
    // s-1's delete failed → stays listed; s-2's succeeded → removed.
    const ids = useSessionStore.getState().sessions!.map((s) => s.id)
    expect(ids).toContain('s-1')
    expect(ids).not.toContain('s-2')
    expect(captured!.pendingAction).toBeNull()
  })
})

describe('SessionActionConfirmDialog — group copy', () => {
  function dialogText(pending: PendingSessionAction): string {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const r = createRoot(el)
    act(() => {
      r.render(
        <SessionActionConfirmDialog pending={pending} onConfirm={() => {}} onCancel={() => {}} />,
      )
    })
    const text = document.body.textContent ?? ''
    act(() => {
      r.unmount()
    })
    el.remove()
    return text
  }

  it('N>1 delete shows the plural branch-group copy', () => {
    const text = dialogText({
      kind: 'delete',
      sessionId: 's-1',
      sessionName: 'feat/a',
      isArchived: false,
      sessionIds: ['s-1', 's-2'],
    })
    expect(text).toContain('Delete sessions?')
    expect(text).toContain('Branch "feat/a" groups 2 sessions')
    expect(text).toContain('permanently remove the sessions and their files')
  })

  it('N>1 archive shows the plural branch-group copy', () => {
    const text = dialogText({
      kind: 'archive',
      sessionId: 's-1',
      sessionName: 'feat/a',
      isArchived: false,
      sessionIds: ['s-1', 's-2', 's-3'],
    })
    expect(text).toContain('Archive sessions?')
    expect(text).toContain('Branch "feat/a" groups 3 sessions')
    expect(text).toContain('make the sessions read-only')
  })

  it('N=1 group delete names the BRANCH, not a session', () => {
    const text = dialogText({
      kind: 'delete',
      sessionId: 's-1',
      sessionName: 'feat/a',
      isArchived: false,
      sessionIds: ['s-1'],
    })
    expect(text).toContain('Delete session?')
    expect(text).toContain('Branch "feat/a" groups 1 session')
    expect(text).toContain('permanently remove the session and its files')
  })

  it('N=1 group archive names the BRANCH and makes no busy claim', () => {
    const text = dialogText({
      kind: 'archive',
      sessionId: 's-1',
      sessionName: 'feat/a',
      isArchived: false,
      sessionIds: ['s-1'],
    })
    expect(text).toContain('Archive session?')
    expect(text).toContain('Branch "feat/a" groups 1 session')
    expect(text).toContain('make the session read-only')
    // A multi-member group confirms even with nobody busy — the copy must
    // not assert that a task IS in progress.
    expect(text).not.toContain('has a task in progress')
  })

  it('single-session copy is unchanged', () => {
    const deleteText = dialogText({
      kind: 'delete',
      sessionId: 's-1',
      sessionName: 'Solo',
      isArchived: false,
    })
    expect(deleteText).toContain('Delete session?')
    expect(deleteText).toContain(
      '"Solo" has a task in progress or unfinished. Deleting will cancel it and permanently remove the session and its files.',
    )
    expect(deleteText).not.toContain('groups')

    const archiveText = dialogText({
      kind: 'archive',
      sessionId: 's-1',
      sessionName: 'Solo',
      isArchived: false,
    })
    expect(archiveText).toContain('Archive session?')
    expect(archiveText).toContain(
      '"Solo" has a task in progress or unfinished. Archiving will cancel it and make the session read-only.',
    )
    expect(archiveText).not.toContain('groups')
  })
})
