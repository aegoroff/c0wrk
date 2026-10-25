// SPDX-License-Identifier: Apache-2.0
//
// Package webaccess is the core of the browser web-access sidecar
// (specs/decisions/101-browser-web-access.md): an HTTP + WebSocket server
// that mirrors the desktop UI into a browser tab by dispatching the same RPC
// surface the Wails webview uses. It binds loopback by default; since stage 2
// a non-loopback (LAN-exposed) bind is allowed and draws a startup warning.
//
// The package is deliberately SELF-CONTAINED: it knows nothing about Wails
// or the desktop layer. Everything environment-specific is injected through
// Options:
//
//   - Dispatch — the RPC target as `any` (at runtime a *backend.FrontendAPI).
//     Calls are resolved by reflection; the package imports only stdlib and
//     backend/config, never desktop (guarded by nodeps_test.go).
//   - Static — the SPA asset tree as fs.FS, served without authentication
//     (the shell is public; all data flows through authenticated endpoints).
//   - CSP — the Content-Security-Policy middleware as a plain
//     func(http.Handler) http.Handler. The authoritative implementation is
//     desktop.CSPMiddleware (build-tag split dev/prod); it is passed in at
//     mounting time and never duplicated here.
//   - Config — the resolved config.WebAccessConfig section (pure data, see
//     backend/config/web_access.go).
//
// Surface (all JSON, all same-origin):
//
//	GET  /api/transport     → {transport,ws,authenticated} — no auth
//	POST /api/login         → {token} → session cookie — rate limited
//	POST /api/rpc/{Method}  → positional JSON args → JSON result | error envelope
//	GET  /ws                → RFC6455 upgrade — cookie auth + same-origin Origin
//	GET  /                  → static SPA through the injected CSP — no auth
//
// Security posture (stage 2, ADR-101):
//   - Bind = any valid IP literal or "localhost" (config.IsValidWebAccessBind).
//     Loopback stays the safe default; a NON-loopback bind makes the listener
//     reachable beyond this machine over plain HTTP unless web_access.tls is
//     on, and New warns about exactly that — naming the transport: with no
//     TLS the auth token is the only protection, under TLS the token still is
//     (the pipe is encrypted, the credential is not optional). An invalid
//     bind is refused (fail-closed).
//   - Auth token: cfg.Token. The desktop layer guarantees a non-empty token
//     before mounting: an empty config token is generated ONCE (GenerateToken)
//     and persisted through the same config-save path every other settings
//     write uses, so the credential is stable across restarts. This package
//     keeps a fresh crypto/rand per-launch fallback for direct construction,
//     and the token is never logged in full and never travels in a URL
//     (login is POST body only; requests authenticate by HttpOnly
//     SameSite=Strict cookie).
//   - The cookie carries a per-launch session secret, NOT the configured
//     token — stealing a cookie never reveals a durable secret.
//   - The state-changing POST routes carry the /ws admission hardening:
//     /api/rpc and /api/login reject a present-but-mismatched Origin (the
//     exact-equality same-origin check — SameSite=Strict separates sites,
//     not origins), and /api/rpc additionally requires Content-Type:
//     application/json, which a preflight-free no-cors request cannot send.
//   - Every handler and goroutine is recovered: a panic in the web layer (or
//     in a dispatched method) becomes a 500 envelope, never an app crash.
//   - RPC surface = exported methods of Dispatch minus the named denylist
//     (dispatch.go). A browser tab holds full control of the app by design;
//     the denylist only removes methods that are web-transport hazards.
//
// KNOWN LIMITATION (resolved by ADR-102): on plain HTTP the cookie is still
// issued without the Secure flag — byte-identical to the pre-ADR-102
// behavior. With web_access.tls enabled the sidecar terminates TLS (New
// fails closed on an enabled-but-unreadable pair, so a listener configured
// as encrypted never silently downgrades to plaintext; MinVersion is pinned
// to TLS 1.3) and the cookie carries Secure. HttpOnly/SameSite=Strict, the
// per-launch session secret and the token gate remain the compensations on
// every transport; the non-loopback exposure warning stands with or without
// TLS, naming the effective transport (ADR-102 decision 6). Websocket origin
// checks compare Origin against r.Host, which stays correct on any interface.
package webaccess

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"path"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
)

