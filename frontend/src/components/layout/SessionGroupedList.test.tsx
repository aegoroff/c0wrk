// @vitest-environment jsdom
//
// SessionGroupedList branch-row actions:
//
// - the branch row carries the freshest member's relative time in the
//   session-row styling (text-xs, muted);
// - the four row actions (New Session / Pin-PinOff / Archive / Delete) live
//   in the hover ItemActions overlay as REGISTERED Radix menu items — the
//   always-visible sibling "+" is gone; arrow keys traverse
//   toggle → actions → next branch, Enter/Space activate;
// - the pin item is the GROUP-level pin toggle (pinnedGroupsStore): it keeps
//   the menu open (preventDefault) and never flips the group's collapse state
//   — neither from the keyboard nor from a click (the overlay stops bubbling
//   to the parent toggle item);
// - New Session inherits the old "+" semantics: closes the menu;
// - Archive / Delete fire the group handler and close the menu;
// - the collapse toggle itself never closes the menu.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { withVirtualTimers } from '@/test/virtualTime'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SessionGroupedList } from './SessionGroupedList'
import { formatRelativeTime } from '@/lib/formatters'
import { useChatStore } from '@/stores/chatStore'
import { useActiveSessionsStore } from '@/stores/activeSessionsStore'
import { usePinnedGroupsStore } from '@/stores/pinnedGroupsStore'
import type { SessionGroups } from '@/lib/sessionGroups'
import type { SessionInfo } from '@/types/models'
import type { SessionItemSummary } from './SessionListItem'

// Radix dropdown positioning observes the trigger with ResizeObserver, which
// jsdom does not provide.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
)

interface Handlers {
  onNewSessionOnBranch: (branch: string) => void
  onArchiveGroup: (branch: string, ids: string[]) => void
  onDeleteGroup: (branch: string, ids: string[]) => void
}

function makeHandlers(): Handlers {
  return {
    onNewSessionOnBranch: vi.fn<(branch: string) => void>(),
    onArchiveGroup: vi.fn<(branch: string, ids: string[]) => void>(),
    onDeleteGroup: vi.fn<(branch: string, ids: string[]) => void>(),
  }
}

/** Minimal in-test collapse state — the same force-expand semantics the real
 *  useCollapsibleSections hook applies for an active search. */
function Harness({ groups, handlers }: { groups: SessionGroups; handlers: Handlers }) {
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const isSectionExpanded = useCallback(
    (key: string, forceExpand?: boolean) => forceExpand === true || !collapsed.has(key),
    [collapsed],
  )
  const toggleSection = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const renderSessionItem = useCallback(
    (s: SessionItemSummary) => (
      <div key={s.id} data-testid={`session-${s.id}`}>
        {s.name}
      </div>
    ),
    [],
  )
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button">open</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <SessionGroupedList
          groups={groups}
          searchActive={false}
          showSectionHeaders={false}
          isSectionExpanded={isSectionExpanded}
          toggleSection={toggleSection}
          renderSessionItem={renderSessionItem}
          onNewSessionOnBranch={handlers.onNewSessionOnBranch}
          onArchiveGroup={handlers.onArchiveGroup}
          onDeleteGroup={handlers.onDeleteGroup}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const NOW = Date.now()
const MIN = 60_000

function sess(id: string, name: string, minutesAgo: number, pinned = false): SessionInfo {
  return {
    id,
    project_id: 'p1',
    name,
    created_at: new Date(NOW - 30 * 24 * 60 * MIN).toISOString(),
    last_active_at: new Date(NOW - minutesAgo * MIN).toISOString(),
    archived: false,
    pinned,
    active: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: 'test',
    family: 'test',
    has_unfinished_task: false,
  }
}

/** feat-a: freshest member LAST in the member order — the row clock must
 *  still show ITS time; feat-b: single member. */
function makeGroups(): SessionGroups {
  return {
    worktrees: [
      {
        branch: 'feat-a',
        sessions: [sess('m1', 'Feat A one', 120), sess('m2', 'Feat A two', 5 * 24 * 60)],
      },
      { branch: 'feat-b', sessions: [sess('b1', 'Feat B one', 30)] },
    ],
    local: [sess('l1', 'Local work', 45)],
    archivedWorktrees: [],
    archivedLocal: [],
  }
}

let activeRoot: Root | null = null

async function render(el: ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  const root = createRoot(container)
  activeRoot = root
  await act(async () => {
    root.render(el)
  })
  return container
}

async function openMenu(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector('button')!
  // Radix attaches its post-open document-level work from a setTimeout(0) —
  // dispatch inside the virtual-time window (deterministic, no real time).
  await withVirtualTimers(() => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  }, 10)
  const menu = document.body.querySelector('[role="menu"]')
  expect(menu).not.toBeNull()
  return menu as HTMLElement
}

