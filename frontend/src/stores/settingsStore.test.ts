// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'

import { useSettingsStore } from '@/stores/settingsStore'

// settingsStore is a plain in-memory zustand store (no persistence, no RPC):
// the only behavioral surface is the open flag plus the active tab identity —
// and the tab id is what other components pass to openSettings, so the
// 'capabilities' id (the former 'mcp' tab) is pinned here.

describe('settingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({ open: false, activeTab: 'general' })
  })

  it('opens on the requested tab', () => {
    useSettingsStore.getState().openSettings('capabilities')
    expect(useSettingsStore.getState().open).toBe(true)
    expect(useSettingsStore.getState().activeTab).toBe('capabilities')
  })

  it('opens on General when no tab is given', () => {
    useSettingsStore.getState().openSettings()
    expect(useSettingsStore.getState().open).toBe(true)
    expect(useSettingsStore.getState().activeTab).toBe('general')
  })

  it('switches tabs and closes independently', () => {
    useSettingsStore.getState().openSettings('capabilities')
    useSettingsStore.getState().setActiveTab('security')
    expect(useSettingsStore.getState().activeTab).toBe('security')
    useSettingsStore.getState().closeSettings()
    expect(useSettingsStore.getState().open).toBe(false)
    // Closing keeps the last active tab so reopening restores the view.
    expect(useSettingsStore.getState().activeTab).toBe('security')
  })
})
