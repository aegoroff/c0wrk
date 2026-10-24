# Comment Policy

> **Read this document before writing or editing code.** Created by [ADR-097](../decisions/097-comment-policy.md), which records why the policy exists as a standalone document; the policy text itself lives here and evolves here.

## Context

Large prose comment blocks accumulated in code files that restate behavior already specified in `specs/`. This duplicates knowledge in two places that drift independently (a spec edit no longer reaches the code comment and vice versa), inflates every agent context window that opens the file, and buries the comments that carry genuinely local information. The reverse case also exists: unique cross-cutting invariants (the FE↔Go `/`-ref grammar parity, the goal/E2S mode-toggle lock asymmetry) survived only as code comments, appearing nowhere in `specs/`.

## The A–D comment classifier

Every multi-line comment block in touched code is classified into one of four classes and handled accordingly:

| Class | Meaning | Action |
| ----- | ------- | ------ |
| **A** | Duplicate of an existing spec | Replace with a 1–4 line essence + relative link into `specs/` |
| **B** | Unique cross-cutting invariant not yet specified | Document it in the fitting spec (`vibespec-update`, or `vibespec-create` for a new document — both Agent Skills), then leave a short essence + link |
| **C** | Local why (affects only this code: field contracts, non-obvious local mechanics) | Keep, tightened |
| **D** | Drift or noise (states something the code/spec contradicts, or restates the obvious) | Delete; fix the underlying drift (in spec or code) rather than rewording the comment |

The pilot pass applied the classifier to `frontend/src/lib/chatInputLock.ts`, `frontend/src/lib/parseReferences.ts`, `frontend/src/lib/modelProfilesTools.ts`, `frontend/src/api/fonts.ts`. Class-B outcomes of the pilot: the `/`-ref extraction grammar parity landed in `specs/domains/frontend/README.md` (chat input section), the execution-mode toggle lock in `specs/domains/frontend/rendering.md` ("Per-message selector lock", which also fixed that section's stale claim that all cluster controls unlock on a paused/failed task, and the adjacent input-lock matrix sentence missing `compacting`).

## Rules

- `specs/` is the source of truth for behavior, interfaces, and invariants; code comments carry pointers and local whys, not parallel specifications. The essence may legitimately be empty when the identifier and the body alone carry the contract and the spec names the construct by name — the comment is then just the godoc summary plus the link.
- A comment is as short as its meaning allows: every sentence must carry information the identifier, the body, the declaration comments of the constructs involved, or the linked spec does not already say.
- Comments that state a cross-cutting invariant (anything a second subsystem, a contract partner, or a future refactor depends on) belong in a spec, not in the file.
- Links use the spec path from the repo root (e.g. `specs/domains/prompt-suggestions.md`); per META.md, no line anchors.
- Prose reduction target for a de-duplication pass over touched files: large (≥3-line) comment blocks shrink by ≥70% in total.
- Enum-like constructs — TS string-literal union types, Go enum-style `const` blocks, and similar variant sets — are commented in place: a short header comment carries the shared context, and each variant carries its own inline comment (see the canonical shape below).
- Tightening prose is the only way to shorten a comment. Joining a multi-line comment's lines into one long single-line comment is forbidden: a stretched comment produces a disproportionately long line, defeats the wrapping the block already had, and reads worse in diffs and side-by-side views.
- A piece of state documents its own protocol exactly once, at the declaration (producer, consumer, synchronization rationale, sentinel semantics); each accessor's comment carries only its delta — what makes this accessor different. Assurance that restates the body ("mutex-guarded", "idempotent", "a no-op when empty") is noise, not documentation. Reference shape: the one-shot resume-request protocol on `Orchestrator` (`resumeRerouteRequested` / `resumeCompactionStrategy` and their accessors in `core/orchestrator.go`).
- A doc comment does not census callers. "Who calls this" is an observation about the present that goes stale at every new call site; state the requirement in modal form ("must be cleared whenever the armed task dies"), name the stable funnel if one exists ("via clearResumeRequests"), and leave enumeration to tooling (find-usages, call-graph search). A genuinely closed writer set may be stated as an invariant ("set by ToBuilderConfig only"), ideally enforced by a test.
- Tool directives and linter pragmas (`//go:build`, `//go:generate`, `//nolint`, `//eslint-disable-*` and their kin) are functional source, not prose: the classifier never applies to them, and they are never tightened, de-duplicated, or linked away.
- Generated code is out of scope: the classifier never applies to files a tool regenerates (`frontend/wailsjs/` and every other machine-generated output) — a comment there is owned by its generator.

### Canonical in-place shape for enum-like constructs

From `frontend/src/api/papers.ts`:

```ts
/** Outcome of running the literature helper for a paper; every non-`ok` value
 *  is an EXPLICIT degradation the UI must surface (the helper needs the
 *  network, a managed Python, and a resolvable seed). */
export type PaperLiteratureStatus =
  | 'ok' // carries the written JSON
  | 'offline' // could not reach OpenAlex/Crossref/arXiv (exit 2)
  | 'unresolved' // the seed could not be resolved (exit 1)
  | 'rate_limited' // a source kept returning HTTP 429 (exit 3)
  | 'no_python' // the managed Python interpreter is not installed
  | 'no_script' // the seeded literature.py helper is missing
  | 'no_seed' // the paper carries no identifier/title to seed with
  | 'error' // any other failure (carries the helper's stderr tail)
```

## Invariants

- `specs/` is always the single source of truth for behavior, interfaces, and invariants; code comments carry pointers and local whys.
- Every cross-cutting invariant lands in a spec first; the comment site keeps a 1–4 line essence plus a relative link.
- Every enum-like construct carries a short header comment plus one inline comment per variant, with each description adjacent to its variant.
- Tightening prose is the only way to shorten a comment.
- The ≥70% shrink target applies to de-duplication passes, not to everyday comments — a new C-class comment may legitimately be 3 lines.
- Every state protocol is documented once, at the declaration; accessor comments carry deltas only, and caller enumeration stays in tooling.

## Anti-Patterns

- **A block comment that enumerates variant descriptions above the construct** — it separates each description from its variant and drifts from the variant list whenever a variant is added, removed, or renamed.
- **A stretched comment (a multi-line block joined into one long single line)** — it produces a disproportionately long line, defeats the wrapping the block already had, and reads worse in diffs and side-by-side views.
- **A parallel specification in comments** — restating spec content in prose guarantees drift; replace with essence + link (class A).
- **Rewording a drifted comment instead of fixing the drift** — a comment that contradicts the code or the spec is fixed at the drift site (class D: in the spec or the code), not in the wording.
- **A caller census in a doc comment** — enumerating a callee's current callers (with per-site glosses) duplicates the call graph in prose and drifts at every new call site; replace with the modal-form contract plus the stable funnel name, and let tooling enumerate.
- **A protocol restated at every accessor** — the state's contract retold by each of its accessors, drowned in "safe to call / mutex-guarded / idempotent" boilerplate; the protocol lives once at the state declaration, each accessor carries only its delta.
- **A caller restating the callee's documented contract** — retelling the callee's doc comment at the call site duplicates the declaration's contract and drifts when the callee changes; the call site carries only its delta, the contract lives at the callee's declaration.
