import { create } from 'zustand'
import {
  createDefaultTabUI,
  fallbackFromTabUI,
  isSameTabUI,
  sanitizeTabUI,
  type TabUIState,
} from '@/lib/tabSnapshot'

// --- Model ---

/**
 * A workspace tab: the outermost context layer of the app (which project and
 * which session the workspace shows, plus the captured per-tab UI slices).
 *
 * The tab layer exists ALWAYS: when `uiStore.tabsEnabled` is false the UI
 * simply never renders the create/close controls, so the layer degenerates to
 * its "exactly one tab" special case — the invariant below still holds and
 * enabling the flag just reveals a tab bar above the already-living single
 * tab. There are deliberately no flag-driven lifecycle transitions.
 */
export interface Tab {
  id: string
  /** Owning project, or null (CHAT / No Project). */
  projectId: string | null
  /** Active session within the tab, or null (no session opened yet). */
  sessionId: string | null
  /** Captured UI slices (see lib/tabSnapshot) — restored on tab activation. */
  ui: TabUIState
}

/** Optional initializer for a new tab. `undefined` fields mean "the default". */
export interface TabInit {
  projectId?: string | null
  sessionId?: string | null
  /** Raw tab-UI payload — validated fail-closed via sanitizeTabUI. */
  ui?: unknown
}

/**
 * Context patch for the ACTIVE tab. `undefined` = "leave unchanged",
 * `null` (project/session) = "clear to No Project / no session".
 */
export interface TabContextPatch {
  projectId?: string | null
  sessionId?: string | null
  /** Replacement UI snapshot — sanitized fail-closed before it is stored. */
  ui?: unknown
}

interface TabState {
  tabs: Tab[]
  activeTabId: string
}

interface TabActions {
  /** Append a tab and activate it. Returns the new tab's id. */
  addTab: (init?: TabInit) => string
  /**
   * Close a tab. Closing the active tab activates its right neighbor (or the
   * last tab when the rightmost one closes). Closing the LAST remaining tab
   * never empties the layer: it is replaced by a fresh default tab.
   */
  closeTab: (id: string) => void
  /** Activate an existing tab. Unknown ids are a no-op. */
  activateTab: (id: string) => void
  /** Patch the active tab's context (project/session and/or UI snapshot). */
  updateActiveContext: (patch: TabContextPatch) => void
}

// --- Factories ---

function generateTabId(): string {
  return crypto.randomUUID()
}

/**
 * Pure tab factory: a new tab with a fresh id and a sanitized UI payload
 * (invalid init fields are discarded — a tab can never be born with a
 * rehydratable-garbage context).
 */
export function createTab(init?: TabInit): Tab {
  return {
    id: generateTabId(),
    projectId: init?.projectId ?? null,
    sessionId: init?.sessionId ?? null,
    ui: init?.ui !== undefined ? sanitizeTabUI(init.ui) : createDefaultTabUI(),
  }
}

// --- Selectors ---

/**
 * Pure selector: the active tab, or null should the invariant ever be violated
 * (it never is — see the store invariants). `find` returns the stored element
 * reference or null: allocation-free, referentially stable across unrelated
 * updates, so `useTabStore(selectActiveTab)` re-renders only when the active
 * tab object itself is replaced.
 */
export function selectActiveTab(state: Pick<TabState, 'tabs' | 'activeTabId'>): Tab | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
}

// --- Store ---

/**
 * The workspace tab layer. TRANSIENT by design: tabs are an app-lifetime UI
 * arrangement, not persisted state — a restart starts from a single default
 * tab. The durable per-tab context lives in the snapshot slices themselves
 * (workspaceTabByProject / researchSegmentByProject persist in uiStore, the
 * input-panel fields in inputModeStore); only `uiStore.tabsEnabled` (whether
 * the tab bar renders) is persisted.
 *
 * Invariants (every action maintains them):
 *   1. `tabs.length >= 1` — the layer is never empty.
 *   2. `activeTabId` always references an element of `tabs`.
 *   3. Actions that change nothing return the SAME state object
 *      (reference-stable no-ops, mirroring setWorkspaceTab).
 */
export const useTabStore = create<TabState & TabActions>()((set) => {
  const initialTab = createTab()
  return {
    tabs: [initialTab],
    activeTabId: initialTab.id,

    addTab: (init) => {
      const tab = createTab(init)
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
      return tab.id
    },

    closeTab: (id) =>
      set((s) => {
        const index = s.tabs.findIndex((tab) => tab.id === id)
        if (index === -1) return s
        if (s.tabs.length === 1) {
          // Invariant 1: the last tab is replaced, never removed.
          const fresh = createTab()
          return { tabs: [fresh], activeTabId: fresh.id }
        }
        const tabs = s.tabs.filter((tab) => tab.id !== id)
        if (id !== s.activeTabId) return { tabs }
        const next = tabs[Math.min(index, tabs.length - 1)]
        return next !== undefined ? { tabs, activeTabId: next.id } : { tabs }
      }),

    activateTab: (id) =>
      set((s) => {
        if (id === s.activeTabId) return s
        if (!s.tabs.some((tab) => tab.id === id)) return s
        return { activeTabId: id }
      }),

    updateActiveContext: (patch) =>
      set((s) => {
        const active = s.tabs.find((tab) => tab.id === s.activeTabId)
        if (active === undefined) return s
        const projectId = patch.projectId !== undefined ? patch.projectId : active.projectId
        const sessionId = patch.sessionId !== undefined ? patch.sessionId : active.sessionId
        // Re-sanitize against the active tab's own stored snapshot: every
        // scalar slice (input/sidebar/viewer/ratio/stats) falls back to what
        // the tab already remembers, so a partial payload never wipes a
        // remembered value with a boot default.
        const sanitized =
          patch.ui !== undefined ? sanitizeTabUI(patch.ui, fallbackFromTabUI(active.ui)) : active.ui
        // A content-equal snapshot keeps the stored reference (no-op stays a
        // reference-stable no-op even when the caller re-captured the slices).
        const ui = sanitized !== active.ui && isSameTabUI(sanitized, active.ui) ? active.ui : sanitized
        if (projectId === active.projectId && sessionId === active.sessionId && ui === active.ui) {
          return s
        }
        const nextTab: Tab = { ...active, projectId, sessionId, ui }
        return { tabs: s.tabs.map((tab) => (tab.id === active.id ? nextTab : tab)) }
      }),
  }
})

// --- Hooks (stable selectors — no per-call allocations) ---

/** The tab list (direct store reference — never copied). */
export const useTabs = (): Tab[] => useTabStore((s) => s.tabs)

/** The active tab id (primitive). */
export const useActiveTabId = (): string => useTabStore((s) => s.activeTabId)

/** The active tab (stored element reference or null — see selectActiveTab). */
export const useActiveTab = (): Tab | null => useTabStore(selectActiveTab)
