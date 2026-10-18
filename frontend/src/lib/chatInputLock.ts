/**
 * Chat input lock policy (live-send).
 *
 * Pure helpers extracted from useChatInputController so the input-lock matrix
 * is unit-testable without the CodeMirror-backed hook harness.
 */

export interface ChatInputLockInput {
  /** A task is currently executing in the session. */
  taskActive: boolean
  /** The task is cooperatively paused (checkpoint landed). */
  paused: boolean
  /** Pause requested, checkpoint not yet landed (the pausing window). */
  pausing: boolean
  /** No project is active (CHAT-less state). */
  isNoProject: boolean
  /** A manual context compaction is in flight (the whole input area locks). */
  compacting: boolean
}

/**
 * Whether the chat input is disabled.
 *
 * - `taskActive` alone does NOT lock the input: a message sent while a task
 *   runs is live-delivered to the running request's next LLM call.
 * - The pausing window DOES lock it: a send in that window races the
 *   pause→paused transition, so the backend rejects it (ErrPausePending) and
 *   the UI mirrors that by disabling input.
 * - A cooperatively paused task leaves the input unlocked (nudge-resume).
 * - Manual compaction locks the input: the compaction flow owns the session
 *   (pause-wait → history swap → auto-resume), and the backend rejects sends
 *   with ErrSessionCompacting for the whole window.
 * - No project locks the input outright.
 */
export function computeChatInputDisabled(s: ChatInputLockInput): boolean {
  return s.compacting || s.pausing || s.isNoProject
}

/** The input placeholder for the current session state (first match wins). */
export function computeChatPlaceholder(s: ChatInputLockInput): string {
  if (s.isNoProject) return 'Select or create a project to start'
  if (s.compacting) return 'Compacting context — the input unlocks when it finishes'
  if (s.pausing) return 'Pausing — the input unlocks once the pause lands'
  if (s.paused) return 'Paused — send a message to nudge-resume, or press Resume'
  if (s.taskActive) return 'Working — your message joins the next request to the model'
  return 'Type a message... (Enter to send, Shift+Enter for new line)'
}

/** True when no special session state is active — the plain "Type a
 *  message..." idle. Only this state may hand the placeholder over to the
 *  prompt-suggestion hint; every state-specific placeholder outranks it. */
export function isChatSessionIdle(s: ChatInputLockInput): boolean {
  return !s.isNoProject && !s.compacting && !s.pausing && !s.paused && !s.taskActive
}

// Prompt-suggestion hint (ADR-088): while the input is empty and the session
// is idle, the placeholder itself becomes the suggestions surface — the
// previewed row's text, a BLANK line, and the italic usage-hint block. The
// surface is a DOM node (buildSuggestionPlaceholderNode) because a flat
// placeholder string can express neither: under cmChatTheme's
// `.cm-placeholder` white-space: pre-line rule a '\n\n' text run collapses to
// a single break (no empty line), and CSS cannot italicize part of a text
// node. The pre-line rule is what still turns the hints' internal '\n' into a
// real second line.
export const SUGGESTION_BROWSE_HINT = '↑↓ browse · → insert'
export const SUGGESTION_TYPE_HINT = 'Or just type a message... (Enter to send, Shift+Enter for new line)'

/** The row the placeholder previews: the selection's row — for a non-empty
 *  set the store keeps the selection ON a row (a fresh snapshot rests on the
 *  top row), so the resting idle placeholder already shows the proactive
 *  prompt. The index is clamped defensively (out-of-range and the -1 empty
 *  sentinel map to the nearest row); an empty list previews nothing. */
export function suggestionPreviewText(
  suggestions: readonly { readonly text: string }[],
  selectedIndex: number,
): string | undefined {
  if (suggestions.length === 0) return undefined
  const idx = Math.max(0, Math.min(selectedIndex, suggestions.length - 1))
  return suggestions[idx]?.text
}

/**
 * Whether the prompt-suggestion hint owns the placeholder: exactly when a
 * non-empty suggestion set exists AND the session is idle. Every other case —
 * an empty list, or ANY state-specific placeholder (no-project, compacting,
 * pausing, paused, working) — keeps the plain state matrix
 * (computeChatPlaceholder): the suggestion hint must never bury a more
 * specific session state.
 *
 * Structural typing (a `{ text }` row) keeps this lib dependency-free of the
 * suggestions event types.
 */
export function isSuggestionPlaceholderActive(
  s: ChatInputLockInput,
  suggestions: readonly { readonly text: string }[],
): boolean {
  return suggestions.length > 0 && isChatSessionIdle(s)
}

