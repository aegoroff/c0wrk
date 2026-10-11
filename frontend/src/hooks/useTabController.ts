import { useEffect, useMemo } from 'react'
import { createTabEngine } from '@/lib/tabEngine'
import { useProjectSwitchState } from '@/hooks/useProjectSwitchState'

// React seam for the tab activation engine (lib/tabEngine).
//
// The hook owns ONE engine instance for its mount lifetime:
//   - `useProjectSwitchState()` is a stable useCallback, so the engine (and
//     its activation chain) is created once per mount and rapid re-renders
//     share the same serialization queue;
//   - the write-back subscriptions are mounted in an effect (no module-level
//     side effects): from the first commit the active tab mirrors the live
//     workspace, under any uiStore.tabsEnabled value — with the flag off
//     that single tab IS the workspace mirror;
//   - `activate` never rejects (the engine rolls failures back internally),
//     so tab-bar click handlers can fire and forget safely.

/** What the UI needs from the tab layer: the single activation entry points. */
export interface TabController {
  /**
   * Activate a tab by id. The promise never rejects — a failed project
   * switch rolls `activeTabId` back to the outgoing tab and is reported
   * through the logger.
   */
  activate: (tabId: string) => Promise<void>
  /**
   * Create a tab and materialize it through the engine as ONE chain link
   * (lib/tabEngine.createAndActivate). Seed-less — the fresh tab inherits
   * the LIVE workspace at the moment the chain link runs — so an in-flight
   * activation can never be overtaken by a half-created tab. The promise
   * never rejects.
   */
  createAndActivate: () => Promise<void>
  /**
   * Mirror the LIVE workspace context into the ACTIVE tab, right now.
   * The write-back subscriptions keep that invariant on every store change;
   * this is the explicit form for store-level transitions the subscriptions
   * cannot see — creating a tab flips `activeTabId` (a tabStore-only change),
   * so the fresh active tab must be converged by hand or it would sit with a
   * stale (default-empty) context until the next unrelated store event.
   */
  writeBack: () => void
}

export function useTabController(): TabController {
  const switchProjectWithState = useProjectSwitchState()

  const engine = useMemo(() => createTabEngine(switchProjectWithState), [switchProjectWithState])

  // attachWriteBack returns its own detach — perfect effect cleanup.
  useEffect(() => engine.attachWriteBack(), [engine])

  return useMemo(
    () => ({ activate: engine.activate, createAndActivate: engine.createAndActivate, writeBack: engine.writeBack }),
    [engine],
  )
}
