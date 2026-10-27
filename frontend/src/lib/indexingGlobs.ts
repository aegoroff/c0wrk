/**
 * Client-side pre-flight validation for vector_index.exclude_patterns
 * entries — mirrors the backend's single source of those rules,
 * config.ValidateVectorIndexExcludePatterns: non-empty, no `!`-negation
 * (the list is exclude-only), the count/length caps, and valid doublestar
 * glob syntax (`*`, `**`, `?`, `[...]`, `{a,b}`).
 *
 * Like the blocklist editor's regex pre-flight, this is best-effort UX
 * only: the JS balance check and Go's doublestar.ValidatePattern can
 * disagree on rare constructs, so the backend remains authoritative and
 * still rejects (without writing) anything invalid.
 */

/** Mirrors backend config.VectorIndexMaxExcludePatterns. */
export const MAX_EXCLUDE_PATTERNS = 256

/** Mirrors backend config.VectorIndexMaxExcludePatternLength (bytes). */
export const MAX_EXCLUDE_PATTERN_LENGTH = 512

/**
 * Structural glob check shared by the doublestar dialect: `[...]` classes
 * and `{a,b}` alternates must be balanced (a `[`/`{` opener needs its
 * closer) and a `\` escape must not dangle at the end. An unbalanced or
 * dangling-escape pattern is always invalid; everything else is accepted
 * here and arbitrated by the backend.
 */
function isBalancedGlob(pattern: string): boolean {
  let classes = 0
  let braces = 0
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') {
      if (i === pattern.length - 1) return false
      i++
      continue
    }
    if (ch === '[') classes++
    else if (ch === ']') {
      if (classes === 0) return false
      classes--
    } else if (ch === '{') braces++
    else if (ch === '}') {
      if (braces === 0) return false
      braces--
    }
  }
  return classes === 0 && braces === 0
}

/**
 * Validate ONE candidate exclude-pattern entry; returns null when it is
 * acceptable or a human-readable error otherwise.
 */
export function validateExcludeGlob(pattern: string): string | null {
  const trimmed = pattern.trim()
  if (trimmed === '') {
    return 'Pattern cannot be empty.'
  }
  if (trimmed.startsWith('!')) {
    return "Negation ('!') is not supported — the list is exclude-only and can never un-ignore a file."
  }
  if (trimmed.length > MAX_EXCLUDE_PATTERN_LENGTH) {
    return `Pattern is ${trimmed.length} bytes long; the maximum is ${MAX_EXCLUDE_PATTERN_LENGTH}.`
  }
  if (!isBalancedGlob(trimmed)) {
    return 'Not a valid glob pattern (doublestar syntax: *, **, ?, [...], {a,b}).'
  }
  return null
}

/**
 * Validate a full candidate list (per-entry rules plus the count cap);
 * returns the first error or null. Mirrors the order of the backend checks
 * so a rejected client-side list previews the backend's own message shape.
 */
export function validateExcludeGlobList(patterns: string[]): string | null {
  if (patterns.length > MAX_EXCLUDE_PATTERNS) {
    return `The list has ${patterns.length} entries; the maximum is ${MAX_EXCLUDE_PATTERNS}.`
  }
  for (const pattern of patterns) {
    const err = validateExcludeGlob(pattern)
    if (err) return err
  }
  return null
}
