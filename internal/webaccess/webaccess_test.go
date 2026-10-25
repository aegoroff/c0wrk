// SPDX-License-Identifier: Apache-2.0
//
// webaccess_test.go — the httptest security/behavior matrix for the sidecar
// core: auth gating of every route, login flows (static + per-launch token),
// cookie flags, the same-origin/content-type CSRF gates on the POST routes,
// transport discovery, static+CSP serving, body limits,
// handler-panic isolation, and the login rate limiter.
//
// Deliberately exercised failure paths (4xx/panics/rate limits) capture the
// server's diagnostics through an injected slog handler and assert on them —
// the test output stays clean on success.

package webaccess

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
)

// stubDispatch is a reflective dispatch target covering the Wails return
// conventions: (), (T), (T, error), (error), multi-value.
type stubDispatch struct{}

func (stubDispatch) Echo(s string) string          { return "echo:" + s }
func (stubDispatch) NoArgs() string                { return "bare" }
func (stubDispatch) Multi(n int, flag bool) string { return fmt.Sprintf("%d-%t", n, flag) }
func (stubDispatch) Failing(ok bool) (string, error) {
	if ok {
		return "fine", nil
	}
	return "", errors.New("kaboom")
}
func (stubDispatch) OnlyError() error                { return nil }
func (stubDispatch) Pair() (seven int, name string)  { return 7, "seven" }
func (stubDispatch) Boom() string                    { panic("boom from method") }
func (stubDispatch) VariadicProbe(xs ...int) int     { return len(xs) }
func (stubDispatch) ChanParamProbe(ch chan int) int  { return len(ch) } //nolint:revive // structural test probe
func (stubDispatch) FuncParamProbe(f func() int) int { return f() }     //nolint:revive // structural test probe

// captureHandler is an slog handler collecting records for assertions.
type captureHandler struct {
	mu      sync.Mutex
	records []slog.Record
}

func (h *captureHandler) Enabled(_ context.Context, _ slog.Level) bool { return true }
func (h *captureHandler) Handle(_ context.Context, r slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append(h.records, r.Clone())
	return nil
}
func (h *captureHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *captureHandler) WithGroup(string) slog.Handler      { return h }

func (h *captureHandler) count(t *testing.T, msg string) int {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, r := range h.records {
		if r.Message == msg {
			n++
		}
	}
	return n
}

// snapshot returns a copy of the collected records for full level+message
// assertions.
func (h *captureHandler) snapshot() []slog.Record {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]slog.Record(nil), h.records...)
}

// newTestOptions builds valid options with a capture logger.
func newTestOptions(dispatch any, mutate func(*Options)) Options {
	opts := Options{
		Config: config.WebAccessConfig{
			Enabled: true,
			Bind:    config.DefaultWebAccessBind,
			Port:    0,
			Token:   "static-test-token-0123456789",
		},
		Dispatch: dispatch,
		Logger:   slog.New(&discardHandler{}),
	}
	if mutate != nil {
		mutate(&opts)
	}
	return opts
}

// discardHandler swallows diagnostics for tests that do not assert on them.
type discardHandler struct{}

func (discardHandler) Enabled(context.Context, slog.Level) bool  { return false }
func (discardHandler) Handle(context.Context, slog.Record) error { return nil }
func (h discardHandler) WithAttrs([]slog.Attr) slog.Handler      { return h }
func (h discardHandler) WithGroup(string) slog.Handler           { return h }

// newTestServer builds a server over stubDispatch and serves it on a real
// httptest listener (so Host/Origin semantics are realistic).
func newTestServer(t *testing.T, mutate func(*Options)) (srv *Server, ts *httptest.Server) {
	t.Helper()
	srv = mustNew(t, newTestOptions(stubDispatch{}, mutate))
	ts = httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

func mustNew(t *testing.T, opts Options) *Server {
	t.Helper()
	srv, err := New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv
}

// loginClient returns a client that has authenticated once.
func loginClient(t *testing.T, baseURL, token string) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	client := &http.Client{Jar: jar}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		baseURL+"/api/login", strings.NewReader(`{"token":`+jsonQuote(token)+`}`))
	if err != nil {
		t.Fatalf("login request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("login status = %d, body = %s", resp.StatusCode, body)
	}
	return client
}

