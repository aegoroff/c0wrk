package desktop

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend"
	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/backend/crashlog"
	"github.com/v0lka/c0wrk/backend/session"
)

func TestScanStderrTailHonorsOffset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "stderr.log")
	// Pre-existing content carries the signature too — only bytes after the
	// offset (this run's output) may trigger detection.
	if err := os.WriteFile(path, []byte("old run: Failed to create EGL images for DMABufs\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := f.WriteString("new run: clean output\n"); err != nil {
		t.Fatalf("append: %v", err)
	}
	_ = f.Close()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}

	// Offset 0 (no snapshot): the stale signature IS matched — the arm-time
	// snapshot is what protects against it.
	if got := scanStderrTail(path, 0); len(got) != 1 {
		t.Fatalf("offset 0: want 1 signature, got %v", got)
	}
	// Offset = file size at arm time: the stale signature is skipped.
	if got := scanStderrTail(path, info.Size()); len(got) != 0 {
		t.Fatalf("arm-time offset: want no signatures, got %v", got)
	}
}

func TestScanStderrTailMatchesSignatures(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "stderr.log")
	cases := []struct {
		name    string
		content string
		want    int
	}{
		{"webkit egl failure", "some prefix Failed to create EGL images for DMABufs: EINVAL\n", 1},
		{"nvidia gem failure", "NVIDIA: DRM_IOCTL_NVIDIA_GEM_ALLOC_NVKMS_MEMORY failed: Invalid argument\n", 1},
		{"gbm buffer failure (webkit 2.54 wording)", "Failed to create GBM buffer of size 1400x900: Недопустимый аргумент\n", 1},
		{"both", "Failed to create EGL images for DMABufs\nDRM_IOCTL_NVIDIA_GEM_ALLOC_NVKMS_MEMORY failed\n", 2},
		{"clean output", "Gtk-WARNING: whatever\n", 0},
		{"lookalike", "failed to create egl images for dmabufs\n", 0}, // case-sensitive on purpose
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(tc.content), 0o600); err != nil {
				t.Fatalf("write: %v", err)
			}
			got := scanStderrTail(path, 0)
			if len(got) != tc.want {
				t.Fatalf("want %d signatures, got %v", tc.want, got)
			}
		})
	}
}

func TestScanStderrTailMissingFileAndTailCap(t *testing.T) {
	// Missing capture: detection silently disarms for the run.
	if got := scanStderrTail(filepath.Join(t.TempDir(), "absent.log"), 0); got != nil {
		t.Fatalf("missing file: want nil, got %v", got)
	}

	// A signature beyond the tail cap is not scanned: the cap bounds
	// pathological growth, and first-paint failures sit at the tail start.
	dir := t.TempDir()
	path := filepath.Join(dir, "stderr.log")
	payload := strings.Repeat("x", int(gpuWatchdogMaxTailBytes)) + "\nFailed to create EGL images for DMABufs\n"
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := scanStderrTail(path, 0); len(got) != 0 {
		t.Fatalf("signature beyond the cap: want nil, got %v", got)
	}
}

// newTestWatchdog builds a fully seam-injected watchdog recording the order
// of persist → relaunch → quit in events.
func newTestWatchdog(t *testing.T, matched []string, persistErr, relaunchErr error) (*webviewGpuWatchdog, *[]string, *backend.WebviewGpuState) {
	t.Helper()
	var events []string
	// Seed the persisted state the way a real load would (fresh auto), then
	// let the watchdog's mutate land on it — mirroring the production
	// load-modify-save inside backend.UpdateWebviewGpuState.
	persisted := backend.WebviewGpuState{GPUPolicy: backend.WebviewGpuPolicyAuto}
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	w := &webviewGpuWatchdog{
		agentDir:   t.TempDir(),
		logger:     slog.New(slog.DiscardHandler),
		stderrPath: filepath.Join(t.TempDir(), "stderr.log"),
		nowFn:      func() time.Time { return now },
		scanTailFn: func(string, int64) []string { return matched },
		updateFn: func(mutate func(*backend.WebviewGpuState)) error {
			events = append(events, "persist")
			mutate(&persisted)
			return persistErr
		},
		relaunchFn: func(*slog.Logger) error {
			events = append(events, "relaunch")
			return relaunchErr
		},
		quitFn: func() { events = append(events, "quit") },
	}
	return w, &events, &persisted
}

