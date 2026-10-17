// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Mock the stores with minimal state the component selects.
const { updateMessage, clearPendingSuggestion, acceptGoalSuggestion, declineGoalSuggestion } = vi.hoisted(() => ({
  updateMessage: vi.fn(),
  clearPendingSuggestion: vi.fn(),
  acceptGoalSuggestion: vi.fn(async () => {}),
  declineGoalSuggestion: vi.fn(async () => {}),
}))
vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({ updateMessage }),
  },
}))
vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { activeSessionId: string | null }) => unknown) =>
    selector({ activeSessionId: 'sess-1' }),
}))
vi.mock('@/stores/goalStore', () => ({
  useGoalStore: {
    getState: () => ({ clearPendingSuggestion }),
  },
}))

// Mock the api so no real Wails binding is touched. The component imports
// { goal } from '@/api' (the index re-export), so mock that module.
vi.mock('@/api', () => ({
  goal: { acceptGoalSuggestion, declineGoalSuggestion },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { GoalSuggestionPanel } from './GoalSuggestionPanel'
import type { DisplayItem } from '@/types/messages'

type GoalSuggestionItem = Extract<DisplayItem, { kind: 'goal_suggestion' }>

function makeItem(opts: { requestId?: string; reason?: string; metadata?: Record<string, unknown> }): GoalSuggestionItem {
  return {
    kind: 'goal_suggestion',
    message: {
      id: 'msg-1',
      sessionId: 'sess-1',
      type: 'goal_suggestion',
      content: opts.reason ?? '',
      metadata: { request_id: opts.requestId ?? 'req-1', ...(opts.metadata ?? {}) },
      timestamp: 1,
    },
    reason: opts.reason ?? 'Запрос описывает многошаговую задачу с проверяемым критерием',
  }
}

describe('GoalSuggestionPanel', () => {
  let root: Root
  let container: HTMLDivElement

  function render(item: GoalSuggestionItem): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(<GoalSuggestionPanel item={item} />)
    })
  }

  it('renders the reason and both decision buttons for a pending suggestion', () => {
    render(makeItem({}))
    expect(container.textContent).toContain('Запрос описывает многошаговую задачу')
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim())
    expect(buttons).toEqual(['Enable goal mode', 'Run as usual'])
  })

  it('accept calls goal.acceptGoalSuggestion with the session and request ids and marks resolved', async () => {
    render(makeItem({ requestId: 'req-9' }))
    const accept = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Enable goal mode')!
    await act(async () => {
      accept.click()
    })
    expect(acceptGoalSuggestion).toHaveBeenCalledWith('sess-1', 'req-9')
    expect(updateMessage).toHaveBeenCalledWith('sess-1', 'msg-1', {
      metadata: expect.objectContaining({ resolved: true, decision: 'accept' }),
    })
    expect(clearPendingSuggestion).toHaveBeenCalledWith('sess-1')
  })

  it('decline calls goal.declineGoalSuggestion and marks resolved', async () => {
    render(makeItem({ requestId: 'req-9' }))
    const decline = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Run as usual')!
    await act(async () => {
      decline.click()
    })
    expect(declineGoalSuggestion).toHaveBeenCalledWith('sess-1', 'req-9')
    expect(updateMessage).toHaveBeenCalledWith('sess-1', 'msg-1', {
      metadata: expect.objectContaining({ resolved: true, decision: 'decline' }),
    })
  })

  it('renders the settled accept card without buttons once decided', () => {
    render(makeItem({ metadata: { resolved: true, decision: 'accept' } }))
    expect(container.textContent).toContain('Goal mode enabled')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('renders the settled decline card without buttons once decided', () => {
    render(makeItem({ metadata: { resolved: true, decision: 'decline' } }))
    expect(container.textContent).toContain('Declined')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
