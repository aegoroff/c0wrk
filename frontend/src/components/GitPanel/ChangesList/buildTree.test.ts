import { describe, it, expect } from 'vitest'
import { buildTree, collectAllDirPaths } from './buildTree'
import type { GitPanelEntry } from '@/stores/gitPanelStore'

// --- Test helpers ---

function makeEntry(path: string): GitPanelEntry {
  return {
    path,
    status: 'M',
    staged: false,
    diffStat: null,
    indexStatus: '',
    worktreeStatus: '',
  }
}

describe('collectAllDirPaths', () => {
  it('returns empty array for no entries', () => {
    expect(collectAllDirPaths([], '/repo')).toEqual([])
  })

  it('returns empty array for root-level files only', () => {
    const entries = [makeEntry('/repo/a.ts'), makeEntry('/repo/b.ts')]
    expect(collectAllDirPaths(entries, '/repo')).toEqual([])
  })

  it('collects all intermediate directory paths', () => {
    const entries = [makeEntry('/repo/src/components/Button.tsx')]
    expect(collectAllDirPaths(entries, '/repo')).toEqual([
      'src',
      'src/components',
    ])
  })

  it('deduplicates shared directory paths', () => {
    const entries = [
      makeEntry('/repo/src/a.ts'),
      makeEntry('/repo/src/b.ts'),
      makeEntry('/repo/src/components/X.tsx'),
      makeEntry('/repo/src/components/Y.tsx'),
    ]
    expect(collectAllDirPaths(entries, '/repo')).toEqual([
      'src',
      'src/components',
    ])
  })

  it('uses display-relative paths when entries are under workspace root', () => {
    const entries = [makeEntry('/repo/lib/utils/helpers.ts')]
    expect(collectAllDirPaths(entries, '/repo')).toEqual([
      'lib',
      'lib/utils',
    ])
  })

  it('uses raw paths when entries are outside workspace root', () => {
    // Absolute paths outside the workspace root are used as-is; the leading
    // slash produces an empty first segment (same behaviour as buildTree).
    const entries = [makeEntry('/other/pkg/file.ts')]
    expect(collectAllDirPaths(entries, '/repo')).toEqual([
      '',
      'other',
      'other/pkg',
    ])
  })

  it('handles mixed root-level and nested files', () => {
    const entries = [
      makeEntry('/repo/README.md'),
      makeEntry('/repo/src/index.ts'),
      makeEntry('/repo/src/deep/nested/file.ts'),
    ]
    expect(collectAllDirPaths(entries, '/repo')).toEqual([
      'src',
      'src/deep',
      'src/deep/nested',
    ])
  })

  it('does not match sibling directories sharing a prefix', () => {
    // "/repo-extra" shares the prefix "/repo" but is a different directory.
    // The raw absolute path is used, so the leading slash produces an empty
    // first segment (same behaviour as buildTree).
    const entries = [makeEntry('/repo-extra/src/file.ts')]
    expect(collectAllDirPaths(entries, '/repo')).toEqual([
      '',
      'repo-extra',
      'repo-extra/src',
    ])
  })

  it('handles empty workspace root', () => {
    const entries = [makeEntry('src/components/Button.tsx')]
    expect(collectAllDirPaths(entries, '')).toEqual([
      'src',
      'src/components',
    ])
  })

  it('strips the focus worktree root, not the project checkout prefix', () => {
    // With the Git panel focused on a managed worktree the backend keys every
    // entry onto the WORKTREE root; the display root is that same root, so the
    // `.worktrees/<name>/` prefix disappears from the collected dir keys.
    const entries = [
      makeEntry('/repo/.worktrees/s-abc/src/components/Button.tsx'),
      makeEntry('/repo/.worktrees/s-abc/README.md'),
    ]
    expect(collectAllDirPaths(entries, '/repo/.worktrees/s-abc')).toEqual([
      'src',
      'src/components',
    ])
  })

  it('does not strip a sibling of the worktree root sharing its prefix', () => {
    const entries = [makeEntry('/repo/.worktrees/s-abcd/src/file.ts')]
    // "s-abcd" is a SIBLING of the root "s-abc", not a child: the raw absolute
    // path is kept, so the leading slash produces an empty first segment
    // (same behaviour as buildTree).
    expect(collectAllDirPaths(entries, '/repo/.worktrees/s-abc')).toEqual([
      '',
      'repo',
      'repo/.worktrees',
      'repo/.worktrees/s-abcd',
      'repo/.worktrees/s-abcd/src',
    ])
  })
})

// ───────────────────── buildTree ⇄ collectAllDirPaths parity ─────────────────

describe('buildTree/collectAllDirPaths key parity', () => {
  /** Collect the tree's directory keys exactly as TreeRow reads expandedDirs. */
  function treeDirPaths(entries: GitPanelEntry[], displayRoot: string): string[] {
    const dirs = new Set<string>()
    const walk = (nodes: ReturnType<typeof buildTree>): void => {
      for (const node of nodes) {
        if (node.isDir) {
          dirs.add(node.fullPath)
          walk(node.children)
        }
      }
    }
    walk(buildTree(entries, displayRoot))
    return Array.from(dirs).sort()
  }

  it('produces identical expandedDirs keys for both helpers', () => {
    const entries = [
      makeEntry('/repo/src/a.ts'),
      makeEntry('/repo/src/components/X.tsx'),
      makeEntry('/repo/lib/util.ts'),
    ]
    expect(treeDirPaths(entries, '/repo')).toEqual(collectAllDirPaths(entries, '/repo'))
  })

  it('stays key-identical when the display root is a focus worktree', () => {
    const entries = [
      makeEntry('/repo/.worktrees/s-abc/src/a.ts'),
      makeEntry('/repo/.worktrees/s-abc/src/deep/b.ts'),
    ]
    const root = '/repo/.worktrees/s-abc'
    expect(treeDirPaths(entries, root)).toEqual(collectAllDirPaths(entries, root))
    expect(collectAllDirPaths(entries, root)).toEqual(['src', 'src/deep'])
  })
})
