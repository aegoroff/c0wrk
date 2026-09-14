// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Mock the API layer: the component must not touch real Wails bindings.
const updateModelProfileMock = vi.fn()
const getModelProfilesMock = vi.fn()
const setModelProfilesEnabledMock = vi.fn()
vi.mock('@/api/config', () => ({
  getModelProfiles: (...args: unknown[]) => getModelProfilesMock(...args),
  updateModelProfile: (...args: unknown[]) => updateModelProfileMock(...args),
  setModelProfilesEnabled: (...args: unknown[]) => setModelProfilesEnabledMock(...args),
}))

// Failure-path tests (backend validation rejection) intentionally make
// ModelProfilesSettings' logger.error fire; mock the logger so the expected
// errors don't pollute vitest output.
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Radix popper positioning (autoUpdate) observes the trigger/content with
// ResizeObserver, which jsdom does not provide — the always-present combobox
// portals its menu into document.body.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
)

import { TooltipProvider, TOOLTIP_DELAY_MS } from '@/components/ui/tooltip'
import type { ModelProfilesResponse, ModelProfileValues } from '@/types/models'
import { ModelProfilesSettings } from './ModelProfilesSettings'

const builtinTools = [
  { name: 'ask_user', description: 'ask the user a question' },
  {
    name: 'bash_exec',
    description:
      'Purpose: run shell commands.\nUse when: you need a shell.\nInputs: command.\nAnti-example: not for file reads.',
  },
  { name: 'cancel_delegation', description: 'cancel a running delegation' },
  { name: 'delegate', description: 'delegate work to a subagent' },
  { name: 'finish', description: 'finish the task' },
  { name: 'read_file', description: 'read a file' },
  {
    name: 'read_skill_resource',
    description:
      "Purpose: read a resource file bundled with an activated skill — its reference material, scripts, or other supporting files — by skill name and a path relative to that skill's directory.\nUse when: a skill's instructions point you at a bundled file (e.g. \"see references/api.md\"); the skill must already be active on the current request.\nInputs: skill (name of the active skill that contains the resource); path (relative path within the skill directory, e.g. 'references/api.md').\nOutputs: the resource file's raw contents as text.\nExample: skill=\"pdf-processing\", path=\"references/forms.md\".\nAnti-example: not for reading a skill's instruction body or arbitrary workspace files (use read_file with a path).",
  },
  { name: 'reflect', description: 'reflect on the trajectory' },
  { name: 'web_search', description: 'search the web' },
]
const toolGroups = [
  {
    id: 'subagents',
    title: 'Subagents & reflection',
    description: 'Delegate work to subagents and read their results.',
    tools: ['delegate', 'cancel_delegation', 'reflect'],
  },
]
const protectedTools = ['ask_user', 'finish']

const baseValues: ModelProfileValues = {
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
    reasoning_effort: '',
  },
  loop_hardening: {
    enabled: false,
    repeat_nudge_threshold: 3,
    parse_error_abort_threshold: 3,
    fruitless_nudge_threshold: 3,
    fruitless_abort_threshold: 4,
    same_tool_repeat_nudge_threshold: 5,
  },
  context: {
    enabled: false,
    compaction: { keep_last: 6, block_size: 5, trigger_percent: 80 },
    tool_output_keep_last_n: 2,
    output_token_reserve: 8192,
  },
}

const baseResponse: ModelProfilesResponse = {
  enabled: true,
  profiles: [
    { id: 'generic', name: 'Generic (model-agnostic)', kind: 'predefined', values: structuredClone(baseValues) },
    { id: 'test-tuned', name: 'Test Tuned', kind: 'custom', values: structuredClone(baseValues) },
  ],
  active_id: 'test-tuned',
  suggested_profile_id: null,
  builtin_tools: builtinTools,
  tool_groups: toolGroups,
  protected_tools: protectedTools,
  warnings: [],
}

/** Response with per-variant overrides applied to the active custom profile's values. */
function respWith(overrides: Partial<ModelProfileValues>): ModelProfilesResponse {
  return structuredClone({
    ...baseResponse,
    profiles: baseResponse.profiles.map((p) =>
      p.id === 'test-tuned' ? { ...p, values: { ...p.values, ...overrides } } : p,
    ),
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  updateModelProfileMock.mockReset()
  getModelProfilesMock.mockReset().mockResolvedValue(structuredClone(baseResponse))
  updateModelProfileMock.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
})

afterEach(() => {
  // Unmount explicitly so a test's portaled Radix menus (the always-present
  // combobox renders its list into document.body) are torn down before the
  // next test replaces document.body. Leaving a stale root attached makes
  // React throw "the node to be removed is not a child of this node" when it
  // reacts to the swap.
  act(() => {
    root.unmount()
  })
  document.body.innerHTML = ''
})

const render = () =>
  act(async () => {
    await root.render(
      <TooltipProvider>
        <ModelProfilesSettings />
      </TooltipProvider>,
    )
  })

const field = (label: string) => container.querySelector(`input[data-field="${label}"]`) as HTMLInputElement | null

const setField = (input: HTMLInputElement, value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

// React 17+ delegates onBlur via the native `focusout` event.
const blur = (input: HTMLInputElement) =>
  act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })

