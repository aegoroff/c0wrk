package main

import (
	"embed"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime/debug"
	"time"

	"github.com/wailsapp/wails/v2"
	wailslogger "github.com/wailsapp/wails/v2/pkg/logger"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/backend/crashlog"
	"github.com/v0lka/c0wrk/core/cli"
	"github.com/v0lka/c0wrk/core/updater"
	"github.com/v0lka/c0wrk/desktop"
)

//go:embed all:frontend/dist
var assets embed.FS

// activeCapture holds the process-wide crash capture installed by mainImpl.
// Package-level (not returned) because main() must reach it after mainImpl
// returns to log the exit code. Nil-tolerant methods make the zero state
// (capture disabled or failed) safe.
var activeCapture *crashlog.Capture

func main() {
	code := mainImpl()
	activeCapture.LogExit(code)
	os.Exit(code)
}

// gpuRelaunchHandoverBudget resolves the relaunched child's handover budget
// from the CONFIGURED shutdown deadline — the same config.yaml the quitting
// instance read — so the child waits exactly as long as the predecessor is
// legitimately allowed to tear down (plus margin). The load is best-effort
// and read-only: a missing file (pristine install) or an unreadable one
// falls back to the built-in default deadline.
func gpuRelaunchHandoverBudget(agentDir string) time.Duration {
	budget := desktop.GpuRelaunchHandoverBudget(desktop.EffectiveShutdownDeadline(0))
	cfg, err := config.Load(config.ConfigPath(agentDir))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			slog.Warn("GPU-fallback relaunch: config unreadable; handover budget sized from the default shutdown deadline", "error", err)
		}
		return budget
	}
	return desktop.GpuRelaunchHandoverBudget(desktop.EffectiveShutdownDeadline(cfg.Shutdown.HardDeadline))
}

