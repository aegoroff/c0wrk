import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateMessageId, generateUUID } from './ids'

// Canonical RFC 4122 v4 shape: version nibble fixed to `4`, variant limited to
// 10xx (8/9/a/b) — both are set by formatUuidBytes for the fallback paths.
const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('generateUUID', () => {
  it('returns a valid RFC 4122 v4 UUID', () => {
    expect(generateUUID()).toMatch(V4_RE)
  })

  it('is unique across many calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 500; i++) ids.add(generateUUID())
    expect(ids.size).toBe(500)
  })

  it('still prefers the native randomUUID when present (secure context)', () => {
    const native = vi.fn(() => 'native-uuid')
    vi.stubGlobal('crypto', { randomUUID: native, getRandomValues: vi.fn() })
    expect(generateUUID()).toBe('native-uuid')
    expect(native).toHaveBeenCalledOnce()
  })

  it('falls back to getRandomValues when randomUUID is unavailable (plain-HTTP context)', () => {
    // What a browser over http://<lan-ip> exposes: no randomUUID at all.
    let seed = 42
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array): Uint8Array => {
        for (let i = 0; i < array.length; i++) {
          seed = (seed * 1103515245 + 12345) % 2147483648
          array[i] = seed & 0xff
        }
        return array
      },
    })
    const first = generateUUID()
    expect(first).toMatch(V4_RE)
    expect(generateUUID()).not.toBe(first)
  })

  it('falls back to Math.random without any crypto at all', () => {
    vi.stubGlobal('crypto', undefined)
    expect(generateUUID()).toMatch(V4_RE)
  })
})

describe('generateMessageId', () => {
  it('delegates to generateUUID (v4 shape)', () => {
    expect(generateMessageId()).toMatch(V4_RE)
  })
})
