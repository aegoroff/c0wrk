import type { SessionInfo } from '@/types/models'

// ──────────────────────────── Collapse keys ──────────────────────────────────

/**
 * Stable collapse-section keys used by the sidebar UI to persist the
 * expanded/collapsed state of each group:
 *
 * - every managed branch group collapses under `branch:<branch>`
 *   (see {@link branchGroupKey});
 * - the whole managed section collapses under `managed`;
 * - the local section under `local`;
 * - the archive section under `archived`.
 */
export const MANAGED_SECTION_KEY = 'managed'
export const LOCAL_SECTION_KEY = 'local'
export const ARCHIVED_SECTION_KEY = 'archived'

/** Collapse key of the managed branch group for the given branch name. */
export function branchGroupKey(branch: string): string {
  return `branch:${branch}`
}

/** DOM id of a collapsible section's content region — the `aria-controls`
 *  target named by its header (Managed/Local in the grouped list, Archived in
 *  SessionSelector) or by a managed branch's row toggle. The region div
 *  renders exactly while the content does, so a set `aria-controls` always
 *  names a live element. Branch names may contain `/` or `:` — legal id
 *  characters (only CSS selectors would care, and we never select by these). */
export function sessionRegionId(key: string): string {
  return `session-region-${key}`
}

// ──────────────────────────────── Types ──────────────────────────────────────

/** All non-archived sessions bound to one managed worktree branch (ADR-080).
 *  Several sessions may share a branch — shared trees are legal since
 *  ADR-082 — so they merge into a single group. */
export interface ManagedBranchGroup {
  /** The pinned branch name (from `workspace_binding.branch`). */
  readonly branch: string
  /** Group members, ordered pinned → freshness. */
  readonly sessions: SessionInfo[]
}

/**
 * The ordered sidebar grouping model for one project's sessions:
 *
 * 1. `managed` — branch groups, ordered by each group's freshest session.
 * 2. `local` — sessions pinned to the project checkout (`kind: 'local'`) or
 *    carrying no `workspace_binding` at all (older backends / CHAT).
 * 3. `archived` — archived sessions regardless of binding.
 */
export interface SessionGroups {
  readonly managed: ManagedBranchGroup[]
  readonly local: SessionInfo[]
  readonly archived: SessionInfo[]
}

export interface BuildSessionGroupsOptions {
  /** Case-insensitive substring filter on the session name. Blank/whitespace
   *  values disable filtering. Groups left without members are omitted. */
  readonly search?: string
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

/** Freshness of the most recently active member — the group-order key. */
function freshestActivity(sessions: readonly SessionInfo[]): number {
  let max = Number.NEGATIVE_INFINITY
  for (const session of sessions) {
    const t = lastActiveTime(session)
    if (t > max) max = t
  }
  return max
}

/** Return a **new** array sorted pinned → freshness. Pure: does not mutate
 *  the input array or any session object. */
function sortByActivity(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [...sessions].sort(compareByActivity)
}

// ──────────────────────────────── Grouping ───────────────────────────────────

/**
 * Build the ordered sidebar grouping model for a project's sessions.
 *
 * Classification (per session, after the optional search filter):
 *
 * - `session.archived` → the `archived` bucket (binding ignored);
 * - `workspace_binding.kind === 'managed_worktree'` → the managed group of
 *   `binding.branch`; sessions sharing one branch merge into a single group
 *   (shared managed trees are legal per ADR-082);
 * - everything else (`kind: 'local'` or no binding at all) → `local`.
 *
 * Ordering:
 *
 * - sessions inside every bucket/group: pinned → freshness (the
 *   {@link compareByActivity} order);
 * - managed branch groups: by their freshest session, most recent first;
 *   alphabetical branch name as the deterministic tiebreak.
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
  const archived: SessionInfo[] = []
  const byBranch = new Map<string, SessionInfo[]>()

  for (const session of visible) {
    if (session.archived) {
      archived.push(session)
      continue
    }
    const binding = session.workspace_binding
    if (binding?.kind === 'managed_worktree') {
      // The backend always pins `branch` on managed bindings; fall back to the
      // tree name (then a sentinel) so a malformed payload still groups.
      const branch = binding.branch || binding.worktree_name || '(unknown)'
      const members = byBranch.get(branch)
      if (members) members.push(session)
      else byBranch.set(branch, [session])
      continue
    }
    local.push(session)
  }

  const managed: ManagedBranchGroup[] = [...byBranch.entries()]
    .map(([branch, members]) => ({
      branch,
      sessions: sortByActivity(members),
    }))
    .sort((a, b) => {
      const byFreshness = freshestActivity(b.sessions) - freshestActivity(a.sessions)
      if (byFreshness !== 0) return byFreshness
      return a.branch.localeCompare(b.branch)
    })

  return {
    managed,
    local: sortByActivity(local),
    archived: sortByActivity(archived),
  }
}