const (
	// cookieName is the session cookie carrying the per-launch secret.
	cookieName = "c0wrk_web"
	// maxBodyBytes bounds every JSON request body; oversize → 413.
	maxBodyBytes = 1 << 20 // 1 MiB
	// maxUploadBodyBytes bounds upload-carrying RPC bodies (see
	// uploadBodyMethods in dispatch.go). The largest attachment payload the
	// backend accepts is its 32 MiB raw-buffer cap (backend
	// maxAttachContentBytes); base64 inflates it by ~4/3 and the
	// positional-JSON envelope adds slack, so the cap lands at 48 MiB.
	// Ordinary RPCs keep the default maxBodyBytes.
	maxUploadBodyBytes = 48 << 20 // 48 MiB
	// tokenBytes is the entropy of a generated auth token — the desktop-minted
	// persistent credential and the per-launch fallback alike.
	tokenBytes = 32
	// shutdownBudget bounds the graceful Stop wait when the caller passes a
	// deadline-free context.
	shutdownBudget = 5 * time.Second
	// readHeaderTimeout and idleTimeout harden the HTTP server against
	// slowloris-style stalling on the listener.
	readHeaderTimeout = 10 * time.Second
	idleTimeout       = 2 * time.Minute
	// requestReadDeadline bounds one request's body read, armed per request
	// after the headers are in (armReadDeadline): ReadHeaderTimeout covers
	// only the header phase, so without this a client could trickle a body
	// forever (slow-POST) and pin a goroutine per connection. The budget is
	// deliberately generous — it must carry a full 48 MiB upload over a slow
	// link — it bounds the pathological trickle, not normal traffic.
	requestReadDeadline = 15 * time.Minute
	// wsPath is advertised by /api/transport so the SPA shell can find the
	// event channel without hardcoding it.
	wsPath = "/ws"
)

// ErrDisabled is returned by New when the config section is off: the sidecar
// must not be constructed for a disabled section (belt-and-braces on top of
// the load-time fail-soft normalization in backend/config).
var ErrDisabled = errors.New("webaccess: web_access section is not enabled")

// Options carries every dependency the sidecar needs from the outside world.
// Nothing inside the package constructs any of them.
type Options struct {
	// Config is the resolved `web_access` config section. New refuses a
	// disabled section (ErrDisabled) and an invalid bind
	// (config.IsValidWebAccessBind); a valid non-loopback bind is accepted
	// with a startup warning (network exposure — the warning names the
	// effective transport, ADR-102 decision 6). A TLS-enabled section must
	// carry a readable cert/key pair; New fails closed otherwise.
	Config config.WebAccessConfig
	// Dispatch is the RPC target: at runtime a *backend.FrontendAPI. Only its
	// exported methods are reachable, minus the denylist (dispatch.go).
	// Required.
	Dispatch any
	// ExtraDispatch is a SECONDARY reflection target, consulted only when
	// Dispatch has no such method. It exists for the few App-level (desktop)
	// capabilities the web surface must mirror — today GetPendingActions, the
	// HITL reconciliation sweep the session switch fires — which live on the
	// App and cannot move to FrontendAPI. The desktop layer opts in through a
	// MINIMAL adapter struct (never the App itself: its control RPCs —
	// SetWebAccessEnabled, EmitSessionEvent and friends — must stay
	// unreachable from the web). The denylist applies to the union; the
	// surface contract test pins the extra set exactly. Optional; a non-nil
	// interface holding a nil pointer fails closed in New.
	ExtraDispatch any
	// Static is the SPA asset tree served at /. Optional: nil disables the
	// static route (everything else keeps working). Static is served WITHOUT
	// authentication — the app shell carries no data.
	Static fs.FS
	// CSP wraps handlers with the Content-Security-Policy middleware. The
	// caller injects desktop.CSPMiddleware() (build-tag aware); nil means
	// "no CSP" (dev builds already compile the no-op variant).
	CSP func(http.Handler) http.Handler
	// Logger receives sidecar diagnostics. Nil → slog.Default(). Secrets
	// (auth token, session cookie) are never logged, in full or in part.
	Logger *slog.Logger
	// WSInbound receives inbound websocket messages from authenticated
	// browser clients. Optional: nil discards inbound traffic. Called on the
	// connection's read goroutine — a panic there closes the connection but
	// never reaches the process.
	WSInbound func(c *WSConn, data []byte)
}