/** Setup: render the harness and open the menu. */
async function setup(): Promise<{ menu: HTMLElement; handlers: Handlers }> {
  const handlers = makeHandlers()
  const container = await render(<Harness groups={makeGroups()} handlers={handlers} />)
  const menu = await openMenu(container)
  return { menu, handlers }
}

/** A real bubbling keydown on `el` — the dispatch path Radix's handlers
 *  listen on. Roving-focus moves apply from a setTimeout, so the dispatch
 *  sits inside the virtual-time window. */
async function pressKey(el: Element, key: string): Promise<void> {
  await withVirtualTimers(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }, 10)
}

/** React-observable click. */
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Branch-row collapse toggle — the registered menu item carrying the branch
 *  name and the GitBranch glyph. */
function branchToggle(menu: HTMLElement, branch: string): HTMLElement {
  const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
    (el) => (el.textContent ?? '').includes(branch) && el.querySelector('svg.lucide-git-branch'),
  )
  expect(item, `branch toggle for "${branch}"`).toBeTruthy()
  return item as HTMLElement
}

/** Walk roving focus from the top of the menu to the item with `title`. */
async function focusItem(menu: HTMLElement, title: string): Promise<void> {
  await pressKey(menu, 'ArrowDown')
  for (let i = 0; i < 12; i++) {
    if (document.activeElement?.getAttribute('title') === title) return
    await pressKey(document.activeElement!, 'ArrowDown')
  }
  expect(document.activeElement?.getAttribute('title')).toBe(title)
}

function branchAction(menu: HTMLElement, title: string): HTMLElement {
  const item = menu.querySelector<HTMLElement>(`[role="menuitem"][title="${title}"]`)
  expect(item, `action "${title}"`).toBeTruthy()
  return item as HTMLElement
}

function menuIsOpen(): boolean {
  return document.body.querySelector('[role="menu"]') !== null
}

const FEAT_A_ACTIONS = [
  'New session in this worktree (feat-a)',
  'Pin group (feat-a)',
  'Archive sessions (feat-a)',
  'Delete sessions (feat-a)',
]

beforeEach(() => {
  vi.clearAllMocks()
  // The activity dot reads the REAL stores — start every test from all-idle.
  useChatStore.setState({ taskActive: {}, paused: {}, unfinishedTaskStatus: {}, messageOrder: {}, messages: {} })
  useActiveSessionsStore.setState({ pendingOverride: {} })
  // The pin action toggles the REAL pinned-groups store — start unpinned.
  usePinnedGroupsStore.setState({ pinnedBranches: [] })
})

afterEach(() => {
  if (activeRoot) {
    act(() => {
      activeRoot!.unmount()
    })
    activeRoot = null
  }
})

