import { useEffect, useId, useMemo } from 'react'
import { GitBranch, FolderTree } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useProjectStore, selectIsNoProject } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import {
  useSessionWorkspaceStore,
  selectPendingWorkspace,
  type PendingWorkspace,
} from '@/stores/sessionWorkspaceStore'
import { useChatStore } from '@/stores/chatStore'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { WorktreePreparingIndicator } from './WorktreePreparingIndicator'

/**
 * The chat toolbar's session-workspace selector (the draft-free creation
 * flow, ADR-091).
 *
 * - While the ACTIVE session is FRESH (no transcript, no running task), the
 *   selector is the interactive workspace choice: `local` (the project
 *   working tree — also the implicit default) or `branch…` — the latter
 *   opens the BranchPicker in its intent-separated pick mode, where
 *   selecting an existing branch or creating a new one RECORDS the pending
 *   choice; provisioning happens at the session's FIRST send (SendMessage's
 *   workspace argument), never as an in-place checkout.
 * - Once a session has a transcript (or a running task), the workspace is
 *   locked forever: the selector shows the session's pinned workspace as a
 *   permanently disabled CHIP. The disabled state must state itself (dimmed,
 *   cursor-not-allowed) instead of an enabled-looking control that silently
 *   swallows clicks, but it renders as `aria-disabled="true"` rather than
 *   the native `disabled` attribute (see the accessibility note at the
 *   render site: a natively disabled control leaves the tab order — its
 *   reason text becomes unreachable — and suppresses pointer events, which
 *   breaks the tooltip in the WebKit webview). The pin is unconditional: it
 *   deliberately ignores the transient `disabled` prop (the mid-task
 *   selector lock) — that lock lifts when the task settles, while the pin
 *   never does, so the chip stays disabled across chat continuations for
 *   the session's whole lifetime.
 *
 * The whole picker/display is a first-class surface: it renders regardless
 * of the master experimental switch (`experimental.enabled` — which gates
 * the E2S execution mode, the embedded model's frontend surfaces, and the
 * Session Statistics settings block, none of them this control). Only the
 * ordinary visibility conditions below apply.
 *
 * Hidden entirely in CHAT (No Project) mode and while no project is active.
 */
