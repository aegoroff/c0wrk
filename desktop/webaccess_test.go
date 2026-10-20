// SPDX-License-Identifier: Apache-2.0
//
// webaccess_test.go — the desktop lifecycle of the browser web-access
// sidecar (ADR-090): the startup mount, the bounded shutdown stop, the
// hot-restart toggle, and the isolation invariant that the control RPCs are
// unreachable from the web dispatch surface.
//
// Every listener-binding test uses a RESERVED loopback port (bound and
// released up front) or port 0 (auto), so the suite never races itself or a
// foreign listener; "nothing listens" is asserted by an actual dial, not by
// absence of a handle.

package desktop

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/internal/webaccess"
)

// writeWebAccessConfig writes a loadable config.yaml (the smallest document
// the loader accepts) with an optional web_access block, loads it through the
// real pipeline, and returns the live config plus its path.
func writeWebAccessConfig(t *testing.T, webAccess string) (cfg *config.Config, path string) {
	t.Helper()
	doc := `
llm:
  default_model: claude-3-haiku
  anthropic:
    api_key: "test-key"
    models:
      - claude-3-haiku
`
	if webAccess != "" {
		doc += "\n" + webAccess + "\n"
	}
	path = filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(doc), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	loaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	cfg = loaded
	return cfg, path
}

// reserveLoopbackPort binds 127.0.0.1:0, closes the listener immediately and
// returns its port. The port is reserved only against concurrent tests in
// this process — the assertion dials decide listening or not.
func reserveLoopbackPort(t *testing.T) int {
	t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve loopback port: %v", err)
	}
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("reservation address %v is not a TCP address", ln.Addr())
	}
	port := addr.Port
	if err := ln.Close(); err != nil {
		t.Fatalf("close reservation listener: %v", err)
	}
	return port
}

