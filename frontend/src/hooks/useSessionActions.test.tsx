// Tests for the New Session gesture's draft flow (useSessionActions).
//
// In a CODE project, New Session arms a session draft (ADR-080) instead of
// creating a session row — no RPC runs, no session becomes active; the draft
// is committed later by the first send / attachment / terminal open (see
// lib/sessionDraft.test.ts). In CHAT (No Project) mode the gesture keeps
// the legacy eager creation.
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
import { useSessionDraftStore } from '@/stores/sessionDraftStore'
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
  useSessionDraftStore.getState().clearDraft()
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

describe('handleNewSession — draft flow', () => {
  it('CODE project: arms a local draft and creates NO session', async () => {
    await act(async () => {
      await captured!.handleNewSession()
    })

    expect(spies.createSession).not.toHaveBeenCalled()
    expect(useSessionStore.getState().activeSessionId).toBeNull()
    expect(useSessionDraftStore.getState().draft).toEqual({
      projectId: 'proj-1',
      workspace: { kind: 'local' },
    })
  })

  it('CODE project: clears the previously active session in memory (no persistence write)', async () => {
    useSessionStore.setState({ activeSessionId: 's-prev', sessions: [makeSession('s-prev')] })

    await act(async () => {
      await captured!.handleNewSession()
    })

    expect(useSessionStore.getState().activeSessionId).toBeNull()
    // The previous session stays in the list — only the selection moved.
    expect(useSessionStore.getState().sessions?.some((s) => s.id === 's-prev')).toBe(true)
  })

  it('CHAT (No Project): keeps the legacy eager creation', async () => {
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
    expect(useSessionDraftStore.getState().draft).toBeNull()
  })

  it('re-arming resets the workspace choice — every New Session starts local', async () => {
    await act(async () => {
      await captured!.handleNewSession()
    })
    useSessionDraftStore
      .getState()
      .setDraftWorkspace({ kind: 'branch', branch: 'feat/x', createBranch: false, startPoint: '' })

    await act(async () => {
      await captured!.handleNewSession()
    })

    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({ kind: 'local' })
  })
})

describe('handleNewSessionOnBranch — grouped-view per-branch draft', () => {
  it('CODE project: arms a branch draft (no createBranch) and creates NO session', () => {
    act(() => {
      captured!.handleNewSessionOnBranch('feat/a')
    })

    // No RPC — the draft commits later, on the first real action.
    expect(spies.createSession).not.toHaveBeenCalled()
    // The drafted workspace pins the branch; createBranch=false because the
    // branch already exists (CreateManagedSession adopts its managed tree).
    expect(useSessionDraftStore.getState().draft).toEqual({
      projectId: 'proj-1',
      workspace: { kind: 'branch', branch: 'feat/a', createBranch: false, startPoint: '' },
    })
  })

  it('CODE project: clears the active session in memory, like New Session', () => {
    useSessionStore.setState({ activeSessionId: 's-prev', sessions: [makeSession('s-prev')] })

    act(() => {
      captured!.handleNewSessionOnBranch('feat/a')
    })

    expect(useSessionStore.getState().activeSessionId).toBeNull()
  })

  it('replaces an armed draft with the branch choice', async () => {
    await act(async () => {
      await captured!.handleNewSession()
    })

    act(() => {
      captured!.handleNewSessionOnBranch('feat/b')
    })

    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({
      kind: 'branch',
      branch: 'feat/b',
      createBranch: false,
      startPoint: '',
    })
  })

  it('CHAT (No Project): deliberate no-op — no draft, no session', () => {
    useProjectStore.setState({
      activeProjectId: '__no_project__',
      projects: [makeProject({ id: '__no_project__', is_no_project: true })],
    })

    act(() => {
      captured!.handleNewSessionOnBranch('feat/a')
    })

    expect(useSessionDraftStore.getState().draft).toBeNull()
    expect(spies.createSession).not.toHaveBeenCalled()
  })
})

describe('group actions — branch groups', () => {
  it('handleArchiveGroup: nobody busy → archives all immediately, no dialog', async () => {
    useSessionStore.setState({ sessions: [makeSession('s-1'), makeSession('s-2')] })

    await act(async () => {
      await captured!.handleArchiveGroup('feat/a', ['s-1', 's-2'])
    })

    expect(spies.archiveSession).toHaveBeenCalledTimes(2)
    expect(captured!.pendingAction).toBeNull()
    for (const s of useSessionStore.getState().sessions!) expect(s.archived).toBe(true)
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
