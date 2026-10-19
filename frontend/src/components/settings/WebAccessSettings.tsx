import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, Eye, EyeOff, MonitorSmartphone } from 'lucide-react'
import { getWebAccessInfo, setWebAccessEnabled, type WebAccessInfo } from '@/api/webAccess'
import { clipboardSetText } from '@/api/runtime'
import { logger } from '@/lib/logger'
import { Toggle } from './ModelProfilesControls'

/**
 * Settings → General → Web Access (ADR-090): the browser sidecar's control
 * surface. The toggle writes through App.SetWebAccessEnabled — which persists
 * AND applies in the same call (start/stop on the fly) — so writes are
 * optimistic with a rollback on rejection, and the authoritative post-toggle
 * state (running flag, resolved URL, live token) is re-read instead of being
 * derived locally.
 *
 * The URL + token are the browser login credentials: the token stays masked
 * until revealed and both copy through the app clipboard bridge. The warning
 * is the feature's honest cost: a tab holding them controls the whole app.
 */
export function WebAccessSettings() {
  // null until the RPC answers — the toggle stays disabled rather than
  // showing a guessed state.
  const [info, setInfo] = useState<WebAccessInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [copiedKey, setCopiedKey] = useState<'' | 'url' | 'token'>('')
  const copyTimer = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void getWebAccessInfo().then((loaded) => {
      if (!cancelled) setInfo(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // A new credential invalidates any reveal: after a start/restart the token
  // on screen must never be a stale one shown in the clear.
  useEffect(() => {
    setRevealed(false)
  }, [info?.token])

  // Clear the copy flash on unmount (and never leak the timer).
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!info) return
      const previous = info
      setInfo({ ...info, enabled: next }) // optimistic: the control must feel immediate
      setSaving(true)
      try {
        await setWebAccessEnabled(next)
        // The toggle both persisted and applied: re-read the authoritative
        // state instead of deriving running/url/token locally. A failed
        // re-read rolls the display back — the backend still holds the
        // previous value everywhere the UI can verify.
        const fresh = await getWebAccessInfo()
        setInfo(fresh ?? previous)
      } catch (err) {
        logger.error('Failed to toggle web access:', err)
        setInfo(previous) // the backend still holds the previous value
      } finally {
        setSaving(false)
      }
    },
    [info],
  )

  const handleCopy = useCallback(async (key: 'url' | 'token', text: string) => {
    try {
      await clipboardSetText(text)
      setCopiedKey(key)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopiedKey(''), 1600)
    } catch (err) {
      logger.error('Failed to copy to clipboard:', err)
    }
  }, [])

  const statusLine = (() => {
    if (!info) return 'Status unavailable — the desktop bridge did not answer.'
    if (info.running) return `Running — open ${info.url} in a browser on this machine.`
    if (info.enabled) return 'Enabled, but not running in this session — it starts on the next app launch.'
    return 'Off — the app is reachable from the desktop window only.'
  })()

  return (
    <div className="flex flex-col gap-2" data-testid="web-access-settings">
      <div className="flex items-center gap-2">
        <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Web Access</span>
      </div>
      <Toggle
        checked={info?.enabled ?? false}
        onChange={(next) => void handleToggle(next)}
        disabled={info === null || saving}
        label={info?.enabled ? 'Enabled' : 'Disabled'}
        description="Serve this app's UI to a local browser from a loopback sidecar. The browser session sees the same chats, projects and tools as the desktop window."
      />
      <p className="text-xs text-muted-foreground" data-testid="web-access-status">
        {statusLine}
      </p>

      {info?.running && info.url !== '' && (
        <div className="flex items-center gap-2 pl-12" data-testid="web-access-url-row">
          <code className="min-w-0 flex-1 truncate rounded-xs bg-muted px-1.5 py-0.5 text-xs">
            {info.url}
          </code>
          <button
            type="button"
            title="Copy URL"
            aria-label="Copy URL"
            data-testid="web-access-copy-url"
            onClick={() => void handleCopy('url', info.url)}
            className="rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100"
          >
            {copiedKey === 'url' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
      )}

      {info !== null && info.token !== '' && (
        <div className="flex items-center gap-2 pl-12" data-testid="web-access-token-row">
          <code className="min-w-0 flex-1 truncate rounded-xs bg-muted px-1.5 py-0.5 text-xs">
            {revealed ? info.token : '••••••••••••••••••••'}
          </code>
          <button
            type="button"
            title={revealed ? 'Hide token' : 'Reveal token'}
            aria-label={revealed ? 'Hide token' : 'Reveal token'}
            data-testid="web-access-reveal"
            onClick={() => setRevealed((r) => !r)}
            className="rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100"
          >
            {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            type="button"
            title="Copy token"
            aria-label="Copy token"
            data-testid="web-access-copy-token"
            onClick={() => void handleCopy('token', info.token)}
            className="rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100"
          >
            {copiedKey === 'token' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
      )}

      {info?.enabled && (
        <div
          className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/20 p-2 text-xs text-warning"
          data-testid="web-access-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            A browser tab holding this URL and token has <span className="font-semibold">full control</span> of
            this app — every chat, project and tool the desktop window has. The listener is loopback-only, but
            anything running in that tab acts as you: never share the token or paste it into another site.
          </span>
        </div>
      )}
    </div>
  )
}