// dialLoopback reports whether anything accepts TCP on 127.0.0.1:port within
// a bounded wait (false = connection refused / unreachable = nothing there).
func dialLoopback(port int) bool {
	dialer := &net.Dialer{Timeout: 500 * time.Millisecond}
	conn, err := dialer.DialContext(context.Background(), "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// newWebAccessTestApp builds an App whose logger buffers everything below
// Error (no test-output noise from the sidecar's Info records) and whose
// config ref points at the given live config. The embedded FrontendAPI is
// NewApp's zero-value seed — exactly what production mounts before Init, and
// all the reflection dispatcher needs to resolve the surface.
func newWebAccessTestApp(t *testing.T, cfg *config.Config, path string) *App {
	t.Helper()
	a := NewApp()
	a.logger = slog.New(slog.NewTextHandler(&strings.Builder{}, &slog.HandlerOptions{Level: slog.LevelError}))
	a.setConfigRef(cfg, path)
	t.Cleanup(func() {
		a.stopWebAccess(context.Background())
	})
	return a
}

func TestInitWebAccess_StartsSidecarWhenEnabled(t *testing.T) {
	cfg, path := writeWebAccessConfig(t, `
web_access:
  enabled: true
`)
	a := newWebAccessTestApp(t, cfg, path)

	a.initWebAccess(cfg, a.log())

	srv := a.webAccess.Load()
	if srv == nil {
		t.Fatal("enabled section: sidecar handle is nil — the sidecar did not mount")
	}
	addr, ok := srv.Addr()
	if !ok {
		t.Fatal("enabled section: sidecar has no resolved listener address")
	}
	if !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Errorf("listener address = %q, want the loopback bind", addr)
	}
	if a.eventTap.Load() == nil {
		t.Error("event tap is nil after a successful mount — browser clients would receive no events")
	}

	info := a.GetWebAccessInfo()
	if !info.Enabled || !info.Running {
		t.Errorf("info = %+v, want enabled+running", info)
	}
	if !strings.HasPrefix(info.URL, "http://127.0.0.1:") {
		t.Errorf("info.URL = %q, want an http loopback URL", info.URL)
	}
	if info.Port == 0 {
		t.Errorf("info.Port = 0, want the resolved auto port")
	}
	// An empty config token is minted once at the first start and persisted
	// (ADR-090) — the login screen credential must exist, and it is only
	// ever revealed here.
	if info.Token == "" {
		t.Error("info.Token is empty — the browser login could never authenticate")
	}
	if !dialLoopback(info.Port) {
		t.Errorf("nothing accepts on %d after the mount", info.Port)
	}
}

func TestInitWebAccess_DisabledStartsNothing(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg, path := writeWebAccessConfig(t, `
web_access:
  enabled: false
  port: `+strconv.Itoa(port)+`
`)
	a := newWebAccessTestApp(t, cfg, path)

	a.initWebAccess(cfg, a.log())

	if srv := a.webAccess.Load(); srv != nil {
		t.Fatalf("disabled section: sidecar handle = %v, want nil", srv)
	}
	if a.eventTap.Load() != nil {
		t.Error("disabled section: event tap is set — events would fan out to nowhere")
	}
	if dialLoopback(port) {
		t.Errorf("something listens on reserved port %d after a disabled mount", port)
	}
	info := a.GetWebAccessInfo()
	if info.Enabled || info.Running || info.URL != "" || info.Port != 0 {
		t.Errorf("info = %+v, want the all-off state", info)
	}
	if info.Token != "" {
		t.Errorf("info.Token = %q, want empty (a disabled section carries no credential)", info.Token)
	}
}

// TestGetWebAccessInfo_BindFields: the info surface exposes the persisted
// bind pin and its loopback classification, running or not.
func TestGetWebAccessInfo_BindFields(t *testing.T) {
	t.Run("running on the loopback default", func(t *testing.T) {
		cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: true\n")
		a := newWebAccessTestApp(t, cfg, path)
		a.initWebAccess(cfg, a.log())

		info := a.GetWebAccessInfo()
		if !info.Running {
			t.Fatal("sidecar did not mount")
		}
		// ApplyDefaults seeds the empty bind with the loopback default, so
		// the pin is always an explicit address.
		if info.ConfiguredBind != config.DefaultWebAccessBind {
			t.Errorf("info.ConfiguredBind = %q, want the seeded default %q", info.ConfiguredBind, config.DefaultWebAccessBind)
		}
		if !info.BindIsLoopback {
			t.Error("info.BindIsLoopback = false, want true for the loopback default")
		}
		if !strings.HasPrefix(info.URL, "http://127.0.0.1:") {
			t.Errorf("info.URL = %q, want the resolved loopback URL as-is", info.URL)
		}
	})
	t.Run("wildcard bind visible while not running", func(t *testing.T) {
		// A disabled section accepts any bind (no load warning) — the pin is
		// reported as configured, classified non-loopback, with no URL (the
		// sidecar never resolved a listener).
		cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: false\n  bind: 0.0.0.0\n")
		a := newWebAccessTestApp(t, cfg, path)

		info := a.GetWebAccessInfo()
		if info.Running || info.URL != "" {
			t.Errorf("info = %+v, want not running with no URL", info)
		}
		if info.ConfiguredBind != "0.0.0.0" {
			t.Errorf("info.ConfiguredBind = %q, want 0.0.0.0", info.ConfiguredBind)
		}
		if info.BindIsLoopback {
			t.Error("info.BindIsLoopback = true, want false for the wildcard bind")
		}
	})
	t.Run("wildcard bind resolves a localhost URL", func(t *testing.T) {
		// A running wildcard listener (the sidecar binds 0.0.0.0 for real)
		// must surface the browser-openable localhost form — no browser can
		// open http://0.0.0.0:port — while the machine-local dial still
		// reaches the very listener behind it.
		cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: true\n  bind: 0.0.0.0\n")
		a := newWebAccessTestApp(t, cfg, path)
		a.initWebAccess(cfg, a.log())

		info := a.GetWebAccessInfo()
		if !info.Running {
			t.Fatal("sidecar did not mount")
		}
		if !strings.HasPrefix(info.URL, "http://localhost:") {
			t.Errorf("info.URL = %q, want the localhost form of the wildcard listener", info.URL)
		}
		if info.ConfiguredBind != "0.0.0.0" || info.BindIsLoopback {
			t.Errorf("info bind = (%q, loopback=%v), want (0.0.0.0, false)", info.ConfiguredBind, info.BindIsLoopback)
		}
		if info.Port == 0 || !dialLoopback(info.Port) {
			t.Errorf("wildcard sidecar not reachable on its resolved port %d", info.Port)
		}
	})
}

// TestWebAccessBrowserURL pins the browser-openable URL mapping GetWebAccessInfo
// applies to the sidecar's resolved listener address: a wildcard host
// (0.0.0.0, ::) is rewritten to localhost — the machine-local way into an
// every-interface listener, which no browser can open by its wildcard name —
// while every specific address is reported exactly as bound. The live
// wildcard path through GetWebAccessInfo is pinned by
// TestGetWebAccessInfo_BindFields; this table pins the mapping itself.
func TestWebAccessBrowserURL(t *testing.T) {
	cases := []struct{ addr, want string }{
		{"0.0.0.0:8080", "http://localhost:8080"},
		{"[::]:9000", "http://localhost:9000"},
		{"127.0.0.1:41234", "http://127.0.0.1:41234"},
		{"[::1]:41235", "http://[::1]:41235"},
		{"192.168.1.10:8080", "http://192.168.1.10:8080"},
	}
	for _, tc := range cases {
		if got := webAccessBrowserURL(tc.addr); got != tc.want {
			t.Errorf("webAccessBrowserURL(%q) = %q, want %q", tc.addr, got, tc.want)
		}
	}
}

func TestInitWebAccess_NilGuards(t *testing.T) {
	t.Run("no FrontendAPI seed", func(t *testing.T) {
		a := &App{} // no NewApp: frontendAPI() is nil
		a.logger = slog.New(slog.NewTextHandler(&strings.Builder{}, &slog.HandlerOptions{Level: slog.LevelError}))
		cfg, _ := writeWebAccessConfig(t, "web_access:\n  enabled: true\n")
		a.initWebAccess(cfg, a.log())
		if a.webAccess.Load() != nil {
			t.Error("sidecar mounted without a FrontendAPI dispatch target")
		}
	})
	t.Run("nil config", func(t *testing.T) {
		a := NewApp()
		a.logger = slog.New(slog.NewTextHandler(&strings.Builder{}, &slog.HandlerOptions{Level: slog.LevelError}))
		a.initWebAccess(nil, a.log())
		if a.webAccess.Load() != nil {
			t.Error("sidecar mounted without config")
		}
	})
}

func TestStopWebAccess_BoundedEvenWithExpiredDeadline(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg, path := writeWebAccessConfig(t, `
web_access:
  enabled: true
  port: `+strconv.Itoa(port)+`
`)
	a := newWebAccessTestApp(t, cfg, path)
	a.initWebAccess(cfg, a.log())
	if a.webAccess.Load() == nil {
		t.Fatal("sidecar did not mount")
	}
	if !dialLoopback(port) {
		t.Fatalf("sidecar is not listening on %d before the stop", port)
	}

	// (1) The locked teardown must respect an EXPIRED caller deadline:
	// return promptly (never hang on the graceful phase) while still freeing
	// the port. Whether the drain beats the deadline or loses to it is
	// http.Server's call — with zero connections both outcomes are legal —
	// so only the BOUND and the teardown are asserted here. The busy case
	// (a live WebSocket forcing the deadline to win and the force close to
	// fire) is pinned deterministically by TestStopWithExpiredDeadlineForceCloses
	// in internal/webaccess.
	//
	// A past DEADLINE (not a bare cancel): Stop only honors a caller budget
	// when the context actually carries one. The wrapped budget inside the
	// Shutdown wrapper derives the child deadline from its parent, so this is
	// exactly the shape a watchdog expiry would deliver.
	expired, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()

	a.webAccessMu.Lock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = a.stopWebAccessLocked(expired)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("locked stop did not return within 5s of an expired deadline")
	}
	// (2) The Shutdown wrapper on a healthy context: the quiet path. Zero
	// expected diagnostics — a stop that took must not log anything.
	a.webAccessMu.Unlock()

	if srv := a.webAccess.Load(); srv != nil {
		t.Errorf("sidecar handle still set after the stop: %v", srv)
	}
	if a.eventTap.Load() != nil {
		t.Error("event tap still set after the stop")
	}
	if dialLoopback(port) {
		t.Errorf("port %d is still accepting after the bounded stop", port)
	}

	// Restart on the same configured port, then drive the full wrapper.
	a.webAccessMu.Lock()
	if _, err := a.startWebAccessLocked(a.log()); err != nil {
		a.webAccessMu.Unlock()
		t.Fatalf("restart after the bounded stop: %v", err)
	}
	a.webAccessMu.Unlock()
	if !dialLoopback(port) {
		t.Fatalf("restarted sidecar is not listening on %d", port)
	}
	injectExpectedDiagnostics(t, a)
	// stopWebAccess takes webAccessMu itself — call it unlocked.
	a.stopWebAccess(context.Background())

	// Idempotent: a second stop on the cleared handle is a no-op, not a panic.
	a.stopWebAccess(context.Background())
	if srv := a.webAccess.Load(); srv != nil {
		t.Errorf("sidecar handle set after the wrapper stop: %v", srv)
	}
}

