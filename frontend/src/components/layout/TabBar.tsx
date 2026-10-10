import { useCallback } from 'react'
import { Plus, Settings, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settingsStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useTabStore, useTabs, useActiveTabId, type Tab } from '@/stores/tabStore'
import { selectSessionNameFor, selectTitleScopeFor } from '@/hooks/useWindowTitle'
import { useSessionStatusIndicator } from '@/hooks/useSessionStatusIndicator'
import type { SessionDisplayStatus } from '@/lib/activeSessions'
import { buildTabLabel } from '@/lib/tabLabel'
import type { TabController } from '@/hooks/useTabController'
import { cn } from '@/lib/utils'

// The workspace tab bar (rendered above the main row only when
// uiStore.tabsEnabled is on — AppLayout owns that gate). Presentational:
// every interaction is routed through the single activation engine via the
// TabController prop (one useTabController mount lives in AppLayout), and
// every label/status is derived LIVE from the project/session/chat stores by
// id, so renames and lifecycle events repaint without the tab holding a
// stale copy — the same contract useWindowTitle follows. The label builder
// itself lives in lib/tabLabel.ts (pure string algebra).

/** Dot color per display status — the SAME tokens and wording the session
 *  list (SessionListItem) and the radar rows (ActiveSessionRow) use, so the
 *  three surfaces can never drift. `idle` has no dot. */
const STATUS_DOT_CLASSES: Partial<Record<SessionDisplayStatus, string>> = {
  pending: 'bg-warning',
  failed: 'bg-destructive',
  active: 'bg-success',
  paused: 'bg-muted-foreground',
}

/** Dot hover hint — SessionListItem's wording. */
const STATUS_DOT_TITLES: Partial<Record<SessionDisplayStatus, string>> = {
  pending: 'Awaiting your response',
  failed: 'Task failed — resume available',
  active: 'Task running',
  paused: 'Task paused',
}

export interface TabBarProps {
  /** The app-level controller (AppLayout's single useTabController mount). */
  controller: TabController
}

export function TabBar({ controller }: TabBarProps) {
  const tabs = useTabs()
  const activeTabId = useActiveTabId()
  const openSettings = useSettingsStore((s) => s.openSettings)

  const handleClose = useCallback(
    (id: string) => {
      const state = useTabStore.getState()
      const index = state.tabs.findIndex((tab) => tab.id === id)
      if (index === -1) return
      if (id !== state.activeTabId || state.tabs.length === 1) {
        // An inactive tab (or the last remaining one): the store transition
        // needs no activation. The last-tab replacement makes a fresh default
        // tab ACTIVE while the live workspace stays where it is — converge it
        // immediately, same reasoning as «+» below.
        useTabStore.getState().closeTab(id)
        if (state.tabs.length === 1) controller.writeBack()
        return
      }
      // Closing the ACTIVE tab: bring the neighbor fully live through the ONE
      // engine path FIRST (capture the outgoing context → flip → project/
      // session move → slice restore), THEN remove the closed tab. Closing
      // first would leave the neighbor active with its unapplied remembered
      // context, and the next write-back would clobber that memory with the
      // closed tab's live context. The neighbor choice mirrors the store's
      // own rule (right neighbor, else the last tab).
      const neighbor = state.tabs[index + 1] ?? state.tabs[index - 1]
      if (neighbor === undefined) return // unreachable: length > 1 here
      void controller.activate(neighbor.id).then(() => {
        useTabStore.getState().closeTab(id)
      })
    },
    [controller],
  )

  const handleAdd = useCallback(() => {
    const id = useTabStore.getState().addTab()
    // addTab already flipped activeTabId, so activate() is a deliberate no-op
    // (the engine's guard treats an already-active tab as nothing to capture
    // or restore) — the call merely keeps creation routed through the single
    // engine entry point.
    void controller.activate(id)
    // The fresh tab is active but still carries its default-empty context,
    // and a tabStore-only change never fires the write-back subscriptions —
    // converge it to the live workspace NOW so the title/status never lag a
    // store event behind the flip.
    controller.writeBack()
  }, [controller])

  // Keyboard interaction on the tab strip (WAI-ARIA APG Tabs, manual
  // activation): ←/→ move FOCUS to the neighbor row (wrapping both ends),
  // Home/End jump to the first/last, Enter/Space activate the focused row —
  // mirroring the system cycling shortcuts' wrap-around. Focus-only arrows
  // keep switching an explicit commitment (Enter/Space/click); the row is a
  // div, so button semantics don't apply natively. Row keys work only when
  // the row ITSELF is focused — the nested close button is a real button
  // and keeps its native behavior.
  const handleTablistKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]')
      if (row === null || e.target !== row) return
      switch (e.key) {
        case 'Enter':
        case ' ':
          e.preventDefault()
          void controller.activate(row.dataset.tabId ?? '')
          return
        case 'ArrowRight':
        case 'ArrowLeft':
        case 'Home':
        case 'End':
          break
        default:
          return
      }
      e.preventDefault()
      const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
      const nextIndex =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? rows.length - 1
            : (rows.indexOf(row) + (e.key === 'ArrowRight' ? 1 : -1) + rows.length) % rows.length
      rows[nextIndex]?.focus()
    },
    [controller],
  )

  return (
    // Zoom-safe by construction: fixed token heights, no viewport units — the
    // bar is a plain flex row shrinking to zero under the h-full app shell.
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
      {/* Overflow scrolls; the custom-scrollbar keeps the 8px app-wide look. */}
      <div
        role="tablist"
        aria-label="Workspace tabs"
        onKeyDown={handleTablistKeyDown}
        className="custom-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => (
          <TabRow
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            controller={controller}
            onClose={handleClose}
          />
        ))}
      </div>
      <Button variant="ghost" size="icon-sm" onClick={handleAdd} aria-label="New tab" title="New tab">
        <Plus className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => openSettings('appearance')}
        aria-label="Settings"
        title="Settings"
      >
        <Settings className="size-4" />
      </Button>
    </div>
  )
}

