// Agents (Subagent Profiles) API wrappers

import { getApp } from './runtime'
import { logger } from '@/lib/logger'
import { isAgentDescriptor, isArrayOf } from '@/types/guards'
import type { AgentDescriptor } from '@/types/models'

export async function listAgents(): Promise<AgentDescriptor[]> {
  try {
    const app = getApp()
    const result = await app.ListAgents()
    if (!isArrayOf(result, isAgentDescriptor)) {
      logger.warn('listAgents: unexpected response shape', result)
      return []
    }
    return result
  } catch (err) {
    logger.error('Failed to list agents:', err)
    throw err
  }
}

/**
 * Force a backend re-discovery of the Subagent Profile directories and
 * return the fresh catalog — the manual path behind the Capabilities tab's
 * refresh button (ListAgents alone is served from the backend cache).
 */
export async function refreshAgents(): Promise<AgentDescriptor[]> {
  try {
    const app = getApp()
    const result = await app.RefreshAgents()
    if (!isArrayOf(result, isAgentDescriptor)) {
      logger.warn('refreshAgents: unexpected response shape', result)
      return []
    }
    return result
  } catch (err) {
    logger.error('Failed to refresh agents:', err)
    throw err
  }
}
