// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { WorktreesSection } from './WorktreesSection'
import type { GitWorktree } from '@/types/models'

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderSection(
  worktrees: GitWorktree[],
  onSelect: (w: GitWorktree) => void = vi.fn(),
  busyPath: string | null = null,
  onDelete: ((w: GitWorktree) => void) | undefined = undefined,
  deleteBusyPath: string | null = null,
  draftSelect = false,
  draftBlockedReason?: (w: GitWorktree) => string | null,
  isPinnedWorktree?: (w: GitWorktree) => boolean,
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  act(() => {
    r.render(
      <WorktreesSection
        worktrees={worktrees}
        onSelect={onSelect}
        busyPath={busyPath}
        onDelete={onDelete}
        deleteBusyPath={deleteBusyPath}
        draftSelect={draftSelect}
        draftBlockedReason={draftBlockedReason}
        isPinnedWorktree={isPinnedWorktree}
      />,
    )
  })
}

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
})

describe('WorktreesSection (list variant)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders nothing when the project has no worktrees', () => {
    renderSection([])

    expect(container?.querySelector('[data-testid="worktree-row"]')).toBeNull()
  })

  it('lists every worktree: the local checkout, the managed session tree with its owner, and the external tree', () => {
    const main = makeWorktree({
      path: '/repo',
      name: 'repo',
      kind: 'main',
      branch: 'main',
      managed: false,
      pinned: false,
      is_focus: true,
    })
    const managed = makeWorktree({ session_id: 'sess-1', session_name: 'Refactor loop' })
    const external = makeWorktree({
      path: '/elsewhere/ext',
      name: 'ext',
      kind: 'external',
      branch: 'ext-branch',
      managed: false,
      pinned: false,
    })
    renderSection([main, managed, external])

    const rows = Array.from(container!.querySelectorAll('[data-testid="worktree-row"]'))
    expect(rows).toHaveLength(3)

    // The checkout is labeled "Local checkout"; its row carries the focus mark.
    expect(rows[0]!.textContent).toContain('Local checkout')
    expect(rows[0]!.textContent).toContain('main')
    expect(rows[0]!.querySelector('[aria-label="Focused"]')).not.toBeNull()

    // The managed tree names its tree, branch, owning session, and pin.
    expect(rows[1]!.textContent).toContain('s-abc12345')
    expect(rows[1]!.textContent).toContain('sess/s-abc12345')
    expect(rows[1]!.textContent).toContain('Refactor loop')
    expect(rows[1]!.querySelector('[aria-label="Pinned branch"]')).not.toBeNull()
    expect(rows[1]!.querySelector('[aria-label="Focused"]')).toBeNull()

    // The external tree is listed without pin or owner.
    expect(rows[2]!.textContent).toContain('ext')
    expect(rows[2]!.querySelector('[aria-label="Pinned branch"]')).toBeNull()
  })

  it('selecting a row switches the focus to that worktree', () => {
    const onSelect = vi.fn()
    const tree = makeWorktree()
    renderSection([tree], onSelect)

    const row = container!.querySelector<HTMLButtonElement>('[data-testid="worktree-row"]')!
    act(() => {
      row.click()
    })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(tree)
  })

  it('shows a locked marker for locked trees and a spinner for the in-flight switch', () => {
    const locked = makeWorktree({ locked: true })
    const busy = makeWorktree({ path: '/repo/.worktrees/s-busy0000', name: 's-busy0000' })
    renderSection([locked, busy], vi.fn(), '/repo/.worktrees/s-busy0000')

    const rows = Array.from(container!.querySelectorAll('[data-testid="worktree-row"]'))
    expect(rows[0]!.querySelector('[aria-label="Locked"]')).not.toBeNull()
    // The busy row is disabled while its focus switch is in flight.
    expect(rows[1]!.getAttribute('aria-disabled')).toBe('true')
    expect(rows[0]!.getAttribute('aria-disabled')).toBeNull()
  })
})

