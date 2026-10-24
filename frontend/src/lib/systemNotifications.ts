// OS-level system notifications via the Go notification bridge.
//
// The sound pipeline (lib/sound.ts) turns session events into synthesized
// tones; this module is its visual counterpart: it turns the SAME events into
// native notification-center banners. Like sound, everything here is
// best-effort — a dropped banner must never break the event pipeline, so
// every entry point catches and logs at warn instead of throwing.
//
// TRANSPORT: every runtime call goes through the Go bindings
// (@/api/notifications → App.InitNotifications / App.SendSystemNotification),
// NOT window.runtime.SendNotification. The click round-trip is Go-owned: the
// backend registers the single OnNotificationResponse callback, focuses the
// window on activation, and emits `notification_clicked` with the routing
// ids extracted from the data map sent here. See @/api/notifications.ts for
// the full rationale. This module keeps the event → content mapping pure and
// owns only the toggle + best-effort semantics.
//
// The event → content mapping (`classifyNotificationContent`) is pure and
// mirrors `classifySessionEvent` (hooks/events/useSoundEvents.ts): the same
// event set, the same task_complete success disambiguation, the same
// defensive `unknown` reads. It returns per-type title/body strings instead of
// a bare kind, because a banner carries text, not a tone.

import type { SessionEventKey } from '@/types/events'
import {
  initSystemNotifications as initGoNotifications,
  sendSystemNotification as sendGoNotification,
} from '@/api/notifications'
import { isWailsReady, isWebTransport } from '@/api/runtime'
import { useSystemNotificationStore } from '@/stores/systemNotificationStore'
import { logger } from '@/lib/logger'

/** The three notification categories (mirrors `SoundKind`). */
export type NotificationKind = 'success' | 'attention' | 'error'

/** What a single banner says, derived purely from the session event. */
export interface SessionNotificationContent {
  kind: NotificationKind
  title: string
  body: string
}

/** Context attached to a banner so a click can be routed back to the session. */
export interface SessionNotificationContext {
  sessionId: string
  projectId?: string
}

/** Longest body we forward to the notification center, ellipsis included. */
const BODY_MAX_CHARS = 200