func TestSetWebAccessEnabled_HotRestartPersists(t *testing.T) {
	port := reserveLoopbackPort(t)
	cfg, path := writeWebAccessConfig(t, `
web_access:
  enabled: true
  port: `+strconv.Itoa(port)+`
`)
	a := newWebAccessTestApp(t, cfg, path)
	a.initWebAccess(cfg, a.log())
	first := a.webAccess.Load()
	if first == nil {
		t.Fatal("sidecar did not mount")
	}

	// ── Disable: the listener dies, the file flips, the tap detaches ──
	if err := a.SetWebAccessEnabled(false); err != nil {
		t.Fatalf("SetWebAccessEnabled(false): %v", err)
	}
	if srv := a.webAccess.Load(); srv != nil {
		t.Errorf("handle still set after disable: %v", srv)
	}
	if a.eventTap.Load() != nil {
		t.Error("event tap still set after disable")
	}
	if dialLoopback(port) {
		t.Errorf("port %d still accepting after disable", port)
	}
	if reloaded, err := config.Load(path); err != nil {
		t.Fatalf("reload config after disable: %v", err)
	} else if reloaded.WebAccess.Enabled {
		t.Error("web_access.enabled is still true on disk after disable")
	}
	if info := a.GetWebAccessInfo(); info.Running || info.Enabled {
		t.Errorf("info after disable = %+v, want enabled=false running=false", info)
	}

	// ── Enable again: hot restart on the same configured port ──
	if err := a.SetWebAccessEnabled(true); err != nil {
		t.Fatalf("SetWebAccessEnabled(true): %v", err)
	}
	second := a.webAccess.Load()
	if second == nil {
		t.Fatal("sidecar did not restart on enable")
	}
	if second == first {
		t.Error("restart reused the stopped server instead of building a new one")
	}
	if a.eventTap.Load() == nil {
		t.Error("event tap not re-registered on enable")
	}
	if !dialLoopback(port) {
		t.Errorf("restarted sidecar is not listening on the configured port %d", port)
	}
	if reloaded, err := config.Load(path); err != nil {
		t.Fatalf("reload config after enable: %v", err)
	} else if !reloaded.WebAccess.Enabled {
		t.Error("web_access.enabled is false on disk after enable")
	}
	info := a.GetWebAccessInfo()
	if !info.Running || !info.Enabled || info.Port != port {
		t.Errorf("info after re-enable = %+v, want running on port %d", info, port)
	}

	// ── Matching request: a no-op that neither restarts nor rewrites ──
	before, _ := os.Stat(path)
	if err := a.SetWebAccessEnabled(true); err != nil {
		t.Fatalf("matching SetWebAccessEnabled(true): %v", err)
	}
	if a.webAccess.Load() != second {
		t.Error("matching enable rebuilt the sidecar")
	}
	after, _ := os.Stat(path)
	if !before.ModTime().Equal(after.ModTime()) {
		t.Error("matching enable rewrote the config file")
	}
}

