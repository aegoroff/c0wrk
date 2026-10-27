import { create } from 'zustand'

/**
 * Indexing-policy master switch (config `vector_index.enabled`): the single
 * frontend gate for every index-dependent surface — the workspace panel's
 * Search (semantics) tab, the status-bar indexing indicator, and the file
 * viewer's "Find similar" context-menu entry. Loaded once from GetConfig by
 * `useIndexingSettings`; after the initial hydration, Settings
 * (`IndexingSettings`) keeps the store in sync directly via `setEnabled`
 * after every successful `UpdateIndexingSettings` save.
 *
 * `enabled` defaults to TRUE — the backend's resolved default for a config
 * that predates the knob (`vector_index.enabled` absent = on, the historical
 * always-on behavior). While `loaded` is false (config not yet read — the
 * splash/startup race), the gated surfaces therefore render as they always
 * did and snap to the persisted value once the config lands; only an
 * explicit opt-out hides them.
 */
interface IndexingSettingsState {
  enabled: boolean
  loaded: boolean
}

interface IndexingSettingsActions {
  setEnabled: (enabled: boolean) => void
  setLoaded: (loaded: boolean) => void
}

export const useIndexingSettingsStore = create<IndexingSettingsState & IndexingSettingsActions>((set) => ({
  enabled: true,
  loaded: false,
  setEnabled: (enabled) => set({ enabled }),
  setLoaded: (loaded) => set({ loaded }),
}))
