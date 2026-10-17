import type { SessionInfo, WorkspaceBinding } from '@/types/models'

// ──────────────────────────── Collapse keys ──────────────────────────────────

/**
 * Stable collapse-section keys used by the sidebar UI to persist the
 * expanded/collapsed state of each group:
 *
 * - every managed branch group collapses under `branch:<branch>`
 *   (see {@link branchGroupKey});
 * - the whole worktrees section collapses under `managed` (kept value — see
 *   {@link MANAGED_SECTION_KEY});
 * - the local section under `local`;
 * - the archive section under `archived`.
 */
/** Collapse key of the worktrees section — kept as 'managed' (the value the
 *  sidebar has always persisted) so existing collapse state survives the
 *  section's rename. */
export const MANAGED_SECTION_KEY = 'managed'
export const LOCAL_SECTION_KEY = 'local'
export const ARCHIVED_SECTION_KEY = 'archived'

/** Collapse key of the managed branch group for the given branch name. */
export function branchGroupKey(branch: string): string {
  return `branch:${branch}`
}

/** DOM id of a collapsible section's content region — the `aria-controls`
 *  target named by its header (Worktrees/Local in the grouped list, Archived in
 *  SessionSelector) or by a managed branch's row toggle. The region div
 *  renders exactly while the content does, so a set `aria-controls` always
 *  names a live element. Branch names may contain `/` or `:` — legal id
 *  characters (only CSS selectors would care, and we never select by these). */
export function sessionRegionId(key: string): string {
  return `session-region-${key}`
}

// ──────────────────────────────── Types ──────────────────────────────────────

/** All sessions — live or archived — bound to one managed worktree branch
 *  (ADR-080). Several sessions may share a branch — shared trees are legal
 *  since ADR-082 — so they merge into a single group. */
export interface ManagedBranchGroup {
  /** The pinned branch name (from `workspace_binding.branch`). */
  readonly branch: string
  /** Group members, ordered pinned → freshness. */
  readonly sessions: SessionInfo[]
}

/**
 * The ordered sidebar grouping model for one project's sessions:
 *
 * 1. `worktrees` — branch groups, GROUP-pinned first, then by each group's
 *    freshest session.
 * 2. `local` — sessions pinned to the project checkout (`kind: 'local'`) or
 *    carrying no `workspace_binding` at all (older backends / CHAT).
 * 3. `archivedWorktrees` — archived sessions on managed branches, grouped by
 *    branch under the same rules as `worktrees`.
 * 4. `archivedLocal` — archived sessions with a local binding or no binding.
 */
export interface SessionGroups {
  readonly worktrees: ManagedBranchGroup[]
  readonly local: SessionInfo[]
  readonly archivedWorktrees: ManagedBranchGroup[]
  readonly archivedLocal: SessionInfo[]
}

export interface BuildSessionGroupsOptions {
  /** Case-insensitive substring filter on the session name. Blank/whitespace
   *  values disable filtering. Groups left without members are omitted. */
  readonly search?: string
  /** Branch names the user PINNED at the group level (pinnedGroupsStore) —
   *  a pinned group floats above the unpinned ones of its section. Does NOT
   *  touch per-session pins, which only order members inside a group. */
  readonly pinnedBranches?: readonly string[]
}

// ──────────────────────────────── Sorting ────────────────────────────────────

/** Freshness timestamp of a session: `last_active_at`, falling back to
 *  `created_at` when the session was never activated. */
export function lastActiveTime(session: SessionInfo): number {
  return new Date(session.last_active_at || session.created_at).getTime()
}

/**
 * Comparator mirroring the sidebar's canonical order — the same one
 * `sessionStore.sortByActivity` applies: pinned sessions surface to the top,
 * then freshest activity first. Kept here (duplicated on purpose) so this
 * module stays a pure helper with no store/zustand imports.
 */
export function compareByActivity(a: SessionInfo, b: SessionInfo): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return lastActiveTime(b) - lastActiveTime(a)
}

/**
 * The group's most recently active member — the branch-row clock (the same
 * freshness the group ORDER keys on). Empty input returns null.
 */
export function freshestSession(sessions: readonly SessionInfo[]): SessionInfo | null {
  let best: SessionInfo | null = null
  for (const session of sessions) {
    if (best === null || lastActiveTime(session) > lastActiveTime(best)) best = session
  }
  return best
}

/** Freshness of the most recently active member — the group-order key. */
function freshestActivity(sessions: readonly SessionInfo[]): number {
  const freshest = freshestSession(sessions)
  return freshest !== null ? lastActiveTime(freshest) : Number.NEGATIVE_INFINITY
}

