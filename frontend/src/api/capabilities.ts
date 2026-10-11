// Capabilities API wrappers — the per-context activation modes of the three
// capability sections (skills, subagent profiles, MCP servers).

import { getApp } from './runtime'
import { logger } from '@/lib/logger'
import { isCapabilitiesInfo } from '@/types/guards'
import type { CapabilitiesInfo, CapabilityModes, CapabilitySection } from '@/types/models'

/**
 * Fetch the normalized capabilities section (GetCapabilityModes): every
 * entry carries canonical per-context enum values ("auto" resolves a missing
 * config entry) and capabilities.mcp names always resolve against the
 * configured servers. Returns empty (never null) sections on an unexpected
 * shape so the settings UI renders defaults instead of crashing; rethrows on
 * RPC failure so the caller can surface a load error.
 */
export async function getCapabilityModes(): Promise<CapabilitiesInfo> {
  try {
    const app = getApp()
    const result = await app.GetCapabilityModes()
    if (!isCapabilitiesInfo(result)) {
      logger.error('getCapabilityModes: unexpected response shape, returning empty sections', result)
      return { skills: {}, agents: {}, mcp: {} }
    }
    return result
  } catch (err) {
    logger.error('Failed to get capability modes:', err)
    throw err
  }
}

/**
 * Replace one capabilities section wholesale (UpdateCapabilityModes). This
 * is a REPLACEMENT, not a merge: the payload must carry the FULL section —
 * every capability the UI renders plus its current modes — because names
 * absent from it lose their stored entry and fall back to "auto" (the
 * backend additionally trims stale mcp names and drops both-empty entries).
 * Rejects with an error listing the accepted enum when any mode value is
 * invalid; the stored config is left untouched.
 */
export async function updateCapabilityModes(
  section: CapabilitySection,
  modes: Record<string, CapabilityModes>,
): Promise<void> {
  try {
    const app = getApp()
    await app.UpdateCapabilityModes(section, modes)
  } catch (err) {
    logger.error(`Failed to update ${section} capability modes:`, err)
    throw err
  }
}
