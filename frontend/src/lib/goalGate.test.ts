import { describe, it, expect, beforeEach } from 'vitest'
import {
  isGoalBlockedByModelProfiles,
  goalBlockedByModelProfilesReason,
  GOAL_BLOCKED_BY_MODEL_PROFILES_REASON,
} from './goalGate'
import { useModelProfilesGateStore } from '@/stores/modelProfilesGateStore'

// The goal gate is the single composition of the Model Profiles master toggle and
// its essential-tools variant sub-toggle. These tests lock the truth table so a
// fail-open edit (a dropped term or a swapped flag) is caught.
beforeEach(() => {
  useModelProfilesGateStore.setState({ enabled: false, essentialToolsEnabled: false, loaded: false })
})

describe('isGoalBlockedByModelProfiles', () => {
  // The four combinations of the two feature flags, with a loaded config.
  it.each([
    { enabled: false, essentialToolsEnabled: false, expected: false },
    { enabled: false, essentialToolsEnabled: true, expected: false },
    { enabled: true, essentialToolsEnabled: false, expected: false },
    { enabled: true, essentialToolsEnabled: true, expected: true },
  ])(
    'loaded config: enabled=$enabled essentialToolsEnabled=$essentialToolsEnabled -> $expected',
    ({ enabled, essentialToolsEnabled, expected }) => {
      useModelProfilesGateStore.setState({ enabled, essentialToolsEnabled, loaded: true })
      expect(isGoalBlockedByModelProfiles()).toBe(expected)
    },
  )

  it('blocks only when BOTH flags are on (explicit composition check)', () => {
    useModelProfilesGateStore.setState({ enabled: true, essentialToolsEnabled: false, loaded: true })
    expect(isGoalBlockedByModelProfiles()).toBe(false)
    useModelProfilesGateStore.setState({ enabled: false, essentialToolsEnabled: true, loaded: true })
    expect(isGoalBlockedByModelProfiles()).toBe(false)
    useModelProfilesGateStore.setState({ enabled: true, essentialToolsEnabled: true, loaded: true })
    expect(isGoalBlockedByModelProfiles()).toBe(true)
  })

  it('does NOT block while the config is not loaded (unknown)', () => {
    // Both flags on but the gate is still "unknown": the backend still
    // enforces, so the UI must not block on an unloaded config.
    useModelProfilesGateStore.setState({ enabled: true, essentialToolsEnabled: true, loaded: false })
    expect(isGoalBlockedByModelProfiles()).toBe(false)
  })

  it('does NOT block on the default (fresh) store state', () => {
    expect(useModelProfilesGateStore.getState()).toMatchObject({
      enabled: false,
      essentialToolsEnabled: false,
      loaded: false,
    })
    expect(isGoalBlockedByModelProfiles()).toBe(false)
  })
})

describe('goalBlockedByModelProfilesReason', () => {
  it('returns the reason text when blocked', () => {
    useModelProfilesGateStore.setState({ enabled: true, essentialToolsEnabled: true, loaded: true })
    expect(goalBlockedByModelProfilesReason()).toBe(GOAL_BLOCKED_BY_MODEL_PROFILES_REASON)
    expect(goalBlockedByModelProfilesReason()).not.toBe('')
  })

  it('returns an empty string when not blocked', () => {
    useModelProfilesGateStore.setState({ enabled: true, essentialToolsEnabled: false, loaded: true })
    expect(goalBlockedByModelProfilesReason()).toBe('')

    useModelProfilesGateStore.setState({ enabled: true, essentialToolsEnabled: true, loaded: false })
    expect(goalBlockedByModelProfilesReason()).toBe('')
  })
})
