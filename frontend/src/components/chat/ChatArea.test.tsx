// @vitest-environment jsdom
//
// Integration test for the archived-session input swap in ChatArea.
//
// ChatArea must render <ArchivedBanner/> instead of <ChatInput/> when the
// active session's `archived` flag is true, and flip back when it is cleared.
// This is the read-only invariant the ArchivedBanner feature exists to enforce
// at the UI layer (the backend guard in backend/session is the server-side
// backstop). We keep the real ArchivedBanner and stub the heavy siblings so the
// assertion exercises ChatArea's own conditional + the real banner wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'

// Enable React's act() flushing in this jsdom environment.

import type { SessionInfo, ChatMessage } from '@/types/models'

// Shared spy so a test can assert what ChatArea hands to mergeHistoryMessages
// after the history-load filter. vi.hoisted keeps it in scope for the mock
// factories below, which are hoisted above the imports.
const mergeSpy = vi.hoisted(() => vi.fn())
const ensureEmptySpy = vi.hoisted(() => vi.fn())

// --- sessionStore: a REAL zustand store so setState triggers re-renders ---
// (lets the live-toggle assertion flip the surface without a fresh mount).
vi.mock('@/stores/sessionStore', async () => {
  const { create } = await import('zustand')
  return {
    useSessionStore: create<{
      sessions: SessionInfo[] | null
      activeSessionId: string | null
      updateSession: (id: string, updates: Partial<SessionInfo>) => void
    }>((set) => ({
      sessions: null,
      activeSessionId: null,
      updateSession: (id, updates) =>
        set((s) => ({
          sessions: (s.sessions ?? []).map((x) => (x.id === id ? { ...x, ...updates } : x)),
        })),
    })),
  }
})

// --- chatStore ---
// ChatArea reads streamingText (undefined) + messages ([]) + the
// history-loaded marker. `chatAreaState` stands in for the chatStore state the
// spinner branch depends on: `historyLoaded` mirrors the historyLoaded marker
// (the real store is set by the loader's finally), `messages` stands in for
// useSessionMessages. Both are mutated by tests; a flip needs an explicit
// re-render in act (the mock has no subscriptions).
const chatAreaState = vi.hoisted(() => ({
  historyLoaded: true,
  messages: [] as unknown[],
}))

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    () => undefined,
    { getState: () => ({ addMessage: vi.fn(), mergeHistoryMessages: mergeSpy, ensureEmptyTranscript: ensureEmptySpy, setTaskActive: vi.fn(), workUnitStatus: {}, scrollPositions: {}, saveScrollPosition: vi.fn(), clearScrollPosition: vi.fn(), markHistoryLoaded: vi.fn() }) }
  ),
  useSessionMessages: () => chatAreaState.messages,
  useSessionWorkUnits: () => ({}),
  useSessionHistoryLoaded: () => chatAreaState.historyLoaded,
  selectSessionMessages: () => [],
}))

// --- planStore: ChatArea calls usePlanStore.getState().clearPlan() in an effect ---
vi.mock('@/stores/planStore', () => ({
  usePlanStore: Object.assign(() => null, { getState: () => ({ clearPlan: vi.fn() }) }),
}))

// --- api/chat: return an empty array / null so the history/reconcile effects are no-ops ---
vi.mock('@/api/chat', () => ({
  getSessionHistory: vi.fn().mockResolvedValue([]),
  getSessionRuntimeStatus: vi.fn().mockResolvedValue(null),
  getPendingActions: vi.fn().mockResolvedValue(null),
  resolveStalePrompt: vi.fn().mockResolvedValue(undefined),
}))

// --- ArchivedBanner deps (kept real, so its imports must resolve to stubs) ---
vi.mock('@/api/sessions', () => ({ archiveSession: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), debug: vi.fn() } }))

