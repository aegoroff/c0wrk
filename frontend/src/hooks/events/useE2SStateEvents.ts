// E2S execution-state events: `e2s_state` is a dedicated session event (see
// useGoalEvents for the dedicated-event pattern) carrying the accumulated
// execution state Σₜ plus turn telemetry. One subscription, one cleanup.
//
// On switch-away the session's snapshot is DROPPED, not kept: the e2s_state
// stream is live-only (no persisted restore yet), so a stale Σ must not
// survive a switch away — otherwise switching back would render the
// pre-switch state as if it were current.

import { useEffect } from 'react'
import { onSessionEvent, reportDroppedEvent } from '@/api/runtime'
import { isE2SStateData } from '@/types/events'
import { handleE2SStateEvent } from './e2sHandlers'
import { useE2SStore } from '@/stores/e2sStore'

export function useE2SStateEvents(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return

    const unsubscribe = onSessionEvent(sessionId, 'e2s_state', (data) => {
      if (!isE2SStateData(data)) { reportDroppedEvent('e2s_state', data); return }
      handleE2SStateEvent(sessionId, data)
    })

    return () => {
      unsubscribe()
      // Clear the outgoing session's snapshot (cleanup on session switch;
      // deletion goes through useSessionActions → clearSession).
      useE2SStore.getState().clearSession(sessionId)
    }
  }, [sessionId])
}
