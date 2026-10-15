// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'

// --- Mock the git API wrappers so tests never touch the Wails backend ---
const { gitMocks } = vi.hoisted(() => ({
  gitMocks: {
    checkoutBranch: vi.fn(),
    renameBranch: vi.fn(),
    deleteBranch: vi.fn(),
    merge: vi.fn(),
    rebase: vi.fn(),
    pushBranch: vi.fn(),
    checkoutRemoteBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    deleteWorktree: vi.fn(),
  },
}))

vi.mock('@/api/git', () => gitMocks)
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

// Focus actions (worktree switching) are mocked so tests never touch the backend.
const { focusMocks } = vi.hoisted(() => ({
  focusMocks: {
    focusWorktree: vi.fn(),
    refreshGitFocus: vi.fn(),
  },
}))

vi.mock('@/lib/gitFocus', () => focusMocks)

import { BranchDropdown } from './BranchDropdown'
import { focusWorktree } from '@/lib/gitFocus'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useProjectStore } from '@/stores/projectStore'
import type { Branch } from '@/types/models'

let container: HTMLDivElement
let root: Root

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return { name: 'feature/x', is_current: false, kind: 'local', upstream: '', ...overrides }
}

beforeEach(() => {
  Object.values(gitMocks).forEach((m) => m.mockReset())
  gitMocks.checkoutBranch.mockResolvedValue(undefined)
  gitMocks.renameBranch.mockResolvedValue(undefined)
  gitMocks.deleteBranch.mockResolvedValue(undefined)
  gitMocks.merge.mockResolvedValue(undefined)
  gitMocks.rebase.mockResolvedValue(undefined)
  gitMocks.pushBranch.mockResolvedValue('pushed')
  gitMocks.checkoutRemoteBranch.mockResolvedValue(undefined)
  gitMocks.deleteRemoteBranch.mockResolvedValue('deleted')
  gitMocks.deleteWorktree.mockResolvedValue(undefined)

  useGitPanelStore.getState().reset()
  // Branch operations record their outcome against the ACTIVE project.
  useProjectStore.setState({ activeProjectId: 'p1' })
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
  document.body.innerHTML = ''
})

function body(): HTMLElement {
  return document.body
}

/** The trigger button lives in the mount container (before open it is the only button). */
function trigger(): HTMLButtonElement {
  return container.querySelector('button') as HTMLButtonElement
}

function renderDropdown() {
  act(() => {
    root.render(
      <TooltipProvider>
        <BranchDropdown />
      </TooltipProvider>,
    )
  })
}

/** Flush microtasks so portaled content (dropdown / dialog) mounts and async actions settle. */
function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function openDropdown() {
  act(() => {
    trigger().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  })
  await flush()
}

function isMenuOpen(): boolean {
  return body().querySelector('[data-slot="dropdown-menu-content"]') !== null
}

/** A branch row is a div[role=button] containing the given name. */
function rowByName(name: string): HTMLElement {
  return Array.from(body().querySelectorAll('div[role="button"]')).find((el) =>
    (el.textContent ?? '').includes(name),
  ) as HTMLElement
}

/** The action buttons inside a row (hover mini-icons). */
function rowButtons(row: HTMLElement): HTMLButtonElement[] {
  return Array.from(row.querySelectorAll('button'))
}

function menuItem(text: string): HTMLElement {
  return Array.from(body().querySelectorAll('[data-slot="dropdown-menu-item"]')).find((el) =>
    (el.textContent ?? '').includes(text),
  ) as HTMLElement
}

function dialogButton(text: string): HTMLButtonElement {
  return Array.from(body().querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === text,
  ) as HTMLButtonElement
}

