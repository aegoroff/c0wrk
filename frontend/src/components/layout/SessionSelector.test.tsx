// @vitest-environment jsdom
//
// SessionSelector grouped-by-branch mode (uiStore.sessionListGrouped):
//
// - the header List⇄FolderTree toggle (same glyph as the git panel's tree
//   view) sits on the search-input line, BEFORE the input, and flips the mode
//   without dismissing the menu;
// - grouped mode renders Managed → branch rows (GitBranch icon + chevron +
//   branch name) → member sessions, then Local → sessions; section headers
//   appear only when BOTH sections are non-empty (a lone Local section is the
//   flat view) and share the branch combo's uppercase section styling;
// - a branch-header selection (click or Enter) collapses/expands its group
//   (ephemeral state) and NEVER closes the dropdown; the Managed/Local section
//   headers collapse the same way;
// - the popup is a fixed wide `w-[28rem]`;
// - grouped mode separates the Managed and Local sections with the branch
//   combo's hairline divider (only when both sections render headers);
// - each managed branch row carries a "New session in this worktree" item
//   (the + action): it arms the ADR-080 draft pinned to that branch
//   (createBranch=false — CreateManagedSession adopts the branch's existing
//   managed tree per ADR-082), clears the active selection and closes the
//   menu; it never toggles the branch's collapse state, and nothing but
//   managed branch rows (flat mode, Local/Archived sections) has the action;
// - an active search force-expands every group and section and hides empty ones;
// - the Archived section behaves exactly as before in both modes;
// - every one of these controls is a REGISTERED Radix menu item — arrow keys
//   traverse them and Enter/Space activate them (a group collapsed with the
//   mouse stays reopenable from the keyboard; Radix prevents Tab inside the
//   menu, so unregistered controls would be unreachable).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { withVirtualTimers } from '@/test/virtualTime'

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    createSession: vi.fn(),
    renameSession: vi.fn(),
    archiveSession: vi.fn(),
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    pinSession: vi.fn(),
  },
}))
vi.mock('@/api/sessions', () => apiMocks)

// The real logger writes expected error noise for failure branches; the
// component under test does not assert on logging.
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

type Binding = {
  kind: 'local' | 'managed_worktree'
  workspace_path: string
  worktree_name?: string
  branch?: string
}
type SessionRow = {
  id: string
  project_id: string
  name: string
  archived: boolean
  pinned: boolean
  last_active_at: string
  workspace_binding?: Binding
}

const { sessionMocks } = vi.hoisted(() => ({
  sessionMocks: {
    sessions: [] as unknown[],
    activeSessionId: null as string | null,
    selectSession: vi.fn(),
    addSession: vi.fn(),
    removeSession: vi.fn(),
    updateSession: vi.fn(),
  },
}))
vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: typeof sessionMocks) => unknown) => selector(sessionMocks),
}))

// Selector-aware chat store stub so every row's indicator resolves to 'idle'
// without touching live task state.
const { chatMocks } = vi.hoisted(() => ({
  chatMocks: {
    taskActive: {} as Record<string, boolean>,
    paused: {} as Record<string, boolean>,
    unfinishedTaskStatus: {} as Record<string, string | undefined>,
    messageOrder: {} as Record<string, string[]>,
    messages: {} as Record<string, unknown>,
  },
}))
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: typeof chatMocks) => unknown) => selector(chatMocks),
}))

import { SessionSelector } from './SessionSelector'
import { useUIStore } from '@/stores/uiStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionDraftStore } from '@/stores/sessionDraftStore'
import type { ProjectInfo } from '@/types/models'

const NOW = Date.now()

function managedBinding(branch: string): Binding {
  return { kind: 'managed_worktree', workspace_path: `/tmp/wt-${branch}`, branch }
}

function makeSession(overrides: Partial<SessionRow> & { id: string; name: string }): SessionRow {
  return {
    project_id: 'proj-1',
    archived: false,
    pinned: false,
    last_active_at: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  }
}

/** CODE project for the real projectStore — the branch-button draft needs it. */
function makeProject(): ProjectInfo {
  return {
    id: 'proj-1',
    name: 'Proj',
    workspace_path: '/w/proj',
    is_external: false,
    is_no_project: false,
    created_at: '2026-01-01T00:00:00Z',
    last_active_at: '2026-01-01T00:00:00Z',
  }
}

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

/** Drain pending microtasks so async handlers and store updates settle. */
const flush = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

