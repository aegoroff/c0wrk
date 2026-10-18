import { create } from 'zustand'
import type { PromptSuggestionRow } from '@/types/events'
import { getPromptSuggestions } from '@/api/suggestions'
import type { PromptSuggestionSource } from '@/api/suggestions'
import { logger } from '@/lib/logger'

// Prompt-suggestions store (ADR-088) — the proactive follow-up prompts the
// chat input offers for the ACTIVE session. Single-slot by design: only the
// active session's set is ever displayed, so the store holds one snapshot
// plus the identity (sessionId) it was loaded for. Every snapshot is fetched
// through GetPromptSuggestions and is therefore already routed and
// kind-filtered by the backend (continuation → the session's goal_advance
// set; new_session → the project's freshest next_task set; none → nothing) —
// this store never re-filters rows or re-routes contexts.
//
// Refetch triggers live in usePromptSuggestionsSync: session/project switch,
// session creation (both are activeSessionId changes), and the session-scoped
// `prompt_suggestions` event. The event itself carries the session's FULL
// active set, but the hook still refetches rather than applying it directly —
// GetPromptSuggestions re-routes by the session's CURRENT content, keeping
// the backend the single authority on which kind the context serves.

/** Stable empty set for selectors — never allocate inside a selector
 *  (React 19 useSyncExternalStore reference-stability contract). */
const EMPTY_SUGGESTIONS: readonly PromptSuggestionRow[] = Object.freeze([])

// --- State types ---

export interface PromptSuggestionsState {
  /** The session the current snapshot was loaded for (null = nothing loaded —
   *  no active session yet). Consumers MUST compare this against their session
   *  before rendering: a mid-switch snapshot may briefly lag the active id. */
  sessionId: string | null
  /** The project context the snapshot was loaded for ('' = No-Project/CHAT). */
  projectId: string
  /** The backend's routing decision for the snapshot; names the consulted
   *  context even when `suggestions` is empty. */
  source: PromptSuggestionSource
  /** The active set, backend-routed and kind-filtered. Reference changes only
   *  when a snapshot is applied. */
  suggestions: readonly PromptSuggestionRow[]
  /** ↑↓ selection into `suggestions`; -1 = nothing selected (raw input). */
  selectedIndex: number
  /** True while a load is in flight for the current session. */
  loading: boolean
}

interface PromptSuggestionsActions {
  /** Fetch the active set for a session (the single refetch entry). A switch
   *  to a different session clears the previous session's rows immediately —
   *  session A's suggestions must never render under session B. Responses are
   *  sequence-guarded: a stale in-flight response never overwrites a newer
   *  load. A failed/null response degrades to an empty set (fail-open). */
  load: (sessionId: string, projectId: string) => Promise<void>
  /** Re-run load for the store's current (sessionId, projectId) context —
   *  the `prompt_suggestions` event entry point. No-op without a session. */
  refetch: () => Promise<void>
  /** Select a row by index; clamped to [-1, suggestions.length - 1].
   *  -1 deselects (back to the raw input). Reference-stable no-op when the
   *  index is unchanged or out of a non-empty range's neighborhood. */
  setSelectedIndex: (index: number) => void
  /** Move the selection by delta (↑↓); clamped the same way. No-op on an
   *  empty set. */
  moveSelection: (delta: number) => void
  /** Deselect (back to -1) without touching the rows. */
  clearSelection: () => void
  /** Drop the snapshot entirely (no active session / chat teardown). */
  reset: () => void
}

/** Monotonic load token — increments on every `load`; only the latest
 *  response may apply. Lives on the closure, not the state (not a selector
 *  concern). */
let loadSeq = 0

// --- Store ---

