// Prompt-suggestions sync (ADR-088) — owns every refetch trigger of the
// promptSuggestionsStore. Mount once where the active session/project are
// known (the chat input surface):
//
//   1. session switch / project switch / session creation — the store's load
//      effect refires on either identity change (creating a session selects
//      it, so creation rides the same trigger);
//   2. the session-scoped `prompt_suggestions` event — the backend has just
//      persisted a fresh generation for this session.
//
// The event handler REFETCHES (GetPromptSuggestions) instead of applying the
// payload directly: the event carries the session's FULL active set (both
// kinds), while the RPC re-routes by the session's current content and
// returns exactly the kind the context serves — the backend stays the single
// authority on routing (see promptSuggestionsStore).

import { useEffect } from 'react'
import { onSessionEvent, reportDroppedEvent } from '@/api/runtime'
import { isPromptSuggestionsData } from '@/types/events'
import { usePromptSuggestionsStore } from '@/stores/promptSuggestionsStore'

export function usePromptSuggestionsSync(sessionId: string | null, projectId: string | null): void {
  // Refetch on session/project change. Without an active session the store
  // resets to pristine (nothing to offer). A null projectId is the
  // No-Project/CHAT window and normalizes to '' — the backend's own sentinel
  // for "no project window".
  useEffect(() => {
    const store = usePromptSuggestionsStore.getState()
    if (!sessionId) {
      store.reset()
      return
    }
    void store.load(sessionId, projectId ?? '')
  }, [sessionId, projectId])

  // Refetch on the fresh-generation event. The subscription is scoped to the
  // active session, and load() publishes its (sessionId, projectId) context
  // synchronously before awaiting — so the store's remembered pair this
  // handler refetches through is always the pair the load effect above
  // installed for THIS session. An event for another session is a no-op by
  // construction (never subscribed).
  useEffect(() => {
    if (!sessionId) return
    const unsubscribe = onSessionEvent(sessionId, 'prompt_suggestions', (data) => {
      if (!isPromptSuggestionsData(data)) {
        reportDroppedEvent('prompt_suggestions', data)
        return
      }
      if (data.session_id !== sessionId) return
      void usePromptSuggestionsStore.getState().refetch()
    })
    return unsubscribe
  }, [sessionId])
}
