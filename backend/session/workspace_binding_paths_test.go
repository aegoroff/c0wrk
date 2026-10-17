package session

import (
	"github.com/v0lka/c0wrk/backend/config"
	"testing"
)

func TestWorkspaceBindingEmptyLegacyPath(t *testing.T) {
	root := t.TempDir()
	got, err := NormalizeWorkspaceBinding("project-id", root, &WorkspaceBinding{Kind: WorkspaceManagedWorktree, WorktreeName: "legacy", Branch: "topic"})
	if err != nil {
		t.Fatal(err)
	}
	want, err := config.ManagedWorktreePath(root, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspacePath != want {
		t.Errorf("NormalizeWorkspaceBinding(empty legacy path) = %q, want %q", got.WorkspacePath, want)
	}
}