/** Return a **new** array sorted pinned → freshness. Pure: does not mutate
 *  the input array or any session object. */
function sortByActivity(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [...sessions].sort(compareByActivity)
}

/** Branch key of a managed binding. The backend always pins `branch`; fall
 *  back to the tree name (then a sentinel) so a malformed payload still
 *  groups. */
function managedBranchKey(binding: WorkspaceBinding): string {
  return binding.branch || binding.worktree_name || '(unknown)'
}

/** Merge `session` into the branch group `branch` — sessions sharing one
 *  branch form a single group (shared managed trees are legal per ADR-082). */
function addToBranchGroups(
  byBranch: Map<string, SessionInfo[]>,
  branch: string,
  session: SessionInfo,
): void {
  const members = byBranch.get(branch)
  if (members) members.push(session)
  else byBranch.set(branch, [session])
}

/** Materialise branch groups under the canonical rules: members sorted
 *  pinned → freshness, groups ordered by the GROUP-level pin (pinned groups
 *  first), then each group's freshest session (most recent first),
 *  alphabetical branch name as the deterministic tiebreak. */
function orderedBranchGroups(
  byBranch: Map<string, SessionInfo[]>,
  pinned: ReadonlySet<string>,
): ManagedBranchGroup[] {
  return [...byBranch.entries()]
    .map(([branch, members]) => ({ branch, sessions: sortByActivity(members) }))
    .sort((a, b) => {
      const byGroupPin = Number(pinned.has(b.branch)) - Number(pinned.has(a.branch))
      if (byGroupPin !== 0) return byGroupPin
      const byFreshness = freshestActivity(b.sessions) - freshestActivity(a.sessions)
      if (byFreshness !== 0) return byFreshness
      return a.branch.localeCompare(b.branch)
    })
}

// ──────────────────────────────── Grouping ───────────────────────────────────

/**
 * Build the ordered sidebar grouping model for a project's sessions.
 *
 * Classification (per session, after the optional search filter):
 *
 * - `session.archived` on a managed binding → the `archivedWorktrees` group of
 *   `binding.branch`, under exactly the grouping/ordering rules of the live
 *   `worktrees` section;
 * - other archived sessions (local binding or none) → `archivedLocal`;
 * - `workspace_binding.kind === 'managed_worktree'` → the worktrees group of
 *   `binding.branch`; sessions sharing one branch merge into a single group
 *   (shared managed trees are legal per ADR-082);
 * - everything else (`kind: 'local'` or no binding at all) → `local`.
 *
 * Ordering:
 *
 * - sessions inside every bucket/group: pinned → freshness (the
 *   {@link compareByActivity} order);
 * - managed branch groups: GROUP-pinned branches first (the
 *   `pinnedBranches` option), then by their freshest session, most recent
 *   first; alphabetical branch name as the deterministic tiebreak.
 *
 * Search filters by name (case-insensitive substring, trimmed); groups left
 * without members simply do not appear in the result, so the UI hides them.
 *
 * Pure: does not mutate the input array or any session object.
 */
export function buildSessionGroups(
  sessions: readonly SessionInfo[],
  options: BuildSessionGroupsOptions = {},
): SessionGroups {
  const needle = (options.search ?? '').trim().toLowerCase()
  const visible =
    needle !== ''
      ? sessions.filter((s) => s.name.toLowerCase().includes(needle))
      : [...sessions]

  const local: SessionInfo[] = []
  const archivedLocal: SessionInfo[] = []
  const byBranch = new Map<string, SessionInfo[]>()
  const archivedByBranch = new Map<string, SessionInfo[]>()
  const pinned = new Set(options.pinnedBranches ?? [])

  for (const session of visible) {
    const binding = session.workspace_binding
    if (session.archived) {
      if (binding?.kind === 'managed_worktree') {
        addToBranchGroups(archivedByBranch, managedBranchKey(binding), session)
      } else {
        archivedLocal.push(session)
      }
      continue
    }
    if (binding?.kind === 'managed_worktree') {
      addToBranchGroups(byBranch, managedBranchKey(binding), session)
      continue
    }
    local.push(session)
  }

  return {
    worktrees: orderedBranchGroups(byBranch, pinned),
    local: sortByActivity(local),
    archivedWorktrees: orderedBranchGroups(archivedByBranch, pinned),
    archivedLocal: sortByActivity(archivedLocal),
  }
}
