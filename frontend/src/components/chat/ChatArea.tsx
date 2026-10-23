import { useEffect, useRef, useMemo } from 'react'
import { useChatStore, useSessionMessages, useSessionWorkUnits, useSessionHistoryLoaded } from '@/stores/chatStore'
import { useBookmarkStore } from '@/stores/bookmarkStore'
import { groupMessages, stabilizeDisplayItems } from '@/lib/chatUtils'
import { reloadSessionHistory, reportHistoryLoadFailure } from '@/lib/sessionHistoryReload'
import { useSessionStore } from '@/stores/sessionStore'
import { useInputModeStore } from '@/stores/inputModeStore'
import { usePlanStore } from '@/stores/planStore'
import { useTaskFlagRestore } from '@/hooks/useTaskFlagRestore'
import type { DisplayItem } from '@/types/messages'
import { AssistantMessage } from './AssistantMessage'
import { ActivityIndicator } from './ActivityIndicator'
import { ChatScrollManager } from './ChatScrollManager'
import { ChatMessageRenderer, CompactErrorFallback } from './ChatMessageRenderer'
import { ChatHoverRegion } from './ChatHoverRegion'
import { ExecutionPanels } from './ExecutionPanels'
import { BlackboardPanel } from './BlackboardPanel'
import { BookmarksPanel } from './BookmarksPanel'
import { ChatInput } from './ChatInput'
import { ArchivedBanner } from './ArchivedBanner'
import { ScrollProvider } from './ScrollContext'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Loader2, MessageCircle } from 'lucide-react'
import { logger } from '@/lib/logger'