/** Find the checkbox that belongs to the Toggle row containing `labelText`. */
const toggleFor = (labelText: string) => {
  const span = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === labelText)
  return span?.closest('div')?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
}

/** Find the tag-list chip rendering the given tool name. */
const chipFor = (name: string) =>
  Array.from(container.querySelectorAll('code')).find((c) => c.textContent === name)?.parentElement ?? null

describe('ModelProfilesSettings — sampling inherit semantics', () => {
  it('renders inherit (0) fields as empty inputs with vendor-default placeholder', async () => {
    await render()
    const temp = field('Temperature')
    expect(temp).not.toBeNull()
    expect(temp?.value).toBe('')
    expect(temp?.placeholder).toBe('vendor default')
    expect(container.textContent).toContain('Empty fields inherit the vendor preset')
  })

  it('shows explicit values and sends them through on commit', async () => {
    getModelProfilesMock.mockResolvedValue(
      respWith({ sampling: { ...baseValues.sampling, temperature: 0.7, top_k: 40 } }),
    )
    await render()
    expect(field('Temperature')?.value).toBe('0.7')
    expect(field('Top K')?.value).toBe('40')

    await setField(field('Top K')!, '20')
    await blur(field('Top K')!)
    const sent = updateModelProfileMock.mock.calls[updateModelProfileMock.mock.calls.length - 1]?.[1]?.config
    expect(sent.sampling.top_k).toBe(20)
  })

  it('clearing an explicit value commits 0 (inherit)', async () => {
    getModelProfilesMock.mockResolvedValue(
      respWith({ sampling: { ...baseValues.sampling, temperature: 0.9 } }),
    )
    await render()
    const temp = field('Temperature')!
    expect(temp.value).toBe('0.9')
    await setField(temp, '')
    await blur(temp)
    const sent = updateModelProfileMock.mock.calls[updateModelProfileMock.mock.calls.length - 1]?.[1]?.config
    expect(sent.sampling.temperature).toBe(0)
  })

  it('rejects out-of-bounds input and keeps the previous value', async () => {
    getModelProfilesMock.mockResolvedValue(
      respWith({ sampling: { ...baseValues.sampling, repetition_penalty: 1.2 } }),
    )
    await render()
    const rep = field('Repetition penalty')!
    await setField(rep, '9')
    await blur(rep)
    expect(rep.value).toBe('1.2')
    expect(updateModelProfileMock).not.toHaveBeenCalled()
  })

  it('presence penalty: inherit renders empty, explicit value commits, >2 rejected', async () => {
    // Unset (0) renders as an empty input with the inherit placeholder.
    await render()
    const pp = field('Presence penalty')!
    expect(pp).not.toBeNull()
    expect(pp.value).toBe('')
    expect(pp.placeholder).toBe('vendor default')

    // An explicit value (the Qwen instruct default 1.5) is sent through on commit.
    await setField(pp, '1.5')
    await blur(pp)
    const sent = updateModelProfileMock.mock.calls[updateModelProfileMock.mock.calls.length - 1]?.[1]?.config
    expect(sent.sampling.presence_penalty).toBe(1.5)

    // Out-of-bounds input (> 2) is rejected and keeps the previous value.
    const before = updateModelProfileMock.mock.calls.length
    await setField(pp, '2.5')
    await blur(pp)
    expect(pp.value).toBe('1.5')
    expect(updateModelProfileMock.mock.calls.length).toBe(before)
  })

  it('represents the empty reasoning_effort as an explicit "Inherit" option', async () => {
    // baseValues.sampling.reasoning_effort = '' — the combobox must render a
    // label (not a blank trigger) so the stored value is visible/selectable.
    await render()
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Reasoning effort"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('Inherit (model default)')
  })
})

