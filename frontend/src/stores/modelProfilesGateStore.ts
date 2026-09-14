import { create } from 'zustand'

/**
 * Model Profiles gate state, loaded once from GetConfig (the effective/resolved ModelProfiles
 * section — see `useModelProfilesGate`) and the single source of truth for the goal-mode
 * block that the ModelProfiles profile implies.
 *
 * This store carries THREE facts, not one:
 *   - `enabled` — the resolved Model Profiles master toggle (config `model_profiles.enabled`,
 *     already folded with the experimental gate by the backend).
 *   - `essentialToolsEnabled` — the resolved essential-tools variant
 *     sub-toggle. When on, goal mode is refused: the narrowing is applied only
 *     to the non-goal Conductor path and the E2S branch (both run after goal
 *     mode's early return), so it never narrows a goal run; if it were applied
 *     to a goal run it would hide the goal-loop tooling (propose_goal,
 *     declare_goal_status, declare_verification) and make the loop unrunnable.
 *   - `loaded` — whether a live (non-startup-race) config has been latched yet.
 *
 * The two feature flags are DISTINCT and both must be on for the goal block;
 * the composition lives in exactly one place (`lib/goalGate`) so no call site
 * can substitute one flag for the other. While `loaded` is false the gate is
 * "unknown" and must NOT block — the backend still enforces the invariant.
 */
interface ModelProfilesGateState {
  enabled: boolean
  essentialToolsEnabled: boolean
  loaded: boolean
}

interface ModelProfilesGateActions {
  setEnabled: (enabled: boolean) => void
  setEssentialToolsEnabled: (essentialToolsEnabled: boolean) => void
  setLoaded: (loaded: boolean) => void
}

export const useModelProfilesGateStore = create<ModelProfilesGateState & ModelProfilesGateActions>((set) => ({
  enabled: false,
  essentialToolsEnabled: false,
  loaded: false,
  setEnabled: (enabled) => set({ enabled }),
  setEssentialToolsEnabled: (essentialToolsEnabled) => set({ essentialToolsEnabled }),
  setLoaded: (loaded) => set({ loaded }),
}))
