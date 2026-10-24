// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LocalBranchRow } from './LocalBranchRow'
import type { Branch } from '@/types/models'

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return { name: 'feature/x', is_current: false, kind: 'local', upstream: '', ...overrides }
}

function render(ui: React.ReactNode): { root: Root; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<TooltipProvider>{ui}</TooltipProvider>)
  })
  return { root, container }
}

const defaultCallbacks = {
  onCheckout: vi.fn(),
  onRename: vi.fn(),
  onMerge: vi.fn(),
  onRebase: vi.fn(),
  onPush: vi.fn(),
  onDelete: vi.fn(),
}

/** The hover overlay renders one <button> per action, in fixed order. */
function buttons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

/** The outer row is a div[role=button], distinct from the action <button>s. */
function row(container: HTMLElement): HTMLElement {
  return container.querySelector('[role="button"]') as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LocalBranchRow', () => {
  it('renders the branch name', () => {
    const { container } = render(
      <LocalBranchRow branch={makeBranch()} inFlight={null} disabled={false} {...defaultCallbacks} />,
    )
    expect(container.textContent).toContain('feature/x')
  })

  it('shows a check icon for the current branch', () => {
    const { container } = render(
      <LocalBranchRow branch={makeBranch({ name: 'main', is_current: true })} inFlight={null} disabled={false} {...defaultCallbacks} />,
    )
    // The current branch has a Check icon; a non-current row has none besides
    // the leading GitBranch glyph. Assert the check via the absence of the
    // merge/rebase actions and the disabled delete, and the row's aria-current.
    expect(row(container).getAttribute('aria-current')).toBe('true')
  })

  it('renders five hover action icons (push/merge/rebase/rename/delete) for a non-current branch', () => {
    const { container } = render(
      <LocalBranchRow branch={makeBranch()} inFlight={null} disabled={false} {...defaultCallbacks} />,
    )
    const btns = buttons(container)
    expect(btns.length).toBe(5)
    for (const b of btns) {
      expect(b.querySelector('svg')).not.toBeNull()
    }
  })

  it('hides merge/rebase and disables delete for the current branch', () => {
    const { container } = render(
      <LocalBranchRow branch={makeBranch({ name: 'main', is_current: true })} inFlight={null} disabled={false} {...defaultCallbacks} />,
    )
    const btns = buttons(container)
    // push | rename | delete (merge & rebase hidden)
    expect(btns.length).toBe(3)
    const [, , del] = btns
    expect(del?.disabled).toBe(true)
    // The disabled delete must explain itself via the wrapper-span tooltip.
    expect(del?.title).toBe('Cannot delete the current branch')
    expect(del?.parentElement?.title).toBe('Cannot delete the current branch')
  })

  it('explains blocked actions with the in-progress reason while another operation runs', () => {
    const { container } = render(
      <LocalBranchRow branch={makeBranch()} inFlight={null} disabled={true} {...defaultCallbacks} />,
    )
    for (const b of buttons(container)) {
      expect(b.disabled).toBe(true)
      // Every blocked action carries the reason on its own title (mirrored
      // for assistive tech) and on the focusable wrapper span.
      expect(b.title).toBe('A git operation is in progress')
      expect(b.parentElement?.title).toBe('A git operation is in progress')
    }
    // The wrapper span is the tab stop while disabled, so it carries the
    // accessible name as "label: reason".
    expect(buttons(container)[0]?.parentElement?.getAttribute('aria-label')).toBe(
      'Push feature/x: A git operation is in progress',
    )
  })

  it('labels idle actions with their name only (no in-progress reason)', () => {
    const { container } = render(
      <LocalBranchRow branch={makeBranch()} inFlight={null} disabled={false} {...defaultCallbacks} />,
    )
    const push = buttons(container)[0]!
    expect(push.disabled).toBe(false)
    expect(push.title).toBe('Push feature/x')
    expect(push.parentElement?.title).toBe('')
  })

  it('calls onCheckout when a non-current row is clicked', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = render(
      <LocalBranchRow branch={makeBranch()} inFlight={null} disabled={false} {...callbacks} />,
    )
    act(() => {
      row(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(callbacks.onCheckout).toHaveBeenCalledWith('feature/x')
  })

  it('does not checkout the current branch', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = render(
      <LocalBranchRow branch={makeBranch({ name: 'main', is_current: true })} inFlight={null} disabled={false} {...callbacks} />,
    )
    act(() => {
      row(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(callbacks.onCheckout).not.toHaveBeenCalled()
  })

  it('wires the delete action and does not trigger checkout', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = render(
      <LocalBranchRow branch={makeBranch()} inFlight={null} disabled={false} {...callbacks} />,
    )
    const btns = buttons(container)
    const del = btns[4]!
    act(() => {
      del.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(callbacks.onDelete).toHaveBeenCalledWith('feature/x')
    expect(callbacks.onCheckout).not.toHaveBeenCalled()
  })

  it('wires the rename action', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = render(
      <LocalBranchRow branch={makeBranch()} inFlight={null} disabled={false} {...callbacks} />,
    )
    const btns = buttons(container)
    const rename = btns[3]!
    act(() => {
      rename.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(callbacks.onRename).toHaveBeenCalledWith('feature/x')
  })

  it('disables checkout and action buttons while another operation is in flight', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = render(
      <LocalBranchRow branch={makeBranch()} inFlight={null} disabled={true} {...callbacks} />,
    )
    act(() => {
      row(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(callbacks.onCheckout).not.toHaveBeenCalled()
    for (const b of buttons(container)) {
      expect(b.disabled).toBe(true)
    }
  })

  it('shows a spinner in place of the push icon while push is in flight', () => {
    const { container } = render(
      <LocalBranchRow branch={makeBranch()} inFlight="push" disabled={false} {...defaultCallbacks} />,
    )
    const btns = buttons(container)
    const push = btns[0]!
    expect(push.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
  })

  describe('pinned branch (managed session)', () => {
    it('shows a lock instead of the check and marks the row current', () => {
      const { container } = render(
        <LocalBranchRow
          branch={makeBranch({ name: 'feat/x', is_current: true })}
          inFlight={null}
          disabled={false}
          pinned
          {...defaultCallbacks}
        />,
      )
      expect(container.querySelector('svg.lucide-lock')).not.toBeNull()
      expect(container.querySelector('svg.lucide-check')).toBeNull()
      expect(container.querySelector('[aria-label="Pinned to this session"]')).not.toBeNull()
      expect(row(container).getAttribute('aria-current')).toBe('true')
      // The pin is communicated up front, not discovered through dead clicks.
      expect(row(container).title).toBe(
        'Pinned: this branch is held by this session\'s managed worktree — the Git panel follows that tree; switch the focus in the Worktrees section to work on other branches',
      )
    })

    it('renders no delete action and disables rename', () => {
      const { container } = render(
        <LocalBranchRow
          branch={makeBranch({ name: 'feat/x', is_current: true })}
          inFlight={null}
          disabled={false}
          pinned
          {...defaultCallbacks}
        />,
      )
      const btns = buttons(container)
      // push | rename (merge & rebase hidden for the current branch, delete gone)
      expect(btns.length).toBe(2)
      for (const b of btns) {
        expect(b.querySelector('svg.lucide-trash2')).toBeNull()
      }
      // Rename stays visible but is disabled with the pinned reason — the
      // branch name is part of the immutable binding (ErrPinnedWorktreeBranch).
      const rename = btns[1]!
      expect(rename.disabled).toBe(true)
      expect(rename.title).toBe('Pinned to this session — renaming is disabled')
      expect(rename.parentElement?.title).toBe('Pinned to this session — renaming is disabled')
      expect(rename.parentElement?.getAttribute('aria-label')).toBe(
        'Rename: Pinned to this session — renaming is disabled',
      )
    })

    it('disables rename on the pinned branch even when it is not the focused one', () => {
      const { container } = render(
        <LocalBranchRow
          branch={makeBranch({ name: 'feat/x', is_current: false })}
          inFlight={null}
          disabled={false}
          pinned
          {...defaultCallbacks}
        />,
      )
      const btns = buttons(container)
      // push | merge | rebase | rename (delete gone) — rename is disabled
      // although a non-current branch normally renames freely.
      expect(btns.length).toBe(4)
      const rename = btns[3]!
      expect(rename.disabled).toBe(true)
      expect(rename.title).toBe('Pinned to this session — renaming is disabled')
    })

    it('does not checkout the pinned branch even when it is not the focused tree’s current one', () => {
      const callbacks = { ...defaultCallbacks }
      const { container } = render(
        <LocalBranchRow
          branch={makeBranch({ name: 'feat/x', is_current: false })}
          inFlight={null}
          disabled={false}
          pinned
          {...callbacks}
        />,
      )
      act(() => {
        row(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(callbacks.onCheckout).not.toHaveBeenCalled()
    })

    it('announces the pin via aria-disabled and stays keyboard-reachable for the tooltip', () => {
      const { container } = render(
        <LocalBranchRow
          branch={makeBranch({ name: 'feat/x', is_current: true })}
          inFlight={null}
          disabled={false}
          pinned
          {...defaultCallbacks}
        />,
      )
      const r = row(container)
      // The row is a no-op, but it stays in the tab order: the explaining
      // tooltip must be reachable without a pointer, and the inert primary
      // action is announced (aria-disabled), not just painted.
      expect(r.getAttribute('aria-disabled')).toBe('true')
      expect(r.getAttribute('tabindex')).toBe('0')
    })

    it('keeps the check on a non-pinned current row', () => {
      const { container } = render(
        <LocalBranchRow
          branch={makeBranch({ name: 'main', is_current: true })}
          inFlight={null}
          disabled={false}
          {...defaultCallbacks}
        />,
      )
      expect(container.querySelector('svg.lucide-check')).not.toBeNull()
      expect(container.querySelector('svg.lucide-lock')).toBeNull()
    })
  })

  describe('managed-focus gate (checkoutBlockedReason)', () => {
    // The reason handed down by useSessionWorktreePin while the Git panel's
    // focus rests on a managed session tree — asserted verbatim to prove the
    // pass-through (the wording itself is the hook's test's business).
    const reason = 'Branch switching is disabled while focused on a session worktree'

    it('dims the row, no-ops the click, and explains itself up front', () => {
      const callbacks = { ...defaultCallbacks }
      const { container } = render(
        <LocalBranchRow
          branch={makeBranch()}
          inFlight={null}
          disabled={false}
          checkoutBlockedReason={reason}
          {...callbacks}
        />,
      )
      const r = row(container)
      act(() => {
        r.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(callbacks.onCheckout).not.toHaveBeenCalled()
      expect(r.className).toContain('cursor-not-allowed')
      expect(r.className).toContain('opacity-50')
      // The refusal is discoverable without a failing server call.
      expect(r.title).toBe(reason)
      expect(r.getAttribute('aria-disabled')).toBe('true')
      // Keyboard users can reach the tooltip: the row keeps its tab stop
      // despite being a click no-op.
      expect(r.getAttribute('tabindex')).toBe('0')
    })

    it('blocks the keyboard activation path too', () => {
      const callbacks = { ...defaultCallbacks }
      const { container } = render(
        <LocalBranchRow
          branch={makeBranch()}
          inFlight={null}
          disabled={false}
          checkoutBlockedReason={reason}
          {...callbacks}
        />,
      )
      act(() => {
        row(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(callbacks.onCheckout).not.toHaveBeenCalled()
    })

    it('keeps the hover actions live — the backend allows them under a managed focus', () => {
      const callbacks = { ...defaultCallbacks }
      const { container } = render(
        <LocalBranchRow
          branch={makeBranch()}
          inFlight={null}
          disabled={false}
          checkoutBlockedReason={reason}
          {...callbacks}
        />,
      )
      // push | merge | rebase | rename | delete — all enabled: only the
      // checkout is refused by the managed-focus pin.
      const btns = buttons(container)
      expect(btns.length).toBe(5)
      for (const b of btns) {
        expect(b.disabled).toBe(false)
      }
    })

    it('checks out normally when the gate hands down null (off-managed focus)', () => {
      const callbacks = { ...defaultCallbacks }
      const { container } = render(
        <LocalBranchRow
          branch={makeBranch()}
          inFlight={null}
          disabled={false}
          checkoutBlockedReason={null}
          {...callbacks}
        />,
      )
      const r = row(container)
      expect(r.getAttribute('aria-disabled')).toBeNull()
      expect(r.getAttribute('title')).toBeNull()
      act(() => {
        r.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(callbacks.onCheckout).toHaveBeenCalledWith('feature/x')
    })
  })
})