func jsonQuote(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// doJSON performs a request against the test server and returns the recorder.
// Content-Type: application/json is always set — mirroring the official shim
// (runtime.ts), which sends it on every RPC/login call including zero-argument
// ones, as the jsonContentTypeGate requires.
func doJSON(t *testing.T, client *http.Client, method, url, body string) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, url, rdr)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("do %s %s: %v", method, url, err)
	}
	return resp
}

func bodyString(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(b)
}

func staticFS() fs.FS {
	return fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte("<html>spa shell</html>")},
		"assets/app.js": &fstest.MapFile{Data: []byte("console.log(1)")},
	}
}

// cspStamper is a stand-in for the injected desktop CSP middleware.
func cspStamper(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'none'")
		next.ServeHTTP(w, r)
	})
}

// --- auth gating -------------------------------------------------------------

func TestRoutesRequireCookieExceptPublicOnes(t *testing.T) {
	_, ts := newTestServer(t, func(o *Options) { o.Static = staticFS(); o.CSP = cspStamper })
	base := ts.URL
	client := &http.Client{} // no cookies

	cases := []struct {
		name string
		call func() *http.Response
		want int
	}{
		{"rpc unauthenticated", func() *http.Response {
			return doJSON(t, client, "POST", base+"/api/rpc/Echo", `["x"]`)
		}, http.StatusUnauthorized},
		{"ws unauthenticated", func() *http.Response {
			return doJSON(t, client, "GET", base+"/ws", "")
		}, http.StatusUnauthorized},
		{"transport is public", func() *http.Response {
			return doJSON(t, client, "GET", base+"/api/transport", "")
		}, http.StatusOK},
		{"static index is public", func() *http.Response {
			return doJSON(t, client, "GET", base+"/", "")
		}, http.StatusOK},
		{"static asset is public", func() *http.Response {
			return doJSON(t, client, "GET", base+"/assets/app.js", "")
		}, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := tc.call()
			if got := resp.StatusCode; got != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", got, tc.want, bodyString(t, resp))
			}
			_ = resp.Body.Close()
		})
	}
}

func TestLoginFlow(t *testing.T) {
	srv, ts := newTestServer(t, func(o *Options) { o.Static = staticFS() })
	base := ts.URL
	client := &http.Client{}

	t.Run("wrong token is rejected 401", func(t *testing.T) {
		resp := doJSON(t, client, "POST", base+"/api/login", `{"token":"nope-nope-nope"}`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", resp.StatusCode)
		}
		var env errorEnvelope
		_ = json.NewDecoder(resp.Body).Decode(&env)
		if env.Error == "" {
			t.Fatal("expected error envelope")
		}
	})

	t.Run("correct token sets HttpOnly SameSite=Strict session cookie", func(t *testing.T) {
		resp := doJSON(t, client, "POST", base+"/api/login", `{"token":"static-test-token-0123456789"}`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		cookies := resp.Cookies()
		if len(cookies) != 1 || cookies[0].Name != cookieName {
			t.Fatalf("expected one %s cookie, got %#v", cookieName, cookies)
		}
		c := cookies[0]
		if !c.HttpOnly {
			t.Error("cookie must be HttpOnly")
		}
		if c.SameSite != http.SameSiteStrictMode {
			t.Errorf("SameSite = %v, want Strict", c.SameSite)
		}
		if c.Path != "/" {
			t.Errorf("Path = %q, want /", c.Path)
		}
		if c.Secure {
			// Plain HTTP keeps the cookie without Secure — byte-identical to
			// the pre-ADR-102 behavior; Secure rides TLS only (tls_test.go
			// pins the TLS side of the contract).
			t.Error("Secure flag unexpected on plain HTTP (Secure rides TLS only, ADR-102)")
		}
		if c.Value == srv.cfg.Token {
			t.Error("cookie must carry the per-launch session secret, not the configured token")
		}
	})

	t.Run("cookie authenticates subsequent requests", func(t *testing.T) {
		authed := loginClient(t, base, srv.AuthToken())
		resp := doJSON(t, authed, "POST", base+"/api/rpc/Echo", `["x"]`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
	})

	t.Run("re-login re-issues the same per-launch session secret", func(t *testing.T) {
		// Stage-1 model: the session secret lives for the launch; a second
		// login simply re-sets the cookie. Rotation happens on restart (a
		// fresh secret is generated per launch).
		again := loginClient(t, base, srv.AuthToken())
		resp := doJSON(t, again, "POST", base+"/api/rpc/Echo", `["x"]`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
	})
}

func TestLoginBodyHandling(t *testing.T) {
	_, ts := newTestServer(t, nil)
	base := ts.URL
	client := &http.Client{}

	cases := []struct {
		name string
		body string
		want int
	}{
		{"malformed json", `{not json`, http.StatusBadRequest},
		{"empty object", `{}`, http.StatusUnauthorized}, // empty token ≠ valid
		{"oversize body", `{"token":"` + strings.Repeat("a", maxBodyBytes) + `"}`, http.StatusRequestEntityTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := doJSON(t, client, "POST", base+"/api/login", tc.body)
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.want)
			}
		})
	}
}

