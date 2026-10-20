// Tests for armWhenRuntimeReady — the shared readiness gate for app-global
// DOM triggers (window focus, tab visibility).
//
// The helper owns the transport-aware arming contract the focus/visibility
// hooks share:
//   - desktop ('wails'): isWailsReady() is synchronous, so attach happens
//     immediately at call time — no microtask, no probe round trip;
//   - web: attach waits for the transport probe to answer 'web' — the
//     `backend:ready` event cannot serve here (a desktop one-shot, emitted
//     before the sidecar even mounts, never replayed);
//   - 'none': never arm — nothing on this origin can serve the RPCs.
// plus the disposer contract: detach-once when armed, cancel-when-pending,
// safe to call twice.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { isWailsReadyMock, transportDetectionMock } = vi.hoisted(() => ({
  isWailsReadyMock: vi.fn((): boolean => false),
  transportDetectionMock: vi.fn((): Promise<'wails' | 'web' | 'none'> => Promise.resolve('web')),
}))

vi.mock('@/api/runtime', () => ({
  isWailsReady: isWailsReadyMock,
  transportDetection: transportDetectionMock,
}))

import { armWhenRuntimeReady } from './armWhenRuntimeReady'

/** A probe promise the test resolves by hand (mirrors the real round trip). */
function deferredTransport(): { promise: Promise<'wails' | 'web' | 'none'>; resolve: (mode: 'wails' | 'web' | 'none') => void } {
  let resolve!: (mode: 'wails' | 'web' | 'none') => void
  const promise = new Promise<'wails' | 'web' | 'none'>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Let the fire-and-forget probe .then() chain settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  isWailsReadyMock.mockReset().mockReturnValue(false)
  transportDetectionMock.mockReset().mockResolvedValue('web')
})

describe('armWhenRuntimeReady', () => {
  it('attaches synchronously on the desktop transport and never probes', () => {
    isWailsReadyMock.mockReturnValue(true)
    const detach = vi.fn()
    const attach = vi.fn(() => detach)

    const dispose = armWhenRuntimeReady(attach)

    // Synchronous: no microtask wait — the desktop bridge is detectable at
    // call time, so a mount-time arm never yields to the task queue.
    expect(attach).toHaveBeenCalledTimes(1)
    expect(transportDetectionMock).not.toHaveBeenCalled()

    dispose()
    expect(detach).toHaveBeenCalledTimes(1)
    dispose()
    // Idempotent disposer — the React effect cleanup may run twice (StrictMode).
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('attaches once the probe resolves web — not before', async () => {
    const probe = deferredTransport()
    transportDetectionMock.mockReturnValue(probe.promise)
    const attach = vi.fn(() => vi.fn())

    const dispose = armWhenRuntimeReady(attach)
    await flushMicrotasks()
    // The probe is still in flight: nothing armed yet.
    expect(attach).not.toHaveBeenCalled()

    probe.resolve('web')
    await flushMicrotasks()
    expect(attach).toHaveBeenCalledTimes(1)

    dispose()
  })

  it('never arms in the transportless none environment', async () => {
    transportDetectionMock.mockResolvedValue('none')
    const attach = vi.fn(() => vi.fn())

    const dispose = armWhenRuntimeReady(attach)
    await flushMicrotasks()

    // 'none' means nothing on this origin can serve RPCs (plain dev server,
    // vitest, SSR) — arming would only produce guaranteed no-op triggers.
    expect(attach).not.toHaveBeenCalled()
    dispose()
  })

  it('a dispose while the probe is pending cancels the arm for good', async () => {
    const probe = deferredTransport()
    transportDetectionMock.mockReturnValue(probe.promise)
    const attach = vi.fn(() => vi.fn())

    const dispose = armWhenRuntimeReady(attach)
    dispose()

    // The probe settles after teardown (an unmounted component) — the late
    // answer must not arm a dead host.
    probe.resolve('web')
    await flushMicrotasks()
    expect(attach).not.toHaveBeenCalled()
  })

  it('the web-path disposer detaches exactly once and is safe to call twice', async () => {
    const detach = vi.fn()
    const attach = vi.fn(() => detach)

    const dispose = armWhenRuntimeReady(attach)
    await flushMicrotasks()
    expect(attach).toHaveBeenCalledTimes(1)

    dispose()
    dispose()
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('arms on the async wails answer too (runtime seen mid-injection)', async () => {
    // isWailsReady() false at call time (a webview caught mid-injection, a
    // test fake), but the probe classifies the transport as 'wails' — the
    // same population the retired backend:ready fallback covered.
    isWailsReadyMock.mockReturnValue(false)
    transportDetectionMock.mockResolvedValue('wails')
    const attach = vi.fn(() => vi.fn())

    const dispose = armWhenRuntimeReady(attach)
    await flushMicrotasks()

    expect(attach).toHaveBeenCalledTimes(1)
    dispose()
  })
})
