package backend

import (
	"context"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/project"
	"github.com/v0lka/c0wrk/core/vectorindex"
)

// Exercise the real indexing path, parked inside embedding while IndexFull
// holds the service write lock. Every operation must finish BEFORE release,
// not merely after the index eventually completes. Watchdogs detect hangs;
// entered/release/done channels establish ordering without scheduler sleeps.
func TestVectorIndexingDoesNotBlockNavigation(t *testing.T) {
	for _, operation := range []string{"status", "session focus", "project", "CHAT CODE round trip"} {
		t.Run(operation, func(t *testing.T) {
			h := newVectorWorktreeHarness(t)
			h.api.builderOverride = &mockBuilder{}
			if _, err := h.api.projectManager.EnsureNoProject(); err != nil {
				t.Fatalf("EnsureNoProject() = %v, want nil", err)
			}
			tree := h.addManagedWorktree(t, "navigation", "navigation")
			other, err := h.api.projectManager.CreateProject("other", "")
			if err != nil {
				t.Fatalf("CreateProject(other) = %v, want nil", err)
			}
			// SwitchProject can create a watcher; close it before harness teardown.
			t.Cleanup(func() {
				h.api.watcherMu.Lock()
				defer h.api.watcherMu.Unlock()
				if h.api.watcher != nil {
					_ = h.api.watcher.Close()
				}
			})

			entered, release := make(chan struct{}), make(chan struct{})
			var enterOnce, releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			t.Cleanup(unblock)
			ready := make(chan struct{})
			close(ready)
			h.roots.SetFactory(func() (*vectorindex.Manager, error) {
				return vectorindex.NewManager(vectorindex.ManagerConfig{
					EmbeddingFunc: func(ctx context.Context, _ string) ([]float32, error) {
						enterOnce.Do(func() { close(entered) })
						select {
						case <-release:
							return []float32{1, 0, 0, 0}, nil
						case <-ctx.Done():
							return nil, ctx.Err()
						}
					},
				})
			}, ready, nil)
			mgr, err := h.roots.ManagerForRoot(context.Background(), h.proj.WorkspacePath)
			if err != nil {
				t.Fatalf("ManagerForRoot(checkout) = %v, want nil", err)
			}
			select {
			case <-entered:
			case <-time.After(10 * time.Second):
				t.Fatal("IndexFull(checkout) did not enter embedding")
			}
			if mgr.Service().IsReady() {
				t.Fatal("IsReady() = true during blocked embedding, want false")
			}

			done := make(chan struct{})
			var opErr error
			// Release before joining, including on fatal watchdog assertions.
			t.Cleanup(func() { unblock(); <-done })
			go func() {
				defer close(done)
				switch operation {
				case "status":
					if opErr = h.roots.ApplyFocus(context.Background(), h.proj.WorkspacePath); opErr != nil {
						return
					}
					st := h.api.GetVectorIndexStatus()
					if !reflect.DeepEqual(st.Indices, []string{"vector", "lexical"}) {
						opErr = fmt.Errorf("GetVectorIndexStatus().Indices = %v, want [vector lexical]", st.Indices)
					}
				case "session focus":
					if opErr = h.api.SetGitPanelFocus(tree); opErr == nil {
						opErr = h.api.SetGitPanelFocus("")
					}
				case "project":
					if opErr = h.api.SwitchProject(other.ID); opErr == nil {
						opErr = h.api.SwitchProject(h.proj.ID)
					}
				case "CHAT CODE round trip":
					if opErr = h.api.SwitchProject(project.NoProjectID); opErr == nil {
						opErr = h.api.SwitchProject(h.proj.ID)
					}
				}
			}()
			select {
			case <-done:
				if opErr != nil {
					t.Fatalf("navigation(%s) = %v, want nil while indexing remains blocked", operation, opErr)
				}
			case <-time.After(10 * time.Second):
				t.Fatalf("navigation(%s) blocked behind IndexFull, want completion before releasing embedding", operation)
			}
			if mgr.Service().IsReady() {
				t.Error("navigation cancelled/completed outgoing IndexFull, want it still running")
			}
		})
	}
}
