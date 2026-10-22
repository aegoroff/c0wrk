// frontend_api_worktrees.go — the session-lifecycle side of ADR-080 managed
// worktrees. The worktrees.Owner coordinator (step: safe primitives) is
// deliberately stateless; this file is the "Git lifecycle owner" that drives
// it from the session RPC flows:
//
//   - SendMessage's send-time workspace binding (bindSessionWorkspace): the
//     first message of a FRESH session provisions the tree → persists the
//     binding inside the fresh window (no transcript, no task rows — one
//     atomic store statement) → evicts the in-memory session so the send's
//     own access restores an orchestrator built for the new workspace,
//     compensating (releasing the fresh tree) when a later step fails. An
//     adopted (shared) tree persists its binding and re-validates the tree
//     inside the adoption↔deletion critical section (managedTreeMu), rolling
//     the just-persisted binding back when the last owner's deletion removed
//     the tree in between.
//   - ensureManagedWorkspace (installed as the manager's WorkspaceEnsurer):
//     lazy restore recreates a missing tree from the pinned branch at the
//     binding's recorded durable path, surfacing the data-loss warning; it
//     never falls back to the project checkout.
//   - ForkSession (managed source): a new tree on <branch>-fork-<short-id>
//     created at the source's COMMITTED HEAD — uncommitted changes are
//     explicitly not carried into the fork.
//   - DeleteSession/DeleteSessionWithOptions: join the running task, stop the
//     session terminal, then recheck dirtiness at removal time; a dirty (or
//     locked) tree blocks deletion with a typed decision error so the session
//     stays retryable until the user confirms the loss. The [count remaining
//     co-owners → release] pair runs under the same critical section as the
//     adoption commit, so a shared tree is only ever released for a last
//     owner whose count saw every committed binding.
package backend

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/backend/project"
	"github.com/v0lka/c0wrk/backend/session"
	"github.com/v0lka/c0wrk/backend/worktrees"
	"github.com/v0lka/c0wrk/core"
	"github.com/v0lka/c0wrk/core/workspace"
)

// managedProvisionTimeout bounds one provisioning git operation (worktree
// add, which materializes a full checkout). Generous on purpose: the point is
// to convert a wedged git into an explicit error, not to race a slow disk.
const managedProvisionTimeout = 10 * time.Minute

// canonicalWorktreeRoot returns the symlink-resolved form of a repository
// root, falling back to the given form when the path cannot be resolved.
// Every worktree seam must present the same (canonical) form to the worktree
// primitives: git lists canonical paths, the add/recreate post-checks
// compare derived targets against that listing, and the per-repo worktree
// lock keys lexically — a legacy registration keeping a symlinked ancestor
// in its stored path would otherwise fail a post-check after a successful
// git mutation and split the lock key against already-canonicalized seams.
// Event payloads and frontend keying stay on the stored form (see the emit
// sites); only the git-facing root is canonicalized.
func canonicalWorktreeRoot(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	return path
}

// SessionDeleteOptions carries the user's explicit decisions for deleting a
// session that owns a managed worktree. Both flags exist because the
// underlying removal primitives refuse to destroy data or bypass locks
// without them; a deletion that needs a flag the caller did not set fails
// with *SessionDeleteBlockedError and the session is kept intact (retryable).
type SessionDeleteOptions struct {
	// ConfirmUncommittedLoss authorizes removing the session's tree even
	// though it still contains uncommitted changes. They are then lost —
	// the branch is never deleted, but uncommitted work lives only in the
	// working tree.
	ConfirmUncommittedLoss bool `json:"confirm_uncommitted_loss"`
	// UnlockLockedTree authorizes removing a tree the user (or tooling)
	// locked via `git worktree lock`.
	UnlockLockedTree bool `json:"unlock_locked_tree"`
}

// SessionDeleteBlockedError reports that the session cannot be deleted
// without an explicit user decision. The session, its tree, and its branch
// are untouched — the caller re-issues the deletion with the named option
// once the user confirms.
type SessionDeleteBlockedError struct {
	// Reason is the human-readable explanation shown to the user.
	Reason string `json:"reason"`
	// Option names the SessionDeleteOptions field that authorizes proceeding.
	Option string `json:"option"`
}

func (e *SessionDeleteBlockedError) Error() string {
	return fmt.Sprintf("session deletion blocked: %s (confirm via %s)", e.Reason, e.Option)
}

// worktreeOwner returns the backend ownership coordinator. The Owner is
// stateless (a logger wrapper over the hardened core/workspace primitives),
// so per-call construction is safe and keeps this API free of extra lock
// state.
func (f *FrontendAPI) worktreeOwner() *worktrees.Owner {
	return worktrees.NewOwner(f.log())
}

// newWorktreeOwner samples config only for provisioning a fresh tree.
func (f *FrontendAPI) newWorktreeOwner(projectID string) (*worktrees.Owner, error) {
	f.configMu.RLock()
	override := ""
	if f.config != nil {
		override = f.config.Git.WorktreesRoot
	}
	f.configMu.RUnlock()
	container, err := config.NewManagedWorktreesDir(f.agentDir, projectID, override)
	if err != nil {
		return nil, err
	}
	return worktrees.NewOwner(f.log(), container), nil
}

// shortIdentity derives the short identity suffix (first 8 chars) used for
// derived tree and branch names. Session ids are UUIDs, so the prefix is
// always hex and never empty for a well-formed id.
func shortIdentity(id string) string {
	if len(id) < 8 {
		return id
	}
	return id[:8]
}

// managedTreeName derives the managed worktree name for a session identity.
// The name is a single portable path component validated again (via
// ManagedWorktreePath) inside every owner operation.
func managedTreeName(sessionID string) string {
	return "s-" + shortIdentity(sessionID)
}

