// Pure aggregation helpers for the global active-sessions badge (the sessions
// dropdown in the sidebar). No React, no store imports — every function here is
// unit-testable in isolation and composable at the call site:
//
//   chatStore snapshot  ──deriveLiveSessionFlags──▶ Record<id, LiveSessionFlags>
//   pendingOverride (GetPendingActions) ──mergePendingOverride──▶ effective flags
//   sessions snapshot + effective flags ──aggregateBadgeFlags──▶ BadgeFlags
//
// The DB-side snapshot (SessionInfo[]) may lag reality: it is refreshed
// debounced (activeSessionsStore.refresh) and only reflects what the backend
// persisted at query time. The LIVE side (taskActive / paused / HITL prompts)
// is read from chatStore — the single source of truth for live execution
// state, kept in sync for background sessions by useBackgroundSessionWatcher
// (same rationale as useSessionStatusIndicator).

import type { PendingActionsResponse } from '@/api/chat'
import type { ChatMessageUI } from '@/types/messages'
import type { SessionInfo } from '@/types/models'
import { hasUnresolvedHITL } from '@/lib/hitlTypes'

/** Per-session display status for the global sessions badge / switcher rows.
 *  Exactly one color per session; see sessionDisplayStatus for priorities. */
export type SessionDisplayStatus = 'pending' | 'failed' | 'active' | 'paused' | 'idle'

/** Live per-session execution flags derived from chatStore. */
export interface LiveSessionFlags {
  /** A task is currently running in this session. */
  readonly taskActive: boolean
  /** The running task is cooperatively suspended at a checkpoint. */
  readonly paused: boolean
  /** An unresolved HITL prompt (tool_confirm / ask_user / step_limit /
   *  plan_review / goal_proposal) awaits the user. */
  readonly hasPendingHITL: boolean
  /** Live unfinished-task status (chatStore.unfinishedTaskStatus) — the SAME
   *  string the DB snapshot carries, but kept authoritative in memory so every
   *  surface repaints the instant a lifecycle event lands. `undefined` =
   *  chatStore holds no live knowledge for the session (a webview reload, a
   *  session never followed), so consumers FALL BACK to the DB snapshot's
   *  `unfinished_task_status`. `''` = chatStore KNOWS the task settled, which
   *  overrides a stale DB `in_progress`/`paused`/`failed` left over from a list
   *  load taken mid-task (the snapshot poll is only every ~30s). */
  readonly unfinishedTaskStatus?: string
}

/** Stable "nothing live" flags — returned by lookups for sessions chatStore
 *  knows nothing about. A shared constant, never a fresh object, so callers
 *  can compare by reference (React #185 convention). */
export const NO_LIVE_FLAGS: LiveSessionFlags = { taskActive: false, paused: false, hasPendingHITL: false }

/** Aggregate badge state over ALL sessions (see aggregateBadgeFlags). */
export interface BadgeFlags {
  /** Red — at least one live session has a failed task. */
  readonly error: boolean
  /** Yellow — at least one session awaits a HITL response. */
  readonly attention: boolean
  /** Green — at least one session is actively processing. */
  readonly active: boolean
  /** Gray — at least one session is paused. */
  readonly paused: boolean
  /** Any of the above — a non-archived session is in a non-idle state. */
  readonly anyLive: boolean
}

/** Stable all-false badge state — returned by aggregateBadgeFlags when no
 *  session is live, so selectors can keep a referentially stable value. */
export const NO_BADGE_FLAGS: BadgeFlags = { error: false, attention: false, active: false, paused: false, anyLive: false }

/** The single status-derivation input, independent of which snapshot a surface
 *  reads. `unfinishedStatus` is the EFFECTIVE unfinished-task status for the
 *  session — the live chatStore overlay when known, otherwise the DB snapshot's
 *  `unfinished_task_status` (see {@link effectiveUnfinishedStatus}). */
export interface SessionStatusInput {
  readonly taskActive: boolean
  readonly paused: boolean
  readonly hasPendingHITL: boolean
  readonly archived: boolean
  /** '' = no unfinished task; 'failed' | 'in_progress' | 'paused' | unknown. */
  readonly unfinishedStatus: string
}

