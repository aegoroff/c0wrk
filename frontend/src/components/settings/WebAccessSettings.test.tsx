// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Spies created via vi.hoisted so they exist before vi.mock factories run.
const mocks = vi.hoisted(() => ({
  getWebAccessInfo: vi.fn(),
  setWebAccessEnabled: vi.fn(),
  setWebAccessConnection: vi.fn(),
  clipboardSetText: vi.fn(),
}))

vi.mock('@/api/webAccess', () => ({
  getWebAccessInfo: mocks.getWebAccessInfo,
  setWebAccessEnabled: mocks.setWebAccessEnabled,
  setWebAccessConnection: mocks.setWebAccessConnection,
}))

vi.mock('@/api/runtime', () => ({
  clipboardSetText: mocks.clipboardSetText,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { WebAccessSettings } from './WebAccessSettings'

const runningInfo = {
  enabled: true,
  running: true,
  url: 'http://127.0.0.1:8765',
  port: 8765,
  token: 'tok-abcdef0123456789',
}
const offInfo = { enabled: false, running: false, url: '', port: 0, token: '' }

let container: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(<WebAccessSettings />)
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

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getWebAccessInfo.mockResolvedValue(offInfo)
  mocks.setWebAccessEnabled.mockResolvedValue(undefined)
  mocks.setWebAccessConnection.mockResolvedValue(undefined)
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
    expect(byTestId('web-access-url-row')).toBeNull()
    expect(byTestId('web-access-token-row')).toBeNull()
    expect(byTestId('web-access-warning')).toBeNull()
    expect(byTestId('web-access-status')?.textContent).toContain('Off')
  })

  it('renders the running state: URL row, masked token, full-control warning', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render()
    await flush()
    expect(toggleInput().checked).toBe(true)
    expect(byTestId('web-access-url-row')?.textContent).toContain('http://127.0.0.1:8765')
    // The token is masked on screen: the raw value never lands in the DOM.
    expect(container.textContent).not.toContain(runningInfo.token)
    expect(byTestId('web-access-token-row')?.textContent).toContain('••••')
    expect(byTestId('web-access-warning')?.textContent).toContain('full control')
  })

  it('reveals and re-hides the token on demand', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(runningInfo)
    render()
    await flush()
    clickButton('web-access-reveal')
    await flush()
    expect(byTestId('web-access-token-row')?.textContent).toContain(runningInfo.token)
    clickButton('web-access-reveal')
    await flush()
    expect(byTestId('web-access-token-row')?.textContent).not.toContain(runningInfo.token)
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

  it('enabling calls the toggle RPC and adopts the re-read authoritative state', async () => {
    mocks.getWebAccessInfo.mockResolvedValueOnce(offInfo).mockResolvedValueOnce(runningInfo)
    render()
    await flush()
    clickToggle()
    await flush()
    expect(mocks.setWebAccessEnabled).toHaveBeenCalledWith(true)
    // The post-toggle re-read, not a local derivation, feeds the display.
    expect(mocks.getWebAccessInfo).toHaveBeenCalledTimes(2)
    expect(byTestId('web-access-url-row')?.textContent).toContain('http://127.0.0.1:8765')
    expect(byTestId('web-access-warning')).not.toBeNull()
  })

  it('rolls the toggle back when the RPC rejects', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(offInfo)
    mocks.setWebAccessEnabled.mockRejectedValue(new Error('persist failed'))
    render()
    await flush()
    clickToggle()
    await flush()
    expect(toggleInput().checked).toBe(false)
    expect(byTestId('web-access-url-row')).toBeNull()
  })

  it('renders the unavailable state and disables the toggle when the bridge fails', async () => {
    mocks.getWebAccessInfo.mockResolvedValue(null)
    render()
    await flush()
    expect(toggleInput().disabled).toBe(true)
    expect(byTestId('web-access-status')?.textContent).toContain('unavailable')
    expect(byTestId('web-access-warning')).toBeNull()
  })

  it('hides the credential rows when enabled but not running', async () => {
    mocks.getWebAccessInfo.mockResolvedValue({ ...offInfo, enabled: true })
    render()
    await flush()
    expect(toggleInput().checked).toBe(true)
    expect(byTestId('web-access-url-row')).toBeNull()
    expect(byTestId('web-access-token-row')).toBeNull()
    expect(byTestId('web-access-warning')?.textContent).toContain('full control')
    expect(byTestId('web-access-status')?.textContent).toContain('not running')
  })
})

describe('WebAccessSettings pin (fixed port & token)', () => {
  function pinPort(): HTMLInputElement {
    const el = byTestId('web-access-pin-port')
    if (!(el instanceof HTMLInputElement)) throw new Error('pin port input not found')
    return el
  }
  function pinToken(): HTMLInputElement {
    const el = byTestId('web-access-pin-token')
    if (!(el instanceof HTMLInputElement)) throw new Error('pin token input not found')
    return el
  }
  function typeInto(input: HTMLInputElement, value: string): void {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(input, value)
      else input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(() => {
    mocks.getWebAccessInfo.mockResolvedValue({
      ...runningInfo,
      configuredPort: 0,
      tokenPinned: false,
    })
  })

  it('applies the drafts: port and token travel, state re-reads, draft clears', async () => {
    render()
    await flush()
    typeInto(pinPort(), '9000')
    typeInto(pinToken(), ' fixed-secret ')
    clickButton('web-access-pin-apply')
    await flush()
    expect(mocks.setWebAccessConnection).toHaveBeenCalledWith(9000, 'fixed-secret')
    // The authoritative state is re-read after the apply.
    expect(mocks.getWebAccessInfo).toHaveBeenCalledTimes(2)
    // A typed secret never lingers on screen.
    expect(pinToken().value).toBe('')
  })

  it('empty drafts mean auto port + ephemeral token (the zero values)', async () => {
    render()
    await flush()
    clickButton('web-access-pin-apply')
    await flush()
    expect(mocks.setWebAccessConnection).toHaveBeenCalledWith(0, '')
  })

  it('seeds the port draft from the persisted pin', async () => {
    mocks.getWebAccessInfo.mockResolvedValue({ ...runningInfo, configuredPort: 8765 })
    render()
    await flush()
    expect(pinPort().value).toBe('8765')
  })

  it('refuses an out-of-range port locally without calling the RPC', async () => {
    render()
    await flush()
    typeInto(pinPort(), '70000')
    clickButton('web-access-pin-apply')
    await flush()
    expect(byTestId('web-access-pin-error')?.textContent).toContain('1–65535')
    expect(mocks.setWebAccessConnection).not.toHaveBeenCalled()
  })

  it('surfaces the backend failure message (including the rollback case)', async () => {
    mocks.setWebAccessConnection.mockRejectedValue(
      new Error('web access connection not applied: the previous settings were restored'),
    )
    render()
    await flush()
    typeInto(pinPort(), '9000')
    clickButton('web-access-pin-apply')
    await flush()
    expect(byTestId('web-access-pin-error')?.textContent).toContain('previous settings were restored')
  })

  it('the token draft is a password field', async () => {
    render()
    await flush()
    expect(pinToken().type).toBe('password')
  })
})
