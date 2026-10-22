package desktop

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/v0lka/c0wrk/backend"
	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/backend/logger"
	"github.com/v0lka/c0wrk/backend/session"
	"github.com/v0lka/c0wrk/core/markitdown"
	"github.com/v0lka/c0wrk/internal/webaccess"
)

// App holds the Wails application state and exposes methods to the frontend.
// All frontend API methods live on the embedded *backend.FrontendAPI; promoted
// methods are visible to the Wails binding generator.
// App itself retains only lifecycle management (Startup/Shutdown), the native
// PickDirectory dialog, and Wails event-listener infrastructure.
type App struct {
	ctx context.Context
	*backend.FrontendAPI

	// ── Cross-goroutine lifecycle state ─────────────────────────────────
	//
	// ctx, FrontendAPI (above), app, logger, db, sessionLogger and
	// shutdownHardDeadline are written by the Wails OnStartup goroutine while
	// Startup runs. They are read concurrently by:
	//   - the second-instance relay goroutine (Wails starts it inside
	//     NewFrontend, before the OnStartup goroutine is even spawned — so a
	//     relay delivered during this instance's own startup reads these
	//     fields with no happens-before edge to the writes), and
	//   - the Wails binding-dispatch goroutines (App methods like
	//     PickDirectory / ConfirmExit / PersistWindowBounds run there, and
	//     each promoted FrontendAPI RPC re-reads the embedded pointer), and
	//   - the close/quit path (OnBeforeClose and Shutdown run on the platform
	//     main goroutine and can fire while a first-run Startup is still
	//     mid-flight, minutes from its last field write).
	//
	// stateMu provides the happens-before edge: every write goes through a
	// set* helper that takes it for writing, and every read outside the
	// OnStartup goroutine goes through the matching accessor (Context, log,
	// application, database, sessionLog, frontendAPI, shutdownDeadline),
	// which takes it for reading. The accessors are leaf helpers — they
	// never call each other and never run caller code under the lock, so
	// the critical sections are single field loads/stores and cannot
	// deadlock. Reads on the OnStartup goroutine itself (the Startup phases)
	// are ordered by program order and do not need the lock, but they use
	// the accessors anyway so no future caller has to know which goroutine
	// it is on.
	stateMu sync.RWMutex

	// app is the central ViewModel (owns builder, manager, persister).
	// Kept here for Startup/Shutdown orchestration that references it directly.
	// Guarded by stateMu — see the block comment above.
	app *backend.Application

	// logger used during Startup before FrontendAPI is constructed.
	// Guarded by stateMu — see the block comment above.
	logger *slog.Logger

	// wailsLogger bridges Wails internal messages (including Fatal/Error)
	// to a persistent wails.log file. Once the session logger is ready,
	// messages are also duplicated to the session log.
	wailsLogger *wailsLogAdapter

	// webviewGpuWatchdog is the (Linux-only, possibly nil) DMABUF-failure
	// watchdog armed in main before wails.Run and started from DomReady.
	// Set strictly before the Wails UI loop begins, so a plain field is
	// safely published (same ordering contract as wailsLogger).
	webviewGpuWatchdog *webviewGpuWatchdog

	db *sql.DB // shared SQLite connection; opened in Startup, closed in Shutdown. Guarded by stateMu.

	// sessionLogger is stored so Shutdown can close it on early Startup exits
	// (e.g. when tool installation fails and Startup returns before
	// FrontendAPI is wired). Guarded by stateMu.
	sessionLogger *logger.SessionLogger

	// Wails event-listener infrastructure (used only in startup.go listeners)
	pendingConfirmations   sync.Map
	pendingAskUser         sync.Map
	pendingStepLimit       sync.Map
	pendingPlanApprovals   sync.Map
	pendingGoalProposals   sync.Map
	pendingGoalSuggestions sync.Map

	// judgeWG tracks in-flight runJudgeEvaluation goroutines so Shutdown can
	// wait for them before tearing down the backend application.
	judgeWG sync.WaitGroup

	// wailsEmit, when non-nil, is used in place of wailsRuntime.EventsEmit. It
	// lets tests inject a fake event sink so phase helpers can be exercised
	// without a live Wails runtime (W-19/W-23). Production wiring keeps it nil.
	wailsEmit func(eventName string, optionalData ...any)

	// eventTap, when non-nil, observes every a.emit call alongside the Wails
	// dispatch — the single, web-agnostic seam a side transport uses to
	// receive exactly the events the webview receives. It knows nothing about
	// sockets, browsers, or any concrete consumer: the mount point hands it a
	// plain func. A nil tap (the default until a side transport mounts)
	// leaves emit byte-for-byte unchanged. The tap must never block, alter,
	// or fail the emit.
	//
	// It is an atomic pointer rather than a plain field on purpose: unlike
	// wailsEmit (written only before event producers start), the web-access
	// mount registers — and hot-restart swaps — the tap from the Startup
	// goroutine AFTER buildFrontendAPI has started the session watchers and
	// the emitBackendReady dispatch, while Wails binding goroutines may
	// already be serving RPCs whose event paths read the tap. The Load/Store
	// pair is the happens-before edge that keeps the late registration and
	// the concurrent readers race-free. Set it through setEventTap.
	eventTap atomic.Pointer[func(name string, args []interface{})]

	// ── Web access sidecar (internal/webaccess, ADR-090) ─────────────────
	//
	// webAccess is the live sidecar; nil while it is not running. Atomic
	// pointer for the same reason as eventTap: startup mounts it, Shutdown
	// and SetWebAccessEnabled stop it, and GetWebAccessInfo reads it — all
	// from different goroutines (OnStartup, the platform main goroutine,
	// Wails binding dispatch). The pointer swap is the only synchronization
	// the handle needs; lifecycle TRANSITIONS are serialized by webAccessMu
	// so a toggle can never interleave with a shutdown stop.
	webAccess atomic.Pointer[webaccess.Server]

	// webAccessMu serializes sidecar lifecycle transitions (startup mount,
	// Shutdown stop, SetWebAccessEnabled toggle) so two of them can never
	// interleave into a half-torn-down server or a leaked listener. It guards
	// the start/stop critical sections only — not the handle reads, which
	// ride the atomic pointer above.
	webAccessMu sync.Mutex

	// webAccessStatic is the SPA asset tree the sidecar serves at /. Wired
	// from main.go via SetWebAccessStaticFS strictly before wails.Run begins
	// (the webviewGpuWatchdog publishing contract), so a plain field is
	// safely published. Nil (never wired — tests, a stripped embed) degrades
	// the sidecar to API+WS only: the static route 404s, everything else
	// keeps working.
	webAccessStatic fs.FS

	// liveConfig and liveConfigPath are the desktop's own handle on the live
	// config object and its on-disk path, captured in buildFrontendAPI.
	// liveConfig is the SAME pointer FrontendAPI.Init seeds (f.config =
	// cfg.Config) — the shared live config the backend mutates in place
	// under its configMu. Desktop NEVER reads or writes backend-owned
	// sections through it; it is kept solely so the desktop-owned
	// web_access section can be flipped and persisted by SetWebAccessEnabled
	// without a backend edit. Writes are serialized between themselves by
	// webAccessMu (the toggle path); a concurrent backend save can only ever
	// READ the section it persists — the one-word window this seam accepts,
	// documented at SetWebAccessEnabled. Guarded by stateMu like the rest of
	// the lifecycle state.
	liveConfig     *config.Config
	liveConfigPath string

	// batcherPtr holds the lazily-created event batcher that sits between the
	// session-event producers and the raw transport (a.emit). It coalesces
	// transient streaming events and delivers content events as one
	// c0wrk:events:batch envelope per ~16ms flush, keeping evaluateJavaScript
	// calls off the AppKit main thread's critical path. batcherOnce guards the
	// one-time construction. See event_batcher.go.
	batcherOnce sync.Once
	batcherPtr  atomic.Pointer[EventBatcher]

	// reloadAppFn, when non-nil, is used in place of wailsRuntime.WindowReloadApp
	// by (*App).reloadFrontend. Lets tests observe the deferred wake reload
	// without a live Wails runtime. Production wiring keeps it nil.
	reloadAppFn func(ctx context.Context)

	// toolsBinPath is the managed tools bin directory (e.g. ~/.c0wrk/tools/bin/),
	// set during Phase 2 and prepended to PATH so exec.CommandContext calls
	// resolve managed binaries (rg, uv, markitdown).
	toolsBinPath string

	// exitConfirmed bypasses the close guard (ShouldPreventClose) once the
	// user confirmed quitting despite active sessions. Wails routes every
	// quit path — including the runtime.Quit issued by ConfirmExit itself —
	// through OnBeforeClose, so the confirmed quit must not be intercepted
	// a second time.
	//
	// Invariant: the flag is armed only immediately before an imminent quit
	// (ConfirmExit stores it and calls wailsRuntime.Quit in the same
	// breath; the webview-GPU watchdog's post-relaunch quit does the same
	// through gpuFallbackQuit), and the platform quit paths that follow
	// cannot be cancelled by the user — so an armed flag never outlives the
	// process it was armed for, and a later guard bypass with newly active
	// sessions is impossible. Any change that makes quit cancellable after
	// arming must reset this flag on cancellation.
	exitConfirmed atomic.Bool

	// updateQuitAt records when the updater-driven quit (ApplyUpdate →
	// quitApp) was issued, so the close guard can tell the frontend that an
	// intercepted quit belongs to a pending self-update (payload flag
	// update_pending) and the confirmation modal can present restart
	// context. It is a timestamp rather than a sticky flag for honesty
	// about cancellation: the staged updater gives up once the parent
	// misses StagedUpdaterShutdownWait, so after that window a quit no
	// longer completes the update and must not be presented as one. The
	// zero value (never armed) disables the context. Accessed atomically
	// because quitApp runs on a Wails RPC goroutine while OnBeforeClose
	// runs on the main thread.
	updateQuitAt atomic.Value // time.Time

	// activeSessionsFn, when non-nil, replaces the backend active-session
	// lookup in the close guard. Lets tests exercise the guard without a
	// live backend application. Production wiring keeps it nil.
	activeSessionsFn func() []session.ActiveSessionInfo

	// quitFn, when non-nil, replaces wailsRuntime.Quit in ConfirmExit. Lets
	// tests observe the confirmed quit without a live Wails runtime.
	// Production wiring keeps it nil.
	quitFn func(ctx context.Context)

	// shutdownHardDeadline is the hard budget for the WHOLE Shutdown teardown,
	// set from config (shutdown.hardDeadline) during Startup. Zero falls back
	// to defaultShutdownHardDeadline. The shutdown watchdog (see
	// shutdown_watchdog.go) enforces it: on expiry the process logs at Error
	// and exits, so a stuck goroutine can never keep the app alive on quit.
	// Guarded by stateMu — see the block comment above.
	shutdownHardDeadline time.Duration

	// launchStderrObserved records whether this launch has a usable stderr
	// capture (main.go, from the crashlog.Install outcome). Startup hands it
	// to the FrontendAPI init so the Settings RPC's running-policy snapshot is
	// derived from the same fact the wails.Run options consumed (a fresh-auto
	// launch without observation runs never — see backend.DeriveWebviewGpuRun).
	// Zero value = unobserved: the safe direction, and the honest report for a
	// Startup that never ran. Guarded by stateMu — see the block comment above.
	launchStderrObserved bool

	// shutdownExitFn, when non-nil, replaces the forced-exit call in the
	// shutdown watchdog's expiry path. Lets tests observe the forced exit
	// without killing the test process (same purpose as quitFn / windowShowFn).
	// Production wiring keeps it nil, where the watchdog calls
	// crashlog.ForceExit(0) (marker removal + exit banner + os.Exit).
	shutdownExitFn func(code int)

	// windowGeomCache snapshots the window geometry captured from the LIVE
	// window by the close guard (OnBeforeClose → captureWindowGeometry). On
	// Linux, Wails destroys the window before the OnShutdown hook runs, so
	// Shutdown persists this snapshot instead of reading the (already
	// destroyed) window — a post-destroy read returns the creation default
	// and clobbers the value PersistWindowBounds saved on resize. Atomic
	// pointer: captured on the platform close-handler goroutine, consumed by
	// Shutdown on the main goroutine.
	windowGeomCache atomic.Pointer[WindowBounds]

	// windowGetSizeFn / windowIsMaximisedFn replace wailsRuntime.WindowGetSize
	// and wailsRuntime.WindowIsMaximised in the geometry capture/persist
	// paths (the per-call seam pattern of windowRaiseFn et al. — the runtime
	// calls fatal on a context no live runtime owns). Production keeps them
	// nil.
	windowGetSizeFn     func(ctx context.Context) (int, int)
	windowIsMaximisedFn func(ctx context.Context) bool

	// embeddedLLMStopFn, when non-nil, replaces the backend embedded-LLM
	// server stop in stopEmbeddedLLM (the Shutdown teardown of the supervised
	// llama-server). Lets tests observe that shutdown stops the model without
	// a real runtime, weights or a live Wails runtime — same purpose as quitFn
	// and windowShowFn. Production wiring keeps it nil, where the call goes to
	// FrontendAPILifecycle.StopEmbeddedLLM.
	embeddedLLMStopFn func(ctx context.Context) error

	// windowShowFn, when non-nil, replaces wailsRuntime.WindowShow in
	// showWindow — and therefore on every path that reveals the window (the
	// startup phases, OnDomReady, and the close guard). Lets tests observe
	// those paths without a live Wails runtime (wailsRuntime panics on a
	// foreign context). Production wiring keeps it nil.
	windowShowFn func(ctx context.Context)

	// windowRaiseFn / windowUnminimiseFn / windowIsMinimisedFn are the
	// per-call seams behind showWindow's platform branches (WindowShow /
	// WindowUnminimise / WindowIsMinimised). Same purpose as windowShowFn:
	// tests drive the platform activation matrix without a live runtime;
	// production keeps them nil.
	windowRaiseFn       func(ctx context.Context)
	windowUnminimiseFn  func(ctx context.Context)
	windowIsMinimisedFn func(ctx context.Context) bool

	// x11PagerActivateFn, when non-nil, replaces the Linux EWMH pager-source
	// activation attempt in showWindow's linux branch (production:
	// x11ActivateOwnWindow over a private X connection). Same purpose as the
	// per-call seams above — lets tests observe/fake the activation matrix
	// without a live X server. Production wiring keeps it nil.
	x11PagerActivateFn func() bool

	// ── System notifications (notifications.go) ────────────────────────────
	//
	// Test seams for the Wails notification runtime calls, following the
	// wailsEmit / windowShowFn / quitFn precedent: each replaces exactly one
	// wailsRuntime package function so the notification paths can be exercised
	// without a live Wails runtime (the real calls fatal on a context no
	// runtime owns). Production wiring keeps every one of them nil.

	// notificationsInitMu serializes InitNotifications: a Wails RPC goroutine
	// and an early frontend init must not interleave the initialize/register
	// steps. notificationsInitialized memoizes the successful init so a second
	// call never registers a second OnNotificationResponse callback (the Wails
	// callback slot is a single package-level variable, but replacing it would
	// also churn goroutine state for nothing). A FAILED init is not memoized —
	// the next call retries (a Linux session bus can appear later).
	notificationsInitMu      sync.Mutex
	notificationsInitialized atomic.Bool

	// onNotificationResponseFn replaces wailsRuntime.OnNotificationResponse.
	onNotificationResponseFn func(ctx context.Context, cb func(result wailsRuntime.NotificationResult))
	// notificationsInitFn replaces wailsRuntime.InitializeNotifications.
	notificationsInitFn func(ctx context.Context) error
	// notificationsAuthFn replaces wailsRuntime.RequestNotificationAuthorization.
	notificationsAuthFn func(ctx context.Context) (bool, error)
	// notificationsAuthCheckFn replaces wailsRuntime.CheckNotificationAuthorization
	// (the non-prompting read the Settings permission hint needs).
	notificationsAuthCheckFn func(ctx context.Context) (bool, error)
	// notificationsSendFn replaces wailsRuntime.SendNotification.
	notificationsSendFn func(ctx context.Context, options wailsRuntime.NotificationOptions) error
	// notificationsCleanupFn replaces wailsRuntime.CleanupNotifications.
	notificationsCleanupFn func(ctx context.Context)
	// notificationsSendViaWailsFn replaces the sendNotificationViaWails
	// fallback (the Wails transport behind the wailsRuntime.SendNotification
	// call). Lets tests observe the Linux dial-failure fallback path — the
	// real Wails call fatals on a context no live runtime owns. Production
	// wiring keeps it nil.
	notificationsSendViaWailsFn func(ctx context.Context, options wailsRuntime.NotificationOptions) error
}

