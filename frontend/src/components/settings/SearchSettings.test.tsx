// @vitest-environment jsdom
// SearchSettings — the web-search provider / API-key panel.
//
// The API-key field is an explicit-commit field: keystrokes stay in a local
// draft (the stored key is invisible while masked, so an autosaved fragment
// could overwrite the real key) and only blur/Enter move the draft into the
// save flow, which persists behind a 500 ms debounce. A pending COMMITTED
// edit must still be FLUSHED when the panel unmounts (closing the settings
// dialog / switching tabs) instead of being silently discarded — the same
// hardening the ProxySettings / VectorIndexSettings siblings carry — and an
// UNCOMMITTED draft must never persist, not even via the flush.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const spies = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateSearchSettings: vi.fn<(req: unknown) => Promise<void>>(),
  updateIndexingSettings: vi.fn<(req: unknown) => Promise<void>>(),
  listVectorIndexGPUs: vi.fn<() => Promise<unknown[]>>(),
}))

vi.mock('@/api/config', () => ({
  getConfig: spies.getConfig,
  updateSearchSettings: spies.updateSearchSettings,
  updateIndexingSettings: spies.updateIndexingSettings,
  MASKED_API_KEY: '***configured***',
}))
// IndexingSettings (rendered above the provider section) embeds
// VectorIndexSettings, which probes the GPU list on mount on Linux hosts.
vi.mock('@/api/vector', () => ({
  listVectorIndexGPUs: spies.listVectorIndexGPUs,
}))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { SearchSettings } from './SearchSettings'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  spies.updateSearchSettings.mockResolvedValue(undefined)
  spies.updateIndexingSettings.mockResolvedValue(undefined)
  spies.listVectorIndexGPUs.mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

type SearchPayload = { provider: string; api_key: string; base_url?: string }

async function renderSearchSettings(search: SearchPayload) {
  spies.getConfig.mockResolvedValue({ search: { base_url: '', ...search } })
  await act(async () => {
    root.render(<SearchSettings />)
  })
}

/** The API-key text input (rendered as a password field for plain keys). */
function apiKeyInput(): HTMLInputElement {
  const input = container.querySelector('input[type="password"]')
  if (!input) throw new Error('api key input not found')
  return input as HTMLInputElement
}

/** The SearXNG instance-URL input (only rendered for the searxng provider). */
function searxngBaseUrlInput(): HTMLInputElement {
  const input = container.querySelector('[data-testid="searxng-base-url"]')
  if (!input) throw new Error('searxng base url input not found')
  return input as HTMLInputElement
}

/**
 * Type into a controlled input. React tracks the previous value on the DOM
 * node, so the native setter has to be used or the synthetic change event is
 * suppressed as a no-op (the repo idiom, see ProxySettings.test).
 */
