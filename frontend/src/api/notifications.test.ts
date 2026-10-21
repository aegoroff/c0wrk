// @vitest-environment jsdom
//
// Tests for the Go notification transport wrappers in api/notifications.ts:
// RPC argument marshalling (undefined values dropped from the data map) and
// the notification_clicked subscription boundary (guard-validated payloads
// reach the callback; malformed ones are reported and dropped).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  initSystemNotifications,
  sendSystemNotification,
  showTestNotification,
  onNotificationClicked,
  checkNotificationAuthorization,
  ensureNotificationPermission,
  NotificationPermissionError,
  webNotificationDenialCause,
  __resetPermissionWarnForTest,
} from './notifications'
import { setLogLevel } from '@/lib/logger'

// The web-transport branches (ADR-090) read isWebTransport and report clicks
// through emitLocalEvent; both are hoisted spies so tests can flip the
// transport and observe the replayed event. Everything else stays the real
// module (the same 'none' settle as before — the existing desktop tests are
// untouched).
const runtimeMocks = vi.hoisted(() => ({
  web: false,
  emitLocalEvent: vi.fn(),
}))

vi.mock('@/api/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/runtime')>()
  return {
    ...actual,
    isWebTransport: () => runtimeMocks.web,
    emitLocalEvent: runtimeMocks.emitLocalEvent,
  }
})

/** Minimal stand-in for the browser Notification API (jsdom has none). */
class FakeNotification {
  static permission: 'default' | 'granted' | 'denied' = 'default'
  static requestPermission = vi.fn<() => Promise<'default' | 'granted' | 'denied'>>()
  static instances: FakeNotification[] = []

  title: string
  options: NotificationOptions & { data?: Record<string, string> }
  onclick: (() => void) | null = null
  closed = false

  constructor(title: string, options?: NotificationOptions & { data?: Record<string, string> }) {
    this.title = title
    this.options = options ?? {}
    FakeNotification.instances.push(this)
  }

  close(): void {
    this.closed = true
  }
}

type SendBinding = (title: string, body: string, data?: Record<string, string>) => Promise<void>

function installApp(methods: Record<string, unknown>): void {
  ;(window as unknown as Record<string, unknown>).go = { desktop: { App: methods } }
}

let consoleWarn: ReturnType<typeof vi.spyOn>
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // Scoped spies: expected diagnostics (deliberately exercised failure paths)
  // are intercepted here and asserted per test, never silenced globally.
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  delete (window as unknown as Record<string, unknown>).go
  delete (window as unknown as Record<string, unknown>).runtime
  runtimeMocks.web = false
  runtimeMocks.emitLocalEvent.mockReset()
  FakeNotification.permission = 'default'
  FakeNotification.requestPermission.mockReset()
  FakeNotification.instances = []
  __resetPermissionWarnForTest()
})

afterEach(() => {
  consoleWarn.mockRestore()
  consoleError.mockRestore()
  vi.unstubAllGlobals()
})

describe('initSystemNotifications', () => {
  it('calls the InitNotifications binding', async () => {
    const init = vi.fn(async () => {})
    installApp({ InitNotifications: init })
    await initSystemNotifications()
    expect(init).toHaveBeenCalledTimes(1)
  })

  it('propagates RPC failures to the caller (lib downgrades to warn)', async () => {
    installApp({ InitNotifications: async () => { throw new Error('D-Bus unavailable') } })
    await expect(initSystemNotifications()).rejects.toThrow('D-Bus unavailable')
  })

  it('throws when the App bindings are absent (no Wails host)', async () => {
    await expect(initSystemNotifications()).rejects.toThrow('Wails App bindings are not available')
  })
})

describe('sendSystemNotification', () => {
  it('forwards title, body and the data map', async () => {
    const send = vi.fn(async (_t: string, _b: string, _d?: Record<string, string>) => {})
    installApp({ SendSystemNotification: send })
    await sendSystemNotification('T', 'B', { sessionId: 's1', projectId: 'p1' })
    expect(send).toHaveBeenCalledWith('T', 'B', { sessionId: 's1', projectId: 'p1' })
  })

  it('drops undefined entries so map[string]string never sees a null', async () => {
    const send = vi.fn<(title: string, body: string, data?: Record<string, string>) => Promise<void>>(async () => {})
    installApp({ SendNotification: send })
    installApp({ SendSystemNotification: send })
    await sendSystemNotification('T', 'B', { sessionId: 's1', projectId: undefined })
    expect(send).toHaveBeenCalledWith('T', 'B', { sessionId: 's1' })
  })

  it('sends undefined (no data map) when every entry was undefined', async () => {
    const send = vi.fn<SendBinding>(async () => {})
    installApp({ SendSystemNotification: send })
    await sendSystemNotification('T', 'B', { projectId: undefined })
    expect(send).toHaveBeenCalledWith('T', 'B', undefined)
  })
})