/**
 * THE single per-session status derivation — one implementation shared by every
 * surface that paints a session-status dot: the sidebar session list
 * (useSessionStatusIndicator), the live-sessions radar badge
 * (aggregateBadgeFlags) and the radar dropdown rows (sortedLiveRows). No surface
 * may reimplement this priority.
 *
 * Priority (most urgent first): pending (yellow) > failed (red) > active
 * (green) > paused (gray) > idle.
 * - `pending` — an unresolved HITL prompt: the user's response is the next
 *   step, the most informative signal even while taskActive is still true.
 * - `failed` — an unfinished task recorded as failed; beats a concurrently
 *   true running flag so a restart-race never paints failure green.
 * - `active` — running live, OR the status says in_progress.
 * - `paused` — live-paused, OR the status says paused.
 * - Unknown non-empty status values (future backends) render as `active` — the
 *   session IS unfinished, silently showing idle would hide it.
 *
 * Archived sessions always render idle (a dot only surfaces live work).
 */
export function deriveSessionStatus(input: SessionStatusInput): SessionDisplayStatus {
  if (input.archived) return 'idle'
  if (input.hasPendingHITL) return 'pending'
  const s = input.unfinishedStatus
  if (s === 'failed') return 'failed'
  if (input.taskActive || s === 'in_progress') return 'active'
  if (input.paused || s === 'paused') return 'paused'
  if (s !== '') return 'active'
  return 'idle'
}

/** The unfinished-task status a surface should color from: the LIVE overlay
 *  when chatStore has live knowledge of the session, otherwise the DB
 *  snapshot's value. `undefined` distinguishes "no live knowledge" from a live
 *  `''` (task settled), so a live clear correctly overrides a stale DB
 *  snapshot.
 *
 *  The DB fallback reads the STATUS STRING, not the redundant
 *  `has_unfinished_task` boolean: the list queries always SELECT both columns
 *  (backend/session/persistence.go), and the string carries strictly more
 *  information. When the string is absent (older/partial payload) an unfinished
 *  session reads idle here, matching the pre-existing contract. */
export function effectiveUnfinishedStatus(session: SessionInfo, live: LiveSessionFlags): string {
  return live.unfinishedTaskStatus ?? session.unfinished_task_status ?? ''
}

/**
 * Does this session count as "live" for the badge — i.e. worth surfacing to
 * the user because something is unfinished or in flight?
 *
 * True when the session is NOT archived and ANY of:
 * - the effective status says it has an unfinished task (non-empty),
 * - a task is live-running or live-paused (chatStore flags),
 * - an unresolved HITL prompt awaits the user.
 */
export function isLiveSession(session: SessionInfo, live: LiveSessionFlags): boolean {
  if (session.archived) return false
  if (live.taskActive || live.paused || live.hasPendingHITL) return true
  return effectiveUnfinishedStatus(session, live) !== ''
}

/** Derive the single display status for a session — thin adapter over
 *  {@link deriveSessionStatus} folding a SessionInfo and its live flags. */
export function sessionDisplayStatus(session: SessionInfo, live: LiveSessionFlags): SessionDisplayStatus {
  return deriveSessionStatus({
    archived: session.archived,
    hasPendingHITL: live.hasPendingHITL,
    taskActive: live.taskActive,
    paused: live.paused,
    unfinishedStatus: effectiveUnfinishedStatus(session, live),
  })
}

/**
 * Fold per-session statuses into the aggregate badge flags: each flag is true
 * when at least one live session shows the corresponding status. Archived and
 * idle sessions contribute nothing. Returns the shared NO_BADGE_FLAGS constant
 * (stable reference) when nothing is live.
 *
 * `liveFlags` maps sessionId → live flags; missing entries fall back to
 * NO_LIVE_FLAGS (sessions chatStore knows nothing about are judged purely on
 * their DB snapshot).
 */
export function aggregateBadgeFlags(
  sessions: readonly SessionInfo[],
  liveFlags: Readonly<Record<string, LiveSessionFlags>>,
): BadgeFlags {
  let error = false
  let attention = false
  let active = false
  let paused = false
  for (const session of sessions) {
    const live = liveFlags[session.id] ?? NO_LIVE_FLAGS
    if (!isLiveSession(session, live)) continue
    const status = sessionDisplayStatus(session, live)
    switch (status) {
      case 'pending': attention = true; break
      case 'failed': error = true; break
      case 'active': active = true; break
      case 'paused': paused = true; break
    }
  }
  if (!error && !attention && !active && !paused) return NO_BADGE_FLAGS
  return { error, attention, active, paused, anyLive: true }
}

