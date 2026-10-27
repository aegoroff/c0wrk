// @vitest-environment jsdom
// IndexingSettings — the Search-tab vector-index indexing-policy block:
// the master "Indexing enabled" switch, the exclude-glob editor, the
// submodule / .gitignore / .aiignore toggles, and the embedded
// VectorIndexSettings section (provider / device / diagnostics).
//
// Every interaction is a discrete IMMEDIATE commit (no debounce — the
// backend applies the policy live), and UpdateIndexingSettings is a full
// replacement: each save carries all five fields, so flipping the master
// switch must preserve the stored patterns.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const spies = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateIndexingSettings: vi.fn<(req: unknown) => Promise<void>>(),
  listVectorIndexGPUs: vi.fn<() => Promise<unknown[]>>(),
}))

vi.mock('@/api/config', () => ({
  getConfig: spies.getConfig,
  updateIndexingSettings: spies.updateIndexingSettings,
  MASKED_API_KEY: '***configured***',
}))
// The embedded VectorIndexSettings probes the GPU list on mount on Linux
// hosts; mocked so the suite stays host-independent.
vi.mock('@/api/vector', () => ({
  listVectorIndexGPUs: spies.listVectorIndexGPUs,
}))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { IndexingSettings } from './IndexingSettings'
import { useIndexingSettingsStore } from '@/stores/indexingSettingsStore'

let container: HTMLDivElement
let root: Root

type VectorIndexPayload = {
  execution_provider: 'auto' | 'cpu' | 'cuda' | 'openvino'
  device_id: number
  enabled?: boolean
  exclude_patterns?: string[]
  index_submodules?: boolean
  respect_gitignore?: boolean
  respect_aiignore?: boolean
}

async function renderIndexing(vectorIndex?: VectorIndexPayload) {
  spies.getConfig.mockResolvedValue(vectorIndex ? { vector_index: vectorIndex } : {})
  await act(async () => {
    root.render(<IndexingSettings />)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  spies.updateIndexingSettings.mockResolvedValue(undefined)
  spies.listVectorIndexGPUs.mockResolvedValue([])
  // The app-wide gate is module state — reset so store-sync assertions start
  // from the pre-load default every time.
  useIndexingSettingsStore.setState({ enabled: true, loaded: false })
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
})

/** The Toggle switch carrying the given label text (exact span match). */
function toggleByLabel(label: string): HTMLInputElement {
  const span = [...container.querySelectorAll('span')].find((s) => s.textContent === label)
  if (!span) throw new Error(`toggle label not found: ${label}`)
  const scope = span.closest('div.flex.flex-col')
  const input = scope?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!input) throw new Error(`toggle checkbox not found for: ${label}`)
  return input
}

/** The exclude-glob editor's free-text input. */
function patternInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="New exclude pattern"]')
  if (!input) throw new Error('exclude pattern input not found')
  return input
}

/** Type into a controlled input via the native setter (the repo idiom). */
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

