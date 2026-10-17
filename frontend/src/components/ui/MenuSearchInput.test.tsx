// @vitest-environment jsdom
//
// Direct unit coverage for the MenuSearchInput typeahead guard. The consumers
// (SessionSelector, BranchDropdown) exercise it end-to-end through real Radix
// menus; these tests pin the guard contract itself so it survives the input
// moving to another menu.
//
// The wrapper div's React onKeyDown stands in for the menu content's NATIVE
// keydown listener: the guard's synthetic stopPropagation reaches
// event.nativeEvent.stopPropagation(), so a bubbling KeyboardEvent dispatched
// on the input never reaches the ancestor — exactly what Radix's typeahead
// (a native listener on the DropdownMenuContent element) experiences.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MenuSearchInput } from './MenuSearchInput'

let root: Root | null = null

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount()
    })
    root = null
  }
})

/** Render the input inside an ancestor whose keydown spy mirrors the menu. */
async function renderGuarded() {
  const ancestorSpy = vi.fn()
  const userSpy = vi.fn()
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <div onKeyDown={ancestorSpy}>
        <MenuSearchInput aria-label="Search" onKeyDown={userSpy} />
      </div>,
    )
  })
  const input = container.querySelector('input')
  expect(input, 'the rendered input').toBeTruthy()
  return { input: input!, ancestorSpy, userSpy }
}

function keyDown(input: HTMLInputElement, key: string, mods: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  act(() => {
    input.dispatchEvent(event)
  })
  return event
}

describe('MenuSearchInput — typeahead guard', () => {
  it('stops plain printable keys from reaching the menu but still delivers them to the user handler un-prevented', async () => {
    const { input, ancestorSpy, userSpy } = await renderGuarded()

    const event = keyDown(input, 'a')

    // The typeahead's ancestor listener never sees the key...
    expect(ancestorSpy).not.toHaveBeenCalled()
    // ...the consumer's handler still runs, receiving the same native event...
    expect(userSpy).toHaveBeenCalledTimes(1)
    const delivered = userSpy.mock.calls[0]?.[0] as { nativeEvent: Event }
    expect(delivered.nativeEvent).toBe(event)
    // ...and nothing preventDefaults it, so the character still types.
    expect(event.defaultPrevented).toBe(false)
  })

  it('mirrors the Radix condition exactly — shift+key is guarded, ctrl/meta/alt are not', async () => {
    const { input, ancestorSpy } = await renderGuarded()

    // Radix checks `!ctrl && !alt && !meta` — shift is NOT an exemption.
    keyDown(input, 'a', { shiftKey: true })
    expect(ancestorSpy).not.toHaveBeenCalled()

    // Every modifier Radix exempts passes through untouched.
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const before = ancestorSpy.mock.calls.length
      keyDown(input, 'n', mods)
      expect(ancestorSpy.mock.calls.length, JSON.stringify(mods)).toBe(before + 1)
    }
  })

  it('passes through the keys the menu still needs — Escape, Tab, Enter, arrows', async () => {
    const { input, ancestorSpy, userSpy } = await renderGuarded()

    for (const key of ['Escape', 'Tab', 'Enter', 'ArrowDown']) {
      const before = ancestorSpy.mock.calls.length
      keyDown(input, key)
      expect(ancestorSpy.mock.calls.length, key).toBe(before + 1)
    }
    // The user handler observes the pass-through keys too.
    expect(userSpy).toHaveBeenCalledTimes(4)
  })

  it('is stopPropagation-only — no key ever gets defaultPrevented', async () => {
    const { input } = await renderGuarded()

    for (const key of ['a', 'Escape', 'ArrowDown']) {
      const event = keyDown(input, key)
      expect(event.defaultPrevented, key).toBe(false)
    }
  })
})
