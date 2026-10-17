// Shared integration suite for the chat editor's undo/redo chords against
// CodeMirror's REAL platform keymaps.
//
// CodeMirror resolves its platform ONCE — when @codemirror/view first loads:
// its internal `browser.mac` / `windows` / `linux` read navigator.platform at
// module scope — and buildKeymap bakes it into the named-binding tables: on
// mac, historyKeymap's Mod-y redo is REPLACED by Cmd+Shift+Z, and the
// standalone Mod-Shift-z redo binding is registered on Linux only. Mocking
// navigator.platform in a test body (after the editor modules were imported)
// switches only our own matcher — which reads the platform per call — never
// the already-built keymap tables; jsdom's empty platform permanently selects
// the linux table, so such tests cannot exercise mac or Windows bindings at
// all.
//
// The per-platform suites in cmChatKeymap.platform-{mac,win,linux}.test.ts
// therefore pin navigator.platform with vi.hoisted — which vitest runs
// BEFORE the static imports below evaluate — and import this module once per
// platform: each test file is a fully isolated module environment whose
// CodeMirror copy is baked for that one platform. Every case below runs
// against that platform's actual named-binding tables, with
// createChatKeymap's `any` fallback layered behind them exactly as in
// production (same keymap composition as createChatExtensions' keymap
// slice). Views are driven through real keydown events dispatched on
// contentDOM, carrying the real physical keyCode (jsdom otherwise reports 0,
// which would leave CodeMirror's physical fallback layer unexercised).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { MutableRefObject } from 'react'
import { createChatKeymap, matchChatHistoryKey } from './cmChatKeymap'

/** One platform's history-chord shape: Cmd on mac, Ctrl everywhere else. */
export interface ChatKeymapPlatformScenario {
  /** Human-readable label, e.g. 'macOS (MacIntel)'. */
  label: string
  /** Whether the history modifier is Cmd (metaKey) — mac — or Ctrl. */
  useMeta: boolean
  /** The modifier's display name for test titles, e.g. 'Cmd'. */
  mod: string
}

const createdViews: EditorView[] = []

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

function pressKey(view: EditorView, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  view.contentDOM.dispatchEvent(event)
  return event.defaultPrevented
}

/** Bare event for the pure matcher. */
function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

/** History chord carrying this platform's modifier. */
function historyChord(scenario: ChatKeymapPlatformScenario, init: KeyboardEventInit): KeyboardEventInit {
  return scenario.useMeta ? { ...init, metaKey: true } : { ...init, ctrlKey: true }
}

/**
 * Register the integration suite for one pinned platform. Called at
 * collection time from each cmChatKeymap.platform-*.test.ts file.
 */
