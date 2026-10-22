package backend

// DeleteWorktree RPC tests: the Git-panel's worktree removal entry point.
// Everything runs against the REAL git binary through the production
// primitives (core/workspace → the RPC flow under test), mirroring the
// focus-model tests in frontend_api_git_focus_test.go and the lifecycle
// tests in frontend_api_worktrees_test.go.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/project"
	"github.com/v0lka/c0wrk/core/vectorindex"
	"github.com/v0lka/c0wrk/core/workspace"
	"github.com/v0lka/c0wrk/internal/gittest"
)

// deleteTestExternalTree adds one clean external linked tree outside the
// managed container and returns its path and branch.
func deleteTestExternalTree(t *testing.T, h *wtHarness) (ext, branch string) {
	t.Helper()
	branch = "ext-branch"
	ext = filepath.Join(gittest.TempDir(t), "ext-tree")
	wtGit(t, h.repoRoot, "worktree", "add", "-b", branch, ext)
	return ext, branch
}

func TestDeleteWorktree_NoActiveProject(t *testing.T) {
	f := &FrontendAPI{appCtx: context.Background}
	f.seedPublished.Store(true)
	f.seedPublished.Store(true)

	if err := f.DeleteWorktree(filepath.Join(t.TempDir(), "tree"), false, false); err == nil {
		t.Fatal("DeleteWorktree without an active project must fail")
	}
}

func TestDeleteWorktree_NoProjectMode(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	h.api.activeProjectMu.Lock()
	h.api.activeProjectID = project.NoProjectID
	h.api.activeProjectMu.Unlock()

	if err := h.api.DeleteWorktree(h.repoRoot, false, false); err == nil {
		t.Fatal("DeleteWorktree in No Project mode must fail")
	}
}

func TestDeleteWorktree_ForeignPathRefused(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	foreign := filepath.Join(gittest.TempDir(t), "not-a-worktree")
	if err := os.MkdirAll(foreign, 0o755); err != nil {
		t.Fatal(err)
	}

	err := h.api.DeleteWorktree(foreign, false, false)
	if !errors.Is(err, workspace.ErrWorktreeNotLinked) {
		t.Fatalf("foreign path error = %v, want ErrWorktreeNotLinked", err)
	}
	// The foreign directory is untouched.
	if _, statErr := os.Stat(foreign); statErr != nil {
		t.Fatalf("foreign directory must survive the refusal: %v", statErr)
	}
}

func TestDeleteWorktree_MainRefused(t *testing.T) {
	h := newWTHarness(t, wtFactory())

	err := h.api.DeleteWorktree(h.repoRoot, true, true)
	if !errors.Is(err, workspace.ErrWorktreeMain) {
		t.Fatalf("main refusal error = %v, want ErrWorktreeMain", err)
	}
	// The checkout survives even with both confirmations set.
	if _, statErr := os.Stat(filepath.Join(h.repoRoot, ".git")); statErr != nil {
		t.Fatalf("checkout must survive the main refusal: %v", statErr)
	}
}

func TestDeleteWorktree_CleanExternal(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	ext, branch := deleteTestExternalTree(t, h)

	if err := h.api.DeleteWorktree(ext, false, false); err != nil {
		t.Fatalf("DeleteWorktree(clean external): %v", err)
	}
	if entry := treeEntry(t, h.repoRoot, ext); entry != nil {
		t.Fatalf("external tree still listed after removal: %+v", entry)
	}
	if _, statErr := os.Stat(ext); !os.IsNotExist(statErr) {
		t.Fatalf("external tree directory still present (err=%v)", statErr)
	}
	// The branch is never deleted: branch lifetime belongs to git and the
	// user, never to worktree housekeeping.
	if !branchExists(t, h.repoRoot, branch) {
		t.Fatalf("branch %q must survive the tree removal", branch)
	}
}

func TestDeleteWorktree_CleanManaged(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	info := h.api.mustManagedSession(t, "", true, "")
	tree := info.WorkspaceBinding.WorkspacePath
	name := info.WorkspaceBinding.WorktreeName

	// The explicit user decision under test: a managed tree is removable
	// even though a session is bound to it — the session rows stay, the
	// tree under them is gone.
	if err := h.api.DeleteWorktree(tree, false, false); err != nil {
		t.Fatalf("DeleteWorktree(managed): %v", err)
	}
	if entry := treeEntry(t, h.repoRoot, tree); entry != nil {
		t.Fatalf("managed tree still listed after removal: %+v", entry)
	}
	if _, statErr := os.Stat(tree); !os.IsNotExist(statErr) {
		t.Fatalf("managed tree directory still present (err=%v)", statErr)
	}
	sessions, err := h.manager.ListSessionsByProject(h.project.ID)
	if err != nil {
		t.Fatalf("ListSessionsByProject: %v", err)
	}
	found := false
	for _, s := range sessions {
		if s.ID == info.ID {
			found = true
			if s.WorkspaceBinding == nil || s.WorkspaceBinding.WorktreeName != name {
				t.Fatalf("surviving session binding = %+v, want worktree %q", s.WorkspaceBinding, name)
			}
		}
	}
	if !found {
		t.Fatalf("bound session %q must survive the tree removal", info.ID)
	}
}

