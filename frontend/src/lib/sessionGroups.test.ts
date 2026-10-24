// Unit tests for sessionGroups — pure sidebar grouping model
// (managed branch groups per ADR-080, shared-branch merging per ADR-082).

import { describe, it, expect } from 'vitest'
import {
  buildSessionGroups,
  branchGroupKey,
  compareByActivity,
  freshestSession,
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
    expect(groups.worktrees).toHaveLength(1)
    expect(groups.worktrees[0]!.branch).toBe('feat/a')
    expect(groups.worktrees[0]!.sessions.map((s) => s.id)).toEqual(['s1'])
    expect(groups.local).toEqual([])
    expect(groups.archivedWorktrees).toEqual([])
    expect(groups.archivedLocal).toEqual([])
  })

  it('routes kind local into the local bucket', () => {
    const groups = buildSessionGroups([
      makeSession({ id: 's1', workspace_binding: LOCAL_BINDING }),
    ])
    expect(groups.worktrees).toEqual([])
    expect(groups.local.map((s) => s.id)).toEqual(['s1'])
  })

  it('routes sessions without a binding into the local bucket', () => {
    const groups = buildSessionGroups([
      makeSession({ id: 'chat1', workspace_binding: undefined }),
    ])
    expect(groups.worktrees).toEqual([])
    expect(groups.local.map((s) => s.id)).toEqual(['chat1'])
  })

  it('routes archived managed sessions into archivedWorktrees groups keyed by branch', () => {
    const groups = buildSessionGroups([
      managedSession('s-arch', 'feat/a', '2026-01-01T10:00:00Z', { archived: true }),
    ])
    expect(groups.archivedWorktrees).toHaveLength(1)
    expect(groups.archivedWorktrees[0]!.branch).toBe('feat/a')
    expect(groups.archivedWorktrees[0]!.sessions.map((s) => s.id)).toEqual(['s-arch'])
    expect(groups.worktrees).toEqual([])
    expect(groups.local).toEqual([])
    expect(groups.archivedLocal).toEqual([])
  })

  it('routes archived local and unbound sessions into archivedLocal', () => {
    const groups = buildSessionGroups([
      makeSession({ id: 'l-arch', workspace_binding: LOCAL_BINDING, archived: true }),
      makeSession({ id: 'u-arch', workspace_binding: undefined, archived: true }),
    ])
    expect(groups.archivedLocal.map((s) => s.id)).toEqual(['l-arch', 'u-arch'])
    expect(groups.archivedWorktrees).toEqual([])
    expect(groups.local).toEqual([])
  })

  it('splits archived sessions by binding without touching the live sections', () => {
    const groups = buildSessionGroups([
      managedSession('s-arch', 'feat/a', '2026-01-01T10:00:00Z', { archived: true }),
      makeSession({ id: 'l-arch', workspace_binding: LOCAL_BINDING, archived: true }),
      managedSession('s-live', 'feat/a', '2026-01-02T10:00:00Z'),
    ])
    expect(groups.archivedWorktrees[0]!.sessions.map((s) => s.id)).toEqual(['s-arch'])
    expect(groups.archivedLocal.map((s) => s.id)).toEqual(['l-arch'])
    expect(groups.worktrees[0]!.sessions.map((s) => s.id)).toEqual(['s-live'])
    expect(groups.local).toEqual([])
  })

  it('returns four empty buckets for empty input', () => {
    expect(buildSessionGroups([])).toEqual({
      worktrees: [],
      local: [],
      archivedWorktrees: [],
      archivedLocal: [],
    })
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
    expect(groups.worktrees).toHaveLength(1)
    expect(groups.worktrees[0]!.branch).toBe('feat/a')
    // Members merge, then sort pinned → freshness inside the group.
    expect(groups.worktrees[0]!.sessions.map((s) => s.id)).toEqual(['s2', 's3', 's1'])
  })

  it('merges archived sessions sharing one branch into a single archivedWorktrees group', () => {
    const groups = buildSessionGroups([
      managedSession('a1', 'feat/dead', '2026-01-02T10:00:00Z', { archived: true }),
      managedSession('a2', 'feat/dead', '2026-01-01T10:00:00Z', { archived: true }),
    ])
    expect(groups.archivedWorktrees).toHaveLength(1)
    expect(groups.archivedWorktrees[0]!.branch).toBe('feat/dead')
    expect(groups.archivedWorktrees[0]!.sessions.map((s) => s.id)).toEqual(['a1', 'a2'])
    // Archived and live sessions sharing a branch stay in separate sections.
    const mixed = buildSessionGroups([
      managedSession('a1', 'feat/dead', '2026-01-02T10:00:00Z', { archived: true }),
      managedSession('s1', 'feat/dead', '2026-01-03T10:00:00Z'),
    ])
    expect(mixed.archivedWorktrees[0]!.sessions.map((s) => s.id)).toEqual(['a1'])
    expect(mixed.worktrees[0]!.sessions.map((s) => s.id)).toEqual(['s1'])
  })

  it('keeps distinct branches in separate groups', () => {
    const groups = buildSessionGroups([
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
      managedSession('s2', 'feat/b', '2026-01-02T10:00:00Z'),
    ])
    expect(groups.worktrees.map((g) => g.branch)).toEqual(['feat/b', 'feat/a'])
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
    expect(groups.archivedLocal.map((s) => s.id)).toEqual(['a2', 'a1'])
  })

  it('orders managed groups by their freshest session, most recent first', () => {
    const groups = buildSessionGroups([
      // 'feat/old' group's freshest session is older than the others'.
      managedSession('o1', 'feat/old', '2026-01-01T10:00:00Z'),
      managedSession('o2', 'feat/old', '2026-01-02T10:00:00Z'),
      managedSession('m1', 'feat/mid', '2026-01-03T10:00:00Z'),
      managedSession('n1', 'feat/new', '2026-01-05T10:00:00Z'),
    ])
    expect(groups.worktrees.map((g) => g.branch)).toEqual([
      'feat/new',
      'feat/mid',
      'feat/old',
    ])
  })

  it('applies the same group ordering to archivedWorktrees as to managed', () => {
    const groups = buildSessionGroups([
      managedSession('o1', 'feat/old', '2026-01-01T10:00:00Z', { archived: true }),
      managedSession('n1', 'feat/new', '2026-01-05T10:00:00Z', { archived: true }),
      managedSession('z1', 'feat/zeta', '2026-01-03T10:00:00Z', { archived: true }),
      managedSession('y1', 'feat/yota', '2026-01-03T10:00:00Z', { archived: true }),
    ])
    // Freshest group first; the freshness tie between feat/zeta and feat/yota
    // breaks alphabetically — the same tiebreak the live section uses.
    expect(groups.archivedWorktrees.map((g) => g.branch)).toEqual([
      'feat/new',
      'feat/yota',
      'feat/zeta',
      'feat/old',
    ])
    // Members are sorted pinned → freshness inside archived groups too.
    const pinnedFirst = buildSessionGroups([
      managedSession('p1', 'feat/dead', '2026-01-01T10:00:00Z', { archived: true, pinned: true }),
      managedSession('f1', 'feat/dead', '2026-01-02T10:00:00Z', { archived: true }),
    ])
    expect(pinnedFirst.archivedWorktrees[0]!.sessions.map((s) => s.id)).toEqual(['p1', 'f1'])
  })

  it('breaks group-order ties alphabetically by branch name', () => {
    const t = '2026-01-02T10:00:00Z'
    const groups = buildSessionGroups([
      managedSession('z', 'feat/zeta', t),
      managedSession('a', 'feat/alpha', t),
    ])
    expect(groups.worktrees.map((g) => g.branch)).toEqual(['feat/alpha', 'feat/zeta'])
  })

  it('a pinned session does not promote its group — freshness decides', () => {
    const groups = buildSessionGroups([
      managedSession('p1', 'feat/pinned', '2026-01-01T10:00:00Z', { pinned: true }),
      managedSession('f1', 'feat/fresh', '2026-01-04T10:00:00Z'),
    ])
    expect(groups.worktrees.map((g) => g.branch)).toEqual(['feat/fresh', 'feat/pinned'])
    // …but the pinned session still leads inside its own group.
    expect(groups.worktrees[1]!.sessions.map((s) => s.id)).toEqual(['p1'])
  })
})

