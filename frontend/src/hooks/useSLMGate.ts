import { useEffect } from 'react'
import { getConfig } from '@/api/config'
import { onGlobalEvent } from '@/api/runtime'
import { logger } from '@/lib/logger'
import { useSLMGateStore } from '@/stores/slmGateStore'

/**
 * Reads the Small-LLM gate from the shared store and triggers the one-time
 * fetch from GetConfig, mirroring `useExperimentalFeatures`. The store is the
 * single source of truth after the initial load.
 *
 * The fetch is attempted on mount and, if it fails (e.g. the backend is still
 * starting during the splash phase) or resolves with `loaded=false` (the
 * backend answers RPCs with a zeroed config until Startup finishes), again on
 * the `backend:ready` event — the same race App.tsx guards against — and on
 * `config:updated`, emitted by the backend after every persisted config
 * mutation (see specs/contracts/event-catalog.md). That second retry covers the
 * residual case where both earlier attempts failed transiently: the next
 * settings save re-reads the live config instead of leaving the gate "unknown"
 * until an app restart. Once the gate has latched, both retries are no-ops.
 *
 * Fail-safe: a fetch error leaves `loaded=false` so consumers see "unknown"
 * rather than "definitively off", and a retry can still recover. The backend
 * remains the authoritative enforcement point for the gate.
 *
 * @returns whether goal mode is currently blocked by the SLM profile (the
 *          reactive counterpart of `isGoalBlockedBySLM`).
 */
export function useSLMGate(): boolean {
  const enabled = useSLMGateStore((s) => s.enabled)
  const essentialToolsEnabled = useSLMGateStore((s) => s.essentialToolsEnabled)
  const loaded = useSLMGateStore((s) => s.loaded)

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let pendingRetry = false

    const load = () => {
      if (useSLMGateStore.getState().loaded) return
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
          // zeroed SLM section. Latching that zero would leave the gate
          // "definitively off" for the whole session and permanently consume
          // the one-shot backend:ready retry. Keep the unknown state so the
          // backend:ready / config:updated retries re-fetch once the config is
          // live.
          if (cfg.loaded === false) return
          // The `slm` block is optional on the wire (older payloads): a missing
          // block means "SLM off", which never blocks.
          useSLMGateStore.getState().setEnabled(cfg.slm?.enabled ?? false)
          useSLMGateStore
            .getState()
            .setEssentialToolsEnabled(cfg.slm?.essential_tools_enabled ?? false)
          useSLMGateStore.getState().setLoaded(true)
        })
        .catch((err) => {
          // Fail-safe: keep the default (not blocking) so goal mode stays
          // available. `loaded` stays false so consumers see "unknown" rather
          // than "definitively off", and a retry can still recover.
          logger.error('useSLMGate: failed to load config:', err)
        })
        .finally(() => {
          inFlight = false
          if (pendingRetry && !cancelled && !useSLMGateStore.getState().loaded) {
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

  return loaded && enabled && essentialToolsEnabled
}
