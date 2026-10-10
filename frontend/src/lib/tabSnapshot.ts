import type { InputMode } from '@/stores/inputModeStore'
import {
  RESEARCH_SEGMENT_VALUES,
  WORKSPACE_TAB_VALUES,
  type ResearchSegment,
  type ResearchSegmentByProject,
  type WorkspaceTab,
  type WorkspaceTabByProject,
} from '@/stores/uiStore'

// Tab snapshot slices — the per-tab UI context captured on tab switches.
//
// The tab layer (stores/tabStore) owns WHICH tab is active; the slices below
// own WHAT the workspace looks like inside it. Capture/restore are pure
// functions: they take the live slice values as arguments and never touch a
// store (cross-store coordination happens in hooks, per specs/domains/
// frontend/stores.md). The future tab-bar wiring captures the outgoing tab's
// slices with `captureTabUI`, stores the result on the tab's `ui` field, and
// restores the incoming tab's slices with `restoreTabUI`.

/**
 * The input-panel geometry/mode slice: exactly the persisted fields of
 * `inputModeStore` that describe the panel itself (transient pending* fields
 * and per-message overrides are deliberately excluded — they are not part of
 * a tab's identity).
 */
export interface TabInputSnapshot {
  mode: InputMode
  height: number
  collapsedHeight: number
  isExpanded: boolean
}

/** A tab's captured UI context: the three snapshot slices, validated. */
export interface TabUIState {
  workspaceTabByProject: WorkspaceTabByProject
  researchSegmentByProject: ResearchSegmentByProject
  inputMode: TabInputSnapshot
}

/**
 * Fallback input-panel snapshot, mirroring inputModeStore's own defaults
 * (DEFAULT_HEIGHT = 200, chat mode, collapsed). Used when a value being
 * sanitized has the wrong type/shape and no caller-supplied fallback exists.
 */
export const DEFAULT_INPUT_SNAPSHOT: TabInputSnapshot = {
  mode: 'chat',
  height: 200,
  collapsedHeight: 200,
  isExpanded: false,
}

