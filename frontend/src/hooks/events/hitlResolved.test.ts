// Tests for handleHitlResolvedEvent — the multi-surface HITL convergence
// handler: a hitl_resolved broadcast (a prompt consumed by ANOTHER surface)
// must retire the local card immediately, converge a raced local decision on
// the effective one, and never wipe a NEWER goal-store prompt.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useChatStore, selectSessionMessages } from '@/stores/chatStore'
import { useGoalStore } from '@/stores/goalStore'
import { useActiveSessionsStore } from '@/stores/activeSessionsStore'
import { getPendingActions, type PendingActionsResponse } from '@/api/chat'
import { handleToolConfirmEvent, handleAskUserEvent, handleStepLimitEvent, handlePlanReviewEvent, handleHitlResolvedEvent, resolveConfirmForToolResult } from './hitlHandlers'
import { handleGoalProposalEvent, handleGoalSuggestionEvent } from './goalHandlers'
import type { HitlResolvedData } from '@/types/events'

// Scoped logger spies: the reconcile's failure path logs at debug level and is
// asserted below; every other logger use in the import graph lands here instead
// of on the console.
const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({ logger: loggerMocks, setLogLevel: vi.fn() }))

// The re-query goes through the api wrapper; the activeSessionsStore itself
// stays REAL so the assertions cover the actual applyPendingActions path.
vi.mock('@/api/chat', () => ({
  getPendingActions: vi.fn(async () => null),
}))

let idc = 0

function findMsg(sessionId: string, id: string) {
  return selectSessionMessages(useChatStore.getState(), sessionId).find(m => m.id === id)
}

function resolve(sessionId: string, data: Omit<HitlResolvedData, 'id'> & { id: string }): void {
  handleHitlResolvedEvent(sessionId, data)
}

describe('handleHitlResolvedEvent — tool_confirm', () => {
  it('resolves a pending card with the effective decision and releases the linked tool card', () => {
    const sessionId = `sess-resolved-${idc++}`
    // Build the exact live state: a tool_call awaiting confirmation + the
    // confirm card, through the real tool_confirm handler.
    useChatStore.getState().setMessages(sessionId, [
      {
        id: 'tool-tc1',
        sessionId,
        type: 'tool_call',
        content: '',
        metadata: { tool: 'bash_exec', args: '{}', step: 1, tool_call_id: 'tc1' },
        timestamp: 1,
      },
    ])
    handleToolConfirmEvent(sessionId, {
      confirm_id: 'c1',
      tool: 'bash_exec',
      args: '{}',
      tool_call_id: 'tc1',
      reasoning: '',
    })

    resolve(sessionId, { kind: 'tool_confirm', id: 'c1', decision: 'allow_once' })

    const card = findMsg(sessionId, 'tool-confirm-c1')
    expect(card?.metadata?.resolved).toBe(true)
    expect(card?.metadata?.decision).toBe('confirmed')
    const toolMsg = findMsg(sessionId, 'tool-tc1')
    expect(toolMsg?.metadata?.awaiting_confirmation).toBe(false)
    expect(useChatStore.getState().activityStatus[sessionId]).toBe('Running tool: bash_exec...')
  })

  it('maps deny/deny_and_stop to denied and clears the activity label', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleToolConfirmEvent(sessionId, { confirm_id: 'c2', tool: 'edit_file', args: '{}', reasoning: '' })

    resolve(sessionId, { kind: 'tool_confirm', id: 'c2', decision: 'deny_and_stop' })

    const card = findMsg(sessionId, 'tool-confirm-c2')
    expect(card?.metadata?.decision).toBe('denied')
    // The store's clear idiom DELETES the map entry rather than storing null.
    expect(useChatStore.getState().activityStatus[sessionId]).toBeFalsy()
  })

  it('converges a raced local decision on the effective one (first-responder-wins correction)', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleToolConfirmEvent(sessionId, { confirm_id: 'c3', tool: 'bash_exec', args: '{}', reasoning: '' })
    // This surface's user clicked deny — but another surface's allow landed
    // first on the backend. The local card says denied; the broadcast carries
    // the truth.
    const card = findMsg(sessionId, 'tool-confirm-c3')!
    useChatStore.getState().updateMessage(sessionId, card.id, {
      metadata: { ...card.metadata, resolved: true, decision: 'denied' },
    })

    resolve(sessionId, { kind: 'tool_confirm', id: 'c3', decision: 'allow_once' })

    expect(findMsg(sessionId, 'tool-confirm-c3')?.metadata?.decision).toBe('confirmed')
  })

  it('never touches a settled card with a decision-less event', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleToolConfirmEvent(sessionId, { confirm_id: 'c4', tool: 'bash_exec', args: '{}', reasoning: '' })
    const card = findMsg(sessionId, 'tool-confirm-c4')!
    useChatStore.getState().updateMessage(sessionId, card.id, {
      metadata: { ...card.metadata, resolved: true, decision: 'denied' },
    })

    resolve(sessionId, { kind: 'tool_confirm', id: 'c4' })

    expect(findMsg(sessionId, 'tool-confirm-c4')?.metadata?.decision).toBe('denied')
  })

  it('is a no-op for an unknown confirm id', () => {
    const sessionId = `sess-resolved-${idc++}`
    resolve(sessionId, { kind: 'tool_confirm', id: 'ghost', decision: 'allow_once' })
    expect(selectSessionMessages(useChatStore.getState(), sessionId)).toHaveLength(0)
  })

  it('settles NEUTRALLY on an unrecognized non-empty decision (CS #25: never renders as denied)', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleToolConfirmEvent(sessionId, { confirm_id: 'c5', tool: 'bash_exec', args: '{}', reasoning: '' })

    resolve(sessionId, { kind: 'tool_confirm', id: 'c5', decision: 'allow_forever' })

    const card = findMsg(sessionId, 'tool-confirm-c5')
    expect(card?.metadata?.resolved).toBe(true)
    expect(card?.metadata?.decision).toBeUndefined()
  })

  it('never overwrites a settled card with an unrecognized decision (CS #25)', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleToolConfirmEvent(sessionId, { confirm_id: 'c6', tool: 'bash_exec', args: '{}', reasoning: '' })
    const card = findMsg(sessionId, 'tool-confirm-c6')!
    useChatStore.getState().updateMessage(sessionId, card.id, {
      metadata: { ...card.metadata, resolved: true, decision: 'confirmed' },
    })

    resolve(sessionId, { kind: 'tool_confirm', id: 'c6', decision: 'gibberish' })

    expect(findMsg(sessionId, 'tool-confirm-c6')?.metadata?.decision).toBe('confirmed')
  })
})

