// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionWorktreePin } from './useSessionWorktreePin'
import { useSessionStore } from '@/stores/sessionStore'
import type { GitWorktree, SessionInfo } from '@/types/models'

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's-1',
    project_id: 'proj-1',
    name: 'Session',
    created_at: '',
    last_active_at: '',
    archived: false,
    pinned: false,
    active: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: 'm',
    family: 'f',
    has_unfinished_task: false,
    ...overrides,
  }
}

function makeWorktree(overrides: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path: '/repo',
    name: 'repo',
    kind: 'main',
    head: 'abc',
    managed: false,
    pinned: false,
    is_focus: false,
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

type PinResult = ReturnType<typeof useSessionWorktreePin>
let last: PinResult | null = null

function Harness(): null {
  last = useSessionWorktreePin()
  return null
}

function renderHook(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(Harness))
  })
}

function rerenderHook(): void {
  act(() => {
    root!.render(createElement(Harness))
  })
}

beforeEach(() => {
  useSessionStore.setState({ sessions: null, activeSessionId: null })
  last = null
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

describe('useSessionWorktreePin — managed active session', () => {
  it('exposes the pinned branch and matches the owning tree by session_id', () => {
    useSessionStore.setState({
      sessions: [
        makeSession({
          id: 's-1',
          workspace_binding: {
            kind: 'managed_worktree',
            workspace_path: '/w/proj/.worktrees/s-1',
            worktree_name: 's-1',
            branch: 'feat/x',
          },
        }),
      ],
      activeSessionId: 's-1',
    })
    renderHook()
    expect(last!.pinnedBranch).toBe('feat/x')
    expect(
      last!.isPinnedWorktree(
        makeWorktree({
          kind: 'managed',
          name: 's-1',
          path: '/w/proj/.worktrees/s-1',
          branch: 'feat/x',
          managed: true,
          pinned: true,
          session_id: 's-1',
          session_name: 'Session',
        }),
      ),
    ).toBe(true)
  })

  it('matches the bound tree by stored workspace_path when the owner is not decorated', () => {
    useSessionStore.setState({
      sessions: [
        makeSession({
          id: 's-1',
          workspace_binding: {
            kind: 'managed_worktree',
            workspace_path: '/data/proj/worktrees/s-1',
            worktree_name: 's-1',
            branch: 'feat/x',
          },
        }),
      ],
      activeSessionId: 's-1',
    })
    renderHook()
    // Canonical git path differing from the stored (symlinked-ancestor) form.
    expect(
      last!.isPinnedWorktree(
        makeWorktree({
          kind: 'managed',
          name: 's-1',
          path: '/mnt/data/proj/worktrees/s-1',
          branch: 'feat/x',
          managed: true,
          pinned: true,
        }),
      ),
    ).toBe(true)
  })

  it('matches the bound tree by managed + worktree_name as the last resort', () => {
    useSessionStore.setState({
      sessions: [
        makeSession({
          id: 's-1',
          workspace_binding: {
            kind: 'managed_worktree',
            workspace_path: '/stored/elsewhere/s-1',
            worktree_name: 's-1',
            branch: 'feat/x',
          },
        }),
      ],
      activeSessionId: 's-1',
    })
    renderHook()
    expect(
      last!.isPinnedWorktree(
        makeWorktree({ kind: 'managed', name: 's-1', path: '/canonical/s-1', managed: true, pinned: true }),
      ),
    ).toBe(true)
  })

  it('does not match other trees — main, external, or another session’s exclusive tree', () => {
    useSessionStore.setState({
      sessions: [
        makeSession({
          id: 's-1',
          workspace_binding: {
            kind: 'managed_worktree',
            workspace_path: '/w/proj/.worktrees/s-1',
            worktree_name: 's-1',
            branch: 'feat/x',
          },
        }),
      ],
      activeSessionId: 's-1',
    })
    renderHook()
    expect(last!.isPinnedWorktree(makeWorktree({ kind: 'main' }))).toBe(false)
    expect(
      last!.isPinnedWorktree(makeWorktree({ kind: 'external', name: 'ext', path: '/elsewhere/ext', managed: false })),
    ).toBe(false)
    expect(
      last!.isPinnedWorktree(
        makeWorktree({ kind: 'managed', name: 's-2', path: '/w/proj/.worktrees/s-2', managed: true, pinned: true }),
      ),
    ).toBe(false)
  })

  it('still pins a SHARED managed tree whose decorated owner is another session (ADR-082)', () => {
    useSessionStore.setState({
      sessions: [
        makeSession({
          id: 's-1',
          workspace_binding: {
            kind: 'managed_worktree',
            workspace_path: '/w/proj/.worktrees/s-1',
            worktree_name: 's-1',
            branch: 'feat/x',
          },
        }),
      ],
      activeSessionId: 's-1',
    })
    renderHook()
    // A co-owner session binds to the same tree: the owner decoration names
    // only one of the owners, so the path match decides.
    expect(
      last!.isPinnedWorktree(
        makeWorktree({
          kind: 'managed',
          name: 's-1',
          path: '/w/proj/.worktrees/s-1',
          managed: true,
          pinned: true,
          session_id: 's-other',
        }),
      ),
    ).toBe(true)
  })
})

describe('useSessionWorktreePin — no pin', () => {
  it('returns null/false for a local session', () => {
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 's-1', workspace_binding: { kind: 'local', workspace_path: '/w/proj' } }),
      ],
      activeSessionId: 's-1',
    })
    renderHook()
    expect(last!.pinnedBranch).toBeNull()
    expect(last!.isPinnedWorktree(makeWorktree({ kind: 'main' }))).toBe(false)
  })

  it('returns null/false for a CHAT session without a binding', () => {
    useSessionStore.setState({ sessions: [makeSession({ id: 's-1' })], activeSessionId: 's-1' })
    renderHook()
    expect(last!.pinnedBranch).toBeNull()
    expect(last!.isPinnedWorktree(makeWorktree({ kind: 'main' }))).toBe(false)
  })

  it('returns null/false without an active session or an unloaded list', () => {
    renderHook()
    expect(last!.pinnedBranch).toBeNull()
    expect(last!.isPinnedWorktree(makeWorktree({ kind: 'main' }))).toBe(false)

    act(() => {
      useSessionStore.setState({ sessions: [makeSession({ id: 's-1' })], activeSessionId: null })
    })
    rerenderHook()
    expect(last!.pinnedBranch).toBeNull()
  })
})

describe('useSessionWorktreePin — stability', () => {
  it('keeps the matcher referentially stable across a no-op re-render', () => {
    useSessionStore.setState({
      sessions: [
        makeSession({
          id: 's-1',
          workspace_binding: {
            kind: 'managed_worktree',
            workspace_path: '/w/proj/.worktrees/s-1',
            worktree_name: 's-1',
            branch: 'feat/x',
          },
        }),
      ],
      activeSessionId: 's-1',
    })
    renderHook()
    const first = last!.isPinnedWorktree
    rerenderHook()
    expect(last!.isPinnedWorktree).toBe(first)
  })
})