func TestSetWebAccessEnabled_RequiresConfigRef(t *testing.T) {
	a := NewApp()
	a.logger = slog.New(slog.NewTextHandler(&strings.Builder{}, &slog.HandlerOptions{Level: slog.LevelError}))
	if err := a.SetWebAccessEnabled(true); err == nil {
		t.Fatal("expected an error without a config ref, got nil")
	} else if !strings.Contains(err.Error(), "config not initialized") {
		t.Errorf("error = %v, want the config-not-initialized message", err)
	}
}

// TestWebClientCannotCallControlRPCs pins the isolation invariant: the sidecar
// dispatches over the FrontendAPI surface, and the App-owned control RPCs are
// not on it — an authenticated browser tab gets "unknown method", never the
// sidecar's own controls.
func TestWebClientCannotCallControlRPCs(t *testing.T) {
	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: true\n")
	a := newWebAccessTestApp(t, cfg, path)
	a.initWebAccess(cfg, a.log())
	srv := a.webAccess.Load()
	if srv == nil {
		t.Fatal("sidecar did not mount")
	}

	for _, method := range []string{"SetWebAccessEnabled", "GetWebAccessInfo", "SetWebAccessConnection", "RegenerateWebAccessToken", "SetWebAccessToken"} {
		if srv.Dispatchable(method) {
			t.Errorf("%s is dispatchable over the web surface — the control RPC leaked into the reflection target", method)
		}
	}

	ts := newWebAccessHTTPTest(t, srv)
	client := loginWebAccessClient(t, ts.URL, srv.AuthToken())

	for _, method := range []string{"SetWebAccessEnabled", "GetWebAccessInfo", "SetWebAccessConnection", "RegenerateWebAccessToken", "SetWebAccessToken"} {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
			ts.URL+"/api/rpc/"+method, strings.NewReader("[]"))
		if err != nil {
			t.Fatalf("build POST /api/rpc/%s: %v", method, err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("POST /api/rpc/%s: %v", method, err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("POST /api/rpc/%s status = %d, want 404 (body: %s)", method, resp.StatusCode, body)
		}
		var env struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("decode error envelope: %v (body: %s)", err, body)
		}
		if !strings.Contains(env.Error, "unknown method") {
			t.Errorf("POST /api/rpc/%s error = %q, want the unknown-method envelope", method, env.Error)
		}
	}
}

// newWebAccessHTTPTest serves the sidecar's real handler (auth included) from
// an httptest server.
func newWebAccessHTTPTest(t *testing.T, srv *webaccess.Server) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// loginWebAccessClient performs the token login so the returned client holds
// the session cookie an authenticated browser tab would carry.
func loginWebAccessClient(t *testing.T, baseURL, token string) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	client := &http.Client{Jar: jar}
	loginBody, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		t.Fatalf("marshal login body: %v", err)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
		baseURL+"/api/login", strings.NewReader(string(loginBody)))
	if err != nil {
		t.Fatalf("build login request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("login status = %d, want 200 (body: %s)", resp.StatusCode, body)
	}
	return client
}