// forkBranchName derives the fork branch: <source branch>-fork-<short id>.
// The suffix makes forks of forks sortable and collision-free without ever
// reusing the source branch (one branch, one worktree).
func forkBranchName(sourceBranch, dstSessionID string) string {
	return sourceBranch + "-fork-" + shortIdentity(dstSessionID)
}

// installWorkspaceEnsurer wires the manager's lazy-restore hook to this API's
// worktree coordinator. Called from NewFrontendAPI after the manager exists
// (mirroring installServiceLLMGate — the one place manager and FrontendAPI
// meet). Without this line managed restores fail closed; tests that build
// FrontendAPI via struct literal call it (or SetWorkspaceEnsurer) explicitly.
func (f *FrontendAPI) installWorkspaceEnsurer() {
	if f.appCell() == nil {
		return
	}
	if m := f.app.Manager(); m != nil {
		m.SetWorkspaceEnsurer(f.ensureManagedWorkspace)
	}
}

// ensureManagedWorkspace is the WorkspaceEnsurer installed on the session
// manager. The stored Git identity is already validated — the manager runs
// NormalizeWorkspaceBinding before invoking this hook — so it guarantees the
// tree exists on the pinned branch before the orchestrator is built, using the
// binding's recorded durable path (or the live/historical resolution for a
// pre-durable empty path). It reports recreated=true exactly when the tree (or
// its stale metadata) was absent and had to be recreated from the branch —
// uncommitted data that lived only in the missing tree is unrecoverable, which
// the manager surfaces as an explicit warning.
func (f *FrontendAPI) ensureManagedWorkspace(ctx context.Context, repoRoot string, binding *session.WorkspaceBinding) (bool, error) {
	// Canonicalize the root the resolver handed back (fail-soft — see
	// canonicalWorktreeRoot): legacy rows registered before the manager
	// canonicalized internal workspaces may keep a symlinked ancestor.
	repoRoot = canonicalWorktreeRoot(repoRoot)
	owner := f.worktreeOwner()
	trees, err := owner.List(ctx, repoRoot)
	if err != nil {
		return false, fmt.Errorf("list worktrees of %s: %w", repoRoot, err)
	}
	// The binding is already normalized (the manager runs
	// NormalizeWorkspaceBinding before installing this ensurer), so a durable
	// managed path is used exactly as recorded. Re-recognizing it here would
	// re-gate restore on the container marker/legacy layout and make a healthy
	// tree un-restorable after the marker or the app-data container is removed.
	// Only a pre-durable row (empty path) resolves from the live list or the
	// historical container, independent of the creation root.
	target := canonicalWorktreeRoot(binding.WorkspacePath)
	if target == "" {
		target, err = owner.Path(ctx, repoRoot, binding.WorktreeName)
		if err != nil {
			return false, err
		}
	}
	// Probe the durable path in canonical form, matching Git's listing even
	// for legacy registrations containing an operator/system symlink.
	entry := workspace.FindWorktree(trees, target)
	missing := entry == nil || !entry.IsLinked() || entry.Prunable
	if _, err := owner.RecreateAt(ctx, repoRoot, binding.WorktreeName, binding.Branch, target); err != nil {
		return false, err
	}
	// Re-establish the container's ownership marker when it is absent (e.g. the
	// app-data container was cleaned and the tree recreated here):
	// classification keys on that marker, so a tree c0wrk has just ensured must
	// stay recognizable as managed. Best-effort — a failure never fails the
	// restore. The legacy checkout-local container is marker-less by design and
	// is never marked.
	if container := filepath.Dir(target); filepath.Base(container) == core.ProjectWorktreesSegment {
		if err := core.MarkWorktreeContainer(repoRoot, container); err != nil {
			f.log().Warn("could not re-establish the managed worktree container marker",
				"repo", repoRoot, "container", container, "error", err)
		}
	}
	return missing, nil
}

// SessionWorkspaceChoice is the send-time workspace request of the
// draft-free creation flow: the first message of a fresh session may carry
// the workspace choice the user made in the chat toolbar's selector. The
// backend provisions (or adopts) the managed worktree, persists the
// binding inside the fresh window, and lets the send's own session access
// restore an orchestrator built for the new workspace. A nil choice (the
// zero value the frontend passes for every ordinary send) is a no-op.
type SessionWorkspaceChoice struct {
	// Branch is the picked branch. Empty with CreateBranch=true derives a
	// session-scoped branch name, mirroring the former CreateManagedSession.
	Branch string `json:"branch"`
	// CreateBranch requests that a MISSING branch be created at StartPoint
	// (empty = repository HEAD); an EXISTING branch is never re-created —
	// the request then behaves exactly like an existing-branch pick (git
	// DWIM semantics, the same contract the former CreateManagedSession had).
	CreateBranch bool `json:"create_branch"`
	// StartPoint is the creation start point for a missing branch; a
	// remote-tracking pick lands here ("origin/x" creates local x from the
	// remote ref).
	StartPoint string `json:"start_point"`
}

// Bind errors. They wrap the returned error so callers (tests, future RPC
// surfaces) can classify the outcome with errors.Is.
var (
	// ErrBindInProgress reports that another send for this session is
	// already applying a workspace bind (the consumption window is busy).
	// The frontend's own re-entrancy guard makes this unreachable from the
	// UI; it is the backend backstop for a hand-crafted concurrent send.
	ErrBindInProgress = errors.New("a workspace bind is already in progress for this session")
	// ErrWorkspaceAlreadyChosen reports that the session's fresh window
	// already persisted a managed-worktree binding for a DIFFERENT choice:
	// the workspace is chosen once per fresh session.
	ErrWorkspaceAlreadyChosen = errors.New("session workspace already chosen")
)

