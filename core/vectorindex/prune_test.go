package vectorindex

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

// newPruneTestService builds a discard-embedder service for the prune tests
// and registers its Close on cleanup (before the TempDir removal — t.Cleanup
// is LIFO — so the lexical bolt/zap handles are released before the unlink,
// which Windows requires). Call it only AFTER every t.TempDir() of the test
// has been created; creating TempDirs afterwards puts the removal ahead of
// Close in the LIFO cleanup chain.
func newPruneTestService(t *testing.T, parkCapacity int) *Service {
	t.Helper()
	svc, err := NewService(ServiceConfig{EmbeddingFunc: fakeEmbeddingFunc(), ParkCapacity: parkCapacity})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })
	return svc
}

// pruneMkdir creates dir (with parents) and fails the test on error.
func pruneMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
}

// pruneWrite writes content to path (creating parents) and fails the test on error.
func pruneWrite(t *testing.T, path, content string) {
	t.Helper()
	pruneMkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// pruneMustExist / pruneMustNotExist assert on-disk presence.
func pruneMustExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected %s to exist: %v", path, err)
	}
}

func pruneMustNotExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be gone, stat err = %v", path, err)
	}
}

// TestPruneMissingBranchData_RemovesAbsentBranchArtifacts pins the full
// artifact sweep for a pruned branch — BOTH indexes (the chromem branch root
// and the bleve lexical directory) plus the sidecar pair — while every kept
// identity survives: existing branches, the synthetic default, the orphan
// root, the embedding cache, and non-sidecar files at the storage root.
func TestPruneMissingBranchData_RemovesAbsentBranchArtifacts(t *testing.T) {
	svc := newPruneTestService(t, 0)
	root := filepath.Join(t.TempDir(), "vi")

	// Kept: main + feature/x (sanitizes to feature_x), the synthetic
	// default pair, the orphan root, the cache, and shapeless files.
	pruneMkdir(t, filepath.Join(root, "branches", "branch_main"))
	pruneWrite(t, filepath.Join(root, "branches", "branch_main", "abc12345", "doc.gob"), "x")
	pruneMkdir(t, filepath.Join(root, "branches", "branch_feature_x"))
	pruneWrite(t, filepath.Join(root, "file_hashes_branch_main.json"), "{}")
	pruneWrite(t, filepath.Join(root, "contentless_branch_main.done"), "")
	pruneWrite(t, filepath.Join(root, "file_hashes_branch_feature_x.json"), "{}")
	pruneMkdir(t, filepath.Join(root, "lexical", "main"))
	pruneMkdir(t, filepath.Join(root, "lexical", "feature_x"))
	pruneMkdir(t, filepath.Join(root, "branches", "_orphan"))
	pruneWrite(t, filepath.Join(root, "branches", "_orphan", "junk"), "x")
	pruneMkdir(t, filepath.Join(root, "lexical", "default"))
	pruneWrite(t, filepath.Join(root, "file_hashes_branch_default.json"), "{}")
	pruneWrite(t, filepath.Join(root, "contentless_branch_default.done"), "")
	pruneWrite(t, filepath.Join(root, "embedding_cache", "chunk.bin"), "x")
	pruneWrite(t, filepath.Join(root, "garbage.txt"), "not a sidecar")

	// Stale: branch "old" — both indexes, sidecar and marker. Plus names
	// that only LOOK like sidecars but are not (wrong identity shape, wrong
	// suffix) and must survive.
	pruneMkdir(t, filepath.Join(root, "branches", "branch_old"))
	pruneWrite(t, filepath.Join(root, "branches", "branch_old", "deadbeef", "doc.gob"), "x")
	pruneMkdir(t, filepath.Join(root, "lexical", "old"))
	pruneWrite(t, filepath.Join(root, "file_hashes_branch_old.json"), "{}")
	pruneWrite(t, filepath.Join(root, "contentless_branch_old.done"), "")
	pruneWrite(t, filepath.Join(root, "file_hashes_notbranch.json"), "{}")
	pruneWrite(t, filepath.Join(root, "file_hashes_branch_old.json.bak"), "{}")

	// Only the repository's surviving local branches are kept.
	removed := svc.PruneMissingBranchData(root, []string{"main", "feature/x"})
	if removed != 4 {
		t.Fatalf("removed = %d, want 4 (branch root + lexical dir + sidecar + marker)", removed)
	}
	pruneMustNotExist(t, filepath.Join(root, "branches", "branch_old"))
	pruneMustNotExist(t, filepath.Join(root, "lexical", "old"))
	pruneMustNotExist(t, filepath.Join(root, "file_hashes_branch_old.json"))
	pruneMustNotExist(t, filepath.Join(root, "contentless_branch_old.done"))

	pruneMustExist(t, filepath.Join(root, "branches", "branch_main", "abc12345", "doc.gob"))
	pruneMustExist(t, filepath.Join(root, "branches", "branch_feature_x"))
	pruneMustExist(t, filepath.Join(root, "file_hashes_branch_main.json"))
	pruneMustExist(t, filepath.Join(root, "contentless_branch_main.done"))
	pruneMustExist(t, filepath.Join(root, "file_hashes_branch_feature_x.json"))
	pruneMustExist(t, filepath.Join(root, "lexical", "main"))
	pruneMustExist(t, filepath.Join(root, "lexical", "feature_x"))
	pruneMustExist(t, filepath.Join(root, "branches", "_orphan", "junk"))
	pruneMustExist(t, filepath.Join(root, "lexical", "default"))
	pruneMustExist(t, filepath.Join(root, "file_hashes_branch_default.json"))
	pruneMustExist(t, filepath.Join(root, "contentless_branch_default.done"))
	pruneMustExist(t, filepath.Join(root, "embedding_cache", "chunk.bin"))
	pruneMustExist(t, filepath.Join(root, "garbage.txt"))
	pruneMustExist(t, filepath.Join(root, "file_hashes_notbranch.json"))
	pruneMustExist(t, filepath.Join(root, "file_hashes_branch_old.json.bak"))
}

