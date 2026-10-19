// Unit tests for api/webAccess.ts — the web-access sidecar control bridge
// (ADR-090). Covers boundary parsing (envelope rejection) and the wrapper
// contracts: the read is fail-open (transport failure → null, never a throw
// into a render path) while the toggle throws (a rejected write must surface).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApp: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

vi.mock('@/api/runtime', () => ({
  getApp: () => mockApp,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { parseWebAccessInfo, getWebAccessInfo, setWebAccessEnabled } from '@/api/webAccess'
import { logger } from '@/lib/logger'

const validInfo = {
  enabled: true,
  running: true,
  url: 'http://127.0.0.1:8765',
  port: 8765,
  token: 'per-launch-token',
}

describe('parseWebAccessInfo', () => {
  it('accepts a fully valid payload', () => {
    expect(parseWebAccessInfo(validInfo)).toEqual(validInfo)
  })

  it('accepts the not-running shape (empty url, zero port)', () => {
    expect(parseWebAccessInfo({ ...validInfo, running: false, url: '', port: 0, token: '' })).toEqual({
      ...validInfo,
      running: false,
      url: '',
      port: 0,
      token: '',
    })
  })

  it('rejects non-objects and null', () => {
    expect(parseWebAccessInfo(null)).toBeNull()
    expect(parseWebAccessInfo('nope')).toBeNull()
    expect(parseWebAccessInfo(undefined)).toBeNull()
  })

  it('rejects a payload with a wrong-typed field', () => {
    for (const bad of [
      { ...validInfo, enabled: 'yes' },
      { ...validInfo, running: 1 },
      { ...validInfo, url: 42 },
      { ...validInfo, port: '8765' },
      { ...validInfo, port: Number.NaN },
      { ...validInfo, token: null },
      { ...validInfo, extra: true },
    ]) {
      if ('extra' in bad) {
        // Extra fields are tolerated — only known fields are validated.
        expect(parseWebAccessInfo(bad)).toEqual(validInfo)
      } else {
        expect(parseWebAccessInfo(bad)).toBeNull()
      }
    }
  })
})

describe('getWebAccessInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockApp)) delete mockApp[key]
  })

  it('returns the parsed payload on success', async () => {
    mockApp.GetWebAccessInfo = vi.fn().mockResolvedValue(validInfo)
    await expect(getWebAccessInfo()).resolves.toEqual(validInfo)
    expect(mockApp.GetWebAccessInfo).toHaveBeenCalledTimes(1)
  })

  it('returns null and logs on an unexpected shape', async () => {
    mockApp.GetWebAccessInfo = vi.fn().mockResolvedValue({ hello: 1 })
    await expect(getWebAccessInfo()).resolves.toBeNull()
    expect(logger.error).toHaveBeenCalled()
  })

  it('returns null on a transport failure (fail-open read)', async () => {
    mockApp.GetWebAccessInfo = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(getWebAccessInfo()).resolves.toBeNull()
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('setWebAccessEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockApp)) delete mockApp[key]
  })

  it('passes the boolean through and resolves on success', async () => {
    mockApp.SetWebAccessEnabled = vi.fn().mockResolvedValue(undefined)
    await expect(setWebAccessEnabled(true)).resolves.toBeUndefined()
    expect(mockApp.SetWebAccessEnabled).toHaveBeenCalledWith(true)
    await setWebAccessEnabled(false)
    expect(mockApp.SetWebAccessEnabled).toHaveBeenLastCalledWith(false)
  })

  it('rethrows on failure (a rejected toggle must surface)', async () => {
    mockApp.SetWebAccessEnabled = vi.fn().mockRejectedValue(new Error('denied'))
    await expect(setWebAccessEnabled(false)).rejects.toThrow('denied')
    expect(logger.error).toHaveBeenCalled()
  })
})