// NewApp creates a new App instance.
// FrontendAPI is initialized as a non-nil zero-value so that early frontend
// RPC calls (before Startup finishes) hit the per-method nil guards and
// return proper errors instead of panicking on a nil pointer dereference.
// Startup INITIALIZES this seed IN PLACE (buildFrontendAPI → Init); the
// pointer itself is published exactly once here and never reassigned, so the
// Wails binding dispatch's per-call dereference can never race a swap
// (review finding #52).
func NewApp() *App {
	return &App{
		FrontendAPI: &backend.FrontendAPI{},
	}
}

// SetWailsLogger stores the Wails log adapter so that the session logger
// can be wired as a delegate once it is initialized in Startup.
func (a *App) SetWailsLogger(wl *wailsLogAdapter) {
	a.wailsLogger = wl
}

// SetWebviewGpuWatchdog stores the (possibly nil) DMABUF-failure watchdog
// armed in main before wails.Run. Nil off Linux and whenever detection does
// not apply (explicit choice, active fallback, safe resolution).
func (a *App) SetWebviewGpuWatchdog(w *webviewGpuWatchdog) {
	a.webviewGpuWatchdog = w
}

// SetWebviewGpuStderrObserved records whether this launch's stderr capture is
// usable (main.go, from the crashlog.Install outcome, before wails.Run).
// Startup hands the fact to the FrontendAPI init so the running-policy
// snapshot is derived from the same input as the wails.Run options — an
// unobserved fresh-auto launch runs never, and the Settings report must say
// so. Exported deliberately: internal startup plumbing rides the Wails
// binding surface by the same precedent as SetWebviewGpuWatchdog; the value
// is a boolean main computes, so a renderer-supplied call could only flip an
// already-consumed report flag, never re-resolve the running webview.
func (a *App) SetWebviewGpuStderrObserved(observed bool) {
	a.setLaunchStderrObserved(observed)
}