// TestSameOriginAndContentTypeGates pins the CSRF hardening on the POST
// routes: a present-but-mismatched Origin is refused on /api/login and
// /api/rpc (the same exact-equality check the /ws upgrade enforces), and
// /api/rpc additionally requires the JSON content type — a preflight-free
// no-cors request cannot send either. Missing Origin stays allowed for
// non-browser clients.
func TestSameOriginAndContentTypeGates(t *testing.T) {
	srv, ts := newTestServer(t, nil)
	base := ts.URL
	// A same-site but cross-origin page: identical host string, different
	// port — exactly the requester SameSite=Strict does NOT separate.
	attackerOrigin := "http://127.0.0.1:3000"

	// post fires a raw POST with explicit Origin/Content-Type control (both
	// omitted when empty).
	post := func(t *testing.T, client *http.Client, url, origin, contentType, body string) *http.Response {
		t.Helper()
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, strings.NewReader(body))
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("do %s: %v", url, err)
		}
		return resp
	}

	t.Run("cross-origin login is refused", func(t *testing.T) {
		resp := post(t, &http.Client{}, base+"/api/login", attackerOrigin, "application/json",
			`{"token":"static-test-token-0123456789"}`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", resp.StatusCode)
		}
	})

	t.Run("cross-origin rpc is refused even with a valid session", func(t *testing.T) {
		authed := loginClient(t, base, srv.AuthToken())
		resp := post(t, authed, base+"/api/rpc/Echo", attackerOrigin, "application/json", `["x"]`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", resp.StatusCode)
		}
	})

	t.Run("same-origin login and rpc pass", func(t *testing.T) {
		resp := post(t, &http.Client{}, base+"/api/login", base, "application/json",
			`{"token":"static-test-token-0123456789"}`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("login status = %d, want 200", resp.StatusCode)
		}
		authed := loginClient(t, base, srv.AuthToken())
		echo := post(t, authed, base+"/api/rpc/Echo", base, "application/json", `["x"]`)
		defer func() { _ = echo.Body.Close() }()
		if echo.StatusCode != http.StatusOK {
			t.Fatalf("rpc status = %d, want 200", echo.StatusCode)
		}
	})

	t.Run("rpc requires the json content type", func(t *testing.T) {
		authed := loginClient(t, base, srv.AuthToken())
		for _, tc := range []struct {
			name        string
			contentType string
		}{
			{"no-cors text/plain", "text/plain"},
			{"form encoding", "application/x-www-form-urlencoded"},
			{"missing header", ""},
		} {
			t.Run(tc.name, func(t *testing.T) {
				resp := post(t, authed, base+"/api/rpc/Echo", "", tc.contentType, `["x"]`)
				defer func() { _ = resp.Body.Close() }()
				if resp.StatusCode != http.StatusUnsupportedMediaType {
					t.Fatalf("status = %d, want 415", resp.StatusCode)
				}
			})
		}
		t.Run("charset parameter is accepted", func(t *testing.T) {
			resp := post(t, authed, base+"/api/rpc/Echo", "", "application/json; charset=utf-8", `["x"]`)
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}
		})
	})

	t.Run("non-browser client without Origin keeps working", func(t *testing.T) {
		authed := loginClient(t, base, srv.AuthToken())
		resp := post(t, authed, base+"/api/rpc/Echo", "", "application/json", `["x"]`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
	})
}

