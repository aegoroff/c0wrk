package backend

// Background stale-branch index cleanup (see frontend_api_vector_prune.go):
// the tests exercise the synchronous sweep directly — the SwitchProject hook
// is a detached `go` call whose failures are Debug-silent by contract, so the
// assertions here are deterministic artifact checks against real git fixtures
// from the shared vectorWorktreeHarness.

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/backend/project"
)

// pruneFixtureBranch writes a complete per-branch artifact set (both indexes
// — the chromem branch root and the bleve lexical directory — plus the
// sidecar pair) under the storage root.
func pruneFixtureBranch(t *testing.T, root, collection, lexicalDir string) {
	t.Helper()
	for _, dir := range []string{
		filepath.Join(root, "branches", collection),
		filepath.Join(root, "lexical", lexicalDir),
	} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	for _, file := range []string{
		filepath.Join(root, "file_hashes_"+collection+".json"),
		filepath.Join(root, "contentless_"+collection+".done"),
	} {
		if err := os.WriteFile(file, []byte("{}"), 0o644); err != nil {
			t.Fatalf("write %s: %v", file, err)
		}
	}
}

func pruneAssertExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected %s to exist: %v", path, err)
	}
}

func pruneAssertGone(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be gone, stat err = %v", path, err)
	}
}

// TestPruneAbsentBranchIndexes_RemovesStaleBranchData pins the checkout sweep:
// a branch absent from the local clone (the fixture repo has only main) loses
// BOTH indexes and its sidecar pair, while main's artifacts survive.
func TestPruneAbsentBranchIndexes_RemovesStaleBranchData(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)

	pruneFixtureBranch(t, viRoot, "branch_main", "main")
	pruneFixtureBranch(t, viRoot, "branch_gone", "gone")

	h.api.pruneAbsentBranchVectorIndexes(h.proj)

	pruneAssertGone(t, filepath.Join(viRoot, "branches", "branch_gone"))
	pruneAssertGone(t, filepath.Join(viRoot, "lexical", "gone"))
	pruneAssertGone(t, filepath.Join(viRoot, "file_hashes_branch_gone.json"))
	pruneAssertGone(t, filepath.Join(viRoot, "contentless_branch_gone.done"))

	pruneAssertExists(t, filepath.Join(viRoot, "branches", "branch_main"))
	pruneAssertExists(t, filepath.Join(viRoot, "lexical", "main"))
	pruneAssertExists(t, filepath.Join(viRoot, "file_hashes_branch_main.json"))
	pruneAssertExists(t, filepath.Join(viRoot, "contentless_branch_main.done"))
}

// TestPruneAbsentBranchIndexes_CoversWorktreeStorages pins the worktree leg of
// the sweep: a real managed tree's storage keeps its own (still existing)
// branch's artifacts and loses the ones of a branch absent from the clone —
// the same repo-wide refs/heads keep-set applies inside every tree storage.
func TestPruneAbsentBranchIndexes_CoversWorktreeStorages(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	h.addManagedWorktree(t, "tree-a", "feature/topic")
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)
	wtRoot := filepath.Join(viRoot, "worktrees", "tree-a")

	pruneFixtureBranch(t, wtRoot, "branch_feature_topic", "feature_topic")
	pruneFixtureBranch(t, wtRoot, "branch_retracted", "retracted")

	h.api.pruneAbsentBranchVectorIndexes(h.proj)

	pruneAssertExists(t, filepath.Join(wtRoot, "branches", "branch_feature_topic"))
	pruneAssertExists(t, filepath.Join(wtRoot, "lexical", "feature_topic"))
	pruneAssertExists(t, filepath.Join(wtRoot, "file_hashes_branch_feature_topic.json"))

	pruneAssertGone(t, filepath.Join(wtRoot, "branches", "branch_retracted"))
	pruneAssertGone(t, filepath.Join(wtRoot, "lexical", "retracted"))
	pruneAssertGone(t, filepath.Join(wtRoot, "file_hashes_branch_retracted.json"))
	pruneAssertGone(t, filepath.Join(wtRoot, "contentless_branch_retracted.done"))
}

