// Transport shim — the single access point for the desktop (Wails) runtime
// bindings (`window.go` / `window.runtime`) and for the browser transport
// used when this same bundle is served by the web-access sidecar (ADR-098).
// Every `window.go`/`window.runtime` access in the frontend lives here; the
// test/wailsAccessInvariant scan enforces it project-wide.

import type { GlobalEventKey, GlobalEventMap, SessionEventKey, SessionEventMap } from '@/types/events'
import { logger } from '@/lib/logger'

/**
 * Report a session event whose payload failed its type guard and was dropped.
 * Malformed events must never disappear silently — a dropped `error` or
 * `task_complete` leaves the UI in a state that no longer matches the backend.
 */
export function reportDroppedEvent(event: string, data: unknown): void {
  logger.warn(`[events] dropped malformed session event "${event}"`, data)
}

// NOTE on system notifications: the Wails runtime also exposes a window.runtime
// notification surface (SendNotification / InitializeNotifications / …), but
// c0wrk does NOT use it. The single transport is the Go bridge — see
// @/api/notifications (App.InitNotifications / App.SendSystemNotification) —
// because the click round-trip is Go-owned: the backend registers the response
// callback, focuses the window, and emits `notification_clicked`. Keeping a
// second optional path here would split the bookkeeping in two.

// --- Transport detection -----------------------------------------------------
//
// Three states, resolved once per page load:
//   - 'wails': the Wails runtime bindings are injected (desktop webview).
//     Detected synchronously — Wails injects them before any bundle code runs.
//   - 'web':   served by the web-access sidecar over plain HTTP (ADR-098).
//     Detected by asking the origin: GET /api/transport answers
//     `{transport:"web", ws:"/ws", authenticated:...}`. RPCs dispatch to
//     POST /api/rpc/<Method>, events arrive over the WebSocket named by `ws`.
//   - 'none':  neither (plain `make dev-frontend` browser session, vitest,
//     SSR). RPC wrappers throw the legacy errors, event helpers no-op —
//     exactly the pre-web-transport behavior.

export type TransportMode = 'wails' | 'web' | 'none'

/** Resolved transport, or 'pending' while the sidecar probe is in flight. */
type TransportResolution = TransportMode | 'pending'

/** Bootstrap answer of the web-access sidecar (GET /api/transport). */
interface TransportInfo {
  transport?: unknown
  ws?: unknown
  /** Whether the browser already holds a valid session cookie. */
  authenticated?: unknown
}

function detectInitialTransport(): TransportResolution {
  if (typeof window === 'undefined') return 'none'
  // Wails injects the runtime and the generated bindings together, before any
  // bundle code runs. A runtime without bindings (unit-test fakes, a webview
  // caught mid-injection) is still the desktop transport: every wrapper below
  // keeps its legacy window.runtime-keyed behavior in that state.
  if (window.go?.desktop?.App || window.runtime) return 'wails'
  return 'pending'
}

let transportMode: TransportResolution = detectInitialTransport()
let webWsPath = '/ws'
/** Web-transport session state from the bootstrap probe: true once the origin
 *  answered `authenticated:true`, false when it answered without a session,
 *  null while pending or outside the web transport. The login gate consumes
 *  this through `webAuthRequired()`. */
let webAuthed: boolean | null = null
let detectionPromise: Promise<TransportMode> | null = null

/** Ask the origin whether the web-access sidecar serves this page. Never rejects. */
async function detectWebTransport(): Promise<TransportMode> {
  if (typeof fetch !== 'function') return 'none'
  try {
    const res = await fetch('/api/transport', {
      headers: { Accept: 'application/json' },
      // Boot-gating probe: a wedged sidecar must release the splash instead
      // of holding it forever; a timeout reads as "no sidecar here", the
      // same answer the catch below gives.
      signal: webFetchTimeoutSignal(),
    })
    if (!res.ok) return 'none'
    const info = (await res.json()) as TransportInfo
    if (info.transport !== 'web' || typeof info.ws !== 'string' || info.ws === '') return 'none'
    webWsPath = info.ws
    // Fail closed: an absent/odd `authenticated` field reads as "must log in".
    // A wrong guess self-corrects — the login POST works regardless, and the
    // page reloads once the cookie is set.
    webAuthed = info.authenticated === true
    // A pre-auth tab holds no session cookie: upgrade attempts would only
    // 401-loop against the sidecar. Login always reloads the page, so the
    // fresh probe reconnects the socket authenticated.
    if (webAuthed) connectWS()
    return 'web'
  } catch {
    // No sidecar on this origin (bare dev server, static preview) — the
    // plain browser session. Debug-level: this is the common dev case, not
    // a problem worth surfacing.
    return 'none'
  }
}