func TestTransportDiscovery(t *testing.T) {
	_, ts := newTestServer(t, nil)
	base := ts.URL

	anon := doJSON(t, &http.Client{}, "GET", base+"/api/transport", "")
	defer func() { _ = anon.Body.Close() }()
	var info transportInfo
	if err := json.NewDecoder(anon.Body).Decode(&info); err != nil {
		t.Fatalf("decode transport: %v", err)
	}
	if info.Transport != "web" || info.WS != "/ws" {
		t.Fatalf("transport payload = %#v", info)
	}
	if info.Authenticated {
		t.Error("authenticated must be false before login")
	}

	authed := loginClient(t, base, "static-test-token-0123456789")
	resp := doJSON(t, authed, "GET", base+"/api/transport", "")
	defer func() { _ = resp.Body.Close() }()
	var after transportInfo
	if err := json.NewDecoder(resp.Body).Decode(&after); err != nil {
		t.Fatalf("decode transport: %v", err)
	}
	if !after.Authenticated {
		t.Error("authenticated must be true after login")
	}
}

// --- static + CSP ------------------------------------------------------------

func TestStaticServedThroughInjectedCSP(t *testing.T) {
	_, ts := newTestServer(t, func(o *Options) { o.Static = staticFS(); o.CSP = cspStamper })
	base := ts.URL

	resp := doJSON(t, &http.Client{}, "GET", base+"/index.html", "")
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Security-Policy"); got != "default-src 'none'" {
		t.Errorf("CSP header = %q, want injected value", got)
	}
	if body := bodyString(t, resp); body != "<html>spa shell</html>" {
		t.Errorf("body = %q", body)
	}
}

func TestStaticWithoutCSPStillServes(t *testing.T) {
	_, ts := newTestServer(t, func(o *Options) { o.Static = staticFS() })
	resp := doJSON(t, &http.Client{}, "GET", ts.URL+"/", "")
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if resp.Header.Get("Content-Security-Policy") != "" {
		t.Error("nil CSP must inject no header")
	}
}

// TestStaticDirectoryRequestsAnswer404 pins the no-listing contract: a
// directory URL without an index.html must not render the generated
// directory index (the SPA file manifest), while the SPA root and real
// assets keep serving exactly as before.
func TestStaticDirectoryRequestsAnswer404(t *testing.T) {
	_, ts := newTestServer(t, func(o *Options) { o.Static = staticFS() })
	client := &http.Client{}
	cases := []struct {
		path string
		want int
	}{
		{"/", http.StatusOK},
		{"/index.html", http.StatusOK},
		{"/assets/app.js", http.StatusOK},
		{"/assets/", http.StatusNotFound},
		{"/assets", http.StatusNotFound},
	}
	for _, tc := range cases {
		resp := doJSON(t, client, "GET", ts.URL+tc.path, "")
		bodyString(t, resp)
		_ = resp.Body.Close() // bodyString already closed it; explicit for the close checker
		if resp.StatusCode != tc.want {
			t.Errorf("GET %s: status = %d, want %d", tc.path, resp.StatusCode, tc.want)
		}
	}
}

func TestPanickingCSPMiddlewareIsIsolated(t *testing.T) {
	capture := &captureHandler{}
	_, ts := newTestServer(t, func(o *Options) {
		o.Static = staticFS()
		o.Logger = slog.New(capture)
		o.CSP = func(http.Handler) http.Handler {
			return http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				panic("csp middleware exploded")
			})
		}
	})

	resp := doJSON(t, &http.Client{}, "GET", ts.URL+"/", "")
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	if n := capture.count(t, "webaccess: handler panic"); n != 1 {
		t.Fatalf("captured 'handler panic' records = %d, want 1", n)
	}
	// The server must keep serving after the panic.
	ok := doJSON(t, &http.Client{}, "GET", ts.URL+"/api/transport", "")
	defer func() { _ = ok.Body.Close() }()
	if ok.StatusCode != http.StatusOK {
		t.Fatalf("server did not recover after middleware panic: %d", ok.StatusCode)
	}
}

