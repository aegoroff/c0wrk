package backend

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/backend/worktrees"
	"github.com/v0lka/c0wrk/core/workspace"
	"github.com/v0lka/c0wrk/internal/gittest"
)

func TestManagedWorktreeRootConfigChangePreservesIdentity(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	first := h.api.mustManagedSession(t, "root-first", true, "")
	want := filepath.Join(canonicalWorktreeRoot(h.agentDir), "projects", h.project.ID, "worktrees", first.WorkspaceBinding.WorktreeName)
	if err := h.api.DeleteProject(h.project.ID); err == nil {
		t.Fatal("DeleteProject(with managed trees) = nil error, want refusal")
	}
	if _, ok := h.manager.GetSession(first.ID); !ok {
		t.Error("blocked DeleteProject removed the resident session")
	}
	if got := first.WorkspaceBinding.WorkspacePath; got != want {
		t.Fatalf("managed session (default).path = %q, want %q", got, want)
	}
	custom := gittest.TempDir(t)
	h.api.config = &config.Config{Git: config.GitConfig{WorktreesRoot: custom}}
	second := h.api.mustManagedSession(t, "root-second", true, "")
	wantSecond := filepath.Join(custom, h.project.ID, "worktrees", second.WorkspaceBinding.WorktreeName)
	if got := second.WorkspaceBinding.WorkspacePath; got != wantSecond {
		t.Fatalf("managed session (custom).path = %q, want %q", got, wantSecond)
	}
	api, mgr, _ := h.restart(t)
	api.config = &config.Config{Git: config.GitConfig{WorktreesRoot: gittest.TempDir(t)}}
	for _, info := range []struct{ id, branch, path string }{{first.ID, "root-first", want}, {second.ID, "root-second", wantSecond}} {
		if restored, ok := mgr.GetSession(info.id); !ok || restored.WorkspaceBinding().WorkspacePath != info.path {
			t.Fatalf("GetSession(%q) did not restore at %q", info.id, info.path)
		}
		loaded, err := h.store.LoadSession(context.Background(), info.id)
		if err != nil {
			t.Fatal(err)
		}
		if got := loaded.WorkspaceBinding.WorkspacePath; got != info.path {
			t.Fatalf("LoadSession(%q).path = %q, want %q", info.id, got, info.path)
		}
		adopted := api.mustManagedSession(t, info.branch, false, "")
		if got := adopted.WorkspaceBinding.WorkspacePath; got != info.path {
			t.Fatalf("adopt(%q).path = %q, want %q", info.branch, got, info.path)
		}
		if !isManagedTreePath(h.repoRoot, info.path) {
			t.Errorf("isManagedTreePath(%q) = false, want true", info.path)
		}
		if target, ok := api.managedWorktreeVectorTarget(h.project, info.path); !ok || target.workspacePath != info.path {
			t.Errorf("managedWorktreeVectorTarget(%q) = %+v, %v, want same root", info.path, target, ok)
		}
		if err := api.SetGitPanelFocus(info.path); err != nil {
			t.Fatal(err)
		}
		if err := api.refusePinnedBranchSwitch(h.repoRoot, info.path, "other"); !errors.Is(err, ErrPinnedWorktreeBranch) {
			t.Errorf("refusePinnedBranchSwitch(%q) = %v, want ErrPinnedWorktreeBranch", info.path, err)
		}
		if err := api.DeleteWorktree(info.path, false, false); err != nil {
			t.Fatal(err)
		}
		recreated, err := api.ensureManagedWorkspace(context.Background(), h.repoRoot, loaded.WorkspaceBinding)
		if err != nil || !recreated {
			t.Fatalf("ensureManagedWorkspace(%q) = %v, %v, want recreated", info.path, recreated, err)
		}
		if _, err := os.Stat(info.path); err != nil {
			t.Fatalf("recreated path %q: %v", info.path, err)
		}
		if err := api.DeleteSession(adopted.ID); err != nil {
			t.Fatal(err)
		}
		if err := api.DeleteSession(info.id); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(info.path); !os.IsNotExist(err) {
			t.Errorf("released path %q: stat = %v, want absent", info.path, err)
		}
	}
}

func TestManagedWorktreeLegacyRootSurvivesConfigChange(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	legacy, err := worktrees.NewOwner(nil).ProvisionNewBranch(context.Background(), h.repoRoot, "legacy-tree", "legacy-branch", "")
	if err != nil {
		t.Fatal(err)
	}
	h.api.config = &config.Config{Git: config.GitConfig{WorktreesRoot: gittest.TempDir(t)}}
	info := h.api.mustManagedSession(t, "legacy-branch", false, "")
	if info.WorkspaceBinding.WorkspacePath != legacy.Path {
		t.Fatalf("adopt(legacy).path = %q, want %q", info.WorkspaceBinding.WorkspacePath, legacy.Path)
	}
	// Remove even git's metadata: restore must use the stored legacy path.
	if err := workspace.RemoveWorktree(context.Background(), h.repoRoot, legacy.Path, workspace.RemoveWorktreeOptions{}); err != nil {
		t.Fatal(err)
	}
	api, _, _ := h.restart(t)
	if _, err := api.ensureManagedWorkspace(context.Background(), h.repoRoot, info.WorkspaceBinding); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacy.Path); err != nil {
		t.Fatalf("restore(legacy path %q): %v", legacy.Path, err)
	}
	if err := api.DeleteSession(info.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacy.Path); !os.IsNotExist(err) {
		t.Errorf("release(legacy %q) stat = %v, want absent", legacy.Path, err)
	}
}
