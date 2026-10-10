# Workspace Tabs

## Role

The workspace tab layer is the outermost context layer of the app shell: each tab remembers which project and which session its workspace view shows plus a snapshot of the UI slices inside it, while exactly one tab — the active one — mirrors the live global stores. The layer always lives; `uiStore.tabsEnabled` only controls whether the tab bar is visible and how notification clicks route (see [ADR-083](../../decisions/083-workspace-tabs-single-engine.md)).

## Key Files

- `frontend/src/stores/tabStore.ts` — the tab layer state: the `Tab {id, projectId, sessionId, ui}` list plus `activeTabId`; actions `addTab` / `closeTab` / `activateTab` / `updateActiveContext`; the pure `selectActiveTab` selector. TRANSIENT — never persisted.
- `frontend/src/lib/tabEngine.ts` — the single activation engine: `activate` (never rejects), `writeBack` (live stores → active tab), `attachWriteBack` (write-back subscriptions). A plain lib module (no React); it never reads the flag.
- `frontend/src/lib/tabSnapshot.ts` — the v1 snapshot slices: `captureTabUI` / `restoreTabUI` / `sanitizeTabUI` (fail-closed validation) and `isSameTabUI` (content equality behind reference-stable no-ops). Pure functions — no store access.
- `frontend/src/hooks/useTabController.ts` — the React seam: one engine instance per mount, `attachWriteBack` mounted in an effect, exposes `{activate, writeBack}`.
- `frontend/src/components/layout/AppLayout.tsx` — THE single controller mount for the app plus the `{tabsEnabled && <TabBar/>}` render gate.
- `frontend/src/components/layout/TabBar.tsx` — the presentational tab strip; every interaction routes through the `TabController` prop; labels and task-status dots derive LIVE from the project/session/chat stores by id, so renames and lifecycle events repaint without a stale copy on the tab.
- `frontend/src/lib/tabLabel.ts` — `buildTabLabel`, the pure label algebra behind the strip: `Project: Session`, `Project`, `CHAT: Session`, `New Tab` (absent segments are dropped, never rendered as empty text).
- `frontend/src/components/layout/SidebarHeader.tsx` — drops its own Settings gear while the bar is on (the bar carries the one Settings affordance, aimed at its Appearance section) and regains it when the flag turns off.
- `frontend/src/components/settings/TabsSettings.tsx` — the Appearance-tab master switch over `uiStore.tabsEnabled`.
- `frontend/src/hooks/useNotificationClicks.ts` — the flag-on banner-click routing branch (the only behavioral flag branch in the app, see [system-notifications.md](system-notifications.md)).
- `frontend/src/hooks/useWindowTitle.ts` — the window title follows the ACTIVE tab's ids, resolved live against the project/session stores.

## Behavior

### Always-live layer, display-and-routing-only flag

The tab layer exists unconditionally. With `uiStore.tabsEnabled` off, the UI never renders the create/close controls, so the layer runs its documented "exactly one tab" special case: that single tab is an invisible live mirror of the workspace, and flipping the flag on merely reveals the tab bar above the already-living tab. There are no flag-driven lifecycle transitions — no state is created, destroyed, or migrated when the flag flips.

| `tabsEnabled` gates | `tabsEnabled` never gates |
| ------------------- | ------------------------- |
| Tab-bar rendering (`AppLayout`) | The tab layer lifecycle (always live) |
| The sidebar Settings gear (`SidebarHeader`) | The activation engine (it never reads the flag) |
| Notification-click routing (`useNotificationClicks`) | The write-back mirror (runs under any flag value) |

### Single engine, one activation path

