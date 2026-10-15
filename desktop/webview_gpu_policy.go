package desktop

import (
	"log/slog"
	"os"
	"runtime"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/options/linux"

	"github.com/v0lka/c0wrk/backend"
)

// webviewGpuPolicy is the effective hardware-acceleration policy for the
// Linux webview — the value WebKit ultimately receives — deliberately
// decoupled from Wails' enum ordering (see wailsWebviewGpuPolicy for why the
// conversion is not the identity). The canonical string alphabet (env var,
// persisted setting, Settings UI, RPCs) lives in backend/webview_gpu.go; this
// enum is the Wails-bound leaf of that pipeline.
type webviewGpuPolicy int

const (
	gpuPolicyNever webviewGpuPolicy = iota
	gpuPolicyAlways
	gpuPolicyOnDemand
)

// String returns the canonical spelling of the policy (backend's canonical
// alphabet).
func (p webviewGpuPolicy) String() string {
	switch p {
	case gpuPolicyAlways:
		return backend.WebviewGpuPolicyAlways
	case gpuPolicyOnDemand:
		return backend.WebviewGpuPolicyOnDemand
	default:
		return backend.WebviewGpuPolicyNever
	}
}

// webviewGpuPolicyFromCanonical maps a canonical policy spelling (validated
// by backend's resolvers) onto the enum.
func webviewGpuPolicyFromCanonical(canonical string) webviewGpuPolicy {
	switch canonical {
	case backend.WebviewGpuPolicyAlways:
		return gpuPolicyAlways
	case backend.WebviewGpuPolicyOnDemand:
		return gpuPolicyOnDemand
	default:
		return gpuPolicyNever
	}
}

// wailsWebviewGpuPolicy converts the policy into the linux.WebviewGpuPolicy
// value to hand to Wails.
//
// Wails v2.16.0 (the version pinned in go.mod) carries a mismatch between
// its Go enum and its C layer: internal/frontend/desktop/linux/window.c
// (SetupWebview) maps the integer to WebKit policies as 0→ALWAYS,
// 1→ON_DEMAND, 2→NEVER, while the Go enum orders OnDemand=0, Always=1,
// Never=2 — so passing the like-named constants silently swaps always and
// on-demand at runtime. The mapping below compensates for that, so the
// policy named on the env var is the one WebKit actually receives:
//
//	desired always    → Go OnDemand(0) → C case 0 → WEBKIT_…POLICY_ALWAYS
//	desired on-demand → Go Always(1)   → C case 1 → WEBKIT_…POLICY_ON_DEMAND
//	desired never     → Go Never(2)    → C case 2 → WEBKIT_…POLICY_NEVER
//
// Re-verify against window.c whenever Wails is upgraded: if upstream ever
// aligns the C switch with the Go enum, the two non-default arms here must
// be swapped back (or dropped) and the tests in webview_gpu_policy_test.go
// updated to match.
func (p webviewGpuPolicy) wailsWebviewGpuPolicy() linux.WebviewGpuPolicy {
	switch p {
	case gpuPolicyAlways:
		return linux.WebviewGpuPolicyOnDemand
	case gpuPolicyOnDemand:
		return linux.WebviewGpuPolicyAlways
	default:
		return linux.WebviewGpuPolicyNever
	}
}

// WebviewGpuPolicyOptions returns the Linux-specific Wails options carrying
// the hardware-acceleration policy for this launch. It returns nil on
// non-Linux platforms — the option only feeds the WebKitGTK frontend, so
// macOS and Windows keep behaving exactly as before. stderrObserved reports
// whether this launch has a usable stderr capture (see DeriveWebviewGpuRun):
// without one a fresh-auto launch is demoted to never, because the failure
// watchdog could never detect the resulting grey window.
func WebviewGpuPolicyOptions(agentDir string, stderrObserved bool, logger *slog.Logger) *linux.Options {
	return webviewGpuPolicyOptions(runtime.GOOS, agentDir, stderrObserved, logger)
}

func webviewGpuPolicyOptions(goos, agentDir string, stderrObserved bool, logger *slog.Logger) *linux.Options {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	if goos != "linux" {
		if raw := os.Getenv(backend.WebviewGpuPolicyEnvVar); strings.TrimSpace(raw) != "" {
			logger.Debug("webview GPU policy override ignored: Linux-only option",
				"env", backend.WebviewGpuPolicyEnvVar, "value", raw, "goos", goos)
		}
		return nil
	}
	// Single launch-time read of the state file: the consumed setting rides
	// along in the result, so the Debug record below needs no second load
	// (a second read could also observe a state file the first did not).
	run := backend.DeriveWebviewGpuRun(agentDir, stderrObserved, logger)
	resolved := webviewGpuPolicyFromCanonical(run.Policy)
	switch run.Source {
	case backend.WebviewGpuSourceEnv:
		logger.Info("webview GPU policy override",
			"env", backend.WebviewGpuPolicyEnvVar, "value", run.Policy)
	case backend.WebviewGpuSourceAutoUnobserved:
		// Explicit diagnostic for the demotion (review finding #155.2): a
		// silent accelerated default without any failure detection would
		// leave a broken grey window as the first symptom. The user keeps an
		// explicit override (env or setting) to force acceleration anyway.
		logger.Warn("webview GPU policy pinned to never: fresh auto without a usable stderr capture "+
			"(the DMABUF watchdog cannot observe this run; set C0WRK_WEBVIEW_GPU_POLICY or the Settings choice to override)",
			"policy", run.Policy, "setting", run.Setting)
	default:
		logger.Debug("webview GPU policy resolved",
			"policy", run.Policy, "source", run.Source, "setting", run.Setting)
	}
	return &linux.Options{WebviewGpuPolicy: resolved.wailsWebviewGpuPolicy()}
}
