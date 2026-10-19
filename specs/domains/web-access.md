# Web Access (Browser Sidecar)

## Purpose

Serve the existing c0wrk frontend to a local browser from the running desktop app: a loopback HTTP + WebSocket sidecar re-exposes the backend RPC surface (by reflection over `*backend.FrontendAPI`) and the backend event stream (via a web-agnostic tap in `(*App).emit`), so the same UI bundle works in the Wails webview and in a browser tab. The sidecar is mounted sideways from `desktop` and is designed to be removable without touching `backend`/`core` ([ADR-090](../decisions/090-browser-web-access.md)). The browser holds full control of the app by design — loopback binding plus the per-launch credential is the whole stage-1 mitigation.

## Key Files

- `internal/webaccess/` - the whole sidecar. `webaccess.go` — `Options`/`Server`, route table, secrets, lifecycle; `auth.go` — `/api/login`, the token↔cookie exchange, the login rate limiter, `requireAuth`; `dispatch.go` — reflection RPC dispatcher, the web-transport denylist, per-method body caps; `ws.go` — hand-rolled RFC6455 codec (handshake, frame read/write, ping/pong/close), the same-origin check, read/write pumps; `broadcast.go` — the event tap plus the per-client bounded-outbox fan-out. Dependency contract: **stdlib + `backend/config` only** — enforced by `nodeps_test.go` (`TestPackageImportHygiene`), which bans `desktop` and Wails imports in every file of the package, tests included.
- `desktop/startup_phases.go` - `initWebAccess` (the startup mount, after `emitBackendReady`) and `stopWebAccess` (the Shutdown stop, ~3s budget). Modeled on `initChatGPTAuth`: fail-soft and loud — a failed mount logs at Error and the desktop app continues; the persisted switch stays on and the next launch retries.
- `desktop/startup.go` - the call sites: `initWebAccess` right after `emitBackendReady`; `stopWebAccess` in `Shutdown` after `stopEmbeddedLLM` (a quit never hangs on a stateless listener).
- `desktop/webaccess_inbound.go` - the inbound bridge: `webWSInboundDispatcher(log)` (mounted as `Options.WSInbound` from `startWebAccessLocked`) decodes the `{name,args}` frames an authenticated tab sends and resolves the whitelisted frontend→backend HITL events through exactly the `desktop/event_handlers.go` methods the Wails listeners use; every other frame drops at Debug.
- `desktop/app.go` - the seams: `eventTap` (atomic pointer consumed by `(*App).emit`), the `webAccess`/`webAccessMu`/`webAccessStatic` fields, `startWebAccessLocked`/`stopWebAccessLocked`, `logWebAccessReady` (logs the URL with the token masked), and the control RPCs `GetWebAccessInfo`/`SetWebAccessEnabled` plus the `SetWebAccessStaticFS` startup handover — all methods on `*App`, never on `FrontendAPI`.
- `desktop/csp.go`, `desktop/csp_dev.go` - `CSPMiddleware()` (build-tag split: production CSP vs dev no-op), injected into `Options.CSP`; never duplicated inside the sidecar.
- `main.go` - the embedded SPA tree (`//go:embed all:frontend/dist`) handed over by `SetWebAccessStaticFS(fs.Sub(assets, "frontend/dist"))` strictly before `wails.Run` (the `SetWebviewGpuWatchdog` publishing precedent).
- `backend/config/web_access.go` - the `web_access` section (pure data; see [Configuration](#configuration)): fail-soft load normalization (warning + reset to the safe default state), fail-closed save validation, `IsLoopbackBind`.
- `backend/frontend_api_attachment.go` - `AttachFileContent` — the single additive backend edit: a byte-upload attachment method (`data []byte` travels base64 over both bridges), name sanitized to a bare base name, capped by the backend's raw-buffer limit (32 MiB). Survives sidecar removal.
- `frontend/src/api/runtime.ts` - the transport shim shared by both clients: synchronous Wails detection, `GET /api/transport` probe for the web transport, the RPC proxy over `POST /api/rpc/<Method>`, the WebSocket event router (batch envelopes and single events fan out through the same registry as the Wails path). Survives sidecar removal as the seam a future headless build rides.
- `frontend/src/api/webAccess.ts`, `frontend/src/components/settings/WebAccessSettings.tsx` - the Settings → General block: `parseWebAccessInfo` boundary validator (fail-open read → "unavailable" state), the optimistic toggle with rollback + authoritative re-read, URL/token rows (the raw token is never rendered — reveal/copy on demand).
- `desktop/webaccess_test.go`, `internal/webaccess/contract_test.go` - the lifecycle/isolation tests (mount, bounded stop, hot restart, control-RPC unreachability over the real authenticated handler) and the surface-contract test (denylist ↔ dispatch-target correspondence, upload-limit sizing).

## Core Types

```go
// internal/webaccess/webaccess.go — everything environment-specific is injected.
type Options struct {
    Config    config.WebAccessConfig          // resolved web_access section; New refuses a disabled section (ErrDisabled) or a non-loopback bind
    Dispatch  any                             // *backend.FrontendAPI at runtime; dispatched by reflection
    Static    fs.FS                           // SPA tree; served WITHOUT auth (the shell carries no data); nil disables the route
    CSP       func(http.Handler) http.Handler // injected desktop.CSPMiddleware(); nil = none
    Logger    *slog.Logger                    // secrets are never logged, in full or in part
    WSInbound func(c *WSConn, data []byte)    // the whitelisted HITL bridge — desktop/webaccess_inbound.go at mount; nil discards
}

type Server struct{ /* ... */ }
func New(opts Options) (*Server, error)        // validates; binds nothing
func (s *Server) Start(ctx context.Context) error // binds loopback (resolves port 0), serves until Stop/ctx
func (s *Server) Stop(ctx context.Context) error  // graceful within the deadline (default 5s), then force-closes — incl. hijacked WS conns; idempotent
func (s *Server) Addr() (string, bool)         // resolved host:port after Start
func (s *Server) AuthToken() string            // the ONLY channel the token leaves the package through
func (s *Server) EventTap() func(name string, args []interface{}) // the seam the desktop mount assigns to (*App).emit
func (s *Server) Dispatchable(method string) bool                 // exported on the target AND not denylisted
func DefaultDenylist() map[string]string       // method → web-transport reason (surface contract test)
```

```go
// backend/config/web_access.go — the operator-facing section (pure data).
type WebAccessConfig struct {
    Enabled bool   `yaml:"enabled"` // default false — nothing starts
    Bind    string `yaml:"bind"`    // default "127.0.0.1"; loopback-only while enabled
    Port    int    `yaml:"port"`    // default 0 = pick a free port at start
    Token   string `yaml:"token"`   // default "" = ephemeral per-launch token
}

// desktop/app.go — the Settings section's whole view (desktop.App only).
type WebAccessInfo struct {
    Enabled bool   `json:"enabled"` // persisted operator intent
    Running bool   `json:"running"` // live in this process
    URL     string `json:"url"`     // loopback URL; '' while not running
    Port    int    `json:"port"`
    Token   string `json:"token"`   // live token, or the configured one for the next launch
}
```

HTTP surface (all JSON, all same-origin; dynamic responses carry `Cache-Control: no-store`):

| Route | Auth | Behavior |
| ----- | ---- | -------- |
| `GET /api/transport` | none | Bootstrap answer `{transport:"web", ws:"/ws", authenticated:bool}` the SPA shell probes first |
| `POST /api/login` | none (rate limited: 10 attempts/min per IP, `Retry-After` on 429) | Token in the POST body → `HttpOnly` `SameSite=Strict` session cookie. 400 malformed · 401 wrong token · 429 limited |
| `POST /api/rpc/{method}` | session cookie | Positional JSON array args → JSON result, or `{error}` envelope with a non-200 status |
| `GET /ws` | session cookie + exact same-origin `Origin` | RFC6455 upgrade; one `{name,args}` frame per event |
| `GET /` | none | Static SPA through the injected CSP middleware |

## Flow

Two clients, one backend, one emit funnel:

```
                         ┌─────────────────────────────────────────────────────────┐
   backend/core events ──► (*App).emit  ──► wailsRuntime.EventsEmit ──► webview    │
                         │      │            (batched flush = c0wrk:events:batch)   │
                         │      └─► eventTap (atomic, nil-safe) ──► hub ──WS──► browser
                         └─────────────────────────────────────────────────────────┘

 webview : window.go.desktop.App.M(args) ──────────────► direct Go call (Wails IPC)
 browser : POST /api/rpc/M  [cookie] ──► reflection dispatcher ──► *backend.FrontendAPI method
 browser : GET /  ──► [CSP middleware] ──► static FS (frontend/dist) ──► same SPA bundle
 browser : GET /ws ──► [cookie + Origin check] ──► per-client outbox ──► one frame per event
 browser : WS text {name,args} ──► WSInbound whitelist ──► shared HITL handlers (webview answers ride Wails events)
```

1. **Mount** — startup (`initWebAccess`, after `emitBackendReady`) or `SetWebAccessEnabled(true)` builds `Options` from the live `FrontendAPI`, the SPA tree `main.go` handed over, `CSPMiddleware()`, the resolved config section, and the inbound HITL dispatcher; `New` validates (enabled, loopback bind, port range, non-nil dispatch target), mints the auth token (configured, or a fresh crypto/rand 32-byte hex per launch) and the separate per-launch session secret; `Start` binds and publishes the handle, then the tap — in that order, so `GetWebAccessInfo` already sees `Running` once events can flow.
2. **Detection** — the webview resolves `'wails'` synchronously; a browser page probes `GET /api/transport` and resolves `'web'` (or `'none'` when no sidecar serves the origin — plain dev server, vitest, SSR).
3. **Login** — the browser SPA asks the operator for the token (Settings → Web Access shows it on demand); `POST /api/login` exchanges it for the session cookie. Rejected attempts log only a SHA-256 digest of the presented secret.
4. **RPC** — every call dispatches by reflection over the exported `FrontendAPI` method surface (the same surface the Wails binding generator consumes): denylisted → 403 with the reason, unknown → 404, wrong arg count → 400, variadic → 501 (fail-closed; no such method exists today), a panicking method → 500 envelope, a non-nil trailing `error` → 500 envelope. Bodies are capped at 1 MiB (48 MiB for `AttachFileContent`, whose base64 payload must fit the backend's own 32 MiB raw cap).
5. **Events** — backend events already funnel through `(*App).emit`; the tap marshals one `{name,args}` envelope per emit call (once, before fan-out) and enqueues it on every live client's bounded outbox (1024 frames). The fan-out never blocks the desktop event goroutine; a client that cannot keep up is dropped with a Warn (it reconnects with backoff — 500 ms doubling to 30 s). The desktop layer's own batching is upstream of `emit`, so a coalesced flush arrives as its `c0wrk:events:batch` envelope frame and the shim unwraps it through the same path the webview uses; the sidecar itself adds no batching and reshapes nothing. Inbound frames ride the same envelope in reverse: the mount wires `Options.WSInbound` to `webWSInboundDispatcher`, whose whitelist resolves exactly the seven frontend→backend HITL events (`tool_confirm_response`, `tool_judge_request`, `ask_user_response`, `step_limit_response`, `plan_approval_response`, `goal_proposal_response`, `goal_suggestion_response`) through the shared handlers — the desktop event listeners and the web bridge are two transports over one authorization decision. Everything else is dropped at Debug and the connection survives.
6. **Stop** — app `Shutdown` (`stopWebAccess`, ~3 s budget, after `stopEmbeddedLLM`) or `SetWebAccessEnabled(false)` clears the handle and the tap first, then stops the server: graceful `Shutdown` within the deadline, then a force-close that reclaims hijacked WebSocket connections. Idempotent; a quit is never blocked by the sidecar.

## Invariants

- **Sidecar boundary** — everything web-specific lives only in `internal/webaccess` and the frontend shim (`frontend/src/api/runtime.ts` web branches, `frontend/src/api/webAccess.ts`, `WebAccessSettings.tsx`). `internal/webaccess` imports only the Go stdlib and `backend/config` (never `desktop`, never Wails — guarded by `TestPackageImportHygiene`); `desktop` is its only importer; `backend` and `core` never reference it.
- **One emit path** — every backend-facing event flows through `(*App).emit` exactly once; the tap observes the same dispatch the webview gets. The tap never alters, filters, blocks, or fails the Wails emit; a panic inside it is recovered and logged ("desktop dispatch unaffected"). Event producers know nothing about transports.
- **Stage 1 binds loopback only** — `New` refuses a non-loopback bind; the config loader fail-soft resets a non-loopback or out-of-range section to the safe default (sidecar off) with a visible warning; `Save` refuses to persist an enabled section that fails the same checks. The shipped config schema cannot express a LAN listener.
- **Default off** — an absent section, or `enabled: false`, starts nothing; the app behaves exactly as before the feature existed.
- **Denylist is the only surface reduction** — the web-dispatchable surface is exactly the exported `FrontendAPI` methods minus `deniedMethods`: `EmitSessionEvent` (a web client must consume events, never forge them into the trusted bus) and `PasteFromClipboard` (OS-wide clipboard exfiltration). Entries are web-transport hazards only, each with its reason inline; ordinary business policy stays in the methods it belongs to.
- **The token never travels in a URL and never lands in logs** — login is POST-body only; requests authenticate by the `HttpOnly` `SameSite=Strict` session cookie, which carries a separate per-launch session secret (stealing a cookie reveals no durable secret); secrets are compared as fixed-size digests in constant time; rejected logins log only a `sha256:<prefix>(len=N)` digest; the ready log masks the token ("(hidden — see Settings → Web Access)"); `AuthToken()` is the token's only exit from the package.
- **Control RPCs are unreachable from the web** — `GetWebAccessInfo`/`SetWebAccessEnabled` are methods on `desktop.App`, and the reflection dispatcher sees exactly the `FrontendAPI` surface, so a browser tab can neither read the credential state nor flip the switch that feeds it. Pinned by tests over the sidecar's real authenticated handler.
- **The inbound event bridge is a whitelist, never a forge path** — an authenticated tab holds webview trust (the session cookie is the boundary), so it may resolve HITL actions; but only through the fixed bridge: `webWSInboundDispatcher` resolves exactly the seven frontend→backend HITL events via the same `desktop/event_handlers.go` handlers the Wails listeners use, drops every other name at Debug (network input must not write unbounded log lines), and `EmitSessionEvent` stays denylisted — arbitrary events still cannot be forged into the trusted bus. Two clients racing one action inherit the handlers' first-responder-wins semantics; a judge flood is self-bounded (the handler acts only on a live `pendingConfirmations` entry). Pinned by dispatch, wire, and hot-restart tests.
- **The feature stays additive** — deleting the sidecar package, its mount, and (optionally) the config section and Settings block restores the pre-feature app (see [Removal Path](#removal-path)); the zero-backend-edit rule holds with the single recorded exception of the additive `AttachFileContent` method.
- **Panics never cross the boundary** — every HTTP handler and goroutine is recovered; a panic in the web layer or in a dispatched method becomes a 500 envelope (or a closed connection), never an app crash.

## Configuration

```yaml
web_access:
  enabled: false   # master switch; false (or an absent section) starts nothing
  bind: "127.0.0.1"  # loopback only while enabled: a loopback IP literal (incl. IPv4-mapped) or "localhost"
  port: 0          # 0 = pick a free loopback port at every start
  token: ""        # empty = ephemeral per-launch token; a static token is opt-in (warned under 16 chars)
```

Load is **fail-soft** (the `shell_exec` precedent): an enabled section with a non-loopback bind or an out-of-range port produces a visible load warning and is reset to the canonical default state (disabled, loopback, auto port, ephemeral token) — a broken section never keeps the app from starting and never leaves an unsafe listener configured. Save is **fail-closed**: an enabled section failing the same checks is never persisted. The security-relevant stage-1 constants — loopback bind, per-launch credential, `HttpOnly`/`SameSite=Strict` cookie, WS same-origin check — are **not** operator-configurable: they are the feature's floor, not tunables ([ADR-090](../decisions/090-browser-web-access.md), decision 2). Known stage-1 limitation, recorded in code: the cookie omits `Secure` because the sidecar serves plain HTTP on loopback; a TLS stage must flip it on.

## Removal Path

The feature is designed to be deleted. To abandon the sidecar (headless exposure is a separate, future decision — the [ADR-090](../decisions/090-browser-web-access.md) stage-2 path is additive, not this):

1. **Delete `internal/webaccess/`** — the entire package, tests included. Nothing outside it (besides the mount) imports it.
2. **Delete the desktop mount** — `initWebAccess`/`stopWebAccess` in `desktop/startup_phases.go` and their call sites in `desktop/startup.go`; `startWebAccessLocked`/`stopWebAccessLocked`/`logWebAccessReady`; the `webAccess`/`webAccessMu`/`webAccessStatic` fields; the control RPCs `GetWebAccessInfo`/`SetWebAccessEnabled` and the `SetWebAccessStaticFS` handover; the `eventTap` field + `setEventTap` (added for this feature — `emit` reverts to dispatching straight to Wails); `desktop/webaccess_inbound.go` + `desktop/webaccess_inbound_test.go` (the inbound bridge and its wire tests); `desktop/webaccess_test.go`; the `SetWebAccessStaticFS(fs.Sub(assets, "frontend/dist"))` line in `main.go`.
3. **Delete the config section** — `backend/config/web_access.go` (struct, `IsLoopbackBind`, load normalization, save validation) and the `web_access:` block from `config.example.yaml`. A leftover `web_access:` section in an existing user `config.yaml` is inert: the loader unmarshals non-strictly, so the unknown key is ignored and dropped by the next save.
4. **Delete the frontend surfaces** — `frontend/src/api/webAccess.ts`, `frontend/src/components/settings/WebAccessSettings.tsx` (and their tests, plus the `webAccess` barrel export in `frontend/src/api/index.ts`).
5. **Remove the SECURITY.md attack-surface entry** for the built-in web server.

**What stays** (deliberately):

- `frontend/src/api/runtime.ts` — the transport shim is the abstraction seam a future headless build rides; with the sidecar gone its web probe simply resolves `'none'` and the Wails paths take over. Do not rip the `'web'` branches out as part of a removal cleanup unless the headless direction is also abandoned.
- `AttachFileContent` (`backend/frontend_api_attachment.go`) — additive, desktop-useful, and the recorded exception to zero backend edits; it survives removal.
- The desktop event batching infrastructure — upstream of the sidecar and independent of it.

## Extension Points

- **Stage 2 — LAN + TLS** is a future, separate ADR ([ADR-090](../decisions/090-browser-web-access.md), decision 3). Credential handling and transport security arrive as mounted parameters; flipping `Secure` on and widening `IsLoopbackBind` are the additive seams.
- **Additional transports over the same event tap** — the tap is web-agnostic (`func(name string, args []interface{})`); a headless build would consume it through the surviving `runtime.ts` shim or a new consumer.
- **New backend RPCs appear to the browser automatically** — reflection dispatch needs no registration; new methods become web-callable the moment they become webview-callable. The surface-contract test is the place to note a new upload-sized method (raise its body cap in `uploadBodyMethods` if it carries bulk payloads) or a new web-transport hazard (denylist entry with its reason).
- **Inbound WS events beyond the HITL seven** — the bridge (`webWSInboundDispatcher`) resolves exactly the seven frontend→backend HITL events; a future feature that legitimately needs more UI→backend events over the web extends that whitelist with its own authorization reasoning and tests, never by reopening a generic forge path (`EmitSessionEvent` stays denied).

## Related Specs

- [ADR-090](../decisions/090-browser-web-access.md) - the sidecar architecture decision this spec implements (note: its decision 6 named `gorilla/websocket`; the implementation narrowed this to a hand-rolled stdlib RFC6455 codec — the library never left the indirect-only Wails dependency)
- [architecture/layers.md](../architecture/layers.md) - the layering invariants the sidecar must not disturb
- [contracts/desktop-frontend.md](../contracts/desktop-frontend.md) - the RPC/event surface the sidecar re-exposes; the two-transport boundary rule
- [contracts/event-catalog.md](../contracts/event-catalog.md) - the event stream bridged by the tap, and the web transport's delivery rules
- [frontend/README.md](frontend/README.md) - the frontend bundle served by both transports
