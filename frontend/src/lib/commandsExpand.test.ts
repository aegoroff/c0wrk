import { describe, it, expect } from 'vitest'
import {
  parseLeadingCommandToken,
  resolveLeadingCommand,
  expandCommand,
  splitPositionalArgs,
} from './commandsExpand'
import type { CommandDescriptor } from '@/types/models'

function cmd(overrides: Partial<CommandDescriptor> = {}): CommandDescriptor {
  return { name: 'deploy', description: 'Deploy', agent: '', model: '', template: 'T', ...overrides }
}

describe('parseLeadingCommandToken', () => {
  it('parses a plain leading token with args', () => {
    expect(parseLeadingCommandToken('/deploy prod --fast')).toEqual({
      name: 'deploy',
      args: 'prod --fast',
      qualified: false,
    })
  })

  it('parses a bare leading token with no args', () => {
    expect(parseLeadingCommandToken('/deploy')).toEqual({ name: 'deploy', args: '', qualified: false })
  })

  it('parses both qualified spellings', () => {
    expect(parseLeadingCommandToken('/command: deploy arg')).toEqual({
      name: 'deploy',
      args: 'arg',
      qualified: true,
    })
    expect(parseLeadingCommandToken('/command:deploy')).toEqual({
      name: 'deploy',
      args: '',
      qualified: true,
    })
  })

  it('tolerates a run of spaces or tabs after the qualified colon', () => {
    expect(parseLeadingCommandToken('/command:   deploy arg')).toEqual({
      name: 'deploy',
      args: 'arg',
      qualified: true,
    })
    expect(parseLeadingCommandToken('/command:\tdeploy')).toEqual({
      name: 'deploy',
      args: '',
      qualified: true,
    })
  })

  it('still rejects a qualified colon followed only by whitespace', () => {
    expect(parseLeadingCommandToken('/command:   ')).toBeNull()
    expect(parseLeadingCommandToken('/command:\t')).toBeNull()
  })

  it('skips leading whitespace', () => {
    expect(parseLeadingCommandToken('  /deploy')).toEqual({ name: 'deploy', args: '', qualified: false })
  })

  it('rejects a mid-message token', () => {
    expect(parseLeadingCommandToken('please /deploy now')).toBeNull()
  })

  it('rejects a token that never reaches a boundary', () => {
    // Paths and punctuation suffixes cannot backtrack into a shorter name.
    expect(parseLeadingCommandToken('/deploy/x')).toBeNull()
    expect(parseLeadingCommandToken('/deploy:arg')).toBeNull()
  })

  it('rejects a malformed qualified id', () => {
    expect(parseLeadingCommandToken('/command: ')).toBeNull()
    expect(parseLeadingCommandToken('/command:')).toBeNull()
  })

  it('non-slash text is not a token', () => {
    expect(parseLeadingCommandToken('deploy now')).toBeNull()
    expect(parseLeadingCommandToken('')).toBeNull()
  })
})