// --- Group-level pin ---

describe('buildSessionGroups — pinnedBranches (group-level pin)', () => {
  it('floats a pinned branch group above the unpinned ones', () => {
    const groups = buildSessionGroups(
      [
        managedSession('p1', 'feat/pinned', '2026-01-01T10:00:00Z'),
        managedSession('f1', 'feat/fresh', '2026-01-04T10:00:00Z'),
        managedSession('m1', 'feat/mid', '2026-01-03T10:00:00Z'),
      ],
      { pinnedBranches: ['feat/pinned'] },
    )
    // The pinned (stale) group leads; the rest keep the freshness order.
    expect(groups.worktrees.map((g) => g.branch)).toEqual([
      'feat/pinned',
      'feat/fresh',
      'feat/mid',
    ])
  })

  it('orders several pinned groups among themselves by freshness', () => {
    const groups = buildSessionGroups(
      [
        managedSession('a1', 'feat/a', '2026-01-01T10:00:00Z'),
        managedSession('b1', 'feat/b', '2026-01-02T10:00:00Z'),
      ],
      { pinnedBranches: ['feat/a', 'feat/b'] },
    )
    expect(groups.worktrees.map((g) => g.branch)).toEqual(['feat/b', 'feat/a'])
  })

  it('applies the same rule to archivedWorktrees', () => {
    const groups = buildSessionGroups(
      [
        managedSession('p1', 'feat/pinned', '2026-01-01T10:00:00Z', { archived: true }),
        managedSession('f1', 'feat/fresh', '2026-01-04T10:00:00Z', { archived: true }),
      ],
      { pinnedBranches: ['feat/pinned'] },
    )
    expect(groups.archivedWorktrees.map((g) => g.branch)).toEqual([
      'feat/pinned',
      'feat/fresh',
    ])
  })

  it('a group-level pin does not reorder members inside the group', () => {
    const groups = buildSessionGroups(
      [
        managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
        managedSession('s2', 'feat/a', '2026-01-02T10:00:00Z'),
      ],
      { pinnedBranches: ['feat/a'] },
    )
    expect(groups.worktrees[0]!.sessions.map((s) => s.id)).toEqual(['s2', 's1'])
  })

  it('an unknown branch name in pinnedBranches is harmless', () => {
    const groups = buildSessionGroups([managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z')], {
      pinnedBranches: ['feat/nope'],
    })
    expect(groups.worktrees.map((g) => g.branch)).toEqual(['feat/a'])
  })
})

