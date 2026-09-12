// @vitest-environment jsdom
//
// Integration test: notification-sound COVERAGE across CHAT↔CODE mode toggles.
//
// A session's audible cues are owned by exactly one subscriber at a time:
//   - the ACTIVE session → useSoundEvents(activeSessionId) (App.tsx wires it
//     through useSessionEvents);
//   - every BACKGROUND session that is busy → useBackgroundSessionWatcher,
//     whose watched set is taskActive ∪ paused ∪ pausing ∪ snapshot
//     (unfinished_task_status ∈ {in_progress, paused}) MINUS the active id.
//
// The CHAT↔CODE toggle is a PROJECT switch (useProjectSwitchState.performSwitch):
// activeSessionId goes dest → null (resetForProjectSwitch) → dest across several
// RPC awaits, and the destination's taskActive flag is reset to false by
// useSessionEvents' reset effect, restored only by ChatArea's async
// fast-restore RPC. This test pins the invariant that the handoff NEVER leaves
// a genuinely-running session with no listener:
//
//   invariant: for every session X with a running backend task,
//              X === activeSessionId  OR  X ∈ watcher's watched set.
//
// The harness mounts the REAL hooks (useSoundEvents, useBackgroundSessionWatcher,
// useActiveSessionsRefresh) against the REAL zustand stores, a controllable
// fake Wails event bus, and verbatim replicas of the two effects the switch
// dance runs (the useSessionEvents reset effect and ChatArea's fast-restore —
// cited inline). The replicas exist only because mounting the full ChatArea /
// useSessionEvents composition would stub away the very wiring under test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useEffect } from 'react'

// ---------------------------------------------------------------------------
// Fake Wails event bus (@/api/runtime mock)
// ---------------------------------------------------------------------------

type Cb = (data: unknown) => void
const listeners = new Map<string, Set<Cb>>()

const onSessionEventMock = vi.fn((sessionId: string, event: string, callback: Cb) => {
  const name = `session:${sessionId}:${event}`
  let set = listeners.get(name)
  if (!set) {
    set = new Set()
    listeners.set(name, set)
  }
  set.add(callback)
  return () => {
    listeners.get(name)?.delete(callback)
  }
})

