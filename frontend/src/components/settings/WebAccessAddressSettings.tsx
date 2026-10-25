import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Pin } from 'lucide-react'
import { getWebAccessInfo, parseWebAccessAddress, setWebAccessConnection, type WebAccessInfo } from '@/api/webAccess'
import { Input } from '@/components/ui/input'
import { useWebAccessCopyFlash } from './useWebAccessCopyFlash'

/**
 * Settings → Web Access — the address block (ADR-101): one URL-style field
 * that both displays the persisted URL (with its http:// prefix) and accepts
 * edits. "http://" is added when the operator omits it, the shape is
 * validated locally with a strict pattern and an invalid value never reaches
 * the backend. There is no apply button — the field commits like the UI
 * Scale control: on Enter or on focus loss; an unchanged value saves
 * nothing. The RPC persists AND hot-restarts the sidecar; the authoritative
 * state is re-read afterwards (which also re-seeds the draft into its
 * canonical shape). Owns the URL copy button (the copy-with-flash hook).
 */

interface WebAccessAddressSettingsProps {
  /** The authoritative read the parent owns — the block never guesses. */
  info: WebAccessInfo
  /** The parent's setter: post-write re-reads land here. */
  onInfo: (info: WebAccessInfo | null) => void
  /** ADR-102: fired after a successful transport change — a re-bind can move
   *  the exposure warning in or out of the loopback class, and the Settings
   *  banner must re-read the recomputed warnings. */
  onConfigChanged?: () => void
}

/** Renders the persisted (bind, port) pin as the full URL the single field
 *  displays and edits: the scheme follows the persisted TLS switch (ADR-102
 *  — what the field shows is the transport the sidecar will serve), plus the
 *  bind (an IPv6 bind bracketed) and the port only when pinned (0 = auto =
 *  omitted). Empty bind = the empty default draft. */
function formatWebAccessAddress(bind: string, port: number, tlsEnabled: boolean): string {
  if (bind === '') return ''
  const host = bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind
  const scheme = tlsEnabled ? 'https' : 'http'
  return port > 0 ? `${scheme}://${host}:${port}` : `${scheme}://${host}`
}

export function WebAccessAddressSettings({ info, onInfo, onConfigChanged }: WebAccessAddressSettingsProps) {
  // The draft mirrors the persisted state (an empty address = the 127.0.0.1 +
  // auto-port defaults); the error slot holds the local refusal OR the
  // backend's rejection — both block the save. The field never saves on
  // keystroke: it commits on Enter or focus loss, like the UI Scale control.
  const [addressDraft, setAddressDraft] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)
  const { copied, copy } = useWebAccessCopyFlash()

  // Seed the draft when the authoritative read lands and after every applied
  // change: the re-read canonicalizes the shape — including the URL scheme,
  // which follows the TLS switch.
  useEffect(() => {
    setAddressDraft(
      formatWebAccessAddress(info.configuredBind, info.configuredPort, info.tlsEnabled),
    )
  }, [info.configuredBind, info.configuredPort, info.tlsEnabled])

  /** Commit the draft (Enter or focus loss): the local pattern validates and
   *  parses it into (bind, port) — an invalid value is refused HERE, before
   *  any RPC. */
  const commitAddress = useCallback(async () => {
    if (pinBusy) return
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
      // ADR-102: a re-bind can move the exposure warning in or out of the
      // loopback class — the banner re-reads the recomputed warnings.
      onConfigChanged?.()
      const fresh = await getWebAccessInfo()
      if (fresh) onInfo(fresh)
    } catch (err) {
      setAddressError(err instanceof Error ? err.message : 'Failed to apply the address settings.')
    } finally {
      setPinBusy(false)
    }
  }, [addressDraft, pinBusy, info.configuredBind, info.configuredPort, onInfo, onConfigChanged])

  const commitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commitAddress()
    }
  }

  return (
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
          onKeyDown={commitOnEnter}
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
            onClick={() => void copy(info.url)}
            className="rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        )}
      </div>
      {addressError !== null && (
        <p className="text-xs text-destructive" role="alert" data-testid="web-access-address-error">
          {addressError}
        </p>
      )}
    </div>
  )
}
