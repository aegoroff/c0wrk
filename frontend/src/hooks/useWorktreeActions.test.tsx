// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// --- Mock the git API wrapper and the focus refresh so tests never touch the
// --- Wails backend ---
const { gitMocks, focusMocks } = vi.hoisted(() => ({
  gitMocks: {
    deleteWorktree: vi.fn(),
  },
  focusMocks: {
    refreshGitFocus: vi.fn(),
  },
}))

vi.mock('@/api/git', () => gitMocks)
vi.mock('@/lib/gitFocus', () => focusMocks)
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { useWorktreeActions, type WorktreeActions } from './useWorktreeActions'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useProjectStore } from '@/stores/projectStore'
import type { GitWorktree } from '@/types/models'

let result!: WorktreeActions
let root: Root
let container: HTMLDivElement

function makeWorktree(overrides: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path: '/repo/.worktrees/s-abc12345',
    name: 's-abc12345',
    kind: 'managed',
    branch: 'sess/s-abc12345',
    head: 'abc',
    managed: true,
    pinned: true,
    is_focus: false,
    ...overrides,
  }
}

function Harness() {
  result = useWorktreeActions()
  return null
}

function renderHook(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<Harness />)
  })
}

beforeEach(() => {
  gitMocks.deleteWorktree.mockReset()
  gitMocks.deleteWorktree.mockResolvedValue(undefined)
  focusMocks.refreshGitFocus.mockReset()
  focusMocks.refreshGitFocus.mockResolvedValue(undefined)
  // Operations record their outcome against the ACTIVE project; without one
  // they are skipped entirely. Reset the recorder slice for clean assertions.
  useGitPanelStore.getState().reset()
  useProjectStore.setState({ activeProjectId: 'p1' })
})

describe('useWorktreeActions — request/cancel', () => {
  it('requestDelete parks the worktree for confirmation', () => {
    renderHook()
    const tree = makeWorktree()
    act(() => {
      result.requestDelete(tree)
    })
    expect(result.pendingDelete).toEqual({ worktree: tree })
    expect(result.deleteError).toBeNull()
  })

  it('requestDelete refuses the local checkout — it is never deletable', () => {
    renderHook()
    act(() => {
      result.requestDelete(makeWorktree({ kind: 'main', path: '/repo', name: 'repo', managed: false, pinned: false }))
    })
    expect(result.pendingDelete).toBeNull()
    expect(gitMocks.deleteWorktree).not.toHaveBeenCalled()
  })

  it('cancelDelete clears the pending worktree and any error without deleting', async () => {
    gitMocks.deleteWorktree.mockRejectedValue(new Error('worktree has uncommitted changes: M f.ts'))
    renderHook()
    act(() => {
      result.requestDelete(makeWorktree())
    })
    await act(async () => {
      await result.confirmDelete('safe', false)
    })
    expect(result.pendingDelete).not.toBeNull()

    act(() => {
      result.cancelDelete()
    })
    expect(result.pendingDelete).toBeNull()
    expect(result.deleteError).toBeNull()
  })
})