func TestWatchdogCheckDetectsPersistsRelaunchesQuits(t *testing.T) {
	w, events, persisted := newTestWatchdog(t,
		[]string{"Failed to create EGL images for DMABufs"}, nil, nil)

	if !w.check() {
		t.Fatal("check = false, want true (decision made)")
	}
	if want := []string{"persist", "relaunch", "quit"}; strings.Join(*events, ",") != strings.Join(want, ",") {
		t.Fatalf("event order = %v, want %v", *events, want)
	}
	if persisted.AutoFallback == nil {
		t.Fatal("no fallback persisted")
	}
	if persisted.AutoFallback.Policy != backend.WebviewGpuPolicyNever {
		t.Errorf("fallback policy = %q, want never", persisted.AutoFallback.Policy)
	}
	if persisted.AutoFallback.Reason != backend.GpuFallbackReasonDmabufFailure {
		t.Errorf("fallback reason = %q, want %q", persisted.AutoFallback.Reason, backend.GpuFallbackReasonDmabufFailure)
	}
	if persisted.AutoFallback.DetectedAt != "2026-10-15T12:00:00Z" {
		t.Errorf("detected_at = %q, want the injected now in UTC RFC3339", persisted.AutoFallback.DetectedAt)
	}
}

func TestWatchdogCheckNoMatchKeepsWindowOpen(t *testing.T) {
	w, events, _ := newTestWatchdog(t, nil, nil, nil)
	if w.check() {
		t.Fatal("check = true on a clean tail, want false")
	}
	if len(*events) != 0 {
		t.Fatalf("events = %v, want none", *events)
	}
}

func TestWatchdogCheckPersistFailureNeverRelaunches(t *testing.T) {
	w, events, _ := newTestWatchdog(t,
		[]string{"DRM_IOCTL_NVIDIA_GEM_ALLOC_NVKMS_MEMORY failed"}, errors.New("disk full"), nil)

	// Without the persisted fallback the relaunched instance would resolve
	// the accelerated policy again and grey-window in a loop — relaunching is
	// forbidden on persist failure.
	if !w.check() {
		t.Fatal("check = false, want true (terminal decision)")
	}
	if strings.Join(*events, ",") != "persist" {
		t.Fatalf("events = %v, want [persist] only", *events)
	}
}

func TestWatchdogCheckRelaunchFailureKeepsRunning(t *testing.T) {
	w, events, _ := newTestWatchdog(t,
		[]string{"Failed to create EGL images for DMABufs"}, nil, errors.New("spawn failed"))

	// The fallback IS persisted; only the quit is withheld so the user keeps
	// a live (albeit blank) session and the next start is safe.
	if !w.check() {
		t.Fatal("check = false, want true (terminal decision)")
	}
	if strings.Join(*events, ",") != "persist,relaunch" {
		t.Fatalf("events = %v, want [persist relaunch]", *events)
	}
}

func TestWatchdogCheckSkipsFallbackForExplicitSetting(t *testing.T) {
	w, events, persisted := newTestWatchdog(t,
		[]string{"Failed to create EGL images for DMABufs"}, nil, nil)
	// A Settings write landed inside the detection window: the state the
	// mutate observes under the RMW lock is no longer auto. Writing the
	// fallback anyway would create an inert record the resolver ignores
	// while the UI keeps showing the auto-disabled banner.
	*persisted = backend.WebviewGpuState{GPUPolicy: backend.WebviewGpuPolicyNever}

	if !w.check() {
		t.Fatal("check = false, want true (decision made)")
	}
	// persist → relaunch → quit: the running instance is stuck on the failed
	// accelerated resolution, and the fresh one applies the explicit setting
	// (its own watchdog disarms for a non-auto setting — no relaunch loop).
	if want := []string{"persist", "relaunch", "quit"}; strings.Join(*events, ",") != strings.Join(want, ",") {
		t.Fatalf("event order = %v, want %v", *events, want)
	}
	if persisted.AutoFallback != nil {
		t.Fatalf("an inert fallback record was written despite the explicit setting: %+v", persisted.AutoFallback)
	}
}

// dmabufFallbackFixture mirrors the watchdog's fallback record shape.
func dmabufFallbackFixture() *backend.WebviewGpuAutoFallback {
	return &backend.WebviewGpuAutoFallback{
		Policy:     backend.WebviewGpuPolicyNever,
		Reason:     backend.GpuFallbackReasonDmabufFailure,
		DetectedAt: "2026-10-15T00:00:00Z",
	}
}