// --- Search ---

describe('buildSessionGroups — search filtering', () => {
  const sessions = [
    managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z', { name: 'Refactor sidebar' }),
    managedSession('s2', 'feat/b', '2026-01-02T10:00:00Z', { name: 'Fix vector index' }),
    managedSession('s3', 'arch/x', '2026-01-01T10:00:00Z', { archived: true, name: 'Old sidebar experiments' }),
    makeSession({ id: 'l1', workspace_binding: LOCAL_BINDING, name: 'Sidebar polish' }),
    makeSession({ id: 'a1', archived: true, name: 'Old vector experiments' }),
  ]

  it('filters by name case-insensitively', () => {
    const groups = buildSessionGroups(sessions, { search: 'SIDEBAR' })
    expect(groups.worktrees[0]!.sessions.map((s) => s.id)).toEqual(['s1'])
    expect(groups.local.map((s) => s.id)).toEqual(['l1'])
    expect(groups.archivedWorktrees[0]!.sessions.map((s) => s.id)).toEqual(['s3'])
    expect(groups.archivedLocal).toEqual([])
  })

  it('omits groups left without matching members', () => {
    const groups = buildSessionGroups(sessions, { search: 'vector' })
    // 'feat/a' held only the sidebar session — the empty group is hidden.
    expect(groups.worktrees).toHaveLength(1)
    expect(groups.worktrees[0]!.branch).toBe('feat/b')
    expect(groups.worktrees[0]!.sessions.map((s) => s.id)).toEqual(['s2'])
    expect(groups.local).toEqual([])
    // 'arch/x' held only the sidebar experiment — hidden the same way.
    expect(groups.archivedWorktrees).toEqual([])
    expect(groups.archivedLocal.map((s) => s.id)).toEqual(['a1'])
  })

  it('treats blank/whitespace search as no filter', () => {
    const unfiltered = buildSessionGroups(sessions)
    expect(buildSessionGroups(sessions, { search: '' })).toEqual(unfiltered)
    expect(buildSessionGroups(sessions, { search: '   ' })).toEqual(unfiltered)
    expect(buildSessionGroups(sessions, { search: undefined })).toEqual(unfiltered)
    expect(buildSessionGroups(sessions)).toEqual(unfiltered)
  })

  it('trims the needle and matches substrings', () => {
    const groups = buildSessionGroups(sessions, { search: '  vector ' })
    expect(groups.worktrees[0]!.sessions.map((s) => s.id)).toEqual(['s2'])
    expect(groups.archivedWorktrees).toEqual([])
    expect(groups.archivedLocal.map((s) => s.id)).toEqual(['a1'])
  })

  it('yields empty buckets when nothing matches', () => {
    const groups = buildSessionGroups(sessions, { search: 'no-such-session' })
    expect(groups).toEqual({
      worktrees: [],
      local: [],
      archivedWorktrees: [],
      archivedLocal: [],
    })
  })
})

