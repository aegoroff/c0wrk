// @vitest-environment jsdom
// Tests for useE2SStateEvents — the e2s_state subscription. Valid payloads
// reach the e2s store (a full Σ snapshot); malformed payloads are
// dropped at the boundary via reportDroppedEvent; switching the session away
// unsubscribes AND clears the outgoing session's snapshot (live-only stream).
//
// Follows the createRoot + jsdom harness pattern (see useActionEvents.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useE2SStateEvents } from '@/hooks/events/useE2SStateEvents'
import { useE2SStore } from '@/stores/e2sStore'

const runtimeHandlers = vi.hoisted(() => new Map<string, Array<(data: unknown) => void>>())
const reportDroppedEventMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/runtime', () => ({
  onSessionEvent: (_sessionId: string, event: string, cb: (data: unknown) => void) => {
    const list = runtimeHandlers.get(event) ?? []
    list.push(cb)
    runtimeHandlers.set(event, list)
    return () => {
      runtimeHandlers.set(event, (runtimeHandlers.get(event) ?? []).filter(fn => fn !== cb))
    }
  },
  reportDroppedEvent: reportDroppedEventMock,
}))

const SESSION = 'sess-e2s'

let container: HTMLDivElement
let root: Root

function Harness({ sessionId }: { sessionId: string }): null {
  useE2SStateEvents(sessionId)
  return null
}

function emit(event: string, data: unknown): void {
  act(() => {
    for (const cb of runtimeHandlers.get(event) ?? []) {
      cb(data)
    }
  })
}

beforeEach(() => {
  useE2SStore.getState().clearAll()
  reportDroppedEventMock.mockClear()
  runtimeHandlers.clear()

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(createElement(Harness, { sessionId: SESSION }))
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('useE2SStateEvents', () => {
  it('writes a valid full snapshot into the e2s store', () => {
    emit('e2s_state', {
      state: { objective: 'o', checklist: [{ text: 'a', checked: true }] },
      turn: 1,
      max_turns: 6,
      status: 'running',
    })
    const snap = useE2SStore.getState().snapshots[SESSION]
    expect(snap).toBeDefined()
    expect(snap?.turn).toBe(1)
    expect(snap?.maxSteps).toBe(6)
    expect(snap?.status).toBe('running')
    expect(snap?.active).toBe(true)
    expect(reportDroppedEventMock).not.toHaveBeenCalled()
  })

  it('accepts a minimal backend payload (no max_turns/status)', () => {
    // An older/partial emitter payload without the top-level telemetry — the
    // guard must not drop it (the store falls back to Σ.status and 0 maxSteps).
    emit('e2s_state', { state: { objective: 'minimal', status: 'active' }, turn: 1 })
    const snap = useE2SStore.getState().snapshots[SESSION]
    expect(snap).toBeDefined()
    expect(snap?.status).toBe('active')
    expect(snap?.maxSteps).toBe(0)
    expect(reportDroppedEventMock).not.toHaveBeenCalled()
  })

  it('replaces the Σ outright on every snapshot (the backend owns the merge)', () => {
    // The backend emitter always sends the FULL Σ (core/e2s emitState);
    // the store keeps only the latest — a second snapshot replaces the
    // first instead of being merged over it.
    emit('e2s_state', {
      state: { objective: 'original', findings: ['f1'] },
      turn: 1,
      max_turns: 6,
      status: 'running',
    })
    emit('e2s_state', {
      state: { objective: 'original', findings: ['f1', 'f2'] },
      turn: 2,
      max_turns: 6,
      status: 'running',
    })
    const snap = useE2SStore.getState().snapshots[SESSION]
    expect(snap?.state.objective).toBe('original')
    expect(snap?.state.findings).toEqual(['f1', 'f2'])
    expect(snap?.turn).toBe(2)
  })

  it('drops a malformed payload via reportDroppedEvent and leaves the store untouched', () => {
    emit('e2s_state', { state: { checklist: [{ text: 1 }] }, turn: 'x', status: 3 })
    expect(reportDroppedEventMock).toHaveBeenCalledTimes(1)
    expect(reportDroppedEventMock).toHaveBeenCalledWith('e2s_state', {
      state: { checklist: [{ text: 1 }] },
      turn: 'x',
      status: 3,
    })
    expect(useE2SStore.getState().snapshots[SESSION]).toBeUndefined()
  })

  it('drops non-object payloads (null/string)', () => {
    emit('e2s_state', null)
    emit('e2s_state', 'running')
    expect(reportDroppedEventMock).toHaveBeenCalledTimes(2)
    expect(useE2SStore.getState().snapshots[SESSION]).toBeUndefined()
  })

  it('clears the session snapshot on switch-away (live-only stream)', () => {
    emit('e2s_state', {
      state: { objective: 'o' },
      turn: 1,
      max_turns: 6,
      status: 'running',
    })
    expect(useE2SStore.getState().snapshots[SESSION]).toBeDefined()

    // Switch to another session — the outgoing session's snapshot is dropped.
    act(() => {
      root.render(createElement(Harness, { sessionId: 'sess-other' }))
    })
    expect(useE2SStore.getState().snapshots[SESSION]).toBeUndefined()

    // …and the new session's subscription is live for its own events.
    emit('e2s_state', { state: { objective: 'other' }, turn: 0, max_turns: 3, status: 'running' })
    expect(useE2SStore.getState().snapshots['sess-other']?.state.objective).toBe('other')
  })

  it('unsubscribes on unmount', () => {
    act(() => {
      root.unmount()
    })
    const before = (runtimeHandlers.get('e2s_state') ?? []).length
    emit('e2s_state', { state: {}, turn: 1, max_turns: 2, status: 'running' })
    expect((runtimeHandlers.get('e2s_state') ?? []).length).toBe(before)
    expect(useE2SStore.getState().snapshots[SESSION]).toBeUndefined()
  })
})
