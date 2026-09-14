import { useEffect } from 'react'
import { getConfig } from '@/api/config'
import { onGlobalEvent } from '@/api/runtime'
import { logger } from '@/lib/logger'
import { isGoalBlockedBySLM } from '@/lib/goalGate'
import { useSLMGateStore } from '@/stores/slmGateStore'

/**
 * Reads the Small-LLM gate from the shared store and keeps it in sync with the
 * backend's resolved config. Unlike `useExperimentalFeatures` — whose Settings
 * writes the store directly — this store has NO direct writer, so the backend
 * events are the only way a runtime config change reaches it.
 *
 * The fetch runs on mount and on two global events:
 *   - `backend:ready` — a RETRY-ONLY trigger. It re-attempts the mount fetch
 *     when that attempt failed or resolved with `loaded=false` (the backend
 *     answers RPCs with a zeroed config until Startup finishes — the same race
 *     App.tsx guards against). Once the gate has latched it is a no-op.
 *   - `config:updated` — a REFRESH trigger, emitted by the backend after every
 *     persisted config mutation (see specs/contracts/event-catalog.md). It
 *     IGNORES the latch and overwrites the store with the freshly resolved
 *     values, so a change the user just made in Settings — e.g. following the
 *     block hint to disable the profile or the Essential Tools variant — takes
 *     effect without an app restart. When the response still reports
 *     `loaded=false` (mid-startup) it leaves the store untouched rather than
 *     downgrading an existing good latch.
 *
 * Fail-safe: on a fetch error the store is left as it was — `loaded=false` on
 * the initial load, so consumers see "unknown" rather than "definitively off",
 * and a retry can still recover. The backend remains the authoritative
 * enforcement point for the gate.
 *
 * @returns whether goal mode is currently blocked by the SLM profile.
 */
export function useSLMGate(): boolean {
  // Subscribe to every field the gate reads so a fetch/refresh that writes the
  // store re-renders this component. The returned value is delegated to
  // `isGoalBlockedBySLM` — the single definition of the composition in
  // `lib/goalGate` — which reads the same store synchronously; these
  // subscriptions are what make that read reactive.
  useSLMGateStore((s) => s.enabled)
  useSLMGateStore((s) => s.essentialToolsEnabled)
  useSLMGateStore((s) => s.loaded)

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    // A refresh (config:updated) or a retry (mount/backend:ready) that arrives
    // while a fetch is in flight is remembered and replayed once the current
    // attempt settles, otherwise a one-shot event is consumed with no effect.
    // A pending refresh always wins: it re-fetches unconditionally, while a
    // pending retry only re-fetches while the gate is still unlatched.
    let pendingRetry = false
    let pendingRefresh = false

    const fetchGate = (refresh: boolean) => {
      // Retry-only triggers skip a store that has already latched; a refresh
      // deliberately ignores the latch so a config change can overwrite it.
      if (!refresh && useSLMGateStore.getState().loaded) return
      if (inFlight) {
        if (refresh) pendingRefresh = true
        else pendingRetry = true
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
          // backend:ready / config:updated triggers re-fetch once the config is
          // live. On a refresh this also protects an existing good latch from
          // being downgraded by a stale mid-startup answer.
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
          // Fail-safe: keep the store as it was (not blocking on the initial
          // load) so goal mode stays available. `loaded` stays false so
          // consumers see "unknown" rather than "definitively off", and a retry
          // can still recover.
          logger.error('useSLMGate: failed to load config:', err)
        })
        .finally(() => {
          inFlight = false
          if (cancelled) return
          if (pendingRefresh) {
            pendingRefresh = false
            pendingRetry = false
            fetchGate(true)
          } else if (pendingRetry && !useSLMGateStore.getState().loaded) {
            pendingRetry = false
            fetchGate(false)
          }
        })
    }

    fetchGate(false)
    const unsubscribes = [
      onGlobalEvent('backend:ready', () => fetchGate(false)),
      onGlobalEvent('config:updated', () => fetchGate(true)),
    ]

    return () => {
      cancelled = true
      unsubscribes.forEach((unsubscribe) => unsubscribe?.())
    }
  }, [])

  return isGoalBlockedBySLM()
}
