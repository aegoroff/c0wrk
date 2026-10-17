package backend

import (
	"github.com/v0lka/c0wrk/backend/config"
	"testing"
)

func TestManagedWorktreeAdoptionIgnoresInvalidCreationRoot(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	first, err := h.api.CreateManagedSession("existing", true, "")
	if err != nil {
		t.Fatal(err)
	}
	h.api.config = &config.Config{Git: config.GitConfig{WorktreesRoot: "invalid-relative-root"}}
	adopted, err := h.api.CreateManagedSession("existing", false, "")
	if err != nil {
		t.Fatalf("CreateManagedSession(adopt, invalid new root): %v", err)
	}
	if adopted.WorkspaceBinding.WorkspacePath != first.WorkspaceBinding.WorkspacePath {
		t.Errorf("adopted path = %q, want existing %q", adopted.WorkspaceBinding.WorkspacePath, first.WorkspaceBinding.WorkspacePath)
	}
	if _, err := h.api.CreateManagedSession("fresh", true, ""); err == nil {
		t.Error("CreateManagedSession(fresh, invalid new root) = nil error, want refusal")
	}
}
