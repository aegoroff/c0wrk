// @vitest-environment jsdom
//
// Tests for the Execution State panel: renders Σₜ (checklist with
// checked/unchecked states, key fields, turn/max counter, status badge),
// updates on every store change, collapses, and renders nothing for a
// non-E2S (snapshot-less / inactive) session.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'

import { ExecutionStatePanel } from './ExecutionStatePanel'
import { useE2SStore } from '@/stores/e2sStore'
import type { E2SStateData } from '@/types/events'

const SESSION = 'sess-1'

function applyEvent(data: E2SStateData): void {
  act(() => {
    useE2SStore.getState().applySnapshot(SESSION, data)
  })
}

let root: Root | null = null

function render(el: ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(el)
  })
  return container
}

beforeEach(() => {
  useE2SStore.getState().clearAll()
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
})

describe('ExecutionStatePanel', () => {
  it('renders nothing without a snapshot', () => {
    const container = render(<ExecutionStatePanel sessionId={SESSION} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the snapshot is inactive', () => {
    act(() => {
      useE2SStore.setState({
        snapshots: { [SESSION]: { state: {}, turn: 0, status: 'running', maxSteps: 5, active: false } },
      })
    })
    const container = render(<ExecutionStatePanel sessionId={SESSION} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders the header: title, turn/max counter, and status badge', () => {
    applyEvent({ state: { objective: 'obj' }, turn: 3, max_turns: 10, status: 'running' })
    const container = render(<ExecutionStatePanel sessionId={SESSION} />)
    expect(container.textContent).toContain('Execution state')
    expect(container.textContent).toContain('turn 3/10')
    const badge = container.querySelector('[data-status="running"]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toContain('running')
  })

  it('renders the bare turn counter for an unbudgeted run (minimal backend payload)', () => {
    // {state, turn} only: no max_turns → "turn 2" (never "turn 2/0"), and the
    // badge falls back to the Σ status key.
    applyEvent({ state: { objective: 'obj', status: 'active' }, turn: 2 })
    const container = render(<ExecutionStatePanel sessionId={SESSION} />)
    expect(container.textContent).toContain('turn 2')
    expect(container.textContent).not.toContain('turn 2/')
    expect(container.querySelector('[data-status="active"]')).not.toBeNull()
  })

  it('renders the Σ checklist with checked and unchecked items', () => {
    applyEvent({
      state: {
        checklist: [
          { text: 'write the store', checked: true },
          { text: 'write the panel', checked: false },
        ],
      },
      turn: 1,
      max_turns: 5,
      status: 'running',
    })
    const container = render(<ExecutionStatePanel sessionId={SESSION} />)
    expect(container.textContent).toContain('write the store')
    expect(container.textContent).toContain('write the panel')
    expect(container.querySelector('[aria-label="checked"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="unchecked"]')).not.toBeNull()
  })

  it('renders the key Σ fields', () => {
    applyEvent({
      state: {
        objective: 'Ship the E2S panel',
        status: 'verifying',
        files_touched: ['frontend/src/stores/e2sStore.ts', 'frontend/src/components/chat/ExecutionStatePanel.tsx'],
        findings: ['goal events are the closest pattern'],
        decisions: ['store owns the patch merge'],
        next_steps: ['add tests'],
      },
      turn: 2,
      max_turns: 8,
      status: 'running',
    })
    const container = render(<ExecutionStatePanel sessionId={SESSION} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Ship the E2S panel')
    expect(text).toContain('verifying')
    expect(text).toContain('frontend/src/stores/e2sStore.ts')
    expect(text).toContain('frontend/src/components/chat/ExecutionStatePanel.tsx')
    expect(text).toContain('goal events are the closest pattern')
    expect(text).toContain('store owns the patch merge')
    expect(text).toContain('add tests')
    // Section labels present.
    expect(text).toContain('Objective')
    expect(text).toContain('Files touched')
    expect(text).toContain('Findings')
    expect(text).toContain('Decisions')
    expect(text).toContain('Next steps')
  })

  it('updates on every step (re-renders from store changes)', () => {
    applyEvent({
      state: { checklist: [{ text: 'first step', checked: false }] },
      turn: 1,
      max_turns: 4,
      status: 'running',
    })
    const container = render(<ExecutionStatePanel sessionId={SESSION} />)
    expect(container.textContent).toContain('turn 1/4')

    applyEvent({
      state: { checklist: [{ text: 'first step', checked: true }] },
      turn: 2,
      max_turns: 4,
      status: 'running',
      patch: true,
    })
    expect(container.textContent).toContain('turn 2/4')
    expect(container.querySelector('[aria-label="checked"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="unchecked"]')).toBeNull()

    applyEvent({ state: {}, turn: 4, max_turns: 4, status: 'done', patch: true })
    expect(container.textContent).toContain('turn 4/4')
    expect(container.querySelector('[data-status="done"]')).not.toBeNull()
  })

  it('collapses and expands via the header button', () => {
    applyEvent({ state: { objective: 'obj' }, turn: 1, max_turns: 5, status: 'running' })
    const container = render(<ExecutionStatePanel sessionId={SESSION} />)
    // Default open — the body with the objective is visible.
    expect(container.textContent).toContain('Objective')

    const header = container.querySelector('button')
    expect(header).not.toBeNull()
    act(() => {
      header!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).not.toContain('Objective')

    act(() => {
      header!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Objective')
  })

  it('renders only per-session state (other sessions do not leak)', () => {
    act(() => {
      useE2SStore.getState().applySnapshot('other-session', {
        state: { objective: 'OTHER' },
        turn: 9,
        max_turns: 9,
        status: 'done',
      })
    })
    applyEvent({ state: { objective: 'MINE' }, turn: 1, max_turns: 2, status: 'running' })
    const container = render(<ExecutionStatePanel sessionId={SESSION} />)
    expect(container.textContent).toContain('MINE')
    expect(container.textContent).not.toContain('OTHER')
  })
})
