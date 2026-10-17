// Unit tests for sessionGroups — pure sidebar grouping model
// (managed branch groups per ADR-080, shared-branch merging per ADR-082).

import { describe, it, expect } from 'vitest'
import {
  buildSessionGroups,
  branchGroupKey,
  compareByActivity,
  lastActiveTime,
  MANAGED_SECTION_KEY,
  LOCAL_SECTION_KEY,
  ARCHIVED_SECTION_KEY,
} from '@/lib/sessionGroups'
import type { SessionInfo, WorkspaceBinding } from '@/types/models'

// --- Test helpers ---

function makeSession(
  overrides: Partial<SessionInfo> & { id: string },
): SessionInfo {
  return {
    project_id: 'p1',
    name: `Session ${overrides.id}`,
    created_at: '2026-01-01T10:00:00Z',
    last_active_at: '2026-01-01T10:00:00Z',
    archived: false,
    pinned: false,
    active: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: 'test-model',
    family: 'test',
    has_unfinished_task: false,
    ...overrides,
  }
}

function managedBinding(branch: string): WorkspaceBinding {
  return {
    kind: 'managed_worktree',
    workspace_path: `/w/proj/.worktrees/s-abcd1234`,
    worktree_name: 's-abcd1234',
    branch,
  }
}

const LOCAL_BINDING: WorkspaceBinding = {
  kind: 'local',
  workspace_path: '/w/proj',
}

/** Session on a managed worktree branch. */
function managedSession(
  id: string,
  branch: string,
  lastActive: string,
  extra: Partial<SessionInfo> = {},
): SessionInfo {
  return makeSession({
    id,
    last_active_at: lastActive,
    workspace_binding: managedBinding(branch),
    ...extra,
  })
}

// --- Collapse keys ---

describe('collapse keys', () => {
  it('branchGroupKey prefixes the branch name', () => {
    expect(branchGroupKey('feat/sidebar')).toBe('branch:feat/sidebar')
    expect(branchGroupKey('main')).toBe('branch:main')
  })
  it('section keys are the documented constants', () => {
    expect(MANAGED_SECTION_KEY).toBe('managed')
    expect(LOCAL_SECTION_KEY).toBe('local')
    expect(ARCHIVED_SECTION_KEY).toBe('archived')
  })
})

// --- Comparator ---

describe('compareByActivity (mirrors sessionStore.sortByActivity)', () => {
  it('surfaces pinned sessions first regardless of freshness', () => {
    const pinned = managedSession('s-old', 'main', '2026-01-01T10:00:00Z', { pinned: true })
    const fresh = managedSession('s-new', 'main', '2026-01-02T10:00:00Z')
    expect(compareByActivity(pinned, fresh)).toBeLessThan(0)
    expect(compareByActivity(fresh, pinned)).toBeGreaterThan(0)
  })
  it('orders equal-pinned sessions freshest first', () => {
    const a = managedSession('a', 'main', '2026-01-01T10:00:00Z')
    const b = managedSession('b', 'main', '2026-01-02T10:00:00Z')
    expect(compareByActivity(a, b)).toBeGreaterThan(0)
    expect(compareByActivity(b, a)).toBeLessThan(0)
  })
  it('returns 0 for identical pinned/freshness', () => {
    const t = '2026-01-01T10:00:00Z'
    expect(compareByActivity(managedSession('a', 'main', t), managedSession('b', 'main', t))).toBe(0)
  })
  it('falls back to created_at when last_active_at is empty', () => {
    const neverActive = makeSession({ id: 'a', last_active_at: '', created_at: '2026-01-01T10:00:00Z' })
    const active = makeSession({ id: 'b', last_active_at: '2026-01-02T10:00:00Z' })
    expect(lastActiveTime(neverActive)).toBe(new Date('2026-01-01T10:00:00Z').getTime())
    expect(compareByActivity(active, neverActive)).toBeLessThan(0)
  })
})

// --- Classification ---

