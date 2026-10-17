// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { logger } from '@/lib/logger'
import { createRoot, type Root } from 'react-dom/client'

// Spies created via vi.hoisted so they exist before the vi.mock factories run.
// Only the functions the component actually calls are mocked; the rest of each
// module surface stays absent per the project's partial-mock convention (see
// ModelConfigDialog.test).
const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setPromptSuggestionsEnabled: vi.fn(),
}))

vi.mock('@/api/config', () => ({
  getConfig: mocks.getConfig,
}))

vi.mock('@/api/suggestions', () => ({
  setPromptSuggestionsEnabled: mocks.setPromptSuggestionsEnabled,
}))

import { PromptSuggestionsSettings } from './PromptSuggestionsSettings'

let container: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(<PromptSuggestionsSettings />)
  })
}

/** Click the master toggle's hidden checkbox (the Toggle primitive's input). */
function toggleInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!input) throw new Error('toggle input not found')
  return input
}

async function flush(): Promise<void> {
  await act(async () => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  // nil default = on: a payload without the block reads as enabled.
  mocks.getConfig.mockResolvedValue({ loaded: true, prompt_suggestions: { enabled: true } })
  mocks.setPromptSuggestionsEnabled.mockResolvedValue(undefined)
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

describe('PromptSuggestionsSettings', () => {
  it('renders the toggle reflecting the config value (on)', async () => {
    render()
    await flush()
    expect(toggleInput().checked).toBe(true)
    expect(toggleInput().disabled).toBe(false)
    expect(container.textContent).toContain('Prompt Suggestions')
    expect(container.textContent).toContain('Enabled')
  })

  it('renders the toggle off when the config gate is explicitly false', async () => {
    mocks.getConfig.mockResolvedValue({ loaded: true, prompt_suggestions: { enabled: false } })
    render()
    await flush()
    expect(toggleInput().checked).toBe(false)
    expect(container.textContent).toContain('Disabled')
  })

  it('defaults to on when the payload predates the prompt_suggestions block', async () => {
    // The backend's nil default is ON; an older fixture without the block
    // must read as enabled, not as off.
    mocks.getConfig.mockResolvedValue({ loaded: true })
    render()
    await flush()
    expect(toggleInput().checked).toBe(true)
  })

  it('keeps the toggle disabled until the config read answers', () => {
    // getConfig intentionally left pending in this test: a never-resolving
    // promise keeps the read in flight, so the pre-answer disabled state is
    // asserted without any post-render state update escaping act().
    mocks.getConfig.mockReturnValue(new Promise(() => {}))
    render()
    expect(toggleInput().disabled).toBe(true)
    expect(toggleInput().checked).toBe(false)
  })

  it('toggling writes through the backend RPC and flips the control optimistically', async () => {
    mocks.getConfig.mockResolvedValue({ loaded: true, prompt_suggestions: { enabled: false } })
    render()
    await flush()

    await act(async () => {
      toggleInput().click()
    })
    await flush()

    expect(mocks.setPromptSuggestionsEnabled).toHaveBeenCalledTimes(1)
    expect(mocks.setPromptSuggestionsEnabled).toHaveBeenCalledWith(true)
    expect(toggleInput().checked).toBe(true)
    expect(container.textContent).toContain('Enabled')
  })

  it('rolls the control back when the backend rejects the write', async ({ onTestFinished }) => {
    // The rejection diagnostic (logger.error at the failure site) is
    // intercepted in the specific test that triggers it.
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    onTestFinished(() => logSpy.mockRestore())
    mocks.setPromptSuggestionsEnabled.mockRejectedValue(new Error('persist failed'))
    render()
    await flush()

    await act(async () => {
      toggleInput().click()
    })
    await flush()

    // The optimistic update must roll back to what the backend still holds.
    expect(toggleInput().checked).toBe(true)
    expect(container.textContent).toContain('Enabled')
    expect(logSpy).toHaveBeenCalledExactlyOnceWith(
      'Failed to toggle prompt suggestions:',
      new Error('persist failed'),
    )
  })

  it('disables the toggle while a write is in flight', async () => {
    let resolveWrite!: () => void
    mocks.setPromptSuggestionsEnabled.mockImplementation(
      () => new Promise<void>((res) => { resolveWrite = res }),
    )
    render()
    await flush()

    await act(async () => {
      toggleInput().click()
    })

    expect(mocks.setPromptSuggestionsEnabled).toHaveBeenCalledWith(false)
    expect(toggleInput().disabled).toBe(true)

    await act(async () => {
      resolveWrite()
    })
    await flush()

    expect(toggleInput().disabled).toBe(false)
    // The optimistic flip held through the successful write (on → off).
    expect(toggleInput().checked).toBe(false)
  })

  it('stays disabled and quiet when the config read fails', async ({ onTestFinished }) => {
    // The read-failure diagnostic (logger.warn at the failure site) is
    // intercepted in the specific test that triggers it.
    const logSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => logSpy.mockRestore())
    mocks.getConfig.mockRejectedValue(new Error('backend unavailable'))
    render()
    await flush()

    // Fail visible: no guessed state, no write path armed.
    expect(toggleInput().disabled).toBe(true)
    await act(async () => {
      toggleInput().click()
    })
    expect(mocks.setPromptSuggestionsEnabled).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledExactlyOnceWith(
      '[prompt-suggestions] gate read failed',
      new Error('backend unavailable'),
    )
  })
})
