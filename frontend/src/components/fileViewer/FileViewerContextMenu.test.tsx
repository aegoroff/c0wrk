// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Mock the Zustand stores so the component's handlers reach into controlled
// fakes instead of the real persisted stores (which crash under jsdom when
// `window.localStorage` is undefined). Only the surface the component uses is
// surfaced; the hooks-based `useInputModeStore` is mocked below. The vector
// mock doubles as both the selector-hook target (the component subscribes to
// `status.state`) and the getState() source for handleFindSimilar.
const vectorMock = vi.hoisted(() => ({
  status: { state: 'ready' as string },
  setQuery: vi.fn(),
}))
const uiMock = vi.hoisted(() => ({
  setWorkspaceTab: vi.fn(),
}))
const inputMock = vi.hoisted(() => ({
  insertTextIntoInput: vi.fn(),
}))
const projectMock = vi.hoisted(() => ({
  activeProjectId: 'p1' as string | null,
}))

vi.mock('@/stores/vectorIndexStore', () => ({
  useVectorIndexStore: Object.assign(
    (selector: (s: typeof vectorMock) => unknown) => selector(vectorMock),
    { getState: () => vectorMock },
  ),
}))
vi.mock('@/stores/uiStore', () => ({
  useUIStore: { getState: () => uiMock },
}))
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: { getState: () => projectMock },
}))
vi.mock('@/stores/inputModeStore', () => ({
  useInputModeStore: (selector: (s: { insertTextIntoInput: typeof inputMock.insertTextIntoInput }) => unknown) =>
    selector(inputMock),
}))

// Indexing master switch double — driven directly per test; the real hook
// (GetConfig hydration + retries) is covered by useIndexingSettings.test.ts.
const indexingGate = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/hooks/useIndexingSettings', () => ({
  useIndexingSettings: () => indexingGate.enabled,
}))

import { FileViewerContextMenu } from './FileViewerContextMenu'

describe('FileViewerContextMenu', () => {
  let container: HTMLElement
  let root: Root
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onClose = vi.fn()
    indexingGate.enabled = true
    vectorMock.status = { state: 'ready' }
    vectorMock.setQuery.mockClear()
    uiMock.setWorkspaceTab.mockClear()
    inputMock.insertTextIntoInput.mockClear()
    container = document.createElement('div')
    document.body.replaceChildren(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  function renderMenu(
    reference: string,
    selectedText: string,
    position: { x: number; y: number } | null = { x: 10, y: 10 },
  ) {
    act(() => {
      root.render(
        <FileViewerContextMenu
          reference={reference}
          selectedText={selectedText}
          position={position}
          onClose={onClose as () => void}
        />,
      )
    })
  }

  function menuItem(label: string): HTMLButtonElement {
    const items = Array.from(container.querySelectorAll('[role="menuitem"]'))
    const match = items.find((b) => b.textContent?.trim() === label)
    if (!match) throw new Error(`menu item "${label}" not rendered`)
    return match as HTMLButtonElement
  }

  it('renders nothing when position is null', () => {
    renderMenu('@foo.go#L1', 'code', null)
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('renders both Add to chat and Find similar items', () => {
    renderMenu('@foo.go#L1', 'code')
    expect(() => menuItem('Add to chat')).not.toThrow()
    expect(() => menuItem('Find similar')).not.toThrow()
  })

  it('Add to chat inserts the reference into the input', async () => {
    renderMenu('@foo.go#L1-5', 'code')
    await act(async () => {
      menuItem('Add to chat').click()
      await Promise.resolve()
    })
    expect(inputMock.insertTextIntoInput).toHaveBeenCalledTimes(1)
    expect(inputMock.insertTextIntoInput).toHaveBeenCalledWith('@foo.go#L1-5')
    expect(onClose).toHaveBeenCalled()
  })

  it('Find similar seeds the vector query and switches to the semantics tab', async () => {
    renderMenu('@foo.go#L1', '  func foo() {}  ')
    await act(async () => {
      menuItem('Find similar').click()
      await Promise.resolve()
    })
    // The selection is trimmed before seeding the query.
    expect(vectorMock.setQuery).toHaveBeenCalledTimes(1)
    expect(vectorMock.setQuery).toHaveBeenCalledWith('func foo() {}')
    expect(uiMock.setWorkspaceTab).toHaveBeenCalledWith('p1', 'semantics')
    expect(onClose).toHaveBeenCalled()
  })

  it('Find similar is a no-op when the selection is blank', async () => {
    renderMenu('@foo.go#L1', '   ')
    await act(async () => {
      menuItem('Find similar').click()
      await Promise.resolve()
    })
    expect(vectorMock.setQuery).not.toHaveBeenCalled()
    expect(uiMock.setWorkspaceTab).not.toHaveBeenCalled()
    // Still closes the menu.
    expect(onClose).toHaveBeenCalled()
  })

  it('Find similar is disabled WITH a state title hint while the index is not ready', async () => {
    vectorMock.status = { state: 'indexing' }
    renderMenu('@foo.go#L1', 'func foo() {}')
    const item = menuItem('Find similar')
    expect(item.getAttribute('aria-disabled')).toBe('true')
    // The disabled state carries an informational title naming the blocker —
    // the live vector-index state (per specs/domains/frontend/
    // button-tooltips.md, an info title on a menuitem is the blessed pattern;
    // it is not an echo of the visible label).
    expect(item.getAttribute('title')).toBe(
      'Find similar is unavailable — the vector index is indexing',
    )
    await act(async () => {
      item.click()
      await Promise.resolve()
    })
    // True no-op: no query seeded, no tab switch, menu stays open.
    expect(vectorMock.setQuery).not.toHaveBeenCalled()
    expect(uiMock.setWorkspaceTab).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Find similar carries no aria-disabled and no title when the index is ready', () => {
    renderMenu('@foo.go#L1', 'code')
    const item = menuItem('Find similar')
    expect(item.hasAttribute('aria-disabled')).toBe(false)
    expect(item.hasAttribute('title')).toBe(false)
  })

  it('hides Find similar (divider included) while indexing is disabled — only Add to chat remains', () => {
    indexingGate.enabled = false
    renderMenu('@foo.go#L1', 'func foo() {}')

    // Exactly one menuitem renders — "Add to chat"...
    const items = container.querySelectorAll('[role="menuitem"]')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent?.trim()).toBe('Add to chat')
    // ...and no "Find similar" text or divider (the divider only separates
    // the two entries, so it hides with the gated entry).
    expect(container.textContent ?? '').not.toContain('Find similar')
    expect(container.querySelector('.h-px.bg-border')).toBeNull()
  })

  it('shows Find similar again once indexing is (re-)enabled', () => {
    indexingGate.enabled = false
    renderMenu('@foo.go#L1', 'code')
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(1)

    indexingGate.enabled = true
    renderMenu('@foo.go#L1', 'code')

    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(2)
    expect(() => menuItem('Find similar')).not.toThrow()
  })
})
