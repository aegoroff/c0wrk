// Unit tests for api/capabilities.ts — the GetCapabilityModes boundary
// (shape guard, empty-section degrade) and the UpdateCapabilityModes
// wrapper (full-section replacement semantics, error propagation).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApp: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

vi.mock('@/api/runtime', () => ({
  getApp: () => mockApp,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { getCapabilityModes, updateCapabilityModes } from '@/api/capabilities'
import type { CapabilityModes } from '@/types/models'

const fullPayload = {
  skills: { 'research-init': { chat_mode: 'auto', code_mode: 'manual' } },
  agents: { 'code-reviewer': { chat_mode: 'manual', code_mode: 'manual' } },
  mcp: { context7: { chat_mode: 'auto', code_mode: 'disabled' } },
}

describe('getCapabilityModes', () => {
  beforeEach(() => {
    delete mockApp.GetCapabilityModes
  })

  it('returns the validated three-section payload', async () => {
    mockApp.GetCapabilityModes = vi.fn(() => Promise.resolve(fullPayload))

    await expect(getCapabilityModes()).resolves.toEqual(fullPayload)
  })

  it('accepts empty sections (fresh install, no capabilities configured)', async () => {
    mockApp.GetCapabilityModes = vi.fn(() => Promise.resolve({ skills: {}, agents: {}, mcp: {} }))

    await expect(getCapabilityModes()).resolves.toEqual({ skills: {}, agents: {}, mcp: {} })
  })

  it('degrades to empty sections on an unexpected shape (null section)', async () => {
    mockApp.GetCapabilityModes = vi.fn(() => Promise.resolve({ skills: null, agents: {}, mcp: {} }))

    await expect(getCapabilityModes()).resolves.toEqual({ skills: {}, agents: {}, mcp: {} })
  })

  it('degrades to empty sections when a mode value is not a canonical enum member', async () => {
    mockApp.GetCapabilityModes = vi.fn(() => Promise.resolve({
      skills: {},
      agents: { broken: { chat_mode: 'sometimes', code_mode: 'auto' } },
      mcp: {},
    }))

    await expect(getCapabilityModes()).resolves.toEqual({ skills: {}, agents: {}, mcp: {} })
  })

  it('rethrows when the RPC fails (callers surface a load error)', async () => {
    mockApp.GetCapabilityModes = vi.fn(() => Promise.reject(new Error('rpc down')))

    await expect(getCapabilityModes()).rejects.toThrow('rpc down')
  })
})

describe('updateCapabilityModes', () => {
  beforeEach(() => {
    delete mockApp.UpdateCapabilityModes
  })

  it('forwards the section id and the full modes map verbatim', async () => {
    const modes: Record<string, CapabilityModes> = { 'research-init': { chat_mode: 'auto', code_mode: 'manual' } }
    mockApp.UpdateCapabilityModes = vi.fn(() => Promise.resolve(undefined))

    await updateCapabilityModes('skills', modes)

    expect(mockApp.UpdateCapabilityModes).toHaveBeenCalledWith('skills', modes)
  })

  it('propagates backend validation errors (invalid enum value)', async () => {
    mockApp.UpdateCapabilityModes = vi.fn(() => Promise.reject(new Error('invalid capability modes')))

    // The frontend types forbid non-enum values; the backend gate is the
    // authoritative one, so the invalid payload is a deliberate cast.
    const bogus = { x: { chat_mode: 'bogus', code_mode: 'auto' } } as unknown as Record<string, CapabilityModes>
    await expect(updateCapabilityModes('mcp', bogus)).rejects.toThrow('invalid capability modes')
  })
})
