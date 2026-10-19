// Unit tests for api/webAccess.ts — the web-access sidecar control bridge
// (ADR-090). Covers boundary parsing (envelope rejection) and the wrapper
// contracts: the read is fail-open (transport failure → null, never a throw
// into a render path) while the toggle throws (a rejected write must surface).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockApp: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

vi.mock('@/api/runtime', () => ({
  getApp: () => mockApp,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { parseWebAccessInfo, getWebAccessInfo, setWebAccessEnabled, setWebAccessConnection, webAccessLogin } from '@/api/webAccess'
import { logger } from '@/lib/logger'

const validInfo = {
  enabled: true,
  running: true,
  url: 'http://127.0.0.1:8765',
  port: 8765,
  configured_port: 8765,
  token: 'per-launch-token',
  token_pinned: false,
}

describe('parseWebAccessInfo', () => {
  const parsedValid = {
    enabled: true,
    running: true,
    url: 'http://127.0.0.1:8765',
    port: 8765,
    configuredPort: 8765,
    token: 'per-launch-token',
    tokenPinned: false,
  }

  it('accepts a fully valid payload', () => {
    expect(parseWebAccessInfo(validInfo)).toEqual(parsedValid)
  })

  it('accepts the not-running shape (empty url, zero port)', () => {
    expect(
      parseWebAccessInfo({ ...validInfo, running: false, url: '', port: 0, configured_port: 0, token: '' }),
    ).toEqual({
      ...parsedValid,
      running: false,
      url: '',
      port: 0,
      configuredPort: 0,
      token: '',
    })
  })

  it('maps the snake_case pin fields', () => {
    expect(
      parseWebAccessInfo({ ...validInfo, configured_port: 9000, token_pinned: true }),
    ).toEqual({ ...parsedValid, configuredPort: 9000, tokenPinned: true })
  })

  it('defaults the pin fields when absent (stale fixture tolerance)', () => {
    const legacy = {
      enabled: true,
      running: true,
      url: 'http://127.0.0.1:8765',
      port: 8765,
      token: 'tok',
    }
    expect(parseWebAccessInfo(legacy)).toEqual({ ...legacy, configuredPort: 0, tokenPinned: false })
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
        expect(parseWebAccessInfo(bad)).toEqual(parseWebAccessInfo(validInfo))
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
    await expect(getWebAccessInfo()).resolves.toEqual(parseWebAccessInfo(validInfo))
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

describe('setWebAccessConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockApp)) delete mockApp[key]
  })

  it('passes the port and token through and resolves on success', async () => {
    mockApp.SetWebAccessConnection = vi.fn().mockResolvedValue(undefined)
    await expect(setWebAccessConnection(9000, 'fixed-secret')).resolves.toBeUndefined()
    expect(mockApp.SetWebAccessConnection).toHaveBeenCalledWith(9000, 'fixed-secret')
    // The auto/ephemeral shape travels as the zero values.
    await setWebAccessConnection(0, '')
    expect(mockApp.SetWebAccessConnection).toHaveBeenLastCalledWith(0, '')
  })

  it('rethrows on failure (including the rollback message must surface)', async () => {
    mockApp.SetWebAccessConnection = vi.fn().mockRejectedValue(
      new Error('web access connection not applied: the sidecar failed to start with the new settings'),
    )
    await expect(setWebAccessConnection(70000, '')).rejects.toThrow(
      'web access connection not applied',
    )
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('webAccessLogin', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(impl: () => Promise<Response>): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(impl)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('posts the token to /api/login and resolves on 200', async () => {
    const fetchMock = stubFetch(async () => new Response(null, { status: 200 }))
    await expect(webAccessLogin('tok')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok' }),
    })
  })

  it('surfaces an actionable message on a wrong token (401)', async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: 'authentication failed' }), { status: 401 }))
    await expect(webAccessLogin('bad')).rejects.toThrow(/Wrong token/)
  })

  it('honors Retry-After on the rate limit (429)', async () => {
    stubFetch(async () => new Response(null, { status: 429, headers: { 'Retry-After': '7' } }))
    await expect(webAccessLogin('tok')).rejects.toThrow(/try again in 7s/)
  })

  it('falls back to a generic minute on a 429 without Retry-After', async () => {
    stubFetch(async () => new Response(null, { status: 429 }))
    await expect(webAccessLogin('tok')).rejects.toThrow(/try again in a minute/)
  })

  it('reports a transport failure as an actionable message', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(webAccessLogin('tok')).rejects.toThrow(/Cannot reach the app/)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('names an unexpected status instead of guessing', async () => {
    stubFetch(async () => new Response(null, { status: 503 }))
    await expect(webAccessLogin('tok')).rejects.toThrow(/HTTP 503/)
  })
})
