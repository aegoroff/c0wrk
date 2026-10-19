// Web-access sidecar control bridge (ADR-090) — thin wrappers over the
// desktop App bindings. Mirrors desktop/app.go GetWebAccessInfo /
// SetWebAccessEnabled: the Settings section's whole view of the sidecar
// (persisted switch, runtime state, loopback URL, login token) and the
// enable/disable toggle that persists AND applies in the same call.
//
// These RPCs exist only on desktop.App — deliberately NOT on the FrontendAPI
// surface the web sidecar dispatches over — so a browser tab can neither read
// the credential state nor flip the switch that feeds it (the web transport's
// getApp proxy simply has no such method; the read degrades to null, the
// toggle throws).

import { getApp } from './runtime'
import { logger } from '@/lib/logger'

/** GetWebAccessInfo payload: the Settings → Web Access section's view. */
export interface WebAccessInfo {
  /** The persisted web_access.enabled switch — operator intent. */
  readonly enabled: boolean
  /** Whether the sidecar is live in this run of the app. */
  readonly running: boolean
  /** The loopback URL a browser opens; '' while not running. */
  readonly url: string
  /** The resolved listen port; 0 while not running. */
  readonly port: number
  /** The browser login credential ('' when none applies yet). */
  readonly token: string
}

/** Boundary validator for the GetWebAccessInfo payload — the envelope must be
 *  fully valid or the whole read is rejected (`null`); the section renders its
 *  unavailable state instead of guessing. */
export function parseWebAccessInfo(raw: unknown): WebAccessInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.enabled !== 'boolean' || typeof r.running !== 'boolean') return null
  if (typeof r.url !== 'string' || typeof r.token !== 'string') return null
  if (typeof r.port !== 'number' || !Number.isFinite(r.port) || r.port < 0) return null
  return {
    enabled: r.enabled,
    running: r.running,
    url: r.url,
    port: r.port,
    token: r.token,
  }
}

/**
 * Fetch the sidecar state for Settings → Web Access. Returns the parsed
 * response, or `null` on a transport failure or an unexpected shape — the
 * section renders "unavailable"; a null never rejects into a render path.
 */
export async function getWebAccessInfo(): Promise<WebAccessInfo | null> {
  try {
    const app = getApp()
    const raw: unknown = await app.GetWebAccessInfo()
    // A nullish transport answer is a degraded environment (no desktop
    // bridge) — "unavailable" without a diagnostic; only a non-null shape
    // that violates the contract is worth logging.
    if (raw === null || raw === undefined) return null
    const parsed = parseWebAccessInfo(raw)
    if (!parsed) {
      logger.error('getWebAccessInfo: unexpected response shape', raw)
    }
    return parsed
  } catch (err) {
    logger.error('Failed to get web access info:', err)
    return null
  }
}

/**
 * Toggle web_access.enabled (Settings surface): persists the switch AND
 * applies it live (start/stop the sidecar). Throws on failure — unlike the
 * read path, a rejected toggle must surface to the UI, which snaps back to
 * the previous value.
 */
export async function setWebAccessEnabled(enabled: boolean): Promise<void> {
  try {
    const app = getApp()
    await app.SetWebAccessEnabled(enabled)
  } catch (err) {
    logger.error('Failed to set web access enabled:', err)
    throw err
  }
}