// TestWatchdogStartScansImmediately pins the immediate first scan: the
// scanner goroutine must check the tail as it opens, not wait out the first
// gpuWatchdogScanInterval tick. The failure signature prints at the webview's
// first paint — before DomReady — so every tick of delay is grey window on
// the fallback relaunch path. The 1s bound is deliberately below the 2s tick:
// a scan that only fired from the ticker could not arrive inside it.
func TestWatchdogStartScansImmediately(t *testing.T) {
	scanned := make(chan struct{}, 1)
	w := &webviewGpuWatchdog{
		agentDir:   t.TempDir(),
		logger:     slog.New(slog.DiscardHandler),
		stderrPath: filepath.Join(t.TempDir(), "stderr.log"),
		scanTailFn: func(string, int64) []string {
			select {
			case scanned <- struct{}{}:
			default:
			}
			return nil
		},
	}
	w.start()

	select {
	case <-scanned:
	case <-time.After(1 * time.Second):
		t.Fatal("the scanner's first scan did not fire immediately on start")
	}
}

// TestWatchdogStartFirstScanDecidesWithoutTick pins the full decision flow on
// the immediate first scan: a signature already in the tail (the common case
// — the failure printed before DomReady) must persist, relaunch and quit
// without waiting out a single ticker tick.
func TestWatchdogStartFirstScanDecidesWithoutTick(t *testing.T) {
	var events []string
	record := func(e string) { events = append(events, e) }
	done := make(chan struct{})
	persisted := backend.WebviewGpuState{GPUPolicy: backend.WebviewGpuPolicyAuto}
	w := &webviewGpuWatchdog{
		agentDir:   t.TempDir(),
		logger:     slog.New(slog.DiscardHandler),
		stderrPath: filepath.Join(t.TempDir(), "stderr.log"),
		nowFn:      func() time.Time { return time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC) },
		scanTailFn: func(string, int64) []string {
			return []string{"Failed to create EGL images for DMABufs"}
		},
		updateFn: func(mutate func(*backend.WebviewGpuState)) error {
			record("persist")
			mutate(&persisted)
			return nil
		},
		relaunchFn: func(*slog.Logger) error {
			record("relaunch")
			return nil
		},
		quitFn: func() {
			record("quit")
			close(done)
		},
	}
	w.start()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("the immediate first scan did not decide; events", events)
	}
	if want := []string{"persist", "relaunch", "quit"}; strings.Join(events, ",") != strings.Join(want, ",") {
		t.Fatalf("event order = %v, want %v", events, want)
	}
	if persisted.AutoFallback == nil {
		t.Fatal("no fallback persisted by the immediate first scan")
	}
}

func TestNewWebviewGpuWatchdogArming(t *testing.T) {
	logger := slog.New(slog.DiscardHandler)
	agentDir := t.TempDir()
	logDir := t.TempDir()
	stderrPath := crashlog.StderrLogPath(logDir)
	if err := os.WriteFile(stderrPath, []byte("startup chatter\n"), 0o600); err != nil {
		t.Fatalf("write stderr fixture: %v", err)
	}

	writeState := func(t *testing.T, st backend.WebviewGpuState) {
		t.Helper()
		if err := backend.SaveWebviewGpuState(agentDir, st); err != nil {
			t.Fatalf("save state: %v", err)
		}
	}

	t.Run("fresh auto arms with the stderr offset", func(t *testing.T) {
		w := newWebviewGpuWatchdog("linux", "", agentDir, logDir, logger)
		if w == nil {
			t.Fatal("expected armed watchdog for fresh auto")
		}
		if w.stderrPath != stderrPath {
			t.Errorf("stderrPath = %q, want %q", w.stderrPath, stderrPath)
		}
		if w.startOffset != int64(len("startup chatter\n")) {
			t.Errorf("startOffset = %d, want the pre-existing file size", w.startOffset)
		}
	})

	t.Run("active fallback disarms", func(t *testing.T) {
		writeState(t, backend.WebviewGpuState{AutoFallback: dmabufFallbackFixture()})
		if w := newWebviewGpuWatchdog("linux", "", agentDir, logDir, logger); w != nil {
			t.Fatal("expected disarmed watchdog with an active fallback")
		}
	})

	t.Run("explicit setting disarms", func(t *testing.T) {
		writeState(t, backend.WebviewGpuState{GPUPolicy: backend.WebviewGpuPolicyNever})
		if w := newWebviewGpuWatchdog("linux", "", agentDir, logDir, logger); w != nil {
			t.Fatal("expected disarmed watchdog for an explicit setting")
		}
	})

	t.Run("explicit env override disarms", func(t *testing.T) {
		writeState(t, backend.WebviewGpuState{})
		if w := newWebviewGpuWatchdog("linux", "on-demand", agentDir, logDir, logger); w != nil {
			t.Fatal("expected disarmed watchdog for an explicit env override")
		}
	})

	t.Run("invalid env stays armed", func(t *testing.T) {
		if w := newWebviewGpuWatchdog("linux", "  turbo ", agentDir, logDir, logger); w == nil {
			t.Fatal("expected armed watchdog for an invalid env value (fall-through to auto)")
		}
	})

	t.Run("non-linux never arms", func(t *testing.T) {
		writeState(t, backend.WebviewGpuState{})
		if w := newWebviewGpuWatchdog("darwin", "", agentDir, logDir, logger); w != nil {
			t.Fatal("expected nil watchdog on darwin")
		}
	})
}

