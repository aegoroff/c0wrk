// @vitest-environment jsdom
//
// Regression tests for the resume prompt's Cancel action. Cancelling a failed
// (resumable) task is a hard discard that emits no terminal event, so the
// frontend must clear the stale live-session state itself — otherwise the
// session keeps showing on the active-sessions radar (red "failed") until the
// 30s safety poll.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The RPC layer must not reach Wails. activeSessionsStore imports listAllSessions
// / getPendingActions at module scope, so those exports must exist on the mocks.
const { cancelUnfinishedTaskMock, resumeTaskMock, listAllSessionsMock, getPendingActionsMock } = vi.hoisted(() => ({
  cancelUnfinishedTaskMock: vi.fn(async () => {}),
  resumeTaskMock: vi.fn(async () => {}),
  listAllSessionsMock: vi.fn(async () => []),
  getPendingActionsMock: vi.fn(async () => null),
}))

vi.mock('@/api/sessions', () => ({ listAllSessions: listAllSessionsMock }))
vi.mock('@/api/chat', () => ({
  cancelUnfinishedTask: cancelUnfinishedTaskMock,
  resumeTask: resumeTaskMock,
  getPendingActions: getPendingActionsMock,
}))

import { ResumeActionPanel } from './ResumeActionPanel'
import { cancelPendingRefresh, useActiveSessionsStore } from '@/stores/activeSessionsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useChatStore } from '@/stores/chatStore'
import type { ChatMessageUI, DisplayItem } from '@/types/messages'
import type { SessionInfo } from '@/types/models'

const SESSION_ID = 'sess-1'

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const ts = new Date(0).toISOString()
  return {
    id: SESSION_ID,
    project_id: 'p1',
    name: 'Session',
    created_at: ts,
    last_active_at: ts,
    archived: false,
    pinned: false,
    active: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: '',
    family: '',
    has_unfinished_task: true,
    unfinished_task_status: 'failed',
    ...overrides,
  }
}

function makeResumeItem(): Extract<DisplayItem, { kind: 'resume_action' }> {
  const message: ChatMessageUI = {
    id: 'resume-1',
    sessionId: SESSION_ID,
    type: 'task_failed_resumable',
    content: 'Plan execution failed.',
    metadata: { resolved: false },
    timestamp: 0,
  }
  return { kind: 'resume_action', message }
}

const roots: Root[] = []

function render(ui: React.ReactNode): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(ui)
  })
  return container
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  if (!btn) throw new Error(`button "${text}" not found`)
  return btn as HTMLButtonElement
}

beforeEach(() => {
  cancelUnfinishedTaskMock.mockReset().mockResolvedValue(undefined)
  resumeTaskMock.mockReset().mockResolvedValue(undefined)
  listAllSessionsMock.mockReset().mockResolvedValue([])
  getPendingActionsMock.mockReset().mockResolvedValue(null)
  useActiveSessionsStore.setState({ sessions: [makeSession()], pendingOverride: {}, refreshing: false })
  useSessionStore.setState({ sessions: [makeSession()], activeSessionId: SESSION_ID })
  useChatStore.setState({ taskActive: {}, unfinishedTaskStatus: {}, paused: {}, messages: {}, messageOrder: {} })
})

afterEach(() => {
  // The cancel path schedules a debounced snapshot refresh — drop it so the
  // trailing RPC cannot land in the next test.
  cancelPendingRefresh()
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount()
    })
  }
})

describe('ResumeActionPanel cancel', () => {
  it('discards the task and clears the stale live-session state', async () => {
    const container = render(<ResumeActionPanel item={makeResumeItem()} />)

    await act(async () => {
      buttonByText(container, 'Cancel').click()
    })

    expect(cancelUnfinishedTaskMock).toHaveBeenCalledWith(SESSION_ID)

    // The session must leave the radar: its DB-derived snapshot entry no
    // longer carries an unfinished task.
    const snap = useActiveSessionsStore.getState().sessions!.find((s) => s.id === SESSION_ID)!
    expect(snap.unfinished_task_status).toBe('')
    expect(snap.has_unfinished_task).toBe(false)

    // ...and the SINGLE live unfinished-task overlay is cleared, so every dot
    // (sidebar session list, radar badge, radar dropdown) turns idle live.
    expect(useChatStore.getState().unfinishedTaskStatus[SESSION_ID]).toBe('')
  })

  it('keeps the state when the cancel RPC rejects (nothing settled)', async () => {
    cancelUnfinishedTaskMock.mockRejectedValueOnce(new Error('backend gone'))
    const container = render(<ResumeActionPanel item={makeResumeItem()} />)

    await act(async () => {
      buttonByText(container, 'Cancel').click()
    })

    const snap = useActiveSessionsStore.getState().sessions!.find((s) => s.id === SESSION_ID)!
    expect(snap.unfinished_task_status).toBe('failed')
    // The overlay is left untouched on failure — the task stays resumable.
    expect(useChatStore.getState().unfinishedTaskStatus[SESSION_ID]).toBeUndefined()
  })
})
