import { useExperimentalStore } from '@/stores/experimentalStore'
import { useInputModeStore } from '@/stores/inputModeStore'

/**
 * Single source of truth for the E2S gating rules.
 *
 * Two DISTINCT booleans govern E2S and live in different stores:
 *   - `experimentalStore.e2sConfigEnabled` — the configuration master gate
 *     (mirrors config `e2s.enabled`), combined with the experimental master
 *     switch `experimentalStore.enabled`. Named `e2sConfigEnabled`, NOT
 *     `e2sEnabled`, precisely so it can never be mistaken for the armed toggle.
 *   - `inputModeStore.e2sEnabled` — the user's per-message ARMED toggle.
 *
 * They are NOT interchangeable: availability is a configuration fact, arming is
 * a user preference. The send gate composes BOTH, so a hand-written `&&` chain
 * at the call site risks a fail-open edit (dropping a term, or swapping the
 * armed flag for the config flag). The gate is therefore defined here, once.
 *
 * Security note: the gate is fail-closed. An unloaded or zeroed config leaves
 * the availability false, and the armed toggle alone can never enable a send.
 */

/** isE2SAvailable reports whether the E2S mode may be offered at all: the
 *  experimental master switch AND `e2s.enabled` must both be on. */
export function isE2SAvailable(): boolean {
  const s = useExperimentalStore.getState()
  return s.enabled && s.e2sConfigEnabled
}

/**
 * isE2SSendEnabled is the E2S SEND GATE — the single definition of whether a
 * message may be dispatched in E2S mode: the mode must be AVAILABLE
 * (isE2SAvailable) AND the user must have ARMED the toggle. Called from the
 * send path, outside render.
 */
export function isE2SSendEnabled(): boolean {
  return isE2SAvailable() && useInputModeStore.getState().e2sEnabled
}