// startWebviewGpuWatchdog launches the bounded startup scan from DomReady —
// the DMABUF failure prints at the webview's first paint, so from here on
// this run's stderr capture contains everything the scan needs. The quit
// path is wired to the live Wails context here, where it exists.
func (a *App) startWebviewGpuWatchdog() {
	w := a.webviewGpuWatchdog
	if w == nil {
		return
	}
	if w.quitFn == nil {
		if a.wailsCtx() != nil {
			w.quitFn = a.gpuFallbackQuit
		}
	}
	w.start()
}

// gpuFallbackQuit is the webview-GPU watchdog's post-relaunch quit. It arms
// the close-guard bypass in the same breath as the quit, mirroring
// ConfirmExit: the confirmation modal lives in the very webview this
// relaunch is replacing (a grey window cannot answer it), so an intercepted
// fallback quit would leave the dying instance alive with an unanswerable
// dialog — and the sessions the guard protects are auto-resumed in the
// relaunched instance anyway.
func (a *App) gpuFallbackQuit() {
	if a.wailsCtx() == nil {
		// No live runtime: nothing to quit through, and arming the bypass
		// now would leave a stale armed flag with no quit behind it (see
		// the exitConfirmed invariant).
		a.log().Error("webview GPU fallback: no Wails context; cannot quit for the relaunch")
		return
	}
	a.exitConfirmed.Store(true)
	a.log().Info("webview GPU fallback: quitting for the relaunched instance (close-guard bypass armed)")
	if a.quitFn != nil {
		a.quitFn(a.wailsCtx())
		return
	}
	wailsRuntime.Quit(a.wailsCtx())
}

// PickDirectory opens a native directory picker dialog. The dialog reopens at
// the directory the user last picked (persisted in dialog_state.json and
// validated to still exist); a successful non-cancelled pick updates that
// memory. This must remain on App (not FrontendAPI) because it requires the
// Wails context.
func (a *App) PickDirectory() (string, error) {
	if a.wailsCtx() == nil {
		return "", errors.New("PickDirectory: application context is not initialized")
	}

	options := wailsRuntime.OpenDialogOptions{
		Title:                "Select Workspace Directory",
		CanCreateDirectories: true,
	}
	// DefaultDirectory must reference an existing directory or the runtime
	// returns an error without showing any dialog; LoadDialogState drops
	// stale/non-existent paths, so adopting its value is always safe.
	if last := LoadDialogState(a.agentDir()); last.LastDirectory != "" {
		options.DefaultDirectory = last.LastDirectory
	}

	dir, err := wailsRuntime.OpenDirectoryDialog(a.wailsCtx(), options)
	if err != nil {
		return "", err
	}
	// On cancel OpenDirectoryDialog returns ("", nil) — keep the previous
	// memory instead of overwriting it with an empty path.
	rememberDialogDirectory(a.agentDir(), dir, a.log())
	return dir, nil
}

// attachmentFilterPattern builds the Wails FileFilter pattern string for the
// markitdown supported extensions, using the conventional "*.ext" form (e.g.
// "*.pdf;*.docx;*.pptx"). This is the cross-platform Wails convention — on
// macOS the backend strips the "*." prefix internally and matches by extension.
func attachmentFilterPattern() string {
	exts := markitdown.SupportedExtensions()
	cleaned := make([]string, 0, len(exts))
	for _, ext := range exts {
		if e := strings.TrimPrefix(ext, "."); e != "" {
			cleaned = append(cleaned, "*."+e)
		}
	}
	return strings.Join(cleaned, ";")
}

// PickAttachmentFiles opens a native multi-select file picker restricted to the
// document formats markitdown can convert. This must remain on App (not
// FrontendAPI) because it requires the Wails context, exactly like PickDirectory.
//
// On cancel, OpenMultipleFilesDialog returns an empty slice and a nil error;
// that ([]string{}, nil) is returned as-is.
func (a *App) PickAttachmentFiles() ([]string, error) {
	if a.wailsCtx() == nil {
		return nil, errors.New("PickAttachmentFiles: application context is not initialized")
	}

	// Deliberately no "All files (*.*)" filter here: on macOS, Wails maps
	// each pattern to a UTType via UTType(filenameExtension:) and merges all
	// resolved types into a single NSOpenPanel.allowedContentTypes array
	// (Mac dialogs only support one combined pattern set — see Wails' dialog
	// docs). The "*" extension from "*.*" resolves to an unusable *dynamic*
	// UTType (e.g. "dyn.ah62d4rv4ge8wy") rather than a wildcard/"anything"
	// type. A dynamic UTType in that array corrupts the panel's whole
	// content-type filter, graying out every entry — including files that
	// otherwise match a perfectly valid type like "public.png" (see e.g.
	// https://github.com/r0x0r/pywebview/issues/1780 for the same root cause
	// in another Cocoa-backed webview shell). This is why images could not
	// be selected at all in the attach dialog. The "Supported documents" and
	// "Images" filters already cover every extension the backend accepts.
	return wailsRuntime.OpenMultipleFilesDialog(a.wailsCtx(), wailsRuntime.OpenDialogOptions{
		Title: "Attach files",
		Filters: []wailsRuntime.FileFilter{
			{
				DisplayName: "Supported documents",
				Pattern:     attachmentFilterPattern(),
			},
			{
				DisplayName: "Images",
				Pattern:     "*.png;*.jpg;*.jpeg;*.gif;*.webp",
			},
		},
	})
}

// PickStudyDocument opens a native single-select file picker restricted to the
// document formats the app can read (the markitdown-supported extensions, PDF
// first among equals). It backs the Papers panel's "pick a local document"
// gesture next to the Study field, so a study can be launched straight from a
// file on disk. This must remain on App (not FrontendAPI) because it requires
// the Wails context, exactly like PickDirectory and PickAttachmentFiles.
//
// On cancel, OpenFileDialog returns ("", nil) — returned as-is so the frontend
// can distinguish "user cancelled" (empty path, no error) from a failure.
func (a *App) PickStudyDocument() (string, error) {
	if a.wailsCtx() == nil {
		return "", errors.New("PickStudyDocument: application context is not initialized")
	}

	// Same filter rationale as PickAttachmentFiles: no "All files (*.*)" entry
	// (a "*" pattern resolves to a dynamic UTType on macOS and corrupts the
	// panel's content-type filter), and the supported-documents set already
	// covers every format the study flow can convert and read.
	return wailsRuntime.OpenFileDialog(a.wailsCtx(), wailsRuntime.OpenDialogOptions{
		Title: "Study a local document",
		Filters: []wailsRuntime.FileFilter{
			{
				DisplayName: "Supported documents",
				Pattern:     attachmentFilterPattern(),
			},
		},
	})
}

// PickAndImportThemes opens a native multi-select file picker restricted to
// CSS files and imports every chosen file as a user theme in one action. This
// must remain on App (not FrontendAPI) because it requires the Wails context,
// exactly like PickDirectory.
//
// On cancel, OpenMultipleFilesDialog returns an empty slice and a nil error;
// the method then returns (nil, nil) — nothing is imported and the frontend
// maps the null result to "user cancelled". The chosen paths are delegated to
// backend.ImportThemesFromPaths (the package-level bridge over the
// unexported FrontendAPI importer), which validates and sanitizes each file
// independently — one invalid file never blocks the rest of the batch, and
// per-file outcomes (including failures) come back in the result list so the
// frontend can surface them. This picker is the ONLY import entry point: the
// underlying import functions are not FrontendAPI methods precisely so the
// binding generator never publishes a path-taking RPC to the renderer.
func (a *App) PickAndImportThemes() ([]backend.ThemeImportResult, error) {
	if a.wailsCtx() == nil {
		return nil, errors.New("PickAndImportThemes: application context is not initialized")
	}

	paths, err := wailsRuntime.OpenMultipleFilesDialog(a.wailsCtx(), wailsRuntime.OpenDialogOptions{
		Title: "Import Themes",
		Filters: []wailsRuntime.FileFilter{
			{
				DisplayName: "Theme files",
				Pattern:     "*.css",
			},
		},
	})
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		// Cancelled: import nothing and report no error.
		return nil, nil
	}

	// Delegate to the package-level batch importer: the import entry points
	// are deliberately NOT FrontendAPI methods (exported methods are
	// auto-bound to the renderer; a path-taking RPC must not be callable
	// from compromised renderer JS). The picker above is the sole path
	// source.
	return backend.ImportThemesFromPaths(a.frontendAPI(), paths), nil
}

// setShutdownHardDeadline records the configured hard deadline (Startup only).
func (a *App) setShutdownHardDeadline(d time.Duration) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	a.shutdownHardDeadline = d
}

