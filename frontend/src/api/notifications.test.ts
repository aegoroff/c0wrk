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
} from './notifications'

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

beforeEach(() => {
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  delete (window as unknown as Record<string, unknown>).go
  delete (window as unknown as Record<string, unknown>).runtime
  runtimeMocks.web = false
  runtimeMocks.emitLocalEvent.mockReset()
  FakeNotification.permission = 'default'
  FakeNotification.requestPermission.mockReset()
  FakeNotification.instances = []
})

afterEach(() => {
  consoleWarn.mockRestore()
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

  it('send requests permission on default and sends once granted', async () => {
    installWeb()
    FakeNotification.requestPermission.mockImplementation(async () => {
      FakeNotification.permission = 'granted'
      return 'granted'
    })
    await sendSystemNotification('T', 'B', { sessionId: 's1' })
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect(FakeNotification.instances).toHaveLength(1)
  })

  it('send rejects with the actionable message when the permission is denied', async () => {
    installWeb()
    FakeNotification.permission = 'denied'
    await expect(sendSystemNotification('T', 'B', { sessionId: 's1' })).rejects.toThrow(
      'Notification permission is not granted',
    )
    expect(FakeNotification.instances).toHaveLength(0)
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

  it('the test banner rejects when the permission stays denied', async () => {
    installWeb()
    FakeNotification.permission = 'denied'
    await expect(showTestNotification()).rejects.toThrow('Notification permission is not granted')
  })

  it('ensureNotificationPermission requests once from a gesture and reports the outcome', async () => {
    installWeb()
    FakeNotification.requestPermission.mockResolvedValue('granted')
    await expect(ensureNotificationPermission()).resolves.toBe(true)
    FakeNotification.requestPermission.mockResolvedValue('denied')
    await expect(ensureNotificationPermission()).resolves.toBe(false)
    // Already granted: no second prompt.
    FakeNotification.permission = 'granted'
    await expect(ensureNotificationPermission()).resolves.toBe(true)
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(2)
  })

  it('ensureNotificationPermission is a desktop no-op that resolves true', async () => {
    // runtimeMocks.web stays false; no window.go and no Notification global —
    // the desktop path owns authorization through InitNotifications instead.
    await expect(ensureNotificationPermission()).resolves.toBe(true)
  })
})