describe('WorktreesSection — delete action (list variant)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('exposes the delete action on linked trees but never on the local checkout', () => {
    const onDelete = vi.fn()
    const main = makeWorktree({
      path: '/repo', name: 'repo', kind: 'main', branch: 'main',
      managed: false, pinned: false,
    })
    const managed = makeWorktree()
    const external = makeWorktree({
      path: '/elsewhere/ext', name: 'ext', kind: 'external',
      managed: false, pinned: false,
    })
    renderSection([main, managed, external], vi.fn(), null, onDelete)

    const rows = Array.from(container!.querySelectorAll('[data-testid="worktree-row"]'))
    // The checkout has no delete button; each linked tree has one.
    expect(rows[0]!.querySelectorAll('button')).toHaveLength(0)
    expect(rows[1]!.querySelectorAll('button')).toHaveLength(1)
    expect(rows[2]!.querySelectorAll('button')).toHaveLength(1)
    expect(rows[1]!.querySelector('button')!.getAttribute('title')).toContain('Delete s-abc12345')
  })

  it('offers no delete actions at all when onDelete is not provided', () => {
    renderSection([makeWorktree()])

    expect(container!.querySelectorAll('[data-testid="worktree-row"] button')).toHaveLength(0)
  })

  it('raises onDelete with the worktree without selecting it', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    const tree = makeWorktree()
    renderSection([tree], onSelect, null, onDelete)

    const action = container!.querySelector<HTMLButtonElement>('[data-testid="worktree-row"] button')!
    act(() => {
      action.click()
    })

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(tree)
    // The delete click must never double as a focus switch.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows a spinner action and disables the row while its deletion is in flight', () => {
    const onDelete = vi.fn()
    const tree = makeWorktree()
    renderSection([tree], vi.fn(), null, onDelete, tree.path)

    const row = container!.querySelector('[data-testid="worktree-row"]')!
    const action = row.querySelector('button')!
    // The deleting row cannot be focus-switched and the action is disabled
    // (the spinner replaces the trash icon inside it).
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(action.disabled).toBe(true)
    expect(action.querySelector('.animate-spin')).not.toBeNull()
  })

  it('keeps the delete actions usable for untouched trees after the in-flight deletion ends', () => {
    const onDelete = vi.fn()
    const tree = makeWorktree()
    renderSection([tree], vi.fn(), null, onDelete, null)

    const action = container!.querySelector<HTMLButtonElement>('[data-testid="worktree-row"] button')!
    expect(action.disabled).toBe(false)
    act(() => {
      action.click()
    })
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})

describe('WorktreesSection — draft-mode selection (list variant)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('labels unblocked rows as run targets: the checkout, and managed trees with the sharing disclosure', () => {
    const main = makeWorktree({
      path: '/repo', name: 'repo', kind: 'main', branch: 'main',
      managed: false, pinned: false,
    })
    const managed = makeWorktree()
    renderSection([main, managed], vi.fn(), null, undefined, null, true)

    const rows = Array.from(container!.querySelectorAll('[data-testid="worktree-row"]'))
    expect(rows[0]!.getAttribute('title')).toBe('Run the new session in the local checkout')
    // The managed tree's tooltip discloses that the session joins the
    // existing worktree instead of getting a fresh one (ADR-082).
    expect(rows[1]!.getAttribute('title')).toBe(
      'Run the new session in worktree s-abc12345 on sess/s-abc12345 — joins the existing worktree',
    )
    expect(rows[0]!.getAttribute('aria-disabled')).toBeNull()
    expect(rows[1]!.getAttribute('aria-disabled')).toBeNull()
  })

  it('renders gated rows inert with the reason as tooltip, never raising onSelect — delete stays available', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    const external = makeWorktree({
      path: '/elsewhere/ext', name: 'ext', kind: 'external', branch: 'ext/branch',
      managed: false, pinned: false,
    })
    renderSection(
      [external],
      onSelect,
      null,
      onDelete,
      null,
      true,
      (w) =>
        w.kind !== 'managed' && w.branch
          ? `Branch ${w.branch} is held by a worktree created outside c0wrk`
          : null,
    )

    const row = container!.querySelector<HTMLElement>('[data-testid="worktree-row"]')!
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.getAttribute('tabindex')).toBe('-1')
    expect(row.getAttribute('title')).toContain('outside c0wrk')
    expect(row.className).toContain('cursor-not-allowed')

    act(() => {
      row.click()
    })
    expect(onSelect).not.toHaveBeenCalled()

    // Keyboard activation is gated the same way.
    act(() => {
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    expect(onSelect).not.toHaveBeenCalled()

    // The delete action stays available on the gated row and never doubles
    // as a selection.
    const action = row.querySelector('button')!
    expect(action.disabled).toBe(false)
    act(() => {
      action.click()
    })
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(external)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps the focus wording when draftSelect is off, regardless of the gate', () => {
    const onSelect = vi.fn()
    const tree = makeWorktree()
    renderSection([tree], onSelect, null, undefined, null, false, () => 'blocked')

    const row = container!.querySelector<HTMLElement>('[data-testid="worktree-row"]')!
    expect(row.getAttribute('title')).toBe('Focus worktree s-abc12345 (sess/s-abc12345)')
    expect(row.getAttribute('aria-disabled')).toBeNull()
    act(() => {
      row.click()
    })
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})

