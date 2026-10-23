// Unit tests for lib/sessionDeleteBlock.ts — recognition of the backend's
// session-deletion refusal (`SessionDeleteBlockedError`).

import { describe, it, expect } from 'vitest'

import { parseSessionDeleteBlock } from './sessionDeleteBlock'

// The exact refusal texts `backend/frontend_api_worktrees.go` produces.
const DIRTY_REASON =
  'the session\'s worktree "s-abc12345" (branch feat/a) contains uncommitted ' +
  'changes; deleting the session removes the tree and those changes cannot ' +
  'be recovered (the branch itself is kept)'
const LOCKED_REASON = 'the session\'s worktree "s-abc12345" is locked (locked for safety)'

const dirtyBlock = `session deletion blocked: ${DIRTY_REASON} (confirm via confirm_uncommitted_loss)`
const lockedBlock = `session deletion blocked: ${LOCKED_REASON} (confirm via unlock_locked_tree)`

describe('parseSessionDeleteBlock', () => {
  it('parses the dirty-tree refusal and names the loss-confirmation option', () => {
    expect(parseSessionDeleteBlock(new Error(dirtyBlock))).toEqual({
      reason: DIRTY_REASON,
      option: 'confirm_uncommitted_loss',
    })
  })

  it('parses the locked-tree refusal and names the unlock option', () => {
    expect(parseSessionDeleteBlock(new Error(lockedBlock))).toEqual({
      reason: LOCKED_REASON,
      option: 'unlock_locked_tree',
    })
  })

  it('parses plain-string rejections the same way as Error instances', () => {
    // Wails delivers Go RPC errors as plain strings, not Error objects.
    expect(parseSessionDeleteBlock(dirtyBlock)).toEqual({
      reason: DIRTY_REASON,
      option: 'confirm_uncommitted_loss',
    })
    expect(parseSessionDeleteBlock(lockedBlock)).toEqual({
      reason: LOCKED_REASON,
      option: 'unlock_locked_tree',
    })
  })

  it('parses a reason that itself contains parentheses (branch note)', () => {
    // The dirty-tree reason quotes the worktree name and carries "(branch …)"
    // plus "(the branch itself is kept)" — the suffix must still anchor.
    expect(parseSessionDeleteBlock(dirtyBlock)?.reason).toBe(DIRTY_REASON)
  })

  it('returns null for unrelated errors', () => {
    expect(parseSessionDeleteBlock(new Error('session manager not initialized'))).toBeNull()
    expect(parseSessionDeleteBlock('db is locked')).toBeNull()
    expect(parseSessionDeleteBlock(new Error('release session worktree "s-1": exit status 128'))).toBeNull()
  })

  it('returns null for near-miss formats that only look like a block', () => {
    // Missing the confirm-via suffix entirely.
    expect(parseSessionDeleteBlock('session deletion blocked: something went wrong')).toBeNull()
    // Empty option slot.
    expect(parseSessionDeleteBlock('session deletion blocked: reason (confirm via )')).toBeNull()
    // Option is not a field-name identifier.
    expect(parseSessionDeleteBlock('session deletion blocked: reason (confirm via just do it)')).toBeNull()
    // A mere mention inside a longer message is not a refusal.
    expect(
      parseSessionDeleteBlock(`failed: ${dirtyBlock}: and then the retry also failed`),
    ).toBeNull()
    // Wrong prefix casing.
    expect(parseSessionDeleteBlock(`Session deletion blocked: r (confirm via unlock_locked_tree)`)).toBeNull()
  })

  it('returns null for non-string, non-Error values', () => {
    expect(parseSessionDeleteBlock(null)).toBeNull()
    expect(parseSessionDeleteBlock(undefined)).toBeNull()
    expect(parseSessionDeleteBlock(42)).toBeNull()
    expect(parseSessionDeleteBlock({ message: dirtyBlock })).toBeNull()
  })
})
