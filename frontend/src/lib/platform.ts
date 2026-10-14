/**
 * Host-platform detection, shared across the app.
 *
 * `navigator.platform` is the primary signal (WebKit composes it from
 * uname(): "Linux x86_64" on amd64, "Linux aarch64" on arm64 — a
 * first-class release platform, ADR-027), with `navigator.userAgent` as
 * the fallback for engines that leave platform empty. The match is
 * deliberately substring-based ("Linux"), never an exact arch string, so
 * every architecture passes.
 */

/** Reports whether the app runs on a Linux host. */
export function isLinuxHost(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Linux/i.test(navigator.platform || navigator.userAgent)
  )
}

/**
 * Reports whether the app runs on a macOS host. Same signal pair as
 * `isLinuxHost`: "Mac" matches MacIntel/Macintosh platform strings and the
 * "Macintosh; Intel Mac OS X" userAgent, and no other host string contains
 * it (Linux and Windows UAs never carry the substring).
 */
export function isMacHost(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac/i.test(navigator.platform || navigator.userAgent)
  )
}