// bindSessionWorkspace applies a send-time workspace choice to a FRESH
// session (no transcript, no task rows — enforced atomically by the store's
// BindSessionWorkspace). The branch-holder dispatch mirrors the former
// CreateManagedSession: a branch held by an existing managed tree ADOPTS
// that tree (shared trees, ADR-082), a branch held by the project checkout
// is a deliberate no-op success (the session already executes exactly
// there — the caller keeps the local binding and clears the pending
// choice), and a branch held by an external worktree is a typed
// ErrBranchBusy refusal. A provisioned-fresh tree is compensated on every
// later failure; adopted trees are never touched.
//
// The binding write is followed by an in-memory eviction so the send's own
// session access lazily restores with an orchestrator built for the NEW
// workspace — the orchestrator captures its workspace at construction, so
// a binding write alone would not retarget execution. Before the eviction
// the session's terminal is stopped (the promotion-flow protocol: the
// frontend hears session:<id>:terminal_exited and lazily resurrects the
// shell in the new workspace) and the staged attachments are snapshotted
// and re-staged after the eviction — the pending lists are memory-only.
// A concurrent bind for the same session is refused (ErrBindInProgress);
// a choice that repeats an already-persisted managed binding is a no-op
// success, a different one is refused (ErrWorkspaceAlreadyChosen).
func (f *FrontendAPI) bindSessionWorkspace(ctx context.Context, id string, choice *SessionWorkspaceChoice) error {
	if choice == nil {
		return nil
	}
	if f.appCell() == nil || f.app.Manager() == nil {
		return errors.New("session manager not initialized - check startup logs for LLM router or configuration errors")
	}
	if f.store == nil {
		return errors.New("session store not initialized")
	}
	// One bind at a time per session: a second send carrying a workspace
	// choice while the first is still provisioning would race the same
	// fresh window (double provision, conflicting compensations). The
	// frontend refuses such sends itself; this is the backend backstop.
	if _, busy := f.bindInFlight.LoadOrStore(id, struct{}{}); busy {
		return fmt.Errorf("%w: wait for the in-flight send to settle", ErrBindInProgress)
	}
	defer f.bindInFlight.Delete(id)
	// The same generous provisioning budget the sibling managed flows get:
	// a wedged git fails the send explicitly instead of hanging it.
	ctx, cancel := context.WithTimeout(ctx, managedProvisionTimeout)
	defer cancel()

	info, err := f.store.LoadSession(ctx, id)
	if err != nil {
		return fmt.Errorf("load session for workspace binding: %w", err)
	}
	if info == nil {
		return fmt.Errorf("session %s not found", id)
	}
	projectID := info.ProjectID
	if projectID == project.NoProjectID {
		return errors.New("CHAT (No Project) sessions cannot own a managed worktree")
	}
	if info.HasUnfinishedTask {
		return fmt.Errorf("%w: the session already has an unfinished task", session.ErrSessionNotFresh)
	}
	// Archived sessions are read-only; dispatch rejects them again (the
	// authoritative ErrSessionArchived gate), but only AFTER this bind has
	// provisioned a tree, persisted the binding and evicted the session —
	// refuse before any of that runs.
	if info.Archived {
		return fmt.Errorf("%w: a read-only session cannot have its workspace bound", session.ErrSessionArchived)
	}
	// Refuse a session that is running something before any git runs (the
	// store guard below remains the authoritative race-closer).
	if status, statusErr := f.app.Manager().GetSessionRuntimeStatus(id); statusErr == nil && status.Active {
		return fmt.Errorf("%w: the session has an active task", session.ErrSessionNotFresh)
	}

	branch := strings.TrimSpace(choice.Branch)
	if choice.CreateBranch && branch == "" {
		branch = "session-" + shortIdentity(id)
	}
	if branch == "" {
		return errors.New("a branch is required — name an existing branch or pass create_branch=true")
	}
	// A fresh window that already persists a managed binding (a previous
	// send's bind succeeded but the send itself failed — no transcript/task
	// rows, so the window is still open) accepts only the SAME choice: the
	// session already executes where that choice wants it, so a repeat is a
	// no-op success. A DIFFERENT choice is refused: dispatching by branch
	// holder alone would silently re-provision (orphaning the previous
	// tree) or no-op (leaving execution in the old tree) — neither honors
	// the fresh selection. Deleting the session resets the window.
	if prev := info.WorkspaceBinding; prev != nil && prev.Kind == session.WorkspaceManagedWorktree {
		if prev.Branch == branch {
			return nil
		}
		return fmt.Errorf("%w: the session is already bound to managed worktree %q on branch %q (the earlier send provisioned it before failing); the workspace is chosen once per fresh session — delete the session to choose again", ErrWorkspaceAlreadyChosen, prev.WorktreeName, prev.Branch)
	}
	// Canonicalize the provisioning root for the git primitives
	// (canonicalWorktreeRoot), the same split the sibling flows use.
	repoRoot, err := f.resolveProjectRoot(ctx, projectID)
	if err != nil {
		return err
	}
	binding := &session.WorkspaceBinding{
		Kind:         session.WorkspaceManagedWorktree,
		WorktreeName: managedTreeName(id),
		Branch:       branch,
	}
	// Validate the whole binding (branch syntax, tree name, containment)
	// BEFORE any git runs, so a malformed request never provisions anything.
	if _, err := session.NormalizeWorkspaceBinding(projectID, repoRoot, binding); err != nil {
		return fmt.Errorf("invalid workspace choice: %w", err)
	}

	createExisting := false
	if choice.CreateBranch {
		exists, err := workspace.BranchExists(ctx, repoRoot, branch)
		if err != nil {
			return fmt.Errorf("checking branch %s: %w", branch, err)
		}
		createExisting = exists
	}
	owner := f.worktreeOwner()
	if !choice.CreateBranch || createExisting {
		trees, err := owner.List(ctx, repoRoot)
		if err != nil {
			return fmt.Errorf("listing worktrees of %s: %w", repoRoot, err)
		}
		if holder := branchHolder(trees, branch); holder != nil {
			switch holder.Kind {
			case workspace.WorktreeManaged:
				return f.bindAdoptedTree(ctx, owner, repoRoot, id, projectID, branch, holder, info.WorkspaceBinding)
			case workspace.WorktreeMain:
				// The checkout holds the branch: the fresh session already
				// executes exactly there, so the choice lands as-is — keep
				// the local binding (an identity, never re-derived into a
				// managed one) and report success.
				return nil
			default:
				return fmt.Errorf("%w: branch %s is checked out in external worktree %s — created outside c0wrk; use a local session or remove that tree first", workspace.ErrBranchBusy, branch, holder.Path)
			}
		}
	}

	provOwner, err := f.newWorktreeOwner(projectID)
	if err != nil {
		return err
	}
	var provisioned workspace.WorktreeInfo
	if choice.CreateBranch && !createExisting {
		provisioned, err = provOwner.ProvisionNewBranch(ctx, repoRoot, binding.WorktreeName, branch, choice.StartPoint)
	} else {
		provisioned, err = provOwner.ProvisionBranch(ctx, repoRoot, binding.WorktreeName, branch)
	}
	if err != nil {
		return err
	}
	binding.WorkspacePath = provisioned.Path
	if err := f.store.BindSessionWorkspace(ctx, id, projectID, binding); err != nil {
		f.compensateProvisionedTree(ctx, repoRoot, binding.WorktreeName, "workspace binding failed")
		return err
	}
	// Quiesce the session in memory so the send's own access lazily restores
	// with an orchestrator built for the NEW workspace. The terminal stops
	// first (the promotion-flow protocol): its PTY's cwd lives in the OLD
	// workspace, and a live shell cannot be moved — the frontend hears
	// session:<id>:terminal_exited and lazily re-spawns the shell in the new
	// workspace on the session's next activation. The staged attachments are
	// snapshotted before the eviction and re-staged after: the pending lists
	// are memory-only, so without the carry-over the first send would
	// silently lose them across the restore.
	if f.stopSessionTerminal(id) {
		f.emitTerminalExited(id)
	}
	// The eviction captures the staged attachments under the same critical
	// section that deletes the session (EvictSessionCarryingAttachments), so
	// a staging append racing the eviction is either carried by the capture
	// or re-stages itself on the restored session — no interleaving loses it.
	pendingSnap, evictErr := f.bindEvict(id)
	if evictErr != nil {
		// Roll the persisted binding back so the store agrees with the
		// in-memory session that refused eviction, then release the tree —
		// but only on a CONFIRMED rollback. A refused rollback (the fresh
		// window closed: a parallel send already started a task) leaves the
		// persisted binding naming this tree; releasing it would strand the
		// binding on a missing path and force the next restore to
		// surprise-reprovision, so the tree stays and the error says so.
		if rbErr := f.rollbackSessionBinding(ctx, id, projectID, info.WorkspaceBinding, binding.WorktreeName); rbErr != nil {
			f.log().Error("workspace-binding rollback refused; provisioned tree kept under the live binding",
				"session_id", id, "worktree", binding.WorktreeName, "cause", rbErr)
			return fmt.Errorf("session workspace binding persisted but the session could not be reloaded; the rollback was refused (the fresh window closed) and the session remains bound to worktree %q: %w", binding.WorktreeName, evictErr)
		}
		f.compensateProvisionedTree(ctx, repoRoot, binding.WorktreeName, "session eviction failed")
		return fmt.Errorf("session workspace binding persisted but the session could not be reloaded; the previous workspace was restored: %w", evictErr)
	}
	if err := f.app.Manager().RestorePendingAttachments(id, pendingSnap); err != nil {
		// The binding is persisted but the session restored WITHOUT the
		// staged attachments. Rejecting the send and notifying the UI (the
		// event drops the stale chips) keeps the retry honest: a silent
		// retry here would start the task without the files, because the
		// backend pending lists — the send's only source — are empty.
		f.app.Manager().EmitStagedAttachmentsLost(id, pendingSnap)
		return fmt.Errorf("session workspace bound, but its staged attachments could not be carried across the workspace switch; the files were NOT sent — re-attach them: %w", err)
	}
	// Seed the tree's embedding cache from the checkout's — after the success
	// point and before the send proceeds (the task's vector manager builds
	// against the new workspace root).
	f.seedWorktreeEmbeddingCache(projectID, binding.WorktreeName)
	return nil
}

