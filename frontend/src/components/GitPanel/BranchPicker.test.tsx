// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// --- Mock the git API wrappers so tests never touch the Wails backend ---
// vi.mock factories are hoisted, so the mock objects must be created via
// vi.hoisted() to be accessible inside the factory.
const { gitMocks } = vi.hoisted(() => ({
  gitMocks: {
    getBranches: vi.fn(),
    listProjectWorktrees: vi.fn(),
    checkoutBranch: vi.fn(),
    checkoutRemoteBranch: vi.fn(),
    createBranch: vi.fn(),
    createBranchInWorktree: vi.fn(),
    getBranchBases: vi.fn(),
    deleteWorktree: vi.fn(),
  },
}))

vi.mock('@/api/git', () => gitMocks)

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

// Focus actions (worktree switching) are mocked so tests never touch the backend.
const { focusMocks } = vi.hoisted(() => ({
  focusMocks: {
    focusWorktree: vi.fn(),
    refreshGitFocus: vi.fn(),
  },
}))

vi.mock('@/lib/gitFocus', () => focusMocks)

import { TooltipProvider } from '@/components/ui/tooltip'
import { BranchPicker } from './BranchPicker'
import { focusWorktree } from '@/lib/gitFocus'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useSessionDraftStore } from '@/stores/sessionDraftStore'
import { useProjectStore } from '@/stores/projectStore'
import type { GitWorktree } from '@/types/models'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // Reset call history without removing the mock function identities.
  gitMocks.getBranches.mockReset()
  gitMocks.listProjectWorktrees.mockReset()
  gitMocks.checkoutBranch.mockReset()
  gitMocks.checkoutRemoteBranch.mockReset()
  gitMocks.createBranch.mockReset()
  gitMocks.createBranchInWorktree.mockReset()
  gitMocks.getBranchBases.mockReset()
  gitMocks.deleteWorktree.mockReset()
  // Default: resolve to an empty branch list so the effect always has a
  // thenable. Individual tests override this as needed.
  gitMocks.getBranches.mockResolvedValue([])
  // Same for the worktree list the open effect refreshes alongside branches.
  gitMocks.listProjectWorktrees.mockResolvedValue([])
  gitMocks.deleteWorktree.mockResolvedValue(undefined)
  focusMocks.focusWorktree.mockReset()
  focusMocks.focusWorktree.mockResolvedValue(undefined)
  focusMocks.refreshGitFocus.mockReset()
  focusMocks.refreshGitFocus.mockResolvedValue(undefined)

  useGitPanelStore.getState().reset()
  // Branch operations record their outcome against the ACTIVE project.
  useProjectStore.setState({ activeProjectId: 'p1' })
  useGitPanelStore.getState().openBranchPicker()
  useGitPanelStore.setState({
    branch: { name: 'main', upstream: '', ahead: 0, behind: 0 },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  // Radix Dialog portals content into document.body — clear any leftovers.
  document.body.innerHTML = ''
})

/**
 * The Radix Dialog renders its content through a portal into document.body,
 * so assertions must target document.body rather than the mount container.
 */
function body(): HTMLElement {
  return document.body
}

/**
 * Set a controlled input's value in a way React detects. React tracks the
 * last value via a hidden descriptor, so directly assigning `.value` then
 * dispatching `input` does NOT trigger onChange in jsdom. We must use the
 * native HTMLInputElement value setter, then dispatch the event.
 */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Flush microtasks so async effects (getBranches) resolve. */
function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** All buttons currently in the DOM (inside the portaled dialog). */
function allButtons(): HTMLButtonElement[] {
  return Array.from(body().querySelectorAll('button'))
}

/** Branch rows are `div[role="button"]` (LocalBranchRow / RemoteBranchRow). */
function branchRows(): HTMLElement[] {
  return Array.from(body().querySelectorAll('div[role="button"]'))
}

/** The branch row whose text contains `name`. */
function branchRow(name: string): HTMLElement | undefined {
  return branchRows().find((el) => el.textContent?.includes(name))
}

function renderPicker() {
  act(() => {
    root.render(
      <TooltipProvider>
        <BranchPicker />
      </TooltipProvider>,
    )
  })
}

