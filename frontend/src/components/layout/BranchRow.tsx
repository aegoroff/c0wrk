import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, GitBranch, Pin, PinOff } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ItemActions } from "./ItemAction";
import { formatRelativeTime } from "@/lib/formatters";
import type { SessionInfo } from "@/types/models";

/** Shared styling of the branch-row action items inside the hover overlay —
 *  the same compact icon-button look the always-visible "+" used to have. */
export const branchActionItemClasses =
  "shrink-0 rounded p-0.5 hover:bg-muted/50 active:bg-muted/30";

/** The group pin/unpin item of the branch-row hover overlay — a state flip
 *  (pinnedGroupsStore) that keeps the menu open. Shared by the live
 *  (SessionGroupedList) and archived (SessionSelector) rows. */
export function PinGroupAction({
  branch,
  pinned,
  onToggle,
}: {
  branch: string;
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <DropdownMenuItem
      title={`${pinned ? "Unpin" : "Pin"} group (${branch})`}
      className={branchActionItemClasses}
      onSelect={(event) => {
        // A state flip, not an action — keep the menu open.
        event.preventDefault();
        onToggle();
      }}
    >
      {pinned ? (
        <PinOff className="size-3 text-primary" />
      ) : (
        <Pin className="size-3 text-primary" />
      )}
    </DropdownMenuItem>
  );
}

interface BranchRowProps {
  /** 'archived' rows speak the Archived wording ("Show archived branch
   *  sessions"); live rows the Worktrees one ("Show branch sessions"). */
  variant?: "live" | "archived";
  branch: string;
  expanded: boolean;
  /** GROUP-level pin badge (pinnedGroupsStore) — not a per-session pin. */
  pinned: boolean;
  /** `aria-controls` target — the collapsing region div's id (sessionRegionId). */
  regionId: string;
  onToggle: () => void;
  /** The group's freshest member (lib/sessionGroups `freshestSession`) — the
   *  row's clock, the same freshness the group ORDER uses. */
  freshest: SessionInfo | null;
  /** Live rows render the radar-style group activity dot; archived rows omit it. */
  activityDot?: ReactNode;
  /** The nested registered menu items of the hover overlay (the row actions). */
  actionItems: ReactNode;
}

/**
 * Shared branch-group row of the session selector — ONE registered menu item
 * (the collapse toggle) carrying the branch name, the freshest member's
 * relative time and a hover overlay of nested registered menu items (the
 * `actionItems`). Radix registers the nested items in the same roving-focus
 * collection, so arrow keys traverse toggle → actions; the overlay stops
 * click/key bubbles so activating an action never toggles the group (see
 * ItemAction).
 *
 * Rendered by SessionGroupedList (live rows) and SessionSelector's Archived
 * section — the two rows must stay look-alikes, so the markup lives here
 * exactly once; the action sets differ at the call sites.
 */
export function BranchRow({
  variant = "live",
  branch,
  expanded,
  pinned,
  regionId,
  onToggle,
  freshest,
  activityDot,
  actionItems,
}: BranchRowProps) {
  const noun = variant === "archived" ? "archived branch sessions" : "branch sessions";
  return (
    <DropdownMenuItem
      title={expanded ? `Hide ${noun}` : `Show ${noun}`}
      className="group/item w-full min-w-0 gap-1 rounded-sm px-2 py-1 text-left text-sm hover:bg-muted/50"
      aria-expanded={expanded}
      aria-controls={regionId}
      onSelect={(event) => {
        // Keep the menu open — this item only flips the group.
        event.preventDefault();
        onToggle();
      }}
    >
      {expanded ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
      )}
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
      {pinned && <Pin className="size-3 shrink-0 text-primary" />}
      <span className="min-w-0 flex-1 truncate">{branch}</span>
      {activityDot}
      {freshest && (
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(freshest.last_active_at || freshest.created_at)}
        </span>
      )}
      <ItemActions>{actionItems}</ItemActions>
    </DropdownMenuItem>
  );
}