describe('ModelProfilesSettings — context section', () => {
  it('renders the context variant with compaction, pruning and reserve fields', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('Context Management')
    expect(text).toContain('Aggressive context management')

    // Fields are hidden until the variant toggle is on.
    expect(field('Keep last')).toBeNull()
  })

  it('exposes compaction fields once the variant is enabled', async () => {
    getModelProfilesMock.mockResolvedValue(
      respWith({ context: { ...baseValues.context, enabled: true } }),
    )
    await render()
    expect(field('Keep last')?.value).toBe('6')
    expect(field('Block size')?.value).toBe('5')
    expect(field('Trigger percent')?.value).toBe('80')
    expect(field('Tool output keep N')?.value).toBe('2')
    expect(field('Output token reserve')?.value).toBe('8192')

    await setField(field('Keep last')!, '4')
    await blur(field('Keep last')!)
    const sent = updateModelProfileMock.mock.calls[updateModelProfileMock.mock.calls.length - 1]?.[1]?.config
    expect(sent.context.compaction.keep_last).toBe(4)
  })

  it('caps Trigger percent below 100 (backend requires < 100 when enabled)', async () => {
    getModelProfilesMock.mockResolvedValue(
      respWith({
        context: { ...baseValues.context, enabled: true, compaction: { keep_last: 6, block_size: 5, trigger_percent: 80 } },
      }),
    )
    await render()
    const tp = field('Trigger percent')!
    expect(tp.max).toBe('99')
    await setField(tp, '100')
    await blur(tp)
    // 100 is out of range: the field reverts and nothing is persisted.
    expect(tp.value).toBe('80')
    expect(updateModelProfileMock).not.toHaveBeenCalled()
  })
})

describe('ModelProfilesSettings — loop hardening bounds', () => {
  it('floors threshold inputs at 1 (backend requires >= 1 when enabled)', async () => {
    getModelProfilesMock.mockResolvedValue(
      respWith({
        loop_hardening: {
          enabled: true,
          repeat_nudge_threshold: 2,
          parse_error_abort_threshold: 3,
          fruitless_nudge_threshold: 3,
          fruitless_abort_threshold: 4,
          same_tool_repeat_nudge_threshold: 5,
        },
      }),
    )
    await render()
    const rf = field('Repeat nudge')!
    expect(rf.min).toBe('1')
    await setField(rf, '0')
    await blur(rf)
    // 0 is below the floor: the field reverts and nothing is persisted.
    expect(rf.value).toBe('2')
    expect(updateModelProfileMock).not.toHaveBeenCalled()
  })
})

describe('ModelProfilesSettings — essential tools static selection & locked tools', () => {
  it('documents the static selection and renders protected tools as locked', async () => {
    await render()
    const text = container.textContent ?? ''
    // The assigned set is the selection + system + all MCP; no budget copy.
    expect(text).toContain("every connected MCP server's tools")
    expect(text).not.toContain('router-matched')
    expect(text).not.toContain('never trimmed')

    // Protected tools render as locked chips: no remove button, lock glyph.
    const lockedChip = chipFor('finish')
    expect(lockedChip).not.toBeNull()
    expect(lockedChip?.querySelector('[aria-label="Remove finish"]')).toBeNull()
    expect(lockedChip?.querySelector('svg')).not.toBeNull()

    // Non-protected tools keep their remove button.
    const openChip = chipFor('read_file')
    expect(openChip?.querySelector('[aria-label="Remove read_file"]')).not.toBeNull()
  })

  it('toggles compact descriptions', async () => {
    await render()
    const toggle = toggleFor('Compact tool descriptions')
    expect(toggle).not.toBeNull()
    expect(toggle?.checked).toBe(false)
    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })
    const sent = updateModelProfileMock.mock.calls[updateModelProfileMock.mock.calls.length - 1]?.[1]?.config
    expect(sent.essential_tools.compact_descriptions).toBe(true)
  })
})

