// Leading-command parsing and template expansion for custom commands (ADR-096).
//
// A custom command is invoked by a LEADING `/name args…` token in the chat
// input (or the collision-qualified `/command: name` form). Commands are NOT
// mentions: they replace the message with the expanded template before the
// mention pipeline runs, so the backend contracts (PreprocessMessageText,
// SendMessage) stay untouched. Everything here is pure — the controller owns
// the catalog fetches and the send flow.

import type { CommandDescriptor } from '@/types/models'

/** The boundary class shared with parseReferences (Go's isRefBoundarySpace
 *  set, not JavaScript's wider Unicode-aware \s). */
const BOUNDARY = '[ \\t\\n\\r\\f]'
// Strict EOF assertion: JavaScript's `$` also accepts a position before a
// final Unicode line separator, which Go does not treat as a boundary.
const EOF = '(?![\\s\\S])'

// Qualified form: /command:name with an OPTIONAL RUN of spaces/tabs after
// the colon (`/command:  name` — a deliberate widening of the ADR-076
// single-space mention grammar: docs/commands.md invites typing /command: by
// hand, and an extra space must not degrade the invocation into a phantom
// plain `command` skill ref). The name ends at a boundary or EOF.
const QUALIFIED_TOKEN_SOURCE = String.raw`\/command:[ \t]*([\w-]+)(?=${BOUNDARY}|${EOF})`
// Plain form: /name with the same boundary rule.
const PLAIN_TOKEN_SOURCE = String.raw`\/([\w-]+)(?=${BOUNDARY}|${EOF})`
const QUALIFIED_TOKEN_RE = new RegExp(`^${QUALIFIED_TOKEN_SOURCE}`)
const PLAIN_TOKEN_RE = new RegExp(`^${PLAIN_TOKEN_SOURCE}`)

export interface LeadingCommandToken {
  /** Command name as typed (catalog lookups are exact, case-sensitive). */
  name: string
  /** Raw remainder after the token with leading whitespace stripped; ''
   *  when the message ends at the token. */
  args: string
  /** True for the collision-qualified /command: form. */
  qualified: boolean
}

/**
 * Parse the LEADING command token of a message. Only a token at the very
 * start (after whitespace) can invoke a command — mid-message `/name` stays
 * in the mention pipeline. Returns null when the message does not start with
 * a syntactically complete token (including `/command:` with a missing or
 * malformed id, and a plain `/name` that never reaches a boundary — paths and
 * punctuation suffixes cannot backtrack into a shorter name).
 */
export function parseLeadingCommandToken(text: string): LeadingCommandToken | null {
  const trimmed = text.replace(/^[ \t\r\n\f]+/, '')
  const qualified = QUALIFIED_TOKEN_RE.exec(trimmed)
  if (qualified && qualified[1] !== undefined) {
    return { name: qualified[1], args: trimmed.slice(qualified[0].length).replace(/^[ \t]+/, ''), qualified: true }
  }
  const plain = PLAIN_TOKEN_RE.exec(trimmed)
  if (plain && plain[1] !== undefined) {
    return { name: plain[1], args: trimmed.slice(plain[0].length).replace(/^[ \t]+/, ''), qualified: false }
  }
  return null
}

/** The four catalogs a leading plain token resolves against (ADR-096
 *  generalizes the ADR-076 collision rule to the command catalog). */
export interface CommandCatalogView {
  commands: ReadonlyMap<string, CommandDescriptor>
  agentNames: ReadonlySet<string>
  skillNames: ReadonlySet<string>
  mcpNames: ReadonlySet<string>
}

export type LeadingCommandResolution =
  | { kind: 'none' }
  /** The name is present in MORE THAN ONE catalog — the ADR-076 visible
   *  no-op; `catalogs` names the hits so the caller can defer to the
   *  existing partitionRefs no-op for mention-only collisions. */
  | { kind: 'ambiguous'; name: string; catalogs: string[] }
  | { kind: 'command'; command: CommandDescriptor; args: string; qualified: boolean }

/**
 * Resolve a leading token against the four catalogs. The qualified form is
 * always valid input: an unknown id resolves to 'none' and the text is
 * preserved verbatim (fail-closed, like every catalog-gated mention). A plain
 * token in exactly one catalog gets that catalog's behavior; in more than
 * one — the ambiguous no-op; in none — 'none' (the historical permissive
 * skill passthrough owns it downstream).
 */
export function resolveLeadingCommand(token: LeadingCommandToken, view: CommandCatalogView): LeadingCommandResolution {
  if (token.qualified) {
    const command = view.commands.get(token.name)
    if (!command) return { kind: 'none' }
    return { kind: 'command', command, args: token.args, qualified: true }
  }
  const hits: string[] = []
  if (view.agentNames.has(token.name)) hits.push('agent')
  if (view.skillNames.has(token.name)) hits.push('skill')
  if (view.mcpNames.has(token.name)) hits.push('mcp')
  const command = view.commands.get(token.name)
  if (command) hits.push('command')
  if (hits.length > 1) return { kind: 'ambiguous', name: token.name, catalogs: hits }
  if (command) return { kind: 'command', command, args: token.args, qualified: false }
  return { kind: 'none' }
}

export interface CommandExpansion {
  /** The expanded message text to send in place of the invocation. */
  text: string
  /** The frontmatter `agent` binding — merged into the partitioned agents. */
  agent: string
  /** The frontmatter `model` binding — a fallback when the user has no
   *  explicit model selected (an explicit selection always wins). */
  model: string
}

/**
 * Expand an invoked command: substitute $ARGUMENTS and the positional $N
 * placeholders in the template. One left-to-right pass; substituted values
 * are inserted LITERALLY (a `$1` inside an argument never re-expands and
 * `$&`-style replacement patterns in arguments cannot fire). `$N` beyond the
 * provided arguments and `$0` expand to the empty string. There are no
 * escape sequences in v1 (ADR-096): a literal `$1` in a template is
 * indistinguishable from the placeholder.
 */
export function expandCommand(command: CommandDescriptor, args: string): CommandExpansion {
  const positionals = splitPositionalArgs(args)
  const text = command.template.replace(/\$(ARGUMENTS|[0-9]+)/g, (_match, key: string) => {
    if (key === 'ARGUMENTS') return args
    const index = Number(key)
    return index >= 1 ? (positionals[index - 1] ?? '') : ''
  })
  return { text, agent: command.agent, model: command.model }
}

/**
 * Split the argument remainder into positional arguments: whitespace-separated
 * tokens, where a double-quoted run groups as ONE argument (POSIX-style
 * backslash escapes inside quotes: \" for a literal quote, \\ for a
 * backslash — a backslash before ANY other character survives verbatim, so
 * quoted Windows paths and `\n`-style literals pass through untouched).
 * Bare tokens keep their characters verbatim — no shell semantics beyond
 * grouping.
 */
export function splitPositionalArgs(argsString: string): string[] {
  const out: string[] = []
  // A complete quoted run first, then an unterminated one (groups to the end
  // of the remainder — a missing closing quote must not scatter the tail
  // into bare tokens), then a bare token.
  const re = /"((?:[^"\\]|\\.)*)"|"(.*)$|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(argsString)) !== null) {
    if (m[1] !== undefined) {
      out.push(m[1].replace(/\\(["\\])/g, '$1'))
    } else if (m[2] !== undefined) {
      out.push(m[2].replace(/\\(["\\])/g, '$1'))
    } else if (m[3] !== undefined) {
      out.push(m[3])
    }
  }
  return out
}
