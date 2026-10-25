// SPDX-License-Identifier: Apache-2.0
//
// auth.go — authentication for the web sidecar: the per-launch token, the
// login endpoint that exchanges it for an HttpOnly SameSite=Strict session
// cookie, the brute-force limiter, and the requireAuth gate shared by every
// authenticated route.
//
// Secrets discipline: the token exists in exactly three places — inside this
// process (memory), in the POST body of a login attempt, and on the operator
// side (wherever the desktop UI shows it). It is never logged (only the
// redactToken digest), never echoed in a response, and never accepted via
// URL — the login is POST-body only, and requests authenticate by cookie.

package webaccess

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"mime"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// loginMaxAttempts caps login attempts per client per window. Loopback
	// clients all share one IP, but the bound is generous for a human and
	// hostile to a scripted brute force.
	loginMaxAttempts = 10
	// loginWindow is the fixed window of the limiter.
	loginWindow = time.Minute
	// sessionCookieTTL — the cookie is a session cookie by default (dies
	// with the browser); no Max-Age is set. The constant documents the
	// choice and keeps it greppable.
	sessionCookieTTL = 0
)

// loginAttempt is a fixed-window bucket for one client key.
type loginAttempt struct {
	start time.Time
	count int
}

// loginLimiter is a tiny per-IP fixed-window counter guarding /api/login.
type loginLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	hits   map[string]*loginAttempt
}

func newLoginLimiter(maxAttempts int, window time.Duration) *loginLimiter {
	return &loginLimiter{max: maxAttempts, window: window, hits: make(map[string]*loginAttempt)}
}

// allow records one attempt for key and reports whether it fits the window.
// Stale buckets are pruned lazily once the map grows past a small multiple
// of the active keys a loopback listener can have.
func (l *loginLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.hits[key]
	if b == nil || now.Sub(b.start) >= l.window {
		if b == nil {
			b = &loginAttempt{}
			l.hits[key] = b
		}
		b.start = now
		b.count = 0
	}
	b.count++
	if len(l.hits) > 64 {
		for k, v := range l.hits {
			if now.Sub(v.start) >= l.window {
				delete(l.hits, k)
			}
		}
	}
	return b.count <= l.max
}

// noStore stamps cache-suppression onto every dynamic response: API results
// and auth state must never land in any cache.
func noStore(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// clientKey identifies the rate-limit bucket: the remote IP without port.
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// constantTimeEqual compares two secrets in constant time regardless of
// length, by comparing fixed-size digests instead of the raw values (a raw
// subtle.ConstantTimeCompare leaks length mismatch through its early return).
func constantTimeEqual(a, b string) bool {
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

// hasSessionCookie reports whether the request carries the valid per-launch
// session secret.
func (s *Server) hasSessionCookie(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	if err != nil || c.Value == "" {
		return false
	}
	return constantTimeEqual(c.Value, s.sessionToken)
}

// requireAuth wraps an authenticated handler: no valid session cookie → 401.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.hasSessionCookie(r) {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		next(w, r)
	}
}

// sameOriginGate rejects a state-changing request whose Origin header is
// present and does not exactly match scheme://r.Host — the exact-equality
// check the /ws upgrade already enforces, extended to the POST routes
// (/api/rpc, /api/login). SameSite=Strict separates SITES, not origins: a
// page served from any other port of the same host shares the cookie jar,
// and a preflight-free no-cors POST would ride the session cookie straight
// into a handler that parses the body regardless of its content type.
// A MISSING Origin stays allowed — browsers attach Origin to every POST
// (fetch spec), so only non-browser clients (curl, scripting) omit it, and
// such a client carries the session cookie only by having logged in
// deliberately; refusing them would break every non-browser consumer for no
// security gain.
func (s *Server) sameOriginGate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" && !s.sameOrigin(r) {
			writeJSONError(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}
		next(w, r)
	}
}

// jsonContentTypeGate requires the JSON media type on a route whose body is
// always JSON (/api/rpc). A cross-origin no-cors request cannot carry
// Content-Type: application/json — the fetch CORS safelist restricts no-cors
// bodies to form/text encodings — so the header doubles as a CSRF
// discriminator on top of sameOriginGate. The official shim sends it on
// every call, including zero-argument ones. Charset and other media-type
// parameters are accepted (parsed via mime.ParseMediaType).
func jsonContentTypeGate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || !strings.EqualFold(mediaType, "application/json") {
			writeJSONError(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json")
			return
		}
		next(w, r)
	}
}

// handleTransport answers the unauthenticated bootstrap question the SPA
// shell asks first: which transport am I on, where is the event channel, and
// am I already authenticated.
func (s *Server) handleTransport(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, transportInfo{
		Transport:     "web",
		WS:            wsPath,
		Authenticated: s.hasSessionCookie(r),
	})
}

// transportInfo is the /api/transport payload.
type transportInfo struct {
	Transport     string `json:"transport"`
	WS            string `json:"ws"`
	Authenticated bool   `json:"authenticated"`
}

// loginRequest is the /api/login payload.
type loginRequest struct {
	Token string `json:"token"`
}

// handleLogin exchanges the auth token for the session cookie.
// 400 malformed body · 401 wrong token · 429 rate limited · 200 + cookie.
// The limiter counts only requests that arrive with a parseable body: a
// script flooding malformed requests must not drain the shared per-IP
// window and lock the operator's own browser out of login.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	body, ok := s.readJSONBody(w, r, maxBodyBytes)
	if !ok {
		return
	}
	var req loginRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "malformed login body")
		return
	}
	if !s.limiter.allow(clientKey(r), time.Now()) {
		w.Header().Set("Retry-After", "60")
		writeJSONError(w, http.StatusTooManyRequests, "too many login attempts; try again later")
		return
	}
	if !constantTimeEqual(req.Token, s.authToken) {
		// Log only the digest of the REJECTED secret — enough to tell
		// replayed wrong attempts apart, useless for reconstruction.
		s.log.Warn("webaccess: rejected login attempt", "presented", redactToken(req.Token))
		writeJSONError(w, http.StatusUnauthorized, "invalid token")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    s.sessionToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		// Secure rides the transport (ADR-102): set exactly when the sidecar
		// terminates TLS, omitted on plain HTTP — byte-identical to the
		// pre-ADR-102 behavior there. HttpOnly/SameSite=Strict, the
		// per-launch session secret and the token gate stay the compensations
		// on both transports.
		Secure: s.tls != nil,
		MaxAge: sessionCookieTTL,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// readJSONBody reads the request body under the given size cap. An oversize
// body becomes a 413 response (ok=false); a genuinely empty body yields an
// empty slice so zero-argument RPCs work with a bare POST.
func (s *Server) readJSONBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	body, err := readAllLimited(w, r, limit)
	if err != nil {
		if errors.Is(err, errBodyTooLarge) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return nil, false
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read request body")
		return nil, false
	}
	return body, true
}

// writeJSON emits a JSON success response.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// Headers are already sent; nothing to recover — the connection
		// is broken and net/http logs the write failure itself.
		return
	}
}

// errorEnvelope is the uniform error payload; the browser shim rejects its
// Promise with the `error` string.
type errorEnvelope struct {
	Error string `json:"error"`
}

// writeJSONError emits the uniform error envelope.
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorEnvelope{Error: msg})
}
