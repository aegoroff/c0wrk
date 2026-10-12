package backend

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/project"
)

// TestSwitchProject_VectorFailureKeepsPreviousWatcher pins review [C3-2]: a
// vector-setup failure during a project switch must leave the workspace
// watcher scoped to the PREVIOUS (still-active) project. The fallible vector
// step runs before the watcher swap, so the failed switch never closes the
// previous watcher nor starts one for the project that never activated —
// otherwise the previous project's file tree silently stops receiving
// workspace:tree_changed until a later successful switch.
func TestSwitchProject_VectorFailureKeepsPreviousWatcher(t *testing.T) {
	h := newProjectSwitchHarness(t)
	defer h.close(t)
	prepareAtomicSwitchHarness(t, h)

	// The harness does not eagerly create workspace directories; the watcher
	// cannot watch a missing root, so materialize both before switching.
	for _, ws := range []string{h.workspace} {
		if err := os.MkdirAll(ws, 0o755); err != nil {
			t.Fatalf("MkdirAll %s: %v", ws, err)
		}
	}

	target, err := h.api.projectManager.CreateProject("Watcher Scope Target", "")
	if err != nil {
		t.Fatalf("failed to create target project: %v", err)
	}
	if err := os.MkdirAll(target.WorkspacePath, 0o755); err != nil {
		t.Fatalf("MkdirAll target workspace: %v", err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	h.seedSessionForProject(t, target.ID, "session-target", now, now)

	// Activate the first project so there IS a previous watcher to keep.
	// The recording emitEvent must be installed BEFORE this first switch:
	// the watcher's debounced callback reads f.emitEvent on the fsnotify
	// goroutine, and swapping it afterwards races that callback under
	// -race (the tree is quiet before the probe write, so the channel
	// sees no spurious events from the first watcher's own startup).
	treeChanged := make(chan struct{}, 16)
	h.api.emitEvent = func(name string, _ ...any) {
		if name == EventWorkspaceTreeChanged {
			select {
			case treeChanged <- struct{}{}:
			default:
			}
		}
	}
	if err := h.api.SwitchProject(h.projectID); err != nil {
		t.Fatalf("initial SwitchProject: %v", err)
	}
	h.api.watcherMu.Lock()
	prevWatcher := h.api.watcher
	h.api.watcherMu.Unlock()
	if prevWatcher == nil {
		t.Fatal("initial switch left no workspace watcher")
	}

	h.api.switchProjectSetupVectorFn = func(ctx context.Context, p *project.ProjectInfo) error {
		return errors.New("vector init boom")
	}

	if err := h.api.SwitchProject(target.ID); err == nil {
		t.Fatal("expected SwitchProject to fail when the vector setup step fails")
	}

	// Identity: the failed switch must not have replaced the watcher.
	h.api.watcherMu.Lock()
	gotWatcher := h.api.watcher
	h.api.watcherMu.Unlock()
	if gotWatcher != prevWatcher {
		t.Fatal("failed vector setup replaced the workspace watcher — the previous project's tree_changed feed was torn down for a project that never activated")
	}

	// Behavioral: the previous project's workspace still delivers tree
	// changes through the surviving watcher.
	probe := filepath.Join(h.workspace, "watch_probe.txt")
	if err := os.WriteFile(probe, []byte("probe"), 0o644); err != nil {
		t.Fatalf("write probe: %v", err)
	}
	select {
	case <-treeChanged:
	case <-time.After(5 * time.Second):
		t.Fatal("no workspace:tree_changed for the previous project's workspace after a failed switch — its watcher is gone or re-scoped")
	}

	// And the never-activated target must not deliver anything (its watcher
	// was never started). Quiet window comfortably above the 200ms debounce.
	targetProbe := filepath.Join(target.WorkspacePath, "watch_probe.txt")
	if err := os.WriteFile(targetProbe, []byte("probe"), 0o644); err != nil {
		t.Fatalf("write target probe: %v", err)
	}
	select {
	case <-treeChanged:
		t.Fatal("workspace:tree_changed fired for the not-activated target project")
	case <-time.After(700 * time.Millisecond):
	}
}