// --- Heavy siblings rendered alongside the input shell: stubbed to null ---
vi.mock('./ChatInput', () => ({ ChatInput: () => <div data-testid="chat-input-stub" /> }))
vi.mock('./ExecutionPanels', () => ({ ExecutionPanels: () => null }))
vi.mock('./BlackboardPanel', () => ({ BlackboardPanel: () => null }))

import { ChatArea } from './ChatArea'
import { useSessionStore } from '@/stores/sessionStore'
import { getSessionHistory } from '@/api/chat'

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: 's1',
    project_id: '',
    name: 'Session',
    created_at: '2026-01-01T00:00:00Z',
    last_active_at: '2026-01-01T00:00:00Z',
    archived: false,
    pinned: false,
    active: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: '',
    family: '',
    has_unfinished_task: false,
    unfinished_task_status: '',
    ...over,
  }
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

async function flushEffects() {
  await act(async () => {
    // Let the history/reconcile effects (mocked async) settle.
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ChatArea archived-session input swap', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    root = null
    mergeSpy.mockClear()
    chatAreaState.historyLoaded = true
    chatAreaState.messages = []
    useSessionStore.setState({ sessions: null, activeSessionId: null })
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
  })

  it('renders ChatInput when the active session is not archived', async () => {
    useSessionStore.setState({ sessions: [session({ archived: false })], activeSessionId: 's1' })
    const container = render(<ChatArea />)
    await flushEffects()

    expect(container.querySelector('[data-testid="chat-input-stub"]')).not.toBeNull()
    // The archived banner text must NOT be present.
    expect(container.textContent).not.toContain('archived')
  })

  it('renders ArchivedBanner (and hides ChatInput) when the active session is archived', async () => {
    useSessionStore.setState({ sessions: [session({ archived: true })], activeSessionId: 's1' })
    const container = render(<ChatArea />)
    await flushEffects()

    // Chat input shell is replaced by the banner.
    expect(container.querySelector('[data-testid="chat-input-stub"]')).toBeNull()
    expect(container.textContent).toContain('archived')
    // The real ArchivedBanner offers a Restore affordance.
    expect(container.querySelector('button')?.textContent).toContain('Restore')
  })

  it('flips the surface when the archived flag toggles on the open session', async () => {
    // Start unarchived → ChatInput is shown.
    useSessionStore.setState({ sessions: [session({ archived: false })], activeSessionId: 's1' })
    const container = render(<ChatArea />)
    await flushEffects()
    expect(container.querySelector('[data-testid="chat-input-stub"]')).not.toBeNull()
    expect(container.textContent).not.toContain('archived')

    // Archive the currently-open session (e.g. via the sidebar) → banner appears.
    act(() => {
      useSessionStore.getState().updateSession('s1', { archived: true })
    })
    await flushEffects()
    expect(container.querySelector('[data-testid="chat-input-stub"]')).toBeNull()
    expect(container.textContent).toContain('archived')

    // Restore it → ChatInput returns.
    act(() => {
      useSessionStore.getState().updateSession('s1', { archived: false })
    })
    await flushEffects()
    expect(container.querySelector('[data-testid="chat-input-stub"]')).not.toBeNull()
    expect(container.textContent).not.toContain('archived')
  })

  it('drops legacy review_prompt rows at history load so they never reach the chat', async () => {
    // A session that ran before ADR-060 carries a review_prompt row as its last
    // message (body "Uncommitted changes detected in this repository."). The
    // history-load filter must drop it before mergeHistoryMessages so the stale
    // line never surfaces at the end of the chat.
    vi.mocked(getSessionHistory).mockResolvedValueOnce([
      { id: 1, session_id: 's1', role: 'user', content: 'do the thing', metadata: '', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, session_id: 's1', role: 'review_prompt', content: 'Uncommitted changes detected in this repository.', metadata: JSON.stringify({ prompt_id: 'p-1', decision: 'decline', resolved: true }), created_at: '2026-01-01T00:00:01Z' },
    ] as unknown as ChatMessage[])
    useSessionStore.setState({ sessions: [session({ archived: false })], activeSessionId: 's1' })
    render(<ChatArea />)
    await flushEffects()

    expect(mergeSpy).toHaveBeenCalled()
    const calls = mergeSpy.mock.calls
    const merged = calls[calls.length - 1]![1] as Array<{ type: string; content: string }>
    expect(merged.some((m) => m.content === 'Uncommitted changes detected in this repository.')).toBe(false)
    expect(merged.some((m) => m.type === 'user' && m.content === 'do the thing')).toBe(true)
  })

  it('materializes the confirmed-empty transcript for an EMPTY history without the merge', async () => {
    // A freshly created session has zero rows. The workspace selector's
    // freshness contract (ADR-091) needs messages[sid] to EXIST as an empty
    // index — an absent index reads as "history not loaded yet" and would
    // keep the picker locked forever, making the send-time bind unreachable.
    // But the empty case must not run the timestamp-guarded MERGE: its
    // loadStartedAt guard would drop stored rows older than this load — on a
    // fresh session that is exactly the frontend-only transcript (a rejected
    // send's error card, an in-flight optimistic message). ensureEmptyTranscript
    // materializes the index and is a no-op when it already exists.
    vi.mocked(getSessionHistory).mockResolvedValueOnce([])
    useSessionStore.setState({ sessions: [session({ archived: false })], activeSessionId: 's1' })
    render(<ChatArea />)
    await flushEffects()

    expect(ensureEmptySpy).toHaveBeenCalledWith('s1')
    expect(mergeSpy).not.toHaveBeenCalled()
  })
})

