package desktop

import (
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/v0lka/c0wrk/backend"
	"github.com/v0lka/c0wrk/backend/crashlog"
	"github.com/v0lka/sp4rk/safeio"
)

// GpuRelaunchWaitEnvVar is set by the watchdog's relaunch on the child
// process. mainImpl consumes it before the single-instance gate: the child
// waits for the dying instance's advisory lock to release, so the watchdog's
// spawn-then-quit ordering cannot race the fresh instance into the Wails
// single-instance relay (which would exit it immediately).
const GpuRelaunchWaitEnvVar = "C0WRK_GPU_RELAUNCH_WAIT_LOCK"

// gpuRelaunchHandoverMargin extends the handover budget past the predecessor's
// shutdown hard deadline. When the deadline fires, the forced exit (marker
// removal, exit banner, os.Exit) and the kernel dropping the advisory lock are
// all bounded and fast — the slack only covers the scheduling tail.
const gpuRelaunchHandoverMargin = 10 * time.Second

const (
	// gpuWatchdogScanInterval is how often the fresh stderr tail is rescanned
	// after the immediate first scan (the scanner fires one check as soon as
	// the frontend DOM is ready). The DMABUF failure prints at the webview's
	// first paint — before DomReady — so the first scan almost always decides;
	// the ticker only covers a signature printed mid-load.
	gpuWatchdogScanInterval = 2 * time.Second
	// gpuWatchdogScanWindow bounds the detection to startup. The grey window
	// is a buffer-allocation failure at renderer init — it does not appear
	// minutes into a session — and an unbounded scan would risk a hostile
	// self-relaunch while the user works (see specs/domains/webview-gpu-policy.md).
	gpuWatchdogScanWindow = 30 * time.Second
	// gpuWatchdogMaxTailBytes caps how much of the stderr tail is scanned per
	// check. The failure signatures sit at the very start of this run's
	// output; the cap only bounds pathological log growth before DomReady.
	gpuWatchdogMaxTailBytes = int64(1 << 20)
	// gpuRelaunchLockPollInterval is the poll period of the relaunched
	// child's wait for the previous instance's advisory lock.
	gpuRelaunchLockPollInterval = 100 * time.Millisecond
)

// gpuDmabufFailureSignatures are the stderr markers of the NVIDIA
// GBM/DMABUF grey-window failure class (wails#2977, c0wrk issue #34):
// WebKit's EGL image allocation failure and the NVIDIA GEM allocation
// error quoted in the reports, plus the GBM buffer allocation failure
// observed live on webkit2gtk 2.54 + NVIDIA 615 (the same class — the
// window renders, then goes grey). Substring matches against this run's
// captured stderr tail; extend the list as further failure wording is
// reported — a miss leaves the grey window up (recoverable via Settings),
// a false match only falls back to software rendering (also recoverable).
var gpuDmabufFailureSignatures = []string{
	"Failed to create EGL images for DMABufs",
	"DRM_IOCTL_NVIDIA_GEM_ALLOC_NVKMS_MEMORY failed",
	"Failed to create GBM buffer",
}

// GpuRelaunchHandoverBudget sizes the relaunched child's pre-startup wait for
// the predecessor's exit. It must cover the predecessor's worst LEGITIMATE
// teardown — bounded by the shutdown hard deadline (shutdown_watchdog.go: up
// to ~46 s embedded-LLM stop, 66 s cumulative default, operator-raisable) —
// because a child that gives up waiting early enters Wails startup, relays its
// launch to the still-quitting instance, and exits: a one-shot relay that
// loses the replacement window entirely. A deadline ≤ 0 (unset) resolves to
// the built-in default.
func GpuRelaunchHandoverBudget(shutdownDeadline time.Duration) time.Duration {
	if shutdownDeadline <= 0 {
		shutdownDeadline = defaultShutdownHardDeadline
	}
	return shutdownDeadline + gpuRelaunchHandoverMargin
}

// WaitForGpuRelaunchHandover is the relaunched child's pre-startup handover
// (issue #34): it waits up to budget for the dying instance's advisory
// single-instance lock to release — proof the predecessor has exited, since
// the kernel drops the lock on every exit path. nil means the child may start.
//
// A budget expiry returns an ERROR the caller must treat as terminal. Unlike
// the old fail-open 15 s wait, proceeding into Wails startup while the
// predecessor still holds the lock would make this process a one-shot relay
// (Wails forwards its launch data to the quitting instance and exits it), and
// with the predecessor gone moments later no window remains at all — the
// persisted fallback would only help a manual restart. Failing loudly keeps
// that failure visible and bounded.
func WaitForGpuRelaunchHandover(lockPath string, budget time.Duration, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	logger.Info("GPU-fallback relaunch: waiting for the previous instance to exit before starting up",
		"lock", lockPath, "budget", budget.String())
	if WaitForInstanceLockRelease(lockPath, budget) {
		return nil
	}
	return fmt.Errorf("GPU-fallback relaunch handover: the previous instance still holds the single-instance lock after %s", budget)
}

