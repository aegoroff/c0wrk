// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  computeChatInputDisabled,
  computeChatPlaceholder,
  computeModeTogglesLocked,
  modeToggleLockReason,
  buildSuggestionPlaceholderNode,
  isSuggestionPlaceholderActive,
  suggestionPositionLabel,
  suggestionPreviewText,
  isChatSessionIdle,
} from '@/lib/chatInputLock'

// The input-lock matrix for live-send: a running task keeps the input OPEN
// (messages interject into the next LLM request); the pausing window, the
// compaction window, and the no-project state lock it.

describe('computeChatInputDisabled', () => {
  it('idle session: input enabled', () => {
    expect(
      computeChatInputDisabled({ taskActive: false, paused: false, pausing: false, isNoProject: false, compacting: false }),
    ).toBe(false)
  })

  it('running task: input enabled (live-send)', () => {
    expect(
      computeChatInputDisabled({ taskActive: true, paused: false, pausing: false, isNoProject: false, compacting: false }),
    ).toBe(false)
  })

  it('paused task: input enabled (nudge-resume)', () => {
    expect(
      computeChatInputDisabled({ taskActive: false, paused: true, pausing: false, isNoProject: false, compacting: false }),
    ).toBe(false)
  })

  it('pausing window: input disabled even though a task is running', () => {
    expect(
      computeChatInputDisabled({ taskActive: true, paused: false, pausing: true, isNoProject: false, compacting: false }),
    ).toBe(true)
  })

  it('compacting: input disabled regardless of task state', () => {
    expect(
      computeChatInputDisabled({ taskActive: false, paused: false, pausing: false, isNoProject: false, compacting: true }),
    ).toBe(true)
    expect(
      computeChatInputDisabled({ taskActive: true, paused: false, pausing: false, isNoProject: false, compacting: true }),
    ).toBe(true)
  })

  it('no project: input disabled regardless of task state', () => {
    expect(
      computeChatInputDisabled({ taskActive: false, paused: false, pausing: false, isNoProject: true, compacting: false }),
    ).toBe(true)
    expect(
      computeChatInputDisabled({ taskActive: true, paused: false, pausing: false, isNoProject: true, compacting: false }),
    ).toBe(true)
  })
})

describe('computeChatPlaceholder', () => {
  it('reflects the live-send affordance while a task runs', () => {
    const text = computeChatPlaceholder({ taskActive: true, paused: false, pausing: false, isNoProject: false, compacting: false })
    expect(text).toContain('next request')
  })

  it('reflects the pausing window', () => {
    const text = computeChatPlaceholder({ taskActive: true, paused: false, pausing: true, isNoProject: false, compacting: false })
    expect(text).toContain('Pausing')
  })

  it('reflects the compacting window', () => {
    const text = computeChatPlaceholder({ taskActive: false, paused: false, pausing: false, isNoProject: false, compacting: true })
    expect(text).toContain('Compacting')
  })

  it('reflects the paused state', () => {
    const text = computeChatPlaceholder({ taskActive: false, paused: true, pausing: false, isNoProject: false, compacting: false })
    expect(text).toContain('nudge-resume')
  })

  it('defaults to the send hint for an idle session', () => {
    const text = computeChatPlaceholder({ taskActive: false, paused: false, pausing: false, isNoProject: false, compacting: false })
    expect(text).toContain('Enter to send')
  })

  it('prioritizes no-project over everything', () => {
    const text = computeChatPlaceholder({ taskActive: true, paused: false, pausing: true, isNoProject: true, compacting: true })
    expect(text).toContain('project')
  })

  it('prioritizes compacting over pausing/paused/task states', () => {
    const text = computeChatPlaceholder({ taskActive: true, paused: false, pausing: true, isNoProject: false, compacting: true })
    expect(text).toContain('Compacting')
  })
})