```
                ┌───────────────────────────────────────────────┐
                │              tabStore (transient)             │
                │  tabs: [Tab {id, projectId, sessionId, ui}]   │
                │  activeTabId                                  │
                └──────▲───────────────────────────▲────────────┘
     activate(id)      │                           │  updateActiveContext
     (the single       │                           │  (write-back mirror)
      path)            │                           │
        ┌──────────────┴───────────┐   ┌───────────┴─────────────────┐
        │  tabEngine.activate      │   │  tabEngine.writeBack        │
        │  capture → flip →        │   │  live stores → active tab   │
        │  switch/select →         │   │  (project id, session id,   │
        │  restore → converge      │   │  the three UI slices)       │
        └──────────────┬───────────┘   └───────────▲─────────────────┘
                       │                           │ attachWriteBack:
                       ▼                           │ subscriptions on project /
        switchProjectWithState / selectSession ────┘ session/ui/input stores
        (the global stores stay the SINGLE source of truth)
```

`AppLayout` mounts the one controller whose engine owns the write-back subscriptions ("exactly one engine per app"). `useNotificationClicks` instantiates its own BARE engine (no `attachWriteBack`), so a banner click can never install a second write-back. All engine instances enqueue on ONE module-level activation chain (`lib/tabEngine`), so a banner-click activation can never interleave its store writes with an in-flight tab-click activation — the shared project switcher alone could not provide this, since a same-project activation makes no switch call at all.

### Activation sequence (`runActivation`)

1. **Capture** — `writeBack()` mirrors the live context into the outgoing tab while it is still active.
2. **Optimistic flip** — `activateTab(tabId)` paints the incoming tab immediately; the incoming tab's remembered `ui` snapshot is copied BEFORE any await, so a mid-switch write-back (the incoming tab is now active and the subscriptions fire) cannot overwrite what the tab remembered.
3. **Context move** — different project: `switchProjectWithState(dest)` (the switch flow owns the session restore: saved session → latest → fresh), with `null` resolving to the No Project pseudo-project entry; same project: `selectSession(sessionId)` when the session differs.
4. **Restore** — the remembered slices are applied to the live stores: the per-project maps merge entry-by-entry (this tab's remembered entries layer over the live map; other projects' entries survive), and the input-panel fields are written as one unit.
5. **Converge** — a final `writeBack()` mirrors whatever the context move landed on (restored session included) into the now-active tab; content-equal against the remembered snapshot, so a clean activation is a reference-stable no-op.