// TestPruneAbsentBranchIndexes_SkipsNoProjectAndForeignWorkspace pins the
// guards: No Project never touches anything, and a workspace that is not a
// git repository (the branch listing fails) leaves the storage untouched.
func TestPruneAbsentBranchIndexes_SkipsNoProjectAndForeignWorkspace(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)
	stale := filepath.Join(viRoot, "branches", "branch_gone")
	pruneFixtureBranch(t, viRoot, "branch_gone", "gone")

	h.api.pruneAbsentBranchVectorIndexes(&project.ProjectInfo{
		ID:            h.proj.ID,
		WorkspacePath: h.proj.WorkspacePath,
		IsNoProject:   true,
	})
	pruneAssertExists(t, stale)

	// A non-git workspace cannot list branches: the sweep skips silently.
	h.api.pruneAbsentBranchVectorIndexes(&project.ProjectInfo{
		ID:            h.proj.ID,
		WorkspacePath: t.TempDir(),
	})
	pruneAssertExists(t, stale)
}

// TestPruneAbsentBranchIndexes_SingleFlightSkip pins the in-flight guard: a
// sweep skipped by the guard touches nothing; releasing the guard lets the
// next sweep run.
func TestPruneAbsentBranchIndexes_SingleFlightSkip(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)
	stale := filepath.Join(viRoot, "branches", "branch_gone")
	pruneFixtureBranch(t, viRoot, "branch_gone", "gone")

	h.api.pruneStaleBranchesInFlight.Store(true)
	h.api.pruneAbsentBranchVectorIndexes(h.proj)
	pruneAssertExists(t, stale)

	h.api.pruneStaleBranchesInFlight.Store(false)
	h.api.pruneAbsentBranchVectorIndexes(h.proj)
	pruneAssertGone(t, stale)
}

// TestPurgeBranchIndexData_RemovesDeletedBranchAcrossStorages pins the
// delete-triggered purge: a branch deleted through the Git panel loses BOTH
// indexes and its sidecar pair in the checkout's storage root AND in every
// managed worktree's storage root, while surviving branches keep theirs. The
// sync helper runs directly — the DeleteBranch hook is a detached `go` call
// covered separately with a bounded watchdog.
func TestPurgeBranchIndexData_RemovesDeletedBranchAcrossStorages(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	h.addManagedWorktree(t, "tree-a", "feature/topic")
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)
	wtRoot := filepath.Join(viRoot, "worktrees", "tree-a")

	pruneFixtureBranch(t, viRoot, "branch_retracted", "retracted")
	pruneFixtureBranch(t, viRoot, "branch_main", "main")
	pruneFixtureBranch(t, wtRoot, "branch_retracted", "retracted")
	pruneFixtureBranch(t, wtRoot, "branch_main", "main")

	h.api.purgeBranchIndexData(h.proj, "retracted")

	for _, root := range []string{viRoot, wtRoot} {
		pruneAssertGone(t, filepath.Join(root, "branches", "branch_retracted"))
		pruneAssertGone(t, filepath.Join(root, "lexical", "retracted"))
		pruneAssertGone(t, filepath.Join(root, "file_hashes_branch_retracted.json"))
		pruneAssertGone(t, filepath.Join(root, "contentless_branch_retracted.done"))

		pruneAssertExists(t, filepath.Join(root, "branches", "branch_main"))
		pruneAssertExists(t, filepath.Join(root, "lexical", "main"))
		pruneAssertExists(t, filepath.Join(root, "file_hashes_branch_main.json"))
		pruneAssertExists(t, filepath.Join(root, "contentless_branch_main.done"))
	}
}

// TestPurgeBranchIndexData_CollisionKeepsSharedArtifacts pins the backend's
// collision leg: the purge feeds DeleteBranchData the REAL surviving-branch
// list, so deleting "feature/foo" while "feature_foo" survives (same
// sanitized identity) keeps the shared artifacts on disk.
func TestPurgeBranchIndexData_CollisionKeepsSharedArtifacts(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	h.repo.Git(t, "branch", "feature_foo")
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)
	pruneFixtureBranch(t, viRoot, "branch_feature_foo", "feature_foo")

	h.api.purgeBranchIndexData(h.proj, "feature/foo")

	pruneAssertExists(t, filepath.Join(viRoot, "branches", "branch_feature_foo"))
	pruneAssertExists(t, filepath.Join(viRoot, "lexical", "feature_foo"))
	pruneAssertExists(t, filepath.Join(viRoot, "file_hashes_branch_feature_foo.json"))
	pruneAssertExists(t, filepath.Join(viRoot, "contentless_branch_feature_foo.done"))
}

