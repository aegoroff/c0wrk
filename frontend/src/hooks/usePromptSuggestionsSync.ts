// Prompt-suggestions sync (ADR-088) — owns every refetch trigger of the
// promptSuggestionsStore. Mount once where the active session/project are
// known (the chat input surface):
//
//   1. session switch / project switch / session creation — the store's load
//      effect refires on either identity change (creating a session selects
//      it, so creation rides the same trigger);
//   2. NO active session in a real project — the session-less state the eager
//      creation flow still has (fresh app start, last session deleted): the
//      project's brand-new-session surface (ADR-088's next_task set) is
//      served by the backend's new_session branch and addressed with the
//      EMPTY session id;
//   3. the session-scoped `prompt_suggestions` event — the backend has just
//      persisted a fresh generation for this session.
//
// The event handler REFETCHES (GetPromptSuggestions) instead of applying the
// payload directly: the event carries the session's FULL active set (both
// kinds), while the RPC re-routes by the session's current content and
// returns exactly the kind the context serves — the backend stays the single
// authority on routing (see promptSuggestionsStore). The session-less surface
// subscribes to no event (there is no session to scope one to): a generation
// landing while no session is active shows on the next switch or creation.

import { useEffect } from 'react'
import { onSessionEvent, reportDroppedEvent } from '@/api/runtime'
import { isPromptSuggestionsData } from '@/types/events'
import { usePromptSuggestionsStore } from '@/stores/promptSuggestionsStore'
import { selectIsNoProject, useProjectStore } from '@/stores/projectStore'

export function usePromptSuggestionsSync(sessionId: string | null, projectId: string | null): void {
  // Refetch on session/project change. Without an active session there are
  // two cases: a REAL project with no active session (the eager flow's
  // session-less states — fresh app start, last session deleted) loads the
  // project's new-session surface under the empty session key ('' — the
  // store's session-less key, echoed verbatim by the backend's new_session
  // branch), and a No-Project (CHAT) window — null projectId or the
  // No-Project pseudo-project — resets to pristine (CHAT has no project
  // window to draw from).
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
  // active session (the session-less surface has none — see the header), and
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
