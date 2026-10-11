import { getDefaultViewerWidth } from '@/stores/fileViewerStore'
import { GIT_PANEL_TAB_VALUES, type GitPanelTab } from '@/stores/gitPanelStore'
import type { InputMode } from '@/stores/inputModeStore'
import {
  RESEARCH_SEGMENT_VALUES,
  WORKSPACE_TAB_VALUES,
  getDefaultSidebarWidth,
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
// store (cross-store coordination happens in the tab engine, per
// specs/domains/frontend/stores.md). The engine captures the outgoing tab's
// slices with `captureTabUI`, stores the result on the tab's `ui` field, and
// restores the incoming tab's slices with `restoreTabUI`.
//
// v2 composition (ADR-085): beside the v1 workspace-panel slices, a tab also
// remembers the shell geometry (left sidebar, right viewer panel), the
// per-project Git-panel tab, and the two chat-view toggles. Scalar slices
// restore as an OVERWRITE — that is what makes them per-tab — while the
// per-project maps merge entry-by-entry exactly like their v1 siblings.

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

/** The left sidebar's geometry slice (uiStore.sidebarCollapsed/sidebarWidth). */
export interface TabSidebarSnapshot {
  collapsed: boolean
  width: number
}

/**
 * The right viewer panel's geometry slice (fileViewerStore
 * pinned/collapsed/width). The viewer's OPEN FILE TABS are deliberately NOT
 * part of a workspace tab's snapshot: they stay per-project state, restored
 * by the project-switch persistence (ProjectSwitchState) — see ADR-085 D3.
 */
export interface TabViewerSnapshot {
  pinned: boolean
  collapsed: boolean
  width: number
}

/** Active Git-panel tab per project id (gitPanelStore.activeTabByProject). */
export type GitPanelTabByProject = Record<string, GitPanelTab>

/** A tab's captured UI context: the v2 snapshot slices, validated. */
export interface TabUIState {
  // v1 slices.
  workspaceTabByProject: WorkspaceTabByProject
  researchSegmentByProject: ResearchSegmentByProject
  inputMode: TabInputSnapshot
  // v2 slices (ADR-085).
  sidebar: TabSidebarSnapshot
  viewer: TabViewerSnapshot
  gitPanelTabByProject: GitPanelTabByProject
  chatSessionListRatio: number
  showSessionStats: boolean
}

/**
 * The live slice values a restore falls back to: every scalar slice falls
 * back to the caller-supplied live value when the snapshot being restored
 * misses it or carries a wrong-typed one (the "wrong-typed scalar falls back
 * to current" contract of mergeUIStore). The per-project maps need no
 * fallback — absent maps restore to empty.
 */
export interface TabUIFallback {
  inputMode: TabInputSnapshot
  sidebar: TabSidebarSnapshot
  viewer: TabViewerSnapshot
  chatSessionListRatio: number
  showSessionStats: boolean
}

/** Documented boot-default chat-session-list split ratio (uiStore). */
export const DEFAULT_CHAT_SESSION_RATIO = 0.5

/** Documented boot-default session-stats row visibility (uiStore, opt-in). */
export const DEFAULT_SHOW_SESSION_STATS = false

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

/**
 * A fresh default sidebar snapshot, mirroring uiStore's initializer
 * (expanded, 1/5-of-screen width clamped to [SIDEBAR_MIN, SIDEBAR_MAX]).
 * A function — the width default is computed from the live window, and a
 * fresh object per call keeps mutations from leaking between defaults.
 */
export function createDefaultSidebarSnapshot(): TabSidebarSnapshot {
  return { collapsed: false, width: getDefaultSidebarWidth() }
}

/**
 * A fresh default viewer snapshot, mirroring fileViewerStore's initializer
 * (unpinned floating, collapsed rail, 2/5-of-screen width clamped to
 * [VIEWER_MIN, VIEWER_MAX]). A function for the same reasons as the sidebar
 * snapshot above.
 */
export function createDefaultViewerSnapshot(): TabViewerSnapshot {
  return { pinned: false, collapsed: false, width: getDefaultViewerWidth() }
}

/**
 * The documented fallback when a restore has no live slices to fall back to
 * (capture's impossible-corrupted-live-value path). Fresh objects, so the
 * result can never alias module state.
 */
export function defaultTabUIFallback(): TabUIFallback {
  return {
    inputMode: { ...DEFAULT_INPUT_SNAPSHOT },
    sidebar: createDefaultSidebarSnapshot(),
    viewer: createDefaultViewerSnapshot(),
    chatSessionListRatio: DEFAULT_CHAT_SESSION_RATIO,
    showSessionStats: DEFAULT_SHOW_SESSION_STATS,
  }
}

/**
 * Build a fallback from an already-validated TabUIState — the tabStore's
 * updateActiveContext re-sanitizes against the active tab's own stored
 * snapshot. Scalar fields are read-only here (sanitize never stores the
 * fallback by reference), so direct references are safe.
 */
export function fallbackFromTabUI(ui: TabUIState): TabUIFallback {
  return {
    inputMode: ui.inputMode,
    sidebar: ui.sidebar,
    viewer: ui.viewer,
    chatSessionListRatio: ui.chatSessionListRatio,
    showSessionStats: ui.showSessionStats,
  }
}

/** The live slice values a capture reads from (a structural subset of the stores' state). */
export interface TabUISource {
  workspaceTabByProject: WorkspaceTabByProject
  researchSegmentByProject: ResearchSegmentByProject
  inputMode: TabInputSnapshot
  sidebar: TabSidebarSnapshot
  viewer: TabViewerSnapshot
  gitPanelTabByProject: GitPanelTabByProject
  chatSessionListRatio: number
  showSessionStats: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Valid input-panel modes (mirrors inputModeStore's InputMode union). */
const INPUT_MODE_VALUES = new Set<InputMode>(['chat', 'terminal'])

/**
 * A fresh, fully-default TabUIState (used for new tabs whose context starts
 * empty). Restoring the three EMPTY per-project maps is a no-op, but the
 * scalar slices carry concrete boot defaults: every field is present and
 * valid, so restoreTabUI applies them as-is rather than falling back to the
 * live values — restoring this object does NOT leave the shell untouched.
 * Creation paths that must preserve the live shell either converge the fresh
 * tab immediately (TabBar's write-back) or seed it with a live capture
 * (tabEngine's captureLiveUI — the banner-click path).
 */
export function createDefaultTabUI(): TabUIState {
  return {
    workspaceTabByProject: {},
    researchSegmentByProject: {},
    inputMode: { ...DEFAULT_INPUT_SNAPSHOT },
    sidebar: createDefaultSidebarSnapshot(),
    viewer: createDefaultViewerSnapshot(),
    gitPanelTabByProject: {},
    chatSessionListRatio: DEFAULT_CHAT_SESSION_RATIO,
    showSessionStats: DEFAULT_SHOW_SESSION_STATS,
  }
}

/**
 * Fail-closed validation for a raw tab-UI payload (same contract as
 * mergeUIStore): every field must have the exact expected type or it falls
 * back — per-project maps rebuild from valid entries only (unknown
 * workspace-tab / research-segment / git-panel-tab values are dropped
 * entry-by-entry, non-object maps are discarded), scalar fields fall back to
 * the caller-supplied fallback (widths/heights/ratio must be finite numbers,
 * modes must be known modes, booleans must be booleans). Garbage never
 * reaches the stores.
 *
 * The result is always freshly allocated — the source maps are defensively
 * copied, so later store mutations never leak into a stored snapshot.
 */
export function sanitizeTabUI(raw: unknown, fallback: TabUIFallback = defaultTabUIFallback()): TabUIState {
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

  const gitPanelTabByProject: GitPanelTabByProject = {}
  if (isRecord(source.gitPanelTabByProject)) {
    for (const [projectId, tab] of Object.entries(source.gitPanelTabByProject)) {
      if (GIT_PANEL_TAB_VALUES.has(tab as GitPanelTab)) {
        gitPanelTabByProject[projectId] = tab as GitPanelTab
      }
    }
  }

  const rawInput = isRecord(source.inputMode) ? source.inputMode : {}
  const finite = (value: unknown, fallbackValue: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallbackValue
  const bool = (value: unknown, fallbackValue: boolean): boolean =>
    typeof value === 'boolean' ? value : fallbackValue

  const inputMode: TabInputSnapshot = {
    mode:
      typeof rawInput.mode === 'string' && INPUT_MODE_VALUES.has(rawInput.mode as InputMode)
        ? (rawInput.mode as InputMode)
        : fallback.inputMode.mode,
    height: finite(rawInput.height, fallback.inputMode.height),
    collapsedHeight: finite(rawInput.collapsedHeight, fallback.inputMode.collapsedHeight),
    isExpanded: bool(rawInput.isExpanded, fallback.inputMode.isExpanded),
  }

  const rawSidebar = isRecord(source.sidebar) ? source.sidebar : {}
  const sidebar: TabSidebarSnapshot = {
    collapsed: bool(rawSidebar.collapsed, fallback.sidebar.collapsed),
    width: finite(rawSidebar.width, fallback.sidebar.width),
  }

  const rawViewer = isRecord(source.viewer) ? source.viewer : {}
  const viewer: TabViewerSnapshot = {
    pinned: bool(rawViewer.pinned, fallback.viewer.pinned),
    collapsed: bool(rawViewer.collapsed, fallback.viewer.collapsed),
    width: finite(rawViewer.width, fallback.viewer.width),
  }

  return {
    workspaceTabByProject,
    researchSegmentByProject,
    inputMode,
    sidebar,
    viewer,
    gitPanelTabByProject,
    chatSessionListRatio: finite(source.chatSessionListRatio, fallback.chatSessionListRatio),
    showSessionStats: bool(source.showSessionStats, fallback.showSessionStats),
  }
}

/**
 * Pure capture: snapshot the live slices into a validated, defensively
 * copied TabUIState (see sanitizeTabUI). The live values are already trusted
 * (the owning stores validate on rehydrate), so valid values pass through
 * unchanged while an impossible corrupted live value fails closed to the
 * documented defaults instead of poisoning the stored snapshot.
 */
export function captureTabUI(source: TabUISource): TabUIState {
  return sanitizeTabUI(source, defaultTabUIFallback())
}

/**
 * Pure restore: validate a stored tab-UI payload for application to the live
 * slices. Invalid/missing scalar fields fall back to the caller-supplied
 * live fallback (the stores' current values), mirroring mergeUIStore's
 * "wrong-typed scalar falls back to current" rule.
 */
export function restoreTabUI(raw: unknown, fallback: TabUIFallback): TabUIState {
  return sanitizeTabUI(raw, fallback)
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
  const aGitTabs = a.gitPanelTabByProject
  const bGitTabs = b.gitPanelTabByProject
  const aGitKeys = Object.keys(aGitTabs)
  if (aGitKeys.length !== Object.keys(bGitTabs).length) return false
  for (const key of aGitKeys) {
    if (aGitTabs[key] !== bGitTabs[key]) return false
  }
  return (
    a.inputMode.mode === b.inputMode.mode &&
    a.inputMode.height === b.inputMode.height &&
    a.inputMode.collapsedHeight === b.inputMode.collapsedHeight &&
    a.inputMode.isExpanded === b.inputMode.isExpanded &&
    a.sidebar.collapsed === b.sidebar.collapsed &&
    a.sidebar.width === b.sidebar.width &&
    a.viewer.pinned === b.viewer.pinned &&
    a.viewer.collapsed === b.viewer.collapsed &&
    a.viewer.width === b.viewer.width &&
    a.chatSessionListRatio === b.chatSessionListRatio &&
    a.showSessionStats === b.showSessionStats
  )
}