export function ChatArea() {
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  // Whether the active session is archived. An archived session is read-only,
  // so the message input shell is replaced by an "Archived" banner. Returns a
  // primitive boolean for referential stability (no object allocation).
  const isArchived = useSessionStore(s =>
    s.sessions?.find(sess => sess.id === s.activeSessionId)?.archived ?? false
  )
  // Input mode is selected here (not just inside ChatInput) so the input
  // shell's error boundary can reset when the user flips chat↔terminal: a
  // caught error otherwise sticks for the lifetime of the mount and the input
  // stays replaced by its fallback even after the cause is gone.
  const inputMode = useInputModeStore(s => s.mode)
  const messages = useSessionMessages(activeSessionId)
  // Durable work-unit overlay (stepId -> block status) from the last session
  // load; consumed by groupMessages to align paused/interrupted delegate &
  // plan-step blocks. A stable store reference (no per-render allocation).
  const workUnits = useSessionWorkUnits(activeSessionId)
  const streamingText = useChatStore(s => activeSessionId ? s.streamingText[activeSessionId] : undefined)
  // Drives the live turn's open state in ChatMessageRenderer: while the task
  // runs, the last turn's work block stays open (status running); when the
  // task ends (or the session is paused), it settles (collapsed,
  // completed/interrupted). Boolean coercion keeps the selector referentially
  // stable (undefined -> false).
  const isTaskActive = useChatStore(s => activeSessionId ? (s.taskActive[activeSessionId] ?? false) : false)
  // Whether the active session's persisted-history load has settled (the
  // shared loader marks it in a finally — success and failure alike).
  // Primitive selector, referentially stable. Lets the empty-session branch
  // tell "still loading" (spinner) from "genuinely empty" (placeholder icon).
  const historyLoaded = useSessionHistoryLoaded(activeSessionId)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Baseline for transcript stabilization (see the displayItems memo below):
  // the previous committed item tree, reused for identity-stable items.
  const prevItemsRef = useRef<DisplayItem[]>([])

  // Trailing streaming answer, rendered INSIDE the live turn's TurnWorkBlock
  // (the renderer's tailSlot). Memoized by content so the slot keeps a stable
  // identity across unrelated ChatArea re-renders: TurnWorkBlock's memo
  // comparator treats a slot identity change as "a new chunk landed" and
  // re-renders the block — a fresh fragment allocated on every render would
  // keep that comparator clause permanently false.
  const trailingContent = useMemo(() => (
    <>
      {streamingText && (
        <ErrorBoundary fallback={<CompactErrorFallback />}>
          <AssistantMessage content={streamingText} isStreaming />
        </ErrorBoundary>
      )}
    </>
  ), [streamingText])

  // Load persisted history on session change, then reconcile the chat store
  // against the backend runtime status and pending-action set AFTER the merge.
  //
  // The load itself lives in lib/sessionHistoryReload (shared with the app-root
  // shallow-resync triggers, which re-run it on WS re-connect / window focus
  // without a session switch). The merge into chatStore is merge-dedup, so a
  // re-run can neither duplicate nor drop messages.
  //
  // Reconciliation runs inside the loader after mergeHistoryMessages (not in a
  // separate effect) so it always sees a populated store. Previously the
  // status/pending RPCs resolved faster than the history RPC and reconciled an
  // empty store, then history loaded with unresolved prompts and nothing
  // re-triggered reconciliation — so stale plan_review / task_failed_resumable
  // banners reappeared in completed sessions.
  //
  // A `cancelled` flag guards the whole async chain: if the user switches
  // sessions before it settles, the result is discarded (the new session's
  // own chain takes over). This is equivalent to `useLatestAsync.wrap` but
  // spans a multi-step await sequence.
  useEffect(() => {
    // A session switch invalidates the stabilization baseline: the new
    // session's items must not be compared against the old one's (their keys
    // may even collide). Dropping the baseline also releases the previous
    // session's item tree.
    prevItemsRef.current = []
    if (!activeSessionId) {
      usePlanStore.getState().clearPlan()
      return
    }
    usePlanStore.getState().clearPlan()
    let cancelled = false
    reloadSessionHistory(activeSessionId, { isCancelled: () => cancelled }).catch((err) => {
      if (cancelled) return
      logger.error('Failed to load session history:', err)
      // Shared card emission (same helper as the load-phase catch): the
      // deterministic id upserts, and a reconcile failure beneath an already
      // rendered transcript logs instead of appending a false failure card.
      reportHistoryLoadFailure(activeSessionId, 'reconcile phase')
    })

    return () => { cancelled = true }
  }, [activeSessionId])

  // Restore the taskActive flag fast and independently of history loading.
  // Extracted into useTaskFlagRestore (single tested implementation, with the
  // stale-snapshot guard that keeps a live resume/terminal transition from
  // being reverted by an older status snapshot).
  useTaskFlagRestore(activeSessionId)

  // Load bookmarks for the active session (bookmarks are isolated per session).
  useEffect(() => {
    if (activeSessionId) void useBookmarkStore.getState().loadBookmarks(activeSessionId)
  }, [activeSessionId])

  // groupMessages rebuilds the WHOLE item tree on every store change (a new
  // message, a resolved confirmation, a streamed tail), handing every block a
  // brand-new `item` object. Stabilize the tree against the previous output so
  // items that did not change keep their object identity — that identity is
  // what lets the memoized message blocks skip re-rendering (and re-parsing
  // their Markdown) when a single message changes. The ref is updated after the
  // commit (not during render, which React StrictMode would double-invoke).
  const displayItems = useMemo(() => {
    const grouped = groupMessages(messages, workUnits).items
    return stabilizeDisplayItems(prevItemsRef.current, grouped)
  }, [messages, workUnits])
  useEffect(() => {
    prevItemsRef.current = displayItems
  }, [displayItems])

  if (!activeSessionId) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="flex flex-col items-center gap-3">
            <MessageCircle className="h-12 w-12 opacity-20" />
          </div>
        </div>
        <ChatInput />
      </div>
    )
  }

  const hasContent = messages.length > 0 || !!streamingText

  // Archived sessions are read-only: swap the input shell for an "Archived"
  // banner. Hoisted into a single const so the archived gate lives in one
  // place (used by both render branches below). activeSessionId is guaranteed
  // non-null past the early return above, so no extra null check is needed.
  const inputShell = isArchived ? <ArchivedBanner sessionId={activeSessionId} /> : <ChatInput />

  if (!hasContent) {
    // History (GetSessionHistory + reconcile) still in flight with nothing to
    // show: spin in place of the empty-session icon so a cold start and a
    // session switch A→B don't flash the "empty session" placeholder. The
    // marker settles on BOTH resolve and reject (loader's finally), so a
    // failed load stops the spin and the error card explains the empty chat;
    // a resync re-run never reaches this branch while content is on screen.
    const historyInFlight = !historyLoaded
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="flex flex-col items-center gap-3">
            {historyInFlight
              ? <Loader2 className="size-8 animate-spin opacity-30" aria-label="Loading session history" />
              : <MessageCircle className="h-12 w-12 opacity-20" />}
          </div>
        </div>
        <ErrorBoundary fallback={<div className="text-xs text-destructive p-2">Panel error</div>}>
          <ExecutionPanels />
          <BlackboardPanel />
        </ErrorBoundary>
        <ErrorBoundary
          resetKeys={[activeSessionId, inputMode, isArchived]}
          fallback={<div className="text-xs text-destructive p-2">Input error</div>}
        >
          {inputShell}
        </ErrorBoundary>
      </div>
    )
  }

  return (
    <ScrollProvider>
      <div className="relative flex flex-1 flex-col min-h-0 bg-background">
        <ChatScrollManager key={activeSessionId} sessionId={activeSessionId} messages={messages} streamingText={streamingText} scrollRef={scrollRef}>
          <ChatHoverRegion className="p-4 space-y-4 min-w-0">
            <ChatMessageRenderer
              items={displayItems}
              stickyUserMessages
              lastTurnActive={isTaskActive}
              trailingContent={trailingContent}
              trailingFooter={<ActivityIndicator />}
            />
          </ChatHoverRegion>
        </ChatScrollManager>
        <ErrorBoundary fallback={<div className="text-xs text-destructive p-2">Panel error</div>}>
          <ExecutionPanels />
          <BlackboardPanel />
          <BookmarksPanel displayItems={displayItems} />
        </ErrorBoundary>
        <ErrorBoundary
          resetKeys={[activeSessionId, inputMode, isArchived]}
          fallback={<div className="text-xs text-destructive p-2">Input error</div>}
        >
          {inputShell}
        </ErrorBoundary>
      </div>
    </ScrollProvider>
  )
}
