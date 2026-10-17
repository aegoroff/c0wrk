import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  GitBranch,
  Loader2,
  Search,
  AlertCircle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useSessionDraftStore } from '@/stores/sessionDraftStore'
import { getBranches, listProjectWorktrees } from '@/api/git'
import { useBranchActions } from '@/hooks/useBranchActions'
import type { BranchActionKind } from '@/hooks/useBranchActions'
import type { GitWorktree } from '@/types/models'
import { focusWorktree } from '@/lib/gitFocus'
import { useWorktreeActions } from '@/hooks/useWorktreeActions'
import { LocalBranchRow } from './LocalBranchRow'
import { RemoteBranchRow } from './RemoteBranchRow'
import { BranchDeleteConfirmDialog } from './BranchDeleteConfirmDialog'
import { WorktreeDeleteConfirmDialog } from './WorktreeDeleteConfirmDialog'
import { NewBranchSection } from './NewBranchSection'
import { WorktreesSection } from './WorktreesSection'

/**
 * Draft-mode selection gate for the Worktrees rows (ADR-080/ADR-082). The
 * only rows that can back the drafted session are the local checkout (a
 * local session) and a MANAGED tree with a branch (its draft commit adopts
 * the existing tree). Everything else is a guaranteed dead end, so it is
 * gated off with the reason:
 *
 * - an EXTERNAL tree never adopts — c0wrk does not bind sessions to trees
 *   it does not own (CreateManagedSession refuses a branch held by an
 *   external tree with ErrBranchBusy), and provisioning a fresh managed
 *   tree on that branch would fail too: git allows a branch in at most one
 *   worktree, and the external tree holds it;
 * - a branch-less (detached HEAD) tree has no branch to run the session on.
 *
 * The returned reason is both the row tooltip and the gate: BranchPicker
 * passes the function to WorktreesSection (rendering gated rows inert) and
 * consults it in the draft onSelect, so the two can never drift apart.
 */
function draftWorktreeBlockedReason(w: GitWorktree): string | null {
  if (w.kind === 'main') return null
  if (!w.branch) {
    return 'Detached HEAD — no branch to run the new session on; pick a branch from the branch list'
  }
  if (w.kind !== 'managed') {
    return `Branch ${w.branch} is held by a worktree created outside c0wrk — remove that tree first or pick another branch`
  }
  return null
}

/** Local twin (short name) of a remote-tracking ref: `origin/feat/x` → `feat/x`. */
function remoteTwinName(remoteRef: string): string {
  const slash = remoteRef.indexOf('/')
  return slash === -1 ? remoteRef : remoteRef.slice(slash + 1)
}

/**
 * Modal picker for switching, creating and managing git branches.
 *
 * - Opens when `gitPanelStore.isBranchPickerOpen` is true.
 * - Lists local and remote branches from `gitPanelStore.branches` (refreshed
 *   from GetBranches on open) using the shared {@link LocalBranchRow}/
 *   {@link RemoteBranchRow} components, which expose the full operation set
 *   (checkout / push / merge / rebase / rename / delete for local;
 *   checkout-remote / delete-remote for remote).
 * - In draft mode (below) remote-tracking rows are selectable pick targets
 *   like local ones — a remote pick records a create-branch draft (local
 *   branch from the remote-tracking start point), never an in-place
 *   checkout; a remote row whose local twin is the main checkout's own
 *   branch is disabled with the SAME draftBlockedReason as that local row
 *   (the DWIM reuse would land the session in the shared checkout);
 *   the Manage-Branches mode keeps checkout-remote on remote rows.
 * - Provides a filter input to narrow the list by name.
 * - Provides a "New Branch" field + button (with optional base selector) that
 *   calls CreateBranch and checks out the new branch immediately.
 * - Checkout runs through the shared {@link useBranchActions} hook (single
 *   busy track that records each result in the Git panel's operation console);
 *   the picker closes once the checkout settles — on success AND on error — so
 *   a recorded failure is visible in that console rather than behind the modal.
 * - A "Worktrees" section switches the Git panel's FOCUS between every
 *   worktree of the project (local checkout, managed session trees with
 *   their owning session, external trees) — a focus switch via
 *   SetGitPanelFocus, never a checkout, so it never touches the operation
 *   console. In the session-draft mode the same rows instead SELECT the
 *   drafted workspace: the "Local checkout" row drafts a local session, a
 *   managed tree with a branch drafts a session on its branch (adopted at
 *   draft commit, ADR-082) — the focus never moves. External and detached
 *   trees are gated off by {@link draftWorktreeBlockedReason}: they can
 *   never back the drafted session, so they render inert with the reason.
 *   The linked trees (managed + external) also expose a hover delete that
 *   runs through the mandatory {@link WorktreeDeleteConfirmDialog}; the
 *   section is shown in draft mode too, so an existing worktree can be
 *   deleted without leaving the chat-side draft picker (the deletion never
 *   touches the draft, and stays available on gated rows).
 */
