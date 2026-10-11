import { logger } from '@/lib/logger'
import {
  captureTabUI,
  restoreTabUI,
  type TabInputSnapshot,
  type TabUIFallback,
  type TabUIState,
} from '@/lib/tabSnapshot'
import { useFileViewerStore } from '@/stores/fileViewerStore'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useInputModeStore } from '@/stores/inputModeStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import type { ProjectInfo } from '@/types/models'

// Tab activation engine — the SINGLE path a tab is activated through.
//
// The engine is a plain lib module (no React): it coordinates the tab layer
// (stores/tabStore) with the live workspace context (project/session stores)
// and the snapshot slices (lib/tabSnapshot). The React seam lives in
// hooks/useTabController, which owns one engine instance and mounts the
// write-back subscriptions for the app lifetime.
//
// One path, no flag branches: `uiStore.tabsEnabled` gates only whether the
// tab BAR renders. With the flag off the layer is its documented
// "exactly one tab" special case — and the write-back below is what makes
// that single tab a live mirror of the workspace. The engine never reads the
// flag.

/**
 * Async project switcher — the curried `useProjectSwitchState()` callback.
 * Serialized internally (switch chain + 30s watchdog) and REJECTS on
 * failure; the engine is the only place that observes those rejections.
 */
export type ProjectSwitcher = (projectId: string) => Promise<void>

/**
 * The explicit context seed for {@link TabEngine.createAndActivate}. An
 * `undefined` field means "the LIVE workspace value, read when the chain link
 * runs" — the «+» semantic (a tab for what the user is looking at). The
 * banner click passes BOTH ids explicitly (the clicked session), so its
 * project/session are fixed while the UI capture stays live.
 */
export interface TabCreateSeed {
  projectId?: string | null
  sessionId?: string | null
}

export interface TabEngine {
  /**
   * Activate a tab. The returned promise NEVER rejects: every failure is
   * rolled back (activeTabId reverts to the outgoing tab) and reported via
   * `logger.warn`, so fire-and-forget callers cannot produce an unhandled
   * rejection.
   */
  activate: (tabId: string) => Promise<void>
  /**
   * Create a tab and materialize it through the FULL activation path as ONE
   * chain link — the shared creation primitive behind the tab bar's «+»
   * button and the banner-click tab. Because creation lives inside the same
   * module-level chain as every activation, an in-flight activation always
   * completes (its restore + write-back land on the tab that was active
   * throughout) BEFORE the new tab exists — the fresh tab can never be
   * grafted with a mid-switch context the way an out-of-chain addTab can.
   * The link reads the seed and captures the live UI when it RUNS (not at
   * call time), so the tab inherits the workspace the user sees at that
   * moment; `captureLiveUI` as the seed keeps the restore re-applying what
   * the workspace already shows (the input panel stays untouched). Like
   * activate, the promise never rejects.
   */
  createAndActivate: (seed?: TabCreateSeed) => Promise<void>
  /**
   * Write-back: mirror the LIVE context (activeProjectId, activeSessionId,
   * the uiStore per-project maps, the input-panel slice) into the ACTIVE
   * tab. Unconditional — it runs under any tabsEnabled value; with the flag
   * off it is what keeps the single tab identical to the workspace.
   * Content-equal writes are reference-stable no-ops (updateActiveContext).
   */
  writeBack: () => void
  /**
   * Mount the write-back subscriptions (project/session/ui/input stores →
   * writeBack). Returns the detach function; the initial context is adopted
   * synchronously on attach, so a freshly mounted layer immediately mirrors
   * the live workspace.
   */
  attachWriteBack: () => () => void
}

// --- Live slice readers ---

/** The current input-panel slice (exactly the TabInputSnapshot fields). */
function liveInputSnapshot(): TabInputSnapshot {
  const s = useInputModeStore.getState()
  return { mode: s.mode, height: s.height, collapsedHeight: s.collapsedHeight, isExpanded: s.isExpanded }
}

/**
 * The live scalar-slice fallback for a restore: a remembered snapshot with a
 * missing/wrong-typed scalar falls back to what the workspace shows right
 * now (the "wrong-typed scalar falls back to current" contract).
 */
function liveTabUIFallback(): TabUIFallback {
  const ui = useUIStore.getState()
  const viewer = useFileViewerStore.getState()
  return {
    inputMode: liveInputSnapshot(),
    sidebar: { collapsed: ui.sidebarCollapsed, width: ui.sidebarWidth },
    viewer: { pinned: viewer.pinned, collapsed: viewer.collapsed, width: viewer.width },
    chatSessionListRatio: ui.chatSessionListRatio,
    showSessionStats: ui.showSessionStats,
  }
}