// Server is the running sidecar core. Construct with New; serve with Start;
// stop with Stop. A Server is safe for concurrent use; Start is single-use —
// a second Start (or Start after Stop) returns an error instead of leaking
// a listener.
type Server struct {
	cfg           config.WebAccessConfig
	dispatch      any
	extraDispatch any
	static        fs.FS
	csp           func(http.Handler) http.Handler
	log           *slog.Logger

	authToken    string // effective auth token (configured or per-launch)
	sessionToken string // per-launch cookie secret, revealed only via login

	limiter *loginLimiter
	handler http.Handler
	tls     *tls.Config

	mu       sync.Mutex
	ln       net.Listener
	httpSrv  *http.Server
	stopOnce sync.Once
	stopped  chan struct{}
	// servingHosts is the snapshot of this machine's serving addresses
	// captured at Start (net.InterfaceAddrs()), guarding the wildcard-bind
	// Host gate (hostAllowed). Written once under mu before the serve
	// goroutine starts; nil until then (fail-closed: with no snapshot only
	// the loopback/localhost structural cases pass on a wildcard bind).
	servingHosts []net.IP
	// dnsMu guards dnsCache — the bounded TTL cache of hostname→served
	// verdicts for the wildcard-bind Host gate (nameServes).
	dnsMu    sync.Mutex
	dnsCache map[string]dnsCacheEntry
	// started makes Start single-use: a second call — or a call after Stop —
	// would bind a second listener this type never tracks. Misuse fails
	// loudly instead of leaking.
	started atomic.Bool

	wsMu    sync.Mutex
	wsConns map[*WSConn]struct{}
	// wsReserved counts in-flight websocket slot reservations: a handshake
	// reserves capacity before Hijack (see handleWS) and the reservation
	// converts into a registration (registerWS) or is released on every
	// failure path in between. The cap check is
	// len(wsConns)+wsReserved >= maxWSConns, so a burst of parallel
	// handshakes cannot each see "one slot free" and all proceed.
	wsReserved int

	wsInbound func(c *WSConn, data []byte)
}

