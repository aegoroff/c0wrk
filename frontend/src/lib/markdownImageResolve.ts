/**
 * Pure helpers for resolving markdown image `src` values to local disk paths.
 *
 * Kept in a dedicated module (rather than alongside the React `Markdown`
 * component) so the component file only exports components — required for
 * React Fast Refresh, and lets these helpers be unit-tested in isolation.
 */

import { isAbsolutePath, normalizePath } from './localFileLink'

/**
 * Matches external/data URLs that the webview can load directly. The regex
 * demands at least two characters before the colon: RFC 3986's grammar would
 * accept a one-letter scheme, but no real-world scheme is a single letter —
 * a letter plus a colon is a Windows drive prefix (`C:`), so such srcs never
 * match here: they are local disk paths and must go through filesystem
 * resolution, not the webview.
 */
export const EXTERNAL_SRC_RE = /^(data:|[a-z][a-z0-9+.-]+:)/i

/**
 * Collapses `.` and `..` segments and returns an absolute path in canonical
 * forward-slash form, preserving the root dialect: POSIX `/a/b`, Windows
 * drive `C:/a/b` (the drive prefix is kept — no leading `/` is glued in
 * front of it) and UNC `//server/share/a/b`. Backslashes normalize to
 * forward slashes, and `..` never rises above its anchored root (filesystem
 * root, drive root or UNC share).
 */
export function normalizeAbsolutePath(p: string): string {
  return normalizePath('', p)
}

/**
 * Builds the ordered list of absolute disk paths to try when resolving a
 * markdown image `src`. Absolute paths — POSIX (`/...`), Windows drive
 * (`C:\...`) and UNC (`\\srv\share\...`) — yield the single normalized
 * candidate (drive/UNC prefix preserved, backslashes forward-slashed);
 * relative paths yield the markdown-file directory first, then the workspace
 * root. Returns an empty array when no base is available to resolve against.
 */
export function candidateImagePaths(
  src: string,
  baseFilePath: string | null | undefined,
  workspaceRoot: string | null | undefined,
): string[] {
  if (isAbsolutePath(src)) return [normalizeAbsolutePath(src)]
  const candidates: string[] = []
  if (baseFilePath) {
    // Windows document paths arrive with backslashes; the directory slice
    // needs forward slashes to find the last separator (and so does the
    // concatenation below).
    const normalizedBase = baseFilePath.replace(/\\/g, '/')
    const slash = normalizedBase.lastIndexOf('/')
    const dir = slash >= 0 ? normalizedBase.slice(0, slash) : ''
    if (dir) candidates.push(normalizeAbsolutePath(dir + '/' + src))
  }
  if (workspaceRoot) {
    candidates.push(normalizeAbsolutePath(workspaceRoot + '/' + src))
  }
  return candidates
}