function ensureTransportDetection(): Promise<TransportMode> {
  if (transportMode !== 'pending') return Promise.resolve(transportMode)
  if (!detectionPromise) {
    detectionPromise = detectWebTransport().then((mode) => {
      transportMode = mode
      // The event socket connects inside detectWebTransport — and only for
      // an authenticated answer — so nothing to do for 'web' here.
      return mode
    })
  }
  return detectionPromise
}

/** Resolves once the transport is known: 'wails' | 'web' | 'none'. */
export function transportDetection(): Promise<TransportMode> {
  return ensureTransportDetection()
}

/** Synchronous snapshot of the transport resolution ('pending' while the
 *  web-transport probe is in flight). The login gate consumes this to avoid
 *  mounting the app before `getApp()` can answer: on the web transport the
 *  probe is an async round trip, and a mount-time RPC that beats it would
 *  throw "Wails App bindings are not available" — killing App.tsx's one-shot
 *  startup safety nets and stranding the UI on the splash forever. Desktop
 *  windows resolve 'wails' synchronously (bindings are injected before the
 *  bundle runs) and never wait. */
export function transportSnapshot(): TransportMode | 'pending' {
  return transportMode
}

/** True when this page talks to the backend over the web-access sidecar.
 *
 *  Synchronous and conservative: false until the probe settles, so callers
 *  gating desktop-only affordances never take the web branch early. By the
 *  time the UI is interactive (the first `backend:ready` event) the probe
 *  has long settled. */
export function isWebTransport(): boolean {
  return transportMode === 'web'
}

// --- Web transport: login gating ----------------------------------------------
//
// The sidecar authenticates by an HttpOnly session cookie exchanged for the
// per-launch token (POST /api/login). A fresh browser tab has no cookie, so
// every RPC would 401 and the events websocket would refuse the upgrade —
// the SPA must show the token gate INSTEAD of booting into that. Two signals
// feed the gate: the bootstrap probe's `authenticated` field (resolved once
// per page load) and a live 401 from any RPC (the app restarted and minted a
// new per-launch secret under an already-open tab).

/** Resolves once the transport probe settled: true when this page is served
 *  by the web-access sidecar WITHOUT a valid session — the token gate must
 *  take over. False for every other transport and for an authenticated tab. */
export async function webAuthRequired(): Promise<boolean> {
  const mode = await ensureTransportDetection()
  return mode === 'web' && webAuthed !== true
}

const webAuthRequiredListeners = new Set<() => void>()

/** Subscribe to the mid-session 401 signal (expired/rotated session cookie).
 *  Returns an unsubscribe function. Listeners never throw into the RPC path. */
export function onWebAuthRequired(callback: () => void): () => void {
  webAuthRequiredListeners.add(callback)
  return () => {
    webAuthRequiredListeners.delete(callback)
  }
}

function notifyWebAuthRequired(): void {
  for (const callback of Array.from(webAuthRequiredListeners)) {
    try {
      callback()
    } catch (err) {
      logger.warn('[auth] web-auth listener threw', err)
    }
  }
}

declare global {
  interface Window {
    go: {
      desktop: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        App: Record<string, (...args: any[]) => Promise<any>>
      }
    }
    runtime: {
      EventsOn(eventName: string, callback: (...data: unknown[]) => void): () => void
      EventsEmit(eventName: string, ...data: unknown[]): void
      ClipboardSetText(text: string): Promise<boolean>
      BrowserOpenURL(url: string): void
      WindowSetTitle(title: string): void
      LogError(message: string): void
    }
  }
}

/** Check if the Wails runtime is available */
export function isWailsReady(): boolean {
  return typeof window !== 'undefined' && !!window.runtime && !!window.go?.desktop?.App
}

/** Check if the raw Wails runtime surface exists (possibly pre-bindings).
 *
 *  Broader than `isWailsReady`: true as soon as `window.runtime` is injected,
 *  even before the generated App bindings are. Callers use it to defer work
 *  until `backend:ready` fires instead of probing `window.runtime` directly —
 *  window access lives in this module only. */