// TestPruneMissingBranchData_KeepsCollidingExistingBranch pins the lossy-name
// rule: a stored directory is removed only when NO existing branch maps to
// its sanitized identity. branch_feature_foo may have been written for the
// now-deleted "feature/foo", but the surviving branch "feature_foo" sanitizes
// to the same identity, so the directory stays.
func TestPruneMissingBranchData_KeepsCollidingExistingBranch(t *testing.T) {
	svc := newPruneTestService(t, 0)
	root := filepath.Join(t.TempDir(), "vi")
	pruneMkdir(t, filepath.Join(root, "branches", "branch_feature_foo"))
	pruneWrite(t, filepath.Join(root, "file_hashes_branch_feature_foo.json"), "{}")
	pruneMkdir(t, filepath.Join(root, "lexical", "feature_foo"))

	removed := svc.PruneMissingBranchData(root, []string{"feature_foo"})
	if removed != 0 {
		t.Fatalf("removed = %d, want 0 (colliding identity must be kept)", removed)
	}
	pruneMustExist(t, filepath.Join(root, "branches", "branch_feature_foo"))
	pruneMustExist(t, filepath.Join(root, "file_hashes_branch_feature_foo.json"))
	pruneMustExist(t, filepath.Join(root, "lexical", "feature_foo"))
}

// TestPruneMissingBranchData_MissingStorageRootIsNoOp pins the fail-soft
// contract: a never-indexed project (no storage root) prunes nothing and
// creates nothing.
func TestPruneMissingBranchData_MissingStorageRootIsNoOp(t *testing.T) {
	svc := newPruneTestService(t, 0)
	root := filepath.Join(t.TempDir(), "missing", "vi")

	if removed := svc.PruneMissingBranchData(root, []string{"main"}); removed != 0 {
		t.Fatalf("removed = %d, want 0 for a missing storage root", removed)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("prune must not create the storage root, stat err = %v", err)
	}
}

