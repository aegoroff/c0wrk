// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useState } from 'react'

const mocks = vi.hoisted(() => ({
  getWebAccessInfo: vi.fn(),
  setWebAccessTLS: vi.fn(),
  generateWebAccessCertificate: vi.fn(),
}))

vi.mock('@/api/webAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/webAccess')>()),
  getWebAccessInfo: mocks.getWebAccessInfo,
  setWebAccessTLS: mocks.setWebAccessTLS,
  generateWebAccessCertificate: mocks.generateWebAccessCertificate,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { WebAccessTLSSettings } from './WebAccessTLSSettings'
import type { WebAccessInfo } from '@/api/webAccess'

const plainInfo: WebAccessInfo = {
  enabled: true,
  running: true,
  url: 'http://127.0.0.1:8765',
  port: 8765,
  configuredPort: 8765,
  configuredBind: '127.0.0.1',
  bindIsLoopback: true,
  token: 'tok-abcdef0123456789',
  tokenPinned: true,
  tlsEnabled: false,
  tlsCert: '',
  tlsKey: '',
  certStatus: '',
  certDetail: '',
}

const httpsInfo: WebAccessInfo = {
  ...plainInfo,
  url: 'https://127.0.0.1:8765',
  tlsEnabled: true,
  tlsCert: '/home/z/.c0wrk/web-access.crt',
  tlsKey: '/home/z/.c0wrk/web-access.key',
  certStatus: 'ok',
}

let container: HTMLDivElement
let root: Root

/** The block renders under the parent's contract: onInfo(null) hides it. */
function Harness({ initial }: { initial: WebAccessInfo }) {
  const [info, setInfo] = useState<WebAccessInfo | null>(initial)
  if (info === null) return <p data-testid="tls-unmounted">unavailable</p>
  return <WebAccessTLSSettings info={info} onInfo={setInfo} />
}

function render(initial: WebAccessInfo): void {
  act(() => {
    root.render(<Harness initial={initial} />)
  })
}

async function flush(): Promise<void> {
  await act(async () => {})
}

function byTestId(id: string): Element | null {
  return container.querySelector(`[data-testid="${id}"]`)
}

function tlsToggle(): HTMLInputElement {
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  const input = inputs[inputs.length - 1]
  if (!input) throw new Error('tls toggle not found')
  return input
}

function certInput(): HTMLInputElement {
  const el = byTestId('web-access-cert-input')
  if (!(el instanceof HTMLInputElement)) throw new Error('cert input not found')
  return el
}

function generateButton(): HTMLButtonElement {
  const el = byTestId('web-access-cert-generate')
  if (!(el instanceof HTMLButtonElement)) throw new Error('generate button not found')
  return el
}

function clickToggle(): void {
  act(() => {
    tlsToggle().click()
  })
}

