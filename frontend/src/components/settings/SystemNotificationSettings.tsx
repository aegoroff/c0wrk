import { useCallback, useEffect, useState } from 'react'
import { Bell, BellRing, Send } from 'lucide-react'
import { useSystemNotificationStore } from '@/stores/systemNotificationStore'
import { Toggle } from './ModelProfilesControls'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  checkNotificationAuthorization,
  initSystemNotifications,
  showTestNotification,
  webNotificationDenialCause,
} from '@/api/notifications'
import {
  getNotificationBannerTimeout,
  setNotificationBannerTimeout,
} from '@/api/config'
import { sendSystemNotification } from '@/lib/systemNotifications'
import { ensureNotificationPermission, NotificationPermissionError } from '@/api/notifications'
import { isWailsReady, isWebTransport } from '@/api/runtime'
import { isLinuxHost } from '@/lib/platform'
import { logger } from '@/lib/logger'

/** Tri-state of the section's permission view. 'checking' while the lazy
 *  mount probe runs; 'neutral' is every not-blocked state — granted, or an
 *  UNANSWERED 'default' prompt (not a denial, ADR-090 decision 11: the Test
 *  button stays the documented retry gesture); 'denied' surfaces the muted
 *  hint and hides the button. */
type PermissionState = 'checking' | 'neutral' | 'denied'

/** Banner-lifetime choices, in seconds. The two sentinels are the ends of the
 *  scale: -1 hands the decision to the notification daemon, 0 means the banner
 *  stays until the user acts on it. */
const bannerTimeoutOptions: { value: number; label: string }[] = [
  { value: -1, label: 'Default' },
  { value: 10, label: '10s' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 0, label: 'Never' },
]

/** The banner-lifetime setting only reaches the OS on Linux, where it becomes
 *  the freedesktop `expire_timeout`; macOS and Windows notification centers
 *  manage banner lifetime themselves, so the control is hidden there rather
 *  than shown as a knob that does nothing. (isLinuxHost lives in
 *  @/lib/platform.) */

/**
 * The hint shown while the authorization reads 'denied', per transport and —
 * web only — per denial cause: an insecure origin (plain HTTP off localhost)
 * is a browser platform rule NO site setting can lift, so the hint points at
 * the real fix (open the app via http://localhost:<port>, e.g. an SSH
 * tunnel); a secure-context denial is the per-site block the site-settings
 * text describes. The macOS text is unchanged.
 */
function deniedHint(): string {
  if (!isWebTransport()) {
    return 'Notifications are disabled for c0wrk in macOS Settings — enable them to receive alerts'
  }
  if (webNotificationDenialCause() === 'insecure-context') {
    return 'Browsers only allow web notifications on secure origins (HTTPS or localhost) — this page is plain HTTP, so no setting can enable them here. Open c0wrk via http://localhost:<port> (for example, through an SSH tunnel) to receive alerts.'
  }
  return 'Notifications are blocked for this site in your browser — allow them in the browser’s site settings to receive alerts'
}

/**
 * General-tab control for system (OS-level) notifications, mirroring
 * SoundSettings directly above it. A single master toggle governs ALL
 * banners: turning it on initializes the Go notification bridge (idempotent)
 * and previews one banner; turning it off simply stops future sends — the OS
 * retires already-delivered banners on its own schedule, so there is no
 * teardown to run.
 *
 * The authorization probe is deliberately lazy: it runs on this section's
 * mount (when the General tab renders it), not at app start, so opening
 * Settings — not launching the app — pays for it. A REAL denial (macOS site
 * setting, browser site setting, insecure web origin) is surfaced as a muted
 * hint instead of a silently dead channel; previews are suppressed in that
 * state. A closed-without-answer prompt ('default') is NOT a denial: the
 * section stays neutral with the Test button as the retry gesture.
 */
