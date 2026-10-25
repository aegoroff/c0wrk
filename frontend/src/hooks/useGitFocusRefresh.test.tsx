// Tests for useGitFocusRefresh — the window-focus trigger of git auto-fetch.
//
// The hook is isolated by mocking its two collaborators:
//   - @/api/git.requestRemoteRefresh: the RPC wrapper (the API boundary has
//     its own tests; here we only assert the hook calls it);
//   - @/api/runtime: isWailsReady/transportDetection/subscribe are replaced
//     so a test can control transport readiness (the arming gate is the
//     shared armWhenRuntimeReady helper).
//
// Key contract under test: the hook itself does NO gating — every focus
// event sends one RPC, and the min-interval / auto_fetch / project gates
// are enforced server-side (covered by the Go tests for
// FrontendAPI.autoFetchOnce). No @testing-library/react in this repo;
// createRoot + jsdom pattern (see useFileDrop.test.tsx).

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { refreshSpy, readyRegistry, wailsReady, transportResult, transportDetectionSpy } = vi.hoisted(() => {
  const transportResult = { value: Promise.resolve<'wails' | 'web' | 'none'>('web') }
  return {
    refreshSpy: vi.fn<() => Promise<void>>(),
    readyRegistry: new Map<string, Array<() => void>>(),
    wailsReady: { value: true },
    transportResult,
    transportDetectionSpy: vi.fn((): Promise<'wails' | 'web' | 'none'> => transportResult.value),
  }
})

vi.mock('@/api/git', () => ({
  requestRemoteRefresh: refreshSpy,
}))

vi.mock('@/api/runtime', () => ({
  isWailsReady: () => wailsReady.value,
  transportDetection: transportDetectionSpy,
  subscribe: (event: string, cb: () => void) => {
    const list = readyRegistry.get(event) ?? []
    list.push(cb)
    readyRegistry.set(event, list)
    return () => {
      readyRegistry.set(event, (readyRegistry.get(event) ?? []).filter((c) => c !== cb))
    }
  },
}))

import { useGitFocusRefresh } from '@/hooks/useGitFocusRefresh'

/** Swap in a probe promise the test resolves by hand. */
function pendingTransport(): (mode: 'wails' | 'web' | 'none') => void {
  let resolve!: (mode: 'wails' | 'web' | 'none') => void
  transportResult.value = new Promise<'wails' | 'web' | 'none'>((res) => {
    resolve = res
  })
  return resolve
}

/** Let the fire-and-forget probe .then() chain settle (outside fake timers). */
async function flushProbe(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function Harness() {
  useGitFocusRefresh()
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  // Unmount any component left mounted by a previous test so listeners
  // never leak between tests.
  act(() => { root?.unmount() })

  readyRegistry.clear()
  refreshSpy.mockReset()
  refreshSpy.mockResolvedValue(undefined)
  wailsReady.value = true
  transportResult.value = Promise.resolve('web')
  transportDetectionSpy.mockClear()

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

function mount(): void {
  act(() => {
    root?.render(<Harness />)
  })
}

function dispatchFocus(): void {
  window.dispatchEvent(new Event('focus'))
}

describe('useGitFocusRefresh', () => {
  it('calls requestRemoteRefresh exactly once on window focus', () => {
    mount()

    act(() => { dispatchFocus() })

    expect(refreshSpy).toHaveBeenCalledOnce()
  })

  it('unsubscribes on unmount (repeated focus after teardown never calls the API)', () => {
    mount()
    act(() => { dispatchFocus() })
    expect(refreshSpy).toHaveBeenCalledTimes(1)

    act(() => { root?.unmount() })
    act(() => { dispatchFocus() })
    act(() => { dispatchFocus() })

    // Still exactly the one pre-unmount call.
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  it('sends one RPC per focus event — no client-side throttle (the 60s min-interval is a server gate)', () => {
    mount()

    act(() => {
      dispatchFocus()
      dispatchFocus()
      dispatchFocus()
    })

    // The hook must not deduplicate: the backend decides which request
    // results in an actual fetch.
    expect(refreshSpy).toHaveBeenCalledTimes(3)
  })

  it('attaches synchronously on the desktop transport — the probe is never consulted', () => {
    mount()

    act(() => { dispatchFocus() })
    expect(refreshSpy).toHaveBeenCalledOnce()

    // isWailsReady() short-circuits: no transport round trip, no event
    // subscription — the desktop arms at mount.
    expect(transportDetectionSpy).not.toHaveBeenCalled()
    expect(readyRegistry.get('backend:ready')).toBeUndefined()
  })

  it('does not attach while the transport probe is pending; arms once it resolves web', async () => {
    wailsReady.value = false
    const resolveTransport = pendingTransport()
    mount()

    // A web tab during the probe round trip: focus fires but nothing can
    // serve the RPC yet — no call.
    act(() => { dispatchFocus() })
    expect(refreshSpy).not.toHaveBeenCalled()

    // The probe answers 'web' → the listener arms.
    await flushProbe()
    act(() => { resolveTransport('web') })
    await flushProbe()

    act(() => { dispatchFocus() })
    expect(refreshSpy).toHaveBeenCalledOnce()

    // The arming never leaned on `backend:ready` — that event is a desktop
    // one-shot (emitted once at startup, before the sidecar even mounts,
    // never replayed), so a late-joining tab would stay disarmed forever.
    expect(readyRegistry.get('backend:ready')).toBeUndefined()
  })

  it('never arms in the transportless none environment', async () => {
    wailsReady.value = false
    const resolveTransport = pendingTransport()
    mount()

    act(() => { resolveTransport('none') })
    await flushProbe()

    act(() => { dispatchFocus() })
    act(() => { dispatchFocus() })
    expect(refreshSpy).not.toHaveBeenCalled()
  })
})