// --- rate limiting -------------------------------------------------------------

func TestLoginRateLimit(t *testing.T) {
	_, ts := newTestServer(t, nil)
	base := ts.URL
	client := &http.Client{}

	// A fixed window admits exactly loginMaxAttempts attempts regardless of
	// validity; the next attempt is refused even with the correct token.
	for i := 0; i < loginMaxAttempts; i++ {
		resp := doJSON(t, client, "POST", base+"/api/login", `{"token":"wrong"}`)
		if resp.StatusCode != http.StatusUnauthorized {
			bodyString(t, resp)
			t.Fatalf("attempt %d: status = %d, want 401", i+1, resp.StatusCode)
		}
		bodyString(t, resp)
		_ = resp.Body.Close()
	}
	resp := doJSON(t, client, "POST", base+"/api/login", `{"token":"static-test-token-0123456789"}`)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", resp.StatusCode)
	}
	if ra := resp.Header.Get("Retry-After"); ra == "" {
		t.Error("429 must carry Retry-After")
	}
}

func TestLoginLimiterWindowReset(t *testing.T) {
	// Virtual time: the limiter takes `now`, so the window boundary is
	// exercised without sleeping.
	l := newLoginLimiter(2, time.Minute)
	now := time.Now()
	if !l.allow("ip", now) {
		t.Fatal("first attempt must pass")
	}
	if !l.allow("ip", now) {
		t.Fatal("second attempt must pass")
	}
	if l.allow("ip", now) {
		t.Fatal("third attempt inside the window must fail")
	}
	if !l.allow("ip", now.Add(time.Minute)) {
		t.Fatal("first attempt after the window must pass")
	}
	if !l.allow("other", now) {
		t.Fatal("a fresh key must have its own bucket")
	}
}

// TestLoginLimiterIgnoresMalformedBodies pins the parse-then-count order:
// a flood of malformed bodies must not consume the shared per-IP window —
// only parseable login attempts count, so a script cannot lock the
// operator's browser out with garbage requests.
func TestLoginLimiterIgnoresMalformedBodies(t *testing.T) {
	_, ts := newTestServer(t, nil)
	base := ts.URL
	client := &http.Client{}
	for i := 0; i < loginMaxAttempts+5; i++ {
		resp := doJSON(t, client, "POST", base+"/api/login", `{not json`)
		bodyString(t, resp)
		_ = resp.Body.Close() // bodyString already closed it; explicit for the close checker
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("malformed attempt %d: status = %d, want 400", i+1, resp.StatusCode)
		}
	}
	resp := doJSON(t, client, "POST", base+"/api/login", `{"token":"wrong"}`)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (malformed bodies must not burn attempts)", resp.StatusCode)
	}
}

// TestHostMatchesBind pins the DNS-rebinding backstop behind sameOrigin:
// the request Host must name the configured bind or the loopback set; a
// rebound DNS name must not. A wildcard bind names no serving host, so
// every Host passes there (cookie scoping stays the gate).
func TestHostMatchesBind(t *testing.T) {
	cases := []struct {
		host, bind string
		want       bool
	}{
		{"127.0.0.1:8321", "127.0.0.1", true},
		{"localhost:8321", "127.0.0.1", true},
		{"127.0.0.1:8321", "localhost", true},
		{"[::1]:8321", "::1", true},
		{"192.168.1.10:8321", "192.168.1.10", true},
		{"attacker.example:8321", "127.0.0.1", false},
		{"192.168.1.10:8321", "127.0.0.1", false},
		{"attacker.example:8321", "0.0.0.0", true},
	}
	for _, tc := range cases {
		if got := hostMatchesBind(tc.host, tc.bind); got != tc.want {
			t.Errorf("hostMatchesBind(%q, %q) = %v, want %v", tc.host, tc.bind, got, tc.want)
		}
	}
}

// TestStartIsSingleUse pins the started guard: a second Start — or a Start
// after Stop — returns an error instead of leaking a second listener.
func TestStartIsSingleUse(t *testing.T) {
	srv := mustNew(t, newTestOptions(stubDispatch{}, func(o *Options) { o.Config.Port = 0 }))
	ctx := context.Background()
	if err := srv.Start(ctx); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	if err := srv.Start(ctx); err == nil {
		t.Error("second Start on a running server must fail")
	}
	if err := srv.Stop(ctx); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := srv.Start(ctx); err == nil {
		t.Error("Start after Stop must fail")
	}
}