describe('SessionGroupedList — branch-row actions', () => {
  it('shows the freshest member relative time in the session-row styling', async () => {
    const { menu } = await setup()

    const toggle = branchToggle(menu, 'feat-a')
    const timeSpans = Array.from(toggle.querySelectorAll<HTMLElement>('span.text-xs'))
    expect(timeSpans).toHaveLength(1)
    const timeSpan = timeSpans[0]!
    // The freshest member (m2, 120 minutes... m1 at 2h) — NOT the stale one.
    expect(timeSpan.className).toContain('text-muted-foreground')
    expect(timeSpan.textContent).toBe(formatRelativeTime(new Date(NOW - 120 * MIN).toISOString()))
    expect(timeSpan.textContent).toBe('2h')

    // Single-member group shows that member's time.
    const single = branchToggle(menu, 'feat-b')
    expect(single.querySelector('span.text-xs')?.textContent).toBe(
      formatRelativeTime(new Date(NOW - 30 * MIN).toISOString()),
    )
  })

  it('renders the four actions in the hover overlay; the always-visible "+" sibling is gone', async () => {
    const { menu } = await setup()

    const toggle = branchToggle(menu, 'feat-a')
    // All four actions registered per branch...
    const actions = FEAT_A_ACTIONS.map((t) => branchAction(menu, t))
    expect(actions.every(Boolean)).toBe(true)
    // ...and ALL of them live inside the toggle's hover overlay span.
    for (const action of actions) {
      expect(action.parentElement!.tagName).toBe('SPAN')
      const overlay = action.parentElement!.className
      expect(overlay).toContain('opacity-0')
      expect(overlay).toContain('group-hover/item:opacity-100')
      expect(action.parentElement!.contains(toggle)).toBe(false)
      expect(toggle.contains(action)).toBe(true)
    }
    // No action is a SIBLING menu item of the toggle anymore (the old "+" was)
    // — the only sibling menu items are the OTHER branch toggles.
    const menuitemSiblings = Array.from(toggle.parentElement!.children).filter(
      (el) => el !== toggle && el.getAttribute('role') === 'menuitem',
    )
    expect(menuitemSiblings.length).toBeGreaterThan(0)
    for (const sibling of menuitemSiblings) {
      expect(sibling.querySelector('svg.lucide-git-branch')).not.toBeNull()
      expect(sibling.getAttribute('title')).toMatch(/^(Hide|Show) branch sessions$/)
    }
  })

  it('keyboard traverses toggle → all four actions; Enter on New Session arms the draft and closes the menu', async () => {
    const { menu, handlers } = await setup()

    await pressKey(menu, 'ArrowDown')
    expect(document.activeElement).toBe(branchToggle(menu, 'feat-a'))

    for (const title of FEAT_A_ACTIONS) {
      await pressKey(document.activeElement!, 'ArrowDown')
      expect(document.activeElement?.getAttribute('title')).toBe(title)
    }

    // The next branch row is reachable right after the actions.
    await pressKey(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(branchToggle(menu, 'feat-b'))

    // Enter on New Session: the old "+" semantics — handler + default close.
    await focusItem(menu, FEAT_A_ACTIONS[0]!)
    await pressKey(document.activeElement!, 'Enter')
    expect(handlers.onNewSessionOnBranch).toHaveBeenCalledWith('feat-a')
    expect(menuIsOpen()).toBe(false)
  })

  it('Enter on the pin action toggles the GROUP pin and keeps the menu open with the group expanded', async () => {
    const { menu } = await setup()
    const toggle = branchToggle(menu, 'feat-a')

    await focusItem(menu, 'Pin group (feat-a)')
    await pressKey(document.activeElement!, 'Enter')

    expect(usePinnedGroupsStore.getState().pinnedBranches).toContain('feat-a')
    // Menu stays open (preventDefault)...
    expect(menuIsOpen()).toBe(true)
    // ...and the group did NOT collapse — aria-expanded unchanged, members visible.
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[data-testid="session-m1"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="session-m2"]')).not.toBeNull()
  })

  it('clicking the pin action on a pinned group unpins it and never collapses the group', async () => {
    usePinnedGroupsStore.setState({ pinnedBranches: ['feat-a'] })
    const { menu } = await setup()
    const toggle = branchToggle(menu, 'feat-a')

    await click(branchAction(menu, 'Unpin group (feat-a)'))

    expect(usePinnedGroupsStore.getState().pinnedBranches).not.toContain('feat-a')
    expect(menuIsOpen()).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[data-testid="session-m1"]')).not.toBeNull()
  })

  it('shows an always-visible pin icon on the pinned group row itself (not only the Unpin action)', async () => {
    usePinnedGroupsStore.setState({ pinnedBranches: ['feat-a'] })
    const { menu } = await setup()

    const pinnedRowIcons = Array.from(
      branchToggle(menu, 'feat-a').querySelectorAll('svg.lucide-pin'),
    )
    // Exactly the always-visible badge: the overlay's action icon is PinOff
    // on a pinned group, so it does not match .lucide-pin.
    expect(pinnedRowIcons).toHaveLength(1)
    expect(pinnedRowIcons[0]!.closest('span.opacity-0')).toBeNull()
    // The overlay action shows PinOff on a pinned group — unambiguous marker.
    expect(branchToggle(menu, 'feat-a').querySelector('svg.lucide-pin-off')).not.toBeNull()

    // An unpinned group's row carries no visible pin badge.
    const unpinnedRowIcons = Array.from(
      branchToggle(menu, 'feat-b').querySelectorAll('svg.lucide-pin'),
    )
    expect(unpinnedRowIcons.every((svg) => svg.closest('span.opacity-0'))).toBe(true)
  })

  it('clicking archive / delete fires the group handler and closes the menu', async () => {
    const { menu, handlers } = await setup()

    await click(branchAction(menu, 'Archive sessions (feat-a)'))
    expect(handlers.onArchiveGroup).toHaveBeenCalledWith('feat-a', ['m1', 'm2'])
    expect(menuIsOpen()).toBe(false)

    // Fresh menu for the delete action.
    const second = await setup()
    await click(branchAction(second.menu, 'Delete sessions (feat-a)'))
    expect(second.handlers.onDeleteGroup).toHaveBeenCalledWith('feat-a', ['m1', 'm2'])
    expect(menuIsOpen()).toBe(false)
  })

  it('Enter on the collapse toggle collapses and re-expands the group without closing the menu', async () => {
    const { menu } = await setup()
    const toggle = branchToggle(menu, 'feat-a')

    await pressKey(toggle, 'Enter')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.querySelector('[data-testid="session-m1"]')).toBeNull()
    expect(menuIsOpen()).toBe(true)

    // Radix returns focus to the content after the re-render (same as the
    // selector's own branch toggles) — the toggle stays the roving tab stop,
    // so dispatch the second Enter on the toggle itself: it re-expands.
    await pressKey(toggle, 'Enter')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[data-testid="session-m1"]')).not.toBeNull()
    expect(menuIsOpen()).toBe(true)
  })
})