async function openMenu(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector('button')!
  // The dispatch sits INSIDE the virtual-time window: Radix attaches its
  // post-open document-level work from a setTimeout(0), which must land on
  // the fake clock and fire during the advance — deterministically, with no
  // real time spent (timing-guard compliant).
  await withVirtualTimers(() => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  }, 10)
  const menu = document.body.querySelector('[role="menu"]')
  expect(menu).not.toBeNull()
  return menu as HTMLElement
}

/** Branch-row collapse toggle — a registered menu item carrying the branch
 *  name and the GitBranch glyph (member session rows never carry that glyph). */
function branchToggle(menu: HTMLElement, branch: string): HTMLElement {
  const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
    (el) => (el.textContent ?? '').includes(branch) && el.querySelector('svg.lucide-git-branch'),
  )
  expect(item, `branch toggle for "${branch}"`).toBeTruthy()
  return item as HTMLElement
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

/** React 19 controlled input: native prototype setter + `input` event. */
async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  expect(setter).toBeTruthy()
  await act(async () => {
    setter!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

function menuText(menu: HTMLElement): string {
  return menu.textContent ?? ''
}

/**
 * A real bubbling keydown on `el` — the dispatch path Radix's React handlers
 * (content-level arrows, item Enter/Space) listen on. Roving-focus moves are
 * applied from a setTimeout, so the dispatch sits inside the virtual-time
 * window (deterministic, no real time spent — timing-guard compliant).
 */
async function pressKey(el: Element, key: string): Promise<void> {
  await withVirtualTimers(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }, 10)
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionMocks.sessions = []
  sessionMocks.activeSessionId = null
  // The real (persisted) uiStore — start every test from the shipped default.
  useUIStore.setState({ sessionListGrouped: false })
})

afterEach(() => {
  if (activeRoot) {
    act(() => {
      activeRoot!.unmount()
    })
    activeRoot = null
  }
})

describe('SessionSelector — flat mode (default)', () => {
  it('renders sessions flat with no grouping chrome while sessionListGrouped is off', async () => {
    sessionMocks.sessions = [
      makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'm2', name: 'Feat A two', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'l1', name: 'Checkout work' }),
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    const text = menuText(menu)
    // No section headers, no branch rows...
    expect(text).not.toContain('Managed')
    expect(text).not.toContain('feat-a')
    // ...but every session row is visible.
    expect(text).toContain('Feat A one')
    expect(text).toContain('Feat A two')
    expect(text).toContain('Checkout work')
    // The mode toggle is present and advertises the switch to grouped mode.
    const toggle = menu.querySelector<HTMLElement>('[role="menuitem"][title="Group sessions by branch"]')
    expect(toggle).not.toBeNull()
    expect(useUIStore.getState().sessionListGrouped).toBe(false)
    void container
  })
})

describe('SessionSelector — mode toggle', () => {
  it('renders a large hover-styled tree toggle on the search line, before the input', async () => {
    // Five sessions so the search input renders.
    sessionMocks.sessions = [
      makeSession({ id: 'l1', name: 'One' }),
      makeSession({ id: 'l2', name: 'Two' }),
      makeSession({ id: 'l3', name: 'Three' }),
      makeSession({ id: 'l4', name: 'Four' }),
      makeSession({ id: 'l5', name: 'Five' }),
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    const toggle = menu.querySelector<HTMLElement>('[role="menuitem"][title="Group sessions by branch"]')!
    expect(toggle).not.toBeNull()
    // Hover affordance (the user requirement) + a bigger hit area aligned
    // with the h-7 search input and the larger size-4 glyph.
    expect(toggle.className).toContain('hover:bg-muted')
    expect(toggle.className).toContain('h-7')
    expect(toggle.className).toContain('w-7')
    // The tree-view glyph, exactly like git → Changes' tree toggle.
    expect(toggle.querySelector('svg.lucide-folder-tree')).not.toBeNull()
    expect(toggle.querySelector('svg.lucide-git-branch')).toBeNull()

    // Same line as the search input, positioned BEFORE it.
    const input = menu.querySelector<HTMLInputElement>('input[placeholder*="Search"]')!
    expect(input).not.toBeNull()
    expect(input.parentElement).toBe(toggle.parentElement)
    const rowChildren = Array.from(toggle.parentElement!.children)
    expect(rowChildren.indexOf(toggle)).toBeLessThan(rowChildren.indexOf(input))
  })

  it('still renders the toggle when the search input is hidden (< 5 sessions)', async () => {
    sessionMocks.sessions = [makeSession({ id: 'l1', name: 'Only one' })]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    expect(menu.querySelector('[role="menuitem"][title="Group sessions by branch"]')).not.toBeNull()
    expect(menu.querySelector('input')).toBeNull()
  })

  it('toggling switches to grouped mode without closing the menu', async () => {
    sessionMocks.sessions = [
      makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'l1', name: 'Checkout work' }),
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    await click(menu.querySelector<HTMLElement>('[role="menuitem"][title="Group sessions by branch"]')!)

    // The menu is still open and now renders the branch group.
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(useUIStore.getState().sessionListGrouped).toBe(true)
    expect(menuText(menu)).toContain('feat-a')
    // The toggle now advertises the way back.
    expect(menu.querySelector('[role="menuitem"][title="Show flat list"]')).not.toBeNull()
  })

  it('toggling back to flat restores the flat list without closing the menu', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = [
      makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'l1', name: 'Checkout work' }),
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)
    expect(menuText(menu)).toContain('feat-a')

    await click(menu.querySelector<HTMLElement>('[role="menuitem"][title="Show flat list"]')!)

    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(useUIStore.getState().sessionListGrouped).toBe(false)
    expect(menuText(menu)).not.toContain('feat-a')
    expect(menuText(menu)).toContain('Feat A one')
  })
})