// shutdownDeadline returns the effective hard deadline for the Shutdown
// teardown: the value Startup recorded from shutdown.hardDeadline, or
// defaultShutdownHardDeadline when unset (0) or Startup never got that far.
func (a *App) shutdownDeadline() time.Duration {
	a.stateMu.RLock()
	defer a.stateMu.RUnlock()
	if a.shutdownHardDeadline > 0 {
		return a.shutdownHardDeadline
	}
	return defaultShutdownHardDeadline
}

// setLaunchStderrObserved records whether this launch's stderr is observable
// (main.go, before wails.Run).
func (a *App) setLaunchStderrObserved(observed bool) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	a.launchStderrObserved = observed
}

// stderrObserved reports the launch's stderr-observation fact for the
// FrontendAPI init (zero value = unobserved, the safe direction).
func (a *App) stderrObserved() bool {
	a.stateMu.RLock()
	defer a.stateMu.RUnlock()
	return a.launchStderrObserved
}

// setLogger records the active logger (Startup only).
func (a *App) setLogger(log *slog.Logger) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	a.logger = log
}

// setSessionLogger records the session log handle (Startup only).
func (a *App) setSessionLogger(l *logger.SessionLogger) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	a.sessionLogger = l
}

// sessionLog returns the session log handle for the close path, or nil when
// Startup has not opened (or has already swapped) one.
func (a *App) sessionLog() *logger.SessionLogger {
	a.stateMu.RLock()
	defer a.stateMu.RUnlock()
	return a.sessionLogger
}

// setContext records the Wails context (Startup only).
func (a *App) setContext(ctx context.Context) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	a.ctx = ctx
}

// wailsCtx returns the Wails application context, or nil before Startup
// bound it (or after a test built the App without a lifecycle). It is the
// locked read of the Wails runtime context, deliberately UNexported: every
// exported App method is promoted onto the Wails binding surface and becomes
// renderer-callable, and this accessor is internal plumbing (the context
// marshals to an empty object — harmless but pointless to expose).
// Cross-goroutine readers — the second-instance relay, binding-dispatch
// goroutines, the close/quit path — must use this instead of touching a.ctx
// directly.
func (a *App) wailsCtx() context.Context {
	a.stateMu.RLock()
	defer a.stateMu.RUnlock()
	return a.ctx
}

// setDatabase records the shared SQLite connection (Startup only).
func (a *App) setDatabase(db *sql.DB) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	a.db = db
}

// database returns the shared SQLite connection for the close path, or nil
// before Startup opened it.
func (a *App) database() *sql.DB {
	a.stateMu.RLock()
	defer a.stateMu.RUnlock()
	return a.db
}

// setApplication records the backend Application (Startup only).
func (a *App) setApplication(app *backend.Application) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	a.app = app
}

// application returns the backend Application, or nil before Startup built
// it. Cross-goroutine readers (the close guard, Shutdown) must use this
// instead of touching a.app directly.
func (a *App) application() *backend.Application {
	a.stateMu.RLock()
	defer a.stateMu.RUnlock()
	return a.app
}

// frontendAPI returns the live FrontendAPI. Never nil: NewApp seeds a
// non-nil zero-value shell so early RPCs hit the per-method guards. The
// embedded pointer is published exactly once (NewApp) and startup INITIALIZES
// that seed in place (buildFrontendAPI → Init) — it is never reassigned — so
// the Wails binding dispatch's per-call dereference of the embedded field can
// never race a swap (review finding #52). The zero-value shell has no wiring —
// callers that need live state must treat it accordingly (the Lifecycle
// accessors guard internally).
func (a *App) frontendAPI() *backend.FrontendAPI {
	a.stateMu.RLock()
	defer a.stateMu.RUnlock()
	return a.FrontendAPI
}

// log returns the instance logger, falling back to slog.Default() when nil.
func (a *App) log() *slog.Logger {
	a.stateMu.RLock()
	log := a.logger
	a.stateMu.RUnlock()
	if log != nil {
		return log
	}
	return slog.Default()
}

// setEventTap installs (fn != nil) or removes (fn == nil) the side event tap.
// See the eventTap field comment for why it is an atomic swap rather than a
// plain store: the web-access mount registers the tap after event producers
// are live, while RPC goroutines may already be emitting.
func (a *App) setEventTap(fn func(name string, args []interface{})) {
	if fn == nil {
		a.eventTap.Store(nil)
		return
	}
	a.eventTap.Store(&fn)
}

// emit dispatches a Wails event. Tests can inject a fake bus by setting
// a.wailsEmit; production code uses wailsRuntime.EventsEmit. Callers must not
// invoke this before Startup binds a.wailsCtx() (or before a.wailsEmit is set in tests).
// When a.eventTap is set, every dispatch is also observed by the tap (see the
// field comment); the tap never alters, blocks, or fails the Wails dispatch.
func (a *App) emit(eventName string, optionalData ...any) {
	if tap := a.eventTap.Load(); tap != nil {
		(*tap)(eventName, optionalData)
	}
	if a.wailsEmit != nil {
		a.wailsEmit(eventName, optionalData...)
		return
	}
	if a.wailsCtx() == nil {
		a.log().Warn("emit called with nil ctx, event dropped", "event", eventName)
		return
	}
	wailsRuntime.EventsEmit(a.wailsCtx(), eventName, optionalData...)
}

// showWindow reveals AND raises the main window. Tests can inject a fake by
// setting a.windowShowFn; production code uses wailsRuntime.
//
// Every reveal path funnels through here — the startup phases, OnDomReady,
// the exit guard, and the notification-click callback — and the raise applies
// to ALL of them by design: reveal without raise would leave a buried window
// "shown". The window is created visible (main.go sets no StartHidden), so in
// a normal start these calls have nothing left to do; they exist so a window
// that is hidden, minimized, or buried under other windows still comes back.
//
// Activation semantics per platform (verified against the Wails v2.16
// frontends — internal/frontend/desktop/{linux,darwin,windows}):
//
//		Linux     WindowShow is gtk_widget_show — a bare map call that is a NO-OP
//		          for an already-mapped (but covered or minimized) window: no
//		          raise, no focus, no restore. WindowUnminimise is the real
//		          activation primitive there: gtk_window_present, which raises,
//		          deiconifies and focuses (EWMH _NET_ACTIVE_WINDOW). So on Linux
//	         the present call ALONE is the full reveal+raise, and the plain
//	         Show is skipped (calling both just double-queues main-thread
//	         work for the same effect).
//
//		darwin    WindowShow is makeKeyAndOrderFront + activateIgnoringOtherApps
//		          — already the full activation; WindowUnminimise (deminiaturize)
//		          adds nothing the Show doesn't do, so it is skipped.
//
//		Windows   ShowWindow maps + activates, but WindowUnminimise maps to the
//		          WPF Form.Restore(), which UNMAXIMIZES a maximized window — so it
//		          runs only when the window is actually minimized. The restore
//		          path is the only way to bring the window back from the taskbar
//		          without a focus-steal fight with the shell.
//
// See specs/domains/frontend/system-notifications.md (§ Click → window
// activation) for the full matrix and the Wails source references.
func (a *App) showWindow(ctx context.Context) {
	if a.windowShowFn != nil {
		a.windowShowFn(ctx)
		return
	}
	switch showWindowPlatform {
	case "linux":
		// Own EWMH pager-source activation first (see window_activation_linux.go):
		// the Wails present() carries a stale/zero timestamp that KWin's focus
		// stealing prevention rejects, leaving the taskbar merely flashing.
		if a.tryX11PagerActivation() {
			return
		}
		// Fallback (Wayland, headless, no matching window): gtk_window_present
		// — raise + deiconify + focus in one call.
		a.windowUnminimise(ctx)
	case "darwin":
		// makeKeyAndOrderFront + activateIgnoringOtherApps.
		a.windowRaise(ctx)
	case "windows":
		// Show maps + activates; Restore only when really minimized, or a
		// maximized window would be unmaximized (WPF Form.Restore).
		a.windowRaise(ctx)
		if a.windowIsMinimised(ctx) {
			a.windowUnminimise(ctx)
		}
	default:
		// Unknown platform: keep the historical behavior (plain show).
		a.windowRaise(ctx)
	}
}

// showWindowPlatform selects the activation branch of showWindow. A package
// var (not a build tag) so tests on ANY platform can exercise every branch —
// production reads runtime.GOOS, exactly like notificationAuthorizationPlatform.
var showWindowPlatform = runtime.GOOS

// windowRaise dispatches to wailsRuntime.WindowShow (the per-call seam lives
// on App — see the windowRaiseFn field).
func (a *App) windowRaise(ctx context.Context) {
	if a.windowRaiseFn != nil {
		a.windowRaiseFn(ctx)
		return
	}
	wailsRuntime.WindowShow(ctx)
}

// windowUnminimise dispatches to wailsRuntime.WindowUnminimise.
func (a *App) windowUnminimise(ctx context.Context) {
	if a.windowUnminimiseFn != nil {
		a.windowUnminimiseFn(ctx)
		return
	}
	wailsRuntime.WindowUnminimise(ctx)
}

// tryX11PagerActivation attempts the Linux EWMH pager-source activation of
// the app's own window (window_activation_linux.go) behind the
// x11PagerActivateFn seam. Returns true when the pager activation ran (the
// caller then skips the Wails fallback); false → fall back to the Wails
// present() path. The seam is nil in production, where the cgo
// implementation runs; tests fake it to exercise both outcomes.
func (a *App) tryX11PagerActivation() bool {
	if a.x11PagerActivateFn != nil {
		return a.x11PagerActivateFn()
	}
	return x11ActivateOwnWindow()
}