// TestPruneMissingBranchData_DropsStaleParkedState pins the live-service
// interaction: a parked state whose branch is being pruned leaves the park
// LRU (so a later return to the project never revives a state whose
// directories were just removed), and its on-disk artifacts are removed. The
// current project's own branch — which the caller's keep list omits — is
// protected defensively.
func TestPruneMissingBranchData_DropsStaleParkedState(t *testing.T) {
	dirA := filepath.Join(t.TempDir(), "A")
	dirB := filepath.Join(t.TempDir(), "B")
	svc := newPruneTestService(t, 2)

	// Open A on branch "gone": both its index directories are created.
	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("SetProject A: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "gone"); err != nil {
		t.Fatalf("SwitchBranch A: %v", err)
	}
	pruneMustExist(t, filepath.Join(dirA, "branches", "branch_gone"))
	pruneMustExist(t, filepath.Join(dirA, "lexical", "gone"))

	// Park A by switching to B on "main" (which A's keep list will name).
	if err := svc.SetProject("B", dirB); err != nil {
		t.Fatalf("SetProject B: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch B: %v", err)
	}
	if len(svc.parked) != 1 || svc.parked[0].projectID != "A" {
		t.Fatalf("parked = %d entries, want [A]", len(svc.parked))
	}

	removed := svc.PruneMissingBranchData(dirA, []string{"main"})
	if removed == 0 {
		t.Fatal("prune removed nothing for a fully stale project")
	}
	pruneMustNotExist(t, filepath.Join(dirA, "branches", "branch_gone"))
	pruneMustNotExist(t, filepath.Join(dirA, "lexical", "gone"))
	if len(svc.parked) != 0 {
		t.Fatalf("stale parked state survived the prune: %d entries", len(svc.parked))
	}

	// A later return to A must restore nothing stale: the park is empty, so
	// SetProject opens a fresh state instead of reviving one whose
	// directories were just removed.
	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("re-open A: %v", err)
	}

	// Active-branch protection: A is current on a branch the keep list
	// omits — its artifacts must survive the sweep of stale names.
	if err := svc.SwitchBranch(context.Background(), "phantom"); err != nil {
		t.Fatalf("SwitchBranch A phantom: %v", err)
	}
	pruneMkdir(t, filepath.Join(dirA, "branches", "branch_stale"))
	svc.PruneMissingBranchData(dirA, []string{"main"})
	pruneMustExist(t, filepath.Join(dirA, "branches", "branch_phantom"))
	pruneMustExist(t, filepath.Join(dirA, "lexical", "phantom"))
	pruneMustNotExist(t, filepath.Join(dirA, "branches", "branch_stale"))
}

// TestDeleteBranchData_RemovesBothIndexesAndSidecars pins the targeted purge:
// deleting a branch through the Git panel removes exactly that branch's four
// artifacts (the chromem branch root, the bleve lexical directory, the
// file-hash sidecar, the content-less marker) and nothing else. A stale
// caller-side list that still names the deleted branch is filtered out — the
// purge must not silently no-op.
func TestDeleteBranchData_RemovesBothIndexesAndSidecars(t *testing.T) {
	svc := newPruneTestService(t, 0)
	root := filepath.Join(t.TempDir(), "vi")
	fixtureBranchArtifacts(t, root, "feature/x")
	fixtureBranchArtifacts(t, root, "main")

	removed := svc.DeleteBranchData(root, "feature/x", []string{"main", "feature/x"})
	if removed != 4 {
		t.Fatalf("removed = %d, want 4", removed)
	}
	pruneMustNotExist(t, filepath.Join(root, "branches", "branch_feature_x"))
	pruneMustNotExist(t, filepath.Join(root, "lexical", "feature_x"))
	pruneMustNotExist(t, filepath.Join(root, "file_hashes_branch_feature_x.json"))
	pruneMustNotExist(t, filepath.Join(root, "contentless_branch_feature_x.done"))

	// The surviving branch keeps its full artifact set.
	pruneMustExist(t, filepath.Join(root, "branches", "branch_main"))
	pruneMustExist(t, filepath.Join(root, "lexical", "main"))
	pruneMustExist(t, filepath.Join(root, "file_hashes_branch_main.json"))
	pruneMustExist(t, filepath.Join(root, "contentless_branch_main.done"))

	// Idempotent: a second purge finds nothing on disk and counts nothing.
	if again := svc.DeleteBranchData(root, "feature/x", []string{"main"}); again != 0 {
		t.Fatalf("second purge removed = %d, want 0", again)
	}
}

// TestDeleteBranchData_CollisionKeepsSharedIdentities pins the lossy-name rule
// for the targeted purge: "feature/foo" was deleted, but the surviving
// "feature_foo" sanitizes to the same collection and lexical identities, so
// every artifact of the shared identity stays on disk.
func TestDeleteBranchData_CollisionKeepsSharedIdentities(t *testing.T) {
	svc := newPruneTestService(t, 0)
	root := filepath.Join(t.TempDir(), "vi")
	fixtureBranchArtifacts(t, root, "feature/foo")

	if removed := svc.DeleteBranchData(root, "feature/foo", []string{"feature_foo"}); removed != 0 {
		t.Fatalf("removed = %d, want 0 for a colliding surviving branch", removed)
	}
	pruneMustExist(t, filepath.Join(root, "branches", "branch_feature_foo"))
	pruneMustExist(t, filepath.Join(root, "lexical", "feature_foo"))
	pruneMustExist(t, filepath.Join(root, "file_hashes_branch_feature_foo.json"))
	pruneMustExist(t, filepath.Join(root, "contentless_branch_feature_foo.done"))
}