export function SessionWorkspaceSelector({ disabled = false }: { disabled?: boolean }) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const isNoProject = useProjectStore(selectIsNoProject)
  // The pending workspace choice of the ACTIVE session (a stable store
  // reference — undefined when the implicit local default applies).
  const pendingChoice = useSessionWorkspaceStore((s) =>
    activeSessionId !== null ? selectPendingWorkspace(s, activeSessionId) : undefined,
  )
  // Paired per the store contract: a stale repo answer from a previously
  // active project must never show the `branch…` entry here.
  const isGitRepo = useGitPanelStore(
    (s) => s.isGitRepo && s.gitRepoProjectId === activeProjectId,
  )
  // Freshness: the transcript must be CONFIRMED empty. An absent message
  // index means the history has not loaded yet — an unknown state, treated
  // as not fresh (the session's pinned binding is the safe display). A
  // running task locks the workspace immediately, transcript or not.
  const messageIndex = useChatStore((s) =>
    activeSessionId !== null ? s.messages[activeSessionId] : undefined,
  )
  const taskActive = useChatStore((s) =>
    activeSessionId !== null ? (s.taskActive[activeSessionId] ?? false) : false,
  )
  const isFresh = useMemo(() => {
    if (activeSessionId === null || messageIndex === undefined || taskActive) return false
    // CONFIRMED empty — or carrying only frontend send-failure cards. A
    // rejected first send leaves exactly that transcript: the send-path
    // catch rolls the optimistic user message back and adds the failure
    // card, while the backend refused the bind before persisting anything
    // (the fresh window is still open — no rows, no task). Such a
    // transcript must keep the picker armed: the pin branch's "fixed when
    // the session was created" would be factually false, and the user's
    // re-armed choice would be locked away. Real transcript rows
    // (user/assistant/…) always make it not-fresh — the window is closed
    // by then.
    //
    // The history-load-failure card is explicitly EXCLUDED from this
    // equivalence: ChatArea stamps it with `historyLoadFailed` because it
    // can be the ONLY visible entry of a session whose persisted rows
    // simply failed to load — treating it as "confirmed empty" would arm
    // the picker on a session that is not fresh (the backend would refuse
    // the bind). Unknown error shapes also stay conservative: only the
    // send-path's bare cards (no metadata) count as fresh-window signals.
    const entries = Object.values(messageIndex)
    return entries.every(
      (m) => m.type === 'error' && m.metadata?.historyLoadFailed !== true,
    )
  }, [activeSessionId, messageIndex, taskActive])
  // The DESTRUCTIVE counterpart of isFresh, used only by the stale-choice
  // cleanup below: it may fire on PROOF that the fresh window is closed —
  // a real transcript row (anything but an error card) or a persisted
  // managed binding in the session row. Error cards never prove closure (a
  // bare card is the failed-first-send transcript whose window is still
  // open; a history-load-failure card can be the ONLY visible entry of a
  // session that never sent anything), so a transient load failure must
  // never trigger the drop — the conservative direction for a deleting
  // operation. When in doubt the pending choice stays: the backend's typed
  // not-fresh refusal and the send's own success/failure teardown close
  // any residue.
  const windowClosed = useMemo(() => {
    if (messageIndex !== undefined && Object.values(messageIndex).some((m) => m.type !== 'error')) {
      return true
    }
    const activeSession = activeSessionId !== null
      ? sessions?.find((s) => s.id === activeSessionId) ?? null
      : null
    return activeSession?.workspace_binding?.kind === 'managed_worktree'
  }, [activeSessionId, messageIndex, sessions])
  // While the send carrying this session's workspace choice is on the wire
  // (backend provisioning a full checkout can take a while), the spinner
  // says why nothing seems to happen. Declared unconditionally with the
  // other hooks (early returns
  // below must never change the hook count).
  const preparingWorktree = useSessionWorkspaceStore(
    (s) => activeSessionId !== null && s.consumingFor === activeSessionId,
  )
  // Accessible-description target for the pinned-workspace chip's reason
  // (see the aria-describedby note below). Declared before the early returns.
  const reasonId = useId()

  // A pending choice must never outlive its fresh window: the first message
  // locks the workspace (the send consumed or refused the choice), so a
  // choice that is still pending once the window is PROVABLY closed (see
  // windowClosed above) is a stale leftover (e.g. the send failed elsewhere)
  // — drop it. EXCEPT while this session's own send is consuming the choice
  // (the consumption window): the pending entry is the in-flight send's
  // payload, not a leftover, and the success teardown clears it explicitly.
  // Unknown transcript states (history not loaded / load failed) keep the
  // choice — dropping on an unproven window would let a transient load
  // failure destroy the user's pick. Runs even when the selector itself
  // renders nothing (CHAT mode / no project), because the hooks above are
  // unconditional.
  useEffect(() => {
    if (activeSessionId === null || !windowClosed || pendingChoice === undefined) return
    if (preparingWorktree) return
    useSessionWorkspaceStore.getState().clearChoice(activeSessionId)
  }, [activeSessionId, windowClosed, pendingChoice, preparingWorktree])

  if (activeProjectId === null || isNoProject) return null

  // The consumption window (the send carrying the choice is on the wire):
  // show the spinner and the CHOSEN branch instead of the pin chip with the
  // stale pre-send binding — provisioning a full checkout takes a while, and
  // asserting "local" for its whole duration would show the opposite of what
  // is actually happening. The live pending choice is still set here (the
  // cleanup effect above leaves it alone for the window; the success teardown
  // clears it).
  if (preparingWorktree) {
    const preparingLabel = pendingChoice?.kind === 'branch' ? pendingChoice.branch : 'local'
    return (
      <span
        data-testid="session-workspace-preparing"
        className="flex items-center gap-1 max-w-[220px]"
      >
        <WorktreePreparingIndicator />
        <span className="truncate text-xs text-muted-foreground">{preparingLabel}</span>
      </span>
    )
  }

  // An existing (non-fresh) session pins its workspace: the binding is
  // immutable past the fresh window (ADR-091), so choosing another
  // branch/workspace is impossible — forever, chat continuations included.
  // The pin renders as a PERMANENTLY DISABLED button rather than an
  // enabled-looking non-interactive element: the disabled state must be
  // visible up front, not discovered by clicks that go nowhere. It
  // deliberately ignores the transient `disabled` prop (the mid-task
  // selector lock) — that lock lifts when the task settles; the pin never
  // does. While the session list has not loaded the entry yet (transient
  // switch window), render nothing rather than guess the binding.
  //
  // Accessibility: the chip uses `aria-disabled="true"` instead of the
  // native `disabled` attribute — a natively disabled control is removed
  // from the tab order (its reason text unreachable by keyboard/screen-
  // reader) and suppresses pointer events, which makes both the `title`
  // tooltip and the not-allowed cursor unreliable in the WebKit webview.
  // The pin reason travels in a visually-hidden element referenced by
  // `aria-describedby` (announced with the chip) and the `title` stays as
  // the mouse tooltip.
  if (!isFresh) {
    const activeSession = activeSessionId !== null
      ? sessions?.find((s) => s.id === activeSessionId) ?? null
      : null
    if (!activeSession) return null
    const binding = activeSession.workspace_binding
    const isManaged = binding?.kind === 'managed_worktree'
    const label = isManaged ? binding?.branch || 'branch' : 'local'
    const pinReason = isManaged
      ? `Managed worktree on ${label} — fixed when the session was created`
      : 'Project working tree — fixed when the session was created'
    return (
      <button
        type="button"
        aria-disabled="true"
        data-testid="session-workspace-readonly"
        aria-label={`Session workspace: ${label}`}
        aria-describedby={reasonId}
        title={pinReason}
        className={cn(
          'flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-input bg-background',
          'text-muted-foreground max-w-[200px] truncate',
          'opacity-50 cursor-not-allowed',
        )}
      >
        {isManaged ? (
          <GitBranch className="size-3 shrink-0" />
        ) : (
          <FolderTree className="size-3 shrink-0" />
        )}
        <span className="truncate">{label}</span>
        <span id={reasonId} className="sr-only">
          {pinReason}
        </span>
      </button>
    )
  }

  // Fresh-session mode: the selector picks the workspace the session's
  // FIRST send will bind. An absent choice means the implicit local default.
  const workspace: PendingWorkspace = pendingChoice ?? { kind: 'local' as const }
  const draftLabel = workspace.kind === 'branch' ? workspace.branch : 'local'
  const locked = disabled

  // Record the local choice: it clears any pending branch pick (the local
  // default is also expressible as "no entry", so both shapes agree).
  const chooseLocal = () => {
    if (activeSessionId === null) return
    useSessionWorkspaceStore.getState().setChoice(activeSessionId, { kind: 'local' })
  }

  const openWorkspaceBranchPicker = () => {
    if (activeSessionId === null) return
    // The pick targets the ACTIVE fresh session (the toolbar belongs to it).
    useGitPanelStore.getState().openBranchPicker('draft')
  }

  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={locked}>
          <button
            type="button"
            disabled={locked}
            aria-label="Session workspace"
            data-testid="session-workspace-selector"
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-input bg-background',
              'hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors',
              'max-w-[200px] truncate disabled:opacity-50 disabled:cursor-not-allowed',
            )}
            title={
              workspace.kind === 'branch'
                ? `First message will provision a managed worktree on branch ${workspace.branch}`
                : 'Session runs in the project working tree'
            }
          >
            {workspace.kind === 'branch' ? (
              <GitBranch className="size-3 shrink-0" />
            ) : (
              <FolderTree className="size-3 shrink-0" />
            )}
            <span className="truncate">{draftLabel}</span>
            <svg className="size-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent aria-label="Session workspace" align="start" className="min-w-56">
          <DropdownMenuItem
            data-testid="workspace-option-local"
            onSelect={chooseLocal}
            aria-current={workspace.kind === 'local' ? 'true' : undefined}
          >
            <FolderTree className="size-3.5" />
            <span className="flex-1">local</span>
            <span className="text-xs text-muted-foreground">project working tree</span>
          </DropdownMenuItem>
          {isGitRepo && (
            <DropdownMenuItem data-testid="workspace-option-branch" onSelect={openWorkspaceBranchPicker}>
              <GitBranch className="size-3.5" />
              <span className="flex-1">branch…</span>
              <span className="text-xs text-muted-foreground">managed worktree</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