describe('SessionSelector — grouped layout', () => {
  const groupedFixture = (): SessionRow[] => [
    makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
    makeSession({ id: 'm2', name: 'Feat A two', workspace_binding: managedBinding('feat-a') }),
    makeSession({ id: 'm3', name: 'Feat B one', workspace_binding: managedBinding('feat-b') }),
    makeSession({ id: 'l1', name: 'Checkout work' }),
  ]

  it('renders Managed header → branch rows → member sessions → Local header → local sessions', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = groupedFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    const text = menuText(menu)
    // Section headers + branch names + all sessions present.
    expect(text).toContain('Managed')
    expect(text).toContain('feat-a')
    expect(text).toContain('feat-b')
    expect(text).toContain('Local')
    expect(text).toContain('Feat A one')
    expect(text).toContain('Feat A two')
    expect(text).toContain('Feat B one')
    expect(text).toContain('Checkout work')

    // Document order: Managed header before the branch rows before the Local
    // header before the local session rows.
    const order = ['Managed', 'feat-a', 'Feat A one', 'Local', 'Checkout work'].map((t) =>
      text.indexOf(t),
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    // Branch rows carry the GitBranch icon (the fork action icon is a
    // different glyph, so this is specific to the group headers).
    for (const branch of ['feat-a', 'feat-b']) {
      expect(branchToggle(menu, branch).querySelector('svg')).not.toBeNull()
    }
  })

  it('a lone Local section renders as the flat view — no section headers', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = [
      makeSession({ id: 'l1', name: 'Checkout work', workspace_binding: { kind: 'local', workspace_path: '/tmp/proj' } }),
      makeSession({ id: 'l2', name: 'Older session' }), // no binding at all → Local
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    const text = menuText(menu)
    expect(text).not.toContain('Managed')
    expect(text).not.toContain('Local')
    expect(text).toContain('Checkout work')
    expect(text).toContain('Older session')
    // No branch header buttons exist (every button with a git-branch icon
    // would be one).
    const branchHeaders = Array.from(menu.querySelectorAll('[role="menuitem"]')).filter((b) =>
      b.querySelector('svg.lucide-git-branch'),
    )
    expect(branchHeaders).toHaveLength(0)
  })

  it('section headers and branch toggles expose aria-expanded and name their live content region', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = [
      ...groupedFixture(),
      makeSession({ id: 'a1', name: 'Old work', archived: true }),
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    /** Direct-child menu button with the exact label. */
    const headerIn = (m: HTMLElement, label: string) =>
      Array.from(m.children).find(
        (el) => el.getAttribute('role') === 'menuitem' && (el.textContent ?? '').trim() === label,
      ) as HTMLElement

    // The Managed header is expanded and controls a live region holding the
    // branch rows and their member sessions.
    const managedHeader = headerIn(menu, 'Managed')
    expect(managedHeader.getAttribute('aria-expanded')).toBe('true')
    const managedRegionId = managedHeader.getAttribute('aria-controls')!
    expect(managedRegionId).toBeTruthy()
    const managedRegion = document.getElementById(managedRegionId)
    expect(managedRegion?.textContent).toContain('feat-a')
    expect(managedRegion?.textContent).toContain('Feat A one')

    // A branch toggle controls exactly its own member sessions.
    const featAToggle = branchToggle(menu, 'feat-a')
    expect(featAToggle.getAttribute('aria-expanded')).toBe('true')
    const branchRegion = document.getElementById(featAToggle.getAttribute('aria-controls')!)
    expect(branchRegion?.textContent).toContain('Feat A one')
    expect(branchRegion?.textContent).not.toContain('Feat B one')

    // Collapsing flips the state and unmounts the region it named.
    await click(managedHeader)
    const menu2 = document.body.querySelector('[role="menu"]') as HTMLElement
    expect(headerIn(menu2, 'Managed').getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(managedRegionId)).toBeNull()

    // Archived starts collapsed — aria-expanded says so up front.
    const archivedHeader = Array.from(menu.querySelectorAll('[role="menuitem"]')).find((b) =>
      (b.textContent ?? '').startsWith('Archived'),
    ) as HTMLElement
    expect(archivedHeader.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('SessionSelector — popup chrome (width & section separators)', () => {
  const bothSectionsFixture = (): SessionRow[] => [
    makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
    makeSession({ id: 'm2', name: 'Feat A two', workspace_binding: managedBinding('feat-a') }),
    makeSession({ id: 'l1', name: 'Checkout work' }),
  ]

  /** Index of a DIRECT menu child matching the predicate (-1 when absent). */
  function childIndex(menu: HTMLElement, pred: (el: Element) => boolean): number {
    return Array.from(menu.children).findIndex(pred)
  }

  const isSectionHeader = (el: Element, label: string) =>
    el.getAttribute('role') === 'menuitem' && (el.textContent ?? '').trim() === label
  const isSeparator = (el: Element) => el.getAttribute('role') === 'separator'

  it('opens a wider popup — fixed w-[28rem], the old w-96 is gone', async () => {
    sessionMocks.sessions = bothSectionsFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    expect(menu.className).toContain('w-[28rem]')
    expect(menu.className).not.toContain('w-96')
  })

  it('separates the Managed and Local sections with a hairline, like the branch combo', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = bothSectionsFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    const managedIdx = childIndex(menu, (el) => isSectionHeader(el, 'Managed'))
    const localIdx = childIndex(menu, (el) => isSectionHeader(el, 'Local'))
    expect(managedIdx).toBeGreaterThanOrEqual(0)
    expect(localIdx).toBeGreaterThan(managedIdx)
    expect(
      Array.from(menu.children)
        .slice(managedIdx, localIdx)
        .some(isSeparator),
    ).toBe(true)
  })

  it('keeps the Managed/Local separator while a section is collapsed — it belongs to the headers', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = bothSectionsFixture()
    const container = await render(<SessionSelector />)
    let menu = await openMenu(container)

    const managedIdx = childIndex(menu, (el) => isSectionHeader(el, 'Managed'))
    expect(managedIdx).toBeGreaterThanOrEqual(0)
    const managedBtn = menu.children[managedIdx] as HTMLElement
    await click(managedBtn)
    menu = document.body.querySelector('[role="menu"]') as HTMLElement
    expect(menuText(menu)).not.toContain('Feat A one')

    const localIdx = childIndex(menu, (el) => isSectionHeader(el, 'Local'))
    expect(localIdx).toBeGreaterThan(managedIdx)
    expect(
      Array.from(menu.children)
        .slice(managedIdx, localIdx)
        .some(isSeparator),
    ).toBe(true)
  })

  it('adds no separators in the lone-Local flat view beyond the New Session divider', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = [
      makeSession({ id: 'l1', name: 'Checkout work' }),
      makeSession({ id: 'l2', name: 'Older session' }),
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    const seps = Array.from(menu.children).filter(isSeparator)
    expect(seps).toHaveLength(1)
  })
})

describe('SessionSelector — branch collapse', () => {
  it('clicking a branch header collapses its group and keeps the menu open; clicking again re-expands', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = [
      makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'm2', name: 'Feat A two', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'l1', name: 'Checkout work' }),
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    // Collapse the branch group.
    await click(branchToggle(menu, 'feat-a'))
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(menuText(menu)).not.toContain('Feat A one')
    expect(menuText(menu)).not.toContain('Feat A two')
    // Sibling content (local section) is untouched.
    expect(menuText(menu)).toContain('Checkout work')

    // Expand again.
    await click(branchToggle(menu, 'feat-a'))
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(menuText(menu)).toContain('Feat A one')
    expect(menuText(menu)).toContain('Feat A two')
  })
})

describe('SessionSelector — section collapse', () => {
  /** Section header item — found by its exact label (Archived carries a count). */
  function sectionHeader(menu: HTMLElement, label: string): HTMLElement {
    const btn = Array.from(menu.querySelectorAll('[role="menuitem"]')).find((b) => {
      const t = (b.textContent ?? '').trim()
      return t === label || t.startsWith(`${label} (`)
    })
    expect(btn, `section header "${label}"`).toBeTruthy()
    return btn as HTMLElement
  }

  const bothSectionsFixture = (): SessionRow[] => [
    makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
    makeSession({ id: 'l1', name: 'Checkout work' }),
  ]

  it('renders the section headers in the branch combo style — uppercase, semibold, chevron, hover', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = bothSectionsFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    for (const label of ['Managed', 'Local']) {
      const btn = sectionHeader(menu, label)
      expect(btn.className).toContain('uppercase')
      expect(btn.className).toContain('font-semibold')
      expect(btn.className).toContain('text-xs')
      expect(btn.className).toContain('hover:bg-muted')
      expect(btn.querySelector('svg.lucide-chevron-down')).not.toBeNull()
    }
  })

  it('collapsing the Managed section hides its branch rows and keeps Local; re-expanding restores', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = bothSectionsFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    await click(sectionHeader(menu, 'Managed'))
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(menuText(menu)).not.toContain('feat-a')
    expect(menuText(menu)).not.toContain('Feat A one')
    // The Local section is untouched.
    expect(menuText(menu)).toContain('Checkout work')

    await click(sectionHeader(menu, 'Managed'))
    expect(menuText(menu)).toContain('feat-a')
    expect(menuText(menu)).toContain('Feat A one')
  })

  it('collapsing the Local section hides local sessions and keeps Managed; re-expanding restores', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = bothSectionsFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    await click(sectionHeader(menu, 'Local'))
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(menuText(menu)).not.toContain('Checkout work')
    // The Managed branch group is untouched.
    expect(menuText(menu)).toContain('Feat A one')

    await click(sectionHeader(menu, 'Local'))
    expect(menuText(menu)).toContain('Checkout work')
  })

  it('an active search force-expands a collapsed section; clearing restores the collapsed state', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = [
      makeSession({ id: 'm1', name: 'Alpha work', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'm2', name: 'Alpha two', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'l1', name: 'Checkout one' }),
      makeSession({ id: 'l2', name: 'Checkout two' }),
      makeSession({ id: 'l3', name: 'Checkout three' }),
    ]
    const container = await render(<SessionSelector />)
    let menu = await openMenu(container)

    // Collapse the whole Managed section: branch content disappears.
    await click(sectionHeader(menu, 'Managed'))
    expect(menuText(menu)).not.toContain('Alpha work')

    // Searching for a member inside the collapsed section force-expands it...
    const input = menu.querySelector<HTMLInputElement>('input[placeholder*="Search"]')!
    await typeInto(input, 'alpha')
    menu = document.body.querySelector('[role="menu"]') as HTMLElement
    expect(menuText(menu)).toContain('Alpha work')
    expect(menuText(menu)).toContain('feat-a')

    // ...and clearing restores the collapsed section.
    await typeInto(menu.querySelector<HTMLInputElement>('input[placeholder*="Search"]')!, '')
    menu = document.body.querySelector('[role="menu"]') as HTMLElement
    expect(menuText(menu)).not.toContain('Alpha work')
  })
})

