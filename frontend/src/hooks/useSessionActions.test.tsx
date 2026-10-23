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
  deleteSessionWithOptions: vi.fn<() => Promise<void>>(),
  pinSession: vi.fn<() => Promise<void>>(),
  logError: vi.fn(),
}))

vi.mock('@/api/sessions', () => ({
  createSession: spies.createSession,
  renameSession: vi.fn(),
  archiveSession: spies.archiveSession,
  deleteSession: spies.deleteSession,
  deleteSessionWithOptions: spies.deleteSessionWithOptions,
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
import { useTerminalRegistryStore } from '@/stores/terminalRegistryStore'
import { useChatInputStore } from '@/stores/chatInputStore'

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
  spies.deleteSessionWithOptions.mockReset().mockResolvedValue(undefined)
  spies.pinSession.mockReset().mockResolvedValue(undefined)
  spies.logError.mockReset()
  useSessionWorkspaceStore.setState({ choices: {}, consumingFor: null })
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  // Group actions consult the live busy overlay — start every test from an
  // idle chat state so busy-ness comes only from the fixture under test.
  useChatStore.setState({ taskActive: {}, paused: {}, unfinishedTaskStatus: {} })
  // Blocked-delete tests touch the per-session slices the finalization drops
  // (terminal registry, chat-input drafts) — start them empty every time.
  useTerminalRegistryStore.setState({ instances: [], readySessions: new Set<string>() })
  useChatInputStore.setState({ inputs: {} })
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

describe('blocked delete — managed-worktree refusal parks, retries, finalizes', () => {
  /** The exact backend refusal text (`SessionDeleteBlockedError.Error()`). */
  function blockedError(reason: string, option: string): Error {
    return new Error(`session deletion blocked: ${reason} (confirm via ${option})`)
  }

  it('a blocked refusal parks the state and deletes NOTHING', async () => {
    useSessionStore.setState({ sessions: [makeSession('s-m', 'proj-1', { name: 'Managed' })] })
    useTerminalRegistryStore.getState().ensureInstance('s-m')
    spies.deleteSession.mockRejectedValueOnce(
      blockedError('worktree "s-m" has uncommitted changes', 'confirm_uncommitted_loss'),
    )

    await act(async () => {
      await captured!.handleDelete('s-m')
    })

    // The refusal is parked with everything the dialog needs — ids, name,
    // reason, and the exact option field to set true on confirm.
    expect(captured!.blockedDelete).toEqual({
      sessionIds: ['s-m'],
      sessionName: 'Managed',
      reason: 'worktree "s-m" has uncommitted changes',
      option: 'confirm_uncommitted_loss',
    })
    // removeSession never ran: the session stays fully listed and its
    // terminal instance stays registered.
    expect(useSessionStore.getState().sessions!.map((s) => s.id)).toContain('s-m')
    expect(useTerminalRegistryStore.getState().instances).toContain('s-m')
    // A recognized refusal is not a failure — nothing logged, no retry.
    expect(spies.logError).not.toHaveBeenCalled()
    expect(spies.deleteSessionWithOptions).not.toHaveBeenCalled()
    expect(captured!.blockedDeleteError).toBeNull()
  })

  it('a NON-blocked delete failure never opens the blocked dialog', async () => {
    useSessionStore.setState({ sessions: [makeSession('s-1')] })
    spies.deleteSession.mockRejectedValueOnce(new Error('rpc down'))

    await act(async () => {
      await captured!.handleDelete('s-1')
    })

    expect(captured!.blockedDelete).toBeNull()
    expect(spies.logError).toHaveBeenCalledWith('Failed to delete session:', expect.any(Error))
  })

  it('confirmBlockedDelete success finalizes exactly like performDelete', async () => {
    useSessionStore.setState({ sessions: [makeSession('s-m', 'proj-1', { name: 'Managed' })] })
    spies.deleteSession.mockRejectedValueOnce(
      blockedError('worktree "s-m" has uncommitted changes', 'confirm_uncommitted_loss'),
    )
    await act(async () => {
      await captured!.handleDelete('s-m')
    })
    useTerminalRegistryStore.getState().ensureInstance('s-m')
    useChatInputStore.getState().setDraft('s-m', 'half-written')
    useSessionWorkspaceStore
      .getState()
      .setChoice('s-m', { kind: 'branch', branch: 'feat/a', createBranch: false, startPoint: '' })

    await act(async () => {
      await captured!.confirmBlockedDelete({ confirmUncommittedLoss: true })
    })

    expect(spies.deleteSessionWithOptions).toHaveBeenCalledTimes(1)
    expect(spies.deleteSessionWithOptions).toHaveBeenCalledWith('s-m', { confirmUncommittedLoss: true })
    // Full cleanup — the same finalization as a plain delete: the row is
    // removed, and every per-session slice is dropped.
    expect(useSessionStore.getState().sessions!.map((s) => s.id)).not.toContain('s-m')
    expect(useTerminalRegistryStore.getState().instances).not.toContain('s-m')
    expect(useChatInputStore.getState().inputs['s-m']).toBeUndefined()
    expect(useSessionWorkspaceStore.getState().choices['s-m']).toBeUndefined()
    expect(captured!.blockedDelete).toBeNull()
    expect(captured!.blockedDeleteError).toBeNull()
  })

  it('group [local-ok, managed-blocked]: earlier members finalize, the block parks the remainder', async () => {
    useSessionStore.setState({
      sessions: [makeSession('s-1'), makeSession('s-2', 'proj-1', { name: 'Managed Two' })],
    })
    spies.deleteSession
      .mockResolvedValueOnce(undefined) // s-1: local, deletes fine
      .mockRejectedValueOnce(blockedError('worktree "s-2" has uncommitted changes', 'confirm_uncommitted_loss'))
    await act(async () => {
      await captured!.handleDeleteGroup('feat/a', ['s-1', 's-2'])
    })

    await act(async () => {
      await captured!.confirmPendingAction()
    })

    expect(spies.deleteSession).toHaveBeenCalledTimes(2)
    const ids = useSessionStore.getState().sessions!.map((s) => s.id)
    expect(ids).not.toContain('s-1')
    expect(ids).toContain('s-2')
    // The remainder (the refused member — here the last) is parked under the
    // GROUP's branch label, not a session name.
    expect(captured!.blockedDelete).toEqual({
      sessionIds: ['s-2'],
      sessionName: 'feat/a',
      reason: 'worktree "s-2" has uncommitted changes',
      option: 'confirm_uncommitted_loss',
    })
  })

  it('group [managed-blocked, local]: the first refusal parks the WHOLE remainder and stops the loop', async () => {
    useSessionStore.setState({
      sessions: [makeSession('s-1', 'proj-1', { name: 'Managed One' }), makeSession('s-2')],
    })
    spies.deleteSession.mockRejectedValueOnce(blockedError('worktree "s-1" is locked', 'unlock_locked_tree'))
    await act(async () => {
      await captured!.handleDeleteGroup('feat/a', ['s-1', 's-2'])
    })

    await act(async () => {
      await captured!.confirmPendingAction()
    })

    // The refusal on the FIRST member stops the loop before s-2.
    expect(spies.deleteSession).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().sessions!.map((s) => s.id)).toEqual(['s-1', 's-2'])
    // Everything still-to-delete is parked — the refused member first.
    expect(captured!.blockedDelete).toEqual({
      sessionIds: ['s-1', 's-2'],
      sessionName: 'feat/a',
      reason: 'worktree "s-1" is locked',
      option: 'unlock_locked_tree',
    })
  })

  it('confirmBlockedDelete retries the whole parked remainder with the decision and releases the state', async () => {
    useSessionStore.setState({
      sessions: [makeSession('s-1', 'proj-1', { name: 'Managed One' }), makeSession('s-2')],
    })
    spies.deleteSession.mockRejectedValueOnce(blockedError('worktree "s-1" is locked', 'unlock_locked_tree'))
    await act(async () => {
      await captured!.handleDeleteGroup('feat/a', ['s-1', 's-2'])
    })
    await act(async () => {
      await captured!.confirmPendingAction()
    })

    await act(async () => {
      await captured!.confirmBlockedDelete({ unlockLockedTree: true })
    })

    expect(spies.deleteSessionWithOptions).toHaveBeenCalledTimes(2)
    expect(spies.deleteSessionWithOptions).toHaveBeenNthCalledWith(1, 's-1', { unlockLockedTree: true })
    expect(spies.deleteSessionWithOptions).toHaveBeenNthCalledWith(2, 's-2', { unlockLockedTree: true })
    const ids = useSessionStore.getState().sessions!.map((s) => s.id)
    expect(ids).not.toContain('s-1')
    expect(ids).not.toContain('s-2')
    expect(captured!.blockedDelete).toBeNull()
  })

  it('a renewed refusal on retry refreshes reason/option and keeps the remainder parked', async () => {
    useSessionStore.setState({
      sessions: [makeSession('s-1', 'proj-1', { name: 'Managed One' }), makeSession('s-2')],
    })
    spies.deleteSession.mockRejectedValueOnce(
      blockedError('worktree "s-1" has uncommitted changes', 'confirm_uncommitted_loss'),
    )
    await act(async () => {
      await captured!.handleDeleteGroup('feat/a', ['s-1', 's-2'])
    })
    await act(async () => {
      await captured!.confirmPendingAction()
    })
    spies.deleteSessionWithOptions.mockRejectedValueOnce(
      blockedError('worktree "s-1" is locked by another process', 'unlock_locked_tree'),
    )

    await act(async () => {
      await captured!.confirmBlockedDelete({ confirmUncommittedLoss: true })
    })

    // The retry stopped at s-1 again; the park is refreshed IN PLACE.
    expect(spies.deleteSessionWithOptions).toHaveBeenCalledTimes(1)
    expect(captured!.blockedDelete).toEqual({
      sessionIds: ['s-1', 's-2'],
      sessionName: 'feat/a',
      reason: 'worktree "s-1" is locked by another process',
      option: 'unlock_locked_tree',
    })
    // A recognized refusal is still not a failure, and nothing was deleted.
    expect(spies.logError).not.toHaveBeenCalled()
    expect(captured!.blockedDeleteError).toBeNull()
    expect(useSessionStore.getState().sessions!.map((s) => s.id)).toEqual(['s-1', 's-2'])
  })

  it('a NON-blocked retry failure parks the inline error; the state stays retryable', async () => {
    useSessionStore.setState({ sessions: [makeSession('s-m', 'proj-1', { name: 'Managed' })] })
    spies.deleteSession.mockRejectedValueOnce(
      blockedError('worktree "s-m" has uncommitted changes', 'confirm_uncommitted_loss'),
    )
    await act(async () => {
      await captured!.handleDelete('s-m')
    })
    spies.deleteSessionWithOptions.mockRejectedValueOnce(new Error('rpc down'))

    await act(async () => {
      await captured!.confirmBlockedDelete({ confirmUncommittedLoss: true })
    })

    expect(captured!.blockedDeleteError).toBe('rpc down')
    expect(spies.logError).toHaveBeenCalledWith('Failed to delete session:', expect.any(Error))
    // Still parked, unchanged — the user can retry or cancel.
    expect(captured!.blockedDelete).toEqual({
      sessionIds: ['s-m'],
      sessionName: 'Managed',
      reason: 'worktree "s-m" has uncommitted changes',
      option: 'confirm_uncommitted_loss',
    })
  })

  it('cancelBlockedDelete clears the parked state and any inline error', async () => {
    useSessionStore.setState({ sessions: [makeSession('s-m', 'proj-1', { name: 'Managed' })] })
    spies.deleteSession.mockRejectedValueOnce(
      blockedError('worktree "s-m" has uncommitted changes', 'confirm_uncommitted_loss'),
    )
    await act(async () => {
      await captured!.handleDelete('s-m')
    })
    spies.deleteSessionWithOptions.mockRejectedValueOnce(new Error('rpc down'))
    await act(async () => {
      await captured!.confirmBlockedDelete({ confirmUncommittedLoss: true })
    })
    expect(captured!.blockedDeleteError).toBe('rpc down')

    await act(async () => {
      captured!.cancelBlockedDelete()
    })

    expect(captured!.blockedDelete).toBeNull()
    expect(captured!.blockedDeleteError).toBeNull()
    // The session was never deleted.
    expect(useSessionStore.getState().sessions!.map((s) => s.id)).toContain('s-m')
  })

  it('busy-confirm is intact: a busy session arms the dialog and ITS confirm parks a block too', async () => {
    useSessionStore.setState({
      sessions: [makeSession('s-busy', 'proj-1', { name: 'Busy', unfinished_task_status: 'in_progress' })],
    })

    await act(async () => {
      await captured!.handleDelete('s-busy')
    })

    // The busy guard fires first: the plain confirm dialog, not the park.
    expect(captured!.pendingAction).toEqual({
      kind: 'delete',
      sessionId: 's-busy',
      sessionName: 'Busy',
      isArchived: false,
    })
    expect(captured!.blockedDelete).toBeNull()
    expect(spies.deleteSession).not.toHaveBeenCalled()

    spies.deleteSession.mockRejectedValueOnce(
      blockedError('worktree "s-busy" has uncommitted changes', 'confirm_uncommitted_loss'),
    )
    await act(async () => {
      await captured!.confirmPendingAction()
    })

    expect(captured!.pendingAction).toBeNull()
    expect(captured!.blockedDelete).toEqual({
      sessionIds: ['s-busy'],
      sessionName: 'Busy',
      reason: 'worktree "s-busy" has uncommitted changes',
      option: 'confirm_uncommitted_loss',
    })
  })
})
