// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// --- Mock the backend boundary so tests never touch the Wails runtime ---
const { configMocks, onGlobalEventMock } = vi.hoisted(() => ({
  configMocks: {
    getConfig: vi.fn(),
  },
  // Typed to the real onGlobalEvent() signature (event name + handler) so
  // mockImplementation below type-checks under `tsc -b`.
  onGlobalEventMock: vi.fn((_name: string, _handler: () => void) => () => {}),
}))

vi.mock('@/api/config', () => ({ getConfig: configMocks.getConfig }))
vi.mock('@/api/runtime', () => ({ onGlobalEvent: onGlobalEventMock }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { useIndexingSettings } from './useIndexingSettings'
import { useIndexingSettingsStore } from '@/stores/indexingSettingsStore'
import type { ConfigResponse } from '@/types/models'

/**
 * Minimal valid ConfigResponse; the hook only reads loaded/vector_index.
 * `llm` and `proxy` are intentionally empty objects cast per-field — building
 * full provider/proxy structures would couple the test to unrelated shapes.
 */
function makeConfig(loaded: boolean, indexingEnabled: boolean | null): ConfigResponse {
  return {
    loaded,
    log_level: 'info',
    config_errors: [],
    llm: {} as ConfigResponse['llm'],
    search: { provider: '', api_key: '', base_url: '' },
    proxy: {} as ConfigResponse['proxy'],
    vector_index:
      indexingEnabled === null
        ? undefined // a config that predates the block entirely
        : { execution_provider: 'cpu', device_id: 0, enabled: indexingEnabled },
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

/** Handlers captured per event name (the hook subscribes to several). */
const capturedHandlers = new Map<string, () => void>()
onGlobalEventMock.mockImplementation((name: string, handler: () => void) => {
  capturedHandlers.set(name, handler)
  return () => {}
})

function Harness(): boolean {
  return useIndexingSettings()
}

function renderHook(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  act(() => {
    r.render(createElement(Harness))
  })
}

/** Let the fire-and-forget promise chain settle past the store writes. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function fireBackendReady(): void {
  act(() => {
    capturedHandlers.get('backend:ready')?.()
  })
}

function fireConfigUpdated(): void {
  act(() => {
    capturedHandlers.get('config:updated')?.()
  })
}

beforeEach(() => {
  configMocks.getConfig.mockReset()
  onGlobalEventMock.mockClear()
  capturedHandlers.clear()
  useIndexingSettingsStore.setState({ enabled: true, loaded: false })
})

afterEach(() => {
  if (root) {
    const r = root
    root = null
    act(() => {
      r.unmount()
    })
  }
  container?.remove()
  container = null
})

describe('useIndexingSettings', () => {
  it('latches the persisted switch on a normal (loaded) response', async () => {
    configMocks.getConfig.mockResolvedValue(makeConfig(true, false))

    renderHook()
    await flushMicrotasks()

    expect(useIndexingSettingsStore.getState().enabled).toBe(false)
    expect(useIndexingSettingsStore.getState().loaded).toBe(true)
    expect(configMocks.getConfig).toHaveBeenCalledTimes(1)
    // The hook subscribes to both retry triggers.
    expect(onGlobalEventMock).toHaveBeenCalledWith('backend:ready', expect.any(Function))
    expect(onGlobalEventMock).toHaveBeenCalledWith('config:updated', expect.any(Function))
  })

  it('reads an absent vector_index block as the resolved default (enabled)', async () => {
    configMocks.getConfig.mockResolvedValue(makeConfig(true, null))

    renderHook()
    await flushMicrotasks()

    expect(useIndexingSettingsStore.getState().enabled).toBe(true)
    expect(useIndexingSettingsStore.getState().loaded).toBe(true)
  })

  it('does NOT latch when the backend answers loaded=false during startup', async () => {
    // Startup race: GetConfig succeeds with a zeroed config while Startup is
    // still running. Latching here would flip the switch for the whole
    // session despite config.yaml saying enabled=false (or true).
    configMocks.getConfig.mockResolvedValue(makeConfig(false, true))

    renderHook()
    await flushMicrotasks()

    expect(useIndexingSettingsStore.getState().loaded).toBe(false)
    // The pre-load default is kept (on), not the zeroed answer.
    expect(useIndexingSettingsStore.getState().enabled).toBe(true)
    expect(configMocks.getConfig).toHaveBeenCalledTimes(1)
  })

  it('recovers via the backend:ready retry after a loaded=false first answer', async () => {
    configMocks.getConfig
      .mockResolvedValueOnce(makeConfig(false, false)) // startup race
      .mockResolvedValueOnce(makeConfig(true, false)) // config live after ready

    renderHook()
    await flushMicrotasks()
    expect(useIndexingSettingsStore.getState().loaded).toBe(false)

    fireBackendReady()
    await flushMicrotasks()

    expect(useIndexingSettingsStore.getState().enabled).toBe(false)
    expect(useIndexingSettingsStore.getState().loaded).toBe(true)
    expect(configMocks.getConfig).toHaveBeenCalledTimes(2)
  })

  it('recovers via config:updated when still not latched', async () => {
    // Residual case: both the mount fetch and the backend:ready retry
    // landed during the startup race, leaving the switch "unknown". The
    // next persisted config mutation emits config:updated, which re-reads
    // the now-live config without an app restart.
    configMocks.getConfig
      .mockResolvedValueOnce(makeConfig(false, true)) // startup race
      .mockResolvedValueOnce(makeConfig(false, true)) // post-ready still racing
      .mockResolvedValueOnce(makeConfig(true, false)) // config live after a settings save

    renderHook()
    await flushMicrotasks()

    fireBackendReady()
    await flushMicrotasks()
    expect(useIndexingSettingsStore.getState().loaded).toBe(false)

    fireConfigUpdated()
    await flushMicrotasks()

    expect(useIndexingSettingsStore.getState().enabled).toBe(false)
    expect(useIndexingSettingsStore.getState().loaded).toBe(true)
    expect(configMocks.getConfig).toHaveBeenCalledTimes(3)
  })

  it('does not re-fetch after the switch has latched (Settings keeps it in sync)', async () => {
    configMocks.getConfig.mockResolvedValue(makeConfig(true, true))

    renderHook()
    await flushMicrotasks()

    fireBackendReady()
    await flushMicrotasks()
    fireConfigUpdated()
    await flushMicrotasks()

    expect(configMocks.getConfig).toHaveBeenCalledTimes(1)
    expect(useIndexingSettingsStore.getState().loaded).toBe(true)
  })

  it('keeps the on default on a fetch error (surfaces stay visible, still retryable)', async () => {
    configMocks.getConfig.mockRejectedValue(new Error('backend gone'))

    renderHook()
    await flushMicrotasks()

    expect(useIndexingSettingsStore.getState().enabled).toBe(true)
    expect(useIndexingSettingsStore.getState().loaded).toBe(false)
  })
})
