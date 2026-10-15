import { useState, useMemo, useCallback } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { useUIStore } from "@/stores/uiStore";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  List,
  Plus,
} from "lucide-react";
import { useSessionActions } from "@/hooks/useSessionActions";
import { SessionItem, type SessionItemSummary } from "./SessionListItem";
import { SessionActionConfirmDialog } from "./SessionActionConfirmDialog";
import { branchGroupKey, buildSessionGroups } from "@/lib/sessionGroups";

/**
 * Dropdown session selector — used in CODE mode (a real project is active).
 *
 * In CHAT (No Project) mode the sidebar renders the flat {@link SessionList}
 * instead, so this component only mounts when `isChatMode` is false.
 */
export function SessionSelector() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  // Grouped-by-branch display mode (persisted display-only flag in uiStore).
  const sessionListGrouped = useUIStore((s) => s.sessionListGrouped);
  const setSessionListGrouped = useUIStore((s) => s.setSessionListGrouped);

  const {
    createError,
    clearCreateError,
    renamingId,
    renameValue,
    setRenameValue,
    renameRef,
    startRename,
    commitRename,
    cancelRename,
    handleNewSession,
    handleDelete,
    handleArchive,
    handlePin,
    handleFork,
    pendingAction,
    confirmPendingAction,
    cancelPendingAction,
  } = useSessionActions();

  const [search, setSearch] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // Archived sessions are collapsed by default; the header shows the count and
  // expands on click.
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);
  // Collapsed managed-branch groups (grouped mode). Ephemeral by design — the
  // expand/collapse state lives only for this component's lifetime and resets
  // on remount; keys are the stable `branch:<name>` collapse keys from
  // lib/sessionGroups.
  const [collapsedBranches, setCollapsedBranches] = useState<ReadonlySet<string>>(new Set());

  const activeSessionsList = useMemo(() => (sessions ?? []).filter((s) => !s.archived), [sessions]);
  const archivedList = useMemo(() => (sessions ?? []).filter((s) => s.archived), [sessions]);

  // Grouping model (grouped mode only, but cheap enough to always compute):
  // classification + ordering live entirely in lib/sessionGroups; the search
  // filter there hides groups left without members.
  const groups = useMemo(() => buildSessionGroups(sessions ?? [], { search }), [sessions, search]);
  const searchActive = search.trim() !== "";
  // Managed/Local section headers only render when BOTH sections are
  // non-empty — a lone Local section IS the current flat view, and a lone
  // Managed section speaks for itself through its branch rows.
  const showSectionHeaders = groups.managed.length > 0 && groups.local.length > 0;

  const toggleBranchGroup = useCallback((key: string) => {
    setCollapsedBranches((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const totalCount = activeSessionsList.length + archivedList.length;
  const showSearch = totalCount >= 5;

  const filterFn = useCallback(
    (name: string) => {
      if (!search) return true;
      return name.toLowerCase().includes(search.toLowerCase());
    },
    [search],
  );

  const activeSession = sessions?.find((s) => s.id === activeSessionId);

  if (renamingId) {
    return (
      <div className="px-2 py-1">
        <Input
          ref={renameRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") cancelRename();
          }}
          onBlur={commitRename}
          className="h-7 text-sm"
        />
      </div>
    );
  }

  const renderSessionItem = (session: SessionItemSummary, opts?: { indented?: boolean }) => (
    <SessionItem
      key={session.id}
      session={session}
      isActive={session.id === activeSessionId}
      indented={opts?.indented}
      onSelect={() => {
        selectSession(session.id, session.project_id);
        setDropdownOpen(false);
      }}
      onRename={() => startRename(session.id, session.name)}
      onArchive={() => handleArchive(session.id, session.archived)}
      onPin={() => handlePin(session.id, session.pinned)}
      onFork={() => handleFork(session.id)}
      onDelete={() => handleDelete(session.id)}
    />
  );

  const visibleActive = activeSessionsList.filter((s) => filterFn(s.name));
  const visibleArchived = archivedList.filter((s) => filterFn(s.name));

  /**
   * Grouped mode: Managed branch groups (each a GitBranch header row that
   * collapses/expands its member sessions) then the Local section. The
   * headers themselves render only when both sections are non-empty (see
   * {@link showSectionHeaders}); an active search force-expands every group
   * so matches inside a collapsed group stay reachable.
   */
  const renderGroupedList = () => (
    <>
      {showSectionHeaders && (
        <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Managed</div>
      )}
      {groups.managed.map((group) => {
        const key = branchGroupKey(group.branch);
        const expanded = searchActive || !collapsedBranches.has(key);
        return (
          <div key={key}>
            <button
              type="button"
              title={expanded ? "Hide branch sessions" : "Show branch sessions"}
              className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-sm hover:bg-muted/50"
              onClick={() => toggleBranchGroup(key)}
            >
              {expanded ? (
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              )}
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{group.branch}</span>
            </button>
            {expanded && group.sessions.map((s) => renderSessionItem(s, { indented: true }))}
          </div>
        );
      })}
      {showSectionHeaders && (
        <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Local</div>
      )}
      {groups.local.map((s) => renderSessionItem(s))}
    </>
  );

  return (
    <div className="border-b border-border px-2 py-1">
      {createError && (
        <div className="mb-1 rounded px-2 py-1 text-xs text-destructive bg-destructive/10">{createError}</div>
      )}
      <div className="flex items-center gap-1">
        <DropdownMenu
          open={dropdownOpen}
          onOpenChange={(o) => {
            setDropdownOpen(o);
            if (!o) setSearch("");
            if (o) clearCreateError();
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" title="Switch session" className="h-7 flex-1 min-w-0 justify-between gap-1 px-2 text-sm">
              <span className="truncate text-muted-foreground">{activeSession?.name ?? "Select session"}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-96">
            {/* Grouped-by-branch mode toggle. A plain button on purpose (not a
                DropdownMenuItem): flipping the display mode must not dismiss
                the menu. The icon shows the mode you switch TO. */}
            <div className="flex items-center justify-end px-1 pb-0.5">
              <button
                type="button"
                title={sessionListGrouped ? "Show flat list" : "Group sessions by branch"}
                className="rounded p-1 text-muted-foreground hover:bg-muted/50"
                onClick={() => setSessionListGrouped(!sessionListGrouped)}
              >
                {sessionListGrouped ? <List className="size-3.5" /> : <GitBranch className="size-3.5" />}
              </button>
            </div>
            {showSearch && (
              <>
                <div className="px-2 py-1">
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search sessions..."
                    className="h-7 text-sm"
                    autoFocus
                  />
                </div>
                <DropdownMenuSeparator />
              </>
            )}

            {sessionListGrouped ? renderGroupedList() : visibleActive.map((s) => renderSessionItem(s))}

            {visibleArchived.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <button
                  type="button"
                  title={archivedCollapsed ? 'Show archived' : 'Hide archived'}
                  className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50"
                  onClick={() => setArchivedCollapsed((c) => !c)}
                >
                  {archivedCollapsed ? (
                    <ChevronRight className="size-3" />
                  ) : (
                    <ChevronDown className="size-3" />
                  )}
                  Archived ({visibleArchived.length})
                </button>
                {!archivedCollapsed && visibleArchived.map((s) => renderSessionItem(s))}
              </>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleNewSession}>
              <Plus className="size-3.5" />
              New Session...
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" title="New Session..." className="rounded p-0.5 hover:bg-muted/50 active:bg-muted/30" onClick={handleNewSession}>
          <Plus className="size-3.5" />
        </button>
      </div>
      <SessionActionConfirmDialog pending={pendingAction} onConfirm={confirmPendingAction} onCancel={cancelPendingAction} />
    </div>
  );
}
