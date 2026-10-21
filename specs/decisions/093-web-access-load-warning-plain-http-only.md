# ADR-093: The web-access load exposure warning is plain-HTTP-only

## Status

Accepted → Narrows the load-warning leg of [ADR-090](./090-browser-web-access.md) decision 12's warn-only exposure model and the "every exposure warning stands unchanged" claim of [ADR-092](./092-web-access-tls.md) → Amends the load-path paragraph and the "exposure is the operator's warned decision" invariant of [domains/web-access.md](../domains/web-access.md); the exposure classification (`IsLoopbackBind`), the warn-only never-a-gate model, and every OTHER warning surface stand unchanged

## Context

A valid non-loopback bind on the web-access sidecar draws a network-exposure warning at config load ([ADR-090](./090-browser-web-access.md), decision 12). That load warning is the only exposure signal that travels the config pipeline into the UI: `normalizeWebAccess` → `LoadResult.LoadErrors` → `configLoadErrors` → `GetConfig().config_errors` → the "Configuration warning" banner at the top of the Settings modal. [ADR-092](./092-web-access-tls.md) made the warning's MESSAGE transport-aware ("traffic is unencrypted" vs "the transport is TLS-encrypted") but kept it firing for every non-loopback bind regardless of TLS.

With TLS shipped, that scope stopped matching the surface's semantics. The top banner reads as "the configuration is wrong — go fix it", and the operator who deliberately serves an encrypted LAN listener over a generated self-signed pair has a working, consciously configured setup: on every launch the banner re-announces a decision already made and persisted, training the user to dismiss the banner — the one surface real config errors (a broken section, a failed load) still need. The exposure itself never goes unseen in the TLS case: the Settings → Web Access section renders its own network-exposure banner from the same `IsLoopbackBind` classification (it already distinguishes the plain-HTTP and TLS-encrypted tiers), and the sidecar logs a transport-aware exposure warning at every start.

What remains genuinely banner-worthy is the combination: non-loopback bind AND TLS off — a network-reachable listener carrying the login page and the session token over plaintext.

## Decision

The config-load network-exposure warning fires only while the effective transport is plain HTTP:

1. **The gate is `!IsLoopbackBind(bind) && !tls.enabled`, evaluated AFTER the fail-soft resets.** `normalizeWebAccess` appends `webAccessLoopbackWarning(bind)` exactly when a valid non-loopback bind survived normalization with TLS off. A TLS-encrypted non-loopback bind loads warning-free with the section and the subsection preserved verbatim. A structurally invalid `tls` subsection resets alone (ADR-092 decision 2), so a non-loopback bind under a broken TLS lands truthfully on plain HTTP and draws the exposure warning on top of the subsection reset — the warning always describes the transport the sidecar will actually serve.

2. **The message names the transport and drops the TLS-encrypted variant.** The warning reads `web_access: bind %q is not loopback — the listener is network-accessible, traffic is plain HTTP without TLS`, aligned with the sidecar start log's plain-HTTP wording. With the TLS-encrypted case no longer reachable, `webAccessLoopbackWarning` loses its transport parameter; the start-log warning in `internal/webaccess` keeps its two-variant shape (it is a log line, not the config pipeline, and it stays transport-truthful for both tiers).

3. **Nothing else moves.** `IsLoopbackBind` remains a warning classification, never a validity gate; an encrypted non-loopback bind still saves as-is, starts as-is, and renders the section's network-exposure banner; the sidecar start log keeps warning on every non-loopback bind with the effective transport named. The plain-HTTP non-loopback combination surfaces through all three channels exactly as before — load warning (banner), section banner, start log.

## Consequences

Positive:

- The top "Configuration warning" banner regains its meaning: what it shows is an unresolved configuration problem, not a persisted operator decision — an encrypted LAN listener no longer cries wolf on every launch.
- The warning text is single-shaped (no transport branch), and the gate's evaluation order after the resets keeps it truthful in every reachable state, including the broken-TLS one.
- The spec's "three chances to see the consequence" story becomes tier-honest: plain HTTP keeps all three channels; TLS keeps the two that describe exposure without misusing the config-error channel.

Negative:

- The domain spec's "loads with exactly one exposure warning" promise is now conditional — an operator skimming only the invariant must read the TLS qualification to predict banner behavior (mitigated by the ADR-092/093 cross-links and the section banner remaining unconditional while enabled).
- ADR-092's "every exposure warning stands unchanged" is no longer literally true; the narrowing lives in this ADR (accepted ADRs are immutable), so the two documents must be read together.

## Alternatives Considered

- **Keep the load warning for every non-loopback bind (status quo)** — rejected: it permanently occupies the config-error banner with a deliberate setup, dulling the surface that actual misconfigurations need.
- **Also silence the sidecar start-log warning under TLS** — rejected: the log is not the config-error channel; a transport-truthful Warn on every non-loopback start costs nothing and keeps the exposure visible in diagnostics where operators debug reachability.
- **Demote the load warning for plain HTTP too (drop the banner leg entirely)** — rejected: token-over-plaintext on a LAN-reachable listener is exactly the "configuration deserves attention" case the banner exists for.
- **Add a `web_access.warned_on` ack flag to silence the banner after the first dismissal** — rejected: persisted acknowledgment state adds a config field and UI flow to save one banner; the TLS gate already separates the deliberate case from the actionable one without new state.
