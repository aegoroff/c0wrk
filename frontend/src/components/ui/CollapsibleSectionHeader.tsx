import { ChevronDown, ChevronRight } from "lucide-react";

interface CollapsibleSectionHeaderProps {
  /** Section label, rendered verbatim in display case ("Managed", "Local"...). */
  label: string;
  /** What the section lists — completes the a11y title: `Hide <label> <noun>`. */
  noun: string;
  /** Whether the section body is currently rendered. */
  expanded: boolean;
  /** Collapse toggle — never dismisses the surrounding menu. */
  onToggle: () => void;
  /** Optional trailing count, e.g. the archived size. */
  count?: number;
  /** id of the content region this header collapses (`aria-controls`). The
   *  region renders only while expanded, so the reference names an element
   *  exactly when one exists. `aria-expanded` is the load-bearing disclosure
   *  half — this is the optional companion. */
  controlsId?: string;
}

/**
 * Collapsible section header button shared by the session selector
 * (Managed/Local/Archived) and the branch combo (Local/Remote/Worktrees):
 * `text-xs font-semibold uppercase tracking-wide text-muted-foreground` with
 * a leading chevron and hover feedback. A plain button on purpose (not a
 * `DropdownMenuItem`) so toggling never dismisses the dropdown.
 */
export function CollapsibleSectionHeader({
  label,
  noun,
  expanded,
  onToggle,
  count,
  controlsId,
}: CollapsibleSectionHeaderProps) {
  return (
    <button
      type="button"
      title={expanded ? `Hide ${label.toLowerCase()} ${noun}` : `Show ${label.toLowerCase()} ${noun}`}
      className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/50"
      aria-expanded={expanded}
      aria-controls={controlsId}
      onClick={onToggle}
    >
      {expanded ? (
        <ChevronDown className="size-3 shrink-0" />
      ) : (
        <ChevronRight className="size-3 shrink-0" />
      )}
      {label}
      {count !== undefined && ` (${count})`}
    </button>
  );
}