// webviewGpuWatchdog detects a DMABUF renderer failure at startup while auto
// mode resolved to the accelerated policy, persists an auto-fallback to
// never, and relaunches the app so the fresh instance starts on the safe
// policy. Detection covers FRESH auto only — an explicit user choice (setting
// or env) is never second-guessed, and an instance that already fell back has
// nothing left to detect. The fresh-auto condition is re-checked under the
// RMW lock at write time: a Settings choice landing inside the detection
// window suppresses the fallback record (the relaunch still runs — the
// explicit choice applies on the fresh instance).
type webviewGpuWatchdog struct {
	agentDir    string
	logger      *slog.Logger
	stderrPath  string
	startOffset int64
	started     atomic.Bool

	// Seams for tests; nil means the production implementation.
	scanTailFn func(path string, offset int64) []string
	updateFn   func(mutate func(*backend.WebviewGpuState)) error
	relaunchFn func(logger *slog.Logger) error
	nowFn      func() time.Time
	quitFn     func()
}

// NewWebviewGpuWatchdog arms the watchdog for this launch, or returns nil
// when detection does not apply: non-Linux, an explicit setting, an active
// fallback, an explicit env override, an unusable stderr capture (there is
// nothing to scan — the same fact DeriveWebviewGpuRun demotes fresh auto
// with), or any already-safe resolution. Must be called after crashlog.Install
// (the offset snapshot below only makes sense once fd 1/2 are redirected) and
// before wails.Run (the webview must not render before the offset is taken).
func NewWebviewGpuWatchdog(agentDir, logDir string, stderrObserved bool, logger *slog.Logger) *webviewGpuWatchdog {
	return newWebviewGpuWatchdog(runtime.GOOS, os.Getenv(backend.WebviewGpuPolicyEnvVar), agentDir, logDir, stderrObserved, logger)
}

func newWebviewGpuWatchdog(goos, envRaw, agentDir, logDir string, stderrObserved bool, logger *slog.Logger) *webviewGpuWatchdog {
	if goos != "linux" {
		return nil
	}
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	if !stderrObserved {
		// Without the capture there is nothing to scan: detection could never
		// fire. The launch-policy resolution has already pinned fresh auto to
		// never for the same reason — arming would be dead weight.
		logger.Debug("webview GPU watchdog disarmed: no usable stderr capture",
			"stderr", crashlog.StderrLogPath(logDir))
		return nil
	}
	state := backend.LoadWebviewGpuState(agentDir, logger)
	if state.Setting() != backend.WebviewGpuPolicyAuto || state.FallbackActive() {
		logger.Debug("webview GPU watchdog disarmed: detection covers fresh auto only",
			"setting", state.Setting(), "fallback", state.FallbackActive())
		return nil
	}
	// An explicit env override is an explicit choice: never second-guessed.
	// An invalid value falls through to auto and stays armed.
	if strings.TrimSpace(envRaw) != "" {
		if _, err := backend.NormalizeWebviewGpuPolicy(envRaw); err == nil {
			logger.Debug("webview GPU watchdog disarmed: explicit env override",
				"env", backend.WebviewGpuPolicyEnvVar, "value", strings.TrimSpace(envRaw))
			return nil
		}
	}
	w := &webviewGpuWatchdog{
		agentDir:   agentDir,
		logger:     logger,
		stderrPath: crashlog.StderrLogPath(logDir),
	}
	// Snapshot the capture size: everything appended after this point is
	// this run's output (stderr.log is append-only; rotation happens only at
	// install time, which has already run).
	if info, err := os.Stat(w.stderrPath); err == nil {
		w.startOffset = info.Size()
	}
	logger.Debug("webview GPU watchdog armed",
		"stderr", w.stderrPath, "start_offset", w.startOffset)
	return w
}

// start runs the bounded startup scan. Idempotent: DomReady fires again on
// every frontend reload, and a second scanner would only double-scan.
func (w *webviewGpuWatchdog) start() {
	if w == nil || !w.started.CompareAndSwap(false, true) {
		return
	}
	go func() {
		// First scan fires immediately, before the first tick: the DMABUF
		// failure prints at the webview's first paint, which precedes
		// DomReady, so the tail already carries the signature when the
		// scanner opens. Waiting for the ticker would add a full
		// gpuWatchdogScanInterval of grey window to every fallback relaunch
		// (observed: detection at DomReady+2s with the signature sitting in
		// the tail the whole time).
		if w.check() {
			return
		}
		ticker := time.NewTicker(gpuWatchdogScanInterval)
		defer ticker.Stop()
		deadline := time.After(gpuWatchdogScanWindow)
		for {
			select {
			case <-ticker.C:
				if w.check() {
					return
				}
			case <-deadline:
				w.logger.Debug("webview GPU watchdog disarmed: no DMABUF failure within the startup window",
					"window", gpuWatchdogScanWindow.String())
				return
			}
		}
	}()
}