// windowIsMinimised dispatches to wailsRuntime.WindowIsMinimised.
func (a *App) windowIsMinimised(ctx context.Context) bool {
	if a.windowIsMinimisedFn != nil {
		return a.windowIsMinimisedFn(ctx)
	}
	return wailsRuntime.WindowIsMinimised(ctx)
}

// resolvePendingMessage delegates to FrontendAPI.ResolvePendingMessage to mark
// a persisted HITL message as resolved in the DB.
func (a *App) resolvePendingMessage(sessionID, role, matchField, matchValue string, extra map[string]any) error {
	fa := a.frontendAPI()
	if fa == nil {
		return nil
	}
	return fa.ResolvePendingMessage(sessionID, role, matchField, matchValue, extra)
}

// ── Web access sidecar: mount, teardown, control RPCs (ADR-090) ──────────
//
// Everything the browser sidecar needs from the app lives at THIS seam: the
// mount builds webaccess.Options from the live FrontendAPI (the reflection
// dispatch target), the opted-in App-level extra surface behind the minimal
// adapter (webaccess_extra.go — currently only GetPendingActions), the SPA
// tree handed over by main.go, the CSP middleware, and the resolved config
// section — and owns the sidecar handle for its whole lifetime. The backend
// never learns the sidecar exists: `backend` and `core` hold no webaccess
// reference, and these control RPCs are methods on App (not on the embedded
// *FrontendAPI), so the reflection dispatcher — which sees the FrontendAPI
// surface plus the adapter's explicit method set, never the App itself — can
// never reach them. A browser tab cannot read the credential state or flip
// the switch that feeds it.

// webAccessStopBudget bounds one sidecar stop (Shutdown and the disable
// toggle). Deliberately small: the sidecar holds no durable state — a Stop is
// a listener close plus a WebSocket fan-out abort — so unlike the embedded
// LLM's 30 s stop there is nothing here worth making a quit wait for. On
// expiry Server.Stop force-closes what a graceful Shutdown could not finish.
const webAccessStopBudget = 3 * time.Second

// setConfigRef captures the desktop's handle on the live config object and
// its path (buildFrontendAPI, Startup goroutine). See the liveConfig field
// comment for the ownership discipline.
func (a *App) setConfigRef(cfg *config.Config, path string) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	a.liveConfig = cfg
	a.liveConfigPath = path
}

// configRef returns the captured live config and path (either may be empty on
// a Startup that never reached buildFrontendAPI).
func (a *App) configRef() (cfg *config.Config, path string) {
	a.stateMu.RLock()
	defer a.stateMu.RUnlock()
	return a.liveConfig, a.liveConfigPath
}

// SetWebAccessStaticFS stores the SPA asset tree the sidecar serves. Exported
// for main.go by the same precedent as SetWebviewGpuWatchdog: internal startup
// plumbing rides the Wails binding surface so the process-level wiring can
// hand over a value only it holds (the embedded asset tree). Call it strictly
// before wails.Run — the plain-field publishing contract in the field comment.
func (a *App) SetWebAccessStaticFS(static fs.FS) {
	a.webAccessStatic = static
}

// WebAccessInfo is the GetWebAccessInfo payload: the Settings section's whole
// view of the sidecar.
type WebAccessInfo struct {
	// Enabled mirrors the persisted web_access.enabled switch — the operator's
	// intent, not the runtime state.
	Enabled bool `json:"enabled"`
	// Running reports whether the sidecar is live in THIS process.
	Running bool `json:"running"`
	// URL is the browser-openable URL (scheme + resolved host:port): a
	// wildcard bind (0.0.0.0, ::) is reported as localhost — the
	// machine-local way into an every-interface listener — while a specific
	// IP is reported as-is. Empty while the sidecar is not running (port 0
	// resolves only at bind).
	URL string `json:"url"`
	// Port is the resolved listen port; 0 while not running.
	Port int `json:"port"`
	// ConfiguredPort is the PERSISTED web_access.port — the pin, not the
	// runtime state: 0 = auto (a free port is picked at every start),
	// 1–65535 = the operator-pinned port every start must bind.
	ConfiguredPort int `json:"configured_port"`
	// ConfiguredBind is the PERSISTED web_access.bind — the interface pin,
	// not the runtime state: the address every start listens on.
	ConfiguredBind string `json:"configured_bind"`
	// BindIsLoopback classifies the configured bind (the same
	// config.IsLoopbackBind rule the loader warns on): a loopback bind keeps
	// the sidecar machine-local, any other valid bind exposes it to the
	// network.
	BindIsLoopback bool `json:"bind_is_loopback"`
	// Token is the credential a browser pastes at the login screen: the live
	// token while running, else the configured one (empty only before the
	// very first start — that start mints one and persists it). This is
	// the ONLY channel the token leaves the sidecar through — it is never
	// logged and never reaches the web dispatch surface.
	Token string `json:"token"`
	// TokenPinned reports whether a persistent token is stored in config.yaml.
	// Since ADR-090's generated-credential default this is true from the first
	// sidecar start on: an empty config token is minted once and written back
	// through the same config save every other settings value uses. False
	// means the section never started with an empty token (the next start
	// would mint one).
	TokenPinned bool `json:"token_pinned"`
	// TLSEnabled mirrors the persisted web_access.tls.enabled switch (ADR-092)
	// — the operator's HTTPS intent, not the runtime transport. The URL field
	// above carries the running sidecar's actual scheme.
	TLSEnabled bool `json:"tls_enabled"`
	// TLSCert is the PERSISTED path to the PEM certificate (empty when the
	// subsection is unconfigured). The standard app-owned pair lives at
	// ~/.c0wrk/web-access.crt; an operator-authored certificate is any path.
	TLSCert string `json:"tls_cert"`
	// TLSKey is the PERSISTED path to the PEM private key (empty when the
	// subsection is unconfigured).
	TLSKey string `json:"tls_key"`
	// CertStatus classifies the configured certificate against the pinned
	// bind (ADR-092 decision 5), computed whenever tls_cert is non-empty:
	// "ok" — the pair loads and the leaf covers the bind's browser-facing
	// host within its validity window; "mismatch" — the leaf does not cover
	// that host (the canonical trigger: the bind was changed after the pair
	// was generated; regenerating is the fix); "expired" — the leaf is
	// outside its validity window (past NotAfter or not yet valid before
	// NotBefore); "unreadable" — the pair cannot be loaded/parsed (missing
	// file, parse error, key/cert mismatch). Empty when no cert path is
	// configured — nothing to classify.
	CertStatus string `json:"cert_status"`
	// CertDetail is the human-readable explanation behind a non-ok
	// CertStatus (which certificate failed which check, and the fix); empty
	// for "ok" and the unconfigured case.
	CertDetail string `json:"cert_detail"`
}

// webAccessURLHost maps a listener host to the host a browser opens: an
// unspecified wildcard host (0.0.0.0, ::) becomes "localhost" — the wildcard
// names "every interface", not an address a browser can open, and localhost
// is the machine-local way in; every specific host (IP literal or name) is
// reported as-is. Shared by the URL renderer and the certificate status
// check (ADR-092 decision 5) so both name the SAME browser-facing host the
// certificate's SANs must cover.
func webAccessURLHost(host string) string {
	if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
		return "localhost"
	}
	return host
}

// webAccessBrowserURL renders the URL a browser opens for the sidecar's
// resolved listener address: the scheme follows the transport the sidecar is
// actually serving (https under web_access.tls, ADR-092 decision 1 — what
// the operator sees is always what the browser must open) plus host:port,
// with one rewrite — an unspecified wildcard host becomes "localhost"
// (webAccessURLHost).
func webAccessBrowserURL(addr string, tlsEnabled bool) string {
	scheme := "http"
	if tlsEnabled {
		scheme = "https"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		// Not host:port — never expected from a TCP listener address; pass
		// the raw value through rather than invent a port.
		return scheme + "://" + addr
	}
	return scheme + "://" + net.JoinHostPort(webAccessURLHost(host), port)
}

// GetWebAccessInfo reports the sidecar state for Settings → Web Access.
// Desktop-only by construction: it is an App method, so the web reflection
// surface (the FrontendAPI methods) cannot serve it back to a browser tab.
func (a *App) GetWebAccessInfo() WebAccessInfo {
	info := WebAccessInfo{}
	if cfg, _ := a.configRef(); cfg != nil {
		info.Enabled = cfg.WebAccess.Enabled
		info.ConfiguredBind = cfg.WebAccess.Bind
		info.BindIsLoopback = config.IsLoopbackBind(cfg.WebAccess.Bind)
		info.ConfiguredPort = cfg.WebAccess.Port
		info.TokenPinned = cfg.WebAccess.Token != ""
		info.TLSEnabled = cfg.WebAccess.TLS.Enabled
		info.TLSCert = cfg.WebAccess.TLS.Cert
		info.TLSKey = cfg.WebAccess.TLS.Key
		info.CertStatus, info.CertDetail = classifyWebAccessCert(
			cfg.WebAccess.TLS.Cert, cfg.WebAccess.TLS.Key, cfg.WebAccess.Bind)
	}
	if srv := a.webAccess.Load(); srv != nil {
		info.Running = true
		if addr, ok := srv.Addr(); ok {
			info.URL = webAccessBrowserURL(addr, srv.TLSEnabled())
			if _, port, perr := net.SplitHostPort(addr); perr == nil {
				info.Port, _ = strconv.Atoi(port)
			}
		}
		info.Token = srv.AuthToken()
	} else if cfg, _ := a.configRef(); cfg != nil {
		// Not running: the configured token is what the next start would
		// use (an empty value means that start mints and persists one).
		info.Token = cfg.WebAccess.Token
	}
	return info
}

