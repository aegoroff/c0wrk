// @vitest-environment jsdom
//
// Tests for the web transport in api/runtime.ts — the browser half of the
// web-access sidecar (ADR-090). The same frontend bundle, served over plain
// HTTP by internal/webaccess, must reach the identical FrontendAPI surface:
//   - detection resolves 'wails' | 'web' | 'none' (and 'wails' never asks
//     the network — the bindings are injected before any bundle code runs);
//   - RPCs round-trip through POST /api/rpc/<Method> with positional JSON
//     args and the uniform {error} failure envelope;
//   - events arrive over the websocket as {name, args} frames and normalize
//     into the same dispatchBatchedEvent fan-out the desktop uses;
//   - the websocket reconnects with exponential backoff (pinned on virtual
//     time, no jitter by design);
//   - the capability helpers degrade to their browser equivalents (clipboard
//     writes fall back to the legacy hidden-textarea execCommand path when
//     the async Clipboard API is missing or refuses the write).
// The desktop-transport regression coverage (batch envelope fan-out) lives in
// runtime.test.ts and must stay untouched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { logger } from '@/lib/logger'

// The malformed-frame tests below feed the transport garbage on purpose; the
// real logger would print "[events] dropped malformed …" warnings for each.
// That output is the expected behavior under test, not a regression — mock
// the logger to keep the suite output clean.
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

type RuntimeModule = typeof import('@/api/runtime')

interface FetchCall {
  url: string
  init?: RequestInit
}

/** Minimal stand-in for the browser WebSocket, driven from the "server" side. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  // Test-side helpers — the server's view of the connection.

  /** Client-side close — the transport's own close() call (the idle
   *  watchdog's forced recycle). */
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  serverClose(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  serverFrame(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

let fetchCalls: FetchCall[]
let fetchResponder: (url: string, init?: RequestInit) => Promise<Response>

function installFetch(): void {
  fetchCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const call = { url: String(url), init }
      fetchCalls.push(call)
      return await fetchResponder(call.url, call.init)
    }),
  )
}

function respondTransport(body: unknown, status = 200): void {
  fetchResponder = async (url) => {
    if (url === '/api/transport') return jsonResponse(body, status)
    throw new Error(`unexpected fetch ${url}`)
  }
}

function respondWebApp(handler: (method: string, body: unknown) => Promise<Response>): void {
  fetchResponder = async (url, init) => {
    if (url === '/api/transport') return jsonResponse({ transport: 'web', ws: '/ws', authenticated: true })
    if (url.startsWith('/api/rpc/')) {
      return await handler(url.slice('/api/rpc/'.length), JSON.parse(String(init?.body ?? '[]')) as unknown)
    }
    throw new Error(`unexpected fetch ${url}`)
  }
}

function installWailsGlobals(): void {
  ;(window as unknown as Record<string, unknown>).go = {
    desktop: { App: { Foo: async () => 'bar' } },
  }
  ;(window as unknown as Record<string, unknown>).runtime = {
    EventsOn: () => () => {},
    EventsEmit: () => {},
    ClipboardSetText: async (): Promise<boolean> => true,
    BrowserOpenURL: () => {},
    WindowSetTitle: () => {},
    LogError: () => {},
  }
}

async function freshRuntime(): Promise<RuntimeModule> {
  vi.resetModules()
  return await import('@/api/runtime')
}

let runtime: RuntimeModule

/** Import the module and wait until the transport probe has settled. The
 *  init is called explicitly — the probe no longer runs as an import side
 *  effect. */
async function bootedRuntime(): Promise<RuntimeModule> {
  const mod = await freshRuntime()
  mod.initRuntimeProbe()
  await mod.transportDetection()
  return mod
}

function webSocket(): FakeWebSocket {
  expect(FakeWebSocket.instances.length).toBe(1)
  const sock = FakeWebSocket.instances[0]
  if (!sock) throw new Error('no websocket instance was created')
  return sock
}

/** jsdom does not implement `document.execCommand` — the property does not
 *  even exist — so the legacy-copy tests install their own verdict stub.
 *  Cleanup happens in the top-level afterEach (the jsdom document is shared
 *  across the whole file). */
function installExecCommand(impl: () => boolean): ReturnType<typeof vi.fn> {
  const stub = vi.fn(impl)
  Object.defineProperty(document, 'execCommand', { value: stub, configurable: true, writable: true })
  return stub
}