describe('buildSessionGroups — classification', () => {
  it('routes managed_worktree bindings into managed groups keyed by branch', () => {
    const groups = buildSessionGroups([
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
    ])
    expect(groups.managed).toHaveLength(1)
    expect(groups.managed[0]!.branch).toBe('feat/a')
    expect(groups.managed[0]!.sessions.map((s) => s.id)).toEqual(['s1'])
    expect(groups.local).toEqual([])
    expect(groups.archived).toEqual([])
  })

  it('routes kind local into the local bucket', () => {
    const groups = buildSessionGroups([
      makeSession({ id: 's1', workspace_binding: LOCAL_BINDING }),
    ])
    expect(groups.managed).toEqual([])
    expect(groups.local.map((s) => s.id)).toEqual(['s1'])
  })

  it('routes sessions without a binding into the local bucket', () => {
    const groups = buildSessionGroups([
      makeSession({ id: 'chat1', workspace_binding: undefined }),
    ])
    expect(groups.managed).toEqual([])
    expect(groups.local.map((s) => s.id)).toEqual(['chat1'])
  })

  it('routes archived sessions into the archive bucket regardless of binding', () => {
    const groups = buildSessionGroups([
      managedSession('s-arch', 'feat/a', '2026-01-01T10:00:00Z', { archived: true }),
      makeSession({ id: 'l-arch', workspace_binding: LOCAL_BINDING, archived: true }),
      managedSession('s-live', 'feat/a', '2026-01-02T10:00:00Z'),
    ])
    expect(groups.archived.map((s) => s.id)).toEqual(['s-arch', 'l-arch'])
    expect(groups.managed[0]!.sessions.map((s) => s.id)).toEqual(['s-live'])
    expect(groups.local).toEqual([])
  })

  it('returns three empty buckets for empty input', () => {
    expect(buildSessionGroups([])).toEqual({ managed: [], local: [], archived: [] })
  })
})

// --- Shared-branch merging (ADR-082) ---

describe('buildSessionGroups — shared-branch merging (ADR-082)', () => {
  it('merges sessions sharing one branch into a single group', () => {
    const groups = buildSessionGroups([
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
      managedSession('s2', 'feat/a', '2026-01-03T10:00:00Z'),
      managedSession('s3', 'feat/a', '2026-01-02T10:00:00Z'),
    ])
    expect(groups.managed).toHaveLength(1)
    expect(groups.managed[0]!.branch).toBe('feat/a')
    // Members merge, then sort pinned → freshness inside the group.
    expect(groups.managed[0]!.sessions.map((s) => s.id)).toEqual(['s2', 's3', 's1'])
  })

  it('keeps distinct branches in separate groups', () => {
    const groups = buildSessionGroups([
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
      managedSession('s2', 'feat/b', '2026-01-02T10:00:00Z'),
    ])
    expect(groups.managed.map((g) => g.branch)).toEqual(['feat/b', 'feat/a'])
  })
})

// --- Ordering ---

describe('buildSessionGroups — ordering', () => {
  it('sorts sessions inside every bucket pinned → freshness', () => {
    const groups = buildSessionGroups([
      makeSession({ id: 'l1', workspace_binding: LOCAL_BINDING, last_active_at: '2026-01-03T10:00:00Z' }),
      makeSession({ id: 'l2', workspace_binding: LOCAL_BINDING, last_active_at: '2026-01-01T10:00:00Z', pinned: true }),
      makeSession({ id: 'l3', workspace_binding: LOCAL_BINDING, last_active_at: '2026-01-02T10:00:00Z' }),
      makeSession({ id: 'a1', archived: true, last_active_at: '2026-01-01T10:00:00Z' }),
      makeSession({ id: 'a2', archived: true, last_active_at: '2026-01-02T10:00:00Z' }),
    ])
    expect(groups.local.map((s) => s.id)).toEqual(['l2', 'l1', 'l3'])
    expect(groups.archived.map((s) => s.id)).toEqual(['a2', 'a1'])
  })

  it('orders managed groups by their freshest session, most recent first', () => {
    const groups = buildSessionGroups([
      // 'feat/old' group's freshest session is older than the others'.
      managedSession('o1', 'feat/old', '2026-01-01T10:00:00Z'),
      managedSession('o2', 'feat/old', '2026-01-02T10:00:00Z'),
      managedSession('m1', 'feat/mid', '2026-01-03T10:00:00Z'),
      managedSession('n1', 'feat/new', '2026-01-05T10:00:00Z'),
    ])
    expect(groups.managed.map((g) => g.branch)).toEqual([
      'feat/new',
      'feat/mid',
      'feat/old',
    ])
  })

  it('breaks group-order ties alphabetically by branch name', () => {
    const t = '2026-01-02T10:00:00Z'
    const groups = buildSessionGroups([
      managedSession('z', 'feat/zeta', t),
      managedSession('a', 'feat/alpha', t),
    ])
    expect(groups.managed.map((g) => g.branch)).toEqual(['feat/alpha', 'feat/zeta'])
  })

  it('a pinned session does not promote its group — freshness decides', () => {
    const groups = buildSessionGroups([
      managedSession('p1', 'feat/pinned', '2026-01-01T10:00:00Z', { pinned: true }),
      managedSession('f1', 'feat/fresh', '2026-01-04T10:00:00Z'),
    ])
    expect(groups.managed.map((g) => g.branch)).toEqual(['feat/fresh', 'feat/pinned'])
    // …but the pinned session still leads inside its own group.
    expect(groups.managed[1]!.sessions.map((s) => s.id)).toEqual(['p1'])
  })
})