// The prompt-suggestion hint (ADR-088): a non-empty suggestion list in the
// idle state takes over the placeholder as a DOM-node surface — the previewed
// row's text, a BLANK line, and the italic usage-hint block. Every
// state-specific placeholder and the empty list keep the base matrix: the
// hint must never bury a more specific session state.
describe('suggestion placeholder surface', () => {
  const idle = { taskActive: false, paused: false, pausing: false, isNoProject: false, compacting: false }
  const rows = (texts: string[]) => texts.map((text, i) => ({ id: String(i), text }))

  it('is active exactly when the set is non-empty AND the session is idle', () => {
    const armed = rows(['a suggestion'])
    expect(isSuggestionPlaceholderActive(idle, armed)).toBe(true)
    expect(isSuggestionPlaceholderActive(idle, [])).toBe(false)
    expect(isSuggestionPlaceholderActive({ ...idle, taskActive: true }, armed)).toBe(false)
    expect(isSuggestionPlaceholderActive({ ...idle, paused: true }, armed)).toBe(false)
    expect(isSuggestionPlaceholderActive({ ...idle, pausing: true }, armed)).toBe(false)
    expect(isSuggestionPlaceholderActive({ ...idle, compacting: true }, armed)).toBe(false)
    expect(isSuggestionPlaceholderActive({ ...idle, isNoProject: true }, armed)).toBe(false)
  })

  it('builds the separated layout: preview, one BLANK line, italic hints', () => {
    const node = buildSuggestionPlaceholderNode('Follow up on the failing test')
    const preview = node.querySelector('.cm-suggestion-preview')
    const hints = node.querySelector<HTMLElement>('.cm-suggestion-hints')
    expect(preview?.textContent).toBe('Follow up on the failing test')
    // No position marker without one (ADR-088 D8's chip degrades to the
    // bare text; the controller always passes one today).
    expect(node.querySelector('.cm-suggestion-position')).toBeNull()
    // The separator is an explicit EMPTY line: two <br> elements. Under the
    // wrap's white-space: pre-line a '\n\n' text run would collapse to a
    // single break, so text alone cannot render the blank line.
    expect(node.querySelectorAll('br')).toHaveLength(2)
    expect(hints?.textContent).toBe('↑↓ browse · → insert\nOr just type a message... (Enter to send, Shift+Enter for new line)')
    // The whole usage block after the separator is italic; the suggestion
    // itself is not (no inline style — it inherits the wrap's normal).
    expect(hints?.style.fontStyle).toBe('italic')
    expect((preview as HTMLElement).style.fontStyle).toBe('')
  })

  it('appends the position marker to the preview line (D8: text + position)', () => {
    const node = buildSuggestionPlaceholderNode('Follow up on the failing test', '2/3')
    const marker = node.querySelector<HTMLElement>('.cm-suggestion-position')
    expect(marker?.textContent).toBe('2/3')
    // The marker rides the preview row (before the blank-line separator) as
    // a muted suffix — the same visual line, dimmed via opacity.
    expect(marker?.style.opacity).toBe('0.6')
    expect(node.querySelectorAll('br')).toHaveLength(2)
    // The preview text itself stays untouched.
    expect(node.querySelector('.cm-suggestion-preview')?.textContent).toBe('Follow up on the failing test')
  })

  it('empty preview text renders the hints alone, without a leading blank line', () => {
    const node = buildSuggestionPlaceholderNode('')
    expect(node.querySelector('.cm-suggestion-preview')).toBeNull()
    expect(node.querySelectorAll('br')).toHaveLength(0)
    expect(node.querySelector('.cm-suggestion-hints')?.textContent).toBe(
      '↑↓ browse · → insert\nOr just type a message... (Enter to send, Shift+Enter for new line)',
    )
  })
})

describe('suggestionPreviewText', () => {
  const rows = (texts: string[]) => texts.map((text, i) => ({ id: String(i), text }))
  const list = rows(['first', 'second'])

  it('resolves the browsed-to row, the top pick at -1, and nothing for an empty list', () => {
    expect(suggestionPreviewText(list, 1)).toBe('second')
    expect(suggestionPreviewText(list, 0)).toBe('first')
    expect(suggestionPreviewText(list, -1)).toBe('first')
    expect(suggestionPreviewText([], 0)).toBeUndefined()
  })

  it('clamps an out-of-range index instead of previewing nothing', () => {
    expect(suggestionPreviewText(list, 99)).toBe('second')
    expect(suggestionPreviewText(list, -7)).toBe('first')
  })
})

