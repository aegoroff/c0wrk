# ADR-090: Unified CLI argument handling (one strict parser in `core/cli`)

## Status

Accepted

## Context

Before this decision, argv interpretation was split and inconsistent:

- `main.go` had **no parser at all** — every argument was silently ignored, so
  `-h`, `-v` and typos alike just started the full desktop app. A user asking
  the binary for its version from a shell or script got a window instead.
- The self-update re-exec path was parsed by `ParseSelfUpdateFlags` in
  [`core/updater/installer.go`](../../core/updater/installer.go) — a **lenient**
  grammar that silently ignored everything it did not recognize (unknown flags,
  bare positionals, and companion flags appearing without `--self-update`).

A desktop binary receives argv from unsupervised sources: desktop launchers,
`wails dev`, legacy macOS LaunchServices `-psn_<serial>` process-serial
arguments, user shells. Under the old behavior, noise in argv could never
surface — but neither could intent: diagnostics were unreachable, and a typo
silently meant "run". Meanwhile the argv *grammar* — process plumbing, not
update-domain logic — lived inside the updater package, and the two-process
machine contract (`SelfUpdateArgs` in the parent → parse in the staging copy)
had no single pinned owner.

Forces:

- Diagnostics must be reachable without a running app: `-h`/`-v` must write to
  the real stdout/stderr, before crash capture redirects fd 1/2 into
  `<logDir>/stderr.log` (see [crash-logging](../domains/crash-logging.md)).
- A diagnostic exit must not touch app state — in particular it must precede
  the single-instance lock (ADR-075): a mistyped flag is not a competing app
  instance.
- The self-update re-exec process must never start the Wails lifecycle.
- The strictness posture of the codebase is fail-closed everywhere else; argv
  was the last silently-lenient input surface.
- [ADR-023](./023-auto-update.md) prose stays accurate either way — it says
  "`main.go` detects `--self-update` before the Wails lifecycle starts" and
  never names the retired updater-side parser, so it needs no amendment.

## Decision

One parser: [`core/cli`](../../core/cli/cli.go) owns the entire argv grammar,
and `main.go` calls `cli.Parse(os.Args[1:])` exactly once as its first action.
Six decisions, referenced as D1–D6 throughout [cli.md](../domains/cli.md):

**D1 — Strict, fail-closed grammar; unknown → exit 2.** Any argv element that
is not a recognized flag — an unknown flag, a bare positional, a `--flag=value`
form (never split), or a companion flag without `--self-update` — is an error
naming that argument (`unknown argument: <arg>`). `main.go` renders a parse
error as `c0wrk: <err>` + usage on stderr and exits 2. The process never
silently treats unrecognized input as "run".

**D2 — One parser, one home; self-update parsing absorbed.** The whole grammar
lives in `core/cli`, a pure package (stdlib + `core/version` only) importable
from both `main` and `core/updater` without a cycle. `ParseSelfUpdateFlags` and
`SelfUpdateOptions` are deleted from the updater; `ApplySelfUpdate` takes a
`cli.SelfUpdateRequest` with unchanged value semantics. The two-process machine
contract is pinned by `TestSelfUpdateArgsRoundTrip`: argv built by
`SelfUpdateArgs` → `cli.Parse` → action `ActionSelfUpdate` with a structurally
identical `SelfUpdateRequest`.

**D3 — `--self-update` is hidden plumbing.** Help lists only `-h/--help` and
`-v/--version`; the re-exec flag and its `--pid`/`--stage`/`--target`
companions are never advertised. The user-facing update flow is the in-app
Update UI (ADR-023); the flag exists only because a binary cannot replace
itself while running and is produced solely by `SelfUpdateArgs`.

**D4 — Hand-rolled scan over stdlib `flag`.** The grammar is a manual loop.
The `flag` package was rejected: it silently collects positionals in
`flag.Args()` (D1 would need a post-check anyway), it carries its own
usage-printing and exit side effects that do not match our streams/codes
contract, it has no first-wins action semantics, and it accepts
`--pid=<value>` and `-pid <value>` spellings a strict fixed grammar should not
negotiate. The grammar is seven flags; a loop is smaller than the machinery
needed to bend `flag` into strictness.

