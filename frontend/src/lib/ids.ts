/**
 * Client-side identifier generation.
 *
 * `crypto.randomUUID` exists only in secure contexts (HTTPS, or loopback
 * http). The same UI is served over plain HTTP on non-loopback addresses by
 * the web-access sidecar (ADR-098), where the method is simply absent — and
 * the very first render already needs a fresh id (the initial tab is born in
 * the tabStore initializer), so an unguarded call crashes the app into a gray
 * screen. `generateUUID` uses the native implementation when present and
 * falls back to `crypto.getRandomValues` (available in insecure contexts),
 * then, as a last resort, to `Math.random`.
 */
export function generateUUID(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return formatUuidBytes(bytes)
}

/** Set the RFC 4122 version-4 and variant bits, then render the canonical form. */
function formatUuidBytes(bytes: Uint8Array): string {
  const b6 = bytes[6] ?? 0
  const b8 = bytes[8] ?? 0
  bytes[6] = (b6 & 0x0f) | 0x40
  bytes[8] = (b8 & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function generateMessageId(): string {
  return generateUUID()
}