/**
 * A validated capture of the live snapshot slices (the v2 composition).
 * Exported for the banner-click tab creation (useNotificationClicks): the one
 * creation path whose new tab must REMEMBER the current live context, so its
 * activation restores exactly what the workspace already shows.
 */
export function captureLiveUI(): TabUIState {
  const ui = useUIStore.getState()
  const viewer = useFileViewerStore.getState()
  return captureTabUI({
    workspaceTabByProject: ui.workspaceTabByProject,
    researchSegmentByProject: ui.researchSegmentByProject,
    inputMode: liveInputSnapshot(),
    sidebar: { collapsed: ui.sidebarCollapsed, width: ui.sidebarWidth },
    viewer: { pinned: viewer.pinned, collapsed: viewer.collapsed, width: viewer.width },
    gitPanelTabByProject: useGitPanelStore.getState().activeTabByProject,
    chatSessionListRatio: ui.chatSessionListRatio,
    showSessionStats: ui.showSessionStats,
  })
}

// --- Write-back ---

function writeBack(): void {
  useTabStore.getState().updateActiveContext({
    projectId: useProjectStore.getState().activeProjectId,
    sessionId: useSessionStore.getState().activeSessionId,
    ui: captureLiveUI(),
  })
}

// --- Sync-slice restore ---

/**
 * Apply a tab's remembered slices to the live stores. The per-project maps
 * merge entry-by-entry (the maps are shared across tabs; a restore layers
 * this tab's remembered entries over the live map without erasing other
 * projects' entries), the scalar shell slices (sidebar, viewer geometry,
 * chat-view toggles) are written through their own store setters — the
 * setters' clamps stay in force — and the input-panel fields are written as
 * a unit, the same four persisted fields the persist middleware restores on
 * boot.
 */
function restoreSlices(ui: TabUIState): void {
  const uiStore = useUIStore.getState()
  for (const [projectId, tab] of Object.entries(ui.workspaceTabByProject)) {
    uiStore.setWorkspaceTab(projectId, tab)
  }
  for (const [projectId, segment] of Object.entries(ui.researchSegmentByProject)) {
    uiStore.setResearchSegment(projectId, segment)
  }
  for (const [projectId, tab] of Object.entries(ui.gitPanelTabByProject)) {
    useGitPanelStore.getState().setActiveTab(projectId, tab)
  }
  uiStore.setSidebarCollapsed(ui.sidebar.collapsed)
  uiStore.setSidebarWidth(ui.sidebar.width)
  uiStore.setChatSessionListRatio(ui.chatSessionListRatio)
  uiStore.setShowSessionStats(ui.showSessionStats)

  const viewer = useFileViewerStore.getState()
  viewer.setPinned(ui.viewer.pinned)
  viewer.setWidth(ui.viewer.width)
  // The empty-floating auto-collapse invariant outranks the snapshot: an
  // unpinned viewer with zero open tabs recedes to the docked rail (the same
  // rule closeFile/closeAllFiles/restoreProjectFiles enforce), so a restore
  // can never float an empty panel over the chat.
  viewer.setCollapsed(ui.viewer.collapsed || (!ui.viewer.pinned && viewer.openTabs.length === 0))

  useInputModeStore.setState({
    mode: ui.inputMode.mode,
    height: ui.inputMode.height,
    collapsedHeight: ui.inputMode.collapsedHeight,
    isExpanded: ui.inputMode.isExpanded,
  })
}

// --- Activation ---

/** The CHAT pseudo-project entry (No Project), discovered like SidebarHeader does. */
function findNoProject(projects: ProjectInfo[]): ProjectInfo | undefined {
  return projects.find((p) => p.is_no_project)
}