export function hasWailsRuntime(): boolean {
  return typeof window !== 'undefined' && !!window.runtime
}

/** Get the Wails runtime; throws if not ready */
export function getRuntime(): {
  EventsOn(eventName: string, callback: (...data: unknown[]) => void): () => void
  EventsEmit(eventName: string, ...data: unknown[]): void
  ClipboardSetText(text: string): Promise<boolean>
  BrowserOpenURL(url: string): void
  WindowSetTitle(title: string): void
  LogError(message: string): void
} {
  if (typeof window === 'undefined' || !window.runtime) {
    throw new Error('Wails runtime is not available')
  }
  return window.runtime
}

/**
 * Get the desktop App RPC proxy; throws if no transport can serve RPCs.
 * In the desktop transport this is the Wails-generated bindings object; in
 * the web transport it is an equivalent Proxy dispatching every method to
 * the sidecar (see below). Returns `any` because neither surface is static:
 * Wails generates method bindings dynamically at build time and the web
 * proxy mirrors whatever the backend reflection dispatcher exposes.
 * Each API module (api/*.ts) wraps calls with runtime validation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getApp(): any {
  if (typeof window !== 'undefined' && window.go?.desktop?.App) {
    return window.go.desktop.App
  }
  if (transportMode === 'web') return getWebApp()
  throw new Error('Wails App bindings are not available')
}

// --- Web transport: RPC over the sidecar --------------------------------------
//
// The browser calls the SAME FrontendAPI surface the Wails bindings call:
// POST /api/rpc/<Method> carries the positional arguments as a JSON array and
// answers with the JSON result — or `{error}` with a non-200 status, the
// uniform envelope internal/webaccess documents ("the browser shim rejects
// its Promise with the `error` string"). Return conventions mirror Wails:
// () → null, (T) → T, (T, error) → T, multi-value → array.

/** One stable function per method name — `getApp().Foo === getApp().Foo`. */
const webAppMethods = new Map<string, (...args: unknown[]) => Promise<unknown>>()

/**
 * Shared bound for the web-sidecar fetches (transport probe, RPC, login): a
 * sidecar that accepts TCP but stalls must not hold a call — or the boot
 * barrier — pending until the browser stack's own long timeout. Generous
 * enough for a full 32 MiB attachment upload on a normal link; the desktop
 * Wails transport stays unbounded (behavior parity).
 */
export const WEB_FETCH_TIMEOUT_MS = 15_000

/** Abort signal bounding a web-sidecar fetch, or undefined on engines without
 *  `AbortSignal.timeout` (the hardening is best-effort there, like the
 *  desktop transport's absence of any bound). */
export function webFetchTimeoutSignal(): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

function getWebApp(): unknown {
  const target: Record<string, never> = {}
  return new Proxy(target, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      let fn = webAppMethods.get(prop)
      if (!fn) {
        fn = (...args: unknown[]) => webRpc(prop, args)
        webAppMethods.set(prop, fn)
      }
      return fn
    },
  })
}

