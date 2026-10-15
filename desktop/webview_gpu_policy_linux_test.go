//go:build linux

package desktop

import (
	"log/slog"
	"testing"

	"github.com/v0lka/c0wrk/backend"
)

// TestWebviewGpuPolicyOptionsProductionEntry runs the production entry —
// runtime.GOOS and the real env var — against a fresh state (auto →
// on-demand, C-layer integer 1). The file is linux-tagged because the
// production entry is a documented nil no-op on macOS and Windows
// (webview_gpu_policy.go): asserting non-nil there would fail the darwin and
// windows CI legs. The non-Linux nil path stays covered by the
// darwin/windows cases of TestWebviewGpuPolicyOptions (the platform seam) in
// webview_gpu_policy_test.go, which builds and runs on every platform.
func TestWebviewGpuPolicyOptionsProductionEntry(t *testing.T) {
	t.Setenv(backend.WebviewGpuPolicyEnvVar, "")
	agentDir := t.TempDir()
	got := WebviewGpuPolicyOptions(agentDir, slog.New(slog.DiscardHandler))
	if got == nil {
		t.Fatal("expected non-nil options on linux")
	}
	if int(got.WebviewGpuPolicy) != 1 {
		t.Fatalf("fresh install default: want C-layer 1 (on-demand), got %d", int(got.WebviewGpuPolicy))
	}
}
