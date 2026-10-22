import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  MonitorSmartphone,
  Pin,
  RefreshCw,
} from 'lucide-react'
import {
  getWebAccessInfo,
  parseWebAccessAddress,
  parseWebAccessToken,
  regenerateWebAccessToken,
  setWebAccessConnection,
  setWebAccessToken,
  setWebAccessEnabled,
  type WebAccessInfo,
} from '@/api/webAccess'
import { clipboardSetText, emit } from '@/api/runtime'
import { logger } from '@/lib/logger'
import { generateUUID } from '@/lib/ids'
import { Input } from '@/components/ui/input'
import { Toggle } from './ModelProfilesControls'
import { WebAccessTLSSettings } from './WebAccessTLSSettings'

/**
 * Settings → General → Web Access (ADR-090): the browser sidecar's control
 * surface. The toggle writes through App.SetWebAccessEnabled — which persists
 * AND applies in the same call (start/stop on the fly) — so writes are
 * optimistic with a rollback on rejection, and the authoritative post-toggle
 * state (running flag, resolved URL, live token) is re-read instead of being
 * derived locally.
 *
 * The address block is one URL-style field that both displays the persisted
 * URL (with its http:// prefix) and accepts edits: "http://" is added when
 * the operator omits it, the shape is validated locally with a strict pattern
 * and an invalid value never reaches the backend. There is no apply button —
 * the field commits like the UI Scale control: on Enter or on focus loss.
 *
 * The token is a second field of the same design, placed under the address.
 * It displays the live credential (masked until revealed) and accepts an
 * operator-typed value of 8–256 characters, committing the same way; the
 * empty field always reverts (emptiness means GENERATED — it must never
 * overwrite an existing credential). Regenerate mints a fresh one instead.
 * Every token write travels its own RPC (SetWebAccessToken /
 * RegenerateWebAccessToken) and the backend serializes them under
 * webAccessMu, so the UI-side drafts can never interleave a persist+restart
 * pair. The warnings are the feature's honest cost: a tab holding them
 * controls the whole app — and when the bind leaves loopback, the listener
 * itself is network-reachable over plain HTTP, which carries its own
 * stronger warning.
 *
 * ADR-095: the transport-affecting writes (the enable toggle, the address
 * pin, the TLS switch and its path commits) also refresh the top-of-Settings
 * config warning banner through onConfigChanged — the backend recomputes the
 * section's config-load warnings on each, so the banner must re-read them.
 * The token writes cannot move that warning and stay out.
 */

/** Renders the persisted (bind, port) pin as the full URL the single field
 *  displays and edits: the scheme follows the persisted TLS switch (ADR-092
 *  — what the field shows is the transport the sidecar will serve), plus the
 *  bind (an IPv6 bind bracketed) and the port only when pinned (0 = auto =
 *  omitted). Empty bind = the empty default draft. */
function formatWebAccessAddress(bind: string, port: number, tlsEnabled: boolean): string {
  if (bind === '') return ''
  const host = bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind
  const scheme = tlsEnabled ? 'https' : 'http'
  return port > 0 ? `${scheme}://${host}:${port}` : `${scheme}://${host}`
}