/** Dispatch one RPC over the sidecar's reflection endpoint. */
async function webRpc(method: string, args: unknown[]): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`/api/rpc/${encodeURIComponent(method)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: webFetchTimeoutSignal(),
    })
  } catch (err) {
    logger.warn(`[rpc] ${method} transport error`, err)
    throw new Error(`RPC ${method} failed: transport unreachable`)
  }
  const text = await res.text()
  let payload: unknown
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
  }
  if (!res.ok) {
    if (res.status === 401) {
      // The session cookie is missing or no longer valid (fresh tab, or the
      // app restarted and minted a new per-launch secret). The login gate
      // listens for this and takes over the screen; the caller still sees
      // the rejection below — handlers keep their existing error paths.
      notifyWebAuthRequired()
    }
    const msg =
      typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `RPC ${method} failed with status ${res.status}`
    throw new Error(msg)
  }
  return payload
}

/**
 * Wails event name under which the backend delivers BATCHED frontend events.
 * MUST match eventBatchEventName in desktop/event_batcher.go. The desktop layer
 * coalesces transient streaming events and drains the rest as one envelope per
 * ~16ms flush, so the AppKit main thread performs one evaluateJavaScript call
 * per flush instead of one per event. The payload is a BatchEnvelope:
 * `{events: [{name, args}, ...]}`.
 */
export const EVENT_BATCH_NAME = 'c0wrk:events:batch'

interface BatchEnvelopeEntry {
  name: string
  args?: unknown[]
}

interface BatchEnvelope {
  events?: BatchEnvelopeEntry[]
}

/**
 * Per-event callback registry. Every `subscribe` callback is registered here so
 * an event arriving inside a batch envelope can be fanned out to the exact same
 * handlers — preserving per-event semantics (order, payload, null filtering)
 * while collapsing the transport to one call per flush.
 */
const batchListeners = new Map<string, Set<(...data: unknown[]) => void>>()
let batchListenerInstalled = false

function dispatchBatchedEvent(name: string, args: unknown[]): void {
  const handlers = batchListeners.get(name)
  if (!handlers || handlers.size === 0) return
  // Snapshot: a handler may unsubscribe (session switch) during iteration.
  for (const handler of Array.from(handlers)) {
    try {
      handler(...args)
    } catch (err) {
      logger.warn(`[events] handler for batched event "${name}" threw`, err)
    }
  }
}

/**
 * Unwrap one batch envelope into the per-event fan-out. Shared by BOTH
 * transports: the desktop envelope listener (below) and the web websocket
 * router (below) normalize their wire envelopes into this single path, so
 * per-event semantics (order, payload, null filtering) are transport-agnostic.
 */
function dispatchEnvelope(envelope: unknown): void {
  const env = envelope as BatchEnvelope | undefined
  if (!env || !Array.isArray(env.events)) {
    logger.warn('[events] dropped malformed batch envelope', envelope)
    return
  }
  for (const entry of env.events) {
    if (!entry || typeof entry.name !== 'string') continue
    dispatchBatchedEvent(entry.name, entry.args ?? [])
  }
}

/** Install the single envelope listener the first time anything subscribes. */
function installBatchListener(): void {
  if (batchListenerInstalled) return
  if (typeof window === 'undefined' || !window.runtime) return
  batchListenerInstalled = true
  window.runtime.EventsOn(EVENT_BATCH_NAME, (...data: unknown[]) => {
    dispatchEnvelope(data[0])
  })
}

// --- Web transport: events over the sidecar websocket --------------------------
//
// The sidecar fans the desktop eventTap out to every connected client — there
// is no per-client subscription state, so a reconnect simply re-attaches to
// the firehose and this module's fan-out registry (batchListeners) survives
// untouched. Frames are `{name, args}` envelopes:
//   - a batched flush arrives as {name: EVENT_BATCH_NAME,
//     args: [{events: [{name, args}, ...]}]} and unwraps through
//     dispatchEnvelope — the exact path the desktop envelope listener uses;
//   - an individually-emitted event arrives as {name, args} and dispatches
//     directly through dispatchBatchedEvent.

const WS_RECONNECT_BASE_MS = 500
const WS_RECONNECT_MAX_MS = 30_000

let ws: WebSocket | null = null
let wsAttempts = 0
let wsEmitDropWarned = false

/**
 * Client-side staleness watchdog: neither side currently keeps the events
 * socket alive (the server defers its ping stage), so a half-open socket —
 * laptop sleep, NAT rebinding — never fires `onclose`: no reconnect, no
 * resync, every emit dropped warn-once until a manual reload. Track the last
 * inbound frame; an idle gap past this threshold means the socket is assumed
 * dead and is force-closed locally, and the existing onclose → backoff →
 * reconnect path re-establishes the stream and fires the reconnect resync.
 * Every inbound frame re-arms the watchdog, so steady traffic never churns
 * the socket; a healthy-but-silent one is recycled at most once per window,
 * and the resync loaders are idempotent by contract.
 */
const WS_IDLE_RECONNECT_MS = 5 * 60_000

let wsIdleTimer: ReturnType<typeof setTimeout> | null = null

function armWSIdleWatchdog(): void {
  if (wsIdleTimer !== null) clearTimeout(wsIdleTimer)
  const sock = ws
  if (sock === null) return
  wsIdleTimer = setTimeout(() => {
    wsIdleTimer = null
    if (ws !== sock) return
    logger.warn(
      `[events] websocket idle past ${Math.round(WS_IDLE_RECONNECT_MS / 60_000)}m with no inbound frames — forcing close to reconnect`,
    )
    sock.close()
  }, WS_IDLE_RECONNECT_MS)
}

function clearWSIdleWatchdog(): void {
  if (wsIdleTimer !== null) {
    clearTimeout(wsIdleTimer)
    wsIdleTimer = null
  }
}

/** Cancel the idle watchdog's pending timer. The web transport never tears
 *  down in production (the socket lives for the page), so this exists for
 *  teardown paths — public for tests, like the sessions store's
 *  cancelPendingRefresh: a module instance discarded between tests must not
 *  fire into a stale socket. */
export function cancelWSIdleWatchdog(): void {
  clearWSIdleWatchdog()
}

/** Re-connect subscribers (see onWSReconnected). */
const wsReconnectListeners = new Set<() => void>()

/**
 * Subscribe to a websocket RE-connect: a successful `onopen` that follows at
 * least one failed/closed attempt — never the socket's first open of the page
 * load. The web transport keeps no replay queue, so every event emitted while
 * the stream was down is gone; this signal lets consumers re-read the state
 * the missed events carried (see useShallowResync). Never fires on the
 * desktop transport (no websocket there). Returns an unsubscribe function;
 * listeners never throw into the socket's event path.
 */
export function onWSReconnected(callback: () => void): () => void {
  wsReconnectListeners.add(callback)
  return () => {
    wsReconnectListeners.delete(callback)
  }
}

function notifyWSReconnected(): void {
  for (const callback of Array.from(wsReconnectListeners)) {
    try {
      callback()
    } catch (err) {
      logger.warn('[events] ws-reconnect listener threw', err)
    }
  }
}

function connectWS(): void {
  if (ws || typeof WebSocket !== 'function' || typeof location === 'undefined') return
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  let sock: WebSocket
  try {
    sock = new WebSocket(`${scheme}//${location.host}${webWsPath}`)
  } catch (err) {
    // Construction only fails on an invalid URL — the advertised ws path is
    // broken; retrying cannot fix a static path, so do not loop.
    logger.warn('[events] websocket construction failed', err)
    return
  }
  ws = sock
  sock.onopen = () => {
    // An open that follows at least one failed/closed attempt is a
    // RE-connect: events emitted during the outage are lost, so resync
    // subscribers re-read state. The page load's first open is not one —
    // the initial loads own their state. Read the flag BEFORE the reset.
    const reconnected = wsAttempts > 0
    wsAttempts = 0
    wsEmitDropWarned = false
    // The open itself is inbound liveness: start the staleness clock.
    armWSIdleWatchdog()
    if (reconnected) notifyWSReconnected()
  }
  sock.onmessage = (ev: MessageEvent) => handleWSFrame(ev.data)
  sock.onclose = () => {
    if (ws !== sock) return
    // No socket to watch — the reconnect timer below owns the next attempt,
    // and its success re-arms the watchdog via onopen.
    clearWSIdleWatchdog()
    ws = null
    scheduleWSReconnect()
  }
}