async function runActivation(switchProjectWithState: ProjectSwitcher, tabId: string): Promise<void> {
  const before = useTabStore.getState()
  // No-op: the requested tab is already active (nothing to capture or restore).
  if (tabId === before.activeTabId) return
  const target = before.tabs.find((t) => t.id === tabId)
  // The tab vanished while this activation sat in the queue (closed) — nothing to do.
  if (target === undefined) return

  // 1. Capture the outgoing tab's context + slices while it is still active.
  writeBack()

  // 2. Optimistic flip — the UI paints the incoming tab immediately.
  const outgoingId = before.activeTabId
  useTabStore.getState().activateTab(tabId)
  // Snapshot the incoming tab's remembered slices BEFORE any await: a
  // mid-switch write-back transiently re-mirrors live slices into the now
  // active tab, and the restore below must apply what the tab REMEMBERED,
  // not what the mirror overwrote it with.
  const rememberedUI = target.ui

  try {
    const projects = useProjectStore.getState()
    let destProjectId = target.projectId

    // Edge: the tab's project was deleted. Retarget the tab to the CHAT
    // pseudo-project and complete the activation there — the tab stays
    // usable and activeTabId stays put.
    if (destProjectId !== null && projects.projects !== null && !projects.projects.some((p) => p.id === destProjectId)) {
      const noProject = findNoProject(projects.projects)
      if (noProject === undefined) {
        throw new Error(`tab project "${destProjectId}" no longer exists and no CHAT pseudo-project is available`)
      }
      destProjectId = noProject.id
      useTabStore.getState().updateActiveContext({ projectId: noProject.id, sessionId: null })
    }

    if (destProjectId !== projects.activeProjectId) {
      // A CHAT tab (null) switches to the No Project pseudo-project entry.
      let switchTarget = destProjectId
      if (switchTarget === null) {
        const chat = projects.projects !== null ? findNoProject(projects.projects) : undefined
        if (chat === undefined) {
          throw new Error('cannot activate a CHAT tab: the CHAT pseudo-project is not available')
        }
        switchTarget = chat.id
      }
      // Different project (null = CHAT pseudo-project): the switch flow first
      // lands the workspace on the project's SHARED saved-session pointer
      // (saved session → latest → fresh session). That pointer is one value
      // per project — and the CHAT pseudo-project is one bucket for every
      // CHAT tab — so it cannot distinguish two same-project tabs. The tab's
      // OWN remembered session is restored explicitly below, mirroring the
      // same-project branch, so a round trip through another mode never
      // converges same-project (or CHAT) tabs onto one session. The final
      // write-back then converges the tab with whatever actually landed.
      await switchProjectWithState(switchTarget)

      // A deleted-project retarget cleared the tab's session above (the
      // remembered id belonged to a project that no longer exists) — the
      // switch flow's restore stands untouched for that edge.
      if (target.sessionId !== null && destProjectId === target.projectId) {
        const sessions = useSessionStore.getState()
        if (target.sessionId !== sessions.activeSessionId) {
          const deleted =
            sessions.sessions !== null &&
            !sessions.sessions.some((s) => s.id === target.sessionId)
          if (deleted) {
            useTabStore.getState().updateActiveContext({ sessionId: null })
          } else {
            sessions.selectSession(target.sessionId, switchTarget)
          }
        }
      }
    } else {
      // Same project: only the session may need to move. A deleted session is
      // dropped from the tab instead of being force-selected; the live
      // session is left alone and the final write-back converges the tab.
      const sessions = useSessionStore.getState()
      if (target.sessionId !== sessions.activeSessionId) {
        const deleted =
          target.sessionId !== null &&
          sessions.sessions !== null &&
          !sessions.sessions.some((s) => s.id === target.sessionId)
        if (deleted) {
          useTabStore.getState().updateActiveContext({ sessionId: null })
        } else {
          sessions.selectSession(target.sessionId, target.projectId ?? undefined)
        }
      }
    }
  } catch (error) {
    // Failure → roll the optimistic flip back. The live context may have
    // partially moved (the switch flow writes stores as it goes); the
    // write-back re-mirrors whatever live ended up as into the refocused
    // tab, keeping the "active tab mirrors live" invariant intact.
    logger.warn(`tabEngine: failed to activate tab; rolling back to the previous tab`, error)
    useTabStore.getState().activateTab(outgoingId)
    writeBack()
    return
  }

  // 3. Restore the remembered sync slices (validated fail-closed against the
  //    live scalar slices — garbage can never reach the stores).
  restoreSlices(restoreTabUI(rememberedUI, liveTabUIFallback()))

  // 4. Converge: mirror the live context (restored session ids included)
  //    into the active tab. Content-equal against the remembered snapshot,
  //    so a clean activation is a reference-stable no-op here.
  writeBack()
}

// --- Creation (the [addTab → activate] chain link) ---

/**
 * One chain link: seed a fresh tab from the LIVE stores (or the explicit
 * seed), then run the full activation path for it. Synchronous up to the
 * activation — addTab, the step-back and the seed capture cannot interleave
 * with anything.
 */
