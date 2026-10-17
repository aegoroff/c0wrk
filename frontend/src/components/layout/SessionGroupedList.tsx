import { Fragment, useMemo, type ReactNode } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { CollapsibleSectionHeader } from "@/components/ui/CollapsibleSectionHeader";
import { ItemActions } from "./ItemAction";
import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { useActiveSessionsStore } from "@/stores/activeSessionsStore";
import { usePinnedGroupsStore } from "@/stores/pinnedGroupsStore";
import {
  SESSION_DOT_CLASSES,
  SESSION_DOT_TITLES,
  aggregateBadgeFlags,
  deriveLiveSessionFlags,
  mergePendingOverride,
} from "@/lib/activeSessions";
import {
  LOCAL_SECTION_KEY,
  MANAGED_SECTION_KEY,
  branchGroupKey,
  lastActiveTime,
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
  /** Archive every member of the group (arms confirmation when a member is busy). */
  onArchiveGroup: (branch: string, ids: string[]) => void;
  /** Delete every member of the group (always arms confirmation). */
  onDeleteGroup: (branch: string, ids: string[]) => void;
}

/** Shared styling of the branch-row action items inside the hover overlay —
 *  the same compact icon-button look the always-visible "+" used to have.
 *  Exported for the archived branch rows in SessionSelector, which mirror
 *  this overlay with their own action set. */
export const branchActionItemClasses =
  "shrink-0 rounded p-0.5 hover:bg-muted/50 active:bg-muted/30";

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

/** The branch row's radar-style activity dot — ONE dot summarizing the live
 *  status of the group's members, so a COLLAPSED group with a live session
 *  stays visible. It reuses the radar's exact aggregation chain
 *  (lib/activeSessions): chatStore slices + the pending-HITL override fold
 *  into per-member flags, `aggregateBadgeFlags` collapses them into badge
 *  flags, and the most urgent flag picks the shared dot color + wording. A
 *  group whose members are all idle renders nothing. */
function BranchActivityDot({ sessions }: { sessions: readonly SessionInfo[] }) {
  const taskActive = useChatStore((s) => s.taskActive);
  const paused = useChatStore((s) => s.paused);
  const messageOrder = useChatStore((s) => s.messageOrder);
  const messages = useChatStore((s) => s.messages);
  const unfinishedTaskStatus = useChatStore((s) => s.unfinishedTaskStatus);
  const pendingOverride = useActiveSessionsStore((s) => s.pendingOverride);

  const dot = useMemo(() => {
    const flags = mergePendingOverride(
      deriveLiveSessionFlags({ taskActive, paused, messageOrder, messages, unfinishedTaskStatus }),
      pendingOverride,
    );
    const badge = aggregateBadgeFlags(sessions, flags);
    for (const flag of ["error", "attention", "active", "paused"] as const) {
      if (badge[flag]) {
        const status = DOT_FLAG_STATUS[flag];
        return { className: SESSION_DOT_CLASSES[status], title: SESSION_DOT_TITLES[status] };
      }
    }
    return null;
  }, [sessions, taskActive, paused, messageOrder, messages, unfinishedTaskStatus, pendingOverride]);

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
  onArchiveGroup,
  onDeleteGroup,
}: SessionGroupedListProps) {
  // The GROUP-level pin (pinnedGroupsStore): a pinned branch floats above the
  // unpinned groups of the section (lib/sessionGroups ordering) — member
  // sessions keep their own per-session pins untouched.
  const pinnedBranches = usePinnedGroupsStore((s) => s.pinnedBranches);
  const togglePinnedBranch = usePinnedGroupsStore((s) => s.togglePinnedBranch);
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
            const ids = group.sessions.map((s) => s.id);
            const groupPinned = pinnedBranches.includes(group.branch);
            // The row's clock is the group's freshest member (the same
            // freshness the group ORDER uses — lib/sessionGroups).
            const freshest =
              group.sessions.length > 0
                ? group.sessions.reduce((a, b) =>
                    lastActiveTime(b) > lastActiveTime(a) ? b : a,
                  )
                : null;
            return (
              <Fragment key={key}>
                {/* The branch row is ONE registered menu item (the collapse
                    toggle) carrying the branch name, the group's radar-style
                    activity dot (BranchActivityDot — visible while collapsed
                    too), the freshest member's relative time (the session-row
                    styling) and a hover
                    overlay of FOUR nested registered menu items — the row
                    actions. Radix registers the nested items in the same
                    roving-focus collection, so arrow keys traverse toggle →
                    actions; the overlay stops click/key bubbles so activating
                    an action never toggles the group, and the pin item's
                    preventDefault keeps the menu open. */}
                <DropdownMenuItem
                  title={expanded ? "Hide branch sessions" : "Show branch sessions"}
                  className="group/item w-full min-w-0 gap-1 rounded-sm px-2 py-1 text-left text-sm hover:bg-muted/50"
                  aria-expanded={expanded}
                  aria-controls={sessionRegionId(key)}
                  onSelect={(event) => {
                    // Keep the menu open — this item only flips the group.
                    event.preventDefault();
                    toggleSection(key);
                  }}
                >
                  {expanded ? (
                    <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  {groupPinned && <Pin className="size-3 shrink-0 text-primary" />}
                  <span className="min-w-0 flex-1 truncate">{group.branch}</span>
                  <BranchActivityDot sessions={group.sessions} />
                  {freshest && (
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(freshest.last_active_at || freshest.created_at)}
                    </span>
                  )}
                  <ItemActions>
                    <DropdownMenuItem
                      title={`New session in this worktree (${group.branch})`}
                      className={branchActionItemClasses}
                      // No preventDefault — Radix's default close is exactly
                      // what the draft-arming "+" gesture wants.
                      onSelect={() => onNewSessionOnBranch(group.branch)}
                    >
                      <Plus className="size-3.5" />
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      title={`${groupPinned ? "Unpin" : "Pin"} group (${group.branch})`}
                      className={branchActionItemClasses}
                      onSelect={(event) => {
                        // A state flip, not an action — keep the menu open.
                        event.preventDefault();
                        togglePinnedBranch(group.branch);
                      }}
                    >
                      {groupPinned ? (
                        <PinOff className="size-3 text-primary" />
                      ) : (
                        <Pin className="size-3 text-primary" />
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      title={`Archive sessions (${group.branch})`}
                      className={branchActionItemClasses}
                      onSelect={() => onArchiveGroup(group.branch, ids)}
                    >
                      <Archive className="size-3 text-warning" />
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      title={`Delete sessions (${group.branch})`}
                      className={branchActionItemClasses}
                      onSelect={() => onDeleteGroup(group.branch, ids)}
                    >
                      <Trash2 className="size-3 text-destructive" />
                    </DropdownMenuItem>
                  </ItemActions>
                </DropdownMenuItem>
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
