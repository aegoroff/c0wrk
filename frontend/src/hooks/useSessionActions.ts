// Shared session CRUD + rename logic for sidebar session lists.
//
// Both the dropdown SessionSelector (CODE mode) and the flat SessionList
// (CHAT mode) need the same operations: create / delete / archive / pin /
// fork / rename. Extracting them here keeps a single source of truth and
// avoids duplicating the API wiring and error handling.
//
// Rename is stateful: callers render the rename input themselves (the
// dropdown replaces itself with an input; the flat list renders the input
// inline in the row). This hook owns only the state + async commit.
//
// Archive/delete are gated on confirmation for busy sessions: a session with
// a running, paused, unfinished (resumable), or HITL-blocked ('pending') task
// has its task cancelled by the backend first, which is destructive to the
// resumable state, so we ask first.

import { useState, useRef, useCallback } from 'react'
import type { RefObject } from 'react'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore, selectIsNoProject } from '@/stores/projectStore'
import { useSessionWorkspaceStore } from '@/stores/sessionWorkspaceStore'
import { useChatStore } from '@/stores/chatStore'
import { useTerminalRegistryStore } from '@/stores/terminalRegistryStore'
import { useChatInputStore } from '@/stores/chatInputStore'
import { useAttachmentsStore } from '@/stores/attachmentsStore'
import { useBookmarkStore } from '@/stores/bookmarkStore'
import { useE2SStore } from '@/stores/e2sStore'
import { isSessionBusy } from '@/hooks/useSessionStatusIndicator'
import {
  createSession,
  renameSession,
  archiveSession,
  deleteSession,
  forkSession,
  pinSession,
} from '@/api/sessions'
import { logger } from '@/lib/logger'

/** A destructive action held for user confirmation before execution. */
export interface PendingSessionAction {
  kind: 'archive' | 'delete'
  sessionId: string
  sessionName: string
  /** Current archived state — only meaningful for 'archive' (false = archiving). */
  isArchived: boolean
  /**
   * Group targeting (branch-group actions): when set, confirmation applies the
   * operation to EVERY id here; `sessionName` is the group label — the branch
   * name — and `sessionId` is just the first member (kept for compatibility).
   */
  sessionIds?: string[]
}

export interface SessionActions {
  /** Last session-creation error, surfaced inline in the list header. */
  createError: string | null
  clearCreateError: () => void
  /** Id of the session currently being renamed, or null. */
  renamingId: string | null
  renameValue: string
  setRenameValue: (value: string) => void
  /** Ref to attach to whichever rename input is currently mounted. */
  renameRef: RefObject<HTMLInputElement | null>
  startRename: (id: string, currentName: string) => void
  commitRename: () => Promise<void>
  cancelRename: () => void
  handleNewSession: () => Promise<void>
  /**
   * Arm a New-Session draft pinned to an existing managed branch (the
   * session selector's grouped view offers this per branch row). No-op
   * outside CODE projects.
   */
  handleNewSessionOnBranch: (branch: string) => void
  handleDelete: (id: string) => Promise<void>
  handleArchive: (id: string, isArchived: boolean) => Promise<void>
  handlePin: (id: string, isPinned: boolean) => Promise<void>
  handleFork: (id: string) => Promise<void>
  /**
   * Archive every member of a branch group; arms confirmation whenever the
   * group holds more than one member (one click would archive N sessions) or
   * the lone member is busy.
   */
  handleArchiveGroup: (branch: string, ids: string[]) => Promise<void>
  /** Restore (unarchive) every member of an ARCHIVED branch group — non-destructive, never asks. */
  handleUnarchiveGroup: (branch: string, ids: string[]) => Promise<void>
  /** Delete every member of a branch group; always asks first. */
  handleDeleteGroup: (branch: string, ids: string[]) => Promise<void>
  /** Pending destructive action awaiting confirmation, or null. */
  pendingAction: PendingSessionAction | null
  /** Execute the pending action (user confirmed). */
  confirmPendingAction: () => Promise<void>
  /** Dismiss the pending action (user cancelled). */
  cancelPendingAction: () => void
}

