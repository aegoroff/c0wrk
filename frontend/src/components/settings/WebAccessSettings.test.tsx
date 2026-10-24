// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Spies created via vi.hoisted so they exist before vi.mock factories run.
const mocks = vi.hoisted(() => ({
  getWebAccessInfo: vi.fn(),
  setWebAccessEnabled: vi.fn(),
  setWebAccessConnection: vi.fn(),
  regenerateWebAccessToken: vi.fn(),
  setWebAccessToken: vi.fn(),
  setWebAccessTLS: vi.fn(),
  generateWebAccessCertificate: vi.fn(),
  clipboardSetText: vi.fn(),
  emit: vi.fn(),
}))

// The RPC wrappers are mocked; parseWebAccessAddress and parseWebAccessToken
// stay REAL — the fields' local validation is pure logic, and the UI tests
// exercise it as-is.
vi.mock('@/api/webAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/webAccess')>()),
  getWebAccessInfo: mocks.getWebAccessInfo,
  setWebAccessEnabled: mocks.setWebAccessEnabled,
  setWebAccessConnection: mocks.setWebAccessConnection,
  regenerateWebAccessToken: mocks.regenerateWebAccessToken,
  setWebAccessToken: mocks.setWebAccessToken,
  setWebAccessTLS: mocks.setWebAccessTLS,
  generateWebAccessCertificate: mocks.generateWebAccessCertificate,
}))

