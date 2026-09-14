// Themes API wrappers.
//
// Wraps the generated Wails bindings (window.go.desktop.App) so components
// never import wailsjs directly. Every RPC response is validated at this
// boundary: malformed data raises a TypeError (never leaks a half-shaped
// record into UI stores), a cancelled picker maps to null, and backend
// errors are logged then re-thrown for the caller to surface.

import { getApp } from './runtime'
import { logger } from '@/lib/logger'
import { isArrayOf } from '@/types/guards'

/** An installed theme known to the backend.
 *  `type` discriminates the theme kind — the value set is backend-owned, so
 *  the guard only pins it to a non-empty contract of "is a string".
 *  `css` carries the theme body on the import result only (list entries are
 *  descriptors); optional at the boundary and validated as a string when
 *  present. */
export interface ThemeInfo {
  id: string
  name: string
  type: string
  css?: string
}

/** Type guard: a well-formed ThemeInfo carries string id/name/type fields. */
export function isThemeInfo(v: unknown): v is ThemeInfo {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.type === 'string' &&
    (o.css === undefined || typeof o.css === 'string')
  )
}

/** Per-file outcome of a batch theme import.
 *  Exactly one of `theme` (success) and `error` (failure) is set — the
 *  backend never fills both, and one invalid file never blocks the rest
 *  of the batch. */
export interface ThemeImportOutcome {
  file: string
  theme?: ThemeInfo
  error?: string
}

/** Type guard: a well-formed ThemeImportOutcome carries a string `file` and
 *  exactly one of a valid `theme` or a string `error`. */
export function isThemeImportOutcome(v: unknown): v is ThemeImportOutcome {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.file !== 'string') return false
  const hasTheme = o.theme !== undefined
  const hasError = o.error !== undefined
  if (hasTheme === hasError) return false // exactly one must be present
  return (!hasTheme || isThemeInfo(o.theme)) && (!hasError || typeof o.error === 'string')
}

/** Fetch the list of installed themes. Throws TypeError on a malformed response. */
export async function listThemes(): Promise<ThemeInfo[]> {
  try {
    const app = getApp()
    const result = await app.ListThemes()
    if (!Array.isArray(result)) {
      throw new TypeError('listThemes: backend returned non-array data')
    }
    if (!isArrayOf(result, isThemeInfo)) {
      throw new TypeError('listThemes: backend returned malformed ThemeInfo entries')
    }
    return result
  } catch (err) {
    logger.error('Failed to list themes:', err)
    throw err
  }
}

/**
 * Open the native multi-select theme picker, import every chosen theme, and
 * return the per-file outcomes in pick order. Returns null when the user
 * cancels the picker. Throws TypeError when the backend resolves with data
 * that is not a well-formed ThemeImportOutcome list.
 */
export async function pickAndImportThemes(): Promise<ThemeImportOutcome[] | null> {
  try {
    const app = getApp()
    const result = await app.PickAndImportThemes()
    if (result === null || result === undefined) {
      return null
    }
    if (!Array.isArray(result)) {
      throw new TypeError('pickAndImportThemes: backend returned non-array data')
    }
    if (!isArrayOf(result, isThemeImportOutcome)) {
      throw new TypeError('pickAndImportThemes: backend returned malformed ThemeImportOutcome entries')
    }
    return result
  } catch (err) {
    logger.error('Failed to pick and import themes:', err)
    throw err
  }
}

/** Delete an installed theme by id. */
export async function deleteTheme(id: string): Promise<void> {
  try {
    const app = getApp()
    await app.DeleteTheme(id)
  } catch (err) {
    logger.error('Failed to delete theme:', err)
    throw err
  }
}
