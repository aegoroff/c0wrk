package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
)

// TestWorkspaceBindingIgnoresLegacyContainerJunk pins the lexical identity
// contract for an empty-path managed binding (a proposal or a pre-durable row):
// a stray object at the legacy <repo>/.worktrees container must not invalidate
// it. Before the fix the managed branch derived through ManagedWorktreePath,
// whose on-disk container validation failed fatally — blocking every managed
// session creation under exactly this trigger.
func TestWorkspaceBindingIgnoresLegacyContainerJunk(t *testing.T) {
	root := t.TempDir()
	legacy := config.ManagedWorktreesDir(root)
	if err := os.Symlink(t.TempDir(), legacy); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	got, err := NormalizeWorkspaceBinding(testProjectID, root, &WorkspaceBinding{
		Kind:         WorkspaceManagedWorktree,
		WorktreeName: "s-abcdef01",
		Branch:       "topic",
	})
	if err != nil {
		t.Fatalf("NormalizeWorkspaceBinding(legacy junk) = %v, want success", err)
	}
	if want := filepath.Join(legacy, "s-abcdef01"); got.WorkspacePath != want {
		t.Errorf("path = %q, want %q", got.WorkspacePath, want)
	}
	// The hardened constructor still refuses the symlinked container: the fix
	// made validation lexical, it did not remove the on-disk guard.
	if _, err := config.ManagedWorktreePath(root, "s-abcdef01"); err == nil {
		t.Error("ManagedWorktreePath(symlinked container) = nil, want refusal")
	}
}

// TestWorkspaceBindingDurablePathWithoutMarker pins that a durable managed
// binding's recorded path stays decodable and listable after the repository
// marker — or the whole app-data container — is gone. The project-scoped
// "<base>/<projectID>/worktrees" layout anchors ownership, so recognition does
// not depend on a mutable marker file. Before the fix, decoding such a row
// failed and ListSessions/ListSessionsByProject aborted the whole project list.
func TestWorkspaceBindingDurablePathWithoutMarker(t *testing.T) {
	s, cleanup := setupTestStore(t)
	t.Cleanup(cleanup)
	root := bindingTestProject(t, s)
	ctx := context.Background()

	treeName := "s-abcdef01"
	container := filepath.Join(t.TempDir(), testProjectID, "worktrees")
	path := filepath.Join(container, treeName)
	info := SessionInfo{
		ID: "durable", ProjectID: testProjectID, Name: "Durable", CreatedAt: "2026-01-01T00:00:00Z",
		WorkspaceBinding: &WorkspaceBinding{
			Kind: WorkspaceManagedWorktree, WorkspacePath: path, WorktreeName: treeName, Branch: "topic",
		},
	}
	if err := s.SaveSession(ctx, info); err != nil {
		t.Fatal(err)
	}
	// The strict (marker-based) recognizer rejects the path — the project-aware
	// tolerance is what keeps the row decodable.
	if _, err := config.ManagedWorktreeNameFromPath(root, path); err == nil {
		t.Fatal("strict recognizer accepted a marker-less path")
	}
	loaded, err := s.LoadSession(ctx, "durable")
	if err != nil || loaded.WorkspaceBinding.WorkspacePath != path {
		t.Fatalf("LoadSession = %+v, %v", loaded, err)
	}
	for _, list := range []func(context.Context) ([]SessionInfo, error){
		s.ListSessions,
		func(ctx context.Context) ([]SessionInfo, error) { return s.ListSessionsByProject(ctx, testProjectID) },
	} {
		rows, err := list(ctx)
		if err != nil {
			t.Fatalf("list with a marker-less durable binding: %v", err)
		}
		if len(rows) != 1 || rows[0].WorkspaceBinding.WorkspacePath != path {
			t.Fatalf("list = %+v", rows)
		}
	}
	// A path whose project-id segment names another project is still refused.
	mismatch := &WorkspaceBinding{
		Kind:          WorkspaceManagedWorktree,
		WorkspacePath: filepath.Join(t.TempDir(), "other-project", "worktrees", treeName),
		WorktreeName:  treeName,
		Branch:        "topic",
	}
	if _, err := NormalizeWorkspaceBinding(testProjectID, root, mismatch); err == nil {
		t.Error("accepted a foreign project-scoped container")
	}
}