vi.mock('@/api/runtime', () => ({
  onSessionEvent: (...args: unknown[]) => onSessionEventMock(...(args as [string, string, Cb])),
  subscribe: () => () => {},
  emit: vi.fn(),
  reportDroppedEvent: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Sound engine mock — the cue is the observable.
// ---------------------------------------------------------------------------

const playSoundMock = vi.fn()
vi.mock('@/lib/sound', () => ({
  playSound: (...args: unknown[]) => playSoundMock(...args),
}))

// ---------------------------------------------------------------------------
// RPC mocks
// ---------------------------------------------------------------------------

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** getSessionRuntimeStatus per-session answers. Absent entry = never resolves
 *  (models an in-flight RPC that a rapid toggle cancels). */
const statusDeferreds = new Map<string, Deferred<{ active: boolean } | null>>()

const getSessionRuntimeStatusMock = vi.fn((sessionId: string) => {
  if (!statusDeferreds.has(sessionId)) statusDeferreds.set(sessionId, makeDeferred())
  return statusDeferreds.get(sessionId)!.promise
})

/** listAllSessions answer (activeSessionsStore snapshot). */
let listAllSessionsImpl: () => Promise<unknown[]> = async () => []

vi.mock('@/api/chat', () => ({
  getSessionRuntimeStatus: (sessionId: string) => getSessionRuntimeStatusMock(sessionId),
  getPendingActions: async () => null,
  getSessionTokens: async () => null,
  resolveStalePrompt: async () => undefined,
}))

const listAllSessionsMock = vi.fn(() => listAllSessionsImpl())
vi.mock('@/api/sessions', () => ({
  listAllSessions: () => listAllSessionsMock(),
}))

// ---------------------------------------------------------------------------
// REAL modules under test
// ---------------------------------------------------------------------------

import { useSessionStore } from '@/stores/sessionStore'
import { useChatStore } from '@/stores/chatStore'
import { usePlanStore } from '@/stores/planStore'
import { useActiveSessionsStore, cancelPendingRefresh } from '@/stores/activeSessionsStore'
import { useActiveSessionsRefresh } from '@/stores/activeSessionsStore'
import { useBackgroundSessionWatcher } from '@/hooks/useBackgroundSessionWatcher'
import { useSoundEvents } from '@/hooks/events/useSoundEvents'
import { useTaskFlagRestore } from '@/hooks/useTaskFlagRestore'

// ---------------------------------------------------------------------------
// Verbatim replicas of the two switch-dance effects
// ---------------------------------------------------------------------------

/**
 * useSessionEvents' reset effect (frontend/src/hooks/useSessionEvents.ts).
 * Since the fix it clears only the plan groups; the old taskActive=false
 * write was removed (it corrupted the live map on switch-TO — see the
 * citation in useSessionEvents.ts). The token RPC is a behavioral no-op for
 * coverage and omitted.
 */
function useResetEffectReplica(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return
    usePlanStore.setState({ planGroups: [] })
  }, [sessionId])
}

/** The App-root wiring under test: session events + background watcher +
 *  the snapshot loader, in the same composition as App.tsx. */
function Harness(): null {
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  useResetEffectReplica(activeSessionId)
  useTaskFlagRestore(activeSessionId)
  useSoundEvents(activeSessionId)
  useBackgroundSessionWatcher()
  useActiveSessionsRefresh()
  return null
}

// ---------------------------------------------------------------------------
// Bus helpers
// ---------------------------------------------------------------------------

function listenerCount(sessionId: string, event: string): number {
  return listeners.get(`session:${sessionId}:${event}`)?.size ?? 0
}

/** Emit a session event exactly like the Go emitter would. */
function emitSession(sessionId: string, event: string, data: unknown): void {
  for (const cb of listeners.get(`session:${sessionId}:${event}`) ?? []) cb(data)
}

// ---------------------------------------------------------------------------
// Switch-dance helpers (store-write sequence of performSwitch, cited)
// ---------------------------------------------------------------------------

/**
 * The store writes of useProjectSwitchState.performSwitch, in order:
 * resetForProjectSwitch() → (snapshot fast-path miss) → setActiveSessionId(dest)
 * across awaited RPCs. Each write gets its own act() commit so effects run
 * exactly as they do between the real awaits.
 */
async function toggleTo(destSessionId: string | null): Promise<void> {
  await act(async () => {
    useSessionStore.getState().resetForProjectSwitch()
  })
  await act(async () => {
    useSessionStore.getState().setActiveSessionId(destSessionId)
  })
}

function seedRunning(sessionId: string): void {
  act(() => {
    useChatStore.getState().setTaskActive(sessionId, true)
  })
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const A = 'sess-code-a'
const B = 'sess-chat-b'

function snapshotWith(sessions: Array<{ id: string; status: string }>): void {
  listAllSessionsImpl = async () =>
    sessions.map((s) => ({
      id: s.id,
      project_id: 'proj',
      name: s.id,
      created_at: '2026-01-01T00:00:00Z',
      last_active_at: '2026-01-01T00:00:00Z',
      archived: false,
      pinned: false,
      has_unfinished_task: s.status !== '',
      unfinished_task_status: s.status,
    }))
}

let root: Root | null = null
let container: HTMLElement | null = null

async function mountHarness(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    )
  })
}

async function unmountHarness(): Promise<void> {
  await act(async () => { root?.unmount() })
  container?.remove()
  root = null
  container = null
}

function resetStores(): void {
  useChatStore.setState({
    messages: {},
    messageOrder: {},
    streamingText: {},
    activityStatus: {},
    taskActive: {},
    paused: {},
    pausing: {},
    compacting: {},
    compactionAvailability: {},
    stepContextFill: {},
    sessionTokens: {},
    runtimeEventAt: {},
    taskFlagsEventAt: {},
  })
  useSessionStore.setState({ sessions: null, activeSessionId: null })
  useActiveSessionsStore.setState({ sessions: null, pendingOverride: {}, refreshing: false })
}

