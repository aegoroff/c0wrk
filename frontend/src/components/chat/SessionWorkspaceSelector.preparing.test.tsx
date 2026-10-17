// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider, TOOLTIP_DELAY_MS } from '@/components/ui/tooltip'
import { createManagedSession, createSession } from '@/api/sessions'
import { createSessionFromDraft } from '@/lib/sessionDraft'
import { logger } from '@/lib/logger'
import { useExperimentalStore } from '@/stores/experimentalStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionDraftStore } from '@/stores/sessionDraftStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { SessionInfo } from '@/types/models'
import { SessionWorkspaceSelector } from './SessionWorkspaceSelector'

vi.mock('@/api/sessions', () => ({ createManagedSession: vi.fn(), createSession: vi.fn() }))
vi.mock('@/api/projects', () => ({ saveProjectActiveSession: vi.fn(() => Promise.resolve()) }))

let root: Root
let container: HTMLDivElement
const hint = 'Preparing worktree…'
const indicator = () => container.querySelector<HTMLElement>('[role="status"]')
const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="session-workspace-selector"]')

function deferredSession() {
  let resolve!: (value: SessionInfo) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<SessionInfo>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function armBranch(projectId = 'proj-1') {
  useSessionDraftStore.getState().startDraft(projectId)
  useSessionDraftStore.getState().setDraftWorkspace({
    kind: 'branch', branch: 'feat/x', createBranch: false, startPoint: '',
  })
}

function render() {
  act(() => root.render(
    <TooltipProvider>
      <SessionWorkspaceSelector />
    </TooltipProvider>,
  ))
}

function session(): SessionInfo {
  return {
    id: 's-1', project_id: 'proj-1', name: 'Session',
    created_at: '', last_active_at: '', archived: false, pinned: false,
    active: false, total_input_tokens: 0, total_output_tokens: 0,
    model: 'm', family: 'f', has_unfinished_task: false,
    workspace_binding: {
      kind: 'managed_worktree', workspace_path: '/w/proj/.worktrees/s-1',
      worktree_name: 's-1', branch: 'feat/x',
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.useFakeTimers()
  vi.mocked(createManagedSession).mockReset()
  vi.mocked(createSession).mockReset()
  useExperimentalStore.setState({ enabled: true })
  useSessionStore.setState({ sessions: null, activeSessionId: null })
  useSessionDraftStore.setState({ draft: null, committing: false, committingDraft: null })
  useProjectStore.setState({ activeProjectId: 'proj-1', projects: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('managed workspace preparation', () => {
  it.each(['resolve', 'reject'] as const)('tracks the entire managed RPC until %s', async (outcome) => {
    armBranch()
    const rpc = deferredSession()
    vi.mocked(createManagedSession).mockReturnValue(rpc.promise)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    render()
    expect(indicator()).toBeNull()
    let pending!: Promise<SessionInfo | unknown>
    act(() => { pending = createSessionFromDraft().catch((error: unknown) => error) })

    expect(createManagedSession).toHaveBeenCalledWith('feat/x', false, '')
    // The live region carries the announcement as its own text content, not
    // only as an aria-label (a role="status" with empty content announces
    // unreliably). Assert the real content screen readers announce.
    expect(indicator()?.textContent).toBe(hint)
    expect(indicator()?.querySelector('.sr-only')?.textContent).toBe(hint)
    expect(indicator()?.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
    expect(trigger()?.disabled).toBe(true)
    expect(trigger()?.contains(indicator())).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(indicator()).not.toBeNull()

    const error = new Error('provisioning failed')
    await act(async () => {
      if (outcome === 'resolve') rpc.resolve(session())
      else rpc.reject(error)
      await pending
    })
    expect(indicator()).toBeNull()
    expect(useSessionDraftStore.getState().committing).toBe(false)
    expect(useSessionDraftStore.getState().committingDraft).toBeNull()
    if (outcome === 'reject') {
      expect(errorSpy).toHaveBeenCalledExactlyOnceWith('Failed to create session from draft:', error)
      expect(useSessionDraftStore.getState().draft?.workspace.kind).toBe('branch')
      expect(trigger()?.disabled).toBe(false)
    } else {
      expect(errorSpy).not.toHaveBeenCalled()
      expect(container.querySelector('[data-testid="session-workspace-readonly"]')?.getAttribute('aria-disabled')).toBe('true')
    }
  })

  it('keeps hover and keyboard hints reachable outside the disabled selector', async () => {
    armBranch()
    useSessionDraftStore.getState().setCommitting(true)
    render()
    const status = indicator()!
    expect(status.tabIndex).toBe(0)
    act(() => status.focus())
    expect(document.activeElement).toBe(status)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(hint)
    act(() => status.blur())
    const move = new MouseEvent('pointermove', { bubbles: true })
    Object.defineProperty(move, 'pointerType', { value: 'mouse' })
    act(() => status.dispatchEvent(move))
    await act(async () => { await vi.advanceTimersByTimeAsync(TOOLTIP_DELAY_MS) })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(hint)
    expect(trigger()?.disabled).toBe(true)
  })

  it('does not show a WT spinner for a pending local creation', async () => {
    useSessionDraftStore.getState().startDraft('proj-1')
    const rpc = deferredSession()
    vi.mocked(createSession).mockReturnValue(rpc.promise)
    render()
    let pending!: Promise<SessionInfo>
    act(() => { pending = createSessionFromDraft() })
    expect(useSessionDraftStore.getState().committing).toBe(true)
    expect(trigger()?.disabled).toBe(true)
    expect(indicator()).toBeNull()
    act(() => armBranch())
    expect(indicator()).toBeNull()
    await act(async () => { rpc.resolve(session()); await pending })
  })

  it('hides the spinner on a project switch while the managed RPC is pending', async () => {
    armBranch()
    const rpc = deferredSession()
    vi.mocked(createManagedSession).mockReturnValue(rpc.promise)
    render()
    let pending!: Promise<SessionInfo>
    act(() => { pending = createSessionFromDraft() })
    expect(indicator()).not.toBeNull()
    act(() => useProjectStore.setState({ activeProjectId: 'proj-other' }))
    expect(indicator()).toBeNull()
    expect(trigger()?.textContent).toContain('local')
    act(() => armBranch('proj-other'))
    expect(trigger()?.textContent).toContain('feat/x')
    expect(indicator()).toBeNull()
    expect(useSessionDraftStore.getState().committingDraft?.projectId).toBe('proj-1')
    await act(async () => { rpc.resolve(session()); await pending })
  })

  it.each(['experimental off', 'No Project', 'no active project', 'foreign draft'])(
    'does not show a WT spinner for %s', (gate) => {
      armBranch(gate === 'foreign draft' ? 'proj-other' : 'proj-1')
      useSessionDraftStore.getState().setCommitting(true)
      if (gate === 'experimental off') useExperimentalStore.setState({ enabled: false })
      if (gate === 'no active project') useProjectStore.setState({ activeProjectId: null })
      if (gate === 'No Project') useProjectStore.setState({
        activeProjectId: '__no_project__',
        projects: [{
          id: '__no_project__', name: 'No Project', workspace_path: '',
          is_external: false, is_no_project: true, created_at: '', last_active_at: '',
        }],
      })
      render()
      expect(indicator()).toBeNull()
      if (gate !== 'foreign draft') expect(trigger()).toBeNull()
    },
  )
})
