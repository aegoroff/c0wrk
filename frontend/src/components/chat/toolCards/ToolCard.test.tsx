// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ToolCard } from './ToolCard'
import type { DisplayItem } from '@/types/messages'
import { TooltipProvider } from '@/components/ui/tooltip'

// The two resolvers ToolCard wires into FileLink, plus the viewer store, are
// mocked so click tests assert which path reaches the viewer without a Wails
// runtime: read_skill_resource goes through the backend RPC wrapper, the
// workspace file tools through the chat workspace root + normalizePath.
const skillsApiMock = vi.hoisted(() => ({
  resolveSkillResourcePath: vi.fn(),
}))
vi.mock('@/api/skills', () => ({
  resolveSkillResourcePath: skillsApiMock.resolveSkillResourcePath,
}))

const chatRootMock = vi.hoisted(() => ({
  resolveChatWorkspaceRoot: vi.fn(),
}))
vi.mock('@/lib/chatWorkspaceRoot', () => ({
  resolveChatWorkspaceRoot: chatRootMock.resolveChatWorkspaceRoot,
}))

const fileViewerMock = vi.hoisted(() => ({
  openFile: vi.fn(),
  openFileAtLine: vi.fn(),
}))
vi.mock('@/stores/fileViewerStore', () => ({
  useFileViewerStore: { getState: () => fileViewerMock },
}))

type ToolItem = Extract<DisplayItem, { kind: 'tool' }>

function makeItem(overrides: Partial<ToolItem> & Pick<ToolItem, 'toolName' | 'args'>): ToolItem {
  return {
    kind: 'tool',
    id: 'tool-1',
    status: 'success',
    ...overrides,
  }
}