function runCreateActivation(switchProjectWithState: ProjectSwitcher, seed: TabCreateSeed): Promise<void> {
  // Resolve the seed NOW (link-run time, not click time): an in-flight
  // activation may have moved the workspace between the caller's click and
  // this link starting, and a fresh tab must inherit what the user sees the
  // moment it materializes.
  const projects = useProjectStore.getState()
  const sessions = useSessionStore.getState()
  const projectId = seed.projectId !== undefined ? seed.projectId : projects.activeProjectId
  const sessionId = seed.sessionId !== undefined ? seed.sessionId : sessions.activeSessionId
  const tabLayer = useTabStore.getState()
  const outgoingId = tabLayer.activeTabId
  // A live capture as the seed: the activation's restore re-applies what the
  // workspace already shows (the bare default snapshot would reset the input
  // panel), and the final write-back converges content-equal.
  const newTabId = useTabStore.getState().addTab({ projectId, sessionId, ui: captureLiveUI() })
  // addTab auto-activated the fresh tab; step back so the engine's FULL path
  // (not its already-active guard) materializes the context. Synchronous —
  // no intermediate active pointer can be painted.
  useTabStore.getState().activateTab(outgoingId)
  return runActivation(switchProjectWithState, newTabId)
}

// Activation chain — MODULE-level, shared by every engine instance (the
// AppLayout controller AND the bare engine in useNotificationClicks). Each
// activation's full body (capture → flip → switch/select → restore →
// write-back) completes before the next one starts — across ALL engines — so
// a banner-click activation can never interleave its store writes with an
// in-flight tab-click activation: the shared project switcher serializes only
// the project-switch segment, and the same-project branch has no switch (and
// therefore no serialization) at all. Tab CREATION rides the same chain
// (createAndActivate), so a «+» click cannot slide a fresh tab under an
// in-flight activation either. Neither entry ever rejects (all failures are
// caught and rolled back), but the chain link guards both settlements anyway
// so a future edit can never poison the queue.
let chain: Promise<void> = Promise.resolve()

// --- Engine factory ---

export function createTabEngine(switchProjectWithState: ProjectSwitcher): TabEngine {
  const enqueue = (link: () => Promise<void>): Promise<void> => {
    const run = chain.then(link, link)
    chain = run
    return run
  }

  const activate = (tabId: string): Promise<void> =>
    enqueue(() => runActivation(switchProjectWithState, tabId))

  const createAndActivate = (seed: TabCreateSeed = {}): Promise<void> =>
    enqueue(() => runCreateActivation(switchProjectWithState, seed))

  const attachWriteBack = (): (() => void) => {
    writeBack()
    const detachProject = useProjectStore.subscribe((s, prev) => {
      if (s.activeProjectId !== prev.activeProjectId) writeBack()
    })
    const detachSession = useSessionStore.subscribe((s, prev) => {
      if (s.activeSessionId !== prev.activeSessionId) writeBack()
    })
    const detachUI = useUIStore.subscribe((s, prev) => {
      if (
        s.workspaceTabByProject !== prev.workspaceTabByProject ||
        s.researchSegmentByProject !== prev.researchSegmentByProject ||
        s.sidebarCollapsed !== prev.sidebarCollapsed ||
        s.sidebarWidth !== prev.sidebarWidth ||
        s.chatSessionListRatio !== prev.chatSessionListRatio ||
        s.showSessionStats !== prev.showSessionStats
      ) {
        writeBack()
      }
    })
    const detachInput = useInputModeStore.subscribe((s, prev) => {
      if (
        s.mode !== prev.mode ||
        s.height !== prev.height ||
        s.collapsedHeight !== prev.collapsedHeight ||
        s.isExpanded !== prev.isExpanded
      ) {
        writeBack()
      }
    })
    const detachViewer = useFileViewerStore.subscribe((s, prev) => {
      if (s.pinned !== prev.pinned || s.collapsed !== prev.collapsed || s.width !== prev.width) {
        writeBack()
      }
    })
    const detachGitPanel = useGitPanelStore.subscribe((s, prev) => {
      if (s.activeTabByProject !== prev.activeTabByProject) writeBack()
    })
    return () => {
      detachProject()
      detachSession()
      detachUI()
      detachInput()
      detachViewer()
      detachGitPanel()
    }
  }

  return { activate, createAndActivate, writeBack, attachWriteBack }
}
