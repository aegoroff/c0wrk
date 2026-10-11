import { useEffect } from 'react'
import type { TabController } from '@/hooks/useTabController'
import { isMacHost } from '@/lib/platform'
import { useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'

// System-standard shortcuts for cycling workspace tabs/documents — the pair
// the HOST PLATFORM's native apps use, not one web-only combo hardcoded for
// every OS:
//
//   macOS (HIG "Show Next/Previous Tab" — Safari, Finder, Terminal, Xcode):
//     Cmd+Shift+]  → next tab    Cmd+Shift+[  → previous tab
//     (matched on the physical key, `code` BracketRight/BracketLeft, so any
//     layout works; Cmd+] / Cmd+[ stay untouched — the web-history pair)
//     Ctrl+Tab / Ctrl+Shift+Tab remain accepted aliases (also a macOS
//     system convention — Safari tab cycling — and a tolerance for webview
//     key-equivalent quirks).
//
//   Windows / Linux (Edge and the GTK notebook document-tab conventions):
//     Ctrl+Tab        → next tab        Ctrl+PageDown → next tab
//     Ctrl+Shift+Tab  → previous tab    Ctrl+PageUp   → previous tab
//
// The listener is window-level (like useShiftHeld): cycling must work no
// matter which panel holds focus — the tab layer is app-wide context, not a
// focus-scoped widget. The ONE exception is the embedded terminal: while IT
// holds focus (xterm attaches its own handlers on its hidden helper textarea,
// and a TUI can legitimately bind the cycling combos), the shortcuts yield
// entirely — the keydown is left unprevented for the terminal. It is mounted
// in AppLayout right next to THE single
// TabController mount and routes every activation through that controller,
// so hotkey cycling travels the exact same single-engine path — and the same
// module-level serialization chain — as tab-bar clicks and banner-click
// activations. A held shortcut firing repeated keydowns is therefore
// well-defined: each keydown enqueues one wrap-around step and the chain
// runs them in order.
//
// The hook is flag-aware but flag-agnostic in behavior: with
// `uiStore.tabsEnabled` off, or with fewer than two tabs, the keypress is
// left completely untouched (no preventDefault) — the pre-tab shell keeps
// its byte-identical keyboard behavior. The gate is read via getState() at
// event time, so the effect attaches once for the controller's app-lifetime;
// the platform probe runs once per mount (the host never changes mid-run).

/** The structural key event the matcher needs (KeyboardEvent satisfies it). */
export interface TabHotkeyEvent {
  key: string
  /** Physical key identifier — the layout-independent matcher for the macOS pair. */
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** The macOS system pair: Cmd+Shift+] / Cmd+Shift+[ (physical-key match). */
function macSystemDelta(event: TabHotkeyEvent): 0 | 1 | -1 {
  if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey) return 0
  if (event.code === 'BracketRight') return 1
  if (event.code === 'BracketLeft') return -1
  return 0
}

/**
 * The Ctrl+Tab pair — the primary system convention on Windows/Linux and an
 * accepted macOS alias (Safari tab cycling). Accepted on every platform.
 */
function ctrlTabDelta(event: TabHotkeyEvent): 0 | 1 | -1 {
  if (!event.ctrlKey || event.altKey || event.metaKey) return 0
  if (event.key === 'Tab') return event.shiftKey ? -1 : 1
  return 0
}

/**
 * The Windows/Linux document-switch aliases (Edge and the GTK notebook
 * convention): Ctrl+PageDown / Ctrl+PageUp. Not a macOS cycling shortcut —
 * mac keeps its own pair plus the Ctrl+Tab alias only.
 */
function pageKeyDelta(event: TabHotkeyEvent): 0 | 1 | -1 {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return 0
  if (event.key === 'PageDown') return 1
  if (event.key === 'PageUp') return -1
  return 0
}

/**
 * Pure matcher: the cycling step a key event asks for — `1` next, `-1`
 * previous, `0` not a tab-cycling shortcut of the given host platform.
 */
export function tabSwitchDelta(event: TabHotkeyEvent, macHost: boolean): 0 | 1 | -1 {
  if (macHost) {
    const mac = macSystemDelta(event)
    if (mac !== 0) return mac
    return ctrlTabDelta(event)
  }
  const primary = ctrlTabDelta(event)
  if (primary !== 0) return primary
  return pageKeyDelta(event)
}

/**
 * Pure neighbor pick over the CURRENT tab order: the id `delta` steps from
 * the active tab, wrapping around (native-app-style cycling). `null` when
 * cycling cannot act — fewer than two tabs, or (defensively) an
 * unresolvable active id.
 */
export function selectNeighborTabId(
  state: Pick<ReturnType<typeof useTabStore.getState>, 'tabs' | 'activeTabId'>,
  delta: 1 | -1,
): string | null {
  const tabs = state.tabs
  if (tabs.length < 2) return null
  const index = tabs.findIndex((tab) => tab.id === state.activeTabId)
  if (index === -1) return null
  const neighbor = tabs[(index + delta + tabs.length) % tabs.length]
  return neighbor !== undefined ? neighbor.id : null
}

/**
 * True when a key event originates inside the embedded terminal — xterm's
 * hidden helper textarea under the container marked `data-terminal-root`
 * (Terminal.tsx). While the terminal holds focus the cycling combos belong to
 * it first (a TUI can bind them), so the shortcuts must not steal them: the
 * event is left untouched. Pure and exported for tests.
 */
export function isTerminalKeyEvent(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-terminal-root]') !== null
}

/**
 * Mount the system tab-cycling shortcuts. Takes the app's single
 * TabController (AppLayout's mount) — activation failures are the engine's
 * concern (activate never rejects), so the handler stays fire-and-forget.
 */
export function useTabHotkeys(controller: TabController): void {
  useEffect(() => {
    const macHost = isMacHost()
    const onKeyDown = (event: KeyboardEvent): void => {
      // The embedded terminal owns its keys while focused — yield before
      // anything else, whatever the combo is.
      if (isTerminalKeyEvent(event.target)) return
      const delta = tabSwitchDelta(event, macHost)
      if (delta === 0) return
      // The shortcuts belong to the visible tab bar: flag off → untouched
      // passthrough, exactly the pre-tab keyboard behavior.
      if (!useUIStore.getState().tabsEnabled) return
      const targetId = selectNeighborTabId(useTabStore.getState(), delta)
      if (targetId === null) return // fewer than two tabs: nothing to cycle
      event.preventDefault()
      void controller.activate(targetId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [controller])
}
