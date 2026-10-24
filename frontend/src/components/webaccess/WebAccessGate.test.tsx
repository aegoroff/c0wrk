// @vitest-environment jsdom
//
// Tests for the web-access login gate (ADR-098): the SPA-side half of the
// sidecar's token↔cookie exchange. Covers the gate's transport rules —
// children render untouched for a non-web (or authenticated) origin, the
// token form replaces the app when the bootstrap probe reports no session,
// a mid-session 401 locks the screen live — and the form's contract: an
// empty token is refused locally, a rejected login surfaces the server's
// actionable message, a successful login reloads the page so every store,
// the transport probe and the websocket boot authenticated.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

const { webAuthRequiredMock, loginMock, authListeners, transportSnapshotMock } = vi.hoisted(() => ({
  webAuthRequiredMock: vi.fn<() => Promise<boolean>>(),
  loginMock: vi.fn<(token: string) => Promise<void>>(),
  authListeners: new Set<() => void>(),
  transportSnapshotMock: vi.fn<() => 'wails' | 'web' | 'none' | 'pending'>(),
}))

vi.mock('@/api/runtime', () => ({
  webAuthRequired: webAuthRequiredMock,
  onWebAuthRequired: (callback: () => void) => {
    authListeners.add(callback)
    return () => {
      authListeners.delete(callback)
    }
  },
  transportSnapshot: transportSnapshotMock,
}))

vi.mock('@/api/webAccess', () => ({
  webAccessLogin: loginMock,
}))

const reloadSpy = vi.hoisted(() => vi.fn())

vi.mock('@/lib/reload', () => ({
  reloadPage: reloadSpy,
}))

import { WebAccessGate } from './WebAccessGate'
import { useUIStore } from '@/stores/uiStore'

function findInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Access token"]')
  expect(input).not.toBeNull()
  return input as HTMLInputElement
}

function findSubmit(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('button[type="submit"]')
  expect(button).not.toBeNull()
  return button as HTMLButtonElement
}

function findAlert(): string | null {
  return document.querySelector('[role="alert"]')?.textContent ?? null
}

/** Type into a controlled input the way a real keystroke reaches React:
 *  assign through the NATIVE value setter (bypassing React's value tracker,
 *  which would dedupe a plain `.value =` write) and dispatch an input event. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Submit the form the way the submit button would: a cancelable bubbling
 *  submit event (jsdom does not perform implicit submission on click). */