// TestDeleteBranch_PurgesDeletedBranchIndexData pins the RPC hook end to end:
// DeleteBranch deletes the git branch and the purge erases the branch's
// stored artifacts from both storage roots. The hook is async by contract;
// the purgeBranchLaunchFn seam runs it synchronously here, so the outcome is
// observable deterministically — no timing-based waiting.
func TestDeleteBranch_PurgesDeletedBranchIndexData(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	h.addManagedWorktree(t, "tree-b", "feature/topic")
	h.repo.Git(t, "branch", "feature/gone")
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)
	wtRoot := filepath.Join(viRoot, "worktrees", "tree-b")

	pruneFixtureBranch(t, viRoot, "branch_feature_gone", "feature_gone")
	pruneFixtureBranch(t, viRoot, "branch_main", "main")
	pruneFixtureBranch(t, wtRoot, "branch_feature_gone", "feature_gone")
	pruneFixtureBranch(t, wtRoot, "branch_main", "main")

	// Deterministic seam: production launches the purge detached (`go`);
	// the test runs it inline so it has landed by the time DeleteBranch
	// returns.
	h.api.purgeBranchLaunchFn = func(fn func()) { fn() }

	if err := h.api.DeleteBranch("feature/gone", false); err != nil {
		t.Fatalf("DeleteBranch: %v", err)
	}

	gone := []string{
		filepath.Join(viRoot, "branches", "branch_feature_gone"),
		filepath.Join(wtRoot, "branches", "branch_feature_gone"),
	}
	for _, path := range gone {
		pruneAssertGone(t, path)
	}

	for _, root := range []string{viRoot, wtRoot} {
		pruneAssertGone(t, filepath.Join(root, "lexical", "feature_gone"))
		pruneAssertGone(t, filepath.Join(root, "file_hashes_branch_feature_gone.json"))
		pruneAssertGone(t, filepath.Join(root, "contentless_branch_feature_gone.done"))
		pruneAssertExists(t, filepath.Join(root, "branches", "branch_main"))
		pruneAssertExists(t, filepath.Join(root, "file_hashes_branch_main.json"))
	}
}

// TestDeleteWorktree_WipesManagedTreeIndexStorage pins the worktree half of
// the Git-panel cleanup: removing a managed tree through DeleteWorktree drops
// the tree's whole worktree-scoped index storage — BOTH indexes and the
// sidecars of every branch it ever indexed — synchronously with the RPC,
// while the checkout's own storage stays untouched.
func TestDeleteWorktree_WipesManagedTreeIndexStorage(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	tree := h.addManagedWorktree(t, "tree-w", "feature/wipe")
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)
	wtRoot := filepath.Join(viRoot, "worktrees", "tree-w")

	pruneFixtureBranch(t, wtRoot, "branch_feature_wipe", "feature_wipe")
	pruneFixtureBranch(t, wtRoot, "branch_main", "main")
	pruneFixtureBranch(t, viRoot, "branch_main", "main")

	if err := h.api.DeleteWorktree(tree, false, false); err != nil {
		t.Fatalf("DeleteWorktree(managed): %v", err)
	}

	if _, err := os.Stat(wtRoot); !os.IsNotExist(err) {
		t.Fatalf("deleted tree's index storage still present (err=%v)", err)
	}
	// The checkout keeps its own data — only the tree's root goes.
	pruneAssertExists(t, filepath.Join(viRoot, "branches", "branch_main"))
	pruneAssertExists(t, filepath.Join(viRoot, "lexical", "main"))
}