/** Exponential backoff, reset by every successful open. Deterministic (no
 *  jitter) so tests can pin the exact schedule on virtual time. */
function scheduleWSReconnect(): void {
  const delay = Math.min(WS_RECONNECT_BASE_MS * 2 ** wsAttempts, WS_RECONNECT_MAX_MS)
  wsAttempts++
  setTimeout(() => {
    if (ws === null) connectWS()
  }, delay)
}

/** Normalize one WS frame into the dispatchBatchedEvent fan-out. */
function handleWSFrame(raw: unknown): void {
  // Any inbound frame — even a malformed one — is proof of liveness: re-arm
  // the staleness watchdog before anything else.
  armWSIdleWatchdog()
  let msg: unknown
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : String(raw))
  } catch {
    logger.warn('[events] dropped malformed websocket frame (not JSON)', raw)
    return
  }
  if (typeof msg !== 'object' || msg === null || typeof (msg as { name?: unknown }).name !== 'string') {
    logger.warn('[events] dropped malformed websocket frame (no event name)', msg)
    return
  }
  const { name } = msg as { name: string }
  const rawArgs = (msg as { args?: unknown }).args
  const args = Array.isArray(rawArgs) ? rawArgs : []
  if (name === EVENT_BATCH_NAME) {
    dispatchEnvelope(args[0])
    return
  }
  dispatchBatchedEvent(name, args)
}

