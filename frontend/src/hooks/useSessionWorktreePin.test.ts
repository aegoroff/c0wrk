// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionWorktreePin, MANAGED_FOCUS_BLOCKED_REASON } from './useSessionWorktreePin'
import { useSessionStore } from '@/stores/sessionStore'
import { useGitPanelStore } from '@/stores/gitPanelStore'
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
  useGitPanelStore.getState().reset()
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

  it('keeps the focus-gate reason function referentially stable across a no-op re-render', () => {
    useGitPanelStore.setState({
      worktrees: [makeWorktree({ kind: 'main', is_focus: true })],
    })
    renderHook()
    const first = last!.branchSwitchBlockedReason
    rerenderHook()
    expect(last!.branchSwitchBlockedReason).toBe(first)
  })
})

describe('useSessionWorktreePin — managed-focus gate (branchSwitchBlockedReason)', () => {
  // The backend refuses CheckoutBranch / CreateBranch / CheckoutRemoteBranch
  // for every branch other than the FOCUSED tree's own whenever that tree is
  // a managed session tree (refusePinnedBranchSwitch) — regardless of which
  // session is active. The gate must mirror exactly that.
  function focusManagedTree(overrides: Partial<GitWorktree> = {}): void {
    useGitPanelStore.setState({
      worktrees: [
        makeWorktree({ kind: 'main', name: 'repo', path: '/w/proj' }),
        makeWorktree({
          kind: 'managed',
          name: 's-9',
          path: '/w/proj/.worktrees/s-9',
          branch: 'feat/focused',
          managed: true,
          pinned: true,
          session_id: 's-9',
          is_focus: true,
          ...overrides,
        }),
      ],
    })
  }

  it('refuses off-pin names while the focus sits on a managed tree — with NO active session', () => {
    // The gate follows the focus, not the active session's binding: it must
    // apply even when the active session is local or absent.
    focusManagedTree()
    renderHook()
    expect(last!.pinnedBranch).toBeNull()
    expect(last!.branchSwitchBlockedReason('other')).toBe(MANAGED_FOCUS_BLOCKED_REASON)
    // The focused tree's own branch cannot move the tree off its pin — a
    // same-branch checkout is allowed server-side.
    expect(last!.branchSwitchBlockedReason('feat/focused')).toBeNull()
  })

  it('allows everything once the focus moves to the main checkout or an external tree', () => {
    useGitPanelStore.setState({
      worktrees: [
        makeWorktree({ kind: 'main', name: 'repo', path: '/w/proj', is_focus: true }),
        makeWorktree({
          kind: 'managed',
          name: 's-9',
          path: '/w/proj/.worktrees/s-9',
          branch: 'feat/focused',
          managed: true,
          pinned: true,
          session_id: 's-9',
        }),
      ],
    })
    renderHook()
    expect(last!.branchSwitchBlockedReason('anything')).toBeNull()

    act(() => {
      useGitPanelStore.setState({
        worktrees: [
          makeWorktree({ kind: 'external', name: 'ext', path: '/elsewhere', is_focus: true }),
        ],
      })
    })
    rerenderHook()
    expect(last!.branchSwitchBlockedReason('anything')).toBeNull()
  })

  it('refuses every name on a detached (branch-less) managed focus', () => {
    focusManagedTree({ branch: undefined })
    renderHook()
    expect(last!.branchSwitchBlockedReason('other')).toBe(MANAGED_FOCUS_BLOCKED_REASON)
    expect(last!.branchSwitchBlockedReason('')).toBe(MANAGED_FOCUS_BLOCKED_REASON)
  })

  it('keys on the FOCUSED tree, not the active session pin (cross-session focus)', () => {
    // Active session s-1 is pinned to feat/mine, but the panel focus rests
    // on s-9's tree: the refusal is s-9's pin, and even the active session's
    // own branch is refused there (a switch would move s-9's tree).
    useSessionStore.setState({
      sessions: [
        makeSession({
          id: 's-1',
          workspace_binding: {
            kind: 'managed_worktree',
            workspace_path: '/w/proj/.worktrees/s-1',
            worktree_name: 's-1',
            branch: 'feat/mine',
          },
        }),
      ],
      activeSessionId: 's-1',
    })
    focusManagedTree()
    renderHook()
    expect(last!.pinnedBranch).toBe('feat/mine')
    expect(last!.branchSwitchBlockedReason('feat/mine')).toBe(MANAGED_FOCUS_BLOCKED_REASON)
    expect(last!.branchSwitchBlockedReason('feat/focused')).toBeNull()
  })
})
