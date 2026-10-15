import { useCallback, useState } from "react";

/**
 * Ephemeral collapse state for collapsible dropdown sections (the session
 * selector's Managed/Local/Archived and the branch combo's
 * Local/Remote/Worktrees). The set lives only for the host component's
 * lifetime and resets on remount; keys are the caller's stable collapse keys.
 *
 * {@link isSectionExpanded} carries the shared force-expand rule: an active
 * search expands every section so matches inside a collapsed one stay
 * reachable.
 */
export function useCollapsibleSections(initiallyCollapsed: readonly string[] = []) {
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(
    () => new Set(initiallyCollapsed),
  );

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const isSectionExpanded = useCallback(
    (key: string, forceExpand = false) => forceExpand || !collapsedSections.has(key),
    [collapsedSections],
  );

  return { collapsedSections, toggleSection, isSectionExpanded };
}
