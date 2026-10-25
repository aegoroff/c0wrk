// @vitest-environment jsdom
//
// WorkDirsModal — the "Add directory" gesture opens the OS-native directory
// dialog (pickDirectory). The web transport has no native dialog, so the
// button is disabled there (title explains why); the wails transport keeps it
// enabled. This file exists to pin that transport gating.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { isWebTransportMock, onGlobalEventMock } = vi.hoisted(() => ({
  isWebTransportMock: vi.fn(() => false),
  onGlobalEventMock: vi.fn(() => () => {}),
}))

vi.mock('@/api/runtime', () => ({
  isWebTransport: isWebTransportMock,
  onGlobalEvent: onGlobalEventMock,
}))

vi.mock('@/api/workdirs', () => ({
  listProjectWorkDirectories: vi.fn(async () => []),
  listSessionWorkDirectories: vi.fn(async () => []),
  addWorkDirectory: vi.fn(),
  updateWorkDirectoryDescription: vi.fn(),
  deleteWorkDirectory: vi.fn(),
}))

vi.mock('@/api/projects', () => ({
  pickDirectory: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { WorkDirsModal } from './WorkDirsModal'
import { useWorkDirsStore } from '@/stores/workDirsStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'

describe('WorkDirsModal add-directory gating across transports', () => {
  let container: HTMLDivElement
  let root: Root | null = null

  beforeEach(() => {
    isWebTransportMock.mockReturnValue(false)
    act(() => {
      useWorkDirsStore.setState({ open: true, projectDirs: [], sessionDirs: [], loading: false })
      useProjectStore.setState({ projects: null, activeProjectId: null, lastRealProjectId: null })
      useSessionStore.setState({ activeSessionId: null })
    })
    container = document.createElement('div')
    document.body.replaceChildren(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount()
      })
    }
    document.body.innerHTML = ''
    isWebTransportMock.mockReturnValue(false)
  })

  function renderModal() {
    return act(async () => {
      root!.render(<WorkDirsModal />)
    })
  }

  function addButton(): HTMLButtonElement {
    const el = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add directory'),
    )
    expect(el).not.toBeNull()
    return el!
  }

  it('enables Add directory in the wails transport', async () => {
    isWebTransportMock.mockReturnValue(false)
    await renderModal()
    expect(addButton().disabled).toBe(false)
  })

  it('disables Add directory in the web transport (native dialog only)', async () => {
    isWebTransportMock.mockReturnValue(true)
    await renderModal()
    const button = addButton()
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('desktop app')
  })
})