// TestDeleteBranchData_ProtectedIdentitiesAndActiveBranch pins the guards: a
// real branch named "default" is indistinguishable from the synthetic
// DefaultBranch identity and is never purged, an empty or missing storage root
// is a silent no-op that creates nothing, and the branch of the live state
// rooted at the target survives even when the caller names it.
func TestDeleteBranchData_ProtectedIdentitiesAndActiveBranch(t *testing.T) {
	// All TempDirs are created BEFORE the service: t.Cleanup is LIFO, so a
	// service created first would close only after the TempDirs are removed,
	// and Windows cannot unlink the still-open bolt/zap handles (the
	// ordering contract newPruneTestService documents).
	root := filepath.Join(t.TempDir(), "vi")
	missing := filepath.Join(t.TempDir(), "missing")
	dirA := filepath.Join(t.TempDir(), "A")
	svc := newPruneTestService(t, 0)

	// Synthetic default: the branch "default" maps onto the synthetic
	// DefaultBranch identities, so its artifacts are untouchable.
	fixtureBranchArtifacts(t, root, "default")
	if removed := svc.DeleteBranchData(root, "default", nil); removed != 0 {
		t.Fatalf("removed = %d, want 0 for the synthetic default identity", removed)
	}
	pruneMustExist(t, filepath.Join(root, "branches", defaultSyntheticCollectionName))
	pruneMustExist(t, filepath.Join(root, "lexical", defaultSyntheticLexicalDirName))

	// Missing storage root: no-op that creates nothing.
	if removed := svc.DeleteBranchData(missing, "feature/x", nil); removed != 0 {
		t.Fatalf("removed = %d, want 0 for a missing storage root", removed)
	}

	// Active-branch protection: the live state's own branch survives.
	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("SetProject A: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "live"); err != nil {
		t.Fatalf("SwitchBranch A: %v", err)
	}
	if removed := svc.DeleteBranchData(dirA, "live", nil); removed != 0 {
		t.Fatalf("removed = %d, want 0 for the live state's branch", removed)
	}
	pruneMustExist(t, filepath.Join(dirA, "branches", "branch_live"))
	pruneMustExist(t, filepath.Join(dirA, "lexical", "live"))
}

// TestDeleteBranchData_DropsParkedState pins the park interaction: a parked
// state of the deleted branch leaves the park LRU (so a later return to the
// project never revives a state whose directories were just removed) and its
// on-disk artifacts are removed.
func TestDeleteBranchData_DropsParkedState(t *testing.T) {
	dirA := filepath.Join(t.TempDir(), "A")
	dirB := filepath.Join(t.TempDir(), "B")
	svc := newPruneTestService(t, 2)

	// Open A on the branch that is about to be deleted: both index
	// directories are created.
	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("SetProject A: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "gone"); err != nil {
		t.Fatalf("SwitchBranch A: %v", err)
	}
	pruneMustExist(t, filepath.Join(dirA, "branches", "branch_gone"))
	pruneMustExist(t, filepath.Join(dirA, "lexical", "gone"))

	// Park A by switching to B on "main" (the surviving branch).
	if err := svc.SetProject("B", dirB); err != nil {
		t.Fatalf("SetProject B: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch B: %v", err)
	}
	if len(svc.parked) != 1 || svc.parked[0].projectID != "A" {
		t.Fatalf("parked = %d entries, want [A]", len(svc.parked))
	}

	if removed := svc.DeleteBranchData(dirA, "gone", []string{"main"}); removed == 0 {
		t.Fatal("purge removed nothing for a fully stale parked project")
	}
	pruneMustNotExist(t, filepath.Join(dirA, "branches", "branch_gone"))
	pruneMustNotExist(t, filepath.Join(dirA, "lexical", "gone"))
	if len(svc.parked) != 0 {
		t.Fatalf("deleted branch's parked state survived the purge: %d entries", len(svc.parked))
	}

	// A later return to A opens a fresh state instead of reviving the
	// evicted one.
	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("re-open A: %v", err)
	}
}

// fixtureBranchArtifacts writes the complete per-branch artifact set for
// branch under the storage root (the same shape the purge tests of
// PruneMissingBranchData use).
func fixtureBranchArtifacts(t *testing.T, root, branch string) {
	t.Helper()
	collection := collectionName(branch)
	pruneMkdir(t, filepath.Join(root, "branches", collection))
	pruneMkdir(t, filepath.Join(root, lexicalDirName, lexicalBranchDirName(branch)))
	pruneWrite(t, filepath.Join(root, "file_hashes_"+collection+".json"), "{}")
	pruneWrite(t, filepath.Join(root, "contentless_"+collection+".done"), "")
}

