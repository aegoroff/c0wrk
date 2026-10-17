package core

import (
	"os"
	"path/filepath"
	"testing"
)

func TestManagedWorktreeContainerOwnership(t *testing.T) {
	repo, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	container, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(container, "tree")
	if IsManagedWorktreePath(repo, target) {
		t.Errorf("IsManagedWorktreePath(unmarked %q) = true, want false", target)
	}
	if err := MarkWorktreeContainer(repo, container); err != nil {
		t.Fatal(err)
	}
	if !IsManagedWorktreePath(repo, target) {
		t.Errorf("IsManagedWorktreePath(marked missing %q) = false, want true", target)
	}
	if IsManagedWorktreePath(repo, filepath.Join(target, "nested")) {
		t.Error("IsManagedWorktreePath(nested) = true, want false")
	}
	other := t.TempDir()
	if IsManagedWorktreePath(other, target) {
		t.Error("IsManagedWorktreePath(foreign repo) = true, want false")
	}
	if err := MarkWorktreeContainer(other, container); err == nil {
		t.Error("MarkWorktreeContainer(foreign repo) = nil, want refusal")
	}
	if err := os.Symlink(other, target); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if IsManagedWorktreePath(repo, target) {
		t.Error("IsManagedWorktreePath(symlink tree) = true, want false")
	}
}

func TestManagedWorktreeMarkerSymlinkRefused(t *testing.T) {
	repo, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	container, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(repo, "payload")
	if err := os.WriteFile(payload, []byte(repo+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(payload, filepath.Join(container, WorktreeRepositoryMarker)); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := MarkWorktreeContainer(repo, container); err == nil {
		t.Error("MarkWorktreeContainer(symlink marker) = nil, want refusal")
	}
	if IsManagedWorktreePath(repo, filepath.Join(container, "tree")) {
		t.Error("IsManagedWorktreePath(symlink marker) = true, want false")
	}
}
