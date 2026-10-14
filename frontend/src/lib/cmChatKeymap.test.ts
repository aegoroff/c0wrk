// Tests that the chat editor's undo/redo chords are layout-agnostic.
//
// CodeMirror resolves historyKeymap's 'Mod-z' / 'Mod-y' bindings from
// event.key, which follows the ACTIVE keyboard layout: on a Cyrillic layout
// Ctrl+Z produces key='я', no key-name binding matches, and CodeMirror has
// no native-undo fallback of its own. createChatKeymap's `any` binding
// instead matches the layout-printed character (event.key.toLowerCase())
// first — the same layout-following signal the key-name layer resolves
// from — and falls back to the physical key (event.code) for layouts that
// print neither Z nor Y; it is the only `any` fallback among the chat
// extension set's keymaps.
//
// Views are driven through real keydown events dispatched on contentDOM —
// the same path CodeMirror's keymap machinery uses in the browser. A
// consumed chord is asserted via defaultPrevented (CodeMirror prevents the
// event exactly when a binding ran); a returned `false` must leave it
// unconsumed for native behavior.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { history } from '@codemirror/commands'
import type { MutableRefObject } from 'react'

import { createChatKeymap, matchChatHistoryKey } from './cmChatKeymap'

const createdViews: EditorView[] = []

/** Mount a throwaway chat editor carrying the keymap under test + history. */
function mountView(onSend: (() => void) | null = null): EditorView {
  const onSendRef: MutableRefObject<(() => void) | null> = { current: onSend }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({ extensions: [createChatKeymap(onSendRef), history()] }),
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

    expect(pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('')
  })

  it('redoes a Cyrillic Ctrl+Y (key=н, code=KeyY)', () => {
    const view = mountView()
    type(view, 'привет')
    pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true })
    expect(view.state.doc.toString()).toBe('')

    expect(pressKey(view, { key: 'н', code: 'KeyY', ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('привет')
  })

  it('undoes on AZERTY, where Z is printed on the physical W slot (key=z, code=KeyW)', () => {
    const view = mountView()
    type(view, 'bonjour')

    expect(pressKey(view, { key: 'z', code: 'KeyW', ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('')
  })

  it('QWERTZ Ctrl+Y on an empty redo stack is a no-op, never an undo', () => {
    const view = mountView()
    type(view, 'Струс')
    // Right after an edit the redo stack is empty: the named redo chord
    // declines and the event reaches the `any` fallback. The fallback must
    // recompute the printed 'y' as redo (declining as well) — misreading
    // the physical Z slot here silently UNDID the edit.
    pressKey(view, { key: 'y', code: 'KeyZ', ctrlKey: true })
    expect(view.state.doc.toString()).toBe('Струс')

    // The same chord redoes once there is something to redo.
    expect(pressKey(view, { key: 'z', code: 'KeyY', ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('')
    expect(pressKey(view, { key: 'y', code: 'KeyZ', ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('Струс')
  })

  it('redoes a Cyrillic Ctrl+Shift+Z (key=Я, code=KeyZ)', () => {
    const view = mountView()
    type(view, 'привет')
    pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true })
    expect(view.state.doc.toString()).toBe('')

    expect(pressKey(view, { key: 'Я', code: 'KeyZ', ctrlKey: true, shiftKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('привет')
  })

  it('leaves the chord unconsumed when there is nothing to undo', () => {
    const view = mountView()

    expect(pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true })).toBe(false)
    expect(view.state.doc.toString()).toBe('')
  })

  it('never intercepts Ctrl+C (native copy chord)', () => {
    const view = mountView()
    type(view, 'привет')

    expect(pressKey(view, { key: 'с', code: 'KeyC', ctrlKey: true })).toBe(false)
    expect(view.state.doc.toString()).toBe('привет')
  })

  it('never intercepts letters without modifiers', () => {
    const view = mountView()
    type(view, 'ок')

    expect(pressKey(view, { key: 'я', code: 'KeyZ' })).toBe(false)
    expect(pressKey(view, { key: 'z', code: 'KeyZ' })).toBe(false)
    expect(pressKey(view, { key: 'н', code: 'KeyY' })).toBe(false)
    expect(view.state.doc.toString()).toBe('ок')
  })

  it('never intercepts AltGr chords (ctrl+alt)', () => {
    const view = mountView()

    expect(pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true, altKey: true })).toBe(false)
    expect(pressKey(view, { key: 'н', code: 'KeyY', ctrlKey: true, altKey: true })).toBe(false)
  })

  it('never intercepts chords during IME composition', () => {
    const view = mountView()

    expect(pressKey(view, { key: 'я', code: 'KeyZ', ctrlKey: true, isComposing: true })).toBe(false)
  })

  it('Enter still sends through the existing binding', () => {
    const onSend = vi.fn()
    const view = mountView(onSend)
    type(view, 'привет')

    expect(pressKey(view, { key: 'Enter' })).toBe(true)
    expect(onSend).toHaveBeenCalledTimes(1)
    // Consumed by the send binding — no newline slipped in behind it.
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

  it('rides Cmd instead of Ctrl on Mac-like platforms', () => {
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
    } finally {
      platformSpy.mockRestore()
    }
  })
})
