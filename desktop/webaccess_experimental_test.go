// SPDX-License-Identifier: Apache-2.0
//
// webaccess_experimental_test.go — the experimental master gate over the
// browser web-access sidecar (ADR-098): the startup mount requires BOTH the
// section's own switch and experimental.enabled; a mid-session gate change
// live-follows through the backend hook (UpdateExperimentalFeatures → the
// OnExperimentalChanged FrontendAPIConfig seam → applyExperimentalWebAccess)
// instead of waiting for the next launch.

package desktop

import (
	"bytes"
	"context"
	"log/slog"
	"strconv"
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/backend"
	"github.com/v0lka/c0wrk/backend/config"
)

// TestInitWebAccess_ExperimentalGateClosedSkipsMount pins the gate the task
// fixes: web_access.enabled: true alone must NOT mount the sidecar while the
// experimental master gate is closed — including its absent-section default
// (false), which is exactly every pre-existing config.yaml at the moment the
// feature shipped. The skip must be QUIET (Debug): an intentionally-off
// feature is not a failure, so no ERROR record may land in the log.
func TestInitWebAccess_ExperimentalGateClosedSkipsMount(t *testing.T) {
	for name, experimental := range map[string]string{
		"section absent":   "",
		"explicitly false": "experimental:\n  enabled: false\n",
	} {
		t.Run(name, func(t *testing.T) {
			port := reserveLoopbackPort(t)
			cfg, path := writeWebAccessConfigGate(t, experimental, "web_access:\n  enabled: true\n  port: "+strconv.Itoa(port)+"\n")

			// A Debug-level buffer (unlike newWebAccessTestApp's Error-only
			// logger) so the skip record itself is observable.
			var buf bytes.Buffer
			a := NewApp()
			a.logger = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
			a.setConfigRef(cfg, path)
			t.Cleanup(func() { a.stopWebAccess(context.Background()) })

			a.initWebAccess(cfg, a.log())

			if srv := a.webAccess.Load(); srv != nil {
				t.Fatalf("closed experimental gate: sidecar handle = %v, want nil", srv)
			}
			if a.eventTap.Load() != nil {
				t.Error("closed experimental gate: event tap is set — events would fan out to nowhere")
			}
			if dialLoopback(port) {
				t.Errorf("something listens on reserved port %d behind a closed experimental gate", port)
			}

			logs := buf.String()
			if strings.Contains(logs, "level=ERROR") {
				t.Errorf("the closed gate must skip quietly, got an ERROR record:\n%s", logs)
			}
			if !strings.Contains(logs, "level=DEBUG") || !strings.Contains(logs, "web access sidecar not mounted") {
				t.Errorf("the closed gate must leave a Debug skip record, got:\n%s", logs)
			}
		})
	}
}

// TestInitWebAccess_ExperimentalGateOpenMounts pins the positive combination:
// both gates open → the startup mount proceeds exactly as before the gate
// existed.
func TestInitWebAccess_ExperimentalGateOpenMounts(t *testing.T) {
	cfg, path := writeWebAccessConfigGate(t, "experimental:\n  enabled: true\n", "web_access:\n  enabled: true\n")
	a := newWebAccessTestApp(t, cfg, path)

	a.initWebAccess(cfg, a.log())

	srv := a.webAccess.Load()
	if srv == nil {
		t.Fatal("both gates open: sidecar handle is nil — the sidecar did not mount")
	}
	if _, ok := srv.Addr(); !ok {
		t.Fatal("both gates open: sidecar has no resolved listener address")
	}
	if a.eventTap.Load() == nil {
		t.Error("both gates open: event tap is nil after a successful mount")
	}
}

