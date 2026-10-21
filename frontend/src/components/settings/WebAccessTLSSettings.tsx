import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, Lock, ShieldCheck } from 'lucide-react'
import {
  generateWebAccessCertificate,
  getWebAccessInfo,
  setWebAccessTLS,
  type WebAccessInfo,
} from '@/api/webAccess'
import { logger } from '@/lib/logger'
import { Input } from '@/components/ui/input'
import { Toggle } from './ModelProfilesControls'

/**
 * Settings → Web Access — the HTTPS (TLS) block (ADR-092). Lives in its own
 * file so WebAccessSettings.tsx stays under the 200-line target: the parent
 * owns the single `info` state and renders this block with it.
 *
 * Same write discipline as every other control in the section: the toggle is
 * optimistic with a rollback on rejection and the authoritative state is
 * re-read after every applied write (the toggle persists AND hot-restarts
 * the sidecar onto the new transport — or restores the previous settings,
 * which the surfaced error says). The certificate path is a self-committing
 * field like the address/token pair: Enter or focus loss, an unchanged value
 * saves nothing, and the PERSISTED key path is threaded through so a
 * hand-configured pair is never clobbered by the `<cert-stem>.key`
 * derivation. Generate mints the app-owned pair and persists its paths
 * without flipping the switch (minting-is-part-of-configuring). The warning
 * is the backend's own certificate classification — cert_status/cert_detail
 * name what failed and the fix; the UI never re-derives it.
 */

interface WebAccessTLSSettingsProps {
  /** The authoritative read the parent owns — the block never guesses. */
  info: WebAccessInfo
  /** The parent's setter: optimistic updates and post-write re-reads land in
   *  the same single source of truth every other block renders from. */
  onInfo: (info: WebAccessInfo | null) => void
}

export function WebAccessTLSSettings({ info, onInfo }: WebAccessTLSSettingsProps) {
  const [certDraft, setCertDraft] = useState(info.tlsCert ?? '')
  const [tlsBusy, setTlsBusy] = useState(false)
  const [certBusy, setCertBusy] = useState(false)
  const [tlsError, setTlsError] = useState<string | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  // Re-seed after every applied change: the re-read canonicalizes the shape.
  useEffect(() => {
    setCertDraft(info.tlsCert ?? '')
  }, [info.tlsCert])

  const reread = useCallback(async () => {
    // A failed re-read answers null and keeps the current display: blanking
    // the section (onInfo(null) unmounts this block) over one transient RPC
    // failure is worse than a possibly-stale value.
    const fresh = await getWebAccessInfo()
    if (fresh) onInfo(fresh)
  }, [onInfo])

  /** Toggle HTTPS: optimistic, then persist+apply through one RPC; the
   *  rejection (including "tls.cert is required when tls is enabled") rolls
   *  the switch back and surfaces the backend's message. */
  const handleToggle = useCallback(
    async (next: boolean) => {
      const previous = info
      onInfo({ ...info, tlsEnabled: next })
      setTlsError(null)
      setGenError(null)
      setTlsBusy(true)
      try {
        await setWebAccessTLS(next, info.tlsCert ?? '', info.tlsKey ?? '')
        await reread()
      } catch (err) {
        logger.error('Failed to toggle web access TLS:', err)
        onInfo(previous)
        setTlsError(err instanceof Error ? err.message : 'Failed to apply the TLS settings.')
      } finally {
        setTlsBusy(false)
      }
    },
    [info, onInfo, reread],
  )

  /** Commit the certificate path draft (Enter or focus loss): an unchanged
   *  value saves nothing; the persisted key path rides along so derivation
   *  only ever fills a genuinely empty key. */
  const commitCert = useCallback(async () => {
    if (certBusy || genBusy) return
    const cert = certDraft.trim()
    if (cert === (info.tlsCert ?? '')) {
      setTlsError(null)
      return
    }
    setCertBusy(true)
    setTlsError(null)
    try {
      await setWebAccessTLS(info.tlsEnabled, cert, info.tlsKey ?? '')
      await reread()
    } catch (err) {
      setTlsError(err instanceof Error ? err.message : 'Failed to apply the certificate path.')
    } finally {
      setCertBusy(false)
    }
  }, [info, certDraft, certBusy, genBusy, reread])

  /** Mint the app-owned pair: writes the files, persists their paths, never
   *  flips the switch, restarts a running sidecar onto the fresh material. */
  const handleGenerate = useCallback(async () => {
    setGenBusy(true)
    setGenError(null)
    try {
      await generateWebAccessCertificate()
      await reread()
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Failed to generate the certificate.')
    } finally {
      setGenBusy(false)
    }
  }, [reread])

  const commitOnEnter = (commit: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  }

  return (
    <div className="flex flex-col gap-1.5 pl-12" data-testid="web-access-tls-block">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Lock className="size-3" />
        HTTPS (TLS)
      </div>
      <Toggle
        checked={info.tlsEnabled}
        onChange={(next) => void handleToggle(next)}
        disabled={tlsBusy || genBusy}
        label={info.tlsEnabled ? 'HTTPS' : 'Plain HTTP'}
        description="Serve the browser session over TLS with a PEM certificate instead of plaintext. Enabling needs a certificate pair — Generate mints the app-owned one; the switch rolls back when the sidecar cannot start with the configured pair."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-testid="web-access-cert-input"
          type="text"
          value={certDraft}
          onChange={(e) => setCertDraft(e.target.value)}
          onKeyDown={commitOnEnter(() => void commitCert())}
          onBlur={() => void commitCert()}
          placeholder="~/.c0wrk/web-access.crt — empty until generated"
          aria-label="Certificate path (PEM; the key path is derived when empty; commits on Enter or focus loss)"
          title="Path to the PEM certificate; the private key is derived as <certificate>.key unless one is already configured. Commits on Enter or focus loss. Generate mints the app-owned self-signed pair for the pinned address."
          disabled={certBusy || genBusy || tlsBusy}
          className="h-7 w-80 text-xs"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          title="Generate a self-signed certificate pair for the pinned address"
          aria-label="Generate certificate"
          data-testid="web-access-cert-generate"
          disabled={genBusy || tlsBusy || certBusy}
          onClick={() => void handleGenerate()}
          className="flex items-center gap-1 rounded-xs border border-border px-2 py-1 text-xs opacity-80 transition-opacity hover:opacity-100 disabled:opacity-40"
        >
          {genBusy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="size-3.5" />
          )}
          Generate
        </button>
      </div>
      {tlsError !== null && (
        <p className="text-xs text-destructive" role="alert" data-testid="web-access-tls-error">
          {tlsError}
        </p>
      )}
      {genError !== null && (
        <p className="text-xs text-destructive" role="alert" data-testid="web-access-cert-error">
          {genError}
        </p>
      )}
      {info.certStatus !== '' && info.certStatus !== 'ok' && (
        <div
          className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/20 p-2 text-xs text-warning"
          data-testid="web-access-cert-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            {info.certDetail !== ''
              ? info.certDetail
              : `The certificate is not ready (${info.certStatus}) — regenerate it below.`}
          </span>
        </div>
      )}
    </div>
  )
}