describe('suggestionPositionLabel', () => {
  it('names the previewed row: the top row at -1 (the resting selection), 1-based', () => {
    expect(suggestionPositionLabel(-1, 3)).toBe('1/3')
    expect(suggestionPositionLabel(0, 3)).toBe('1/3')
    expect(suggestionPositionLabel(1, 3)).toBe('2/3')
    expect(suggestionPositionLabel(2, 3)).toBe('3/3')
  })

  it('applies the same clamp as suggestionPreviewText, so label and preview name one row', () => {
    expect(suggestionPositionLabel(99, 2)).toBe('2/2')
    expect(suggestionPositionLabel(-7, 2)).toBe('1/2')
  })

  it('an empty set has no position', () => {
    expect(suggestionPositionLabel(0, 0)).toBe('')
    expect(suggestionPositionLabel(-1, 0)).toBe('')
  })
})

describe('isChatSessionIdle', () => {
  const idle = { taskActive: false, paused: false, pausing: false, isNoProject: false, compacting: false }

  it('is idle only when no special state is active', () => {
    expect(isChatSessionIdle(idle)).toBe(true)
    for (const key of ['taskActive', 'paused', 'pausing', 'isNoProject', 'compacting'] as const) {
      expect(isChatSessionIdle({ ...idle, [key]: true })).toBe(false)
    }
  })
})

// The goal/E2S mode-toggle lock: locked while ANY live task state can still be
// continued-or-abandoned by the next send (running, pausing, compacting,
// paused, lingering unfinished task); unlocked only in clean states — fresh
// session, settled task (continuation on the inherited blackboard), or a
// failed task the user cancelled.
describe('computeModeTogglesLocked', () => {
  const base = { taskActive: false, pausing: false, compacting: false, paused: false, unfinishedTaskStatus: '' }

  const locked = (overrides: Partial<typeof base>) => computeModeTogglesLocked({ ...base, ...overrides })
  const reason = (overrides: Partial<typeof base>) => modeToggleLockReason({ ...base, ...overrides })

  it('idle session (fresh first message): unlocked', () => {
    expect(locked({})).toBe(false)
    expect(reason({})).toBe('')
  })

  it('settled task (continuation after a successful completion): unlocked', () => {
    // '' is the explicit "task settled" overlay value — a follow-up send
    // continues the completed lineage, the one window where re-arming is
    // meaningful.
    expect(locked({ unfinishedTaskStatus: '' })).toBe(false)
    expect(reason({ unfinishedTaskStatus: '' })).toBe('')
  })

  it('running task: locked', () => {
    expect(locked({ taskActive: true })).toBe(true)
    expect(reason({ taskActive: true })).toBe('Locked while the session is running')
  })

  it('pausing window: locked with the running reason (the task is still live)', () => {
    expect(locked({ taskActive: true, pausing: true })).toBe(true)
    expect(reason({ taskActive: true, pausing: true })).toBe('Locked while the session is running')
  })

  it('compacting: locked with the compaction reason', () => {
    expect(locked({ compacting: true })).toBe(true)
    expect(reason({ compacting: true })).toBe('Locked while context compaction is in flight')
  })

  it('cooperatively paused: locked even though model/reasoning unlock', () => {
    expect(locked({ paused: true })).toBe(true)
    expect(reason({ paused: true })).toBe('Locked while the task is paused — resume or cancel it first')
  })

  it('failed-resumable overlay: locked with the failed reason', () => {
    expect(locked({ unfinishedTaskStatus: 'failed' })).toBe(true)
    expect(reason({ unfinishedTaskStatus: 'failed' })).toBe('Locked while a failed task awaits resume or cancel')
  })

  it('any other lingering unfinished status keeps the lock (fail-closed)', () => {
    expect(locked({ unfinishedTaskStatus: 'paused' })).toBe(true)
    expect(locked({ unfinishedTaskStatus: 'in_progress' })).toBe(true)
    expect(reason({ unfinishedTaskStatus: 'paused' })).toBe('Locked while an unfinished task is pending')
    expect(reason({ unfinishedTaskStatus: 'in_progress' })).toBe('Locked while an unfinished task is pending')
  })

  it('failed task after the user chose cancel (overlay cleared): unlocked', () => {
    expect(locked({ unfinishedTaskStatus: '' })).toBe(false)
  })

  it('compaction outranks the paused/lingering reasons (most specific flow first)', () => {
    expect(reason({ compacting: true, paused: true, unfinishedTaskStatus: 'failed' })).toBe(
      'Locked while context compaction is in flight',
    )
  })
})
