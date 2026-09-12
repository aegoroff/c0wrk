// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useE2SStore, useE2SSnapshot, useE2SActive } from './e2sStore'
import type { E2SStateData } from '@/types/events'

function makeEvent(overrides: Partial<E2SStateData> = {}): E2SStateData {
  return {
    state: { objective: 'ship it', checklist: [{ text: 'step 1', checked: false }] },
    turn: 1,
    max_turns: 8,
    status: 'running',
    ...overrides,
  }
}

describe('e2sStore', () => {
  beforeEach(() => {
    useE2SStore.getState().clearAll()
  })

  it('applies a full snapshot: entry created, active, maxSteps mirrored from max_turns', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent())
    const snap = useE2SStore.getState().snapshots['s1']
    expect(snap).toBeDefined()
    expect(snap).toMatchObject({
      turn: 1,
      status: 'running',
      maxSteps: 8,
      active: true,
    })
    expect(snap?.state.objective).toBe('ship it')
  })

  it('keeps sessions isolated (per-session snapshots)', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent({ status: 'running' }))
    useE2SStore.getState().applySnapshot('s2', makeEvent({ status: 'done', turn: 5 }))
    const snapshots = useE2SStore.getState().snapshots
    expect(snapshots['s1']?.status).toBe('running')
    expect(snapshots['s2']?.status).toBe('done')
    expect(snapshots['s2']?.turn).toBe(5)
  })

  it('replaces the Σ on a subsequent full snapshot', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent())
    useE2SStore.getState().applySnapshot('s1', makeEvent({
      turn: 2,
      state: { objective: 'replaced', checklist: [{ text: 'step 1', checked: true }] },
    }))
    const snap = useE2SStore.getState().snapshots['s1']
    expect(snap?.turn).toBe(2)
    expect(snap?.state.objective).toBe('replaced')
    expect(snap?.state.checklist?.[0]?.checked).toBe(true)
  })

  it('merges a patch over the previous Σ (absent fields keep their value)', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent({
      state: {
        objective: 'original objective',
        files_touched: ['a.ts'],
        checklist: [{ text: 'step 1', checked: false }, { text: 'step 2', checked: false }],
      },
    }))
    useE2SStore.getState().applySnapshot('s1', makeEvent({
      turn: 2,
      patch: true,
      state: { checklist: [{ text: 'step 1', checked: true }, { text: 'step 2', checked: true }] },
    }))
    const snap = useE2SStore.getState().snapshots['s1']
    // Patched slice replaced…
    expect(snap?.state.checklist?.every((i) => i.checked)).toBe(true)
    // …unmentioned fields retained.
    expect(snap?.state.objective).toBe('original objective')
    expect(snap?.state.files_touched).toEqual(['a.ts'])
    // Telemetry always replaced.
    expect(snap?.turn).toBe(2)
  })

  it('treats a patch with no previous snapshot as a full state', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent({ patch: true, state: { objective: 'solo' } }))
    const snap = useE2SStore.getState().snapshots['s1']
    expect(snap?.state.objective).toBe('solo')
    expect(snap?.active).toBe(true)
  })

  it('retains the turn cap when a patch omits max_turns (telemetry, not Σ)', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent({ max_turns: 12 }))
    useE2SStore.getState().applySnapshot('s1', makeEvent({
      patch: true,
      max_turns: undefined,
      state: { status: 'active' },
    }))
    expect(useE2SStore.getState().snapshots['s1']?.maxSteps).toBe(12)
  })

  it('preserves extension keys and applies null tombstones on a patch merge', () => {
    // A patch slice must not silently drop extension keys the model added, and
    // a JSON null tombstone must delete an extension key — mirroring the
    // domain merge operator (core/e2s/merge.go).
    useE2SStore.getState().applySnapshot('s1', {
      state: { objective: 'o', scratch_note: 'keep me', scratch_dead: 'delete me' },
      turn: 1,
    })
    useE2SStore.getState().applySnapshot('s1', {
      patch: true,
      state: { scratch_note: 'updated', scratch_dead: null },
      turn: 2,
    })
    const state = useE2SStore.getState().snapshots['s1']?.state
    expect(state?.scratch_note).toBe('updated')
    expect(state !== undefined && 'scratch_dead' in state).toBe(false)
    // Untouched fields survive.
    expect(state?.objective).toBe('o')
  })

  it('falls back to Σ.status and unbudgeted maxSteps for a minimal payload', () => {
    // A payload without the top-level telemetry: the snapshot's status comes
    // from the Σ status key and maxSteps stays 0 (unbudgeted).
    useE2SStore.getState().applySnapshot('s1', {
      state: { objective: 'o', status: 'active' },
      turn: 2,
    })
    const snap = useE2SStore.getState().snapshots['s1']
    expect(snap?.status).toBe('active')
    expect(snap?.maxSteps).toBe(0)
    expect(snap?.turn).toBe(2)
  })

  it('prefers the top-level status/max_turns when present (forward contract)', () => {
    useE2SStore.getState().applySnapshot('s1', {
      state: { objective: 'o', status: 'active' },
      turn: 2,
      status: 'running',
      max_turns: 9,
    })
    const snap = useE2SStore.getState().snapshots['s1']
    expect(snap?.status).toBe('running')
    expect(snap?.maxSteps).toBe(9)
  })

  it('clearSession removes only the targeted entry', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent())
    useE2SStore.getState().applySnapshot('s2', makeEvent())
    useE2SStore.getState().clearSession('s1')
    const snapshots = useE2SStore.getState().snapshots
    expect(snapshots['s1']).toBeUndefined()
    expect(snapshots['s2']).toBeDefined()
  })

  it('clearSession is a no-op for an unknown session (state identity preserved)', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent())
    const before = useE2SStore.getState()
    useE2SStore.getState().clearSession('unknown')
    expect(useE2SStore.getState()).toBe(before)
  })

  it('dropSessions removes several entries in one update and leaves others intact', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent())
    useE2SStore.getState().applySnapshot('s2', makeEvent())
    useE2SStore.getState().applySnapshot('s3', makeEvent())
    useE2SStore.getState().dropSessions(['s1', 's3'])
    const snapshots = useE2SStore.getState().snapshots
    expect(snapshots['s1']).toBeUndefined()
    expect(snapshots['s3']).toBeUndefined()
    expect(snapshots['s2']).toBeDefined()
  })

  it('dropSessions is a no-op for an all-unknown batch (state identity preserved)', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent())
    const before = useE2SStore.getState()
    useE2SStore.getState().dropSessions(['unknown-a', 'unknown-b'])
    expect(useE2SStore.getState()).toBe(before)
  })

  it('clearAll empties every snapshot', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent())
    useE2SStore.getState().applySnapshot('s2', makeEvent())
    useE2SStore.getState().clearAll()
    expect(useE2SStore.getState().snapshots).toEqual({})
  })
})

