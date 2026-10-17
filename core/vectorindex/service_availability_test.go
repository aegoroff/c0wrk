package vectorindex

import (
	"context"
	"path/filepath"
	"testing"
)

func TestIndexAvailabilityLifecycle(t *testing.T) {
	root := t.TempDir()
	svc, err := NewService(ServiceConfig{EmbeddingFunc: fakeEmbeddingFunc(), ParkCapacity: 2})
	if err != nil {
		t.Fatalf("NewService() = %v, want nil", err)
	}
	t.Cleanup(func() { _ = svc.Close() })
	assertAvailability := func(vector, lexical bool) {
		t.Helper()
		gotVector, gotLexical := svc.IndexAvailability()
		if gotVector != vector || gotLexical != lexical {
			t.Errorf("IndexAvailability() = (%t, %t), want (%t, %t)", gotVector, gotLexical, vector, lexical)
		}
	}
	assertAvailability(false, false)
	pathA := filepath.Join(root, "a")
	if err := svc.SetProject("a", pathA); err != nil {
		t.Fatalf("SetProject(a) = %v, want nil", err)
	}
	assertAvailability(false, false)
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch(main) = %v, want nil", err)
	}
	assertAvailability(true, true)

	// A UI status probe must work even on the write-lock holder itself.
	// No goroutine or timeout is needed to establish the lock ordering.
	svc.AcquireWriteLock()
	assertAvailability(true, true)
	svc.ReleaseWriteLock()

	if err := svc.SetProject("b", filepath.Join(root, "b")); err != nil {
		t.Fatalf("SetProject(b) = %v, want nil", err)
	}
	assertAvailability(false, false)
	if err := svc.SetProject("a", pathA); err != nil {
		t.Fatalf("SetProject(a, parked) = %v, want nil", err)
	}
	assertAvailability(true, true)

	svc.ResetForNoProject("chat")
	assertAvailability(false, false)
	if err := svc.SetProject("a", pathA); err != nil {
		t.Fatalf("SetProject(a, after reset) = %v, want nil", err)
	}
	assertAvailability(true, true)
	if err := svc.Close(); err != nil {
		t.Fatalf("Close() = %v, want nil", err)
	}
	assertAvailability(false, false)
}
