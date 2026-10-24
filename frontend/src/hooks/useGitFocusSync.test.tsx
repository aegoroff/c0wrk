// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// --- Mock the focus actions so tests never touch the Wails backend ---
const { focusMocks } = vi.hoisted(() => ({
  focusMocks: {
    focusSessionWorkspace: vi.fn(),
    clearGitFocusState: vi.fn(),
  },
}))

vi.mock('@/lib/gitFocus', () => focusMocks)

import { useGitFocusSync } from './useGitFocusSync'
import { focusSessionWorkspace, clearGitFocusState } from '@/lib/gitFocus'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { SessionInfo, WorkspaceBinding } from '@/types/models'

/** Minimal probe component mounting the side-effect hook. */
function Probe() {
  useGitFocusSync()
  return null
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderProbe(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  act(() => {
    r.render(<Probe />)
  })
}

/** SessionInfo fixture (same shape as the sessionStore tests'). */
function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    project_id: 'p1',
    name: `Session ${overrides.id}`,
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
    ...overrides,
  }
}

const MANAGED_BINDING: WorkspaceBinding = {
  kind: 'managed_worktree',
  workspace_path: '/w/trees/sess-1',
  worktree_name: 't-ab12cd34',
  branch: 'feat/x',
}
const LOCAL_BINDING: WorkspaceBinding = { kind: 'local', workspace_path: '/w/proj' }

let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let consoleWarnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  focusMocks.focusSessionWorkspace.mockReset()
  focusMocks.focusSessionWorkspace.mockResolvedValue(true)
  focusMocks.clearGitFocusState.mockReset()
  // Reset both stores so every test is self-contained (the stores are
  // module singletons shared across the file).
  useProjectStore.setState({ activeProjectId: null })
  useSessionStore.setState({ sessions: null, activeSessionId: null })
  // The hook is side-effect-only and quiet: ANY console output in these
  // tests is unexpected — intercept at the source and fail on it below.
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
  // Assert AFTER unmount — React logs during teardown too.
  expect(consoleErrorSpy).not.toHaveBeenCalled()
  expect(consoleWarnSpy).not.toHaveBeenCalled()
  consoleErrorSpy.mockRestore()
  consoleWarnSpy.mockRestore()
})

describe('useGitFocusSync', () => {
  it('applies the session-default focus on mount for an active project', () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    useSessionStore.setState({ activeSessionId: null })

    renderProbe()

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)
    expect(clearGitFocusState).not.toHaveBeenCalled()
  })

  it('re-applies the focus when the active session changes', () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    useSessionStore.setState({ activeSessionId: 'sess-1' })
    renderProbe()

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)

    act(() => {
      useSessionStore.setState({ activeSessionId: 'sess-2' })
    })

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(2)
  })

  it('re-applies the focus when the active project changes', () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    renderProbe()

    act(() => {
      useProjectStore.setState({ activeProjectId: 'p2' })
    })

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(2)
  })

  it('clears the mirrored focus state when no project is active', () => {
    useProjectStore.setState({ activeProjectId: null })

    renderProbe()

    expect(focusSessionWorkspace).not.toHaveBeenCalled()
    expect(clearGitFocusState).toHaveBeenCalledTimes(1)
  })

  it('re-applies the focus when the active session binding transitions to managed_worktree', () => {
    // The binding is mirrored into the store only AFTER the fact (the
    // sessions refresh following a workspace-carrying send), so the
    // transition absent → managed_worktree must re-apply the focus even
    // though neither the project nor the session id changed.
    useProjectStore.setState({ activeProjectId: 'p1' })
    useSessionStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession({ id: 'sess-1' })],
    })
    renderProbe()

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)

    act(() => {
      useSessionStore.getState().setSessions([
        makeSession({ id: 'sess-1', workspace_binding: MANAGED_BINDING }),
      ])
    })

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(2)
  })

  it('re-applies the focus when a local binding transitions through updateSession', () => {
    // The post-send row refresh path (refreshSessionRow in useMessageSender)
    // mirrors the persisted managed binding through updateSession with a
    // freshly allocated binding object — still a transition.
    useProjectStore.setState({ activeProjectId: 'p1' })
    useSessionStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession({ id: 'sess-1', workspace_binding: LOCAL_BINDING })],
    })
    renderProbe()

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)

    act(() => {
      useSessionStore.getState().updateSession('sess-1', {
        workspace_binding: { ...MANAGED_BINDING },
      })
    })

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(2)
  })

  it('does NOT re-apply on duplicate equal list deliveries', () => {
    // Every ListSessions reply allocates a fresh binding OBJECT with equal
    // content; the derived PRIMITIVE key (kind:workspace_path) compares
    // equal, so the duplicate delivery must not re-apply.
    useProjectStore.setState({ activeProjectId: 'p1' })
    useSessionStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession({ id: 'sess-1', workspace_binding: MANAGED_BINDING })],
    })
    renderProbe()

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)

    act(() => {
      useSessionStore.getState().setSessions([
        makeSession({ id: 'sess-1', workspace_binding: { ...MANAGED_BINDING } }),
      ])
    })

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-apply when a NON-active session binding transitions', () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    useSessionStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession({ id: 'sess-1' }), makeSession({ id: 'sess-2' })],
    })
    renderProbe()

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)

    // sess-2 gains a managed binding; the active session (sess-1) is
    // untouched — the refreshed list re-renders the hook but the active
    // binding key is unchanged.
    act(() => {
      useSessionStore.getState().setSessions([
        makeSession({ id: 'sess-1' }),
        makeSession({ id: 'sess-2', workspace_binding: MANAGED_BINDING }),
      ])
    })

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-apply on last_active_at-only updates', () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    useSessionStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession({ id: 'sess-1', workspace_binding: MANAGED_BINDING })],
    })
    renderProbe()

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)

    // The exact refreshSessionRow shape: a bumped last_active_at next to a
    // fresh-but-equal binding object — the sessions array AND the binding
    // object identity both change, the derived primitive key does not.
    act(() => {
      useSessionStore.getState().updateSession('sess-1', {
        last_active_at: '2026-01-02T00:00:00Z',
        workspace_binding: { ...MANAGED_BINDING },
      })
    })

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)

    // Same via a full list delivery (the sessions refresh event path).
    act(() => {
      useSessionStore.getState().setSessions([
        makeSession({
          id: 'sess-1',
          workspace_binding: { ...MANAGED_BINDING },
          last_active_at: '2026-01-03T00:00:00Z',
        }),
      ])
    })

    expect(focusSessionWorkspace).toHaveBeenCalledTimes(1)
  })
})