export function SystemNotificationSettings() {
  const enabled = useSystemNotificationStore((s) => s.enabled)
  const setEnabled = useSystemNotificationStore((s) => s.setEnabled)
  const [permission, setPermission] = useState<PermissionState>('checking')
  const [bannerTimeout, setBannerTimeout] = useState<number | null>(null)

  // Linux-only, and only worth an RPC when the channel is on at all.
  useEffect(() => {
    if (!isWailsReady() || !isLinuxHost()) return
    let cancelled = false
    void getNotificationBannerTimeout()
      .then((seconds) => {
        if (!cancelled) setBannerTimeout(seconds)
      })
      .catch((err) => logger.warn('[system-notifications] banner timeout read failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  const handleBannerTimeoutChange = useCallback(async (seconds: number) => {
    const previous = bannerTimeout
    setBannerTimeout(seconds) // optimistic: the control must feel immediate
    try {
      await setNotificationBannerTimeout(seconds)
    } catch (err) {
      logger.warn('[system-notifications] banner timeout write failed', err)
      setBannerTimeout(previous)
    }
  }, [bannerTimeout])

  // One authorization read per mount. Fail-open (a transport error resolves
  // to granted inside checkNotificationAuthorization), so the hint only ever
  // appears for a genuine denial — a macOS one on the desktop, a blocked
  // site permission in the web transport. Without any transport (vitest,
  // dev-frontend) the section stays in the neutral granted state.
  useEffect(() => {
    if (!isWailsReady() && !isWebTransport()) return
    let cancelled = false
    void checkNotificationAuthorization().then((granted) => {
      if (!cancelled) setPermission(granted ? 'neutral' : 'denied')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleChange = (next: boolean): void => {
    setEnabled(next)
    if (!next) return
    // Fire-and-forget init (idempotent on both sides — App.tsx already ran
    // it at startup, this is the retry/first-touch path) + an immediate
    // preview banner so the user can confirm the channel works. In the web
    // transport this click is ALSO the permission gesture: the toggle-on
    // click requests the browser's notification permission before the
    // preview, so a granted prompt lands with the confirmation banner.
    // With a denied authorization the send lands nowhere; the muted hint is
    // what surfaces that case, so the preview is skipped there.
    void initSystemNotifications().catch(() => {})
    void ensureNotificationPermission()
      .then((outcome) => {
        // Three outcomes: 'granted' previews the confirmation banner; a real
        // 'denied' flips to the muted hint; 'default' — the prompt was
        // closed WITHOUT an answer — is NOT a denial (ADR-090, decision 11):
        // it lands in the neutral state, so no hint shows and the Test
        // button stays available as the documented retry gesture.
        //
        // Only the WEB outcome is a permission verdict: the desktop
        // ensureNotificationPermission is a no-op that resolves 'granted',
        // and folding that constant into the state here would wipe a real
        // 'denied' the mount probe read from the OS (macOS System Settings)
        // — the hint would vanish while the authorization stays denied.
        // The preview guard below already keeps the banner suppressed in
        // that state.
        if (isWebTransport()) {
          setPermission(outcome === 'denied' ? 'denied' : 'neutral')
        }
        if (outcome === 'granted' && permission !== 'denied') {
          void sendSystemNotification({
            kind: 'success',
            title: 'c0wrk — System notifications enabled',
            body: 'You will see notifications like this when tasks finish or need your input.',
          })
        }
      })
      .catch(() => {})
  }

  // The test button uses the platform banner (Go-authored ShowTestNotification
  // on the desktop; the browser Notification API in the web transport): it
  // demonstrates click routing too — activating it focuses the window/tab
  // without navigating anywhere. A web rejection carries the gesture's
  // outcome: only a REAL denial ('denied') flips the section to its hint;
  // a dismissed prompt ('default', not a denial) keeps the neutral state so
  // the button stays right here as the retry gesture (ADR-090, decision 11).
  const handleTest = (): void => {
    void showTestNotification().catch((err) => {
      logger.warn('[system-notifications] test notification failed', err)
      if (isWebTransport() && err instanceof NotificationPermissionError) {
        setPermission(err.outcome === 'denied' ? 'denied' : 'neutral')
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {enabled ? (
          <BellRing className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Bell className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">System Notifications</span>
      </div>
      <Toggle
        checked={enabled}
        onChange={handleChange}
        label={enabled ? 'Enabled' : 'Disabled'}
        description="Show a system notification when a task finishes, when your input is needed, or on errors. Works alongside sound notifications."
      />
      {enabled && bannerTimeout !== null && (
        <div className="flex flex-col gap-1.5 pl-12" data-testid="banner-timeout-control">
          <span className="text-xs text-muted-foreground">
            How long a banner stays on screen
          </span>
          {/* An option picker (not view tabs — there is no associated
              tabpanel), matching SecuritySettings/MCPServerForm pickers. */}
          <SegmentedControl
            ariaLabel="Banner timeout"
            semantic="radio"
            fullWidth
            items={bannerTimeoutOptions.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            value={bannerTimeout}
            onValueChange={(value) => void handleBannerTimeoutChange(value)}
          />
          <p className="text-xs text-muted-foreground">
            “Never” keeps the banner until you click or dismiss it — useful because some desktops
            drop an expired banner silently, without keeping it in the notification history.
          </p>
        </div>
      )}
      {permission === 'denied' ? (
        <p
          className="text-xs text-muted-foreground pl-12"
          data-testid="notification-permission-hint"
        >
          {deniedHint()}
        </p>
      ) : (
        enabled && (
          <button
            type="button"
            data-testid="send-test-notification"
            onClick={handleTest}
            className="self-start flex items-center gap-1.5 rounded border border-input px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 active:bg-muted/30 focus-visible:outline-none"
          >
            <Send className="size-3 shrink-0" />
            Send test notification
          </button>
        )
      )}
    </div>
  )
}