func mainImpl() int {
	// The command line is parsed exactly once, here, before anything else in
	// the process runs. The ordering is load-bearing: (a) a parse error, -h or
	// -v must reach the REAL stdout/stderr — crashlog.Install below redirects
	// fd 1/2 into <logDir>/stderr.log, and usage output buried in a log file
	// is invisible to the user; (b) a diagnostic exit must not touch app state
	// at all — in particular it happens before AcquireSingleInstanceLock
	// (ADR-075), since a mistyped flag is not a competing app instance; and
	// (c) the self-update re-exec path must NOT start the Wails lifecycle:
	// this process is the staging updater — it waits for the parent PID to
	// exit, swaps the install tree, relaunches the new app, and exits.
	req, parseErr := cli.Parse(os.Args[1:])
	if parseErr != nil {
		fmt.Fprintf(os.Stderr, "c0wrk: %v\n", parseErr)
		cli.PrintHelp(os.Stderr)
		return 2
	}
	switch req.Action {
	case cli.ActionHelp:
		cli.PrintHelp(os.Stdout)
		return 0
	case cli.ActionVersion:
		cli.PrintVersion(os.Stdout)
		return 0
	case cli.ActionSelfUpdate:
		if applyErr := updater.ApplySelfUpdate(*req.SelfUpdate, slog.Default()); applyErr != nil {
			fmt.Fprintf(os.Stderr, "c0wrk self-update failed: %v\n", applyErr)
			return 1
		}
		return 0
	}

	// Normal startup: reap any orphaned updater artifacts left by a previous
	// update (notably Windows, where a running updater .exe cannot self-delete).
	// This MUST happen only after the single-instance gate below and only in
	// the owning instance: the reap os.RemoveAll's every c0wrk-update-* /
	// c0wrk-extract-* staging in os.TempDir() older than the 24 h staleness
	// bound (updater.cleanupStaleMaxAge), so the fresh staging of an in-flight
	// self-update is never touched — but keeping the sweep behind the gate
	// still means only the owning instance ever destroys temp artifacts, and
	// a transient second launch can never race a mid-flight relaunch's use of
	// its staging (review finding #37).

	// Top-level panic recovery captures any unrecovered panic in the
	// main goroutine (e.g. a nil dereference in a goroutine without its
	// own recover). Logs the stack trace to the default logger and the
	// wails.log file before the process exits.
	defer func() {
		if r := recover(); r != nil {
			slog.Error("unrecovered panic in main goroutine",
				"panic", r,
				"stack", string(debug.Stack()),
			)
			panic(r) // re-panic to preserve default crash behavior after logging
		}
	}()

	agentDir := config.AgentDir()
	logDir := config.LogsDir(agentDir)

	// GPU-fallback relaunch ordering (issue #34): a watchdog-relaunched
	// instance carries C0WRK_GPU_RELAUNCH_WAIT_LOCK=1 and waits for the
	// quitting instance's advisory lock to release before starting up, so
	// the previous instance's spawn-then-quit cannot race the fresh instance
	// into the Wails single-instance relay (which would exit it). The wait
	// budget covers the predecessor's worst legitimate teardown (its shutdown
	// hard deadline — up to the ~46 s embedded-LLM stop — plus margin); a
	// failed wait is TERMINAL: entering Wails startup anyway would relay this
	// process's launch to the still-quitting instance and exit it, losing the
	// replacement window entirely (the persisted fallback only helps a manual
	// restart then).
	if os.Getenv(desktop.GpuRelaunchWaitEnvVar) == "1" {
		_ = os.Unsetenv(desktop.GpuRelaunchWaitEnvVar)
		if err := desktop.WaitForGpuRelaunchHandover(config.SingleInstanceLockPath(agentDir), gpuRelaunchHandoverBudget(agentDir), slog.Default()); err != nil {
			slog.Error("GPU-fallback relaunch: not starting after the failed handover "+
				"(the fallback is persisted; the next manual start applies it)", "error", err)
			return 1
		}
	}

	// Single-instance gate (issue #98, ADR-075): take the app-level lock
	// BEFORE any shared state is touched. A second process (on macOS,
	// LaunchServices activating the app from a delivered notification banner
	// whose bundle registration no longer matches the running process — a
	// rebuilt .app or an updater-swapped install tree) must stay read-only
	// toward ~/.c0wrk from here on: most importantly it must not install the
	// crash capture below, whose liveness-marker stash would overwrite the
	// running instance's forensics and leave an orphaned marker that the next
	// start misreports as an unclean shutdown. The lock is advisory only —
	// actual enforcement (relay to the first instance + early exit) is the
	// Wails SingleInstanceLock option wired into wails.Run below. Setup
	// failures fail open to "first instance": a wedged lock file must never
	// brick startup, and the Wails lock still enforces single instance.
	instanceLock, firstInstance, lockErr := desktop.AcquireSingleInstanceLock(config.SingleInstanceLockPath(agentDir))
	if lockErr != nil {
		slog.Warn("single-instance lock file unavailable; crash-capture forensics ungated for this run",
			"error", lockErr)
	}
	// Held for the process lifetime: closing it would release the lock (and
	// an unreachable os.File is closed by its finalizer under GC), so the
	// defer both pins it and releases it on the one clean-return path. The
	// second instance never returns from wails.Run (it exits inside the
	// Wails single-instance relay), where the OS drops the lock anyway.
	defer func() { _ = instanceLock.Close() }()

	// Reap orphaned updater artifacts (see the comment above): only now that
	// the app-level lock is held, and only in the first instance — the exact
	// gate the crash capture below uses — so a transient second launch can
	// never reap a live self-update's staging.
	if firstInstance {
		updater.CleanupStaleUpdaters(slog.Default())
	}

	// Arm crash capture before anything else can fail: fd 1/2 are redirected
	// into <logDir>/stderr.log so Go runtime panic dumps, native-library
	// errors and termination signals are persisted even when launched from
	// Finder. C0WRK_DISABLE_CRASH_CAPTURE=1 opts out (useful under `wails
	// dev` to keep live console output). The exact value is compared so a
	// stray "0"/"false" cannot silently disable capture. A second instance
	// skips installation entirely: it lives only long enough to relay its
	// launch data and exit, and its marker writes would poison the first
	// instance's crash forensics (see the gate above and ADR-075).
	//
	// The outcome also decides this launch's webview GPU resolution: the
	// DMABUF watchdog detects the grey-window failure ONLY through the
	// captured stderr, so an unobserved run must not apply the accelerated
	// fresh-auto default (backend.DeriveWebviewGpuRun demotes it to never —
	// review finding #155.2). An intentional C0WRK_DISABLE_CRASH_CAPTURE=1
	// opts out of recovery the same way; an explicit policy override (env or
	// Settings) is never demoted.
	var stderrObserved bool
	if os.Getenv("C0WRK_DISABLE_CRASH_CAPTURE") != "1" && firstInstance {
		capture, err := crashlog.Install(logDir)
		if err != nil {
			slog.Warn("crash capture unavailable; panics may leave no trace and the webview GPU watchdog cannot observe this run", "error", err)
		} else {
			activeCapture = capture
			stderrObserved = true
		}
	}

	wlog, wlogErr := desktop.NewWailsLogger(logDir)
	if wlogErr != nil {
		slog.Warn("failed to create wails log file, Wails errors may be lost", "error", wlogErr)
	}
	// Wails substitutes its default logger only when options.Logger is a nil
	// INTERFACE (options.MergeDefaults: `if appoptions.Logger == nil`). wlog
	// is a concrete *wailsLogAdapter, so a plain `Logger: wlog` would store a
	// typed-nil inside a non-nil interface, defeat the guard, and panic on the
	// first Wails log call (nil receiver deref in the adapter). Convert the
	// failure to a genuine nil interface so Wails' default logger takes over.
	var wailsLogger wailslogger.Logger
	if wlog != nil {
		wailsLogger = wlog
	}

	app := desktop.NewApp()
	app.SetWailsLogger(wlog)
	// Record the stderr-observation outcome BEFORE the startup phases read it:
	// the FrontendAPI init derives the Settings RPC's running-policy snapshot
	// from the same fact the wails.Run options below consume.
	app.SetWebviewGpuStderrObserved(stderrObserved)
	// Next-start post-mortem: a previous fresh-auto run that GDK killed on a
	// fatal Wayland protocol error never reached the watchdog's DomReady
	// scan; persist the fallback now, before the policy below is resolved.
	desktop.ApplyWebviewGpuCrashFallback(agentDir, logDir, stderrObserved, slog.Default())
	// NVIDIA Wayland explicit sync breaks GTK3's mixed GL/shm surface under
	// the accelerated policy (fatal protocol error before DomReady); must be
	// set before wails.Run initializes GTK/EGL.
	desktop.ApplyNvidiaExplicitSyncWorkaround(slog.Default())
	// Arm the Linux DMABUF-failure watchdog (issue #34) after crash capture —
	// the stderr offset snapshot only makes sense once fd 1/2 are redirected —
	// and before wails.Run, whose webview must not render first. Nil off Linux
	// and whenever detection does not apply (explicit policy choice, active
	// fallback, no usable capture, already-safe resolution).
	app.SetWebviewGpuWatchdog(desktop.NewWebviewGpuWatchdog(agentDir, logDir, stderrObserved, slog.Default()))

	// Restore the persisted window size (written on resize/shutdown) so the
	// app reopens at the size the user left it. On first run (no state file)
	// this returns the built-in 1400x900 default. The maximized flag is
	// re-applied in Startup once the Wails context exists.
	windowBounds := desktop.LoadWindowBounds(agentDir)

	runErr := wails.Run(&options.App{
		Title:            "c0wrk",
		Width:            windowBounds.Width,
		Height:           windowBounds.Height,
		MinWidth:         1024,
		MinHeight:        600,
		BackgroundColour: options.NewRGB(40, 44, 52),
		// The window is deliberately NOT created hidden. Wails applies
		// StartHidden by queueing a hide on the platform UI loop *after* the
		// webview starts loading, while OnStartup already runs concurrently on
		// its own goroutine — so a fast backend start gets its WindowShow calls
		// queued ahead of that hide, the hide executes last, and the window
		// stays withdrawn for the life of the process. Starting visible removes
		// the race: the window is mapped synchronously by Wails before its UI
		// loop begins. Nothing is lost — desktop/startup_phases.go revealed the
		// window unconditionally within a millisecond of startup anyway.
		AssetServer: &assetserver.Options{
			Assets: assets,
			// Strict CSP on every asset response (production builds only —
			// the dev variant in desktop/csp_dev.go is a no-op so it never
			// breaks the Vite/HMR pipeline). Defense in depth for injected
			// theme CSS: even a future sanitizer bypass cannot fetch anything.
			Middleware: desktop.CSPMiddleware(),
		},
		// Enable native file-drop so dragging files onto the window emits their
		// absolute paths to the frontend (files:dropped, wired in Startup via
		// wailsRuntime.OnFileDrop). DisableWebViewDrop prevents the webview
		// from navigating to/opening the dropped file — paths are delivered
		// only through the Go event, never interpreted as navigation targets.
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: true,
		},
		// Linux-only webview hardware-acceleration policy. Resolution order:
		// C0WRK_WEBVIEW_GPU_POLICY (always | on-demand | never) → the
		// persisted Settings choice (webview_state.json) → auto, which is
		// on-demand unless the failure watchdog has persisted a fallback to
		// never (the grey-window protection for wails#2977, issue #34) or
		// this run's stderr is unobservable (no capture — nothing could
		// detect a grey window, so fresh auto pins to never instead).
		// Returns nil on macOS/Windows, leaving those platforms untouched.
		Linux: desktop.WebviewGpuPolicyOptions(agentDir, stderrObserved, slog.Default()),
		// Single instance (issue #98, ADR-075): a LaunchServices-triggered
		// second open (macOS notification-banner click against a stale or
		// rebuilt bundle registration, a Finder re-open while the app runs)
		// must relay to THIS instance and exit, never boot a full second app
		// over the same SQLite DB, embedded-LLM supervisor and watchers —
		// the in-flight tasks of the first instance used to die with it.
		// The relay focuses the existing window; the notification's session
		// routing is not recoverable on this path (only the process macOS
		// attributes the click to receives it).
		SingleInstanceLock: desktop.SingleInstanceOptions(app),
		OnStartup:          app.Startup,
		OnDomReady:         app.DomReady,
		OnShutdown:         app.Shutdown,
		// Close guard: every quit path (window close button, Cmd+Q / the OS
		// quit menu, runtime.Quit — including the updater's quit) funnels
		// through this hook on all platforms. While sessions have live work
		// the hook intercepts the quit, emits app:exit_requested, and the
		// frontend shows a confirmation modal; ConfirmExit re-issues the quit
		// with a bypass flag so it goes through. See desktop/exit_guard.go.
		OnBeforeClose: app.ShouldPreventClose,
		Bind: []any{
			app,
		},
		Debug: options.Debug{
			OpenInspectorOnStartup: os.Getenv("C0WRK_DEBUG") != "",
		},
		Logger:   wailsLogger,
		LogLevel: 2, // TRACE to capture all Wails messages
	})
	if runErr != nil {
		slog.Error("failed to start Wails application", "error", runErr)
	}
	if wlog != nil {
		_ = wlog.Close()
	}
	// Clean-exit point for the liveness marker: reached on every normal
	// return (graceful quit, wails.Run error). A panic escaping mainImpl
	// skips this — deliberately, so the next start reports the crash.
	activeCapture.RemoveMarker()
	if runErr != nil {
		return 1
	}
	return 0
}
