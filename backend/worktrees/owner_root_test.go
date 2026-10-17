package worktrees

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/core/workspace"
	"github.com/v0lka/c0wrk/internal/gittest"
)

func TestOwnerNewRootRefusesCheckoutOverlap(t *testing.T) {
	_, repo := setupOwnerRepo(t)
	for _, container := range []string{repo.Root, filepath.Dir(repo.Root), filepath.Join(repo.Root, ".git", "trees"), filepath.Join(repo.Root, "nested")} {
		if _, err := NewOwner(nil, container).NewPath(repo.Root, "tree"); err == nil {
			t.Errorf("NewPath(container=%q) = nil error, want overlap refusal", container)
		}
	}
}

// TestOwnerNameResolutionIgnoresLegacyContainerJunk is the regression for the
// name-based resolution contract: a LIVE tree in a NEW (marked) container must
// be resolvable, inspectable and releasable even when a stray object occupies
// the LEGACY <repo>/.worktrees/<name> path. Before the fix, Path validated the
// legacy container up front and returned its error as fatal, so a perfectly
// healthy tree in the new container could be neither released, forked nor
// adopted.
func TestOwnerNameResolutionIgnoresLegacyContainerJunk(t *testing.T) {
	_, repo := setupOwnerRepo(t)
	container, err := config.NewManagedWorktreesDir(gittest.TempDir(t), "project", "")
	if err != nil {
		t.Fatalf("derive container: %v", err)
	}
	owner := NewOwner(nil, container)
	ctx := context.Background()

	info, err := owner.ProvisionNewBranch(ctx, repo.Root, "s1", "wt-s1", "")
	if err != nil {
		t.Fatalf("provision in new container: %v", err)
	}
	if filepath.Dir(info.Path) != container {
		t.Fatalf("tree path = %q, want inside %q", info.Path, container)
	}

	// Plant junk on the LEGACY path the pre-fix resolution validated first:
	// a symlink where the name would derive <repo>/.worktrees/s1.
	legacy := filepath.Join(repo.Root, ".worktrees")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	junk := filepath.Join(legacy, "s1")
	if err := os.Symlink(filepath.Join(gittest.TempDir(t), "elsewhere"), junk); err != nil {
		t.Fatal(err)
	}

	got, err := owner.Path(ctx, repo.Root, "s1")
	if err != nil {
		t.Fatalf("Path with legacy junk = %v, want resolution to the live tree", err)
	}
	if got != info.Path {
		t.Fatalf("Path = %q, want live tree %q", got, info.Path)
	}
	if _, err := owner.Inspect(ctx, repo.Root, "s1"); err != nil {
		t.Fatalf("Inspect with legacy junk = %v, want the live tree", err)
	}
	if err := owner.Release(ctx, repo.Root, "s1", workspace.RemoveWorktreeOptions{}); err != nil {
		t.Fatalf("Release with legacy junk = %v, want success", err)
	}
	if _, err := os.Lstat(junk); err != nil {
		t.Errorf("legacy junk object was disturbed: %v", err)
	}
}
