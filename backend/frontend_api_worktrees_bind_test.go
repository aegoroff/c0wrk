package backend

// Send-time workspace binding tests (the draft-free creation flow): the
// first message of a FRESH session carries a SessionWorkspaceChoice, and
// bindSessionWorkspace provisions (or adopts) the managed worktree, persists
// the binding inside the fresh window, and evicts the in-memory session so
// the send's own session access restores an orchestrator built for the NEW
// workspace. Everything runs against the REAL git binary through the
// production primitives, mirroring the sibling lifecycle tests above.

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/backend/session"
	"github.com/v0lka/c0wrk/core/workspace"
)

// newFreshLocalSession creates a plain local session through the production
// CreateSession RPC — exactly the row the draft-free "New Session" gesture
// produces in a CODE project.
func newFreshLocalSession(t *testing.T, h *wtHarness) *session.SessionInfo {
	t.Helper()
	info, err := h.api.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if b := info.WorkspaceBinding; b == nil || b.Kind != session.WorkspaceLocal {
		t.Fatalf("fresh session binding must be local, got %+v", b)
	}
	return info
}

// mustManagedSession creates a CODE session and binds its fresh window to a
// managed worktree on the given branch — the draft-free equivalent of the
// former CreateManagedSession RPC (session created, tree provisioned or
// adopted, binding persisted, execution workspace retargeted). The returned
// info is reloaded from the store so it carries the managed binding.
func (f *FrontendAPI) mustManagedSession(t *testing.T, branch string, createBranch bool, startPoint string) *session.SessionInfo {
	t.Helper()
	info, err := f.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := f.bindSessionWorkspace(f.ctx(), info.ID, &SessionWorkspaceChoice{
		Branch:       branch,
		CreateBranch: createBranch,
		StartPoint:   startPoint,
	}); err != nil {
		t.Fatalf("bindSessionWorkspace(%q, create=%v, start=%q): %v", branch, createBranch, startPoint, err)
	}
	reloaded, err := f.store.LoadSession(f.ctx(), info.ID)
	if err != nil {
		t.Fatalf("reload bound session: %v", err)
	}
	return reloaded
}

func noManagedTrees(t *testing.T, repoRoot, what string) {
	t.Helper()
	trees, err := workspace.ListWorktrees(context.Background(), repoRoot)
	if err != nil {
		t.Fatalf("list worktrees: %v", err)
	}
	for _, tr := range trees {
		if tr.Kind == workspace.WorktreeManaged {
			t.Fatalf("%s provisioned a managed tree %q", what, tr.Path)
		}
	}
}

func TestBindSessionWorkspace_ProvisionsTreeAndRestoresIntoIt(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	fresh := newFreshLocalSession(t, h)

	if err := h.api.bindSessionWorkspace(context.Background(), fresh.ID, &SessionWorkspaceChoice{
		Branch:       "feature/bind",
		CreateBranch: true,
	}); err != nil {
		t.Fatalf("bindSessionWorkspace: %v", err)
	}

	// The binding was persisted inside the fresh window.
	binding := managedBindingOf(t, h.store, fresh.ID)
	if binding == nil || binding.Kind != session.WorkspaceManagedWorktree || binding.Branch != "feature/bind" {
		t.Fatalf("persisted binding mismatch: %+v", binding)
	}
	if binding.WorktreeName != managedTreeName(fresh.ID) {
		t.Fatalf("tree name %q != derived %q", binding.WorktreeName, managedTreeName(fresh.ID))
	}
	// The tree exists on the pinned branch, and the branch was created.
	if entry := treeEntry(t, h.project.WorkspacePath, binding.WorkspacePath); entry == nil || entry.Branch != "feature/bind" {
		t.Fatalf("managed tree missing or wrong identity: %+v", entry)
	}
	if !branchExists(t, h.repoRoot, "feature/bind") {
		t.Fatal("create-branch request did not create the branch")
	}
	// The eviction happened: the send's own session access lazily restores
	// an orchestrator built for the NEW workspace — execution retargets.
	if wp, ok := h.manager.GetSessionWorkspacePath(fresh.ID); !ok || wp != binding.WorkspacePath {
		t.Fatalf("runtime workspace %q (ok=%v) != tree path %q", wp, ok, binding.WorkspacePath)
	}
}

