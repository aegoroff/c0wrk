// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Mock the API layer: the component must not touch real Wails bindings.
// updateExperimentalFeatures is the master experimental gate — the profile UI
// must never call it (UX invariant: profile switch does not toggle the gate).
const getSLMProfilesMock = vi.fn()
const updateSLMProfileMock = vi.fn()
const createSLMProfileMock = vi.fn()
const deleteSLMProfileMock = vi.fn()
const selectSLMProfileMock = vi.fn()
const setSLMEnabledMock = vi.fn()
const updateExperimentalFeaturesMock = vi.fn()
vi.mock('@/api/config', () => ({
  getSLMProfiles: (...args: unknown[]) => getSLMProfilesMock(...args),
  updateSLMProfile: (...args: unknown[]) => updateSLMProfileMock(...args),
  createSLMProfile: (...args: unknown[]) => createSLMProfileMock(...args),
  deleteSLMProfile: (...args: unknown[]) => deleteSLMProfileMock(...args),
  selectSLMProfile: (...args: unknown[]) => selectSLMProfileMock(...args),
  setSLMEnabled: (...args: unknown[]) => setSLMEnabledMock(...args),
  updateExperimentalFeatures: (...args: unknown[]) => updateExperimentalFeaturesMock(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Radix popper positioning (autoUpdate) observes the trigger/content with
// ResizeObserver, which jsdom does not provide — the always-present combobox
// and the profile selector portal their menus into document.body.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
)

import { TooltipProvider } from '@/components/ui/tooltip'
import { useExperimentalStore } from '@/stores/experimentalStore'
import type { SLMProfilesResponse, SLMProfileValues } from '@/types/models'
import { SLMSettings } from './SLMSettings'

const builtinTools = [
  { name: 'ask_user', description: 'ask the user a question' },
  { name: 'bash_exec', description: 'run shell commands.' },
  { name: 'finish', description: 'finish the task' },
  { name: 'read_file', description: 'read a file' },
]
const toolGroups = [
  {
    id: 'subagents',
    title: 'Subagents & reflection',
    description: 'Delegate work to subagents.',
    tools: ['bash_exec'],
  },
]
const protectedTools = ['ask_user', 'finish']

const baseValues: SLMProfileValues = {
  essential_tools: {
    enabled: true,
    always_present: ['finish', 'read_file'],
    compact_descriptions: false,
  },
  system_prompt: { lite: false, few_shot: false, reasoning_scaffold: false },
  sampling: {
    enabled: true,
    temperature: 0,
    top_p: 0,
    top_k: 0,
    repetition_penalty: 0,
    presence_penalty: 0,
    reasoning_effort: 'medium',
  },
  loop_hardening: {
    enabled: true,
    repeat_nudge_threshold: 2,
    parse_error_abort_threshold: 3,
    fruitless_nudge_threshold: 3,
    fruitless_abort_threshold: 4,
    same_tool_repeat_nudge_threshold: 5,
  },
  context: {
    enabled: true,
    compaction: { keep_last: 6, block_size: 5, trigger_percent: 80 },
    tool_output_keep_last_n: 2,
    output_token_reserve: 16384,
  },
}

const genericProfile = { id: 'generic', name: 'Generic (model-agnostic)', kind: 'predefined' as const, values: structuredClone(baseValues) }
const qwenProfile = { id: 'qwen3.8-27b', name: 'Qwen3.8-27B (minimal)', kind: 'predefined' as const, values: structuredClone(baseValues) }
const gemmaProfile = { id: 'gemma-4-26b-a4b-it', name: 'Gemma-4-26B-A4B-it (maximal)', kind: 'predefined' as const, values: structuredClone(baseValues) }
const customProfile = { id: 'test-tuned', name: 'Test Tuned', kind: 'custom' as const, values: structuredClone(baseValues) }

/** Response fixture with per-field overrides. */
function resp(overrides: {
  enabled?: boolean
  active_id?: string
  suggested?: string | null
  profiles?: SLMProfilesResponse['profiles']
  warnings?: string[]
}): SLMProfilesResponse {
  return structuredClone({
    enabled: overrides.enabled ?? true,
    profiles: overrides.profiles ?? [genericProfile, qwenProfile, gemmaProfile, customProfile],
    active_id: overrides.active_id ?? 'test-tuned',
    suggested_profile_id: overrides.suggested ?? null,
    builtin_tools: builtinTools,
    tool_groups: toolGroups,
    protected_tools: protectedTools,
    warnings: overrides.warnings ?? [],
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  getSLMProfilesMock.mockReset().mockResolvedValue(resp({}))
  updateSLMProfileMock.mockReset().mockResolvedValue(undefined)
  createSLMProfileMock.mockReset().mockResolvedValue('my-copy')
  deleteSLMProfileMock.mockReset().mockResolvedValue(undefined)
  selectSLMProfileMock.mockReset().mockResolvedValue(undefined)
  setSLMEnabledMock.mockReset().mockResolvedValue(undefined)
  updateExperimentalFeaturesMock.mockClear()
  container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  document.body.innerHTML = ''
})

const render = () =>
  act(async () => {
    await root.render(
      <TooltipProvider>
        <SLMSettings />
      </TooltipProvider>,
    )
  })

const field = (label: string) =>
  container.querySelector(`input[data-field="${label}"]`) as HTMLInputElement | null

/** The checkbox of the Toggle row containing `labelText`. */
const toggleFor = (labelText: string) => {
  const span = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === labelText)
  return span?.closest('div')?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
}

const buttonByLabel = (label: string) =>
  container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null

const selectorTrigger = () => buttonByLabel('Select Small LLM profile')

/** Open the profile selector's Radix menu (toggles on pointerdown). */
async function openSelector(): Promise<void> {
  const btn = selectorTrigger()
  expect(btn).not.toBeNull()
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 10))
  })
}

