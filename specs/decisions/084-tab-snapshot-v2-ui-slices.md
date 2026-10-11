# ADR-084: Tab Snapshot v2 — Per-Tab Shell Geometry, Git-Panel Tab and Chat-View Toggles

## Status

Accepted

## Context

The workspace tab layer ([ADR-083](./083-workspace-tabs-single-engine.md)) ships a v1 snapshot of exactly three slices: `workspaceTabByProject`, `researchSegmentByProject` and `inputMode`. In practice that means switching tabs moves the project and session and restores the workspace-panel tab, the Research segment and the input panel — but the rest of the shell stays as the previous tab left it: the left sidebar's collapsed/expanded state and width, the right viewer panel's pinned/collapsed/width geometry, the Git panel's active tab, and the chat-view toggles (CHAT session-list split ratio, session-stats row visibility) are shared across every tab.

Users expect a workspace tab to be a full workspace context: restoring it should restore the shell arrangement they left it with. ADR-083 explicitly anticipated this as "a deliberate v2 composition change, not a free field".

Two constraints carried over from ADR-083:

1. Per-tab state lives ONLY as snapshot slices on the tab; the global stores remain the single source of truth (a parallel per-tab state tree stays rejected).
2. The file viewer's open tabs and active file stay per-project (ADR-083 D3): two workspace tabs on the same project intentionally share the project's viewer arrangement.

## Decision

The snapshot grows from three to eight slices (the v2 composition). Five are added:

| Slice | Source | Restore semantics |
| ----- | ------ | ----------------- |
| `sidebar` (`{collapsed, width}`) | `uiStore.sidebarCollapsed/sidebarWidth` | overwrite via the store setters (the setters' clamps stay in force) |
| `viewer` (`{pinned, collapsed, width}`) | `fileViewerStore` | overwrite via the setters, EXCEPT `collapsed`, which the empty-floating auto-collapse invariant can override: an unpinned viewer with zero open tabs recedes to the docked rail regardless of the snapshot |
| `gitPanelTabByProject` (`files\|changes\|history` per project) | `gitPanelStore.activeTabByProject` | merge entry-by-entry, exactly like the v1 per-project maps (other projects' entries survive) |
| `chatSessionListRatio` | `uiStore` | overwrite via the setter (clamped 0..1) |
| `showSessionStats` | `uiStore` | overwrite via the setter |

Restore semantics follow the slice's shape. Per-project maps merge entry-by-entry (shared maps — a restore layers entries over the live map). Scalar slices restore as an OVERWRITE of the live value: overwriting is precisely what makes them per-tab, and it is applied through the owning stores' own setters, so every existing clamp and derived behavior stays in force. The write-back mirror captures all eight slices, `attachWriteBack` subscribes to the new source fields (uiStore scalars, fileViewerStore geometry, the gitPanelStore map reference), and every payload still crosses the fail-closed `sanitizeTabUI` (maps rebuilt entry-by-entry from valid values; scalars fall back to the caller-supplied live slices when missing or wrong-typed; finite-number validation only — range clamping stays with the applying store setters). `GIT_PANEL_TAB_VALUES` is exported from `gitPanelStore` as the validation source of truth, mirroring `WORKSPACE_TAB_VALUES`.

Nothing new is persisted: `tabStore` stays transient, and every new slice's owner already persists its own field (uiStore v7 fields, fileViewerStore v4 fields, gitPanelStore's `activeTabByProject`). A restart therefore boots with the last-active tab's shell — the stores' own persisted values — and the fresh default tab converges to it through `attachWriteBack`.

## Consequences

Positive:

- A tab switch now restores the whole shell arrangement — sidebar, viewer geometry, Git-panel tab, chat-view toggles — not just the workspace-panel context, matching the user expectation that a tab is a full workspace context.
- Still no dual bookkeeping: the stores keep single ownership; tabs hold only validated snapshots; the active tab remains their structural mirror.
- The change is additive: v1 call shapes keep working (`updateActiveContext` re-sanitizes partial payloads against the active tab's remembered snapshot, so a partial re-capture never wipes a remembered scalar with a boot default).

Negative:

- The scalar-overwrite semantics mean two tabs on the same project still share per-project maps (documented ADR-083 tradeoff, unchanged), but each now restores its own geometry — with the cost that the persisted (restart-time) values always belong to the tab that was last active.
- Feature-triggered reveals (open-file expands the viewer, reveal-in-workspace expands the sidebar) legitimately override a just-restored snapshot; the write-back re-converges, but the tab then remembers the revealed state.
- More subscriptions on the write-back path (file-viewer and git-panel stores); content-equal writes stay reference-stable no-ops, so the cost is bounded.

## Alternatives Considered

- **A per-tab React instance of the whole shell** (each tab mounts its own layout subtree holding its own state): rejected again for the ADR-083 reasons — a second source of truth for store-owned data, a continuous sync burden, and a clashing owner for the per-project persisted viewer tabs.
- **Making the viewer's open file tabs a per-tab slice**: rejected — forks ownership ADR-083 D3 already settled (viewer tabs persist per project via `ProjectSwitchState`); the geometry slice gives tabs their own panel arrangement without forking the file arrangement.
- **Persisting tab arrangements across restarts**: rejected — unchanged from ADR-083; the durable per-context state already persists in the owning stores.

## Related

- [tabs.md](../domains/frontend/tabs.md) — the updated v2 slice table, restore semantics and invariants
- [ADR-083](./083-workspace-tabs-single-engine.md) — the single-engine architecture this composition extends