describe('SessionSelector — search in grouped mode', () => {
  // Five sessions so the search box renders (showSearch at >= 5).
  const searchableFixture = (): SessionRow[] => [
    makeSession({ id: 'm1', name: 'Alpha work', workspace_binding: managedBinding('feat-a') }),
    makeSession({ id: 'm2', name: 'Beta work', workspace_binding: managedBinding('feat-b') }),
    makeSession({ id: 'l1', name: 'Checkout one' }),
    makeSession({ id: 'l2', name: 'Checkout two' }),
    makeSession({ id: 'l3', name: 'Checkout three' }),
  ]

  it('force-expands collapsed groups so matches stay reachable, and hides empty groups', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = searchableFixture()
    const container = await render(<SessionSelector />)
    let menu = await openMenu(container)

    // Collapse feat-a first: its member must disappear.
    await click(branchToggle(menu, 'feat-a'))
    expect(menuText(menu)).not.toContain('Alpha work')

    // Searching for the hidden member force-expands its group...
    const input = menu.querySelector<HTMLInputElement>('input[placeholder*="Search"]')!
    expect(input).not.toBeNull()
    await typeInto(input, 'alpha')

    menu = document.body.querySelector('[role="menu"]') as HTMLElement
    const text = menuText(menu)
    expect(text).toContain('Alpha work')
    // ...while groups without matches are hidden entirely (branch row AND
    // member sessions) and non-matching local rows disappear too.
    expect(text).not.toContain('feat-b')
    expect(text).not.toContain('Beta work')
    expect(text).not.toContain('Checkout one')

    // Clearing the search restores the ephemeral collapsed state.
    await typeInto(menu.querySelector<HTMLInputElement>('input[placeholder*="Search"]')!, '')
    menu = document.body.querySelector('[role="menu"]') as HTMLElement
    expect(menuText(menu)).not.toContain('Alpha work')
    expect(menuText(menu)).toContain('Beta work')
  })
})

