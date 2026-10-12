import { useMemo } from 'react'
import { TreeRow } from './TreeRow'
import { buildTree } from './buildTree'
import type { StageSide, StageToggleHandler } from '@/lib/gitStatus'
import type { GitPanelEntry, SortBy } from '@/stores/gitPanelStore'

// ───────────────────────────── Tree Section ──────────────────────────────────

interface TreeSectionProps {
  entries: GitPanelEntry[]
  /** Porcelain axis this section's rows act on (index | worktree). */
  side: StageSide
  /** Sort criterion applied to leaf (file) nodes within the tree (D8). */
  sortBy: SortBy
  /** Root the display paths are relative to (focus root, else workspace). */
  displayRoot: string
  expandedDirs: Set<string>
  onToggleExpandedDir: (dir: string) => void
  onToggleFile: StageToggleHandler
  onOpenDiff: (path: string) => void
}

export function TreeSection({
  entries,
  side,
  sortBy,
  displayRoot,
  expandedDirs,
  onToggleExpandedDir,
  onToggleFile,
  onOpenDiff,
}: TreeSectionProps) {
  const tree = useMemo(
    () => buildTree(entries, displayRoot, sortBy),
    [entries, displayRoot, sortBy],
  )

  return (
    <>
      {tree.map((node) => (
        <TreeRow
          key={node.isDir ? node.fullPath : node.entry.path}
          node={node}
          depth={0}
          side={side}
          displayRoot={displayRoot}
          expandedDirs={expandedDirs}
          onToggleExpandedDir={onToggleExpandedDir}
          onToggleFile={onToggleFile}
          onOpenDiff={onOpenDiff}
        />
      ))}
    </>
  )
}
