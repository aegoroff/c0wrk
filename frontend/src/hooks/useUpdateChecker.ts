// Subscribes to the global self-update events and reflects them into
// updateStore, and loads the running build version on mount.
//
// Mount this hook once at the app root (App.tsx) so the subscriptions are
// active for the whole session. All five update events are wired: the typed
// helpers in @/api/updater validate each payload before invoking the callback,
// so malformed emissions are dropped rather than corrupting the store.
//
// NOTE: this hook NO LONGER performs an automatic check on mount. The
// automatic background check is the sole responsibility of the Go backend
// (FrontendAPI.RunBackgroundUpdateCheck), which honours the operator master
// gate (config.yaml updates.enabled) and the auto-check preference
// (config.yaml updates.auto_check), respects the check interval, and caches
// the result so a discovered update is immediately downloadable. The frontend
// only needs to listen for the resulting update:available event (wired below)
// and surface the running version. A user can still trigger a manual check
// from the Settings panel.

import { useEffect } from 'react'
import {
  onUpdateAvailable,
  onUpdateNone,
  onUpdateProgress,
  onUpdateDownloaded,
  onUpdateError,
  getUpdateSettings,
  getLastUpdateCheck,
} from '@/api/updater'
import { subscribe } from '@/api/runtime'
import { useUpdateStore } from '@/stores/updateStore'
import { logger } from '@/lib/logger'

export function useUpdateChecker(): void {
  // ── Load running version + recover a startup update:available ─────────
  // The running version is always loaded so the Settings panel and the toast
  // can show "you're on vX.Y.Z" regardless of whether an update is available.
  // The load is attempted on mount and, if it fails (e.g. the backend is still
  // starting), retried on `backend:ready` — mirroring useExperimentalFeatures —
  // so a transient startup race doesn't leave the version label empty for the
  // whole session.
  //
  // The same load path also pulls GetLastUpdateCheck: the backend's startup
  // auto-check emits update:available ~1s after backend readiness, which can
  // race this hook's event subscription — the event (and the update toast)
  // would be silently lost. The backend caches the check result, so a pull
  // after mount (and after backend:ready) recovers it regardless of event
  // delivery timing.
  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let pendingRetry = false

    const load = () => {
      if (useUpdateStore.getState().currentVersion !== '') return
      if (inFlight) {
        // A retry (e.g. backend:ready) arrived while a fetch is in flight:
        // remember it and re-run after the current attempt settles.
        pendingRetry = true
        return
      }
      inFlight = true
      getUpdateSettings()
        .then((settings) => {
          if (cancelled) return
          useUpdateStore.getState().setCurrentVersion(settings.current_version)
        })
        .catch((err) => {
          // Settings unavailable (e.g. backend not ready yet) — non-fatal; the
          // Settings button still lets the user check manually.
          logger.warn('Could not load update settings:', err)
        })
        .finally(() => {
          inFlight = false
          if (pendingRetry && !cancelled && useUpdateStore.getState().currentVersion === '') {
            pendingRetry = false
            load()
          }
        })
    }

    load()
    const unsubscribe = subscribe('backend:ready', load)

    // ── Pull the cached startup check result ────────────────────────────
    // Independent of the version load (which may lag behind backend
    // readiness): the update toast must surface even while the version label
    // is still empty. A failure here is non-fatal — the manual check from the
    // Settings panel still works.
    const recoverStartupCheck = () => {
      getLastUpdateCheck()
        .then((info) => {
          if (cancelled || !info) return
          const { phase } = useUpdateStore.getState()
          if (phase === 'downloading' || phase === 'downloaded') return
          useUpdateStore.getState().onAvailable(info)
        })
        .catch(() => {
          // Backend not ready yet or RPC failed — the backend:ready retry of
          // the version load above covers the "not ready" case; a persistent
          // failure is visible through a manual check.
        })
    }
    recoverStartupCheck()
    const unsubscribeReady = subscribe('backend:ready', recoverStartupCheck)

    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribeReady?.()
    }
  }, [])

  // ── Wire the five global update events into the store ─────────────────
  useEffect(() => {
    const offAvailable = onUpdateAvailable((data) => {
      useUpdateStore.getState().onAvailable(data)
    })
    const offNone = onUpdateNone(() => {
      useUpdateStore.getState().onNone()
    })
    const offProgress = onUpdateProgress((data) => {
      useUpdateStore.getState().onProgress(data.done, data.total)
    })
    const offDownloaded = onUpdateDownloaded(() => {
      useUpdateStore.getState().onDownloaded()
    })
    const offError = onUpdateError((data) => {
      useUpdateStore.getState().onError(data.message)
    })
    return () => {
      offAvailable()
      offNone()
      offProgress()
      offDownloaded()
      offError()
    }
  }, [])
}