const menuItems = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
const menuItem = (profileId: string) => {
  const el = menuItems().find((m) => m.dataset.profileId === profileId)
  if (!el) throw new Error(`Menu item for "${profileId}" not found`)
  return el
}
const menuLabels = () =>
  Array.from(document.body.querySelectorAll('[role="menu"] > *')).map((el) => el.textContent ?? '')

const dialogEl = (kind: string) =>
  document.body.querySelector(`[data-testid="slm-profile-dialog-${kind}"]`) as HTMLElement | null

const nameInput = () =>
  document.body.querySelector<HTMLInputElement>('[data-testid="slm-profile-name-input"]')

const setName = (input: HTMLInputElement, value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

const dialogButton = (label: string) =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.getAttribute('aria-label') === label || b.textContent === label,
  )

const suggestionBanner = () =>
  container.querySelector('[data-testid="slm-suggestion-banner"]') ??
  document.body.querySelector('[data-testid="slm-suggestion-banner"]')

describe('SLMSettings — profile selector', () => {
  it('renders grouped options: Predefined profiles, then Custom, with the active one marked', async () => {
    await render()
    // The trigger shows the active profile name.
    expect(selectorTrigger()?.textContent).toContain('Test Tuned')

    await openSelector()
    const labels = menuLabels()
    expect(labels).toContain('Predefined')
    expect(labels).toContain('Custom')
    // Group order: predefined items before the Custom label.
    expect(labels.indexOf('Predefined')).toBeLessThan(labels.indexOf('Custom'))
    const ids = menuItems().map((m) => m.dataset.profileId)
    expect(ids).toEqual(['generic', 'qwen3.8-27b', 'gemma-4-26b-a4b-it', 'test-tuned'])
    // The active profile is marked selected.
    expect(menuItem('test-tuned').dataset.selected).toBe('true')
    expect(menuItem('generic').dataset.selected).toBe('false')
  })

  it('selecting another profile calls selectSLMProfile, reloads and updates the trigger', async () => {
    getSLMProfilesMock
      .mockResolvedValueOnce(resp({ active_id: 'test-tuned' }))
      .mockResolvedValueOnce(resp({ active_id: 'generic' }))
    await render()
    await openSelector()
    await act(async () => {
      menuItem('generic').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(selectSLMProfileMock).toHaveBeenCalledWith('generic')
    expect(getSLMProfilesMock).toHaveBeenCalledTimes(2)
    expect(selectorTrigger()?.textContent).toContain('Generic (model-agnostic)')
  })

  it('re-picking the active profile is a no-op (no RPC)', async () => {
    await render()
    await openSelector()
    await act(async () => {
      menuItem('test-tuned').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(selectSLMProfileMock).not.toHaveBeenCalled()
  })

  it('UX invariant: switching a profile never touches the master experimental gate', async () => {
    const before = useExperimentalStore.getState().enabled
    getSLMProfilesMock
      .mockResolvedValueOnce(resp({ active_id: 'test-tuned' }))
      .mockResolvedValueOnce(resp({ active_id: 'qwen3.8-27b' }))
    await render()
    await openSelector()
    await act(async () => {
      menuItem('qwen3.8-27b').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(selectSLMProfileMock).toHaveBeenCalledTimes(1)
    expect(updateExperimentalFeaturesMock).not.toHaveBeenCalled()
    expect(useExperimentalStore.getState().enabled).toBe(before)
  })
})

describe('SLMSettings — predefined active profile (read-only view)', () => {
  beforeEach(() => {
    getSLMProfilesMock.mockResolvedValue(resp({ active_id: 'generic' }))
  })

  it('renders the sections with every control disabled', async () => {
    await render()
    expect(toggleFor('Curate the tool subset')?.disabled).toBe(true)
    expect(toggleFor('Compact tool descriptions')?.disabled).toBe(true)
    expect(field('Temperature')?.disabled).toBe(true)
    expect(field('Keep last')?.disabled).toBe(true)
    expect(buttonByLabel('Add Always-present tools')?.disabled).toBe(true)
    // The profile selector itself stays enabled — switching away is allowed.
    expect(selectorTrigger()?.disabled).toBe(false)
  })

  it('disabled controls never emit an update', async () => {
    await render()
    await act(async () => {
      toggleFor('Curate the tool subset')?.click()
    })
    expect(updateSLMProfileMock).not.toHaveBeenCalled()
  })

  it('offers Duplicate (no Rename/Delete) and creates + activates an editable copy', async () => {
    getSLMProfilesMock
      .mockResolvedValueOnce(resp({ active_id: 'generic' }))
      .mockResolvedValueOnce(
        resp({
          active_id: 'my-copy',
          profiles: [
            genericProfile,
            qwenProfile,
            gemmaProfile,
            customProfile,
            { id: 'my-copy', name: 'My Copy', kind: 'custom', values: structuredClone(baseValues) },
          ],
        }),
      )
    await render()
    expect(buttonByLabel('Rename profile')).toBeNull()
    expect(buttonByLabel('Delete profile')).toBeNull()

    await act(async () => {
      buttonByLabel('Duplicate profile')?.click()
    })
    expect(dialogEl('duplicate')).not.toBeNull()
    // The name input is prefilled with "<name> (copy)".
    expect(nameInput()?.value).toBe('Generic (model-agnostic) (copy)')

    await setName(nameInput()!, 'My Copy')
    await act(async () => {
      dialogButton('Confirm duplicate profile')?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(createSLMProfileMock).toHaveBeenCalledWith('generic', 'My Copy')
    expect(selectSLMProfileMock).toHaveBeenCalledWith('my-copy')
    // The dialog closed and the copy is now the active, editable profile.
    expect(dialogEl('duplicate')).toBeNull()
    expect(selectorTrigger()?.textContent).toContain('My Copy')
    expect(toggleFor('Curate the tool subset')?.disabled).toBe(false)
  })

  it('an empty name cannot be submitted', async () => {
    await render()
    await act(async () => {
      buttonByLabel('Duplicate profile')?.click()
    })
    await setName(nameInput()!, '   ')
    // The confirm button is disabled for a blank name.
    expect(dialogButton('Confirm duplicate profile')?.disabled).toBe(true)
    expect(createSLMProfileMock).not.toHaveBeenCalled()
  })
})

describe('SLMSettings — custom profile CRUD', () => {
  beforeEach(() => {
    getSLMProfilesMock.mockResolvedValue(resp({ active_id: 'test-tuned' }))
  })

  it('shows Rename and Delete (no Duplicate) and saves a rename through the dialog', async () => {
    await render()
    expect(buttonByLabel('Duplicate profile')).toBeNull()

    await act(async () => {
      buttonByLabel('Rename profile')?.click()
    })
    expect(dialogEl('rename')).not.toBeNull()
    expect(nameInput()?.value).toBe('Test Tuned')

    await setName(nameInput()!, 'Renamed')
    await act(async () => {
      dialogButton('Confirm rename profile')?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(updateSLMProfileMock).toHaveBeenCalledWith('test-tuned', { name: 'Renamed' })
    expect(dialogEl('rename')).toBeNull()
  })

  it('delete requires an explicit confirmation and reloads after', async () => {
    getSLMProfilesMock
      .mockResolvedValueOnce(resp({ active_id: 'test-tuned' }))
      .mockResolvedValueOnce(resp({ active_id: 'generic', warnings: ['the active profile was deleted; switched to generic'] }))
    await render()
    await act(async () => {
      buttonByLabel('Delete profile')?.click()
    })
    const dlg = dialogEl('delete')
    expect(dlg).not.toBeNull()
    expect(dlg?.textContent).toContain('Test Tuned')
    // No RPC before the confirmation button is pressed.
    expect(deleteSLMProfileMock).not.toHaveBeenCalled()

    await act(async () => {
      dialogButton('Confirm delete profile')?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(deleteSLMProfileMock).toHaveBeenCalledWith('test-tuned')
    expect(dialogEl('delete')).toBeNull()
    // The reload picked up the generic fallback + its one-shot notice.
    expect(selectorTrigger()?.textContent).toContain('Generic (model-agnostic)')
    expect(container.textContent).toContain('switched to generic')
  })

  it('cancelling the delete dialog sends no RPC', async () => {
    await render()
    await act(async () => {
      buttonByLabel('Delete profile')?.click()
    })
    await act(async () => {
      dialogButton('Cancel')?.click()
    })
    expect(dialogEl('delete')).toBeNull()
    expect(deleteSLMProfileMock).not.toHaveBeenCalled()
  })
})

describe('SLMSettings — suggestion banner', () => {
  it('is hidden when no profile is suggested', async () => {
    getSLMProfilesMock.mockResolvedValue(resp({ active_id: 'test-tuned', suggested: null }))
    await render()
    expect(suggestionBanner()).toBeNull()
  })

  it('is hidden when the suggested profile is already active', async () => {
    getSLMProfilesMock.mockResolvedValue(resp({ active_id: 'qwen3.8-27b', suggested: 'qwen3.8-27b' }))
    await render()
    expect(suggestionBanner()).toBeNull()
  })

  it('appears when suggested differs from active; Apply selects it and the banner disappears', async () => {
    getSLMProfilesMock
      .mockResolvedValueOnce(resp({ active_id: 'test-tuned', suggested: 'qwen3.8-27b' }))
      .mockResolvedValueOnce(resp({ active_id: 'qwen3.8-27b', suggested: 'qwen3.8-27b' }))
    await render()
    const banner = suggestionBanner()
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('Qwen3.8-27B (minimal)')

    await act(async () => {
      buttonByLabel('Apply suggested profile')?.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    // Apply is an explicit select — never an auto-apply on load.
    expect(selectSLMProfileMock).toHaveBeenCalledTimes(1)
    expect(selectSLMProfileMock).toHaveBeenCalledWith('qwen3.8-27b')
    expect(suggestionBanner()).toBeNull()
  })

  it('Hide dismisses without selecting; the same suggestion stays hidden', async () => {
    getSLMProfilesMock.mockResolvedValue(resp({ active_id: 'test-tuned', suggested: 'qwen3.8-27b' }))
    await render()
    expect(suggestionBanner()).not.toBeNull()
    await act(async () => {
      buttonByLabel('Dismiss suggested profile')?.click()
    })
    expect(suggestionBanner()).toBeNull()
    expect(selectSLMProfileMock).not.toHaveBeenCalled()
    // A reload (any profile op) keeps the same suggestion dismissed.
    getSLMProfilesMock.mockResolvedValue(resp({ active_id: 'generic', suggested: 'qwen3.8-27b' }))
    await openSelector()
    await act(async () => {
      menuItem('generic').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(suggestionBanner()).toBeNull()
  })

  it('a different suggestion (model switch) re-opens the banner', async () => {
    getSLMProfilesMock
      .mockResolvedValueOnce(resp({ active_id: 'test-tuned', suggested: 'qwen3.8-27b' }))
      .mockResolvedValueOnce(resp({ active_id: 'test-tuned', suggested: 'gemma-4-26b-a4b-it' }))
    await render()
    await act(async () => {
      buttonByLabel('Dismiss suggested profile')?.click()
    })
    expect(suggestionBanner()).toBeNull()
    // Switching the default model changes the suggestion — banner returns.
    await openSelector()
    await act(async () => {
      menuItem('generic').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    const banner = suggestionBanner()
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('Gemma-4-26B-A4B-it (maximal)')
  })
})

describe('SLMSettings — dangling active profile fallback', () => {
  it('warns and renders the generic profile read-only', async () => {
    getSLMProfilesMock.mockResolvedValue(resp({ active_id: 'ghost-profile' }))
    await render()
    const warn = container.querySelector('[data-testid="slm-fallback-warning"]')
    expect(warn).not.toBeNull()
    expect(warn?.textContent).toContain('ghost-profile')
    expect(warn?.textContent).toContain('Generic (model-agnostic)')
    // The effective (generic) values render read-only; the selector flags the unknown id.
    expect(toggleFor('Curate the tool subset')?.disabled).toBe(true)
    expect(selectorTrigger()?.textContent).toContain('Unknown profile (ghost-profile)')
    expect(buttonByLabel('Duplicate profile')).not.toBeNull()
  })
})

describe('SLMSettings — master toggle (slm.enabled)', () => {
  const masterToggle = () => toggleFor('Enable the Small-LLM profile')

  const clickMasterToggle = () =>
    act(async () => {
      masterToggle()?.click()
      await new Promise((r) => setTimeout(r, 0))
    })

  it('hides every profile control while disabled, showing only the toggle and a hint', async () => {
    getSLMProfilesMock.mockResolvedValue(resp({ enabled: false }))
    await render()

    // The master toggle is present and unchecked.
    const toggle = masterToggle()
    expect(toggle).not.toBeNull()
    expect(toggle?.checked).toBe(false)

    // No profile picker, no CRUD actions, no variant sections.
    expect(selectorTrigger()).toBeNull()
    expect(buttonByLabel('Duplicate profile')).toBeNull()
    expect(buttonByLabel('Rename profile')).toBeNull()
    expect(toggleFor('Curate the tool subset')).toBeFalsy()
    expect(field('Temperature')).toBeNull()
    const text = container.textContent ?? ''
    expect(text).toContain('The Small-LLM profile is off')
    expect(text).not.toContain('Context Management')
  })

  it('turning it on calls setSLMEnabled(true) and reveals the profile UI', async () => {
    getSLMProfilesMock
      .mockResolvedValueOnce(resp({ enabled: false }))
      .mockResolvedValueOnce(resp({ enabled: true }))
    await render()
    expect(selectorTrigger()).toBeNull()

    await clickMasterToggle()

    expect(setSLMEnabledMock).toHaveBeenCalledWith(true)
    // The catalog was reloaded after the toggle RPC.
    expect(getSLMProfilesMock).toHaveBeenCalledTimes(2)
    // The reloaded (enabled) response renders the full profile UI.
    expect(selectorTrigger()).not.toBeNull()
    expect(toggleFor('Curate the tool subset')).not.toBeNull()
    expect(container.textContent).toContain('Context Management')
    expect(masterToggle()?.checked).toBe(true)
  })

  it('turning it off hides the profile UI again', async () => {
    getSLMProfilesMock
      .mockResolvedValueOnce(resp({ enabled: true }))
      .mockResolvedValueOnce(resp({ enabled: false }))
    await render()
    expect(selectorTrigger()).not.toBeNull()

    await clickMasterToggle()

    expect(setSLMEnabledMock).toHaveBeenCalledWith(false)
    expect(getSLMProfilesMock).toHaveBeenCalledTimes(2)
    expect(selectorTrigger()).toBeNull()
    expect(container.textContent).not.toContain('Context Management')
    expect(masterToggle()?.checked).toBe(false)
  })

  it('UX invariant: the master toggle never touches the master experimental gate', async () => {
    const before = useExperimentalStore.getState().enabled
    getSLMProfilesMock
      .mockResolvedValueOnce(resp({ enabled: false }))
      .mockResolvedValueOnce(resp({ enabled: true }))
    await render()

    await clickMasterToggle()

    expect(setSLMEnabledMock).toHaveBeenCalledWith(true)
    expect(updateExperimentalFeaturesMock).not.toHaveBeenCalled()
    expect(useExperimentalStore.getState().enabled).toBe(before)
  })
})
