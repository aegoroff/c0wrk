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
 * Settings → Web Access — the HTTPS (TLS) block (ADR-092), in its own file so
 * the parent WebAccessSettings.tsx stays under the 200-line target; the
 * parent owns the single `info` state this block renders from. Write
 * discipline: optimistic with a rollback on rejection, authoritative state
 * re-read after every applied write. The cert and key paths are independent
 * self-committing fields (Enter or focus loss; unchanged saves nothing) —
 * each threads the other persisted path through (the backend loads the pair
 * as a unit and refuses a half-set one). Generate mints and persists the pair.
 */

interface WebAccessTLSSettingsProps {
  /** The authoritative read the parent owns — the block never guesses. */
  info: WebAccessInfo
  /** The parent's setter: optimistic updates and post-write re-reads land here. */
  onInfo: (info: WebAccessInfo | null) => void
  /** ADR-092: fired after a successful transport change — the backend has
   *  recomputed the section's config-load warnings, and the Settings banner
   *  must re-read them. The certificate Generate cannot move those warnings
   *  (paths only) and stays out. */
  onConfigChanged?: () => void
}

export function WebAccessTLSSettings({ info, onInfo, onConfigChanged }: WebAccessTLSSettingsProps) {
  const [certDraft, setCertDraft] = useState(info.tlsCert ?? '')
  const [keyDraft, setKeyDraft] = useState(info.tlsKey ?? '')
  const [tlsBusy, setTlsBusy] = useState(false)
  const [commitBusy, setCommitBusy] = useState(false)
  const [tlsError, setTlsError] = useState<string | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  // One writer lock: a commit never races a toggle, Generate, or the other field.
  const writeBusy = tlsBusy || genBusy || commitBusy

  // Re-seed after every applied change: the re-read canonicalizes the shape,
  // so Generate (and each commit) lands the persisted pair in both fields.
  useEffect(() => {
    setCertDraft(info.tlsCert ?? '')
    setKeyDraft(info.tlsKey ?? '')
  }, [info.tlsCert, info.tlsKey])

  const reread = useCallback(async () => {
    // A failed re-read answers null and keeps the current display: blanking
    // the section (onInfo(null)) over a transient RPC failure is worse.
    const fresh = await getWebAccessInfo()
    if (fresh) onInfo(fresh)
  }, [onInfo])

  /** Toggle HTTPS: optimistic, then persist+apply through one RPC; the
   *  rejection rolls the switch back and surfaces the backend's message. */
  const handleToggle = useCallback(
    async (next: boolean) => {
      const previous = info
      onInfo({ ...info, tlsEnabled: next })
      setTlsError(null)
      setGenError(null)
      setTlsBusy(true)
      try {
        await setWebAccessTLS(next, info.tlsCert ?? '', info.tlsKey ?? '')
        // ADR-092: the HTTPS flip is the transition that must move the
        // config-load-warning banner — the backend has recomputed it.
        onConfigChanged?.()
        await reread()
      } catch (err) {
        logger.error('Failed to toggle web access TLS:', err)
        onInfo(previous)
        setTlsError(err instanceof Error ? err.message : 'Failed to apply the TLS settings.')
      } finally {
        setTlsBusy(false)
      }
    },
    [info, onInfo, reread, onConfigChanged],
  )

  /** Commit one path draft (Enter or focus loss): an unchanged value saves
   *  nothing; the other persisted path rides along — the backend loads the
   *  pair as a unit and refuses a half-set one. */
  const commitPath = useCallback(
    async (field: 'cert' | 'key') => {
      if (writeBusy) return
      const cert = field === 'cert' ? certDraft.trim() : info.tlsCert ?? ''
      const key = field === 'key' ? keyDraft.trim() : info.tlsKey ?? ''
      if (cert === (info.tlsCert ?? '') && key === (info.tlsKey ?? '')) {
        setTlsError(null)
        return
      }
      setCommitBusy(true)
      setTlsError(null)
      try {
        await setWebAccessTLS(info.tlsEnabled, cert, key)
        // ADR-092: the backend recomputes the section's warnings after every
        // SetWebAccessTLS (the recompute is state-only and idempotent), so
        // the commit mirrors it even though a path change alone cannot move
        // the exposure warning.
        onConfigChanged?.()
        await reread()
      } catch (err) {
        setTlsError(err instanceof Error ? err.message : 'Failed to apply the TLS paths.')
      } finally {
        setCommitBusy(false)
      }
    },
    [writeBusy, certDraft, keyDraft, info, reread, onConfigChanged],
  )
  const commitCert = useCallback(() => commitPath('cert'), [commitPath])
  const commitKey = useCallback(() => commitPath('key'), [commitPath])

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
    if (e.key !== 'Enter') return
    e.preventDefault()
    commit()
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
        disabled={writeBusy}
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
          aria-label="Certificate path (PEM; commits on Enter or focus loss)"
          title="Path to the PEM certificate of the TLS pair. Commits on Enter or focus loss. Generate mints the app-owned self-signed pair for the pinned address."
          disabled={writeBusy}
          className="h-7 w-80 text-xs"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          title="Generate a self-signed certificate pair for the pinned address"
          aria-label="Generate certificate"
          data-testid="web-access-cert-generate"
          disabled={writeBusy}
          onClick={() => void handleGenerate()}
          className="flex items-center gap-1 rounded-xs border border-border px-2 py-1 text-xs opacity-80 transition-opacity hover:opacity-100 disabled:opacity-40"
        >
          {genBusy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          Generate
        </button>
      </div>
      <Input
        data-testid="web-access-key-input"
        type="text"
        value={keyDraft}
        onChange={(e) => setKeyDraft(e.target.value)}
        onKeyDown={commitOnEnter(() => void commitKey())}
        onBlur={() => void commitKey()}
        placeholder="~/.c0wrk/web-access.key — filled by Generate"
        aria-label="Private key path (PEM; commits on Enter or focus loss)"
        title="Path to the PEM private key of the TLS pair — the pair is loaded as a unit, so a half-set pair is refused. Commits on Enter or focus loss."
        disabled={writeBusy}
        className="h-7 w-80 text-xs"
        autoComplete="off"
        spellCheck={false}
      />
      {tlsError !== null && (
        <p className="text-xs text-destructive" role="alert" data-testid="web-access-tls-error">{tlsError}</p>
      )}
      {genError !== null && (
        <p className="text-xs text-destructive" role="alert" data-testid="web-access-cert-error">{genError}</p>
      )}
      {info.certStatus !== '' && info.certStatus !== 'ok' && (
        <div className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/20 p-2 text-xs text-warning" data-testid="web-access-cert-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{info.certDetail !== '' ? info.certDetail : `The certificate is not ready (${info.certStatus}) — regenerate it below.`}</span>
        </div>
      )}
    </div>
  )
}
