// Custom commands API wrappers (ADR-096)

import { getApp } from './runtime'
import { logger } from '@/lib/logger'
import { isCommandDescriptor, isArrayOf } from '@/types/guards'
import type { CommandDescriptor } from '@/types/models'

/**
 * List the custom command descriptors (name, description, frontmatter
 * agent/model bindings, and the full template body). The backend cache is
 * invalidated on project switches and by the global-dir watchers
 * (commands:changed). A malformed response degrades to [] — a transient
 * serialization hiccup must hide the section for one trigger, never break
 * the chat input. An RPC failure throws (callers degrade on their own).
 */
export async function listCommands(): Promise<CommandDescriptor[]> {
  try {
    const app = getApp()
    const result = await app.ListCommands()
    if (!isArrayOf(result, isCommandDescriptor)) {
      logger.warn('listCommands: unexpected response shape', result)
      return []
    }
    return result
  } catch (err) {
    logger.error('Failed to list commands:', err)
    throw err
  }
}
