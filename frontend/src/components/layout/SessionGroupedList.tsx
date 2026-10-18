import { Fragment, useMemo, type ReactNode } from "react";
import { Archive, Plus, Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { CollapsibleSectionHeader } from "@/components/ui/CollapsibleSectionHeader";
import { BranchRow, PinGroupAction, branchActionItemClasses } from "./BranchRow";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { useActiveSessionsStore } from "@/stores/activeSessionsStore";
import { useProjectStore } from "@/stores/projectStore";
import { useGroupPins } from "@/stores/pinnedGroupsStore";
import {
  SESSION_DOT_CLASSES,
  SESSION_DOT_TITLES,
  aggregateBadgeFlags,
  deriveLiveSessionFlags,
  mergePendingOverride,
  type LiveSessionFlags,
} from "@/lib/activeSessions";
import {
  LOCAL_SECTION_KEY,
  MANAGED_SECTION_KEY,
  branchGroupKey,
  freshestSession,
  sessionRegionId,
  type SessionGroups,
} from "@/lib/sessionGroups";
import type { SessionInfo } from "@/types/models";
import type { SessionItemSummary } from "./SessionListItem";

interface SessionGroupedListProps {
  /** Grouping model from `buildSessionGroups` (search already applied). */
  groups: SessionGroups;
  /** An active search force-expands every section and branch group. */
  searchActive: boolean;
  /** Worktrees/Local headers render only while BOTH sections are non-empty —
   *  a lone Local section IS the current flat view, and a lone Worktrees
   *  section speaks for itself through its branch rows. A hidden header's
   *  content renders unconditionally; the hairline separator belongs to the
   *  headers and disappears with them. */
  showSectionHeaders: boolean;
  isSectionExpanded: (key: string, forceExpand?: boolean) => boolean;
  toggleSection: (key: string) => void;
  renderSessionItem: (session: SessionItemSummary, opts?: { indented?: boolean }) => ReactNode;
  /** Arms the ADR-080 branch draft AND closes the menu (clearing the search). */
  onNewSessionOnBranch: (branch: string) => void;
  /**
   * Unfiltered member ids of a LIVE branch group — group actions act on the
   * WHOLE branch even while a search narrows the visible rows, so the
   * confirmation dialog counts the full membership.
   */
  fullBranchIds: (branch: string) => string[];
  /** Archive every member of the group (arms confirmation for any
   *  multi-member group, or a busy lone member). */
  onArchiveGroup: (branch: string, ids: string[]) => void;
  /** Delete every member of the group (always arms confirmation). */
  onDeleteGroup: (branch: string, ids: string[]) => void;
}

/** Badge flag → session status — indexed in the radar's own precedence order:
 *  the FIRST true flag wins the dot (red failure → yellow attention → green
 *  running → gray paused), the same colors + wording every status surface
 *  paints (lib/activeSessions). */
const DOT_FLAG_STATUS = {
  error: "failed",
  attention: "pending",
  active: "active",
  paused: "paused",
} as const;

/** The per-session live flags the branch dots aggregate — derived ONCE per
 *  list render instead of once per branch row: one set of chatStore slices +
 *  the pending-HITL override fold into a single flags map (the radar's exact
 *  chain, lib/activeSessions), which every `BranchActivityDot` below then
 *  narrows to its own members. A message-level event re-derives the map once
 *  for the whole list, not B times. */
function useLiveSessionFlags(): Readonly<Record<string, LiveSessionFlags>> {
  const taskActive = useChatStore((s) => s.taskActive);
  const paused = useChatStore((s) => s.paused);
  const messageOrder = useChatStore((s) => s.messageOrder);
  const messages = useChatStore((s) => s.messages);
  const unfinishedTaskStatus = useChatStore((s) => s.unfinishedTaskStatus);
  const pendingOverride = useActiveSessionsStore((s) => s.pendingOverride);
  return useMemo(
    () =>
      mergePendingOverride(
        deriveLiveSessionFlags({ taskActive, paused, messageOrder, messages, unfinishedTaskStatus }),
        pendingOverride,
      ),
    [taskActive, paused, messageOrder, messages, unfinishedTaskStatus, pendingOverride],
  );
}

/** The branch row's radar-style activity dot — ONE dot summarizing the live
 *  status of the group's members, so a COLLAPSED group with a live session
 *  stays visible. Narrows the list-level flags map ({@link useLiveSessionFlags})
 *  to the group's members via `aggregateBadgeFlags`, and the most urgent flag
 *  picks the shared dot color + wording. A group whose members are all idle
 *  renders nothing. */
function BranchActivityDot({
  sessions,
  flags,
}: {
  sessions: readonly SessionInfo[];
  flags: Readonly<Record<string, LiveSessionFlags>>;
}) {
  const dot = useMemo(() => {
    const badge = aggregateBadgeFlags(sessions, flags);
    for (const flag of ["error", "attention", "active", "paused"] as const) {
      if (badge[flag]) {
        const status = DOT_FLAG_STATUS[flag];
        return { className: SESSION_DOT_CLASSES[status], title: SESSION_DOT_TITLES[status] };
      }
    }
    return null;
  }, [sessions, flags]);

  if (!dot) return null;
  return <span className={cn("size-1.5 shrink-0 rounded-full", dot.className)} title={dot.title} />;
}

/**
 * Grouped mode of the session selector: the collapsible Worktrees section
 * (branch group rows, each collapsing its member sessions) then the
 * collapsible Local section, separated by the branch combo's hairline. The
 * component renders a FRAGMENT so the headers, the separator and the section
 * regions stay direct children of the surrounding `DropdownMenuContent`
 * (Radix role="menu"); every section's rows sit inside a semantic-neutral
 * region div (role="presentation") that carries the disclosure target id.
 */
export function SessionGroupedList({
  groups,
  searchActive,
  showSectionHeaders,
  isSectionExpanded,
  toggleSection,
  renderSessionItem,
  onNewSessionOnBranch,
  fullBranchIds,
  onArchiveGroup,
  onDeleteGroup,
}: SessionGroupedListProps) {
  // The GROUP-level pin (pinnedGroupsStore, keyed by project): a pinned
  // branch floats above the unpinned groups of the section (lib/sessionGroups
  // ordering) — member sessions keep their own per-session pins untouched.
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const { pinnedBranches, togglePinnedBranch } = useGroupPins(activeProjectId);
  // ONE derivation per list render feeds every branch row's activity dot.
  const liveFlags = useLiveSessionFlags();
  return (
    <>
      {showSectionHeaders && (
        <CollapsibleSectionHeader
          label="Worktrees"
          noun="sessions"
          expanded={isSectionExpanded(MANAGED_SECTION_KEY, searchActive)}
          onToggle={() => toggleSection(MANAGED_SECTION_KEY)}
          controlsId={sessionRegionId(MANAGED_SECTION_KEY)}
        />
      )}
      {(!showSectionHeaders || isSectionExpanded(MANAGED_SECTION_KEY, searchActive)) && (
        <div id={sessionRegionId(MANAGED_SECTION_KEY)} role="presentation">
          {groups.worktrees.map((group) => {
            const key = branchGroupKey(group.branch);
            const expanded = isSectionExpanded(key, searchActive);
            const groupPinned = pinnedBranches.includes(group.branch);
            return (
              <Fragment key={key}>
                <BranchRow
                  branch={group.branch}
                  expanded={expanded}
                  pinned={groupPinned}
                  regionId={sessionRegionId(key)}
                  onToggle={() => toggleSection(key)}
                  freshest={freshestSession(group.sessions)}
                  activityDot={<BranchActivityDot sessions={group.sessions} flags={liveFlags} />}
                  actionItems={
                    <>
                      <DropdownMenuItem
                        title={`New session in this worktree (${group.branch})`}
                        className={branchActionItemClasses}
                        // No preventDefault — Radix's default close is exactly
                        // what the draft-arming "+" gesture wants.
                        onSelect={() => onNewSessionOnBranch(group.branch)}
                      >
                        <Plus className="size-3.5" />
                      </DropdownMenuItem>
                      <PinGroupAction
                        branch={group.branch}
                        pinned={groupPinned}
                        onToggle={() => togglePinnedBranch(group.branch)}
                      />
                      <DropdownMenuItem
                        title={`Archive sessions (${group.branch})`}
                        className={branchActionItemClasses}
                        onSelect={() => onArchiveGroup(group.branch, fullBranchIds(group.branch))}
                      >
                        <Archive className="size-3 text-warning" />
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        title={`Delete sessions (${group.branch})`}
                        className={branchActionItemClasses}
                        onSelect={() => onDeleteGroup(group.branch, fullBranchIds(group.branch))}
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
        </div>
      )}
      {showSectionHeaders && <DropdownMenuSeparator />}
      {showSectionHeaders && (
        <CollapsibleSectionHeader
          label="Local"
          noun="sessions"
          expanded={isSectionExpanded(LOCAL_SECTION_KEY, searchActive)}
          onToggle={() => toggleSection(LOCAL_SECTION_KEY)}
          controlsId={sessionRegionId(LOCAL_SECTION_KEY)}
        />
      )}
      {(!showSectionHeaders || isSectionExpanded(LOCAL_SECTION_KEY, searchActive)) && (
        <div id={sessionRegionId(LOCAL_SECTION_KEY)} role="presentation">
          {groups.local.map((s) => renderSessionItem(s))}
        </div>
      )}
    </>
  );
}
