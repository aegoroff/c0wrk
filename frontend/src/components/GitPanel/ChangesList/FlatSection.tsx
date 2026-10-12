import { Fragment, useMemo } from 'react'
import { GitFileEntry } from '../GitFileEntry'
import { groupEntries } from '@/lib/gitSortGroup'
import { stripRootPrefix } from '@/lib/gitStatus'
import type { StageSide, StageToggleHandler } from '@/lib/gitStatus'
import type { GitPanelEntry, GroupBy } from '@/stores/gitPanelStore'

// ───────────────────────────── Flat Section ──────────────────────────────────

interface FlatSectionProps {
  /** Entries for this section — already sorted by the caller. */
  entries: GitPanelEntry[]
  /** Porcelain axis this section's rows act on (index | worktree). */
  side: StageSide
  /** Sub-grouping criterion applied within the section (D8). */
  groupBy: GroupBy
  /** Root the display strings are relative to (focus root, else workspace). */
  displayRoot: string
  onToggleFile: StageToggleHandler
  onOpenDiff: (path: string) => void
}

/**
 * Render a directory group label relative to the display root. Absolute
 * parent-directory keys (produced by `groupEntries`) are stripped of the
 * display root for display (via the shared `stripRootPrefix` segment-boundary
 * semantics); the `(root)` sentinel is shown as-is, and a label that IS the
 * root itself collapses back to the sentinel.
 */
function displayDirLabel(label: string, displayRoot: string): string {
  if (label === '(root)') return '(root)'
  const rel = stripRootPrefix(label, displayRoot)
  return rel === '' ? '(root)' : rel
}

/** Compact sub-group header rendered above each group of files. */
function SubGroupHeader({ label }: { label: string }) {
  return (
    <div className="px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70 select-none">
      {label}
    </div>
  )
}

export function FlatSection({
  entries,
  side,
  groupBy,
  displayRoot,
  onToggleFile,
  onOpenDiff,
}: FlatSectionProps) {
  const groups = useMemo(
    () => (groupBy === 'none' ? null : groupEntries(entries, groupBy)),
    [entries, groupBy],
  )

  // No sub-grouping — render entries directly (already sorted).
  if (groups === null) {
    return (
      <>
        {entries.map((entry) => (
          <GitFileEntry
            key={entry.path}
            entry={entry}
            side={side}
            displayRoot={displayRoot}
            onToggle={onToggleFile}
            onOpenDiff={onOpenDiff}
          />
        ))}
      </>
    )
  }

  // Sub-grouped — render a header above each group of files.
  return (
    <>
      {Array.from(groups, ([label, items]) => (
        <Fragment key={label}>
          <SubGroupHeader
            label={groupBy === 'directory' ? displayDirLabel(label, displayRoot) : label}
          />
          {items.map((entry) => (
            <GitFileEntry
              key={entry.path}
              entry={entry}
              side={side}
              displayRoot={displayRoot}
              onToggle={onToggleFile}
              onOpenDiff={onOpenDiff}
            />
          ))}
        </Fragment>
      ))}
    </>
  )
}
