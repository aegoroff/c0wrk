// Tests that the chat editor's undo/redo chords are layout-agnostic.
//
// CodeMirror resolves a keydown in three layers: (1) key-name bindings —
// historyKeymap's 'Mod-z' / 'Mod-y' derive their name from event.key, which
// follows the ACTIVE keyboard layout, so on a Cyrillic layout Ctrl+Z arrives
// as key='я' and no named binding matches; (2) an else-if physical fallback
// mapping event.keyCode onto a QWERTY key name (how mac Cmd+Shift+Z still
// redoes on a Cyrillic layout); (3) the `any` fallback of every keymap,
// consulted for each keydown no binding consumed. createChatKeymap's `any`
// binding lives in layer (3): it matches the layout-printed character
// (event.key.toLowerCase()) first — the same layout-following signal the
// key-name layer resolves from — and falls back to the physical key
// (event.code) for layouts that print neither Z nor Y nor any other Latin
// letter (a printed 'f' — Dvorak's physical KeyY — keeps its own chord,
// never a redo); it is the only `any`
// fallback among the chat extension set's keymaps. A recognized chord is
// consumed even when the history command no-ops, so layer (2) can never
// re-interpret the same keydown as the opposite chord.
//
// Views are driven through real keydown events dispatched on contentDOM —
// the same path CodeMirror's keymap machinery uses in the browser. The
// harness mirrors the KEYMAP slice of createChatExtensions exactly
// (createChatKeymap + keymap.of([...defaultKeymap, ...historyKeymap]) +
// history(), same order), so the named-binding layers a real browser
// consults are in play, and every event carries the real physical keyCode
// (90 for KeyZ, 89 for KeyY, ...) — jsdom otherwise reports 0, which would
// leave layer (2) unexercised. A returned `false` means nothing consumed
// the chord anywhere; `true` means SOMETHING did — our `any` layer, or
// CodeMirror's own physical fallback resolving a named historyKeymap
// binding (those prevent the event even when their command no-ops), which
// is CM behavior outside this keymap's control.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { MutableRefObject } from 'react'

import { createChatKeymap, matchChatHistoryKey } from './cmChatKeymap'

const createdViews: EditorView[] = []

/**
 * Mount a throwaway chat editor with the exact keymap composition of
 * createChatExtensions' keymap slice (frontend/src/lib/cmChatExtensions.ts):
 * the chat keymap under test, then the default+history named bindings,
 * then history. Keep the order in sync with createChatExtensions.
 */
function mountView(onSend: (() => void) | null = null): EditorView {
  const onSendRef: MutableRefObject<(() => void) | null> = { current: onSend }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      extensions: [
        createChatKeymap(onSendRef),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        history(),
      ],
    }),
    parent: host,
  })
  createdViews.push(view)
  return view
}

/** Insert text at the cursor through the regular (history-tracked) path. */
function type(view: EditorView, text: string): void {
  view.dispatch(view.state.replaceSelection(text))
}

/**
 * Dispatch a keydown on the editor's contentDOM; returns whether CodeMirror
 * consumed the chord (it prevents the event exactly when a binding ran).
 * Callers pass the real physical keyCode for the key's code slot — a real
 * browser always sets it (jsdom defaults to 0).
 */
function pressKey(view: EditorView, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  view.contentDOM.dispatchEvent(event)
  return event.defaultPrevented
}

/** Bare event for the pure matcher. */
function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let consoleWarnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const view of createdViews.splice(0)) view.destroy()
  document.body.replaceChildren()
  // Scoped console spies (specs/domains/testing.md): the run must be clean,
  // including CodeMirror's internal error reporting paths.
  expect(consoleErrorSpy).not.toHaveBeenCalled()
  expect(consoleWarnSpy).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

