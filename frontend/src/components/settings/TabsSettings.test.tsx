// @vitest-environment jsdom
//
// TabsSettings — the Appearance-tab switch over uiStore.tabsEnabled.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TabsSettings } from './TabsSettings'
import { useUIStore } from '@/stores/uiStore'

let container: HTMLDivElement
let root: Root

function renderSection(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<TabsSettings />)
  })
}

function toggleInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!input) throw new Error('Tabs toggle not found')
  return input
}

beforeEach(() => {
  useUIStore.setState({ tabsEnabled: false })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  document.body.innerHTML = ''
})

describe('TabsSettings', () => {
  it('renders the Tabs section with the flag off by default', () => {
    renderSection()
    expect(container.textContent).toContain('Tabs')
    expect(toggleInput().checked).toBe(false)
  })

  it('toggles uiStore.tabsEnabled on and off', () => {
    renderSection()
    act(() => {
      toggleInput().click()
    })
    expect(useUIStore.getState().tabsEnabled).toBe(true)
    expect(toggleInput().checked).toBe(true)

    act(() => {
      toggleInput().click()
    })
    expect(useUIStore.getState().tabsEnabled).toBe(false)
  })

  it('reflects an externally enabled flag (checked state follows the store)', () => {
    act(() => {
      useUIStore.setState({ tabsEnabled: true })
    })
    renderSection()
    expect(toggleInput().checked).toBe(true)
    expect(container.textContent).toContain('Enabled')
  })
})