export function runChatKeymapPlatformSuite(scenario: ChatKeymapPlatformScenario): void {
  describe(`chat keymap — ${scenario.label}: real platform keymap integration`, () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      for (const view of createdViews.splice(0)) view.destroy()
      document.body.replaceChildren()
      // Scoped console spies (specs/domains/testing.md): the run must be
      // clean, including CodeMirror's internal error reporting paths.
      expect(consoleErrorSpy).not.toHaveBeenCalled()
      expect(consoleWarnSpy).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })

    it(`undoes a Latin ${scenario.mod}+Z through the platform's named binding`, () => {
      const view = mountView()
      type(view, 'привет')

      expect(pressKey(view, historyChord(scenario, { key: 'z', code: 'KeyZ', keyCode: 90 }))).toBe(
        true,
      )
      expect(view.state.doc.toString()).toBe('')
    })

    it(`redoes ${scenario.mod}+Shift+Z and ${scenario.mod}+Y on a Latin layout`, () => {
      const view = mountView()
      type(view, 'привет')
      pressKey(view, historyChord(scenario, { key: 'z', code: 'KeyZ', keyCode: 90 }))

      // On mac the redo binding rides Cmd+Shift+Z (Mod-y is replaced);
      // on Windows it rides Mod-y; on Linux the standalone Mod-Shift-z
      // redo binding exists. The printed character routes all to redo.
      expect(
        pressKey(
          view,
          historyChord(scenario, { key: 'Z', code: 'KeyZ', shiftKey: true, keyCode: 90 }),
        ),
      ).toBe(true)
      expect(view.state.doc.toString()).toBe('привет')
      pressKey(view, historyChord(scenario, { key: 'z', code: 'KeyZ', keyCode: 90 }))

      expect(pressKey(view, historyChord(scenario, { key: 'y', code: 'KeyY', keyCode: 89 }))).toBe(
        true,
      )
      expect(view.state.doc.toString()).toBe('привет')
    })

    it('undoes and redoes Cyrillic input (key=я / Я / н)', () => {
      const view = mountView()
      type(view, 'привет')

      expect(pressKey(view, historyChord(scenario, { key: 'я', code: 'KeyZ', keyCode: 90 }))).toBe(
        true,
      )
      expect(view.state.doc.toString()).toBe('')

      expect(
        pressKey(
          view,
          historyChord(scenario, { key: 'Я', code: 'KeyZ', shiftKey: true, keyCode: 90 }),
        ),
      ).toBe(true)
      expect(view.state.doc.toString()).toBe('привет')
      pressKey(view, historyChord(scenario, { key: 'я', code: 'KeyZ', keyCode: 90 }))

      // Printed 'н' matches no named binding on any platform: the
      // printed-character / physical-KeyY fallback provides redo (on mac
      // Mod-y is replaced by Cmd+Shift+Z, so the fallback is the only
      // Cmd+Y-shaped redo path there).
      expect(pressKey(view, historyChord(scenario, { key: 'н', code: 'KeyY', keyCode: 89 }))).toBe(
        true,
      )
      expect(view.state.doc.toString()).toBe('привет')
    })

    it('matchChatHistoryKey rides the live platform modifier', () => {
      if (scenario.useMeta) {
        expect(matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyZ', metaKey: true }))).toBe(
          'undo',
        )
        expect(matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyZ', ctrlKey: true }))).toBeNull()
      } else {
        expect(matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyZ', ctrlKey: true }))).toBe(
          'undo',
        )
        expect(matchChatHistoryKey(keyEvent({ key: 'z', code: 'KeyZ', metaKey: true }))).toBeNull()
      }
    })

    if (scenario.useMeta) {
      it('QWERTZ: Cmd+Z printed on the physical Y slot undoes, Cmd+Shift+Z restores', () => {
        const view = mountView()
        type(view, 'Струс')

        // QWERTZ prints 'z' on the physical Y slot: the printed character
        // gives the mac Cmd+Z chord a direct named-binding match.
        expect(pressKey(view, { key: 'z', code: 'KeyY', metaKey: true, keyCode: 89 })).toBe(true)
        expect(view.state.doc.toString()).toBe('')
        expect(
          pressKey(view, { key: 'Z', code: 'KeyY', metaKey: true, shiftKey: true, keyCode: 89 }),
        ).toBe(true)
        expect(view.state.doc.toString()).toBe('Струс')
      })
    } else {
      it('QWERTZ: Ctrl+Y on an empty redo stack is a consumed no-op, never an undo', () => {
        const view = mountView()
        type(view, 'Струс')

        // Printed 'y' on the physical Z slot: Mod-y (redo) is registered on
        // Windows/Linux, no-ops on the empty redo stack, and the chord is
        // consumed — it must never fall through to the physical slot as an
        // undo. With history to act on, the same chord redoes.
        expect(pressKey(view, { key: 'y', code: 'KeyZ', ctrlKey: true, keyCode: 90 })).toBe(true)
        expect(view.state.doc.toString()).toBe('Струс')
        expect(pressKey(view, { key: 'z', code: 'KeyY', ctrlKey: true, keyCode: 89 })).toBe(true)
        expect(view.state.doc.toString()).toBe('')
        expect(pressKey(view, { key: 'y', code: 'KeyZ', ctrlKey: true, keyCode: 90 })).toBe(true)
        expect(view.state.doc.toString()).toBe('Струс')
      })
    }

    it('Dvorak: an unrelated printed-f chord (physical KeyY) never redoes', () => {
      const view = mountView()
      type(view, 'привет')
      pressKey(view, historyChord(scenario, { key: 'я', code: 'KeyZ', keyCode: 90 }))
      expect(view.state.doc.toString()).toBe('')

      // Dvorak prints 'f' on the physical KeyY slot. The pre-fix build
      // re-interpreted this unrelated Cmd/Ctrl+F chord as the physical
      // slot's redo and consumed it — mutating the draft. Nothing in the
      // platform keymap binds Mod-f, so the chord must stay unconsumed and
      // the nonempty redo stack intact.
      expect(pressKey(view, historyChord(scenario, { key: 'f', code: 'KeyY', keyCode: 70 }))).toBe(
        false,
      )
      expect(view.state.doc.toString()).toBe('')

      expect(pressKey(view, historyChord(scenario, { key: 'н', code: 'KeyY', keyCode: 89 }))).toBe(
        true,
      )
      expect(view.state.doc.toString()).toBe('привет')
    })
  })
}
