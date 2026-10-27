# Code Review Round 2 — fix diff (c0wrk over ded83c02 + sp4rk ignore/)

Scope: the local changes produced by addressing the five SHOULD FIX findings of
`code-review.md` — the uncommitted c0wrk diff over `ded83c02` (15 files,
+601/−74) and the uncommitted sp4rk `ignore/` diff (`ignore.go` +146,
`ignore_test.go` +283; the `code-review.md` deletion is the review artifact's
relocation, not review scope).

Method: per-file diffs + full-file context reads; each of the five findings
re-checked at its cited location; the FE↔Go boundary re-cross-checked; the
service↔FS-form refactor of `core/vectorindex/prune.go` verified
behavior-preserving against the pre-refactor semantics (park/live-state
protection stays in the Service methods; the on-disk halves are shared).
Objective checks, all run for this round:

- `go test -count=1 ./backend ./backend/config ./core/vectorindex ./desktop` — all `ok`
  (backend 51s incl. the new disabled-cleanup tests, vectorindex 19s incl. the
  new FS-parity tests).
- sp4rk: `go test ./ignore/ -count=1` — `ok`; `golangci-lint run ./ignore/...` — 0 issues.
- c0wrk: `golangci-lint run ./backend/... ./core/vectorindex/...` — 0 issues;
  `gofmt -l` clean; `go build ./...` — ok.
- Frontend: `npx vitest run` over the five touched test files — 45/45 pass,
  zero stray console output; `npx tsc --noEmit` clean; `npx eslint` over the
  ten touched files clean.
- Mutation proof for finding [3]: with `parsePatternLines` moved back AFTER
  `load()` (the regression the test must catch),
  `TestResolverWithOptions_ExtraPatternsPruneWalk` FAILS with
  `compiled 3 patterns, want 1` — the assertion flips. Restored; suite green.

## Finding verification (each cited location re-checked)

1. **`disabled` ingestion (WAS [3]/SHOULD FIX)** — FIXED. `'disabled'` is in
   `VALID_VECTOR_STATES` (`frontend/src/types/events.ts`), in the
   `VectorIndexStatus['state']` union (`frontend/src/types/models.ts`), and
   `IndexingStatus` renders an explicit "Indexing off" pill (idle dots, no
   bar) via the `deriveDotStatus` disabled arm. `useVectorReindex` treats the
   state as terminal (disabled without spinner, own tooltip). Regression
   pinned by `useVectorIndexStatus.test.tsx` ("accepts the disabled (ADR-103)
   status on every ingestion path"), `IndexingStatus.test.tsx`, and
   `indexPhaseStatus.test.ts`.
2. **IndexingSettings sequencing (WAS [2])** — FIXED. Commits are serialized
   through a promise tail (`commitTailRef`), so arrival order at the backend's
   `saveMu` matches policy evolution; settle paths are identity-guarded
   (`policyRef.current === next`), and a guarded failure reverts to
   `persistedRef` — the last backend-confirmed policy — instead of the
   request's own optimistic predecessor. Pinned by two new tests: stale
   failure does not clobber a newer optimistic state (and the wire sees A
   before B), and the latest failure reverts to the last confirmed policy.
3. **Vacuous pruning test (WAS [3])** — FIXED. The test now asserts
   `len(r.patterns) == 1` (3 under regression — mutation-proven above) and
   `IgnoredByAIIgnore(vendored/doc.md) == false` (true under regression, when
   the nested scoped `vendored/**/*.md` rule is collected). Both flip.
4. **Error string convention (WAS [4])** — FIXED. `resolveIgnoreFiles` now
   returns `"ignore: IgnoreFiles entry %q must be %q or %q"` (lowercase start,
   package prefix; fix option (a) of the original report).
5. **Disabled-period cleanup (WAS [5])** — FIXED. `core/vectorindex` gained
   manager-free FS forms (`PruneMissingBranchDataFS` / `DeleteBranchDataFS`)
   sharing the exact on-disk halves with the Service methods; the three cited
   consumers (`deleteWorktreeVectorIndex`, the stale-branch sweep, the
   deleted-branch purge) fall back to them (worktrees: plain `os.RemoveAll` of
   the derived storage root — `DeleteProjectData`'s park-slot fixup is vacuous
   while parked) instead of skipping for the whole disabled period. Transient
   skips (still loading / embedder unavailable) keep their retry semantics.
   Pinned by `TestPruneAbsentBranchIndexes_RunsWhileDisabled`,
   `TestPurgeBranchIndexData_RunsWhileDisabled`,
   `TestDeleteWorktree_WipesManagedTreeIndexStorageWhileDisabled`, and the
   FS-parity tests in `core/vectorindex/prune_test.go`.

## Findings

**None at MUST FIX or SHOULD FIX level.**

CONSIDER-level notes (non-blocking):

1. `DeleteBranchData` computes `col`/`lex` and then `branchCollisionIdentities`
   recomputes them internally — two redundant sanitizations per call (pure
   string ops over a small slice; the shared-helper shape was chosen to keep
   the FS form's parameter list honest).
2. The disabled branches of the sweep and the purge duplicate the
   roots-enumeration loop shape of their manager paths (a shared
   `enumerateStorageRoots(viRoot)` helper could fold both).
3. The previously silent transient skip in `deleteWorktreeVectorIndex` now
   emits a Debug line (aligned with its two siblings) — a deliberate, logged
   behavior alignment, not a regression.

Areas re-reviewed with no further findings: the prune refactor (behavior
equivalence, fail-soft contracts, symlink-unlink semantics preserved), the
backend disabled fallbacks (races with `Disable` bounded to a best-effort Warn
identical to the pre-existing belt-and-braces removal failure path; `Disable`
clears the roots map before returning, so no live handles remain), the
IndexingSettings convergence semantics (store ⇄ form convergence traced for
every settle interleaving; unmount during an in-flight tail is a React-18+
no-op), and the `disabled` FE surface (gated panels, status pill, reindex
action all consistent with ADR-103's "explicit off state").
