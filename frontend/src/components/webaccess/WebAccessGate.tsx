// Web-access login gate (ADR-090) — the SPA-side half of the sidecar's
// token↔cookie exchange. A fresh browser tab holds no session cookie, so
// every RPC would 401 and the events websocket would refuse the upgrade;
// instead of booting into that silent failure, the gate takes over the
// screen and asks for the per-launch token shown in Settings → Web Access
// in the desktop window. The spec's login step lives here:
// specs/domains/web-access.md ("the browser SPA asks the operator for the
// token; POST /api/login exchanges it for the session cookie").
//
// Transport rules:
//   - 'wails' / 'none' — the gate renders children untouched (a webview
//     session is authenticated by construction; a plain dev-server session
//     has no sidecar on its origin at all).
//   - 'web', probe says no session — the login form replaces the app.
//   - 'web', a mid-session RPC answers 401 (the desktop app restarted and
//     minted a new per-launch secret under an already-open tab) — the form
//     takes over live through onWebAuthRequired.
// A successful login sets the cookie and reloads the page, so every store,
// the transport probe and the websocket boot authenticated — no code path
// has to learn about "auth arrived late".

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { onWebAuthRequired, webAuthRequired } from '@/api/runtime'
import { webAccessLogin } from '@/api/webAccess'
import { reloadPage } from '@/lib/reload'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type GateState =
  /** Probe still in flight — render children (the app's splash) as today. */
  | 'checking'
  /** No gate needed: wails/none transport, or an authenticated web tab. */
  | 'open'
  /** Web transport without a session — show the token form. */
  | 'locked'

/** Render `children` except when the web transport demands a login. */
export function WebAccessGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking')

  useEffect(() => {
    let cancelled = false
    void webAuthRequired().then((required) => {
      if (!cancelled) setState(required ? 'locked' : 'open')
    })
    // A mid-session 401 (rotated per-launch token) locks the screen no
    // matter what the initial probe said.
    const unsubscribe = onWebAuthRequired(() => setState('locked'))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  if (state === 'locked') return <WebAccessLogin />
  return <>{children}</>
}

/** The token form. Full-screen, zoom-safe (percentage sizing only — the UI
 *  Scale applies CSS zoom on <html>, and viewport units would blow past the
 *  window), wired to the design tokens exclusively. */
function WebAccessLogin() {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      if (busy) return
      const trimmed = token.trim()
      if (trimmed === '') {
        setError('Enter the access token.')
        return
      }
      setBusy(true)
      setError(null)
      try {
        await webAccessLogin(trimmed)
        // The HttpOnly session cookie is set. A full reload boots the SPA
        // through the normal path — stores, probe and websocket all start
        // authenticated, and F5 keeps working (the cookie persists for the
        // desktop app's lifetime).
        reloadPage()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in failed.')
        setBusy(false)
      }
    },
    [busy, token],
  )

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-4">
      <form
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-background p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-foreground">c0wrk</h1>
        <p className="text-sm text-muted-foreground">
          This tab reaches the desktop app through its local browser bridge. Paste the access
          token from <span className="text-foreground">Settings → Web Access</span> in the
          desktop window.
        </p>
        <Input
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Access token"
          aria-label="Access token"
          autoComplete="off"
          disabled={busy}
        />
        {error !== null && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