/** Set a controlled input's value in a way React detects (native setter + event). */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('BranchDropdown', () => {
  it('renders the current branch name in the trigger', () => {
    renderDropdown()
    expect(container.textContent).toContain('main')
  })

  it('opens the dropdown on pointerdown and lists local + remote groups', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/x' }),
      makeBranch({ name: 'origin/feature/x', kind: 'remote' }),
    ])
    renderDropdown()
    expect(isMenuOpen()).toBe(false)

    await openDropdown()

    expect(isMenuOpen()).toBe(true)
    expect(body().textContent).toContain('Local')
    expect(body().textContent).toContain('Remote')
    expect(body().textContent).toContain('feature/x')
    expect(body().textContent).toContain('origin/feature/x')
  })

  it('hides the search input when there are fewer than 5 branches', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'a' }),
      makeBranch({ name: 'b' }),
      makeBranch({ name: 'c' }),
    ])
    renderDropdown()
    await openDropdown()
    expect(body().querySelector('input[placeholder="Search branches..."]')).toBeNull()
  })

  it('shows the search input when there are 5+ branches', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'a' }),
      makeBranch({ name: 'b' }),
      makeBranch({ name: 'c' }),
      makeBranch({ name: 'd' }),
    ])
    renderDropdown()
    await openDropdown()
    expect(body().querySelector('input[placeholder="Search branches..."]')).not.toBeNull()
  })

  it('filters branches by the search input', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/auth' }),
      makeBranch({ name: 'feature/api' }),
      makeBranch({ name: 'bugfix/1' }),
      makeBranch({ name: 'bugfix/2' }),
    ])
    renderDropdown()
    await openDropdown()

    const input = body().querySelector('input[placeholder="Search branches..."]') as HTMLInputElement
    act(() => setInputValue(input, 'feature'))

    expect(body().textContent).toContain('feature/auth')
    expect(body().textContent).toContain('feature/api')
    expect(body().textContent).not.toContain('bugfix/1')
  })

  it('keeps the search input focused when a keystroke matches a branch row', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/auth' }),
      makeBranch({ name: 'feature/api' }),
      makeBranch({ name: 'bugfix/1' }),
      makeBranch({ name: 'bugfix/2' }),
    ])
    renderDropdown()
    await openDropdown()

    const input = body().querySelector('input[placeholder="Search branches..."]') as HTMLInputElement
    act(() => {
      input.focus()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))
    })
    // Radix's typeahead focuses its match from a setTimeout(0) — let it fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Branch rows are plain role=button divs (the menu holds no Radix items
    // today), so the typeahead has nothing to steal with — but the input is a
    // MenuSearchInput so this holds even if menu items are ever added.
    expect(document.activeElement).toBe(input)
  })

  it('checks out a local branch on click and closes the dropdown', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/x' }),
    ])
    renderDropdown()
    await openDropdown()

    act(() => {
      rowByName('feature/x').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.checkoutBranch).toHaveBeenCalledWith('feature/x')
    expect(isMenuOpen()).toBe(false)
    // The outcome is recorded in the operation console slice.
    expect(useGitPanelStore.getState().operationByProject['p1']).toMatchObject({
      kind: 'checkout',
      ok: true,
    })
  })

  it('does not checkout the current branch', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
    ])
    renderDropdown()
    await openDropdown()

    act(() => {
      rowByName('main').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(gitMocks.checkoutBranch).not.toHaveBeenCalled()
  })

  it('wires the push action', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/x' }),
    ])
    renderDropdown()
    await openDropdown()

    const row = rowByName('feature/x')
    act(() => {
      rowButtons(row)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.pushBranch).toHaveBeenCalledWith('feature/x')
    expect(gitMocks.checkoutBranch).not.toHaveBeenCalled()
  })

  it('wires the merge action', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/x' }),
    ])
    renderDropdown()
    await openDropdown()

    const row = rowByName('feature/x')
    act(() => {
      rowButtons(row)[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.merge).toHaveBeenCalledWith('feature/x')
  })

  it('wires the rebase action', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/x' }),
    ])
    renderDropdown()
    await openDropdown()

    const row = rowByName('feature/x')
    act(() => {
      rowButtons(row)[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.rebase).toHaveBeenCalledWith('feature/x')
  })

  it('switches to an inline rename input', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/x' }),
    ])
    renderDropdown()
    await openDropdown()

    const row = rowByName('feature/x')
    act(() => {
      rowButtons(row)[3]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(isMenuOpen()).toBe(false)
    const input = container.querySelector('input') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe('feature/x')
  })

  it('opens the delete confirm dialog for a local branch', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/x' }),
    ])
    renderDropdown()
    await openDropdown()

    const row = rowByName('feature/x')
    act(() => {
      rowButtons(row)[4]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(body().textContent).toContain('Delete branch?')

    act(() => {
      dialogButton('Delete').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.deleteBranch).toHaveBeenCalledWith('feature/x', false)
  })

  it('checks out a remote branch as local on click', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'origin/feature/x', kind: 'remote' }),
    ])
    renderDropdown()
    await openDropdown()

    act(() => {
      rowByName('origin/feature/x').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.checkoutRemoteBranch).toHaveBeenCalledWith('origin/feature/x')
    expect(isMenuOpen()).toBe(false)
  })

  it('opens the delete confirm dialog for a remote branch', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'origin/feature/x', kind: 'remote' }),
    ])
    renderDropdown()
    await openDropdown()

    const row = rowByName('origin/feature/x')
    act(() => {
      rowButtons(row)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(body().textContent).toContain('Delete remote branch?')

    act(() => {
      dialogButton('Delete').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.deleteRemoteBranch).toHaveBeenCalledWith('feature/x', 'origin')
  })

  it('does not render the New branch.../Manage branches... footer items', async () => {
    // The footer entries duplicated the git panel toolbar's "Manage branches"
    // button (the only picker opener) and were removed.
    renderDropdown()
    await openDropdown()

    expect(menuItem('New branch...')).toBeUndefined()
    expect(menuItem('Manage branches...')).toBeUndefined()
    // Branch creation lives in the BranchPicker modal — the dropdown never
    // opens it itself.
    expect(useGitPanelStore.getState().isBranchPickerOpen).toBe(false)
  })
})

