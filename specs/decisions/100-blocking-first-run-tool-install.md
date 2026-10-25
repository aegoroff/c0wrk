# ADR-100: Blocking First-Run Tool Install

## Status

Accepted

Amends [ADR-032](./032-offline-first-tool-reconciliation.md): decision points 2–4 (per-tool failure isolation, no destructive operations without secured replacement bytes, fail-closed verification) remain in force. Decision point 1's scheduling (the network retry as a background goroutine after startup completes) and decision point 5's blanket non-fatality are replaced for tools that are positively known to be missing — the network retry runs as a blocking pass inside startup, and its failure is fatal.

## Context

ADR-032 made startup immune to tool failures so that offline machines keep a working app. For the offline *steady state* — tools installed, or valid cached archives present — this is exactly right and stays exactly right. But the case ADR-032 optimized away, the **first run on a machine with no `~/.c0wrk/tools/` and no cache**, produced a "successfully" started app that could not do its job: `rg` (every search) and `uv`/`markitdown` (document conversion) are resolved by name through `PATH` by the executor, so the agent's core workflows were dead ends from the moment the main UI rendered. The background pass then downloaded the tools invisibly behind that UI; until it finished, search and conversion failed, and if connectivity never returned during the session the app stayed degraded until relaunch — with a single toast as the only explanation. A started-but-unusable app is not a better outcome than a blocked startup; for a first-run user it is a worse one, because it hides the cause.

ADR-010 point 8 (the pre-ADR-032 fatal modal) was right about this case and wrong about the offline steady state. This ADR splits the two: steady-state offline stays non-blocking; positively-missing tools become a blocking, splash-visible install that must succeed before the app comes up.

## Decision

1. **Blocking network pass under the splash.** When tools are missing after the offline pass (`EnsureCriticalTools(AllowNetwork: false)` — probes plus cached-archive installs, no network I/O), the retry `EnsureCriticalTools(AllowNetwork: true)` runs **synchronously inside `initTools`** (Phase 2), blocking startup while the tool-install splash is up and `tool_manager:progress` flows. The two passes remain sequenced, never concurrent (the Manager stays single-goroutine). This replaces ADR-032 D1's "background goroutine after startup has completed" scheduling; the pass structure itself is unchanged.

2. **Positive-absence predicate decides blocking.** The blocking/fatal path engages only when tools are positively known (or reasonably suspected) to be missing: `NeedsInstall()` returned a non-empty list or itself errored (unknown counts as missing until probed), or the offline pass left tools not-Ready, or the offline pass failed structurally while tools were suspected missing (the network pass still runs, and may be fatal). The single non-fatal degradation is the mirror case: a **structural failure of the offline pass over an already-complete install** (`NeedsInstall` reported nothing missing) — `tool_manager:done` plus one `runtime_error` toast (`error_code: "tool_install_failed"`), no network pass, no blocking, startup continues.

3. **Fatal outcome restores exit semantics.** Tools still not-Ready after the blocking network pass, or a structural failure of that pass, are fatal: a native blocking modal (`wailsRuntime.MessageDialog`, ErrorDialog, single "Exit" button — "Tool Installation Failed", naming the failed tools or carrying the error text, with the "Check your internet connection and disk space, then restart c0wrk." suffix) followed by `wailsRuntime.Quit`; `initTools` returns `("", false)` so `toolsOK=false` aborts Startup. `tool_manager:done` is emitted exactly once per launch — on the deciding pass, before any modal, so the splash resolves first. `PrependToPATH` runs only on the non-fatal paths.

4. **Testable seams.** The orchestration lives in `reconcileToolsWithSplash` behind two seams: `toolEnsurer` (`NeedsInstall` + `EnsureCriticalTools`; production binds `*toolmanager.Manager`, tests bind a fake) and `toolFatalActions{dialog, quit}` (production: native modal + quit; tests: recorders). The flow is exercised without the filesystem or the network; `finishToolInstallInBackground` is gone.

## Consequences

- The app never presents its main UI without the managed tools: a first run either installs them under the splash or exits with a modal that names them.
- The offline steady state is untouched: complete install (or complete cache) → one offline pass, zero network I/O, no splash, `done` once, startup continues in milliseconds.
- A first run while offline is now fatal with a clear native modal — a conscious reversal of ADR-032's first-run outcome; the user needs connectivity exactly once, after which every launch is offline-clean.
- The event lifecycle simplifies: `tool_manager:done` fires exactly once per launch (no post-splash repeat for the frontend to treat as a no-op), and `tool_manager:start` is emitted at most once — early via `NeedsInstall`, or between the passes when `NeedsInstall` missed what probing found.
- First-run startup blocks for the full download duration (ADR-010's 3–10 min estimate) — the wait returns to where ADR-010 put it, before a usable UI, now under a progress splash.
- `runtime_error` / `tool_install_failed` survives in exactly one role: the structural-offline-failure-over-complete-install degradation.

## Alternatives Considered

- **Keep the background pass unconditionally (ADR-032 as-is).** Rejected: an app started without its managed tools is not a working app — search and document conversion are core agent capabilities, so the "running app with degraded features" is a dead UI for the primary workflows, and a first-run user has no context for a toast explaining it.
- **Non-blocking install plus a persistent banner in the main UI.** Rejected: the main UI is exactly as dead as under the background pass; a banner re-states the problem the splash already exists to solve, restores no capability, and adds a UI surface to maintain.
- **Gate the fatal path on an "online but broken" predicate** (block/exit only when connectivity is detected). Rejected: ADR-032 already rejected this predicate as unreliable (probe hiccups, quarantine, sandboxing make "is online" unprovable from the app); nothing here changes that assessment.
- **In-app Retry** (a dialog with a Retry button that re-runs the install inside the running app). Out of scope: a retry loop needs splash/UI state machinery and a re-entrant startup path that this change deliberately avoids; the native modal's Exit + relaunch already covers recovery, and the offline steady state is unaffected either way.
