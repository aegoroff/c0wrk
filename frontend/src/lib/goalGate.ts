import { useSLMGateStore } from '@/stores/slmGateStore'

/**
 * Single source of truth for the goal-mode gate that the Small-LLM profile
 * imposes.
 *
 * The Small-LLM essential-tools variant NARROWS the tool set: goal-mode tools
 * are stripped before any selection runs, so an armed goal loop has no tools to
 * drive it. Goal mode is therefore unavailable while SLM is active AND its
 * essential-tools variant is engaged. Two DISTINCT booleans govern this and
 * both must hold:
 *   - `slmGateStore.enabled` — the resolved Small-LLM master toggle;
 *   - `slmGateStore.essentialToolsEnabled` — the resolved essential-tools
 *     variant sub-toggle.
 *
 * They are NOT interchangeable (master-on with the variant off leaves the tool
 * set untouched, so goal mode still works), and the composition must not be
 * re-derived as a hand-written `&&` at a call site where a term could be
 * dropped or swapped. It is defined here, once.
 *
 * Security/UX note: the gate is fail-safe — an unloaded ("unknown") config does
 * NOT block. Blocking is a UX guard only; the backend remains the authoritative
 * enforcement point.
 */

/** User-facing reason shown when goal mode is blocked by the SLM profile. */
export const GOAL_BLOCKED_BY_SLM_REASON =
  'Goal mode is unavailable while the Small-LLM profile is active with the ' +
  'Essential Tools variant enabled, because it narrows the tool set and ' +
  'removes the goal-mode tools. Disable the Essential Tools variant (or the ' +
  'Small-LLM profile) to use goal mode.'

/**
 * isGoalBlockedBySLM reports whether goal mode must be blocked: a loaded config
 * that has the Small-LLM master toggle AND its essential-tools variant both
 * enabled. Returns false while `loaded` is false (unknown) — the backend still
 * enforces the invariant, so an as-yet-unloaded gate must not block the user.
 * Called from the send path / event handlers, outside render.
 */
export function isGoalBlockedBySLM(): boolean {
  const { enabled, essentialToolsEnabled, loaded } = useSLMGateStore.getState()
  return loaded && enabled && essentialToolsEnabled
}

/**
 * goalBlockedBySLMReason returns the human-readable reason to surface when
 * goal mode is blocked, or an empty string when it is not. Pairs with
 * isGoalBlockedBySLM so consumers show the reason only when the gate blocks.
 */
export function goalBlockedBySLMReason(): string {
  return isGoalBlockedBySLM() ? GOAL_BLOCKED_BY_SLM_REASON : ''
}
