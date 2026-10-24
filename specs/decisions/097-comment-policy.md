# ADR-097: Comment policy document

## Status

Accepted

## Context

Code comments had accumulated large prose blocks duplicating `specs/` content (dual bookkeeping that drifts independently), while unique cross-cutting invariants survived only as comments. Agents must internalize the comment rules on every coding task — before writing code — and an accepted ADR is both the wrong home for a living policy (accepted ADRs are immutable, per META.md, so every wording-level refinement would require a superseding ADR) and off the mandatory read path (an ADR deep in `decisions/` is discovered by number, not surfaced where coding tasks start).

## Decision

Create `specs/architecture/comment-policy.md` as the single source of truth for the comment policy — the A–D comment classifier (spec-duplicate → essence + link; unique cross-cutting invariant → spec first, then essence + link; local why → keep tightened; drift/noise → delete and fix the drift), the enum-in-place rule (short header comment plus per-variant inline comments; the enumerating block comment above the construct is forbidden), and the no-stretching rule (tightening prose is the only way to shorten a comment) — and surface it on the mandatory read path: a read-before-coding callout at the top of `specs/INDEX.md`, a Navigation-by-Task row, and a pointer from AGENTS.md's Specifications section.

This ADR records the fact of the document's creation and the reasoning behind the split; the policy text itself lives in the document and evolves there. Refining the policy's wording never requires a new ADR; reversing it structurally does.

## Consequences

Positive:

- The policy sits on the agent read path (AGENTS.md → INDEX.md top → the document), so it is read before code is written.
- The living policy text changes without superseding ADRs for refinements.
- The immutable ADR layer stays reserved for decisions, not rules text.

Negative:

- One extra document hop to reach the rules from this ADR.
- Three places reference the policy (this ADR, `specs/INDEX.md`, and AGENTS.md); all three must keep pointing at the document if it moves.

## Alternatives Considered

- **Keep the full policy inside this ADR**: rejected — accepted ADRs are immutable, so every refinement would spawn a new ADR, and an ADR is not on any pre-coding read path.
- **Enforce the policy in CI (linters)**: rejected for now — classification requires judgment (A vs C in particular); revisit if drift re-accumulates.
- **Directory-adjacent docs (a README per package)**: rejected — c0wrk's knowledge base is the `specs/` tree; a parallel doc layer recreates the drift problem.
