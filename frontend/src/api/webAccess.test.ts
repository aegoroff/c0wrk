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

import {
  parseWebAccessInfo,
  parseWebAccessAddress,
  parseWebAccessToken,
  WEB_ACCESS_TOKEN_MIN_LENGTH,
  WEB_ACCESS_TOKEN_MAX_LENGTH,
  getWebAccessInfo,
  setWebAccessEnabled,
  setWebAccessConnection,
  setWebAccessTLS,
  generateWebAccessCertificate,
  regenerateWebAccessToken,
  setWebAccessToken,
  webAccessLogin,
} from '@/api/webAccess'
import { logger } from '@/lib/logger'

const validInfo = {
  enabled: true,
  running: true,
  url: 'http://127.0.0.1:8765',
  port: 8765,
  configured_port: 8765,
  configured_bind: '127.0.0.1',
  bind_is_loopback: true,
  token: 'per-launch-token',
  token_pinned: false,
  tls_enabled: false,
  tls_cert: '',
  tls_key: '',
  cert_status: '',
  cert_detail: '',
}

describe('parseWebAccessInfo', () => {
  const parsedValid = {
    enabled: true,
    running: true,
    url: 'http://127.0.0.1:8765',
    port: 8765,
    configuredPort: 8765,
    configuredBind: '127.0.0.1',
    bindIsLoopback: true,
    token: 'per-launch-token',
    tokenPinned: false,
    tlsEnabled: false,
    tlsCert: '',
    tlsKey: '',
    certStatus: '',
    certDetail: '',
  }

  it('accepts a fully valid payload', () => {
    expect(parseWebAccessInfo(validInfo)).toEqual(parsedValid)
  })

  it('accepts the not-running shape (empty url, zero port)', () => {
    expect(
      parseWebAccessInfo({
        ...validInfo,
        running: false,
        url: '',
        port: 0,
        configured_port: 0,
        configured_bind: '',
        bind_is_loopback: true,
        token: '',
      }),
    ).toEqual({
      ...parsedValid,
      running: false,
      url: '',
      port: 0,
      configuredPort: 0,
      configuredBind: '',
      token: '',
    })
  })

  it('maps the snake_case pin fields', () => {
    expect(
      parseWebAccessInfo({ ...validInfo, configured_port: 9000, token_pinned: true }),
    ).toEqual({ ...parsedValid, configuredPort: 9000, tokenPinned: true })
  })

  it('maps the snake_case bind fields (a non-loopback bind)', () => {
    expect(
      parseWebAccessInfo({ ...validInfo, configured_bind: '0.0.0.0', bind_is_loopback: false }),
    ).toEqual({ ...parsedValid, configuredBind: '0.0.0.0', bindIsLoopback: false })
    expect(
      parseWebAccessInfo({ ...validInfo, configured_bind: 'localhost', bind_is_loopback: true }),
    ).toEqual({ ...parsedValid, configuredBind: 'localhost', bindIsLoopback: true })
  })

  it('defaults the pin fields when absent (stale fixture tolerance)', () => {
    const legacy = {
      enabled: true,
      running: true,
      url: 'http://127.0.0.1:8765',
      port: 8765,
      token: 'tok',
    }
    expect(parseWebAccessInfo(legacy)).toEqual({
      ...legacy,
      configuredPort: 0,
      configuredBind: '',
      bindIsLoopback: true,
      tokenPinned: false,
      tlsEnabled: false,
      tlsCert: '',
      tlsKey: '',
      certStatus: '',
      certDetail: '',
    })
  })

  it('maps the snake_case TLS fields (ADR-092)', () => {
    expect(
      parseWebAccessInfo({
        ...validInfo,
        tls_enabled: true,
        tls_cert: '/home/z/.c0wrk/web-access.crt',
        tls_key: '/home/z/.c0wrk/web-access.key',
        cert_status: 'ok',
        cert_detail: '',
      }),
    ).toEqual({
      ...parsedValid,
      tlsEnabled: true,
      tlsCert: '/home/z/.c0wrk/web-access.crt',
      tlsKey: '/home/z/.c0wrk/web-access.key',
      certStatus: 'ok',
    })
  })

  it('passes a non-ok cert status and its detail through verbatim', () => {
    expect(
      parseWebAccessInfo({
        ...validInfo,
        cert_status: 'mismatch',
        cert_detail: 'the certificate does not cover 192.0.2.1 — regenerate it',
      })?.certStatus,
    ).toBe('mismatch')
    expect(
      parseWebAccessInfo({
        ...validInfo,
        cert_status: 'expired',
        cert_detail: 'expired 2026-01-01T00:00:00Z — regenerate',
      })?.certDetail,
    ).toBe('expired 2026-01-01T00:00:00Z — regenerate')
  })

  it('defaults the TLS fields when absent or wrong-typed (stale fixture tolerance)', () => {
    expect(parseWebAccessInfo({ ...validInfo, tls_cert: 5, tls_key: null })).toEqual({
      ...parsedValid,
      tlsCert: '',
      tlsKey: '',
    })
    expect(parseWebAccessInfo({ ...validInfo, tls_enabled: 'yes' })).toEqual(parsedValid)
    expect(parseWebAccessInfo({ ...validInfo, cert_status: 9, cert_detail: {} })).toEqual(parsedValid)
  })

  it('defaults a wrong-typed bind field to the unpinned/loopback shape (stale fixture tolerance)', () => {
    expect(parseWebAccessInfo({ ...validInfo, configured_bind: 5 })).toEqual({
      ...parsedValid,
      configuredBind: '',
    })
    expect(parseWebAccessInfo({ ...validInfo, bind_is_loopback: 'no' })).toEqual(parsedValid)
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

  it('passes the bind and port through and resolves on success (no token — it is generation-owned)', async () => {
    mockApp.SetWebAccessConnection = vi.fn().mockResolvedValue(undefined)
    await expect(setWebAccessConnection('0.0.0.0', 9000)).resolves.toBeUndefined()
    expect(mockApp.SetWebAccessConnection).toHaveBeenCalledWith('0.0.0.0', 9000)
    // The auto/default-bind shape travels as the zero values.
    await setWebAccessConnection('', 0)
    expect(mockApp.SetWebAccessConnection).toHaveBeenLastCalledWith('', 0)
  })

  it('rethrows on failure (including the rollback message must surface)', async () => {
    mockApp.SetWebAccessConnection = vi.fn().mockRejectedValue(
      new Error('web access connection not applied: the sidecar failed to start with the new settings'),
    )
    await expect(setWebAccessConnection('example.com', 70000)).rejects.toThrow(
      'web access connection not applied',
    )
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('setWebAccessTLS', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockApp)) delete mockApp[key]
  })

  it('passes the switch and both paths through and resolves on success', async () => {
    mockApp.SetWebAccessTLS = vi.fn().mockResolvedValue(undefined)
    await expect(
      setWebAccessTLS(true, '/home/z/.c0wrk/web-access.crt', '/home/z/.c0wrk/web-access.key'),
    ).resolves.toBeUndefined()
    expect(mockApp.SetWebAccessTLS).toHaveBeenCalledWith(
      true,
      '/home/z/.c0wrk/web-access.crt',
      '/home/z/.c0wrk/web-access.key',
    )
    // The derivation is the backend's job: the UI sends an empty key through
    // untouched when none is configured.
    await setWebAccessTLS(true, '/tmp/pair.pem', '')
    expect(mockApp.SetWebAccessTLS).toHaveBeenLastCalledWith(true, '/tmp/pair.pem', '')
    await setWebAccessTLS(false, '', '')
    expect(mockApp.SetWebAccessTLS).toHaveBeenLastCalledWith(false, '', '')
  })

  it('rethrows on failure (including the rollback message must surface)', async () => {
    mockApp.SetWebAccessTLS = vi.fn().mockRejectedValue(
      new Error('web access TLS change not applied: the previous settings were restored'),
    )
    await expect(setWebAccessTLS(true, 'cert.pem', 'key.pem')).rejects.toThrow(
      'previous settings were restored',
    )
    expect(logger.error).toHaveBeenCalled()
  })

  it('surfaces the shared structural refusal for an enabled section without a cert', async () => {
    mockApp.SetWebAccessTLS = vi.fn().mockRejectedValue(
      new Error(
        'web access TLS not applied: web_access: tls.cert is required when tls is enabled (generate a pair in Settings → Web Access or point cert/key at PEM files)',
      ),
    )
    await expect(setWebAccessTLS(true, '', '')).rejects.toThrow('tls.cert is required')
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('generateWebAccessCertificate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockApp)) delete mockApp[key]
  })

  it('calls the generation RPC and resolves on success', async () => {
    mockApp.GenerateWebAccessCertificate = vi.fn().mockResolvedValue(undefined)
    await expect(generateWebAccessCertificate()).resolves.toBeUndefined()
    expect(mockApp.GenerateWebAccessCertificate).toHaveBeenCalledTimes(1)
  })

  it('rethrows on failure (a rejected generation must surface)', async () => {
    mockApp.GenerateWebAccessCertificate = vi
      .fn()
      .mockRejectedValue(new Error('failed to generate the web access certificate'))
    await expect(generateWebAccessCertificate()).rejects.toThrow(
      'failed to generate the web access certificate',
    )
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('regenerateWebAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockApp)) delete mockApp[key]
  })

  it('calls the rotation RPC and resolves on success', async () => {
    mockApp.RegenerateWebAccessToken = vi.fn().mockResolvedValue(undefined)
    await expect(regenerateWebAccessToken()).resolves.toBeUndefined()
    expect(mockApp.RegenerateWebAccessToken).toHaveBeenCalledTimes(1)
  })

  it('rethrows on failure (a rejected rotation must surface)', async () => {
    mockApp.RegenerateWebAccessToken = vi.fn().mockRejectedValue(new Error('failed to persist web access config'))
    await expect(regenerateWebAccessToken()).rejects.toThrow('failed to persist web access config')
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('setWebAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockApp)) delete mockApp[key]
  })

  it('calls the set-token RPC with the given credential and resolves on success', async () => {
    mockApp.SetWebAccessToken = vi.fn().mockResolvedValue(undefined)
    await expect(setWebAccessToken('custom-token-123')).resolves.toBeUndefined()
    expect(mockApp.SetWebAccessToken).toHaveBeenCalledWith('custom-token-123')
  })

  it('rethrows on failure (including the rollback message must surface)', async () => {
    mockApp.SetWebAccessToken = vi.fn().mockRejectedValue(
      new Error('web access token change not applied: the previous token was restored'),
    )
    await expect(setWebAccessToken('custom-token-123')).rejects.toThrow('previous token was restored')
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('parseWebAccessAddress', () => {
  it('accepts the canonical shapes and yields the (bind, port) pair', () => {
    expect(parseWebAccessAddress('127.0.0.1:8080')).toEqual({ bind: '127.0.0.1', port: 8080 })
    expect(parseWebAccessAddress('0.0.0.0:3000')).toEqual({ bind: '0.0.0.0', port: 3000 })
    expect(parseWebAccessAddress('localhost:8080')).toEqual({ bind: 'localhost', port: 8080 })
    expect(parseWebAccessAddress('[::1]:8080')).toEqual({ bind: '::1', port: 8080 })
    expect(parseWebAccessAddress('192.168.1.10')).toEqual({ bind: '192.168.1.10', port: 0 })
  })

  it('adds the http:// scheme automatically when omitted', () => {
    expect(parseWebAccessAddress('http://127.0.0.1:8080')).toEqual({ bind: '127.0.0.1', port: 8080 })
    expect(parseWebAccessAddress('HTTP://localhost')).toEqual({ bind: 'localhost', port: 0 })
    expect(parseWebAccessAddress('http://[::1]:9090')).toEqual({ bind: '::1', port: 9090 })
  })

  it('treats the empty input as the defaults (loopback bind, auto port)', () => {
    expect(parseWebAccessAddress('')).toEqual({ bind: '', port: 0 })
    expect(parseWebAccessAddress('   ')).toEqual({ bind: '', port: 0 })
  })

  it('accepts the boundary octets and ports', () => {
    expect(parseWebAccessAddress('255.255.255.255:65535')).toEqual({ bind: '255.255.255.255', port: 65535 })
    expect(parseWebAccessAddress('0.0.0.0:1')).toEqual({ bind: '0.0.0.0', port: 1 })
    expect(parseWebAccessAddress('[::1]')).toEqual({ bind: '::1', port: 0 })
  })

  it('accepts the https:// prefix now that the transport is the TLS switch', () => {
    expect(parseWebAccessAddress('https://127.0.0.1:8080')).toEqual({ bind: '127.0.0.1', port: 8080 })
    expect(parseWebAccessAddress('HTTPS://localhost')).toEqual({ bind: 'localhost', port: 0 })
    expect(parseWebAccessAddress('https://[::1]:9090')).toEqual({ bind: '::1', port: 9090 })
  })

  it('refuses schemes other than http:// and https://', () => {
    const refused = parseWebAccessAddress('ftp://127.0.0.1:8080')
    expect('error' in refused).toBe(true)
    if ('error' in refused) expect(refused.error).toMatch(/http/)
  })

  it('refuses hostnames other than localhost', () => {
    for (const bad of ['example.com:8080', 'myhost.local', 'localhost.localdomain:80']) {
      const refused = parseWebAccessAddress(bad)
      expect('error' in refused).toBe(true)
    }
  })

  it('refuses out-of-range IPv4 octets', () => {
    for (const bad of ['256.1.1.1', '1.2.3.256', '300.300.300.300', '999.0.0.1']) {
      expect('error' in parseWebAccessAddress(bad)).toBe(true)
    }
  })

  it('refuses out-of-range and malformed ports', () => {
    for (const bad of ['127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:99999', '127.0.0.1:-1']) {
      expect('error' in parseWebAccessAddress(bad)).toBe(true)
    }
  })

  it('refuses garbage shapes', () => {
    for (const bad of ['127.0.0.1:', ':8080', '127.0.0.1:80:90', '::1', '[::1]junk', '1.2.3', 'a:b']) {
      expect('error' in parseWebAccessAddress(bad)).toBe(true)
    }
  })

  it('carries an actionable message on every refusal', () => {
    const refused = parseWebAccessAddress('nope')
    expect('error' in refused).toBe(true)
    if ('error' in refused) {
      expect(refused.error.length).toBeGreaterThan(10)
      expect(refused.error).toMatch(/127\.0\.0\.1/)
    }
  })
})

describe('parseWebAccessToken', () => {
  it('accepts an in-bounds credential and trims the paste artifacts', () => {
    expect(parseWebAccessToken('custom-token-123')).toEqual({ token: 'custom-token-123' })
    expect(parseWebAccessToken('  spaced-token-1  ')).toEqual({ token: 'spaced-token-1' })
    expect(parseWebAccessToken('a'.repeat(WEB_ACCESS_TOKEN_MAX_LENGTH))).toEqual({
      token: 'a'.repeat(WEB_ACCESS_TOKEN_MAX_LENGTH),
    })
  })

  it('rejects values below the floor — including the empty one', () => {
    for (const input of ['', 'short', '  ', 'a'.repeat(WEB_ACCESS_TOKEN_MIN_LENGTH - 1)]) {
      const result = parseWebAccessToken(input)
      if (!('error' in result)) {
        throw new Error(`parseWebAccessToken(${JSON.stringify(input)}) accepted a too-short token`)
      }
      expect(result.error).toContain(`at least ${WEB_ACCESS_TOKEN_MIN_LENGTH}`)
      expect(result.error).toContain('generated')
    }
  })

  it('rejects values above the ceiling', () => {
    const result = parseWebAccessToken('x'.repeat(WEB_ACCESS_TOKEN_MAX_LENGTH + 1))
    expect('error' in result && result.error).toContain(`at most ${WEB_ACCESS_TOKEN_MAX_LENGTH}`)
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
