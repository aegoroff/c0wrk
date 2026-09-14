import { describe, it, expect, beforeEach } from 'vitest'
import {
  isGoalBlockedBySLM,
  goalBlockedBySLMReason,
  GOAL_BLOCKED_BY_SLM_REASON,
} from './goalGate'
import { useSLMGateStore } from '@/stores/slmGateStore'

// The goal gate is the single composition of the Small-LLM master toggle and
// its essential-tools variant sub-toggle. These tests lock the truth table so a
// fail-open edit (a dropped term or a swapped flag) is caught.
beforeEach(() => {
  useSLMGateStore.setState({ enabled: false, essentialToolsEnabled: false, loaded: false })
})

describe('isGoalBlockedBySLM', () => {
  // The four combinations of the two feature flags, with a loaded config.
  it.each([
    { enabled: false, essentialToolsEnabled: false, expected: false },
    { enabled: false, essentialToolsEnabled: true, expected: false },
    { enabled: true, essentialToolsEnabled: false, expected: false },
    { enabled: true, essentialToolsEnabled: true, expected: true },
  ])(
    'loaded config: enabled=$enabled essentialToolsEnabled=$essentialToolsEnabled -> $expected',
    ({ enabled, essentialToolsEnabled, expected }) => {
      useSLMGateStore.setState({ enabled, essentialToolsEnabled, loaded: true })
      expect(isGoalBlockedBySLM()).toBe(expected)
    },
  )

  it('blocks only when BOTH flags are on (explicit composition check)', () => {
    useSLMGateStore.setState({ enabled: true, essentialToolsEnabled: false, loaded: true })
    expect(isGoalBlockedBySLM()).toBe(false)
    useSLMGateStore.setState({ enabled: false, essentialToolsEnabled: true, loaded: true })
    expect(isGoalBlockedBySLM()).toBe(false)
    useSLMGateStore.setState({ enabled: true, essentialToolsEnabled: true, loaded: true })
    expect(isGoalBlockedBySLM()).toBe(true)
  })

  it('does NOT block while the config is not loaded (unknown)', () => {
    // Both flags on but the gate is still "unknown": the backend still
    // enforces, so the UI must not block on an unloaded config.
    useSLMGateStore.setState({ enabled: true, essentialToolsEnabled: true, loaded: false })
    expect(isGoalBlockedBySLM()).toBe(false)
  })

  it('does NOT block on the default (fresh) store state', () => {
    expect(useSLMGateStore.getState()).toMatchObject({
      enabled: false,
      essentialToolsEnabled: false,
      loaded: false,
    })
    expect(isGoalBlockedBySLM()).toBe(false)
  })
})

describe('goalBlockedBySLMReason', () => {
  it('returns the reason text when blocked', () => {
    useSLMGateStore.setState({ enabled: true, essentialToolsEnabled: true, loaded: true })
    expect(goalBlockedBySLMReason()).toBe(GOAL_BLOCKED_BY_SLM_REASON)
    expect(goalBlockedBySLMReason()).not.toBe('')
  })

  it('returns an empty string when not blocked', () => {
    useSLMGateStore.setState({ enabled: true, essentialToolsEnabled: false, loaded: true })
    expect(goalBlockedBySLMReason()).toBe('')

    useSLMGateStore.setState({ enabled: true, essentialToolsEnabled: true, loaded: false })
    expect(goalBlockedBySLMReason()).toBe('')
  })
})