**D5 — Ordering contract in `main.go`.** The parse-and-dispatch runs before the
GPU-relaunch handover wait, before `AcquireSingleInstanceLock` (ADR-075), and
before `crashlog.Install`: self-update dispatch → CLI diagnostics →
GPU-relaunch wait → single-instance lock → crash capture. Exit codes are fixed:
0 for help/version and a successful self-update apply, 2 for a parse error,
1 for an `ApplySelfUpdate` failure (`c0wrk self-update failed: …`). The parse
error prefix changed from the old `c0wrk self-update:` to `c0wrk:` — the one
diagnostic-contract change; the text is human-facing (it lands in the updater's
captured `updater-output.log` on the re-exec path) and no code parses it.

**D6 — Dangling companions tightened.** The retired
`ParseSelfUpdateFlags` silently ignored companion flags when `--self-update`
was absent (as it ignored everything unrecognized). Under the unified grammar a
companion without `--self-update` is an unknown-argument error — the first one
seen is named, checked only after the whole line parses so a genuine
`--self-update` line is never misjudged. Companion value-syntax errors (a
missing or empty value, a non-positive `--pid`) still error immediately during
the scan, carried over from the updater parser: the old code rejected these
same inputs (empty `--stage`/`--target` post-scan), the unified grammar rejects
them at the flag itself.

## Consequences

Positive:

- One grammar, one test suite: 29 table-driven `Parse` cases plus the
  round-trip test pin the user-visible CLI behavior and the two-process
  self-update contract in a single place, testable without building the app.
- Help and version actually work on the shipped binary (they previously
  silently launched the app).
- Argv noise from unsupervised launchers becomes a diagnosable exit (the error
  names the argument) instead of a mysterious normal start; argv joins every
  other c0wrk input surface in the fail-closed posture.
- The updater package sheds process plumbing and keeps only update-domain
  logic; the import direction (`core/updater` → `core/cli`) is acyclic.

Negative / accepted trade-offs:

- **Strictness rejects externally injected argv.** Under `wails dev`, harness
  arguments reaching the binary — and legacy macOS LaunchServices
  `-psn_<serial>` arguments, where still injected — now exit 2 where they were
  previously swallowed. Accepted: both are development/legacy launch paths, not
  release paths, and the failure is self-explanatory on stderr.
- `-flag=value` syntax is not supported (separate-argument form only) — a
  deliberate strictness point on a fixed internal surface plus two info flags.
- The diagnostic exit path exits before the app is "up", so a wrapper script
  that ignored the exit code sees code 2 rather than a window; that is the
  contract, not a regression.

## Alternatives Considered

- **stdlib `flag`.** Rejected for the D4 reasons: silent positional
  collection, uncontrollable usage/exit side effects, no first-wins action
  semantics, lenient spelling negotiation — all of which would have to be
  re-tightened around the package.
- **Lenient policy (keep swallowing unknown arguments).** Rejected: it is what
  made `-h`/`-v` unreachable and typos silent. A desktop binary's argv comes
  from sources it does not control; silent "run" is the least useful outcome
  for every one of them, and it contradicts the codebase's fail-closed posture.
- **Separate parsers (keep the updater-side grammar, add a main-side one).**
  Rejected: two grammars over one argv would each need their own test suite,
  and the self-update machine contract — already the most fragile
  parent/child agreement in the app — could drift between them. Absorbing the
  updater grammar into `core/cli` leaves exactly one owner.

## Related

- [cli.md](../domains/cli.md) — the behavioral contract (types, flow, invariants, extension points)
- [ADR-023](./023-auto-update.md) — the re-exec dance consuming `--self-update`
- [ADR-075](./075-single-instance-lock.md) — the single-instance lock the ordering contract must precede
- [crash-logging.md](../domains/crash-logging.md) — the fd 1/2 redirect that motivates diagnostics-first ordering
