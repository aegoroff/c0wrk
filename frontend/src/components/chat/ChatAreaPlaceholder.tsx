import { Loader2, MessageCircle } from 'lucide-react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ExecutionPanels } from './ExecutionPanels'
import { BlackboardPanel } from './BlackboardPanel'
import { ArchivedBanner } from './ArchivedBanner'
import { ChatInput } from './ChatInput'
import type { InputMode } from '@/stores/inputModeStore'

// ChatArea's two placeholder branches (no active session, and an
// empty-but-loading session) share this shell: a centered icon, the side
// panels, and the input area. The spinner replaces the empty-session icon
// while the persisted-history load is in flight, so a cold start and a
// session switch A→B don't flash the "empty session" placeholder. The
// marker settles on BOTH resolve and reject (loader's finally), so a failed
// load stops the spin and the error card explains the empty chat; a resync
// re-run never reaches this branch while content is on screen. A session
// without content renders its panels and the (archive-aware) input shell;
// a sessionless area renders only the bare input.
export function ChatAreaPlaceholder({ sessionId, historyInFlight, inputMode, isArchived }: {
  sessionId: string | null
  historyInFlight: boolean
  inputMode: InputMode
  isArchived: boolean
}) {
  const icon = historyInFlight
    ? <Loader2 className="size-8 animate-spin opacity-30" aria-label="Loading session history" />
    : <MessageCircle className="h-12 w-12 opacity-20" />

  if (!sessionId) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="flex flex-col items-center gap-3">
            {icon}
          </div>
        </div>
        <ChatInput />
      </div>
    )
  }

  // Archived sessions are read-only: swap the input shell for an "Archived"
  // banner. Hoisted into a single const so the archived gate lives in one
  // place.
  const inputShell = isArchived ? <ArchivedBanner sessionId={sessionId} /> : <ChatInput />

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          {icon}
        </div>
      </div>
      <ErrorBoundary fallback={<div className="text-xs text-destructive p-2">Panel error</div>}>
        <ExecutionPanels />
        <BlackboardPanel />
      </ErrorBoundary>
      <ErrorBoundary
        resetKeys={[sessionId, inputMode, isArchived]}
        fallback={<div className="text-xs text-destructive p-2">Input error</div>}
      >
        {inputShell}
      </ErrorBoundary>
    </div>
  )
}
