// Prompt-suggestions sync (ADR-088) — owns every refetch trigger of the
// promptSuggestionsStore. Mount once where the active session/project are
// known (the chat input surface):
//
//   1. session switch / project switch / session creation — the store's load
//      effect refires on either identity change (creating a session selects
//      it, so creation rides the same trigger);
//   2. the ARMED New-Session draft of a real project (ADR-080: the gesture
//      clears the selection without creating a row) — the draft is the
//      brand-new-session surface ADR-088 serves the project's freshest
//      next_task set from; it is addressed with the EMPTY session id, which
//      routes GetPromptSuggestions straight into the new_session branch;
//   3. the session-scoped `prompt_suggestions` event — the backend has just
//      persisted a fresh generation for this session.
//
// The event handler REFETCHES (GetPromptSuggestions) instead of applying the
// payload directly: the event carries the session's FULL active set (both
// kinds), while the RPC re-routes by the session's current content and
// returns exactly the kind the context serves — the backend stays the single
// authority on routing (see promptSuggestionsStore). The draft surface
// subscribes to no event (there is no session to scope one to): a generation
// landing while the draft is armed shows on the next switch or re-arming.

import { useEffect } from 'react'
import { onSessionEvent, reportDroppedEvent } from '@/api/runtime'
import { isPromptSuggestionsData } from '@/types/events'
import { usePromptSuggestionsStore } from '@/stores/promptSuggestionsStore'
import { selectIsNoProject, useProjectStore } from '@/stores/projectStore'

export function usePromptSuggestionsSync(sessionId: string | null, projectId: string | null): void {
  // Refetch on session/project change. Without an active session there are
  // two cases: a REAL project's armed New-Session draft loads the project
  // surface under the empty session key ('' — the store's draft-surface
  // key, echoed verbatim by the backend's new_session branch), and a
  // No-Project (CHAT) window — null projectId or the No-Project
  // pseudo-project — resets to pristine (CHAT has no project window to draw
  // from).
  useEffect(() => {
    const store = usePromptSuggestionsStore.getState()
    const projectID = projectId ?? ''
    if (!sessionId) {
      if (projectID === '' || selectIsNoProject(useProjectStore.getState())) {
        store.reset()
        return
      }
      void store.load('', projectID)
      return
    }
    void store.load(sessionId, projectID)
  }, [sessionId, projectId])

  // Refetch on the fresh-generation event. The subscription is scoped to the
  // active session (the draft surface has none — see the header), and
  // load() publishes its (sessionId, projectId) context synchronously before
  // awaiting — so the store's remembered pair this handler refetches through
  // is always the pair the load effect above installed for THIS session. An
  // event for another session is a no-op by construction (never subscribed).
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
