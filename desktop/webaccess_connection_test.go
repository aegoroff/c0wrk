// SPDX-License-Identifier: Apache-2.0
//
// webaccess_connection_test.go — SetWebAccessConnection: the pinned
// port/token surface of the browser web-access sidecar (ADR-090 amendment,
// decision 10). Pins persist to config.yaml, apply live via a hot restart,
// roll back when the new pin cannot serve, and are refused by the same port
// validation the load/save paths use.

package desktop

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
)

// sidecarPort extracts the resolved listen port of a running sidecar, failing
// the test when it has none.
func sidecarPort(t *testing.T, a *App) int {
	t.Helper()
	srv := a.webAccess.Load()
	if srv == nil {
		t.Fatal("sidecar is not running")
	}
	addr, ok := srv.Addr()
	if !ok {
		t.Fatal("running sidecar has no resolved address")
	}
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("sidecar address %q: %v", addr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("sidecar port %q: %v", portStr, err)
	}
	return port
}

// TestSetWebAccessConnection_PinsAndHotRestarts: an auto-port sidecar is
// restarted onto the pinned port with the pinned token; both pins persist,
// the new token authenticates, and the info surface reports them.
func TestSetWebAccessConnection_PinsAndHotRestarts(t *testing.T) {
	pinned := reserveLoopbackPort(t)
	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: true\n")
	a := newWebAccessTestApp(t, cfg, path)
	a.initWebAccess(cfg, a.log())
	first := a.webAccess.Load()
	if first == nil {
		t.Fatal("sidecar did not mount")
	}

	if err := a.SetWebAccessConnection(pinned, "ops-token"); err != nil {
		t.Fatalf("SetWebAccessConnection: %v", err)
	}
	if a.webAccess.Load() == first {
		t.Error("hot restart reused the old server instead of building a new one")
	}
	// Start binds synchronously before returning, so the new listener is
	// already accepting once the call returned.
	if !dialLoopback(pinned) {
		t.Fatalf("sidecar is not listening on the pinned port %d", pinned)
	}

	reloaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if reloaded.WebAccess.Port != pinned || reloaded.WebAccess.Token != "ops-token" {
		t.Errorf("disk pin = (port %d, token %q), want (%d, ops-token)",
			reloaded.WebAccess.Port, reloaded.WebAccess.Token, pinned)
	}

	// The pinned token is the live credential: a browser login with it works.
	info := a.GetWebAccessInfo()
	if !info.Running || info.ConfiguredPort != pinned || !info.TokenPinned || info.Token != "ops-token" {
		t.Errorf("info = %+v, want running, configured_port=%d, token_pinned, token=ops-token", info, pinned)
	}
	ts := newWebAccessHTTPTest(t, a.webAccess.Load())
	client := loginWebAccessClient(t, ts.URL, "ops-token")
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.URL+"/api/transport", http.NoBody)
	if err != nil {
		t.Fatalf("build GET /api/transport: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("authenticated GET /api/transport: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		t.Errorf("authenticated transport probe status = %d, want 200", resp.StatusCode)
	}

	// Unpinning the token (empty) restarts onto the ephemeral mode.
	if err := a.SetWebAccessConnection(pinned, ""); err != nil {
		t.Fatalf("SetWebAccessConnection unpin token: %v", err)
	}
	if a.webAccess.Load().AuthToken() == "" {
		t.Error("ephemeral mode produced an empty live token")
	}
	reloaded, err = config.Load(path)
	if err != nil {
		t.Fatalf("reload config after unpin: %v", err)
	}
	if reloaded.WebAccess.Token != "" {
		t.Errorf("token still pinned on disk: %q", reloaded.WebAccess.Token)
	}
}