interface TabRowProps {
  tab: Tab
  active: boolean
  controller: TabController
  onClose: (id: string) => void
}

/**
 * One tab. Its own component so the per-tab status hook
 * (useSessionStatusIndicator → deriveSessionStatus — the SAME single
 * derivation every status dot uses) subscribes per session.
 */
function TabRow({ tab, active, controller, onClose }: TabRowProps) {
  // Live title segments by the tab's ids — primitives, so unrelated store
  // updates (activity bumps, ui snapshots) never re-render the row.
  const scope = useProjectStore((s) => selectTitleScopeFor(s, tab.projectId))
  const sessionName = useSessionStore((s) => selectSessionNameFor(s, tab.sessionId))
  // The SessionInfo backing the dot's DB fallback (may be absent for another
  // project's session — the live chatStore flags still apply).
  const session = useSessionStore((s) =>
    tab.sessionId !== null ? (s.sessions?.find((sess) => sess.id === tab.sessionId) ?? null) : null,
  )
  const status = useSessionStatusIndicator(
    tab.sessionId,
    session?.unfinished_task_status ?? '',
    session?.archived ?? false,
  )

  const label = buildTabLabel(scope, sessionName)
  const dotClass = STATUS_DOT_CLASSES[status]
  const dotTitle = STATUS_DOT_TITLES[status]

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-tab-id={tab.id}
      title={label}
      onClick={() => void controller.activate(tab.id)}
      onMouseDown={(e) => {
        // Middle-click closes (browser-tab convention); preventDefault stops
        // the autoscroll latch.
        if (e.button === 1) {
          e.preventDefault()
          onClose(tab.id)
        }
      }}
      className={cn(
        'group/tab flex h-7 min-w-0 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
    >
      {dotClass !== undefined && (
        <span className={cn('size-1.5 shrink-0 rounded-full', dotClass)} title={dotTitle} />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        aria-label={`Close ${label}`}
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation()
          onClose(tab.id)
        }}
        // Keep the row's middle-click handler out of the close button.
        onMouseDown={(e) => e.stopPropagation()}
        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