// --- body limits ---------------------------------------------------------------

func TestRPCBodyLimitIs413(t *testing.T) {
	_, ts := newTestServer(t, nil)
	base := ts.URL
	client := loginClient(t, base, "static-test-token-0123456789")

	big := `["` + strings.Repeat("a", maxBodyBytes) + `"]`
	resp := doJSON(t, client, "POST", base+"/api/rpc/Echo", big)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
}

// --- New() validation ------------------------------------------------------------

func TestNewValidatesOptions(t *testing.T) {
	t.Run("disabled config is refused", func(t *testing.T) {
		opts := newTestOptions(stubDispatch{}, func(o *Options) { o.Config.Enabled = false })
		if _, err := New(opts); !errors.Is(err, ErrDisabled) {
			t.Fatalf("err = %v, want ErrDisabled", err)
		}
	})
	t.Run("unparseable bind is refused", func(t *testing.T) {
		opts := newTestOptions(stubDispatch{}, func(o *Options) { o.Config.Bind = "garbage" })
		_, err := New(opts)
		if err == nil || !strings.Contains(err.Error(), "not a valid IP literal") {
			t.Fatalf("err = %v, want invalid-bind refusal", err)
		}
	})
	t.Run("empty bind is refused", func(t *testing.T) {
		opts := newTestOptions(stubDispatch{}, func(o *Options) { o.Config.Bind = "" })
		_, err := New(opts)
		if err == nil || !strings.Contains(err.Error(), "bind is required") {
			t.Fatalf("err = %v, want empty-bind refusal", err)
		}
	})
	t.Run("nil dispatch is refused", func(t *testing.T) {
		opts := newTestOptions(nil, nil)
		if _, err := New(opts); err == nil {
			t.Fatal("nil dispatch must be refused")
		}
	})
	t.Run("nil-pointer dispatch is refused", func(t *testing.T) {
		var nilTarget *stubDispatch
		opts := newTestOptions(nil, nil)
		opts.Dispatch = nilTarget
		if _, err := New(opts); err == nil {
			t.Fatal("nil-pointer dispatch must be refused")
		}
	})
	t.Run("out-of-range port is refused", func(t *testing.T) {
		opts := newTestOptions(stubDispatch{}, func(o *Options) { o.Config.Port = 70000 })
		if _, err := New(opts); err == nil {
			t.Fatal("out-of-range port must be refused")
		}
	})
	t.Run("short configured token warns once", func(t *testing.T) {
		capture := &captureHandler{}
		opts := newTestOptions(stubDispatch{}, func(o *Options) {
			o.Config.Token = "short"
			o.Logger = slog.New(capture)
		})
		if _, err := New(opts); err != nil {
			t.Fatalf("New: %v", err)
		}
		if n := capture.count(t, "webaccess: configured token is short; leave it empty to use the generated credential or use at least 16 characters"); n != 1 {
			t.Fatalf("short-token warnings = %d, want 1", n)
		}
	})
	t.Run("empty token generates a per-launch secret", func(t *testing.T) {
		a := mustNew(t, newTestOptions(stubDispatch{}, func(o *Options) { o.Config.Token = "" }))
		b := mustNew(t, newTestOptions(stubDispatch{}, func(o *Options) { o.Config.Token = "" }))
		if a.AuthToken() == "" || len(a.AuthToken()) != 2*tokenBytes {
			t.Fatalf("generated token = %q, want %d hex chars", a.AuthToken(), 2*tokenBytes)
		}
		if a.AuthToken() == b.AuthToken() {
			t.Fatal("per-launch tokens must differ")
		}
	})
	t.Run("redactToken never reveals the value", func(t *testing.T) {
		secret := "super-secret-token-value"
		red := redactToken(secret)
		if strings.Contains(red, secret) {
			t.Fatalf("redacted = %q leaks the secret", red)
		}
		if !strings.HasPrefix(red, "sha256:") {
			t.Fatalf("redacted = %q, want sha256 prefix", red)
		}
	})
}

