import { describe, it, expect } from 'vitest'
import {
  MAX_EXCLUDE_PATTERNS,
  MAX_EXCLUDE_PATTERN_LENGTH,
  validateExcludeGlob,
  validateExcludeGlobList,
} from './indexingGlobs'

describe('validateExcludeGlob', () => {
  it('accepts gitignore-style doublestar globs', () => {
    for (const pattern of [
      'node_modules/',
      '*.log',
      '**/*.snap',
      'docs/{en,ru}/',
      'build/?cache',
      '[Tt]mp/',
      'a/**/b',
    ]) {
      expect(validateExcludeGlob(pattern)).toBeNull()
    }
  })

  it('rejects empty and whitespace-only entries', () => {
    expect(validateExcludeGlob('')).toMatch(/empty/i)
    expect(validateExcludeGlob('   ')).toMatch(/empty/i)
  })

  it('rejects !-negation (the list is exclude-only)', () => {
    expect(validateExcludeGlob('!keep.go')).toMatch(/[Nn]egation/)
  })

  it('rejects entries over the byte cap', () => {
    const tooLong = 'a'.repeat(MAX_EXCLUDE_PATTERN_LENGTH + 1)
    expect(validateExcludeGlob(tooLong)).toContain(`the maximum is ${MAX_EXCLUDE_PATTERN_LENGTH}`)
  })

  it('rejects unbalanced classes, braces, and dangling escapes', () => {
    expect(validateExcludeGlob('[a-')).toMatch(/valid glob/)
    expect(validateExcludeGlob('*.{snap')).toMatch(/valid glob/)
    expect(validateExcludeGlob('foo\\')).toMatch(/valid glob/)
  })
})

describe('validateExcludeGlobList', () => {
  it('returns null for a valid list and surfaces the first per-entry error', () => {
    expect(validateExcludeGlobList(['*.log', 'vendor/'])).toBeNull()
    expect(validateExcludeGlobList(['*.log', ''])).toMatch(/empty/i)
  })

  it('enforces the count cap', () => {
    const tooMany = Array.from({ length: MAX_EXCLUDE_PATTERNS + 1 }, () => '*.log')
    expect(validateExcludeGlobList(tooMany)).toContain(`the maximum is ${MAX_EXCLUDE_PATTERNS}`)
    const exact = Array.from({ length: MAX_EXCLUDE_PATTERNS }, () => '*.log')
    expect(validateExcludeGlobList(exact)).toBeNull()
  })
})