// bindAdoptedTree re-binds a fresh session to an EXISTING managed worktree
// (the shared-tree revision of ADR-080), mirroring the adoption-creation
// race protocol: Recreate, the binding persist, and the eviction all run
// inside the adoption↔deletion critical section (managedTreeMu), and the
// tree is re-validated after the persist — a concurrent last-owner deletion
// either counts this session's committed binding (release skipped) or
// removed the tree BEFORE the write, in which case the just-persisted
// binding is rolled back and the session restores on its previous
// workspace. Adopted trees are never released or compensated.
func (f *FrontendAPI) bindAdoptedTree(ctx context.Context, owner *worktrees.Owner, repoRoot, id, projectID, branch string, holder *workspace.WorktreeInfo, prevBinding *session.WorkspaceBinding) error {
	f.managedTreeMu.Lock()
	defer f.managedTreeMu.Unlock()
	if _, err := owner.Recreate(ctx, repoRoot, holder.Name, branch, holder.Path); err != nil {
		return err
	}
	binding := &session.WorkspaceBinding{
		Kind:          session.WorkspaceManagedWorktree,
		WorkspacePath: holder.Path,
		WorktreeName:  holder.Name,
		Branch:        branch,
	}
	if err := f.store.BindSessionWorkspace(ctx, id, projectID, binding); err != nil {
		return err
	}
	// Quiesce + carry-over, mirroring the provisioned path: the terminal
	// stops before the eviction (PTY cwd lives in the old workspace; the
	// frontend resurrects the shell in the adopted tree on the next
	// activation), and the staged attachments hop across the eviction via
	// their memory-only snapshot.
	if f.stopSessionTerminal(id) {
		f.emitTerminalExited(id)
	}
	pendingSnap, evictErr := f.bindEvict(id)
	if evictErr != nil {
		if rbErr := f.rollbackSessionBinding(ctx, id, projectID, prevBinding, holder.Name); rbErr != nil {
			return fmt.Errorf("session workspace binding persisted but the session could not be reloaded; the rollback was refused (the fresh window closed) and the session remains bound to worktree %q: %w", holder.Name, evictErr)
		}
		return fmt.Errorf("session workspace binding persisted but the session could not be reloaded; the previous workspace was restored: %w", evictErr)
	}
	if err := f.app.Manager().RestorePendingAttachments(id, pendingSnap); err != nil {
		f.app.Manager().EmitStagedAttachmentsLost(id, pendingSnap)
		return fmt.Errorf("session workspace bound, but its staged attachments could not be carried across the workspace switch; the files were NOT sent — re-attach them: %w", err)
	}
	if _, err := owner.Inspect(ctx, repoRoot, holder.Name); err != nil {
		if rbErr := f.rollbackSessionBinding(ctx, id, projectID, prevBinding, holder.Name); rbErr != nil {
			return fmt.Errorf("managed worktree %q was gone at the post-bind re-validation (removed by a concurrent last-owner deletion); the rollback was refused (the fresh window closed) and the session remains bound to it: %w", holder.Name, err)
		}
		return fmt.Errorf("managed worktree %q was gone at the post-bind re-validation (removed by a concurrent last-owner deletion); the previous workspace was restored — retry the send to provision a fresh tree: %w", holder.Name, err)
	}
	// Idempotent: the tree's first session seeded the cache already; a fresh
	// seed keeps adopted (previously orphaned) trees warm too.
	f.seedWorktreeEmbeddingCache(projectID, holder.Name)
	return nil
}

