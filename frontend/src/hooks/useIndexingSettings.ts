import { useEffect } from 'react'
import { getConfig } from '@/api/config'
import { onGlobalEvent } from '@/api/runtime'
import { logger } from '@/lib/logger'
import { useIndexingSettingsStore } from '@/stores/indexingSettingsStore'

/**
 * Reads the indexing master switch (`vector_index.enabled`) from the shared
 * store and triggers the one-time fetch from GetConfig — the same hydration
 * shape as useExperimentalFeatures. The store is the single source of truth
 * after the initial load, and Settings updates it directly via setEnabled
 * after every successful UpdateIndexingSettings save.
 *
 * The fetch is attempted on mount and, if it fails (e.g. the backend is still
 * starting during the splash phase) or resolves with `loaded=false` (the
 * backend answers RPCs with a zeroed config until Startup finishes), again on
 * the `backend:ready` event and on `config:updated`, emitted by the backend
 * after every persisted config mutation (see
 * specs/contracts/event-catalog.md). That second retry covers the residual
 * case where both earlier attempts failed transiently. Once the switch has
 * latched, both retries are no-ops — Settings keeps the store in sync
 * directly.
 *
 * Unlike the experimental switch, the unknown state (`loaded=false`) keeps
 * `enabled` at its TRUE default — the backend's resolved default for a
 * config without the knob — so the index surfaces stay visible during the
 * startup race instead of flashing hidden, and only a definitively persisted
 * opt-out hides them.
 */
export function useIndexingSettings(): boolean {
  const enabled = useIndexingSettingsStore((s) => s.enabled)

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let pendingRetry = false

    const load = () => {
      if (useIndexingSettingsStore.getState().loaded) return
      if (inFlight) {
        // A retry (e.g. backend:ready) arrived while a fetch is in flight:
        // remember it and re-run after the current attempt settles, otherwise
        // the one-shot backend:ready emission is consumed with no effect.
        pendingRetry = true
        return
      }
      inFlight = true

      getConfig()
        .then((cfg) => {
          if (cancelled) return
          // Startup race: before the backend's Startup finishes, GetConfig
          // SUCCEEDS with loaded=false (config not yet initialized) and a
          // zeroed vector_index section. Latching that would flip the switch
          // for the whole session — keep the unknown state so the
          // backend:ready / config:updated retries re-fetch once the config
          // is live.
          if (cfg.loaded === false) return
          // Absence of the block (or the knob) is the resolved default:
          // indexing on — the historical always-on behavior.
          const indexingEnabled = cfg.vector_index?.enabled ?? true
          useIndexingSettingsStore.getState().setEnabled(indexingEnabled)
          useIndexingSettingsStore.getState().setLoaded(true)
        })
        .catch((err) => {
          // Keep the default (on) so the surfaces stay visible; `loaded`
          // stays false so a retry can still recover.
          logger.error('useIndexingSettings: failed to load config:', err)
        })
        .finally(() => {
          inFlight = false
          if (pendingRetry && !cancelled && !useIndexingSettingsStore.getState().loaded) {
            pendingRetry = false
            load()
          }
        })
    }

    load()
    const unsubscribes = [
      onGlobalEvent('backend:ready', load),
      onGlobalEvent('config:updated', load),
    ]

    return () => {
      cancelled = true
      unsubscribes.forEach((unsubscribe) => unsubscribe?.())
    }
  }, [])

  return enabled
}
