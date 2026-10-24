// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { logger } from '@/lib/logger'
import { createRoot, type Root } from 'react-dom/client'

// Spies created via vi.hoisted so they exist before vi.mock factories run.
// Only the functions the component actually calls are mocked; the rest of
// each module surface stays absent per the project's partial-mock
// convention (see ModelConfigDialog.test).
const mocks = vi.hoisted(() => ({
  checkNotificationAuthorization: vi.fn(),
  initSystemNotifications: vi.fn(),
  showTestNotification: vi.fn(),
  ensureNotificationPermission: vi.fn(),
  webNotificationDenialCause: vi.fn(),
  isWailsReady: vi.fn(),
  isWebTransport: vi.fn(),
  send: vi.fn(),
  getBannerTimeout: vi.fn(),
  setBannerTimeout: vi.fn(),
}))

vi.mock('@/api/notifications', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/api/notifications')>()
  return {
    ...original,
    checkNotificationAuthorization: mocks.checkNotificationAuthorization,
    initSystemNotifications: mocks.initSystemNotifications,
    showTestNotification: mocks.showTestNotification,
    ensureNotificationPermission: mocks.ensureNotificationPermission,
    webNotificationDenialCause: mocks.webNotificationDenialCause,
  }
})

// lib/systemNotifications is mocked wholesale: the component must not
// depend on its store gate or transport internals for the preview send —
// only on the exported sendSystemNotification signature.
vi.mock('@/lib/systemNotifications', () => ({
  sendSystemNotification: mocks.send,
}))

vi.mock('@/api/runtime', () => ({
  isWailsReady: mocks.isWailsReady,
  isWebTransport: mocks.isWebTransport,
}))

vi.mock('@/api/config', () => ({
  getNotificationBannerTimeout: mocks.getBannerTimeout,
  setNotificationBannerTimeout: mocks.setBannerTimeout,
}))

import { SystemNotificationSettings } from './SystemNotificationSettings'
import { useSystemNotificationStore } from '@/stores/systemNotificationStore'
import { NotificationPermissionError } from '@/api/notifications'

let container: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(<SystemNotificationSettings />)
  })
}

/** Click the master toggle's hidden checkbox (the Toggle primitive's input). */
function toggleInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!input) throw new Error('toggle input not found')
  return input
}

function testButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-testid="send-test-notification"]')
}

function hintText(): string | null {
  const el = container.querySelector('[data-testid="notification-permission-hint"]')
  return el?.textContent ?? null
}

