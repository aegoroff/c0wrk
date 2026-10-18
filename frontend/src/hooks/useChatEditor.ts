import { useRef, useEffect, useCallback, useMemo } from 'react'
import { EditorView, placeholder, keymap } from '@codemirror/view'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { completionStatus } from '@codemirror/autocomplete'
import { createChatExtensions } from '@/lib/cmChatExtensions'
import { createChatEditorTheme } from '@/lib/cmChatTheme'
import { useThemeStore, selectActiveThemeType, selectActiveThemeId } from '@/stores/themeStore'
import { useFontStore } from '@/stores/fontStore'

/**
 * Decide whether a paste event should take the NATIVE fast path (let
 * CodeMirror insert the text) instead of routing through the Go backend.
 *
 * The fast path applies when the clipboard carries ONLY text — either plain
 * text or text/html — and NO file-like content. Rationale:
 *  - A screenshot/"copy image" paste is exposed by the browser as an image
 *    File in `items` (kind 'file', type image/*). A Finder/Explorer "copy"
 *    of files is exposed as file entries too (type may be empty or a URI-list
 *    flavor). Either way, the presence of a file-typed item means the paste
 *    is NOT plain text and must be routed through the backend probe.
 *  - text/html (rich text from a browser/AI chat, without any image) has no
 *    file payload, so it is still a text paste — fast-path it to avoid a Go
 *    roundtrip and to keep the rich-text→markdown handling CodeMirror already
 *    does. The backend's text probe would return the same string anyway.
 *
 * Returns true → caller returns false (no preventDefault), letting CM insert
 * natively. Returns false → caller preventDefault()s and invokes onPaste.
 */
export function shouldFastPathPaste(data: DataTransfer): boolean {
  // Any file-typed item (image, or copied file/URI) ⇒ not a text fast path.
  const items = data.items
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      // kind is 'string' | 'file' per the DataTransferItem spec.
      if (it && it.kind === 'file') return false
    }
  }
  // No file payload: a pure-text paste (plain and/or html). Fast path.
  return true
}

/** The prompt-suggestion keyboard action a keydown encodes. */
export type ChatSuggestionNavAction = 'up' | 'down' | 'insert'

/**
 * Keymap for the prompt-suggestion hint (ADR-088) while the input is EMPTY:
 * bare ArrowUp/ArrowDown browse the store's selection, ArrowRight inserts the
 * previewed row's text as real editor content — never a send.
 *
 * Chord routing is structural, not guarded: CodeMirror resolves a keydown's
 * key NAME with modifier prefixes (Alt-/Ctrl-/Meta-/Shift-), so these bare
 * 'Arrow*' bindings only ever match the unmodified chords — Shift+Arrow
 * (selection), Mod/Alt+Arrow (word/bookmark motion) land under different
 * names and are never ours. Key events during an active IME composition are
 * dropped upstream by CodeMirror itself (InputState.ignoreDuringComposition —
 * key handlers don't run while composing), so `run` — which receives only
 * the view — needs no composition check either. The guards that remain here
 * each fall through to CodeMirror's default bindings (return false):
 *  - an active autocomplete popup (its own keymap owns the arrows);
 *  - a non-empty document (interception ONLY while the input is empty — with
 *    content, arrows move the caret exactly as before).
 *
 * The handler is ref-held: the keymap is created once at mount, while the
 * controller re-arms it every render against the live promptSuggestionsStore
 * state. It must be included BEFORE createChatExtensions' keymaps (earlier
 * extensions win at equal precedence) so a consumed arrow never reaches the
 * default cursor bindings.
 */
export function createSuggestionNavKeymap(
  onNav: { current: ((action: ChatSuggestionNavAction) => boolean) | null },
): Extension {
  const bind = (key: 'ArrowUp' | 'ArrowDown' | 'ArrowRight', action: ChatSuggestionNavAction) => ({
    key,
    run: (view: EditorView): boolean => {
      if (completionStatus(view.state) !== null) return false
      if (view.state.doc.length !== 0) return false
      return onNav.current?.(action) ?? false
    },
  })
  return keymap.of([bind('ArrowUp', 'up'), bind('ArrowDown', 'down'), bind('ArrowRight', 'insert')])
}

interface UseChatEditorOptions {
  disabled: boolean
  placeholder: string
  /**
   * Initial document text, applied when the editor is CREATED (mount only —
   * later changes are ignored; use setText for updates). The controller
   * passes the active session's stored draft so a remount (e.g. a CHAT↔CODE
   * mode switch) restores the draft into the editor without relying on
   * effect ordering.
   */
  initialText?: string
  onSend: () => void
  /** Invoked with the FULL editor text on every document change. The
   *  controller persists it as the active session's draft. */
  onContentChange?: (text: string) => void
  /** Async paste handler invoked when the editor (focused) receives a paste
   *  that is NOT a plain-text/html fast path (i.e. it may carry an image or
   *  files). Receives the clipboard DataTransfer so the handler can branch on
   *  content type. The handler MUST do its own async work (vision resolution,
   *  backend paste, staging); the editor extension does not fall back to the
   *  native paste for non-fast-path events, so the handler owns the UX. */
  onPaste?: (data: DataTransfer) => Promise<void>
  /** Prompt-suggestion navigation, consulted for the BARE ArrowUp/ArrowDown/
   *  ArrowRight while the document is empty and no autocomplete popup is
   *  active (see createSuggestionNavKeymap). Return true to consume the
   *  keydown (preventDefault); false falls through to CodeMirror's default
   *  bindings. The controller arms it only while the active session's
   *  suggestion set is non-empty. */
  onSuggestionNav?: (action: ChatSuggestionNavAction) => boolean
}