// New validates the options and builds the server. It does not bind anything
// until Start.
func New(opts Options) (*Server, error) {
	if !opts.Config.Enabled {
		return nil, ErrDisabled
	}
	if !config.IsValidWebAccessBind(opts.Config.Bind) {
		// Fail-closed: an invalid bind is a wiring bug, not an exposure
		// decision. Same two messages the config load/save paths produce.
		if opts.Config.Bind == "" {
			return nil, errors.New("webaccess: bind is required when enabled")
		}
		return nil, fmt.Errorf("webaccess: bind %q is not a valid IP literal or \"localhost\"", opts.Config.Bind)
	}
	if opts.Config.Port < 0 || opts.Config.Port > 65535 {
		return nil, fmt.Errorf("webaccess: port %d out of range (0 = auto)", opts.Config.Port)
	}
	// Insecure-LAN fail-closed backstop (the mount half of the exposure
	// gate): an enabled non-loopback bind over plain HTTP without the
	// explicit allow_insecure_lan opt-in is refused here — the same
	// predicate and message the config load (fail-soft), config save
	// (fail-closed) and the desktop interactive boundaries enforce. A
	// listener the operator configured as LAN-exposed never comes up on
	// plaintext unless the accepted-risk opt-in names it; with
	// web_access.tls enabled this check is inert (the pair loads below).
	if err := config.ValidateWebAccessExposure(opts.Config); err != nil {
		return nil, err
	}
	// TLS termination (ADR-102): an enabled subsection MUST yield a readable,
	// parseable, matching pair. New refuses to construct the sidecar here —
	// a listener the operator configured as encrypted never silently
	// downgrades to plaintext (fail-closed at mount; the persisted switch
	// stays on and the next launch retries). The structural state (enabled
	// with an empty path) is already reset fail-soft at config load
	// (backend/config normalizeWebAccess); the empty-path check here is
	// belt-and-braces on the package boundary.
	var tlsCfg *tls.Config
	if opts.Config.TLS.Enabled {
		if opts.Config.TLS.Cert == "" || opts.Config.TLS.Key == "" {
			return nil, errors.New("webaccess: tls is enabled but the cert/key paths are empty")
		}
		pair, err := tls.LoadX509KeyPair(opts.Config.TLS.Cert, opts.Config.TLS.Key)
		if err != nil {
			return nil, fmt.Errorf("webaccess: tls is enabled but the certificate pair is unreadable: %w", err)
		}
		tlsCfg = &tls.Config{
			// The sidecar's clients are mainstream browsers on the machine's
			// own network segment; TLS 1.3 is the floor (originally 1.2 per
			// ADR-102 decision 6, raised in the security-review fix round:
			// every mainstream browser has required 1.3 since ~2020-21, so
			// the 1.2 floor only kept downgrade surface alive).
			MinVersion:   tls.VersionTLS13,
			Certificates: []tls.Certificate{pair},
		}
	}
	if opts.Dispatch == nil {
		return nil, errors.New("webaccess: Dispatch target is required")
	}
	// Fail-closed on a dispatch target we cannot reflect over: a nil pointer
	// would resolve no methods and silently expose an empty surface.
	if v := reflect.ValueOf(opts.Dispatch); v.Kind() == reflect.Pointer && v.IsNil() {
		return nil, errors.New("webaccess: Dispatch target is a nil pointer")
	}
	// Same fail-closed rule for the optional extra surface: an explicitly
	// provided but nil extra target is a wiring bug, not an empty feature.
	if v := reflect.ValueOf(opts.ExtraDispatch); v.IsValid() && v.Kind() == reflect.Pointer && v.IsNil() {
		return nil, errors.New("webaccess: ExtraDispatch target is a nil pointer")
	}

	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}

	// Stage-2 posture: a valid non-loopback bind puts the listener on the
	// network. Allowed (the operator owns the exposure decision — and on
	// plain HTTP has named it through allow_insecure_lan, enforced above)
	// but loudly surfaced — the warning names the effective transport so it
	// stays truthful under web_access.tls (ADR-102); the exposure
	// classification itself is about reachability, never encryption.
	if !config.IsLoopbackBind(opts.Config.Bind) {
		if tlsCfg != nil {
			log.Warn(fmt.Sprintf("webaccess: bind %q is not loopback — the listener is reachable beyond this machine, the transport is TLS-encrypted, the auth token is the only protection", opts.Config.Bind))
		} else {
			log.Warn(fmt.Sprintf("webaccess: bind %q is not loopback — the listener is reachable beyond this machine, traffic is plain HTTP without TLS (accepted via web_access.allow_insecure_lan), the auth token is the only protection", opts.Config.Bind))
		}
	}

	authToken := opts.Config.Token
	if authToken == "" {
		// Defense-in-depth fallback: the desktop layer generates and persists
		// the token before mounting, so an empty config token should not
		// reach New. A fresh per-launch secret is still better than none.
		gen, err := GenerateToken()
		if err != nil {
			return nil, fmt.Errorf("webaccess: generating per-launch token: %w", err)
		}
		authToken = gen
	} else if len(authToken) < 16 {
		// Operator-chosen weak secret: allowed (the operator owns the
		// risk — a short token is the weakest link already on loopback,
		// and the only protection on a non-loopback bind) but surfaced.
		log.Warn("webaccess: configured token is short; leave it empty to use the generated credential or use at least 16 characters")
	}
	sessionToken, err := randomHex(tokenBytes)
	if err != nil {
		return nil, fmt.Errorf("webaccess: generating session secret: %w", err)
	}

	s := &Server{
		cfg:           opts.Config,
		dispatch:      opts.Dispatch,
		extraDispatch: opts.ExtraDispatch,
		static:        opts.Static,
		csp:           opts.CSP,
		log:           log,
		authToken:     authToken,
		sessionToken:  sessionToken,
		limiter:       newLoginLimiter(loginMaxAttempts, loginWindow),
		stopped:       make(chan struct{}),
		wsConns:       make(map[*WSConn]struct{}),
		dnsCache:      make(map[string]dnsCacheEntry),
		wsInbound:     opts.WSInbound,
		tls:           tlsCfg,
	}
	s.handler = s.buildHandler()
	return s, nil
}

// buildHandler wires the route table. API handlers are recovered and emit
// no-store JSON; static assets go through the injected CSP middleware.
func (s *Server) buildHandler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/transport", s.recoverWrap(noStore(s.handleTransport)))
	mux.Handle("POST /api/login", s.recoverWrap(noStore(s.sameOriginGate(armReadDeadline(s.handleLogin)))))
	mux.Handle("POST /api/rpc/{method}", s.recoverWrap(noStore(s.sameOriginGate(armReadDeadline(s.requireAuth(jsonContentTypeGate(s.handleRPC)))))))
	mux.Handle("GET /ws", s.recoverWrap(noStore(s.requireAuth(s.handleWS))))
	if s.static != nil {
		static := noDirListing(http.FileServerFS(s.static), s.static)
		if s.csp != nil {
			static = s.csp(static)
		}
		mux.Handle("/", static)
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
	}
	// The outer recover is the last line of defense for every route,
	// including injected middleware and the static handler. securityHeaders
	// sits INSIDE the recover so a panicking route cannot strip the headers
	// from the 500 the recover writes, and OUTSIDE everything else so it
	// covers API, /ws and the static tree in one place (including the
	// no-CSP dev shape).
	return s.recoverWrap(securityHeaders(mux))
}

