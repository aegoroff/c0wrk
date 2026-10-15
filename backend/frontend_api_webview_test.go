package backend

import (
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
)

// newWebviewGpuTestAPI builds a directly-constructed FrontendAPI (the same
// pattern the seed-field comment sanctions for tests) with the running
// snapshot set to what Init would have derived for a fresh auto launch, and
// the seed publication flag stored so the guardless log path (f.log →
// seedAcquire) does not wait for an Init that never runs here.
func newWebviewGpuTestAPI(t *testing.T) (f *FrontendAPI, agentDir string) {
	t.Helper()
	f = &FrontendAPI{
		agentDir:                t.TempDir(),
		logger:                  slog.New(slog.DiscardHandler),
		webviewGpuRunning:       WebviewGpuPolicyOnDemand,
		webviewGpuRunningSource: WebviewGpuSourceAuto,
	}
	f.seedPublished.Store(true)
	return f, f.agentDir
}

func TestWebviewGpuPolicyGetFreshInstall(t *testing.T) {
	f, _ := newWebviewGpuTestAPI(t)

	info := f.GetWebviewGpuPolicy()
	if info.Setting != WebviewGpuPolicyAuto {
		t.Errorf("Setting = %q, want auto (nothing persisted yet)", info.Setting)
	}
	if info.Running != WebviewGpuPolicyOnDemand {
		t.Errorf("Running = %q, want on-demand", info.Running)
	}
	if info.RunningSource != WebviewGpuSourceAuto {
		t.Errorf("RunningSource = %q, want auto", info.RunningSource)
	}
	if info.Fallback != nil {
		t.Errorf("Fallback = %+v, want nil", info.Fallback)
	}
	if info.RestartRequired {
		t.Error("RestartRequired = true, want false (pending == running)")
	}
}

func TestWebviewGpuPolicyGetFallbackPendingDelta(t *testing.T) {
	f, agentDir := newWebviewGpuTestAPI(t)
	// The watchdog fell back while this run still resolved on-demand —
	// only possible mid-run (fallback persisted after launch): the pending
	// policy (never) differs from running (on-demand).
	if err := SaveWebviewGpuState(agentDir, WebviewGpuState{AutoFallback: dmabufFallbackFixture()}); err != nil {
		t.Fatalf("save: %v", err)
	}

	info := f.GetWebviewGpuPolicy()
	if info.Fallback == nil {
		t.Fatal("Fallback = nil, want the persisted record")
	}
	if info.Setting != WebviewGpuPolicyAuto {
		t.Errorf("Setting = %q, want auto", info.Setting)
	}
	if !info.RestartRequired {
		t.Error("RestartRequired = false, want true (pending never ≠ running on-demand)")
	}

	// A run that already launched on the fallback resolves never: no restart
	// pending.
	f.webviewGpuRunning = WebviewGpuPolicyNever
	f.webviewGpuRunningSource = WebviewGpuSourceAutoFallback
	if info := f.GetWebviewGpuPolicy(); info.RestartRequired {
		t.Error("RestartRequired = true after the fallback relaunch, want false")
	}
}

func TestWebviewGpuPolicySetPersistsAndClearsFallback(t *testing.T) {
	f, agentDir := newWebviewGpuTestAPI(t)
	if err := SaveWebviewGpuState(agentDir, WebviewGpuState{AutoFallback: dmabufFallbackFixture()}); err != nil {
		t.Fatalf("save: %v", err)
	}

	info, err := f.SetWebviewGpuPolicy("  ONDEMAND ")
	if err != nil {
		t.Fatalf("set: %v", err)
	}
	if info.Setting != WebviewGpuPolicyOnDemand {
		t.Errorf("Setting = %q, want on-demand (case/alias normalized)", info.Setting)
	}

	persisted := LoadWebviewGpuState(agentDir, nil)
	if persisted.GPUPolicy != WebviewGpuPolicyOnDemand {
		t.Errorf("persisted GPUPolicy = %q, want on-demand", persisted.GPUPolicy)
	}
	if persisted.AutoFallback != nil {
		t.Errorf("persisted fallback = %+v, want cleared by an explicit choice", persisted.AutoFallback)
	}
}

func TestWebviewGpuPolicySetAutoIsRetry(t *testing.T) {
	f, agentDir := newWebviewGpuTestAPI(t)
	if err := SaveWebviewGpuState(agentDir, WebviewGpuState{GPUPolicy: WebviewGpuPolicyNever, AutoFallback: dmabufFallbackFixture()}); err != nil {
		t.Fatalf("save: %v", err)
	}

	if _, err := f.SetWebviewGpuPolicy("auto"); err != nil {
		t.Fatalf("set: %v", err)
	}
	persisted := LoadWebviewGpuState(agentDir, nil)
	if persisted.GPUPolicy != WebviewGpuPolicyAuto {
		t.Errorf("persisted GPUPolicy = %q, want auto", persisted.GPUPolicy)
	}
	if persisted.AutoFallback != nil {
		t.Errorf("persisted fallback = %+v, want cleared (re-choosing auto is the retry action)", persisted.AutoFallback)
	}

	// Retry semantics visible in the returned info: the pending policy is
	// on-demand again while the current run (post-relaunch) is never.
	f.webviewGpuRunning = WebviewGpuPolicyNever
	f.webviewGpuRunningSource = WebviewGpuSourceAutoFallback
	info := f.GetWebviewGpuPolicy()
	if !info.RestartRequired {
		t.Error("RestartRequired = false after retry, want true (pending on-demand ≠ running never)")
	}
}

func TestWebviewGpuPolicySetInvalidRejectedWithoutWrite(t *testing.T) {
	f, agentDir := newWebviewGpuTestAPI(t)

	info, err := f.SetWebviewGpuPolicy("turbo")
	if err == nil {
		t.Fatal("expected an error for an unknown setting")
	}
	for _, want := range []string{"turbo", "auto", "always", "on-demand", "never"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q should mention %q", err.Error(), want)
		}
	}
	if info.Setting != "" {
		t.Errorf("info from a rejected set = %+v, want zero", info)
	}
	// No state file may appear.
	if _, statErr := os.Stat(config.WebviewStatePath(agentDir)); !os.IsNotExist(statErr) {
		t.Errorf("state file written by a rejected set: %v", statErr)
	}
}

func TestWebviewGpuPolicyEnvPinSuppressesRestartRequired(t *testing.T) {
	f, agentDir := newWebviewGpuTestAPI(t)
	// This run was forced by an explicit env override; the next launch
	// resolves to the same value regardless of the setting, so no restart
	// can apply a change.
	f.webviewGpuRunning = WebviewGpuPolicyNever
	f.webviewGpuRunningSource = WebviewGpuSourceEnv
	if err := SaveWebviewGpuState(agentDir, WebviewGpuState{GPUPolicy: WebviewGpuPolicyAlways}); err != nil {
		t.Fatalf("save: %v", err)
	}

	info := f.GetWebviewGpuPolicy()
	if info.RestartRequired {
		t.Error("RestartRequired = true under an env override, want false (the override wins on relaunch too)")
	}
}