/** Send a UI→backend event over the websocket as a `{name, args}` frame —
 *  the symmetric shape of the server→client envelope. */
function webEmit(eventName: string, data?: unknown): void {
  const frame = JSON.stringify({ name: eventName, args: data !== undefined ? [data] : [] })
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(frame)
    return
  }
  // Not connected (bootstrapping or mid-reconnect): drop. The sidecar keeps
  // no inbound queue, so a buffered frame would arrive arbitrarily late;
  // warn once per outage instead of once per drop.
  if (!wsEmitDropWarned) {
    wsEmitDropWarned = true
    logger.warn(`[events] dropped "${eventName}" — websocket not connected`)
  }
}

/** Subscribe to a backend event; returns an unsubscribe function. */
export function subscribe(eventName: string, callback: (...data: unknown[]) => void): () => void {
  // Register in the fan-out registry FIRST: it is the one dispatch path that
  // exists in every transport (the desktop envelope listener and the web
  // websocket router both fan out through it), so a subscription made while
  // the transport probe is still in flight starts receiving as soon as the
  // events flow, in either mode.
  let handlers = batchListeners.get(eventName)
  if (!handlers) {
    handlers = new Set()
    batchListeners.set(eventName, handlers)
  }
  handlers.add(callback)

  if (transportMode === 'web') {
    // The websocket router delivers everything — batched flushes and
    // individually-emitted events alike — and there is no Wails runtime to
    // register with. The registry entry above is the whole subscription.
    return () => {
      handlers?.delete(callback)
    }
  }

  if (typeof window === 'undefined' || !window.runtime) {
    // No-op unsubscribe so hooks can subscribe unconditionally without
    // throwing in environments where the Wails runtime is absent (vitest, SSR).
    // The registry entry stays: harmless when nothing dispatches ('none'),
    // correct when the probe later settles 'web'.
    return () => {
      handlers?.delete(callback)
    }
  }
  const rt = getRuntime()

  // Make sure the single envelope listener exists.
  installBatchListener()

  // Also register directly with the Wails runtime: individually-emitted events
  // (every non-batched global event) still reach the callback. Batched session
  // events are never emitted individually, so a callback fires exactly once per
  // event — never twice.
  const unsubscribeDirect = rt.EventsOn(eventName, callback)
  return () => {
    handlers?.delete(callback)
    unsubscribeDirect()
  }
}

/** Emit a backend event (UI→backend direction).
 *
 *  A silent no-op when no serving transport exists ('none', or the probe is
 *  still 'pending' without a Wails runtime), mirroring the sibling
 *  best-effort helpers (`logError`, `setWindowTitle`): every caller fires
 *  this from unguarded paths (error toasts, feedback flashes), so a throw
 *  would only become an unhandled rejection. */
export function emit(eventName: string, data?: unknown): void {
  if (transportMode === 'web') {
    // UI-originated runtime_error stays LOCAL: the inbound whitelist is a
    // backend→frontend-only authorization (the seven HITL responses) and
    // drops this name at Debug, and the backend neither listens for it nor
    // re-emits it — a wire frame would be silently discarded and the error
    // toast would never fire in a browser tab. Dispatch into the local
    // listener registry instead — the same replay approach the web
    // notification click uses (emitLocalEvent) — so the desktop's Wails-bus
    // round-trip semantics (page-local toast) hold in both transports.
    if (eventName === 'runtime_error') {
      emitLocalEvent(eventName, data)
      return
    }
    webEmit(eventName, data)
    return
  }
  if (typeof window === 'undefined' || !window.runtime) return
  const rt = getRuntime()
  if (data !== undefined) {
    rt.EventsEmit(eventName, data)
  } else {
    rt.EventsEmit(eventName)
  }
}

/** Synthesize one backend-shaped event into the LOCAL listener registry —
 *  without touching any transport (nothing is sent to the backend).
 *
 *  This is the web notification click's bridge: a browser Notification
 *  activation replays the same `notification_clicked` event the Go callback
 *  emits on the desktop (desktop/notifications.go), so the downstream path —
 *  the `isNotificationClickedData` guard and useNotificationClicks'
 *  navigation — is byte-identical in both transports instead of growing a
 *  second, web-only routing entry point. */