// The warning-channel refresh (ADR-092): every transport-affecting control
// RPC recomputes the section's config-load-warning contribution AFTER its
// webAccessMu critical section — outside the lock on purpose, see
// RefreshWebAccessLoadWarnings for the lock-order rule. The refresh is
// idempotent, so it also runs after refusals and rollbacks: it reflects
// whatever state the attempt left behind. The token and certificate RPCs
// deliberately do not refresh: neither the credential nor the pair's paths
// change the section's transport state, so its warning contribution cannot
// move.
func (a *App) refreshWebAccessLoadWarnings() {
	a.frontendAPI().Lifecycle().RefreshWebAccessLoadWarnings()
}

// SetWebAccessEnabled persists the web_access.enabled switch and applies it
// live: enabling starts the sidecar, disabling stops it. A request matching
// the current state is a no-op, and a failed disk write rolls the in-memory
// flip back so a rejected toggle is indistinguishable from a rejected
// request (the SetModelProfilesEnabled contract).
//
// Enabling onto a configured-but-unusable TLS (ADR-092) is refused before
// anything is mutated or persisted: the pair is loaded exactly like the
// sidecar would load it (config.ValidateWebAccessTLSPair), so a broken
// certificate leaves the section OFF with the reason in the toggle's error
// — never a listener downgraded to plain HTTP, never a persisted-on switch
// above a silently-down sidecar.
//
// Locking discipline: webAccessMu serializes the whole transition — config
// flip, persist, start/stop — against the startup mount and the Shutdown
// stop, so a toggle can never race a teardown into a leaked listener. The
// config mutation itself deliberately does NOT take FrontendAPI's unexported
// configMu (desktop cannot; that is the zero-backend-edit constraint):
// desktop is the sole WRITER of the web_access section (backend code never
// touches it at runtime), and a concurrent backend config save can only READ
// the section it persists wholesale — the accepted one-word window of this
// desktop-owned seam. The warning refresh runs after the unlock, so the
// never-takes-configMu-under-webAccessMu rule survives (ADR-092).
func (a *App) SetWebAccessEnabled(on bool) error {
	a.webAccessMu.Lock()
	err := a.setWebAccessEnabledLocked(on)
	a.webAccessMu.Unlock()
	a.refreshWebAccessLoadWarnings()
	return err
}

func (a *App) setWebAccessEnabledLocked(on bool) error {
	cfg, cfgPath := a.configRef()
	if cfg == nil || cfgPath == "" {
		return errors.New("config not initialized")
	}
	if cfg.WebAccess.Enabled == on {
		return nil
	}

	// ADR-092: a flip onto an unusable TLS is refused up front — the same
	// usability predicate the load path heals by, fail-closed here because
	// this is an interactive boundary, not a broken config file.
	if on && cfg.WebAccess.TLS.Enabled {
		if err := config.ValidateWebAccessTLSPair(cfg.WebAccess.TLS); err != nil {
			return fmt.Errorf("cannot enable web access: %w", err)
		}
	}

	prev := cfg.WebAccess
	cfg.WebAccess.Enabled = on
	if err := config.Save(cfg, cfgPath); err != nil {
		cfg.WebAccess = prev
		return fmt.Errorf("failed to persist web access config: %w", err)
	}

	if on {
		srv, err := a.startWebAccessLocked(a.log())
		if err != nil {
			// The persisted switch stays on (operator intent; the next
			// launch retries) but the failure must be visible now.
			return fmt.Errorf("web access enabled, but the sidecar failed to start: %w", err)
		}
		logWebAccessReady(a.log(), srv)
		return nil
	}

	sctx, cancel := context.WithTimeout(context.Background(), webAccessStopBudget)
	defer cancel()
	if err := a.stopWebAccessLocked(sctx); err != nil {
		return fmt.Errorf("web access disabled, but the sidecar stop failed: %w", err)
	}
	return nil
}

// applyExperimentalWebAccess is the desktop hook the backend invokes after a
// successful experimental.enabled persist (UpdateExperimentalFeatures → the
// OnExperimentalChanged FrontendAPIConfig seam, ADR-090): web access is an
// experimental feature,
// so its sidecar must follow the master gate LIVE instead of waiting for the
// next launch. Opening the gate mounts the sidecar when the section's own
// switch is on and nothing is running yet; closing it stops a running
// sidecar (bounded by webAccessStopBudget, the SetWebAccessEnabled budget).
// Everything else — gate open with the section off, gate closed with nothing
// running, a repeated open over a live sidecar — is a no-op, which makes the
// hook idempotent under repeated toggles onto the same value.
//
// The sidecar lifecycle decision reads the persisted config only: the
// in-memory gate is already the post-toggle truth when this runs, and the
// web_access section is desktop-owned (backend code never touches it at
// runtime). Failure is fail-soft and LOUD exactly like the startup mount
// (initWebAccess): a sidecar that cannot start logs at Error and leaves the
// app fully usable desktop-side; the persisted switch stays on, so the next
// launch or successful toggle retries.
//
// Locking discipline: webAccessMu serializes the whole transition against
// the startup mount, the Shutdown stop and the control RPCs, so the hook can
// never interleave with another lifecycle transition into a leaked listener.
// No lock-order cycle exists with the backend: UpdateExperimentalFeatures
// holds configMu while this takes webAccessMu, and desktop code never takes
// configMu (the zero-backend-edit constraint documented at
// SetWebAccessEnabled).
func (a *App) applyExperimentalWebAccess(enabled bool) {
	a.webAccessMu.Lock()
	defer a.webAccessMu.Unlock()

	cfg, _ := a.configRef()
	if cfg == nil {
		// A Startup that never reached buildFrontendAPI: nothing to mount,
		// and no live config to read the section's own switch from.
		return
	}

	switch {
	case enabled && cfg.WebAccess.Enabled:
		srv, err := a.startWebAccessLocked(a.log())
		if err != nil {
			a.log().Error("web access sidecar failed to start after the experimental gate opened; continuing without it", "error", err)
			return
		}
		// Idempotent on a live server: a repeated open returns the running
		// sidecar instead of double-binding, so this is quiet for that case.
		logWebAccessReady(a.log(), srv)
	case !enabled:
		if a.webAccess.Load() == nil {
			return
		}
		sctx, cancel := context.WithTimeout(context.Background(), webAccessStopBudget)
		defer cancel()
		if err := a.stopWebAccessLocked(sctx); err != nil {
			a.log().Error("web access sidecar failed to stop after the experimental gate closed", "error", err)
		}
	}
}

// SetWebAccessConnection persists the pinned bind and port (Settings →
// Web Access: the single address field parses into these two) and applies
// them live: a running sidecar is hot-restarted onto the new connection
// settings. The token is deliberately NOT part of this call — the credential
// has its own RPCs (SetWebAccessToken for an operator-typed value,
// RegenerateWebAccessToken for rotation), all serialized by webAccessMu so
// concurrent writers can never interleave their persist+restart pairs. An
// empty bind = the loopback default (config.DefaultWebAccessBind); otherwise
// any valid IP literal or "localhost" is accepted through
// config.ValidateWebAccessBind — the exact rule the load/save paths enforce
// (a valid non-loopback bind is a deliberate LAN listener, classified by
// config.IsLoopbackBind). Port 0 = auto (a free port at every start),
// 1–65535 = pinned. A request matching the current pin is a no-op.
//
// Failure ordering mirrors the toggle's honesty rules: the config write is
// rolled back if persisting fails, and if the RESTART with the new settings
// fails (e.g. the pinned port is already taken) the previous pin is restored,
// persisted, and the sidecar is brought back on it — the caller gets an error
// explaining both, and the app is never left silently without a sidecar it
// had before the call. Locking discipline: webAccessMu, exactly like
// SetWebAccessEnabled (see its comment for the desktop-owned config seam);
// the warning refresh runs after the unlock (ADR-092, the lock-order rule).
func (a *App) SetWebAccessConnection(bind string, port int) error {
	a.webAccessMu.Lock()
	err := a.setWebAccessConnectionLocked(bind, port)
	a.webAccessMu.Unlock()
	a.refreshWebAccessLoadWarnings()
	return err
}