// rollbackSessionBinding restores a session's previous persisted workspace
// binding after a post-write step (eviction refusal, adoption re-validation)
// failed. It REPORTS the outcome: a nil return means the previous binding is
// durably recorded again and the caller may release a provisioned tree; a
// non-nil return means the restore did NOT happen (most commonly the store's
// atomic fresh-window guard refused the write because the window closed — a
// parallel send already started a task), so the caller must keep the tree:
// the persisted binding still names it, and releasing it would strand the
// binding on a missing path. Best-effort but loud: a failed rollback
// self-heals only on the next restore of the affected session, so the error
// is logged at Error here as well as surfaced to the caller.
func (f *FrontendAPI) rollbackSessionBinding(ctx context.Context, id, projectID string, prev *session.WorkspaceBinding, treeName string) error {
	if prev == nil {
		// Unreachable from the bind paths (NormalizeWorkspaceBinding gives
		// every CODE session a non-nil binding), but with no previous binding
		// recorded the rollback outcome is unknowable — refuse rather than
		// let the caller release a tree under the live persisted binding.
		return errors.New("no previous workspace binding recorded; rollback outcome unknown")
	}
	if err := f.store.BindSessionWorkspace(ctx, id, projectID, prev); err != nil {
		f.log().Error("failed to roll back the persisted workspace binding",
			"session_id", id, "worktree", treeName, "error", err)
		return err
	}
	return nil
}

// branchHolder returns the worktree entry currently holding branch, or nil
// when the branch is not checked out anywhere.
func branchHolder(trees []workspace.WorktreeInfo, branch string) *workspace.WorktreeInfo {
	for i := range trees {
		if trees[i].Branch == branch {
			return &trees[i]
		}
	}
	return nil
}

// bindEvict performs the bind paths' in-memory eviction and returns the
// staged-attachment capture: the test seam when installed
// (FrontendAPI.bindEvictHook), the manager's eviction-with-capture otherwise.
func (f *FrontendAPI) bindEvict(id string) (*session.PendingAttachmentSnapshot, error) {
	if f.bindEvictHook != nil {
		return f.bindEvictHook(id)
	}
	return f.app.Manager().EvictSessionCarryingAttachments(id)
}

func (f *FrontendAPI) compensateProvisionedTree(ctx context.Context, repoRoot, treeName, cause string) {
	if treeName == "" {
		return // an adopted tree: it pre-existed and is never touched
	}
	if err := f.worktreeOwner().Release(ctx, repoRoot, treeName, workspace.RemoveWorktreeOptions{}); err != nil {
		f.log().Warn("compensation failed: provisioned worktree left in place",
			"tree", treeName, "repo", repoRoot, "cause", cause, "error", err)
		return
	}
	f.log().Info("compensated provisioned worktree after failure", "tree", treeName, "repo", repoRoot, "cause", cause)
}