function typeInto(input: HTMLInputElement, value: string) {
  const nativeInputSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set
  if (!nativeInputSetter) throw new Error('native input setter not found')
  act(() => {
    nativeInputSetter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('SearchSettings — explicit-commit debounced save', () => {
  /**
   * Move focus to the input and then away from it (React binds onBlur to the
   * delegated focusout; jsdom fires the native blur/focusout pair on .blur()).
   */
  function blurInput(input: HTMLInputElement) {
    act(() => {
      input.focus()
    })
    act(() => {
      input.blur()
    })
  }

  it('saves the API key only after the explicit commit (blur), through the 500 ms debounce', async () => {
    await renderSearchSettings({ provider: 'tavily', api_key: '' })

    typeInto(apiKeyInput(), 'sk-test')
    // Keystrokes NEVER schedule a save: the stored key is invisible while the
    // field is masked/empty, so autosaving per keystroke would persist a
    // half-typed fragment over the real key.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(spies.updateSearchSettings).not.toHaveBeenCalled()

    // The blur commit is the single point where a key edit becomes saveable;
    // from there it flows through the normal 500 ms debounce.
    blurInput(apiKeyInput())
    expect(spies.updateSearchSettings).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(spies.updateSearchSettings).toHaveBeenCalledTimes(1)
    expect(spies.updateSearchSettings).toHaveBeenCalledWith({
      provider: 'tavily',
      api_key: 'sk-test',
      base_url: '',
    })
  })

  it('commits the API key draft on Enter without a blur', async () => {
    await renderSearchSettings({ provider: 'tavily', api_key: '' })

    const input = apiKeyInput()
    typeInto(input, 'sk-test')
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(spies.updateSearchSettings).toHaveBeenCalledTimes(1)
    expect(spies.updateSearchSettings).toHaveBeenCalledWith({
      provider: 'tavily',
      api_key: 'sk-test',
      base_url: '',
    })
  })

  it('never persists an uncommitted half-typed API key on unmount', async () => {
    await renderSearchSettings({ provider: 'tavily', api_key: '***configured***' })

    // The user focuses the (empty-rendering, masked) key field and types a
    // fragment, then closes the dialog without ever leaving the field — no
    // blur, no Enter. The stored key must survive untouched.
    const input = apiKeyInput()
    act(() => {
      input.focus()
    })
    typeInto(input, 'sk-tes')
    expect(spies.updateSearchSettings).not.toHaveBeenCalled()

    act(() => {
      root.unmount()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(spies.updateSearchSettings).not.toHaveBeenCalled()
  })

  it('blur without an edit commits nothing over a masked stored key', async () => {
    await renderSearchSettings({ provider: 'tavily', api_key: '***configured***' })

    // Focus clears the input for a fresh value; leaving without typing must
    // not schedule a save (an empty draft maps back to the masked sentinel,
    // which would only re-send the existing state anyway).
    blurInput(apiKeyInput())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(spies.updateSearchSettings).not.toHaveBeenCalled()
  })

  it('flushes a committed pending edit on unmount instead of discarding it', async () => {
    await renderSearchSettings({ provider: 'tavily', api_key: '' })

    typeInto(apiKeyInput(), 'sk-test')
    blurInput(apiKeyInput())
    expect(spies.updateSearchSettings).not.toHaveBeenCalled()

    // Close the settings dialog BEFORE the debounce window elapses — the
    // committed edit must be flushed, not cancelled (a cancelled edit is
    // lost with no error surfaced anywhere).
    act(() => {
      root.unmount()
    })

    expect(spies.updateSearchSettings).toHaveBeenCalledTimes(1)
    expect(spies.updateSearchSettings).toHaveBeenCalledWith({
      provider: 'tavily',
      api_key: 'sk-test',
      base_url: '',
    })

    // The abandoned timer must not produce a duplicate save afterwards.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(spies.updateSearchSettings).toHaveBeenCalledTimes(1)
  })

  it('does not fire a save on unmount when nothing is pending', async () => {
    await renderSearchSettings({ provider: 'tavily', api_key: '' })

    act(() => {
      root.unmount()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(spies.updateSearchSettings).not.toHaveBeenCalled()
  })
})

describe('SearchSettings — SearXNG instance URL', () => {
  /** Blur + focus pair for the explicit-commit inputs (see the sibling helper). */
  function blurInput(input: HTMLInputElement) {
    act(() => {
      input.focus()
    })
    act(() => {
      input.blur()
    })
  }

  it('renders the instance-URL input only for the searxng provider', async () => {
    await renderSearchSettings({ provider: 'searxng', api_key: '', base_url: 'http://10.0.0.5:8888' })
    expect(searxngBaseUrlInput().value).toBe('http://10.0.0.5:8888')

    // The panel remounts per render call in this suite; assert the absence
    // for a key-bearing provider with a fresh mount.
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    await renderSearchSettings({ provider: 'tavily', api_key: '' })
    expect(() => searxngBaseUrlInput()).toThrow()
  })

  it('saves the instance URL only after the explicit commit (blur), through the 500 ms debounce', async () => {
    await renderSearchSettings({ provider: 'searxng', api_key: '', base_url: '' })

    typeInto(searxngBaseUrlInput(), 'http://10.0.0.5:8888')
    // Keystrokes never schedule a save — a half-typed URL must not be
    // autosaved and rejected by the backend validation mid-typing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(spies.updateSearchSettings).not.toHaveBeenCalled()

    blurInput(searxngBaseUrlInput())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(spies.updateSearchSettings).toHaveBeenCalledTimes(1)
    expect(spies.updateSearchSettings).toHaveBeenCalledWith({
      provider: 'searxng',
      api_key: '',
      base_url: 'http://10.0.0.5:8888',
    })
  })

  it('never persists an uncommitted half-typed instance URL on unmount', async () => {
    await renderSearchSettings({ provider: 'searxng', api_key: '', base_url: '' })

    const input = searxngBaseUrlInput()
    act(() => {
      input.focus()
    })
    typeInto(input, 'http://10.0.0.')
    expect(spies.updateSearchSettings).not.toHaveBeenCalled()

    act(() => {
      root.unmount()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(spies.updateSearchSettings).not.toHaveBeenCalled()
  })
})

describe('SearchSettings — provider guidance copy', () => {
  it('warns when the best-effort DuckDuckGo provider is selected', async () => {
    await renderSearchSettings({ provider: 'duckduckgo', api_key: '' })
    const text = container.textContent ?? ''
    expect(text).toContain('best-effort')
    expect(text).toContain('anti-bot')
    expect(text).toContain('API-backed provider')
  })

  it('states the API-backed recommendation without the DDG warning for API providers', async () => {
    await renderSearchSettings({ provider: 'tavily', api_key: '' })
    const text = container.textContent ?? ''
    // The recommendation is always present...
    expect(text).toContain('Recommended: an API-backed provider')
    // ...but the DDG-specific warning only renders for duckduckgo.
    expect(text).not.toContain('best-effort scraper')
  })
})

describe('SearchSettings — section heading', () => {
  it('renders the picker under the shared section heading: Globe icon + Web Search Provider', async () => {
    await renderSearchSettings({ provider: 'tavily', api_key: '' })

    const heading = [...container.querySelectorAll('label')].find((el) =>
      (el.textContent ?? '').includes('Web Search Provider'),
    )
    expect(heading).toBeTruthy()
    // Shared settings-heading idiom — a muted lucide icon next to
    // text-sm font-medium text (see "Default Model" in LLMSettings and
    // the section headers in SettingsModal; the Globe is the same web
    // glyph "HTTP Proxy" carries). The old variant was a bare
    // text-xs text-muted-foreground label with no icon.
    expect(heading!.querySelector('svg.lucide-globe')).not.toBeNull()
    expect(heading!.className).toContain('flex items-center gap-2')
    expect(heading!.className).toContain('text-sm font-medium')
    expect(heading!.className).not.toContain('text-xs')
  })
})

describe('SearchSettings — tab composition (indexing block first)', () => {
  it('renders the Indexing section above the Web Search Provider section, separated by a divider', async () => {
    await renderSearchSettings({ provider: 'tavily', api_key: '' })

    // The Indexing section header (master toggle, exclude-glob editor,
    // policy toggles, and the moved vector-index controls) renders first.
    const indexingHeader = [...container.querySelectorAll('span')].find(
      (s) => s.textContent === 'Indexing',
    )
    expect(indexingHeader).toBeDefined()

    const providerHeading = [...container.querySelectorAll('label')].find((el) =>
      (el.textContent ?? '').includes('Web Search Provider'),
    )
    expect(providerHeading).toBeDefined()

    // DOM order pins the placement contract: indexing before the provider.
    expect(
      indexingHeader!.compareDocumentPosition(providerHeading!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    // The provider section sits below a divider inside the same tab stack,
    // mirroring how the General tab separates its sections.
    const providerSection = providerHeading!.closest('div.border-t')
    expect(providerSection).not.toBeNull()
    expect(providerSection!.className).toContain('pt-4')
    expect(providerSection!.parentElement).toBe(indexingHeader!.closest('div.space-y-6'))
  })
})