describe('SessionSelector — whitespace-only search', () => {
  // Five active sessions (search-input threshold) + two archived rows: a
  // blank search must filter NOTHING, so the grouped sections (trimmed
  // grouping model), the flat list and the Archived section (filterFn) all
  // agree. The untrimmed filter used to empty the Archived section and drop
  // it from the menu entirely.
  const whitespaceFixture = (): SessionRow[] => [
    makeSession({ id: 'm1', name: 'Alpha work', workspace_binding: managedBinding('feat-a') }),
    makeSession({ id: 'l1', name: 'Checkout one' }),
    makeSession({ id: 'l2', name: 'Checkout two' }),
    makeSession({ id: 'l3', name: 'Checkout three' }),
    makeSession({ id: 'a1', name: 'Old archived', archived: true }),
    makeSession({ id: 'a2', name: 'Elder archived', archived: true }),
  ]

  it.each([false, true])(
    'a blank search hides nothing in %s mode — Archived keeps its full count',
    async (grouped) => {
      useUIStore.setState({ sessionListGrouped: grouped })
      sessionMocks.sessions = whitespaceFixture()
      const container = await render(<SessionSelector />)
      let menu = await openMenu(container)

      const input = menu.querySelector<HTMLInputElement>('input[placeholder*="Search"]')!
      expect(input).not.toBeNull()
      await typeInto(input, '   ')

      menu = document.body.querySelector('[role="menu"]') as HTMLElement
      expect(menu).not.toBeNull()
      const text = menuText(menu)
      expect(text).toContain('Alpha work')
      expect(text).toContain('Checkout one')
      expect(text).toContain('Checkout three')
      expect(text).toContain('Archived (2)')

      // The section is still interactive: expanding shows every archived row.
      await click(
        Array.from(menu.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent?.includes('Archived'))! as HTMLElement,
      )
      expect(menuText(menu)).toContain('Old archived')
      expect(menuText(menu)).toContain('Elder archived')
    },
  )
})

