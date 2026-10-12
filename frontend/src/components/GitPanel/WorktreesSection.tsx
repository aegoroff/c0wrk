import { Check, FolderGit2, GitBranch, Link2, Loader2, Lock, Pin, Trash2 } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ItemAction, ItemActions } from '@/components/layout/ItemAction'
import { cn } from '@/lib/utils'
import type { GitWorktree } from '@/types/models'

/**
 * The worktree focus-switcher list, shared by the BranchDropdown combo and
 * the BranchPicker (switch-branch dialog). Every worktree of the active
 * project is listed — the local checkout, the app-managed session trees
 * (with their owning session and a pin marker: branch checkout is refused
 * there), and external linked trees. Selecting an entry switches the Git
 * panel's FOCUS to that tree (SetGitPanelFocus) — it never checks anything
 * out, never retargets a session's execution workspace.
 *
 * Linked trees (managed + external) expose a hover DELETE action (the
 * ItemActions overlay pattern from LocalBranchRow); the local checkout is
 * the project's registration root and never offers one. The delete goes
 * through the mandatory WorktreeDeleteConfirmDialog — the section only
 * raises `onDelete`.
 *
 * `variant="menu"` renders Radix dropdown items (BranchDropdown);
 * `variant="list"` renders plain rows (BranchPicker). In the menu variant
 * the delete click must never reach the DropdownMenuItem's select handler:
 * the ItemActions overlay stops the event's propagation, so clicking delete
 * neither switches the focus nor dismisses the menu.
 */
export function WorktreesSection({
  worktrees,
  onSelect,
  busyPath = null,
  variant = 'list',
  onDelete,
  deleteBusyPath = null,
}: {
  worktrees: GitWorktree[]
  onSelect: (worktree: GitWorktree) => void
  /** Path of a worktree whose focus switch is in flight (spinner row). */
  busyPath?: string | null
  variant?: 'menu' | 'list'
  /**
   * When set, linked trees (managed + external) expose a hover delete
   * action; the local checkout never does. The consumer owns the
   * confirmation dialog.
   */
  onDelete?: (worktree: GitWorktree) => void
  /** Path of a worktree whose deletion is in flight (spinner action, disabled row). */
  deleteBusyPath?: string | null
}) {
  if (worktrees.length === 0) return null

  return (
    <>
      {worktrees.map((w) => {
        const busy = busyPath === w.path
        const deleting = deleteBusyPath === w.path
        const rowBusy = busy || deleting
        const deletable = onDelete !== undefined && w.kind !== 'main'
        const content = (
          <>
            <WorktreeKindIcon worktree={w} />
            <span className="min-w-0 flex-1 truncate">
              <span className="truncate font-medium">
                {w.kind === 'main' ? 'Local checkout' : w.name}
              </span>
              <span className="ml-1.5 truncate font-mono text-xs text-muted-foreground">
                {w.branch || 'detached'}
              </span>
              {w.managed && w.session_name && (
                <span className="ml-1.5 truncate text-xs text-muted-foreground/80">
                  · {w.session_name}
                </span>
              )}
            </span>
            {w.pinned && (
              <Pin
                className="size-3 shrink-0 text-muted-foreground/70"
                aria-label="Pinned branch"
              />
            )}
            {w.locked && <Lock className="size-3 shrink-0 text-muted-foreground/70" aria-label="Locked" />}
            {busy ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              w.is_focus && <Check className="size-3.5 shrink-0 text-primary" aria-label="Focused" />
            )}
            {deletable && (
              <ItemActions>
                <ItemAction
                  label={deleting ? `Deleting ${w.name}` : `Delete ${w.name}`}
                  onClick={() => onDelete(w)}
                  disabled={deleteBusyPath !== null}
                  disabledReason={
                    deleting
                      ? 'Deleting this worktree'
                      : 'A worktree deletion is in progress'
                  }
                >
                  {deleting ? (
                    <Loader2 className="size-3.5 animate-spin text-destructive" />
                  ) : (
                    <Trash2 className="size-3.5 text-destructive" />
                  )}
                </ItemAction>
              </ItemActions>
            )}
          </>
        )
        if (variant === 'menu') {
          return (
            <DropdownMenuItem
              key={w.path}
              data-testid="worktree-row"
              data-path={w.path}
              disabled={rowBusy}
              onSelect={() => onSelect(w)}
              className="group/item relative"
            >
              {content}
            </DropdownMenuItem>
          )
        }
        return (
          <div
            key={w.path}
            role="button"
            tabIndex={rowBusy ? -1 : 0}
            data-testid="worktree-row"
            data-path={w.path}
            aria-disabled={rowBusy || undefined}
            onClick={() => {
              if (rowBusy) return
              onSelect(w)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (!rowBusy) onSelect(w)
              }
            }}
            title={`Focus ${w.kind === 'main' ? 'the local checkout' : `worktree ${w.name}`}${w.branch ? ` (${w.branch})` : ''}`}
            className={cn(
              'group/item relative flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              rowBusy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
            )}
          >
            {content}
          </div>
        )
      })}
    </>
  )
}

/** Kind icon: folder for the checkout, branch for managed trees, link for external. */
function WorktreeKindIcon({ worktree }: { worktree: GitWorktree }) {
  if (worktree.kind === 'main') {
    return <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
  }
  if (worktree.kind === 'managed') {
    return <GitBranch className="size-4 shrink-0 text-muted-foreground" />
  }
  return <Link2 className="size-4 shrink-0 text-muted-foreground" />
}
