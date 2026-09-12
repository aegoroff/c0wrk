import { create } from 'zustand'

/**
 * Master experimental-features switch, loaded once from GetConfig and updated
 * in place when the user toggles it in Settings. Gated features (the Small-LLM
 * profile and the E2S execution mode) read their availability reactively so
 * hiding/revealing happens within the same session without a reload.
 *
 * `e2sConfigEnabled` mirrors the E2S-specific `e2s.enabled` config toggle. It is
 * deliberately named `e2sConfigEnabled` (NOT `e2sEnabled`) so it can never be
 * confused with `inputModeStore.e2sEnabled`, the user's per-message ARMED
 * toggle — availability is a config fact, arming is a user preference, and a
 * fail-closed gate must combine BOTH. The composition lives in exactly one
 * place (`lib/e2sGate`) so no call site can substitute one flag for the other.
 */
interface ExperimentalState {
  enabled: boolean
  e2sConfigEnabled: boolean
  loaded: boolean
}

interface ExperimentalActions {
  setEnabled: (enabled: boolean) => void
  setE2SConfigEnabled: (e2sConfigEnabled: boolean) => void
  setLoaded: (loaded: boolean) => void
}

export const useExperimentalStore = create<ExperimentalState & ExperimentalActions>((set) => ({
  enabled: false,
  e2sConfigEnabled: false,
  loaded: false,
  setEnabled: (enabled) => set({ enabled }),
  setE2SConfigEnabled: (e2sConfigEnabled) => set({ e2sConfigEnabled }),
  setLoaded: (loaded) => set({ loaded }),
}))
