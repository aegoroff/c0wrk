// Fetch-on-focus: the window-focus trigger of the git auto-fetch feature.
//
// Mirrors VS Code's behaviour: whenever the app window regains focus, ask
// the backend to refresh the active project's remote-tracking refs. This
// hook is intentionally dumb — it contains NO gating logic. Every gate
// (the git.auto_fetch master switch, active CODE project vs CHAT/No
// Project, git work tree, configured remote, and the shared 60s
// min-interval across all auto-fetch triggers) lives in the backend
// (FrontendAPI.autoFetchOnce, see backend/frontend_api_git_autofetch.go),
// so the client and server can never disagree about whether a fetch is
// due. In particular, repeated focus events within the min-interval still
// send an RPC — the server silently skips the redundant fetch.
//
// Mount this hook ONCE at the app root (App.tsx). The focus listener arms
// through armWhenRuntimeReady — the shared readiness gate: on the desktop
// the Wails bridge is detected synchronously and the listener attaches at
// mount; a web-transport tab (ADR-099) attaches once the transport probe
// resolves 'web'; the transportless 'none' environment never arms, because
// before a serving transport exists the RPC is a guaranteed no-op and
// focus events during the splash phase would be dead weight. (`backend:ready`
// would NOT work as the arming signal: it is a desktop one-shot — emitted
// once at startup, desktop/startup.go, right before the sidecar mounts —
// and never replays, so a tab that joins later would stay disarmed
// forever.) Cleanup always removes the listener, so an unmounted host
// never fires refresh requests.

import { useEffect } from 'react'
import { requestRemoteRefresh } from '@/api/git'
import { armWhenRuntimeReady } from '@/lib/armWhenRuntimeReady'

export function useGitFocusRefresh(): void {
  useEffect(() => {
    const onFocus = (): void => {
      // Fire-and-forget: requestRemoteRefresh never rejects (errors are
      // swallowed inside the wrapper) and returns immediately — the fetch
      // itself runs in a backend goroutine.
      void requestRemoteRefresh()
    }

    return armWhenRuntimeReady(() => {
      window.addEventListener('focus', onFocus)
      return () => {
        window.removeEventListener('focus', onFocus)
      }
    })
  }, [])
}
