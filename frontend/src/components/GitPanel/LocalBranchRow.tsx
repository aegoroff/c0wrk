import { GitBranch, Check, Loader2, GitMerge, GitFork, Pencil, Trash2, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ItemAction, ItemActions } from '@/components/layout/ItemAction'
import type { Branch } from '@/types/models'
import type { BranchActionKind } from '@/hooks/useBranchActions'

interface LocalBranchRowProps {
  branch: Branch
  /** The action currently in-flight on this row (null = idle). */
  inFlight: BranchActionKind | null
  /** True when a different row's operation is in-flight — dims & blocks this row. */
  disabled: boolean
  onCheckout: (name: string) => void
  onRename: (name: string) => void
  onMerge: (name: string) => void
  onRebase: (name: string) => void
  onPush: (name: string) => void
  onDelete: (name: string) => void
  /**
   * Session-draft mode (ADR-080): when set, clicking SELECTS the branch for
   * the new session's managed worktree instead of checking it out — no git
   * operation runs, and the per-branch hover actions are hidden.
   */
  draftSelect?: {
    selected: boolean
    onSelect: (name: string) => void
  }
  /**
   * Draft-mode block reason: when set (together with `draftSelect`), the
   * branch cannot back the new session's worktree and a click is a no-op;
   * the text doubles as the row tooltip. The picker passes it ONLY for the
   * branch checked out in the MAIN checkout — git allows a branch in at
   * most one worktree. Branches held by existing managed worktrees stay
   * selectable (the draft commit adopts the existing tree, ADR-082) even
   * when they are `is_current` — that flag follows the Git panel's focus
   * (GetBranches runs in the focused tree), not the main checkout.
   */
  draftBlockedReason?: string | null
}

/**
 * A single local branch row. Clicking checks out the branch; hovering reveals
 * the per-branch actions (push / merge / rebase / rename / delete) via the
 * shared ItemAction overlay. Merge & rebase are hidden for the current branch
 * (self-merge/rebase is rejected by git), and delete is disabled there too —
 * the backend refuses to delete the checked-out branch.
 *
 * With `draftSelect` set, the row is a pure selection target for the chat
 * draft's managed-worktree branch — see {@link LocalBranchRowProps.draftSelect}.
 */
export function LocalBranchRow({
  branch,
  inFlight,
  disabled,
  onCheckout,
  onRename,
  onMerge,
  onRebase,
  onPush,
  onDelete,
  draftSelect,
  draftBlockedReason,
}: LocalBranchRowProps) {
  const isCurrent = branch.is_current
  // A row is blocked when any operation is running on it OR elsewhere.
  const blocked = disabled || inFlight !== null
  // Draft mode: blocked only when the picker says so — the MAIN checkout's
  // branch (git enforces one worktree per branch). `is_current` deliberately
  // does not block here: it follows the Git panel's focus, and a branch held
  // by an existing managed worktree is adopted at draft commit (ADR-082).
  const draftBlocked = draftSelect !== undefined && !!draftBlockedReason

  const handleCheckout = () => {
    if (draftSelect) {
      if (blocked || draftBlocked) return
      draftSelect.onSelect(branch.name)
      return
    }
    if (isCurrent || blocked) return
    onCheckout(branch.name)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleCheckout()
    }
  }

  const selected = draftSelect?.selected ?? false

  return (
    <div
      role="button"
      tabIndex={(draftSelect ? blocked || draftBlocked : isCurrent || blocked) ? -1 : 0}
      aria-current={isCurrent || selected ? 'true' : undefined}
      title={draftBlocked ? (draftBlockedReason ?? undefined) : undefined}
      onClick={handleCheckout}
      onKeyDown={handleKeyDown}
      data-testid={draftSelect ? 'draft-branch-row' : undefined}
      className={cn(
        'group/item relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
        isCurrent || selected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
        (disabled || draftBlocked) && 'cursor-not-allowed opacity-50',
        (draftSelect ? !blocked && !draftBlocked : !disabled && !isCurrent) && 'cursor-pointer',
      )}
    >
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{branch.name}</span>
      {(isCurrent || selected) && <Check className="size-4 shrink-0" />}
      {inFlight === 'checkout' && (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      )}

      {/* Hover action overlay — push/merge/rebase/rename/delete. Hidden in
          draft mode: the row is a selection target, not a management one. */}
      {draftSelect ? null : (
      <ItemActions>
        <ItemAction
          label={`Push ${branch.name}`}
          onClick={() => onPush(branch.name)}
          disabled={blocked}
          disabledReason={blocked ? 'A git operation is in progress' : undefined}
        >
          {inFlight === 'push' ? (
            <Loader2 className="size-3.5 animate-spin text-foreground" />
          ) : (
            <Upload className="size-3.5 text-primary" />
          )}
        </ItemAction>

        {!isCurrent && (
          <ItemAction
            label={`Merge ${branch.name} into current`}
            onClick={() => onMerge(branch.name)}
            disabled={blocked}
            disabledReason={blocked ? 'A git operation is in progress' : undefined}
          >
            {inFlight === 'merge' ? (
              <Loader2 className="size-3.5 animate-spin text-info" />
            ) : (
              <GitMerge className="size-3.5 text-info" />
            )}
          </ItemAction>
        )}

        {!isCurrent && (
          <ItemAction
            label={`Rebase current onto ${branch.name}`}
            onClick={() => onRebase(branch.name)}
            disabled={blocked}
            disabledReason={blocked ? 'A git operation is in progress' : undefined}
          >
            {inFlight === 'rebase' ? (
              <Loader2 className="size-3.5 animate-spin text-warning" />
            ) : (
              <GitFork className="size-3.5 text-warning" />
            )}
          </ItemAction>
        )}

        <ItemAction
          label="Rename"
          onClick={() => onRename(branch.name)}
          disabled={blocked}
          disabledReason={blocked ? 'A git operation is in progress' : undefined}
        >
          {inFlight === 'rename' ? (
            <Loader2 className="size-3.5 animate-spin text-info" />
          ) : (
            <Pencil className="size-3.5 text-info" />
          )}
        </ItemAction>

        <ItemAction
          label={isCurrent ? 'Delete branch' : `Delete ${branch.name}`}
          onClick={() => onDelete(branch.name)}
          disabled={blocked || isCurrent}
          disabledReason={
            isCurrent ? 'Cannot delete the current branch' : blocked ? 'A git operation is in progress' : undefined
          }
        >
          {inFlight === 'delete' ? (
            <Loader2 className="size-3.5 animate-spin text-destructive" />
          ) : (
            <Trash2 className="size-3.5 text-destructive" />
          )}
        </ItemAction>
      </ItemActions>
      )}
    </div>
  )
}
