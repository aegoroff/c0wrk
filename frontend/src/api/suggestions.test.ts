// Unit tests for api/suggestions.ts — the prompt-suggestions RPC bridge
// (ADR-088). Covers boundary parsing (envelope rejection, per-row tolerance)
// and the fail-open read wrapper (transport failure → null, never a throw
// into a render path).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApp: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

vi.mock('@/api/runtime', () => ({
  getApp: () => mockApp,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { parsePromptSuggestionsResponse, getPromptSuggestions, setPromptSuggestionsEnabled } from '@/api/suggestions'
import type { PromptSuggestionRow } from '@/types/events'

function makeRow(overrides: Partial<PromptSuggestionRow> = {}): PromptSuggestionRow {
  return {
    id: 'row-1',
    session_id: 'sess-1',
    task_id: '',
    kind: 'goal_advance',
    text: 'Refine the parser tests',
    status: 'active',
    created_at: '2026-10-17T10:00:00Z',
    ...overrides,
  }
}

const validResponse = {
  session_id: 'sess-1',
  project_id: 'proj-1',
  source: 'continuation',
  suggestions: [makeRow()],
}

describe('parsePromptSuggestionsResponse', () => {
  it('accepts a fully valid payload', () => {
    const parsed = parsePromptSuggestionsResponse(validResponse)
    expect(parsed).toEqual(validResponse)
  })

  it('normalizes an absent project_id to "" (backend omits it for No-Project)', () => {
    const parsed = parsePromptSuggestionsResponse({
      session_id: 'sess-1',
      source: 'none',
      suggestions: [],
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.project_id).toBe('')
    expect(parsed?.source).toBe('none')
    expect(parsed?.suggestions).toEqual([])
  })

  it('accepts every documented source value', () => {
    for (const source of ['continuation', 'new_session', 'none']) {
      expect(parsePromptSuggestionsResponse({ ...validResponse, source })?.source).toBe(source)
    }
  })

  it('rejects an unknown source value', () => {
    expect(parsePromptSuggestionsResponse({ ...validResponse, source: 'teleport' })).toBeNull()
  })

  it('rejects non-object payloads', () => {
    expect(parsePromptSuggestionsResponse(null)).toBeNull()
    expect(parsePromptSuggestionsResponse('continuation')).toBeNull()
    expect(parsePromptSuggestionsResponse(42)).toBeNull()
  })

  it('rejects a missing session_id', () => {
    const { session_id: _omitted, ...rest } = validResponse
    expect(parsePromptSuggestionsResponse(rest)).toBeNull()
  })

  it('rejects a non-array suggestions field', () => {
    expect(parsePromptSuggestionsResponse({ ...validResponse, suggestions: 'rows' })).toBeNull()
  })

  it('drops malformed rows but keeps valid siblings (per-row tolerance)', () => {
    const parsed = parsePromptSuggestionsResponse({
      ...validResponse,
      suggestions: [
        makeRow({ id: 'ok-1' }),
        makeRow({ id: 'bad-1', text: 42 as unknown as string }),
        { id: 'bad-2' },
        makeRow({ id: 'ok-2' }),
      ],
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.suggestions.map((r) => r.id)).toEqual(['ok-1', 'ok-2'])
  })

  it('accepts an all-malformed set as an empty array (envelope stays valid)', () => {
    const parsed = parsePromptSuggestionsResponse({
      ...validResponse,
      suggestions: [{ nope: true }, 'row'],
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.suggestions).toEqual([])
  })
})

describe('getPromptSuggestions', () => {
  beforeEach(() => {
    delete mockApp.GetPromptSuggestions
  })

  it('passes both ids through and returns the parsed response', async () => {
    mockApp.GetPromptSuggestions = vi.fn(() => Promise.resolve(validResponse))
    const result = await getPromptSuggestions('sess-1', 'proj-1')
    expect(mockApp.GetPromptSuggestions).toHaveBeenCalledWith('sess-1', 'proj-1')
    expect(result).toEqual(validResponse)
  })

  it('returns null on an unexpected response shape (logged, not thrown)', async () => {
    mockApp.GetPromptSuggestions = vi.fn(() => Promise.resolve({ broken: true }))
    const result = await getPromptSuggestions('sess-1', 'proj-1')
    expect(result).toBeNull()
  })

  it('fails open on a transport error — returns null instead of throwing', async () => {
    mockApp.GetPromptSuggestions = vi.fn(() => Promise.reject(new Error('bindings gone')))
    await expect(getPromptSuggestions('sess-1', 'proj-1')).resolves.toBeNull()
  })
})

describe('setPromptSuggestionsEnabled', () => {
  beforeEach(() => {
    delete mockApp.SetPromptSuggestionsEnabled
  })

  it('forwards the toggle to the backend', async () => {
    mockApp.SetPromptSuggestionsEnabled = vi.fn(() => Promise.resolve(undefined))
    await setPromptSuggestionsEnabled(false)
    expect(mockApp.SetPromptSuggestionsEnabled).toHaveBeenCalledWith(false)
  })

  it('throws on failure (a rejected toggle must surface, unlike the read path)', async () => {
    mockApp.SetPromptSuggestionsEnabled = vi.fn(() => Promise.reject(new Error('config not initialized')))
    await expect(setPromptSuggestionsEnabled(true)).rejects.toThrow(/config not initialized/)
  })
})