// securityHeaders stamps the transport-level hardening headers onto every
// response the sidecar emits: X-Content-Type-Options: nosniff (a sniffed
// content type must never turn a JSON error or an asset into executable
// content — CSP 'none' already contains the practical blast radius, this is
// defense-in-depth) and Referrer-Policy: no-referrer (the sidecar's origin
// is the operator's machine host:port — it must not leak into outbound
// Referer headers from the mirrored UI).
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// armReadDeadline arms the per-request body-read deadline (see
// requestReadDeadline) on the body-carrying POST routes. It runs after the
// headers are parsed, so the header phase stays under ReadHeaderTimeout and
// the deadline covers exactly the body. The /ws route is never armed: its
// hijacked connection must not inherit a read deadline.
func armReadDeadline(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Best-effort: a writer that cannot take a deadline leaves the
		// request under the listener's timeouts alone.
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(requestReadDeadline)) //nolint:errcheck // best-effort bound
		next(w, r)
	}
}

// noDirListing wraps the static file server so a directory URL without an
// index.html answers 404 instead of rendering the generated directory index
// — the SPA file manifest is not something the sidecar needs to hand out.
// Directories WITH an index.html (the SPA root) keep serving it through the
// stdlib handler, byte-identical to before.
func noDirListing(next http.Handler, fsys fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" {
			name = "."
		}
		if d, err := fs.Stat(fsys, name); err == nil && d.IsDir() {
			if _, err := fs.Stat(fsys, path.Join(name, "index.html")); err != nil {
				http.NotFound(w, r)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// Handler returns the fully wired HTTP handler (tests and embedding).
func (s *Server) Handler() http.Handler { return s.handler }

// AuthToken returns the effective auth token a user must paste into the
// browser login screen: the configured token, or the generated per-launch
// one. This is the ONLY channel the token leaves the package through — it is
// never logged and never appears in a URL.
func (s *Server) AuthToken() string { return s.authToken }

// TLSEnabled reports whether this server terminates TLS on its listener
// (ADR-102): the desktop surface renders the browser-facing URL's scheme
// from it. The value is fixed at New — the pair is loaded there, so no
// synchronization is needed beyond the constructor's happens-before edge.
func (s *Server) TLSEnabled() bool { return s.tls != nil }

// GenerateToken mints a fresh auth token: 32 bytes of crypto/rand rendered as
// 64 hex characters — the same entropy the sidecar's per-launch fallback
// mints. The desktop layer calls it when the persisted token is empty (first
// enable, or a hand-edited config): the credential is created once and then
// persisted through the same config-save path every other settings write
// uses (ADR-101) — it is never silently re-minted per launch again.
func GenerateToken() (string, error) {
	return randomHex(tokenBytes)
}

// Addr returns the resolved listen address after a successful Start
// (host:port; the port is the actual one when config port was 0/auto).
func (s *Server) Addr() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ln == nil {
		return "", false
	}
	return s.ln.Addr().String(), true
}

// Start binds the configured interface (resolving port 0 to a free port) and
// serves until Stop or ctx cancellation. When the config section enables TLS
// (ADR-102) the same listener terminates TLS with the pair loaded in New
// (MinVersion 1.3); otherwise it serves plain HTTP exactly as before. It
// returns after the listener is bound; serve errors after that are logged,
// not returned. Start is single-use: a second Start (or Start after Stop)
// returns an error instead of leaking a second listener.
func (s *Server) Start(ctx context.Context) error {
	if !s.started.CompareAndSwap(false, true) {
		return errors.New("webaccess: server already started (Start is single-use)")
	}
	addr := net.JoinHostPort(s.cfg.Bind, strconv.Itoa(s.cfg.Port))
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("webaccess: listen on %s: %w", addr, err)
	}

	// Snapshot the machine's serving addresses for the wildcard-bind Host
	// gate (hostAllowed → ipServed): every unicast address the wildcard
	// listener answers on. Computed once per Start; an empty snapshot on
	// error keeps the gate fail-closed (loopback/localhost still pass).
	serving := servingHostSnapshot()
	s.mu.Lock()
	s.servingHosts = serving
	s.ln = ln
	// Pin HTTP/1.1-only: /ws is a Hijacker-based Upgrade handshake and cannot
	// survive HTTP/2, and an automatic h2 setup would let browsers attempt
	// WebSocket-over-HTTP/2 (RFC 8441 extended CONNECT — no Upgrade, no
	// Hijacker) for wss:// under TLS. Go's h2 server currently rejects
	// extended CONNECT by default, but that default is explicitly temporary
	// (GODEBUG http2xconnect, go issue #71128) — the non-nil Protocols below
	// disables the automatic h2 configuration outright on both the TLS and
	// the plain listener (h2c was never enabled) instead of riding that
	// default. The ALPN assertion in TestServer_TLSEndToEnd fails when this
	// pin is removed.
	protos := new(http.Protocols)
	protos.SetHTTP1(true)     // the zero (empty) set denies every protocol
	s.httpSrv = &http.Server{ //nolint:gosec // local sidecar for the desktop UI; TLS opt-in via web_access.tls (ADR-102), floor 1.3 pinned in New; timeouts set below
		Handler:           s.handler,
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
		TLSConfig:         s.tls,
		Protocols:         protos,
		// Route the stdlib server's internal diagnostics (refused TLS
		// handshakes, protocol misuse) through the injected slog logger at
		// Debug level: they are client-triggered, unauthenticated input can
		// produce them at line rate, and they carry no operator value at the
		// default verbosity. Serve-loop termination keeps its explicit
		// server-side log below. Tests intercept these records at the source
		// through the capture handler.
		ErrorLog: slog.NewLogLogger(s.log.Handler(), slog.LevelDebug),
	}
	srv := s.httpSrv
	s.mu.Unlock()

	s.log.Info("webaccess: listening", "addr", ln.Addr().String(), "tls", s.tls != nil)

	go func() {
		var serr error
		if s.tls != nil {
			// TLS termination on the same listener (ADR-102): the pair is
			// preloaded into TLSConfig.Certificates in New, so the file
			// arguments stay empty and the key material is never re-read
			// from disk on the serve path.
			serr = srv.ServeTLS(ln, "", "")
		} else {
			serr = srv.Serve(ln)
		}
		if serr != nil && !errors.Is(serr, http.ErrServerClosed) {
			s.log.Error("webaccess: serve stopped", "err", serr)
		}
	}()
	if ctx != nil {
		go func() {
			select {
			case <-ctx.Done():
				if serr := s.stop(shutdownBudget); serr != nil {
					s.log.Error("webaccess: context shutdown failed", "err", serr)
				}
			case <-s.stopped:
			}
		}()
	}
	return nil
}

