// @vitest-environment jsdom
//
// Regression: the switch-time fast-restore (useTaskFlagRestore) must restore the
// FULL task-flag snapshot it reads, not just `taskActive`.
//
// Reproduction of the reported bug: a session persisted as cooperatively paused
// is shown as paused in the sidebar list and the live-sessions radar (both fall
// back to the DB snapshot's `unfinished_task_status === 'paused'`), yet the chat
// toolbar rendered a plain Send button instead of Resume. The toolbar reads
// ONLY `chatStore.paused`, which was never set on session load: this hook read
// `status.active` only, and its write stamped `taskFlagsEventAt`, which then made
// ChatArea's later `reconcileRuntimeStatus` skip ITS paused restore (the
// stale-snapshot guard). See applyRuntimeTaskFlags in lib/sessionRuntime.ts and
// useTaskFlagRestore.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { getSessionRuntimeStatusMock } = vi.hoisted(() => ({
  getSessionRuntimeStatusMock: vi.fn(),
}))

vi.mock('@/api/chat', () => ({
  getSessionRuntimeStatus: getSessionRuntimeStatusMock,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { useTaskFlagRestore } from './useTaskFlagRestore'
import { useChatStore } from '@/stores/chatStore'

function Harness({ sessionId }: { sessionId: string | null }) {
  useTaskFlagRestore(sessionId)
  return null
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(sessionId: string | null): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  act(() => {
    r.render(createElement(Harness, { sessionId }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  getSessionRuntimeStatusMock.mockReset()
  useChatStore.setState({
    taskActive: {},
    paused: {},
    pausing: {},
    taskFlagsEventAt: {},
    unfinishedTaskStatus: {},
  })
})

afterEach(() => {
  if (root) {
    const r = root
    root = null
    act(() => {
      r.unmount()
    })
  }
  container?.remove()
  container = null
})

describe('useTaskFlagRestore', () => {
  it('restores the paused flag so the toolbar shows Resume (not Send)', async () => {
    getSessionRuntimeStatusMock.mockResolvedValue({
      active: false,
      has_unfinished_task: true,
      unfinished_task_status: 'paused',
      paused: true,
    })

    render('s1')
    await flush()

    expect(useChatStore.getState().paused.s1).toBe(true)
    expect(useChatStore.getState().taskActive.s1).toBe(false)
  })

  it('does not mark a running session as paused', async () => {
    getSessionRuntimeStatusMock.mockResolvedValue({
      active: true,
      has_unfinished_task: true,
      paused: false,
    })

    render('s1')
    await flush()

    expect(useChatStore.getState().paused.s1).toBeUndefined()
    expect(useChatStore.getState().taskActive.s1).toBe(true)
  })

  it('clears a stale paused flag when the task is live again', async () => {
    useChatStore.setState({ paused: { s1: true }, taskActive: { s1: false } })
    getSessionRuntimeStatusMock.mockResolvedValue({
      active: true,
      has_unfinished_task: true,
      paused: true,
    })

    render('s1')
    await flush()

    expect(useChatStore.getState().paused.s1).toBeUndefined()
    expect(useChatStore.getState().taskActive.s1).toBe(true)
  })
})
