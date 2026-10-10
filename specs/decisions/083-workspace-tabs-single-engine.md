# ADR-083: Workspace Tabs — Single Engine, Flag-Only Visibility, Snapshot Slices

## Status

Accepted

## Context

The app gained optional workspace tabs: several simultaneously remembered workspace contexts (project + session + UI slices) between which the user switches. Design had to settle three questions:

1. **What does the `tabsEnabled` flag mean?** A naive reading — "the feature is off, so tear the layer down" — would make every consumer flag-aware, need flag-driven lifecycle transitions (state created on enable, destroyed on disable), and leave the flag-off output subtly different from the pre-tab UI it claims to preserve.
2. **Where does per-tab state live?** The live workspace context already has single owners: `projectStore.activeProjectId`, `sessionStore.activeSessionId`, the per-project uiStore maps, `inputModeStore`'s panel fields. Duplicating them into a per-tab parallel tree would create a second source of truth for the same data — violating the frontend's single-source-of-truth principle — and force a merge/sync discipline between the tree and the live stores that every existing consumer would have to opt into.
3. **Is the file viewer per tab or per project?** Viewer tabs already persist per project through the project-switch state (`ProjectSwitchState.open_tabs`); giving each workspace tab its own viewer tree would fork that ownership.

## Decision

1. **The tab layer always lives; disabled mode is the one-tab special case.** There is no "tabs off" state machine: the layer runs unconditionally, and `uiStore.tabsEnabled` gates only what the user sees and how banner clicks route — the tab bar's rendering (and, with it, the sidebar Settings gear, which the bar replaces when shown) and the notification-click branch. The activation engine never reads the flag; flipping it creates and destroys nothing. With the flag off the layer degenerates to exactly one tab that the write-back keeps as an invisible live mirror of the workspace, so flag-off output stays byte-identical to the pre-tab UI.
2. **One engine over snapshot slices, not a parallel tree.** Exactly one engine instance with write-back subscriptions exists per app (the `AppLayout` controller mount). A tab stores only ids (`projectId`, `sessionId`) plus a validated snapshot of three slices — `workspaceTabByProject`, `researchSegmentByProject`, `inputMode` — captured from the live stores at switch time (`captureTabUI`) and reapplied on activation (`restoreTabUI`, per-project maps merged entry-by-entry). The global stores remain the single source of truth: the ACTIVE tab is, by construction, their mirror (`writeBack` + subscriptions keep it converged); non-active tabs hold only remembered snapshots. Activations serialize through the engine's module-level activation chain — every engine instance (the controller and the notification hook's bare engine) enqueues on the same queue — and roll back the optimistic `activeTabId` flip on failure.
3. **The file viewer remains per-project.** Viewer tabs and the active file stay owned by the project-switch persistence and are never captured into a workspace tab's snapshot. A v1 snapshot therefore has exactly three slices, and every payload crosses the fail-closed `sanitizeTabUI` contract before storage or restore.

Supporting choices: `tabStore` is transient (a restart always starts from a single default tab — an app-lifetime UI arrangement is not durable state; the durable per-context context already persists in uiStore/inputModeStore and the project switch state); the one behavioral flag branch lives in `useNotificationClicks` (flag ON routes a click through the engine's single activation path, flag OFF keeps the pre-tab radar pattern); only `tabsEnabled` itself persists (uiStore `c0wrk-sidebar-collapsed`, v6→v7, default off).

## Consequences

Positive:

- No dual bookkeeping: tabs never clone the live workspace context; the write-back makes "active tab = global stores" a structural invariant instead of a sync obligation, and consumers (window title, tab labels) already read the live stores by id.
- The flag is reversible at runtime with zero migration and no flag-dependent code outside the three documented gates; enabling tabs reveals a bar above an already-correct single tab rather than bootstrapping state.
- Cross-engine safety is structural: a second bare engine (the notification hook's) cannot install a second write-back, and all engines enqueue on one module-level activation chain, so their activations can never interleave — the shared project switcher alone could not provide this, since a same-project activation makes no switch call at all.
- Corrupt or future-shaped snapshot payloads fail closed at the `sanitizeTabUI` boundary instead of poisoning the stores.

Negative:

- A workspace tab remembers only the three v1 slices: anything else per-tab (scroll positions, file-viewer arrangement, per-session panel state beyond the input-panel fields) is shared within a project, not per tab — adding a slice is a deliberate v2 composition change, not a free field.
- Tab arrangements die with the app by design; users lose their tab layout on restart (mitigated by the durable per-project/per-session state the slices and switch flow restore).
- Two engine instances exist (the app controller and the notification hook's bare engine); the one-write-back property is enforced by convention at the call sites, not by the type system.

## Alternatives Considered

- **Parallel per-tab state tree** (each tab owns its own project/session/panel/viewer state, activated by swapping the tree in): rejected — a second source of truth for data with live single owners, a continuous tree↔store sync burden, flag-dependent consumers everywhere, and a clashing owner for the already per-project persisted viewer tabs.
- **Flag-gated layer lifecycle** (create the tab store on enable, destroy on disable): rejected — lifecycle transitions need migration on every toggle, make the flag a state-machine input in every consumer, and break the "flag-off output = pre-tab output" goal, since teardown-and-rebuild cannot guarantee byte-identical restoration.
- **Persisting tab arrangements** (restore tabs across restarts): rejected for v1 — tabs are an app-lifetime arrangement; persisted tab ids would dangle against deleted projects/sessions and duplicate the session/project restore logic that already exists per project.
- **Per-tab file-viewer trees**: rejected — forks ownership of viewer state that the project-switch persistence already owns and persists per project; a tab switch within one project intentionally shares the project's viewer.
