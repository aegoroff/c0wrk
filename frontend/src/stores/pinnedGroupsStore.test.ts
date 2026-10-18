// Tests for the group-pins store's stale-pin pruning (`prunePins`): a branch
// whose last session is gone must not keep its pin forever (it could never
// surface again), while a branch that still holds ANY group — live or
// archived — keeps its pin. Pure store tests, no React rendering; the jsdom
// environment only provides `localStorage` for the persist middleware.

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { usePinnedGroupsStore } from './pinnedGroupsStore'

beforeEach(() => {
  usePinnedGroupsStore.setState({ pinsByProject: {} })
})

describe('prunePins', () => {
  it('drops pins whose branch holds no live or archived group', () => {
    usePinnedGroupsStore.setState({ pinsByProject: { p1: ['live', 'gone', 'archived-only'] } })

    usePinnedGroupsStore.getState().prunePins('p1', ['live', 'archived-only'])

    expect(usePinnedGroupsStore.getState().pinsByProject.p1).toEqual(['live', 'archived-only'])
  })

  it('removes the whole per-project entry when every pin went stale', () => {
    usePinnedGroupsStore.setState({ pinsByProject: { p1: ['gone'], p2: ['kept'] } })

    usePinnedGroupsStore.getState().prunePins('p1', [])

    // The emptied entry is deleted outright — storage stays bounded.
    expect(usePinnedGroupsStore.getState().pinsByProject.p1).toBeUndefined()
    expect(usePinnedGroupsStore.getState().pinsByProject.p2).toEqual(['kept'])
  })

  it('is an identity-preserving no-op when nothing is stale', () => {
    usePinnedGroupsStore.setState({ pinsByProject: { p1: ['feat-a'] } })
    const before = usePinnedGroupsStore.getState()

    usePinnedGroupsStore.getState().prunePins('p1', ['feat-a', 'feat-b'])

    expect(usePinnedGroupsStore.getState()).toBe(before)
  })

  it('never touches other projects', () => {
    usePinnedGroupsStore.setState({ pinsByProject: { p1: ['gone', 'kept'], p2: ['gone'] } })

    usePinnedGroupsStore.getState().prunePins('p1', ['kept'])

    expect(usePinnedGroupsStore.getState().pinsByProject).toEqual({ p1: ['kept'], p2: ['gone'] })
  })

  it('is a no-op for a project with no pins at all', () => {
    const before = usePinnedGroupsStore.getState()

    usePinnedGroupsStore.getState().prunePins('p-none', ['feat-a'])

    expect(usePinnedGroupsStore.getState()).toBe(before)
  })

  it('toggling after a prune starts from the pruned list', () => {
    usePinnedGroupsStore.setState({ pinsByProject: { p1: ['gone'] } })
    usePinnedGroupsStore.getState().prunePins('p1', ['feat-a'])
    expect(usePinnedGroupsStore.getState().pinsByProject.p1).toBeUndefined()

    usePinnedGroupsStore.getState().togglePinnedBranch('p1', 'feat-a')

    expect(usePinnedGroupsStore.getState().pinsByProject.p1).toEqual(['feat-a'])
  })
})