export function emitLocalEvent(eventName: string, data?: unknown): void {
  dispatchBatchedEvent(eventName, data !== undefined ? [data] : [])
}

/** Copy text to the system clipboard via the native Wails runtime.
 *
 *  Use this INSTEAD of `navigator.clipboard.writeText`. The Web Clipboard API
 *  is unreliable inside the Wails webview: `navigator.clipboard` is `undefined`
 *  in production builds (the webview origin is not a secure context — see
 *  wailsapp/wails#1670) and, even when present, `writeText` rejects with
 *  `NotAllowedError` under WKWebView's strict transient-activation rules for
 *  clipboard writes triggered from context-menu item clicks. The native
 *  runtime writes through Go and is unaffected by those restrictions, so it
 *  works consistently for every entry. */
export async function clipboardSetText(text: string): Promise<boolean> {
  if (transportMode === 'web') {
    // Browser clipboard. The webview restrictions the native path exists to
    // dodge (non-secure origin, WKWebView transient activation) do not apply
    // to a normal browser page driven by a user gesture. Failure → false,
    // mirroring the Wails ClipboardSetText contract (never throws to callers).
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch (err) {
      logger.warn('[clipboard] write failed (web transport)', err)
    }
    // The async Clipboard API is missing (older browsers, insecure origins)
    // or refused the write — degrade to the legacy execCommand path instead
    // of reporting a bare failure.
    const copied = legacyClipboardCopy(text)
    if (!copied) logger.warn('[clipboard] legacy execCommand copy failed (web transport)')
    return copied
  }
  const rt = getRuntime()
  return rt.ClipboardSetText(text)
}

/** One legacy clipboard write via `document.execCommand('copy')`.
 *
 *  Fallback for contexts without a working `navigator.clipboard`: a hidden
 *  readonly `<textarea>` carrying the text is selected and the deprecated
 *  synchronous copy command is invoked. Best-effort by contract — reports
 *  `true` only when the command itself reported success, restores the user's
 *  selection and removes the node on every exit path, and never throws (a
 *  missing DOM or a failing command simply yields `false`; the caller logs). */
function legacyClipboardCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const selection = typeof document.getSelection === 'function' ? document.getSelection() : null
  const savedRanges: Range[] = []
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i += 1) {
      savedRanges.push(selection.getRangeAt(i).cloneRange())
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  // Rendered but invisible and inert: `display:none` would make the
  // programmatic selection a no-op on some engines, and the textarea must
  // stay out of the layout and the pointer's way.
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return document.execCommand('copy') === true
  } catch {
    return false
  } finally {
    try {
      textarea.remove()
      // Restore whatever the user had selected before the hidden textarea
      // stole the selection.
      if (selection) {
        selection.removeAllRanges()
        for (const range of savedRanges) selection.addRange(range)
      }
    } catch {
      // Best-effort restoration — never mask the copy result.
    }
  }
}

/** Set the native window title.
 *
 *  In the web transport the title IS the browser tab label: the same string
 *  is written to `document.title`, so `useWindowTitle`'s
 *  "c0wrk - Project: Session" template lands in the tab strip exactly as it
 *  lands in the desktop title bar.
 *
 *  Unlike the other wrappers here this one NO-OPS when the runtime is absent
 *  instead of throwing, mirroring `subscribe`: the title is a purely cosmetic
 *  side effect driven from a `useEffect`, and every hook test runs under
 *  jsdom without `window.runtime`. A throw would turn a decorative update
 *  into a render-time failure. */
export function setWindowTitle(title: string): void {
  if (transportMode === 'web') {
    if (typeof document !== 'undefined') document.title = title
    return
  }
  if (typeof window === 'undefined' || !window.runtime) return
  getRuntime().WindowSetTitle(title)
}

/** Forward a diagnostic message to the Go process log (`wails.log`).
 *
 *  Mirrors the Wails runtime's `LogError`, which routes through the Go
 *  `logger.Logger` wired into `wails.Run` (`Logger: wlog`, see main.go →
 *  desktop/wails_logger.go) and lands in a persistent `<logDir>/wails.log`.
 *  The webview console is NOT persisted in the packaged app (WebKitGTK writes
 *  no console output to disk), so a crash that only reaches `console.error`
 *  leaves no trace once the process exits — this is the channel that survives.
 *
 *  Unlike the RPC/runtime wrappers that throw, this NO-OPS when the runtime is
 *  absent (vitest, SSR), mirroring `setWindowTitle`: a diagnostics call made
 *  from an error path must never itself turn into a failure. */
