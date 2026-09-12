// Shared E2S event handler — writes an `e2s_state` snapshot into the e2s
// store. Kept separate from the hook (mirroring goalHandlers.ts) so future
// consumers (e.g. a background-session watcher) can feed the store from any
// subscription site without re-implementing the guard→store path.

import { useE2SStore } from '@/stores/e2sStore'
import type { E2SStateData } from '@/types/events'

/** Apply an e2s_state snapshot (full or patch) to a session's store entry. */
export function handleE2SStateEvent(sessionId: string, data: E2SStateData): void {
  useE2SStore.getState().applySnapshot(sessionId, data)
}