/** Valid input-panel modes (mirrors inputModeStore's InputMode union). */
const INPUT_MODE_VALUES = new Set<InputMode>(['chat', 'terminal'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A fresh, fully-default TabUIState (used for new tabs whose context starts
 * empty). Restoring the two EMPTY per-project maps is a no-op, but the
 * input snapshot carries concrete boot defaults: every field is present and
 * valid, so restoreTabUI applies them as-is rather than falling back to the
 * live values — restoring this object does NOT leave the input panel
 * untouched. Creation paths that must preserve the live panel either
 * converge the fresh tab immediately (TabBar's write-back) or seed it with
 * a live capture (tabEngine's captureLiveUI — the banner-click path).
 */
export function createDefaultTabUI(): TabUIState {
  return {
    workspaceTabByProject: {},
    researchSegmentByProject: {},
    inputMode: { ...DEFAULT_INPUT_SNAPSHOT },
  }
}

/**
 * Fail-closed validation for a raw tab-UI payload (same contract as
 * mergeUIStore): every field must have the exact expected type or it falls
 * back — per-project maps rebuild from valid entries only (unknown
 * workspace-tab / research-segment values are dropped entry-by-entry,
 * non-object maps are discarded), scalar input fields fall back to the
 * caller-supplied fallback (heights must be finite numbers, mode must be a
 * known mode, isExpanded a boolean). Garbage never reaches the stores.
 *
 * The result is always freshly allocated — the source maps are defensively
 * copied, so later store mutations never leak into a stored snapshot.
 */
export function sanitizeTabUI(
  raw: unknown,
  fallbackInput: TabInputSnapshot = DEFAULT_INPUT_SNAPSHOT,
): TabUIState {
  const source = isRecord(raw) ? raw : {}

  const workspaceTabByProject: WorkspaceTabByProject = {}
  if (isRecord(source.workspaceTabByProject)) {
    for (const [projectId, tab] of Object.entries(source.workspaceTabByProject)) {
      if (WORKSPACE_TAB_VALUES.has(tab as WorkspaceTab)) {
        workspaceTabByProject[projectId] = tab as WorkspaceTab
      }
    }
  }

  const researchSegmentByProject: ResearchSegmentByProject = {}
  if (isRecord(source.researchSegmentByProject)) {
    for (const [projectId, segment] of Object.entries(source.researchSegmentByProject)) {
      if (RESEARCH_SEGMENT_VALUES.has(segment as ResearchSegment)) {
        researchSegmentByProject[projectId] = segment as ResearchSegment
      }
    }
  }

  const rawInput = isRecord(source.inputMode) ? source.inputMode : {}
  const finite = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const inputMode: TabInputSnapshot = {
    mode:
      typeof rawInput.mode === 'string' && INPUT_MODE_VALUES.has(rawInput.mode as InputMode)
        ? (rawInput.mode as InputMode)
        : fallbackInput.mode,
    height: finite(rawInput.height, fallbackInput.height),
    collapsedHeight: finite(rawInput.collapsedHeight, fallbackInput.collapsedHeight),
    isExpanded:
      typeof rawInput.isExpanded === 'boolean' ? rawInput.isExpanded : fallbackInput.isExpanded,
  }

  return { workspaceTabByProject, researchSegmentByProject, inputMode }
}

/** The live slice values a capture reads from (a structural subset of the stores' state). */
export interface TabUISource {
  workspaceTabByProject: WorkspaceTabByProject
  researchSegmentByProject: ResearchSegmentByProject
  inputMode: TabInputSnapshot
}

/**
 * Pure capture: snapshot the three live slices into a validated, defensively
 * copied TabUIState (see sanitizeTabUI). The live values are already trusted
 * (the owning stores validate on rehydrate), so valid values pass through
 * unchanged while an impossible corrupted live value fails closed to the
 * documented defaults instead of poisoning the stored snapshot.
 */
export function captureTabUI(source: TabUISource): TabUIState {
  return sanitizeTabUI(source, DEFAULT_INPUT_SNAPSHOT)
}

/**
 * Pure restore: validate a stored tab-UI payload for application to the live
 * slices. Invalid/missing fields fall back to the caller-supplied live input
 * snapshot (the stores' current values), mirroring mergeUIStore's
 * "wrong-typed scalar falls back to current" rule.
 */
export function restoreTabUI(raw: unknown, fallbackInput: TabInputSnapshot): TabUIState {
  return sanitizeTabUI(raw, fallbackInput)
}

/**
 * Deep content equality for two validated tab-UI states. Used by
 * tabStore.updateActiveContext to keep no-op updates reference-stable (an
 * equal snapshot never replaces the stored one).
 */
export function isSameTabUI(a: TabUIState, b: TabUIState): boolean {
  const aTabs = a.workspaceTabByProject
  const bTabs = b.workspaceTabByProject
  const aTabKeys = Object.keys(aTabs)
  if (aTabKeys.length !== Object.keys(bTabs).length) return false
  for (const key of aTabKeys) {
    if (aTabs[key] !== bTabs[key]) return false
  }
  const aSegments = a.researchSegmentByProject
  const bSegments = b.researchSegmentByProject
  const aSegmentKeys = Object.keys(aSegments)
  if (aSegmentKeys.length !== Object.keys(bSegments).length) return false
  for (const key of aSegmentKeys) {
    if (aSegments[key] !== bSegments[key]) return false
  }
  return (
    a.inputMode.mode === b.inputMode.mode &&
    a.inputMode.height === b.inputMode.height &&
    a.inputMode.collapsedHeight === b.inputMode.collapsedHeight &&
    a.inputMode.isExpanded === b.inputMode.isExpanded
  )
}
