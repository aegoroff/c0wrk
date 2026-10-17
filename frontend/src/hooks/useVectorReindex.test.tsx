// Behavior of the force-full-reindex action's state machine (useVectorReindex):
// the ADR-064 `loading` open reads as busy with its own tooltip; the terminal
// `unavailable` state (a failed open / init failure) disables the action
// WITHOUT the busy spinner and with an actionable tooltip — a reindex cannot
// repair a missing collection — and clicking it must not fire the RPC. Uses
// the real stores; only the RPC boundary (@/api/vector) is mocked.

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const reindexSpy = vi.hoisted(() => vi.fn())

vi.mock('@/api/vector', () => ({
  reindexVectorIndex: reindexSpy,
}))

import { useVectorReindex } from '@/hooks/useVectorReindex'
import { useVectorIndexStore } from '@/stores/vectorIndexStore'
import { useProjectStore } from '@/stores/projectStore'
import type { VectorIndexStatus } from '@/types/models'

const statusWith = (state: VectorIndexStatus['state']): VectorIndexStatus => ({
  state,
  progress: 0,
  files_indexed: 0,
  total_files: 0,
})

// Harness: capture the latest hook return so tests can assert and click.
let latest: ReturnType<typeof useVectorReindex> | null = null
function Harness() {
  latest = useVectorReindex()
  return null
}

/** The captured hook return, failing loudly if never rendered. */
function hook(): ReturnType<typeof useVectorReindex> {
  if (!latest) throw new Error('harness did not capture the hook return')
  return latest
}

let container: HTMLElement
let root: Root

beforeEach(() => {
  reindexSpy.mockReset()
  reindexSpy.mockResolvedValue(undefined)
  act(() => {
    useVectorIndexStore.getState().reset()
    useProjectStore.setState({ activeProjectId: 'proj-1' })
  })
  container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  act(() => {
    useProjectStore.setState({ activeProjectId: null })
  })
})

describe('useVectorReindex — the terminal unavailable state', () => {
  it('disables the action without the busy spinner and names the real reason', () => {
    act(() => {
      useVectorIndexStore.setState({ status: statusWith('unavailable') })
    })
    act(() => {
      root.render(<Harness />)
    })
    expect(hook().reindexDisabled).toBe(true)
    // Nothing is running: unavailable is terminal, not busy — no spinner.
    expect(hook().reindexBusy).toBe(false)
    expect(hook().reindexDisabledTitle).toBe(
      'Index unavailable — switch branch or reopen the project to retry',
    )
  })

  it('never fires the reindex RPC while the index is unavailable', () => {
    act(() => {
      useVectorIndexStore.setState({ status: statusWith('unavailable') })
    })
    act(() => {
      root.render(<Harness />)
    })
    act(() => {
      hook().handleReindex()
    })
    expect(reindexSpy).not.toHaveBeenCalled()
    // The guard runs before the optimistic latch: no busy state either.
    expect(hook().reindexBusy).toBe(false)
  })

  it('releases a pending optimistic latch when the index turns unavailable', () => {
    act(() => {
      useVectorIndexStore.setState({ status: statusWith('ready') })
    })
    act(() => {
      root.render(<Harness />)
    })
    act(() => {
      hook().handleReindex()
    })
    // The optimistic latch owns the busy state until a status event lands.
    expect(hook().reindexBusy).toBe(true)
    // The backend reports the failed open instead of a busy state: the latch
    // must release, leaving only the terminal disabled state behind.
    act(() => {
      useVectorIndexStore.setState({ status: statusWith('unavailable') })
    })
    expect(hook().reindexBusy).toBe(false)
    expect(hook().reindexDisabled).toBe(true)
  })
})

describe('useVectorReindex — busy states (unchanged)', () => {
  it('counts the ADR-064 DB open as busy with its own tooltip', () => {
    act(() => {
      useVectorIndexStore.setState({ status: statusWith('loading') })
    })
    act(() => {
      root.render(<Harness />)
    })
    expect(hook().reindexDisabled).toBe(true)
    expect(hook().reindexBusy).toBe(true)
    expect(hook().reindexDisabledTitle).toBe('Opening the index…')
  })

  it('reports a plain click as busy during the optimistic latch', () => {
    act(() => {
      useVectorIndexStore.setState({ status: statusWith('ready') })
    })
    act(() => {
      root.render(<Harness />)
    })
    expect(hook().reindexDisabled).toBe(false)
    act(() => {
      hook().handleReindex()
    })
    expect(reindexSpy).toHaveBeenCalledTimes(1)
    // The optimistic latch owns the disabled state until a status event lands.
    expect(hook().reindexBusy).toBe(true)
    expect(hook().reindexDisabled).toBe(true)
    expect(hook().reindexDisabledTitle).toBe('Reindexing...')
  })
})
