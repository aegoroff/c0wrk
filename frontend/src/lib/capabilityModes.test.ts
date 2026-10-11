// Unit tests for lib/capabilityModes.ts — the shared option list, the
// per-context explanation copy used by every Capabilities card, the pure
// session-kind mentionability filter behind the /-completion and the send
// path, and the project_id → session-kind mapping.

import { describe, it, expect } from 'vitest'

import {
  CAPABILITY_MODE_OPTIONS,
  capabilityModeExplanation,
  isDisabledInBothContexts,
  isManualAnywhere,
  isMentionableInContext,
  mentionableNamesInContext,
  sessionKindFromProjectId,
} from '@/lib/capabilityModes'
import { NO_PROJECT_ID, type CapabilityModes } from '@/types/models'

describe('CAPABILITY_MODE_OPTIONS', () => {
  it('lists the three canonical modes in menu order', () => {
    expect(CAPABILITY_MODE_OPTIONS.map((o) => o.value)).toEqual(['auto', 'manual', 'disabled'])
    expect(CAPABILITY_MODE_OPTIONS.map((o) => o.label)).toEqual(['auto', 'manual', 'disabled'])
  })
})

describe('capabilityModeExplanation', () => {
  it('names the session type explicitly in every explanation', () => {
    expect(capabilityModeExplanation('chat', 'auto')).toContain('Chat sessions')
    expect(capabilityModeExplanation('code', 'auto')).toContain('Code sessions')
  })

  it('auto: always available in that context', () => {
    expect(capabilityModeExplanation('chat', 'auto')).toBe('Chat sessions: always available.')
  })

  it('manual: held back until a /name mention enables it', () => {
    expect(capabilityModeExplanation('code', 'manual')).toBe('Code sessions: held back until a /name mention enables it for the task.')
  })

  it('disabled: never advertised in that context, other context unaffected', () => {
    expect(capabilityModeExplanation('chat', 'disabled')).toBe('Chat sessions: never advertised — the other context is unaffected.')
    expect(capabilityModeExplanation('code', 'disabled')).toBe('Code sessions: never advertised — the other context is unaffected.')
  })
})

describe('neutral-render predicates', () => {
  it('disabled-in-both is the only inert combination', () => {
    expect(isDisabledInBothContexts('disabled', 'disabled')).toBe(true)
    expect(isDisabledInBothContexts('disabled', 'auto')).toBe(false)
    expect(isDisabledInBothContexts('auto', 'disabled')).toBe(false)
    expect(isDisabledInBothContexts('manual', 'manual')).toBe(false)
  })

  it('manual anywhere is badge-worthy', () => {
    expect(isManualAnywhere('manual', 'auto')).toBe(true)
    expect(isManualAnywhere('auto', 'manual')).toBe(true)
    expect(isManualAnywhere('auto', 'auto')).toBe(false)
    expect(isManualAnywhere('disabled', 'disabled')).toBe(false)
  })
})

describe('isMentionableInContext — the (kind, modes) → mentionable/hidden filter', () => {
  it('auto and manual are mentionable, disabled is hidden — per context', () => {
    for (const context of ['chat', 'code'] as const) {
      expect(isMentionableInContext(context, { chat_mode: 'auto', code_mode: 'auto' })).toBe(true)
      expect(isMentionableInContext(context, { chat_mode: 'manual', code_mode: 'manual' })).toBe(true)
      expect(isMentionableInContext(context, { chat_mode: 'disabled', code_mode: 'disabled' })).toBe(false)
    }
  })

  it('reads ONLY the active context\u2019s column — the other context\u2019s mode is irrelevant', () => {
    // Chat-disabled but code-auto: mentionable for CODE sessions, hidden for CHAT.
    expect(isMentionableInContext('chat', { chat_mode: 'disabled', code_mode: 'auto' })).toBe(false)
    expect(isMentionableInContext('code', { chat_mode: 'disabled', code_mode: 'auto' })).toBe(true)
    // Manual-in-chat + disabled-in-code: the mirror image.
    expect(isMentionableInContext('chat', { chat_mode: 'manual', code_mode: 'disabled' })).toBe(true)
    expect(isMentionableInContext('code', { chat_mode: 'manual', code_mode: 'disabled' })).toBe(false)
  })
})

describe('mentionableNamesInContext — catalog filtering for skills/agents', () => {
  it('keeps auto and manual names, drops explicitly disabled ones for the context', () => {
    const modes: Record<string, CapabilityModes> = {
      'auto-skill': { chat_mode: 'auto', code_mode: 'auto' },
      'chat-only': { chat_mode: 'manual', code_mode: 'disabled' },
      'code-only': { chat_mode: 'disabled', code_mode: 'manual' },
    }
    expect(mentionableNamesInContext(['auto-skill', 'chat-only', 'code-only'], modes, 'chat')).toEqual([
      'auto-skill',
      'chat-only',
    ])
    expect(mentionableNamesInContext(['auto-skill', 'chat-only', 'code-only'], modes, 'code')).toEqual([
      'auto-skill',
      'code-only',
    ])
  })

  it('treats a name missing from the section as auto (the zero-regression default)', () => {
    const modes: Record<string, CapabilityModes> = { known: { chat_mode: 'auto', code_mode: 'disabled' } }
    expect(mentionableNamesInContext(['known', 'unknown-skill'], modes, 'code')).toEqual(['unknown-skill'])
    expect(mentionableNamesInContext(['known', 'unknown-skill'], modes, 'chat')).toEqual([
      'known',
      'unknown-skill',
    ])
  })

  it('filters nothing when the section is missing (capabilities fetch failed → fail open)', () => {
    const names = ['a', 'b']
    expect(mentionableNamesInContext(names, null, 'chat')).toBe(names)
    expect(mentionableNamesInContext(names, undefined, 'code')).toBe(names)
  })
})

describe('sessionKindFromProjectId — SessionInfo.project_id → context', () => {
  it('maps NO_PROJECT_ID to the chat context', () => {
    expect(sessionKindFromProjectId(NO_PROJECT_ID)).toBe('chat')
  })

  it('maps a real project id to the code context', () => {
    expect(sessionKindFromProjectId('proj-1')).toBe('code')
  })

  it('treats a missing id as chat (the no-session fallback context)', () => {
    expect(sessionKindFromProjectId(null)).toBe('chat')
    expect(sessionKindFromProjectId(undefined)).toBe('chat')
    expect(sessionKindFromProjectId('')).toBe('chat')
  })
})
