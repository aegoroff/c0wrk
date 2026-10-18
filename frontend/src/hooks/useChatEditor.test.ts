// Unit tests for the chat editor hook:
//  - shouldFastPathPaste — the fast-path heuristic that decides whether the
//    chat editor should let CodeMirror insert a paste natively (pure
//    text/html) or route it through the Go backend (image / copied files).
//    Pure function over a DataTransfer.
//  - onContentChange — the hook must report the FULL editor text (not a
//    boolean) on every document change, so the controller can persist it as
//    the active session's draft. Needs a real CodeMirror view in the DOM.
//
// jsdom environment: the onContentChange suite mounts a real CodeMirror
// EditorView (needs a DOM), and useThemeStore (imported via the hook)
// persists through window.localStorage.
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The editor's extension bundle pulls in the @-/#-autocomplete source, which
// imports the Wails api wrappers. Mock them so nothing reaches window.go.
vi.mock('@/api/workspace', () => ({ listDirectory: vi.fn().mockResolvedValue([]) }))
vi.mock('@/api/skills', () => ({ listSkills: vi.fn().mockResolvedValue([]) }))
vi.mock('@/api/agents', () => ({ listAgents: vi.fn().mockResolvedValue([]) }))
vi.mock('@/api/runtime', () => ({ subscribe: vi.fn(() => () => {}) }))

import { shouldFastPathPaste, useChatEditor, type ChatEditorAPI, type ChatSuggestionNavAction } from '@/hooks/useChatEditor'

/** Build a minimal DataTransfer-like object from a list of {kind, type} items. */
function fakeDataTransfer(items: Array<{ kind: 'string' | 'file'; type: string }>): DataTransfer {
  return {
    items: items as unknown as DataTransferItemList,
  } as DataTransfer
}

describe('shouldFastPathPaste', () => {
  it('fast-paths plain text (string item, text/plain)', () => {
    expect(shouldFastPathPaste(fakeDataTransfer([{ kind: 'string', type: 'text/plain' }]))).toBe(true)
  })

  it('fast-paths rich text (string items, text/plain + text/html, no file)', () => {
    const data = fakeDataTransfer([
      { kind: 'string', type: 'text/plain' },
      { kind: 'string', type: 'text/html' },
    ])
    expect(shouldFastPathPaste(data)).toBe(true)
  })

  it('fast-paths text/html only (rich text from a browser/AI chat)', () => {
    expect(shouldFastPathPaste(fakeDataTransfer([{ kind: 'string', type: 'text/html' }]))).toBe(true)
  })

  it('does NOT fast-path an image paste (file item, image/png)', () => {
    expect(shouldFastPathPaste(fakeDataTransfer([{ kind: 'file', type: 'image/png' }]))).toBe(false)
  })

  it('does NOT fast-path a screenshot that also carries a text/html shadow', () => {
    // Browsers often expose a screenshot as BOTH an image file and a text/html
    // representation; the file item must force the backend route.
    const data = fakeDataTransfer([
      { kind: 'string', type: 'text/html' },
      { kind: 'file', type: 'image/png' },
    ])
    expect(shouldFastPathPaste(data)).toBe(false)
  })

  it('does NOT fast-path a copied file (file item, generic/empty type)', () => {
    expect(shouldFastPathPaste(fakeDataTransfer([{ kind: 'file', type: '' }]))).toBe(false)
  })

  it('treats an empty clipboard as a fast path (nothing to route)', () => {
    expect(shouldFastPathPaste(fakeDataTransfer([]))).toBe(true)
  })
})

describe('useChatEditor onContentChange', () => {
  let container: HTMLDivElement
  let root: Root
  let captured: ChatEditorAPI | null = null
  let changes: string[]

  function Harness() {
    const editor = useChatEditor({
      disabled: false,
      placeholder: 'type…',
      onSend: () => {},
      onContentChange: (text: string) => {
        changes.push(text)
      },
    })
    captured = editor
    return createElement('div', { ref: editor.containerRef })
  }

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    document.body.innerHTML = ''
    captured = null
    changes = []
    vi.clearAllMocks()
  })

  function render() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness))
    })
  }

  it('reports the FULL text (not a boolean) on every document change', () => {
    changes = []
    render()
    const editor = captured!
    // Mounting with an empty doc must not fire a content change.
    expect(changes).toEqual([])

    // Programmatic setText → full text.
    act(() => {
      editor.setText('hello')
    })
    expect(changes).toEqual(['hello'])
    expect(editor.getText()).toBe('hello')

    // insertAtCursor appends (unfocused → end of doc).
    act(() => {
      editor.insertAtCursor(' world')
    })
    expect(changes).toEqual(['hello', 'hello world'])

    // clear → empty string.
    act(() => {
      editor.clear()
    })
    expect(changes).toEqual(['hello', 'hello world', ''])
    expect(editor.getText()).toBe('')
  })

  it('does not fire onContentChange for non-document updates (focus)', () => {
    changes = []
    render()
    const editor = captured!
    editor.focus()
    expect(changes).toEqual([])
    expect(editor.getText()).toBe('')
  })
})

