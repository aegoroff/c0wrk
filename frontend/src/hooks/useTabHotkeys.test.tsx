// @vitest-environment jsdom
//
// useTabHotkeys — the system-standard tab-cycling shortcuts.
//
// The controller is faked (the engine has its own suite); the tab layer and
// the flag are the real stores. Host-platform detection is pinned per test
// via navigator.platform/userAgent (the project convention, cf.
// lib/platform.test.ts) — the hook probes at effect mount, so pins precede
// every render.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useTabHotkeys } from './useTabHotkeys'
import { createTab, useTabStore, type Tab } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import type { TabController } from '@/hooks/useTabController'

// --- fixtures ---

function fakeController(): TabController {
  return {
    activate: vi.fn((_tabId: string) => Promise.resolve()),
    // The hotkeys never create tabs; the stub only satisfies the interface.
    createAndActivate: vi.fn(() => Promise.resolve()),
    writeBack: vi.fn(),
  } satisfies TabController
}

function seedTabs(): [Tab, Tab, Tab] {
  return [createTab(), createTab(), createTab()]
}

// --- harness ---

let container: HTMLDivElement
let root: Root

function Harness({ controller }: { controller: TabController }): null {
  useTabHotkeys(controller)
  return null
}

function renderHarness(controller = fakeController()): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<Harness controller={controller} />)
  })
}

const originalPlatform = navigator.platform
const originalUserAgent = navigator.userAgent

function pinNavigator(platform: string, userAgent: string): void {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform })
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
}

/** Dispatches a cancelable keydown at window; returns it for defaultPrevented. */
function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

beforeEach(() => {
  const [t1, t2, t3] = seedTabs()
  useTabStore.setState({ tabs: [t1, t2, t3], activeTabId: t2.id })
  useUIStore.setState({ tabsEnabled: true })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  document.body.innerHTML = ''
  Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform })
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent })
})

// --- Windows/Linux system set (Ctrl family) ---