/** The chatStore slices deriveLiveSessionFlags needs. Structural (plain data)
 *  so tests can pass literals without React. `unfinishedTaskStatus` is optional
 *  so existing literals (and older call sites) stay valid — an absent map means
 *  "no live unfinished-status knowledge", i.e. every session falls back to the
 *  DB snapshot. */
export interface LiveChatSnapshot {
  readonly taskActive: Readonly<Record<string, boolean>>
  readonly paused: Readonly<Record<string, boolean>>
  readonly messageOrder: Readonly<Record<string, readonly string[]>>
  readonly messages: Readonly<Record<string, Readonly<Record<string, ChatMessageUI>>>>
  readonly unfinishedTaskStatus?: Readonly<Record<string, string>>
}

/**
 * Derive live flags for every session chatStore has live knowledge of, in the
 * same shape useSessionStatusIndicator reads a single session (global variant):
 * taskActive / paused maps plus a HITL scan over the ordered messages.
 *
 * ⚠️ Allocates a fresh record on every call — NEVER use as a Zustand selector
 * (React #185); call it inside useMemo / plain code instead. Only sessions
 * with at least one live signal get an entry; look up with
 * `flags[id] ?? NO_LIVE_FLAGS`.
 */
export function deriveLiveSessionFlags(chat: LiveChatSnapshot): Readonly<Record<string, LiveSessionFlags>> {
  const result: Record<string, LiveSessionFlags> = {}
  for (const [sessionId, running] of Object.entries(chat.taskActive)) {
    if (running) result[sessionId] = { taskActive: true, paused: false, hasPendingHITL: false }
  }
  for (const [sessionId, isPaused] of Object.entries(chat.paused)) {
    if (!isPaused) continue
    const existing = result[sessionId]
    if (existing) {
      if (!existing.paused) result[sessionId] = { ...existing, paused: true }
    } else {
      result[sessionId] = { taskActive: false, paused: true, hasPendingHITL: false }
    }
  }
  for (const [sessionId, order] of Object.entries(chat.messageOrder)) {
    const index = chat.messages[sessionId]
    if (!index || order.length === 0) continue
    const msgs: ChatMessageUI[] = []
    for (const id of order) {
      const m = index[id]
      if (m) msgs.push(m)
    }
    if (!hasUnresolvedHITL(msgs)) continue
    const existing = result[sessionId]
    if (existing) {
      if (!existing.hasPendingHITL) result[sessionId] = { ...existing, hasPendingHITL: true }
    } else {
      result[sessionId] = { taskActive: false, paused: false, hasPendingHITL: true }
    }
  }
  // Live unfinished-task status: fold chatStore's authoritative per-session
  // string in — including the empty-string "settled" value, which lets a live
  // clear override a stale DB snapshot (in_progress/paused/failed left over
  // from a list load taken mid-task). A session gets an entry whenever
  // chatStore holds live knowledge of it, even with no other live signal.
  for (const [sessionId, status] of Object.entries(chat.unfinishedTaskStatus ?? {})) {
    const existing = result[sessionId]
    if (existing) {
      if (existing.unfinishedTaskStatus !== status) result[sessionId] = { ...existing, unfinishedTaskStatus: status }
    } else {
      result[sessionId] = { taskActive: false, paused: false, hasPendingHITL: false, unfinishedTaskStatus: status }
    }
  }
  return result
}

/**
 * OR-merge the authoritative GetPendingActions override into derived live
 * flags: `override[id] === true` forces hasPendingHITL on. `false` / absent
 * entries never CLEAR a live-derived HITL signal — the override only adds
 * knowledge chatStore cannot have (e.g. a session whose messages were never
 * loaded but whose task is blocked on a prompt).
 *
 * Returns the SAME reference as `base` when the merge changes nothing, so
 * memoized consumers keep referential stability.
 */
