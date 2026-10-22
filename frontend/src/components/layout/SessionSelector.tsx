import { Fragment, useState, useMemo, useCallback, useEffect } from "react";
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
import {
  ArchiveRestore,
  ChevronDown,
  Plus,
  Trash2,
} from "lucide-react";
import { useSessionActions } from "@/hooks/useSessionActions";
import { useCollapsibleSections } from "@/hooks/useCollapsibleSections";
import { SessionItem, type SessionItemSummary } from "./SessionListItem";
import { SessionActionConfirmDialog } from "./SessionActionConfirmDialog";
import { SessionGroupedList } from "./SessionGroupedList";
import { BranchRow, PinGroupAction, branchActionItemClasses } from "./BranchRow";
import { SessionSelectorToolbar } from "./SessionSelectorToolbar";
import { ARCHIVED_SECTION_KEY, buildSessionGroups, freshestSession, sessionRegionId } from "@/lib/sessionGroups";
import { useProjectStore } from "@/stores/projectStore";
import { useGroupPins, usePinnedGroupsStore } from "@/stores/pinnedGroupsStore";

/** Collapse key of an archived branch group — namespaced under `archived:`
 *  so it can never collide with the live `branch:<name>` key of the same
 *  branch (a branch may hold both live and archived sessions). */
function archivedBranchKey(branch: string): string {
  return `archived:${branch}`;
}

/**
 * Dropdown session selector — used in CODE mode (a real project is active).
 *
 * In CHAT (No Project) mode the sidebar renders the flat {@link SessionList}
 * instead, so this component only mounts when `isChatMode` is false. The
 * `sessionListGrouped` display mode drives BOTH the live list and the Archived
 * section: grouped mode delegates to {@link SessionGroupedList} and renders
 * the Archived section as collapsible branch rows with their own action
 * overlay (Pin/Unpin, Unarchive all, Delete all) plus flat archived local
 * sessions; flat mode renders every session — active and archived — as a
 * plain row (no branch groups, per-session actions only).
 */