vi.mock('@/api/runtime', () => ({
  clipboardSetText: mocks.clipboardSetText,
  emit: mocks.emit,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { WebAccessSettings } from './WebAccessSettings'
import { logger } from '@/lib/logger'
import type { WebAccessInfo } from '@/api/webAccess'

const runningInfo: WebAccessInfo = {
  enabled: true,
  running: true,
  url: 'http://127.0.0.1:8765',
  port: 8765,
  configuredBind: '127.0.0.1',
  configuredPort: 8765,
  bindIsLoopback: true,
  token: 'tok-abcdef0123456789',
  tokenPinned: true,
  tlsEnabled: false,
  tlsCert: '',
  tlsKey: '',
  certStatus: '',
  certDetail: '',
}
const offInfo: WebAccessInfo = {
  enabled: false,
  running: false,
  url: '',
  port: 0,
  configuredBind: '127.0.0.1',
  configuredPort: 0,
  bindIsLoopback: true,
  token: '',
  tokenPinned: false,
  tlsEnabled: false,
  tlsCert: '',
  tlsKey: '',
  certStatus: '',
  certDetail: '',
}

let container: HTMLDivElement
let root: Root

function render(onConfigChanged?: () => void): void {
  act(() => {
    root.render(<WebAccessSettings onConfigChanged={onConfigChanged} />)
  })
}

async function flush(): Promise<void> {
  await act(async () => {})
}

function toggleInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!input) throw new Error('toggle input not found')
  return input
}

function byTestId(id: string): Element | null {
  return container.querySelector(`[data-testid="${id}"]`)
}

function addressInput(): HTMLInputElement {
  const el = byTestId('web-access-address-input')
  if (!(el instanceof HTMLInputElement)) throw new Error('address input not found')
  return el
}

function tokenInput(): HTMLInputElement {
  const el = byTestId('web-access-token-input')
  if (!(el instanceof HTMLInputElement)) throw new Error('token input not found')
  return el
}

function clickToggle(): void {
  act(() => {
    toggleInput().click()
  })
}

function clickButton(id: string): void {
  const el = byTestId(id)
  if (!el) throw new Error(`button ${id} not found`)
  act(() => {
    ;(el as HTMLButtonElement).click()
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter) setter.call(input, value)
    else input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The fields commit like the UI Scale control: Enter or focus loss. */
function pressEnter(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

function blurField(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getWebAccessInfo.mockResolvedValue(offInfo)
  mocks.setWebAccessEnabled.mockResolvedValue(undefined)
  mocks.setWebAccessConnection.mockResolvedValue(undefined)
  mocks.regenerateWebAccessToken.mockResolvedValue(undefined)
  mocks.setWebAccessToken.mockResolvedValue(undefined)
  mocks.setWebAccessTLS.mockResolvedValue(undefined)
  mocks.generateWebAccessCertificate.mockResolvedValue(undefined)
  mocks.clipboardSetText.mockResolvedValue(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('WebAccessSettings', () => {
  it('renders the off state: toggle unchecked, no credentials, no warning', async () => {
    render()
    await flush()
    expect(toggleInput().checked).toBe(false)
    expect(container.textContent).toContain('Web Access')
    expect(container.textContent).toContain('Disabled')
    // The single field displays the persisted pin (auto port = no port in
    // the shape); nothing to copy while the sidecar is off.
    expect(addressInput().value).toBe('http://127.0.0.1')
    expect(byTestId('web-access-copy-url')).toBeNull()
    expect(byTestId('web-access-token-block')).toBeNull()
    expect(byTestId('web-access-warning')).toBeNull()
    expect(byTestId('web-access-status')?.textContent).toContain('Off')
  })

  it('renders the running state: URL in the field, masked token input, full-control warning', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render()
    await flush()
    expect(toggleInput().checked).toBe(true)
    // One field displays AND edits the URL: the persisted pin, with scheme.
    expect(addressInput().value).toBe('http://127.0.0.1:8765')
    expect(byTestId('web-access-copy-url')).not.toBeNull()
    // The token is a password-masked input seeded with the live credential:
    // the raw value is never in the text flow.
    expect(tokenInput().type).toBe('password')
    expect(tokenInput().value).toBe(runningInfo.token)
    expect(container.textContent).not.toContain(runningInfo.token)
    expect(byTestId('web-access-warning')?.textContent).toContain('full control')
  })

  it('reveals and re-hides the token on demand', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render()
    await flush()
    expect(tokenInput().type).toBe('password')
    clickButton('web-access-reveal')
    await flush()
    expect(tokenInput().type).toBe('text')
    clickButton('web-access-reveal')
    await flush()
    expect(tokenInput().type).toBe('password')
  })

  it('copies the URL and the token through the app clipboard bridge', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render()
    await flush()
    clickButton('web-access-copy-url')
    await flush()
    expect(mocks.clipboardSetText).toHaveBeenCalledWith(runningInfo.url)
    clickButton('web-access-copy-token')
    await flush()
    expect(mocks.clipboardSetText).toHaveBeenCalledWith(runningInfo.token)
  })

  it('toasts and logs on a false clipboard verdict instead of flashing the success state', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    mocks.clipboardSetText.mockResolvedValue(false)
    render()
    await flush()
    clickButton('web-access-copy-url')
    await flush()
    expect(mocks.clipboardSetText).toHaveBeenCalledWith(runningInfo.url)
    // The copy affordance never flips to the success Check icon...
    expect(byTestId('web-access-copy-url')?.querySelector('svg.lucide-check')).toBeNull()
    // ...the failure is logged and surfaced as a runtime_error toast.
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Failed to copy to clipboard')
    expect(mocks.emit).toHaveBeenCalledWith(
      'runtime_error',
      expect.objectContaining({ message: 'Failed to copy to clipboard' }),
    )
  })

  it('enabling calls the toggle RPC and adopts the re-read authoritative state', async () => {
    mocks.getWebAccessInfo.mockResolvedValueOnce(offInfo).mockResolvedValueOnce(runningInfo)
    render()
    await flush()
    clickToggle()
    await flush()
    expect(mocks.setWebAccessEnabled).toHaveBeenCalledWith(true)
    // The post-toggle re-read, not a local derivation, feeds the display.
    expect(mocks.getWebAccessInfo).toHaveBeenCalledTimes(2)
    expect(addressInput().value).toBe('http://127.0.0.1:8765')
    expect(byTestId('web-access-warning')).not.toBeNull()
  })

  it('keeps the applied switch when the post-toggle re-read fails (no "Off" lie)', async () => {
    mocks.getWebAccessInfo.mockResolvedValueOnce(offInfo).mockResolvedValueOnce(null)
    render()
    await flush()
    clickToggle()
    await flush()
    expect(mocks.setWebAccessEnabled).toHaveBeenCalledWith(true)
    // The write succeeded; a failed re-read must not flip the display back
    // to the pre-toggle snapshot — the sidecar is actually serving.
    expect(toggleInput().checked).toBe(true)
    expect(byTestId('web-access-status')?.textContent).not.toContain('Off')
    expect(addressInput().value).toBe('http://127.0.0.1')
  })

  it('rolls the toggle back when the RPC rejects', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(offInfo)
    mocks.setWebAccessEnabled.mockRejectedValue(new Error('persist failed'))
    render()
    await flush()
    clickToggle()
    await flush()
    expect(toggleInput().checked).toBe(false)
    // The field keeps showing the persisted (untoggled) pin.
    expect(addressInput().value).toBe('http://127.0.0.1')
  })

  it('renders the unavailable state and disables the toggle when the bridge fails', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(null)
    render()
    await flush()
    expect(toggleInput().disabled).toBe(true)
    expect(byTestId('web-access-status')?.textContent).toContain('unavailable')
    expect(byTestId('web-access-warning')).toBeNull()
    // Without an authoritative read there is nothing to display or edit.
    expect(byTestId('web-access-address-input')).toBeNull()
    expect(byTestId('web-access-token-input')).toBeNull()
  })

  it('hides the credential rows when enabled but not running (no token minted yet)', async () => {
    mocks.getWebAccessInfo.mockResolvedValue({ ...offInfo, enabled: true })
    render()
    await flush()
    expect(toggleInput().checked).toBe(true)
    // The field always shows the persisted pin; only the copy affordance
    // needs a running sidecar (no resolved URL to open otherwise).
    expect(addressInput().value).toBe('http://127.0.0.1')
    expect(byTestId('web-access-copy-url')).toBeNull()
    expect(byTestId('web-access-token-block')).toBeNull()
    expect(byTestId('web-access-warning')?.textContent).toContain('full control')
    expect(byTestId('web-access-status')?.textContent).toContain('not running')
  })
})

