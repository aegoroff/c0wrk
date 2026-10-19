# ADR-090: Browser Web Access — a Loopback Sidecar Mounted Sideways from desktop

## Status

Accepted

## Context

c0wrk's UI exists in exactly one place: the Wails desktop window. The React frontend is served by the Wails asset server (`//go:embed all:frontend/dist` in `main.go`), talks to the Go backend through generated bindings over the embedded `*backend.FrontendAPI`, and receives the event stream through Wails events. A user who wants to check on or drive a session from a phone, a second machine, or any browser has no path to the running app.

A browser surface needs the three transports the webview gets from Wails for free: the static frontend bundle, an RPC channel into the backend, and the event stream. Building any of that into the desktop package — or maintaining a second, headless binary — multiplies the surface that must be tested and kept in sync before the need is even proven.

The requirement that shaped this decision: **attach the web surface maximally sideways.** The existing app must carry almost no web knowledge, the feature must stay trivially removable, and the larger evolution (LAN exposure, a headless build) must not be foreclosed by stage 1. Whatever is decided has to respect the layering invariants ([architecture/layers.md](../architecture/layers.md)) and the security posture of a tool that can execute shell commands on the user's machine — a browser surface into c0wrk is, by construction, full remote control of the agent.

## Decision

1. **The web surface is an autonomous sidecar package, `internal/webaccess`, that depends on neither `desktop` nor Wails.** Every environment-specific piece is injected from the mounting point in `desktop`:
   - **Dispatch target.** webaccess receives the existing `*backend.FrontendAPI` as an opaque target and dispatches every RPC by reflection over its exported method surface — the same surface the Wails binding generator consumes. Zero edits in `backend`/`core`: methods become callable from the browser exactly when they become callable from the webview.
   - **Event tap.** `(*App).emit` in `desktop/app.go` — the single funnel through which every backend-facing event already flows — gains a generic, web-agnostic tap (the `eventTap` seam): when non-nil, it receives `(eventName, optionalData...)` alongside the normal Wails emit. This is the only seam in app core, it is 2–3 additive lines, and it knows nothing about sockets, browsers, or webaccess.
   - **Static FS and CSP middleware.** The static filesystem (the built frontend bundle — the same tree Wails embeds) and the Content-Security-Policy middleware are constructed at the mounting point and handed to webaccess; the package serves only what it is given.

2. **Stage 1 is loopback-only with a per-launch credential.** The sidecar binds `127.0.0.1`, generates a per-launch token, and delivers it as an `HttpOnly` `SameSite=Strict` cookie; the WebSocket upgrade additionally verifies the request `Origin`. **Accepted consequence, stated explicitly:** a browser holding the cookie has full control of the app — identical to sitting at the desktop. Loopback binding plus the per-launch token is the whole stage-1 mitigation; no per-RPC authorization model is built.

3. **Stage 2 — LAN exposure with TLS — is out of scope and gets its own future ADR; the path is not closed.** Stage 1 is shaped so that ADR can be additive: bind address, credential handling, and transport security all arrive as mounted parameters rather than package constants.

4. **Control RPCs live on `desktop.App`, never on `*backend.FrontendAPI`.** `GetWebAccessInfo`/`SetWebAccessEnabled` are desktop-lifecycle concerns. Because the web client dispatches over the `FrontendAPI` surface, keeping the control RPCs off it means the browser cannot control the sidecar itself — no self-disable, no credential state readback through the web surface. It also keeps the import graph acyclic: `desktop` imports `webaccess`; `backend` never imports `webaccess`; `webaccess` imports only the Go stdlib plus the WebSocket library.

5. **The removal path is: delete `internal/webaccess`, the desktop mounting lines, and — optionally — the config section and the Settings block.** No backend/core code carries web concepts. The single deliberate backend edit is additive and survives removal: the new `AttachFileContent` method (decision 7). The frontend shim in `frontend/src/api/runtime.ts` **stays** after removal: it is the transport-abstraction seam a future headless build needs, independent of whether the desktop sidecar exists.

6. **WebSocket transport is `gorilla/websocket v1.5.3`.** It is already in the module graph as an indirect dependency of Wails v2, so adopting it promotes an existing pinned version instead of adding a new dependency.

7. **Browser-native gaps are handled by feature-detect + gating; attachments are the one additive backend edit.** The web client detects desktop-only affordances (native file and directory dialogs) and gates the corresponding UI instead of reimplementing them. Where the web surface genuinely needs new backend capability — file attachments, where a browser hands over bytes rather than a local path — a new `AttachFileContent` method is added to the backend attachment surface. This is the deliberate, recorded exception to "zero backend edits".

