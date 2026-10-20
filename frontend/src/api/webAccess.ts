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
  /** The PERSISTED port pin: 0 = auto (a free port every start),
   *  1–65535 = pinned. Absent on an older payload → 0. */
  readonly configuredPort: number
  /** The PERSISTED bind pin: the interface every start listens on — an IP
   *  literal or "localhost" ('' when an older payload didn't carry it; the
   *  backend default 127.0.0.1 applies). */
  readonly configuredBind: string
  /** Whether the configured bind names a loopback interface. A non-loopback
   *  bind is a deliberate network listener. Absent on an older payload
   *  → true: loopback is the only shape such a payload could describe. */
  readonly bindIsLoopback: boolean
  /** The browser login credential ('' when none applies yet). */
  readonly token: string
  /** Whether a static token is persisted in config.yaml (a credential that
   *  survives restarts) as opposed to the ephemeral per-launch secret. */
  readonly tokenPinned: boolean
}

/** Boundary validator for the GetWebAccessInfo payload — the envelope must be
 *  fully valid or the whole read is rejected (`null`); the section renders its
 *  unavailable state instead of guessing. `configured_port`/`token_pinned`,
 *  `configured_bind`/`bind_is_loopback` default to the unpinned shape when
 *  absent: the pin UI and the backend ship in one binary, so tolerance only
 *  serves stale fixtures — and a payload without bind fields can only ever
 *  have described the loopback default (bind_is_loopback → true, so the
 *  strong network warning never fires on a stale read). */
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
    configuredPort:
      typeof r.configured_port === 'number' && Number.isFinite(r.configured_port)
        ? r.configured_port
        : 0,
    configuredBind: typeof r.configured_bind === 'string' ? r.configured_bind : '',
    bindIsLoopback: r.bind_is_loopback !== false,
    token: r.token,
    tokenPinned: r.token_pinned === true,
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

/**
 * Pin the bind and port (Settings → Web Access): persists both to config.yaml
 * AND applies them live — a running sidecar hot-restarts onto the new
 * connection settings, so every open tab must re-login afterwards. An empty
 * bind = the loopback default (127.0.0.1); a valid non-loopback IP literal is
 * a deliberate network listener (the backend validates and rejects anything
 * else). Port 0 = auto. The token is deliberately not part of this call: the
 * credential is owned by generation (minted at the first start, rotated via
 * regenerateWebAccessToken). Throws on failure — the section surfaces the
 * message (including the "previous settings were restored" rollback case)
 * instead of guessing the state.
 */
export async function setWebAccessConnection(bind: string, port: number): Promise<void> {
  try {
    const app = getApp()
    await app.SetWebAccessConnection(bind, port)
  } catch (err) {
    logger.error('Failed to set web access connection:', err)
    throw err
  }
}

/**
 * Regenerate the persistent access token (Settings → Web Access): mints a
 * fresh credential, persists it through the same config write every settings
 * change uses, and hot-restarts a running sidecar onto it — every open tab
 * must sign in again with the token the section now shows. Throws on failure.
 */
export async function regenerateWebAccessToken(): Promise<void> {
  try {
    const app = getApp()
    await app.RegenerateWebAccessToken()
  } catch (err) {
    logger.error('Failed to regenerate the web access token:', err)
    throw err
  }
}

/**
 * Persist an operator-typed access token (Settings → Web Access token field):
 * the custom credential replaces the stored one through the same immediate
 * config write and hot-restarts a running sidecar onto it — every open tab
 * must sign in again with the token the section now shows. The backend
 * trims, bounds-checks (min 8 / max 256 characters) and no-ops on the
 * unchanged value. Throws on failure — the field surfaces the message
 * (including the rollback case) instead of guessing the state.
 */
export async function setWebAccessToken(token: string): Promise<void> {
  try {
    const app = getApp()
    await app.SetWebAccessToken(token)
  } catch (err) {
    logger.error('Failed to set the web access token:', err)
    throw err
  }
}

/** A successfully parsed address field: the bind the backend stores (an IP
 *  literal or "localhost"; a bracketed IPv6 loses its brackets) and the port
 *  (0 = auto). */
export interface WebAccessAddress {
  readonly bind: string
  readonly port: number
}

