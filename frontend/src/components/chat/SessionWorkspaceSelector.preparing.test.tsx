// Tests for the send-time "Preparing worktree…" hint (ADR-091): while a
// send carrying the session's workspace choice is on the wire (the store's
// consumption window), the fresh-session selector shows a spinner beside
// the picker; the hint disappears when the send settles — success OR
// failure — and the picker itself stays interactive throughout.
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'

import { SessionWorkspaceSelector } from './SessionWorkspaceSelector'
import { useSessionWorkspaceStore, pendingWorkspaceToWire } from '@/stores/sessionWorkspaceStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useChatStore } from '@/stores/chatStore'
import { useProjectStore } from '@/stores/projectStore'
import type { ProjectInfo } from '@/types/models'

let container: HTMLDivElement | null = null
let root: Root | null = null

function makeProject(): ProjectInfo {
  return {
    id: 'proj-1',
    name: 'Proj',
    workspace_path: '/w/proj',
    is_external: false,
    is_no_project: false,
    created_at: '2026-01-01T00:00:00Z',
    last_active_at: '2026-01-01T00:00:00Z',
  }
}

function renderSelector() {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  act(() => {
    r.render(
      <TooltipProvider>
        <SessionWorkspaceSelector />
      </TooltipProvider>,
    )
  })
}

function body(): HTMLElement {
  return document.body
}


function trigger(): HTMLButtonElement | null {
  return body().querySelector<HTMLButtonElement>('[data-testid="session-workspace-selector"]')
}

function preparing(): HTMLElement | null {
  return body().querySelector<HTMLElement>('[role="status"]')
}

/** Arm the ACTIVE fresh session with a branch choice (the send-to-come
 *  carries it as the workspace argument). */
function armChoice(id = 's-1') {
  useSessionStore.setState({
    sessions: [{ id, project_id: 'proj-1', name: 'S', created_at: '', last_active_at: '', archived: false, pinned: false, active: false, total_input_tokens: 0, total_output_tokens: 0, model: '', family: '', has_unfinished_task: false }],
    activeSessionId: id,
  })
  useChatStore.setState({ messages: { [id]: {} }, taskActive: {}, paused: {} })
  useSessionWorkspaceStore.getState().setChoice(id, {
    kind: 'branch',
    branch: 'feat/x',
    createBranch: false,
    startPoint: '',
  })
}

beforeEach(() => {
  useSessionWorkspaceStore.setState({ choices: {}, consumingFor: null })
  useSessionStore.setState({ sessions: null, activeSessionId: null })
  useChatStore.setState({ messages: {}, taskActive: {}, paused: {} })
  useProjectStore.setState({ activeProjectId: 'proj-1', projects: [makeProject()] })
})

afterEach(() => {
  if (root) {
    const r = root
    root = null
    act(() => {
      r.unmount()
    })
  }
  container?.remove()
  container = null
})

describe('Worktree preparing hint (send-time consumption window)', () => {
  it('shows the spinner while the choice is being consumed, then hides it', () => {
    armChoice()
    renderSelector()
    expect(preparing()).toBeNull()

    // The send captured the choice and put it on the wire.
    act(() => {
      useSessionWorkspaceStore.getState().beginConsumption('s-1')
    })
    expect(preparing()).not.toBeNull()
    // The spinner's accessible name announces what is happening.
    expect(preparing()!.textContent).toContain('Preparing worktree')

    // The send settles (success or failure — the hint goes either way).
    act(() => {
      useSessionWorkspaceStore.getState().endConsumption()
    })
    expect(preparing()).toBeNull()
    // The picker itself stays interactive throughout the window.
    expect(trigger()).not.toBeNull()
  })

  it('another session\'s consumption window never lights this selector', () => {
    armChoice('s-1')
    renderSelector()

    act(() => {
      useSessionWorkspaceStore.getState().beginConsumption('s-other')
    })
    expect(preparing()).toBeNull()
  })

  it('the wire conversion maps only branch choices; local/absent send null', () => {
    expect(pendingWorkspaceToWire({ kind: 'branch', branch: 'feat/x', createBranch: true, startPoint: 'origin/feat/x' })).toEqual({
      branch: 'feat/x',
      create_branch: true,
      start_point: 'origin/feat/x',
    })
    expect(pendingWorkspaceToWire({ kind: 'local' })).toBeNull()
    expect(pendingWorkspaceToWire(undefined)).toBeNull()
  })
})