export interface ChatEditorAPI {
  containerRef: React.RefObject<HTMLDivElement | null>
  getText: () => string
  setText: (s: string) => void
  clear: () => void
  focus: () => void
  /** Insert text at the current cursor position, or append to the end if unfocused. */
  insertAtCursor: (text: string) => void
}

/**
 * Hook that creates and manages a CodeMirror EditorView for the chat input.
 * Returns an imperative API for reading/writing text and focusing.
 */
export function useChatEditor(options: UseChatEditorOptions): ChatEditorAPI {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onSendRef = useRef<(() => void) | null>(options.onSend)
  const onContentChangeRef = useRef(options.onContentChange)
  const onPasteRef = useRef<((data: DataTransfer) => Promise<void>) | null>(options.onPaste)
  // Suggestion-nav handler is ref-held for the same mount-once keymap reason:
  // createSuggestionNavKeymap is baked into the editor state at mount, while
  // the controller re-arms (or disarms) the handler every render.
  const onSuggestionNavRef = useRef<((action: ChatSuggestionNavAction) => boolean) | null>(null)
  const editableComp = useRef(new Compartment())
  const placeholderComp = useRef(new Compartment())
  const themeCompartment = useRef(new Compartment())
  const theme = useThemeStore(selectActiveThemeType)
  // Theme IDENTITY: a same-type custom-theme switch keeps `theme` unchanged
  // but still swaps the CSS variables the baked palette resolves from.
  const themeId = useThemeStore(selectActiveThemeId)
  // The UI (sans) choice: the theme's font itself rides the `--font-sans` var
  // and re-resolves on its own — this value exists to TRIGGER the reconfigure
  // below so CodeMirror re-measures line heights for the new metrics.
  const uiFontFamily = useFontStore((s) => s.uiFontFamily)

  // Keep callback refs up to date without recreating extensions.
  onSendRef.current = options.onSend
  onContentChangeRef.current = options.onContentChange
  onPasteRef.current = options.onPaste
  onSuggestionNavRef.current = options.onSuggestionNav ?? null

  // Create the editor on mount.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const extensions = createChatExtensions(onSendRef, themeCompartment.current)

    const state = EditorState.create({
      doc: options.initialText ?? '',
      extensions: [
        editableComp.current.of(EditorView.editable.of(!options.disabled)),
        placeholderComp.current.of(placeholder(options.placeholder)),
        // The suggestion-nav keymap rides BEFORE createChatExtensions' keymaps
        // (earlier extensions win at equal precedence) so a consumed arrow
        // never reaches the default cursor bindings. Its own guards defer to
        // active autocompletion and — crucially — any non-empty document;
        // modifier chords and IME composition never reach it at all (CM's
        // key-name resolution and InputState composition handling).
        createSuggestionNavKeymap(onSuggestionNavRef),
        ...extensions,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onContentChangeRef.current?.(update.state.doc.toString())
          }
        }),
        // Paste interception — SCOPED to the editor: this handler only fires
        // when the CodeMirror editor itself is the paste target (it is
        // focused). It is NOT a document-wide 'paste' listener. Plain
        // text/html pastes take the fast path (default CM behavior, no Go
        // roundtrip); anything that may carry an image/files is routed
        // through the async onPaste handler (vision-gated staging).
        EditorView.domEventHandlers({
          paste(event: ClipboardEvent): boolean {
            const data = event.clipboardData
            if (!data) return false
            if (shouldFastPathPaste(data)) {
              // Let CodeMirror insert the text natively — no Go roundtrip.
              return false
            }
            // Potentially an image/file: take over and route via the backend.
            event.preventDefault()
            void onPasteRef.current?.(data)
            return true
          },
        }),
      ],
    })

    const view = new EditorView({ state, parent: container })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Only run on mount/unmount — dynamic updates via compartments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reconfigure editable compartment when disabled changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: editableComp.current.reconfigure(EditorView.editable.of(!options.disabled)),
    })
  }, [options.disabled])

  // Reconfigure placeholder compartment when placeholder text changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: placeholderComp.current.reconfigure(placeholder(options.placeholder)),
    })
  }, [options.placeholder])

  // Re-resolve the editor theme (palette + { dark } flag) on app theme change.
  // Keyed on BOTH the type (drives the { dark } flag — applyThemes can correct
  // the type without changing the id) and the identity (a same-type
  // custom-theme swap changes the palette CSS variables while `theme` stays).
  // The UI font choice forces the same reconfigure when the user switches
  // fonts — CM measures heights lazily, and without the redraw the new
  // font's metrics would be applied on stale measurements.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(createChatEditorTheme(theme === 'dark')),
    })
  }, [theme, themeId, uiFontFamily])

  const getText = useCallback((): string => {
    return viewRef.current?.state.doc.toString() ?? ''
  }, [])

  const setText = useCallback((s: string): void => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: s },
    })
  }, [])

  const clear = useCallback((): void => {
    setText('')
  }, [setText])

  const focus = useCallback((): void => {
    viewRef.current?.focus()
  }, [])

  const insertAtCursor = useCallback((text: string): void => {
    const view = viewRef.current
    if (!view) return
    const from = view.hasFocus
      ? view.state.selection.main.head
      : view.state.doc.length
    view.dispatch({
      changes: { from, insert: text },
      // Place cursor after the inserted text.
      selection: { anchor: from + text.length },
    })
    view.focus()
  }, [])

  return useMemo(() => ({ containerRef, getText, setText, clear, focus, insertAtCursor }), [getText, setText, clear, focus, insertAtCursor])
}