describe('showTestNotification', () => {
  it('calls the ShowTestNotification binding', async () => {
    const show = vi.fn(async () => {})
    installApp({ ShowTestNotification: show })
    await showTestNotification()
    expect(show).toHaveBeenCalledTimes(1)
  })
})

describe('onNotificationClicked', () => {
  /** Minimal fake runtime that records EventsOn handlers per event name. */
  function installEventsRuntime(): Record<string, ((...data: unknown[]) => void)[]> {
    const runtimeHandlers: Record<string, ((...data: unknown[]) => void)[]> = {}
    ;(window as unknown as Record<string, unknown>).runtime = {
      EventsOn: (name: string, cb: (...data: unknown[]) => void) => {
        ;(runtimeHandlers[name] ??= []).push(cb)
        return () => {}
      },
    }
    return runtimeHandlers
  }

  it('delivers a valid payload to the callback', () => {
    const runtimeHandlers = installEventsRuntime()
    const got: unknown[] = []
    const off = onNotificationClicked((data) => got.push(data))
    runtimeHandlers['notification_clicked']![0]!({
      notification_id: 'n1',
      session_id: 's1',
      project_id: 'p1',
    })
    expect(got).toEqual([{ notification_id: 'n1', session_id: 's1', project_id: 'p1' }])
    off()
  })

  it('drops and reports a malformed payload', () => {
    const runtimeHandlers = installEventsRuntime()
    const got: unknown[] = []
    const off = onNotificationClicked((data) => got.push(data))
    runtimeHandlers['notification_clicked']![0]!({ notification_id: 42 })
    expect(got).toEqual([])
    expect(consoleWarn).toHaveBeenCalled()
    off()
  })

  it('returns a working unsubscribe (no-op without a runtime)', () => {
    expect(() => onNotificationClicked(() => {})).not.toThrow()
  })
})