function pressEnter(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

/**
 * Press Enter AND flush the immediate save's promise resolution inside an
 * act boundary — the commit resolves `updateIndexingSettings` on a
 * microtask, and its success path (`setSaveError(null)`) must not land as
 * an act-warning state update.
 */
async function pressEnterAndFlush(input: HTMLInputElement) {
  pressEnter(input)
  await act(async () => {})
}

function chips(): string[] {
  return [...container.querySelectorAll('[data-testid="exclude-globs-chips"] code')].map(
    (code) => code.textContent ?? '',
  )
}

describe('IndexingSettings — rendering and the master-switch gate', () => {
  it('renders the master toggle and the full policy surface while indexing is enabled', async () => {
    await renderIndexing({
      execution_provider: 'cpu',
      device_id: 0,
      enabled: true,
      exclude_patterns: ['node_modules/', '*.min.js'],
      index_submodules: false,
      respect_gitignore: true,
      respect_aiignore: false,
    })

    expect(toggleByLabel('Indexing enabled').checked).toBe(true)
    // The stored patterns render as chips.
    expect(chips()).toEqual(['node_modules/', '*.min.js'])
    // The three policy toggles render with their persisted states.
    expect(toggleByLabel('Index Git submodules').checked).toBe(false)
    expect(toggleByLabel('Respect .gitignore').checked).toBe(true)
    expect(toggleByLabel('Respect .aiignore').checked).toBe(false)
    // The moved embedder half renders inside the block (its diagnostics
    // block is cross-platform).
    expect(container.querySelector('[data-testid="vector-diagnostics"]')).not.toBeNull()
  })

  it('hides every indexing control while the master switch is off', async () => {
    await renderIndexing({
      execution_provider: 'cpu',
      device_id: 0,
      enabled: false,
      exclude_patterns: ['node_modules/'],
    })

    // The master toggle stays and reports the off state...
    expect(toggleByLabel('Indexing enabled').checked).toBe(false)
    // ...and everything indexing-related hides with it: the glob editor,
    // the policy toggles, and the embedder/provider section.
    expect(container.querySelector('[data-testid="exclude-globs-editor"]')).toBeNull()
    expect(container.querySelector('[data-testid="indexing-policy-controls"]')).toBeNull()
    for (const label of ['Index Git submodules', 'Respect .gitignore', 'Respect .aiignore']) {
      expect(
        [...container.querySelectorAll('span')].some((s) => s.textContent === label),
      ).toBe(false)
    }
    expect(container.querySelector('[data-testid="vector-diagnostics"]')).toBeNull()
  })

  it('resolves a missing vector_index block to the historical defaults (enabled)', async () => {
    await renderIndexing(undefined)

    expect(toggleByLabel('Indexing enabled').checked).toBe(true)
    expect(container.querySelector('[data-testid="exclude-globs-editor"]')).not.toBeNull()
  })
})

describe('IndexingSettings — immediate full-policy saves', () => {
  it('flips the master switch with the rest of the policy preserved', async () => {
    await renderIndexing({
      execution_provider: 'cpu',
      device_id: 0,
      enabled: true,
      exclude_patterns: ['/dist'],
      index_submodules: true,
      respect_gitignore: true,
      respect_aiignore: false,
    })

    await act(async () => {
      toggleByLabel('Indexing enabled').click()
    })

    expect(spies.updateIndexingSettings).toHaveBeenCalledTimes(1)
    expect(spies.updateIndexingSettings).toHaveBeenCalledWith({
      enabled: false,
      exclude_patterns: ['/dist'],
      index_submodules: true,
      respect_gitignore: true,
      respect_aiignore: false,
    })
    // Hiding is immediate: the policy surface disappears without waiting
    // for the save round trip.
    expect(container.querySelector('[data-testid="indexing-policy-controls"]')).toBeNull()
  })

  it('saves each policy toggle with the other fields untouched', async () => {
    await renderIndexing({
      execution_provider: 'cpu',
      device_id: 0,
      enabled: true,
      exclude_patterns: [],
      index_submodules: false,
      respect_gitignore: true,
      respect_aiignore: true,
    })

    await act(async () => {
      toggleByLabel('Index Git submodules').click()
    })
    expect(spies.updateIndexingSettings).toHaveBeenCalledWith({
      enabled: true,
      exclude_patterns: [],
      index_submodules: true,
      respect_gitignore: true,
      respect_aiignore: true,
    })

    await act(async () => {
      toggleByLabel('Respect .aiignore').click()
    })
    expect(spies.updateIndexingSettings).toHaveBeenLastCalledWith({
      enabled: true,
      exclude_patterns: [],
      index_submodules: true,
      respect_gitignore: true,
      respect_aiignore: false,
    })
  })

  it('reverts the control and surfaces the error when the save is rejected', async () => {
    await renderIndexing({ execution_provider: 'cpu', device_id: 0, enabled: true })
    spies.updateIndexingSettings.mockRejectedValueOnce(new Error('pattern rejected by backend'))

    await act(async () => {
      toggleByLabel('Index Git submodules').click()
    })

    // The backend rejected before writing, so the toggle snaps back to the
    // persisted state and the reason is visible.
    expect(toggleByLabel('Index Git submodules').checked).toBe(false)
    expect(container.textContent).toContain('pattern rejected by backend')

    // The next commit builds from the REVERTED state (submodules stay off).
    await act(async () => {
      toggleByLabel('Index Git submodules').click()
    })
    expect(spies.updateIndexingSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ index_submodules: true, enabled: true }),
    )
  })
})

