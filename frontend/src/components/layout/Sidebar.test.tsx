// @vitest-environment jsdom
//
// Sidebar collapsed branch — the pre-tab Settings parity guard (ADR-093).
//
// The collapsed shell has NO Settings entry point: the branch mounts only
// the expand affordance and no `SidebarHeader`, whose gear is the app's one
// general Settings entry point. That is the deliberate restoration of the
// pre-tab-bar status quo — the same shell state had no Settings entry before
// the tab bar existed either (the strip-borne gear was born with ADR-085's
// tab bar and was dropped again by ADR-093) — so it is locked here: adding
// an entry point to the collapsed strip (or anywhere else while collapsed)
// must be an explicit ADR-093-revisiting decision, not a drive-by fix.
//
// (The expanded side of the parity — the gear present and opening the
// default tab — is SidebarHeader.test.tsx's suite; this file only locks the
// collapsed branch, so the early return renders just a Button and no
// project/session/workspace machinery is ever mounted here.)

import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { Sidebar } from './Sidebar'

let container: HTMLDivElement
let root: Root | null = null

function renderCollapsedSidebar(): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<Sidebar width={40} collapsed onToggleCollapse={() => {}} />)
  })
  return container
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container?.remove()
  document.body.innerHTML = ''
})

describe('Sidebar collapsed shell (ADR-093 parity guard)', () => {
  it('mounts only the expand affordance — no Settings entry point', () => {
    const el = renderCollapsedSidebar()
    // Sanity: the collapsed strip itself rendered, so the negative queries
    // below are meaningful (and the same `button[aria-label="Settings"]`
    // query pattern matches the real gear over in SidebarHeader.test.tsx).
    expect(el.querySelector('button[aria-label="Expand sidebar"]')).not.toBeNull()
    // No Settings button anywhere in the collapsed strip.
    expect(el.querySelector('button[aria-label="Settings"]')).toBeNull()
    expect(el.querySelector('[title="Settings"]')).toBeNull()
    // And no SidebarHeader content either — the header owns the gear.
    expect(el.querySelector('button[title="Assistant mode"]')).toBeNull()
  })
})
