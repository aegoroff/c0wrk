// @vitest-environment jsdom
// Tests for useLifecycleEvents' step_start handler. A step_start is live proof
// that the session's task is running, and the invariant covers every real
// emitter: the main ReAct loop (one per executor step), the E2S loop (one per
// E2S turn), and the plan-scoped emitter copies carrying plan-step/subagent
// work (WithPlanStepID) — each runs only while the session's task is active,
// and after a terminal or pause transition none of them is running to emit
// one. The handler therefore re-asserts the task-active flag when it is not
// set — a stale runtime-status snapshot can revert an optimistic send
// activation mid-run (its read predates the backend's activation, so the
// stale-snapshot guard passes it through), which settles the live turn's work
// block to `interrupted` while the loop keeps emitting events. The flag's
// FALSE direction is owned by pause/terminal events, so the assertion only
// ever sets TRUE and is a no-op while the flag already holds.
//
// Follows the createRoot + jsdom harness pattern (see useActionEvents.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLifecycleEvents } from '@/hooks/events/useLifecycleEvents'
import { useChatStore } from '@/stores/chatStore'

const runtimeHandlers = vi.hoisted(() => new Map<string, Array<(data: unknown) => void>>())

vi.mock('@/api/runtime', () => ({
  onSessionEvent: (_sessionId: string, event: string, cb: (data: unknown) => void) => {
    const list = runtimeHandlers.get(event) ?? []
    list.push(cb)
    runtimeHandlers.set(event, list)
    return () => {
      runtimeHandlers.set(event, (runtimeHandlers.get(event) ?? []).filter(fn => fn !== cb))
    }
  },
  reportDroppedEvent: vi.fn(),
}))

import { reportDroppedEvent as reportDroppedEventMock } from '@/api/runtime'

const SESSION = 'sess-lifecycle'

function fireSessionEvent(event: string, data: unknown): void {
  for (const cb of runtimeHandlers.get(event) ?? []) cb(data)
}

let container: HTMLDivElement
let root: Root

function Harness(): null {
  useLifecycleEvents(SESSION)
  return null
}

beforeEach(() => {
  runtimeHandlers.clear()
  vi.clearAllMocks()
  useChatStore.setState({
    messages: {},
    messageOrder: {},
    taskActive: { [SESSION]: false },
    unfinishedTaskStatus: {},
    paused: {},
    pausing: {},
    streamingText: {},
    activityStatus: {},
    runtimeEventAt: {},
    taskFlagsEventAt: {},
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function mount(): void {
  act(() => {
    root.render(createElement(Harness))
  })
}

describe('useLifecycleEvents step_start task-active re-assertion', () => {
  it('asserts taskActive when the flag is stale-false while the loop steps', () => {
    useChatStore.setState({ taskActive: { [SESSION]: false } })
    mount()

    act(() => { fireSessionEvent('step_start', { step_num: 3 }) })

    expect(useChatStore.getState().taskActive[SESSION]).toBe(true)
    expect(useChatStore.getState().activityStatus[SESSION]).toBe('Thinking...')
  })

  it('asserts the flag for a fresh session holding no live knowledge at all', () => {
    // After a webview reload chatStore's maps start empty — the handler must
    // still arm the flag, not treat the absent key as authoritative.
    useChatStore.setState({ taskActive: {} })
    mount()

    act(() => { fireSessionEvent('step_start', { step_num: 1 }) })

    expect(useChatStore.getState().taskActive[SESSION]).toBe(true)
  })

  it('is a store no-op while the flag already holds (no per-step churn)', () => {
    const before = useChatStore.getState().taskFlagsEventAt[SESSION]
    useChatStore.setState({ taskActive: { [SESSION]: true } })
    mount()

    act(() => { fireSessionEvent('step_start', { step_num: 2 }) })

    expect(useChatStore.getState().taskActive[SESSION]).toBe(true)
    // The guarded write is skipped: no freshness stamp, no map churn.
    expect(useChatStore.getState().taskFlagsEventAt[SESSION]).toBe(before)
    expect(useChatStore.getState().activityStatus[SESSION]).toBe('Thinking...')
  })

  it('pins the live unfinished-task overlay to "" when it activates the session', () => {
    // setTaskActive(true) supersedes a stale DB failed/paused snapshot — the
    // same contract every other activation path follows.
    useChatStore.setState({ taskActive: {}, unfinishedTaskStatus: { [SESSION]: 'failed' } })
    mount()

    act(() => { fireSessionEvent('step_start', { step_num: 1 }) })

    expect(useChatStore.getState().taskActive[SESSION]).toBe(true)
    expect(useChatStore.getState().unfinishedTaskStatus[SESSION]).toBe('')
  })

  it('never clears a task another event paused — assertion is one-directional', () => {
    // A paused task's loop is stopped: no step_start can arrive after
    // session_paused in a truthful stream. If one nonetheless does (an event
    // racing the pause), the handler must not resurrect the flag beyond the
    // pause event's own ordering — here the pause landed FIRST, so the flag is
    // false and the step_start re-asserts; the inverse order (flag cleared by
    // the pause after the step) is guarded by the pause handler itself. This
    // test pins the DIRECTION: only true is ever written from this handler.
    useChatStore.setState({ taskActive: { [SESSION]: false }, paused: { [SESSION]: true } })
    mount()

    act(() => { fireSessionEvent('step_start', { step_num: 1 }) })

    expect(useChatStore.getState().taskActive[SESSION]).toBe(true)
    // The paused overlay is untouched by this handler (pause owns it).
    expect(useChatStore.getState().paused[SESSION]).toBe(true)
  })

  it('does not assert on a malformed payload (dropped-event path)', () => {
    useChatStore.setState({ taskActive: { [SESSION]: false } })
    mount()

    act(() => { fireSessionEvent('step_start', { step_num: 'not-a-number' }) })

    expect(useChatStore.getState().taskActive[SESSION]).toBe(false)
    expect(useChatStore.getState().activityStatus[SESSION]).toBeUndefined()
    expect(reportDroppedEventMock).toHaveBeenCalledWith('step_start', { step_num: 'not-a-number' })
  })

  it('leaves OTHER sessions untouched', () => {
    useChatStore.setState({ taskActive: { other: true } })
    mount()

    act(() => { fireSessionEvent('step_start', { step_num: 1 }) })

    expect(useChatStore.getState().taskActive[SESSION]).toBe(true)
    expect(useChatStore.getState().taskActive.other).toBe(true)
    expect(useChatStore.getState().activityStatus.other).toBeUndefined()
  })
})
