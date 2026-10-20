// @vitest-environment jsdom
// Tests for useUpdateChecker's startup-recovery path: the backend's startup
// auto-check emits update:available ~1s after backend readiness, which can
// race (and lose against) this hook's event subscription — the toast would be
// silently lost. The hook therefore pulls GetLastUpdateCheck on mount and on
// backend:ready so the cached check result surfaces regardless of event
// delivery timing.
//
// Follows the createRoot + jsdom harness pattern (see
// usePromptSuggestionsSync.test.tsx).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

const runtimeHandlers = vi.hoisted(() => new Map<string, Array<(data?: unknown) => void>>())
const getUpdateSettingsMock = vi.hoisted(() => vi.fn())
const getLastUpdateCheckMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/updater', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/updater')>()
  return {
    ...actual,
    getUpdateSettings: getUpdateSettingsMock,
    getLastUpdateCheck: getLastUpdateCheckMock,
    onUpdateAvailable: (cb: (data: unknown) => void) => {
      const list = runtimeHandlers.get('update:available') ?? []
      list.push(cb)
      runtimeHandlers.set('update:available', list)
      return () => {
        runtimeHandlers.set('update:available', (runtimeHandlers.get('update:available') ?? []).filter(fn => fn !== cb))
      }
    },
    onUpdateNone: () => () => {},
    onUpdateProgress: () => () => {},
    onUpdateDownloaded: () => () => {},
    onUpdateError: () => () => {},
  }
})

vi.mock('@/api/runtime', () => ({
  subscribe: (_event: string, cb: (data?: unknown) => void) => {
    const list = runtimeHandlers.get('backend:ready') ?? []
    list.push(cb)
    runtimeHandlers.set('backend:ready', list)
    return () => {
      runtimeHandlers.set('backend:ready', (runtimeHandlers.get('backend:ready') ?? []).filter(fn => fn !== cb))
    }
  },
}))

import { act } from 'react'
import { useUpdateChecker } from '@/hooks/useUpdateChecker'
import { useUpdateStore } from '@/stores/updateStore'
import type { UpdateInfo } from '@/api/updater'

function makeInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    available: true,
    current_version: 'v0.11.0',
    latest_version: 'v0.12.0',
    release_notes: 'notes',
    published_at: '2026-10-18T00:00:00Z',
    html_url: 'https://github.com/v0lka/c0wrk/releases/tag/v0.12.0',
    asset_name: 'c0wrk-desktop-macos-arm64.zip',
    ...overrides,
  }
}

function emitBackendReady(): void {
  for (const cb of runtimeHandlers.get('backend:ready') ?? []) cb()
}

// TestHost renders the hook through a component whose return type satisfies
// createElement (the hook itself returns void).
function TestHost(): null {
  useUpdateChecker()
  return null
}

async function mountHook(): Promise<{ unmount: () => void }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const unmount = () => {
    act(() => root.unmount())
    container.remove()
  }
  await act(async () => {
    root.render(createElement(TestHost))
  })
  return { unmount }
}

function resetStore(): void {
  useUpdateStore.setState({
    phase: 'idle',
    info: null,
    currentVersion: '',
    progress: null,
    errorMessage: null,
    isChecking: false,
    isDownloading: false,
  })
}

describe('useUpdateChecker — startup recovery via GetLastUpdateCheck', () => {
  let cleanup: (() => void) | undefined

  beforeEach(() => {
    runtimeHandlers.clear()
    resetStore()
    getUpdateSettingsMock.mockResolvedValue({ auto_check: true, skipped_version: '', current_version: 'v0.11.0', operator_enabled: true })
    getLastUpdateCheckMock.mockResolvedValue(null)
  })

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    runtimeHandlers.clear()
    resetStore()
  })

  it('surfaces a cached available update pulled on mount (event was lost)', async () => {
    getLastUpdateCheckMock.mockResolvedValue(makeInfo())
    await act(async () => {
      const h = await mountHook()
      cleanup = h.unmount
    })
    const { phase, info } = useUpdateStore.getState()
    expect(phase).toBe('available')
    expect(info?.latest_version).toBe('v0.12.0')
  })

  it('stays idle when the pull reports nothing pending', async () => {
    getLastUpdateCheckMock.mockResolvedValue(null)
    await act(async () => {
      const h = await mountHook()
      cleanup = h.unmount
    })
    expect(useUpdateStore.getState().phase).toBe('idle')
  })

  it('retries the pull on backend:ready after an initial failure', async () => {
    getLastUpdateCheckMock.mockRejectedValueOnce(new Error('backend not ready'))
    await act(async () => {
      const h = await mountHook()
      cleanup = h.unmount
    })
    expect(useUpdateStore.getState().phase).toBe('idle')

    await act(async () => {
      getLastUpdateCheckMock.mockResolvedValue(makeInfo())
      emitBackendReady()
    })
    const { phase, info } = useUpdateStore.getState()
    expect(phase).toBe('available')
    expect(info?.latest_version).toBe('v0.12.0')
  })

  it('does not clobber an in-flight download when the pull resolves late', async () => {
    await act(async () => {
      const h = await mountHook()
      cleanup = h.unmount
    })
    // A download started through the ordinary event path: phase downloading.
    act(() => {
      useUpdateStore.getState().onProgress(50, 100)
    })
    // A late startup pull resolves while the download is in flight.
    await act(async () => {
      getLastUpdateCheckMock.mockResolvedValue(makeInfo())
      emitBackendReady()
    })
    const { phase } = useUpdateStore.getState()
    expect(phase).toBe('downloading')
  })
})
