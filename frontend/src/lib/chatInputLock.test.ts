import { describe, it, expect } from 'vitest'
import {
  computeChatInputDisabled,
  computeChatPlaceholder,
  computeModeTogglesLocked,
  modeToggleLockReason,
  computeSuggestionPlaceholder,
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
// idle state takes over the placeholder with the three-line browse hint —
// the previewed row's text, the ↑↓/→ affordances, and the type-a-message
// fallback. Every state-specific placeholder and the empty list keep the
// base matrix: the hint must never bury a more specific session state.
describe('computeSuggestionPlaceholder', () => {
  const idle = { taskActive: false, paused: false, pausing: false, isNoProject: false, compacting: false }
  const rows = (texts: string[]) => texts.map((text, i) => ({ id: String(i), text }))

  it('idle + non-empty list: three-line hint previewing the top pick while nothing is selected (-1)', () => {
    const text = computeSuggestionPlaceholder(idle, rows(['Follow up on the failing test', 'Write release notes']), -1)
    expect(text).toBe(
      'Follow up on the failing test\n↑↓ browse · → insert\nOr just type a message... (Enter to send, Shift+Enter for new line)',
    )
  })

  it('idle + browsed-to row: the placeholder previews exactly the selection', () => {
    const text = computeSuggestionPlaceholder(idle, rows(['first', 'second']), 1)
    expect(text).toBe(
      'second\n↑↓ browse · → insert\nOr just type a message... (Enter to send, Shift+Enter for new line)',
    )
  })

  it('every non-idle state keeps its own placeholder (first match wins)', () => {
    const armed = rows(['a suggestion'])
    expect(computeSuggestionPlaceholder({ ...idle, taskActive: true }, armed, 0)).toContain('next request')
    expect(computeSuggestionPlaceholder({ ...idle, paused: true }, armed, 0)).toContain('nudge-resume')
    expect(computeSuggestionPlaceholder({ ...idle, pausing: true }, armed, 0)).toContain('Pausing')
    expect(computeSuggestionPlaceholder({ ...idle, compacting: true }, armed, 0)).toContain('Compacting')
    expect(computeSuggestionPlaceholder({ ...idle, isNoProject: true }, armed, 0)).toContain('project')
  })

  it('empty list: falls back to the full state matrix (idle default included)', () => {
    expect(computeSuggestionPlaceholder(idle, [], -1)).toBe('Type a message... (Enter to send, Shift+Enter for new line)')
    expect(computeSuggestionPlaceholder({ ...idle, taskActive: true }, [], -1)).toContain('next request')
  })

  it('empty preview text renders the two-line hint without a leading blank line', () => {
    const text = computeSuggestionPlaceholder(idle, rows(['']), 0)
    expect(text).toBe('↑↓ browse · → insert\nOr just type a message... (Enter to send, Shift+Enter for new line)')
  })

  it('out-of-range selection is clamped defensively (the store keeps [-1, len-1])', () => {
    expect(computeSuggestionPlaceholder(idle, rows(['only']), 99)).toContain('only')
    expect(computeSuggestionPlaceholder(idle, rows(['only']), -7)).toContain('only')
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
