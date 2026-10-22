// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// --- Mock the git API wrappers so tests never touch the Wails backend ---
const { gitMocks } = vi.hoisted(() => ({
  gitMocks: {
    createBranch: vi.fn(),
    createBranchInWorktree: vi.fn(),
    getBranchBases: vi.fn(),
  },
}))

vi.mock('@/api/git', () => gitMocks)

// The focus refresh is mocked: the worktree path calls it after success (the
// focus itself must never move).
const { focusMocks } = vi.hoisted(() => ({
  focusMocks: {
    focusWorktree: vi.fn(),
    refreshGitFocus: vi.fn(),
  },
}))

vi.mock('@/lib/gitFocus', () => focusMocks)

// Intercepted at the source: a failed creation is logged by the component.
const { loggerMocks } = vi.hoisted(() => ({
  loggerMocks: { error: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({ logger: loggerMocks }))

import { NewBranchSection } from './NewBranchSection'

type SectionProps = ComponentProps<typeof NewBranchSection>

let container: HTMLDivElement
let root: Root

function makeProps(overrides: Partial<SectionProps> = {}): SectionProps {
  return {
    disabled: false,
    currentBranch: 'main',
    onClearError: vi.fn(),
    onError: vi.fn(),
    onCreated: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  gitMocks.createBranch.mockReset()
  gitMocks.createBranchInWorktree.mockReset()
  gitMocks.getBranchBases.mockReset()
  gitMocks.createBranch.mockResolvedValue(undefined)
  gitMocks.createBranchInWorktree.mockResolvedValue(undefined)
  focusMocks.focusWorktree.mockReset()
  focusMocks.focusWorktree.mockResolvedValue(undefined)
  focusMocks.refreshGitFocus.mockReset()
  focusMocks.refreshGitFocus.mockResolvedValue(undefined)
  loggerMocks.error.mockReset()

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

function renderSection(props: SectionProps) {
  act(() => {
    root.render(<NewBranchSection {...props} />)
  })
}

/** Set a controlled input's value in a way React detects (native setter + event). */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function nameInput(): HTMLInputElement {
  return container.querySelector('input[placeholder="branch-name"]') as HTMLInputElement
}

function worktreeCheckbox(): HTMLInputElement {
  return container.querySelector('input[type="checkbox"]') as HTMLInputElement
}

function allButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

async function typeAndSubmit(name: string) {
  await act(async () => {
    setInputValue(nameInput(), name)
  })
  const newBtn = allButtons().find((b) => b.textContent?.includes('New'))!
  await act(async () => {
    newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('NewBranchSection — Worktree checkbox', () => {
  it('renders the Worktree checkbox unchecked and enabled in switch mode', () => {
    renderSection(makeProps())

    const box = worktreeCheckbox()
    expect(box).not.toBeNull()
    expect(box.checked).toBe(false)
    expect(box.disabled).toBe(false)
  })

  it('creates in place by default: createBranch runs, no worktree RPC, no focus refresh', async () => {
    const onCreated = vi.fn()
    renderSection(makeProps({ onCreated }))
    await typeAndSubmit('feat/a')

    expect(gitMocks.createBranch).toHaveBeenCalledWith('feat/a', '')
    expect(gitMocks.createBranchInWorktree).not.toHaveBeenCalled()
    expect(focusMocks.refreshGitFocus).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledTimes(1)
    // The name field is cleared after a successful creation.
    expect(nameInput().value).toBe('')
  })

  it('with the checkbox on, creation routes through createBranchInWorktree and refreshes the focus', async () => {
    const onCreated = vi.fn()
    renderSection(makeProps({ onCreated }))

    // The user opts into a worktree.
    act(() => {
      worktreeCheckbox().click()
    })

    await typeAndSubmit('feat/wt')

    expect(gitMocks.createBranchInWorktree).toHaveBeenCalledWith('feat/wt', '')
    expect(gitMocks.createBranch).not.toHaveBeenCalled()
    // The new tree is pulled into the worktree list — the focus itself never
    // switches (AC: the panel stays where it is after creation).
    expect(focusMocks.refreshGitFocus).toHaveBeenCalledTimes(1)
    expect(focusMocks.focusWorktree).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledTimes(1)
  })

  it('passes the selected base to createBranchInWorktree', async () => {
    gitMocks.getBranchBases.mockResolvedValue([
      { ref: 'develop', label: 'develop', type: 'local', detail: '' },
      { ref: 'origin/main', label: 'origin/main', type: 'remote', detail: '' },
    ])
    renderSection(makeProps())

    // Tick the worktree checkbox first.
    act(() => {
      worktreeCheckbox().click()
    })

    // Expand the "Choose base" collapsible (bases load lazily).
    const baseTrigger = allButtons().find((b) => b.textContent?.includes('Choose base'))!
    await act(async () => {
      baseTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // Select the 'develop' base.
    const devBaseBtn = allButtons().find((b) => b.textContent?.includes('develop'))!
    act(() => {
      devBaseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await typeAndSubmit('feat/from-dev')

    expect(gitMocks.createBranchInWorktree).toHaveBeenCalledWith('feat/from-dev', 'develop')
  })

  it('toggling the checkbox clears the shared error banner', async () => {
    const onClearError = vi.fn()
    renderSection(makeProps({ onClearError }))

    act(() => {
      worktreeCheckbox().click()
    })

    expect(onClearError).toHaveBeenCalled()
  })
})

describe('NewBranchSection — draft mode (ADR-080)', () => {
  it('renders the Worktree checkbox disabled with the session-worktree tooltip', () => {
    renderSection(makeProps({ onDraftCreate: vi.fn() }))

    const box = worktreeCheckbox()
    expect(box.disabled).toBe(true)
    // A drafted session always provisions its own worktree — the checkbox is
    // inert, and the label explains why on hover.
    const label = box.closest('label')!
    expect(label.getAttribute('title')).toBe('The session always gets its own worktree')
  })

  it('submitting records the draft choice and never runs a git RPC', async () => {
    const onDraftCreate = vi.fn()
    const onCreated = vi.fn()
    renderSection(makeProps({ onDraftCreate, onCreated }))
    await typeAndSubmit('feat/draft')

    expect(onDraftCreate).toHaveBeenCalledWith('feat/draft', '')
    expect(gitMocks.createBranch).not.toHaveBeenCalled()
    expect(gitMocks.createBranchInWorktree).not.toHaveBeenCalled()
    expect(focusMocks.refreshGitFocus).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledTimes(1)
  })

  it('draft submission ignores the (disabled) checkbox state', async () => {
    const onDraftCreate = vi.fn()
    renderSection(makeProps({ onDraftCreate }))

    const box = worktreeCheckbox()
    expect(box.checked).toBe(false)

    await typeAndSubmit('feat/draft2')

    // The recorded branch intent is created inside the session's managed
    // worktree by the FIRST SEND's provisioning — no worktree flag is needed
    // at pick time.
    expect(onDraftCreate).toHaveBeenCalledWith('feat/draft2', '')
  })

  it('refuses a submit naming an existing local branch instead of recording a DWIM-reuse draft', async () => {
    const onDraftCreate = vi.fn()
    const onCreated = vi.fn()
    const onError = vi.fn()
    renderSection(makeProps({ onDraftCreate, onCreated, onError, existingLocalBranches: ['feat/x', 'main'] }))

    await typeAndSubmit('feat/x')

    // The refusal surfaces in the picker's shared error banner; no draft is
    // recorded (commit-time DWIM would silently reuse the branch and ignore
    // the chosen base), the success path does not run, and the typed name
    // stays in the field for renaming.
    expect(onError).toHaveBeenCalledWith(
      'A branch named "feat/x" already exists — pick it from the list or choose another name',
    )
    expect(onDraftCreate).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
    expect(gitMocks.createBranch).not.toHaveBeenCalled()
    expect(nameInput().value).toBe('feat/x')
  })

  it('refuses the current branch\'s name in the create form too (it already exists)', async () => {
    const onDraftCreate = vi.fn()
    renderSection(makeProps({ onDraftCreate, existingLocalBranches: ['main'] }))

    await typeAndSubmit('main')

    expect(onDraftCreate).not.toHaveBeenCalled()
  })

  it('records the draft for a fresh name even when the existing-branches list is set', async () => {
    const onDraftCreate = vi.fn()
    renderSection(makeProps({ onDraftCreate, existingLocalBranches: ['feat/x', 'main'] }))

    await typeAndSubmit('feat/fresh')

    expect(onDraftCreate).toHaveBeenCalledWith('feat/fresh', '')
  })
})

describe('NewBranchSection — failures', () => {
  it('surfaces a worktree-creation failure via onError and logs it', async () => {
    gitMocks.createBranchInWorktree.mockRejectedValue(
      new Error('branch "feat/wt" already exists'),
    )
    const onError = vi.fn()
    const onCreated = vi.fn()
    renderSection(makeProps({ onError, onCreated }))

    act(() => {
      worktreeCheckbox().click()
    })
    await typeAndSubmit('feat/wt')

    expect(onError).toHaveBeenCalledWith('branch "feat/wt" already exists')
    expect(loggerMocks.error).toHaveBeenCalledTimes(1)
    // A failed creation keeps the picker open and the name intact.
    expect(onCreated).not.toHaveBeenCalled()
    expect(nameInput().value).toBe('feat/wt')
  })
})

describe('NewBranchSection — managed-focus gate (disabledReason, ADR-080)', () => {
  // Handed down by BranchPicker while the Git panel's focus rests on a
  // managed session tree: in-place creation (CreateBranch) moves the focused
  // tree off its pin and is refused server-side; the Worktree path is not.
  const reason = 'Branch switching is disabled while focused on a session worktree'

  function newButton(): HTMLButtonElement {
    return allButtons().find((b) => b.textContent?.includes('New'))!
  }

  it('disables the in-place submit with the refusal reason as its tooltip', () => {
    renderSection(makeProps({ disabledReason: reason }))

    const btn = newButton()
    // Even with a typed name the button stays disabled.
    act(() => {
      setInputValue(nameInput(), 'feat/a')
    })
    expect(btn.disabled).toBe(true)
    expect(btn.title).toBe(reason)
  })

  it('blocks the submit and the Enter path — no CreateBranch call goes out', async () => {
    renderSection(makeProps({ disabledReason: reason }))

    await typeAndSubmit('feat/a')

    expect(gitMocks.createBranch).not.toHaveBeenCalled()
    expect(gitMocks.createBranchInWorktree).not.toHaveBeenCalled()
  })

  it('the Worktree path stays available: ticking the checkbox un-blocks the button', async () => {
    const onCreated = vi.fn()
    renderSection(makeProps({ disabledReason: reason, onCreated }))

    act(() => {
      worktreeCheckbox().click()
    })

    // The checkbox re-enables the submit — creating in a fresh tree never
    // touches the focused one.
    const btn = newButton()
    act(() => {
      setInputValue(nameInput(), 'feat/wt')
    })
    expect(btn.disabled).toBe(false)
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(gitMocks.createBranchInWorktree).toHaveBeenCalledWith('feat/wt', '')
    expect(gitMocks.createBranch).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledTimes(1)
    // The tooltip is back to the worktree-path wording, not the refusal.
    expect(btn.title).toBe('Create the branch in a new worktree (the current checkout stays untouched)')
  })

  it('draft mode ignores the gate: the reason is never passed and the draft records', async () => {
    const onDraftCreate = vi.fn()
    // BranchPicker drops disabledReason in draft mode — assert the section
    // itself keeps working when a (dropped) reason is absent.
    renderSection(makeProps({ onDraftCreate }))
    await typeAndSubmit('feat/draft')

    expect(onDraftCreate).toHaveBeenCalledWith('feat/draft', '')
    expect(gitMocks.createBranch).not.toHaveBeenCalled()
  })
})