describe('SessionSelector — search input focus', () => {
  // Radix's menu content runs its typeahead for EVERY printable character
  // typed anywhere inside the menu (no input-target exclusion in
  // @radix-ui/react-menu): the search field's first real keystroke used to
  // focus the first matching menu item and blur the field. The whitespace
  // and typeInto-based tests never saw it — they emit no keydown, or a
  // space that matches no item's text.
  const focusFixture = (): SessionRow[] => [
    makeSession({ id: 'l1', name: 'Alpha work' }),
    makeSession({ id: 'l2', name: 'Beta work' }),
    makeSession({ id: 'l3', name: 'Gamma work' }),
    makeSession({ id: 'l4', name: 'Delta work' }),
    makeSession({ id: 'l5', name: 'Echo work' }),
  ]

  it('keeps focus when the first keystroke matches a menu item ("New Session...")', async () => {
    sessionMocks.sessions = focusFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    const input = menu.querySelector<HTMLInputElement>('input[placeholder*="Search"]')!
    // The dispatch must sit INSIDE the virtual-time window so Radix's
    // setTimeout(0) typeahead focus lands on the fake clock and the advance
    // deterministically fires it.
    await withVirtualTimers(() => {
      input.focus()
      // A REAL keydown — `typeInto` (native setter + input event) never
      // emits one, which is exactly what Radix's typeahead listens for.
      // 'n' matches only the footer "New Session..." item.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))
    })

    expect(document.activeElement).toBe(input)
  })

  it('does not swallow keys the menu still needs — Escape closes the menu while typing', async () => {
    sessionMocks.sessions = focusFixture()
    const container = await render(<SessionSelector />)
    await openMenu(container)

    const input = document.body.querySelector<HTMLInputElement>('input[placeholder*="Search"]')!
    await act(async () => {
      input.focus()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()

    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('SessionSelector — grouped sessions still select', () => {
  it('clicking a session row inside a branch group selects it and closes the menu', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = [
      makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'l1', name: 'Checkout work' }),
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    const row = Array.from(menu.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes('Feat A one'),
    )
    expect(row).toBeTruthy()
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(sessionMocks.selectSession).toHaveBeenCalledWith('m1', 'proj-1')
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('SessionSelector — archived section unchanged', () => {
  it('still renders its collapsed header and expands on click in grouped mode', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = [
      makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'l1', name: 'Checkout work' }),
      makeSession({ id: 'a1', name: 'Old archived', archived: true }),
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    const text = menuText(menu)
    expect(text).toContain('Archived (1)')
    expect(text).not.toContain('Old archived')

    await click(Array.from(menu.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent?.includes('Archived'))! as HTMLElement)
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(menuText(menu)).toContain('Old archived')
  })
})

describe('SessionSelector — branch new-session action', () => {
  /** Two managed branches (feat-a newest) + a local row + an archived row. */
  const newSessionFixture = (): SessionRow[] => [
    makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a'), last_active_at: new Date(NOW - 10_000).toISOString() }),
    makeSession({ id: 'm2', name: 'Feat B one', workspace_binding: managedBinding('feat-b') }),
    makeSession({ id: 'l1', name: 'Checkout work' }),
    makeSession({ id: 'a1', name: 'Old archived', archived: true }),
  ]

  /** The + item of one managed branch row — found by its full title. */
  function newSessionAction(menu: HTMLElement, branch: string): HTMLElement {
    const btn = menu.querySelector<HTMLElement>(
      `[role="menuitem"][title="New session in this worktree (${branch})"]`,
    )
    expect(btn, `new-session button for "${branch}"`).toBeTruthy()
    return btn as HTMLElement
  }

  beforeEach(() => {
    // The real stores behind the branch-button draft flow.
    useProjectStore.setState({ activeProjectId: 'proj-1', projects: [makeProject()] })
    useSessionDraftStore.getState().clearDraft()
  })

  it('offers the button on every managed branch row — and nowhere else', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = newSessionFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    const buttons = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"][title^="New session in this worktree"]'),
    )
    // Exactly one per managed branch — the archived row, the local row and
    // every other row have none.
    expect(buttons.map((b) => b.title)).toEqual([
      'New session in this worktree (feat-a)',
      'New session in this worktree (feat-b)',
    ])
  })

  it('flat mode has no new-session buttons', async () => {
    sessionMocks.sessions = newSessionFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    expect(
      menu.querySelectorAll('[role="menuitem"][title^="New session in this worktree"]'),
    ).toHaveLength(0)
  })

  it('clicking arms the branch draft, clears the active session and closes the menu', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = newSessionFixture()
    sessionMocks.activeSessionId = 'm1'
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    await click(newSessionAction(menu, 'feat-a'))

    // The menu closed so the chat area's draft state becomes visible...
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    // ...the draft is armed for the branch (createBranch=false — the branch
    // exists, CreateManagedSession adopts its managed tree), ...
    expect(useSessionDraftStore.getState().draft).toEqual({
      projectId: 'proj-1',
      workspace: { kind: 'branch', branch: 'feat-a', createBranch: false, startPoint: '' },
    })
    // ...and the active selection was cleared (draft and selection are
    // mutually exclusive — same contract as the New Session gesture).
    expect(sessionMocks.selectSession).toHaveBeenCalledWith(null)
  })

  it('clicking never toggles the collapse state — even a collapsed branch arms its draft', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = newSessionFixture()
    const container = await render(<SessionSelector />)
    let menu = await openMenu(container)

    // Collapse feat-a first: its member disappears.
    await click(branchToggle(menu, 'feat-a'))
    menu = document.body.querySelector('[role="menu"]') as HTMLElement
    expect(menuText(menu)).not.toContain('Feat A one')

    // The + button stays reachable on the collapsed row and arms the draft...
    await click(newSessionAction(menu, 'feat-a'))
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({
      kind: 'branch',
      branch: 'feat-a',
      createBranch: false,
      startPoint: '',
    })

    // ...without touching the ephemeral collapse state.
    menu = await openMenu(container)
    expect(menuText(menu)).not.toContain('Feat A one')
  })
})

describe('SessionSelector — keyboard reachability of the new controls', () => {
  // 5 total sessions (the search input renders) with one managed branch, two
  // local rows and an archived row: the grouping toggle, the Managed header,
  // the branch toggle and its "+", the Local/Archived headers and the footer
  // action all render as registered items.
  const kbFixture = (): SessionRow[] => [
    makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
    makeSession({ id: 'm2', name: 'Feat A two', workspace_binding: managedBinding('feat-a') }),
    makeSession({ id: 'l1', name: 'Checkout one' }),
    makeSession({ id: 'l2', name: 'Checkout two' }),
    makeSession({ id: 'a1', name: 'Old work', archived: true }),
  ]

  /** Section header item by its exact label. */
  function headerItem(m: HTMLElement, label: string): HTMLElement {
    const el = Array.from(m.querySelectorAll('[role="menuitem"]')).find(
      (item) => (item.textContent ?? '').trim() === label,
    )
    expect(el, `section header "${label}"`).toBeTruthy()
    return el as HTMLElement
  }

  it('ArrowDown enters the collection at the grouping toggle and walks DOM order — toggle → Managed header', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = kbFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    // Pointer-open leaves focus on the menu content itself; the first
    // ArrowDown enters the roving collection at its FIRST item — the
    // grouping toggle (the search input is not an item and is skipped).
    await pressKey(menu, 'ArrowDown')
    // Grouped mode is on, so the toggle advertises the flat switch.
    const toggle = menu.querySelector<HTMLElement>('[role="menuitem"][title="Show flat list"]')!
    expect(document.activeElement).toBe(toggle)

    // Next in DOM order: the Managed section header — previously a plain
    // button the arrows skipped entirely (Tab is prevented inside the menu).
    await pressKey(toggle, 'ArrowDown')
    expect(document.activeElement).toBe(headerItem(menu, 'Managed'))
  })

  it('Enter on the grouping toggle flips the mode without closing the menu', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = kbFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    await pressKey(menu, 'ArrowDown')
    await pressKey(document.activeElement!, 'Enter')

    // The menu is still open and the display mode flipped to flat.
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(useUIStore.getState().sessionListGrouped).toBe(false)
    expect(menuText(menu)).not.toContain('feat-a')
    expect(menuText(menu)).toContain('Checkout one')
  })

  it('Enter on the Managed header collapses and re-expands the section — the menu stays open', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = kbFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    // toggle → Managed header, then Enter to collapse.
    await pressKey(menu, 'ArrowDown')
    await pressKey(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(headerItem(menu, 'Managed'))
    await pressKey(document.activeElement!, 'Enter')

    expect(headerItem(menu, 'Managed').getAttribute('aria-expanded')).toBe('false')
    expect(menuText(menu)).not.toContain('Feat A one')
    // The Local section is untouched and the menu is still open.
    expect(menuText(menu)).toContain('Checkout one')
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()

    // Enter again — the section re-expands (focus persisted through the
    // header's in-place re-render).
    await pressKey(document.activeElement!, 'Enter')
    expect(menuText(menu)).toContain('Feat A one')
  })

  it('a branch group collapsed with the mouse is reachable and re-expandable from the keyboard', async () => {
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = kbFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    // Mouse: collapse feat-a.
    await click(branchToggle(menu, 'feat-a'))
    expect(menuText(menu)).not.toContain('Feat A one')

    // Keyboard: toggle → Managed header → feat-a toggle (the collapsed row
    // keeps its registered toggle and "+"), then Enter re-expands.
    await pressKey(menu, 'ArrowDown')
    await pressKey(document.activeElement!, 'ArrowDown')
    await pressKey(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(branchToggle(menu, 'feat-a'))
    await pressKey(document.activeElement!, 'Enter')

    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(menuText(menu)).toContain('Feat A one')
    expect(menuText(menu)).toContain('Feat A two')
  })

  it('Enter on a branch "+" arms the branch draft and closes the menu', async () => {
    // The real stores behind the branch-draft flow.
    useProjectStore.setState({ activeProjectId: 'proj-1', projects: [makeProject()] })
    useSessionDraftStore.getState().clearDraft()
    useUIStore.setState({ sessionListGrouped: true })
    sessionMocks.sessions = kbFixture()
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    // toggle → Managed header → feat-a toggle → feat-a "+".
    await pressKey(menu, 'ArrowDown')
    for (let i = 0; i < 3; i++) {
      await pressKey(document.activeElement!, 'ArrowDown')
    }
    expect(document.activeElement?.getAttribute('title')).toBe('New session in this worktree (feat-a)')
    await pressKey(document.activeElement!, 'Enter')

    // The "+" select is NOT prevented — Radix's default close fires (and the
    // onOpenChange path clears the search).
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(useSessionDraftStore.getState().draft?.workspace).toEqual({
      kind: 'branch',
      branch: 'feat-a',
      createBranch: false,
      startPoint: '',
    })
    // The active selection was cleared (draft and selection are mutually
    // exclusive — same contract as the click path).
    expect(sessionMocks.selectSession).toHaveBeenCalledWith(null)
  })
})