describe('WorktreesSection — session pin (manage mode)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  const sessionTree = () =>
    makeWorktree({
      path: '/w/proj/.worktrees/s-1',
      name: 's-1',
      branch: 'feat/x',
      is_focus: true,
    })
  const otherTree = () =>
    makeWorktree({
      path: '/w/proj/.worktrees/s-2',
      name: 's-2',
      branch: 'feat/y',
      is_focus: false,
    })
  const pinFirst = (w: GitWorktree) => w.name === 's-1'

  it('renders a lock instead of the focus check on the session tree and offers no delete there', () => {
    renderSection([sessionTree(), otherTree()], vi.fn(), null, vi.fn(), null, false, undefined, pinFirst)

    const pinnedRow = container!.querySelector<HTMLElement>('[data-path="/w/proj/.worktrees/s-1"]')!
    expect(pinnedRow.querySelector('svg.lucide-lock')).not.toBeNull()
    expect(pinnedRow.querySelector('[aria-label="Pinned to this session"]')).not.toBeNull()
    expect(pinnedRow.querySelector('svg.lucide-check')).toBeNull()
    expect(pinnedRow.querySelector('svg.lucide-trash2')).toBeNull()
    expect(pinnedRow.title).toBe('Worktree s-1 — pinned to this session (feat/x)')

    // A foreign managed tree keeps the delete action (and no pin lock).
    const otherRow = container!.querySelector<HTMLElement>('[data-path="/w/proj/.worktrees/s-2"]')!
    expect(otherRow.querySelector('svg.lucide-lock')).toBeNull()
    expect(otherRow.querySelector('svg.lucide-trash2')).not.toBeNull()
  })

  it('marks the pin with a lock while the focus check sits on the row the panel is focused on', () => {
    const focusedOther = { ...otherTree(), is_focus: true }
    renderSection([sessionTree(), focusedOther], vi.fn(), null, vi.fn(), null, false, undefined, pinFirst)

    const pinnedRow = container!.querySelector<HTMLElement>('[data-path="/w/proj/.worktrees/s-1"]')!
    expect(pinnedRow.querySelector('svg.lucide-lock')).not.toBeNull()
    expect(pinnedRow.querySelector('svg.lucide-check')).toBeNull()

    const focusedRow = container!.querySelector<HTMLElement>('[data-path="/w/proj/.worktrees/s-2"]')!
    expect(focusedRow.querySelector('svg.lucide-check')).not.toBeNull()
    expect(focusedRow.querySelector('[aria-label="Focused"]')).not.toBeNull()
  })

  it('keeps the pinned row selectable — focus switching stays allowed', () => {
    const onSelect = vi.fn()
    renderSection([sessionTree()], onSelect, null, vi.fn(), null, false, undefined, pinFirst)

    const pinnedRow = container!.querySelector<HTMLElement>('[data-path="/w/proj/.worktrees/s-1"]')!
    expect(pinnedRow.getAttribute('aria-disabled')).toBeNull()
    act(() => {
      pinnedRow.click()
    })
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('never applies the pin in draft mode — the check/delete semantics stay untouched', () => {
    renderSection([sessionTree()], vi.fn(), null, vi.fn(), null, true, undefined, pinFirst)

    const row = container!.querySelector<HTMLElement>('[data-path="/w/proj/.worktrees/s-1"]')!
    expect(row.querySelector('svg.lucide-lock')).toBeNull()
    // Draft rows keep the delete affordance (a stale tree can be pruned mid-draft).
    expect(row.querySelector('svg.lucide-trash2')).not.toBeNull()
  })
})
