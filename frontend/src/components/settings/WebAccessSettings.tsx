import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, MonitorSmartphone } from 'lucide-react'
import { getWebAccessInfo, setWebAccessEnabled, type WebAccessInfo } from '@/api/webAccess'
import { logger } from '@/lib/logger'
import { Toggle } from './ModelProfilesControls'
import { WebAccessAddressSettings } from './WebAccessAddressSettings'
import { WebAccessTokenSettings } from './WebAccessTokenSettings'
import { WebAccessTLSSettings } from './WebAccessTLSSettings'

/**
 * Settings → General → Web Access (ADR-101): the browser sidecar's control
 * surface — a thin COMPOSITOR over the three per-block files this section is
 * split into (the address field, the TLS transport block and the token
 * field each own their draft state and write discipline; this parent owns
 * the single authoritative `info` read they all render from, plus the
 * enable toggle and the honest-cost warnings).
 *
 * The toggle writes through App.SetWebAccessEnabled — which persists AND
 * applies in the same call (start/stop on the fly) — so writes are
 * optimistic with a rollback on rejection, and the authoritative post-toggle
 * state (running flag, resolved URL, live token) is re-read instead of being
 * derived locally.
 *
 * ADR-102: the transport-affecting writes (the enable toggle, the address
 * pin, the TLS switch and its path commits) also refresh the top-of-Settings
 * config warning banner through onConfigChanged — the backend recomputes the
 * section's config-load warnings on each, so the banner must re-read them.
 * The token writes cannot move that warning and stay out.
 */

export function WebAccessSettings({ onConfigChanged }: { onConfigChanged?: () => void }) {
  // null until the RPC answers — the toggle stays disabled rather than
  // showing a guessed state.
  const [info, setInfo] = useState<WebAccessInfo | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getWebAccessInfo().then((loaded) => {
      if (!cancelled) setInfo(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!info) return
      const previous = info
      setInfo({ ...info, enabled: next }) // optimistic: the control must feel immediate
      setSaving(true)
      try {
        await setWebAccessEnabled(next)
        // ADR-102: the enable flip is a transport change, so the backend has
        // recomputed the section's config-load warnings — tell the banner to
        // re-read them.
        onConfigChanged?.()
        // The toggle both persisted and applied: re-read the authoritative
        // state instead of deriving running/url/token locally. A failed
        // re-read keeps the APPLIED switch value — the write succeeded, so
        // falling back to `previous` would render a network-facing sidecar
        // as Off (the same re-read-null semantics the TLS block follows;
        // its test pins them). Only the running/url/token detail may go
        // stale until the next successful read.
        const fresh = await getWebAccessInfo()
        setInfo(fresh ?? { ...previous, enabled: next })
      } catch (err) {
        logger.error('Failed to toggle web access:', err)
        setInfo(previous) // the backend still holds the previous value
      } finally {
        setSaving(false)
      }
    },
    [info, onConfigChanged],
  )

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
        description="Serve this app's UI to a browser from a local HTTP or HTTPS sidecar (loopback by default). The browser session sees the same chats, projects and tools as the desktop window."
      />
      <p className="text-xs text-muted-foreground" data-testid="web-access-status">
        {statusLine}
      </p>

      {info !== null && <WebAccessAddressSettings info={info} onInfo={setInfo} onConfigChanged={onConfigChanged} />}

      {info !== null && <WebAccessTLSSettings info={info} onInfo={setInfo} onConfigChanged={onConfigChanged} />}

      {info !== null && info.token !== '' && <WebAccessTokenSettings info={info} onInfo={setInfo} />}

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

      {info?.enabled && !info.bindIsLoopback && !info.tlsEnabled && (
        <div
          className="flex items-start gap-2 rounded-md bg-warning/15 border border-warning/30 p-2 text-xs text-warning"
          data-testid="web-access-warning-network"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            <span className="font-semibold">Network exposure:</span> the sidecar listens beyond loopback, so
            its login page is reachable from other machines on this network. Traffic is plain HTTP —
            unencrypted — and the token is the <span className="font-semibold">only protection</span>: keep
            the token secret and never expose this listener across an untrusted network.
          </span>
        </div>
      )}

      {info?.enabled && !info.bindIsLoopback && info.tlsEnabled && (
        <div
          className="flex items-start gap-2 rounded-md bg-warning/15 border border-warning/30 p-2 text-xs text-warning"
          data-testid="web-access-warning-network"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            <span className="font-semibold">Network exposure:</span> the sidecar listens beyond loopback, so
            its login page is reachable from other machines on this network. Traffic is TLS-encrypted, but a
            self-signed certificate still warns every browser — verify it — and the token remains the{' '}
            <span className="font-semibold">only protection</span>: keep it secret and never expose this
            listener across an untrusted network.
          </span>
        </div>
      )}
    </div>
  )
}
