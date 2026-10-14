// @vitest-environment jsdom
//
// SidebarHeader — the Settings gear follows the tab-bar flag: when the
// workspace tab bar is enabled it carries its own Settings affordance and
// the header drops its gear; disabled, the header keeps today's UI.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The radar indicator drags its own store/api subtree — not under test here.
vi.mock('./ActiveSessionsIndicator', () => ({ ActiveSessionsIndicator: () => null }))
vi.mock('@/hooks/useProjectSwitchState', () => ({ useProjectSwitchState: () => async () => {} }))

import { SidebarHeader } from './SidebarHeader'
import { useUIStore } from '@/stores/uiStore'
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
  useProjectStore.setState({ projects: null })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  document.body.innerHTML = ''
})

describe('SidebarHeader settings gear vs the tab-bar flag', () => {
  it('keeps the gear when the tab bar is off (today\'s UI)', () => {
    renderHeader()
    expect(gear()).not.toBeNull()
  })

  it('drops the gear when the tab bar is on (the bar carries Settings)', () => {
    act(() => {
      useUIStore.setState({ tabsEnabled: true })
    })
    renderHeader()
    expect(gear()).toBeNull()
    // The rest of the header is untouched — collapse and mode toggles stay.
    expect(container.querySelector('button[aria-label="Collapse sidebar"]')).not.toBeNull()
  })

  it('re-gains the gear when the flag turns off again', () => {
    act(() => {
      useUIStore.setState({ tabsEnabled: true })
    })
    renderHeader()
    expect(gear()).toBeNull()
    act(() => {
      useUIStore.setState({ tabsEnabled: false })
    })
    expect(gear()).not.toBeNull()
  })
})
