import { keymap } from '@codemirror/view'
import { completionStatus } from '@codemirror/autocomplete'
import { redo, undo } from '@codemirror/commands'
import type { Extension } from '@codemirror/state'
import type { MutableRefObject } from 'react'

/**
 * History action encoded by a keyboard event, or null when the event must
 * not be intercepted.
 */
export type ChatHistoryAction = 'undo' | 'redo'

/**
 * Mac-like platform check mirroring @codemirror/view's internal `browser.mac`
 * (`/Mac/.test(navigator.platform)`): history chords ride Cmd there and Ctrl
 * everywhere else, exactly like the 'Mod-*' key-name resolution does. The
 * `browser` object itself is not part of @codemirror/view's public exports.
 */
function isMacLikePlatform(): boolean {
  return /Mac/.test(navigator.platform)
}

/**
 * Layout-agnostic history matcher behind the chat editor's undo/redo.
 *
 * CodeMirror resolves `historyKeymap`'s 'Mod-z' / 'Mod-y' bindings from
 * `event.key`, which follows the ACTIVE keyboard layout: on a Cyrillic
 * layout Ctrl+Z produces key='я', no key-name binding matches, and
 * CodeMirror has no native-undo fallback of its own. This matcher instead
 * recognizes the PHYSICAL key (`event.code`, layout-independent) and the
 * layout-printed character (`event.key.toLowerCase()`, covering layouts
 * like AZERTY/QWERTZ where Z sits on a different physical slot), so the
 * chords behave identically in every layout.
 *
 * Guarded against AltGr (ctrl+alt) and IME composition; anything not
 * recognized — including native browser chords like Ctrl+C — returns null
 * so the event is left alone.
 */
export function matchChatHistoryKey(event: KeyboardEvent): ChatHistoryAction | null {
  const mod = isMacLikePlatform() ? event.metaKey : event.ctrlKey
  if (!mod || event.altKey || event.isComposing) return null
  // Z is checked first, mirroring historyKeymap's own precedence
  // (Mod-z / Shift-Mod-z before Mod-y): the physical Z slot wins over the
  // Y chord even on QWERTZ, where that slot prints 'y'.
  if (event.code === 'KeyZ' || event.key.toLowerCase() === 'z') {
    return event.shiftKey ? 'redo' : 'undo'
  }
  if (event.code === 'KeyY' || event.key.toLowerCase() === 'y') {
    return 'redo'
  }
  return null
}

/**
 * Chat-specific keymap:
 * - Enter sends the message (unless autocomplete is active)
 * - Shift-Enter inserts a newline
 * - `any` fallback resolves undo/redo from the physical key + layout
 *   character (see matchChatHistoryKey)
 */
export function createChatKeymap(onSendRef: MutableRefObject<(() => void) | null>): Extension {
  return keymap.of([
    {
      key: 'Enter',
      run: (view) => {
        if (completionStatus(view.state) !== null) return false
        onSendRef.current?.()
        return true
      },
    },
    {
      key: 'Shift-Enter',
      run: (view) => {
        view.dispatch(view.state.replaceSelection('\n'))
        return true
      },
    },
    {
      // Consulted for keydowns no key-name binding consumed. This keymap is
      // the FIRST one in createChatExtensions, so its fallback is polled
      // before any other extension's. Returning the command's result keeps
      // the contract: false lets other bindings / native behavior continue.
      any: (view, event) => {
        switch (matchChatHistoryKey(event)) {
          case 'undo':
            return undo(view)
          case 'redo':
            return redo(view)
          default:
            return false
        }
      },
    },
  ])
}