// TestApplyExperimentalWebAccess_LiveFollowStartAndStop drives the desktop
// hook through a full open/close cycle on a config whose startup mount was
// skipped (gate closed, section on): opening the gate mounts mid-session,
// closing it stops the sidecar, and both no-op combinations stay inert.
func TestApplyExperimentalWebAccess_LiveFollowStartAndStop(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg, path := writeWebAccessConfigGate(t, "experimental:\n  enabled: false\n", "web_access:\n  enabled: true\n  port: "+strconv.Itoa(port)+"\n")
	a := newWebAccessTestApp(t, cfg, path)

	// Startup: gate closed → no mount, even though the section is on.
	a.initWebAccess(cfg, a.log())
	if a.webAccess.Load() != nil {
		t.Fatal("precondition: the closed-gate startup mount should have skipped")
	}
	if dialLoopback(port) {
		t.Fatal("precondition: nothing should listen before the hook opens the gate")
	}

	// Open: hook mounts mid-session (a pinned port must be taken exactly
	// once — a double bind would fail the start and log an Error).
	a.applyExperimentalWebAccess(true)
	srv := a.webAccess.Load()
	if srv == nil {
		t.Fatal("gate opened: sidecar handle is nil — the hook did not mount")
	}
	if a.eventTap.Load() == nil {
		t.Error("gate opened: event tap is nil — browser clients would receive no events")
	}
	if !dialLoopback(port) {
		t.Errorf("nothing accepts on the pinned port %d after the hook opened the gate", port)
	}

	// Idempotent open: a repeated open over the live sidecar is a no-op —
	// the same handle, still one listener on the same port.
	again := a.webAccess.Load()
	a.applyExperimentalWebAccess(true)
	if a.webAccess.Load() != again {
		t.Error("repeated open swapped the live sidecar handle — startWebAccessLocked is not idempotent on a live server")
	}
	if !dialLoopback(port) {
		t.Errorf("listener lost after an idempotent repeated open (port %d)", port)
	}

	// Close: hook stops the running sidecar.
	a.applyExperimentalWebAccess(false)
	if srv := a.webAccess.Load(); srv != nil {
		t.Fatalf("gate closed: sidecar handle = %v, want nil", srv)
	}
	if a.eventTap.Load() != nil {
		t.Error("gate closed: event tap is still set — events would fan out to a dead server")
	}
	if dialLoopback(port) {
		t.Errorf("something still listens on port %d after the hook closed the gate", port)
	}

	// Inert close: closing an already-closed gate is a no-op (no stop of a
	// nil sidecar, no log noise beyond the Debug level of the test logger).
	a.applyExperimentalWebAccess(false)
	if a.webAccess.Load() != nil {
		t.Error("gate closed twice: sidecar handle reappeared")
	}
}

// TestApplyExperimentalWebAccess_SectionOffMountsNothing pins the section's
// own switch as an independent gate: an OPEN experimental gate whose
// web_access.enabled is false must not start the sidecar.
func TestApplyExperimentalWebAccess_SectionOffMountsNothing(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg, path := writeWebAccessConfigGate(t, "experimental:\n  enabled: false\n", "web_access:\n  enabled: false\n  port: "+strconv.Itoa(port)+"\n")
	a := newWebAccessTestApp(t, cfg, path)

	a.applyExperimentalWebAccess(true)

	if a.webAccess.Load() != nil {
		t.Fatal("section off: sidecar handle is set — the hook started the sidecar against its own disabled switch")
	}
	if dialLoopback(port) {
		t.Errorf("something listens on reserved port %d with web_access.enabled=false", port)
	}
}

// TestSetWebAccessEnabled_ExperimentalGateClosedPersistsButMountsNothing pins
// the third mount decision (ADR-098 decision 13): the PUBLIC SetWebAccessEnabled
// binding persists the section switch with the master gate closed, but starts
// no sidecar — a closed gate cannot be bypassed by a programmatic caller, a
// config-restore path or a webview-console invocation. The skip is quiet
// (Debug), the disable toggle behind the closed gate is a clean no-op, and
// opening the gate afterwards mounts the persisted-on section through the
// live-follow hook.
func TestSetWebAccessEnabled_ExperimentalGateClosedPersistsButMountsNothing(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg, path := writeWebAccessConfigGate(t, "experimental:\n  enabled: false\n", "web_access:\n  enabled: false\n  port: "+strconv.Itoa(port)+"\n")

	// A Debug-level buffer (unlike newWebAccessTestApp's Error-only logger)
	// so the quiet-skip record itself is observable and any ERROR/WARN
	// diagnostic fails the test.
	var buf bytes.Buffer
	a := NewApp()
	a.logger = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	a.setConfigRef(cfg, path)
	t.Cleanup(func() { a.stopWebAccess(context.Background()) })

	// Toggle on behind the closed gate: persisted, unmounted, quiet.
	if err := a.SetWebAccessEnabled(true); err != nil {
		t.Fatalf("SetWebAccessEnabled(true) behind the closed gate: %v", err)
	}
	if a.webAccess.Load() != nil {
		t.Fatal("closed experimental gate: the toggle mounted the sidecar — gate bypass")
	}
	if a.eventTap.Load() != nil {
		t.Error("closed experimental gate: the toggle set the event tap")
	}
	if dialLoopback(port) {
		t.Errorf("something listens on reserved port %d behind the closed gate", port)
	}
	persisted, err := config.Load(path)
	if err != nil {
		t.Fatalf("config.Load after the gated toggle: %v", err)
	}
	if !persisted.WebAccess.Enabled {
		t.Error("web_access.enabled was not persisted by the gated toggle — operator intent lost")
	}

	// The disable toggle behind the closed gate is a clean no-op.
	if err := a.SetWebAccessEnabled(false); err != nil {
		t.Fatalf("SetWebAccessEnabled(false) behind the closed gate: %v", err)
	}
	if a.webAccess.Load() != nil {
		t.Fatal("disable toggle behind the closed gate left a sidecar handle")
	}
	persisted, err = config.Load(path)
	if err != nil {
		t.Fatalf("config.Load after the gated disable: %v", err)
	}
	if persisted.WebAccess.Enabled {
		t.Error("web_access.enabled still on after the gated disable")
	}

	// Re-enable, then open the gate: the live-follow hook mounts the
	// persisted-on section mid-session.
	if err := a.SetWebAccessEnabled(true); err != nil {
		t.Fatalf("re-enable behind the closed gate: %v", err)
	}
	a.applyExperimentalWebAccess(true)
	if a.webAccess.Load() == nil {
		t.Fatal("gate opened after the gated toggle: sidecar handle is nil — the hook did not mount")
	}
	if !dialLoopback(port) {
		t.Errorf("nothing accepts on the pinned port %d after the gate opened", port)
	}

	// The disable toggle still stops the live sidecar (gate now open).
	if err := a.SetWebAccessEnabled(false); err != nil {
		t.Fatalf("SetWebAccessEnabled(false) with the gate open: %v", err)
	}
	if a.webAccess.Load() != nil {
		t.Fatal("disable toggle left the sidecar running")
	}
	if dialLoopback(port) {
		t.Errorf("something still listens on port %d after the disable toggle", port)
	}

	logs := buf.String()
	if strings.Contains(logs, "level=ERROR") || strings.Contains(logs, "level=WARN") {
		t.Errorf("the gated toggle must stay quiet, got:\n%s", logs)
	}
	if !strings.Contains(logs, "web access enabled while the experimental gate is closed") {
		t.Errorf("the gated toggle must leave its Debug skip record, got:\n%s", logs)
	}
}

