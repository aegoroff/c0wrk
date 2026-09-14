import { useModelProfilesGateStore } from '@/stores/modelProfilesGateStore'

/**
 * Single definition of the goal-mode gate that the Model Profiles profile imposes.
 *
 * Goal mode is refused while the Model Profiles profile is active AND its Essential
 * Tools variant is engaged. The essential-tools narrowing is applied only to
 * the non-goal Conductor path and the E2S branch (both run after goal mode's
 * early return), so it never narrows a goal run; if it were applied to a goal
 * run it would hide the goal-loop tooling (propose_goal, declare_goal_status,
 * declare_verification) and make the loop unrunnable — which is why goal mode
 * is refused while the narrowing is active.
 *
 * Two DISTINCT booleans govern this and both must hold:
 *   - `modelProfilesGateStore.enabled` — the resolved Model Profiles master toggle;
 *   - `modelProfilesGateStore.essentialToolsEnabled` — the resolved essential-tools
 *     variant sub-toggle.
 *
 * They are NOT interchangeable (master-on with the variant off leaves the tool
 * set untouched, so goal mode still works). The composition is defined here,
 * once, so no call site can substitute one flag for the other: the reactive
 * consumer is `useModelProfilesGate` (which subscribes to the store and returns
 * `isGoalBlockedByModelProfiles()`), and `goalBlockedByModelProfilesReason` yields the user-facing
 * reason for non-reactive consumers.
 *
 * Security/UX note: the gate is fail-safe — an unloaded ("unknown") config does
 * NOT block. Blocking is a UX guard only; the backend remains the authoritative
 * enforcement point.
 */

/** User-facing reason shown when goal mode is blocked by the ModelProfiles profile. */
export const GOAL_BLOCKED_BY_MODEL_PROFILES_REASON =
  'Goal mode is unavailable while the Model Profiles profile is active with the ' +
  'Essential Tools variant enabled. Disable the Essential Tools variant (or ' +
  'the Model Profiles profile) to use goal mode.'

/**
 * isGoalBlockedByModelProfiles reports whether goal mode must be blocked: a loaded config
 * that has the Model Profiles master toggle AND its essential-tools variant both
 * enabled. Returns false while `loaded` is false (unknown) — the backend still
 * enforces the invariant, so an as-yet-unloaded gate must not block. The
 * reactive consumer is `useModelProfilesGate`, which subscribes to the store (for
 * re-rendering) and returns this value.
 */
export function isGoalBlockedByModelProfiles(): boolean {
  const { enabled, essentialToolsEnabled, loaded } = useModelProfilesGateStore.getState()
  return loaded && enabled && essentialToolsEnabled
}

/**
 * goalBlockedByModelProfilesReason returns the human-readable reason to surface when
 * goal mode is blocked, or an empty string when it is not. Pairs with
 * isGoalBlockedByModelProfiles so consumers show the reason only when the gate blocks.
 */
export function goalBlockedByModelProfilesReason(): string {
  return isGoalBlockedByModelProfiles() ? GOAL_BLOCKED_BY_MODEL_PROFILES_REASON : ''
}