// Stop gracefully shuts the listener down within ctx (or shutdownBudget when
// ctx has no deadline), then force-closes what remains — including hijacked
// WebSocket connections, which http.Server.Shutdown does not track.
func (s *Server) Stop(ctx context.Context) error {
	budget := shutdownBudget
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Deadline(); ok {
		return s.stopWith(ctx)
	}
	sctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	return s.stopWith(sctx)
}

func (s *Server) stop(budget time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	return s.stopWith(ctx)
}

func (s *Server) stopWith(ctx context.Context) (err error) {
	s.stopOnce.Do(func() {
		close(s.stopped)
		s.mu.Lock()
		srv := s.httpSrv
		ln := s.ln
		s.mu.Unlock()
		if srv != nil {
			if serr := srv.Shutdown(ctx); serr != nil {
				err = errors.Join(serr, srv.Close())
			}
		}
		if ln != nil {
			// Shutdown closes only the listeners Serve has tracked, and the
			// tracking happens inside the serve goroutine: a stop that wins
			// the race against Serve's first instruction finds nothing
			// tracked, Shutdown returns nil, the error-only Close never ran
			// — and the raw listener (the bound port) outlived the stop.
			// Closing it here is the port-freeing close in that window; once
			// the http.Server owns the close it is an idempotent no-op whose
			// error carries no information.
			_ = ln.Close()
		}
		s.closeAllWS()
		s.log.Info("webaccess: stopped")
	})
	return err
}

// redactToken renders a secret safe for logs: a short SHA-256 prefix and the
// length — never the value itself.
func redactToken(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return fmt.Sprintf("sha256:%s(len=%d)", hex.EncodeToString(sum[:2]), len(secret))
}

// randomHex returns 2*n hex characters from crypto/rand.
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("crypto/rand: %w", err)
	}
	return hex.EncodeToString(b), nil
}
