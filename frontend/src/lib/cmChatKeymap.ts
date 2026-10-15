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
 * CodeMirror resolves a keydown in three layers: (1) key-name bindings —
 * `historyKeymap`'s 'Mod-z' / 'Mod-y' derive their name from `event.key`,
 * which follows the ACTIVE keyboard layout, so on a Cyrillic layout
 * Ctrl+Z arrives as key='я' and no named binding matches; (2) an else-if
 * physical fallback that maps `event.keyCode` onto a QWERTY key name and
 * re-resolves the chord (this is how mac Cmd+Shift+Z still redoes on a
 * Cyrillic layout); (3) the `any` fallback of every keymap, consulted for
 * each keydown no binding consumed. This matcher lives in layer (3) and
 * recognizes the layout-printed character (`event.key.toLowerCase()`) —
 * the SAME layout-following signal the key-name layer resolves bindings
 * from, so a history chord recomputes into the same action the named
 * layer would have taken (QWERTZ prints 'y' on the physical Z slot: its
 * Ctrl+Y is redo, never undo) — and, for layouts that print neither Z nor
 * Y at all (Cyrillic 'я' / 'н'), the layout-independent PHYSICAL key
 * (`event.code`).
 *
 * The caller consumes a recognized chord even when the history command
 * no-ops, mirroring historyKeymap's own bindings (their preventDefault
 * defaults to true): that keeps layer (2) from re-interpreting the same
 * declined keydown as the OPPOSITE chord — without it, a QWERTZ Ctrl+Y
 * on an empty redo stack fell through to physical slot Z and silently
 * undid the edit.
 *
 * Guarded against AltGr (ctrl+alt) and IME composition; anything not
 * recognized — including native browser chords like Ctrl+C — returns null
 * so the event is left alone.
 */
export function matchChatHistoryKey(event: KeyboardEvent): ChatHistoryAction | null {
  const mod = isMacLikePlatform() ? event.metaKey : event.ctrlKey
  if (!mod || event.altKey || event.isComposing) return null
  // The printed character wins: it is the signal the key-name layer saw,
  // so this fallback never contradicts a historyKeymap chord on layouts
  // like QWERTZ, where the physical slots swap Z and Y.
  const printed = event.key.toLowerCase()
  if (printed === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (printed === 'y') return 'redo'
  // Physical-key fallback for layouts printing neither Z nor Y (Cyrillic:
  // Ctrl+я / Ctrl+н ride the same physical slots).
  if (event.code === 'KeyZ') return event.shiftKey ? 'redo' : 'undo'
  if (event.code === 'KeyY') return 'redo'
  return null
}

/**
 * Chat-specific keymap:
 * - Enter sends the message (unless autocomplete is active)
 * - Shift-Enter inserts a newline
 * - `any` fallback resolves undo/redo from the layout-printed character +
 *   physical key (see matchChatHistoryKey)
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
      // Consulted for keydowns no key-name binding consumed. It is the only
      // `any` fallback among createChatExtensions' keymaps (autocompletion
      // and the default/history keymaps bind named keys only), so no other
      // extension's fallback competes with it. A recognized history chord
      // ALWAYS consumes (true) — even when undo/redo no-ops on an empty
      // stack, like historyKeymap's own bindings whose preventDefault
      // defaults to true — so CodeMirror's physical-keyCode fallback layer
      // cannot re-interpret the same keydown as the opposite chord (see
      // matchChatHistoryKey). Unrecognized keys return false and keep the
      // contract: other bindings / native behavior continue.
      any: (view, event) => {
        switch (matchChatHistoryKey(event)) {
          case 'undo':
            undo(view)
            return true
          case 'redo':
            redo(view)
            return true
          default:
            return false
        }
      },
    },
  ])
}