// forkManagedSession forks a session that owns a managed worktree into its
// OWN tree on a derived branch (<source branch>-fork-<short id>) created at
// the source tree's COMMITTED HEAD. Uncommitted changes in the source tree
// are NOT copied — the fork's starting point is the commit, and this path
// makes no uncommitted-copy claim; the source tree is left byte-identical.
// The store fork (deep row copy) and the tree provisioning are compensated
// against each other: a store failure releases the freshly provisioned tree
// (its branch is kept).
func (f *FrontendAPI) forkManagedSession(ctx context.Context, src *session.SessionInfo, cloneReview session.ForkReviewCloner) (*session.SessionInfo, error) {
	f.seedAcquire()
	// The caller (ForkSession) passes a never-deadlined context; bound the
	// worktree inspect and the store fork with the same budget the sibling
	// provisioning step gets, so a wedged git fails the synchronous
	// ForkSession RPC explicitly instead of hanging it forever (review
	// [117]). ProvisionNewBranch derives its own (nested) deadline below.
	ctx, cancel := context.WithTimeout(ctx, managedProvisionTimeout)
	defer cancel()

	binding := src.WorkspaceBinding
	repoRoot, err := f.resolveProjectRoot(ctx, src.ProjectID)
	if err != nil {
		return nil, fmt.Errorf("cannot resolve project root for managed fork: %w", err)
	}

	owner := f.worktreeOwner()
	entry, err := owner.Inspect(ctx, repoRoot, binding.WorktreeName)
	if err != nil {
		if errors.Is(err, workspace.ErrWorktreeNotLinked) {
			return nil, fmt.Errorf("cannot fork: the source session's worktree %q is missing — restore the session first", binding.WorktreeName)
		}
		return nil, err
	}
	sourceHead := entry.Head // the committed HEAD; uncommitted work is deliberately excluded

	provisionCtx, cancel := context.WithTimeout(ctx, managedProvisionTimeout)
	defer cancel()

	draft := session.NewSessionDraft(src.ProjectID, nil)
	treeName := managedTreeName(draft.ID)
	branch := forkBranchName(binding.Branch, draft.ID)
	owner, err = f.newWorktreeOwner(src.ProjectID)
	if err != nil {
		return nil, err
	}
	provisioned, err := owner.ProvisionNewBranch(provisionCtx, repoRoot, treeName, branch, sourceHead)
	if err != nil {
		return nil, err
	}

	commit := f.managedForkCommit
	if commit == nil {
		commit = f.store.ForkSessionWithBinding
	}
	info, err := commit(ctx, src.ID, draft.ID, &session.WorkspaceBinding{
		Kind:          session.WorkspaceManagedWorktree,
		WorkspacePath: provisioned.Path,
		WorktreeName:  treeName,
		Branch:        branch,
	}, cloneReview)
	if err != nil {
		f.compensateProvisionedTree(provisionCtx, repoRoot, treeName, "fork persistence failed")
		return nil, err
	}
	// Same contract as bindSessionWorkspace: after the success point, before
	// the RPC returns and the frontend focuses the fork's tree. A fork's tree
	// starts at the source's committed HEAD, so the checkout cache is a
	// near-perfect match for its first index pass.
	f.seedWorktreeEmbeddingCache(src.ProjectID, treeName)
	return info, nil
}

// resolveProjectRoot resolves a project's registered repository root and
// validates its shape. Deletion, restore, and fork all derive tree paths
// from it; an unusable root must fail those flows explicitly rather than
// guess.
func (f *FrontendAPI) resolveProjectRoot(ctx context.Context, projectID string) (string, error) {
	f.seedAcquire()
	if f.projectManager == nil {
		return "", errors.New("project manager not initialized")
	}
	proj, err := f.projectManager.GetProject(projectID)
	if err != nil {
		return "", fmt.Errorf("load project %s: %w", projectID, err)
	}
	if proj == nil {
		return "", fmt.Errorf("project %s not found", projectID)
	}
	root := proj.WorkspacePath
	if root == "" || !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return "", fmt.Errorf("project %s has no absolute registered workspace root", projectID)
	}
	// Canonicalize the registered root for the git primitives (fail-soft to
	// the stored form — see canonicalWorktreeRoot): legacy rows registered
	// before the manager canonicalized internal workspaces may carry a
	// symlinked ancestor.
	return canonicalWorktreeRoot(root), nil
}