describe('WebAccessSettings non-loopback bind warnings', () => {
  const lanInfo = { ...runningInfo, configuredBind: '0.0.0.0', bindIsLoopback: false }

  beforeEach(() => {
    mocks.getWebAccessInfo.mockResolvedValue(lanInfo)
  })

  it('renders the strong network warning only for an enabled non-loopback bind', async () => {
    render()
    await flush()
    const net = byTestId('web-access-warning-network')
    expect(net).not.toBeNull()
    expect(net?.textContent).toContain('Network exposure')
    expect(net?.textContent).toContain('plain HTTP')
    expect(net?.textContent).toContain('only protection')
    // The loopback-tier banner is replaced, not duplicated.
    expect(byTestId('web-access-warning')).toBeNull()
  })

  it('keeps the plain full-control warning on a loopback bind (no network banner)', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render()
    await flush()
    expect(byTestId('web-access-warning')?.textContent).toContain('full control')
    expect(byTestId('web-access-warning-network')).toBeNull()
  })

  it('shows neither warning while disabled, even on a non-loopback bind', async () => {
    mocks.getWebAccessInfo.mockResolvedValue({ ...lanInfo, enabled: false })
    render()
    await flush()
    expect(byTestId('web-access-warning')).toBeNull()
    expect(byTestId('web-access-warning-network')).toBeNull()
  })

  it('no longer claims the listener is loopback-only as an unconditional fact', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render()
    await flush()
    expect(byTestId('web-access-warning')?.textContent).not.toContain('loopback-only')
  })

  it('worded the running status for a network listener', async () => {
    render()
    await flush()
    const status = byTestId('web-access-status')?.textContent ?? ''
    expect(status).toContain('Running')
    expect(status).toContain('other devices on the network')
  })

  it('keeps the machine-local wording for a loopback listener', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render()
    await flush()
    expect(byTestId('web-access-status')?.textContent).toContain('on this machine.')
  })

  it('drops the plain-HTTP claim from the network warning when TLS is on', async () => {
    mocks.getWebAccessInfo.mockResolvedValue({ ...lanInfo, tlsEnabled: true, url: 'https://192.168.1.10:8765' })
    render()
    await flush()
    const net = byTestId('web-access-warning-network')
    expect(net).not.toBeNull()
    expect(net?.textContent).toContain('TLS-encrypted')
    expect(net?.textContent).not.toContain('plain HTTP')
    // The loopback-tier banner stays replaced, not duplicated.
    expect(byTestId('web-access-warning')).toBeNull()
  })
})

