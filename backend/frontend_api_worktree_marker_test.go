package backend

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/v0lka/c0wrk/core"
)

// TestManagedWorktreeCreateIgnoresLegacyContainerJunk pins that a stray object
// at the LEGACY <repo>/.worktrees container does not block managed-session
// creation in the new app-data container. Before the fix, CreateManagedSession's
// pre-flight NormalizeWorkspaceBinding derived through ManagedWorktreePath and
// its on-disk legacy-container validation failed fatally, so every managed
// creation was refused under this trigger.
func TestManagedWorktreeCreateIgnoresLegacyContainerJunk(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	legacy := filepath.Join(h.repoRoot, core.WorktreesRelativePath)
	if err := os.Symlink(t.TempDir(), legacy); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	info := h.api.mustManagedSession(t, "junk-safe", true, "")
	want := filepath.Join(canonicalWorktreeRoot(h.agentDir), "projects", h.project.ID, "worktrees")
	if got := filepath.Dir(info.WorkspaceBinding.WorkspacePath); got != want {
		t.Fatalf("tree container = %q, want %q", got, want)
	}
}

// TestManagedWorktreeDurableBindingWithoutMarker pins that removing the
// repository marker — and then the whole app-data container — leaves a durable
// managed session decodable, listable and restorable at its recorded path.
// Ownership is anchored by the project-scoped layout, not by the marker file;
// a missing container is recreated at the recorded path (not relocated).
func TestManagedWorktreeDurableBindingWithoutMarker(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	ctx := context.Background()

	info := h.api.mustManagedSession(t, "nomarker", true, "")
	path := info.WorkspaceBinding.WorkspacePath
	container := filepath.Dir(path)

	// Drop the ownership marker, leaving the tree in place.
	if err := os.Remove(filepath.Join(container, core.WorktreeRepositoryMarker)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.LoadSession(ctx, info.ID); err != nil {
		t.Fatalf("LoadSession(marker removed) = %v, want success", err)
	}
	if _, err := h.store.ListSessions(ctx); err != nil {
		t.Fatalf("ListSessions(marker removed) = %v, want success", err)
	}
	_, mgr, _ := h.restart(t)
	if _, ok := mgr.GetSession(info.ID); !ok {
		t.Fatal("restore failed after the marker was removed")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("tree missing after restore: %v", err)
	}
	// Restore re-establishes the ownership marker so the ensured tree stays
	// classified as managed.
	if _, err := os.Stat(filepath.Join(container, core.WorktreeRepositoryMarker)); err != nil {
		t.Fatalf("ownership marker not re-established after restore: %v", err)
	}
	if !isManagedTreePath(h.repoRoot, path) {
		t.Error("restored tree is no longer classified as managed")
	}

	// Remove the whole container: decoding and listing still succeed, and a
	// fresh restore recreates the tree at the recorded path.
	if err := os.RemoveAll(container); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.LoadSession(ctx, info.ID); err != nil {
		t.Fatalf("LoadSession(container removed) = %v, want success", err)
	}
	if _, err := h.store.ListSessions(ctx); err != nil {
		t.Fatalf("ListSessions(container removed) = %v, want success", err)
	}
	_, mgr2, _ := h.restart(t)
	if _, ok := mgr2.GetSession(info.ID); !ok {
		t.Fatal("restore failed after the container was removed")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("tree not recreated at the recorded path %q: %v", path, err)
	}
	if _, err := os.Stat(filepath.Join(container, core.WorktreeRepositoryMarker)); err != nil {
		t.Fatalf("ownership marker not re-established after recreation: %v", err)
	}
}