async function flush(): Promise<void> {
  await act(async () => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isWailsReady.mockReturnValue(true)
  mocks.isWebTransport.mockReturnValue(false)
  mocks.ensureNotificationPermission.mockResolvedValue('granted')
  // Secure-context default: a real browser serving over HTTPS/localhost that
  // denied the site can lift the block in its settings — that wording is the
  // fallback the insecure-origin test below overrides.
  mocks.webNotificationDenialCause.mockReturnValue('site-settings')
  mocks.checkNotificationAuthorization.mockResolvedValue(true)
  mocks.initSystemNotifications.mockResolvedValue(undefined)
  mocks.showTestNotification.mockResolvedValue(undefined)
  mocks.send.mockResolvedValue(undefined)
  mocks.getBannerTimeout.mockResolvedValue(-1)
  mocks.setBannerTimeout.mockResolvedValue(undefined)
  useSystemNotificationStore.setState({ enabled: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useSystemNotificationStore.setState({ enabled: true })
})

describe('SystemNotificationSettings', () => {
  it('renders the toggle reflecting the store state', async () => {
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()
    expect(toggleInput().checked).toBe(false)
    expect(container.textContent).toContain('System Notifications')
    expect(container.textContent).toContain('Disabled')
  })

  it('probes authorization once on mount and renders no hint when granted', async () => {
    render()
    expect(mocks.checkNotificationAuthorization).toHaveBeenCalledTimes(1)
    await flush()
    expect(hintText()).toBeNull()
    expect(testButton()).not.toBeNull()
  })

  it('skips the probe entirely when the Wails runtime is absent', async () => {
    mocks.isWailsReady.mockReturnValue(false)
    render()
    await flush()
    expect(mocks.checkNotificationAuthorization).not.toHaveBeenCalled()
    expect(hintText()).toBeNull()
  })

  it('renders the muted macOS hint instead of the test button when denied', async () => {
    mocks.checkNotificationAuthorization.mockResolvedValue(false)
    render()
    await flush()
    expect(hintText()).toBe(
      'Notifications are disabled for c0wrk in macOS Settings — enable them to receive alerts',
    )
    expect(testButton()).toBeNull()
  })

  it('turning on initializes the bridge and previews a banner', async () => {
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()

    await act(async () => {
      toggleInput().click()
    })

    expect(useSystemNotificationStore.getState().enabled).toBe(true)
    expect(mocks.initSystemNotifications).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    const [content] = mocks.send.mock.calls[0] as [
      { title: string; body: string; kind: string },
    ]
    expect(content.title).toBe('c0wrk — System notifications enabled')
    expect(content.body).toBe(
      'You will see notifications like this when tasks finish or need your input.',
    )
  })

  it('turning off sends nothing and tears nothing down', async () => {
    render()
    await flush()

    await act(async () => {
      toggleInput().click()
    })

    expect(useSystemNotificationStore.getState().enabled).toBe(false)
    expect(mocks.initSystemNotifications).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('suppresses the enable preview while authorization is denied', async () => {
    mocks.checkNotificationAuthorization.mockResolvedValue(false)
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()

    await act(async () => {
      toggleInput().click()
    })

    // Init still runs (the bridge is real even with banners hidden); only
    // the preview banner is skipped — sending into a denied channel would
    // confuse the "did it work?" signal.
    expect(mocks.initSystemNotifications).toHaveBeenCalledTimes(1)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('the test button sends the Go-authored banner', async () => {
    render()
    await flush()

    await act(async () => {
      testButton()?.click()
    })

    expect(mocks.showTestNotification).toHaveBeenCalledTimes(1)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('hides the test button while the toggle is off', async () => {
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()
    expect(testButton()).toBeNull()
  })

  it('toggle-on on the desktop keeps a real denied authorization (no-op ensure must not wipe the hint)', async () => {
    // The mount probe read the REAL OS authorization (macOS System Settings:
    // denied). The desktop ensureNotificationPermission is a no-op resolving
    // 'granted' — folding that constant into the section state used to hide
    // the hint and reveal the Test button while the OS still refuses.
    mocks.checkNotificationAuthorization.mockResolvedValue(false)
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()
    expect(hintText()).not.toBeNull()

    await act(async () => {
      toggleInput().click()
    })
    await flush()

    // The hint survives the off→on toggle; the button stays hidden and the
    // preview stays suppressed (the send lands nowhere on a denied channel).
    expect(hintText()).toBe(
      'Notifications are disabled for c0wrk in macOS Settings — enable them to receive alerts',
    )
    expect(testButton()).toBeNull()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('toggle-on on the web previews the banner after a since-fixed denial (outcome, not the stale closure)', async () => {
    // The mount probe read a real denial, the user lifted the block in the
    // browser's site settings, and the re-enable click's ensure resolves
    // 'granted'. The render-scope `permission` closure still reads 'denied'
    // at that point — suppression must derive from the fresh outcome, or
    // the confirmation banner never fires.
    mocks.isWebTransport.mockReturnValue(true)
    mocks.checkNotificationAuthorization.mockResolvedValue(false)
    mocks.ensureNotificationPermission.mockResolvedValue('granted')
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()

    await act(async () => {
      toggleInput().click()
    })
    await flush()

    expect(mocks.send).toHaveBeenCalledTimes(1)
    const [content] = mocks.send.mock.calls[0] as [{ title: string }]
    expect(content.title).toBe('c0wrk — System notifications enabled')
  })

  it('toggle-on on the web still derives the section state from the prompt outcome', async () => {
    // The web outcome IS a permission verdict, so the derivation must keep
    // running there: a denied prompt keeps the browser-specific hint.
    mocks.isWebTransport.mockReturnValue(true)
    mocks.checkNotificationAuthorization.mockResolvedValue(false)
    mocks.ensureNotificationPermission.mockResolvedValue('denied')
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()
    expect(hintText()).not.toBeNull()

    await act(async () => {
      toggleInput().click()
    })
    await flush()

    expect(hintText()).toBe(
      'Notifications are blocked for this site in your browser — allow them in the browser’s site settings to receive alerts',
    )
    expect(testButton()).toBeNull()
  })
})

// --- Banner lifetime -------------------------------------------------------

/** The segmented banner-lifetime buttons, in render order. */
function bannerTimeoutButtons(): HTMLButtonElement[] {
  const control = container.querySelector('[data-testid="banner-timeout-control"]')
  return control ? Array.from(control.querySelectorAll('button')) : []
}

describe('banner lifetime control', () => {
  // The control is Linux-only (isLinuxHost() reads navigator.platform), so pin
  // the platform for this suite: jsdom seeds navigator.platform from the host
  // running the tests, and on the Windows/macOS CI runners the selector would
  // otherwise not render at all. defineProperty (per the project convention,
  // cf. the navigator.clipboard stubs) shadows the platform string
  // deterministically wherever the suite executes.
  const originalPlatform = navigator.platform
  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Linux x86_64',
    })
  })
  afterEach(() => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: originalPlatform,
    })
  })

  it('renders the configured lifetime once the backend answers', async () => {
    mocks.getBannerTimeout.mockResolvedValue(30)
    render()
    await flush()

    const labels = bannerTimeoutButtons().map((b) => b.textContent)
    expect(labels).toEqual(['Default', '10s', '30s', '1m', 'Never'])
  })

  it('persists the chosen lifetime, including "Never" (0)', async () => {
    render()
    await flush()

    const never = bannerTimeoutButtons().find((b) => b.textContent === 'Never')
    expect(never).toBeDefined()
    await act(async () => {
      never!.click()
    })

    // 0 is a real value here, not an unset field — the whole point of the
    // setting is that the banner stays until the user acts on it.
    expect(mocks.setBannerTimeout).toHaveBeenCalledWith(0)
  })

  it('stays hidden while the master toggle is off', async () => {
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()

    expect(bannerTimeoutButtons()).toHaveLength(0)
  })

  it('reverts the selection when the backend rejects the write', async ({ onTestFinished }) => {
    const logSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => logSpy.mockRestore())
    mocks.getBannerTimeout.mockResolvedValue(-1)
    mocks.setBannerTimeout.mockRejectedValue(new Error('nope'))
    render()
    await flush()

    const never = bannerTimeoutButtons().find((b) => b.textContent === 'Never')
    await act(async () => {
      never!.click()
    })
    await flush()

    // The optimistic update must roll back to what the backend still holds.
    // The active pill is marked by the shared control's `bg-primary` chrome.
    const selected = bannerTimeoutButtons().find((b) => b.className.includes('bg-primary'))
    expect(selected?.textContent).toBe('Default')
    expect(logSpy).toHaveBeenCalledExactlyOnceWith('[system-notifications] banner timeout write failed', new Error('nope'))
  })

  it('renders on Linux arm64 hosts — the matcher must stay architecture-agnostic', async () => {
    // WebKit composes navigator.platform from uname(): "Linux x86_64" on amd64,
    // "Linux aarch64" on arm64 — a first-class release platform (ADR-027).
    // isLinuxHost() matches the "Linux" substring, so any architecture string
    // passes; this test pins that. A regression to exact-match against one
    // arch would silently hide the control for every arm64 user while the
    // rest of the suite (pinned to x86_64 above) stayed green.
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Linux aarch64',
    })
    render()
    await flush()

    expect(bannerTimeoutButtons().length).toBeGreaterThan(0)
  })
})

