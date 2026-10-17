// @vitest-environment jsdom
//
// Regression: the chat toolbar must show Resume for a session that is PAUSED in
// the persisted snapshot, even when chatStore holds no live `paused` flag — the
// SAME DB fallback the sidebar dot / radar already use. Before the fix the
// toolbar read only the live `chatStore.paused` flag, so a session whose
// session-load runtime-status RPC failed (or was suppressed) painted a plain
// Send button while the sidebar / radar showed it paused.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { statusMock } = vi.hoisted(() => ({ statusMock: vi.fn() }))

vi.mock('@/api/runtime', () => ({
  subscribe: vi.fn(() => () => {}), emit: vi.fn(), onGlobalEvent: vi.fn(() => () => {}),
  onSessionEvent: vi.fn(() => () => {}), reportDroppedEvent: vi.fn(), getApp: vi.fn(),
}))
vi.mock('@/api/config', () => ({ getConfig: vi.fn().mockResolvedValue({ loaded: true, llm: { all_models: [], default_model: '', models_ready: true } }) }))
vi.mock('@/api/prompt', () => ({ optimizePrompt: vi.fn() }))
vi.mock('@/api/chat', () => ({
  sendMessage: vi.fn(), cancelTask: vi.fn(), pauseSession: vi.fn(), resumeSession: vi.fn(),
  getSessionRuntimeStatus: statusMock, getSessionHistory: vi.fn().mockResolvedValue([]),
  getPendingActions: vi.fn().mockResolvedValue(null), resolveStalePrompt: vi.fn(),
}))
vi.mock('@/api/sessions', () => ({ createSession: vi.fn(), listSessions: vi.fn() }))
vi.mock('@/api/agents', () => ({ listAgents: vi.fn().mockResolvedValue([]) }))
vi.mock('@/api/workspace', () => ({ listDirectory: vi.fn().mockResolvedValue([]) }))
vi.mock('@/api/skills', () => ({ listSkills: vi.fn().mockResolvedValue([]) }))
vi.mock('@/api/mcp', () => ({ getMCPMentionableServers: vi.fn().mockResolvedValue([]), mentionableMCPNames: vi.fn(() => []) }))
vi.mock('@/api/capabilities', () => ({ getCapabilityModes: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/attachments', () => ({ pasteFromClipboard: vi.fn(), isImagePath: vi.fn(), attachFiles: vi.fn(), pickAttachmentFiles: vi.fn() }))
vi.mock('@/hooks/useMessageSender', () => ({ useMessageSender: () => ({ send: vi.fn(), cancel: vi.fn(), isProcessing: false }) }))
vi.mock('@/hooks/useConfigData', () => ({ useConfigData: () => ({ allModels: [], defaultModel: '', loaded: true }), invalidateConfigCache: vi.fn() }))
vi.mock('@/hooks/useAttachmentsInput', () => ({ useAttachmentsInput: () => ({ handleAttach: vi.fn() }) }))
vi.mock('@/hooks/useExperimentalFeatures', () => ({ useExperimentalFeatures: () => false }))
vi.mock('@/hooks/useModelProfilesGate', () => ({ useModelProfilesGate: () => false }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@/components/terminal/TerminalPanel', () => ({ TerminalPanel: () => null }))

import { ChatInput } from '@/components/chat/ChatInput'
import { useTaskFlagRestore } from '@/hooks/useTaskFlagRestore'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { useInputModeStore } from '@/stores/inputModeStore'
import { useChatStore } from '@/stores/chatStore'
import type { SessionInfo } from '@/types/models'

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: 's1', project_id: 'p1', name: 'Session',
    created_at: '2026-01-01T00:00:00Z', last_active_at: '2026-01-01T00:00:00Z',
    archived: false, pinned: false, active: false,
    total_input_tokens: 0, total_output_tokens: 0, model: '', family: '',
    has_unfinished_task: false, unfinished_task_status: '',
    ...over,
  }
}

function Harness() {
  const sid = useSessionStore((s) => s.activeSessionId)
  useTaskFlagRestore(sid)
  return createElement(ChatInput)
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) })
  class RO { observe(): void {} unobserve(): void {} disconnect(): void {} }
  globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver
})

let container: HTMLDivElement
let root: Root
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }) }
const resume = () => container.querySelector('button[aria-label="Resume task"]')
const send = () => container.querySelector('button[aria-label="Send message"]')

beforeEach(() => {
  statusMock.mockReset()
  useChatStore.setState({ taskActive: {}, paused: {}, pausing: {}, taskFlagsEventAt: {}, unfinishedTaskStatus: {}, runtimeEventAt: {} })
  useSessionStore.setState({ sessions: [session({})], activeSessionId: 's1' })
  useProjectStore.setState({ activeProjectId: 'p1' })
  useInputModeStore.setState({ mode: 'chat', pendingInsertion: null })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = '' })

describe('ChatInput paused affordance mirrors the sidebar DB fallback', () => {
  it('shows Resume for a PERSISTED-paused session with NO live paused flag', async () => {
    // The reported bug: the session-load runtime-status RPC yields nothing /
    // fails, so chatStore holds no live knowledge — the DB snapshot is the ONLY
    // source, and the sidebar shows paused. The toolbar must agree.
    statusMock.mockResolvedValue(null)
    useSessionStore.setState({ sessions: [session({ unfinished_task_status: 'paused', has_unfinished_task: true })], activeSessionId: 's1' })
    act(() => { root.render(createElement(Harness)) })
    await flush()
    expect(useChatStore.getState().paused.s1).toBeUndefined()
    expect(resume()).not.toBeNull()
    expect(send()).toBeNull()
  })

  it('still shows Resume when the live paused flag is restored from the RPC', async () => {
    statusMock.mockResolvedValue({ active: false, has_unfinished_task: true, unfinished_task_status: 'paused', paused: true })
    useSessionStore.setState({ sessions: [session({ unfinished_task_status: 'paused', has_unfinished_task: true })], activeSessionId: 's1' })
    act(() => { root.render(createElement(Harness)) })
    await flush()
    expect(resume()).not.toBeNull()
    expect(send()).toBeNull()
  })

  it('shows Send for an idle session', async () => {
    statusMock.mockResolvedValue({ active: false, has_unfinished_task: false, paused: false })
    act(() => { root.render(createElement(Harness)) })
    await flush()
    expect(send()).not.toBeNull()
    expect(resume()).toBeNull()
  })

  it('a live settled overlay overrides a stale DB paused status (shows Send)', async () => {
    // chatStore KNOWS the task settled (`''`), so a stale DB 'paused' from an
    // older list load must not surface a phantom Resume.
    statusMock.mockResolvedValue(null)
    useChatStore.setState({ unfinishedTaskStatus: { s1: '' } })
    useSessionStore.setState({ sessions: [session({ unfinished_task_status: 'paused', has_unfinished_task: true })], activeSessionId: 's1' })
    act(() => { root.render(createElement(Harness)) })
    await flush()
    expect(send()).not.toBeNull()
    expect(resume()).toBeNull()
  })
})
