// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateLLMConfig: vi.fn(),
  invalidateConfigCache: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@/api/config', () => ({
  getConfig: mocks.getConfig,
  updateLLMConfig: mocks.updateLLMConfig,
  MASKED_API_KEY: '***configured***',
}))
vi.mock('@/hooks/useConfigData', () => ({ invalidateConfigCache: mocks.invalidateConfigCache }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.loggerError },
}))

import { useLLMConfig, type ProviderConfig } from './useLLMConfig'

let container: HTMLDivElement
let root: Root
let result!: ReturnType<typeof useLLMConfig>

function HookHarness() {
  result = useLLMConfig()
  return null
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.updateLLMConfig.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('useLLMConfig default replacement', () => {
  it('holds provider edits locally until a replacement default produces one complete valid save', async () => {
    mocks.getConfig.mockResolvedValue({
      loaded: true,
      llm: {
        default_model: 'anthropic/old-model',
        anthropic: { api_key: '', models: ['old-model'] },
      },
    })

    act(() => root.render(<HookHarness />))
    await flush()

    expect(result.defaultModel).toBe('anthropic/old-model')
    act(() => result.toggleModel('anthropic', 'old-model'))
    expect(result.defaultModel).toBe('')
    expect(result.providerConfigs.anthropic?.models).toEqual([])

    // Enabling a model while default is empty auto-claims it as the default
    // and persists in one shot (first-run / recovery after clearing default).
    act(() => result.toggleModel('anthropic', 'new-model'))
    expect(result.providerConfigs.anthropic?.models).toEqual(['new-model'])
    expect(result.defaultModel).toBe('anthropic/new-model')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(mocks.updateLLMConfig).toHaveBeenCalledTimes(1)
    expect(mocks.updateLLMConfig).toHaveBeenCalledWith({
      default_model: 'anthropic/new-model',
      anthropic: { api_key: '', models: ['new-model'] },
      openai_compatible: {},
      anthropic_compatible: {},
    })
  })

  it('auto-sets default_model when enabling the first model with no default', async () => {
    mocks.getConfig.mockResolvedValue({
      loaded: true,
      llm: {
        default_model: '',
        anthropic: { api_key: '', models: [] },
        openai_compatible: {},
      },
    })

    act(() => root.render(<HookHarness />))
    await flush()
    expect(result.defaultModel).toBe('')

    act(() => result.addProvider('custom', {
      api_key: 'sk-test',
      base_url: 'https://api.example.com/v1',
      models: [],
      type: 'openai',
    }))
    act(() => result.toggleModel('custom', 'org/model-a'))

    expect(result.defaultModel).toBe('custom/org/model-a')
    expect(result.providerConfigs.custom?.models).toEqual(['org/model-a'])
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(mocks.updateLLMConfig).toHaveBeenCalledWith({
      default_model: 'custom/org/model-a',
      anthropic: { api_key: '', models: [] },
      openai_compatible: {
        custom: {
          api_key: 'sk-test',
          base_url: 'https://api.example.com/v1',
          models: ['org/model-a'],
        },
      },
      anthropic_compatible: {},
    })
  })
})

describe('useLLMConfig compatible provider deletion', () => {
  it('sends an explicit empty compatible map when the last provider is deleted', async () => {
    mocks.getConfig.mockResolvedValue({
      loaded: true,
      llm: {
        default_model: 'anthropic/default-model',
        anthropic: { api_key: '', models: ['default-model'] },
        openai_compatible: {
          custom: { api_key: '', base_url: 'http://localhost:1234', models: ['custom-model'] },
        },
      },
    })

    act(() => root.render(<HookHarness />))
    await flush()

    act(() => result.deleteProvider('custom'))
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(mocks.updateLLMConfig).toHaveBeenCalledWith({
      default_model: 'anthropic/default-model',
      anthropic: { api_key: '', models: ['default-model'] },
      openai_compatible: {},
      anthropic_compatible: {},
    })
  })
})

describe('useLLMConfig loading errors', () => {
  it('retains custom providers from a successful load when a repeated load errors', async () => {
    let rejectSecondLoad!: (reason?: unknown) => void
    mocks.getConfig
      .mockResolvedValueOnce({
        loaded: true,
        llm: {
          default_model: 'custom/model-a',
          openai_compatible: {
            custom: { api_key: '', base_url: 'http://localhost:1234', models: ['model-a'] },
          },
        },
      })
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectSecondLoad = reject }))

    act(() => root.render(<StrictMode><HookHarness /></StrictMode>))
    await flush()
    expect(result.openaiCompatibleProviderNames.has('custom')).toBe(true)

    await act(async () => { rejectSecondLoad(new Error('temporary config error')) })
    await flush()

    const custom: ProviderConfig | undefined = result.providerConfigs.custom
    expect(custom).toEqual({
      api_key: '',
      base_url: 'http://localhost:1234',
      models: ['model-a'],
      type: 'openai',
    })
    expect(result.openaiCompatibleProviderNames.has('custom')).toBe(true)
  })
})