// The suggestion-nav keymap (ADR-088): bare ↑/↓/→ on an EMPTY input browse
// and insert the prompt suggestions; everything else — modifier chords, IME
// composition, non-empty documents, a disarmed handler — keeps CodeMirror's
// default behavior and never consults the handler. Tests mount the REAL hook
// (the actual extension bundle, keymap first) and drive it through real
// keydown events on contentDOM.
describe('useChatEditor suggestion-nav keymap', () => {
  let container: HTMLDivElement
  let root: Root
  let captured: ChatEditorAPI | null = null
  let nav: Mock<(action: ChatSuggestionNavAction) => boolean>
  let send: Mock<() => void>
  let armed: boolean

  function Harness() {
    const editor = useChatEditor({
      disabled: false,
      placeholder: 'type…',
      onSend: () => {
        send()
      },
      onSuggestionNav: (action: ChatSuggestionNavAction): boolean => {
        if (!armed) return false
        nav(action)
        return true
      },
    })
    captured = editor
    return createElement('div', { ref: editor.containerRef })
  }

  function render(withArmed: boolean): void {
    armed = withArmed
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness))
    })
  }

  function contentDOM(): HTMLElement {
    return captured!.containerRef.current!.querySelector('.cm-content') as HTMLElement
  }

  function press(key: string, init: KeyboardEventInit = {}): boolean {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    contentDOM().dispatchEvent(event)
    return event.defaultPrevented
  }

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    document.body.innerHTML = ''
    captured = null
    vi.clearAllMocks()
  })

  it('empty input: bare ↑/↓/→ browse and insert, each consumed and never a send', () => {
    nav = vi.fn(() => true)
    send = vi.fn(() => {})
    render(true)

    expect(press('ArrowDown')).toBe(true)
    expect(nav).toHaveBeenNthCalledWith(1, 'down')
    expect(press('ArrowUp')).toBe(true)
    expect(nav).toHaveBeenNthCalledWith(2, 'up')
    expect(press('ArrowRight')).toBe(true)
    expect(nav).toHaveBeenNthCalledWith(3, 'insert')

    // → inserts as real content — it must never route through the send path.
    expect(send).not.toHaveBeenCalled()
    expect(captured!.getText()).toBe('')
  })

  it('non-empty input: the handler is never consulted (arrows keep the caret behavior)', () => {
    nav = vi.fn(() => true)
    send = vi.fn(() => {})
    render(true)
    act(() => {
      captured!.setText('ab\ncd')
    })

    // Whether CodeMirror's own cursor bindings can move (and consume) at the
    // doc end is CM behavior; the contract here is only that the suggestion
    // handler stays out of the picture with content.
    press('ArrowDown')
    press('ArrowRight')
    expect(nav).not.toHaveBeenCalled()
  })

  it('modifier chords (Shift/Mod/Alt+Arrow) resolve to other key names and are never ours', () => {
    nav = vi.fn(() => true)
    render(true)

    // CodeMirror prefixes the resolved key name with the chord's modifiers,
    // so a bare 'ArrowDown' binding only ever matches the unmodified key.
    // (IME composition is handled upstream too: CodeMirror's InputState
    // ignores key events while composing, so keymaps never see them.)
    press('ArrowDown', { shiftKey: true })
    press('ArrowRight', { ctrlKey: true })
    press('ArrowUp', { metaKey: true })
    press('ArrowDown', { altKey: true })
    expect(nav).not.toHaveBeenCalled()
  })

  it('disarmed handler: the keys fall through untouched (nav declines, doc unchanged)', () => {
    nav = vi.fn(() => true)
    send = vi.fn(() => {})
    render(false)

    press('ArrowDown')
    press('ArrowRight')
    expect(nav).not.toHaveBeenCalled()
    expect(captured!.getText()).toBe('')
  })

  it('the latest rendered handler is used (ref-held, never a stale mount closure)', () => {
    nav = vi.fn(() => true)
    render(true)
    expect(press('ArrowDown')).toBe(true)
    expect(nav).toHaveBeenCalledTimes(1)

    // Disarm via a re-render: the mount-once keymap must pick up the new
    // handler, not the armed closure it was created with.
    act(() => {
      armed = false
      root.render(createElement(Harness))
    })
    press('ArrowDown')
    expect(nav).toHaveBeenCalledTimes(1)
  })
})