describe('BranchDropdown — worktree focus switcher', () => {
  beforeEach(() => {
    focusMocks.focusWorktree.mockReset()
    focusMocks.focusWorktree.mockResolvedValue(undefined)
    focusMocks.refreshGitFocus.mockReset()
    focusMocks.refreshGitFocus.mockResolvedValue(undefined)
  })

  it('hides the Worktrees section when the project has no worktrees', async () => {
    useGitPanelStore.getState().setWorktrees([])
    renderDropdown()
    await openDropdown()

    expect(Array.from(body().querySelectorAll('[data-testid="worktree-row"]'))).toHaveLength(0)
    expect(body().textContent).not.toContain('Worktrees')
  })

  it('lists every worktree and switches the panel focus on selection', async () => {
    useGitPanelStore.getState().setWorktrees([
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: true,
      },
      {
        path: '/repo/.worktrees/s-abc12345', name: 's-abc12345', kind: 'managed',
        branch: 'sess/s-abc12345', head: 'b', managed: true, pinned: false,
        is_focus: false, session_id: 'sess-1', session_name: 'Refactor loop',
      },
    ])
    renderDropdown()
    await openDropdown()

    const rows = Array.from(body().querySelectorAll('[data-testid="worktree-row"]'))
    expect(rows).toHaveLength(2)
    expect(body().textContent).toContain('Worktrees')
    expect(body().textContent).toContain('Local checkout')
    expect(body().textContent).toContain('Refactor loop')

    act(() => {
      rows[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(focusWorktree).toHaveBeenCalledTimes(1)
    expect(focusWorktree).toHaveBeenCalledWith('/repo/.worktrees/s-abc12345')
    // Selecting a worktree closes the dropdown.
    expect(isMenuOpen()).toBe(false)
  })

  it('exposes the delete action on the linked tree but never on the checkout', async () => {
    useGitPanelStore.getState().setWorktrees([
      {
        path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a',
        managed: false, pinned: false, is_focus: false,
      },
      {
        path: '/repo/.worktrees/s-abc12345', name: 's-abc12345', kind: 'managed',
        branch: 'sess/s-abc12345', head: 'b', managed: true, pinned: false,
        is_focus: false,
      },
    ])
    renderDropdown()
    await openDropdown()

    const rows = Array.from(body().querySelectorAll('[data-testid="worktree-row"]'))
    expect(rows).toHaveLength(2)
    // The checkout row has no hover actions; the linked tree has one.
    expect(rowButtons(rows[0] as HTMLElement)).toHaveLength(0)
    expect(rowButtons(rows[1] as HTMLElement)).toHaveLength(1)
  })

  it('opens the delete confirm dialog on the row action without switching the focus', async () => {
    useGitPanelStore.getState().setWorktrees([
      {
        path: '/repo/.worktrees/s-abc12345', name: 's-abc12345', kind: 'managed',
        branch: 'sess/s-abc12345', head: 'b', managed: true, pinned: false,
        is_focus: false,
      },
    ])
    renderDropdown()
    await openDropdown()

    const row = body().querySelector('[data-testid="worktree-row"]') as HTMLElement
    act(() => {
      rowButtons(row)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    // The delete click must never double as a focus switch.
    expect(focusWorktree).not.toHaveBeenCalled()
    expect(body().textContent).toContain('Delete worktree?')

    act(() => {
      dialogButton('Delete').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.deleteWorktree).toHaveBeenCalledWith('/repo/.worktrees/s-abc12345', {
      force: false,
      unlock: false,
    })
    // Success refreshes the worktree list + focus mirror.
    expect(focusMocks.refreshGitFocus).toHaveBeenCalledTimes(1)
  })

  it('shows the unlock consent in the dialog for a locked tree', async () => {
    useGitPanelStore.getState().setWorktrees([
      {
        path: '/repo/.worktrees/s-abc12345', name: 's-abc12345', kind: 'managed',
        branch: 'sess/s-abc12345', head: 'b', managed: true, pinned: false,
        is_focus: false, locked: true,
      },
    ])
    renderDropdown()
    await openDropdown()

    const row = body().querySelector('[data-testid="worktree-row"]') as HTMLElement
    act(() => {
      rowButtons(row)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const box = body().querySelector('[data-testid="worktree-unlock-checkbox"]') as HTMLInputElement
    expect(box).toBeTruthy()
    expect(box.checked).toBe(false)

    act(() => {
      box.click()
    })
    act(() => {
      dialogButton('Delete').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.deleteWorktree).toHaveBeenCalledWith('/repo/.worktrees/s-abc12345', {
      force: false,
      unlock: true,
    })
  })

  it('shows the backend refusal in the dialog for a failed deletion', async () => {
    gitMocks.deleteWorktree.mockRejectedValue(
      new Error('worktree has uncommitted changes: M frontend/src/api/git.ts'),
    )
    // The failure is recorded against the ACTIVE project's console.
    useGitPanelStore.getState().setWorktrees([
      {
        path: '/repo/.worktrees/s-abc12345', name: 's-abc12345', kind: 'managed',
        branch: 'sess/s-abc12345', head: 'b', managed: true, pinned: false,
        is_focus: false,
      },
    ])
    renderDropdown()
    await openDropdown()

    const row = body().querySelector('[data-testid="worktree-row"]') as HTMLElement
    act(() => {
      rowButtons(row)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    act(() => {
      dialogButton('Delete').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    // The refusal re-opens the dialog with the verbatim reason + force hint;
    // the outcome is recorded in the operation console.
    expect(body().textContent).toContain('worktree has uncommitted changes')
    expect(body().textContent).toContain('Force delete discards the uncommitted changes.')
    expect(focusMocks.refreshGitFocus).not.toHaveBeenCalled()
    expect(useGitPanelStore.getState().operationByProject['p1']).toMatchObject({
      kind: 'worktree-delete',
      ok: false,
    })

    // Retrying with Force discards the dirty tree.
    gitMocks.deleteWorktree.mockResolvedValue(undefined)
    act(() => {
      dialogButton('Force delete').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(gitMocks.deleteWorktree).toHaveBeenLastCalledWith('/repo/.worktrees/s-abc12345', {
      force: true,
      unlock: false,
    })
    expect(body().textContent).not.toContain('Delete worktree?')
    expect(focusMocks.refreshGitFocus).toHaveBeenCalledTimes(1)
  })
})

describe('BranchDropdown — collapsible sections', () => {
  /** Section header button — found by its exact label. */
  function sectionHeader(label: string): HTMLButtonElement {
    const btn = Array.from(body().querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === label,
    )
    expect(btn, `section header "${label}"`).toBeTruthy()
    return btn as HTMLButtonElement
  }

  function clickHeader(label: string) {
    act(() => {
      sectionHeader(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    return flush()
  }

  // Local and remote names must not be substrings of each other — the
  // section tests assert on absence via textContent.
  const localAndRemote = () =>
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/x' }),
      makeBranch({ name: 'origin/feature/y', kind: 'remote' }),
    ])

  it('renders section headers in the combo style with a chevron and hover affordance', async () => {
    localAndRemote()
    renderDropdown()
    await openDropdown()

    for (const label of ['Local', 'Remote']) {
      const btn = sectionHeader(label)
      expect(btn.className).toContain('uppercase')
      expect(btn.className).toContain('font-semibold')
      expect(btn.className).toContain('text-xs')
      expect(btn.className).toContain('hover:bg-muted')
      expect(btn.querySelector('svg.lucide-chevron-down')).not.toBeNull()
    }
  })

  it('section headers expose aria-expanded and name their live content region', async () => {
    localAndRemote()
    renderDropdown()
    await openDropdown()

    const local = sectionHeader('Local')
    expect(local.getAttribute('aria-expanded')).toBe('true')
    const regionId = local.getAttribute('aria-controls')!
    expect(regionId).toBeTruthy()
    expect(document.getElementById(regionId)?.textContent).toContain('feature/x')

    // Collapsing flips the state and unmounts the region it named.
    await clickHeader('Local')
    expect(sectionHeader('Local').getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(regionId)).toBeNull()
  })

  it('collapses the Local section without closing the menu; the Remote section is untouched', async () => {
    localAndRemote()
    renderDropdown()
    await openDropdown()

    await clickHeader('Local')
    expect(isMenuOpen()).toBe(true)
    expect(body().textContent).not.toContain('feature/x')
    expect(body().textContent).toContain('origin/feature/y')
    // The collapsed section keeps its header so it can be re-expanded.
    expect(body().textContent).toContain('Local')

    await clickHeader('Local')
    expect(body().textContent).toContain('feature/x')
  })

  it('collapses the Remote section and re-expands it', async () => {
    localAndRemote()
    renderDropdown()
    await openDropdown()

    await clickHeader('Remote')
    expect(isMenuOpen()).toBe(true)
    expect(body().textContent).not.toContain('origin/feature/y')
    expect(body().textContent).toContain('feature/x')

    await clickHeader('Remote')
    expect(body().textContent).toContain('origin/feature/y')
  })

  it('collapses the Worktrees section and re-expands it', async () => {
    localAndRemote()
    useGitPanelStore.getState().setWorktrees([
      { path: '/repo', name: 'repo', kind: 'main', branch: 'main', head: 'a', managed: false, pinned: false, is_focus: true },
      {
        path: '/repo/.worktrees/s-abc', name: 's-abc', kind: 'managed',
        branch: 'sess/s-abc', head: 'b', managed: true, pinned: false, is_focus: false,
      },
    ])
    renderDropdown()
    await openDropdown()

    expect(body().querySelector('[data-testid="worktree-row"]')).not.toBeNull()

    await clickHeader('Worktrees')
    expect(isMenuOpen()).toBe(true)
    expect(body().querySelector('[data-testid="worktree-row"]')).toBeNull()
    expect(body().textContent).toContain('Worktrees')

    await clickHeader('Worktrees')
    expect(body().querySelector('[data-testid="worktree-row"]')).not.toBeNull()
  })

  it('an active search force-expands a collapsed section; clearing restores it', async () => {
    useGitPanelStore.getState().setBranches([
      makeBranch({ name: 'main', is_current: true }),
      makeBranch({ name: 'feature/x' }),
      makeBranch({ name: 'feature/api' }),
      makeBranch({ name: 'bugfix/1' }),
      makeBranch({ name: 'bugfix/2' }),
    ])
    renderDropdown()
    await openDropdown()

    await clickHeader('Local')
    expect(body().textContent).not.toContain('feature/x')

    const input = body().querySelector('input[placeholder="Search branches..."]') as HTMLInputElement
    act(() => setInputValue(input, 'feature'))
    await flush()
    expect(body().textContent).toContain('feature/x')
    expect(body().textContent).not.toContain('bugfix/1')

    act(() => setInputValue(input, ''))
    await flush()
    expect(body().textContent).not.toContain('feature/x')
  })
})