// The address-field grammar after the scheme: "localhost", an IPv4 dotted
// quad with every octet bounded 0-255 entirely inside the pattern, or a
// bracketed IPv6 literal (character-class shape only — the backend's
// net.ParseIP is the exact authority), then an optional :port. Deliberately
// narrower than a generic URL: the sidecar binds IP literals or the
// "localhost" name only, so any other hostname could never work.
const WEB_ACCESS_ADDRESS_PATTERN =
  /^(localhost|(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/

/**
 * Parse the Settings address field into the (bind, port) pair the backend
 * stores. Accepted shapes: "127.0.0.1:8080", "localhost:8080", "[::1]:8080",
 * the same with an explicit "http://" prefix, and the bare host without a
 * port (= auto port). An empty input means the defaults (127.0.0.1 + auto).
 * A missing scheme gains "http://" automatically; "https://" is refused
 * rather than silently downgraded — the sidecar serves plain HTTP. Invalid
 * input yields the error message and the caller must not save.
 */
export function parseWebAccessAddress(input: string): WebAccessAddress | { error: string } {
  const value = input.trim()
  if (value === '') return { bind: '', port: 0 }
  if (/^https:\/\//i.test(value)) {
    return { error: 'https:// is not supported — the sidecar serves plain HTTP only.' }
  }
  // Strip an explicit http://, refuse any other scheme, auto-prepend http://
  // when none is given — the remainder is host[:port] in every branch, so one
  // pattern validates all spellings.
  let hostPort = value
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (!/^http:\/\//i.test(value)) {
      return { error: 'Only the http:// scheme is supported — the sidecar serves plain HTTP.' }
    }
    hostPort = value.slice(7)
  }
  const match = WEB_ACCESS_ADDRESS_PATTERN.exec(hostPort)
  if (match === null || match[1] === undefined) {
    return {
      error:
        'Use host:port — an IPv4 address, "localhost" or [IPv6] with a port 1-65535, e.g. 127.0.0.1:8080. Empty = defaults (127.0.0.1, auto port).',
    }
  }
  let bind = match[1]
  if (bind.startsWith('[') && bind.endsWith(']')) {
    bind = bind.slice(1, -1)
  }
  const portGroup = match[2]
  if (portGroup === undefined) {
    return { bind, port: 0 }
  }
  const port = Number(portGroup)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'The port must be a whole number 1-65535 (omit it for an auto port).' }
  }
  return { bind, port }
}

/** The token field's local bounds — the exact rule the backend's
 *  config.ValidateWebAccessToken enforces, mirrored client-side so an
 *  out-of-bounds value never travels. */
export const WEB_ACCESS_TOKEN_MIN_LENGTH = 8
export const WEB_ACCESS_TOKEN_MAX_LENGTH = 256

/** A successfully parsed token field: the trimmed credential to persist. */
export interface WebAccessToken {
  readonly token: string
}

/**
 * Validate the Settings token field into the credential the backend stores.
 * The value is trimmed; a non-empty result of 8–256 characters is accepted.
 * The empty input is rejected like any other short value — the caller treats
 * it as "revert the draft" (emptiness means GENERATED; it must never
 * overwrite an existing credential) rather than a save. An invalid value
 * yields the error message and the caller must not save.
 */
export function parseWebAccessToken(input: string): WebAccessToken | { error: string } {
  const token = input.trim()
  if (token.length < WEB_ACCESS_TOKEN_MIN_LENGTH) {
    return {
      error: `The token must be at least ${WEB_ACCESS_TOKEN_MIN_LENGTH} characters — leave it empty to keep the generated one.`,
    }
  }
  if (token.length > WEB_ACCESS_TOKEN_MAX_LENGTH) {
    return { error: `The token is too long — at most ${WEB_ACCESS_TOKEN_MAX_LENGTH} characters.` }
  }
  return { token }
}

/**
 * Exchange the per-launch token for the session cookie (POST /api/login).
 *
 * This is a sidecar REST endpoint, NOT a FrontendAPI RPC: it runs before any
 * session exists (that is its whole purpose), so it fetches the serving
 * origin directly instead of going through the RPC dispatch — which would
 * itself 401 without a cookie. The browser attaches the returned HttpOnly
 * cookie to subsequent fetches/WS upgrades automatically (same-origin).
 *
 * Resolves once the cookie is set (the caller reloads the page so every
 * store, the transport probe and the websocket start authenticated).
 * Rejects with an operator-actionable message otherwise: 401 wrong token,
 * 429 rate limited (with the server's Retry-After), or a transport failure.
 */
export async function webAccessLogin(token: string): Promise<void> {
  let res: Response
  try {
    res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  } catch (err) {
    logger.warn('[web-access] login transport failure', err)
    throw new Error('Cannot reach the app — is the desktop instance still running?')
  }
  if (res.ok) return
  if (res.status === 401) {
    throw new Error('Wrong token — copy it from Settings → Web Access in the desktop app.')
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get('Retry-After'))
    throw new Error(
      Number.isFinite(retry) && retry > 0
        ? `Too many attempts — try again in ${Math.ceil(retry)}s.`
        : 'Too many attempts — try again in a minute.',
    )
  }
  throw new Error(`Login failed (HTTP ${res.status}).`)
}
