// SPDX-License-Identifier: Apache-2.0
//
// Package webaccess is the core of the browser web-access sidecar
// (specs/decisions/090-browser-web-access.md): an HTTP + WebSocket server
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
// Security posture (stage 2, ADR-090):
//   - Bind = any valid IP literal or "localhost" (config.IsValidWebAccessBind).
//     Loopback stays the safe default; a NON-loopback bind makes the listener
//     reachable beyond this machine over plain HTTP without TLS, and New
//     warns about exactly that — with no transport encryption the auth token
//     is the only protection. An invalid bind is refused (fail-closed).
//   - Auth token: cfg.Token when set, else a fresh crypto/rand token per
//     launch. The token is never logged in full and never travels in a URL
//     (login is POST body only; requests authenticate by HttpOnly
//     SameSite=Strict cookie).
//   - The cookie carries a per-launch session secret, NOT the configured
//     token — stealing a cookie never reveals a durable secret.
//   - Every handler and goroutine is recovered: a panic in the web layer (or
//     in a dispatched method) becomes a 500 envelope, never an app crash.
//   - RPC surface = exported methods of Dispatch minus the named denylist
//     (dispatch.go). A browser tab holds full control of the app by design;
//     the denylist only removes methods that are web-transport hazards.
//
// KNOWN LIMITATION: the cookie is issued without the Secure flag because the
// sidecar serves plain HTTP (no TLS yet). On the loopback default this is a
// local-machine concern; on a non-loopback bind the missing Secure flag plus
// the lack of TLS is part of the exposure the startup warning names.
// HttpOnly/SameSite=Strict, the per-launch session secret and the token gate
// remain the compensations; a TLS stage must flip Secure on. Websocket origin
// checks compare Origin against r.Host, which stays correct on any interface.
package webaccess

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"reflect"
	"strconv"
	"sync"
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
	// tokenBytes is the entropy of a generated per-launch auth token.
	tokenBytes = 32
	// shutdownBudget bounds the graceful Stop wait when the caller passes a
	// deadline-free context.
	shutdownBudget = 5 * time.Second
	// readHeaderTimeout and idleTimeout harden the HTTP server against
	// slowloris-style stalling on the listener.
	readHeaderTimeout = 10 * time.Second
	idleTimeout       = 2 * time.Minute
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
	// with a startup warning (network exposure, no TLS).
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
// stop with Stop. A Server is safe for concurrent use.
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

	mu       sync.Mutex
	ln       net.Listener
	httpSrv  *http.Server
	stopOnce sync.Once
	stopped  chan struct{}

	wsMu    sync.Mutex
	wsConns map[*WSConn]struct{}

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
	// network. Allowed (the operator owns the exposure decision) but loudly
	// surfaced — plain HTTP without TLS means the auth token is the only
	// protection out there.
	if !config.IsLoopbackBind(opts.Config.Bind) {
		log.Warn(fmt.Sprintf("webaccess: bind %q is not loopback — the listener is reachable beyond this machine, traffic is plain HTTP without TLS, the auth token is the only protection", opts.Config.Bind))
	}

	authToken := opts.Config.Token
	if authToken == "" {
		gen, err := randomHex(tokenBytes)
		if err != nil {
			return nil, fmt.Errorf("webaccess: generating per-launch token: %w", err)
		}
		authToken = gen
	} else if len(authToken) < 16 {
		// Operator-chosen weak secret: allowed (the operator owns the
		// risk — a short token is the weakest link already on loopback,
		// and the only protection on a non-loopback bind) but surfaced.
		log.Warn("webaccess: configured token is short; prefer the per-launch token or at least 16 characters")
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
		wsInbound:     opts.WSInbound,
	}
	s.handler = s.buildHandler()
	return s, nil
}

// buildHandler wires the route table. API handlers are recovered and emit
// no-store JSON; static assets go through the injected CSP middleware.
func (s *Server) buildHandler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/transport", s.recoverWrap(noStore(s.handleTransport)))
	mux.Handle("POST /api/login", s.recoverWrap(noStore(s.handleLogin)))
	mux.Handle("POST /api/rpc/{method}", s.recoverWrap(noStore(s.requireAuth(s.handleRPC))))
	mux.Handle("GET /ws", s.recoverWrap(noStore(s.requireAuth(s.handleWS))))
	if s.static != nil {
		static := http.FileServerFS(s.static)
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
	// including injected middleware and the static handler.
	return s.recoverWrap(mux)
}

// Handler returns the fully wired HTTP handler (tests and embedding).
func (s *Server) Handler() http.Handler { return s.handler }

// AuthToken returns the effective auth token a user must paste into the
// browser login screen: the configured token, or the generated per-launch
// one. This is the ONLY channel the token leaves the package through — it is
// never logged and never appears in a URL.
func (s *Server) AuthToken() string { return s.authToken }

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
// serves until Stop or ctx cancellation. It returns after the listener is
// bound; serve errors after that are logged, not returned.
func (s *Server) Start(ctx context.Context) error {
	addr := net.JoinHostPort(s.cfg.Bind, strconv.Itoa(s.cfg.Port))
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("webaccess: listen on %s: %w", addr, err)
	}

	s.mu.Lock()
	s.ln = ln
	s.httpSrv = &http.Server{ //nolint:gosec // plain-HTTP sidecar (TLS is a later stage); timeouts set below
		Handler:           s.handler,
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
	}
	srv := s.httpSrv
	s.mu.Unlock()

	s.log.Info("webaccess: listening", "addr", ln.Addr().String())

	go func() {
		if serr := srv.Serve(ln); serr != nil && !errors.Is(serr, http.ErrServerClosed) {
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
		s.mu.Unlock()
		if srv != nil {
			if serr := srv.Shutdown(ctx); serr != nil {
				err = errors.Join(serr, srv.Close())
			}
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
