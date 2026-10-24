// Side-effect-only hook that moves the Git panel's focus target
// automatically: on every active-project or active-session change it
// re-applies the session-default focus (the active session's execution
// workspace — the managed tree of a managed session, the checkout for a
// local session) on the backend and refreshes the mirrored focus/worktree
// state. The same apply also fires when the ACTIVE session's
// workspace_binding TRANSITIONS (absent/local → managed_worktree): the
// binding is mirrored into the session store only after the fact (the
// sessions refresh after a workspace-carrying send), so without the binding
// key in the dependency list the panel would keep the pre-bind focus target
// until the next unrelated switch. A duplicate delivery, another session's
// transition, or a last_active_at-only update must NOT re-apply — the key
// is a PRIMITIVE (`${kind}:${workspace_path}`) derived in useMemo, so fresh
// binding object allocations with equal content compare equal.
// Mounted exactly once at the App root (beside
// useVectorIndexStatus) — the Git panel exists only while the workspace's
// git tab is active, so a panel-level mount would miss chat-area session
// switches — and the effect never races a second copy of itself.

import { useEffect, useMemo } from 'react'
import { clearGitFocusState, focusSessionWorkspace } from '@/lib/gitFocus'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'

export function useGitFocusSync(): void {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)

  // The active session's binding as a primitive key (stable-selector rule:
  // derived in useMemo over store references, never allocated inside a
  // Zustand selector). Empty string = no session / no binding yet (the
  // backend default target); the shape matches the binding's identity that
  // moves the focus target — kind + workspace_path (worktree_name/branch
  // are decorations, not targets).
  const activeBindingKey = useMemo(() => {
    const binding = activeSessionId === null
      ? undefined
      : sessions?.find((sess) => sess.id === activeSessionId)?.workspace_binding
    return binding ? `${binding.kind}:${binding.workspace_path}` : ''
  }, [sessions, activeSessionId])

  useEffect(() => {
    if (!activeProjectId) {
      // CHAT / No Project: no git panel target exists at all.
      clearGitFocusState()
      return
    }
    // Both switches move the focus: a project switch resets the backend's
    // relevant tree universe, a session switch changes the default target.
    // The apply is serialized + supersede-guarded inside focusSessionWorkspace,
    // so unmount/switch races cannot land an older target last.
    void focusSessionWorkspace()
    // activeSessionId / activeBindingKey are trigger-only deps: the apply
    // reads the live state from the stores itself, but a session switch
    // (even with an equal binding key) and a binding transition of the
    // active session must both re-apply.
  }, [activeProjectId, activeSessionId, activeBindingKey])
}