// --- Active-session awareness (live sections only) ---

describe('buildSessionGroups — activeSessionId (live sections only)', () => {
  it('floats the group holding the active session above fresher unpinned groups, below a GROUP-pinned group', () => {
    const groups = buildSessionGroups(
      [
        managedSession('a1', 'feat/stale', '2026-01-01T10:00:00Z'),
        managedSession('f1', 'feat/fresh', '2026-01-05T10:00:00Z'),
        managedSession('m1', 'feat/mid', '2026-01-03T10:00:00Z'),
      ],
      { pinnedBranches: ['feat/fresh'], activeSessionId: 'a1' },
    )
    // feat/stale holds the active session: it beats the fresher unpinned
    // feat/mid but still loses to the GROUP-pinned feat/fresh. Without the
    // option the freshness order would be fresh → mid → stale.
    expect(groups.worktrees.map((g) => g.branch)).toEqual([
      'feat/fresh',
      'feat/stale',
      'feat/mid',
    ])
  })

  it('surfaces the active session inside its group right below pinned members', () => {
    const groups = buildSessionGroups(
      [
        managedSession('p1', 'feat/a', '2026-01-01T10:00:00Z', { pinned: true }),
        managedSession('f1', 'feat/a', '2026-01-05T10:00:00Z'),
        managedSession('act', 'feat/a', '2026-01-02T10:00:00Z'),
        managedSession('m1', 'feat/a', '2026-01-03T10:00:00Z'),
      ],
      { activeSessionId: 'act' },
    )
    // Pinned p1 leads; the active session cuts in below it (beating the
    // fresher m1/f1); the rest keep the freshness order.
    expect(groups.worktrees[0]!.sessions.map((s) => s.id)).toEqual([
      'p1',
      'act',
      'f1',
      'm1',
    ])
  })

  it('applies the same member rule to the local bucket — active first below pinned locals', () => {
    const groups = buildSessionGroups(
      [
        makeSession({
          id: 'lp',
          workspace_binding: LOCAL_BINDING,
          last_active_at: '2026-01-01T10:00:00Z',
          pinned: true,
        }),
        makeSession({ id: 'lf', workspace_binding: LOCAL_BINDING, last_active_at: '2026-01-05T10:00:00Z' }),
        makeSession({ id: 'lact', workspace_binding: LOCAL_BINDING, last_active_at: '2026-01-02T10:00:00Z' }),
        makeSession({ id: 'lu', last_active_at: '2026-01-01T11:00:00Z' }),
      ],
      { activeSessionId: 'lact' },
    )
    expect(groups.local.map((s) => s.id)).toEqual(['lp', 'lact', 'lf', 'lu'])
  })

  it('keeps the previous ordering for a null/undefined active id', () => {
    const sessions = [
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z', { pinned: true }),
      managedSession('s2', 'feat/a', '2026-01-03T10:00:00Z'),
      managedSession('s3', 'feat/b', '2026-01-02T10:00:00Z'),
      makeSession({ id: 'l1', workspace_binding: LOCAL_BINDING, last_active_at: '2026-01-04T10:00:00Z' }),
    ]
    const baseline = buildSessionGroups(sessions)
    expect(buildSessionGroups(sessions, { activeSessionId: null })).toEqual(baseline)
    expect(buildSessionGroups(sessions, { activeSessionId: undefined })).toEqual(baseline)
  })

  it('keeps the previous ordering for an unknown active id', () => {
    const sessions = [
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
      managedSession('s2', 'feat/a', '2026-01-02T10:00:00Z'),
      makeSession({ id: 'l1', workspace_binding: LOCAL_BINDING }),
    ]
    const baseline = buildSessionGroups(sessions)
    expect(buildSessionGroups(sessions, { activeSessionId: 'no-such-id' })).toEqual(baseline)
  })

  it('leaves both archived buckets byte-identical when the option is set', () => {
    const sessions = [
      managedSession('n-arch', 'feat/newer', '2026-01-05T10:00:00Z', { archived: true }),
      managedSession('f-arch', 'feat/dead', '2026-01-02T10:00:00Z', { archived: true }),
      managedSession('p-arch', 'feat/dead', '2026-01-01T10:00:00Z', { archived: true, pinned: true }),
      makeSession({ id: 'l-arch', archived: true, last_active_at: '2026-01-04T10:00:00Z' }),
      makeSession({ id: 'u-arch', archived: true, last_active_at: '2026-01-03T10:00:00Z' }),
      managedSession('live1', 'feat/alive', '2026-01-06T10:00:00Z'),
    ]
    const baseline = buildSessionGroups(sessions)
    // The option naming a LIVE session changes nothing in the archive…
    const liveActive = buildSessionGroups(sessions, { activeSessionId: 'live1' })
    expect(liveActive.archivedWorktrees).toEqual(baseline.archivedWorktrees)
    expect(liveActive.archivedLocal).toEqual(baseline.archivedLocal)
    // …and neither does naming an ARCHIVED session — no active awareness at
    // all: feat/dead (holding f-arch) must not float above feat/newer, and
    // f-arch must not cut in below the pinned p-arch.
    const archivedActive = buildSessionGroups(sessions, { activeSessionId: 'f-arch' })
    expect(archivedActive.archivedWorktrees).toEqual(baseline.archivedWorktrees)
    expect(archivedActive.archivedLocal).toEqual(baseline.archivedLocal)
  })

  it('does not float the active group or member when search hides the active session', () => {
    const sessions = [
      managedSession('act', 'feat/stale', '2026-01-01T10:00:00Z', { name: 'Active work' }),
      managedSession('f1', 'feat/a', '2026-01-05T10:00:00Z', { name: 'Sidebar fix' }),
      managedSession('m1', 'feat/a', '2026-01-03T10:00:00Z', { name: 'Sidebar polish' }),
    ]
    const searched = buildSessionGroups(sessions, { search: 'sidebar', activeSessionId: 'act' })
    // The active session (and its whole group) is filtered out; the surviving
    // group keeps the plain freshness order of its remaining members.
    expect(searched.worktrees.map((g) => g.branch)).toEqual(['feat/a'])
    expect(searched.worktrees[0]!.sessions.map((s) => s.id)).toEqual(['f1', 'm1'])
  })
})