describe('handleHitlResolvedEvent — ask_user / step_limit / plan_review', () => {
  it('settles an ask_user form without inventing answers', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleAskUserEvent(sessionId, {
      request_id: 'au-1',
      questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'Yes', value: 'yes' }] }],
    })

    resolve(sessionId, { kind: 'ask_user', id: 'au-1' })

    const card = findMsg(sessionId, 'ask-user-au-1')
    expect(card?.metadata?.resolved).toBe(true)
    expect(card?.metadata?.answers).toBeUndefined()
  })

  it('records the effective step-limit decision', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleStepLimitEvent(sessionId, { request_id: 'sl-1', current_step: 10, max_steps: 10 })

    resolve(sessionId, { kind: 'step_limit', id: 'sl-1', decision: 'allow_more' })

    const card = findMsg(sessionId, 'step-limit-sl-1')
    expect(card?.metadata?.resolved).toBe(true)
    expect(card?.metadata?.decision).toBe('allow_more')
  })

  it('settles a step-limit card NEUTRALLY on an unrecognized decision (CS #25: no unchecked cast)', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleStepLimitEvent(sessionId, { request_id: 'sl-2', current_step: 10, max_steps: 10 })

    resolve(sessionId, { kind: 'step_limit', id: 'sl-2', decision: 'wave_it_through' })

    const card = findMsg(sessionId, 'step-limit-sl-2')
    expect(card?.metadata?.resolved).toBe(true)
    expect(card?.metadata?.decision).toBeUndefined()
  })

  it('never overwrites a settled step-limit card with an unrecognized decision (CS #25)', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleStepLimitEvent(sessionId, { request_id: 'sl-3', current_step: 10, max_steps: 10 })
    const card = findMsg(sessionId, 'step-limit-sl-3')!
    useChatStore.getState().updateMessage(sessionId, card.id, {
      metadata: { ...card.metadata, resolved: true, decision: 'deny' },
    })

    resolve(sessionId, { kind: 'step_limit', id: 'sl-3', decision: 'gibberish' })

    expect(findMsg(sessionId, 'step-limit-sl-3')?.metadata?.decision).toBe('deny')
  })

  it('settles a plan review card', () => {
    const sessionId = `sess-resolved-${idc++}`
    handlePlanReviewEvent(sessionId, { request_id: 'pr-1', plan_path: '/p.md', plan_content: '# Plan' })

    resolve(sessionId, { kind: 'plan_review', id: 'pr-1' })

    expect(findMsg(sessionId, 'plan-review-pr-1')?.metadata?.resolved).toBe(true)
  })
})

