// System-notification desktop bindings — the single import path for the Go
// notification transport (desktop/notifications.go).
//
// Transport decision (documented per the step spec): ALL notification runtime
// calls route through the Go bindings (`App.InitNotifications` /
// `App.SendSystemNotification` / `App.ShowTestNotification`), never through
// `window.runtime.SendNotification`. One accountable path matters because the
// click round-trip is Go-owned: SendSystemNotification's `data` map is what
// the Wails click callback returns as `UserInfo`, and only the notification
// the Go layer registered the callback against emits `notification_clicked`.
// A banner sent through `window.runtime` would still arrive at the same
// callback (both transports hit the same Wails frontend), but the ids and the
// send/init bookkeeping would live in two places — exactly the split-brain
// this wrapper exists to prevent.

// Web-access note (ADR-090, browser transport): a browser tab cannot reach
// the desktop.App notification bindings (they are not on the web dispatch
// surface), and it SHOULDN'T — the browser has its own notification center.
// In the web transport every entry point below branches to the Web
// Notification API instead: permission is the browser's, a click runs
// window.focus() and replays `notification_clicked` LOCALLY through
// emitLocalEvent, so the downstream guard + navigation path is identical to
// the desktop's Go-owned round-trip. The permission prompt is a
// browser-gesture affair: the boot init only READS the permission, while the
// Settings toggle and the Test button (real user gestures) request it.

import { emitLocalEvent, getApp, isWebTransport, onGlobalEvent, reportDroppedEvent } from './runtime'
import { logger } from '@/lib/logger'
import type { NotificationClickedData } from '@/types/events'
import { isNotificationClickedData } from '@/types/events'

/** Data map forwarded through the Go binding; keys `sessionId` and
 *  `projectId` are the click-routing contract (returned as UserInfo by the
 *  Wails click callback, extracted into notification_clicked). Values are
 *  plain strings — `undefined` entries are dropped by sendSystemNotification
 *  so the Go `map[string]string` binding never receives a null value. */
export interface SystemNotificationData {
  sessionId?: string
  projectId?: string
  [key: string]: string | undefined
}

/**
 * Initialize the OS notification bridge: the Go bindings on the desktop
 * transport (Wails InitializeNotifications + the single
 * OnNotificationResponse callback + the macOS authorization prompt —
 * idempotent, a second call is a no-op on the backend; a FAILED init is
 * retried), or a read-only permission read on the web transport — the
 * browser's permission prompt must ride a user gesture, so the gestureless
 * boot call never requests one (the Settings toggle and the Test button do).
 */
export async function initSystemNotifications(): Promise<void> {
  if (isWebTransport()) {
    if (!webNotificationsAvailable()) {
      logger.debug('[system-notifications] browser Notification API unavailable; skipping init')
      return
    }
    logger.debug(`[system-notifications] browser notification permission: ${Notification.permission}`)
    return
  }
  const app = getApp()
  await app.InitNotifications()
}

/**
 * Send one native notification. Desktop transport: through the Go bindings —
 * the `data` map is the click-routing context (the backend emits
 * `notification_clicked` with the ids extracted from it on activation).
 * Web transport: a browser Notification whose click handler focuses the tab
 * and replays the same event locally. Rejects on failure (the lib wrapper
 * catches and downgrades to warn); a missing browser permission is NOT a
 * failure — the web send drops the banner silently instead (see
 * `sendWebNotification`).
 */
export async function sendSystemNotification(
  title: string,
  body: string,
  data?: SystemNotificationData,
): Promise<void> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value !== undefined) clean[key] = value
  }
  if (isWebTransport()) {
    await sendWebNotification(title, body, clean)
    return
  }
  const app = getApp()
  // Drop undefined entries: the Go binding unmarshals into map[string]string
  // and a null value would fail the call.
  await app.SendSystemNotification(title, body, Object.keys(clean).length > 0 ? clean : undefined)
}