describe('createChatKeymap — undo/redo across keyboard layouts', () => {
  it('undoes a Cyrillic Ctrl+Z (key=я, code=KeyZ)', () => {
    const view = mountView()
    type(view, 'привет')
    expect(view.state.doc.toString()).toBe('привет')

    expect(pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true, keyCode: 90 })).toBe(true)
    expect(view.state.doc.toString()).toBe('')
  })

  it('redoes a Cyrillic Ctrl+Y (key=н, code=KeyY)', () => {
    const view = mountView()
    type(view, 'привет')
    pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true, keyCode: 90 })
    expect(view.state.doc.toString()).toBe('')

    expect(pressKey(view, { key: 'н', code: 'KeyY', ctrlKey: true, keyCode: 89 })).toBe(true)
    expect(view.state.doc.toString()).toBe('привет')
  })

  it('undoes on AZERTY, where Z is printed on the physical W slot (key=z, code=KeyW)', () => {
    const view = mountView()
    type(view, 'bonjour')

    expect(pressKey(view, { key: 'z', code: 'KeyW', ctrlKey: true, keyCode: 87 })).toBe(true)
    expect(view.state.doc.toString()).toBe('')
  })

  it('QWERTZ Ctrl+Y on an empty redo stack is a consumed no-op, never an undo', () => {
    const view = mountView()
    type(view, 'Струс')
    // Right after an edit the redo stack is empty: the printed 'y' makes
    // this redo, which no-ops. The chord must still be CONSUMED — a false
    // would let the physical-keyCode fallback resolve the real keydown's
    // keyCode 90 (physical slot Z) as Ctrl-z and silently UNDO the edit.
    expect(pressKey(view, { key: 'y', code: 'KeyZ', ctrlKey: true, keyCode: 90 })).toBe(true)
    expect(view.state.doc.toString()).toBe('Струс')

    // The same chords work once there is history to act on.
    expect(pressKey(view, { key: 'z', code: 'KeyY', ctrlKey: true, keyCode: 89 })).toBe(true)
    expect(view.state.doc.toString()).toBe('')
    expect(pressKey(view, { key: 'y', code: 'KeyZ', ctrlKey: true, keyCode: 90 })).toBe(true)
    expect(view.state.doc.toString()).toBe('Струс')
  })

  it("Dvorak's printed 'f' on the physical KeyY slot never redoes (Ctrl+F regression)", () => {
    const view = mountView()
    type(view, 'привет')
    pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true, keyCode: 90 })
    expect(view.state.doc.toString()).toBe('')

    // Dvorak prints 'f' on the physical KeyY slot. The pre-fix build
    // re-interpreted this unrelated chord as the physical slot's redo and
    // CONSUMED it — mutating the draft from an unrelated shortcut. It must
    // stay unconsumed and leave the nonempty redo stack untouched.
    expect(pressKey(view, { key: 'f', code: 'KeyY', ctrlKey: true, keyCode: 70 })).toBe(false)
    expect(view.state.doc.toString()).toBe('')

    // The redo stack is intact: the proper redo chord still restores.
    expect(pressKey(view, { key: 'н', code: 'KeyY', ctrlKey: true, keyCode: 89 })).toBe(true)
    expect(view.state.doc.toString()).toBe('привет')
  })

  it('redoes a Cyrillic Ctrl+Shift+Z (key=Я, code=KeyZ)', () => {
    const view = mountView()
    type(view, 'привет')
    pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true, keyCode: 90 })
    expect(view.state.doc.toString()).toBe('')

    expect(
      pressKey(view, { key: 'Я', code: 'KeyZ', ctrlKey: true, shiftKey: true, keyCode: 90 }),
    ).toBe(true)
    expect(view.state.doc.toString()).toBe('привет')
  })

  it('consumes empty history chords as intentional no-ops (never leaks to native behavior)', () => {
    const view = mountView()
    // Nothing to undo AND nothing to redo: both chords are still consumed,
    // like historyKeymap's own bindings (their preventDefault defaults to
    // true), and leave the document untouched.
    expect(pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true, keyCode: 90 })).toBe(true)
    expect(pressKey(view, { key: 'н', code: 'KeyY', ctrlKey: true, keyCode: 89 })).toBe(true)
    expect(view.state.doc.toString()).toBe('')
  })

  it('never intercepts Ctrl+C (native copy chord)', () => {
    const view = mountView()
    type(view, 'привет')

    expect(pressKey(view, { key: 'с', code: 'KeyC', ctrlKey: true, keyCode: 67 })).toBe(false)
    expect(view.state.doc.toString()).toBe('привет')
  })

  it('never intercepts letters without modifiers', () => {
    const view = mountView()
    type(view, 'ок')

    expect(pressKey(view, { key: 'я', code: 'KeyZ', keyCode: 90 })).toBe(false)
    expect(pressKey(view, { key: 'z', code: 'KeyZ', keyCode: 90 })).toBe(false)
    expect(pressKey(view, { key: 'н', code: 'KeyY', keyCode: 89 })).toBe(false)
    expect(view.state.doc.toString()).toBe('ок')
  })

  it('never intercepts AltGr chords (ctrl+alt)', () => {
    const view = mountView()

    expect(
      pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true, altKey: true, keyCode: 90 }),
    ).toBe(false)
    expect(
      pressKey(view, { key: 'н', code: 'KeyY', ctrlKey: true, altKey: true, keyCode: 89 }),
    ).toBe(false)
  })

  it('never intercepts chords during IME composition', () => {
    const view = mountView()

    // Our matcher declines composition events (the precise guard lives in
    // the matchChatHistoryKey unit tests). The chord can still show up
    // defaultPrevented: historyKeymap's own physical fallback resolves the
    // real keydown's slot as Ctrl-z and its binding carries preventDefault
    // by default — CM prevents it even though the command no-ops. That is
    // CM behavior outside this keymap's control; what must not happen is
    // an interception on OUR side.
    pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true, isComposing: true, keyCode: 90 })
    expect(view.state.doc.toString()).toBe('')
  })

  it('Enter still sends through the existing binding', () => {
    const onSend = vi.fn()
    const view = mountView(onSend)
    type(view, 'привет')

    expect(pressKey(view, { key: 'Enter', keyCode: 13 })).toBe(true)
    expect(onSend).toHaveBeenCalledTimes(1)
    // Consumed by the send binding — defaultKeymap's Enter binding (insert
    // a newline) never ran behind it.
    expect(view.state.doc.toString()).toBe('привет')
  })
})