describe('e2sStore selectors', () => {
  // Harness pattern (see useActionEvents.test.ts): render the selector hooks
  // through a minimal component and capture their results per render.
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  const seen: unknown[] = []
  const last = (): unknown => seen[seen.length - 1]

  function renderHarness(id: string | null, hook: (s: string | null) => unknown): void {
    // Unmount any previous harness instance first: root/container are shared
    // module-level vars, so without this the earlier root would leak into
    // document.body (afterEach could only unmount the last one).
    if (root) {
      act(() => {
        root!.unmount()
      })
      root = null
    }
    container?.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root!.render(createElement(function Harness(): null {
        seen.push(hook(id))
        return null
      }))
    })
  }

  beforeEach(() => {
    useE2SStore.getState().clearAll()
    seen.length = 0
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    container?.remove()
    container = null
  })

  it('useE2SSnapshot returns the direct store reference (no allocation)', () => {
    useE2SStore.getState().applySnapshot('s1', makeEvent())
    const stored = useE2SStore.getState().snapshots['s1']
    renderHarness('s1', useE2SSnapshot)
    // The hook returned the exact stored entry object — a direct reference,
    // not a copy (React 19 snapshot stability contract).
    expect(last()).toBe(stored)
  })

  it('useE2SSnapshot returns undefined for null session or unknown id', () => {
    renderHarness(null, useE2SSnapshot)
    expect(last()).toBeUndefined()
    renderHarness('nope', useE2SSnapshot)
    expect(last()).toBeUndefined()
  })

  it('useE2SActive returns a boolean primitive and tracks the snapshot', () => {
    renderHarness('s1', useE2SActive)
    expect(last()).toBe(false)
    act(() => {
      useE2SStore.getState().applySnapshot('s1', makeEvent())
    })
    expect(last()).toBe(true)
    expect(typeof last()).toBe('boolean')
  })
})
