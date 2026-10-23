// @vitest-environment jsdom
//
// Invariant under test: the directory picker returns an OS-native path. When a
// Windows directory is picked (`C:\Users\me\proj`) the auto-filled project name
// must be the final segment, not the whole path — a plain split('/') leaves the
// entire string in the field. The picked path is additionally rendered with the
// `truncate` overflow guard so long paths never stretch the dialog.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { pickDirectoryMock, createProjectMock, isWebTransportMock } = vi.hoisted(() => ({
  pickDirectoryMock: vi.fn<() => Promise<string>>(),
  createProjectMock: vi.fn<(name: string, path: string) => Promise<{ id: string }>>(),
  isWebTransportMock: vi.fn(() => false),
}))

vi.mock('@/api/projects', () => ({
  pickDirectory: pickDirectoryMock,
  createProject: createProjectMock,
}))

vi.mock('@/api/runtime', () => ({
  isWebTransport: isWebTransportMock,
}))

vi.mock('@/hooks/useProjectSwitchState', () => ({
  useProjectSwitchState: () => vi.fn(async () => {}),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { CreateProjectDialog } from './CreateProjectDialog'

// Radix portals the dialog content to document.body, so queries target the
// whole document rather than the render container.
const dialogEl = () => document.querySelector<HTMLElement>('[role="dialog"]')
const findButton = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
const nameInput = () => dialogEl()?.querySelector('input') ?? null

describe('CreateProjectDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    pickDirectoryMock.mockReset()
    createProjectMock.mockReset()
    isWebTransportMock.mockReturnValue(false)
    container = document.createElement('div')
    document.body.replaceChildren(container)
    root = createRoot(container)
  })

  const renderOpen = () =>
    act(async () => {
      root.render(<CreateProjectDialog open onOpenChange={() => {}} />)
    })

  it('derives the project name from the final segment of a Windows path', async () => {
    pickDirectoryMock.mockResolvedValue('C:\\Users\\tomsk\\Downloads\\imap_chrome_extension')
    await renderOpen()

    await act(async () => {
      findButton('Choose directory')?.click()
    })

    expect((nameInput() as HTMLInputElement | null)?.value).toBe('imap_chrome_extension')
    // The full path stays visible (ellipsized) and is exposed via the title.
    // The directory button also carries a title, so target the path display
    // paragraph explicitly rather than the first [title] in the dialog.
    expect(dialogEl()?.querySelector('p[title]')?.getAttribute('title')).toBe(
      'C:\\Users\\tomsk\\Downloads\\imap_chrome_extension',
    )
  })

  it('derives the project name from the final segment of a POSIX path', async () => {
    pickDirectoryMock.mockResolvedValue('/Users/dev/projects/my-app')
    await renderOpen()

    await act(async () => {
      findButton('Choose directory')?.click()
    })

    expect((nameInput() as HTMLInputElement | null)?.value).toBe('my-app')
  })

  it('does not overwrite a name the user already typed', async () => {
    pickDirectoryMock.mockResolvedValue('/Users/dev/projects/my-app')
    await renderOpen()

    const input = nameInput() as HTMLInputElement
    await act(async () => {
      // React tracks the DOM value via a native setter, so drive it directly.
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setValue?.call(input, 'custom-name')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      findButton('Choose directory')?.click()
    })

    expect((nameInput() as HTMLInputElement | null)?.value).toBe('custom-name')
  })

  it('renders the picked path with the truncate overflow guard', async () => {
    pickDirectoryMock.mockResolvedValue('C:\\Users\\tomsk\\Downloads\\imap_chrome_extension')
    await renderOpen()

    await act(async () => {
      findButton('Choose directory')?.click()
    })

    expect(dialogEl()?.querySelector('p.truncate')).not.toBeNull()
  })

  it('shows the native directory browser in the wails transport', async () => {
    isWebTransportMock.mockReturnValue(false)
    await renderOpen()

    expect(findButton('Choose directory')).not.toBeUndefined()
    expect(dialogEl()?.textContent).not.toContain('Type the workspace directory path')
  })

  it('web transport cannot create projects: Create is disabled with the reason', async () => {
    isWebTransportMock.mockReturnValue(true)
    await renderOpen()

    expect(findButton('Choose directory')).toBeUndefined()
    // Creation is a desktop-only capability. The hint states it, and the
    // disabled Create button carries the reason as its tooltip — the old
    // "type the workspace directory path" hint pointed at a path input the
    // dialog does not have, making Create permanently (and silently) dead.
    expect(dialogEl()?.textContent).toContain('requires the desktop app')
    const create = findButton('Create')
    expect(create).toBeInstanceOf(HTMLButtonElement)
    expect((create as HTMLButtonElement).disabled).toBe(true)
    expect((create as HTMLButtonElement).getAttribute('title')).toContain('desktop app')
    expect(pickDirectoryMock).not.toHaveBeenCalled()
  })

  it('keeps Create enabled (path-gated) in the wails transport', async () => {
    isWebTransportMock.mockReturnValue(false)
    await renderOpen()

    const create = findButton('Create')
    expect(create).toBeInstanceOf(HTMLButtonElement)
    // Still disabled until a directory is picked — but not transport-gated,
    // and without a web-only tooltip.
    expect((create as HTMLButtonElement).disabled).toBe(true)
    expect((create as HTMLButtonElement).getAttribute('title')).toBeNull()
    expect(dialogEl()?.textContent).not.toContain('requires the desktop app')
  })
})