describe('ModelProfilesSettings — essential tools picker (combobox)', () => {
  const picker = () =>
    container.querySelector('button[aria-label="Add Always-present tools"]') as HTMLButtonElement | null

  /** Open the picker's Radix menu (toggles on pointerdown, not click). */
  async function openPicker(): Promise<void> {
    const btn = picker()
    expect(btn).not.toBeNull()
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 10))
    })
  }

  const menuItems = (): string[] =>
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
      (o) => o.textContent?.trim() ?? '',
    )

  function menuItem(label: string): HTMLElement {
    const el = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((o) =>
      o.textContent?.includes(label),
    )
    if (!el) throw new Error(`Menu item "${label}" not found`)
    return el
  }

  /** Hover a menu item long enough for its Radix tooltip to open (real delay). */
  async function hoverMenuItem(label: string): Promise<void> {
    const el = menuItem(label)
    await act(async () => {
      el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }))
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
      await new Promise((r) => setTimeout(r, TOOLTIP_DELAY_MS + 50))
    })
  }

  const lastSent = () =>
    updateModelProfileMock.mock.calls[updateModelProfileMock.mock.calls.length - 1]?.[1]?.config

  it('offers the workflow cluster plus only the built-ins that are not already allowed', async () => {
    await render()
    await openPicker()
    const items = menuItems()
    // The cluster is offered once…
    expect(items).toContain('Subagents & reflection')
    // …and its members are NOT offered individually (atomic selection).
    expect(items).not.toContain('delegate')
    expect(items).not.toContain('reflect')
    // Ungrouped, not-yet-allowed built-ins are offered…
    expect(items).toContain('bash_exec')
    expect(items).toContain('web_search')
    // …while already-allowed ones (always_present ∪ protected) are not.
    expect(items).not.toContain('read_file')
    expect(items).not.toContain('finish')
    expect(items).not.toContain('ask_user')
  })

  it('picking a group pins every member of the cluster at once', async () => {
    await render()
    await openPicker()
    await act(async () => {
      menuItem('Subagents & reflection').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const sent = lastSent()
    expect(sent.essential_tools.always_present).toContain('delegate')
    expect(sent.essential_tools.always_present).toContain('cancel_delegation')
    expect(sent.essential_tools.always_present).toContain('reflect')
    // Existing pins are preserved.
    expect(sent.essential_tools.always_present).toContain('read_file')
  })

  it('shows a hover tooltip with the cluster description and member list (rendered markdown)', async () => {
    await render()
    await openPicker()
    await hoverMenuItem('Subagents & reflection')
    const tip = document.body.querySelector('[data-slot="tooltip-content"]')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('Delegate work to subagents and read their results.')
    // The member tools render as a real <ul>/<li> list under a bold label —
    // proving the tooltip content is markdown-rendered, not raw text. (Radix's
    // Presence may remount the portaled content in jsdom, so assert membership
    // rather than an exact, possibly-duplicated sequence.)
    expect(tip!.querySelector('strong')?.textContent).toBe('Tools:')
    const items = Array.from(tip!.querySelectorAll('li')).map((li) => li.textContent)
    for (const name of ['delegate', 'cancel_delegation', 'reflect']) {
      expect(items).toContain(name)
    }
  })

  it('renders a tool tooltip description as markdown (bold rubric labels)', async () => {
    await render()
    await openPicker()
    await hoverMenuItem('bash_exec')
    const tip = document.body.querySelector('[data-slot="tooltip-content"]')
    expect(tip).not.toBeNull()
    // Each rubric section becomes a paragraph with a bold label.
    const strongs = Array.from(tip!.querySelectorAll('strong')).map((s) => s.textContent)
    expect(strongs).toContain('Purpose:')
    expect(strongs).toContain('Anti-example:')
    expect(tip!.textContent).toContain('Purpose: run shell commands.')
    expect(tip!.textContent).toContain('Anti-example: not for file reads.')
  })

  it('renders the read_skill_resource tooltip as markdown (bold rubric labels)', async () => {
    await render()
    await openPicker()
    await hoverMenuItem('read_skill_resource')
    const tip = document.body.querySelector('[data-slot="tooltip-content"]')
    expect(tip).not.toBeNull()
    // The SDK tool's description carries the same rubric as every other tool, so
    // it formats identically — each section a paragraph with a bold label.
    const strongs = Array.from(tip!.querySelectorAll('strong')).map((s) => s.textContent)
    expect(strongs).toContain('Purpose:')
    expect(strongs).toContain('Use when:')
    expect(strongs).toContain('Anti-example:')
    expect(tip!.textContent).toContain('read a resource file bundled with an activated skill')
  })
})

describe('ModelProfilesSettings — inline validation errors', () => {
  it('shows the backend validation error next to the form and reverts local state', async () => {
    getModelProfilesMock.mockResolvedValue(
      respWith({ context: { ...baseValues.context, enabled: true } }),
    )
    await render()
    updateModelProfileMock.mockRejectedValue(new Error('keep_last must be >= 2'))

    await setField(field('Keep last')!, '4')
    await blur(field('Keep last')!)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const text = container.textContent ?? ''
    expect(text).toContain('keep_last must be >= 2')
    // Config was reloaded from the backend (reverted).
    expect(getModelProfilesMock).toHaveBeenCalledTimes(2)
    expect(field('Keep last')?.value).toBe('6')
  })
})