describe('SessionGroupedList — branch-row activity dot', () => {
  /** The group row's activity dot, or null when the group is idle. */
  function activityDot(row: HTMLElement): HTMLElement | null {
    return row.querySelector<HTMLElement>('span.size-1\\.5.rounded-full')
  }

  it('an idle group renders no activity dot', async () => {
    const { menu } = await setup()
    expect(activityDot(branchToggle(menu, 'feat-a'))).toBeNull()
    expect(activityDot(branchToggle(menu, 'feat-b'))).toBeNull()
  })

  it('a running member shows the green dot — also while the group is collapsed', async () => {
    useChatStore.setState({ taskActive: { m1: true } })
    const { menu } = await setup()
    const row = branchToggle(menu, 'feat-a')
    const dot = activityDot(row)
    expect(dot).toBeTruthy()
    expect(dot!.className).toContain('bg-success')
    expect(dot!.title).toBe('Task running')
    // The idle group next to it stays dotless.
    expect(activityDot(branchToggle(menu, 'feat-b'))).toBeNull()

    // Collapse the group: the row (and its dot) remain — a collapsed group
    // with a live member stays visible.
    await click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(activityDot(row)!.className).toContain('bg-success')
  })

  it('the most urgent member wins: failed beats running (radar precedence)', async () => {
    useChatStore.setState({ taskActive: { m2: true }, unfinishedTaskStatus: { m1: 'failed' } })
    const { menu } = await setup()
    const dot = activityDot(branchToggle(menu, 'feat-a'))!
    expect(dot.className).toContain('bg-destructive')
    expect(dot.title).toBe('Task failed — resume available')
  })

  it('a pending (HITL) member wins the dot', async () => {
    useActiveSessionsStore.setState({ pendingOverride: { m1: true } })
    useChatStore.setState({ taskActive: { m2: true } })
    const { menu } = await setup()
    const dot = activityDot(branchToggle(menu, 'feat-a'))!
    expect(dot.className).toContain('bg-warning')
    expect(dot.title).toBe('Awaiting your response')
  })
})
