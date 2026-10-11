// Shared presentation helpers for the per-context capability modes
// ("auto" | "manual" | "disabled" per chat / code context) — the one copy of
// the option list, the user-facing semantics text used by the MCP server
// cards and the read-only Subagents/Skills cards in Settings → Capabilities,
// and the pure mentionability filter the /-completion and the send path
// consume.

import { NO_PROJECT_ID } from '@/types/models'
import type { CapabilityModes, MCPServerMode } from '@/types/models'

export type CapabilityContext = 'chat' | 'code'

/** The three activation modes in menu order, values already canonical. */
export const CAPABILITY_MODE_OPTIONS = ['auto', 'manual', 'disabled'].map((value) => ({
  value,
  label: value,
})) as ReadonlyArray<{ value: MCPServerMode; label: string }>

const CONTEXT_LABEL: Record<CapabilityContext, string> = { chat: 'Chat', code: 'Code' }

/**
 * One-line explanation of what a mode means in one context — the semantics
 * differ by session type, so the text names the context explicitly:
 * auto advertises the capability into every session of that type, manual
 * holds it back until a /-mention enables it for the task, disabled keeps it
 * away from that context entirely (the other context is unaffected).
 */
export function capabilityModeExplanation(context: CapabilityContext, mode: MCPServerMode): string {
  const label = CONTEXT_LABEL[context]
  switch (mode) {
    case 'auto':
      return `${label} sessions: always available.`
    case 'manual':
      return `${label} sessions: held back until a /name mention enables it for the task.`
    case 'disabled':
      return `${label} sessions: never advertised — the other context is unaffected.`
  }
}

/**
 * The ONLY inert combination: a capability disabled in both contexts is
 * never dialed / never advertised anywhere, so cards render it neutrally
 * (no error color, no live status) instead of as a failure.
 */
export function isDisabledInBothContexts(chatMode: MCPServerMode, codeMode: MCPServerMode): boolean {
  return chatMode === 'disabled' && codeMode === 'disabled'
}

/**
 * Whether any context is parked in `manual` — the mention-triggered mode
 * worth a badge on a collapsed card.
 */
export function isManualAnywhere(chatMode: MCPServerMode, codeMode: MCPServerMode): boolean {
  return chatMode === 'manual' || codeMode === 'manual'
}

/**
 * The pure session-kind mentionability filter: whether ONE capability
 * (MCP server, skill, subagent profile) is mentionable for sessions of the
 * given kind. `auto` (always advertised there) and `manual`
 * (mention-triggered by design — the mention flow is exactly how it
 * activates) are visible and mentionable; `disabled` is inert in that
 * context — its tools are never advertised, so the completion hides the
 * entry and a mention must not thread it. The OTHER context's mode is
 * irrelevant here by construction.
 */
export function isMentionableInContext(context: CapabilityContext, modes: Pick<CapabilityModes, 'chat_mode' | 'code_mode'>): boolean {
  const mode = context === 'chat' ? modes.chat_mode : modes.code_mode
  return mode === 'auto' || mode === 'manual'
}

/**
 * Filter a catalog's names down to those mentionable for `context` sessions,
 * per the capabilities section (`capabilities.skills` / `.agents` as returned
 * by GetCapabilityModes). A missing entry reads as "auto" — the backend's
 * zero-regression default — so only an EXPLICITLY disabled entry is hidden.
 * A null/undefined section (capabilities fetch failed) filters nothing:
 * a transient RPC failure must degrade to "everything offered", never to
 * silently hiding whole catalogs.
 */
export function mentionableNamesInContext(
  names: string[],
  modes: Record<string, CapabilityModes> | null | undefined,
  context: CapabilityContext,
): string[] {
  if (!modes) return names
  return names.filter((name) => {
    const entry = modes[name]
    return !entry || isMentionableInContext(context, entry)
  })
}

/**
 * Session kind from the kind-source of record — `SessionInfo.project_id`:
 * the No-Project pseudo-project id (and a missing id, the shape a not-yet-
 * created session's fallback context can take) is the CHAT context, every
 * real project id is CODE.
 */
export function sessionKindFromProjectId(projectId: string | null | undefined): CapabilityContext {
  return projectId !== null && projectId !== undefined && projectId !== '' && projectId !== NO_PROJECT_ID
    ? 'code'
    : 'chat'
}