describe('useTabHotkeys — Windows/Linux system set', () => {
  beforeEach(() => {
    pinNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')
  })

  it('Ctrl+Tab activates the next tab and wraps at the end', () => {
    const [t1, t2, t3] = seedTabs()
    useTabStore.setState({ tabs: [t1, t2, t3], activeTabId: t2.id })
    const controller = fakeController()
    renderHarness(controller)

    pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(controller.activate).toHaveBeenCalledWith(t3.id)

    // The engine flip is faked by hand: with t3 active, cycling wraps to t1.
    act(() => {
      useTabStore.setState({ activeTabId: t3.id })
    })
    pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t1.id)
  })

  it('Ctrl+Shift+Tab activates the previous tab and wraps at the start', () => {
    const [t1, t2, t3] = seedTabs()
    useTabStore.setState({ tabs: [t1, t2, t3], activeTabId: t2.id })
    const controller = fakeController()
    renderHarness(controller)

    pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t1.id)

    act(() => {
      useTabStore.setState({ activeTabId: t1.id })
    })
    pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t3.id)
  })

  it('Ctrl+PageDown / Ctrl+PageUp mirror next / previous', () => {
    const [t1, t2, t3] = seedTabs()
    useTabStore.setState({ tabs: [t1, t2, t3], activeTabId: t2.id })
    const controller = fakeController()
    renderHarness(controller)

    pressKey({ key: 'PageDown', code: 'PageDown', ctrlKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t3.id)
    pressKey({ key: 'PageUp', code: 'PageUp', ctrlKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t1.id)
  })

  it('prevents the default action exactly when it activates', () => {
    const controller = fakeController()
    renderHarness(controller)

    const acting = pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(acting.defaultPrevented).toBe(true)

    // Single tab: cycling cannot act and the event stays untouched.
    const only = createTab()
    act(() => {
      useTabStore.setState({ tabs: [only], activeTabId: only.id })
    })
    const idle = pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(idle.defaultPrevented).toBe(false)
    expect(controller.activate).toHaveBeenCalledTimes(1)
  })

  it('ignores non-cycling combos, including the macOS-only pair', () => {
    const controller = fakeController()
    renderHarness(controller)

    const ignored: KeyboardEventInit[] = [
      { key: 'Tab', code: 'Tab' }, // plain focus-cycling Tab
      { key: 'Enter', code: 'Enter', ctrlKey: true },
      { key: 'Tab', code: 'Tab', ctrlKey: true, altKey: true },
      { key: 'Tab', code: 'Tab', ctrlKey: true, metaKey: true },
      { key: 'PageDown', code: 'PageDown', ctrlKey: true, shiftKey: true },
      { key: ']', code: 'BracketRight', metaKey: true, shiftKey: true }, // macOS pair
    ]
    for (const init of ignored) {
      pressKey(init)
    }
    expect(controller.activate).not.toHaveBeenCalled()
  })

  it('is a no-op while the tab bar is disabled, leaving the event unprevented', () => {
    const controller = fakeController()
    act(() => {
      useUIStore.setState({ tabsEnabled: false })
    })
    renderHarness(controller)

    const event = pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(controller.activate).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('yields entirely while the embedded terminal holds focus (event untouched)', () => {
    const controller = fakeController()
    renderHarness(controller)
    // The xterm DOM shape: a container marked data-terminal-root holding the
    // hidden helper textarea that carries focus while the terminal is used.
    const term = document.createElement('div')
    term.setAttribute('data-terminal-root', '')
    const helper = document.createElement('textarea')
    term.appendChild(helper)
    document.body.appendChild(term)
    act(() => {
      helper.focus()
    })
    expect(document.activeElement).toBe(helper)

    // Keydowns originate AT the focused textarea and bubble to window — the
    // terminal wins on every cycling combo, both platform sets.
    const combos: KeyboardEventInit[] = [
      { key: 'Tab', code: 'Tab', ctrlKey: true },
      { key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true },
      { key: 'PageDown', code: 'PageDown', ctrlKey: true },
      { key: ']', code: 'BracketRight', metaKey: true, shiftKey: true },
    ]
    for (const init of combos) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      act(() => {
        helper.dispatchEvent(event)
      })
      expect(controller.activate).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(false)
    }
  })

  it('still cycles when a terminal is mounted but NOT focused', () => {
    const controller = fakeController()
    renderHarness(controller)
    const term = document.createElement('div')
    term.setAttribute('data-terminal-root', '')
    const helper = document.createElement('textarea')
    term.appendChild(helper)
    document.body.appendChild(term)
    // Focus stays outside the terminal (activeElement = body).

    const event = pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(controller.activate).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('reads the tab layer at event time, not mount time', () => {
    const only = createTab()
    act(() => {
      useTabStore.setState({ tabs: [only], activeTabId: only.id })
    })
    const controller = fakeController()
    renderHarness(controller)

    pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(controller.activate).not.toHaveBeenCalled()

    const second = createTab()
    act(() => {
      useTabStore.setState({ tabs: [only, second], activeTabId: only.id })
    })
    pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(controller.activate).toHaveBeenCalledWith(second.id)
  })

  it('detaches its listener on unmount', () => {
    const controller = fakeController()
    const element = document.createElement('div')
    document.body.appendChild(element)
    const localRoot = createRoot(element)
    act(() => {
      localRoot.render(<Harness controller={controller} />)
    })
    act(() => {
      localRoot.unmount()
    })
    element.remove()

    pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(controller.activate).not.toHaveBeenCalled()
  })
})

// --- macOS system pair (Cmd+Shift+brackets) + the accepted Ctrl alias ---

describe('useTabHotkeys — macOS system pair', () => {
  beforeEach(() => {
    pinNavigator('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
  })

  it('Cmd+Shift+] activates the next tab and wraps at the end', () => {
    const [t1, t2, t3] = seedTabs()
    useTabStore.setState({ tabs: [t1, t2, t3], activeTabId: t2.id })
    const controller = fakeController()
    renderHarness(controller)

    pressKey({ key: ']', code: 'BracketRight', metaKey: true, shiftKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t3.id)

    act(() => {
      useTabStore.setState({ activeTabId: t3.id })
    })
    pressKey({ key: ']', code: 'BracketRight', metaKey: true, shiftKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t1.id)
  })

  it('Cmd+Shift+[ activates the previous tab and wraps at the start', () => {
    const [t1, t2, t3] = seedTabs()
    useTabStore.setState({ tabs: [t1, t2, t3], activeTabId: t2.id })
    const controller = fakeController()
    renderHarness(controller)

    pressKey({ key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t1.id)

    act(() => {
      useTabStore.setState({ activeTabId: t1.id })
    })
    pressKey({ key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t3.id)
  })

  it('Ctrl+Tab / Ctrl+Shift+Tab stay accepted aliases on macOS', () => {
    const [t1, t2, t3] = seedTabs()
    useTabStore.setState({ tabs: [t1, t2, t3], activeTabId: t2.id })
    const controller = fakeController()
    renderHarness(controller)

    pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t3.id)
    pressKey({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true })
    expect(controller.activate).toHaveBeenLastCalledWith(t1.id)
  })

  it('keeps Cmd+] / Cmd+[ (the web-history pair) and non-matching combos out', () => {
    const controller = fakeController()
    renderHarness(controller)

    const ignored: KeyboardEventInit[] = [
      { key: ']', code: 'BracketRight', metaKey: true }, // no Shift
      { key: '[', code: 'BracketLeft', metaKey: true }, // no Shift
      { key: ']', code: 'BracketRight', shiftKey: true }, // no Cmd
      { key: ']', code: 'BracketRight', ctrlKey: true, shiftKey: true }, // Ctrl, not Cmd
      { key: ']', code: 'BracketRight', metaKey: true, shiftKey: true, altKey: true },
      { key: 'x', code: 'KeyX', metaKey: true, shiftKey: true },
      { key: 'PageDown', code: 'PageDown', ctrlKey: true }, // not a macOS cycling shortcut
    ]
    for (const init of ignored) {
      pressKey(init)
    }
    expect(controller.activate).not.toHaveBeenCalled()
  })

  it('is a no-op while the tab bar is disabled, leaving the event unprevented', () => {
    const controller = fakeController()
    act(() => {
      useUIStore.setState({ tabsEnabled: false })
    })
    renderHarness(controller)

    const event = pressKey({ key: ']', code: 'BracketRight', metaKey: true, shiftKey: true })
    expect(controller.activate).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