func (a *App) setWebAccessConnectionLocked(bind string, port int) error {
	cfg, cfgPath := a.configRef()
	if cfg == nil || cfgPath == "" {
		return errors.New("config not initialized")
	}
	bind = strings.TrimSpace(bind)
	if bind == "" {
		bind = config.DefaultWebAccessBind
	}
	if err := config.ValidateWebAccessBind(bind); err != nil {
		return err
	}
	if err := config.ValidateWebAccessPort(port); err != nil {
		return err
	}

	if cfg.WebAccess.Bind == bind && cfg.WebAccess.Port == port {
		return nil
	}

	prev := cfg.WebAccess
	cfg.WebAccess.Bind = bind
	cfg.WebAccess.Port = port
	if err := config.Save(cfg, cfgPath); err != nil {
		cfg.WebAccess = prev
		return fmt.Errorf("failed to persist web access config: %w", err)
	}
	return a.restartWebAccessOrRollbackLocked(prev, cfg, cfgPath, "connection")
}

// RegenerateWebAccessToken mints a fresh persistent credential (the Settings
// → Web Access button): the new token replaces the stored one through the
// same immediate config write every settings change uses, and a running
// sidecar hot-restarts onto it — every open browser tab must sign in again
// with the token Settings now shows. Works while the sidecar is stopped too:
// the persisted write is the whole effect then. Failure ordering mirrors
// SetWebAccessConnection: a failed persist rolls the mint back in memory,
// and a failed restart restores the previous token on disk and brings the
// sidecar back up on it. Locking discipline: webAccessMu.
func (a *App) RegenerateWebAccessToken() error {
	a.webAccessMu.Lock()
	defer a.webAccessMu.Unlock()

	cfg, cfgPath := a.configRef()
	if cfg == nil || cfgPath == "" {
		return errors.New("config not initialized")
	}
	tok, err := webaccess.GenerateToken()
	if err != nil {
		return fmt.Errorf("web access: generating auth token: %w", err)
	}

	prev := cfg.WebAccess
	cfg.WebAccess.Token = tok
	if err := config.Save(cfg, cfgPath); err != nil {
		cfg.WebAccess = prev
		return fmt.Errorf("failed to persist web access config: %w", err)
	}
	return a.restartWebAccessOrRollbackLocked(prev, cfg, cfgPath, "token regeneration")
}

// SetWebAccessToken persists an operator-typed credential (the Settings →
// Web Access token field) and applies it live, exactly like the rotation
// above: a running sidecar hot-restarts onto the new token — every open
// browser tab must sign in again — and with the sidecar stopped the
// persisted write is the whole effect. The value is trimmed and
// bounds-checked by config.ValidateWebAccessToken (min
// config.MinWebAccessTokenLength characters; the empty value is rejected —
// emptiness means GENERATED, and clearing the field reverts the UI instead
// of overwriting an existing credential). A request matching the stored
// token is a no-op. Failure ordering and locking discipline mirror
// RegenerateWebAccessToken: webAccessMu, rollback on persist failure,
// restore-and-restart on restart failure.
func (a *App) SetWebAccessToken(token string) error {
	a.webAccessMu.Lock()
	defer a.webAccessMu.Unlock()

	cfg, cfgPath := a.configRef()
	if cfg == nil || cfgPath == "" {
		return errors.New("config not initialized")
	}
	token = strings.TrimSpace(token)
	if token == cfg.WebAccess.Token {
		return nil
	}
	if err := config.ValidateWebAccessToken(token); err != nil {
		return err
	}

	prev := cfg.WebAccess
	cfg.WebAccess.Token = token
	if err := config.Save(cfg, cfgPath); err != nil {
		cfg.WebAccess = prev
		return fmt.Errorf("failed to persist web access config: %w", err)
	}
	return a.restartWebAccessOrRollbackLocked(prev, cfg, cfgPath, "token change")
}

// Web-access TLS certificate statuses (ADR-092 decision 5): the exact
// vocabulary GetWebAccessInfo reports in cert_status. The empty string (the
// zero value, not a constant) means no cert path is configured — nothing to
// classify.
const (
	webAccessCertStatusOK         = "ok"
	webAccessCertStatusMismatch   = "mismatch"
	webAccessCertStatusUnreadable = "unreadable"
	webAccessCertStatusExpired    = "expired"
)

// SetWebAccessTLS persists the web_access.tls subsection (the HTTPS switch,
// ADR-092 decision 1) and applies it live: a running sidecar is hot-restarted
// onto the new transport. The caller authors both PEM paths explicitly —
// cert and key — the key path is never derived from the cert path. An
// enabled subsection with empty paths is refused through
// config.ValidateWebAccessTLS — the exact structural rule the load/save
// paths enforce; a disabled subsection is inert for that rule (the sidecar
// serves plain HTTP, byte-identical to pre-ADR behavior).
//
// A non-empty cert+key pair is loaded with tls.LoadX509KeyPair — the same
// load the sidecar performs at mount — BEFORE the no-op check and any
// persist, so a broken pair never reaches disk or the sidecar: a key that
// does not match its certificate is refused with the mismatch message
// ("does not match"), everything else (missing files, unparseable PEM) with
// the unreadable message. The mount-time FAIL-CLOSED check stays as the
// backstop for hand-edited configs — a listener configured as encrypted
// never downgrades to plaintext (ADR-092 decision 2) — but through this RPC
// the operator is stopped at the door. A request matching the current
// subsection remains a no-op (after the pair has loaded).
//
// Failure ordering mirrors the section's other control RPCs (the
// SetWebAccessConnection contract): a failed persist rolls the subsection
// back in memory, and a failed restart restores the previous subsection on
// disk and brings the sidecar back on it. The subsection deliberately does
// not consult web_access.enabled or the experimental gate: like the
// bind/port pins it persists regardless and takes effect at the next start
// whose gates are open. Locking discipline: webAccessMu, exactly like
// SetWebAccessEnabled (see its comment for the desktop-owned config seam);
// the warning refresh runs after the unlock (ADR-092, the lock-order rule) —
// the HTTPS flip is precisely the transition that must move the
// config-load-warning banner.
func (a *App) SetWebAccessTLS(enabled bool, cert, key string) error {
	a.webAccessMu.Lock()
	err := a.setWebAccessTLSLocked(enabled, cert, key)
	a.webAccessMu.Unlock()
	a.refreshWebAccessLoadWarnings()
	return err
}

func (a *App) setWebAccessTLSLocked(enabled bool, cert, key string) error {
	cfg, cfgPath := a.configRef()
	if cfg == nil || cfgPath == "" {
		return errors.New("config not initialized")
	}
	cert = strings.TrimSpace(cert)
	key = strings.TrimSpace(key)
	if cert != "" && key != "" {
		// Refuse an unloadable pair before the no-op check or any persist,
		// classified the way cert_status classifies it: a key that does not
		// match its certificate is a mismatch, every other load failure is
		// an unreadable pair.
		if _, err := tls.LoadX509KeyPair(cert, key); err != nil {
			if strings.Contains(err.Error(), "does not match") {
				return fmt.Errorf("web access: TLS private key %q does not match the certificate %q: %w", key, cert, err)
			}
			return fmt.Errorf("web access: TLS certificate/key pair (%q, %q) is unreadable: %w", cert, key, err)
		}
	}
	next := config.WebAccessTLSConfig{Enabled: enabled, Cert: cert, Key: key}
	if err := config.ValidateWebAccessTLS(next); err != nil {
		return err
	}
	if cfg.WebAccess.TLS == next {
		return nil
	}

	prev := cfg.WebAccess
	cfg.WebAccess.TLS = next
	if err := config.Save(cfg, cfgPath); err != nil {
		cfg.WebAccess.TLS = prev.TLS
		return fmt.Errorf("failed to persist web access config: %w", err)
	}
	return a.restartWebAccessOrRollbackLocked(prev, cfg, cfgPath, "TLS switch")
}

// GenerateWebAccessCertificate regenerates the app-owned self-signed pair for
// the CURRENTLY pinned bind (ADR-092 decision 3) at the fixed locations
// ~/.c0wrk/web-access.crt + .key (the backend/config path API), persists the
// pair's paths into web_access.tls (minting-is-part-of-configuring, the
// token precedent), and hot-restarts a running sidecar onto the fresh
// certificate. It never flips tls.enabled and never touches operator-authored
// paths — clicking Generate overwrites only the standard pair it owns.
// Works while the sidecar is stopped too: generation plus the persisted
// paths are the whole effect then (a start with TLS enabled picks the pair
// up).
//
// The files are written BEFORE the config save: the reverse order would
// persist paths at files that do not exist yet — a fail-closed mount the
// operator did nothing to deserve. The leftover-files-on-persist-failure
// direction is harmless: the files are the idempotent standard pair nothing
// references until the paths persist. Failure ordering mirrors the other
// control RPCs; locking discipline: webAccessMu.
func (a *App) GenerateWebAccessCertificate() error {
	a.webAccessMu.Lock()
	defer a.webAccessMu.Unlock()

	cfg, cfgPath := a.configRef()
	if cfg == nil || cfgPath == "" {
		return errors.New("config not initialized")
	}
	agentDir := config.AgentDir()
	certPath := config.WebAccessCertPath(agentDir)
	keyPath := config.WebAccessKeyPath(agentDir)
	if err := webaccess.GenerateWebAccessCertificate(cfg.WebAccess.Bind, certPath, keyPath); err != nil {
		return err
	}

	prev := cfg.WebAccess
	next := config.WebAccessTLSConfig{
		Enabled: cfg.WebAccess.TLS.Enabled,
		Cert:    certPath,
		Key:     keyPath,
	}
	if cfg.WebAccess.TLS != next {
		cfg.WebAccess.TLS = next
		if err := config.Save(cfg, cfgPath); err != nil {
			cfg.WebAccess.TLS = prev.TLS
			return fmt.Errorf("failed to persist web access config: %w", err)
		}
	}
	// Hot-restart even when the persisted paths did not change: regeneration
	// replaced the key material on disk, and a running sidecar keeps serving
	// the pair it loaded at start until it is rebuilt.
	return a.restartWebAccessOrRollbackLocked(prev, cfg, cfgPath, "certificate generation")
}