// --- Purity ---

describe('buildSessionGroups — purity', () => {
  it('does not mutate the input array or reorder it', () => {
    const sessions = [
      managedSession('s2', 'feat/b', '2026-01-02T10:00:00Z'),
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
      makeSession({ id: 'l1', workspace_binding: LOCAL_BINDING }),
      managedSession('a1', 'arch/x', '2026-01-01T10:00:00Z', { archived: true }),
    ]
    const snapshot = sessions.map((s) => s.id)
    buildSessionGroups(sessions)
    expect(sessions.map((s) => s.id)).toEqual(snapshot)
  })

  it('returns fresh arrays, never input references', () => {
    const sessions = [
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
      makeSession({ id: 'l1', workspace_binding: LOCAL_BINDING }),
      managedSession('a1', 'arch/x', '2026-01-01T10:00:00Z', { archived: true }),
      makeSession({ id: 'a2', archived: true }),
    ]
    const groups = buildSessionGroups(sessions)
    expect(groups.local).not.toBe(sessions)
    expect(groups.archivedLocal).not.toBe(sessions)
    for (const group of groups.worktrees) {
      expect(group.sessions).not.toBe(sessions)
    }
    for (const group of groups.archivedWorktrees) {
      expect(group.sessions).not.toBe(sessions)
    }
  })
})

describe('freshestSession', () => {
  it('returns null for an empty group', () => {
    expect(freshestSession([])).toBeNull()
  })

  it('picks the most recently active member', () => {
    const sessions = [
      managedSession('s1', 'feat/a', '2026-01-01T10:00:00Z'),
      managedSession('s2', 'feat/a', '2026-01-02T10:00:00Z'),
      managedSession('s3', 'feat/a', '2026-01-01T18:00:00Z'),
    ]
    expect(freshestSession(sessions)?.id).toBe('s2')
  })

  it('falls back to created_at when a session was never activated', () => {
    const sessions = [
      makeSession({ id: 's1', created_at: '2026-01-05T10:00:00Z', last_active_at: '' }),
      managedSession('s2', 'feat/a', '2026-01-02T10:00:00Z'),
    ]
    expect(freshestSession(sessions)?.id).toBe('s1')
  })
})