// pruneFSLogger is the discard logger the manager-free FS-form tests run with.
func pruneFSLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}

// TestPruneMissingBranchDataFS_MatchesServiceForm pins the manager-free sweep
// (the disabled-registry path): the same artifact set is removed and the same
// identities (existing branches, synthetic default, orphan root, embedding
// cache) survive as under the Service form, and a missing storage root is a
// fail-soft no-op.
func TestPruneMissingBranchDataFS_MatchesServiceForm(t *testing.T) {
	root := filepath.Join(t.TempDir(), "vi")
	fixtureBranchArtifacts(t, root, "main")
	fixtureBranchArtifacts(t, root, "old")
	// Protected identities and the branch-independent cache survive.
	pruneMkdir(t, filepath.Join(root, "branches", "_orphan"))
	pruneMkdir(t, filepath.Join(root, lexicalDirName, "default"))
	pruneWrite(t, filepath.Join(root, "embedding_cache", "chunk.bin"), "x")

	removed := PruneMissingBranchDataFS(pruneFSLogger(), root, []string{"main"})
	if removed != 4 {
		t.Fatalf("removed = %d, want 4 (branch root + lexical dir + sidecar + marker)", removed)
	}
	pruneMustNotExist(t, filepath.Join(root, "branches", "branch_old"))
	pruneMustNotExist(t, filepath.Join(root, lexicalDirName, "old"))
	pruneMustNotExist(t, filepath.Join(root, "file_hashes_branch_old.json"))
	pruneMustNotExist(t, filepath.Join(root, "contentless_branch_old.done"))
	pruneMustExist(t, filepath.Join(root, "branches", "branch_main"))
	pruneMustExist(t, filepath.Join(root, lexicalDirName, "main"))
	pruneMustExist(t, filepath.Join(root, "file_hashes_branch_main.json"))
	pruneMustExist(t, filepath.Join(root, "contentless_branch_main.done"))
	pruneMustExist(t, filepath.Join(root, "branches", "_orphan"))
	pruneMustExist(t, filepath.Join(root, lexicalDirName, "default"))
	pruneMustExist(t, filepath.Join(root, "embedding_cache", "chunk.bin"))

	// Missing storage root: silent no-op.
	if removed := PruneMissingBranchDataFS(pruneFSLogger(), filepath.Join(t.TempDir(), "missing"), []string{"main"}); removed != 0 {
		t.Fatalf("missing root: removed = %d, want 0", removed)
	}
}

// TestDeleteBranchDataFS_MatchesServiceForm pins the manager-free targeted
// purge (the disabled-registry path): the deleted branch loses its artifact
// set, a collision-shared artifact stays (the lossy-name rule), and a missing
// storage root is a fail-soft no-op.
func TestDeleteBranchDataFS_MatchesServiceForm(t *testing.T) {
	root := filepath.Join(t.TempDir(), "vi")
	fixtureBranchArtifacts(t, root, "main")
	fixtureBranchArtifacts(t, root, "retracted")

	removed := DeleteBranchDataFS(pruneFSLogger(), root, "retracted", []string{"main"})
	if removed != 4 {
		t.Fatalf("removed = %d, want 4 (branch root + sidecar pair + lexical dir)", removed)
	}
	pruneMustNotExist(t, filepath.Join(root, "branches", "branch_retracted"))
	pruneMustNotExist(t, filepath.Join(root, lexicalDirName, "retracted"))
	pruneMustNotExist(t, filepath.Join(root, "file_hashes_branch_retracted.json"))
	pruneMustNotExist(t, filepath.Join(root, "contentless_branch_retracted.done"))
	pruneMustExist(t, filepath.Join(root, "branches", "branch_main"))

	// Collision: deleting feature/foo while feature_foo survives keeps the
	// shared artifacts on disk (same sanitized identity, both halves).
	colRoot := filepath.Join(t.TempDir(), "vi-col")
	fixtureBranchArtifacts(t, colRoot, "feature_foo")
	if removed := DeleteBranchDataFS(pruneFSLogger(), colRoot, "feature/foo", []string{"feature_foo"}); removed != 0 {
		t.Fatalf("collision purge removed %d artifacts, want 0", removed)
	}
	pruneMustExist(t, filepath.Join(colRoot, "branches", "branch_feature_foo"))

	// Missing storage root: silent no-op.
	if removed := DeleteBranchDataFS(pruneFSLogger(), filepath.Join(t.TempDir(), "missing"), "gone", []string{"main"}); removed != 0 {
		t.Fatalf("missing root: removed = %d, want 0", removed)
	}
}