export function SessionSelector() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  // Grouped-by-branch display mode (persisted display-only flag in uiStore).
  const sessionListGrouped = useUIStore((s) => s.sessionListGrouped);
  const setSessionListGrouped = useUIStore((s) => s.setSessionListGrouped);

  const actions = useSessionActions();
  // The GROUP-level pin (persisted in pinnedGroupsStore, keyed by the active
  // project): a pinned branch group floats above the unpinned ones — in the
  // Worktrees section AND the Archived section (the same branch name is the
  // pin key in both).
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const { pinnedBranches, togglePinnedBranch } = useGroupPins(activeProjectId);

  const [search, setSearch] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // Ephemeral collapse state for the sections and branch groups; keys are the
  // stable collapse keys from lib/sessionGroups (`archived` — and in grouped
  // mode `managed` / `local` / `branch:<name>`; archived branch groups use
  // the local `archived:<name>` keys — the archived SECTION starts collapsed).
  const { toggleSection, isSectionExpanded } = useCollapsibleSections([ARCHIVED_SECTION_KEY]);

  const activeSessionsList = useMemo(() => (sessions ?? []).filter((s) => !s.archived), [sessions]);

  // Grouping model (grouped mode only, but cheap enough to always compute):
  // classification + ordering live entirely in lib/sessionGroups; the search
  // filter there hides groups left without members. The GROUPED Archived
  // section renders from it too (and the Archived header count uses it in
  // both modes); flat mode renders archived rows from `visibleArchived`.
  const groups = useMemo(
    () => buildSessionGroups(sessions ?? [], { search, pinnedBranches }),
    [sessions, search, pinnedBranches],
  );
  // The UNFILTERED grouping (no search) — group actions act on the WHOLE
  // branch even while a search narrows the visible rows, so the confirmation
  // dialog counts the branch's full membership.
  const allGroups = useMemo(() => buildSessionGroups(sessions ?? []), [sessions]);
  const fullBranchIds = useCallback(
    (branch: string) =>
      allGroups.worktrees.find((g) => g.branch === branch)?.sessions.map((s) => s.id) ?? [],
    [allGroups],
  );

  // Stale-pin hygiene (pinnedGroupsStore): a branch whose last session was
  // deleted keeps its group pin forever otherwise — drop pins with no live or
  // archived group in the UNFILTERED model (a search only hides groups
  // temporarily). Gated on a LOADED list: `sessions === null` means the
  // switch/reset transient, and pruning against an empty model then would
  // wipe the destination project's pins.
  const prunePins = usePinnedGroupsStore((s) => s.prunePins);
  const livePinBranches = useMemo(
    () => [...allGroups.worktrees, ...allGroups.archivedWorktrees].map((g) => g.branch),
    [allGroups],
  );
  useEffect(() => {
    if (sessions !== null && activeProjectId !== null) prunePins(activeProjectId, livePinBranches);
  }, [sessions, activeProjectId, livePinBranches, prunePins]);

  const searchActive = search.trim() !== "";
  const showSectionHeaders = groups.worktrees.length > 0 && groups.local.length > 0;

  // Archived section content: managed branch groups + flat local sessions,
  // search already applied (so header count and rows can never disagree).
  const archivedCount =
    groups.archivedWorktrees.reduce((n, g) => n + g.sessions.length, 0) + groups.archivedLocal.length;

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

  // Unfiltered total — `showSearch` must NOT shrink while a search is
  // narrowing the list (the input would unmount mid-search).
  const showSearch = (sessions ?? []).length >= 5;

  const visibleActive = activeSessionsList.filter((s) => filterFn(s.name));

  // Flat-mode Archived rows: the SAME canonical order + search rule as
  // `visibleActive` (store order — per-session pins first, then freshness).
  // Grouped mode instead renders the Archived section from the grouping
  // model above, so branch groups appear only while the toggle is on.
  const archivedSessionsList = useMemo(() => (sessions ?? []).filter((s) => s.archived), [sessions]);
  const visibleArchived = archivedSessionsList.filter((s) => filterFn(s.name));

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
                fullBranchIds={fullBranchIds}
                onArchiveGroup={actions.handleArchiveGroup}
                onDeleteGroup={actions.handleDeleteGroup}
              />
            ) : (
              visibleActive.map((s) => renderSessionItem(s))
            )}

            {archivedCount > 0 && (
              <>
                <DropdownMenuSeparator />
                <CollapsibleSectionHeader
                  label="Archived"
                  noun="sessions"
                  count={archivedCount}
                  expanded={isSectionExpanded(ARCHIVED_SECTION_KEY, searchActive)}
                  onToggle={() => toggleSection(ARCHIVED_SECTION_KEY)}
                  controlsId={sessionRegionId(ARCHIVED_SECTION_KEY)}
                />
                {isSectionExpanded(ARCHIVED_SECTION_KEY, searchActive) && (
                  <div id={sessionRegionId(ARCHIVED_SECTION_KEY)} role="presentation">
                    {sessionListGrouped ? (
                      <>
                        {groups.archivedWorktrees.map((group) => {
                          const key = archivedBranchKey(group.branch);
                          const expanded = isSectionExpanded(key, searchActive);
                          // Full (unfiltered) membership — same rule as the live
                          // rows: the group acts on the whole branch, and the
                          // plural confirmation copy counts exactly these ids.
                          const ids =
                            allGroups.archivedWorktrees.find((g) => g.branch === group.branch)?.sessions.map(
                              (s) => s.id,
                            ) ?? [];
                          const groupPinned = pinnedBranches.includes(group.branch);
                          return (
                            <Fragment key={key}>
                              <BranchRow
                                variant="archived"
                                branch={group.branch}
                                expanded={expanded}
                                pinned={groupPinned}
                                regionId={sessionRegionId(key)}
                                onToggle={() => toggleSection(key)}
                                freshest={freshestSession(group.sessions)}
                                actionItems={
                                  <>
                                    <PinGroupAction
                                      branch={group.branch}
                                      pinned={groupPinned}
                                      onToggle={() => togglePinnedBranch(group.branch)}
                                    />
                                    <DropdownMenuItem
                                      title={`Restore sessions (${group.branch})`}
                                      className={branchActionItemClasses}
                                      onSelect={() => void actions.handleUnarchiveGroup(group.branch, ids)}
                                    >
                                      <ArchiveRestore className="size-3 text-warning" />
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      title={`Delete sessions (${group.branch})`}
                                      className={branchActionItemClasses}
                                      onSelect={() => actions.handleDeleteGroup(group.branch, ids)}
                                    >
                                      <Trash2 className="size-3 text-destructive" />
                                    </DropdownMenuItem>
                                  </>
                                }
                              />
                              {expanded && (
                                <div id={sessionRegionId(key)} role="presentation">
                                  {group.sessions.map((s) => renderSessionItem(s, { indented: true }))}
                                </div>
                              )}
                            </Fragment>
                          );
                        })}
                        {groups.archivedLocal.map((s) => renderSessionItem(s))}
                      </>
                    ) : (
                      // Flat mode: no branch groups — every archived session is a
                      // plain row (store order, search-filtered), per-session
                      // actions only, exactly like the flat live list above.
                      visibleArchived.map((s) => renderSessionItem(s))
                    )}
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