export function useSessionActions(): SessionActions {
  const addSession = useSessionStore((s) => s.addSession)
  const removeSession = useSessionStore((s) => s.removeSession)
  const updateSession = useSessionStore((s) => s.updateSession)
  const selectSession = useSessionStore((s) => s.selectSession)

  const [createError, setCreateError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [pendingAction, setPendingAction] = useState<PendingSessionAction | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  const handleNewSession = useCallback(async () => {
    setCreateError(null)
    // The draft-free creation flow (ADR-091): EVERY "New Session" eagerly
    // creates the session row — a CODE session is born LOCAL (the project
    // checkout), exactly like a CHAT (No Project) session, and is fast
    // because nothing is provisioned. A worktree session is born at the
    // session's FIRST send: pick the branch in the chat toolbar's workspace
    // selector (or via the per-branch gesture below) and the choice rides
    // on the first message (SendMessage's workspace argument). There is no
    // draft state: the session always exists from the gesture onward.
    try {
      const session = await createSession()
      addSession(session)
      // A brand-new session is born with a CONFIRMED-EMPTY transcript: the
      // workspace selector's freshness contract needs the index to exist from
      // birth — an absent index reads as "history not loaded" and keeps the
      // picker locked behind the permanent pin until the history loader
      // settles. The ChatArea's unconditional empty merge covers this too;
      // seeding here closes that birth window (ADR-091).
      useChatStore.getState().ensureEmptyTranscript(session.id)
      // A newly created session becomes the visible active one — an explicit
      // activation, so persist it as the project's saved session right away
      // (otherwise an app restart would restore a different session).
      selectSession(session.id, session.project_id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to create session:', error)
      setCreateError(message)
    }
  }, [addSession, selectSession])

  /**
   * "New session on branch X" (the session selector's grouped view offers
   * this per branch row). The same eager creation as {@link handleNewSession}
   * — the row is born immediately (local) — plus the fresh session's PENDING
   * workspace choice preset to the branch: the first send then provisions
   * the managed worktree (or ADOPTS the branch's existing managed tree,
   * ADR-082) and the session executes there. Outside a CODE project the
   * gesture has no meaning (no worktrees) and is a deliberate no-op.
   */
  const handleNewSessionOnBranch = useCallback(
    (branch: string) => {
      setCreateError(null)
      const projectState = useProjectStore.getState()
      const projectId = projectState.activeProjectId
      if (projectId === null || selectIsNoProject(projectState)) return
      void (async () => {
        try {
          const session = await createSession()
          addSession(session)
          // Seed the confirmed-empty index synchronously so the picker is
          // ARMED from birth: an absent index reads as "history not loaded",
          // which renders the permanent pin instead of the picker and hides
          // the preset choice below until the history loader settles
          // (ADR-091). The preset itself lives in sessionWorkspaceStore and
          // is only dropped on proof that the fresh window closed.
          useChatStore.getState().ensureEmptyTranscript(session.id)
          selectSession(session.id, session.project_id)
          // Preset the fresh window's pending choice: the FIRST send to this
          // session provisions (or adopts) the tree on `branch`.
          useSessionWorkspaceStore
            .getState()
            .setChoice(session.id, { kind: 'branch', branch, createBranch: false, startPoint: '' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.error('Failed to create session on branch:', error)
          setCreateError(message)
        }
      })()
    },
    [addSession, selectSession],
  )

  const performDelete = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id)
        removeSession(id)
        // The backend stopped this session's terminal PTY in DeleteSession;
        // drop its (now-dead) instance from the app-lifetime registry.
        useTerminalRegistryStore.getState().removeInstances([id])
        // Drop the deleted session's chat-input slice (draft, optimize flag,
        // optimize error) so the per-session map stays bounded.
        useChatInputStore.getState().dropSessions([id])
        // Drop its pending-attachment slice + transient image-error banner
        // for the same reason (namesById stays — committed names remain
        // resolvable for tool cards).
        useAttachmentsStore.getState().dropSessions([id])
        // Drop the deleted session's bookmarks so the per-session map stays
        // bounded (the backend already cascade-deleted them from the DB).
        useBookmarkStore.getState().clearSession(id)
        // Drop its E2S execution-state snapshot (live-only stream — a deleted
        // session never re-emits e2s_state, so the entry would go stale).
        useE2SStore.getState().clearSession(id)
        // Drop its saved chat scroll position — the session is gone, and the
        // entry would otherwise keep the per-session map growing.
        useChatStore.getState().clearScrollPosition(id)
        // Drop its pending workspace choice (a fresh session deleted before
        // its first send) — the per-session map stays bounded.
        useSessionWorkspaceStore.getState().dropSessions([id])
        // Drop its step context fill + per-step token totals for the same
        // reason — one action clears both session-keyed maps (a deleted
        // session never re-emits context_fill, so the entries would go stale).
        useChatStore.getState().clearStepContextFill(id)
      } catch (error) {
        logger.error('Failed to delete session:', error)
      }
    },
    [removeSession],
  )

  const performArchive = useCallback(
    async (id: string, isArchived: boolean) => {
      try {
        await archiveSession(id)
        updateSession(id, { archived: !isArchived })
      } catch (error) {
        logger.error('Failed to archive session:', error)
      }
    },
    [updateSession],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      // Deleting a busy session cancels its task first (destructive to any
      // resumable state), so ask for confirmation before proceeding.
      if (isSessionBusy(id)) {
        const name = useSessionStore.getState().sessions?.find((s) => s.id === id)?.name ?? id
        setPendingAction({ kind: 'delete', sessionId: id, sessionName: name, isArchived: false })
        return
      }
      await performDelete(id)
    },
    [performDelete],
  )

  const handleArchive = useCallback(
    async (id: string, isArchived: boolean) => {
      // Only archiving (not unarchiving) can cancel a running/unfinished task.
      if (!isArchived && isSessionBusy(id)) {
        const name = useSessionStore.getState().sessions?.find((s) => s.id === id)?.name ?? id
        setPendingAction({ kind: 'archive', sessionId: id, sessionName: name, isArchived })
        return
      }
      await performArchive(id, isArchived)
    },
    [performArchive],
  )

  const handlePin = useCallback(
    async (id: string, isPinned: boolean) => {
      try {
        await pinSession(id)
        updateSession(id, { pinned: !isPinned })
      } catch (error) {
        logger.error('Failed to pin session:', error)
      }
    },
    [updateSession],
  )

  const handleArchiveGroup = useCallback(
    async (branch: string, ids: string[]) => {
      // Branch groups only ever hold non-archived sessions (archived ones land
      // in the separate Archived bucket), so a group action always archives.
      // Archiving cancels any running/unfinished task per member — confirm
      // whenever the blast radius exceeds one session (a multi-member group
      // archives N sessions in one click, busy or not) and, for a lone
      // member, when it is busy (the same guard as the per-row action).
      if (ids.length > 1 || ids.some((id) => isSessionBusy(id))) {
        setPendingAction({ kind: 'archive', sessionId: ids[0] ?? '', sessionName: branch, isArchived: false, sessionIds: ids })
        return
      }
      for (const id of ids) await performArchive(id, false)
    },
    [performArchive],
  )

  const handleUnarchiveGroup = useCallback(
    async (_branch: string, ids: string[]) => {
      // Restoring is non-destructive (nothing is cancelled), so it never asks.
      // Each perform* catches its own error, so one failure never breaks the loop.
      for (const id of ids) await performArchive(id, true)
    },
    [performArchive],
  )

  const handleDeleteGroup = useCallback(
    async (branch: string, ids: string[]) => {
      // Deleting always cancels tasks and destroys sessions — always ask,
      // regardless of busy state; the pending action targets the whole group.
      setPendingAction({ kind: 'delete', sessionId: ids[0] ?? '', sessionName: branch, isArchived: false, sessionIds: ids })
    },
    [],
  )

  const handleFork = useCallback(
    async (id: string) => {
      try {
        const forked = await forkSession(id)
        addSession(forked)
        // Forking activates the fork — persist it as the saved session (same
        // reasoning as handleNewSession).
        selectSession(forked.id, forked.project_id)
      } catch (error) {
        logger.error('Failed to fork session:', error)
      }
    },
    [addSession, selectSession],
  )

  const confirmPendingAction = useCallback(async () => {
    if (!pendingAction) return
    const { kind, sessionId, isArchived, sessionIds } = pendingAction
    setPendingAction(null)
    // Group actions (sessionIds set) apply the operation to EVERY member;
    // each perform* catches its own error, so one failure never breaks the loop.
    for (const id of sessionIds ?? [sessionId]) {
      if (kind === 'delete') {
        await performDelete(id)
      } else {
        await performArchive(id, isArchived)
      }
    }
  }, [pendingAction, performDelete, performArchive])

  const cancelPendingAction = useCallback(() => setPendingAction(null), [])

  const startRename = useCallback((id: string, currentName: string) => {
    setRenamingId(id)
    setRenameValue(currentName)
    setTimeout(() => renameRef.current?.focus(), 50)
  }, [])

  const commitRename = useCallback(async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null)
      return
    }
    try {
      await renameSession(renamingId, renameValue.trim())
      updateSession(renamingId, { name: renameValue.trim() })
    } catch (error) {
      logger.error('Failed to rename session:', error)
    }
    setRenamingId(null)
  }, [renamingId, renameValue, updateSession])

  const cancelRename = useCallback(() => setRenamingId(null), [])
  const clearCreateError = useCallback(() => setCreateError(null), [])

  return {
    createError,
    clearCreateError,
    renamingId,
    renameValue,
    setRenameValue,
    renameRef,
    startRename,
    commitRename,
    cancelRename,
    handleNewSession,
    handleNewSessionOnBranch,
    handleDelete,
    handleArchive,
    handlePin,
    handleFork,
    handleArchiveGroup,
    handleUnarchiveGroup,
    handleDeleteGroup,
    pendingAction,
    confirmPendingAction,
    cancelPendingAction,
  }
}
