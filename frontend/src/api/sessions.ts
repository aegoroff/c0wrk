// Session management API wrappers

import { getApp } from './runtime'
import { logger } from '@/lib/logger'
import { isSessionInfo, isArrayOf, isProjectInfo } from '@/types/guards'
import type { ProjectInfo, SessionInfo } from '@/types/models'
import type { SessionDeleteOptionsUI } from '@/types/api'

export async function createSession(): Promise<SessionInfo> {
  try {
    const app = getApp()
    const result = await app.CreateSession()
    if (!isSessionInfo(result)) {
      throw new Error('createSession: backend returned invalid data')
    }
    return result
  } catch (err) {
    logger.error('Failed to create session:', err)
    throw err
  }
}


export async function deleteSession(id: string): Promise<void> {
  try {
    const app = getApp()
    await app.DeleteSession(id)
  } catch (err) {
    logger.error('Failed to delete session:', err)
    throw err
  }
}

/**
 * Delete a session carrying the user's explicit decisions about its managed
 * worktree — the typed counterpart of `DeleteSessionWithOptions`.
 * `confirmUncommittedLoss` confirms discarding the tree's uncommitted
 * changes, `unlockLockedTree` authorizes removing a locked tree; neither is
 * ever taken implicitly. Unlike `deleteSession` this wrapper does not log or
 * wrap the failure: the backend refuses a missing decision with a
 * `session deletion blocked: <reason> (confirm via <option>)` error that
 * must reach the caller intact — recognize it with
 * `parseSessionDeleteBlock`, then re-issue the deletion with the named
 * option once the user confirms. A blocked deletion leaves the session, its
 * tree, and its branch fully intact and retryable.
 */
export async function deleteSessionWithOptions(
  id: string,
  options: SessionDeleteOptionsUI = {},
): Promise<void> {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('deleteSessionWithOptions: session id is required')
  }
  const app = getApp()
  await app.DeleteSessionWithOptions(id.trim(), {
    confirm_uncommitted_loss: options.confirmUncommittedLoss === true,
    unlock_locked_tree: options.unlockLockedTree === true,
  })
}

export async function listSessions(): Promise<SessionInfo[]> {
  try {
    const app = getApp()
    const result = await app.ListSessions()
    if (!isArrayOf(result, isSessionInfo)) {
      logger.error('listSessions: unexpected response shape, returning []', result)
      return []
    }
    return result
  } catch (err) {
    logger.error('Failed to list sessions:', err)
    throw err
  }
}

/** Sessions across ALL projects (global switcher), sorted pinned-first then by
 *  effective activity. Errors are handled exactly like listSessions(). */
export async function listAllSessions(): Promise<SessionInfo[]> {
  try {
    const app = getApp()
    const result = await app.ListAllSessions()
    if (!isArrayOf(result, isSessionInfo)) {
      logger.error('listAllSessions: unexpected response shape, returning []', result)
      return []
    }
    return result
  } catch (err) {
    logger.error('Failed to list all sessions:', err)
    throw err
  }
}

export async function renameSession(id: string, name: string): Promise<void> {
  try {
    const app = getApp()
    await app.RenameSession(id, name)
  } catch (err) {
    logger.error('Failed to rename session:', err)
    throw err
  }
}

export async function archiveSession(id: string): Promise<void> {
  try {
    const app = getApp()
    await app.ArchiveSession(id)
  } catch (err) {
    logger.error('Failed to archive session:', err)
    throw err
  }
}

export async function pinSession(id: string): Promise<void> {
  try {
    const app = getApp()
    await app.PinSession(id)
  } catch (err) {
    logger.error('Failed to pin session:', err)
    throw err
  }
}

export async function forkSession(id: string): Promise<SessionInfo> {
  try {
    const app = getApp()
    const result = await app.ForkSession(id)
    if (!isSessionInfo(result)) {
      throw new Error('forkSession: backend returned invalid data')
    }
    return result
  } catch (err) {
    logger.error('Failed to fork session:', err)
    throw err
  }
}

/**
 * Promote a CHAT (No Project) session into a new CODE project with that
 * single session in it. The session keeps its identity and full history; its
 * workspace moves into the project's internal Workspace. The backend rejects
 * the promotion for a session with an unfinished task or a non-CHAT owner.
 * The caller switches to the returned project on success.
 */
export async function promoteSessionToProject(sessionId: string, projectName: string): Promise<ProjectInfo> {
  try {
    const app = getApp()
    const result = await app.PromoteSessionToProject(sessionId, projectName)
    if (!isProjectInfo(result)) {
      throw new Error('promoteSessionToProject: backend returned invalid data')
    }
    return result
  } catch (err) {
    logger.error('Failed to promote session to project:', err)
    throw err
  }
}