/**
 * The prompt-suggestion placeholder surface as a DOM node for CodeMirror's
 * `placeholder()` (it accepts a string or an HTMLElement and clones the node
 * into its `.cm-placeholder` wrap; cmChatTheme keeps the white-space rule):
 *
 *   <previewed suggestion text>
 *   (blank line)
 *   ↑↓ browse · → insert            ← italic ┐ the whole usage block after
 *   Or just type a message... (...) ← italic ┘ the separator is italic
 *
 * The blank line between the suggestion and the usage hints is built from two
 * explicit <br> elements: under the wrap's `white-space: pre-line` a '\n\n'
 * text sequence collapses to a single break, so text alone cannot render an
 * empty line there. The hints' own internal '\n' stays plain text — pre-line
 * preserves it. The italic rides an inline style because no stylesheet is
 * loaded in the unit-test environment (the style survives cloneNode).
 */
export function buildSuggestionPlaceholderNode(preview: string): HTMLElement {
  const root = document.createElement('span')
  root.className = 'cm-suggestion-placeholder'
  if (preview !== '') {
    const previewLine = document.createElement('span')
    previewLine.className = 'cm-suggestion-preview'
    previewLine.textContent = preview
    root.appendChild(previewLine)
    // One BLANK line: the first <br> closes the preview row, the second is
    // the empty line — explicit elements never collapse.
    root.appendChild(document.createElement('br'))
    root.appendChild(document.createElement('br'))
  }
  const hints = document.createElement('span')
  hints.className = 'cm-suggestion-hints'
  hints.style.fontStyle = 'italic'
  hints.textContent = `${SUGGESTION_BROWSE_HINT}\n${SUGGESTION_TYPE_HINT}`
  root.appendChild(hints)
  return root
}

/**
 * Per-message EXECUTION-MODE lock (goal / E2S toggles and the goal budget
 * selector) — deliberately NARROWER than the model/reasoning selector lock:
 * model and reasoning unlock on a cooperative pause or a resumable failure
 * (the resume honors a freshly picked override), while goal/E2S do not.
 *
 * Why the asymmetry: goal and E2S are not resume-time overrides — they can
 * only arm a NEW task. A send that arrives while an unfinished task lingers
 * (paused, failed-resumable, or orphaned in_progress) is intercepted by the
 * backend's resume branch, and a goal- or E2S-armed send actively ABANDONS
 * the unfinished task (abandonUnfinishedTaskForGoal / abandonUnfinishedTaskForE2S:
 * the interrupted run is cancelled so the new mode starts clean). Flipping the
 * mode in those states therefore discards the suspended task — so the toggles
 * stay locked until the session returns to a clean state:
 *   - the task settled successfully (a follow-up send is a continuation on the
 *     inherited blackboard — the one place re-arming is meaningful), or
 *   - the failed task was cancelled (the next send starts fresh), or
 *   - the session had no task at all (fresh first message).
 */
export interface ModeToggleLockInput {
  /** A task is currently executing in the session. */
  taskActive: boolean
  /** Pause requested, checkpoint not yet landed (the pausing window). */
  pausing: boolean
  /** A manual context compaction is in flight. */
  compacting: boolean
  /** The task is cooperatively paused (checkpoint landed). */
  paused: boolean
  /** chatStore.unfinishedTaskStatus for the active session: '' = settled/none,
   *  otherwise a live unfinished task lingers ('paused' | 'failed' |
   *  'in_progress'). Any non-empty value keeps the toggles locked — every such
   *  state can still be continued or abandoned by the next send. */
  unfinishedTaskStatus: string
}

/** Whether the goal/E2S toggles (and the goal budget selector) are locked. */
export function computeModeTogglesLocked(s: ModeToggleLockInput): boolean {
  return s.taskActive || s.pausing || s.compacting || s.paused || s.unfinishedTaskStatus !== ''
}

/**
 * Why the mode toggles are locked, for the disabled control's title. Empty
 * string when unlocked. Precedence mirrors computeChatPlaceholder: the most
 * specific transient flow first, then the lingering-task states.
 */
export function modeToggleLockReason(s: ModeToggleLockInput): string {
  if (!computeModeTogglesLocked(s)) return ''
  if (s.compacting) return 'Locked while context compaction is in flight'
  if (s.paused) return 'Locked while the task is paused — resume or cancel it first'
  if (s.unfinishedTaskStatus === 'failed') return 'Locked while a failed task awaits resume or cancel'
  if (s.unfinishedTaskStatus !== '') return 'Locked while an unfinished task is pending'
  return 'Locked while the session is running'
}
