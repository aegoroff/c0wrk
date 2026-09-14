import { create } from 'zustand'

/**
 * Small-LLM gate state, loaded once from GetConfig (the effective/resolved SLM
 * section — see `useSLMGate`) and the single source of truth for the goal-mode
 * block that the SLM profile implies.
 *
 * This store carries THREE facts, not one:
 *   - `enabled` — the resolved Small-LLM master toggle (config `slm.enabled`,
 *     already folded with the experimental gate by the backend).
 *   - `essentialToolsEnabled` — the resolved essential-tools variant
 *     sub-toggle. When on, the profile NARROWS the tool set (goal-mode tools
 *     are stripped before selection), which makes goal mode unusable.
 *   - `loaded` — whether a live (non-startup-race) config has been latched yet.
 *
 * The two feature flags are DISTINCT and both must be on for the goal block;
 * the composition lives in exactly one place (`lib/goalGate`) so no call site
 * can substitute one flag for the other. While `loaded` is false the gate is
 * "unknown" and must NOT block — the backend still enforces the invariant.
 */
interface SLMGateState {
  enabled: boolean
  essentialToolsEnabled: boolean
  loaded: boolean
}

interface SLMGateActions {
  setEnabled: (enabled: boolean) => void
  setEssentialToolsEnabled: (essentialToolsEnabled: boolean) => void
  setLoaded: (loaded: boolean) => void
}

export const useSLMGateStore = create<SLMGateState & SLMGateActions>((set) => ({
  enabled: false,
  essentialToolsEnabled: false,
  loaded: false,
  setEnabled: (enabled) => set({ enabled }),
  setEssentialToolsEnabled: (essentialToolsEnabled) => set({ essentialToolsEnabled }),
  setLoaded: (loaded) => set({ loaded }),
}))