/** True when this window exposes the Web Notification API. */
function webNotificationsAvailable(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

/**
 * Read `Notification.permission` without tripping Firefox's SecurityError:
 * on an insecure origin Firefox throws from the getter itself instead of
 * answering 'denied'. A null here IS the insecure-origin denial cause (the
 * browser auto-refuses notifications there) — every caller maps it that way.
 */
function readNotificationPermission(): 'default' | 'granted' | 'denied' | null {
  try {
    return Notification.permission
  } catch {
    return null
  }
}

/**
 * One browser banner. The options mirror the Go data map's contract: the
 * ids ride `data` and the click replays `notification_clicked` locally, so
 * useNotificationClicks routes the tab exactly as it routes the desktop
 * window. `tag` collapses per session, so a burst of events for one session
 * replaces the stale banner instead of stacking duplicates.
 *
 * Permission contract (ADR-090): the send path NEVER prompts — the grant
 * gestures are the Settings master toggle and the Test button, and a
 * gestureless requestPermission here would be dismissed by most browsers
 * anyway. Without a granted permission the banner is dropped WITHOUT an
 * error: `debug` per occurrence, ONE `warn` per app run
 * (`logUngrantedPermission`), so a burst of cued events can never spam the
 * console.
 */
async function sendWebNotification(title: string, body: string, data: Record<string, string>): Promise<void> {
  if (!webNotificationsAvailable()) {
    throw new Error('This browser does not expose the Notification API.')
  }
  if (Notification.permission !== 'granted') {
    logUngrantedPermission()
    return
  }
  const options: NotificationOptions & { data?: Record<string, string> } = { body }
  if (data.sessionId !== undefined) options.tag = `c0wrk:${data.sessionId}`
  if (Object.keys(data).length > 0) options.data = data
  const notification = new Notification(title, options)
  notification.onclick = () => {
    // Best-effort: brings the tab's window forward where the browser allows
    // it (a notification click carries user activation).
    try {
      window.focus()
    } catch {
      // A blocked focus must not eat the navigation below.
    }
    // The Go callback's contract: `notification_clicked` with snake_case ids
    // (empty when unattributed — the consumer treats that as focus-only).
    emitLocalEvent('notification_clicked', {
      notification_id: `web-${Date.now()}`,
      session_id: data.sessionId ?? '',
      project_id: data.projectId ?? '',
    })
    notification.close()
  }
}

/** Whether the once-per-run permission warn has fired already. Session-scoped
 *  on purpose: the first ungranted send explains the silence at warn, every
 *  later occurrence stays at debug — a burst of cued events costs one line. */
let permissionWarned = false

/** Drop a banner because the browser permission is not granted: the FIRST
 *  occurrence per app run warns (naming the current permission and the grant
 *  surfaces), later ones only debug. Never throws — the send path is
 *  best-effort and must not spam the event pipeline's log. */
function logUngrantedPermission(): void {
  if (permissionWarned) {
    logger.debug(
      `[system-notifications] banner skipped: notification permission is '${Notification.permission}'`,
    )
    return
  }
  permissionWarned = true
  logger.warn(
    `[system-notifications] notification permission is '${Notification.permission}' — banners stay silent until it is granted via the Settings toggle or the Test button`,
  )
}

/** Test-only: clear the once-per-run permission warn so unit tests start
 *  from a clean slate. */
export function __resetPermissionWarnForTest(): void {
  permissionWarned = false
}

/** How a web permission request can settle. 'default' means the prompt was
 *  closed WITHOUT an answer — it is NOT a denial (ADR-090, decision 11): the
 *  Settings Test button stays the documented retry gesture, so consumers must
 *  keep it reachable instead of surfacing the blocked hint. */
export type NotificationPermissionOutcome = 'granted' | 'denied' | 'default'

/**
 * Request the browser notification permission from a USER GESTURE (the
 * Settings master toggle or the Test button). Resolves with the resulting
 * permission state: 'granted' to proceed, 'denied' for a real refusal,
 * 'default' when the prompt was closed without an answer. Desktop transport:
 * a no-op that resolves 'granted' — the OS authorization is owned by
 * InitNotifications.
 */
export async function ensureNotificationPermission(): Promise<NotificationPermissionOutcome> {
  if (!isWebTransport()) return 'granted'
  if (!webNotificationsAvailable()) return 'denied'
  const permission = readNotificationPermission()
  // A SecurityError read (Firefox on an insecure origin) refuses upfront —
  // requestPermission would be auto-denied there anyway.
  if (permission === null || permission === 'denied') return 'denied'
  if (permission === 'granted') return 'granted'
  try {
    await Notification.requestPermission()
  } catch (err) {
    logger.warn('[system-notifications] permission request failed', err)
    return 'denied'
  }
  // The resolved value is NOT the source of truth (Safari resolves
  // requestPermission with undefined): re-read the permission after the
  // prompt settles. A DISMISSED prompt leaves it at 'default' — reported as
  // 'default', never folded into a denial.
  return readNotificationPermission() ?? 'denied'
}

/**
 * Read the current notification authorization WITHOUT prompting. Desktop:
 * macOS answers from UNNotificationCenter; Linux/Windows always grant (no
 * authorization concept). Web: the browser permission state — 'default'
 * (never asked) is NOT a denial: the Settings toggle and the Test button
 * are the documented user gestures that request the permission (ADR-090,
 * decision 11), so only a real 'denied' may surface the blocked hint. An
 * RPC failure resolves to true — a transient transport error must not paint
 * a misleading "disabled in macOS Settings" hint.
 */
export async function checkNotificationAuthorization(): Promise<boolean> {
  if (isWebTransport()) {
    // Mapping 'default' to "denied" would hide exactly the Test button whose
    // click is supposed to request the permission — treat only 'denied' as
    // one. A permission read that THROWS (Firefox refuses to even answer on
    // an insecure origin) IS a denial: requestPermission auto-refuses there.
    if (!webNotificationsAvailable()) return true
    const permission = readNotificationPermission()
    return permission === 'default' || permission === 'granted'
  }
  const app = getApp()
  try {
    return await app.CheckNotificationAuthorization()
  } catch (err) {
    logger.warn('[system-notifications] authorization check failed; assuming granted', err)
    return true
  }
}

/** The two user-facing causes of a web-transport 'denied' permission. They
 *  need DIFFERENT hints: an insecure origin (plain HTTP off localhost) is a
 *  browser platform rule no site setting can lift — the fix is opening the
 *  app on a secure origin — while a secure-context denial is the per-site
 *  block the user CAN lift in the browser's site settings. */
export type WebNotificationDenialCause = 'insecure-context' | 'site-settings'

/**
 * Classify a 'denied' browser notification permission for the Settings
 * hint. Returns null when there is no denial to explain (the API is absent
 * or the permission is not 'denied'). Both the permission and the
 * secure-context reads are defensive: on an insecure origin Firefox throws
 * SecurityError from the `Notification.permission` getter itself — a failed
 * read is classified as the insecure-origin cause, never as a site-settings
 * block, because the browser auto-refuses notifications there.
 */
export function webNotificationDenialCause(): WebNotificationDenialCause | null {
  if (!webNotificationsAvailable()) return null
  const permission = readNotificationPermission()
  if (permission === null) return 'insecure-context'
  if (permission !== 'denied') return null
  try {
    return window.isSecureContext ? 'site-settings' : 'insecure-context'
  } catch {
    // An unreadable isSecureContext counts as the same insecure cause.
    return 'insecure-context'
  }
}

/** Rejected by showTestNotification when the web permission gesture does not
 *  settle on 'granted'. `outcome` distinguishes the two non-grant results so
 *  the Settings section can react differently: a REAL 'denied' surfaces the
 *  blocked hint (the Test button hides), while 'default' — the prompt was
 *  closed without an answer — is NOT a denial (ADR-090, decision 11): the
 *  section stays neutral and the button remains the documented retry
 *  gesture. */
export class NotificationPermissionError extends Error {
  constructor(readonly outcome: 'denied' | 'default') {
    super(
      outcome === 'denied'
        ? 'Notification permission is not granted — allow notifications for this site.'
        : 'Notification permission prompt was dismissed — send the test notification again to retry.',
    )
    this.name = 'NotificationPermissionError'
  }
}

/** Settings "preview" button: an unattributed banner — activating it focuses
 *  the window/tab but never navigates. Web transport: the click gesture is
 *  the honest moment to request the browser permission; a non-granted
 *  outcome rejects with NotificationPermissionError carrying it (a real
 *  'denied' or a dismissed prompt — 'default', not a denial). */
export async function showTestNotification(): Promise<void> {
  if (isWebTransport()) {
    // The click IS the documented permission gesture (ADR-090, decision 11):
    // request first, then send through the granted-only path.
    const outcome = await ensureNotificationPermission()
    if (outcome !== 'granted') {
      throw new NotificationPermissionError(outcome)
    }
    await sendWebNotification(
      'c0wrk — test notification',
      'Click routing works: activating this banner focuses the tab.',
      {},
    )
    return
  }
  const app = getApp()
  await app.ShowTestNotification()
}

/**
 * Subscribe to notification activations. The payload is validated with
 * `isNotificationClickedData`; a malformed one is reported through
 * `reportDroppedEvent` and never reaches the callback. Returns an
 * unsubscribe function (a no-op when the Wails runtime is absent).
 */
export function onNotificationClicked(
  callback: (data: NotificationClickedData) => void,
): () => void {
  return onGlobalEvent('notification_clicked', (data) => {
    if (data === undefined) return
    if (!isNotificationClickedData(data)) {
      reportDroppedEvent('notification_clicked', data)
      return
    }
    callback(data)
  })
}
