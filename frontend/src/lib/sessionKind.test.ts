// Unit tests for lib/sessionKind.ts — the store-reading session-kind
// resolver the /-completion reads at trigger time and the send path reads at
// send time. The pure project_id mapping itself is covered in
// capabilityModes.test.ts; these cover the store plumbing and the
// session-switch flip.

import { describe, it, expect, beforeEach } from 'vitest'

import { activeSessionKind, sessionKindForSession } from '@/lib/sessionKind'
import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import { NO_PROJECT_ID, type SessionInfo } from '@/types/models'

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    project_id: overrides.project_id ?? 'proj-1',
    name: overrides.name ?? `Session ${overrides.id}`,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    last_active_at: overrides.last_active_at ?? '2026-01-01T00:00:00Z',
    archived: overrides.archived ?? false,
    pinned: overrides.pinned ?? false,
    active: overrides.active ?? false,
    total_input_tokens: overrides.total_input_tokens ?? 0,
    total_output_tokens: overrides.total_output_tokens ?? 0,
    model: overrides.model ?? 'test-model',
    family: overrides.family ?? 'test',
    has_unfinished_task: overrides.has_unfinished_task ?? false,
    ...overrides,
  }
}

beforeEach(() => {
  useSessionStore.setState({ sessions: null, activeSessionId: null })
  useProjectStore.setState({ projects: null, activeProjectId: null })
})

describe('sessionKindForSession', () => {
  it('resolves the kind from the session\u2019s own project_id', () => {
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'chat-sess', project_id: NO_PROJECT_ID }),
        makeSession({ id: 'code-sess', project_id: 'proj-1' }),
      ],
      activeSessionId: 'chat-sess',
    })
    expect(sessionKindForSession('chat-sess')).toBe('chat')
    expect(sessionKindForSession('code-sess')).toBe('code')
  })

  it('falls back to the active project context when the id is unknown to the store', () => {
    // The transient window around a project switch (sessions not loaded) —
    // a session created right now would land in the active project.
    useSessionStore.setState({ sessions: [], activeSessionId: 'sess-x' })
    useProjectStore.setState({ projects: [], activeProjectId: 'proj-9' })
    expect(sessionKindForSession('sess-x')).toBe('code')

    useProjectStore.setState({ projects: [], activeProjectId: null })
    expect(sessionKindForSession('sess-x')).toBe('chat')
  })

  it('falls back to the active project context when no session is active', () => {
    useProjectStore.setState({ projects: [], activeProjectId: NO_PROJECT_ID })
    expect(sessionKindForSession(null)).toBe('chat')
    useProjectStore.setState({ projects: [], activeProjectId: 'proj-2' })
    expect(sessionKindForSession(null)).toBe('code')
  })
})

describe('activeSessionKind', () => {
  it('follows the ACTIVE session — switching sessions flips the filter input', () => {
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'chat-sess', project_id: NO_PROJECT_ID }),
        makeSession({ id: 'code-sess', project_id: 'proj-1' }),
      ],
      activeSessionId: 'chat-sess',
    })
    expect(activeSessionKind()).toBe('chat')

    // The session switch the AC calls for: the completion re-reads the kind
    // on the next trigger, so the offered sets follow the active session.
    useSessionStore.setState({ activeSessionId: 'code-sess' })
    expect(activeSessionKind()).toBe('code')

    useSessionStore.setState({ activeSessionId: null })
    // No active session: the project context stands in.
    useProjectStore.setState({ projects: [], activeProjectId: 'proj-1' })
    expect(activeSessionKind()).toBe('code')
  })
})
