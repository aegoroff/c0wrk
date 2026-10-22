import { create } from 'zustand'

// The pending workspace choice for a FRESH session (the draft-free creation
// flow, ADR-091). A CODE session is born local — the eager "New Session"
// creates the row immediately — and a branch picked in the chat toolbar's
// workspace selector is recorded HERE, per session, until the session's
// FIRST message consumes it: the send passes it to the backend
// (SendMessage's workspace argument), which provisions the managed worktree,
// persists the binding inside the fresh window (no transcript, no task) and
// lets the task start in the tree. A fresh session with no recorded choice
// simply sends as the local session it already is.
//
// The store is deliberately transient (never persisted): an un-sent choice
// has no durable meaning — the session row itself is local until the send —
// so an app restart starts fresh.

/**
 * The execution workspace a fresh session's first send will bind.
 *
 * - `local` — the project checkout (also the implicit default: an absent
 *   entry means local; the explicit entry behaves identically).
 * - `branch` — a managed worktree provisioned on `branch`. When
 *   `createBranch` is true the branch is CREATED at `startPoint` (empty =
 *   repository HEAD) by the send-time provisioning (git DWIM semantics — an
 *   existing branch is never re-created); a remote-tracking pick lands here
 *   (branch "x", startPoint "origin/x").
 */
export type PendingWorkspace =
  | { readonly kind: 'local' }
  | {
      readonly kind: 'branch'
      readonly branch: string
      readonly createBranch: boolean
      readonly startPoint: string
    }

// --- State types ---

interface SessionWorkspaceState {
  /** Per-fresh-session pending choice (sessionId → choice). */
  choices: Record<string, PendingWorkspace>
  /**
   * The fresh session whose choice is being consumed by an in-flight send
   * (the workspace argument is on the wire, provisioning may be running in
   * the backend). Drives the toolbar's "Preparing worktree…" hint; null
   * when no send is consuming a choice.
   */
  consumingFor: string | null
  /** Record/replace the fresh session's pending workspace choice. */
  setChoice: (sessionId: string, workspace: PendingWorkspace) => void
  /** Drop the choice (send consumed it, the user picked local again, …). */
  clearChoice: (sessionId: string) => void
  /**
   * Mark the named session's choice as being consumed by an in-flight send.
   * Refuses (returns false) when a consumption window is already open — one
   * window at a time, so a second concurrent send can never re-enter the
   * window while provisioning is running. The send-path early guard usually
   * filters those sends before the optimistic activation; this is the
   * authoritative backstop living next to the state it protects.
   */
  beginConsumption: (sessionId: string) => boolean
  /** Settle the consumption window (success OR failure — always called). */
  endConsumption: () => void
  /** Drop the slices of deleted sessions so the map stays bounded. */
  dropSessions: (ids: string[]) => void
}

// --- Store ---

export const useSessionWorkspaceStore = create<SessionWorkspaceState>((set) => ({
  choices: {},
  consumingFor: null,

  setChoice: (sessionId, workspace) =>
    set((s) => ({ choices: { ...s.choices, [sessionId]: workspace } })),

  clearChoice: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.choices)) return s
      const next = { ...s.choices }
      delete next[sessionId]
      return { choices: next }
    }),

  beginConsumption: (sessionId) => {
    let accepted = false
    set((s) => {
      if (s.consumingFor !== null) return s
      accepted = true
      return { consumingFor: sessionId }
    })
    return accepted
  },

  endConsumption: () => set({ consumingFor: null }),

  dropSessions: (ids) =>
    set((s) => {
      let changed = false
      const next = { ...s.choices }
      for (const id of ids) {
        if (id in next) {
          delete next[id]
          changed = true
        }
      }
      return changed ? { choices: next } : s
    }),
}))

/** Stable selector: the pending choice of one session (or undefined). */
export const selectPendingWorkspace = (
  s: SessionWorkspaceState,
  sessionId: string,
): PendingWorkspace | undefined => s.choices[sessionId]

/** The SendMessage wire shape of a workspace choice (backend
 *  SessionWorkspaceChoice JSON tags). */
export interface WorkspaceChoiceWire {
  branch: string
  create_branch: boolean
  start_point: string
}

/** Convert a pending choice into the SendMessage wire argument. A local
 *  choice (or no choice at all) sends null — the session is already local,
 *  and the backend treats a nil choice as a no-op. */
export function pendingWorkspaceToWire(
  workspace: PendingWorkspace | undefined,
): WorkspaceChoiceWire | null {
  if (workspace?.kind !== 'branch') return null
  return {
    branch: workspace.branch,
    create_branch: workspace.createBranch,
    start_point: workspace.startPoint,
  }
}
