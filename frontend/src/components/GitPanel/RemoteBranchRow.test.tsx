// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RemoteBranchRow } from './RemoteBranchRow'
import type { ComponentProps } from 'react'
import type { Branch } from '@/types/models'

type RemoteBranchRowProps = ComponentProps<typeof RemoteBranchRow>

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return { name: 'origin/feature/x', is_current: false, kind: 'remote', upstream: '', ...overrides }
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

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

function row(container: HTMLElement): HTMLElement {
  return container.querySelector('[role="button"]') as HTMLElement
}

const defaultCallbacks = {
  onCheckoutRemote: vi.fn(),
  onDeleteRemote: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RemoteBranchRow', () => {
  it('renders the full remote-tracking ref', () => {
    const { container } = render(
      <RemoteBranchRow branch={makeBranch()} inFlight={null} disabled={false} {...defaultCallbacks} />,
    )
    expect(container.textContent).toContain('origin/feature/x')
  })

  it('renders a single delete-remote hover action icon', () => {
    const { container } = render(
      <RemoteBranchRow branch={makeBranch()} inFlight={null} disabled={false} {...defaultCallbacks} />,
    )
    const btns = buttons(container)
    expect(btns.length).toBe(1)
    expect(btns[0]!.querySelector('svg')).not.toBeNull()
  })

  it('calls onCheckoutRemote with the full ref on click', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = render(
      <RemoteBranchRow branch={makeBranch()} inFlight={null} disabled={false} {...callbacks} />,
    )
    act(() => {
      row(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(callbacks.onCheckoutRemote).toHaveBeenCalledWith('origin/feature/x')
  })

  it('splits remote and short name for the delete action', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = render(
      <RemoteBranchRow branch={makeBranch()} inFlight={null} disabled={false} {...callbacks} />,
    )
    act(() => {
      buttons(container)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(callbacks.onDeleteRemote).toHaveBeenCalledWith('feature/x', 'origin')
    expect(callbacks.onCheckoutRemote).not.toHaveBeenCalled()
  })

  it('handles nested branch names (everything after the first slash)', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = render(
      <RemoteBranchRow
        branch={makeBranch({ name: 'origin/feature/deep/x' })}
        inFlight={null}
        disabled={false}
        {...callbacks}
      />,
    )
    act(() => {
      buttons(container)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(callbacks.onDeleteRemote).toHaveBeenCalledWith('feature/deep/x', 'origin')
  })

  it('disables checkout and delete while another operation is in flight', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = render(
      <RemoteBranchRow branch={makeBranch()} inFlight={null} disabled={true} {...callbacks} />,
    )
    act(() => {
      row(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(callbacks.onCheckoutRemote).not.toHaveBeenCalled()
    expect(buttons(container)[0]!.disabled).toBe(true)
  })

  it('explains the blocked delete-remote action while another operation runs', () => {
    const { container } = render(
      <RemoteBranchRow branch={makeBranch()} inFlight={null} disabled={true} {...defaultCallbacks} />,
    )
    const del = buttons(container)[0]!
    expect(del.disabled).toBe(true)
    // The reason must be reachable: on the button title (mirrored for
    // assistive tech) and on the focusable wrapper span.
    expect(del.title).toBe('A git operation is in progress')
    expect(del.parentElement?.title).toBe('A git operation is in progress')
    expect(del.parentElement?.getAttribute('aria-label')).toBe(
      'Delete origin/feature/x on remote: A git operation is in progress',
    )
  })

  it('shows a spinner while the remote checkout is in flight', () => {
    const { container } = render(
      <RemoteBranchRow branch={makeBranch()} inFlight="checkoutRemote" disabled={false} {...defaultCallbacks} />,
    )
    // The trailing spinner icon is rendered adjacent to the name.
    expect(container.querySelector('svg.animate-spin')).not.toBeNull()
  })
})

describe('RemoteBranchRow — managed-focus gate (checkoutBlockedReason)', () => {
  // Handed down by useSessionWorktreePin while the Git panel's focus rests
  // on a managed session tree: checking a remote branch out creates a local
  // branch and moves the focused tree off its pin (ErrPinnedWorktreeBranch).
  const reason = 'Branch switching is disabled while focused on a session worktree'

  function renderGated(overrides: Partial<RemoteBranchRowProps> = {}) {
    return render(
      <RemoteBranchRow
        branch={makeBranch()}
        inFlight={null}
        disabled={false}
        checkoutBlockedReason={reason}
        {...defaultCallbacks}
        {...overrides}
      />,
    )
  }

  it('dims the row, no-ops the checkout, and explains itself up front', () => {
    const { container } = renderGated()
    const r = row(container)
    act(() => {
      r.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(defaultCallbacks.onCheckoutRemote).not.toHaveBeenCalled()
    expect(r.className).toContain('cursor-not-allowed')
    expect(r.className).toContain('opacity-50')
    expect(r.title).toBe(reason)
    expect(r.getAttribute('aria-disabled')).toBe('true')
    // Keyboard users can reach the tooltip: the row keeps its tab stop.
    expect(r.getAttribute('tabindex')).toBe('0')
  })

  it('blocks the keyboard activation path too', () => {
    const { container } = renderGated()
    act(() => {
      row(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(defaultCallbacks.onCheckoutRemote).not.toHaveBeenCalled()
  })

  it('keeps delete-remote live — the backend allows it under a managed focus', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = renderGated(callbacks)
    const del = buttons(container)[0]!
    expect(del.disabled).toBe(false)
    act(() => {
      del.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(callbacks.onDeleteRemote).toHaveBeenCalledWith('feature/x', 'origin')
    expect(callbacks.onCheckoutRemote).not.toHaveBeenCalled()
  })

  it('checks out normally when the gate hands down null (off-managed focus)', () => {
    const callbacks = { ...defaultCallbacks }
    const { container } = render(
      <RemoteBranchRow
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
    expect(callbacks.onCheckoutRemote).toHaveBeenCalledWith('origin/feature/x')
  })
})

describe('RemoteBranchRow — session-draft mode (draftSelect)', () => {
  const onSelect = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderDraft(
    overrides: Partial<Branch> = {},
    selected = false,
    draftBlockedReason?: string | null,
  ) {
    return render(
      <RemoteBranchRow
        branch={makeBranch(overrides)}
        inFlight={null}
        disabled={false}
        draftBlockedReason={draftBlockedReason}
        {...defaultCallbacks}
        draftSelect={{ selected, onSelect }}
      />,
    )
  }

  it('selects instead of checking out: click records the pick with the full ref, no git runs', () => {
    const { container } = renderDraft()
    act(() => {
      row(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith('origin/feature/x')
    expect(defaultCallbacks.onCheckoutRemote).not.toHaveBeenCalled()
    expect(defaultCallbacks.onDeleteRemote).not.toHaveBeenCalled()
  })

  it('hides the management hover actions — the row is a selection target', () => {
    const { container } = renderDraft()
    expect(buttons(container)).toHaveLength(0)
  })

  it('marks the already-picked remote branch with aria-current and a check', () => {
    const { container } = renderDraft({}, true)
    const r = row(container)
    expect(r.getAttribute('aria-current')).toBe('true')
    expect(r.querySelector('svg')).not.toBeNull()
    expect(r.className).toContain('bg-primary/10')
  })

  it('leaves an unpicked draft row unmarked', () => {
    const { container } = renderDraft({}, false)
    expect(row(container).getAttribute('aria-current')).toBeNull()
  })

  // The reason is handed down precomputed by BranchPicker (same predicate as
  // the local rows) — the row renders it verbatim, so a distinctive string
  // here proves the pass-through without coupling to the picker's wording.
  const reason = 'Held by the main checkout — unit-test reason'

  it('blocks the row when the picker hands down a draftBlockedReason, like a local row', () => {
    const { container } = renderDraft({}, false, reason)

    const r = row(container)
    expect(r.getAttribute('tabindex')).toBe('-1')
    expect(r.className).toContain('cursor-not-allowed')
    // The tooltip is the handed-down reason, verbatim.
    expect(r.getAttribute('title')).toBe(reason)

    act(() => {
      r.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).not.toHaveBeenCalled()
    expect(defaultCallbacks.onCheckoutRemote).not.toHaveBeenCalled()
  })

  it('blocks via the keyboard path too', () => {
    const { container } = renderDraft({}, false, reason)
    const r = row(container)
    act(() => {
      r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('stays selectable when the picker hands down no blocking reason (null)', () => {
    const { container } = renderDraft({}, false, null)

    const r = row(container)
    expect(r.getAttribute('tabindex')).toBe('0')
    expect(r.className).toContain('cursor-pointer')
    expect(r.getAttribute('title')).toBeNull()

    act(() => {
      r.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith('origin/feature/x')
  })

  it('a handed-down reason blocks nothing outside draft mode — checkout-remote still runs', () => {
    const { container } = render(
      <RemoteBranchRow
        branch={makeBranch()}
        inFlight={null}
        disabled={false}
        draftBlockedReason={reason}
        {...defaultCallbacks}
      />,
    )
    act(() => {
      row(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(defaultCallbacks.onCheckoutRemote).toHaveBeenCalledWith('origin/feature/x')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
