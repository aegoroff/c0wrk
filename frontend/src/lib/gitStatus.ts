// Shared helpers for converting backend git status into store entries.
//
// Extracted from GitPanel/index.tsx and useGitStatusEvents.ts so the
// GitStatusEntry → GitPanelEntry mapping lives in exactly one place.

import type { GitPanelEntry } from '@/stores/gitPanelStore'
import type { GitStatusEntry } from '@/types/models'

/**
 * Convert a backend `GitStatusEntry` map (keyed by path) into the
 * `GitPanelEntry[]` shape consumed by the git panel store.
 *
 * The mapping is intentionally a straight passthrough of the porcelain
 * status codes (`status`, `indexStatus`, `worktreeStatus`) so that
 * downstream components can classify entries precisely (e.g. untracked
 * files carry `worktreeStatus === '?'`).
 */
export function toEntries(
  statusMap: Record<string, GitStatusEntry>,
): GitPanelEntry[] {
  return Object.entries(statusMap).map(([path, entry]) => ({
    path,
    status: entry.status,
    staged: entry.staged,
    diffStat: null,
    indexStatus: entry.index_status,
    worktreeStatus: entry.worktree_status,
  }))
}

// --- Display-path stripping ---
//
// The backend keys every git status entry onto the resolved focus worktree
// root (`resolveGitRepoRoot` → `resolveGitFocusRoot`), so an entry path is
// absolute under the FOCUS root — which for a managed session tree is a
// `.worktrees/<name>` directory nested inside the project checkout. Display
// paths must therefore be stripped against the focus root (falling back to
// the project workspace root only when no focus is resolved) — stripping by
// the workspace path would leave a `.worktrees/<name>/` prefix on every row.

/**
 * Strip the `root` prefix from `path` for display purposes, matching only at
 * a path-segment boundary so a sibling directory sharing the same prefix
 * (e.g. "/repo" vs "/repo-extra") is never stripped. An empty or non-matching
 * root returns `path` unchanged; a match returns the remainder without the
 * leading separator (possibly the empty string when `path === root`).
 *
 * Single source of truth for the segment-boundary strip: GitFileEntry's
 * display path, buildTree/collectAllDirPaths's tree keys, FlatSection's
 * directory-group labels, and GitFileContextMenu's .gitignore patterns and
 * operation labels all share this semantics.
 */
export function stripRootPrefix(path: string, root: string): string {
  if (root !== '' && (path === root || path.startsWith(root + '/'))) {
    return path.slice(root.length).replace(/^\//, '')
  }
  return path
}

// --- Two-axis porcelain classification ---
//
// `git status --porcelain` v1 reports every tracked path as a two-character
// `XY` pair: X is the INDEX (staged) status and Y is the WORKTREE (unstaged)
// status. A path can be modified on both axes at once (`MM`), so a single
// `staged` boolean is not enough to describe it — these helpers classify an
// entry along each axis independently and are the single source of truth for
// the Staged / Changes / Untracked split.

/** The porcelain axis a status character belongs to. */
export type StageSide = 'index' | 'worktree'

/** The bulk action a row can trigger on its axis. */
export type StageAction = 'stage' | 'unstage'

/**
 * Handler a changes-list row invokes to flip its axis state (`stage` or
 * `unstage`). It resolves `false` when the operation failed so the row can
 * revert its optimistic checkbox; `true` leaves the optimistic flip in place
 * until the next status refresh re-derives it.
 */
export type StageToggleHandler = (
  path: string,
  action: StageAction,
) => Promise<boolean>

/**
 * Two-char porcelain status combinations that indicate an unresolved merge
 * conflict (both axes together). Mirrors `git status`'s unmerged codes.
 */
export const CONFLICT_COMBOS: ReadonlySet<string> = new Set([
  'UU',
  'AA',
  'DD',
  'AU',
  'UD',
  'UA',
  'DU',
])

/**
 * True when the index/worktree status pair marks an unresolved merge conflict.
 * Conflict rows carry a non-empty index status, so they classify as staged and
 * are deliberately excluded from the unstaged axis.
 */
export function isMergeConflict(entry: GitPanelEntry): boolean {
  return CONFLICT_COMBOS.has(`${entry.indexStatus}${entry.worktreeStatus}`)
}

/**
 * True for a real porcelain change code on one axis: non-empty, not the
 * "unmodified" space, and not the untracked `?` marker. `!` (ignored) never
 * appears in `git status` output, so it is not special-cased here.
 */
function isChangeCode(code: string): boolean {
  return code !== '' && code !== ' ' && code !== '?'
}

/** True when the entry carries a modification on the index (staged) axis. */
export function hasStagedChanges(entry: GitPanelEntry): boolean {
  return isChangeCode(entry.indexStatus)
}

/**
 * True when the entry carries a modification on the worktree (unstaged) axis.
 * Excludes untracked (`?`) paths and merge-conflict rows — a conflict is
 * reported on the index axis, never as a plain unstaged modification.
 */
export function hasUnstagedChanges(entry: GitPanelEntry): boolean {
  return (
    isChangeCode(entry.worktreeStatus) &&
    !isUntracked(entry) &&
    !isMergeConflict(entry)
  )
}

/** True when the entry is an untracked (`?`) path. */
export function isUntracked(entry: GitPanelEntry): boolean {
  return entry.worktreeStatus === '?'
}

/** The three structural sections of the changes list. */
export interface ClassifiedEntries {
  staged: GitPanelEntry[]
  unstaged: GitPanelEntry[]
  untracked: GitPanelEntry[]
}

/**
 * Split entries into the Staged / Changes / Untracked sections. The split is
 * by-axis, not exclusive: a path modified on both axes (`MM`) appears in BOTH
 * `staged` and `unstaged`. Input order is preserved within each section.
 */
export function classifyEntries(entries: GitPanelEntry[]): ClassifiedEntries {
  return {
    staged: entries.filter(hasStagedChanges),
    unstaged: entries.filter(hasUnstagedChanges),
    untracked: entries.filter(isUntracked),
  }
}

/**
 * The status character to render for a row on the given axis: the axis's own
 * porcelain code (including the untracked `?`) when it carries one, else the
 * entry's overall `status` (covers older entries that only set
 * `status`/`staged`).
 */
export function rowStatusChar(entry: GitPanelEntry, side: StageSide): string {
  const code = side === 'index' ? entry.indexStatus : entry.worktreeStatus
  return code !== '' && code !== ' ' ? code : entry.status
}
