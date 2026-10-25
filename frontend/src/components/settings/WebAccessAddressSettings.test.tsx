// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Spies created via vi.hoisted so they exist before vi.mock factories run.
const mocks = vi.hoisted(() => ({
  getWebAccessInfo: vi.fn(),
  setWebAccessConnection: vi.fn(),
  setWebAccessAllowInsecureLAN: vi.fn(),
}))

vi.mock('@/api/webAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/webAccess')>()),
  getWebAccessInfo: mocks.getWebAccessInfo,
  setWebAccessConnection: mocks.setWebAccessConnection,
  setWebAccessAllowInsecureLAN: mocks.setWebAccessAllowInsecureLAN,
}))

import { WebAccessAddressSettings } from './WebAccessAddressSettings'
import type { WebAccessInfo } from '@/api/webAccess'

function info(overrides: Partial<WebAccessInfo>): WebAccessInfo {
  return {
    enabled: true,
    running: true,
    url: 'http://127.0.0.1:8765',
    port: 8765,
    configuredBind: '127.0.0.1',
    configuredPort: 8765,
    bindIsLoopback: true,
    allowInsecureLAN: false,
    allowInsecureLANRequired: false,
    token: '',
    tokenPinned: true,
    tlsEnabled: false,
    tlsCert: '',
    tlsKey: '',
    certStatus: '',
    certDetail: '',
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

function render(section: WebAccessInfo, onInfo?: (i: WebAccessInfo | null) => void): void {
  act(() => {
    root.render(
      <WebAccessAddressSettings
        info={section}
        onInfo={onInfo ?? (() => {})}
        onConfigChanged={undefined}
      />,
    )
  })
}

function checkbox(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('[data-testid="web-access-insecure-lan-checkbox"]')
  if (!el) throw new Error('the opt-in checkbox is not rendered')
  return el
}

describe('WebAccessAddressSettings — the allow_insecure_lan opt-in', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mocks.getWebAccessInfo.mockReset()
    mocks.setWebAccessAllowInsecureLAN.mockReset()
    mocks.setWebAccessConnection.mockReset()
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('stays hidden for a loopback plaintext bind (nothing to opt into)', () => {
    render(info({}))
    expect(container.querySelector('[data-testid="web-access-insecure-lan"]')).toBeNull()
  })

  it('stays hidden for a TLS-encrypted non-loopback bind', () => {
    render(info({ configuredBind: '0.0.0.0', bindIsLoopback: false, tlsEnabled: true }))
    expect(container.querySelector('[data-testid="web-access-insecure-lan"]')).toBeNull()
  })

  it('renders when the pins require the opt-in, and mirrors the persisted flag', () => {
    render(info({ configuredBind: '0.0.0.0', bindIsLoopback: false, allowInsecureLANRequired: true }))
    expect(container.querySelector('[data-testid="web-access-insecure-lan"]')).not.toBeNull()
    expect(checkbox().checked).toBe(false)
  })

  it('a click writes the flag through the RPC and re-reads the authoritative state', async () => {
    const onInfo = vi.fn()
    mocks.setWebAccessAllowInsecureLAN.mockResolvedValue(undefined)
    mocks.getWebAccessInfo.mockResolvedValue(
      info({ configuredBind: '0.0.0.0', bindIsLoopback: false, allowInsecureLAN: true }),
    )
    render(info({ configuredBind: '0.0.0.0', bindIsLoopback: false, allowInsecureLANRequired: true }), onInfo)

    await act(async () => {
      checkbox().click()
    })

    expect(mocks.setWebAccessAllowInsecureLAN).toHaveBeenCalledWith(true)
    expect(onInfo).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ allowInsecureLAN: true, configuredBind: '0.0.0.0' }),
    )
  })

  it('a refused write surfaces the backend message in the shared error slot', async () => {
    mocks.setWebAccessAllowInsecureLAN.mockRejectedValue(
      new Error('web_access: bind "0.0.0.0" is not loopback and tls is off — … allow_insecure_lan: true …'),
    )
    render(info({ configuredBind: '0.0.0.0', bindIsLoopback: false, allowInsecureLAN: true }))

    await act(async () => {
      checkbox().click()
    })

    const err = container.querySelector('[data-testid="web-access-address-error"]')
    expect(err?.textContent).toContain('allow_insecure_lan')
  })
})
