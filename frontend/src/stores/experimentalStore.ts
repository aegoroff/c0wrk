import { create } from 'zustand'

/**
 * Master experimental-features switch, loaded once from GetConfig and updated
 * in place when the user toggles it in Settings. Gated features (the Small-LLM
 * profile and the E2S execution mode) read their availability reactively so
 * hiding/revealing happens within the same session without a reload.
 *
 * This switch is the SOLE gate for both gated features — there is no
 * per-feature config toggle. In particular E2S availability is exactly
 * `enabled`, which is DISTINCT from `inputModeStore.e2sEnabled`, the user's
 * per-message ARMED toggle: availability is a config fact, arming is a user
 * preference, and a fail-closed gate must combine BOTH. The composition lives
 * in exactly one place (`lib/e2sGate`) so no call site can substitute one flag
 * for the other.
 */
interface ExperimentalState {
  enabled: boolean
  loaded: boolean
}

interface ExperimentalActions {
  setEnabled: (enabled: boolean) => void
  setLoaded: (loaded: boolean) => void
}

export const useExperimentalStore = create<ExperimentalState & ExperimentalActions>((set) => ({
  enabled: false,
  loaded: false,
  setEnabled: (enabled) => set({ enabled }),
  setLoaded: (loaded) => set({ loaded }),
}))
