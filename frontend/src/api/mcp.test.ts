// Unit tests for api/mcp.ts — the timeout normalization on the GetMCPServers
// boundary (the activation `mode` left this wire shape: it moved to the
// capabilities section), and the GetMCPMentionableServers wrapper (shape
// guard, failure degrade, and the per-context mentionable filter that hides
// only servers disabled in BOTH contexts).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApp: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

vi.mock('@/api/runtime', () => ({
  getApp: () => mockApp,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import {
  getMCPServers,
  getMCPMentionableServers,
  isMentionableMCPMode,
  isMentionableMCPServer,
  mentionableMCPNames,
} from '@/api/mcp'
import type { MCPMentionableServer } from '@/types/models'

describe('getMCPServers boundary normalization', () => {
  beforeEach(() => {
    delete mockApp.GetMCPServers
  })

  it('normalizes the omitted timeout keys to empty strings', async () => {
    mockApp.GetMCPServers = vi.fn(() => Promise.resolve({
      srv: { transport: 'stdio', command: 'cmd' },
    }))

    const servers = await getMCPServers()

    expect(servers['srv']!.timeout).toBe('')
    expect(servers['srv']!.call_timeout).toBe('')
  })

  it('passes entries through verbatim — a stray legacy `mode` key is not normalized or echoed', async () => {
    // The backend stopped marshalling `mode` (it lives in the capabilities
    // section now); anything a stale caller still sends must not reappear.
    mockApp.GetMCPServers = vi.fn(() => Promise.resolve({
      srv: { transport: 'stdio', command: 'cmd', timeout: '30s', call_timeout: '1m' },
    }))

    const servers = await getMCPServers()

    expect(servers['srv']).toEqual({ transport: 'stdio', command: 'cmd', timeout: '30s', call_timeout: '1m' })
    expect(servers['srv']).not.toHaveProperty('mode')
  })
})

describe('getMCPMentionableServers', () => {
  beforeEach(() => {
    delete mockApp.GetMCPMentionableServers
  })

  it('returns the validated {name, chat_mode, code_mode} listing', async () => {
    mockApp.GetMCPMentionableServers = vi.fn(() => Promise.resolve([
      { name: 'context7', chat_mode: 'auto', code_mode: 'auto' },
      { name: 'github', chat_mode: 'manual', code_mode: 'auto' },
    ]))

    const servers = await getMCPMentionableServers()

    expect(servers).toEqual([
      { name: 'context7', chat_mode: 'auto', code_mode: 'auto' },
      { name: 'github', chat_mode: 'manual', code_mode: 'auto' },
    ])
  })

  it('degrades to [] on an unexpected response shape', async () => {
    mockApp.GetMCPMentionableServers = vi.fn(() => Promise.resolve([
      { name: 'context7', chat_mode: 'not-a-mode', code_mode: 'auto' },
    ]))

    const servers = await getMCPMentionableServers()

    expect(servers).toEqual([])
  })

  it('degrades to [] when the RPC fails (never blocks the input)', async () => {
    mockApp.GetMCPMentionableServers = vi.fn(() => Promise.reject(new Error('rpc down')))

    const servers = await getMCPMentionableServers()

    expect(servers).toEqual([])
  })
})

describe('mentionable mode helpers', () => {
  it('treats auto and manual as mentionable, disabled as not (per context)', () => {
    expect(isMentionableMCPMode('auto')).toBe(true)
    expect(isMentionableMCPMode('manual')).toBe(true)
    expect(isMentionableMCPMode('disabled')).toBe(false)
  })

  it('display predicate: keeps a server while mentionable in at least one context', () => {
    // ≥1-context semantics are display-only (persisted-message chip kind
    // resolution); the completion and the send path use the kind-aware
    // mentionableMCPNames below.
    expect(isMentionableMCPServer({ name: 's', chat_mode: 'auto', code_mode: 'auto' })).toBe(true)
    expect(isMentionableMCPServer({ name: 's', chat_mode: 'disabled', code_mode: 'auto' })).toBe(true)
    expect(isMentionableMCPServer({ name: 's', chat_mode: 'manual', code_mode: 'disabled' })).toBe(true)
  })

  it('display predicate: hides a server only when disabled in BOTH contexts (the inert combination)', () => {
    expect(isMentionableMCPServer({ name: 's', chat_mode: 'disabled', code_mode: 'disabled' })).toBe(false)
  })

  it('mentionableMCPNames is session-kind-aware: only the context\u2019s column decides', () => {
    const servers: MCPMentionableServer[] = [
      { name: 'zeta', chat_mode: 'manual', code_mode: 'auto' },
      { name: 'alpha', chat_mode: 'disabled', code_mode: 'auto' },
      { name: 'mid', chat_mode: 'auto', code_mode: 'disabled' },
    ]

    // Chat sessions see the chat column: alpha is disabled there.
    expect(mentionableMCPNames(servers, 'chat')).toEqual(['zeta', 'mid'])
    // Code sessions see the code column: mid is disabled there.
    expect(mentionableMCPNames(servers, 'code')).toEqual(['zeta', 'alpha'])
  })

  it('mentionableMCPNames hides a server disabled in both contexts for either kind', () => {
    const servers: MCPMentionableServer[] = [
      { name: 'off', chat_mode: 'disabled', code_mode: 'disabled' },
      { name: 'on', chat_mode: 'auto', code_mode: 'manual' },
    ]
    expect(mentionableMCPNames(servers, 'chat')).toEqual(['on'])
    expect(mentionableMCPNames(servers, 'code')).toEqual(['on'])
  })
})
