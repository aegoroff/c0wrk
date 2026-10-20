// Shared runtime-readiness arming for app-global DOM triggers (window focus,
// tab visibility, …): run `attach` exactly once a transport that can serve
// RPCs is live, and never in an environment that has nothing to talk to.
//
// Why NOT `backend:ready`: that event is a desktop one-shot — the startup
// sequence emits it once during boot (desktop/startup.go, right before
// initWebAccess mounts the sidecar) and never replays it. The desktop webview
// always catches it because Wails injects the runtime and the generated
// bindings BEFORE any bundle code runs, so a subscriber mounted at the App
// root is registered in time. A browser tab that joins later (the web
// transport, ADR-090) subscribes only after its page loads — by then the
// event is long gone — so gating web arming on `backend:ready` leaves web
// tabs permanently disarmed: their focus/visibility triggers never fire and
// the missed-delta repair stays dead. Transport detection (api/runtime) is
// the readiness signal that works in BOTH transports:
//
//   - 'wails' — resolved synchronously at module load (`isWailsReady()`);
//     the attach happens immediately, without waiting for anything.
//   - 'web'   — the web-access sidecar serves this page. Attaching is safe
//     unconditionally: the login gate (WebAccessGate) keeps unauthenticated
//     tabs behind the token form — the app root, where these triggers mount,
//     only ever mounts for an authenticated tab — and a mid-session 401
//     swaps the app for the gate, whose cleanup detaches.
//   - 'none'  — no backend on this origin (plain `make dev-frontend`
//     browser session, vitest, SSR): never arm, the RPCs are guaranteed
//     no-ops.
//
// The async path also arms on 'wails' for defense: `detectInitialTransport`
// already classifies a runtime-without-bindings webview (a desktop window
// caught mid-injection, a test fake) as 'wails', where `isWailsReady()` is
// still false — the same population the retired `backend:ready` fallback
// covered.
//
// `attach` must be idempotent-safe in the caller's sense: it is invoked at
// most once per armWhenRuntimeReady call, and the returned disposer is
// idempotent. Returns a disposer that detaches when armed, cancels a still
// pending detection when not, and is safe to call twice — the exact
// effect-cleanup shape the arming hooks need.
import { isWailsReady, transportDetection } from '@/api/runtime'

export function armWhenRuntimeReady(attach: () => () => void): () => void {
  let disposed = false
  let detach: (() => void) | null = null

  if (isWailsReady()) {
    detach = attach()
    return () => {
      detach?.()
      detach = null
    }
  }

  // The probe is a one-round-trip promise per page load; by the time the app
  // root mounts it has usually settled already, so this is near-instant in
  // both transports.
  void transportDetection().then((mode) => {
    if (disposed || detach !== null || mode === 'none') return
    detach = attach()
  })

  return () => {
    disposed = true
    detach?.()
    detach = null
  }
}