// --- stage-2 bind posture -----------------------------------------------------

// TestNewAcceptsNonLoopbackBinds pins the stage-2 widening: any valid bind —
// the unspecified wildcard or a specific LAN address — constructs, and each
// draws exactly one Warn naming the exposure (slog hook).
func TestNewAcceptsNonLoopbackBinds(t *testing.T) {
	for _, bind := range []string{"0.0.0.0", "::", "192.168.1.10", "10.0.0.5"} {
		t.Run(bind, func(t *testing.T) {
			capture := &captureHandler{}
			opts := newTestOptions(stubDispatch{}, func(o *Options) {
				o.Config.Bind = bind
				o.Logger = slog.New(capture)
			})
			if _, err := New(opts); err != nil {
				t.Fatalf("New(%q): %v", bind, err)
			}
			warns := 0
			for _, r := range capture.snapshot() {
				if !strings.Contains(r.Message, "is not loopback") {
					continue
				}
				if r.Level != slog.LevelWarn {
					t.Errorf("level = %v, want Warn", r.Level)
				}
				if !strings.Contains(r.Message, "the auth token is the only protection") {
					t.Errorf("warning %q does not name the token as the only protection", r.Message)
				}
				warns++
			}
			if warns != 1 {
				t.Fatalf("non-loopback warnings = %d, want 1", warns)
			}
		})
	}
}

// TestNewSilentOnLoopbackBinds: the warning is an exposure signal, so loopback
// binds — including the "localhost" name — must stay completely silent.
func TestNewSilentOnLoopbackBinds(t *testing.T) {
	for _, bind := range []string{config.DefaultWebAccessBind, "127.0.0.1", "::1", "localhost"} {
		t.Run(bind, func(t *testing.T) {
			capture := &captureHandler{}
			opts := newTestOptions(stubDispatch{}, func(o *Options) {
				o.Config.Bind = bind
				o.Logger = slog.New(capture)
			})
			if _, err := New(opts); err != nil {
				t.Fatalf("New(%q): %v", bind, err)
			}
			if n := len(capture.snapshot()); n != 0 {
				t.Fatalf("captured %d diagnostics for loopback bind %q, want 0", n, bind)
			}
		})
	}
}

// TestStartOnWildcardBindServesLoopback drives the widened contract end to
// end: the 0.0.0.0 listener answers on the loopback address and shuts down
// cleanly, with exactly one exposure warning logged at construction.
func TestStartOnWildcardBindServesLoopback(t *testing.T) {
	capture := &captureHandler{}
	srv := mustNew(t, newTestOptions(stubDispatch{}, func(o *Options) {
		o.Config.Bind = "0.0.0.0"
		o.Logger = slog.New(capture)
	}))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := srv.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	addr, ok := srv.Addr()
	if !ok {
		t.Fatal("Addr missing after Start")
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split %q: %v", addr, err)
	}
	url := "http://127.0.0.1:" + port + "/api/transport"
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, http.NoBody)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		t.Fatalf("get %s: %v", url, err)
	}
	bodyString(t, resp) // drains + closes
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if err := srv.Stop(context.Background()); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if n := capture.count(t, `webaccess: bind "0.0.0.0" is not loopback — the listener is reachable beyond this machine, traffic is plain HTTP without TLS, the auth token is the only protection`); n != 1 {
		t.Fatalf("exposure warnings = %d, want 1", n)
	}
}

// --- lifecycle ---------------------------------------------------------------

func TestStartStopServesAndReleases(t *testing.T) {
	srv := mustNew(t, newTestOptions(stubDispatch{}, nil))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := srv.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	addr, ok := srv.Addr()
	if !ok {
		t.Fatal("Addr missing after Start")
	}
	url := "http://" + addr
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url+"/api/transport", http.NoBody)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	bodyString(t, resp) // drains + closes
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	if err := srv.Stop(context.Background()); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	// The listener must be closed: a follow-up connect fails.
	var dialer net.Dialer
	conn, err := dialer.DialContext(context.Background(), "tcp", addr)
	if err == nil {
		conn.Close() //nolint:errcheck // leak-free test
		t.Fatal("connection succeeded after Stop")
	}
	cancel()
}