describe('ToolCard', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    // Radix tooltip positioning uses ResizeObserver, which jsdom lacks.
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    // Radix schedules post-open updates via rAF; run them synchronously.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    skillsApiMock.resolveSkillResourcePath.mockReset()
    chatRootMock.resolveChatWorkspaceRoot.mockReset()
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
    vi.unstubAllGlobals()
    container.remove()
    document.body.replaceChildren()
  })

  const render = (item: ToolItem) =>
    act(() => {
      root.render(<TooltipProvider><ToolCard item={item} /></TooltipProvider>)
    })

  const badges = () => Array.from(container.querySelectorAll('span'))
    .filter(el => {
      const t = el.textContent ?? ''
      return t === 'cached' || t === 'batched' || t === 'MCP' || t.startsWith('MCP: ')
    })

  const mcpBadge = () => badges().find(el => (el.textContent ?? '').startsWith('MCP'))

  it('shows the real file name (not the tool name) for batched sub-calls', () => {
    render(makeItem({
      toolName: 'read_file (batched)',
      args: '{"path":"/repo/frontend/src/components/chat/toolCards/ToolCard.tsx"}',
      parsedArgs: { path: '/repo/frontend/src/components/chat/toolCards/ToolCard.tsx' },
      result: 'file content',
    }))
    expect(container.textContent).toContain('Read: ')
    expect(container.textContent).toContain('ToolCard.tsx')
    // The bare tool name must no longer stand in for the file name.
    expect(container.textContent).not.toContain('Read: read_file')
    // The batched banner is rendered and non-shrinkable so it stays visible
    // next to a truncated title.
    const badge = badges().find(el => el.textContent === 'batched')
    expect(badge).toBeDefined()
    expect(badge!.className).toContain('shrink-0')
    expect(badge!.className).toContain('whitespace-nowrap')
  })

  it('shows the real file name and fragment window for cached reads with merged args', () => {
    render(makeItem({
      toolName: 'read_file (cached)',
      args: '{"path":"/repo/core/orchestrator.go","hash":"ab12","start_line":501,"num_lines":100}',
      parsedArgs: { path: '/repo/core/orchestrator.go', hash: 'ab12', start_line: 501, num_lines: 100 },
      result: '[Lines 501-600 of 2000 from cached read_file result | hash: ab12]\npackage main',
    }))
    // Title carries the file name + the fragment's start line, not the tool name.
    expect(container.textContent).toContain('orchestrator.go L501')
    expect(container.textContent).not.toContain('Read: read_file')
    // Cached banner + fragment range note, both non-shrinkable.
    const badge = badges().find(el => el.textContent === 'cached')
    expect(badge).toBeDefined()
    expect(badge!.className).toContain('shrink-0')
    const range = Array.from(container.querySelectorAll('span'))
      .find(el => (el.textContent ?? '').startsWith('fragment: lines'))
    expect(range).toBeDefined()
    expect(range!.className).toContain('shrink-0')
    expect(range!.className).toContain('whitespace-nowrap')
    expect(range!.textContent).toContain('lines 501–600 of 2000')
  })

  it('shows the URL for a cached web_fetch', () => {
    render(makeItem({
      toolName: 'web_fetch (cached)',
      args: '{"url":"https://example.com/docs/api"}',
      parsedArgs: { url: 'https://example.com/docs/api' },
      result: '<html>docs</html>',
    }))
    expect(container.textContent).toContain('Fetched: ')
    expect(container.textContent).toContain('https://example.com/docs/api')
    expect(container.textContent).not.toContain('Fetched: web_fetch')
    expect(badges().find(el => el.textContent === 'cached')).toBeDefined()
  })

  it('renders a file link for cached file tools when the merged args carry a path', () => {
    render(makeItem({
      toolName: 'read_file (cached)',
      args: '{"path":"/repo/main.go","hash":"cd34","start_line":10,"num_lines":5}',
      parsedArgs: { path: '/repo/main.go', hash: 'cd34', start_line: 10, num_lines: 5 },
      result: '[Lines 10-14 of 40 from cached read_file result | hash: cd34]\nfunc main() {}',
    }))
    const link = container.querySelector('span[role="button"]')
    expect(link).not.toBeNull()
    expect(link!.textContent).toContain('main.go L10')
  })

  it('degrades to the generic placeholder for pre-rewrite cached calls (hash-only args)', () => {
    render(makeItem({
      toolName: 'read_file (cached)',
      args: '{"hash":"ab12"}',
      parsedArgs: { hash: 'ab12' },
      result: '[Lines 1-5 of 10 from cached read_file result | hash: ab12]\ncontent',
    }))
    // Old sessions recorded before the backend rewrite keep hash-only args;
    // the card falls back to the extractor placeholder, still with its badge.
    expect(container.textContent).toContain('Read: file')
    expect(badges().find(el => el.textContent === 'cached')).toBeDefined()
    // No file link is possible without a path.
    expect(container.querySelector('span[role="button"]')).toBeNull()
  })

  it('keeps plain (unsuffixed) cards unchanged', () => {
    render(makeItem({
      toolName: 'read_file',
      args: '{"path":"/repo/plain.ts"}',
      parsedArgs: { path: '/repo/plain.ts' },
      result: 'content',
    }))
    expect(container.textContent).toContain('plain.ts')
    expect(badges()).toHaveLength(0)
  })

  it('names the MCP server on the badge for a bare server source', () => {
    render(makeItem({
      toolName: 'search_issues',
      args: '{"query":"badge"}',
      parsedArgs: { query: 'badge' },
      result: '{"ok":true}',
      source: 'github',
    }))
    const badge = mcpBadge()
    expect(badge).toBeDefined()
    expect(badge!.textContent).toBe('MCP: github')
  })

  it('normalizes the mcp: source prefix to the bare server name', () => {
    render(makeItem({
      toolName: 'search_issues',
      args: '{"query":"badge"}',
      parsedArgs: { query: 'badge' },
      result: '{"ok":true}',
      source: 'mcp:github',
    }))
    const badge = mcpBadge()
    expect(badge).toBeDefined()
    expect(badge!.textContent).toBe('MCP: github')
  })

  it('renders no MCP badge for core and undefined sources', () => {
    render(makeItem({
      toolName: 'search_issues',
      args: '{"query":"badge"}',
      parsedArgs: { query: 'badge' },
      result: '{"ok":true}',
      source: 'core',
    }))
    expect(mcpBadge()).toBeUndefined()

    render(makeItem({
      toolName: 'search_issues',
      args: '{"query":"badge"}',
      parsedArgs: { query: 'badge' },
      result: '{"ok":true}',
    }))
    expect(mcpBadge()).toBeUndefined()
  })

  it('renders an error card collapsed by default (no auto-open on remount)', () => {
    render(makeItem({
      toolName: 'read_file',
      args: '{"path":"/repo/error.ts"}',
      parsedArgs: { path: '/repo/error.ts' },
      result: 'ERROR_BODY_MARKER',
      status: 'error',
    }))
    // A failed card must not force its body open — on session switch / reload
    // the card remounts and defaultOpen would otherwise expand every error.
    // Radix keeps the content mounted and toggles data-state, so assert on it.
    const state = () =>
      container.querySelector('[data-slot="collapsible-content"]')?.getAttribute('data-state')
    expect(state()).toBe('closed')
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(state()).toBe('open')
  })

  // --- Tool-call link resolution: every path opens against its true base ---

  const clickLink = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // Flush the resolver's promise chain before leaving act().
      await Promise.resolve()
    })
  }

  it('opens a read_skill_resource path from the skill catalog via the backend RPC', async () => {
    skillsApiMock.resolveSkillResourcePath.mockResolvedValue(
      '/home/u/.c0wrk/.agents/skills/vibespec-explore/references/roadmap-format.md',
    )
    render(makeItem({
      toolName: 'read_skill_resource',
      args: '{"skill":"vibespec-explore","path":"references/roadmap-format.md"}',
      parsedArgs: { skill: 'vibespec-explore', path: 'references/roadmap-format.md' },
      result: 'roadmap template body',
    }))
    expect(container.textContent).toContain('Read: roadmap-format.md')
    const link = container.querySelector('span[role="button"]') as HTMLElement
    await clickLink(link)
    // The RPC wrapper was called with the skill name and the raw relative
    // path; the RESOLVED absolute path is what opens in the viewer.
    expect(skillsApiMock.resolveSkillResourcePath).toHaveBeenCalledWith(
      'vibespec-explore', 'references/roadmap-format.md',
    )
    expect(fileViewerMock.openFile).toHaveBeenCalledTimes(1)
    expect(fileViewerMock.openFile).toHaveBeenCalledWith(
      '/home/u/.c0wrk/.agents/skills/vibespec-explore/references/roadmap-format.md',
    )
    // The skill catalog — not the workspace — is the base for this tool: the
    // workspace resolver must stay untouched.
    expect(chatRootMock.resolveChatWorkspaceRoot).not.toHaveBeenCalled()
  })

  it('renders a read_skill_resource path as plain text when the RPC fails', async () => {
    skillsApiMock.resolveSkillResourcePath.mockResolvedValue(null)
    render(makeItem({
      toolName: 'read_skill_resource',
      args: '{"skill":"gone-skill","path":"references/api.md"}',
      parsedArgs: { skill: 'gone-skill', path: 'references/api.md' },
      result: 'skill "gone-skill" not found',
    }))
    const link = container.querySelector('span[role="button"]') as HTMLElement
    await clickLink(link)
    // Failed resolution: no navigation, the link degrades to plain text.
    expect(fileViewerMock.openFile).not.toHaveBeenCalled()
    expect(container.querySelector('span[role="button"]')).toBeNull()
    expect(container.textContent).toContain('Read: api.md')
  })

  it('resolves a relative read_file arg against the workspace root', async () => {
    chatRootMock.resolveChatWorkspaceRoot.mockResolvedValue('/home/u/proj')
    render(makeItem({
      toolName: 'read_file',
      args: '{"path":"src/main.ts"}',
      parsedArgs: { path: 'src/main.ts' },
      result: 'export {}',
    }))
    const link = container.querySelector('span[role="button"]') as HTMLElement
    await clickLink(link)
    expect(fileViewerMock.openFile).toHaveBeenCalledWith('/home/u/proj/src/main.ts')
    expect(skillsApiMock.resolveSkillResourcePath).not.toHaveBeenCalled()
  })

  it('passes absolute and drive paths through without distortion', async () => {
    chatRootMock.resolveChatWorkspaceRoot.mockResolvedValue('/home/u/proj')
    render(makeItem({
      toolName: 'read_file',
      args: '{"path":"/repo/abs.ts"}',
      parsedArgs: { path: '/repo/abs.ts' },
      result: 'content',
    }))
    await clickLink(container.querySelector('span[role="button"]') as HTMLElement)
    expect(fileViewerMock.openFile).toHaveBeenCalledWith('/repo/abs.ts')

    fileViewerMock.openFile.mockClear()
    render(makeItem({
      toolName: 'edit_file',
      args: '{"path":"C:\\\\ws\\\\doc.md"}',
      parsedArgs: { path: 'C:\\ws\\doc.md' },
      result: 'ok',
    }))
    await clickLink(container.querySelector('span[role="button"]') as HTMLElement)
    // Drive-absolute form is preserved (canonical forward-slash form), never
    // joined with the POSIX workspace root.
    expect(fileViewerMock.openFile).toHaveBeenCalledWith('C:/ws/doc.md')
  })

  it('opens the raw path unchanged when no workspace root is available', async () => {
    chatRootMock.resolveChatWorkspaceRoot.mockResolvedValue(null)
    render(makeItem({
      toolName: 'read_file',
      args: '{"path":"src/main.ts"}',
      parsedArgs: { path: 'src/main.ts' },
      result: 'content',
    }))
    const link = container.querySelector('span[role="button"]') as HTMLElement
    await clickLink(link)
    // Transient no-root state (No Project): the historical behavior — the raw
    // arg opens as-is rather than the link degrading to text.
    expect(fileViewerMock.openFile).toHaveBeenCalledWith('src/main.ts')
    expect(container.querySelector('span[role="button"]')).not.toBeNull()
  })
})