// --- Search ---

describe('buildSessionGroups — search filtering', () => {
  const sessions = [
    managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z', { name: 'Refactor sidebar' }),
    managedSession('s2', 'feat/b', '2026-01-02T10:00:00Z', { name: 'Fix vector index' }),
    makeSession({ id: 'l1', workspace_binding: LOCAL_BINDING, name: 'Sidebar polish' }),
    makeSession({ id: 'a1', archived: true, name: 'Old vector experiments' }),
  ]

  it('filters by name case-insensitively', () => {
    const groups = buildSessionGroups(sessions, { search: 'SIDEBAR' })
    expect(groups.managed[0]!.sessions.map((s) => s.id)).toEqual(['s1'])
    expect(groups.local.map((s) => s.id)).toEqual(['l1'])
    expect(groups.archived).toEqual([])
  })

  it('omits groups left without matching members', () => {
    const groups = buildSessionGroups(sessions, { search: 'vector' })
    // 'feat/a' held only the sidebar session — the empty group is hidden.
    expect(groups.managed).toHaveLength(1)
    expect(groups.managed[0]!.branch).toBe('feat/b')
    expect(groups.managed[0]!.sessions.map((s) => s.id)).toEqual(['s2'])
    expect(groups.local).toEqual([])
    expect(groups.archived.map((s) => s.id)).toEqual(['a1'])
  })

  it('treats blank/whitespace search as no filter', () => {
    const unfiltered = buildSessionGroups(sessions)
    expect(buildSessionGroups(sessions, { search: '' })).toEqual(unfiltered)
    expect(buildSessionGroups(sessions, { search: '   ' })).toEqual(unfiltered)
    expect(buildSessionGroups(sessions, {})).toEqual(unfiltered)
    expect(buildSessionGroups(sessions)).toEqual(unfiltered)
  })

  it('trims the needle and matches substrings', () => {
    const groups = buildSessionGroups(sessions, { search: '  vector ' })
    expect(groups.managed[0]!.sessions.map((s) => s.id)).toEqual(['s2'])
    expect(groups.archived.map((s) => s.id)).toEqual(['a1'])
  })

  it('yields empty buckets when nothing matches', () => {
    const groups = buildSessionGroups(sessions, { search: 'no-such-session' })
    expect(groups).toEqual({ managed: [], local: [], archived: [] })
  })
})

// --- Purity ---

describe('buildSessionGroups — purity', () => {
  it('does not mutate the input array or reorder it', () => {
    const sessions = [
      managedSession('s2', 'feat/b', '2026-01-02T10:00:00Z'),
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
      makeSession({ id: 'l1', workspace_binding: LOCAL_BINDING }),
    ]
    const snapshot = sessions.map((s) => s.id)
    buildSessionGroups(sessions)
    expect(sessions.map((s) => s.id)).toEqual(snapshot)
  })

  it('returns fresh arrays, never input references', () => {
    const sessions = [
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
      makeSession({ id: 'l1', workspace_binding: LOCAL_BINDING }),
      makeSession({ id: 'a1', archived: true }),
    ]
    const groups = buildSessionGroups(sessions)
    expect(groups.local).not.toBe(sessions)
    expect(groups.archived).not.toBe(sessions)
    for (const group of groups.managed) {
      expect(group.sessions).not.toBe(sessions)
    }
  })
})
