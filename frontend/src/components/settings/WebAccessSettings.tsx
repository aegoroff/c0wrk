import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, Eye, EyeOff, MonitorSmartphone, Pin } from 'lucide-react'
import {
  getWebAccessInfo,
  setWebAccessConnection,
  setWebAccessEnabled,
  type WebAccessInfo,
} from '@/api/webAccess'
import { clipboardSetText } from '@/api/runtime'
import { logger } from '@/lib/logger'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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
 * until revealed and both copy through the app clipboard bridge. The warnings
 * are the feature's honest cost: a tab holding them controls the whole app —
 * and when the bind leaves loopback, the listener itself is network-reachable
 * over plain HTTP, which carries its own stronger warning.
 */
export function WebAccessSettings() {
  // null until the RPC answers — the toggle stays disabled rather than
  // showing a guessed state.
  const [info, setInfo] = useState<WebAccessInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [copiedKey, setCopiedKey] = useState<'' | 'url' | 'token'>('')
  const copyTimer = useRef<number | null>(null)
  // The pin drafts. The port mirrors the persisted pin (empty = auto) and the
  // bind mirrors the persisted interface pin (empty = the 127.0.0.1 default);
  // the token is deliberately NEVER prefilled — it is live-secret material,
  // the row above reveals it on demand, and the draft only ever carries what
  // the operator just typed.
  const [bindDraft, setBindDraft] = useState('')
  const [portDraft, setPortDraft] = useState('')
  const [tokenDraft, setTokenDraft] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getWebAccessInfo().then((loaded) => {
      if (!cancelled) setInfo(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Seed the pin drafts once the authoritative read lands (0 = auto = empty;
  // an empty bind = the loopback default).
  useEffect(() => {
    const pin = info?.configuredPort ?? 0
    setPortDraft(pin > 0 ? String(pin) : '')
  }, [info?.configuredPort])

  useEffect(() => {
    setBindDraft(info?.configuredBind ?? '')
  }, [info?.configuredBind])

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

  /** Apply the pin drafts: bind '' = the 127.0.0.1 default, port '' = auto
   *  (0), token '' = ephemeral (''). The RPC persists AND hot-restarts the
   *  sidecar; the authoritative state is re-read, and the token draft is
   *  always cleared — a typed secret must not linger on screen after it
   *  traveled. The bind is validated backend-side (an IP literal or
   *  "localhost"); a rejection surfaces verbatim in the pin error. */
  const handlePin = useCallback(async () => {
    if (!info) return
    const trimmedPort = portDraft.trim()
    let port = 0
    if (trimmedPort !== '') {
      port = Number(trimmedPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        setPinError('Port must be empty (auto) or a whole number 1–65535.')
        return
      }
    }
    setPinBusy(true)
    setPinError(null)
    try {
      await setWebAccessConnection(bindDraft.trim(), port, tokenDraft.trim())
      const fresh = await getWebAccessInfo()
      if (fresh) setInfo(fresh)
      setTokenDraft('')
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'Failed to apply the connection settings.')
    } finally {
      setPinBusy(false)
    }
  }, [info, bindDraft, portDraft, tokenDraft])

  const statusLine = (() => {
    if (!info) return 'Status unavailable — the desktop bridge did not answer.'
    if (info.running) {
      // A loopback listener is machine-local by construction; a non-loopback
      // bind is reachable from the network, and "on this machine" would be
      // false comfort there.
      return info.bindIsLoopback
        ? `Running — open ${info.url} in a browser on this machine.`
        : `Running — open ${info.url} on this machine, or the same port from other devices on the network.`
    }
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
        description="Serve this app's UI to a browser from a local HTTP sidecar (loopback by default). The browser session sees the same chats, projects and tools as the desktop window."
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

      {info !== null && (
        <div className="flex flex-col gap-1.5 pl-12" data-testid="web-access-pin-block">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Pin className="size-3" />
            Fixed bind, port &amp; token
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              data-testid="web-access-pin-bind"
              type="text"
              value={bindDraft}
              onChange={(e) => setBindDraft(e.target.value)}
              placeholder="Bind — 127.0.0.1"
              aria-label="Fixed bind address (empty = 127.0.0.1)"
              disabled={pinBusy}
              className="h-7 w-40 text-xs"
              autoComplete="off"
            />
            <Input
              data-testid="web-access-pin-port"
              type="text"
              inputMode="numeric"
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value)}
              placeholder="Port — auto"
              aria-label="Fixed port (empty = auto)"
              disabled={pinBusy}
              className="h-7 w-32 text-xs"
              autoComplete="off"
            />
            <Input
              data-testid="web-access-pin-token"
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder={info.tokenPinned ? 'Token pinned — empty keeps it' : 'Token — empty = per-launch'}
              aria-label="Fixed token (empty = ephemeral per-launch)"
              disabled={pinBusy}
              className="h-7 w-56 text-xs"
              autoComplete="off"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="web-access-pin-apply"
              onClick={() => void handlePin()}
              disabled={pinBusy}
              className="h-7 text-xs"
            >
              {pinBusy ? 'Applying…' : 'Apply'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Persisted in config.yaml and applied immediately — a running sidecar restarts onto the
            new connection, so open browser tabs must sign in again. Bind takes an IP literal or
            &ldquo;localhost&rdquo; — empty = 127.0.0.1; 0.0.0.0 listens on every network interface.
          </p>
          {pinError !== null && (
            <p className="text-xs text-destructive" role="alert" data-testid="web-access-pin-error">
              {pinError}
            </p>
          )}
        </div>
      )}

      {info?.enabled && info.bindIsLoopback && (
        <div
          className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/20 p-2 text-xs text-warning"
          data-testid="web-access-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            A browser tab holding this URL and token has <span className="font-semibold">full control</span> of
            this app — every chat, project and tool the desktop window has. Anything running in that tab acts
            as you: never share the token or paste it into another site.
          </span>
        </div>
      )}

      {info?.enabled && !info.bindIsLoopback && (
        <div
          className="flex items-start gap-2 rounded-md bg-warning/15 border border-warning/30 p-2 text-xs text-warning"
          data-testid="web-access-warning-network"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            <span className="font-semibold">Network exposure:</span> the sidecar listens beyond loopback, so
            its login page is reachable from other machines on this network. Traffic is plain HTTP —
            unencrypted — and the token is the <span className="font-semibold">only protection</span>: pin a
            strong token and never expose this listener across an untrusted network.
          </span>
        </div>
      )}
    </div>
  )
}
