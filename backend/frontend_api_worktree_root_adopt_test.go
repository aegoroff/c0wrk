package backend

import (
	"context"
	"github.com/v0lka/c0wrk/backend/config"
	"testing"
)

func TestManagedWorktreeAdoptionIgnoresInvalidCreationRoot(t *testing.T) {
	h := newWTHarness(t, wtFactory())
	first := h.api.mustManagedSession(t, "existing", true, "")
	h.api.config = &config.Config{Git: config.GitConfig{WorktreesRoot: "invalid-relative-root"}}
	adopted := h.api.mustManagedSession(t, "existing", false, "")
	if adopted.WorkspaceBinding.WorkspacePath != first.WorkspaceBinding.WorkspacePath {
		t.Errorf("adopted path = %q, want existing %q", adopted.WorkspaceBinding.WorkspacePath, first.WorkspaceBinding.WorkspacePath)
	}
	fresh := newFreshLocalSession(t, h)
	if err := h.api.bindSessionWorkspace(context.Background(), fresh.ID, &SessionWorkspaceChoice{Branch: "fresh", CreateBranch: true}); err == nil {
		t.Error("fresh bind with an invalid new root = nil error, want refusal")
	}
}
