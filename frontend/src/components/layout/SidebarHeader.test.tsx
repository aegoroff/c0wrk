// @vitest-environment jsdom
//
// SidebarHeader — the Settings gear lives here in BOTH tab-bar modes: it is
// unconditional (the same single entry point it has always been), whether the
// workspace tab bar is enabled or not.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The radar indicator drags its own store/api subtree — not under test here.
vi.mock('./ActiveSessionsIndicator', () => ({ ActiveSessionsIndicator: () => null }))
vi.mock('@/hooks/useProjectSwitchState', () => ({ useProjectSwitchState: () => async () => {} }))

import { SidebarHeader } from './SidebarHeader'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useProjectStore } from '@/stores/projectStore'

let container: HTMLDivElement
let root: Root

function renderHeader(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<SidebarHeader onToggleCollapse={() => {}} collapsed={false} />)
  })
}

function gear(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
}

beforeEach(() => {
  useUIStore.setState({ tabsEnabled: false })
  useSettingsStore.setState({ open: false, activeTab: 'general' })
  useProjectStore.setState({ projects: null })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  document.body.innerHTML = ''
})

describe('SidebarHeader settings gear', () => {
  it("renders the gear with the tab bar off (today's UI)", () => {
    renderHeader()
    expect(gear()).not.toBeNull()
  })

  it('renders the gear with the tab bar on too (the header keeps its entry point)', () => {
    act(() => {
      useUIStore.setState({ tabsEnabled: true })
    })
    renderHeader()
    // The rest of the header is untouched — collapse and mode toggles stay.
    expect(container.querySelector('button[aria-label="Collapse sidebar"]')).not.toBeNull()
    expect(gear()).not.toBeNull()
  })

  it('opens Settings on the default tab', () => {
    renderHeader()
    act(() => {
      gear()?.click()
    })
    const settings = useSettingsStore.getState()
    expect(settings.open).toBe(true)
    expect(settings.activeTab).toBe('general')
  })
})
