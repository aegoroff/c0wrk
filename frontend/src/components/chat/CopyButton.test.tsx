// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { CopyButton } from './CopyButton'
import { clipboardSetText, emit, isWebTransport } from '@/api/runtime'
import { saveMessageAsMarkdown } from '@/api/files'

// Copy must go through the native Wails runtime, NOT navigator.clipboard
// (mirrors FileViewerTabContextMenu/FileTreeContextMenu); the save path goes
// through the backend RPC. Both boundary modules are mocked so no real
// window.runtime / window.go binding is touched.
vi.mock('@/api/runtime', () => ({
  clipboardSetText: vi.fn().mockResolvedValue(true),
  emit: vi.fn(),
  isWebTransport: vi.fn(() => false),
}))

vi.mock('@/api/files', () => ({
  saveMessageAsMarkdown: vi.fn(),
}))

// The save-rejection test below deliberately drives the component's error
// path; without the mock, logger.error writes the expected failure to the
// real console and pollutes the test output.
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const pressShift = () =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))
  })

const releaseShift = () =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }))
  })

describe('CopyButton', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    // Pin the success verdict explicitly: the failure tests below override it,
    // and this per-test setup keeps that override from leaking across tests.
    vi.mocked(clipboardSetText).mockResolvedValue(true)
    // Set the Web Clipboard API to undefined to prove the native path is taken.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    container = document.createElement('div')
    document.body.replaceChildren(container)
    root = createRoot(container)
  })

  afterEach(() => {
    // Reset the module-level Shift state shared by all useShiftHeld consumers
    // BEFORE unmounting: unmount detaches the store's window listeners, so a
    // keyup/blur dispatched afterwards never reaches it and a held Shift
    // would leak into the next test (its button would mount as "Save").
    releaseShift()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    act(() => root.unmount())
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  const render = (props: React.ComponentProps<typeof CopyButton>) =>
    act(() => {
      root.render(<CopyButton {...props} />)
    })

  it('renders the idle "Copy" label with the provided text', () => {
    render({ text: 'hello world' })
    expect(container.textContent).toContain('Copy')
    expect(clipboardSetText).not.toHaveBeenCalled()
  })

  it('copies the text to the clipboard and flips to "Copied" on click', async () => {
    render({ text: 'answer text' })
    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(clipboardSetText).toHaveBeenCalledTimes(1)
    expect(clipboardSetText).toHaveBeenCalledWith('answer text')
    expect(container.textContent).toContain('Copied')
  })

  it('reverts to "Copy" after the timeout elapses', async () => {
    render({ text: 'revert me' })
    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(container.textContent).toContain('Copied')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(container.textContent).toContain('Copy')
    expect(container.textContent).not.toContain('Copied')
  })

  it('flashes "Failed" with a destructive icon instead of "Copied" when the clipboard write reports false', async () => {
    vi.mocked(clipboardSetText).mockResolvedValue(false)
    render({ text: 'answer text' })
    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(clipboardSetText).toHaveBeenCalledTimes(1)
    expect(clipboardSetText).toHaveBeenCalledWith('answer text')
    // A false verdict must never render the success state...
    expect(container.textContent).not.toContain('Copied')
    // ...the failure signal is the "Failed" label plus the red X icon.
    expect(container.textContent).toContain('Failed')
    expect(button.getAttribute('aria-label')).toBe('Failed')
    const icon = button.querySelector('svg')
    expect(icon?.getAttribute('class')).toContain('text-destructive')
    expect(icon?.getAttribute('class')).not.toContain('text-success')
    // The failure flash is bounded like the success flash: back to idle after 2s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(container.textContent).not.toContain('Failed')
    expect(container.textContent).toContain('Copy')
  })

  it('flashes "Failed" when the clipboard write rejects (the defensive catch path)', async () => {
    vi.mocked(clipboardSetText).mockRejectedValue(new Error('transport exploded'))
    render({ text: 'answer text' })
    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(container.textContent).not.toContain('Copied')
    expect(container.textContent).toContain('Failed')
  })

  it('morphs into "Save" while Shift is held and back on release', () => {
    render({ text: 'hello' })
    expect(container.textContent).toContain('Copy')
    expect(container.textContent).not.toContain('Save')

    pressShift()
    expect(container.textContent).toContain('Save')
    expect(container.textContent).not.toContain('Copy')

    releaseShift()
    expect(container.textContent).toContain('Copy')
    expect(container.textContent).not.toContain('Save')
  })

  it('saves the message to a file on Shift+click and flashes "Saved"', async () => {
    vi.mocked(saveMessageAsMarkdown).mockResolvedValue('/proj/message.md')
    render({ text: 'answer text' })
    // Guards Shift-state isolation: a leak from a previous test would mount
    // the button in its "Save" variant before pressShift() runs.
    expect(container.textContent).toContain('Copy')
    pressShift()

    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(saveMessageAsMarkdown).toHaveBeenCalledTimes(1)
    expect(saveMessageAsMarkdown).toHaveBeenCalledWith('answer text')
    // The Shift variant must never touch the clipboard.
    expect(clipboardSetText).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Saved')
  })

  it('stays idle when the save dialog is cancelled', async () => {
    vi.mocked(saveMessageAsMarkdown).mockResolvedValue('')
    render({ text: 'answer text' })
    // Guards Shift-state isolation (see the save test above).
    expect(container.textContent).toContain('Copy')
    pressShift()

    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(saveMessageAsMarkdown).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Saved')
    expect(container.textContent).toContain('Save')
    expect(emit).not.toHaveBeenCalled()
  })

  it('surfaces a runtime_error toast when the save fails', async () => {
    vi.mocked(saveMessageAsMarkdown).mockRejectedValue(new Error('boom'))
    render({ text: 'answer text' })
    // Guards Shift-state isolation (see the save test above).
    expect(container.textContent).toContain('Copy')
    pressShift()

    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(emit).toHaveBeenCalledWith(
      'runtime_error',
      expect.objectContaining({ message: 'Failed to save message to file' }),
    )
    expect(container.textContent).not.toContain('Saved')
  })
})

describe('CopyButton in web transport (no native save dialog)', () => {
  let container: HTMLElement
  let root: Root
  const createObjectURL = vi.fn<(obj: Blob) => string>(() => 'blob:mock-url')
  const revokeObjectURL = vi.fn<(url: string) => void>(() => {})

  beforeEach(() => {
    vi.useFakeTimers()
    // jsdom implements neither object-URL primitive; stub both so the anchor
    // download path runs end-to-end.
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    vi.mocked(isWebTransport).mockReturnValue(true)

    container = document.createElement('div')
    document.body.replaceChildren(container)
    root = createRoot(container)
  })

  afterEach(() => {
    releaseShift()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    act(() => root.unmount())
    vi.mocked(isWebTransport).mockReturnValue(false)
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  const render = (props: React.ComponentProps<typeof CopyButton>) =>
    act(() => {
      root.render(<CopyButton {...props} />)
    })

  it('Shift+click hands the browser an anchor download and never calls the save RPC', async () => {
    render({ text: 'markdown body' })
    pressShift()

    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(saveMessageAsMarkdown).not.toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0]?.[0]
    expect(await blob?.text()).toBe('markdown body')
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
    expect(container.textContent).toContain('Saved')
  })

  it('the plain click still copies through the shared transport clipboard', async () => {
    render({ text: 'copy me' })
    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(clipboardSetText).toHaveBeenCalledWith('copy me')
  })
})