describe('resolveConfirmForToolResult — tool_result backstop', () => {
  it('settles an orphaned card the push never reached, neutrally', () => {
    const sessionId = `sess-resolved-${idc++}`
    useChatStore.getState().setMessages(sessionId, [
      {
        id: 'tool-tc10',
        sessionId,
        type: 'tool_call',
        content: '',
        metadata: { tool: 'bash_exec', args: '{}', step: 1, tool_call_id: 'tc10' },
        timestamp: 1,
      },
    ])
    handleToolConfirmEvent(sessionId, {
      confirm_id: 'c10',
      tool: 'bash_exec',
      args: '{}',
      tool_call_id: 'tc10',
      reasoning: '',
    })

    // The hitl_resolved push was missed; the result proves the tool ran.
    resolveConfirmForToolResult(sessionId, 'tc10')

    const card = findMsg(sessionId, 'tool-confirm-c10')
    expect(card?.metadata?.resolved).toBe(true)
    expect(card?.metadata?.decision).toBeUndefined()
    expect(findMsg(sessionId, 'tool-tc10')?.metadata?.awaiting_confirmation).toBe(false)
  })

  it('never overrides an existing resolution', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleToolConfirmEvent(sessionId, {
      confirm_id: 'c11',
      tool: 'bash_exec',
      args: '{}',
      tool_call_id: 'tc11',
      reasoning: '',
    })
    const card = findMsg(sessionId, 'tool-confirm-c11')!
    useChatStore.getState().updateMessage(sessionId, card.id, {
      metadata: { ...card.metadata, resolved: true, decision: 'denied' },
    })

    resolveConfirmForToolResult(sessionId, 'tc11')

    expect(findMsg(sessionId, 'tool-confirm-c11')?.metadata?.decision).toBe('denied')
  })

  it('is a no-op without a matching card or a correlatable id', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleToolConfirmEvent(sessionId, { confirm_id: 'c12', tool: 'bash_exec', args: '{}', reasoning: '' })
    // No tool_call_id on the card → uncorrelatable; and no id at all.
    resolveConfirmForToolResult(sessionId, 'tc-other')
    resolveConfirmForToolResult(sessionId, undefined)
    const card = findMsg(sessionId, 'tool-confirm-c12')
    expect(card?.metadata?.resolved).toBeFalsy()
  })
})