describe('SystemNotificationSettings web transport', () => {
  it('the toggle-on click requests the browser permission before the preview', async () => {
    mocks.isWebTransport.mockReturnValue(true)
    mocks.ensureNotificationPermission.mockResolvedValue('granted')
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()
    await act(async () => {
      toggleInput().click()
    })
    await flush()
    // The gesture ordering contract: permission first, preview after.
    expect(mocks.ensureNotificationPermission).toHaveBeenCalledTimes(1)
    expect(mocks.initSystemNotifications).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('a denied permission renders the browser-specific hint (not the macOS one)', async () => {
    mocks.isWebTransport.mockReturnValue(true)
    mocks.checkNotificationAuthorization.mockResolvedValue(false)
    render()
    await flush()
    expect(hintText()).toContain('browser')
    expect(hintText()).not.toContain('macOS')
    expect(testButton()).toBeNull()
  })

  it('an insecure-origin denial renders the dedicated hint without the site-settings wording', async () => {
    mocks.isWebTransport.mockReturnValue(true)
    mocks.checkNotificationAuthorization.mockResolvedValue(false)
    mocks.webNotificationDenialCause.mockReturnValue('insecure-context')
    render()
    await flush()
    const hint = hintText()
    // Names the actual fix (a secure origin — HTTPS/localhost, e.g. an SSH
    // tunnel) and must NOT offer the site-settings advice: no site setting
    // can lift a browser platform rule on a plain-HTTP origin.
    expect(hint).toContain('secure origins (HTTPS or localhost)')
    expect(hint).toContain('plain HTTP')
    expect(hint).toContain('http://localhost:<port>')
    expect(hint).toContain('SSH tunnel')
    expect(hint).not.toContain('site settings')
    // requestPermission auto-refuses on insecure origins — no button.
    expect(testButton()).toBeNull()
  })

  it('a secure-context denial keeps the site-settings hint and hides the test button', async () => {
    mocks.isWebTransport.mockReturnValue(true)
    mocks.checkNotificationAuthorization.mockResolvedValue(false)
    mocks.webNotificationDenialCause.mockReturnValue('site-settings')
    render()
    await flush()
    expect(hintText()).toBe(
      'Notifications are blocked for this site in your browser — allow them in the browser’s site settings to receive alerts',
    )
    expect(testButton()).toBeNull()
  })

  it('keeps the test button reachable in a fresh browser (permission never asked)', async () => {
    // The api layer maps the unasked 'default' permission to "not denied"
    // (ADR-090 decision 11: the Test button's click is the gesture that
    // requests it) — the probe resolving true here IS that fresh-browser
    // state. The button must render, not the blocked-site hint.
    mocks.isWebTransport.mockReturnValue(true)
    mocks.checkNotificationAuthorization.mockResolvedValue(true)
    useSystemNotificationStore.setState({ enabled: true })
    render()
    await flush()
    expect(hintText()).toBeNull()
    expect(testButton()).not.toBeNull()
  })

  it('a prompt closed without an answer keeps the neutral state: no hint, Test button visible', async () => {
    // The toggle-on gesture ran, the browser prompt was DISMISSED: the api
    // layer resolves 'default' — NOT a denial (ADR-090, decision 11). The
    // section must stay neutral: no blocked hint, and the Test button stays
    // visible as the documented retry gesture. No preview either — nothing
    // was granted.
    mocks.isWebTransport.mockReturnValue(true)
    mocks.ensureNotificationPermission.mockResolvedValue('default')
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()
    await act(async () => {
      toggleInput().click()
    })
    await flush()
    expect(hintText()).toBeNull()
    expect(testButton()).not.toBeNull()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('a real denial (Block) from the toggle gesture renders the hint and hides the Test button', async () => {
    mocks.isWebTransport.mockReturnValue(true)
    mocks.ensureNotificationPermission.mockResolvedValue('denied')
    useSystemNotificationStore.setState({ enabled: false })
    render()
    await flush()
    await act(async () => {
      toggleInput().click()
    })
    await flush()
    expect(hintText()).toContain('blocked for this site')
    expect(testButton()).toBeNull()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('a dismissed prompt from the Test button keeps the button reachable (retry gesture)', async ({
    onTestFinished,
  }) => {
    const logSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => logSpy.mockRestore())
    mocks.isWebTransport.mockReturnValue(true)
    mocks.showTestNotification.mockRejectedValueOnce(new NotificationPermissionError('default'))
    render()
    await flush()
    await act(async () => {
      testButton()?.click()
    })
    await flush()
    // Not a denial: no hint, the button is still right there to try again.
    expect(hintText()).toBeNull()
    expect(testButton()).not.toBeNull()
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('a real denial from the Test button surfaces the hint and hides the button', async ({
    onTestFinished,
  }) => {
    const logSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => logSpy.mockRestore())
    mocks.isWebTransport.mockReturnValue(true)
    mocks.showTestNotification.mockRejectedValueOnce(new NotificationPermissionError('denied'))
    render()
    await flush()
    await act(async () => {
      testButton()?.click()
    })
    await flush()
    expect(hintText()).toContain('blocked for this site')
    expect(testButton()).toBeNull()
    expect(logSpy).toHaveBeenCalledTimes(1)
  })
})