// --- Web transport (ADR-090): the browser IS the notification center -------
describe('web transport notifications', () => {
  function installWeb(): void {
    runtimeMocks.web = true
    vi.stubGlobal('Notification', FakeNotification)
  }

  it('init reads the permission without prompting (no gesture at boot)', async () => {
    installWeb()
    FakeNotification.permission = 'granted'
    await expect(initSystemNotifications()).resolves.toBeUndefined()
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  })

  it('send shows a browser banner tagged per session with the routing data', async () => {
    installWeb()
    FakeNotification.permission = 'granted'
    await sendSystemNotification('T', 'B', { sessionId: 's1', projectId: 'p1' })
    expect(FakeNotification.instances).toHaveLength(1)
    const banner = FakeNotification.instances[0]!
    expect(banner.title).toBe('T')
    expect(banner.options.body).toBe('B')
    expect(banner.options.tag).toBe('c0wrk:s1')
    expect(banner.options.data).toEqual({ sessionId: 's1', projectId: 'p1' })
  })

  it('send never prompts on default and drops the banner (one warn, zero errors)', async () => {
    installWeb()
    // The send path owns no gesture, so it no longer even tries
    // requestPermission (most browsers dismiss a gestureless prompt anyway):
    // the Settings toggle / Test button are the documented request paths.
    // A dropped banner is logged once at warn, never at error.
    await expect(sendSystemNotification('T', 'B', { sessionId: 's1' })).resolves.toBeUndefined()
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    expect(FakeNotification.instances).toHaveLength(0)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("permission is 'default'"))
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('send drops the banner without an error when the permission is denied', async () => {
    installWeb()
    FakeNotification.permission = 'denied'
    await expect(sendSystemNotification('T', 'B', { sessionId: 's1' })).resolves.toBeUndefined()
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    expect(FakeNotification.instances).toHaveLength(0)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('the ungranted send warns once per run; later occurrences stay at debug', async () => {
    installWeb()
    FakeNotification.permission = 'denied'
    await sendSystemNotification('T', 'B')
    await sendSystemNotification('T', 'B')
    // A burst of cued events costs exactly ONE warn — the once-per-run flag.
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    setLogLevel('debug')
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      await sendSystemNotification('T', 'B')
      expect(consoleDebug).toHaveBeenCalledTimes(1)
      expect(consoleWarn).toHaveBeenCalledTimes(1)
    } finally {
      consoleDebug.mockRestore()
      setLogLevel('warn')
    }
  })

  it('click focuses the tab, replays notification_clicked locally and closes', async () => {
    installWeb()
    FakeNotification.permission = 'granted'
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    await sendSystemNotification('T', 'B', { sessionId: 's1', projectId: 'p1' })
    const banner = FakeNotification.instances[0]!
    banner.onclick!()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.emitLocalEvent).toHaveBeenCalledWith(
      'notification_clicked',
      expect.objectContaining({ session_id: 's1', project_id: 'p1' }),
    )
    const payload = runtimeMocks.emitLocalEvent.mock.calls[0]![1] as { notification_id: string }
    expect(payload.notification_id).toMatch(/^web-/)
    expect(banner.closed).toBe(true)
  })

  it('click on an unattributed banner emits empty routing ids (focus only)', async () => {
    installWeb()
    FakeNotification.permission = 'granted'
    await sendSystemNotification('T', 'B')
    FakeNotification.instances[0]!.onclick!()
    expect(runtimeMocks.emitLocalEvent).toHaveBeenCalledWith('notification_clicked', {
      notification_id: expect.any(String),
      session_id: '',
      project_id: '',
    })
  })

  it('authorization mirrors the browser permission', async () => {
    installWeb()
    FakeNotification.permission = 'granted'
    await expect(checkNotificationAuthorization()).resolves.toBe(true)
    FakeNotification.permission = 'denied'
    await expect(checkNotificationAuthorization()).resolves.toBe(false)
    // 'default' (never asked) is NOT a denial — the Test button's click is
    // the gesture that requests the permission (ADR-090, decision 11), so
    // the probe must leave the button reachable in a fresh browser.
    FakeNotification.permission = 'default'
    await expect(checkNotificationAuthorization()).resolves.toBe(true)
  })

  it('the test banner requests permission from the click gesture and sends', async () => {
    installWeb()
    FakeNotification.requestPermission.mockImplementation(async () => {
      FakeNotification.permission = 'granted'
      return 'granted'
    })
    await showTestNotification()
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    const banner = FakeNotification.instances[0]!
    expect(banner.title).toContain('test notification')
    // Unattributed: no tag, no data map — a click focuses only.
    expect(banner.options.tag).toBeUndefined()
    expect(banner.options.data).toBeUndefined()
    banner.onclick!()
    const payload = runtimeMocks.emitLocalEvent.mock.calls[0]![1] as { session_id: string }
    expect(payload.session_id).toBe('')
  })

  it('the test banner rejects with a denied NotificationPermissionError when blocked', async () => {
    installWeb()
    FakeNotification.permission = 'denied'
    const err = await showTestNotification().then(
      () => {
        throw new Error('expected rejection')
      },
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(NotificationPermissionError)
    expect((err as NotificationPermissionError).outcome).toBe('denied')
    expect((err as Error).message).toContain('Notification permission is not granted')
    expect(FakeNotification.instances).toHaveLength(0)
  })

  it('the test banner rejects with outcome default when the prompt is dismissed', async () => {
    installWeb()
    // The prompt was closed without an answer: the permission re-read stays
    // 'default' — the error must carry THAT, not a denial (ADR-090, decision
    // 11: the button remains the retry gesture).
    FakeNotification.requestPermission.mockResolvedValue('default')
    const err = await showTestNotification().then(
      () => {
        throw new Error('expected rejection')
      },
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(NotificationPermissionError)
    expect((err as NotificationPermissionError).outcome).toBe('default')
    expect(FakeNotification.instances).toHaveLength(0)
  })

  it('ensureNotificationPermission requests once from a gesture and reports the outcome', async () => {
    installWeb()
    // A real browser flips the permission static as the prompt settles —
    // the re-read (not the resolved value) is what the outcome mirrors.
    FakeNotification.requestPermission.mockImplementation(async () => {
      FakeNotification.permission = 'granted'
      return 'granted'
    })
    await expect(ensureNotificationPermission()).resolves.toBe('granted')
    // Back to a fresh browser: a granted permission would short-circuit at
    // the pre-read and never prompt again.
    FakeNotification.permission = 'default'
    FakeNotification.requestPermission.mockImplementation(async () => {
      FakeNotification.permission = 'denied'
      return 'denied'
    })
    await expect(ensureNotificationPermission()).resolves.toBe('denied')
    // Already granted: no second prompt.
    FakeNotification.permission = 'granted'
    await expect(ensureNotificationPermission()).resolves.toBe('granted')
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(2)
  })

  it('ensureNotificationPermission re-reads the permission after the prompt (dismissed = default, not denied)', async () => {
    installWeb()
    // Safari resolves requestPermission with undefined (here: a "granted"
    // lie), and a prompt closed WITHOUT an answer leaves the permission at
    // 'default'. The re-read is the source of truth: the outcome must be
    // 'default' — NOT a denial (ADR-090, decision 11) — so the Settings
    // section keeps the Test button reachable as the retry gesture.
    FakeNotification.requestPermission.mockImplementation(async () => 'granted')
    await expect(ensureNotificationPermission()).resolves.toBe('default')
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('ensureNotificationPermission is a desktop no-op that resolves granted', async () => {
    // runtimeMocks.web stays false; no window.go and no Notification global —
    // the desktop path owns authorization through InitNotifications instead.
    await expect(ensureNotificationPermission()).resolves.toBe('granted')
  })
})

// --- Web denial causes: WHY is the browser permission 'denied'? ------------
describe('webNotificationDenialCause', () => {
  /**
   * Firefox on an insecure origin: reading the static permission itself
   * throws SecurityError instead of answering 'denied'.
   */
  class FirefoxInsecureNotification {
    static get permission(): 'default' | 'granted' | 'denied' {
      throw new DOMException('The operation is insecure', 'SecurityError')
    }
    static requestPermission = vi.fn<() => Promise<'default' | 'granted' | 'denied'>>()
  }

  /** Shadows jsdom's isSecureContext; unstubAllGlobals (afterEach) restores it. */
  function stubSecureContext(secure: boolean): void {
    vi.stubGlobal('isSecureContext', secure)
  }

  it('classifies a secure-context denial as the site-settings cause', () => {
    vi.stubGlobal('Notification', FakeNotification)
    stubSecureContext(true)
    FakeNotification.permission = 'denied'
    expect(webNotificationDenialCause()).toBe('site-settings')
  })

  it('classifies an insecure-context denial as the dedicated insecure cause', () => {
    vi.stubGlobal('Notification', FakeNotification)
    stubSecureContext(false)
    FakeNotification.permission = 'denied'
    expect(webNotificationDenialCause()).toBe('insecure-context')
  })

  it('treats a SecurityError permission read (Firefox, insecure) as the same insecure cause', () => {
    vi.stubGlobal('Notification', FirefoxInsecureNotification)
    stubSecureContext(false)
    expect(webNotificationDenialCause()).toBe('insecure-context')
  })

  it('returns null when the permission is not denied', () => {
    vi.stubGlobal('Notification', FakeNotification)
    stubSecureContext(true)
    FakeNotification.permission = 'granted'
    expect(webNotificationDenialCause()).toBeNull()
    // 'default' (never asked) has no denial to explain either.
    FakeNotification.permission = 'default'
    expect(webNotificationDenialCause()).toBeNull()
  })

  it('returns null without the Notification API', () => {
    stubSecureContext(true)
    expect(webNotificationDenialCause()).toBeNull()
  })

  it('authorization maps a SecurityError permission read to denied (the probe must not reject)', async () => {
    // The mount probe chains .then() without a catch — a Firefox-insecure
    // read that answered "not denied" (or rejected) would strand the section
    // in 'checking' with an unhandled rejection instead of the hint.
    runtimeMocks.web = true
    vi.stubGlobal('Notification', FirefoxInsecureNotification)
    await expect(checkNotificationAuthorization()).resolves.toBe(false)
  })

  it('ensureNotificationPermission refuses upfront when the permission read throws', async () => {
    runtimeMocks.web = true
    vi.stubGlobal('Notification', FirefoxInsecureNotification)
    await expect(ensureNotificationPermission()).resolves.toBe('denied')
    expect(FirefoxInsecureNotification.requestPermission).not.toHaveBeenCalled()
  })
})
