// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { SubAgentBlock } from './SubAgentBlock'
import { BookmarkableContext } from './BookmarkableContext'
import type { DisplayItem } from '@/types/messages'

type SubAgentItem = Extract<DisplayItem, { kind: 'subagent' }>

function makeSub(overrides: Partial<SubAgentItem> = {}): SubAgentItem {
  return {
    kind: 'subagent',
    id: 'sub-1',
    stepId: 'del_1',
    title: 'Research topic',
    status: 'running',
    children: [],
    ...overrides,
  }
}

const CHILD: DisplayItem = { kind: 'memory_read', id: 'mem-1', content: 'BODY_MARKER' }

describe('SubAgentBlock', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.replaceChildren(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    document.body.replaceChildren()
  })

  const render = (item: SubAgentItem) =>
    act(() => {
      root.render(
        <BookmarkableContext.Provider value={false}>
          <SubAgentBlock item={item} />
        </BookmarkableContext.Provider>,
      )
    })

  const state = () =>
    container.querySelector('[data-slot="collapsible-content"]')?.getAttribute('data-state')
  const trigger = () => container.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement

  it('renders collapsed by default while running', () => {
    render(makeSub({ status: 'running', children: [CHILD] }))
    expect(state()).toBe('closed')
  })

  it('renders collapsed by default once completed', () => {
    render(makeSub({ status: 'completed', duration: 1200, children: [CHILD] }))
    expect(state()).toBe('closed')
  })

  it('expands its body when the user clicks the header', () => {
    render(makeSub({ status: 'completed', children: [CHILD] }))
    act(() => {
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(state()).toBe('open')
  })
})
