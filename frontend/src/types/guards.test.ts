import { describe, expect, it } from 'vitest'
import { isModelProfile, isModelProfileKind, isModelProfilesResponse } from './guards'
import type { ModelProfilesResponse } from './models'

// Canonical GetModelProfiles wire payload (mirrors backend/api_types.go):
// every field the backend serializes is present, lists are [] (never null),
// suggested_profile_id is null when no predefined profile matches.
const baseResponse: ModelProfilesResponse = {
  enabled: false,
  profiles: [
    {
      id: 'generic',
      name: 'Generic',
      kind: 'predefined',
      values: {
        essential_tools: {
          enabled: false,
          always_present: ['read_file'],
          compact_descriptions: false,
        },
        system_prompt: { lite: false, few_shot: false, reasoning_scaffold: false },
        sampling: {
          enabled: false,
          temperature: 0,
          top_p: 0,
          top_k: 0,
          repetition_penalty: 0,
          presence_penalty: 0,
          reasoning_effort: '',
        },
        loop_hardening: {
          enabled: false,
          repeat_nudge_threshold: 0,
          parse_error_abort_threshold: 0,
          fruitless_nudge_threshold: 0,
          fruitless_abort_threshold: 0,
          same_tool_repeat_nudge_threshold: 0,
        },
        context: {
          enabled: false,
          compaction: { keep_last: 0, block_size: 0, trigger_percent: 0 },
          tool_output_keep_last_n: 0,
          output_token_reserve: 0,
        },
      },
    },
    {
      id: 'my-profile',
      name: 'My profile',
      kind: 'custom',
      values: {
        essential_tools: {
          enabled: true,
          always_present: ['read_file', 'write_file'],
          compact_descriptions: true,
        },
        system_prompt: { lite: true, few_shot: false, reasoning_scaffold: true },
        sampling: {
          enabled: true,
          temperature: 0.6,
          top_p: 0.9,
          top_k: 20,
          repetition_penalty: 1.1,
          presence_penalty: 0,
          reasoning_effort: 'low',
        },
        loop_hardening: {
          enabled: true,
          repeat_nudge_threshold: 2,
          parse_error_abort_threshold: 3,
          fruitless_nudge_threshold: 2,
          fruitless_abort_threshold: 4,
          same_tool_repeat_nudge_threshold: 2,
        },
        context: {
          enabled: true,
          compaction: { keep_last: 4, block_size: 8, trigger_percent: 70 },
          tool_output_keep_last_n: 2,
          output_token_reserve: 2048,
        },
      },
    },
  ],
  active_id: 'my-profile',
  suggested_profile_id: null,
  builtin_tools: [
    { name: 'read_file', description: 'Read a file' },
    { name: 'write_file', description: 'Write a file' },
  ],
  tool_groups: [
    {
      id: 'plan',
      title: 'Planning',
      description: 'Plan + step lifecycle tools',
      tools: ['declare_plan', 'declare_step_complete'],
    },
  ],
  protected_tools: ['delegate'],
  warnings: ['stored active profile not found; using generic'],
}

/**
 * Fixture element access with a runtime guarantee
 * (noUncheckedIndexedAccess-friendly). Throws on a broken fixture instead of
 * silently mutating the wrong thing.
 */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i]
  if (v === undefined) throw new Error(`fixture element ${i} missing`)
  return v
}

function mutated(fn: (r: ModelProfilesResponse) => void): unknown {
  const clone = structuredClone(baseResponse)
  fn(clone)
  return clone
}

