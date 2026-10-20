# ADR-091: Web Access Stage 2 — a Configurable Bind with Warn-Only Exposure

## Status

Accepted

## Context

[ADR-090](./090-browser-web-access.md) shipped the browser sidecar as stage 1: the listener was pinned to `127.0.0.1`, the config loader fail-soft reset any non-loopback bind to "sidecar off", and `Save` refused to persist one — the shipped schema could not express a LAN listener. Decision 3 of ADR-090 explicitly deferred "LAN exposure with TLS" to a future ADR and shaped stage 1 so that decision could be additive.

The deferral left the motivating use case unserved: an operator who wants to reach the running app from a phone or a second machine on their own network has no supported path. Hard-coding the loopback pin protects users who never asked for exposure, but for the operator who does, refusing a valid configuration is not a security boundary — the same goal can be reached with an external reverse proxy c0wrk neither sees nor warns about. The question stage 2 answers: which parts of the listener address stay machine-decided, and which become the operator's decision — and how the app treats a decision it does not make for the user.

## Decision

1. **`web_access.bind` becomes operator-configurable, validated for syntax only.** The accepted value set is any IP literal — loopback (`127.0.0.1`, the `127.x.y.z` range, `::1`, IPv4-mapped forms), the unspecified wildcard (`0.0.0.0`, `::`), or a specific interface address (LAN or public), plus the exact name `localhost` — with `127.0.0.1` unchanged as the default (`config.DefaultWebAccessBind`). The predicates live in `backend/config`: `IsValidWebAccessBind` (the validity gate) and `IsLoopbackBind` (the exposure classification over already-valid binds).

2. **Exposure is warn-only; the gate keys on validity, never on loopback class.** A valid non-loopback bind is the operator's decision and survives the pipeline:
   - **Load** is fail-soft on invalid values only (unparseable bind, empty bind while enabled, out-of-range port): a visible warning is emitted and the section resets to the safe default state (sidecar off, loopback, auto port, ephemeral token). A valid non-loopback bind loads as-is with exactly one network-exposure warning (`web_access: bind %q is not loopback — the listener is network-accessible, traffic is unencrypted`); a reset lands on defaults, so reset-warning and exposure-warning never stack.
   - **Save** is fail-closed on the same invalid values only; a valid non-loopback section persists as-is.
   - **Sidecar start** (`internal/webaccess.New`) rejects invalid binds with the same messages (fail-closed) and warns once on a valid non-loopback bind (`webaccess: bind %q is not loopback — the listener is reachable beyond this machine, traffic is plain HTTP without TLS, the auth token is the only protection`); loopback binds stay silent.
   - **Settings UI** renders the network-exposure banner whenever an enabled section classifies non-loopback, in addition to the ordinary loopback reminder.

   The rationale for warn-only: whether a given network is trustworthy is knowledge the app does not have and cannot encode; refusing valid non-loopback binds does not remove the exposure, it removes the supported way to get it (and pushes operators to unobserved proxies). What the app can do — and now does at every layer where the decision becomes live (load, start, UI) — is keep the consequence visibly in front of the user who made it.

3. **No TLS in this stage.** The sidecar still serves plain HTTP; the session cookie still omits the `Secure` flag (recorded in code as a known limitation). On a non-loopback bind the per-launch (or pinned) token is the *only* protection: anyone on the network path can observe both the traffic and the token. TLS termination and flipping `Secure` on remain a future, separate decision ([ADR-090](./090-browser-web-access.md) decision 3's unfulfilled half).

4. **The connection pin grows the bind argument.** `SetWebAccessConnection(bind, port, token)` (still a `desktop.App` control RPC, off the web-dispatched surface) persists all three fields under the toggle's rollback discipline: an empty bind means the default `127.0.0.1`, validation reuses `config.ValidateWebAccessBind`/`ValidateWebAccessPort` (the exact load/save messages), the no-op check compares all three values, and the previous pin — the whole struct — is restored atomically when the persist or the hot restart fails.

5. **Browser-facing URLs never name a wildcard host.** `GetWebAccessInfo` renders the URL through `webAccessBrowserURL`: `0.0.0.0`/`::` are rewritten to `localhost` (no browser can open a wildcard literal), specific IPs pass through as-is, IPv6 is bracketed. The info also carries `configured_bind` (the persisted pin) and `bind_is_loopback` (the same `IsLoopbackBind` classification the load warning uses) so the UI keys its banners on the backend's own classification instead of re-deriving it.

## Consequences

Positive:

- The motivating use case — reaching the app from another device on the operator's own network — is a first-class, warned configuration instead of an unsupported workaround.
- The safe default is untouched: an absent section, `enabled: false`, or the default bind behave byte-identically to stage 1; the warning set only activates on a non-loopback choice.
- One validity predicate drives every layer (load, save, sidecar construction, pin RPC), so there is a single message vocabulary and a single classification source (`IsLoopbackBind`) shared with the UI.
- The stage-2 shape is exactly the additive path ADR-090 reserved: no new dependency, no new process, no dispatch-surface change, and the TLS decision stays open.

Negative:

- The config schema now *can* express a LAN listener — the stage-1 invariant is deliberately lifted. Exposure is one config value away, and the compensations are warnings plus the token, not a gate.
- On a non-loopback bind the surface is plain HTTP: an on-path observer (rogue host, compromised AP, ARP spoofer) can sniff the token and the whole session, then impersonate the operator with full remote control. The warnings state this; they cannot prevent it.
- The cookie's missing `Secure` flag, harmless on loopback, is part of the warned exposure on a LAN — a non-HTTP(S) passive observer can lift the session cookie directly.
- A one-time load warning plus the Settings banner may be missed (the banner renders only when the operator opens the Settings block); the startup `New` warning reaches only the log.
- Wildcard binds (`0.0.0.0`/`::`) listen on every interface, including ones the operator forgot exist (VPNs, docker bridges, tethered interfaces).

## Alternatives Considered

- **Keep the loopback-only gate and document an external reverse proxy** — rejected as the product answer: it moves exposure behind c0wrk's back (unwarned, unobserved, often without the token gate if the proxy forwards unauthenticated), while the sidecar path keeps one credential model and one warning surface. The proxy route remains available to operators who want TLS today.
- **An explicit opt-in key (e.g. `allow_non_loopback: true`) beside the bind** — rejected: two keys to express one decision, a stale-boolean drift risk (bind changed, flag not), and no added safety — the warning set must exist either way, since the flag only *restates* the bind's loopback class.
- **TLS termination in the sidecar now** — rejected for this stage: certificate provisioning (self-signed warnings, ACME, trust-store handling) is a scope of its own, and half-done TLS (untrusted self-signed) trains users through browser warning screens. Deferred as the future decision ADR-090 reserved.
- **Fail-closed on wildcard binds specifically** (require a specific interface address) — rejected: the wildcard is the idiomatic "every interface" answer on DHCP machines, and the specific-address pin breaks silently when the DHCP lease changes; the same exposure warning covers both.

## Related

- [ADR-090](./090-browser-web-access.md) — the parent decision whose deferred stage 2 this ADR implements
- [web-access.md](../domains/web-access.md) — the domain spec documenting the stage-2 behavior
- [SECURITY.md](../../SECURITY.md) — the attack-surface entry carrying the warn-only exposure model and its residual risks