describe('IndexingSettings — exclude-glob editor', () => {
  it('adds a glob on Enter, renders the chip, and saves the appended list', async () => {
    await renderIndexing({
      execution_provider: 'cpu',
      device_id: 0,
      enabled: true,
      exclude_patterns: ['node_modules/'],
    })

    typeInto(patternInput(), 'vendor/')
    await pressEnterAndFlush(patternInput())

    expect(chips()).toEqual(['node_modules/', 'vendor/'])
    expect(patternInput().value).toBe('')
    expect(spies.updateIndexingSettings).toHaveBeenCalledTimes(1)
    expect(spies.updateIndexingSettings).toHaveBeenCalledWith(
      expect.objectContaining({ exclude_patterns: ['node_modules/', 'vendor/'] }),
    )
  })

  it('removes a glob via the chip button and saves the shortened list', async () => {
    await renderIndexing({
      execution_provider: 'cpu',
      device_id: 0,
      enabled: true,
      exclude_patterns: ['node_modules/', 'vendor/'],
    })

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove pattern vendor/"]',
    )
    if (!remove) throw new Error('remove button not found')
    await act(async () => {
      remove.click()
    })

    expect(chips()).toEqual(['node_modules/'])
    expect(spies.updateIndexingSettings).toHaveBeenCalledTimes(1)
    expect(spies.updateIndexingSettings).toHaveBeenCalledWith(
      expect.objectContaining({ exclude_patterns: ['node_modules/'] }),
    )
  })

  it('silently ignores a duplicate pattern (no save, input cleared)', async () => {
    await renderIndexing({
      execution_provider: 'cpu',
      device_id: 0,
      enabled: true,
      exclude_patterns: ['*.log'],
    })

    typeInto(patternInput(), '*.log')
    await pressEnterAndFlush(patternInput())

    expect(chips()).toEqual(['*.log'])
    expect(patternInput().value).toBe('')
    expect(spies.updateIndexingSettings).not.toHaveBeenCalled()
  })

  it('rejects an invalid glob with a visible error and no save', async () => {
    await renderIndexing({ execution_provider: 'cpu', device_id: 0, enabled: true })

    // Negation is unsupported (the list is exclude-only).
    typeInto(patternInput(), '!keep.go')
    await pressEnterAndFlush(patternInput())
    let alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Negation')
    expect(patternInput().value).toBe('!keep.go')

    // An unbalanced character class is not a valid doublestar glob.
    typeInto(patternInput(), '[unclosed')
    await pressEnterAndFlush(patternInput())
    alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Not a valid glob pattern')

    expect(spies.updateIndexingSettings).not.toHaveBeenCalled()
    // Nothing was added.
    expect(chips()).toEqual([])
  })
})

describe('IndexingSettings — app-wide gate sync (indexingSettingsStore)', () => {
  it('syncs the store after a successful master-switch save (off)', async () => {
    await renderIndexing({ execution_provider: 'cpu', device_id: 0, enabled: true })
    expect(useIndexingSettingsStore.getState().enabled).toBe(true)

    await act(async () => {
      toggleByLabel('Indexing enabled').click()
    })

    // The gated surfaces (Search tab, status-bar indicator, Find similar)
    // read this store — a confirmed save flips them immediately.
    expect(useIndexingSettingsStore.getState().enabled).toBe(false)
  })

  it('syncs the store back on when the master switch is re-enabled', async () => {
    await renderIndexing({ execution_provider: 'cpu', device_id: 0, enabled: false })

    await act(async () => {
      toggleByLabel('Indexing enabled').click()
    })

    expect(useIndexingSettingsStore.getState().enabled).toBe(true)
  })

  it('does NOT sync the store when the save is rejected', async () => {
    await renderIndexing({ execution_provider: 'cpu', device_id: 0, enabled: true })
    spies.updateIndexingSettings.mockRejectedValueOnce(new Error('persist failed'))

    await act(async () => {
      toggleByLabel('Indexing enabled').click()
    })

    // The backend rejected before writing — the app-wide gate must keep the
    // persisted (on) state, not the optimistic control flip.
    expect(useIndexingSettingsStore.getState().enabled).toBe(true)
  })
})