let loggerWarn: ReturnType<typeof vi.fn>

beforeEach(async () => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  installFetch()
  // The default bootstrap answers authenticated:true — the connected-tab
  // case, where the transport also opens its event socket. Unauthenticated
  // probes must NOT open a socket (see the login-gating suite); the default
  // keeps the long-standing socket expectations meaningful.
  respondTransport({ transport: 'web', ws: '/ws', authenticated: true })
  loggerWarn = vi.mocked(logger.warn)
  loggerWarn.mockClear()
})

afterEach(() => {
  // Cancel the idle watchdog BEFORE the globals go away: suites that run on
  // real timers leave a pending recycle timer behind, and a module instance
  // discarded here must not fire into a stale socket later.
  runtime?.cancelWSIdleWatchdog()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete (window as unknown as Record<string, unknown>).go
  delete (window as unknown as Record<string, unknown>).runtime
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(document, 'execCommand')
})

describe('transport detection', () => {
  it("resolves 'wails' synchronously from the injected bindings and never asks the network", async () => {
    installWailsGlobals()
    runtime = await bootedRuntime()

    expect(runtime.isWebTransport()).toBe(false)
    expect(runtime.isWailsReady()).toBe(true)
    expect(runtime.getApp().Foo).toBeTypeOf('function')
    // The Wails state is decided without a single request.
    expect(fetchCalls).toHaveLength(0)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it("resolves 'wails' from a runtime without bindings (pre-bindings webview, test fakes)", async () => {
    delete (window as unknown as Record<string, unknown>).go
    ;(window as unknown as Record<string, unknown>).runtime = { EventsOn: () => () => {} }
    runtime = await bootedRuntime()

    expect(runtime.isWebTransport()).toBe(false)
    // Bindings still absent — the same error message as ever.
    expect(() => runtime.getApp()).toThrow('Wails App bindings are not available')
    expect(fetchCalls).toHaveLength(0)
  })

  it("resolves 'web' from the sidecar's bootstrap answer and connects the event socket", async () => {
    runtime = await bootedRuntime()

    expect(runtime.isWebTransport()).toBe(true)
    const sock = webSocket()
    expect(sock.url).toBe(`ws://${location.host}/ws`)
    expect(sock.readyState).toBe(FakeWebSocket.CONNECTING)
    // RPCs are answered by the reflection endpoint, not the bindings object.
    expect(() => runtime.getApp()).not.toThrow()
  })

  it("resolves 'none' when the origin does not answer (status >= 400)", async () => {
    respondTransport({ message: 'nope' }, 404)
    runtime = await bootedRuntime()

    expect(runtime.isWebTransport()).toBe(false)
    expect(() => runtime.getApp()).toThrow('Wails App bindings are not available')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it("resolves 'none' when the probe request itself fails", async () => {
    fetchResponder = async () => {
      throw new TypeError('Failed to parse URL')
    }
    runtime = await bootedRuntime()

    expect(runtime.isWebTransport()).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it("resolves 'none' on a malformed bootstrap answer", async () => {
    respondTransport({ transport: 'desktop', ws: 42 })
    runtime = await bootedRuntime()

    expect(runtime.isWebTransport()).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it("resolves 'none' without any fetch implementation (SSR-ish host)", async () => {
    vi.stubGlobal('fetch', undefined)
    runtime = await bootedRuntime()

    expect(runtime.isWebTransport()).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it('initRuntimeProbe is idempotent: a double call sends exactly one probe', async () => {
    runtime = await freshRuntime()
    runtime.initRuntimeProbe()
    runtime.initRuntimeProbe()
    expect(await runtime.transportDetection()).toBe('web')

    // The transport request went out once, no matter how often the kick ran.
    expect(fetchCalls.filter((c) => c.url === '/api/transport')).toHaveLength(1)
  })

  it('delivers events to a subscription made while the probe is still in flight', async () => {
    // Park the probe mid-flight: the page has neither Wails bit and the
    // bootstrap answer has not arrived yet.
    let resolveTransport!: (r: Response) => void
    fetchResponder = () =>
      new Promise<Response>((resolve) => {
        resolveTransport = resolve
      })
    runtime = await freshRuntime()
    runtime.initRuntimeProbe()
    expect(runtime.isWebTransport()).toBe(false) // conservative while pending

    const seen: unknown[] = []
    const unsubscribe = runtime.subscribe('backend:ready', (...data) => seen.push(data))

    resolveTransport(jsonResponse({ transport: 'web', ws: '/ws', authenticated: true }))
    expect(await runtime.transportDetection()).toBe('web')
    const sock = webSocket()

    sock.serverFrame({ name: 'backend:ready', args: [{ up: true }] })
    expect(seen).toEqual([[{ up: true }]])

    unsubscribe()
    sock.serverFrame({ name: 'backend:ready', args: [{ up: false }] })
    expect(seen).toEqual([[{ up: true }]])
  })
})

describe('web RPC round-trip', () => {
  beforeEach(async () => {
    runtime = await bootedRuntime()
  })

  it('sends positional JSON args and returns the JSON result', async () => {
    respondWebApp(async (method, body) => {
      expect(method).toBe('ListSessions')
      expect(body).toEqual(['p1', true])
      return jsonResponse([{ id: 's1' }])
    })
    const app = runtime.getApp()
    await expect(app.ListSessions('p1', true)).resolves.toEqual([{ id: 's1' }])

    const rpcCall = fetchCalls[1]
    expect(rpcCall?.url).toBe('/api/rpc/ListSessions')
    expect(rpcCall?.init?.method).toBe('POST')
    expect(rpcCall?.init?.body).toBe('["p1",true]')
  })

  it('sends [] for a zero-arg call and passes multi-value arrays through', async () => {
    respondWebApp(async (method, body) => {
      expect(body).toEqual([])
      if (method === 'Multi') return jsonResponse(['a', 2])
      return jsonResponse(null)
    })
    const app = runtime.getApp()
    await expect(app.Nothing()).resolves.toBeNull()
    await expect(app.Multi()).resolves.toEqual(['a', 2])
  })

  it('rejects with the error-envelope message', async () => {
    respondWebApp(async () => jsonResponse({ error: 'boom inside' }, 500))
    const app = runtime.getApp()
    await expect(app.ListSessions()).rejects.toThrow('boom inside')
  })

  it('rejects denylisted methods with the server reason verbatim', async () => {
    respondWebApp(async () =>
      jsonResponse(
        {
          error:
            'web clients consume events over /ws; injecting synthetic session events into the desktop event bus is not exposed',
        },
        403,
      ),
    )
    const app = runtime.getApp()
    await expect(app.EmitSessionEvent()).rejects.toThrow(/not exposed/)
  })

  it('rejects with a status fallback when the failure body is not the envelope', async () => {
    respondWebApp(async () =>
      ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' }) as unknown as Response,
    )
    const app = runtime.getApp()
    await expect(app.ListSessions()).rejects.toThrow(/502/)
  })

  it('rejects with a transport error when fetch itself fails', async () => {
    fetchResponder = async (url) => {
      if (url === '/api/transport') return jsonResponse({ transport: 'web', ws: '/ws', authenticated: true })
      throw new TypeError('network died')
    }
    const app = runtime.getApp()
    await expect(app.ListSessions()).rejects.toThrow(/transport unreachable/)
  })

  it('returns one stable function per method name', () => {
    const app = runtime.getApp()
    expect(app.ListSessions).toBe(app.ListSessions)
    expect(app.ListSessions).not.toBe(app.ListProjects)
  })
})

describe('web events over the websocket', () => {
  beforeEach(async () => {
    runtime = await bootedRuntime()
  })

  it('fans a batched frame out to per-event subscribers in order', () => {
    const sock = webSocket()
    const received: string[] = []
    runtime.onSessionEvent('s1', 'assistant_chunk', (d) => {
      received.push(`chunk:${(d as { accumulated_content?: string } | undefined)?.accumulated_content}`)
    })
    runtime.onSessionEvent('s1', 'assistant_done', (d) => {
      received.push(`done:${(d as { content?: string } | undefined)?.content}`)
    })

    sock.serverFrame({
      name: runtime.EVENT_BATCH_NAME,
      args: [
        {
          events: [
            { name: 'session:s1:assistant_chunk', args: [{ content: 'a', accumulated_content: 'a' }] },
            { name: 'session:s1:assistant_chunk', args: [{ content: 'b', accumulated_content: 'ab' }] },
            { name: 'session:s1:assistant_done', args: [{ content: 'ab' }] },
          ],
        },
      ],
    })

    expect(received).toEqual(['chunk:a', 'chunk:ab', 'done:ab'])
  })

  it('preserves the null-payload filter for batched session events', () => {
    const sock = webSocket()
    const seen: Array<unknown> = []
    runtime.onSessionEvent('s1', 'task_cancelled', (d) => seen.push(d))

    sock.serverFrame({
      name: runtime.EVENT_BATCH_NAME,
      args: [{ events: [{ name: 'session:s1:task_cancelled', args: [null] }] }],
    })
    sock.serverFrame({
      name: runtime.EVENT_BATCH_NAME,
      args: [{ events: [{ name: 'session:s1:task_cancelled', args: [] }] }],
    })

    expect(seen).toEqual([undefined, undefined])
  })

  it('delivers an individually-emitted event frame directly', () => {
    const sock = webSocket()
    const seen: unknown[] = []
    runtime.onGlobalEvent('backend:ready', (d) => seen.push(d))

    sock.serverFrame({ name: 'backend:ready', args: [{ up: true }] })
    expect(seen).toEqual([{ up: true }])
  })

  it('normalizes a missing/null args field into a zero-arg call', () => {
    const sock = webSocket()
    const calls: Array<unknown[]> = []
    runtime.subscribe('files:dropped', (...data) => calls.push(data))

    sock.serverFrame({ name: 'files:dropped', args: null })
    sock.serverFrame({ name: 'files:dropped' })

    expect(calls).toEqual([[], []])
  })

  it('drops malformed frames with a warning and never throws', () => {
    const sock = webSocket()
    const seen: unknown[] = []
    runtime.onGlobalEvent('backend:ready', (d) => seen.push(d))

    expect(() => sock.serverFrame('this is not json')).not.toThrow()
    expect(() => sock.serverFrame({ nope: 1 })).not.toThrow()
    expect(() => sock.serverFrame({ name: runtime.EVENT_BATCH_NAME, args: [{ garbage: true }] })).not.toThrow()

    expect(seen).toEqual([])
    expect(loggerWarn.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('stops delivering after unsubscribe', () => {
    const sock = webSocket()
    const seen: unknown[] = []
    const unsubscribe = runtime.onGlobalEvent('backend:ready', (d) => seen.push(d))

    sock.serverFrame({ name: 'backend:ready', args: [1] })
    unsubscribe()
    sock.serverFrame({ name: 'backend:ready', args: [2] })

    expect(seen).toEqual([1])
  })
})

describe('websocket reconnect (virtual time)', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    runtime = await bootedRuntime()
  })

  it('reconnects with exponential backoff and resets the schedule on success', () => {
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0]!.serverClose()
    vi.advanceTimersByTime(499)
    expect(FakeWebSocket.instances).toHaveLength(1) // first retry is due at 500ms
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)

    FakeWebSocket.instances[1]!.serverClose()
    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.instances).toHaveLength(2) // second retry is due at +1000ms
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(3)

    FakeWebSocket.instances[2]!.serverClose()
    vi.advanceTimersByTime(1999)
    expect(FakeWebSocket.instances).toHaveLength(3) // third retry is due at +2000ms
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(4)

    // A successful open resets the attempt counter: the next retry is 500ms,
    // not the 4000ms the un-reset sequence would be at.
    FakeWebSocket.instances[3]!.serverOpen()
    FakeWebSocket.instances[3]!.serverClose()
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(5)
  })

  it('re-attaches the event firehose after a reconnect (registry survives)', () => {
    const seen: unknown[] = []
    runtime.onGlobalEvent('backend:ready', (d) => seen.push(d))

    const first = webSocket()
    first.serverOpen()
    first.serverFrame({ name: 'backend:ready', args: ['before'] })
    first.serverClose()

    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    const second = FakeWebSocket.instances[1]!
    second.serverFrame({ name: 'backend:ready', args: ['after'] })

    expect(seen).toEqual(['before', 'after'])
  })

  it('caps the backoff at the maximum delay', () => {
    for (let i = 0; i < 7; i++) {
      FakeWebSocket.instances[i]!.serverClose()
      vi.advanceTimersByTime(30_000)
    }
    // After 6 attempts the schedule has hit the 30s cap; the 7th retry still
    // arrives within one capped window.
    expect(FakeWebSocket.instances).toHaveLength(8)
  })
})

describe('websocket idle watchdog (virtual time)', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    runtime = await bootedRuntime()
  })

  it('force-closes a socket idle past the threshold and reconnects with a resync', () => {
    const resyncs: number[] = []
    runtime.onWSReconnected(() => resyncs.push(1))

    const first = webSocket()
    first.serverOpen()
    vi.advanceTimersByTime(299_999)
    // One millisecond short of the idle window: the socket stays untouched.
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    // The watchdog assumed the half-open socket dead: a local close, the
    // warn-once record, and the existing backoff path takes over.
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('idle past 5m'))
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    // The recycle rode the reconnect path: the retry's open is a RE-connect
    // (the attempt counter is > 0), so the resync fired — events emitted
    // during the dead window are re-read by consumers.
    FakeWebSocket.instances[1]!.serverOpen()
    expect(resyncs).toEqual([1])
  })

  it('re-arms on every inbound frame: steady traffic never churns the socket', () => {
    const first = webSocket()
    first.serverOpen()
    // Ten minutes of regular traffic, one frame a minute: every frame
    // restarts the idle clock long before it expires.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(60_000)
      first.serverFrame({ name: 'backend:ready', args: [i] })
    }
    expect(FakeWebSocket.instances).toHaveLength(1)
    // The watchdog is still armed, not disarmed by the traffic: five idle
    // minutes after the last frame it recycles the socket as before.
    vi.advanceTimersByTime(300_000)
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('leaves a reconnecting transport alone — the backoff owns the down phase', () => {
    webSocket().serverClose()
    vi.advanceTimersByTime(10 * 60_000)
    // The retry fired (a fresh socket exists), but no idle recycle ran while
    // the transport was down: the warn record is absent.
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(loggerWarn).not.toHaveBeenCalledWith(expect.stringContaining('idle past'))
  })
})

describe('websocket re-connect notification', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    runtime = await bootedRuntime()
  })

  it('fires on a successful re-connect, not on the first open', () => {
    const fires: number[] = []
    runtime.onWSReconnected(() => fires.push(1))

    // The page-load's first open is not a re-connect.
    const first = webSocket()
    first.serverOpen()
    expect(fires).toEqual([])

    // The first open after an outage is.
    first.serverClose()
    vi.advanceTimersByTime(500)
    FakeWebSocket.instances[1]!.serverOpen()
    expect(fires).toEqual([1])

    // And a later outage → open pair fires again (the flag re-arms on close).
    FakeWebSocket.instances[1]!.serverClose()
    vi.advanceTimersByTime(500)
    FakeWebSocket.instances[2]!.serverOpen()
    expect(fires).toEqual([1, 1])
  })

  it('fires even when no connection was ever established before (first attempt failed)', () => {
    // Boundary of the wsAttempts>0 contract: the initial attempt never made
    // it to open (close while CONNECTING), so the successful retry is
    // technically the first open — but events were still lost during the
    // outage window, so the re-connect signal fires. A harmless over-trigger:
    // the resync loaders are idempotent.
    const fires: number[] = []
    runtime.onWSReconnected(() => fires.push(1))

    webSocket().serverClose() // initial attempt dies before opening
    vi.advanceTimersByTime(500)
    FakeWebSocket.instances[1]!.serverOpen()
    expect(fires).toEqual([1])
  })

  it('supports unsubscribe and isolates a throwing listener', () => {
    const seen: string[] = []
    const unsubscribe = runtime.onWSReconnected(() => seen.push('a'))
    runtime.onWSReconnected(() => {
      throw new Error('listener bug')
    })
    runtime.onWSReconnected(() => seen.push('b'))

    webSocket().serverClose()
    vi.advanceTimersByTime(500)
    FakeWebSocket.instances[1]!.serverOpen()

    // The throwing listener neither prevents the others nor escapes the
    // socket's event path (it surfaces as a warned, swallowed error).
    expect(seen).toEqual(['a', 'b'])
    expect(loggerWarn).toHaveBeenCalled()

    unsubscribe()
    FakeWebSocket.instances[1]!.serverClose()
    vi.advanceTimersByTime(500)
    FakeWebSocket.instances[2]!.serverOpen()
    // Only 'a' was unsubscribed: it stops, 'b' keeps receiving.
    expect(seen).toEqual(['a', 'b', 'b'])
  })
})

describe('web capability helpers', () => {
  beforeEach(async () => {
    runtime = await bootedRuntime()
  })

  it('clipboardSetText writes through navigator.clipboard and reports success', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const execCommand = installExecCommand(() => true)
    await expect(runtime.clipboardSetText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    // The async API succeeded — the legacy fallback must stay untouched and
    // leave no staging node behind.
    expect(execCommand).not.toHaveBeenCalled()
    expect(document.body.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('clipboardSetText falls back to the hidden-textarea execCommand path when navigator.clipboard is missing', async () => {
    Reflect.deleteProperty(navigator, 'clipboard')
    const during: HTMLTextAreaElement[] = []
    const execCommand = installExecCommand(() => {
      const el = document.body.querySelector<HTMLTextAreaElement>('textarea')
      if (el) during.push(el)
      return true
    })
    await expect(runtime.clipboardSetText('legacy text')).resolves.toBe(true)

    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(during).toHaveLength(1)
    const staged = during[0]
    if (!staged) throw new Error('no staging textarea existed during the copy')
    // The staging node carries the text, is readonly, and is invisible and
    // inert (fixed-position, zero opacity, no pointer events).
    expect(staged.value).toBe('legacy text')
    expect(staged.readOnly).toBe(true)
    expect(staged.style.position).toBe('fixed')
    expect(staged.style.opacity).toBe('0')
    expect(staged.style.pointerEvents).toBe('none')
    // The staging node is removed again afterwards.
    expect(document.body.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('clipboardSetText reports the execCommand verdict — false when the legacy copy fails', async () => {
    Reflect.deleteProperty(navigator, 'clipboard')
    installExecCommand(() => false)
    await expect(runtime.clipboardSetText('x')).resolves.toBe(false)
    expect(loggerWarn).toHaveBeenCalledWith('[clipboard] legacy execCommand copy failed (web transport)')
    expect(document.body.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('clipboardSetText falls back when writeText rejects, preserving the write-failure warning', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
      configurable: true,
    })
    const execCommand = installExecCommand(() => true)
    await expect(runtime.clipboardSetText('denied-then-legacy')).resolves.toBe(true)

    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(loggerWarn).toHaveBeenCalledWith('[clipboard] write failed (web transport)', expect.anything())
    expect(document.body.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('clipboardSetText restores the user selection after a legacy copy', async () => {
    Reflect.deleteProperty(navigator, 'clipboard')
    installExecCommand(() => true)
    const target = document.createElement('div')
    target.textContent = 'user selected text'
    document.body.appendChild(target)
    const selection = document.getSelection()
    if (!selection) throw new Error('jsdom selection unavailable')
    const range = document.createRange()
    range.selectNodeContents(target)
    selection.removeAllRanges()
    selection.addRange(range)

    try {
      await expect(runtime.clipboardSetText('x')).resolves.toBe(true)
      // The hidden textarea stole the selection mid-copy; the user's range is
      // back afterwards.
      expect(selection.rangeCount).toBe(1)
      expect(selection.toString()).toBe('user selected text')
    } finally {
      selection.removeAllRanges()
      target.remove()
    }
  })

  it('clipboardSetText reports false without a document — there is no fallback surface', async () => {
    Reflect.deleteProperty(navigator, 'clipboard')
    vi.stubGlobal('document', undefined)
    await expect(runtime.clipboardSetText('x')).resolves.toBe(false)
    expect(loggerWarn).toHaveBeenCalledWith('[clipboard] legacy execCommand copy failed (web transport)')
  })

  it('clipboardSetText never throws — execCommand failures resolve to false', async () => {
    Reflect.deleteProperty(navigator, 'clipboard')
    installExecCommand(() => {
      throw new Error('execCommand exploded')
    })
    await expect(runtime.clipboardSetText('x')).resolves.toBe(false)
    expect(document.body.querySelectorAll('textarea')).toHaveLength(0)
    expect(loggerWarn).toHaveBeenCalledWith('[clipboard] legacy execCommand copy failed (web transport)')
  })

  it('clipboardSetText never throws — a synchronously-throwing writeText degrades to the fallback', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: () => {
          throw new TypeError('sync throw')
        },
      },
      configurable: true,
    })
    const execCommand = installExecCommand(() => true)
    await expect(runtime.clipboardSetText('x')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledTimes(1)
  })

  it('openExternalURL opens a new browser tab with noopener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    runtime.openExternalURL('https://example.com')
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
  })

  it('setWindowTitle mirrors the title into document.title', () => {
    // The browser tab strip is the web transport's title bar: the same
    // "c0wrk - Project: Session" template lands in the tab label.
    runtime.setWindowTitle('c0wrk - MyProject: Refactor auth')
    expect(document.title).toBe('c0wrk - MyProject: Refactor auth')
  })

  it('logError lands in the browser console', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    runtime.logError('crash diagnostics')
    expect(error).toHaveBeenCalledWith('crash diagnostics')
  })

  it('emit sends a {name, args} frame once the socket is open and warns-once while not', () => {
    const sock = webSocket()
    runtime.emit('tool_judge_request', { confirm_id: 'c1' })
    expect(sock.sent).toHaveLength(0)
    expect(loggerWarn).toHaveBeenCalledTimes(1) // warn-once per outage
    runtime.emit('tool_judge_request', { confirm_id: 'c2' })
    expect(loggerWarn).toHaveBeenCalledTimes(1)

    sock.serverOpen()
    runtime.emit('tool_judge_request', { confirm_id: 'c3' })
    runtime.emit('session:ping')
    expect(sock.sent).toEqual([
      JSON.stringify({ name: 'tool_judge_request', args: [{ confirm_id: 'c3' }] }),
      JSON.stringify({ name: 'session:ping', args: [] }),
    ])

    // A fresh outage warns again (the flag reset on open).
    sock.serverClose()
    runtime.emit('tool_judge_request', { confirm_id: 'c4' })
    expect(loggerWarn).toHaveBeenCalledTimes(2)
  })

  it('emit routes runtime_error LOCALLY in the web transport — never over the wire', () => {
    const sock = webSocket()
    const seen: unknown[] = []
    const unsubscribe = runtime.subscribe('runtime_error', (...args: unknown[]) => seen.push(args))

    // Closed socket: the error-toast path must still work — UI-originated
    // errors fire exactly when the transport is unhappy, and the inbound
    // whitelist would drop the name server-side anyway.
    runtime.emit('runtime_error', { id: 'e1', message: 'x' })
    expect(seen).toEqual([[{ id: 'e1', message: 'x' }]])
    expect(sock.sent).toHaveLength(0)
    expect(loggerWarn).not.toHaveBeenCalled()

    // Open socket: still local, still no frame.
    sock.serverOpen()
    runtime.emit('runtime_error', { id: 'e2', message: 'y' })
    expect(seen).toEqual([[{ id: 'e1', message: 'x' }], [{ id: 'e2', message: 'y' }]])
    expect(sock.sent).toHaveLength(0)

    unsubscribe()
    runtime.emit('runtime_error', { id: 'e3' })
    expect(seen).toHaveLength(2)
  })
})

describe('desktop transport stays on the Wails runtime', () => {
  beforeEach(async () => {
    installWailsGlobals()
    runtime = await bootedRuntime()
  })

  it('subscribe registers directly with the Wails runtime', () => {
    const handlers = new Map<string, Set<(...data: unknown[]) => void>>()
    ;(window as unknown as Record<string, unknown>).runtime = {
      EventsOn: (name: string, cb: (...data: unknown[]) => void) => {
        let set = handlers.get(name)
        if (!set) {
          set = new Set()
          handlers.set(name, set)
        }
        set.add(cb)
        return () => {
          handlers.get(name)?.delete(cb)
        }
      },
    }

    const seen: unknown[] = []
    runtime.subscribe('backend:ready', (d) => seen.push(d))
    expect(handlers.get('backend:ready')?.size).toBe(1)
    for (const cb of Array.from(handlers.get('backend:ready')!)) cb()
    expect(seen).toHaveLength(1)
  })

  it('the capability helpers route through the Wails runtime', async () => {
    const calls: string[] = []
    ;(window as unknown as Record<string, unknown>).runtime = {
      EventsOn: () => () => {},
      EventsEmit: (name: string) => calls.push(`emit:${name}`),
      ClipboardSetText: async () => {
        calls.push('clipboard')
        return true
      },
      BrowserOpenURL: (url: string) => calls.push(`open:${url}`),
      WindowSetTitle: (t: string) => calls.push(`title:${t}`),
      LogError: (m: string) => calls.push(`log:${m}`),
    }

    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await runtime.clipboardSetText('x')
    runtime.emit('runtime_error', {})
    runtime.openExternalURL('https://example.com')
    runtime.setWindowTitle('t')
    runtime.logError('m')

    expect(calls).toEqual(['clipboard', 'emit:runtime_error', 'open:https://example.com', 'title:t', 'log:m'])
    expect(open).not.toHaveBeenCalled()
  })

  it('emit is a silent no-op when no runtime is available (mirrors the sibling best-effort helpers)', () => {
    // Error-toast and feedback callers fire emit from unguarded paths; a
    // throw here would surface as an unhandled rejection, so the contract is
    // the logError/setWindowTitle one: drop, never throw.
    delete (window as unknown as Record<string, unknown>).runtime

    expect(() => runtime.emit('runtime_error', { id: 'e1', message: 'x' })).not.toThrow()
    expect(() => runtime.emit('session:ping')).not.toThrow()
  })
})

describe('web transport login gating', () => {
  it('reports no gate when the probe answers authenticated:true', async () => {
    respondTransport({ transport: 'web', ws: '/ws', authenticated: true })
    runtime = await freshRuntime()
    await expect(runtime.webAuthRequired()).resolves.toBe(false)
  })

  it('gates a fresh tab: the field is absent or explicitly false', async () => {
    respondTransport({ transport: 'web', ws: '/ws' })
    runtime = await freshRuntime()
    await expect(runtime.webAuthRequired()).resolves.toBe(true)

    respondTransport({ transport: 'web', ws: '/ws', authenticated: false })
    runtime = await freshRuntime()
    await expect(runtime.webAuthRequired()).resolves.toBe(true)
  })

  it('does not open the event socket for an unauthenticated tab', async () => {
    // A pre-auth upgrade attempt can only 401-loop against the sidecar;
    // login reloads the page, so the post-auth probe reconnects instead.
    respondTransport({ transport: 'web', ws: '/ws', authenticated: false })
    runtime = await bootedRuntime()

    expect(runtime.isWebTransport()).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('exposes the synchronous transport snapshot while the probe is in flight', async () => {
    let resolveTransport!: (r: Response) => void
    fetchResponder = () =>
      new Promise<Response>((resolve) => {
        resolveTransport = resolve
      })
    runtime = await freshRuntime()
    runtime.initRuntimeProbe()
    // The gate consumes this synchronously: the app must not mount while
    // the transport is unresolved (a mount-time RPC would beat the probe
    // and crash on the absent bindings).
    expect(runtime.transportSnapshot()).toBe('pending')

    resolveTransport(jsonResponse({ transport: 'web', ws: '/ws', authenticated: true }))
    expect(await runtime.transportDetection()).toBe('web')
    expect(runtime.transportSnapshot()).toBe('web')
  })

  it('never gates the wails transport and never asks the network', async () => {
    installWailsGlobals()
    runtime = await freshRuntime()
    await expect(runtime.webAuthRequired()).resolves.toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it('a 401 RPC fires the mid-session signal and still rejects the call', async () => {
    runtime = await bootedRuntime()
    const signals: number[] = []
    const unsubscribe = runtime.onWebAuthRequired(() => signals.push(1))

    respondWebApp(async () => jsonResponse({ error: 'authentication required' }, 401))
    await expect(runtime.getApp().Foo()).rejects.toThrow('authentication required')
    expect(signals).toEqual([1])

    // The unsubscribe works: no listener, no signal — and the rejection
    // contract is unchanged either way.
    unsubscribe()
    await expect(runtime.getApp().Foo()).rejects.toThrow('authentication required')
    expect(signals).toEqual([1])
  })

  it('a non-401 RPC failure never fires the signal', async () => {
    runtime = await bootedRuntime()
    const signals: number[] = []
    runtime.onWebAuthRequired(() => signals.push(1))

    respondWebApp(async () => jsonResponse({ error: 'boom' }, 500))
    await expect(runtime.getApp().Foo()).rejects.toThrow('boom')
    expect(signals).toEqual([])
  })
})

describe('emitLocalEvent', () => {
  it('feeds the local listener registry without touching any transport', async () => {
    runtime = await bootedRuntime()
    const seen: unknown[] = []
    const unsubscribe = runtime.subscribe('local-test', (...args: unknown[]) => seen.push(args))
    runtime.emitLocalEvent('local-test', { a: 1 })
    runtime.emitLocalEvent('local-test')
    unsubscribe()
    runtime.emitLocalEvent('local-test', { a: 2 })
    expect(seen).toEqual([[{ a: 1 }], []])
    // Nothing traveled: no RPC, no websocket frame.
    expect(fetchCalls.filter((c) => c.url !== '/api/transport')).toEqual([])
  })
})