// prepareManagedTreeDeletion runs the managed part of session deletion
// BEFORE any session state is removed, so a blocked or failed removal leaves
// the session fully retryable. The one exception is the shared-tree co-owner
// path: when other sessions still bind the tree, no removal (and therefore
// no blocking confirmation) can happen, so the pre-flight removes the
// deleting session's own store row itself, inside the critical section — a
// concurrent co-owner's count must observe it gone, or two simultaneous
// deletions of the last two owners would both skip the release and orphan
// the tree. It then returns the session's project ID so the caller's
// store-only fallback can still clean the session's internal files (the row
// they would normally be resolved from is gone); it returns "" when the row
// was left to the caller. The pre-flight is otherwise a no-op (returning "")
// for CHAT and local sessions, for sessions that no longer exist, and —
// deliberately — for a store read failure (the tolerant legacy path then
// handles cleanup, matching DeleteSession's established best-effort contract
// for internal files; a tree can be released by retrying the deletion once
// the store is reachable again).
func (f *FrontendAPI) prepareManagedTreeDeletion(ctx context.Context, id string, opts SessionDeleteOptions) (cleanupProjectID string, err error) {
	f.seedAcquire()
	if f.store == nil {
		return "", nil
	}
	// The caller passes a never-deadlined context; bound the git worktree
	// work (and the store read) with the same generous budget provisioning
	// gets, so a wedged git fails the DeleteSession RPC explicitly instead
	// of hanging it — and, while the removal holds the per-repo worktree
	// lock, every other managed-worktree operation for the repository
	// behind it (review [115]).
	ctx, cancel := context.WithTimeout(ctx, managedProvisionTimeout)
	defer cancel()
	info, err := f.store.LoadSession(ctx, id)
	if err != nil {
		f.log().Warn("failed to load session for managed-tree deletion check", "session_id", id, "error", err)
		return "", nil
	}
	if info == nil || info.WorkspaceBinding == nil || info.WorkspaceBinding.Kind != session.WorkspaceManagedWorktree {
		return "", nil
	}
	binding := info.WorkspaceBinding

	// 0. Decide the block FIRST, touching nothing (review [161]): the
	// deletion contract promises that a blocked deletion leaves the
	// session, tree, and branch "fully intact and retryable", but the
	// task-join and terminal-stop below are irreversible — a first,
	// unconfirmed call that only exists to surface the user decision must
	// not already have killed the in-flight run. The probe applies the
	// same locked/dirty classification the removal primitive applies at
	// removal time; the authoritative recheck inside the release still
	// gates the actual removal.
	//
	// A shared tree lowers the stakes: a co-owner deletion removes nothing
	// (the tree — and any uncommitted work in it — stays for the remaining
	// sessions), so no confirmation is even asked and the probe is skipped.
	// The count here is advisory (step 3 re-counts under the critical
	// section, and the removal primitives recheck at removal time); on a
	// count failure the probe still runs, so a wedged store can only ever
	// over-block (the retryable direction), never under-block.
	coOwnerShared := false
	if sharers, cerr := f.store.CountManagedWorktreeSessions(ctx, binding.WorktreeName, id); cerr != nil {
		f.log().Warn("failed to count shared-tree co-owners before the deletion probe; probing anyway",
			"session_id", id, "worktree", binding.WorktreeName, "error", cerr)
	} else {
		coOwnerShared = sharers > 0
	}
	if !coOwnerShared {
		repoRoot, err := f.resolveProjectRoot(ctx, info.ProjectID)
		if err != nil {
			return "", fmt.Errorf("cannot resolve project root to release session worktree: %w", err)
		}
		if blockErr := f.probeSessionTreeDeletionBlock(ctx, repoRoot, binding, opts); blockErr != nil {
			return "", blockErr
		}
	}

	// 1. Join the running task first: its final writes must be visible to
	// the dirty recheck below. CancelTask signals cancellation and waits
	// (bounded by the manager's stop timeout) for the task goroutine.
	if mgr := f.app.Manager(); mgr != nil {
		if status, serr := mgr.GetSessionRuntimeStatus(id); serr == nil && status.Active {
			if cerr := mgr.CancelTask(id); cerr != nil {
				f.log().Warn("failed to cancel running task before session deletion", "session_id", id, "error", cerr)
			}
		}
	}
	// 2. Stop the session terminal: its shell's working directory lives
	// inside the tree being removed.
	f.stopSessionTerminal(id)

	// 3. The [co-owner count → own-row removal → release] protocol runs
	// inside the adoption↔deletion critical section (managedTreeMu, see
	// bindAdoptedTree): an adoption that is committing its binding either
	// finishes first and is counted below, or commits after the release and
	// re-validates against the already-removed tree, rolling itself back —
	// and a concurrent co-owner deletion either observes this session's row
	// removed and releases, or removes its own row first for this session to
	// observe.
	f.managedTreeMu.Lock()
	released, rowGoneProjectID, repoRoot, releaseErr := f.removeOwnerAndReleaseTreeLocked(ctx, info.ProjectID, binding, id, opts)
	f.managedTreeMu.Unlock()
	if releaseErr != nil {
		return "", releaseErr
	}
	if released {
		// The tree is gone: drop its worktree-scoped vector-index storage
		// too (best-effort — leftover data would only be derived garbage:
		// in the narrow resurrection window an in-flight adoption's Recreate
		// can re-create a just-released tree from its branch before this
		// cleanup runs, and only that tree's derived vector/cache data is
		// then discarded — re-indexed on demand). The registry release first
		// shuts the root's live manager (closing its open chromem handles so
		// the removal works on Windows too).
		f.deleteWorktreeVectorIndex(repoRoot, info.ProjectID, binding.WorktreeName, binding.WorkspacePath)
	}
	return rowGoneProjectID, nil
}

// removeOwnerAndReleaseTreeLocked removes the deleting session's row from the
// shared tree's owner set and releases the tree only when that made it the
// LAST owner. When co-owners remain, the row is still removed (so their
// counts observe it gone — see prepareManagedTreeDeletion for why that must
// happen inside the critical section), but the tree — and any uncommitted
// work in it — stays for the remaining sessions and the dirty/locked
// confirmations are simply never reached; the returned project ID then tells
// the caller the row is already gone. A count failure blocks the deletion
// (retryable) instead of risking a shared tree's removal. The caller must
// hold managedTreeMu so this [count → row removal → release] protocol cannot
// interleave with an adoption's [commit binding → re-validate tree] pair
// (bindAdoptedTree) or with another deletion's protocol.
func (f *FrontendAPI) removeOwnerAndReleaseTreeLocked(ctx context.Context, projectID string, binding *session.WorkspaceBinding, deletingSessionID string, opts SessionDeleteOptions) (released bool, rowGoneProjectID, repoRoot string, err error) {
	sharers, err := f.store.CountManagedWorktreeSessions(ctx, binding.WorktreeName, deletingSessionID)
	if err != nil {
		return false, "", "", fmt.Errorf("count sessions sharing worktree %q: %w", binding.WorktreeName, err)
	}
	if sharers > 0 {
		f.log().Debug("skipping managed tree release: other sessions still share it",
			"session_id", deletingSessionID, "worktree", binding.WorktreeName, "other_sessions", sharers)
		if err := f.store.DeleteSession(ctx, deletingSessionID); err != nil {
			return false, "", "", fmt.Errorf("remove deleted session %s from the owner set of worktree %q: %w", deletingSessionID, binding.WorktreeName, err)
		}
		return false, projectID, "", nil
	}
	// The removal primitives recheck dirtiness and lock state themselves, at
	// removal time, so the confirmation is never based on a stale snapshot.
	repoRoot, err = f.resolveProjectRoot(ctx, projectID)
	if err != nil {
		return false, "", "", fmt.Errorf("cannot resolve project root to release session worktree: %w", err)
	}
	if err := f.releaseSessionTree(ctx, repoRoot, binding, opts); err != nil {
		return false, "", "", err
	}
	return true, "", repoRoot, nil
}