8. **The inbound WebSocket bridge is a fixed whitelist (amendment closing the stage-1 HITL gap).** Stage 1 shipped with inbound frames discarded — HITL answers from a tab were view-only. Closing that gap does NOT reopen a generic forge path: the mount wires `Options.WSInbound` to a desktop-owned dispatcher (`desktop/webaccess_inbound.go`) that resolves exactly the seven frontend→backend HITL response events through the same `desktop/event_handlers.go` handlers the Wails event listeners use — one authorization decision, two transports. A tab holds webview trust (decision 2's cookie boundary), so resolving a pending HITL action is an authorized operation; every other frame drops at Debug (network input must not write unbounded log lines), `EmitSessionEvent` stays denylisted so arbitrary events still cannot be forged into the trusted bus, and a judge flood is self-bounded (the handler acts only on a live pending entry). Frontend code needs no change: `runtime.ts`'s `emit()` already sent the symmetric `{name,args}` frames.

9. **The web SPA boots only after the transport probe settles, and App-level gaps surface through an explicitly pinned extra adapter (amendment from field diagnosis of the first real browser session).** Two defects surfaced when a late-joining browser tab met the real sidecar. First, the boot race: the web-transport probe is an async round trip, and a tab that mounted the app before it settled fired every mount-time RPC at `getApp()` while the transport was unresolved — the shim threw, and `App.tsx`'s one-shot splash→main safety net died without a retry, stranding the tab on an empty splash forever (the desktop window was immune only because Wails injects its bindings synchronously). The fix is a boot barrier in the gate — the app mounts only into a resolved transport — with the `'wails'` path short-circuited synchronously so the window never waits; a pre-auth tab also no longer opens the event socket (the upgrade could only 401-loop; login reloads the page and the fresh probe reconnects). Second, `GetPendingActions` — the HITL reconciliation sweep a session switch fires — lives on `desktop.App`, not `FrontendAPI`, so the reflection dispatcher 404'd it. Rather than moving app state into `backend` or widening the dispatch target to the whole App (which would expose the control RPCs decision 4 isolates), the mount passes a MINIMAL desktop-owned adapter (`webaccess_extra.go`) as `Options.ExtraDispatch`, consulted only when the primary surface lacks the method; the denylist governs the union, and the adapter's method set is pinned exactly by tests in both packages. Adding to it is a conscious, test-amended security decision, never a convenience.

## Consequences

Positive:

- Near-zero cost to the existing app: two or three additive lines in `desktop/app.go`, a mount block in `desktop`, one additive backend method. No `backend`/`core` edit carries web knowledge, and the layering invariants hold untouched.
- `internal/webaccess` is testable without Wails, a webkit toolchain, or a window: plain `httptest` over HTTP + WebSocket covers the whole sidecar.
- The web UI tracks the desktop UI for free — both reflection dispatch and the generic event tap consume the surfaces Wails already exposes, so new RPCs and events appear in the browser without a sync step.
- Removal is a directory delete plus a handful of mounting lines; the feature cannot rot into the app's bones because nothing outside the sidecar and its mount knows about it.
- The event tap is web-agnostic: a future transport (headless, telemetry) can consume the same seam.

Negative:

- Full control from the browser is an accepted, permanent consequence of stage 1. Whoever obtains the per-launch cookie on the loopback interface can drive the agent, including shell execution; stage 1 deliberately builds no finer authorization.
- Reflection dispatch is untyped at compile time. Method-surface errors surface at request time, and semantics that Wails handles specially (context-aware methods, native dialogs, some value marshaling edge cases) may need per-case handling at the mount as they are discovered.
- The emit seam adds one indirection on the desktop event path, and the tap widens the blast radius of a panic in a transport consumer — the tap must be defensive by contract (never alter, never block, never propagate failures into the Wails emit).
- A second serving surface of the frontend bundle exists (sidecar static FS vs Wails asset server); CSP and any asset-side hardening must now be reasoned about twice, mitigated by both being constructed at the mounting point.
- Native browser affordances (file pickers, dialogs) degrade to feature-detected alternatives; the web client is explicitly second-class for those flows until a future ADR says otherwise.

## Alternatives Considered

- **Webserver inside `desktop/`** — rejected. It couples the HTTP/WS surface to the Wails lifecycle and types, makes the sidecar untestable without a window/toolchain, blurs `desktop`'s role down to "everything that talks to a user", and turns the removal path into surgery on the app core instead of deleting a package.
- **A headless binary now** — rejected. It doubles the build, release, and compatibility matrix before the browser use-case is proven, and it forces an immediate decision about which backend wiring the headless variant carries. Stage 1's sidecar plus the surviving `runtime.ts` shim keeps the headless path open without paying for it now (stage 2/3 gets its own ADR when pursued).
- **Migrating to Wails v3** (multi-window/web-native serving) — rejected. The project is pinned to the Wails v2 line; a framework migration is a cross-cutting risk out of all proportion to the feature, and it still would not answer the "drive the app from another device" question that motivates the sidecar.
- **Relying on `wails dev`** — rejected. It is a development server, not a product surface: no auth model, dev-server semantics, no distribution story, and it answers none of the remote-access needs.

## Related

- [web-access.md](../domains/web-access.md) — the domain spec (draft) this decision is implemented by
- [architecture/layers.md](../architecture/layers.md) — the layering the sidecar must not disturb
- [contracts/desktop-frontend.md](../contracts/desktop-frontend.md) — the RPC/event surface the sidecar re-exposes
- [075-single-instance-lock.md](075-single-instance-lock.md) — adjacent desktop-lifecycle machinery (single app instance the sidecar serves)
- [023-auto-update.md](023-auto-update.md) — precedent for stage-gated, separately-decided exposure of the app to external processes
