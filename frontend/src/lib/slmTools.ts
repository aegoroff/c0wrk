import type { SLMBuiltinTool, SLMToolGroup } from '@/types/models'

/**
 * One selectable entry in the Small-LLM "Always-present tools" picker.
 *
 * The picker mixes two kinds of entry:
 *   - a **cluster** (see `SLMToolGroup`): picking it pins every member at
 *     once (`members`), so a workflow can never be selected partially — e.g.
 *     the plan-step tool without the plan-declaration tool;
 *   - a **single tool** left ungrouped (`members` undefined).
 *
 * `tooltip` is compact **markdown** rendered by the picker: for a cluster it is
 * the cluster description followed by a bullet list of every member tool; for a
 * tool it is that tool's registry description, reformatted from its plain
 * rubric lines (`Purpose:` / `Use when:` / …) into bold-labelled paragraphs
 * (see `toolDescriptionMarkdown`).
 */
export interface PickerOption {
  /** Value handed to the picker's onChange (a `group:<id>` token for clusters). */
  value: string
  /** Human-readable label shown in the menu. */
  label: string
  /** Hover tooltip as markdown (rendered by the picker's combobox). */
  tooltip: string
  /** Member tools to pin when this option is a cluster; undefined for a tool. */
  members?: string[]
}

/** Prefix marking a cluster entry's value, keeping it distinct from tool names. */
export const GROUP_VALUE_PREFIX = 'group:'

/**
 * Rubric section labels that every built-in tool description leads a line with
 * (enforced by `core/tools/descriptions_guard_test.go` and the sp4rk
 * `tools/builtins` guard). Kept in one place so the parser and the rendered
 * labels can never drift.
 */
const DESCRIPTION_SECTION_LABELS = [
  'Purpose',
  'Use when',
  'Inputs',
  'Outputs',
  'Example',
  'Anti-example',
] as const

const DESCRIPTION_SECTION_RE = new RegExp(
  `^(${DESCRIPTION_SECTION_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):\\s*(.*)$`,
)

/**
 * Reformat a built-in tool's registry description — plain `Label: text` rubric
 * lines — into compact markdown for the picker tooltip: every section becomes
 * its own paragraph whose label is bold, and continuation lines fold into the
 * current paragraph. Deliberately heading-free (no `#`) so it stays readable in
 * a narrow hover card.
 *
 * ```
 * Purpose: do a thing.
 * Use when: you need a thing.
 * ```
 * becomes
 * ```
 * **Purpose:** do a thing.
 *
 * **Use when:** you need a thing.
 * ```
 *
 * A description without rubric labels is returned as a single paragraph
 * unchanged, so non-rubric text (e.g. a test fixture) is never dropped.
 */
export function toolDescriptionMarkdown(description: string): string {
  const text = description.trim()
  if (text === '') return ''

  const sections: { label: string; lines: string[] }[] = []
  let current: { label: string; lines: string[] } | null = null

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const match = DESCRIPTION_SECTION_RE.exec(line)
    if (match) {
      // A rubric label begins a new paragraph. (The capture groups are typed
      // `string | undefined` under noUncheckedIndexedAccess; the regex
      // guarantees group 1, and group 2 defaults to an empty body.)
      current = { label: match[1] ?? '', lines: [match[2] ?? ''] }
      sections.push(current)
    } else {
      // Continuation of the current section; a leading untagged line gets its
      // own label-less paragraph.
      if (!current) {
        current = { label: '', lines: [] }
        sections.push(current)
      }
      current.lines.push(line)
    }
  }

  return sections
    .map(({ label, lines }) => {
      const body = lines.join(' ').trim()
      if (label === '') return body
      return body === '' ? `**${label}:**` : `**${label}:** ${body}`
    })
    .filter((block) => block !== '')
    .join('\n\n')
}

/**
 * Build the markdown tooltip for a workflow cluster: the cluster description
 * (the capability it grants the agent) as a paragraph, followed by a bullet
 * list of every member tool — including ones already pinned, so the entry
 * documents the whole workflow.
 */
export function toolGroupTooltipMarkdown(
  description: string,
  tools: readonly string[],
): string {
  const blocks: string[] = []
  const desc = description.trim()
  if (desc !== '') blocks.push(desc)
  if (tools.length > 0) {
    const bullets = tools.map((name) => `- \`${name}\``).join('\n')
    blocks.push(`**Tools:**\n\n${bullets}`)
  }
  return blocks.join('\n\n')
}

/**
 * Candidate entries for the Small-LLM "Always-present tools" picker.
 *
 * The backend reports `builtinTools` as every registered non-MCP (built-in)
 * tool with its description, and `toolGroups` as the workflow clusters whose
 * members are pinned together. The picker must offer only what is not already
 * allowed:
 *
 *   - explicitly — the user's pins in `alwaysPresent`;
 *   - implicitly — the protected orchestration tools (`protectedTools`, which
 *     `SelectTools` always keeps and the UI renders as locked chips) and every
 *     MCP tool, which is never a built-in and therefore never appears in
 *     `builtinTools`.
 *
 * Clusters come first, each offering only its still-selectable members (and
 * hidden entirely when none remain); their markdown tooltip lists ALL cluster
 * members, including already-allowed ones, so the entry documents the whole
 * workflow. Ungrouped tools follow in backend order (sorted). Grouped tools are
 * never listed individually — that is what makes the cluster atomic.
 */
export function essentialToolPickerOptions(
  builtinTools: readonly SLMBuiltinTool[],
  toolGroups: readonly SLMToolGroup[],
  alwaysPresent: readonly string[],
  protectedTools: readonly string[] = [],
): PickerOption[] {
  const allowed = new Set([...alwaysPresent, ...protectedTools])
  const candidates = new Set(
    builtinTools.filter((t) => !allowed.has(t.name)).map((t) => t.name),
  )

  const grouped = new Set<string>()
  const options: PickerOption[] = []

  for (const group of toolGroups) {
    for (const name of group.tools) grouped.add(name)
    const members = group.tools.filter((name) => candidates.has(name))
    if (members.length === 0) continue
    options.push({
      value: `${GROUP_VALUE_PREFIX}${group.id}`,
      label: group.title,
      tooltip: toolGroupTooltipMarkdown(group.description, group.tools),
      members,
    })
  }

  for (const tool of builtinTools) {
    if (candidates.has(tool.name) && !grouped.has(tool.name)) {
      options.push({
        value: tool.name,
        label: tool.name,
        tooltip: toolDescriptionMarkdown(tool.description),
      })
    }
  }

  return options
}
