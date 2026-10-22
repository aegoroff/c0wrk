// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The viewer store is mocked (rather than real) so assertions observe exactly
// which path FileLink hands to the viewer, without persist middleware under
// jsdom.
const fileViewerMock = vi.hoisted(() => ({
  openFile: vi.fn(),
  openFileAtLine: vi.fn(),
}))
vi.mock('@/stores/fileViewerStore', () => ({
  useFileViewerStore: { getState: () => fileViewerMock },
}))

import { FileLink } from './FileLink'

describe('FileLink', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    fileViewerMock.openFile.mockClear()
    fileViewerMock.openFileAtLine.mockClear()
    container = document.createElement('div')
    document.body.replaceChildren(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    document.body.replaceChildren()
  })

  const render = (props: Parameters<typeof FileLink>[0]) =>
    act(() => {
      root.render(<FileLink {...props} />)
    })

  const link = () => container.querySelector('span[role="button"]') as HTMLElement | null

  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // Flush the resolver's promise chain before leaving act().
      await Promise.resolve()
    })
  }

  it('opens the raw path directly when no resolver is given', async () => {
    render({ path: '/repo/plain.ts' })
    await click(link()!)
    expect(fileViewerMock.openFile).toHaveBeenCalledTimes(1)
    expect(fileViewerMock.openFile).toHaveBeenCalledWith('/repo/plain.ts')
    expect(fileViewerMock.openFileAtLine).not.toHaveBeenCalled()
  })

  it('opens the raw path at a line when line is given', async () => {
    render({ path: '/repo/plain.ts', line: 7 })
    await click(link()!)
    expect(fileViewerMock.openFileAtLine).toHaveBeenCalledWith('/repo/plain.ts', 7)
    expect(fileViewerMock.openFile).not.toHaveBeenCalled()
  })

  it('opens the RESOLVED path when a resolver is given', async () => {
    const resolve = vi.fn().mockResolvedValue('/skills/exp/references/api.md')
    render({ path: 'references/api.md', resolve })
    await click(link()!)
    expect(resolve).toHaveBeenCalledWith('references/api.md')
    // The resolved absolute path — not the raw relative arg — reaches the viewer.
    expect(fileViewerMock.openFile).toHaveBeenCalledWith('/skills/exp/references/api.md')
  })

  it('opens the resolved path at a line', async () => {
    const resolve = vi.fn().mockResolvedValue('/ws/src/main.ts')
    render({ path: 'src/main.ts', line: 3, resolve })
    await click(link()!)
    expect(fileViewerMock.openFileAtLine).toHaveBeenCalledWith('/ws/src/main.ts', 3)
    expect(fileViewerMock.openFile).not.toHaveBeenCalled()
  })

  it('degrades to plain text when the resolver returns null', async () => {
    const resolve = vi.fn().mockResolvedValue(null)
    render({ path: 'references/missing.md', resolve })
    await click(link()!)
    // No viewer navigation on a failed resolution.
    expect(fileViewerMock.openFile).not.toHaveBeenCalled()
    expect(fileViewerMock.openFileAtLine).not.toHaveBeenCalled()
    // The link is gone; the same text renders as a plain span.
    expect(link()).toBeNull()
    expect(container.textContent).toBe('missing.md')
  })

  it('degrades to plain text when the resolver rejects', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('rpc down'))
    render({ path: 'references/missing.md', resolve })
    await click(link()!)
    // A rejection is unresolvable exactly like a null answer — same sticky
    // downgrade, and the void'd click handler must not leak an unhandled
    // rejection.
    expect(fileViewerMock.openFile).not.toHaveBeenCalled()
    expect(fileViewerMock.openFileAtLine).not.toHaveBeenCalled()
    expect(link()).toBeNull()
    expect(container.textContent).toBe('missing.md')
  })

  it('activates via keyboard Enter', async () => {
    render({ path: '/repo/plain.ts' })
    await act(async () => {
      link()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(fileViewerMock.openFile).toHaveBeenCalledWith('/repo/plain.ts')
  })
})