export const usePromptSuggestionsStore = create<PromptSuggestionsState & PromptSuggestionsActions>((set, get) => ({
  sessionId: null,
  projectId: '',
  source: 'none',
  suggestions: EMPTY_SUGGESTIONS,
  selectedIndex: -1,
  loading: false,

  load: async (sessionId, projectId) => {
    const prev = get()
    const switching = prev.sessionId !== sessionId
    const seq = ++loadSeq
    if (switching) {
      // Immediate skeleton: never let the outgoing session's rows show under
      // the incoming one while the fetch is in flight.
      set({
        sessionId,
        projectId,
        source: 'none',
        suggestions: EMPTY_SUGGESTIONS,
        selectedIndex: -1,
        loading: true,
      })
    } else {
      // Same-session refetch: keep the current rows visible until the fresh
      // snapshot lands (a mid-navigation event refetch must not blank the
      // popup). Selection resets only when a snapshot is applied.
      set({ projectId, loading: true })
    }

    const resp = await getPromptSuggestions(sessionId, projectId)
    if (seq !== loadSeq) return // a newer load superseded this one
    if (resp === null || resp.session_id !== sessionId) {
      // Transport/validation failure (or the backend echoed another session):
      // fail-open WITHOUT blanking rows this session may already display — a
      // switching load is already showing the empty skeleton, while a
      // same-session refetch keeps its previous (same-session) rows until the
      // next success repairs them.
      if (resp !== null) {
        logger.warn('promptSuggestionsStore: response session mismatch, dropping', {
          requested: sessionId,
          returned: resp.session_id,
        })
      }
      set({ loading: false })
      return
    }
    set({
      source: resp.source,
      suggestions: resp.suggestions,
      selectedIndex: -1, // a fresh snapshot starts unselected
      loading: false,
    })
  },

  refetch: async () => {
    const { sessionId, projectId } = get()
    if (!sessionId) return
    await get().load(sessionId, projectId)
  },

  setSelectedIndex: (index) =>
    set((s) => {
      const max = s.suggestions.length - 1
      const clamped = Math.max(-1, Math.min(index, max))
      if (clamped === s.selectedIndex) return s
      return { selectedIndex: clamped }
    }),

  moveSelection: (delta) => {
    const s = get()
    if (s.suggestions.length === 0) return
    s.setSelectedIndex(s.selectedIndex + delta)
  },

  clearSelection: () =>
    set((s) => (s.selectedIndex === -1 ? s : { selectedIndex: -1 })),

  reset: () => {
    if (get().sessionId === null && get().suggestions.length === 0) {
      return // already pristine — keep the reference-stable no-op
    }
    set({
      sessionId: null,
      projectId: '',
      source: 'none',
      suggestions: EMPTY_SUGGESTIONS,
      selectedIndex: -1,
      loading: false,
    })
  },
}))

// --- Stable selectors (hooks) ---
//
// Each selector returns a PRIMITIVE or a DIRECT store reference (the rows
// array, a selected row object) — never a freshly allocated array/object.
// This honors the React 19 useSyncExternalStore stability contract; see
// AGENTS.md §2.7. The sessionId guard keeps a mid-switch snapshot from
// leaking into another session's input: consumers pass the session they
// render for and get the stable EMPTY set while the store still holds (or
// loads) a different session's rows.

/** The active set for `sessionId`, or the stable empty set when the store's
 *  snapshot belongs to a different (or no) session. */
export function usePromptSuggestions(sessionId: string | null): readonly PromptSuggestionRow[] {
  return usePromptSuggestionsStore((s) => (sessionId !== null && s.sessionId === sessionId ? s.suggestions : EMPTY_SUGGESTIONS))
}

/** The routing decision for `sessionId`'s snapshot ('none' when it belongs to
 *  another session or nothing is loaded). */
export function usePromptSuggestionsSource(sessionId: string | null): PromptSuggestionSource {
  return usePromptSuggestionsStore((s) => (sessionId !== null && s.sessionId === sessionId ? s.source : 'none'))
}

/** The ↑↓ selection index for `sessionId`'s set (-1 when it belongs to
 *  another session or nothing is loaded). */
export function usePromptSelectedIndex(sessionId: string | null): number {
  return usePromptSuggestionsStore((s) => (sessionId !== null && s.sessionId === sessionId ? s.selectedIndex : -1))
}

/** The currently selected row for `sessionId` (direct reference; undefined
 *  when nothing is selected or the snapshot belongs to another session). */
export function usePromptSelectedSuggestion(sessionId: string | null): PromptSuggestionRow | undefined {
  return usePromptSuggestionsStore((s) => {
    if (sessionId === null || s.sessionId !== sessionId) return undefined
    return s.suggestions[s.selectedIndex]
  })
}
