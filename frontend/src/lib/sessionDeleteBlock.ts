// Reliable recognition of the backend's session-deletion refusal.

/**
 * A recognized blocked refusal: what was refused and which decision unblocks it.
 */
export interface SessionDeleteBlock {
  /** Human-readable explanation shown to the user. */
  reason: string
  /** Names the `SessionDeleteOptions` field that authorizes proceeding
   *  (`confirm_uncommitted_loss` or `unlock_locked_tree`). */
  option: string
}

/**
 * The exact text of `backend.SessionDeleteBlockedError.Error()`:
 *   `session deletion blocked: <reason> (confirm via <option>)`
 * The reason is matched greedily and the suffix is anchored to the end, so a
 * reason that itself contains parentheses (the backend's dirty-tree message
 * quotes the worktree name and the branch: `… "s-x" (branch main) …`) still
 * parses. The option is a Go field name — snake_case identifiers only.
 */
const BLOCKED_RE = /^session deletion blocked: (.+) \(confirm via ([A-Za-z0-9_]+)\)$/

/** Normalize an unknown thrown value into a displayable message. Wails
 *  delivers Go RPC errors as plain strings while code under test throws
 *  `Error` instances — both must parse identically. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Parse a session-deletion refusal into its reason and authorizing option.
 * Returns null for any other error — callers use that to distinguish a
 * structured block (surface the reason, offer the named confirmation, retry
 * with the matching flag) from a plain failure (show the message; nothing to
 * confirm, and the session is NOT safely untouched by assumption).
 */
export function parseSessionDeleteBlock(err: unknown): SessionDeleteBlock | null {
  const [, reason, option] = BLOCKED_RE.exec(messageOf(err)) ?? []
  // The groups are unconditional, so both are always present on a match —
  // the undefined checks only narrow the indexed-access types.
  if (reason === undefined || option === undefined) return null
  return { reason, option }
}
