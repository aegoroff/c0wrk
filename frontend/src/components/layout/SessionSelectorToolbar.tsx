import { MenuSearchInput } from "@/components/ui/MenuSearchInput";
import { FolderTree, List } from "lucide-react";

interface SessionSelectorToolbarProps {
  grouped: boolean;
  onToggleGrouped: () => void;
  showSearch: boolean;
  search: string;
  onSearchChange: (value: string) => void;
}

/**
 * The session selector's search-input line: the grouped-by-branch mode toggle
 * before the input (same glyph the git panel's tree view uses). The toggle is
 * a plain button on purpose (not a DropdownMenuItem): flipping the display
 * mode must not dismiss the menu. The icon shows the mode you switch TO; the
 * toggle renders even when the search input is hidden (below the 5-session
 * threshold). The input is a MenuSearchInput — a plain Input would let Radix's
 * menu typeahead steal its focus on the first matching keystroke.
 */
export function SessionSelectorToolbar({
  grouped,
  onToggleGrouped,
  showSearch,
  search,
  onSearchChange,
}: SessionSelectorToolbarProps) {
  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <button
        type="button"
        title={grouped ? "Show flat list" : "Group sessions by branch"}
        className="h-7 w-7 shrink-0 rounded text-muted-foreground hover:bg-muted/50 active:bg-muted/30"
        onClick={onToggleGrouped}
      >
        {grouped ? <List className="size-4" /> : <FolderTree className="size-4" />}
      </button>
      {showSearch && (
        <MenuSearchInput
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search sessions..."
          className="h-7 min-w-0 flex-1 text-sm"
          autoFocus
        />
      )}
    </div>
  );
}
