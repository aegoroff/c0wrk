// Unit tests for api/themes.ts — the ThemeInfo/ThemeImportOutcome type guards
// and the three RPC wrapper functions (happy path, picker cancel, malformed
// backend data).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock getApp before importing the module under test ---
const mockApp: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

vi.mock('@/api/runtime', () => ({
  getApp: () => mockApp,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

import {
  listThemes,
  pickAndImportThemes,
  deleteTheme,
  isThemeInfo,
  isThemeImportOutcome,
} from '@/api/themes'

// --- Type guard tests ---

describe('isThemeInfo', () => {
  it('accepts a well-formed record', () => {
    expect(isThemeInfo({ id: 'one-dark', name: 'One Dark', type: 'color' })).toBe(true)
  })

  it('accepts a record with empty strings (degenerate but well-typed)', () => {
    expect(isThemeInfo({ id: '', name: '', type: '' })).toBe(true)
  })

  it('rejects null and non-objects', () => {
    expect(isThemeInfo(null)).toBe(false)
    expect(isThemeInfo('one-dark')).toBe(false)
    expect(isThemeInfo(42)).toBe(false)
  })

  it('rejects an array', () => {
    expect(isThemeInfo(['one-dark'])).toBe(false)
  })

  it('rejects missing fields', () => {
    expect(isThemeInfo({ id: 'one-dark', name: 'One Dark' })).toBe(false)
  })

  it('rejects non-string fields', () => {
    expect(isThemeInfo({ id: 7, name: 'One Dark', type: 'color' })).toBe(false)
    expect(isThemeInfo({ id: 'one-dark', name: 7, type: 'color' })).toBe(false)
    expect(isThemeInfo({ id: 'one-dark', name: 'One Dark', type: 7 })).toBe(false)
  })

  it('rejects an object with null field values', () => {
    expect(isThemeInfo({ id: null, name: 'One Dark', type: 'color' })).toBe(false)
  })
})

describe('isThemeImportOutcome', () => {
  it('accepts a success outcome (theme set, no error)', () => {
    expect(isThemeImportOutcome({ file: 'a.css', theme: { id: 'a', name: 'A', type: 'dark' } })).toBe(true)
  })

  it('accepts a failure outcome (error set, no theme)', () => {
    expect(isThemeImportOutcome({ file: 'a.css', error: 'invalid theme CSS' })).toBe(true)
  })

  it('rejects when both theme and error are set', () => {
    expect(
      isThemeImportOutcome({ file: 'a.css', theme: { id: 'a', name: 'A', type: 'dark' }, error: 'x' }),
    ).toBe(false)
  })

  it('rejects when neither theme nor error is set', () => {
    expect(isThemeImportOutcome({ file: 'a.css' })).toBe(false)
  })

  it('rejects a malformed theme payload', () => {
    expect(isThemeImportOutcome({ file: 'a.css', theme: { id: 7 } })).toBe(false)
  })

  it('rejects a non-string error payload', () => {
    expect(isThemeImportOutcome({ file: 'a.css', error: 42 })).toBe(false)
  })

  it('rejects records without a string file', () => {
    expect(isThemeImportOutcome({ theme: { id: 'a', name: 'A', type: 'dark' } })).toBe(false)
    expect(isThemeImportOutcome(null)).toBe(false)
    expect(isThemeImportOutcome('a.css')).toBe(false)
  })
})

// --- API wrapper tests ---

describe('listThemes', () => {
  beforeEach(() => {
    Object.keys(mockApp).forEach((k) => delete mockApp[k])
  })

  it('returns themes from the backend', async () => {
    mockApp.ListThemes = vi.fn().mockResolvedValue([
      { id: 'one-dark', name: 'One Dark', type: 'color' },
      { id: 'nord', name: 'Nord', type: 'color' },
    ])
    const result = await listThemes()
    expect(mockApp.ListThemes).toHaveBeenCalled()
    expect(result).toEqual([
      { id: 'one-dark', name: 'One Dark', type: 'color' },
      { id: 'nord', name: 'Nord', type: 'color' },
    ])
  })

  it('returns an empty list when no themes are installed', async () => {
    mockApp.ListThemes = vi.fn().mockResolvedValue([])
    const result = await listThemes()
    expect(result).toEqual([])
  })

  it('throws TypeError when backend returns a non-array', async () => {
    mockApp.ListThemes = vi.fn().mockResolvedValue({ themes: [] })
    await expect(listThemes()).rejects.toThrow(TypeError)
    await expect(listThemes()).rejects.toThrow('non-array')
  })

  it('throws TypeError when an entry has non-string fields', async () => {
    mockApp.ListThemes = vi.fn().mockResolvedValue([
      { id: 'one-dark', name: 'One Dark', type: 'color' },
      { id: 'broken', name: 42, type: 'color' },
    ])
    await expect(listThemes()).rejects.toThrow(TypeError)
    await expect(listThemes()).rejects.toThrow('malformed ThemeInfo')
  })

  it('propagates backend errors', async () => {
    mockApp.ListThemes = vi.fn().mockRejectedValue(new Error('themes dir unreadable'))
    await expect(listThemes()).rejects.toThrow('themes dir unreadable')
  })
})

describe('pickAndImportThemes', () => {
  beforeEach(() => {
    Object.keys(mockApp).forEach((k) => delete mockApp[k])
  })

  it('returns per-file outcomes in pick order on success', async () => {
    const outcomes = [
      { file: '/tmp/nord.css', theme: { id: 'nord', name: 'Nord', type: 'dark', css: ':root{}' } },
      { file: '/tmp/broken.css', error: 'invalid theme CSS: @import is not allowed' },
    ]
    mockApp.PickAndImportThemes = vi.fn().mockResolvedValue(outcomes)
    const result = await pickAndImportThemes()
    expect(mockApp.PickAndImportThemes).toHaveBeenCalled()
    expect(result).toEqual(outcomes)
  })

  it('returns an empty list when nothing was picked without cancel', async () => {
    // Defensive: the desktop bridge maps a cancelled picker to null, but the
    // wrapper must not choke on an empty outcome array either.
    mockApp.PickAndImportThemes = vi.fn().mockResolvedValue([])
    const result = await pickAndImportThemes()
    expect(result).toEqual([])
  })

  it('returns null when the user cancels the picker', async () => {
    mockApp.PickAndImportThemes = vi.fn().mockResolvedValue(null)
    const result = await pickAndImportThemes()
    expect(result).toBeNull()
  })

  it('returns null when the backend resolves undefined (cancel variant)', async () => {
    mockApp.PickAndImportThemes = vi.fn().mockResolvedValue(undefined)
    const result = await pickAndImportThemes()
    expect(result).toBeNull()
  })

  it('throws TypeError when the backend resolves a non-array', async () => {
    mockApp.PickAndImportThemes = vi.fn().mockResolvedValue({ file: 'a.css' })
    await expect(pickAndImportThemes()).rejects.toThrow(TypeError)
    await expect(pickAndImportThemes()).rejects.toThrow('non-array')
  })

  it('throws TypeError when an outcome entry is malformed', async () => {
    mockApp.PickAndImportThemes = vi.fn().mockResolvedValue([
      { file: 'a.css', theme: { id: 'a', name: 'A', type: 'dark' } },
      { file: 'b.css', theme: { id: 'b', name: 42, type: 'dark' } },
    ])
    await expect(pickAndImportThemes()).rejects.toThrow(TypeError)
    await expect(pickAndImportThemes()).rejects.toThrow('malformed ThemeImportOutcome')
  })

  it('propagates backend errors', async () => {
    mockApp.PickAndImportThemes = vi.fn().mockRejectedValue(new Error('import failed'))
    await expect(pickAndImportThemes()).rejects.toThrow('import failed')
  })
})

describe('deleteTheme', () => {
  beforeEach(() => {
    Object.keys(mockApp).forEach((k) => delete mockApp[k])
  })

  it('calls app.DeleteTheme with the id', async () => {
    mockApp.DeleteTheme = vi.fn().mockResolvedValue(undefined)
    await deleteTheme('one-dark')
    expect(mockApp.DeleteTheme).toHaveBeenCalledWith('one-dark')
  })

  it('propagates backend errors', async () => {
    mockApp.DeleteTheme = vi.fn().mockRejectedValue(new Error('theme in use'))
    await expect(deleteTheme('one-dark')).rejects.toThrow('theme in use')
  })
})