func TestWaitForInstanceLockRelease(t *testing.T) {
	path := config.SingleInstanceLockPath(t.TempDir())

	// No holder: the first poll takes the (freshly created) lock.
	if !WaitForInstanceLockRelease(path, time.Second) {
		t.Fatal("expected success with no lock holder")
	}

	// A live holder blocks the wait until the bounded timeout expires.
	lock, held, err := AcquireSingleInstanceLock(path)
	if err != nil || !held {
		t.Fatalf("acquire: held=%v err=%v", held, err)
	}
	t.Cleanup(func() { _ = lock.Close() })
	if WaitForInstanceLockRelease(path, 300*time.Millisecond) {
		t.Fatal("wait succeeded while the lock was held")
	}

	// After the holder releases, the next wait succeeds.
	if err := lock.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if !WaitForInstanceLockRelease(path, time.Second) {
		t.Fatal("expected success after the holder released")
	}
}

// TestWebviewGpuWatchdogQuitBypassesCloseGuard pins the relaunch quit's
// interaction with the exit guard: the quit the watchdog issues after a
// successful relaunch must NOT be intercepted by ShouldPreventClose — the
// confirmation modal lives in the grey webview being replaced, so an
// intercepted fallback quit would strand an unanswerable dialog and cancel
// the auto-recovery. startWebviewGpuWatchdog wires w.quitFn to
// a.gpuFallbackQuit; the pre-set started flag keeps start() from spawning
// the scanner goroutine in this test.
func TestWebviewGpuWatchdogQuitBypassesCloseGuard(t *testing.T) {
	f := newExitGuardFixture([]session.ActiveSessionInfo{{ID: "sess-1"}})
	// Intercept the instance logger: the paths under test announce their
	// decisions at Info, and that output must not leak into the test run
	// (asserted below instead).
	var logs bytes.Buffer
	f.app.logger = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))

	// Without the bypass the guard intercepts (and would render the modal
	// into the webview the watchdog is about to replace).
	if !f.app.ShouldPreventClose(context.Background()) {
		t.Fatal("expected the guard to intercept a plain quit while a session is active")
	}

	w := &webviewGpuWatchdog{}
	w.started.Store(true) // start() must not spawn the scanner goroutine here
	f.app.webviewGpuWatchdog = w
	f.app.startWebviewGpuWatchdog()
	if w.quitFn == nil {
		t.Fatal("startWebviewGpuWatchdog did not wire the quit path")
	}

	w.quitFn()
	if !f.app.exitConfirmed.Load() {
		t.Error("expected the fallback quit to arm the close-guard bypass")
	}
	if f.quitCalls != 1 {
		t.Errorf("expected exactly one quit call, got %d", f.quitCalls)
	}
	if !strings.Contains(logs.String(), "webview GPU fallback: quitting for the relaunched instance") {
		t.Errorf("expected the fallback-quit Info record, got:\n%s", logs.String())
	}
	if f.app.ShouldPreventClose(context.Background()) {
		t.Error("expected the fallback quit to pass the close guard")
	}
	if len(f.emitted) != 1 {
		t.Errorf("expected no additional exit_requested events, got %v", f.emitted)
	}
}

// TestGpuFallbackQuitNoContextDoesNotArmBypass pins the guard-rail of the
// bypass invariant: without a live Wails context there is no quit, so the
// bypass flag must stay unarmed (a stale armed flag would silently disable
// the close guard for the rest of the process).
func TestGpuFallbackQuitNoContextDoesNotArmBypass(t *testing.T) {
	app := NewApp()
	quitCalls := 0
	app.quitFn = func(context.Context) { quitCalls++ }
	// The guard-rail path announces its refusal at Error — intercepted here
	// and asserted, never leaked into the test output.
	var logs bytes.Buffer
	app.logger = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))

	app.gpuFallbackQuit()

	if app.exitConfirmed.Load() {
		t.Error("the bypass flag must not be armed without a Wails context")
	}
	if quitCalls != 0 {
		t.Errorf("expected no quit call, got %d", quitCalls)
	}
	if n := strings.Count(logs.String(), "level=ERROR"); n != 1 {
		t.Errorf("expected exactly one ERROR record, got %d:\n%s", n, logs.String())
	}
	if !strings.Contains(logs.String(), "webview GPU fallback: no Wails context; cannot quit for the relaunch") {
		t.Errorf("expected the no-context refusal message, got:\n%s", logs.String())
	}
}