describe('useWorktreeActions — confirmed deletion', () => {
  it('confirmDelete(safe) removes without force, clears pending and refreshes the focus', async () => {
    renderHook()
    act(() => {
      result.requestDelete(makeWorktree())
    })
    await act(async () => {
      await result.confirmDelete('safe', false)
    })
    expect(gitMocks.deleteWorktree).toHaveBeenCalledWith('/repo/.worktrees/s-abc12345', {
      force: false,
      unlock: false,
    })
    expect(result.pendingDelete).toBeNull()
    expect(result.deleteError).toBeNull()
    expect(focusMocks.refreshGitFocus).toHaveBeenCalledTimes(1)
    // The outcome lands in the Git panel's operation console.
    expect(useGitPanelStore.getState().operationByProject['p1']).toMatchObject({
      kind: 'worktree-delete',
      ok: true,
      label: 'Deleted worktree s-abc12345',
    })
  })

  it('confirmDelete(force, unlock) passes both flags through', async () => {
    renderHook()
    act(() => {
      result.requestDelete(makeWorktree({ locked: true }))
    })
    await act(async () => {
      await result.confirmDelete('force', true)
    })
    expect(gitMocks.deleteWorktree).toHaveBeenCalledWith('/repo/.worktrees/s-abc12345', {
      force: true,
      unlock: true,
    })
  })

  it('tracks the in-flight busy path during the removal', async () => {
    let resolve!: () => void
    gitMocks.deleteWorktree.mockImplementation(
      () => new Promise<void>((r) => { resolve = r }),
    )
    renderHook()
    act(() => {
      result.requestDelete(makeWorktree())
    })

    let pending!: Promise<void>
    act(() => {
      pending = result.confirmDelete('safe', false)
    })
    expect(result.isBusy).toBe(true)
    expect(result.busyPath).toBe('/repo/.worktrees/s-abc12345')

    await act(async () => {
      resolve()
      await pending
    })
    expect(result.isBusy).toBe(false)
    expect(result.busyPath).toBeNull()
  })

  it('restores the dialog with the backend refusal on failure and skips the focus refresh', async () => {
    gitMocks.deleteWorktree.mockRejectedValue(
      new Error('worktree has uncommitted changes: M frontend/src/api/git.ts'),
    )
    renderHook()
    const tree = makeWorktree()
    act(() => {
      result.requestDelete(tree)
    })

    await act(async () => {
      await result.confirmDelete('safe', false)
    })

    // The dirty refusal re-opens the dialog with the verbatim reason, so the
    // user can retry with Force; the focus is NOT refreshed (nothing moved).
    expect(result.pendingDelete).toEqual({ worktree: tree })
    expect(result.deleteError).toContain('worktree has uncommitted changes')
    expect(focusMocks.refreshGitFocus).not.toHaveBeenCalled()
    // The failure is still recorded in the operation console.
    expect(useGitPanelStore.getState().operationByProject['p1']).toMatchObject({
      kind: 'worktree-delete',
      ok: false,
    })
  })

  it('a retry with force after a dirty refusal succeeds and clears the error', async () => {
    gitMocks.deleteWorktree
      .mockRejectedValueOnce(new Error('worktree has uncommitted changes: M f.ts'))
      .mockResolvedValueOnce(undefined)
    renderHook()
    act(() => {
      result.requestDelete(makeWorktree())
    })

    await act(async () => {
      await result.confirmDelete('safe', false)
    })
    expect(result.deleteError).not.toBeNull()

    await act(async () => {
      await result.confirmDelete('force', false)
    })
    expect(gitMocks.deleteWorktree).toHaveBeenLastCalledWith('/repo/.worktrees/s-abc12345', {
      force: true,
      unlock: false,
    })
    expect(result.pendingDelete).toBeNull()
    expect(result.deleteError).toBeNull()
    expect(focusMocks.refreshGitFocus).toHaveBeenCalledTimes(1)
  })

  it('skips the removal entirely when no project is active — nothing ran', async () => {
    useProjectStore.setState({ activeProjectId: null })
    renderHook()
    const tree = makeWorktree()
    act(() => {
      result.requestDelete(tree)
    })

    await act(async () => {
      await result.confirmDelete('safe', false)
    })

    expect(gitMocks.deleteWorktree).not.toHaveBeenCalled()
    expect(focusMocks.refreshGitFocus).not.toHaveBeenCalled()
    // A skipped attempt restores the pending tree but carries no error —
    // nothing failed; the operation simply never ran.
    expect(result.pendingDelete).toEqual({ worktree: tree })
    expect(result.deleteError).toBeNull()
    expect(useGitPanelStore.getState().operationByProject['p1']).toBeUndefined()
  })

  it('a skipped attempt while another removal is in flight does not run twice', async () => {
    let resolve!: () => void
    gitMocks.deleteWorktree.mockImplementation(
      () => new Promise<void>((r) => { resolve = r }),
    )
    renderHook()
    const tree = makeWorktree()
    act(() => {
      result.requestDelete(tree)
    })

    let first!: Promise<void>
    act(() => {
      first = result.confirmDelete('safe', false)
    })
    await act(async () => {
      await result.confirmDelete('safe', false)
    })
    await act(async () => {
      resolve()
      await first
    })

    expect(gitMocks.deleteWorktree).toHaveBeenCalledTimes(1)
  })
})