Activations serialize through the engine's module-level chain, shared by every engine instance: each activation's full body completes before the next one starts — including activations from a DIFFERENT engine instance (the notification hook's bare engine) — so rapid tab clicks and a banner click landing mid-switch never interleave their store writes.

### Write-back: the active tab is a live mirror

`writeBack()` copies the live workspace context (`activeProjectId`, `activeSessionId`, the two per-project uiStore maps, the input-panel slice) into the ACTIVE tab via `updateActiveContext`. `attachWriteBack()` adopts the context synchronously on attach, then keeps the mirror converged through subscriptions on the four source stores. Content-equal writes keep the stored references, so unrelated store churn costs nothing.

### Snapshot slices (v1 composition)

| Slice | Source | Content |
| ----- | ------ | ------- |
| `workspaceTabByProject` | `uiStore` | `'explorer'` \| `'git'` \| `'semantics'` \| `'research'` per project id |
| `researchSegmentByProject` | `uiStore` | `'dashboard'` \| `'papers'` per project id |
| `inputMode` | `inputModeStore` | `{mode, height, collapsedHeight, isExpanded}` — exactly the panel's persisted fields; the transient `pending*` fields are excluded |

Every payload crosses `sanitizeTabUI` (the same fail-closed contract as `mergeUIStore`): per-project maps rebuild from valid entries only, scalar input fields fall back to the caller-supplied fallback, results are freshly allocated so later store mutations never leak into a stored snapshot. `captureTabUI` captures the live slices; `restoreTabUI` validates a remembered snapshot against the live input slice; `isSameTabUI` powers the content-equality no-ops.

The file viewer is deliberately NOT a slice: its open tabs and active file remain per-project state, restored by the project-switch persistence (`ProjectSwitchState`), never captured per workspace tab.

### Banner-click routing (the one flag branch)

With the flag ON, a `notification_clicked` payload routes through the tab engine: prefer the exact `{projectId, sessionId}` tab, else any tab already showing the session (session ids are globally unique), and `activate` it; no match creates a tab for the clicked context carrying a capture of the CURRENT live slices (`captureLiveUI`) — the activation's restore step then re-applies what the workspace already shows, so the input panel is left untouched exactly like a «+»-created tab (`addTab` auto-activates, the handler steps back to the previous tab, then `activate` materializes the context). With the flag OFF, the pre-tab radar pattern runs (switch-when-needed → `selectSession`) and the tab layer is never read or written. See [system-notifications.md](system-notifications.md) § Click routing.

### Edge handling

| Situation | Behavior |
| --------- | -------- |
| Tab's project was deleted | The tab retargets to the CHAT pseudo-project (session cleared) and completes activation there |
| Tab's project is `null` (CHAT) | Switches to the No Project pseudo-project entry |
| Tab's session was deleted | The dead id is dropped from the tab; the live session stays put |
| `activate` on the already-active id | No-op (nothing captured, nothing restored) |
| Tab closed while its activation sat in the queue | No-op |
| No Project entry unavailable | The activation fails and rolls back (see Error Handling) |

## Error Handling

- **Activation never rejects.** Every failure inside `runActivation` is caught: `activeTabId` rolls back to the outgoing tab, the failure is reported through `logger.warn`, and the promise resolves — fire-and-forget callers cannot produce an unhandled rejection. The live context may have partially moved (the switch flow writes stores as it goes); the post-rollback `writeBack()` re-mirrors whatever live ended up as into the refocused tab, keeping the active-tab-mirrors-live property intact.
- **Fail-closed snapshots.** A malformed tab-UI payload (a hand-edited store, a future wire source) never reaches the stores: invalid entries and wrong-typed scalars fall back per `sanitizeTabUI`.
- **Store-level no-ops.** `activateTab` on an unknown id, `closeTab` on an unknown id, and `updateActiveContext` with an unchanged context all return the same state object.
- **Project-switch failures** surface their own toast from the switch flow; the activation rolls back on top of them.

## Invariants

- The tab layer always holds at least one tab; closing the last tab replaces it with a fresh default tab.
- `activeTabId` always references an element of `tabs`.
- The ACTIVE tab always mirrors the live workspace context — project id, session id, and the three snapshot slices — kept converged by the write-back subscriptions under any `tabsEnabled` value.
- Every tab activation travels the single engine path, and the engine stays flag-agnostic — it reads only the tab layer and the live stores.
- Tab actions that change nothing return the same state object (reference-stable no-ops).
- Tab arrangements stay app-lifetime: `tabStore` keeps its state in memory only, and a restart always starts from a single default tab.
- The `tabsEnabled` flag persists across restarts (`c0wrk-sidebar-collapsed`, uiStore persist version 7, default off).
- A snapshot payload is validated fail-closed both before storage and before restore, so the stores receive validated values only.
- A snapshot restore always merges the per-project maps entry-by-entry and preserves other projects' entries.
- Exactly one engine with write-back subscriptions exists per app (the `AppLayout` controller mount); every other engine instance runs bare, without `attachWriteBack`.
- The file viewer stays per-project: viewer tabs and the active file ride the project-switch persistence, outside every workspace tab's snapshot.
- With the flag off, the shell layout stays byte-identical to the pre-tab UI: no bar, no wrapper artifacts, and the single tab remains the invisible live mirror.

## Related Specs

- [stores.md](stores.md) — `tabStore` in the store catalog; `uiStore` owns the persisted flag (v7) and the per-project maps the snapshot slices capture
- [system-notifications.md](system-notifications.md) — the flag-on banner-click branch of `useNotificationClicks`
- [README.md](README.md) — the app shell the tab bar sits above and the project-switch flow the engine drives
- [ADR-083](../../decisions/083-workspace-tabs-single-engine.md) — the single-engine / disabled-mode-is-one-tab / snapshot-slices decision
