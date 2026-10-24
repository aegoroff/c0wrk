import { useEffect, useMemo, useState } from 'react'
import { useProjectStore, selectIsNoProject } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { getSessionWorkspace } from '@/api/workspace'

/**
 * Resolves the active workspace path. The path follows the active session's
 * own workspace when it carries one — a managed worktree of the active
 * project, or the per-session No Project workspace — and the project
 * workspace_path otherwise. Returns `null` while the path is unavailable.
 *
 * Rule: specs/domains/session-worktrees.md (User-facing workspace roots);
 * specs/decisions/095-chat-file-reference-path-semantics.md (Consequences).
 */
export function useWorkspacePath(): string | null {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)

  const isNoProject = useProjectStore(selectIsNoProject)

  // Project-level workspace path (correct for regular projects; for No
  // Project this is the empty placeholder directory).
  const activeProject = useMemo(
    () => projects?.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  )
  const projectWorkspacePath = activeProject?.workspace_path ?? null

  // A managed-worktree session of the active project owns the root: its own
  // tree, not the project checkout. The binding rides the sessions list; the
  // RPC below covers a row whose binding path has not landed yet.
  const { managedPath, managedAwaitingRpc } = useMemo(() => {
    if (!activeProject || activeProject.is_no_project || !activeSessionId) {
      return { managedPath: null, managedAwaitingRpc: false }
    }
    const session = sessions?.find((s) => s.id === activeSessionId) ?? null
    if (!session || session.project_id !== activeProjectId) {
      return { managedPath: null, managedAwaitingRpc: false }
    }
    const binding = session.workspace_binding
    if (binding?.kind !== 'managed_worktree') {
      return { managedPath: null, managedAwaitingRpc: false }
    }
    return binding.workspace_path
      ? { managedPath: binding.workspace_path, managedAwaitingRpc: false }
      : { managedPath: null, managedAwaitingRpc: true }
  }, [activeProject, activeProjectId, activeSessionId, sessions])

  // For No Project, each session has its own isolated workspace. Fetch it.
  const fetchSessionWorkspace = isNoProject || managedAwaitingRpc
  const [sessionWorkspacePath, setSessionWorkspacePath] = useState<string | null>(null)
  useEffect(() => {
    if (!fetchSessionWorkspace || !activeSessionId) {
      setSessionWorkspacePath(null)
      return
    }
    let cancelled = false
    getSessionWorkspace(activeSessionId)
      .then((wsPath) => { if (!cancelled) setSessionWorkspacePath(wsPath) })
      .catch(() => { /* keep previous value on error; fall back to project workspace */ })
    return () => { cancelled = true }
  }, [fetchSessionWorkspace, activeSessionId])

  return managedPath ?? (sessionWorkspacePath ?? projectWorkspacePath)
}
