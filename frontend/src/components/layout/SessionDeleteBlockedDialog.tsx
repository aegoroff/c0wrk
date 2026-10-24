import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { BlockedSessionDelete } from '@/hooks/useSessionActions'
import type { SessionDeleteOptionsUI } from '@/types/api'

interface SessionDeleteBlockedDialogProps {
  /** The parked refusal (see `useSessionActions.blockedDelete`) — null renders nothing. */
  blocked: BlockedSessionDelete | null
  /**
   * Message of the last NON-blocked retry failure, shown inline so the user
   * can react in place; the parked state stays retryable. Null after a fresh
   * request (a renewed refusal updates `blocked` instead).
   */
  error?: string | null
  /** Retry the parked deletions carrying the user's explicit decisions. */
  onConfirm: (options: SessionDeleteOptionsUI) => void
  /** Dismiss the parked refusal — deletes nothing. */
  onCancel: () => void
}

/**
 * Visible refusal dialog for a session delete the backend blocked pending an
 * explicit worktree decision (`session deletion blocked: …`). Shows the
 * verbatim reason, the still-to-delete session (or the branch-named group
 * copy — count-aware, like `SessionActionConfirmDialog`) and offers BOTH
 * consents as checkboxes, pre-ticking exactly the one the refusal named;
 * retry re-issues the parked deletions with the ticked decisions, a cancel
 * releases the parked state without deleting anything. The git branch is
 * never deleted — only the session and its managed worktree. Rendered by
 * both session list surfaces, next to `SessionActionConfirmDialog`.
 */
export function SessionDeleteBlockedDialog({
  blocked,
  error,
  onConfirm,
  onCancel,
}: SessionDeleteBlockedDialogProps) {
  // Group copy whenever more than one session is still parked — `sessionName`
  // is then the BRANCH label, so the singular copy would pose a branch as a
  // session name (same count-aware rule as SessionActionConfirmDialog).
  const groupSize = blocked?.sessionIds.length ?? 0
  const isGroup = groupSize > 1
  const noun = groupSize === 1 ? 'session' : 'sessions'
  const [discard, setDiscard] = useState(false)
  const [unlock, setUnlock] = useState(false)

  // Consents are per-parked-refusal: a fresh park — or a renewed refusal
  // that refreshes the parked state in place with a new option — resets both
  // boxes to the default that pre-ticks exactly the decision the backend
  // demanded. An inline retry failure does NOT reset: the user's explicit
  // ticks survive a failed retry so the very next confirm just retries.
  useEffect(() => {
    setDiscard(blocked?.option === 'confirm_uncommitted_loss')
    setUnlock(blocked?.option === 'unlock_locked_tree')
  }, [blocked])

  const confirm = () => onConfirm({ confirmUncommittedLoss: discard, unlockLockedTree: unlock })

  return (
    <Dialog open={blocked !== null} onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Session deletion blocked</DialogTitle>
          <DialogDescription>
            {blocked ? (
              <>
                {isGroup ? (
                  <span className="font-medium">{`Branch "${blocked.sessionName}" groups ${groupSize} ${noun}.`}</span>
                ) : (
                  <span className="font-medium">{`"${blocked.sessionName}"`}</span>
                )}
                <span className="mt-1 block">
                  Deleting was refused until an explicit decision about the session's managed
                  worktree is made. Deleting removes the {isGroup ? `${noun} and their worktree directories` : 'session and its worktree directory'} from disk;
                  the git branch is kept.
                </span>
                <span className="mt-1 block break-words font-mono text-xs text-muted-foreground">
                  {blocked.reason}
                </span>
              </>
            ) : (
              ''
            )}
          </DialogDescription>
        </DialogHeader>
        {blocked && (
          <div className="flex flex-col gap-2">
            <label className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="session-delete-discard-row">
              <input
                type="checkbox"
                checked={discard}
                onChange={(e) => setDiscard(e.target.checked)}
                data-testid="session-delete-discard-checkbox"
                className="mt-0.5 size-3.5 accent-primary"
              />
              <span>Discard uncommitted changes — delete the worktree even though it holds uncommitted changes.</span>
            </label>
            <label className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="session-delete-unlock-row">
              <input
                type="checkbox"
                checked={unlock}
                onChange={(e) => setUnlock(e.target.checked)}
                data-testid="session-delete-unlock-checkbox"
                className="mt-0.5 size-3.5 accent-primary"
              />
              <span>Unlock the tree — the managed worktree is locked, and deletion refuses while it stays locked.</span>
            </label>
          </div>
        )}
        {error && (
          <div
            className="flex flex-col gap-0.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="session-delete-blocked-error"
          >
            <span className="flex items-center gap-1.5">
              <AlertCircle className="size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </span>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} title="Keep the session and its worktree">Cancel</Button>
          <Button variant="destructive" onClick={confirm} title="Retry the deletion with the ticked decisions">
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
