// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MCPServerCard } from './MCPServerCard'
import type { MCPServerStatus } from '@/types/models'

let container: HTMLDivElement
let root: Root

function setup(
  server: Omit<MCPServerStatus, 'chat_mode' | 'code_mode'> & Partial<Pick<MCPServerStatus, 'chat_mode' | 'code_mode'>>,
  expanded = false,
  props: Partial<Parameters<typeof MCPServerCard>[0]> = {},
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <MCPServerCard
        server={{ chat_mode: 'auto', code_mode: 'auto', ...server }}
        tools={[]}
        expanded={expanded}
        onToggleExpand={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        chatMode={props.chatMode ?? server.chat_mode ?? 'auto'}
        codeMode={props.codeMode ?? server.code_mode ?? 'auto'}
        isSaving={false}
        onChatModeChange={() => {}}
        onCodeModeChange={() => {}}
        {...props}
      />,
    )
  })
}

function teardown() {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
}

function trigger(context: 'chat' | 'code', name = 'srv'): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${name} ${context} mode"]`)!
}

describe('MCPServerCard', () => {
  it('renders a neutral "Starting…" state for the gateway placeholder', () => {
    setup({ name: '_gateway', transport: '', connected: false, starting: true, tool_count: 0, tools: [] })
    expect(container.textContent).toContain('Starting…')
    // Friendly label instead of the raw sentinel name.
    expect(container.textContent).toContain('MCP Gateway')
    expect(container.textContent).not.toContain('_gateway')
    // Not editable/deletable while starting.
    expect(container.querySelectorAll('button')).toHaveLength(0)
    teardown()
  })

  it('renders a friendly error state for the failed gateway placeholder', () => {
    setup({ name: '_gateway', transport: '', connected: false, starting: false, tool_count: 0, tools: [], error: 'gateway startup failed: connection refused' })
    // Friendly label instead of the raw sentinel name.
    expect(container.textContent).toContain('MCP Gateway')
    expect(container.textContent).not.toContain('_gateway')
    // The error message is surfaced.
    expect(container.textContent).toContain('gateway startup failed: connection refused')
    // Not editable/deletable (no Edit/Delete buttons).
    expect(container.querySelectorAll('button')).toHaveLength(0)
    teardown()
  })

  it('renders a connected state with a green check icon', () => {
    setup({ name: 'context7', transport: 'http', connected: true, starting: false, tool_count: 2, tools: ['a', 'b'] })
    expect(container.textContent).toContain('context7')
    expect(container.textContent).toContain('2 tools')
    // svg icons rendered
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0)
    teardown()
  })

  it('renders a distinct unhealthy indicator for a reachable-but-degraded server', () => {
    setup({ name: 'flaky', transport: 'http', connected: true, unhealthy: true, starting: false, tool_count: 1, tools: [] })
    expect(container.textContent).toContain('flaky')
    // A distinct warning label (not the plain green connected state).
    expect(container.textContent).toContain('Unhealthy')
    teardown()
  })

  it('renders a healthy connected server without the unhealthy indicator', () => {
    setup({ name: 'context7', transport: 'http', connected: true, unhealthy: false, starting: false, tool_count: 2, tools: [] })
    expect(container.textContent).not.toContain('Unhealthy')
    teardown()
  })

  it('renders a destructive state with the error message', () => {
    setup({ name: 'broken', transport: 'http', connected: false, starting: false, tool_count: 0, tools: [], error: 'connection refused' }, true)
    expect(container.textContent).toContain('broken')
    expect(container.textContent).toContain('connection refused')
    teardown()
  })

  it('renders a manual badge when either context is manual', () => {
    setup({ name: 'context7', transport: 'http', connected: false, starting: false, tool_count: 0, tools: [], error: 'unavailable', chat_mode: 'manual' })
    expect(container.textContent).toContain('manual')
    teardown()
    setup({ name: 'context7', transport: 'http', connected: false, starting: false, tool_count: 0, tools: [], error: 'unavailable', code_mode: 'manual' })
    expect(container.textContent).toContain('manual')
    teardown()
  })

  it('renders a disabled-in-both server neutrally: mode badge, no error, no red icon', () => {
    setup({ name: 'off-srv', transport: 'stdio', connected: false, starting: false, tool_count: 0, tools: [], chat_mode: 'disabled', code_mode: 'disabled' })
    expect(container.textContent).toContain('disabled')
    // Intentionally not dialed, never broken: no failure text anywhere.
    expect(container.textContent).not.toContain('unavailable')
    // The status icon is the neutral CircleOff, not the destructive alert.
    const alertIcons = container.querySelectorAll('.text-destructive')
    expect(alertIcons).toHaveLength(0)
    teardown()
  })

  it('keeps a live status for a server disabled in only one context', () => {
    // The chat context is off, but the server still serves CODE sessions —
    // a red "unavailable" entry would be wrong.
    setup({ name: 'half-off', transport: 'http', connected: false, starting: false, tool_count: 0, tools: [], error: 'unavailable', chat_mode: 'disabled', code_mode: 'auto' })
    expect(container.textContent).not.toContain('disabled')
    expect(container.querySelectorAll('.text-destructive').length).toBeGreaterThan(0)
    teardown()
  })

  it.each([
    ['chat', 'auto', 'Chat sessions: always available.'] as const,
    ['chat', 'manual', 'Chat sessions: held back until a /name mention enables it for the task.'] as const,
    ['chat', 'disabled', 'Chat sessions: never advertised — the other context is unaffected.'] as const,
    ['code', 'auto', 'Code sessions: always available.'] as const,
    ['code', 'manual', 'Code sessions: held back until a /name mention enables it for the task.'] as const,
    ['code', 'disabled', 'Code sessions: never advertised — the other context is unaffected.'] as const,
  ])('shows the %s selector in %s mode with its per-session-type explanation beside Edit/Delete', (context, mode, explanation) => {
    setup({ name: 'srv', transport: 'http', connected: false, starting: false, tool_count: 0, tools: [] }, true, context === 'chat' ? { chatMode: mode } : { codeMode: mode })
    const triggerEl = trigger(context)
    expect(triggerEl.textContent).toContain(mode)
    expect(triggerEl.classList.contains('w-max')).toBe(true)
    expect(triggerEl.classList.contains('shrink-0')).toBe(true)
    expect(triggerEl.className).not.toContain('min-w-')
    expect(Array.from(triggerEl.querySelectorAll('[aria-hidden="true"].invisible')).map((label) => label.textContent))
      .toEqual(['auto', 'manual', 'disabled'])
    expect(triggerEl.querySelector('span.grid')?.classList.contains('text-left')).toBe(true)
    // Edit/Delete and the per-context explanations live in the same expanded
    // card body as the selector.
    const cardBody = triggerEl.closest('[data-slot="collapsible-content"]') ?? container
    expect(cardBody.textContent).toContain('Edit')
    expect(cardBody.textContent).toContain('Delete')
    expect(cardBody.textContent).toContain(explanation)
    // The selector is context-labeled, so the two never read identically.
    expect(trigger(context === 'chat' ? 'code' : 'chat')).toBeDefined()
    teardown()
  })

  it('disables both mode selectors and edit/delete while saving', () => {
    const onChatModeChange = vi.fn()
    const onCodeModeChange = vi.fn()
    setup({ name: 'srv', transport: 'http', connected: true, starting: false, tool_count: 0, tools: [] }, true, { isSaving: true, onChatModeChange, onCodeModeChange })
    for (const context of ['chat', 'code'] as const) {
      const triggerEl = trigger(context)
      expect(triggerEl.disabled).toBe(true)
      act(() => { triggerEl.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
      expect(document.querySelector('[role="menu"]')).toBeNull()
    }
    expect(onChatModeChange).not.toHaveBeenCalled()
    expect(onCodeModeChange).not.toHaveBeenCalled()
    expect(Array.from(container.querySelectorAll('button')).every((button) => button.disabled)).toBe(true)
    teardown()
  })

  it('renders no mode badge for the implicit auto default', () => {
    setup({ name: 'auto-srv', transport: 'http', connected: true, starting: false, tool_count: 1, tools: ['a'] })
    expect(container.textContent).not.toContain('manual')
    expect(container.textContent).not.toContain('disabled')
    teardown()
  })

  it('reports changes through the context-specific callback', () => {
    const onChatModeChange = vi.fn()
    const onCodeModeChange = vi.fn()
    setup({ name: 'srv', transport: 'http', connected: true, starting: false, tool_count: 0, tools: [] }, true, { onChatModeChange, onCodeModeChange })
    act(() => { trigger('chat').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => el.textContent === 'manual')!
    expect(item).toBeDefined()
    act(() => { item.click() })
    expect(onChatModeChange).toHaveBeenCalledExactlyOnceWith('manual')
    expect(onCodeModeChange).not.toHaveBeenCalled()
    teardown()
  })
})
