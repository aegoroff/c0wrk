import { describe, it, expect, beforeEach } from 'vitest'
import { useIndexingSettingsStore } from './indexingSettingsStore'

beforeEach(() => {
  useIndexingSettingsStore.setState({ enabled: true, loaded: false })
})

describe('indexingSettingsStore', () => {
  it('defaults to enabled=true (the resolved config default) and loaded=false', () => {
    expect(useIndexingSettingsStore.getState().enabled).toBe(true)
    expect(useIndexingSettingsStore.getState().loaded).toBe(false)
  })

  it('setEnabled flips the gate for the index surfaces', () => {
    useIndexingSettingsStore.getState().setEnabled(false)
    expect(useIndexingSettingsStore.getState().enabled).toBe(false)
    expect(useIndexingSettingsStore.getState().loaded).toBe(false)

    useIndexingSettingsStore.getState().setEnabled(true)
    expect(useIndexingSettingsStore.getState().enabled).toBe(true)
  })

  it('setLoaded marks the switch as read without touching enabled', () => {
    useIndexingSettingsStore.getState().setEnabled(false)
    useIndexingSettingsStore.getState().setLoaded(true)
    expect(useIndexingSettingsStore.getState()).toMatchObject({ enabled: false, loaded: true })
  })
})