function submitForm(): void {
  const form = document.querySelector('form')
  expect(form).not.toBeNull()
  form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

describe('WebAccessGate', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.replaceChildren(container)
    root = createRoot(container)
    authListeners.clear()
    useUIStore.setState({ tabsEnabled: false })
    webAuthRequiredMock.mockReset().mockResolvedValue(false)
    // Default: probe unresolved — the gate must hold the app on the spinner
    // (the load-bearing 'checking' state) until webAuthRequired settles.
    transportSnapshotMock.mockReset().mockReturnValue('pending')
    loginMock.mockReset().mockResolvedValue(undefined)
    reloadSpy.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  async function render(children: ReactNode = <div data-testid="app">app</div>) {
    await act(async () => {
      root.render(<WebAccessGate>{children}</WebAccessGate>)
      await Promise.resolve()
    })
    await act(async () => {})
  }

  async function renderLocked() {
    webAuthRequiredMock.mockResolvedValue(true)
    await render()
  }

  it('renders children untouched for a non-web (or authenticated) origin', async () => {
    await render()
    expect(document.querySelector('[data-testid="app"]')).not.toBeNull()
    expect(document.querySelector('input[aria-label="Access token"]')).toBeNull()
    expect(webAuthRequiredMock).toHaveBeenCalledTimes(1)
  })

  it('mounts the app synchronously when the transport is already wails', () => {
    // The desktop window never waits: the initial state callable reads the
    // 'wails' snapshot and renders children on the very first render, with
    // no probe round trip and no spinner flash.
    transportSnapshotMock.mockReturnValue('wails')
    act(() => {
      root.render(<WebAccessGate><div data-testid="app">app</div></WebAccessGate>)
    })
    expect(document.querySelector('[data-testid="app"]')).not.toBeNull()
    expect(document.querySelector('.animate-spin')).toBeNull()
  })

  it('holds the app on the probe spinner while the transport is unresolved', async () => {
    // THE regression this gate exists for: a mount-time RPC that beats the
    // web-transport probe throws "Wails App bindings are not available" and
    // kills App.tsx's one-shot startup safety nets — the tab strands on the
    // splash forever. The app must not mount until the probe settles.
    transportSnapshotMock.mockReturnValue('pending')
    let resolveAuth!: (value: boolean) => void
    webAuthRequiredMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveAuth = resolve
      }),
    )
    await act(async () => {
      root.render(<WebAccessGate><div data-testid="app">app</div></WebAccessGate>)
      await Promise.resolve()
    })

    expect(document.querySelector('[data-testid="app"]')).toBeNull()
    expect(document.querySelector('.animate-spin')).not.toBeNull()
    expect(document.querySelector('input[aria-label="Access token"]')).toBeNull()

    // Settling to "web, no session" swaps the hold screen for the login form.
    await act(async () => {
      resolveAuth(true)
      await Promise.resolve()
    })
    expect(document.querySelector('.animate-spin')).toBeNull()
    expect(findInput()).not.toBeNull()
  })

  it('replaces the app with the token form when the probe reports no session', async () => {
    await renderLocked()
    expect(document.querySelector('[data-testid="app"]')).toBeNull()
    expect(findInput()).not.toBeNull()
    expect(findSubmit().textContent).toBe('Sign in')
  })

  it('refuses an empty token locally without calling the login endpoint', async () => {
    await renderLocked()
    await act(async () => {
      submitForm()
      await Promise.resolve()
    })
    expect(findAlert()).toBe('Enter the access token.')
    expect(loginMock).not.toHaveBeenCalled()
  })

  it('surfaces the wrong-token error and keeps the form interactive', async () => {
    loginMock.mockRejectedValue(new Error('Wrong token — copy it from Settings → Web Access.'))
    await renderLocked()
    await act(async () => {
      typeInto(findInput(), 'bad-token')
      submitForm()
      await Promise.resolve()
    })
    expect(loginMock).toHaveBeenCalledWith('bad-token')
    expect(findAlert()).toBe('Wrong token — copy it from Settings → Web Access.')
    // The form recovered for the next attempt, and no reload happened.
    expect(findSubmit().disabled).toBe(false)
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('reloads the page once on a successful login', async () => {
    await renderLocked()
    await act(async () => {
      typeInto(findInput(), ' good-token ')
      submitForm()
      await Promise.resolve()
    })
    // The token is trimmed before it travels.
    expect(loginMock).toHaveBeenCalledWith('good-token')
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('locks live when a mid-session 401 fires on an open tab', async () => {
    await render()
    expect(document.querySelector('[data-testid="app"]')).not.toBeNull()
    await act(async () => {
      for (const callback of Array.from(authListeners)) callback()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="app"]')).toBeNull()
    expect(findInput()).not.toBeNull()
  })

  it('forces the workspace tab bar off when the transport is web', async () => {
    // The browser owns the tabs: the gate flips uiStore.tabsEnabled to false
    // before the app mounts (the 'checking' hold guarantees the order), so
    // the tab layer degenerates to its single-tab special case.
    transportSnapshotMock.mockReturnValue('web')
    useUIStore.setState({ tabsEnabled: true })
    await render(<div data-testid="app">app</div>)
    expect(useUIStore.getState().tabsEnabled).toBe(false)
    expect(document.querySelector('[data-testid="app"]')).not.toBeNull()
  })

  it('leaves tabsEnabled alone for non-web transports', async () => {
    transportSnapshotMock.mockReturnValue('none')
    useUIStore.setState({ tabsEnabled: true })
    await render(<div data-testid="app">app</div>)
    expect(useUIStore.getState().tabsEnabled).toBe(true)
  })
})
