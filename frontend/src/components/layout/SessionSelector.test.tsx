// @vitest-environment jsdom
//
// SessionSelector grouped-by-branch mode (uiStore.sessionListGrouped):
//
// - the header List⇄GitBranch toggle flips the mode without dismissing the menu;
// - grouped mode renders Managed → branch rows (GitBranch icon + chevron +
//   branch name) → member sessions, then Local → sessions; section headers
//   appear only when BOTH sections are non-empty (a lone Local section is the
//   flat view);
// - a branch-header click collapses/expands its group (ephemeral state) and
//   NEVER closes the dropdown;
// - an active search force-expands every group and hides empty ones;
// - the Archived section behaves exactly as before in both modes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

async function openMenu(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector('button')!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 10))
  })
  const menu = document.body.querySelector('[role="menu"]')
  expect(menu).not.toBeNull()
  return menu as HTMLElement
}

/** Plain header button of a managed branch group — found by its branch name. */
function branchButton(menu: HTMLElement, branch: string): HTMLButtonElement {
  const btn = Array.from(menu.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(branch),
  )
  expect(btn, `branch header button for "${branch}"`).toBeTruthy()
  return btn as HTMLButtonElement
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
    const toggle = menu.querySelector<HTMLButtonElement>('button[title="Group sessions by branch"]')
    expect(toggle).not.toBeNull()
    expect(useUIStore.getState().sessionListGrouped).toBe(false)
    void container
  })
})

describe('SessionSelector — mode toggle', () => {
  it('toggling switches to grouped mode without closing the menu', async () => {
    sessionMocks.sessions = [
      makeSession({ id: 'm1', name: 'Feat A one', workspace_binding: managedBinding('feat-a') }),
      makeSession({ id: 'l1', name: 'Checkout work' }),
    ]
    const container = await render(<SessionSelector />)
    const menu = await openMenu(container)

    await click(menu.querySelector<HTMLButtonElement>('button[title="Group sessions by branch"]')!)

    // The menu is still open and now renders the branch group.
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(useUIStore.getState().sessionListGrouped).toBe(true)
    expect(menuText(menu)).toContain('feat-a')
    // The toggle now advertises the way back.
    expect(menu.querySelector('button[title="Show flat list"]')).not.toBeNull()
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

    await click(menu.querySelector<HTMLButtonElement>('button[title="Show flat list"]')!)

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
      expect(branchButton(menu, branch).querySelector('svg')).not.toBeNull()
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
    const branchHeaders = Array.from(menu.querySelectorAll('button')).filter((b) =>
      b.querySelector('svg.lucide-git-branch'),
    )
    expect(branchHeaders).toHaveLength(0)
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
    await click(branchButton(menu, 'feat-a'))
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(menuText(menu)).not.toContain('Feat A one')
    expect(menuText(menu)).not.toContain('Feat A two')
    // Sibling content (local section) is untouched.
    expect(menuText(menu)).toContain('Checkout work')

    // Expand again.
    await click(branchButton(menu, 'feat-a'))
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(menuText(menu)).toContain('Feat A one')
    expect(menuText(menu)).toContain('Feat A two')
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
    await click(branchButton(menu, 'feat-a'))
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

    await click(Array.from(menu.querySelectorAll('button')).find((b) => b.textContent?.includes('Archived'))!)
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(menuText(menu)).toContain('Old archived')
  })
})