describe('isModelProfilesResponse', () => {
  it('accepts a canonical payload', () => {
    expect(isModelProfilesResponse(mutated(() => {}))).toBe(true)
  })

  it('accepts a string suggested_profile_id', () => {
    const payload = mutated((r) => {
      r.suggested_profile_id = 'qwen3'
    })
    expect(isModelProfilesResponse(payload)).toBe(true)
  })

  it('accepts an empty catalog with empty picker universe', () => {
    const payload = mutated((r) => {
      r.profiles = []
      r.active_id = 'generic'
      r.builtin_tools = []
      r.tool_groups = []
      r.protected_tools = []
      r.warnings = []
    })
    expect(isModelProfilesResponse(payload)).toBe(true)
  })

  it('rejects non-object payloads', () => {
    for (const bad of [null, undefined, 42, 'profiles', true, [], [baseResponse]]) {
      expect(isModelProfilesResponse(bad)).toBe(false)
    }
  })

  const malformed: Array<[label: string, mutate: (r: ModelProfilesResponse) => void]> = [
    ['missing profiles key', (r) => delete (r as { profiles?: unknown }).profiles],
    ['profiles not an array', (r) => ((r as { profiles?: unknown }).profiles = {})],
    [
      'profile missing id',
      (r) => delete (at(r.profiles, 0) as { id?: string }).id,
    ],
    ['profile id not a string', (r) => ((at(r.profiles, 0) as { id?: unknown }).id = 7)],
    ['profile name not a string', (r) => ((at(r.profiles, 0) as { name?: unknown }).name = null)],
    ['profile unknown kind', (r) => (at(r.profiles, 0).kind = 'system' as 'custom')],
    [
      'profile missing values',
      (r) => delete (at(r.profiles, 0) as { values?: unknown }).values,
    ],
    [
      'values missing sampling section',
      (r) => delete (at(r.profiles, 0).values as { sampling?: unknown }).sampling,
    ],
    [
      'sampling temperature not a number',
      (r) => ((at(r.profiles, 0).values.sampling as { temperature?: unknown }).temperature = '0.5'),
    ],
    [
      'sampling missing top_k',
      (r) => delete (at(r.profiles, 0).values.sampling as { top_k?: unknown }).top_k,
    ],
    [
      'sampling reasoning_effort not a string',
      (r) => ((at(r.profiles, 0).values.sampling as { reasoning_effort?: unknown }).reasoning_effort = 3),
    ],
    [
      'always_present element not a string',
      (r) => {
        const list = at(r.profiles, 0).values.essential_tools.always_present as unknown[]
        list[0] = 42
      },
    ],
    [
      'essential_tools missing compact_descriptions',
      (r) =>
        delete (at(r.profiles, 0).values.essential_tools as { compact_descriptions?: unknown })
          .compact_descriptions,
    ],
    [
      'system_prompt missing reasoning_scaffold',
      (r) =>
        delete (at(r.profiles, 0).values.system_prompt as { reasoning_scaffold?: unknown })
          .reasoning_scaffold,
    ],
    [
      'loop_hardening missing fruitless_abort_threshold',
      (r) =>
        delete (at(r.profiles, 0).values.loop_hardening as { fruitless_abort_threshold?: unknown })
          .fruitless_abort_threshold,
    ],
    [
      'context missing compaction',
      (r) => delete (at(r.profiles, 0).values.context as { compaction?: unknown }).compaction,
    ],
    [
      'compaction missing trigger_percent',
      (r) =>
        delete (at(r.profiles, 0).values.context.compaction as { trigger_percent?: unknown })
          .trigger_percent,
    ],
    [
      'context output_token_reserve not a number',
      (r) =>
        ((at(r.profiles, 0).values.context as { output_token_reserve?: unknown })
          .output_token_reserve = '2048'),
    ],
    ['missing enabled key', (r) => delete (r as { enabled?: unknown }).enabled],
    ['enabled not a boolean', (r) => ((r as { enabled?: unknown }).enabled = 'true')],
    ['missing active_id key', (r) => delete (r as { active_id?: unknown }).active_id],
    ['active_id not a string', (r) => ((r as { active_id?: unknown }).active_id = 1)],
    [
      'missing suggested_profile_id key',
      (r) => delete (r as { suggested_profile_id?: unknown }).suggested_profile_id,
    ],
    [
      'suggested_profile_id neither string nor null',
      (r) => ((r as { suggested_profile_id?: unknown }).suggested_profile_id = 4),
    ],
    [
      'builtin_tools element missing description',
      (r) => delete (at(r.builtin_tools, 0) as { description?: string }).description,
    ],
    [
      'builtin_tools element name not a string',
      (r) => ((at(r.builtin_tools, 0) as { name?: unknown }).name = 9),
    ],
    [
      'tool_groups element missing title',
      (r) => delete (at(r.tool_groups, 0) as { title?: string }).title,
    ],
    [
      'tool_groups element tools not an array',
      (r) => ((at(r.tool_groups, 0) as { tools?: unknown }).tools = 'plan'),
    ],
    [
      'tool_groups element tools contains a non-string',
      (r) => ((at(r.tool_groups, 0) as { tools?: unknown[] }).tools = ['declare_plan', 5]),
    ],
    [
      'protected_tools not an array',
      (r) => ((r as { protected_tools?: unknown }).protected_tools = 'delegate'),
    ],
    [
      'protected_tools element not a string',
      (r) => ((r as { protected_tools?: unknown[] }).protected_tools = ['delegate', null]),
    ],
    ['warnings not an array', (r) => ((r as { warnings?: unknown }).warnings = { length: 0 })],
    [
      'warnings element not a string',
      (r) => ((r as { warnings?: unknown[] }).warnings = ['ok', 42]),
    ],
  ]

  for (const [label, mutate] of malformed) {
    it(`rejects ${label}`, () => {
      expect(isModelProfilesResponse(mutated(mutate))).toBe(false)
    })
  }
})

describe('isModelProfile', () => {
  it('accepts a well-formed profile', () => {
    expect(isModelProfile(structuredClone(at(baseResponse.profiles, 1)))).toBe(true)
  })

  it('rejects a profile whose second element is malformed', () => {
    // Guards must validate EVERY element, not just the first one.
    const payload = mutated((r) => {
      ((at(r.profiles, 1).values.sampling as { temperature?: unknown }).temperature = undefined)
    })
    const resp = payload as ModelProfilesResponse
    expect(isModelProfile(at(resp.profiles, 0))).toBe(true)
    expect(isModelProfile(at(resp.profiles, 1))).toBe(false)
  })
})

describe('isModelProfileKind', () => {
  it('accepts both kinds and rejects others', () => {
    expect(isModelProfileKind('predefined')).toBe(true)
    expect(isModelProfileKind('custom')).toBe(true)
    for (const bad of ['system', '', 'PREDEFINED', undefined, null, 1]) {
      expect(isModelProfileKind(bad)).toBe(false)
    }
  })
})