// probeSessionTreeDeletionBlock reports the *SessionDeleteBlockedError the
// release attempt would produce, without touching anything: the same
// locked/dirty classification RemoveWorktree applies at removal time (live
// worktree list + the tree's porcelain status), evaluated BEFORE the
// destructive pre-flight so a blocked first call destroys neither the
// in-flight task nor the terminal (review [161]). A nil return means "not
// blocked" — or "the probe could not classify" (tree not linked anymore,
// listing failure, dirty-probe failure); the authoritative recheck inside
// releaseSessionTree still gates the actual removal, so a probe pass never
// bypasses a real block.
func (f *FrontendAPI) probeSessionTreeDeletionBlock(ctx context.Context, repoRoot string, binding *session.WorkspaceBinding, opts SessionDeleteOptions) error {
	entry, err := f.worktreeOwner().Inspect(ctx, repoRoot, binding.WorktreeName)
	if err != nil {
		// Not linked anymore (nothing to release) or the listing failed:
		// neither is a user decision — let the release attempt decide.
		return nil //nolint:nilerr // the authoritative release path re-checks and reports the real block
	}
	if entry.Kind != workspace.WorktreeManaged {
		return nil // non-managed tree: the release leaves it in place
	}
	if entry.Locked && !opts.UnlockLockedTree {
		return &SessionDeleteBlockedError{
			Reason: fmt.Sprintf("the session's worktree %q is locked (%s)", binding.WorktreeName, entry.LockedReason),
			Option: "unlock_locked_tree",
		}
	}
	if !opts.ConfirmUncommittedLoss && !entry.Prunable {
		if dirty, derr := workspace.WorktreeDirty(ctx, entry.Path); derr == nil && dirty {
			return &SessionDeleteBlockedError{
				Reason: fmt.Sprintf("the session's worktree %q (branch %s) contains uncommitted changes; deleting the session removes the tree and those changes cannot be recovered (the branch itself is kept)", binding.WorktreeName, binding.Branch),
				Option: "confirm_uncommitted_loss",
			}
		}
	}
	return nil
}

// releaseSessionTree removes the session's managed tree per the caller's
// explicit decisions. Never-removal boundaries: a tree that is not linked
// anymore is already gone (nothing to do), and a tree classified as
// non-managed (main/external) is left untouched — session deletion never
// removes a foreign checkout. The branch is never deleted by any path here.
func (f *FrontendAPI) releaseSessionTree(ctx context.Context, repoRoot string, binding *session.WorkspaceBinding, opts SessionDeleteOptions) error {
	owner := f.worktreeOwner()
	entry, err := owner.Inspect(ctx, repoRoot, binding.WorktreeName)
	if err != nil {
		if errors.Is(err, workspace.ErrWorktreeNotLinked) {
			return nil
		}
		return fmt.Errorf("inspect session worktree %q: %w", binding.WorktreeName, err)
	}
	if entry.Kind != workspace.WorktreeManaged {
		f.log().Warn("session deletion: path holds a non-managed worktree; leaving it in place",
			"path", entry.Path, "kind", string(entry.Kind), "repo", repoRoot)
		return nil
	}
	if err := owner.Release(ctx, repoRoot, binding.WorktreeName, workspace.RemoveWorktreeOptions{
		Force:  opts.ConfirmUncommittedLoss,
		Unlock: opts.UnlockLockedTree,
	}); err != nil {
		switch {
		case errors.Is(err, workspace.ErrWorktreeDirty) && !opts.ConfirmUncommittedLoss:
			return &SessionDeleteBlockedError{
				Reason: fmt.Sprintf("the session's worktree %q (branch %s) contains uncommitted changes; deleting the session removes the tree and those changes cannot be recovered (the branch itself is kept)", binding.WorktreeName, binding.Branch),
				Option: "confirm_uncommitted_loss",
			}
		case errors.Is(err, workspace.ErrWorktreeLocked) && !opts.UnlockLockedTree:
			return &SessionDeleteBlockedError{
				Reason: fmt.Sprintf("the session's worktree %q is locked (%s)", binding.WorktreeName, lockedReasonOf(err)),
				Option: "unlock_locked_tree",
			}
		default:
			return fmt.Errorf("release session worktree %q: %w", binding.WorktreeName, err)
		}
	}
	return nil
}

// lockedReasonOf extracts the primitive's verbatim lock reason when present.
func lockedReasonOf(err error) string {
	var state *workspace.StateError
	if errors.As(err, &state) {
		return state.Reason
	}
	return "no reason recorded"
}

// stopSessionTerminal stops the session's terminal, if any, and reports
// whether a live terminal was stopped. Shared by the managed pre-flight
// (before tree removal), the bind paths (before the workspace-switching
// eviction), and the legacy deletion path (idempotent: IsActive gates the
// Stop). The promotion flow uses the report to emit
// session:<id>:terminal_exited — the one explicit stop the frontend must
// hear about, because its terminal instance survives the stop.
func (f *FrontendAPI) stopSessionTerminal(id string) bool {
	f.seedAcquire()
	if f.terminalManager == nil || !f.terminalManager.IsActive(id) {
		return false
	}
	if err := f.terminalManager.Stop(id); err != nil {
		f.log().Warn("failed to stop terminal for session", "session_id", id, "error", err)
	}
	return true
}

// emitTerminalExited announces an explicit terminal stop so the frontend's
// xterm instance can lazily resurrect the shell — in the session's (new)
// workspace on its next activation. Nil-guarded: struct-literal-constructed
// APIs (tests, early lifecycle) may not have the event sink wired.
func (f *FrontendAPI) emitTerminalExited(id string) {
	if f.emitEvent == nil {
		return
	}
	f.emitEvent(fmt.Sprintf("session:%s:terminal_exited", id), map[string]string{})
}