describe('BranchPicker', () => {
  it('does not render anything when closed', () => {
    useGitPanelStore.getState().closeBranchPicker()
    renderPicker()
    expect(body().textContent).not.toContain('Switch Branch')
  })

  it('renders the title and loads branches when open', async () => {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
      { name: 'feature/x', is_current: false, kind: 'local', upstream: '' },
      { name: 'bugfix/123', is_current: false, kind: 'local', upstream: '' },
    ])
    renderPicker()

    await flush()

    expect(body().textContent).toContain('Switch Branch')
    expect(gitMocks.getBranches).toHaveBeenCalled()
    // All branches rendered.
    expect(body().textContent).toContain('main')
    expect(body().textContent).toContain('feature/x')
    expect(body().textContent).toContain('bugfix/123')
  })

  it('renders remote branches in a separate group', async () => {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
      { name: 'origin/feature/x', is_current: false, kind: 'remote', upstream: '' },
    ])
    renderPicker()
    await flush()

    expect(body().textContent).toContain('Local')
    expect(body().textContent).toContain('Remote')
    expect(body().textContent).toContain('origin/feature/x')
  })

  it('marks the current branch with a check and disables its row', async () => {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
      { name: 'dev', is_current: false, kind: 'local', upstream: '' },
    ])
    renderPicker()
    await flush()

    const mainRow = branchRow('main')!
    const devRow = branchRow('dev')!

    // The current branch is non-interactive and marked with aria-current.
    expect(mainRow.getAttribute('aria-current')).toBe('true')
    expect(mainRow.getAttribute('tabindex')).toBe('-1')
    // The current branch shows a check icon (lucide renders an <svg>).
    expect(mainRow.querySelector('svg')).not.toBeNull()
    // Non-current branches are interactive and carry no aria-current.
    expect(devRow.getAttribute('tabindex')).toBe('0')
    expect(devRow.getAttribute('aria-current')).toBeNull()
  })

  it('calls checkoutBranch and closes the picker when a branch is clicked', async () => {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
      { name: 'dev', is_current: false, kind: 'local', upstream: '' },
    ])
    gitMocks.checkoutBranch.mockResolvedValue(undefined)
    renderPicker()
    await flush()

    const devRow = branchRow('dev')!
    await act(async () => {
      devRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.checkoutBranch).toHaveBeenCalledWith('dev')
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
    // The outcome is recorded in the operation console slice.
    expect(useGitPanelStore.getState().operationByProject['p1']).toMatchObject({
      kind: 'checkout',
      ok: true,
    })
  })

  it('records a checkout failure in the operation console and closes', async () => {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
      { name: 'dev', is_current: false, kind: 'local', upstream: '' },
    ])
    gitMocks.checkoutBranch.mockRejectedValue(
      new Error('local changes would be overwritten'),
    )
    renderPicker()
    await flush()

    const devRow = branchRow('dev')!
    await act(async () => {
      devRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    // The picker closes on error (the operation console surfaces it) and the
    // failure is recorded against the active project.
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
    expect(useGitPanelStore.getState().operationByProject['p1']).toMatchObject({
      kind: 'checkout',
      ok: false,
      error: 'local changes would be overwritten',
    })
  })

  it('filters branches by the filter input', async () => {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
      { name: 'feature/auth', is_current: false, kind: 'local', upstream: '' },
      { name: 'feature/api', is_current: false, kind: 'local', upstream: '' },
      { name: 'bugfix/123', is_current: false, kind: 'local', upstream: '' },
    ])
    renderPicker()
    await flush()

    const filterInput = Array.from(body().querySelectorAll('input')).find(
      (i) => i.getAttribute('placeholder') === 'Filter branches...',
    )!
    await act(async () => {
      setInputValue(filterInput, 'feature')
    })

    const text = body().textContent ?? ''
    expect(text).toContain('feature/auth')
    expect(text).toContain('feature/api')
    expect(text).not.toContain('main')
    expect(text).not.toContain('bugfix/123')
  })

  it('creates a new branch via the New button', async () => {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
    ])
    gitMocks.createBranch.mockResolvedValue(undefined)
    renderPicker()
    await flush()

    const newBranchInput = Array.from(body().querySelectorAll('input')).find(
      (i) => i.getAttribute('placeholder') === 'branch-name',
    )!
    const newBtn = allButtons().find((b) => b.textContent?.includes('New'))!

    await act(async () => {
      setInputValue(newBranchInput, 'feature/new')
    })
    await act(async () => {
      newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gitMocks.createBranch).toHaveBeenCalledWith('feature/new', '')
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
  })

  it('creates a new branch from a selected base', async () => {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
    ])
    gitMocks.getBranchBases.mockResolvedValue([
      { ref: 'develop', label: 'develop', type: 'local', detail: '' },
      { ref: 'origin/main', label: 'origin/main', type: 'remote', detail: '' },
    ])
    gitMocks.createBranch.mockResolvedValue(undefined)
    renderPicker()
    await flush()

    // Type the new branch name.
    const newBranchInput = Array.from(body().querySelectorAll('input')).find(
      (i) => i.getAttribute('placeholder') === 'branch-name',
    )!
    await act(async () => {
      setInputValue(newBranchInput, 'feature/from-dev')
    })

    // Expand the "Choose base" collapsible.
    const baseTrigger = allButtons().find((b) =>
      b.textContent?.includes('Choose base'),
    )!
    await act(async () => {
      baseTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // Select the 'develop' base.
    const devBaseBtn = allButtons().find((b) =>
      b.textContent?.includes('develop'),
    )!
    await act(async () => {
      devBaseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    // Click New.
    const newBtn = allButtons().find((b) => b.textContent?.includes('New'))!
    await act(async () => {
      newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gitMocks.createBranch).toHaveBeenCalledWith('feature/from-dev', 'develop')
  })

  it('creates a new branch via Enter key in the new-branch input', async () => {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
    ])
    gitMocks.createBranch.mockResolvedValue(undefined)
    renderPicker()
    await flush()

    const newBranchInput = Array.from(body().querySelectorAll('input')).find(
      (i) => i.getAttribute('placeholder') === 'branch-name',
    )!

    await act(async () => {
      setInputValue(newBranchInput, 'release/v2')
    })
    await act(async () => {
      newBranchInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(gitMocks.createBranch).toHaveBeenCalledWith('release/v2', '')
  })

  it('shows an error when createBranch fails', async () => {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
    ])
    gitMocks.createBranch.mockRejectedValue(
      new Error('branch "dup" already exists'),
    )
    renderPicker()
    await flush()

    const newBranchInput = Array.from(body().querySelectorAll('input')).find(
      (i) => i.getAttribute('placeholder') === 'branch-name',
    )!
    const newBtn = allButtons().find((b) => b.textContent?.includes('New'))!

    await act(async () => {
      setInputValue(newBranchInput, 'dup')
    })
    await act(async () => {
      newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(body().textContent).toContain('already exists')
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(true)
  })

  it('shows a loading state and no branch list while branches load', () => {
    // Never-resolving promise keeps loadingBranches=true.
    gitMocks.getBranches.mockReturnValue(new Promise(() => {}))
    renderPicker()

    expect(gitMocks.getBranches).toHaveBeenCalled()
    // No branch names rendered yet.
    expect(body().textContent).not.toContain('main')
  })

  it('captures a pending branch base when the picker transitions closed→open', async () => {
    // Close the picker first (beforeEach opens it) and mount — mirroring the
    // real initial state where BranchPicker is always mounted but closed.
    useGitPanelStore.getState().closeBranchPicker()
    renderPicker()
    expect(body().textContent).not.toContain('Switch Branch')

    // Simulate the commit context menu's "Create › Branch" handler: set the
    // base ref and open the picker synchronously in the same tick.
    gitMocks.getBranchBases.mockResolvedValue([
      { ref: 'develop', label: 'develop', type: 'local', detail: '' },
    ])
    act(() => {
      useGitPanelStore.getState().setPendingBranchBase('abc1234deadbeef')
      useGitPanelStore.getState().openBranchPicker()
    })
    await flush()

    // The "Choose base" collapsible should auto-expand and the preselected
    // base should be visible — proving NewBranchSection captured it despite
    // Radix Dialog's deferred Presence mount.
    expect(body().textContent).toContain('Base:')
    expect(body().textContent).toContain('abc1234deadbeef')
  })
})

describe('BranchPicker — worktree focus switcher', () => {
  beforeEach(() => {
    focusMocks.focusWorktree.mockReset()
    focusMocks.focusWorktree.mockResolvedValue(undefined)
  })

  it('hides the Worktrees section when the project has no worktrees', async () => {
    useGitPanelStore.getState().setWorktrees([])
    renderPicker()
    await flush()

    expect(body().textContent).not.toContain('Worktrees')
  })

  it('lists every worktree (including the local checkout) and switches the focus on selection', async () => {
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: false,
      },
      {
        path: '/repo/.worktrees/s-abc12345', name: 's-abc12345', kind: 'managed',
        branch: 'sess/s-abc12345', head: 'b', managed: true, pinned: true,
        is_focus: true, session_id: 'sess-1', session_name: 'Refactor loop',
      },
      {
        path: '/elsewhere/ext', name: 'ext', kind: 'external', branch: 'ext-branch',
        head: 'c', managed: false, pinned: false, is_focus: false,
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    renderPicker()
    await flush()

    const rows = Array.from(body().querySelectorAll<HTMLButtonElement>('[data-testid="worktree-row"]'))
    expect(rows).toHaveLength(3)
    expect(body().textContent).toContain('Worktrees')
    expect(body().textContent).toContain('Local checkout')
    expect(body().textContent).toContain('Refactor loop')

    await act(async () => {
      rows[0]!.click()
    })
    await flush()

    expect(focusWorktree).toHaveBeenCalledTimes(1)
    expect(focusWorktree).toHaveBeenCalledWith('/repo')
    // Selecting a worktree closes the switch-branch dialog.
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
  })

  it('deletes a linked tree through the confirm dialog in switch mode', async () => {
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: false,
      },
      {
        path: '/repo/.worktrees/s-abc12345', name: 's-abc12345', kind: 'managed',
        branch: 'sess/s-abc12345', head: 'b', managed: true, pinned: true,
        is_focus: true, session_id: 'sess-1', session_name: 'Refactor loop',
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    renderPicker()
    await flush()

    const rows = Array.from(body().querySelectorAll('[data-testid="worktree-row"]'))
    // The checkout has no delete action; the linked tree does.
    expect(rows[0]!.querySelectorAll('button')).toHaveLength(0)
    act(() => {
      rows[1]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(body().textContent).toContain('Delete worktree?')
    act(() => {
      const del = allButtons().find((b) => b.textContent?.trim() === 'Delete')!
      del.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.deleteWorktree).toHaveBeenCalledWith('/repo/.worktrees/s-abc12345', {
      force: false,
      unlock: false,
    })
    expect(focusMocks.refreshGitFocus).toHaveBeenCalledTimes(1)
  })
})

describe('BranchPicker — session-draft mode (select/create for a managed worktree)', () => {
  /**
   * Open the picker in DRAFT mode with a standard branch fixture:
   * `main` is the working tree's current branch, `feat/a` + `feat/b` are
   * free local branches, `origin/feat/remote` is a remote branch.
   */
  async function openDraftPicker() {
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
      { name: 'feat/a', is_current: false, kind: 'local', upstream: '' },
      { name: 'feat/b', is_current: false, kind: 'local', upstream: '' },
      { name: 'origin/feat/remote', is_current: false, kind: 'remote', upstream: '' },
    ])
    useGitPanelStore.getState().openBranchPicker('draft')
    renderPicker()
    await flush()
  }

  beforeEach(() => {
    useSessionDraftStore.getState().startDraft('p1')
    // The shared focus mock carries call history from the earlier describes.
    focusMocks.focusWorktree.mockReset()
    focusMocks.focusWorktree.mockResolvedValue(undefined)
  })

  it('select-existing intent: records the branch in the draft, never checks out', async () => {
    await openDraftPicker()

    // The subtitle discloses both outcomes: a fresh worktree, or joining
    // the existing one when the picked branch is already in use (ADR-082).
    expect(body().textContent).toContain(
      'joins the existing worktree when the branch is already in use',
    )

    const row = branchRow('feat/a')!
    expect(row).toBeDefined()
    await act(async () => {
      row.click()
    })
    await flush()

    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({
      kind: 'branch',
      branch: 'feat/a',
      createBranch: false,
      startPoint: '',
    })
    // NO in-place checkout side effect: no git mutation ran at pick time —
    // provisioning happens at draft commit via CreateManagedSession.
    expect(gitMocks.checkoutBranch).not.toHaveBeenCalled()
    expect(gitMocks.createBranch).not.toHaveBeenCalled()
    expect(gitMocks.checkoutRemoteBranch).not.toHaveBeenCalled()
    expect(focusWorktree).not.toHaveBeenCalled()
    // Selection closes the picker.
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
  })

  it('marks the already-picked branch and keeps the picker open while it loads', async () => {
    useSessionDraftStore
      .getState()
      .setDraftWorkspace({ kind: 'branch', branch: 'feat/b', createBranch: false, startPoint: '' })
    await openDraftPicker()

    expect(body().textContent).toContain('Choose Branch')
    expect(branchRow('feat/b')!.getAttribute('aria-current')).toBe('true')
    expect(branchRow('feat/a')!.getAttribute('aria-current')).toBeNull()
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(true)
  })

  it('draft mode: selects a worktree\'s branch even when it is_current — the existing managed tree is adopted', async () => {
    // The Git panel is focused on the managed tree holding feat/a, so
    // GetBranches (which runs in the focused tree) marks feat/a is_current.
    // The pick must still record the draft — at draft commit
    // CreateManagedSession ADOPTS the existing tree (ADR-082) — and close
    // the picker; nothing is checked out here.
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: false, kind: 'local', upstream: '' },
      { name: 'feat/a', is_current: true, kind: 'local', upstream: '' },
    ])
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: false,
      },
      {
        path: '/repo/.worktrees/s-live1234', name: 's-live1234', kind: 'managed',
        branch: 'feat/a', head: 'b', managed: true, pinned: true,
        is_focus: true, session_id: 'sess-1', session_name: 'Live loop',
      },
    ]
    // The open effect refreshes the worktree list from the backend — serve
    // the same fixture there so the assertions below hold after it lands.
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    useGitPanelStore.getState().openBranchPicker('draft')
    renderPicker()
    await flush()

    const row = branchRow('feat/a')!
    expect(row).toBeDefined()
    expect(row.className).not.toContain('cursor-not-allowed')
    await act(async () => {
      row.click()
    })
    await flush()

    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({
      kind: 'branch',
      branch: 'feat/a',
      createBranch: false,
      startPoint: '',
    })
    expect(gitMocks.checkoutBranch).not.toHaveBeenCalled()
    expect(focusWorktree).not.toHaveBeenCalled()
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
  })

  it('draft mode: blocks only the main checkout\'s worktree branch, regardless of Git-panel focus', async () => {
    // The Git panel is focused on the MANAGED tree, so `main` is NOT
    // is_current (GetBranches runs in the focused tree) — yet the checkout
    // holds `main` and stays blocked: git allows a branch in at most one
    // worktree. The rule is focus-independent.
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: false, kind: 'local', upstream: '' },
      { name: 'feat/a', is_current: true, kind: 'local', upstream: '' },
    ])
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: false,
      },
      {
        path: '/repo/.worktrees/s-live1234', name: 's-live1234', kind: 'managed',
        branch: 'feat/a', head: 'b', managed: true, pinned: true,
        is_focus: true, session_id: 'sess-1', session_name: 'Live loop',
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    useGitPanelStore.getState().openBranchPicker('draft')
    renderPicker()
    await flush()

    const row = branchRow('main')!
    expect(row.className).toContain('cursor-not-allowed')
    // The tooltip names the MAIN checkout — not "the working tree" (the
    // block follows the checkout, not the focus).
    expect(row.getAttribute('title')).toContain('main checkout')
    await act(async () => {
      row.click()
    })
    await flush()

    // The draft stays local and the picker stays open (no selection made).
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({ kind: 'local' })
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(true)
  })

  it('create-new intent: records the drafted branch instead of CreateBranch + checkout', async () => {
    await openDraftPicker()

    const input = Array.from(body().querySelectorAll<HTMLInputElement>('input')).find((i) => i.placeholder === 'branch-name')!
    act(() => {
      setInputValue(input, 'feat/drafted')
    })
    const newButton = allButtons().find((b) => b.textContent?.trim() === 'New')!
    await act(async () => {
      newButton.click()
    })
    await flush()

    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({
      kind: 'branch',
      branch: 'feat/drafted',
      createBranch: true,
      startPoint: '',
    })
    // The branch is created at draft commit inside the session's managed
    // worktree — NOT here via an in-place CreateBranch/checkout.
    expect(gitMocks.createBranch).not.toHaveBeenCalled()
    expect(gitMocks.checkoutBranch).not.toHaveBeenCalled()
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
  })

  it('create-new intent: carries the chosen base as the start point', async () => {
    gitMocks.getBranchBases.mockResolvedValue([
      { ref: 'main', label: 'main' },
      { ref: 'v1.0.0', label: 'tag: v1.0.0' },
    ])
    // Preselect a base the way the history context menu does — the section
    // opens with the base selector expanded and the ref picked.
    useGitPanelStore.getState().setPendingBranchBase('v1.0.0')
    await openDraftPicker()

    const input = Array.from(body().querySelectorAll<HTMLInputElement>('input')).find((i) => i.placeholder === 'branch-name')!
    act(() => {
      setInputValue(input, 'feat/from-base')
    })
    const newButton = allButtons().find((b) => b.textContent?.trim() === 'New')!
    await act(async () => {
      newButton.click()
    })
    await flush()

    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({
      kind: 'branch',
      branch: 'feat/from-base',
      createBranch: true,
      startPoint: 'v1.0.0',
    })
  })

  it('lists remote rows selectable like local ones and keeps the worktrees section in draft mode', async () => {
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: false,
      },
      {
        path: '/repo/.worktrees/s-abc12345', name: 's-abc12345', kind: 'managed',
        branch: 'sess/s-abc12345', head: 'b', managed: true, pinned: true,
        is_focus: false, session_id: 'sess-1', session_name: 'Refactor loop',
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    await openDraftPicker()

    // Remote rows are listed and selectable in draft mode (no git operation
    // runs at pick time — provisioning happens at draft commit).
    expect(body().textContent).toContain('Remote')
    expect(branchRow('origin/feat/remote')).toBeDefined()

    // The worktrees section is shown so an existing tree can be deleted
    // from the same dialog (the deletion never touches the draft).
    const rows = Array.from(body().querySelectorAll<HTMLButtonElement>('[data-testid="worktree-row"]'))
    expect(rows).toHaveLength(2)
    expect(body().textContent).toContain('Worktrees')
    expect(body().textContent).toContain('Refactor loop')
  })

  it('draft mode: clicking a managed worktree row records the worktree\'s branch in the draft', async () => {
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: true,
      },
      {
        path: '/repo/.worktrees/s-abc12345', name: 's-abc12345', kind: 'managed',
        branch: 'sess/s-abc12345', head: 'b', managed: true, pinned: true,
        is_focus: false, session_id: 'sess-1', session_name: 'Refactor loop',
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    await openDraftPicker()

    const rows = Array.from(body().querySelectorAll<HTMLElement>('[data-testid="worktree-row"]'))
    // The tooltip discloses the sharing: the session joins the existing
    // worktree instead of getting a fresh one (ADR-082 adoption).
    expect(rows[1]!.getAttribute('title')).toContain('joins the existing worktree')
    await act(async () => {
      rows[1]!.click()
    })
    await flush()

    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({
      kind: 'branch',
      branch: 'sess/s-abc12345',
      createBranch: false,
      startPoint: '',
    })
    // Draft selection never moves the Git panel's focus.
    expect(focusWorktree).not.toHaveBeenCalled()
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
  })

  it('draft mode: an external worktree row is not a draft target — its branch is held outside c0wrk', async () => {
    // c0wrk never adopts trees it does not own (ADR-082): the draft commit
    // would refuse a branch held by an external tree (ErrBranchBusy), and
    // provisioning a fresh managed tree on that branch would fail too — git
    // allows a branch in at most one worktree. The row must render disabled
    // with that reason, never arm a doomed draft.
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: true,
      },
      {
        path: '/elsewhere/ext-tree', name: 'ext-tree', kind: 'external',
        branch: 'ext/branch', head: 'c', managed: false, pinned: false,
        is_focus: false,
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    await openDraftPicker()

    const rows = Array.from(body().querySelectorAll<HTMLElement>('[data-testid="worktree-row"]'))
    expect(rows[1]!.className).toContain('cursor-not-allowed')
    expect(rows[1]!.getAttribute('aria-disabled')).toBe('true')
    // The tooltip mirrors the backend refusal: the tree was created outside
    // c0wrk and its branch cannot back the new session.
    expect(rows[1]!.getAttribute('title')).toContain('outside c0wrk')
    await act(async () => {
      rows[1]!.click()
    })
    await flush()

    // No doomed draft: the pre-armed local workspace is untouched…
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({ kind: 'local' })
    // …and never a hidden focus switch either; the picker stays open so the
    // user can pick a real target.
    expect(focusWorktree).not.toHaveBeenCalled()
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(true)
    // Deletion stays available on the gated row.
    expect(rows[1]!.querySelectorAll('button')).toHaveLength(1)
  })

  it('draft mode: a detached linked tree is not a draft target — no branch to run the session on', async () => {
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: true,
      },
      {
        path: '/elsewhere/det-tree', name: 'det-tree', kind: 'external',
        head: 'd', managed: false, pinned: false, is_focus: false,
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    await openDraftPicker()

    const rows = Array.from(body().querySelectorAll<HTMLElement>('[data-testid="worktree-row"]'))
    expect(rows[1]!.className).toContain('cursor-not-allowed')
    expect(rows[1]!.getAttribute('aria-disabled')).toBe('true')
    // The tooltip must not promise a run target the click cannot deliver.
    expect(rows[1]!.getAttribute('title')).toContain('Detached HEAD')
    await act(async () => {
      rows[1]!.click()
    })
    await flush()

    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({ kind: 'local' })
    expect(focusWorktree).not.toHaveBeenCalled()
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(true)
  })

  it('draft mode: opening the picker refreshes the worktrees list before the draft gates decide', async () => {
    // Stale mirror: the focus sync last saw the checkout holding `main`…
    useGitPanelStore.getState().setWorktrees([
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: true,
      },
    ])
    // …but `dev` was checked out in the main checkout since (via the
    // switch-mode picker or externally). The open refresh must replace the
    // stale list BEFORE the main-checkout gate reads it.
    const fresh: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'dev', head: 'a2',
        managed: false, pinned: false, is_focus: true,
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(fresh)
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: false, kind: 'local', upstream: '' },
      { name: 'dev', is_current: false, kind: 'local', upstream: '' },
    ])
    useGitPanelStore.getState().openBranchPicker('draft')
    renderPicker()
    await flush()

    expect(useGitPanelStore.getState().worktrees).toEqual(fresh)
    // `dev` is now the main checkout's branch — blocked, focus-independent.
    const devRow = branchRow('dev')!
    expect(devRow.className).toContain('cursor-not-allowed')
    expect(devRow.getAttribute('title')).toContain('main checkout')
    // `main` was freed by the checkout — selectable again.
    const mainRow = branchRow('main')!
    expect(mainRow.className).not.toContain('cursor-not-allowed')
    await act(async () => {
      mainRow.click()
    })
    await flush()
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({
      kind: 'branch',
      branch: 'main',
      createBranch: false,
      startPoint: '',
    })
  })

  it('draft mode: clicking the local checkout worktree row records the local workspace in the draft', async () => {
    // Start from an armed branch draft: the "Local checkout" row must reset
    // the drafted workspace to the project working tree.
    useSessionDraftStore
      .getState()
      .setDraftWorkspace({ kind: 'branch', branch: 'feat/a', createBranch: false, startPoint: '' })
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: true,
      },
      {
        path: '/repo/.worktrees/s-abc12345', name: 's-abc12345', kind: 'managed',
        branch: 'sess/s-abc12345', head: 'b', managed: true, pinned: true,
        is_focus: false, session_id: 'sess-1', session_name: 'Refactor loop',
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    await openDraftPicker()

    const rows = Array.from(body().querySelectorAll<HTMLElement>('[data-testid="worktree-row"]'))
    await act(async () => {
      rows[0]!.click()
    })
    await flush()

    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({ kind: 'local' })
    expect(focusWorktree).not.toHaveBeenCalled()
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
  })

  it('select-remote intent: records a create-branch draft from the remote start point, never checks out', async () => {
    await openDraftPicker()

    const row = branchRow('origin/feat/remote')!
    expect(row).toBeDefined()
    await act(async () => {
      row.click()
    })
    await flush()

    // The draft records the REMOTE-based intent: provision the managed
    // worktree on the local short name, created from the remote-tracking
    // start point (git DWIM at commit — an existing local branch of that
    // name is reused, a missing one is created from the remote ref).
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({
      kind: 'branch',
      branch: 'feat/remote',
      createBranch: true,
      startPoint: 'origin/feat/remote',
    })
    // NO in-place checkout side effect at pick time: no git mutation ran —
    // provisioning happens at draft commit via CreateManagedSession.
    expect(gitMocks.checkoutRemoteBranch).not.toHaveBeenCalled()
    expect(gitMocks.checkoutBranch).not.toHaveBeenCalled()
    expect(gitMocks.createBranch).not.toHaveBeenCalled()
    expect(focusWorktree).not.toHaveBeenCalled()
    // Selection closes the picker.
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
  })

  it('marks the already-picked remote branch without marking local rows', async () => {
    useSessionDraftStore
      .getState()
      .setDraftWorkspace({ kind: 'branch', branch: 'feat/remote', createBranch: true, startPoint: 'origin/feat/remote' })
    await openDraftPicker()

    const remoteRow = branchRow('origin/feat/remote')!
    expect(remoteRow.getAttribute('aria-current')).toBe('true')
    expect(remoteRow.getAttribute('tabindex')).toBe('0')
    // The selected remote row shows a check icon (lucide renders an <svg>).
    expect(remoteRow.querySelector('svg')).not.toBeNull()
    // Local rows are not marked by a remote-based pick.
    expect(branchRow('feat/a')!.getAttribute('aria-current')).toBeNull()
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(true)
  })

  it('disables the remote twin of the main checkout\'s branch — its pick would land a local session', async () => {
    // `origin/main` is the remote twin of the MAIN checkout's branch (`main`):
    // commit-time DWIM would reuse local main, and the holder dispatch would
    // serve the session from the shared checkout instead of a worktree. The
    // gate reads the main checkout from the refreshed worktrees list — the
    // same predicate as the local rows, focus-independent.
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: true,
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
      { name: 'origin/main', is_current: false, kind: 'remote', upstream: '' },
    ])
    useGitPanelStore.getState().openBranchPicker('draft')
    renderPicker()
    await flush()

    const row = branchRow('origin/main')!
    expect(row.className).toContain('cursor-not-allowed')
    // Same reason — and wording — as the local `main` row: the two sections
    // block identically.
    expect(row.getAttribute('title')).toBe(
      'Checked out in the main checkout — pick another branch or use local',
    )
    expect(branchRow('main')!.getAttribute('title')).toBe(
      'Checked out in the main checkout — pick another branch or use local',
    )
    await act(async () => {
      row.click()
    })
    await flush()

    // The draft stays local and the picker stays open (no selection made) —
    // and no in-place checkout-remote ran either.
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({ kind: 'local' })
    expect(gitMocks.checkoutRemoteBranch).not.toHaveBeenCalled()
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(true)
  })

  it('create-new intent: refuses an existing local name with the error banner, records nothing', async () => {
    await openDraftPicker()

    const input = Array.from(body().querySelectorAll<HTMLInputElement>('input')).find((i) => i.placeholder === 'branch-name')!
    act(() => {
      setInputValue(input, 'feat/a')
    })
    const newButton = allButtons().find((b) => b.textContent?.trim() === 'New')!
    await act(async () => {
      newButton.click()
    })
    await flush()

    // The refusal is visible in the dialog's error banner…
    expect(body().textContent).toContain('A branch named "feat/a" already exists')
    // …the draft stays local (no silent DWIM reuse ignoring the base)…
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({ kind: 'local' })
    // …and the picker stays open with the name intact for renaming.
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(true)
    expect(input.value).toBe('feat/a')
  })

  it('switch mode keeps the in-place checkout on remote rows', async () => {
    // Open as the Git panel's Manage-Branches dialog (switch intent).
    useGitPanelStore.getState().openBranchPicker()
    gitMocks.getBranches.mockResolvedValue([
      { name: 'main', is_current: true, kind: 'local', upstream: '' },
      { name: 'origin/feat/remote', is_current: false, kind: 'remote', upstream: '' },
    ])
    gitMocks.checkoutRemoteBranch.mockResolvedValue(undefined)
    renderPicker()
    await flush()

    const row = branchRow('origin/feat/remote')!
    await act(async () => {
      row.click()
    })
    await flush()

    // Remote-row click stays checkout-remote in switch mode — the armed
    // draft is untouched (still the default local workspace) and no
    // branch selection was recorded.
    expect(gitMocks.checkoutRemoteBranch).toHaveBeenCalledWith('origin/feat/remote')
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({ kind: 'local' })
  })

  it('deleting a worktree from the draft picker runs the confirmed removal without touching the draft', async () => {
    const worktrees: GitWorktree[] = [
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: false,
      },
      {
        path: '/repo/.worktrees/s-stale000', name: 's-stale000', kind: 'managed',
        branch: 'sess/s-stale000', head: 'b', managed: true, pinned: true,
        is_focus: false, session_id: 'sess-1', session_name: 'Stale loop',
      },
    ]
    gitMocks.listProjectWorktrees.mockResolvedValue(worktrees)
    useGitPanelStore.getState().setWorktrees(worktrees)
    await openDraftPicker()
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({ kind: 'local' })

    const rows = Array.from(body().querySelectorAll('[data-testid="worktree-row"]'))
    // The checkout has no delete action; the linked tree does.
    expect(rows[0]!.querySelectorAll('button')).toHaveLength(0)
    act(() => {
      rows[1]!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(body().textContent).toContain('Delete worktree?')
    act(() => {
      const del = allButtons().find((b) => b.textContent?.trim() === 'Delete')!
      del.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.deleteWorktree).toHaveBeenCalledWith('/repo/.worktrees/s-stale000', {
      force: false,
      unlock: false,
    })
    expect(focusMocks.refreshGitFocus).toHaveBeenCalledTimes(1)
    // The draft is untouched by the deletion.
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({ kind: 'local' })
  })

  it('closing the picker resets the mode — the next Git-panel open is a switch intent', async () => {
    await openDraftPicker()
    act(() => {
      useGitPanelStore.getState().closeBranchPicker()
    })
    // Radix settles the dialog's exit asynchronously — flush inside act so
    // the deferred state update is not an unwrapped act warning.
    await flush()
    expect(useGitPanelStore.getState().branchPickerMode).toBe('switch')

    act(() => {
      useGitPanelStore.getState().openBranchPicker()
    })
    await flush()
    expect(useGitPanelStore.getState().branchPickerMode).toBe('switch')
  })
})