export function WebAccessSettings({ onConfigChanged }: { onConfigChanged?: () => void }) {
  // null until the RPC answers — the toggle stays disabled rather than
  // showing a guessed state.
  const [info, setInfo] = useState<WebAccessInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [copiedKey, setCopiedKey] = useState<'' | 'url' | 'token'>('')
  const copyTimer = useRef<number | null>(null)
  // The drafts mirror the persisted state (an empty address = the 127.0.0.1 +
  // auto-port defaults); the error slots hold the local refusals OR the
  // backend's rejections — both block the save. Neither field saves on
  // keystroke: each commits on Enter or focus loss, like the UI Scale
  // control.
  const [addressDraft, setAddressDraft] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [regenBusy, setRegenBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getWebAccessInfo().then((loaded) => {
      if (!cancelled) setInfo(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Seed the drafts once the authoritative read lands (and after every
  // applied change: the re-read canonicalizes the shapes — including the
  // URL scheme, which follows the TLS switch).
  useEffect(() => {
    setAddressDraft(
      formatWebAccessAddress(
        info?.configuredBind ?? '',
        info?.configuredPort ?? 0,
        info?.tlsEnabled ?? false,
      ),
    )
  }, [info?.configuredBind, info?.configuredPort, info?.tlsEnabled])
  useEffect(() => {
    setTokenDraft(info?.token ?? '')
  }, [info?.token])

  // A new credential invalidates any reveal: after a start/restart/rotation
  // the token on screen must never be a stale one shown in the clear.
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
        // ADR-095: the enable flip is a transport change, so the backend has
        // recomputed the section's config-load warnings — tell the banner to
        // re-read them.
        onConfigChanged?.()
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
    [info, onConfigChanged],
  )

  const handleCopy = useCallback(async (key: 'url' | 'token', text: string) => {
    // `clipboardSetText` reports the verdict as a boolean — `false` (or a
    // rejection, folded in defensively) is a failed copy: log it, toast it,
    // and never flash the success state.
    const ok = await clipboardSetText(text).catch(() => false)
    if (!ok) {
      logger.error('Failed to copy to clipboard')
      emit('runtime_error', {
        id: generateUUID(),
        message: 'Failed to copy to clipboard',
      })
      return
    }
    setCopiedKey(key)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopiedKey(''), 1600)
  }, [])

  /** Commit the address draft (Enter or focus loss): the local pattern
   *  validates and parses it into (bind, port) — an invalid value is refused
   *  HERE, before any RPC, and an unchanged value saves nothing. The RPC
   *  persists AND hot-restarts the sidecar; the authoritative state is
   *  re-read (which also re-seeds the draft into its canonical shape). */
  const commitAddress = useCallback(async () => {
    if (!info || pinBusy) return
    const parsed = parseWebAccessAddress(addressDraft)
    if ('error' in parsed) {
      setAddressError(parsed.error)
      return
    }
    if (parsed.bind === info.configuredBind && parsed.port === info.configuredPort) {
      setAddressError(null)
      return
    }
    setPinBusy(true)
    setAddressError(null)
    try {
      await setWebAccessConnection(parsed.bind, parsed.port)
      // ADR-095: a re-bind can move the exposure warning in or out of the
      // loopback class — the banner re-reads the recomputed warnings.
      onConfigChanged?.()
      const fresh = await getWebAccessInfo()
      if (fresh) setInfo(fresh)
    } catch (err) {
      setAddressError(err instanceof Error ? err.message : 'Failed to apply the address settings.')
    } finally {
      setPinBusy(false)
    }
  }, [info, addressDraft, pinBusy, onConfigChanged])

  /** Commit the token draft (Enter or focus loss), mirroring the address
   *  field: local validation first (trimmed, 8–256 characters), an unchanged
   *  value saves nothing, and the empty draft always REVERTS — emptiness
   *  means GENERATED and must never overwrite an existing credential. The
   *  RPC persists AND hot-restarts the sidecar; the authoritative state is
   *  re-read afterwards. */
  const commitToken = useCallback(async () => {
    if (!info || tokenBusy) return
    if (tokenDraft.trim() === '') {
      setTokenDraft(info.token)
      setTokenError(null)
      return
    }
    const parsed = parseWebAccessToken(tokenDraft)
    if ('error' in parsed) {
      setTokenError(parsed.error)
      return
    }
    if (parsed.token === info.token) {
      setTokenError(null)
      return
    }
    setTokenBusy(true)
    setTokenError(null)
    try {
      await setWebAccessToken(parsed.token)
      const fresh = await getWebAccessInfo()
      if (fresh) setInfo(fresh)
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to apply the token.')
    } finally {
      setTokenBusy(false)
    }
  }, [info, tokenDraft, tokenBusy])

  /** Rotate the credential: mints, persists and hot-restarts — every open
   *  browser tab must sign in again with the token this section now shows. */
  const handleRegenerate = useCallback(async () => {
    setRegenBusy(true)
    setTokenError(null)
    try {
      await regenerateWebAccessToken()
      const fresh = await getWebAccessInfo()
      if (fresh) setInfo(fresh)
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to regenerate the token.')
    } finally {
      setRegenBusy(false)
    }
  }, [])

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

  /** Shared Enter-to-commit handler for the two self-committing fields. */
  const commitOnEnter = (commit: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  }

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

      {info !== null && (
        <div className="flex flex-col gap-1.5 pl-12" data-testid="web-access-address-block">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Pin className="size-3" />
            Address &amp; port
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              data-testid="web-access-address-input"
              type="text"
              value={addressDraft}
              onChange={(e) => setAddressDraft(e.target.value)}
              onKeyDown={commitOnEnter(() => void commitAddress())}
              onBlur={() => void commitAddress()}
              placeholder="http://127.0.0.1:8080 — empty = auto"
              aria-label="Listen address and port (empty = 127.0.0.1 with an auto port; commits on Enter or focus loss)"
              title="URL-style — http:// is added when omitted; commits on Enter or focus loss. 0.0.0.0 (or ::) listens on every network interface. Persisted in config.yaml and applied immediately: a running sidecar restarts onto the new address, so open browser tabs must sign in again."
              disabled={pinBusy}
              className="h-7 w-80 text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            {info.url !== '' && (
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
            )}
          </div>
          {addressError !== null && (
            <p className="text-xs text-destructive" role="alert" data-testid="web-access-address-error">
              {addressError}
            </p>
          )}
        </div>
      )}

      {info !== null && <WebAccessTLSSettings info={info} onInfo={setInfo} onConfigChanged={onConfigChanged} />}

      {info !== null && info.token !== '' && (
        <div className="flex flex-col gap-1.5 pl-12" data-testid="web-access-token-block">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <KeyRound className="size-3" />
            Token
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              data-testid="web-access-token-input"
              type={revealed ? 'text' : 'password'}
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              onKeyDown={commitOnEnter(() => void commitToken())}
              onBlur={() => void commitToken()}
              placeholder="generated at the first start"
              aria-label="Access token (8-256 characters; an empty field reverts; commits on Enter or focus loss)"
              title="The credential browser tabs sign in with — minted and persisted at the first start. A custom value (8–256 characters) commits on Enter or focus loss, like the address; an emptied field reverts instead of clearing the credential. Regenerate mints a fresh one — every open tab must sign in again."
              disabled={tokenBusy}
              className="h-7 w-80 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
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
            <button
              type="button"
              title="Regenerate token — every open browser tab must sign in again"
              aria-label="Regenerate token"
              data-testid="web-access-token-regenerate"
              disabled={regenBusy}
              onClick={() => void handleRegenerate()}
              className="rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
            >
              {regenBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </button>
          </div>
          {tokenError !== null && (
            <p className="text-xs text-destructive" role="alert" data-testid="web-access-token-error">
              {tokenError}
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
