// Tests for handleHitlResolvedEvent — the multi-surface HITL convergence
// handler: a hitl_resolved broadcast (a prompt consumed by ANOTHER surface)
// must retire the local card immediately, converge a raced local decision on
// the effective one, and never wipe a NEWER goal-store prompt.

import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, selectSessionMessages } from '@/stores/chatStore'
import { useGoalStore } from '@/stores/goalStore'
import { handleToolConfirmEvent, handleAskUserEvent, handleStepLimitEvent, handlePlanReviewEvent, handleHitlResolvedEvent, resolveConfirmForToolResult } from './hitlHandlers'
import { handleGoalProposalEvent, handleGoalSuggestionEvent } from './goalHandlers'
import type { HitlResolvedData } from '@/types/events'

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
