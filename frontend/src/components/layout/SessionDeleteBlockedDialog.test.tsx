// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SessionDeleteBlockedDialog } from './SessionDeleteBlockedDialog'
import type { BlockedSessionDelete } from '@/hooks/useSessionActions'
import type { SessionDeleteOptionsUI } from '@/types/api'

let onConfirm: (options: SessionDeleteOptionsUI) => void
let onCancel: () => void
let root: Root
let container: HTMLDivElement

function makeBlocked(overrides: Partial<BlockedSessionDelete> = {}): BlockedSessionDelete {
  return {
    sessionIds: ['s-abc12345'],
    sessionName: 'my session',
    reason: 'worktree has uncommitted changes: "s-abc12345" (branch main)',
    option: 'confirm_uncommitted_loss',
    ...overrides,
  }
}

function renderBlocked(blocked: BlockedSessionDelete | null, error: string | null = null): void {
  act(() => {
    root.render(
      <SessionDeleteBlockedDialog blocked={blocked} error={error} onConfirm={onConfirm} onCancel={onCancel} />,
    )
  })
}

// Radix Dialog portals content into document.body.
function allButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll('button'))
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return allButtons().find((b) => b.textContent?.includes(text))
}

function checkbox(testid: string): HTMLInputElement {
  return document.body.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement
}

beforeEach(() => {
  onConfirm = vi.fn<(options: SessionDeleteOptionsUI) => void>()
  onCancel = vi.fn<() => void>()
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

describe('SessionDeleteBlockedDialog', () => {
  it('renders nothing when nothing is parked', () => {
    renderBlocked(null)
    expect(document.body.textContent).not.toContain('Session deletion blocked')
    expect(allButtons().length).toBe(0)
  })

  it('names the session, explains the refusal and shows the verbatim reason', () => {
    renderBlocked(makeBlocked())
    expect(document.body.textContent).toContain('Session deletion blocked')
    expect(document.body.textContent).toContain('"my session"')
    expect(document.body.textContent).toContain('the git branch is kept.')
    expect(document.body.textContent).toContain(
      'worktree has uncommitted changes: "s-abc12345" (branch main)',
    )
  })

  it('uses branch-named count-aware copy for a multi-session park', () => {
    renderBlocked(
      makeBlocked({ sessionIds: ['s-1', 's-2', 's-3'], sessionName: 'feature-x' }),
    )
    expect(document.body.textContent).toContain('Branch "feature-x" groups 3 sessions.')
    expect(document.body.textContent).not.toContain('"feature-x" has')
  })

  it('offers both consents and pre-ticks the demanded one (uncommitted loss)', () => {
    renderBlocked(makeBlocked({ option: 'confirm_uncommitted_loss' }))
    expect(checkbox('session-delete-discard-checkbox').checked).toBe(true)
    expect(checkbox('session-delete-unlock-checkbox').checked).toBe(false)
  })

  it('pre-ticks the unlock consent when the refusal names it', () => {
    renderBlocked(makeBlocked({ option: 'unlock_locked_tree' }))
    expect(checkbox('session-delete-unlock-checkbox').checked).toBe(true)
    expect(checkbox('session-delete-discard-checkbox').checked).toBe(false)
  })

  it('confirm passes exactly the ticked decisions', () => {
    renderBlocked(makeBlocked({ option: 'confirm_uncommitted_loss' }))
    act(() => {
      buttonByText('Delete')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onConfirm).toHaveBeenCalledWith({ confirmUncommittedLoss: true, unlockLockedTree: false })
  })

  it('confirm carries a manually ticked unlock consent too', () => {
    renderBlocked(makeBlocked({ option: 'confirm_uncommitted_loss' }))
    act(() => {
      checkbox('session-delete-unlock-checkbox').click()
    })
    act(() => {
      buttonByText('Delete')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onConfirm).toHaveBeenCalledWith({ confirmUncommittedLoss: true, unlockLockedTree: true })
  })

  it('unticking the pre-checked consent confirms nothing implicitly', () => {
    renderBlocked(makeBlocked({ option: 'unlock_locked_tree' }))
    act(() => {
      checkbox('session-delete-unlock-checkbox').click()
    })
    act(() => {
      buttonByText('Delete')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onConfirm).toHaveBeenCalledWith({ confirmUncommittedLoss: false, unlockLockedTree: false })
  })

  it('cancel dismisses without confirming', () => {
    renderBlocked(makeBlocked())
    act(() => {
      buttonByText('Cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('shows the last retry failure inline', () => {
    renderBlocked(makeBlocked(), 'git worktree remove failed: fatal: boom')
    const box = document.body.querySelector('[data-testid="session-delete-blocked-error"]')
    expect(box).toBeTruthy()
    expect(box!.textContent).toContain('git worktree remove failed: fatal: boom')
  })

  it('resets the consents when a renewed refusal parks a new state', () => {
    renderBlocked(makeBlocked({ option: 'confirm_uncommitted_loss' }))
    act(() => {
      checkbox('session-delete-unlock-checkbox').click()
    })
    expect(checkbox('session-delete-unlock-checkbox').checked).toBe(true)

    // A renewed refusal refreshes the parked state in place (new object,
    // new demanded option) — the defaults re-derive from the new option.
    renderBlocked(makeBlocked({ option: 'unlock_locked_tree', reason: 'worktree is locked: "s-abc12345"' }))
    expect(checkbox('session-delete-unlock-checkbox').checked).toBe(true)
    expect(checkbox('session-delete-discard-checkbox').checked).toBe(false)
  })

  it('keeps the user ticks across an inline retry failure', () => {
    // The real hook only sets the error on a retry failure — the parked
    // state keeps its reference, so the consents must survive.
    const blocked = makeBlocked({ option: 'unlock_locked_tree' })
    renderBlocked(blocked)
    act(() => {
      checkbox('session-delete-discard-checkbox').click()
    })
    renderBlocked(blocked, 'context deadline exceeded')
    expect(checkbox('session-delete-discard-checkbox').checked).toBe(true)
    expect(checkbox('session-delete-unlock-checkbox').checked).toBe(true)
  })
})
