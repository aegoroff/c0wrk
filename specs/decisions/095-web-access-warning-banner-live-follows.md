# ADR-095: The config-load-warning banner follows the live web-access section

## Status

Accepted → Amends [ADR-093](./093-web-access-load-warning-plain-http-only.md) (the load warning's launch-frozen lifetime: the load pipeline stays the single STARTUP source, but the banner no longer freezes on that snapshot for the session) and the warning-surface accounting of [ADR-094](./094-web-access-tls-unusable-disables-sidecar.md) decision 2 (the unusable-TLS load warning is likewise live-refreshed by the same rule) → Amends the load paragraph and the channel accounting of [domains/web-access.md](../domains/web-access.md); ADR-093's plain-HTTP-only scope, ADR-094's disable-on-unusable semantics, and every warning TEXT stand unchanged

## Context

The "Configuration warning" banner at the top of the Settings modal renders `GetConfig().config_errors` — the `configLoadErrors` channel the load pipeline fills once at startup (`normalizeWebAccess` → `LoadResult.LoadErrors` → `SetConfigLoadState`). Nothing in the web-access control layer ever wrote that channel again: `SetWebAccessEnabled` / `SetWebAccessConnection` / `SetWebAccessTLS` mutate and persist the live section but leave the launch-time warning list untouched, and the banner component only re-reads on modal open and LLM saves. The observable symptom: an operator on a non-loopback bind flips the section to HTTPS — the warning that named "plain HTTP without TLS" stayed on screen for the rest of the session — and flipping back to plain HTTP did NOT bring it back. A launch-frozen snapshot presented as live config state is a staleness bug, not a designed behavior: the banner's one job is to say "your configuration, as it stands now, draws this warning".

## Decision

The banner follows the live section: every transport-affecting web-access write recomputes the section's warning contribution to the channel.

1. **One pure text source.** `config.WebAccessLoadWarnings(section)` is the state-only counterpart of the `normalizeWebAccess` warning tail, which now delegates to it — the load pipeline and the runtime recompute cannot drift in text or condition. It computes ONLY the exposure warning and ONLY from state (enabled, `IsLoopbackBind`, `tls.enabled`): the interactive writers preflight a TLS pair fail-closed (the TLS commit loads the pair, the enable flip refuses an unusable one), so a runtime-mutated section can never carry an unusable TLS; pair files that rot UNDER an already-persisted usable TLS stay owned by the section's `cert_status` banner and the mount backstop (ADR-094 decision 5). A disabled section warns nothing — no listener, nothing to expose.

2. **A surgical channel refresh, not a clear-all.** `FrontendAPILifecycle.RefreshWebAccessLoadWarnings` (the `SetConfigLoadState` precedent: on the Lifecycle, never the Wails RPC surface) drops every `web_access`-prefixed entry and appends the fresh set, under `configMu`. Warnings from every other load-pipeline section (autonomy migration, MCP timeouts, …) survive untouched — the exact inverse of the settings writers that nil the whole channel once their own section validated.

3. **The three transport-affecting RPCs wire it in — outside `webAccessMu`.** `SetWebAccessEnabled`, `SetWebAccessConnection` and `SetWebAccessTLS` become lock-then-body wrappers (`…Locked` bodies keep the `webAccessMu` discipline) that call the refresh AFTER releasing the mutex. The lock order is the point: `UpdateExperimentalFeatures` holds `configMu` while invoking the ADR-091 hook which takes `webAccessMu` — acquiring `configMu` under `webAccessMu` would close an ABBA cycle. The refresh is idempotent, so it also runs after refusals and rollbacks and simply reflects whatever state the attempt left. The token RPCs and `GenerateWebAccessCertificate` deliberately do not refresh: neither the credential nor the pair's paths can move the section's warning state. The load pipeline remains the single startup source — the `SetConfigLoadState` handoff is unchanged.

4. **The banner re-reads when the section moves.** The Settings → Web Access block gains `onConfigChanged`, fired after every successful transport-affecting RPC (the token writes stay out); `SettingsModal` threads its shared banner refresher (the same callback the LLM save path uses) through it, so the "Configuration warning" banner re-reads the channel within one RPC round-trip.

## Consequences

Positive:

- The banner states the truth about the current config: switching to HTTPS removes the plain-HTTP warning immediately, switching back (or re-binding onto a LAN address, or enabling the section) restores it, and disabling the section clears it — no restart, no modal reopen.
- Load and runtime warnings share one text source; a runtime recompute is byte-identical to what the next launch would produce from the same section state.
- Unrelated load warnings survive every web-access transition; the refresh can never erase another section's warning.

Negative:

- The desktop web-access layer now (indirectly) acquires `configMu` — the first configMu reach from this layer, safe only because it happens outside `webAccessMu`; the lock-order rule ("never configMu under webAccessMu") is a maintained invariant, not a structural guarantee.
- Web-access warnings are live-state while every other section's load warnings stay launch-frozen — an asymmetry that is correct (this is the only section with interactive transport flips) but must be remembered when reasoning about the channel.
- A refresh moves the section's entries to the END of the channel list; the list's order is not contractual, but the position within `config_errors` is not stable across a flip.

## Alternatives Considered

- **Clear-all on every web-access write (the embedded/LLM save pattern)** — rejected: it would wipe unrelated load warnings (autonomy migration, MCP timeouts) that no web-access action has any authority over.
- **Compute the web-access warnings fresh inside `GetConfig`** — rejected: the reader would filter-and-append per call, every other consumer of the channel would still see stale stored entries, and the banner would mix a live section view with a frozen rest-of-channel snapshot by accident of where the logic sits.
- **Refresh under `webAccessMu`** — rejected: `configMu` under `webAccessMu` closes the ABBA cycle with `UpdateExperimentalFeatures` (which holds `configMu` while taking `webAccessMu` through the ADR-091 hook).
- **Compose the banner text client-side from `GetWebAccessInfo`** — rejected: a second warning text source in the frontend; the backend channel stays the single authority the load pipeline already feeds.
- **Fire `onConfigChanged` only when the warning actually changed** — rejected: the frontend cannot know the recompute's outcome without a return channel; the recompute is state-only and idempotent, so unconditional is simpler and honest.