// classifyWebAccessCert computes the cert_status/cert_detail pair of
// GetWebAccessInfo (ADR-092 decision 5): whenever a cert path is configured,
// the pair is loaded exactly the way the sidecar loads it
// (tls.LoadX509KeyPair) and the leaf is checked against the pinned bind —
// SAN coverage of the bind's browser-facing host (webAccessURLHost: the same
// rewrite the rendered URL applies, so the status certifies the address the
// browser actually opens) and validity window (NotBefore/NotAfter). The check
// order is fixed so
// the classification is deterministic: unreadable (nothing about an
// unloadable pair can be judged) → mismatch (deterministic,
// config-derived — the canonical changed-bind trigger) → expired
// (clock-derived: past NotAfter or not yet valid before NotBefore) → ok.
// An unconfigured cert path is the empty status with
// no detail.
func classifyWebAccessCert(certPath, keyPath, bind string) (status, detail string) {
	if certPath == "" {
		return "", ""
	}
	host := webAccessURLHost(bind)
	pair, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return webAccessCertStatusUnreadable, fmt.Sprintf(
			"the certificate pair could not be loaded (%v) — the sidecar will refuse to start while this pair is configured; fix the files or regenerate the pair", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return webAccessCertStatusUnreadable, fmt.Sprintf(
			"the certificate could not be parsed (%v) — the sidecar will refuse to start while this pair is configured; fix the files or regenerate the pair", err)
	}
	if !webAccessCertCoversHost(leaf, host) {
		return webAccessCertStatusMismatch, fmt.Sprintf(
			"the certificate does not cover %q (the current bind) — regenerate the pair for this address or point cert/key at a pair that covers it", host)
	}
	if !time.Now().Before(leaf.NotAfter) {
		return webAccessCertStatusExpired, fmt.Sprintf(
			"the certificate expired %s — regenerate the pair to renew it", leaf.NotAfter.UTC().Format(time.RFC3339))
	}
	if time.Now().Before(leaf.NotBefore) {
		// Same clock-derived bucket as expired: the pair is outside its
		// validity window, which is what the status vocabulary expresses.
		return webAccessCertStatusExpired, fmt.Sprintf(
			"the certificate is not valid until %s — check the system clock or regenerate the pair", leaf.NotBefore.UTC().Format(time.RFC3339))
	}
	return webAccessCertStatusOK, ""
}

// webAccessCertCoversHost reports whether the leaf's SANs cover host: an IP
// host must appear among the IP SANs, a name host among the DNS SANs
// (RFC 6125 — the two lists are not interchangeable).
func webAccessCertCoversHost(leaf *x509.Certificate, host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		for _, san := range leaf.IPAddresses {
			if san.Equal(ip) {
				return true
			}
		}
		return false
	}
	for _, san := range leaf.DNSNames {
		if strings.EqualFold(san, host) {
			return true
		}
	}
	return false
}

// restartWebAccessOrRollbackLocked hot-restarts a running sidecar onto the
// just-persisted config state; when the sidecar is not running it is a no-op
// (the persisted write was the whole effect). If the restart cannot serve
// (e.g. the pinned port is already taken), prev — the section state the
// sidecar was running with — is restored in memory, persisted, and the
// sidecar is brought back on it; the returned error names both failures and
// the app is never left silently without a sidecar it had before. Callers
// hold webAccessMu and have already persisted the new state into cfg; what
// names the change in error messages comes through what.
func (a *App) restartWebAccessOrRollbackLocked(prev config.WebAccessConfig, cfg *config.Config, cfgPath, what string) error {
	if a.webAccess.Load() == nil {
		return nil
	}

	// Hot-restart onto the new state. The stop's error is deliberately not
	// fatal here: the start below needs the listener gone, and a failed stop
	// surfaces through the start failure (the old socket still holds the
	// port) — the rollback path then restores the previous state.
	sctx, cancel := context.WithTimeout(context.Background(), webAccessStopBudget)
	defer cancel()
	_ = a.stopWebAccessLocked(sctx)
	srv, err := a.startWebAccessLocked(a.log())
	if err == nil {
		logWebAccessReady(a.log(), srv)
		return nil
	}

	// The new state does not serve. Restore the previous one on disk and
	// bring the sidecar back up on it; both failures are named to the caller.
	cfg.WebAccess = prev
	if saveErr := config.Save(cfg, cfgPath); saveErr != nil {
		a.log().Error("web access: failed to persist the rolled-back settings", "err", saveErr)
	}
	restored, restartErr := a.startWebAccessLocked(a.log())
	if restartErr != nil {
		return fmt.Errorf(
			"web access %s not applied: the sidecar failed to start with the new settings (%w) and could not be restored on the previous ones (%w) — it will retry on the next launch",
			what, err, restartErr)
	}
	logWebAccessReady(a.log(), restored)
	return fmt.Errorf(
		"web access %s not applied: the sidecar failed to start with the new settings (%w); the previous settings were restored and the sidecar is running again",
		what, err)
}

// startWebAccessLocked constructs and starts the sidecar and publishes the
// handle + event tap. Callers must hold webAccessMu. Idempotent on a live
// server: it returns the running one so a startup mount and a toggle can
// never double-bind.
func (a *App) startWebAccessLocked(log *slog.Logger) (*webaccess.Server, error) {
	if cur := a.webAccess.Load(); cur != nil {
		return cur, nil
	}
	cfg, cfgPath := a.configRef()
	if cfg == nil || cfgPath == "" {
		return nil, errors.New("config not initialized")
	}
	// The persistent credential: an empty config token means "mint one, now"
	// — generated once and written back through the same immediate config
	// save every other settings change uses (ADR-090). From the first start
	// on the credential is stable across restarts; the sidecar's own
	// per-launch fallback stays as defense-in-depth for direct construction.
	if cfg.WebAccess.Token == "" {
		tok, err := webaccess.GenerateToken()
		if err != nil {
			return nil, fmt.Errorf("web access: generating auth token: %w", err)
		}
		prev := cfg.WebAccess
		cfg.WebAccess.Token = tok
		if err := config.Save(cfg, cfgPath); err != nil {
			cfg.WebAccess = prev
			return nil, fmt.Errorf("web access: failed to persist the generated auth token: %w", err)
		}
		log.Info("web access: generated a persistent auth token (the config token was empty)")
	}
	srv, err := webaccess.New(webaccess.Options{
		Config:   cfg.WebAccess,
		Dispatch: a.frontendAPI(),
		// App-level methods the mirrored UI needs, behind the minimal
		// adapter (desktop/webaccess_extra.go) — never the App itself.
		ExtraDispatch: &webExtraSurface{app: a},
		Static:        a.webAccessStatic,
		CSP:           CSPMiddleware(),
		Logger:        log,
		// The browser-side twin of wireWailsEventListeners: an authenticated
		// tab resolves the whitelisted HITL response events through the same
		// App handlers the Wails runtime path uses (desktop/webaccess_inbound.go).
		WSInbound: a.webWSInboundDispatcher(log),
	})
	if err != nil {
		return nil, err
	}
	if err := srv.Start(context.Background()); err != nil {
		return nil, err
	}
	// Publish the handle before the tap: once events fan out, a concurrent
	// GetWebAccessInfo must already see Running.
	a.webAccess.Store(srv)
	a.setEventTap(srv.EventTap())
	return srv, nil
}

// stopWebAccessLocked detaches and stops the live sidecar. Callers must hold
// webAccessMu. The handle and tap are cleared BEFORE the stop so events stop
// flowing to a dying server and a concurrent toggle sees "not running"
// immediately; the stop itself is idempotent (Server.Stop is once-guarded).
// A nil handle is a no-op.
func (a *App) stopWebAccessLocked(ctx context.Context) error {
	srv := a.webAccess.Load()
	if srv == nil {
		return nil
	}
	a.webAccess.Store(nil)
	a.setEventTap(nil)
	return srv.Stop(ctx)
}

// logWebAccessReady records the sidecar's URL at Info. The auth token is
// deliberately NOT part of the record — it is app-secret material (the
// Settings section reveals it on demand); the log only names where a browser
// connects and that a credential exists.
func logWebAccessReady(log *slog.Logger, srv *webaccess.Server) {
	addr, ok := srv.Addr()
	if !ok {
		addr = "(unresolved)"
	}
	log.Info("web access sidecar ready", "url", webAccessBrowserURL(addr, srv.TLSEnabled()),
		"token", "(hidden — see Settings → Web Access)")
}