describe('ChatArea history-loading spinner', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    root = null
    mergeSpy.mockClear()
    // Default this describe to "history in flight, nothing on screen yet" —
    // the cold-start / switched-to-unloaded-session state.
    chatAreaState.historyLoaded = false
    chatAreaState.messages = []
    useSessionStore.setState({ sessions: null, activeSessionId: null })
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
  })

  it('spins instead of the empty-session icon while the history load is in flight', async () => {
    // No content in the store and the historyLoaded marker unset (the shared
    // loader has not settled): the empty-session placeholder must not flash —
    // a spinner takes its place, the rest of the shell is untouched.
    useSessionStore.setState({ sessions: [session({ archived: false })], activeSessionId: 's1' })
    const container = render(<ChatArea />)
    await flushEffects()

    expect(container.querySelector('[aria-label="Loading session history"]')).not.toBeNull()
    expect(container.querySelector('svg.h-12')).toBeNull()
    expect(container.querySelector('[data-testid="chat-input-stub"]')).not.toBeNull()
  })

  it('settles to the empty-session placeholder once the load marker is set', async () => {
    useSessionStore.setState({ sessions: [session({ archived: false })], activeSessionId: 's1' })
    const container = render(<ChatArea />)
    await flushEffects()
    expect(container.querySelector('[aria-label="Loading session history"]')).not.toBeNull()

    // The loader's finally marks the session loaded (an empty history
    // resolved — this is the "genuinely empty session" outcome) and the real
    // store notifies subscribers; the mock has none, so re-render explicitly.
    act(() => {
      chatAreaState.historyLoaded = true
      root!.render(<ChatArea />)
    })
    await flushEffects()

    expect(container.querySelector('[aria-label="Loading session history"]')).toBeNull()
    expect(container.querySelector('svg.h-12')).not.toBeNull()
  })

  it('shows the placeholder immediately for an already-loaded empty session', async () => {
    // Returning to a session whose load has settled (or a session whose
    // history resolved earlier in this mount): no spinner, no flash.
    chatAreaState.historyLoaded = true
    useSessionStore.setState({ sessions: [session({ archived: false })], activeSessionId: 's1' })
    const container = render(<ChatArea />)
    await flushEffects()

    expect(container.querySelector('[aria-label="Loading session history"]')).toBeNull()
    expect(container.querySelector('svg.h-12')).not.toBeNull()
  })
})