export function BranchPicker() {
  const isOpen = useGitPanelStore((s) => s.isBranchPickerOpen)
  const closeBranchPicker = useGitPanelStore((s) => s.closeBranchPicker)
  const pickerMode = useGitPanelStore((s) => s.branchPickerMode)
  const currentBranch = useGitPanelStore((s) => s.branch)
  const branches = useGitPanelStore((s) => s.branches)
  const setBranches = useGitPanelStore((s) => s.setBranches)
  const pendingBranchBase = useGitPanelStore((s) => s.pendingBranchBase)
  const clearPendingBranchBase = useGitPanelStore((s) => s.clearPendingBranchBase)
  const worktrees = useGitPanelStore((s) => s.worktrees)
  const setWorktrees = useGitPanelStore((s) => s.setWorktrees)

  const actions = useBranchActions()
  const worktreeActions = useWorktreeActions()
  // Destructure the stable operation callbacks so the checkout handlers below
  // can list them (rather than the recreated `actions` object) as useCallback
  // dependencies, keeping `react-hooks/exhaustive-deps` satisfied.
  const { checkout, checkoutRemote } = actions

  // Consume a pending branch base set externally (e.g. "Create › Branch" from
  // the commit context menu). The base must persist in the store while the
  // picker is open so that NewBranchSection can capture it on mount — Radix
  // Dialog's Presence state machine defers the actual DOM mount of
  // DialogContent by a synchronous re-render cycle, so clearing the base
  // eagerly on open (in a useEffect that runs before the content mounts)
  // would race and leave NewBranchSection with a null base. Instead, the
  // base is cleared only when the picker *closes*, ensuring it is available
  // throughout the open lifecycle and reset before the next manual open.
  useEffect(() => {
    if (!isOpen) {
      clearPendingBranchBase()
    }
  }, [isOpen, clearPendingBranchBase])

  const [filter, setFilter] = useState('')
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  // Refresh the store's branch list AND the project's worktree list every
  // time the picker opens. Both lists are read from `gitPanelStore` — the
  // single source of truth shared with BranchDropdown and the focus
  // switcher — so this effect only refreshes, it never forks a second local
  // copy. The worktrees refresh matters in draft mode: the draft gates
  // (the main-checkout branch block, the worktree-row selection gate)
  // decide from `worktrees`, and that list is otherwise refreshed only on
  // focus switches / project-session changes — a checkout that happened
  // since (via the switch-mode picker or externally) would leave the block
  // decisions reading stale data.
  useEffect(() => {
    if (!isOpen) return
    setFilter('')
    setError(null)
    setLoadingBranches(true)
    Promise.all([getBranches(), listProjectWorktrees()])
      .then(([result, trees]) => {
        setBranches(result)
        setWorktrees(trees)
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : 'Failed to load branches',
        )
        setBranches([])
      })
      .finally(() => setLoadingBranches(false))
    // Focus the filter input shortly after opening.
    requestAnimationFrame(() => filterRef.current?.focus())
  }, [isOpen, setBranches, setWorktrees])

  const localBranches = useMemo(
    () => branches.filter((b) => b.kind === 'local'),
    [branches],
  )
  const remoteBranches = useMemo(
    () => branches.filter((b) => b.kind === 'remote'),
    [branches],
  )
  // Names only, for NewBranchSection's draft-mode duplicate-name guard.
  const localBranchNames = useMemo(() => localBranches.map((b) => b.name), [localBranches])

  const filterFn = useCallback(
    (name: string) => {
      const q = filter.trim().toLowerCase()
      if (!q) return true
      return name.toLowerCase().includes(q)
    },
    [filter],
  )

  const visibleLocal = localBranches.filter((b) => filterFn(b.name))
  const visibleRemote = remoteBranches.filter((b) => filterFn(b.name))

  // Checkout (local + remote) closes the picker once the operation settles —
  // on success AND on error. The shared hook records the outcome in the Git
  // panel's operation console, so the picker must not linger over a failure.
  // A skipped call (another operation already in flight) is not a settle: the
  // picker stays open rather than dismissing itself for a no-op.
  const handleCheckout = useCallback(
    async (name: string) => {
      const outcome = await checkout(name)
      if (outcome.ran) closeBranchPicker()
    },
    [checkout, closeBranchPicker],
  )

  const handleCheckoutRemote = useCallback(
    async (remoteBranch: string) => {
      const outcome = await checkoutRemote(remoteBranch)
      if (outcome.ran) closeBranchPicker()
    },
    [checkoutRemote, closeBranchPicker],
  )

  // ── Session-draft mode (ADR-080) ──────────────────────────────────────
  // The picker was opened from the chat toolbar's `branch…` entry: rows
  // SELECT the branch the drafted session's managed worktree will be
  // provisioned on. Nothing is checked out here — the working tree is
  // untouched; provisioning (worktree add + optional branch creation)
  // happens at draft commit via CreateManagedSession. Remote-tracking
  // rows participate too: picking `origin/x` records a create-branch
  // draft (local `x` created from `origin/x` at commit). The Manage
  // Branches mode keeps its own semantics — a remote-row click there is
  // an in-place checkout-remote.
  const isDraftMode = pickerMode === 'draft'
  const draft = useSessionDraftStore((s) => s.draft)

  // In draft mode a branch can back the new session's managed worktree
  // unless the MAIN checkout holds it — git allows a branch in at most one
  // worktree. Branches held by existing managed worktrees stay selectable:
  // the draft commit ADOPTS the existing tree instead of provisioning a new
  // one (ADR-082). `is_current` is deliberately not consulted — it follows
  // the Git panel's focus (GetBranches runs in the focused tree), so the
  // main checkout's branch stays blocked (and managed branches selectable)
  // regardless of where the focus sits.
  const mainCheckoutBranch = useMemo(
    () => worktrees.find((w) => w.kind === 'main')?.branch ?? null,
    [worktrees],
  )
  const draftBlockedReason = useCallback(
    (name: string) =>
      name === mainCheckoutBranch
        ? 'Checked out in the main checkout — pick another branch or use local'
        : null,
    [mainCheckoutBranch],
  )

  const handleDraftSelect = useCallback(
    (name: string) => {
      useSessionDraftStore
        .getState()
        .setDraftWorkspace({ kind: 'branch', branch: name, createBranch: false, startPoint: '' })
      closeBranchPicker()
    },
    [closeBranchPicker],
  )

  const handleDraftCreate = useCallback(
    (name: string, startPoint: string) => {
      useSessionDraftStore
        .getState()
        .setDraftWorkspace({ kind: 'branch', branch: name, createBranch: true, startPoint })
      closeBranchPicker()
    },
    [closeBranchPicker],
  )

  // A remote-tracking pick records a create-branch draft: the session's
  // managed worktree is provisioned on the LOCAL branch named by the
  // remote ref's short name, created from that ref at draft commit.
  // CreateManagedSession follows git DWIM semantics at commit — an
  // existing local branch of that name is reused (never re-created or
  // reset), a missing one is created from the remote-tracking start point.
  // Nothing is checked out at pick time. The row itself refuses the pick
  // when that local twin is the main checkout's branch (the same
  // draftBlockedReason predicate as the local rows) — the DWIM reuse would
  // silently serve the session from the shared checkout instead of a
  // managed worktree.
  const handleDraftRemoteSelect = useCallback(
    (remoteRef: string) => {
      const local = remoteTwinName(remoteRef)
      useSessionDraftStore
        .getState()
        .setDraftWorkspace({ kind: 'branch', branch: local, createBranch: true, startPoint: remoteRef })
      closeBranchPicker()
    },
    [closeBranchPicker],
  )

  // The row-level "already picked" marker: an existing-branch selection.
  const draftSelectedBranch =
    draft !== null && draft.workspace.kind === 'branch' && !draft.workspace.createBranch
      ? draft.workspace.branch
      : null

  // The row-level "already picked" marker for a remote-based selection: a
  // create-branch draft whose start point is a remote-tracking ref naming
  // exactly the drafted local branch (the remote-pick shape — not a
  // manually named new branch that merely uses a remote base).
  const draftSelectedRemote = (() => {
    if (draft === null || draft.workspace.kind !== 'branch' || !draft.workspace.createBranch) {
      return null
    }
    const startPoint = draft.workspace.startPoint
    const slash = startPoint.indexOf('/')
    if (slash === -1) return null
    return draft.workspace.branch === startPoint.slice(slash + 1) ? startPoint : null
  })()

  const handleClearError = useCallback(() => setError(null), [])
  const handleError = useCallback((msg: string) => setError(msg), [])

  // A row is busy when its own operation is running; otherwise it is blocked
  // while a different row's operation runs.
  const inFlightFor = (name: string): BranchActionKind | null =>
    actions.busyBranch === name ? actions.busyAction : null
  const disabledFor = (name: string): boolean =>
    actions.isBusy && actions.busyBranch !== name

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) closeBranchPicker()
      }}
    >
      <DialogContent
        showCloseButton
        aria-describedby={undefined}
        className="max-w-sm p-0 flex flex-col max-h-[calc(var(--ui-vh)-2rem)] overflow-y-auto custom-scrollbar"
      >
        <DialogHeader className="px-4 pt-4 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <GitBranch className="size-4" />
            {isDraftMode ? 'Choose Branch' : 'Switch Branch'}
          </DialogTitle>
          {isDraftMode && (
            <p className="text-xs text-muted-foreground">
              The new session runs in its own worktree on the picked branch — or
              joins the existing worktree when the branch is already in use; your
              working tree stays untouched.
            </p>
          )}
        </DialogHeader>

        {/* Filter */}
        <div className="px-4 pb-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={filterRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter branches..."
              className="h-8 pl-7 text-xs"
            />
          </div>
        </div>

        {/* Branch list — flex-1 so it shrinks when the base selector expands */}
        <div className="flex-1 min-h-[80px] overflow-y-auto custom-scrollbar px-2 pb-2">
          {actions.renamingBranch ? (
            <div className="px-1 py-1">
              <Input
                ref={actions.renameRef}
                value={actions.renameValue}
                onChange={(e) => actions.setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void actions.commitRename()
                  if (e.key === 'Escape') actions.cancelRename()
                }}
                onBlur={() => void actions.commitRename()}
                placeholder={`Rename ${actions.renamingBranch}`}
                className="h-8 text-xs"
                autoFocus
              />
            </div>
          ) : loadingBranches ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : visibleLocal.length === 0 && visibleRemote.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              {branches.length === 0 ? 'No branches found' : 'No matching branches'}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {visibleLocal.length > 0 && (
                <li className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Local
                </li>
              )}
              {visibleLocal.map((b) => (
                <li key={b.name}>
                  <LocalBranchRow
                    branch={b}
                    inFlight={inFlightFor(b.name)}
                    disabled={disabledFor(b.name)}
                    onCheckout={handleCheckout}
                    onRename={actions.startRename}
                    onMerge={actions.mergeBranch}
                    onRebase={actions.rebaseBranch}
                    onPush={actions.push}
                    onDelete={actions.requestDeleteLocal}
                    draftSelect={
                      isDraftMode
                        ? { selected: draftSelectedBranch === b.name, onSelect: handleDraftSelect }
                        : undefined
                    }
                    draftBlockedReason={isDraftMode ? draftBlockedReason(b.name) : undefined}
                  />
                </li>
              ))}
              {visibleRemote.length > 0 && (
                <li className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Remote
                </li>
              )}
              {visibleRemote.map((b) => (
                <li key={b.name}>
                  <RemoteBranchRow
                    branch={b}
                    inFlight={inFlightFor(b.name)}
                    disabled={disabledFor(b.name)}
                    draftBlockedReason={
                      isDraftMode ? draftBlockedReason(remoteTwinName(b.name)) : undefined
                    }
                    onCheckoutRemote={handleCheckoutRemote}
                    onDeleteRemote={actions.requestDeleteRemote}
                    draftSelect={
                      isDraftMode
                        ? { selected: draftSelectedRemote === b.name, onSelect: handleDraftRemoteSelect }
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Worktrees — switch the Git panel's FOCUS between every worktree of
            the project (local checkout, managed session trees, external
            trees) and expose deletion of the linked trees. Selecting one
            closes the picker: the focus switch is not a checkout, so there
            is no operation console outcome to read. In DRAFT mode the same
            rows SELECT the drafted workspace instead: the local checkout
            drafts a local session, a managed tree drafts a session on ITS
            branch — CreateManagedSession then adopts the existing tree
            (ADR-082) — and the focus never moves. External and detached
            trees can never back the drafted session (a branch held outside
            c0wrk is refused, a detached tree has no branch to bind), so
            {@link draftWorktreeBlockedReason} gates them off and the section
            renders them inert with the reason. Linked trees also expose
            deletion (e.g. a stale managed tree); the deletion never touches
            the draft. */}
        {worktrees.length > 0 && (
          <div className="shrink-0 border-t border-border px-2 pb-2 pt-1">
            <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Worktrees
            </div>
            <WorktreesSection
              worktrees={worktrees}
              draftSelect={isDraftMode}
              draftBlockedReason={isDraftMode ? draftWorktreeBlockedReason : undefined}
              onSelect={(w) => {
                if (!isDraftMode) {
                  // Switch mode: the row switches the Git panel's focus.
                  void focusWorktree(w.path)
                } else if (draftWorktreeBlockedReason(w) !== null) {
                  // External or detached tree: not a draft target (the row
                  // renders disabled) — and never a hidden focus switch; the
                  // picker stays open so the user can pick a real target.
                  return
                } else if (w.kind === 'main') {
                  // "Local checkout" row: the drafted session runs in the
                  // project working tree.
                  useSessionDraftStore.getState().setDraftWorkspace({ kind: 'local' })
                } else if (w.branch) {
                  // A managed tree drafts a session on ITS branch; the draft
                  // commit adopts the existing tree (ADR-082).
                  useSessionDraftStore
                    .getState()
                    .setDraftWorkspace({ kind: 'branch', branch: w.branch, createBranch: false, startPoint: '' })
                }
                closeBranchPicker()
              }}
              onDelete={worktreeActions.requestDelete}
              deleteBusyPath={worktreeActions.busyPath}
            />
          </div>
        )}

        {/* New branch — key on isOpen so the field resets when reopened. In
            draft mode the submit records the drafted branch (created at
            draft commit in the session's managed worktree) instead of
            running CreateBranch + in-place checkout; an existing local name
            is refused up front — commit-time DWIM would silently reuse that
            branch and ignore the chosen base. */}
        <NewBranchSection
          key={isOpen ? 'open' : 'closed'}
          disabled={actions.isBusy}
          currentBranch={currentBranch.name}
          pendingBase={pendingBranchBase}
          onClearError={handleClearError}
          onError={handleError}
          onCreated={closeBranchPicker}
          onDraftCreate={isDraftMode ? handleDraftCreate : undefined}
          existingLocalBranches={isDraftMode ? localBranchNames : undefined}
        />

        {/* Local error (branch-list load / create-branch failures) */}
        {error && (
          <div className="flex items-center gap-1.5 border-t border-destructive/20 px-4 py-2 text-xs text-destructive shrink-0">
            <AlertCircle className="size-3.5 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}
      </DialogContent>

      <BranchDeleteConfirmDialog
        pending={actions.pendingDelete}
        onConfirm={actions.confirmDelete}
        onCancel={actions.cancelDelete}
      />

      <WorktreeDeleteConfirmDialog
        pending={worktreeActions.pendingDelete}
        error={worktreeActions.deleteError}
        onConfirm={worktreeActions.confirmDelete}
        onCancel={worktreeActions.cancelDelete}
      />
    </Dialog>
  )
}