export function mergePendingOverride(
  base: Readonly<Record<string, LiveSessionFlags>>,
  override: Readonly<Record<string, boolean>>,
): Readonly<Record<string, LiveSessionFlags>> {
  let merged: Record<string, LiveSessionFlags> | null = null
  for (const [sessionId, pending] of Object.entries(override)) {
    if (!pending) continue
    const existing = base[sessionId]
    if (existing?.hasPendingHITL) continue
    if (!merged) merged = { ...base }
    merged[sessionId] = existing
      ? { ...existing, hasPendingHITL: true }
      : { taskActive: false, paused: false, hasPendingHITL: true }
  }
  return merged ?? base
}

/** True when a GetPendingActions response contains at least one pending
 *  prompt of any kind. `null` (RPC failure / malformed payload) counts as
 *  "no pending" — the override must fail open, not paint phantom yellow. */
export function hasPendingActions(response: PendingActionsResponse | null): boolean {
  if (!response) return false
  return (
    response.tool_confirms.length > 0 ||
    response.step_limits.length > 0 ||
    response.plan_approvals.length > 0 ||
    response.ask_user.length > 0 ||
    response.goal_proposals.length > 0
  )
}

/**
 * Stable string signature of the set of live session ids (taskActive or
 * paused). Changes exactly when a session STARTS or STOPS being live — i.e. on
 * task transitions (start / complete / error / cancel / pause / resume / resumable
 * failure) — and not on streaming chunks or message appends. Used as an effect
 * dependency to re-snapshot the DB list after transitions; the primitive
 * string return keeps it safe as a Zustand selector (React #185).
 */
export function liveSessionsSignature(
  taskActive: Readonly<Record<string, boolean>>,
  paused: Readonly<Record<string, boolean>>,
): string {
  const ids = new Set<string>()
  for (const [id, running] of Object.entries(taskActive)) {
    if (running) ids.add(id)
  }
  for (const [id, isPaused] of Object.entries(paused)) {
    if (isPaused) ids.add(id)
  }
  if (ids.size === 0) return ''
  return [...ids].sort().join('\n')
}

/**
 * One-shot composition for the badge: derive live flags from the chat
 * snapshot, OR-merge the pending override, aggregate over the session list.
 * Convenience entry point for the UI (all steps are individually testable).
 * `sessions` may be null (never loaded) — treated as an empty list.
 */
export function deriveBadgeFlags(
  sessions: readonly SessionInfo[] | null,
  chat: LiveChatSnapshot,
  override: Readonly<Record<string, boolean>>,
): BadgeFlags {
  const live = mergePendingOverride(deriveLiveSessionFlags(chat), override)
  return aggregateBadgeFlags(sessions ?? [], live)
}

/** One row of the active-sessions dropdown: the live session plus its
 *  derived display status. */
export interface LiveSessionRow {
  readonly session: SessionInfo
  readonly status: SessionDisplayStatus
}

/** Stable empty rows list — returned by sortedLiveRows when there is nothing
 *  live, so memoized consumers keep a referentially stable value. */
export const NO_LIVE_ROWS: readonly LiveSessionRow[] = []

/** Display statuses that sort to the top of the sessions dropdown: something
 *  needs the user (pending) or died and can be resumed (failed). */
const URGENT_STATUSES: ReadonlySet<SessionDisplayStatus> = new Set(['pending', 'failed'])

/**
 * The dropdown's row list: every live session (isLiveSession) with its
 * display status, sorted urgent-first (pending/failed), then by most recent
 * activity (last_active_at descending) within each group. `sessions` may be
 * null (never loaded) — treated as an empty list.
 */
export function sortedLiveRows(
  sessions: readonly SessionInfo[] | null,
  liveFlags: Readonly<Record<string, LiveSessionFlags>>,
): readonly LiveSessionRow[] {
  if (!sessions) return NO_LIVE_ROWS
  const rows: LiveSessionRow[] = []
  for (const session of sessions) {
    const live = liveFlags[session.id] ?? NO_LIVE_FLAGS
    if (!isLiveSession(session, live)) continue
    rows.push({ session, status: sessionDisplayStatus(session, live) })
  }
  rows.sort((a, b) => {
    const urgent = Number(URGENT_STATUSES.has(b.status)) - Number(URGENT_STATUSES.has(a.status))
    if (urgent !== 0) return urgent
    // ISO-8601 timestamps sort chronologically as plain strings.
    return b.session.last_active_at.localeCompare(a.session.last_active_at)
  })
  return rows
}