describe('matchChatHistoryKey', () => {
  it('maps Ctrl + physical Z to undo, +Shift to redo', () => {
    expect(matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyZ', ctrlKey: true }))).toBe('undo')
    expect(
      matchChatHistoryKey(keyEvent({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true })),
    ).toBe('redo')
  })

  it('follows the printed character against the physical slot (QWERTZ)', () => {
    // QWERTZ: the redo chord Ctrl+Y prints 'y' on the physical Z slot — the
    // printed character wins, this is redo and never undo.
    expect(matchChatHistoryKey(keyEvent({ key: 'y', code: 'KeyZ', ctrlKey: true }))).toBe('redo')
    expect(
      matchChatHistoryKey(keyEvent({ key: 'Y', code: 'KeyZ', ctrlKey: true, shiftKey: true })),
    ).toBe('redo')
    // The undo chord Ctrl+Z prints 'z' on the physical Y slot.
    expect(matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyY', ctrlKey: true }))).toBe('undo')
    expect(
      matchChatHistoryKey(keyEvent({ key: 'Z', code: 'KeyY', ctrlKey: true, shiftKey: true })),
    ).toBe('redo')
  })

  it('maps Ctrl + physical Y to redo', () => {
    expect(matchChatHistoryKey(keyEvent({ key: 'y', code: 'KeyY', ctrlKey: true }))).toBe('redo')
    expect(matchChatHistoryKey(keyEvent({ key: 'н', code: 'KeyY', ctrlKey: true }))).toBe('redo')
  })

  it('matches the layout-printed Z character on a foreign physical slot', () => {
    expect(matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyW', ctrlKey: true }))).toBe('undo')
    // AZERTY Shift prints uppercase — still matches after lowercasing.
    expect(
      matchChatHistoryKey(keyEvent({ key: 'Z', code: 'KeyW', ctrlKey: true, shiftKey: true })),
    ).toBe('redo')
  })

  it('ignores chords without the platform modifier', () => {
    expect(matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyZ' }))).toBeNull()
    // metaKey is the history modifier only on Mac-like platforms.
    expect(matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyZ', metaKey: true }))).toBeNull()
  })

  it('ignores AltGr (ctrl+alt) and IME composition', () => {
    expect(
      matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true })),
    ).toBeNull()
    expect(
      matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyZ', ctrlKey: true, isComposing: true })),
    ).toBeNull()
  })

  it('ignores unrelated chords (Ctrl+C / Ctrl+с)', () => {
    expect(matchChatHistoryKey(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBeNull()
    expect(matchChatHistoryKey(keyEvent({ key: 'с', code: 'KeyC', ctrlKey: true }))).toBeNull()
  })

  it("declines Dvorak's printed Latin letters on the Z/Y physical slots", () => {
    // On Dvorak the physical KeyY slot prints 'f': Ctrl+F is an unrelated
    // chord — a printed Latin letter other than z/y — and must stay
    // unconsumed, never a redo (PR #157 review comment 1).
    expect(matchChatHistoryKey(keyEvent({ key: 'f', code: 'KeyY', ctrlKey: true }))).toBeNull()
    expect(
      matchChatHistoryKey(keyEvent({ key: 'F', code: 'KeyY', ctrlKey: true, shiftKey: true })),
    ).toBeNull()
  })

  it('rides Cmd instead of Ctrl on Mac-like platforms', () => {
    // The matcher reads the platform PER CALL, so a spy is enough here.
    // Keymap-level mac integration (the Cmd bindings CodeMirror builds at
    // module load) is covered by the per-platform suites in
    // cmChatKeymap.platform-*.test.ts, which pin the platform before the
    // editor modules load.
    const platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    try {
      expect(matchChatHistoryKey(keyEvent({ key: 'я', code: 'KeyZ', ctrlKey: true }))).toBeNull()
      expect(matchChatHistoryKey(keyEvent({ key: 'я', code: 'KeyZ', metaKey: true }))).toBe('undo')
      expect(
        matchChatHistoryKey(keyEvent({ key: 'я', code: 'KeyZ', metaKey: true, shiftKey: true })),
      ).toBe('redo')
      // historyKeymap's mac redo chord is Cmd+Shift+Z (Mod-y is replaced on
      // mac): the printed-'y' fallback provides Cmd+Y = redo there.
      expect(matchChatHistoryKey(keyEvent({ key: 'y', code: 'KeyY', metaKey: true }))).toBe('redo')
      // Dvorak on mac prints 'f' on the physical KeyY slot: Cmd+F keeps its
      // own behavior — the printed Latin letter declines before the
      // physical fallback can turn it into a redo.
      expect(matchChatHistoryKey(keyEvent({ key: 'f', code: 'KeyY', metaKey: true }))).toBeNull()
    } finally {
      platformSpy.mockRestore()
    }
  })
})