/** Clip `text` to `max` characters, appending an ellipsis when it had to cut. */
function truncate(text: string, max: number = BODY_MAX_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** Read a well-known optional string field off an untyped event payload. */
function readString(data: unknown, field: string): string | undefined {
  const value = (data as Record<string, unknown> | null | undefined)?.[field]
  return typeof value === 'string' ? value : undefined
}

/**
 * Pure mapping from a session event to its notification content.
 *
 * Returns null for events that should stay silent. This is the notification
 * counterpart of `classifySessionEvent`: same event set, same
 * task_complete success disambiguation, same defensive `unknown` reads —
 * but each event type yields its own title/body pair (a banner must tell the
 * user WHAT needs attention, not just that something does).
 */
export function classifyNotificationContent(
  event: SessionEventKey,
  data: unknown,
): SessionNotificationContent | null {
  switch (event) {
    // --- success / failure of the whole task ---
    case 'task_complete': {
      // success === false means partial/failed/aborted — an error, not a win.
      const success = (data as { success?: boolean } | null | undefined)?.success
      if (success === false) {
        const output = readString(data, 'output')
        return {
          kind: 'error',
          title: 'Task failed',
          body: output ? truncate(output) : 'The task finished with errors.',
        }
      }
      const output = readString(data, 'output')
      return {
        kind: 'success',
        title: 'Task completed',
        body: output ? truncate(output) : 'The task finished successfully.',
      }
    }

    // --- attention: any interactive prompt requiring the user ---
    case 'ask_user':
      return {
        kind: 'attention',
        title: 'Your input is needed',
        body: 'The agent asked a question and is waiting for your answer.',
      }
    case 'step_limit':
      return {
        kind: 'attention',
        title: 'Step limit reached',
        body: 'The task hit its step limit and is waiting for your decision.',
      }
    case 'tool_confirm':
      return {
        kind: 'attention',
        title: 'Tool approval required',
        body: 'A tool call needs your confirmation before it can run.',
      }
    case 'plan_review_ready':
      return {
        kind: 'attention',
        title: 'Plan ready for review',
        body: 'A proposed plan is waiting for your approval.',
      }
    case 'task_failed_resumable': {
      const message = readString(data, 'message')
      return {
        kind: 'attention',
        title: 'Task failed — resumable',
        body: message ? truncate(message) : 'The task stopped with an error and can be resumed.',
      }
    }
    case 'goal_proposal':
      return {
        kind: 'attention',
        title: 'Goal proposal ready',
        body: 'A goal proposal needs your review before execution continues.',
      }
    case 'goal_suggestion':
      return {
        kind: 'attention',
        title: 'Goal mode suggested',
        body: 'Goal mode looks like a better fit for this task — the offer is waiting for your answer.',
      }

    // --- error ---
    case 'error': {
      const message = readString(data, 'error')
      return {
        kind: 'error',
        title: 'Task error',
        body: message ? truncate(message) : 'An unexpected error occurred.',
      }
    }
    case 'task_cancelled':
      return {
        kind: 'error',
        title: 'Task cancelled',
        body: 'The running task was cancelled.',
      }

    default:
      return null
  }
}

// --- Transport --------------------------------------------------------------
//
// Desktop: every call goes through the Go bindings (@/api/notifications).
// Web transport (ADR-099): @/api/notifications branches to the browser
// Notification API itself, so the SAME lib entry points serve both. The
// availability guard below accepts either transport; the web branches live
// behind the api layer so this module stays a pure event→content mapping
// with toggle + best-effort semantics. The web permission contract also
// lives behind that api boundary: the per-event send path never prompts and
// never errors on a missing grant — it drops the banner silently (debug per
// occurrence, one warn per app run), and only the Settings toggle and the
// Test button (real user gestures) request the permission.

/** True when SOME notification transport exists: the Go bindings (desktop
 *  webview) or the browser Notification API (web-access sidecar tab). False
 *  under vitest/SSR/dev-frontend, where notifications silently no-op. */
function notificationTransportAvailable(): boolean {
  return isWailsReady() || isWebTransport()
}

/**
 * Show one native notification. A silent no-op when the master toggle is off
 * or no transport exists. Best-effort: failures are logged at warn and
 * swallowed — never break the event pipeline.
 */
export async function sendSystemNotification(
  content: SessionNotificationContent,
  context?: SessionNotificationContext,
): Promise<void> {
  try {
    if (!useSystemNotificationStore.getState().enabled) return
    if (!notificationTransportAvailable()) return
    await sendGoNotification(
      content.title,
      content.body,
      context ? { sessionId: context.sessionId, projectId: context.projectId } : undefined,
    )
  } catch (err) {
    logger.warn('[system-notifications] send failed', err)
  }
}

/**
 * Lazily initialize the notification bridge: the Go side
 * (InitializeNotifications + the click callback + the macOS authorization
 * prompt) on the desktop, a permission read on the web transport.
 * Idempotent: the work runs at most once per app run — concurrent and later
 * calls await/return the same settled promise. Never throws: a platform
 * without notifications (Linux without a D-Bus notification service, a
 * denied authorization, a browser without the Notification API) is logged
 * and left enabled — individual sends simply fail softly. A FAILED init is
 * NOT memoized on the backend, but this memoized frontend entry still calls
 * it only once per app run; retry happens after the next reload.
 */
async function runInitSystemNotifications(): Promise<void> {
  if (!notificationTransportAvailable()) {
    logger.debug('[system-notifications] no notification transport; skipping init')
    return
  }
  try {
    await initGoNotifications()
  } catch (err) {
    logger.warn('[system-notifications] init failed (non-fatal)', err)
  }
}

let initPromise: Promise<void> | null = null

/** See `runInitSystemNotifications` — memoized, never-throwing entry point. */
export function initSystemNotifications(): Promise<void> {
  if (!initPromise) initPromise = runInitSystemNotifications()
  return initPromise
}

/** Test-only: reset module state so unit tests start from a clean slate. */
export function __resetSystemNotificationModule(): void {
  initPromise = null
}