describe('sound coverage across CHAT↔CODE toggles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listeners.clear()
    statusDeferreds.clear()
    listAllSessionsImpl = async () => []
    resetStores()
    cancelPendingRefresh()
  })

  afterEach(async () => {
    await unmountHarness()
    cancelPendingRefresh()
    resetStores()
    vi.useRealTimers()
  })

  it('steady state: the background session completion is announced', async () => {
    // Both sessions run; the user views A (CODE). The snapshot never loaded —
    // coverage must come from the live taskActive map alone. A's fast-restore
    // (issued at mount, after the reset effect wrote taskActive[A]=false)
    // lands BEFORE the user toggles — the healthy steady-state sequencing.
    seedRunning(A)
    seedRunning(B)
    await act(async () => {
      useSessionStore.getState().setActiveSessionId(A)
    })
    await mountHarness()
    await act(async () => {
      statusDeferreds.get(A)!.resolve({ active: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(useChatStore.getState().taskActive[A]).toBe(true)

    // Toggle to CHAT (B): A becomes background and must stay watched via its
    // live taskActive=true flag even though the snapshot is empty.
    await toggleTo(B)

    expect(listenerCount(A, 'task_complete')).toBeGreaterThan(0)

    playSoundMock.mockClear()
    // The completion handler finalizes the session's UI state (chatStore +
    // sessionStore writes), which re-renders the Harness — wrap the
    // bus emission in act() so the store-driven update is flushed like any
    // other state change under test.
    await act(async () => {
      emitSession(A, 'task_complete', { success: true })
    })
    expect(playSoundMock).toHaveBeenCalledWith('success')
  })

  it('rapid toggle dance (cancelled fast-restore) must not orphan a running background session', async () => {
    // The killer repro: A and B both running, the user toggles A→B→A faster
    // than the fast-restore RPCs resolve. Each toggle's reset effect writes
    // taskActive[dest]=false; both restores are cancelled; the snapshot is
    // empty/never loaded. B keeps running in the backend — its completion
    // MUST still be announced (it must remain in the watched set).
    seedRunning(A)
    seedRunning(B)
    await act(async () => {
      useSessionStore.getState().setActiveSessionId(A)
    })
    await mountHarness()

    // Toggle to CHAT — B's fast-restore RPC stays in flight (deferred).
    await toggleTo(B)
    // Toggle straight back to CODE — B's restore is cancelled, A's stays in
    // flight. Final state: A active, B background whose live flag the dance
    // corrupted to false; the DB still says in_progress (snapshot empty).
    await toggleTo(A)

    // The invariant: B must still have a sound listener for its terminal event.
    expect(listenerCount(B, 'task_complete')).toBeGreaterThan(0)

    playSoundMock.mockClear()
    // Same as above: the terminal handler re-renders the Harness via store
    // writes, so the emission is act()-wrapped.
    await act(async () => {
      emitSession(B, 'task_complete', { success: true })
    })
    expect(playSoundMock).toHaveBeenCalledWith('success')
  })

  it('a switch must refresh the authoritative snapshot (self-healing watched set)', async () => {
    vi.useFakeTimers()
    // Arrive at the corrupted state directly (taskActive all false — however
    // history got here). The mount-time refresh loaded a STALE-EMPTY snapshot
    // (it predates the task starts / the RPC failed); the DB now knows better
    // (listAllSessionsImpl flips below). The user toggles — the live set stays
    // empty, liveSessionsSignature never changes, so the ONLY correct trigger
    // for re-reading the DB is the switch itself.
    useChatStore.setState({ taskActive: { [A]: false, [B]: false } })
    await act(async () => {
      useSessionStore.getState().setActiveSessionId(A)
    })
    await mountHarness()
    // Let the mount refresh land with the stale-empty list.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(useActiveSessionsStore.getState().sessions).toEqual([])

    // The DB now reports both tasks in_progress.
    snapshotWith([
      { id: A, status: 'in_progress' },
      { id: B, status: 'in_progress' },
    ])

    await toggleTo(B)

    // Let the debounced refresh (REFRESH_DEBOUNCE_MS) fire and land.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })

    // A is now the running background session: it must be re-watched via the
    // fresh snapshot's in_progress status.
    expect(listenerCount(A, 'task_complete')).toBeGreaterThan(0)
  })

  it('fast-restore resolves: the flag is repaired for the newly active session', async () => {
    seedRunning(A)
    seedRunning(B)
    await act(async () => {
      useSessionStore.getState().setActiveSessionId(A)
    })
    await mountHarness()

    // Toggle to B, then let B's fast-restore land (backend says active=true).
    await toggleTo(B)
    await act(async () => {
      statusDeferreds.get(B)!.resolve({ active: true })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useChatStore.getState().taskActive[B]).toBe(true)
  })
})