export function logError(message: string): void {
  if (transportMode === 'web') {
    // A browser tab has no Go process log to reach — the persisted channel
    // here is the browser console (devtools).
    console.error(message)
    return
  }
  if (typeof window === 'undefined' || !window.runtime) return
  getRuntime().LogError(message)
}

/** Open a URL in the user's default system browser.
 *
 *  Use this INSTEAD of relying on `<a target="_blank">` navigation. The Wails
 *  webview has no concept of a "default browser": a plain anchor with
 *  `target="_blank"` is either silently ignored or opens inside the webview
 *  itself (which cannot render arbitrary web pages). The native runtime
 *  dispatches the URL to the OS — `open` on macOS, `xdg-open` on Linux, and
 *  the default protocol handler on Windows — so external links open in the
 *  system browser consistently across all three platforms. */
export function openExternalURL(url: string): void {
  if (transportMode === 'web') {
    // The sidecar cannot open OS browser windows from inside a tab; the
    // browser's own popup mechanism is the transport-correct equivalent.
    // noopener keeps the opened page from reaching back into this one.
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  const rt = getRuntime()
  rt.BrowserOpenURL(url)
}

/**
 * Subscribe to a typed session-scoped event.
 * Auto-prefixes with `session:${sessionId}:${event}`.
 * Returns an unsubscribe function.
 *
 * For events with non-void payloads, the callback receives the raw data
 * from the backend. Callers MUST validate with the matching `is*Data`
 * guard from `@/types/events` before accessing properties.
 * See useChatEvents.ts for the correct pattern.
 *
 * Null/undefined payloads are filtered at this boundary so handlers
 * don't need to guard against missing data from backend schema drift.
 */
export function onSessionEvent<K extends SessionEventKey>(
  sessionId: string,
  event: K,
  callback: (data: SessionEventMap[K] | undefined) => void,
): () => void {
  const eventName = `session:${sessionId}:${event}`
  return subscribe(eventName, (data: unknown) => {
    // Filter null/undefined payloads at the boundary to protect against
    // backend schema drift or malformed emissions.
    if (data === null || data === undefined) {
      callback(undefined)
      return
    }
    callback(data as SessionEventMap[K])
  })
}

/**
 * Subscribe to a typed global event (non-session-scoped).
 * Returns an unsubscribe function.
 *
 * For events with non-void payloads, the callback receives the raw data
 * from the backend. Callers MUST validate with the matching `is*` guard
 * from `@/types/events` before accessing properties.
 */
export function onGlobalEvent<K extends GlobalEventKey>(
  event: K,
  callback: (data: GlobalEventMap[K] | undefined) => void,
): () => void {
  return subscribe(event, (data: unknown) => {
    if (data === null || data === undefined) {
      callback(undefined)
      return
    }
    callback(data as GlobalEventMap[K])
  })
}

/** Confirm quitting the app despite active sessions (close guard).
 *
 * Counterpart to the global `app:exit_requested` event: the backend's
 * OnBeforeClose guard intercepts a quit while sessions have live work, emits
 * that event, and waits for the user's decision. This RPC arms the backend
 * exit-confirmed flag and re-issues the graceful quit so the normal Shutdown
 * sequence still runs. */
export async function confirmExit(): Promise<void> {
  const app = getApp()
  await app.ConfirmExit()
}

/** Kick off the web-transport probe once per page load. A Wails page resolved
 *  synchronously above (its bindings are injected before any bundle code
 *  runs), so the network ask only happens on a plain browser page; it settles
 *  'none' — silently — when no sidecar serves this origin. The promise never
 *  rejects, so the kick cannot turn into an unhandled rejection. Idempotent:
 *  ensureTransportDetection dedupes (settled modes short-circuit, in-flight
 *  probes share one promise), so a double call is safe.
 *
 *  Called once from main.tsx before the first render. The probe used to run
 *  as this module's import side effect — a documented deviation from the
 *  no-module-side-effects rule that also fired a network request on every
 *  test import. */
export function initRuntimeProbe(): void {
  void ensureTransportDetection()
}
