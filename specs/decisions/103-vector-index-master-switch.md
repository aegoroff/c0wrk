# ADR-103: Vector Indexing Master Switch (Live Teardown and Rebuild)

## Status

Accepted

## Context

The vector-index subsystem was historically always on: every launch loaded the ONNX embedder in the background, indexed every workspace root, registered the `semantic_search` tool and RAG hint injection into every session, and rendered search surfaces (the workspace panel's Search tab, the status-bar indexing indicator, the viewer's Find similar action). Operators who do not want semantic search — machines that cannot afford the embedder's RAM/VRAM footprint, privacy-restricted environments, or users of the lexical `glob` tool only — had no way to turn any of it off; the indexer's cost was paid on every project unconditionally.

The switch had to decide two things: what "off" MEANS (which of the tool registration, the RAG wiring, the per-root registry, and the ONNX session survive a false value), and WHEN a flip takes effect (the embedder session may be mid-init in the background, a manager may be indexing right now, and live sessions hold cloned tool registries).

## Decision

1. **`vector_index.enabled` is a pointer-bool master gate, default true** (nil = the historical always-on behavior; an explicit false turns the subsystem off). It ships with the indexing-policy knobs on the same config section — `exclude_patterns`, `index_submodules`, `respect_gitignore`/`respect_aiignore` — all edited from one Settings → Search "Indexing" section and all applied live by a single `UpdateIndexingSettings` RPC.
2. **The switch applies LIVE (validate → persist → apply), not at restart.** The disable transition runs in a fixed order: an epochal invalidation of any in-flight background ONNX init FIRST (so the stale init's late factory wiring cannot resurrect the registry after the teardown — the launcher's epochal guard makes it close its own embedder instead), then `SetVectorSearchEnabled(false)` strips the `semantic_search` tool and the RAG closures from the builder (the closures are stashed; because every per-session registry clone shares the embedded sp4rk registry, LIVE sessions lose the tool too), then `VectorRoots.Disable` parks the per-root registry (managers shut down, embedder released, factory dropped; every routing path fails fast with `errVectorDisabled`; `FactoryReady` reports false so project switches defer their vector setup for the re-enable drain), and a `state: "disabled"` status snapshot is emitted — distinct from `"unavailable"` (a failed backend).
3. **The enable transition rebuilds from the stash**: the closures are re-registered, and the desktop background ONNX init relaunches under a fresh epoch (a fresh embedder + factory + ready channel — the per-launch replacement of the former process-wide once-guard, which could fire only once per app run); its success path clears the registry's disabled flag and drains the deferred project setup. A boot with indexing off registers the closures then flips the builder off (populating the stash for a later enable) and skips the ONNX load entirely.
4. **Policy-only saves while enabled (exclude patterns, submodules, ignore-file respect) release the live managers and rebuild the focus root**: the desktop manager factory snapshots the LIVE config under `configMu` on every build, so the rebuilt manager carries the new policy and its next incremental pass evicts newly excluded files (the policy reaches every walk identically — the full walk, the validation walk that turns "no longer walked" into "deleted", and the watcher's indexability check). A save resolving to the same policy releases nothing.
5. **The frontend gates its surfaces off the same flag** (`indexingSettingsStore` + `useIndexingSettings`, the experimental-features latch pattern; the store's default is the resolved backend default `true`, so the unknown pre-load state never flashes the always-on surfaces away): the workspace panel's Search tab (a remembered selection remaps to git/explorer), the status-bar indexing indicator, and the viewer's Find similar action hide while off.
6. **Index data on disk is preserved across disable/enable cycles**: `VectorRoots.Disable` shuts managers down and releases the embedder but never touches storage roots, so re-enabling resumes from the persisted index instead of re-embedding from scratch.

## Consequences

- "Disabled" means ABSENT, not broken: the agent never sees a `semantic_search` tool that errors, RAG hint injection stops, `GetVectorIndexStatus` serves `state: "disabled"` so the UI renders an explicit off state, and no dead UI surface remains.
- The embedder's RAM/VRAM is actually released on the flip, not held hostage until the next app restart.
- The desktop vector launcher becomes restartable: the process-wide once-guard is replaced by a per-launch epoch + ready channel, adding state-machine complexity that every future init-path change must respect.
- A flip that lands while a background init is in flight is safe but eventual: the epochal guard makes the stale launch unwind itself, so the teardown is guaranteed at the cost of one extra embedder create/close pair on that race window.
- Non-focus roots pick a policy-only change up lazily (their managers are rebuilt from the live config when next routed to), so a policy save's eviction guarantee is immediate only for the focus root.

## Alternatives Considered

- **Restart-only semantics** (like `execution_provider`/`device_id`, which take effect at the next embedder creation): rejected — a switch that cannot unload a resident multi-hundred-MB embedder on demand does not solve the resource problem that motivates it, and the operator gets no feedback that anything changed until a full app cycle.
- **Keep the tool registered but erroring** (disable the index, leave `semantic_search` returning an error): rejected — every session still advertises the tool, the agent wastes calls and turns on a tool that always fails, RAG hint injection keeps paying its costs, and "disabled" would be indistinguishable from "broken" for both the model and the UI.
- **Frontend-only gating** (hide the UI surfaces, leave the backend running): rejected — cosmetic; the indexer keeps walking and embedding, the tool stays model-visible, and the resource cost remains.
- **Tearing down without the epochal guard**: rejected — the background ONNX init is asynchronous; a disable landing mid-init races the init's late factory wiring, which would resurrect a factory after `VectorRoots.Disable` unwound the registry (the exact race the launcher's epoch invalidation closes).
