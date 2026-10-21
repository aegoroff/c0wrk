# ADR-094: A requested-but-unusable TLS pair leaves the web-access sidecar down

## Status

Accepted → Supersedes the load-path leg of [ADR-092](./092-web-access-tls.md) decision 2 ("structural invalidity is fail-soft at load — the TLS subsection resets alone with a visible warning and the sidecar serves HTTP") and the broken-TLS clause of [ADR-093](./093-web-access-load-warning-plain-http-only.md) decision 1 ("a non-loopback bind under a broken TLS lands truthfully on plain HTTP and draws the exposure warning") → Amends the load paragraph, the `tls` yaml bullets, and the two transport invariants of [domains/web-access.md](../domains/web-access.md); ADR-092's never-downgrade-to-plaintext principle, ADR-093's plain-HTTP-only exposure warning, and every OTHER warning surface stand unchanged

## Context

[ADR-092](./092-web-access-tls.md) layered TLS validity exactly like the section's own: structural invalidity (`tls.enabled` with an empty cert or key path) reset the subsection ALONE at load and left the sidecar serving plain HTTP, while a configured-but-unreadable pair was deliberately kept out of the config layer ("the config layer never reads the files") and failed closed at sidecar mount — loudly in the log, invisibly in the UI. [ADR-093](./093-web-access-load-warning-plain-http-only.md) then made the load exposure warning truthful for the first shape: the broken TLS reset to plain HTTP, so the non-loopback exposure warning fired on the transport actually served.

Both shapes share one flaw the fallback exposes: the operator asked for TLS, and when TLS cannot be honored the answer was exactly the transport they did not ask for — a LAN-reachable plaintext listener standing in for a broken encrypted one, distinguished only by a warning the operator may never connect to the cause. The file-level shape was even quieter: the mount failure is a log-only Error line, and the enable flip could persist a switch-on section whose sidecar then failed silently — "the persisted switch stays on; the next launch retries" re-runs the same invisible loop every launch. The one channel built for "configuration cannot serve its purpose" — the load-warning pipeline into the top "Configuration warning" banner ([ADR-093](./093-web-access-load-warning-plain-http-only.md), Context) — never saw the broken pair, because the config layer refused to look at the files.

## Decision

A TLS subsection the sidecar cannot actually serve is one thing — UNUSABLE — and unusable TLS leaves no listener at all:

1. **Usability is one predicate: structure + load.** `webAccessTLSPairError` (exported as `config.ValidateWebAccessTLSPair`) runs the structural rule (an enabled subsection needs both paths configured) and then loads the pair with `crypto/tls.LoadX509KeyPair`. The config layer now READS the certificate files at load — the deliberate reversal of the never-reads-the-files doctrine. A disabled subsection is usable by definition: inert, exactly like the whole section when `web_access.enabled` is off.

2. **An unusable TLS turns the whole section off at load — never a plain-HTTP listener.** `normalizeWebAccess` appends one warning — `web_access.tls unusable (the sidecar stays disabled — a configured TLS is never downgraded to plain HTTP; fix the certificate pair or turn tls off, then enable web_access again): <reason>` — and sets `web_access.enabled = false`, preserving bind, port, token and the subsection itself verbatim. The operator's paths survive the reset, a disabled section is inert so the persisted shape stays valid, and recovery needs no re-entry of anything: fix the pair, flip the switch back on. The exposure warning cannot fire — there is no listener left to expose — so ADR-093's broken-TLS clause is gone by construction, not by another special case.

3. **The interactive boundaries fail closed on the same predicate.** `SetWebAccessTLS` already loads the pair before persisting; `SetWebAccessEnabled(true)` now preflights it too and refuses the flip with the load failure — nothing is mutated or persisted, so the toggle can never produce a persisted-on switch above a silently-down sidecar, and the operator learns the reason from the toggle's error instead of from a log line.

4. **The save gate stays structure-only.** Filesystem state must never brick an unrelated settings save: an enabled section with a structurally valid subsection pointing at absent files saves fine. The unusable pair is the load path's fail-soft concern and the interactive boundaries' fail-closed concern — never Save's.

5. **The mount backstop stands.** `New` keeps refusing a pair it cannot load (fail-closed, no plaintext downgrade), covering the one race the load path cannot see: files vanishing between load and mount. A running sidecar keeps serving from its in-memory certificate; a hot-restart that cannot reload the pair simply fails closed.

## Consequences

Positive:

- The one outcome a TLS configuration exists to prevent — a plaintext listener standing in for a broken encrypted one — is unreachable in every path: load, flip, mount.
- The broken-pair case now travels the config-error channel: the banner that says "go fix your configuration" carries the reason and the fix, instead of a startup log nobody is tailing.
- One rule, one predicate, one message shape cover both former cases (structural and file-level); the subsection survives the healing, so recovery is two operator actions with nothing re-typed.

Negative:

- The load path performs filesystem I/O plus x509 parsing on every load while TLS is enabled — two small file reads, deterministic, but a real (if negligible) cost the pure-data section previously never paid.
- A section healed to disabled is indistinguishable, in the Settings toggle, from a manually disabled one; the distinction lives only in the load warning (mitigated by the message naming the subsection, the reason, and the fix).
- ADR-092's fail-soft-at-load story and ADR-093's broken-TLS clause are no longer literally true; the supersession lives in this ADR (accepted ADRs are immutable), so the three documents must be read together.

## Alternatives Considered

- **Keep the ADR-092 subsection-alone reset (sidecar on plain HTTP)** — rejected: it is precisely the plaintext fallback this decision removes; the listener would serve unencrypted exactly when the operator asked for encryption.
- **Keep `enabled: true` and gate the mount on a separate effective-state flag (`tlsBlocked`)** — rejected: a second source of truth for "will the sidecar run" duplicates the master switch's job, leaks config-layer state into every gate reader, and renders in the UI as a switch that lies about the feature being on.
- **Make the save gate check the files (fail-closed at Save)** — rejected: filesystem state would brick every unrelated settings save over a broken certificate; a settings write must never depend on the pair's on-disk mood.
- **Leave the pair check at mount only (status quo for the file-level shape)** — rejected: an Error log is not an operator surface; the case would loop invisibly ("the persisted switch stays on; the next launch retries") with the banner — the one channel built for exactly this class of problem — silent.
