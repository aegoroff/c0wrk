import { describe, it, expect, beforeEach } from 'vitest'
import { isE2SAvailable, isE2SSendEnabled } from './e2sGate'
import { useExperimentalStore } from '@/stores/experimentalStore'
import { useInputModeStore } from '@/stores/inputModeStore'

// The E2S send gate is fail-closed and composes two DISTINCT booleans from two
// stores: the experimental availability gate and the user's armed per-message
// toggle. These tests lock the composition so a fail-open edit (a dropped term
// or a swapped flag) is caught.
beforeEach(() => {
  useExperimentalStore.setState({ enabled: false, loaded: false })
  useInputModeStore.setState({ e2sEnabled: false, goalEnabled: false, goalBudget: '' })
})

describe('isE2SAvailable', () => {
  it('is false while the experimental master switch is off', () => {
    useExperimentalStore.setState({ enabled: false })
    expect(isE2SAvailable()).toBe(false)
  })

  it('is true when the experimental master switch is on', () => {
    useExperimentalStore.setState({ enabled: true })
    expect(isE2SAvailable()).toBe(true)
  })
})

describe('isE2SSendEnabled', () => {
  it('is false when available but the toggle is not armed', () => {
    useExperimentalStore.setState({ enabled: true })
    useInputModeStore.setState({ e2sEnabled: false })
    expect(isE2SSendEnabled()).toBe(false)
  })

  it('is true when available and armed', () => {
    useExperimentalStore.setState({ enabled: true })
    useInputModeStore.setState({ e2sEnabled: true })
    expect(isE2SSendEnabled()).toBe(true)
  })

  it('fails closed when armed but unavailable (stale persisted toggle)', () => {
    // The critical case: a persisted arming outliving the gate must never
    // produce an E2S send the backend would reject.
    useExperimentalStore.setState({ enabled: false })
    useInputModeStore.setState({ e2sEnabled: true })
    expect(isE2SSendEnabled()).toBe(false)
  })
})
