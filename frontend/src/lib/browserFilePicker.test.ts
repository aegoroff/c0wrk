// Browser file picker tests — jsdom for the DOM/window surface.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { openBrowserFilePicker } from './browserFilePicker'

// The picker opens an ephemeral <input type="file">; jsdom never opens a
// real dialog, so the gesture is driven by dispatching the settling events.

describe('openBrowserFilePicker', () => {
  afterEach(() => {
    // Remove any picker input a test left behind (each open appends one).
    document.querySelectorAll('input[type="file"]').forEach((el) => el.remove())
  })

  it('settles via the window focus fallback and removes its input', async () => {
    const pending = openBrowserFilePicker()
    // An engine without cancel/change delivery still closes the dialog —
    // the following focus settles the promise (CS #18's leak path).
    window.dispatchEvent(new Event('focus'))
    await expect(pending).resolves.toEqual([])
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0)
  })

  it('removes its input on cancel and ignores the later focus', async () => {
    const pending = openBrowserFilePicker()
    const input = document.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    input?.dispatchEvent(new Event('cancel'))
    await expect(pending).resolves.toEqual([])
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0)
    // The fallback must be a no-op after the promise settled.
    window.dispatchEvent(new Event('focus'))
  })
})