function clickGenerate(): void {
  act(() => {
    generateButton().click()
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
  mocks.getWebAccessInfo.mockResolvedValue(httpsInfo)
  mocks.setWebAccessTLS.mockResolvedValue(undefined)
  mocks.generateWebAccessCertificate.mockResolvedValue(undefined)
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

describe('WebAccessTLSSettings', () => {
  it('renders the unconfigured state: switch off, empty path field, no warning', async () => {
    render(plainInfo)
    await flush()
    expect(tlsToggle().checked).toBe(false)
    expect(container.textContent).toContain('Plain HTTP')
    expect(certInput().value).toBe('')
    expect(byTestId('web-access-cert-warning')).toBeNull()
    expect(byTestId('web-access-tls-error')).toBeNull()
  })

  it('renders the enabled state: switch on, seeded path, no warning for a good certificate', async () => {
    render(httpsInfo)
    await flush()
    expect(tlsToggle().checked).toBe(true)
    expect(container.textContent).toContain('HTTPS')
    expect(certInput().value).toBe('/home/z/.c0wrk/web-access.crt')
    expect(byTestId('web-access-cert-warning')).toBeNull()
  })

  it('toggles optimistically, persists through the RPC and adopts the re-read state', async () => {
    // The block itself never reads on mount (the parent does): the only
    // getWebAccessInfo call here is the post-write re-read.
    mocks.getWebAccessInfo.mockResolvedValue({ ...httpsInfo, tlsEnabled: true })
    render(plainInfo)
    await flush()
    clickToggle()
    await flush()
    expect(mocks.setWebAccessTLS).toHaveBeenCalledWith(true, '', '')
    // The authoritative state is re-read after the applied write.
    expect(mocks.getWebAccessInfo).toHaveBeenCalledTimes(1)
    expect(tlsToggle().checked).toBe(true)
  })

  it('threads the persisted key path through so the derivation never clobbers it', async () => {
    render(httpsInfo)
    await flush()
    clickToggle()
    await flush()
    expect(mocks.setWebAccessTLS).toHaveBeenCalledWith(
      false,
      '/home/z/.c0wrk/web-access.crt',
      '/home/z/.c0wrk/web-access.key',
    )
  })

  it('rolls the toggle back and surfaces the backend refusal (no cert configured)', async () => {
    mocks.setWebAccessTLS.mockRejectedValue(
      new Error(
        'web access TLS not applied: web_access: tls.cert is required when tls is enabled (generate a pair in Settings → Web Access or point cert/key at PEM files)',
      ),
    )
    render(plainInfo)
    await flush()
    clickToggle()
    await flush()
    expect(tlsToggle().checked).toBe(false)
    expect(byTestId('web-access-tls-error')?.textContent).toContain('tls.cert is required')
  })

  it('commits the certificate path on Enter with the key path riding along', async () => {
    render(httpsInfo)
    await flush()
    typeInto(certInput(), '/tmp/pair.pem')
    pressEnter(certInput())
    await flush()
    expect(mocks.setWebAccessTLS).toHaveBeenCalledWith(
      true,
      '/tmp/pair.pem',
      '/home/z/.c0wrk/web-access.key',
    )
    expect(mocks.getWebAccessInfo).toHaveBeenCalledTimes(1)
  })

  it('commits on focus loss, trims the paste artifacts, and saves nothing when unchanged', async () => {
    render(httpsInfo)
    await flush()
    typeInto(certInput(), '  /tmp/other.pem  ')
    // The post-commit re-read returns the NEWLY persisted path — the shape
    // the real backend answers with after a successful write.
    mocks.getWebAccessInfo.mockResolvedValueOnce({ ...httpsInfo, tlsCert: '/tmp/other.pem' })
    blurField(certInput())
    await flush()
    expect(mocks.setWebAccessTLS).toHaveBeenCalledWith(
      true,
      '/tmp/other.pem',
      '/home/z/.c0wrk/web-access.key',
    )

    blurField(certInput())
    pressEnter(certInput())
    await flush()
    expect(mocks.setWebAccessTLS).toHaveBeenCalledTimes(1)
  })

  it('surfaces a rejected path commit and keeps the draft', async () => {
    mocks.setWebAccessTLS.mockRejectedValue(
      new Error('web access TLS change not applied: the previous settings were restored'),
    )
    render(httpsInfo)
    await flush()
    typeInto(certInput(), '/tmp/broken.pem')
    pressEnter(certInput())
    await flush()
    expect(byTestId('web-access-tls-error')?.textContent).toContain('previous settings were restored')
  })

  it('generates the app-owned pair: busy button, RPC, re-read, error surfaced on failure', async () => {
    let resolveGen!: () => void
    mocks.generateWebAccessCertificate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveGen = resolve
        }),
    )
    render(httpsInfo)
    await flush()
    clickGenerate()
    expect(generateButton().disabled).toBe(true)
    expect(certInput().disabled).toBe(true)
    await act(async () => {
      resolveGen()
    })
    await flush()
    expect(mocks.generateWebAccessCertificate).toHaveBeenCalledTimes(1)
    expect(mocks.getWebAccessInfo).toHaveBeenCalledTimes(1)
    expect(generateButton().disabled).toBe(false)

    mocks.generateWebAccessCertificate.mockRejectedValue(
      new Error('failed to generate the web access certificate'),
    )
    clickGenerate()
    await flush()
    expect(byTestId('web-access-cert-error')?.textContent).toContain('failed to generate')
  })

  it('renders the backend cert warning verbatim for a non-ok status, and nothing for ok/empty', async () => {
    render({
      ...httpsInfo,
      certStatus: 'mismatch',
      certDetail: 'the certificate does not cover 192.0.2.1 — regenerate it (Generate below)',
    })
    await flush()
    const warning = byTestId('web-access-cert-warning')
    expect(warning?.textContent).toContain('does not cover 192.0.2.1')
    expect(warning?.textContent).toContain('regenerate')

    // A fresh mount: Harness state does not survive a re-render in place.
    act(() => {
      root.unmount()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render(plainInfo)
    await flush()
    expect(byTestId('web-access-cert-warning')).toBeNull()
  })

  it('falls back to a generic message when a non-ok status carries no detail', async () => {
    render({ ...httpsInfo, certStatus: 'unreadable', certDetail: '' })
    await flush()
    expect(byTestId('web-access-cert-warning')?.textContent).toContain('unreadable')
  })
})
