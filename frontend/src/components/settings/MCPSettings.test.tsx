// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MCPSettings } from './MCPSettings'
import { getMCPServers, getMCPStatus, getToolList, updateMCPServers } from '@/api/mcp'
import { getCapabilityModes, updateCapabilityModes } from '@/api/capabilities'
import { logger } from '@/lib/logger'
import type { CapabilityModes, MCPServerConfig } from '@/types/models'

vi.mock('@/api/mcp', () => ({
  getMCPServers: vi.fn(), getMCPStatus: vi.fn(), getToolList: vi.fn(), updateMCPServers: vi.fn(),
}))
vi.mock('@/api/capabilities', () => ({
  getCapabilityModes: vi.fn(), updateCapabilityModes: vi.fn(),
}))
// Scoped logger spy: the deliberately exercised failure paths below DO log
// (the api wrapper and the component both report the failed load/save), and
// the tests assert those diagnostics instead of letting them leak to stderr.
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
vi.mock('@/api/runtime', () => ({ subscribe: vi.fn(() => () => {}) }))

const config: MCPServerConfig = {
  transport: 'http', command: 'preserved', args: ['arg'], env: { KEY: '${ENV_VALUE}' },
  url: 'http://localhost:8080/mcp', headers: { Header: 'value' }, timeout: '30s', call_timeout: '2m',
}
let configs: Record<string, MCPServerConfig>
let caps: Record<string, CapabilityModes>
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  configs = { srv: { ...config }, other: { ...config } }
  caps = { srv: { chat_mode: 'auto', code_mode: 'auto' }, other: { chat_mode: 'manual', code_mode: 'disabled' } }
  vi.mocked(getMCPServers).mockImplementation(async () => configs)
  vi.mocked(getMCPStatus).mockImplementation(async () => Object.entries(configs).map(([name, cfg]) => ({
    name, transport: cfg.transport, connected: true, starting: false, tool_count: 0, tools: [],
    chat_mode: caps[name]?.chat_mode ?? 'auto', code_mode: caps[name]?.code_mode ?? 'auto',
  })))
  vi.mocked(getToolList).mockResolvedValue([])
  vi.mocked(getCapabilityModes).mockImplementation(async () => ({ skills: {}, agents: {}, mcp: caps }))
  vi.mocked(updateMCPServers).mockImplementation(async (next) => { configs = next })
  vi.mocked(updateCapabilityModes).mockImplementation(async (_section, next) => { caps = next })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<MCPSettings />) })
  act(() => { container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click() })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

function trigger(context: 'chat' | 'code', name = 'srv'): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${name} ${context} mode"]`)!
}

async function chooseMode(context: 'chat' | 'code', mode: string) {
  await act(async () => { trigger(context).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((el) => el.textContent === mode)
  expect(item).toBeDefined()
  await act(async () => { item!.click() })
}

describe('MCPSettings per-context capability modes', () => {
  it('persists a chat-mode change through the capabilities RPC, replacing the FULL mcp section', async () => {
    await chooseMode('chat', 'manual')
    expect(updateCapabilityModes).toHaveBeenCalledExactlyOnceWith('mcp', {
      srv: { chat_mode: 'manual', code_mode: 'auto' },
      other: { chat_mode: 'manual', code_mode: 'disabled' },
    })
    // The server config map is untouched by a mode change — the wire no
    // longer carries a per-server mode at all.
    expect(updateMCPServers).not.toHaveBeenCalled()
    expect(trigger('chat').textContent).toContain('manual')
    expect(trigger('code').textContent).toContain('auto')
  })

  it('persists a code-mode change independently of the chat context', async () => {
    await chooseMode('code', 'disabled')
    expect(updateCapabilityModes).toHaveBeenCalledExactlyOnceWith('mcp', {
      srv: { chat_mode: 'auto', code_mode: 'disabled' },
      other: { chat_mode: 'manual', code_mode: 'disabled' },
    })
    expect(trigger('chat').textContent).toContain('auto')
    expect(trigger('code').textContent).toContain('disabled')
  })

  it('does not save when reselecting the current mode', async () => {
    await chooseMode('chat', 'auto')
    expect(updateCapabilityModes).not.toHaveBeenCalled()
  })

  it('disables mutation controls during a pending save and recovers after completion', async () => {
    let complete!: () => void
    vi.mocked(updateCapabilityModes).mockImplementation((_section, next) => new Promise<void>((resolve) => {
      complete = () => { caps = next; resolve() }
    }))
    await chooseMode('chat', 'manual')
    expect(trigger('chat').disabled).toBe(true)
    expect(trigger('code').disabled).toBe(true)
    for (const label of ['Edit', 'Delete', 'Add Server']) {
      const button = Array.from(container.querySelectorAll('button')).find((el) => el.textContent?.trim() === label)!
      expect(button.disabled).toBe(true)
    }
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await act(async () => { complete() })
    expect(trigger('chat').disabled).toBe(false)
    expect(trigger('chat').textContent).toContain('manual')
    expect(updateCapabilityModes).toHaveBeenCalledTimes(1)
  })

  it('shows a failed update and retains the previous mode, allowing retry', async () => {
    vi.mocked(updateCapabilityModes).mockRejectedValueOnce(new Error('Unable to save modes'))
    vi.mocked(logger.error).mockClear()
    await chooseMode('chat', 'manual')
    // The failed save surfaces in the banner; the component itself logs
    // nothing on this path (the api wrapper's diagnostic is mocked away).
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Unable to save modes')
    expect(trigger('chat').textContent).toContain('auto')
    expect(trigger('chat').disabled).toBe(false)
    await chooseMode('chat', 'manual')
    expect(container.textContent).not.toContain('Unable to save modes')
    expect(trigger('chat').textContent).toContain('manual')
  })

  it('keeps mode selectors disabled (and shows the error) when capabilities failed to load', async () => {
    // Reload with a failing capabilities load: the server list still renders
    // (status comes from GetMCPStatus), but the selectors must stay disabled
    // — updateCapabilityModes REPLACES the whole section, and writing from a
    // half-known map would reset every other server's modes.
    vi.mocked(getCapabilityModes).mockRejectedValue(new Error('caps down'))
    const reload = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('title') === 'Reload servers')!
    vi.mocked(logger.error).mockClear()
    await act(async () => { reload.click() })
    // The component reports the failed capabilities load exactly once —
    // intercepted by the scoped spy instead of leaking to stderr. (The api
    // wrapper's own diagnostic is mocked away with the module.)
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Failed to load capability modes:', expect.any(Error))
    expect(container.textContent).toContain('caps down')
    const chatTrigger = container.querySelector<HTMLButtonElement>('[aria-label="srv chat mode"]')
    expect(chatTrigger).not.toBeNull()
    expect(chatTrigger!.disabled).toBe(true)
    // A disabled trigger cannot open its menu, so nothing can be selected…
    await act(async () => { chatTrigger!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    // …and nothing reaches the capabilities RPC.
    expect(updateCapabilityModes).not.toHaveBeenCalled()
  })
})