// TestSetWebAccessConnection_RestartFailureRestoresPreviousPin: a pin whose
// port is already taken must not take the sidecar down — the previous pin is
// restored on disk and the sidecar comes back on it, with the failure named.
func TestSetWebAccessConnection_RestartFailureRestoresPreviousPin(t *testing.T) {
	occupied := reserveLoopbackPort(t)
	// Hold the port for the whole call: the restart onto it must fail.
	var lc net.ListenConfig
	ln, err := lc.Listen(context.Background(), "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(occupied)))
	if err != nil {
		t.Fatalf("occupy port %d: %v", occupied, err)
	}
	defer func() { _ = ln.Close() }()

	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: true\n  token: keep-me\n")
	a := newWebAccessTestApp(t, cfg, path)
	a.initWebAccess(cfg, a.log())
	before := a.webAccess.Load()
	if before == nil {
		t.Fatal("sidecar did not mount")
	}

	if err := a.SetWebAccessConnection(occupied, ""); err == nil {
		t.Fatal("expected an error when the pinned port is already taken")
	} else if !strings.Contains(err.Error(), "previous settings were restored") {
		t.Errorf("error = %v, want the restored-previous-settings message", err)
	}

	restored := a.webAccess.Load()
	if restored == nil {
		t.Fatal("sidecar did not come back after the rollback")
	}
	if restored == before {
		t.Error("rollback reused the stopped server instead of building a new one")
	}
	// Port 0 = auto: the restored sidecar legitimately binds a fresh free
	// port, so the assertion is "listening", not "the same port".
	portAfter := sidecarPort(t, a)
	if !dialLoopback(portAfter) {
		t.Errorf("restored sidecar is not listening on its resolved port %d", portAfter)
	}
	reloaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if reloaded.WebAccess.Port != 0 || reloaded.WebAccess.Token != "keep-me" {
		t.Errorf("disk after rollback = (port %d, token %q), want (0, keep-me)",
			reloaded.WebAccess.Port, reloaded.WebAccess.Token)
	}
	if info := a.GetWebAccessInfo(); !info.Running || !info.TokenPinned {
		t.Errorf("info after rollback = %+v, want running with token_pinned=true (the original pin)", info)
	}
}

// TestSetWebAccessConnection_ValidationRefused: an out-of-range port is
// rejected with the shared message and mutates neither disk nor runtime.
func TestSetWebAccessConnection_ValidationRefused(t *testing.T) {
	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: true\n")
	a := newWebAccessTestApp(t, cfg, path)
	a.initWebAccess(cfg, a.log())
	srv := a.webAccess.Load()
	if srv == nil {
		t.Fatal("sidecar did not mount")
	}
	statBefore, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}

	for _, port := range []int{-1, 65536} {
		if err := a.SetWebAccessConnection(port, ""); err == nil {
			t.Errorf("SetWebAccessConnection(%d): expected a validation error", port)
		} else if !strings.Contains(err.Error(), "out of range") {
			t.Errorf("SetWebAccessConnection(%d) error = %v, want the out-of-range message", port, err)
		}
	}
	if a.webAccess.Load() != srv {
		t.Error("a rejected validation rebuilt the sidecar")
	}
	statAfter, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat config after rejection: %v", err)
	}
	if !statBefore.ModTime().Equal(statAfter.ModTime()) {
		t.Error("a rejected validation rewrote the config file")
	}
}

// TestSetWebAccessConnection_NotRunningPersistsOnly: with the sidecar off,
// the pin lands on disk and takes effect at the next start — no sidecar is
// started by the call itself.
func TestSetWebAccessConnection_NotRunningPersistsOnly(t *testing.T) {
	pinned := reserveLoopbackPort(t)
	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: false\n")
	a := newWebAccessTestApp(t, cfg, path)

	if err := a.SetWebAccessConnection(pinned, "next-launch"); err != nil {
		t.Fatalf("SetWebAccessConnection: %v", err)
	}
	if a.webAccess.Load() != nil {
		t.Error("the call started the sidecar while web access is disabled")
	}
	if dialLoopback(pinned) {
		t.Error("something listens on the pinned port while the sidecar is off")
	}
	reloaded, err := config.Load(filepath.Join(filepath.Dir(path), "config.yaml"))
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if reloaded.WebAccess.Port != pinned || reloaded.WebAccess.Token != "next-launch" {
		t.Errorf("disk pin = (port %d, token %q), want (%d, next-launch)",
			reloaded.WebAccess.Port, reloaded.WebAccess.Token, pinned)
	}
	info := a.GetWebAccessInfo()
	if info.Running || info.ConfiguredPort != pinned || !info.TokenPinned || info.Token != "next-launch" {
		t.Errorf("info = %+v, want configured pin visible while not running", info)
	}
}

// TestSetWebAccessConnection_RequiresConfigRef mirrors the toggle's guard.
func TestSetWebAccessConnection_RequiresConfigRef(t *testing.T) {
	a := NewApp()
	a.logger = slog.New(slog.NewTextHandler(&strings.Builder{}, &slog.HandlerOptions{Level: slog.LevelError}))
	if err := a.SetWebAccessConnection(8080, ""); err == nil {
		t.Fatal("expected an error without a config ref, got nil")
	} else if !strings.Contains(err.Error(), "config not initialized") {
		t.Errorf("error = %v, want the config-not-initialized message", err)
	}
}