describe('resolveLeadingCommand', () => {
  const view = {
    commands: new Map([['deploy', cmd()]]),
    agentNames: new Set(['review']),
    skillNames: new Set(['review', 'test']),
    mcpNames: new Set<string>(),
  }

  it('a plain name in exactly the command catalog resolves to the command', () => {
    const r = resolveLeadingCommand({ name: 'deploy', args: 'a', qualified: false }, view)
    expect(r).toEqual({ kind: 'command', command: view.commands.get('deploy'), args: 'a', qualified: false })
  })

  it('a qualified unknown id degrades to none (fail-closed)', () => {
    expect(resolveLeadingCommand({ name: 'ghost', args: '', qualified: true }, view).kind).toBe('none')
  })

  it('a plain unknown name degrades to none (permissive passthrough owns it)', () => {
    expect(resolveLeadingCommand({ name: 'ghost', args: '', qualified: false }, view).kind).toBe('none')
  })

  it('a name in two catalogs is ambiguous with both listed', () => {
    const r = resolveLeadingCommand({ name: 'review', args: '', qualified: false }, view)
    expect(r).toEqual({ kind: 'ambiguous', name: 'review', catalogs: ['agent', 'skill'] })
  })

  it('a skill+command collision is ambiguous', () => {
    const withCollision = {
      ...view,
      commands: new Map([['test', cmd({ name: 'test' })]]),
    }
    const r = resolveLeadingCommand({ name: 'test', args: '', qualified: false }, withCollision)
    expect(r).toEqual({ kind: 'ambiguous', name: 'test', catalogs: ['skill', 'command'] })
  })

  it('the qualified form wins over any collision', () => {
    const withCollision = {
      ...view,
      commands: new Map([['review', cmd({ name: 'review' })]]),
    }
    const r = resolveLeadingCommand({ name: 'review', args: '', qualified: true }, withCollision)
    expect(r).toEqual({ kind: 'command', command: withCollision.commands.get('review'), args: '', qualified: true })
  })
})

describe('splitPositionalArgs', () => {
  it('splits on whitespace', () => {
    expect(splitPositionalArgs('a b  c')).toEqual(['a', 'b', 'c'])
  })

  it('groups double-quoted runs as one argument', () => {
    expect(splitPositionalArgs('config.json src "{ \\"key\\": \\"value\\" }"')).toEqual([
      'config.json',
      'src',
      '{ "key": "value" }',
    ])
  })

  it('unescapes exactly the two documented escapes inside quotes', () => {
    expect(splitPositionalArgs('"\\"quoted\\""')).toEqual(['"quoted"'])
    expect(splitPositionalArgs('"a\\\\b"')).toEqual(['a\\b'])
  })

  it('a backslash before any other character survives verbatim', () => {
    expect(splitPositionalArgs('"C:\\Users\\zab\\report.md"')).toEqual(['C:\\Users\\zab\\report.md'])
    expect(splitPositionalArgs('"x\\ny"')).toEqual(['x\\ny'])
  })

  it('an empty quoted run is a positional argument', () => {
    expect(splitPositionalArgs('a "" b')).toEqual(['a', '', 'b'])
  })

  it('an unterminated quote groups to the end', () => {
    expect(splitPositionalArgs('a "b c')).toEqual(['a', 'b c'])
  })

  it('empty input yields no positionals', () => {
    expect(splitPositionalArgs('')).toEqual([])
    expect(splitPositionalArgs('   ')).toEqual([])
  })
})

describe('expandCommand', () => {
  it('substitutes $ARGUMENTS with the raw remainder', () => {
    const e = expandCommand(cmd({ template: 'Run $ARGUMENTS now' }), 'tests --cover')
    expect(e.text).toBe('Run tests --cover now')
  })

  it('substitutes positional $N and leaves missing ones empty', () => {
    const e = expandCommand(cmd({ template: 'Create $1 in $2 with: $3 | $9' }), 'config.json src "{}"')
    expect(e.text).toBe('Create config.json in src with: {} | ')
  })

  it('substituted values never re-expand (one pass, literal)', () => {
    const e = expandCommand(cmd({ template: 'A $1 B $ARGUMENTS' }), '$1 $& x')
    expect(e.text).toBe('A $1 B $1 $& x')
  })

  it('$0 expands to empty; template without placeholders is verbatim', () => {
    expect(expandCommand(cmd({ template: 'plain body' }), 'ignored').text).toBe('plain body')
    expect(expandCommand(cmd({ template: 'zero: $0' }), 'a').text).toBe('zero: ')
  })

  it('carries the frontmatter bindings', () => {
    const e = expandCommand(cmd({ agent: 'reviewer', model: 'gpt-x', template: 'T' }), '')
    expect(e.agent).toBe('reviewer')
    expect(e.model).toBe('gpt-x')
  })
})