// TestPruneAbsentBranchIndexes_RunsWhileDisabled pins the disabled-period
// fix: with the registry parked by the master switch (every manager shut
// down, factory dropped — ManagerForCleanup reports nothing), the sweep is
// NOT blocked for the whole disabled period. It runs the manager-free FS
// forms instead, removing absent branches' artifacts across the checkout AND
// managed-tree storage roots while surviving branches keep theirs.
func TestPruneAbsentBranchIndexes_RunsWhileDisabled(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	h.addManagedWorktree(t, "tree-d", "feature/topic")
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)
	wtRoot := filepath.Join(viRoot, "worktrees", "tree-d")

	pruneFixtureBranch(t, viRoot, "branch_main", "main")
	pruneFixtureBranch(t, viRoot, "branch_gone", "gone")
	pruneFixtureBranch(t, wtRoot, "branch_feature_topic", "feature_topic")
	pruneFixtureBranch(t, wtRoot, "branch_gone", "gone")

	h.roots.Disable()

	h.api.pruneAbsentBranchVectorIndexes(h.proj)

	for _, root := range []string{viRoot, wtRoot} {
		pruneAssertGone(t, filepath.Join(root, "branches", "branch_gone"))
		pruneAssertGone(t, filepath.Join(root, "lexical", "gone"))
		pruneAssertGone(t, filepath.Join(root, "file_hashes_branch_gone.json"))
		pruneAssertGone(t, filepath.Join(root, "contentless_branch_gone.done"))
	}
	pruneAssertExists(t, filepath.Join(viRoot, "branches", "branch_main"))
	pruneAssertExists(t, filepath.Join(viRoot, "lexical", "main"))
	pruneAssertExists(t, filepath.Join(wtRoot, "branches", "branch_feature_topic"))
	pruneAssertExists(t, filepath.Join(wtRoot, "lexical", "feature_topic"))
}

// TestPurgeBranchIndexData_RunsWhileDisabled pins the delete-triggered purge
// under the disabled registry: the branch's artifacts are purged immediately
// through the manager-free FS form in both storage roots, surviving branches
// keep theirs.
func TestPurgeBranchIndexData_RunsWhileDisabled(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	h.addManagedWorktree(t, "tree-p", "feature/topic")
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)
	wtRoot := filepath.Join(viRoot, "worktrees", "tree-p")

	pruneFixtureBranch(t, viRoot, "branch_retracted", "retracted")
	pruneFixtureBranch(t, viRoot, "branch_main", "main")
	pruneFixtureBranch(t, wtRoot, "branch_retracted", "retracted")
	pruneFixtureBranch(t, wtRoot, "branch_main", "main")

	h.roots.Disable()

	h.api.purgeBranchIndexData(h.proj, "retracted")

	for _, root := range []string{viRoot, wtRoot} {
		pruneAssertGone(t, filepath.Join(root, "branches", "branch_retracted"))
		pruneAssertGone(t, filepath.Join(root, "lexical", "retracted"))
		pruneAssertGone(t, filepath.Join(root, "file_hashes_branch_retracted.json"))
		pruneAssertGone(t, filepath.Join(root, "contentless_branch_retracted.done"))

		pruneAssertExists(t, filepath.Join(root, "branches", "branch_main"))
		pruneAssertExists(t, filepath.Join(root, "file_hashes_branch_main.json"))
	}
}

// TestDeleteWorktree_WipesManagedTreeIndexStorageWhileDisabled pins the
// worktree half under the disabled registry: deleting a managed tree while
// indexing is off still removes the tree's whole index storage (the plain fs
// fallback — no manager is needed, and no live or parked state holds
// handles), so a disabled period cannot strand deleted trees' storage until
// the whole project is deleted.
func TestDeleteWorktree_WipesManagedTreeIndexStorageWhileDisabled(t *testing.T) {
	h := newVectorWorktreeHarness(t)
	tree := h.addManagedWorktree(t, "tree-off", "feature/off")
	viRoot := config.ProjectVectorIndexPath(h.agentDir, h.proj.ID)
	wtRoot := filepath.Join(viRoot, "worktrees", "tree-off")

	pruneFixtureBranch(t, wtRoot, "branch_feature_off", "feature_off")
	pruneFixtureBranch(t, viRoot, "branch_main", "main")

	h.roots.Disable()

	if err := h.api.DeleteWorktree(tree, false, false); err != nil {
		t.Fatalf("DeleteWorktree(managed, disabled): %v", err)
	}

	if _, err := os.Stat(wtRoot); !os.IsNotExist(err) {
		t.Fatalf("deleted tree's index storage still present while disabled (err=%v)", err)
	}
	// The checkout keeps its own data — only the tree's root goes.
	pruneAssertExists(t, filepath.Join(viRoot, "branches", "branch_main"))
}
