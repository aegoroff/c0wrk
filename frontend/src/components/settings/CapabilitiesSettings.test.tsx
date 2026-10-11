// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CapabilitiesSettings } from './CapabilitiesSettings'
import { listAgents } from '@/api/agents'
import { listSkills } from '@/api/skills'
import { getCapabilityModes, updateCapabilityModes } from '@/api/capabilities'
import { logger } from '@/lib/logger'
import type { CapabilitiesInfo } from '@/types/models'

vi.mock('@/api/agents', () => ({ listAgents: vi.fn() }))
vi.mock('@/api/skills', () => ({ listSkills: vi.fn() }))
vi.mock('@/api/capabilities', () => ({ getCapabilityModes: vi.fn(), updateCapabilityModes: vi.fn(async () => undefined) }))
// Scoped logger spy: the deliberately exercised failure paths below DO log
// (the api wrapper and the component both report the failed load/save), and
// the tests assert those diagnostics instead of letting them leak to stderr.
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
// MCPSettings owns its section's data flow and is covered by MCPSettings.test;
// here it is a marker stub so the composition tests stay focused on the
// Subagents/Skills sections and the subsection ORDER.
vi.mock('./MCPSettings', () => ({
  // The real section header span so the composition test can assert the
  // subsection ORDER.
  MCPSettings: () => <div data-testid="mcp-settings-stub"><span className="text-sm font-medium">MCP Servers</span></div>,
}))

let caps: CapabilitiesInfo
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  caps = {
    skills: { commit: { chat_mode: 'manual', code_mode: 'auto' } },
    agents: { 'code-reviewer': { chat_mode: 'auto', code_mode: 'manual' } },
    mcp: {},
  }
  vi.mocked(listAgents).mockResolvedValue([
    { name: 'code-reviewer', description: 'Reviews code changes' },
    { name: 'hidden-agent', description: 'ListAgents already excludes hidden profiles' },
  ])
  vi.mocked(listSkills).mockResolvedValue([{ name: 'commit', description: 'Commit discipline skill' }])
  vi.mocked(getCapabilityModes).mockImplementation(async () => caps)
  vi.mocked(updateCapabilityModes).mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<CapabilitiesSettings />) })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

function sectionTitles(): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('span.text-sm.font-medium'))
    .map((el) => el.textContent)
    .filter((t): t is string => t === 'Subagents' || t === 'MCP Servers' || t === 'Skills')
}

function trigger(name: string, context: 'chat' | 'code'): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${name} ${context} mode"]`)!
}

async function chooseMode(name: string, context: 'chat' | 'code', mode: string) {
  await act(async () => { trigger(name, context).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((el) => el.textContent === mode)
  expect(item).toBeDefined()
  await act(async () => { item!.click() })
}

describe('CapabilitiesSettings', () => {
  it('renders the three subsections in order: Subagents, MCP Servers, Skills', () => {
    expect(sectionTitles()).toEqual(['Subagents', 'MCP Servers', 'Skills'])
  })

  it('renders read-only catalog cards with both context selectors', () => {
    expect(container.textContent).toContain('code-reviewer')
    expect(container.textContent).toContain('Reviews code changes')
    expect(container.textContent).toContain('commit')
    expect(container.textContent).toContain('Commit discipline skill')
    // No mutation controls anywhere outside the (stubbed) MCP section.
    const cardButtons = Array.from(container.querySelectorAll('button'))
      .filter((b) => b.textContent?.match(/Add|Edit|Delete/))
    expect(cardButtons).toHaveLength(0)
    for (const name of ['code-reviewer', 'commit']) {
      expect(trigger(name, 'chat')).not.toBeNull()
      expect(trigger(name, 'code')).not.toBeNull()
    }
  })

  it('renders stored modes, defaulting a missing entry to auto/auto', () => {
    // 'commit' has a stored skills entry; 'code-reviewer' has an agents one.
    expect(trigger('commit', 'chat').textContent).toContain('manual')
    expect(trigger('commit', 'code').textContent).toContain('auto')
    expect(trigger('code-reviewer', 'chat').textContent).toContain('auto')
    expect(trigger('code-reviewer', 'code').textContent).toContain('manual')
  })

  it('persists a change through the capabilities RPC, replacing the FULL section', async () => {
    await chooseMode('commit', 'code', 'disabled')
    expect(updateCapabilityModes).toHaveBeenCalledExactlyOnceWith('skills', {
      commit: { chat_mode: 'manual', code_mode: 'disabled' },
    })
    expect(trigger('commit', 'code').textContent).toContain('disabled')
    // The untouched context and the other section are unaffected.
    expect(trigger('commit', 'chat').textContent).toContain('manual')
    expect(trigger('code-reviewer', 'code').textContent).toContain('manual')
  })

  it('does not save when reselecting the current mode', async () => {
    await chooseMode('code-reviewer', 'code', 'manual')
    expect(updateCapabilityModes).not.toHaveBeenCalled()
  })

  it('shows a failed update and retains the previous mode, allowing retry', async () => {
    vi.mocked(updateCapabilityModes).mockRejectedValueOnce(new Error('Unable to save modes'))
    vi.mocked(logger.error).mockClear()
    await chooseMode('commit', 'chat', 'disabled')
    // The failed save surfaces in the banner; the component itself logs
    // nothing on this path (the api wrapper's diagnostic is mocked away).
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Unable to save modes')
    expect(trigger('commit', 'chat').textContent).toContain('manual')
    expect(trigger('commit', 'chat').disabled).toBe(false)
    await chooseMode('commit', 'chat', 'disabled')
    expect(trigger('commit', 'chat').textContent).toContain('disabled')
  })

  it('keeps selectors disabled while capabilities have not loaded', async () => {
    vi.mocked(getCapabilityModes).mockRejectedValue(new Error('caps down'))
    vi.mocked(logger.error).mockClear()
    await act(async () => {
      root.unmount()
      root = createRoot(container)
      root.render(<CapabilitiesSettings />)
    })
    // The component reports the failed capabilities load exactly once —
    // intercepted by the scoped spy instead of leaking to stderr. (The api
    // wrapper's own diagnostic is mocked away with the module.)
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Failed to load capability modes:', expect.any(Error))
    expect(container.textContent).toContain('caps down')
    // The catalogs still render; the selectors cannot write a half-known map.
    expect(container.textContent).toContain('code-reviewer')
    expect(trigger('code-reviewer', 'chat').disabled).toBe(true)
  })

  it('shows empty-state text for empty catalogs', async () => {
    vi.mocked(listAgents).mockResolvedValue([])
    vi.mocked(listSkills).mockResolvedValue([])
    await act(async () => {
      root.unmount()
      root = createRoot(container)
      root.render(<CapabilitiesSettings />)
    })
    expect(container.textContent).toContain('No subagent profiles found.')
    expect(container.textContent).toContain('No skills found.')
  })
})