// TestUpdateExperimentalFeatures_HookStartsSidecarMidSession is the full
// cross-seam contract (ADR-098): a REAL FrontendAPI (Init'd, like production)
// carries the desktop hook, so UpdateExperimentalFeatures(true) persists the
// gate AND mounts the skipped sidecar in the same call, and
// UpdateExperimentalFeatures(false) stops it — no restart anywhere.
func TestUpdateExperimentalFeatures_HookStartsSidecarMidSession(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg, path := writeWebAccessConfigGate(t, "experimental:\n  enabled: false\n", "web_access:\n  enabled: true\n  port: "+strconv.Itoa(port)+"\n")

	// The startup_embedded_test pattern: a real FrontendAPI wired into the
	// App, over a temp agent dir, with an event recorder in place of the
	// Wails runtime. applyDefaults-free config: no skill/agent watchers
	// against the real user directories.
	agentDir := t.TempDir()
	recorder := &emitRecorder{}
	a := NewApp()
	a.logger = testLoggerForPhases()
	a.wailsEmit = recorder.emit
	a.FrontendAPI = backend.NewFrontendAPI(backend.FrontendAPIConfig{
		Config:                cfg,
		ConfigPath:            path,
		AgentDir:              agentDir,
		Logger:                a.logger,
		EmitEvent:             recorder.emit,
		AppCtx:                context.Background,
		OnExperimentalChanged: a.applyExperimentalWebAccess,
	})
	t.Cleanup(func() {
		a.stopWebAccess(context.Background())
		a.Lifecycle().Cleanup()
	})
	// Mirror buildFrontendAPI's wiring: the hook rides the FrontendAPIConfig
	// seam above (production hands it to Init inside buildFrontendAPI); the
	// config ref is captured the same way.
	a.setConfigRef(cfg, path)

	// Startup with the gate closed: the sidecar stays unmounted.
	a.initWebAccess(cfg, a.log())
	if a.webAccess.Load() != nil {
		t.Fatal("precondition: the closed-gate startup mount should have skipped")
	}

	// Enable mid-session: persist + hook in one call → the sidecar mounts.
	if err := a.frontendAPI().UpdateExperimentalFeatures(true); err != nil {
		t.Fatalf("UpdateExperimentalFeatures(true): %v", err)
	}
	if a.webAccess.Load() == nil {
		t.Fatal("gate enabled mid-session: sidecar handle is nil — the hook did not mount")
	}
	if !dialLoopback(port) {
		t.Errorf("nothing accepts on the pinned port %d after the mid-session enable", port)
	}
	persisted, err := config.Load(path)
	if err != nil {
		t.Fatalf("config.Load after enable: %v", err)
	}
	if !persisted.Experimental.Enabled {
		t.Error("persisted experimental.enabled = false after the mid-session enable, want true")
	}

	// Disable mid-session: the running sidecar stops in the same call.
	if err := a.frontendAPI().UpdateExperimentalFeatures(false); err != nil {
		t.Fatalf("UpdateExperimentalFeatures(false): %v", err)
	}
	if srv := a.webAccess.Load(); srv != nil {
		t.Fatalf("gate disabled mid-session: sidecar handle = %v, want nil", srv)
	}
	if dialLoopback(port) {
		t.Errorf("something still listens on port %d after the mid-session disable", port)
	}
	persisted, err = config.Load(path)
	if err != nil {
		t.Fatalf("config.Load after disable: %v", err)
	}
	if persisted.Experimental.Enabled {
		t.Error("persisted experimental.enabled = true after the mid-session disable, want false")
	}
}
