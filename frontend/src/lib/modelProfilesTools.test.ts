import { describe, it, expect } from 'vitest'

import type { ModelProfilesBuiltinTool, ModelProfilesToolGroup } from '@/types/models'
import {
  essentialToolPickerOptions,
  toolDescriptionMarkdown,
  toolGroupTooltipMarkdown,
  GROUP_VALUE_PREFIX,
} from './modelProfilesTools'

const TOOLS: ModelProfilesBuiltinTool[] = [
  { name: 'declare_plan', description: 'declare a plan' },
  { name: 'execute_plan', description: 'execute a plan' },
  { name: 'declare_step_complete', description: 'mark a step' },
  { name: 'update_checklist', description: 'update the checklist' },
  { name: 'web_search', description: 'search the web' },
  { name: 'read_file', description: 'read a file' },
]

const GROUPS: ModelProfilesToolGroup[] = [
  {
    id: 'plan',
    title: 'Planning & steps',
    description: 'Plan work and track steps.',
    tools: ['declare_plan', 'execute_plan', 'declare_step_complete', 'update_checklist'],
  },
]

const byValue = (opts: ReturnType<typeof essentialToolPickerOptions>, value: string) =>
  opts.find((o) => o.value === value)

describe('essentialToolPickerOptions', () => {
  it('offers a cluster as one atomic entry with all its members', () => {
    const opts = essentialToolPickerOptions(TOOLS, GROUPS, [], [])
    const plan = byValue(opts, `${GROUP_VALUE_PREFIX}plan`)
    expect(plan).toBeDefined()
    expect(plan?.label).toBe('Planning & steps')
    expect(plan?.members).toEqual([
      'declare_plan',
      'execute_plan',
      'declare_step_complete',
      'update_checklist',
    ])
    // The tooltip carries the cluster description AND the full member list, as
    // markdown (description paragraph + bold "Tools:" + bullet list).
    expect(plan?.tooltip).toContain('Plan work and track steps.')
    expect(plan?.tooltip).toContain('**Tools:**')
    expect(plan?.tooltip).toContain('- `declare_plan`')
    expect(plan?.tooltip).toContain('- `execute_plan`')
    expect(plan?.tooltip).toContain('- `declare_step_complete`')
    expect(plan?.tooltip).toContain('- `update_checklist`')
  })

  it('never lists grouped tools individually (the cluster is atomic)', () => {
    const opts = essentialToolPickerOptions(TOOLS, GROUPS, [], [])
    const values = opts.map((o) => o.value)
    expect(values).not.toContain('declare_plan')
    expect(values).not.toContain('execute_plan')
    expect(values).not.toContain('declare_step_complete')
    expect(values).not.toContain('update_checklist')
  })

  it('lists clusters first, then ungrouped tools in backend order with their description', () => {
    const opts = essentialToolPickerOptions(TOOLS, GROUPS, [], [])
    expect(opts.map((o) => o.value)).toEqual([
      `${GROUP_VALUE_PREFIX}plan`,
      'web_search',
      'read_file',
    ])
    expect(byValue(opts, 'web_search')?.tooltip).toBe('search the web')
    expect(byValue(opts, 'read_file')?.members).toBeUndefined()
  })

  it('offers only the still-selectable members of a partly-allowed cluster', () => {
    const opts = essentialToolPickerOptions(
      TOOLS,
      GROUPS,
      ['declare_plan', 'execute_plan', 'declare_step_complete'],
      [],
    )
    const plan = byValue(opts, `${GROUP_VALUE_PREFIX}plan`)
    expect(plan?.members).toEqual(['update_checklist'])
    // The tooltip still documents the whole cluster, including pinned members.
    expect(plan?.tooltip).toContain('declare_plan')
  })

  it('hides a cluster whose members are all already allowed', () => {
    const opts = essentialToolPickerOptions(
      TOOLS,
      GROUPS,
      ['declare_plan', 'execute_plan', 'declare_step_complete', 'update_checklist'],
      [],
    )
    expect(byValue(opts, `${GROUP_VALUE_PREFIX}plan`)).toBeUndefined()
    expect(opts.map((o) => o.value)).toEqual(['web_search', 'read_file'])
  })

  it('excludes tools already in always_present', () => {
    const opts = essentialToolPickerOptions(TOOLS, GROUPS, ['read_file'], [])
    expect(opts.map((o) => o.value)).toEqual([`${GROUP_VALUE_PREFIX}plan`, 'web_search'])
  })

  it('excludes protected tools even when they are absent from always_present', () => {
    // The backend normally unions protected tools into always_present; this
    // guards the picker against a payload that did not.
    const opts = essentialToolPickerOptions(TOOLS, GROUPS, ['read_file'], ['update_checklist'])
    const plan = byValue(opts, `${GROUP_VALUE_PREFIX}plan`)
    expect(plan?.members).toEqual(['declare_plan', 'execute_plan', 'declare_step_complete'])
  })

  it('ignores cluster members absent from the built-in universe', () => {
    const groups: ModelProfilesToolGroup[] = [
      { id: 'ghost', title: 'Ghost', description: 'n/a', tools: ['ghost_tool'] },
    ]
    const opts = essentialToolPickerOptions(TOOLS, groups, [], [])
    expect(byValue(opts, `${GROUP_VALUE_PREFIX}ghost`)).toBeUndefined()
    expect(opts.map((o) => o.value)).toEqual([
      'declare_plan',
      'execute_plan',
      'declare_step_complete',
      'update_checklist',
      'web_search',
      'read_file',
    ])
  })
})

describe('toolDescriptionMarkdown', () => {
  it('turns each rubric section into its own paragraph with a bold label', () => {
    const desc =
      'Purpose: do a thing.\n' +
      'Use when: you need a thing.\n' +
      'Inputs: command.\n' +
      'Anti-example: not for other things.'
    expect(toolDescriptionMarkdown(desc)).toBe(
      '**Purpose:** do a thing.\n\n' +
        '**Use when:** you need a thing.\n\n' +
        '**Inputs:** command.\n\n' +
        '**Anti-example:** not for other things.',
    )
  })

  it('folds continuation lines into the current section and drops blank lines', () => {
    const desc = 'Purpose: line one\ncontinued here.\n\nUse when: now.'
    expect(toolDescriptionMarkdown(desc)).toBe(
      '**Purpose:** line one continued here.\n\n**Use when:** now.',
    )
  })

  it('keeps an unlabelled description as a single paragraph', () => {
    expect(toolDescriptionMarkdown('run shell commands')).toBe('run shell commands')
  })

  it('returns an empty string for empty/whitespace input', () => {
    expect(toolDescriptionMarkdown('   \n  ')).toBe('')
  })
})

describe('toolGroupTooltipMarkdown', () => {
  it('renders the description paragraph plus a bullet list of every member', () => {
    expect(toolGroupTooltipMarkdown('Plan work.', ['declare_plan', 'execute_plan'])).toBe(
      'Plan work.\n\n**Tools:**\n\n- `declare_plan`\n- `execute_plan`',
    )
  })

  it('omits the tool list when the cluster has no members', () => {
    expect(toolGroupTooltipMarkdown('Plan work.', [])).toBe('Plan work.')
  })
})