// check scans this run's stderr tail once. It returns true when the watchdog
// has decided (failure detected and the fallback flow ran, or a terminal
// error made further scans pointless) and false when the scan found nothing
// and the window stays open.
func (w *webviewGpuWatchdog) check() bool {
	matched := w.scanTail()
	if len(matched) == 0 {
		return false
	}
	w.logger.Warn("webview GPU fallback: DMABUF renderer failure detected; pinning auto to software rendering",
		"signatures", matched, "stderr", w.stderrPath)

	// Persist BEFORE relaunching: the fallback record is what makes the
	// fresh instance resolve auto to never. A failed persist must not
	// relaunch — the fresh instance would resolve the accelerated policy
	// again and grey-window in a loop. The load-modify-save runs under
	// backend's webview_state RMW lock, so a user choice landing
	// concurrently (Settings RPC) can neither be clobbered by this write
	// nor wipe the fallback before it lands.
	detectedAt := w.now().UTC().Format(time.RFC3339)
	skipFallback := false
	if err := w.updateState(func(state *backend.WebviewGpuState) {
		// Re-check fresh-auto under the RMW lock: the arm-time snapshot may
		// be stale — a Settings choice can land inside the detection window.
		// The user's explicit choice rules: writing the fallback anyway would
		// create an inert record ResolveWebviewGpuPolicy ignores while the UI
		// keeps showing the auto-disabled banner. The relaunch below still
		// runs either way — this instance is stuck on the failed accelerated
		// resolution, and the fresh one applies the explicit setting (its own
		// watchdog disarms for a non-auto setting, so there is no loop).
		if state.Setting() != backend.WebviewGpuPolicyAuto {
			skipFallback = true
			return
		}
		state.AutoFallback = &backend.WebviewGpuAutoFallback{
			Policy:     backend.WebviewGpuPolicyNever,
			Reason:     backend.GpuFallbackReasonDmabufFailure,
			DetectedAt: detectedAt,
		}
	}); err != nil {
		w.logger.Error("webview GPU fallback: persisting fallback state failed; NOT relaunching "+
			"(the relaunched instance would resolve the accelerated policy again)",
			"error", err)
		return true
	}
	if err := w.relaunch(); err != nil {
		// Keep this instance alive rather than killing the session over a
		// spawn failure: with the fallback persisted the next start is safe,
		// and with the explicit setting the fresh start applies it — the
		// current window may stay blank until a manual restart either way.
		if skipFallback {
			w.logger.Error("webview GPU fallback: relaunch failed; restart manually to apply the explicit setting",
				"error", err)
		} else {
			w.logger.Error("webview GPU fallback: relaunch failed; the fallback applies on the next start",
				"error", err)
		}
		return true
	}
	if skipFallback {
		w.logger.Info("webview GPU fallback: the setting left auto during detection; relaunching on the user's explicit choice",
			"reason", backend.GpuFallbackReasonDmabufFailure)
	} else {
		w.logger.Info("webview GPU fallback: relaunching with software rendering",
			"reason", backend.GpuFallbackReasonDmabufFailure)
	}
	w.quit()
	return true
}

func (w *webviewGpuWatchdog) scanTail() []string {
	if w.scanTailFn != nil {
		return w.scanTailFn(w.stderrPath, w.startOffset)
	}
	return scanStderrTail(w.stderrPath, w.startOffset)
}

// updateState persists the fallback record through backend's serialized
// webview-state update: the whole load-modify-save cycle is atomic with
// respect to the Settings RPC's SetWebviewGpuPolicy (both writers rewrite the
// whole file — see backend.UpdateWebviewGpuState).
func (w *webviewGpuWatchdog) updateState(mutate func(*backend.WebviewGpuState)) error {
	if w.updateFn != nil {
		return w.updateFn(mutate)
	}
	return backend.UpdateWebviewGpuState(w.agentDir, w.logger, mutate)
}

func (w *webviewGpuWatchdog) relaunch() error {
	if w.relaunchFn != nil {
		return w.relaunchFn(w.logger)
	}
	return relaunchDetachedSelf(w.logger)
}

func (w *webviewGpuWatchdog) now() time.Time {
	if w.nowFn != nil {
		return w.nowFn()
	}
	return time.Now()
}

func (w *webviewGpuWatchdog) quit() {
	if w.quitFn != nil {
		w.quitFn()
	}
}

// scanStderrTail reads at most gpuWatchdogMaxTailBytes of stderrPath
// starting at startOffset (this run's first byte) and returns the failure
// signatures it contains. Read errors, a missing capture file, and a
// not-yet-grown tail all return nil — a missing capture disarms detection
// for the run rather than failing it.
func scanStderrTail(path string, startOffset int64) []string {
	file, err := safeio.OpenFileNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		return nil
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || info.Size() <= startOffset {
		return nil
	}
	if _, err := file.Seek(startOffset, io.SeekStart); err != nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(file, gpuWatchdogMaxTailBytes))
	if err != nil {
		return nil
	}
	var matched []string
	for _, sig := range gpuDmabufFailureSignatures {
		if bytes.Contains(data, []byte(sig)) {
			matched = append(matched, sig)
		}
	}
	return matched
}