func TestBindSessionWorkspace_ExistingFreeBranchProvisions(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	fresh := newFreshLocalSession(t, h)
	wtGit(t, h.repoRoot, "branch", "feature/topic")

	if err := h.api.bindSessionWorkspace(context.Background(), fresh.ID, &SessionWorkspaceChoice{Branch: "feature/topic"}); err != nil {
		t.Fatalf("bindSessionWorkspace: %v", err)
	}
	binding := managedBindingOf(t, h.store, fresh.ID)
	if binding == nil || binding.Branch != "feature/topic" {
		t.Fatalf("persisted binding mismatch: %+v", binding)
	}
	if entry := treeEntry(t, h.project.WorkspacePath, binding.WorkspacePath); entry == nil || entry.Branch != "feature/topic" {
		t.Fatalf("tree not on feature/topic: %+v", entry)
	}
}

func TestBindSessionWorkspace_AdoptsSharedTree(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	wtGit(t, h.repoRoot, "branch", "feature/shared")
	holder := h.api.mustManagedSession(t, "feature/shared", false, "")
	fresh := newFreshLocalSession(t, h)

	if err := h.api.bindSessionWorkspace(context.Background(), fresh.ID, &SessionWorkspaceChoice{Branch: "feature/shared"}); err != nil {
		t.Fatalf("bindSessionWorkspace: %v", err)
	}
	binding := managedBindingOf(t, h.store, fresh.ID)
	if binding == nil || binding.WorktreeName != holder.WorkspaceBinding.WorktreeName {
		t.Fatalf("fresh session must adopt the holding tree %q, got %+v", holder.WorkspaceBinding.WorktreeName, binding)
	}
	if wp, ok := h.manager.GetSessionWorkspacePath(fresh.ID); !ok || wp != holder.WorkspaceBinding.WorkspacePath {
		t.Fatalf("runtime workspace %q (ok=%v) != shared tree %q", wp, ok, holder.WorkspaceBinding.WorkspacePath)
	}
	// Exactly one managed tree serves both sessions.
	trees, err := workspace.ListWorktrees(context.Background(), h.project.WorkspacePath)
	if err != nil {
		t.Fatalf("list worktrees: %v", err)
	}
	managed := 0
	for _, tr := range trees {
		if tr.Kind == workspace.WorktreeManaged {
			managed++
		}
	}
	if managed != 1 {
		t.Fatalf("managed trees = %d, want 1 (the shared holder)", managed)
	}
}

func TestBindSessionWorkspace_CheckoutHeldBranchIsNoOp(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	fresh := newFreshLocalSession(t, h)

	// main is held by the checkout: the choice lands as a no-op success —
	// the session already executes exactly there, its binding stays local.
	if err := h.api.bindSessionWorkspace(context.Background(), fresh.ID, &SessionWorkspaceChoice{Branch: "main"}); err != nil {
		t.Fatalf("bindSessionWorkspace on checkout-held branch: %v", err)
	}
	binding := managedBindingOf(t, h.store, fresh.ID)
	if binding == nil || binding.Kind != session.WorkspaceLocal {
		t.Fatalf("binding must stay local, got %+v", binding)
	}
	noManagedTrees(t, h.project.WorkspacePath, "checkout-held no-op")
}

func TestBindSessionWorkspace_RefusesExternalTreeHolder(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	fresh := newFreshLocalSession(t, h)
	wtGit(t, h.repoRoot, "branch", "feature/ext")
	external := filepath.Join(t.TempDir(), "external-tree")
	wtGit(t, h.repoRoot, "worktree", "add", external, "feature/ext")

	err := h.api.bindSessionWorkspace(context.Background(), fresh.ID, &SessionWorkspaceChoice{Branch: "feature/ext"})
	if err == nil {
		t.Fatal("expected refusal for an external worktree holding the branch")
	}
	if !errors.Is(err, workspace.ErrBranchBusy) || !strings.Contains(err.Error(), "external worktree") {
		t.Fatalf("refusal must be a typed branch-busy error naming the external tree: %v", err)
	}
	if binding := managedBindingOf(t, h.store, fresh.ID); binding == nil || binding.Kind != session.WorkspaceLocal {
		t.Fatalf("refused bind must leave the local binding, got %+v", binding)
	}
	noManagedTrees(t, h.project.WorkspacePath, "refused bind")
}

