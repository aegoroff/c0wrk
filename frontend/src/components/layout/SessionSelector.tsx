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
import { Button } from "@/components/ui/button";
import { CollapsibleSectionHeader } from "@/components/ui/CollapsibleSectionHeader";
import { InlineRenameInput } from "@/components/ui/InlineRenameInput";
import { ChevronDown, Plus } from "lucide-react";
import { useSessionActions } from "@/hooks/useSessionActions";
import { useCollapsibleSections } from "@/hooks/useCollapsibleSections";
import { SessionItem, type SessionItemSummary } from "./SessionListItem";
import { SessionActionConfirmDialog } from "./SessionActionConfirmDialog";
import { SessionGroupedList } from "./SessionGroupedList";
import { SessionSelectorToolbar } from "./SessionSelectorToolbar";
import { ARCHIVED_SECTION_KEY, buildSessionGroups, sessionRegionId } from "@/lib/sessionGroups";

/**
 * Dropdown session selector — used in CODE mode (a real project is active).
 *
 * In CHAT (No Project) mode the sidebar renders the flat {@link SessionList}
 * instead, so this component only mounts when `isChatMode` is false. Grouped
 * mode delegates to {@link SessionGroupedList}; the Archived section renders
 * in both modes.
 */
export function SessionSelector() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  // Grouped-by-branch display mode (persisted display-only flag in uiStore).
  const sessionListGrouped = useUIStore((s) => s.sessionListGrouped);
  const setSessionListGrouped = useUIStore((s) => s.setSessionListGrouped);

  const actions = useSessionActions();

  const [search, setSearch] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // Ephemeral collapse state for the sections and branch groups; keys are the
  // stable collapse keys from lib/sessionGroups (`archived` — and in grouped
  // mode `managed` / `local` / `branch:<name>` — archived starts collapsed).
  const { toggleSection, isSectionExpanded } = useCollapsibleSections([ARCHIVED_SECTION_KEY]);

  const activeSessionsList = useMemo(() => (sessions ?? []).filter((s) => !s.archived), [sessions]);
  const archivedList = useMemo(() => (sessions ?? []).filter((s) => s.archived), [sessions]);

  // Grouping model (grouped mode only, but cheap enough to always compute):
  // classification + ordering live entirely in lib/sessionGroups; the search
  // filter there hides groups left without members.
  const groups = useMemo(() => buildSessionGroups(sessions ?? [], { search }), [sessions, search]);
  const searchActive = search.trim() !== "";
  const showSectionHeaders = groups.managed.length > 0 && groups.local.length > 0;

  // Trimmed to match `buildSessionGroups` (and the branch combo's own
  // filterFn): a whitespace-only search is "no filter", so the grouped
  // sections, the flat list and the Archived section can never disagree.
  const filterFn = useCallback(
    (name: string) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return name.toLowerCase().includes(q);
    },
    [search],
  );

  const totalCount = activeSessionsList.length + archivedList.length;
  const showSearch = totalCount >= 5;

  const visibleActive = activeSessionsList.filter((s) => filterFn(s.name));
  const visibleArchived = archivedList.filter((s) => filterFn(s.name));

  const activeSession = sessions?.find((s) => s.id === activeSessionId);

  if (actions.renamingId) {
    // The dropdown replaces itself with the rename editor (mirrors the branch
    // combo); commit/cancel come from the hook's rename state.
    return (
      <div className="px-2 py-1">
        <InlineRenameInput inputRef={actions.renameRef} value={actions.renameValue} onChange={actions.setRenameValue} onCommit={actions.commitRename} onCancel={actions.cancelRename} />
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
      onRename={() => actions.startRename(session.id, session.name)}
      onArchive={() => actions.handleArchive(session.id, session.archived)}
      onPin={() => actions.handlePin(session.id, session.pinned)}
      onFork={() => actions.handleFork(session.id)}
      onDelete={() => actions.handleDelete(session.id)}
    />
  );

  /** Branch-row "+": arm the branch draft, clear the search and close the menu. */
  const newSessionOnBranch = (branch: string) => {
    actions.handleNewSessionOnBranch(branch);
    setSearch("");
    setDropdownOpen(false);
  };

  return (
    <div className="border-b border-border px-2 py-1">
      {actions.createError && (
        <div className="mb-1 rounded px-2 py-1 text-xs text-destructive bg-destructive/10">{actions.createError}</div>
      )}
      <div className="flex items-center gap-1">
        <DropdownMenu
          open={dropdownOpen}
          onOpenChange={(o) => {
            setDropdownOpen(o);
            if (!o) setSearch("");
            if (o) actions.clearCreateError();
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" title="Switch session" className="h-7 flex-1 min-w-0 justify-between gap-1 px-2 text-sm">
              <span className="truncate text-muted-foreground">{activeSession?.name ?? "Select session"}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[28rem]">
            <SessionSelectorToolbar
              grouped={sessionListGrouped}
              onToggleGrouped={() => setSessionListGrouped(!sessionListGrouped)}
              showSearch={showSearch}
              search={search}
              onSearchChange={setSearch}
            />
            {showSearch && <DropdownMenuSeparator />}

            {sessionListGrouped ? (
              <SessionGroupedList
                groups={groups}
                searchActive={searchActive}
                showSectionHeaders={showSectionHeaders}
                isSectionExpanded={isSectionExpanded}
                toggleSection={toggleSection}
                renderSessionItem={renderSessionItem}
                onNewSessionOnBranch={newSessionOnBranch}
              />
            ) : (
              visibleActive.map((s) => renderSessionItem(s))
            )}

            {visibleArchived.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <CollapsibleSectionHeader
                  label="Archived"
                  noun="sessions"
                  count={visibleArchived.length}
                  expanded={isSectionExpanded(ARCHIVED_SECTION_KEY, searchActive)}
                  onToggle={() => toggleSection(ARCHIVED_SECTION_KEY)}
                  controlsId={sessionRegionId(ARCHIVED_SECTION_KEY)}
                />
                {isSectionExpanded(ARCHIVED_SECTION_KEY, searchActive) && (
                  <div id={sessionRegionId(ARCHIVED_SECTION_KEY)} role="presentation">
                    {visibleArchived.map((s) => renderSessionItem(s))}
                  </div>
                )}
              </>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={actions.handleNewSession}>
              <Plus className="size-3.5" />
              New Session...
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" title="New Session..." className="rounded p-0.5 hover:bg-muted/50 active:bg-muted/30" onClick={actions.handleNewSession}>
          <Plus className="size-3.5" />
        </button>
      </div>
      <SessionActionConfirmDialog
        pending={actions.pendingAction}
        onConfirm={actions.confirmPendingAction}
        onCancel={actions.cancelPendingAction}
      />
    </div>
  );
}
