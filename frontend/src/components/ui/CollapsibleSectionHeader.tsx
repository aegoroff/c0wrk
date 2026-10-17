import { ChevronDown, ChevronRight } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

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
 * Collapsible section header shared by the session selector
 * (Managed/Local/Archived) and the branch combo (Local/Remote/Worktrees):
 * `text-xs font-semibold uppercase tracking-wide text-muted-foreground` with
 * a leading chevron and hover feedback.
 *
 * A registered `DropdownMenuItem` — deliberately NOT a plain button: Radix's
 * menu prevents Tab inside the content and arrow-key navigation only visits
 * the roving-focus collection, so an unregistered control would be
 * unreachable for keyboard-only users (a section collapsed with the mouse
 * could never be reopened from the keyboard). Enter/Space activate the item
 * through `onSelect`, whose `preventDefault()` keeps the surrounding menu
 * open — the plain-button behavior, preserved on the new element. Clicks run
 * through the same `onSelect` (Radix composes its select handler into
 * `onClick`), so toggle logic lives in exactly one place. MUST render inside
 * a `DropdownMenu` content — the Radix item context is required.
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
    <DropdownMenuItem
      title={expanded ? `Hide ${label.toLowerCase()} ${noun}` : `Show ${label.toLowerCase()} ${noun}`}
      className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/50"
      aria-expanded={expanded}
      aria-controls={controlsId}
      onSelect={(event) => {
        // Keep the menu open — this item only flips its section body.
        event.preventDefault();
        onToggle();
      }}
    >
      {expanded ? (
        <ChevronDown className="size-3 shrink-0" />
      ) : (
        <ChevronRight className="size-3 shrink-0" />
      )}
      {label}
      {count !== undefined && ` (${count})`}
    </DropdownMenuItem>
  );
}
