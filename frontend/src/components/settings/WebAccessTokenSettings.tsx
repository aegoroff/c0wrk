import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import {
  getWebAccessInfo,
  parseWebAccessToken,
  regenerateWebAccessToken,
  setWebAccessToken,
  type WebAccessInfo,
} from '@/api/webAccess'
import { Input } from '@/components/ui/input'
import { useWebAccessCopyFlash } from './useWebAccessCopyFlash'

/**
 * Settings → Web Access — the token block (ADR-101): a second field of the
 * address field's design, placed under it. It displays the live credential
 * (masked until revealed) and accepts an operator-typed value of 8–256
 * characters, committing the same way (Enter or focus loss); the empty field
 * always reverts (emptiness means GENERATED — it must never overwrite an
 * existing credential). Regenerate mints a fresh one instead. Every token
 * write travels its own RPC (SetWebAccessToken / RegenerateWebAccessToken)
 * and the backend serializes them under webAccessMu, so the UI-side drafts
 * can never interleave a persist+restart pair. The token writes cannot move
 * the config-load warnings and fire no onConfigChanged. Owns the
 * reveal / copy / regenerate buttons.
 */

interface WebAccessTokenSettingsProps {
  /** The authoritative read the parent owns — the block never guesses. */
  info: WebAccessInfo
  /** The parent's setter: post-write re-reads land here. */
  onInfo: (info: WebAccessInfo | null) => void
}

export function WebAccessTokenSettings({ info, onInfo }: WebAccessTokenSettingsProps) {
  const [revealed, setRevealed] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [regenBusy, setRegenBusy] = useState(false)
  const { copied, copy } = useWebAccessCopyFlash()

  // Seed the draft when the authoritative read lands and after every applied
  // change. A new credential ALSO invalidates any reveal: after a
  // start/restart/rotation the token on screen must never be a stale one
  // shown in the clear.
  useEffect(() => {
    setTokenDraft(info.token)
  }, [info.token])
  useEffect(() => {
    setRevealed(false)
  }, [info.token])

  /** Commit the draft (Enter or focus loss), mirroring the address field:
   *  local validation first (trimmed, 8–256 characters), an unchanged value
   *  saves nothing, and the empty draft always REVERTS. The RPC persists AND
   *  hot-restarts the sidecar; the authoritative state is re-read after. */
  const commitToken = useCallback(async () => {
    if (tokenBusy) return
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
      if (fresh) onInfo(fresh)
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to apply the token.')
    } finally {
      setTokenBusy(false)
    }
  }, [tokenDraft, tokenBusy, info.token, onInfo])

  /** Rotate the credential: mints, persists and hot-restarts — every open
   *  browser tab must sign in again with the token this section now shows. */
  const handleRegenerate = useCallback(async () => {
    setRegenBusy(true)
    setTokenError(null)
    try {
      await regenerateWebAccessToken()
      const fresh = await getWebAccessInfo()
      if (fresh) onInfo(fresh)
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to regenerate the token.')
    } finally {
      setRegenBusy(false)
    }
  }, [onInfo])

  const commitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commitToken()
    }
  }

  return (
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
          onKeyDown={commitOnEnter}
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
          onClick={() => void copy(info.token)}
          className="rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
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
          {regenBusy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </button>
      </div>
      {tokenError !== null && (
        <p className="text-xs text-destructive" role="alert" data-testid="web-access-token-error">
          {tokenError}
        </p>
      )}
    </div>
  )
}