describe('handleHitlResolvedEvent — goal store convergence', () => {
  beforeEach(() => {
    useGoalStore.getState().clearAll()
  })

  it('clears the pending proposal only when it is the resolved one', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleGoalProposalEvent(sessionId, {
      request_id: 'gp-1',
      session_id: sessionId,
      condition: 'c',
      verify: 'v',
    })

    resolve(sessionId, { kind: 'goal_proposal', id: 'gp-1' })

    expect(useGoalStore.getState().pendingProposal[sessionId]).toBeUndefined()
    expect(findMsg(sessionId, 'goal-proposal-gp-1')?.metadata?.resolved).toBe(true)
  })

  it('settles the goal-store mirror even when this surface never rendered the card', () => {
    const sessionId = `sess-resolved-${idc++}`
    // The store entry without the chat message: the card may never have been
    // rendered here (event missed, reconcile dropped it) while the badge/panel
    // state lives on independently.
    useGoalStore.getState().setPendingProposal(sessionId, {
      request_id: 'gp-ghost',
      session_id: sessionId,
      condition: 'c',
      verify: 'v',
    })

    resolve(sessionId, { kind: 'goal_proposal', id: 'gp-ghost' })

    expect(useGoalStore.getState().pendingProposal[sessionId]).toBeUndefined()
  })

  it('keeps a NEWER pending proposal when the resolved id differs', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleGoalProposalEvent(sessionId, {
      request_id: 'gp-newer',
      session_id: sessionId,
      condition: 'c2',
      verify: 'v2',
    })

    resolve(sessionId, { kind: 'goal_proposal', id: 'gp-older' })

    expect(useGoalStore.getState().pendingProposal[sessionId]?.request_id).toBe('gp-newer')
  })

  it('clears the pending suggestion when it is the resolved one', () => {
    const sessionId = `sess-resolved-${idc++}`
    handleGoalSuggestionEvent(sessionId, {
      request_id: 'gs-1',
      session_id: sessionId,
      reason: 'looks like a goal',
    })

    resolve(sessionId, { kind: 'goal_suggestion', id: 'gs-1' })

    expect(useGoalStore.getState().pendingSuggestion[sessionId]).toBeUndefined()
    expect(findMsg(sessionId, 'goal-suggestion-gs-1')?.metadata?.resolved).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pending-HITL override reconcile — a hitl_resolved broadcast must retire the
// sticky pendingOverride bit in activeSessionsStore (its only `false` writer —
// THIS surface answering the prompt itself — cannot run when ANOTHER surface
// resolved the prompt), applying the backend's authoritative answer rather
// than blindly clearing (a second prompt may already be pending).
// ---------------------------------------------------------------------------

const mockedGetPendingActions = vi.mocked(getPendingActions)

const EMPTY_PENDING: PendingActionsResponse = {
  tool_confirms: [],
  step_limits: [],
  plan_approvals: [],
  ask_user: [],
  goal_proposals: [],
  goal_suggestions: [],
}

describe('handleHitlResolvedEvent — pending-override reconcile', () => {
  /** Drain the fire-and-forget `.then()` tail of the reconcile. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  beforeEach(() => {
    mockedGetPendingActions.mockReset()
    mockedGetPendingActions.mockResolvedValue(EMPTY_PENDING)
    useActiveSessionsStore.setState({ pendingOverride: {} })
    loggerMocks.error.mockClear()
    loggerMocks.warn.mockClear()
    loggerMocks.info.mockClear()
    loggerMocks.debug.mockClear()
  })

  // Every test here adds NO card to chatStore: the reconcile must run before
  // the chat-card early return, i.e. exactly when the card was never rendered
  // on this surface (criterion 4).
  it.each([
    'tool_confirm',
    'ask_user',
    'step_limit',
    'plan_review',
    'goal_proposal',
    'goal_suggestion',
  ] as const)(
    'reconciles a sticky override for %s: exactly one re-query, empty answer clears the bit (no card needed)',
    async (kind) => {
      const sessionId = `sess-reconcile-${idc++}`
      useActiveSessionsStore.getState().setPendingOverride(sessionId, true)

      resolve(sessionId, { kind, id: 'whatever' })

      // The re-query is scheduled synchronously, before the card lookup — the
      // empty chatStore in this test proves the early return cannot prevent it.
      expect(mockedGetPendingActions).toHaveBeenCalledTimes(1)
      expect(mockedGetPendingActions).toHaveBeenCalledWith(sessionId)

      await flush()
      // Empty authoritative answer → bit removed (the KEY is deleted, not
      // stored as false), and exactly one RPC per event.
      expect(useActiveSessionsStore.getState().pendingOverride[sessionId]).toBeUndefined()
      expect(mockedGetPendingActions).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps the bit when the authoritative answer still carries a pending prompt', async () => {
    const sessionId = `sess-reconcile-${idc++}`
    useActiveSessionsStore.getState().setPendingOverride(sessionId, true)
    mockedGetPendingActions.mockResolvedValue({
      ...EMPTY_PENDING,
      ask_user: [{ request_id: 'au-second', questions: [] }],
    })

    resolve(sessionId, { kind: 'ask_user', id: 'au-second' })
    await flush()

    expect(useActiveSessionsStore.getState().pendingOverride[sessionId]).toBe(true)
    expect(mockedGetPendingActions).toHaveBeenCalledTimes(1)
  })

  it('never re-queries when the override bit is absent (or false)', () => {
    const sessionId = `sess-reconcile-${idc++}`

    resolve(sessionId, { kind: 'tool_confirm', id: 'ghost' })

    expect(mockedGetPendingActions).not.toHaveBeenCalled()
  })

  it('keeps the bit and logs at debug when the re-query fails (null is not authoritative)', async () => {
    const sessionId = `sess-reconcile-${idc++}`
    useActiveSessionsStore.getState().setPendingOverride(sessionId, true)
    mockedGetPendingActions.mockResolvedValue(null)

    resolve(sessionId, { kind: 'tool_confirm', id: 'ghost' })
    await flush()

    expect(useActiveSessionsStore.getState().pendingOverride[sessionId]).toBe(true)
    expect(loggerMocks.debug).toHaveBeenCalledTimes(1)
    expect(loggerMocks.debug).toHaveBeenCalledWith(expect.stringContaining('keeping override'), sessionId)
    expect(loggerMocks.error).not.toHaveBeenCalled()
    expect(loggerMocks.warn).not.toHaveBeenCalled()
  })
})
