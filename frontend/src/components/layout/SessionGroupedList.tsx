import { Fragment, type ReactNode } from "react";
import { ChevronDown, ChevronRight, GitBranch, Plus } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { CollapsibleSectionHeader } from "@/components/ui/CollapsibleSectionHeader";
import {
  LOCAL_SECTION_KEY,
  MANAGED_SECTION_KEY,
  branchGroupKey,
  sessionRegionId,
  type SessionGroups,
} from "@/lib/sessionGroups";
import type { SessionItemSummary } from "./SessionListItem";

interface SessionGroupedListProps {
  /** Grouping model from `buildSessionGroups` (search already applied). */
  groups: SessionGroups;
  /** An active search force-expands every section and branch group. */
  searchActive: boolean;
  /** Managed/Local headers render only while BOTH sections are non-empty —
   *  a lone Local section IS the current flat view, and a lone Managed
   *  section speaks for itself through its branch rows. A hidden header's
   *  content renders unconditionally; the hairline separator belongs to the
   *  headers and disappears with them. */
  showSectionHeaders: boolean;
  isSectionExpanded: (key: string, forceExpand?: boolean) => boolean;
  toggleSection: (key: string) => void;
  renderSessionItem: (session: SessionItemSummary, opts?: { indented?: boolean }) => ReactNode;
  /** Arms the ADR-080 branch draft AND closes the menu (clearing the search). */
  onNewSessionOnBranch: (branch: string) => void;
}

/**
 * Grouped mode of the session selector: the collapsible Managed section
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
}: SessionGroupedListProps) {
  return (
    <>
      {showSectionHeaders && (
        <CollapsibleSectionHeader
          label="Managed"
          noun="sessions"
          expanded={isSectionExpanded(MANAGED_SECTION_KEY, searchActive)}
          onToggle={() => toggleSection(MANAGED_SECTION_KEY)}
          controlsId={sessionRegionId(MANAGED_SECTION_KEY)}
        />
      )}
      {(!showSectionHeaders || isSectionExpanded(MANAGED_SECTION_KEY, searchActive)) && (
        <div id={sessionRegionId(MANAGED_SECTION_KEY)} role="presentation">
          {groups.managed.map((group) => {
            const key = branchGroupKey(group.branch);
            const expanded = isSectionExpanded(key, searchActive);
            return (
              // The branch row is a flex wrapper holding TWO sibling buttons —
              // the collapse toggle and the new-session action (nesting a
              // button inside a button is invalid HTML). Member sessions render
              // below the row, still inside the keyed fragment.
              <Fragment key={key}>
                <div className="flex w-full items-center pr-0.5">
                  {/* The branch row is a flex wrapper holding TWO sibling menu
                      items — the collapse toggle and the new-session action
                      (interactive elements are never nested). Both are
                      registered Radix items: arrow keys reach them, Enter/Space
                      activate them. The toggle's onSelect preventDefaults so
                      collapsing never dismisses the menu; the "+" select does
                      NOT — Radix's default close is exactly what the action
                      wants. */}
                  <DropdownMenuItem
                    title={expanded ? "Hide branch sessions" : "Show branch sessions"}
                    className="flex min-w-0 flex-1 items-center gap-1 rounded-sm px-2 py-1 text-left text-sm hover:bg-muted/50"
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
                    <span className="min-w-0 flex-1 truncate">{group.branch}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    title={`New session in this worktree (${group.branch})`}
                    className="ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted/50 active:bg-muted/30"
                    onSelect={() => onNewSessionOnBranch(group.branch)}
                  >
                    <Plus className="size-3.5" />
                  </DropdownMenuItem>
                </div>
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