func TestBindSessionWorkspace_DWIMCreatesMissingBranchFromRemoteStartPoint(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	fresh := newFreshLocalSession(t, h)
	remoteSha := commitRemoteTip(t, h.repoRoot, "feature/topic")

	if err := h.api.bindSessionWorkspace(context.Background(), fresh.ID, &SessionWorkspaceChoice{
		Branch:       "feature/topic",
		CreateBranch: true,
		StartPoint:   "origin/feature/topic",
	}); err != nil {
		t.Fatalf("bindSessionWorkspace (remote-tracking pick): %v", err)
	}
	if !branchExists(t, h.repoRoot, "feature/topic") {
		t.Fatal("the local branch was not created from the remote-tracking start point")
	}
	binding := managedBindingOf(t, h.store, fresh.ID)
	entry := treeEntry(t, h.project.WorkspacePath, binding.WorkspacePath)
	if entry == nil || entry.Branch != "feature/topic" {
		t.Fatalf("managed tree missing or wrong identity: %+v", entry)
	}
	if got := wtGit(t, entry.Path, "rev-parse", "HEAD"); got != remoteSha {
		t.Fatalf("tree HEAD %q != remote-tracking tip %q", got, remoteSha)
	}
}

func TestBindSessionWorkspace_EmptyBranchRefused(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	fresh := newFreshLocalSession(t, h)

	err := h.api.bindSessionWorkspace(context.Background(), fresh.ID, &SessionWorkspaceChoice{})
	if err == nil || !strings.Contains(err.Error(), "a branch is required") {
		t.Fatalf("empty branch without create_branch must be refused, got: %v", err)
	}
	noManagedTrees(t, h.project.WorkspacePath, "refused empty-branch bind")
}

func TestBindSessionWorkspace_FreshWindowEnforcedByStore(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	fresh := newFreshLocalSession(t, h)
	// Close the fresh window behind the bind's back: a persisted message
	// makes the store's atomic guard refuse the write AFTER provisioning —
	// the typed error must surface and the fresh tree must be compensated
	// away (branches are never deleted, trees are).
	msg := session.ChatMessage{SessionID: fresh.ID, Role: "user", Content: "first"}
	if err := h.store.SaveMessage(context.Background(), msg); err != nil {
		t.Fatalf("save message: %v", err)
	}

	err := h.api.bindSessionWorkspace(context.Background(), fresh.ID, &SessionWorkspaceChoice{
		Branch:       "feature/late",
		CreateBranch: true,
	})
	if err == nil {
		t.Fatal("expected the fresh-window guard to refuse the binding")
	}
	if !errors.Is(err, session.ErrSessionNotFresh) {
		t.Fatalf("refusal must be the typed not-fresh error, got: %v", err)
	}
	if binding := managedBindingOf(t, h.store, fresh.ID); binding == nil || binding.Kind != session.WorkspaceLocal {
		t.Fatalf("refused bind must leave the local binding, got %+v", binding)
	}
	noManagedTrees(t, h.project.WorkspacePath, "compensated fresh-window refusal")
}

// The compensation path (a provisioned tree released after the binding write
// failed) is exercised by TestBindSessionWorkspace_FreshWindowEnforcedByStore:
// the store's atomic fresh-window guard refuses the write after provisioning,
// for real, without any injection seam.

func TestRollbackSessionBinding_RestoresPreviousBinding(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	fresh := newFreshLocalSession(t, h)
	prev := managedBindingOf(t, h.store, fresh.ID)

	bound := &session.WorkspaceBinding{
		Kind:         session.WorkspaceManagedWorktree,
		WorktreeName: managedTreeName(fresh.ID),
		Branch:       "feature/rollback",
	}
	if err := h.store.BindSessionWorkspace(context.Background(), fresh.ID, h.project.ID, bound); err != nil {
		t.Fatalf("seed the managed binding: %v", err)
	}
	h.api.rollbackSessionBinding(context.Background(), fresh.ID, h.project.ID, prev, bound.WorktreeName)

	restored := managedBindingOf(t, h.store, fresh.ID)
	if restored == nil || restored.Kind != session.WorkspaceLocal {
		t.Fatalf("rollback must restore the local binding, got %+v", restored)
	}
}
