// Skills API wrappers

import { getApp } from './runtime'
import { logger } from '@/lib/logger'
import { isSkillDescriptor, isArrayOf } from '@/types/guards'
import type { SkillDescriptor } from '@/types/models'

export async function listSkills(): Promise<SkillDescriptor[]> {
  try {
    const app = getApp()
    const result = await app.ListSkills()
    if (!isArrayOf(result, isSkillDescriptor)) {
      logger.warn('listSkills: unexpected response shape', result)
      return []
    }
    return result
  } catch (err) {
    logger.error('Failed to list skills:', err)
    throw err
  }
}

/**
 * Force a backend re-discovery of the skill directories and return the fresh
 * catalog — the manual path behind the Capabilities tab's refresh button
 * (ListSkills alone is served from the backend cache).
 */
export async function refreshSkills(): Promise<SkillDescriptor[]> {
  try {
    const app = getApp()
    const result = await app.RefreshSkills()
    if (!isArrayOf(result, isSkillDescriptor)) {
      logger.warn('refreshSkills: unexpected response shape', result)
      return []
    }
    return result
  } catch (err) {
    logger.error('Failed to refresh skills:', err)
    throw err
  }
}

/**
 * Resolve a read_skill_resource tool call's (skill, path) arguments to the
 * absolute file path the tool actually read — the backend scans the same
 * skill catalog the tool's per-session SkillManager does and applies the
 * tool's own traversal guard.
 *
 * Unlike the other wrappers, this one deliberately FAILS SOFT: it logs a
 * warning and returns null instead of throwing. Its only consumer is the
 * tool-call card's FileLink, where a failed resolution downgrades the link
 * to plain text; throwing here would turn that cosmetic fallback into an
 * unhandled rejection in a click handler.
 */
export async function resolveSkillResourcePath(skill: string, path: string): Promise<string | null> {
  try {
    const app = getApp()
    const result: unknown = await app.ResolveSkillResourcePath(skill, path)
    if (typeof result !== 'string' || result === '') {
      logger.warn('resolveSkillResourcePath: unexpected response shape', result)
      return null
    }
    return result
  } catch (err) {
    logger.warn('Failed to resolve skill resource path:', err)
    return null
  }
}