func TestDeleteWorktree_DirtyRequiresForce(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	ext, branch := deleteTestExternalTree(t, h)
	if err := os.WriteFile(filepath.Join(ext, "dirty.txt"), []byte("uncommitted"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Without the loss confirmation the removal is refused and the tree
	// stays exactly as it was.
	err := h.api.DeleteWorktree(ext, false, false)
	if !errors.Is(err, workspace.ErrWorktreeDirty) {
		t.Fatalf("dirty removal without force = %v, want ErrWorktreeDirty", err)
	}
	if entry := treeEntry(t, h.repoRoot, ext); entry == nil {
		t.Fatal("dirty tree must stay listed after the refused removal")
	}
	if !branchExists(t, h.repoRoot, branch) {
		t.Fatalf("branch %q must survive the refused removal", branch)
	}

	// With the confirmation the removal succeeds.
	if err := h.api.DeleteWorktree(ext, true, false); err != nil {
		t.Fatalf("DeleteWorktree(dirty, force): %v", err)
	}
	if entry := treeEntry(t, h.repoRoot, ext); entry != nil {
		t.Fatalf("dirty tree still listed after forced removal: %+v", entry)
	}
	if !branchExists(t, h.repoRoot, branch) {
		t.Fatalf("branch %q must survive the forced removal", branch)
	}
}

func TestDeleteWorktree_LockedRequiresUnlock(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	ext, _ := deleteTestExternalTree(t, h)
	wtGit(t, h.repoRoot, "worktree", "lock", ext)

	// Without the unlock decision the removal is refused and the lock
	// stays in place.
	err := h.api.DeleteWorktree(ext, false, false)
	if !errors.Is(err, workspace.ErrWorktreeLocked) {
		t.Fatalf("locked removal without unlock = %v, want ErrWorktreeLocked", err)
	}
	if entry := treeEntry(t, h.repoRoot, ext); entry == nil || !entry.Locked {
		t.Fatalf("locked tree must stay listed and locked after the refused removal: %+v", entry)
	}

	// With the unlock decision the removal succeeds.
	if err := h.api.DeleteWorktree(ext, false, true); err != nil {
		t.Fatalf("DeleteWorktree(locked, unlock): %v", err)
	}
	if entry := treeEntry(t, h.repoRoot, ext); entry != nil {
		t.Fatalf("locked tree still listed after removal: %+v", entry)
	}
}

// TestDeleteWorktree_EmitsStatusChangedAndRollsFocusBack pins the emit
// contract: git:status_changed goes to the project CHECKOUT (not the
// deleted tree), and a focus pointing at the deleted tree rolls back to
// the checkout through resolveGitFocusRoot's stale-focus fallback.
func TestDeleteWorktree_EmitsStatusChangedAndRollsFocusBack(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	ext, _ := deleteTestExternalTree(t, h)
	if err := h.api.SetGitPanelFocus(ext); err != nil {
		t.Fatalf("SetGitPanelFocus(ext): %v", err)
	}

	var emitted string
	h.api.emitEvent = func(name string, args ...any) {
		if name == EventGitStatusChanged && len(args) >= 1 {
			if p, ok := args[0].(string); ok {
				emitted = p
			}
		}
	}

	if err := h.api.DeleteWorktree(ext, false, false); err != nil {
		t.Fatalf("DeleteWorktree(focused external): %v", err)
	}
	if emitted != h.project.WorkspacePath {
		t.Fatalf("git:status_changed payload = %q, want the project checkout %q", emitted, h.project.WorkspacePath)
	}
	root, err := h.api.resolveGitRepoRoot()
	if err != nil {
		t.Fatalf("resolveGitRepoRoot after deletion: %v", err)
	}
	if root != h.project.WorkspacePath {
		t.Fatalf("focus after deletion = %q, want the checkout", root)
	}
	if got := h.api.gitFocusPathSnapshot(); got != "" {
		t.Fatalf("stale focus must be cleared after deletion, still %q", got)
	}
}

// TestDeleteWorktree_ReleasesExternalVectorRoot pins the cleanup contract
// for an external tree that had picked up a live vector manager (it was
// the panel's focus): the registry root is released with the tree, so no
// manager survives pointing into a removed directory.
func TestDeleteWorktree_ReleasesExternalVectorRoot(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	ext, _ := deleteTestExternalTree(t, h)

	mgr, err := vectorindex.NewManager(vectorindex.ManagerConfig{
		EmbeddingFunc: func(ctx context.Context, text string) ([]float32, error) {
			return make([]float32, 4), nil
		},
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() { mgr.Shutdown() })
	vr := h.api.vectorRootsRegistry()
	vr.mu.Lock()
	vr.roots[canonicalRoot(ext)] = &vectorRootEntry{mgr: mgr, projectID: h.project.ID, lastUsed: time.Now()}
	vr.mu.Unlock()

	if err := h.api.DeleteWorktree(ext, false, false); err != nil {
		t.Fatalf("DeleteWorktree(external with live vector root): %v", err)
	}
	if got := vr.liveRootsForTest(); got != 0 {
		t.Fatalf("vector registry holds %d live roots after the tree removal, want 0", got)
	}
}