describe('WebAccessSettings TLS block (ADR-100) integration', () => {
  /** The section renders two switches now: the section toggle first, the
   *  TLS toggle last. */
  function tlsSwitch(): HTMLInputElement {
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    const input = inputs[inputs.length - 1]
    if (!input) throw new Error('tls toggle not found')
    return input
  }

  it('renders the TLS block for an authoritative read and hides it when the bridge fails', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(httpsInfo())
    render()
    await flush()
    expect(byTestId('web-access-tls-block')).not.toBeNull()
    expect(tlsSwitch().checked).toBe(true)

    mocks.getWebAccessInfo.mockResolvedValue(null)
    act(() => {
      root.unmount()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render()
    await flush()
    expect(byTestId('web-access-tls-block')).toBeNull()
  })

  it('seeds the address field with the https:// scheme while TLS is enabled', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(httpsInfo())
    render()
    await flush()
    expect(addressInput().value).toBe('https://127.0.0.1:8765')
  })

  it('wires the child toggle through to the SetWebAccessTLS RPC and re-reads', async () => {
    mocks.getWebAccessInfo.mockResolvedValue({ ...offInfo, tlsCert: '/tmp/cert.pem' })
    render()
    await flush()
    clickToggle() // the section toggle — unchanged behavior
    await flush()
    expect(mocks.setWebAccessEnabled).toHaveBeenCalledWith(true)

    act(() => {
      tlsSwitch().click()
    })
    await flush()
    expect(mocks.setWebAccessTLS).toHaveBeenCalledWith(true, '/tmp/cert.pem', '')
    // The post-write authoritative re-read (child) on top of the section's own.
    expect(mocks.getWebAccessInfo.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

/** The TLS-on shape of the authoritative payload: a running sidecar serving
 *  https with the app-owned pair configured and healthy. */
function httpsInfo() {
  return {
    ...runningInfo,
    url: 'https://127.0.0.1:8765',
    tlsEnabled: true,
    tlsCert: '/home/z/.c0wrk/web-access.crt',
    tlsKey: '/home/z/.c0wrk/web-access.key',
    certStatus: 'ok',
  }
}

describe('WebAccessSettings address (one URL-style field, commit on Enter/blur)', () => {
  beforeEach(() => {
    mocks.getWebAccessInfo.mockResolvedValue({
      ...runningInfo,
      configuredBind: '127.0.0.1',
      bindIsLoopback: true,
      configuredPort: 0,
      tokenPinned: true,
    })
  })

  it('commits on Enter: the parsed (bind, port) travels, state re-reads', async () => {
    render()
    await flush()
    typeInto(addressInput(), 'http://0.0.0.0:9000')
    pressEnter(addressInput())
    await flush()
    expect(mocks.setWebAccessConnection).toHaveBeenCalledWith('0.0.0.0', 9000)
    // The authoritative state is re-read after the commit.
    expect(mocks.getWebAccessInfo).toHaveBeenCalledTimes(2)
  })

  it('commits on focus loss', async () => {
    render()
    await flush()
    typeInto(addressInput(), 'localhost:9000')
    blurField(addressInput())
    await flush()
    expect(mocks.setWebAccessConnection).toHaveBeenCalledWith('localhost', 9000)
  })

  it('does not save an unchanged value (blur or Enter on the seeded field)', async () => {
    render()
    await flush()
    blurField(addressInput())
    pressEnter(addressInput())
    await flush()
    expect(mocks.setWebAccessConnection).not.toHaveBeenCalled()
  })

  it('adds the http:// scheme automatically; a bare host means the auto port', async () => {
    render()
    await flush()
    typeInto(addressInput(), '0.0.0.0')
    blurField(addressInput())
    await flush()
    expect(mocks.setWebAccessConnection).toHaveBeenCalledWith('0.0.0.0', 0)
  })

  it('an emptied field applies the defaults (loopback bind, auto port)', async () => {
    render()
    await flush()
    typeInto(addressInput(), '')
    pressEnter(addressInput())
    await flush()
    expect(mocks.setWebAccessConnection).toHaveBeenCalledWith('', 0)
  })

  it('seeds the field from the persisted pin (IPv4 and bracketed IPv6)', async () => {
    mocks.getWebAccessInfo.mockResolvedValue({
      ...runningInfo,
      configuredBind: '192.168.1.10',
      bindIsLoopback: false,
      configuredPort: 8765,
    })
    render()
    await flush()
    expect(addressInput().value).toBe('http://192.168.1.10:8765')

    mocks.getWebAccessInfo.mockResolvedValue({
      ...runningInfo,
      configuredBind: '::1',
      bindIsLoopback: true,
      configuredPort: 8765,
    })
    // A fresh mount seeds the IPv6 shape with its brackets.
    act(() => {
      root.unmount()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render()
    await flush()
    expect(addressInput().value).toBe('http://[::1]:8765')
  })

  it('the field is a plain text input with the default placeholder, autocomplete off', async () => {
    render()
    await flush()
    expect(addressInput().type).toBe('text')
    expect(addressInput().placeholder).toContain('http://127.0.0.1:8080')
    expect(addressInput().autocomplete).toBe('off')
  })

  it('refuses an invalid address locally without calling the RPC', async () => {
    render()
    await flush()
    typeInto(addressInput(), 'example.com:8080')
    blurField(addressInput())
    await flush()
    expect(byTestId('web-access-address-error')?.textContent).toContain('host:port')
    expect(mocks.setWebAccessConnection).not.toHaveBeenCalled()
  })

  it('accepts the https:// prefix (the scheme is display-only now) and still refuses out-of-range ports locally', async () => {
    render()
    await flush()
    typeInto(addressInput(), 'https://127.0.0.1:8080')
    pressEnter(addressInput())
    await flush()
    // The scheme travels as the parsed pair — the transport is the TLS switch.
    expect(byTestId('web-access-address-error')).toBeNull()
    expect(mocks.setWebAccessConnection).toHaveBeenCalledWith('127.0.0.1', 8080)

    typeInto(addressInput(), '127.0.0.1:70000')
    pressEnter(addressInput())
    await flush()
    expect(byTestId('web-access-address-error')?.textContent).toContain('1-65535')
    expect(mocks.setWebAccessConnection).toHaveBeenCalledTimes(1)
  })

  it('surfaces the backend failure message (including the rollback case)', async () => {
    mocks.setWebAccessConnection.mockRejectedValue(
      new Error('web access connection not applied: the previous settings were restored'),
    )
    render()
    await flush()
    typeInto(addressInput(), '127.0.0.1:9000')
    pressEnter(addressInput())
    await flush()
    expect(byTestId('web-access-address-error')?.textContent).toContain('previous settings were restored')
  })
})

describe('WebAccessSettings token (input under the address, commit on Enter/blur)', () => {
  beforeEach(() => {
    mocks.getWebAccessInfo.mockResolvedValue({ ...runningInfo, tokenPinned: true })
  })

  it('commits a typed custom token on Enter: the trimmed value travels, state re-reads', async () => {
    render()
    await flush()
    typeInto(tokenInput(), '  custom-token-123  ')
    pressEnter(tokenInput())
    await flush()
    expect(mocks.setWebAccessToken).toHaveBeenCalledWith('custom-token-123')
    expect(mocks.getWebAccessInfo).toHaveBeenCalledTimes(2)
  })

  it('commits on focus loss too', async () => {
    render()
    await flush()
    typeInto(tokenInput(), 'another-token-9')
    blurField(tokenInput())
    await flush()
    expect(mocks.setWebAccessToken).toHaveBeenCalledWith('another-token-9')
  })

  it('does not save an unchanged token (blur or Enter on the seeded field)', async () => {
    render()
    await flush()
    blurField(tokenInput())
    pressEnter(tokenInput())
    await flush()
    expect(mocks.setWebAccessToken).not.toHaveBeenCalled()
  })

  it('an emptied field reverts instead of clearing the credential', async () => {
    render()
    await flush()
    typeInto(tokenInput(), '')
    blurField(tokenInput())
    await flush()
    expect(mocks.setWebAccessToken).not.toHaveBeenCalled()
    expect(tokenInput().value).toBe(runningInfo.token)
    expect(byTestId('web-access-token-error')).toBeNull()
  })

  it('refuses a short token locally without calling the RPC', async () => {
    render()
    await flush()
    typeInto(tokenInput(), 'short')
    pressEnter(tokenInput())
    await flush()
    expect(byTestId('web-access-token-error')?.textContent).toContain('at least 8')
    expect(mocks.setWebAccessToken).not.toHaveBeenCalled()
  })

  it('surfaces the backend failure message (including the rollback case)', async () => {
    mocks.setWebAccessToken.mockRejectedValue(
      new Error('web access token change not applied: the previous token was restored'),
    )
    render()
    await flush()
    typeInto(tokenInput(), 'never-lands-123')
    pressEnter(tokenInput())
    await flush()
    expect(byTestId('web-access-token-error')?.textContent).toContain('previous token was restored')
  })

  it('is a monospace password input with autocomplete off', async () => {
    render()
    await flush()
    expect(tokenInput().type).toBe('password')
    expect(tokenInput().autocomplete).toBe('off')
    expect(tokenInput().classList.contains('font-mono')).toBe(true)
  })
})

describe('WebAccessSettings token regenerate', () => {
  function regenerateButton(): HTMLButtonElement {
    const el = byTestId('web-access-token-regenerate')
    if (!(el instanceof HTMLButtonElement)) throw new Error('regenerate button not found')
    return el
  }

  beforeEach(() => {
    mocks.getWebAccessInfo.mockResolvedValue({
      ...runningInfo,
      configuredPort: 0,
      tokenPinned: true,
    })
  })

  it('the rotation button sits next to the token input and mints through the RPC, re-reading state', async () => {
    render()
    await flush()
    expect(regenerateButton()).toBeTruthy()
    clickButton('web-access-token-regenerate')
    await flush()
    expect(mocks.regenerateWebAccessToken).toHaveBeenCalledTimes(1)
    // The authoritative state is re-read after the rotation.
    expect(mocks.getWebAccessInfo).toHaveBeenCalledTimes(2)
  })

  it('is disabled while the rotation is in flight', async () => {
    let resolveRegen!: () => void
    mocks.regenerateWebAccessToken.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRegen = resolve
        }),
    )
    render()
    await flush()
    clickButton('web-access-token-regenerate')
    expect(regenerateButton().disabled).toBe(true)
    await act(async () => {
      resolveRegen()
    })
    await flush()
    expect(regenerateButton().disabled).toBe(false)
  })

  it('surfaces the rotation failure next to the token field', async () => {
    mocks.regenerateWebAccessToken.mockRejectedValue(new Error('failed to persist web access config'))
    render()
    await flush()
    clickButton('web-access-token-regenerate')
    await flush()
    expect(byTestId('web-access-token-error')?.textContent).toContain('failed to persist')
  })

  it('no rotation button without a live token (nothing minted yet)', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(offInfo)
    render()
    await flush()
    expect(byTestId('web-access-token-regenerate')).toBeNull()
  })
})

describe('WebAccessSettings config warning banner refresh (ADR-100)', () => {
  it('fires onConfigChanged after a successful enable toggle', async () => {
    const onConfigChanged = vi.fn()
    mocks.getWebAccessInfo.mockResolvedValueOnce(offInfo).mockResolvedValueOnce(runningInfo)
    render(onConfigChanged)
    await flush()
    clickToggle()
    await flush()
    expect(mocks.setWebAccessEnabled).toHaveBeenCalledWith(true)
    expect(onConfigChanged).toHaveBeenCalledTimes(1)
  })

  it('does not fire onConfigChanged when the toggle RPC rejects', async () => {
    const onConfigChanged = vi.fn()
    mocks.getWebAccessInfo.mockResolvedValue(offInfo)
    mocks.setWebAccessEnabled.mockRejectedValue(new Error('persist failed'))
    render(onConfigChanged)
    await flush()
    clickToggle()
    await flush()
    expect(onConfigChanged).not.toHaveBeenCalled()
  })

  it('fires onConfigChanged after a committed address change, not for an unchanged field', async () => {
    const onConfigChanged = vi.fn()
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render(onConfigChanged)
    await flush()
    // Unchanged value: nothing saves, nothing fires.
    blurField(addressInput())
    await flush()
    expect(mocks.setWebAccessConnection).not.toHaveBeenCalled()
    expect(onConfigChanged).not.toHaveBeenCalled()
    // A real re-bind: the RPC travels and the banner refresh follows.
    typeInto(addressInput(), 'http://192.168.23.2:8765')
    pressEnter(addressInput())
    await flush()
    expect(mocks.setWebAccessConnection).toHaveBeenCalledWith('192.168.23.2', 8765)
    expect(onConfigChanged).toHaveBeenCalledTimes(1)
  })

  it('never fires onConfigChanged for token writes (they cannot move the warning)', async () => {
    const onConfigChanged = vi.fn()
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render(onConfigChanged)
    await flush()
    typeInto(tokenInput(), 'tok-0123456789abcdef')
    pressEnter(tokenInput())
    await flush()
    expect(mocks.setWebAccessToken).toHaveBeenCalled()
    expect(onConfigChanged).not.toHaveBeenCalled()
    clickButton('web-access-token-regenerate')
    await flush()
    expect(mocks.regenerateWebAccessToken).toHaveBeenCalled()
    expect(onConfigChanged).not.toHaveBeenCalled()
  })

  it('fires onConfigChanged after a successful TLS toggle from the child block', async () => {
    const onConfigChanged = vi.fn()
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render(onConfigChanged)
    await flush()
    const tlsToggle = container.querySelectorAll<HTMLInputElement>(
      '[data-testid="web-access-tls-block"] input[type="checkbox"]',
    )[0]
    if (!tlsToggle) throw new Error('TLS toggle not found')
    act(() => {
      tlsToggle.click()
    })
    await flush()
    expect(mocks.setWebAccessTLS).toHaveBeenCalledWith(true, '', '')
    expect(onConfigChanged).toHaveBeenCalledTimes(1)
  })
})
