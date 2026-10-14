package vectorindex

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Per-branch artifact pruning. The ADR-064 storage layout gives every git
// branch its own on-disk artifacts under a project's (or a managed worktree's)
// vector-index storage root:
//
//	<root>/branches/<collectionName(branch)>/   chromem DB root — the VECTOR index
//	<root>/lexical/<lexicalBranchDirName>/      bleve index — the LEXICAL index
//	<root>/file_hashes_<collectionName>.json    per-branch file-hash sidecar
//	<root>/contentless_<collectionName>.done    per-branch migration marker
//
// Branches disappear from the local clone over time (merged and deleted on the
// remote, dropped by hand, worktrees pruned), but their index artifacts are
// never re-opened and silently accumulate. PruneMissingBranchData removes BOTH
// indexes — the chromem vector DB root and the bleve lexical directory — plus
// the branch's sidecar and marker for every branch that is absent from the
// caller-supplied list of the repository's existing local branches. The backend
// calls it in the background on every project switch; the caller enumerates the
// storage roots (the project checkout's own root plus every managed worktree's
// root) and lists the branches once per repository with
// `git for-each-ref refs/heads`. DeleteBranchData is the targeted counterpart:
// the backend fires it right after a Git-panel branch deletion, so the deleted
// branch's artifacts are removed immediately instead of waiting for the next
// switch sweep.

const (
	// lexicalDirName is the storage subdirectory holding the per-branch
	// bleve lexical indexes. Mirrors the literal used by the lexical open
	// path (AddDocuments / SwitchBranch).
	lexicalDirName = "lexical"
)

// Synthetic ("branch-less") identities that are never pruned, computed from
// the same sanitizers the layout keys on so they cannot drift:
//
//   - DefaultBranch is the branch identity used when branch detection has no
//     git repository to ask (non-git workspaces, detection failure), and a
//     real branch literally named "default" sanitizes to the same identities.
//     The two are indistinguishable on disk, so the identity is kept.
//   - orphanBranchRootName (branches/_orphan) is a deliberate design decision
//     of the legacy-layout migration: kept on disk, never loaded.
var (
	defaultSyntheticCollectionName = collectionName(DefaultBranch)
	defaultSyntheticLexicalDirName = lexicalBranchDirName(DefaultBranch)
)

// PruneMissingBranchData removes the per-branch artifacts of every branch that
// is absent from keepBranches under the storage root projectPath, returning
// how many on-disk artifacts were removed. It deletes, per absent branch, BOTH
// indexes (the chromem vector DB root under branches/ and the bleve lexical
// directory under lexical/) plus the branch's file-hash sidecar and
// content-less marker. The content-addressed embedding cache is
// branch-independent by design and is never touched.
//
// Keeping is decided on the sanitized identities, not on recovered branch
// names: the branch ⇒ directory mapping is lossy, so a directory is removed
// only when NO branch in keepBranches (and no protected identity) maps to it —
// a sanitized-name collision between a deleted and an existing branch keeps
// the shared directory. Three identities are always kept: the synthetic
// DefaultBranch ("branch_default" collection / "default" lexical dir, which a
// real branch named "default" also maps to), the legacy-migration orphan root
// (branches/_orphan), and — defensively — the ACTIVE branch of a live state
// rooted at projectPath, whose artifacts the running service may currently
// hold open even when the caller's branch list missed it (a checked-out
// branch cannot normally be absent, but the prune must stay harmless if the
// refs were changed underneath it).
//
// Parked states whose branch is absent are dropped from the park LRU with
// their handles released (mirroring DeleteProjectData: the migration is
// cancelled, the sidecar is deliberately NOT flushed — the directory is about
// to disappear — and migrationWG bookkeeping stays with Close). Parked states
// of other branches, other projects and other storage paths are untouched.
//
// The operation is fail-soft and best-effort: a missing storage root is a
// silent no-op that creates nothing; unreadable directories and per-entry
// removal failures (a concurrent open handle on Windows, a racing removal)
// are logged at Debug and skipped, so the next switch retries them. Callers
// treat the returned count as advisory telemetry only. Safe to call
// concurrently with a live service on the same storage: only artifacts of
// absent branches are removed, and a live service holds open handles solely
// for branches that were checked out at some point — all of which stay in the
// keep set unless deleted from the refs after the fact (the same graceful
// degradation a manual `git branch -D` exhibits today).
func (s *Service) PruneMissingBranchData(projectPath string, keepBranches []string) int {
	if projectPath == "" {
		return 0
	}
	target := filepath.Clean(projectPath)

	keepCollections := make(map[string]struct{}, len(keepBranches)+2)
	keepLexical := make(map[string]struct{}, len(keepBranches)+2)
	keepCollections[defaultSyntheticCollectionName] = struct{}{}
	keepLexical[defaultSyntheticLexicalDirName] = struct{}{}
	for _, branch := range keepBranches {
		if branch == "" {
			continue
		}
		keepCollections[collectionName(branch)] = struct{}{}
		keepLexical[lexicalBranchDirName(branch)] = struct{}{}
	}

	// Protect the active branch of a live state rooted at target, and drop
	// parked states whose branch is being pruned (their chromem DB and bleve
	// handles must not outlive the directories they point at).
	s.mu.Lock()
	if cur := s.current; cur != nil && cur.projectPath != "" &&
		filepath.Clean(cur.projectPath) == target && cur.currentBranch != "" {
		keepCollections[collectionName(cur.currentBranch)] = struct{}{}
		keepLexical[lexicalBranchDirName(cur.currentBranch)] = struct{}{}
	}
	kept := s.parked[:0]
	for _, ps := range s.parked {
		_, branchKept := keepCollections[collectionName(ps.currentBranch)]
		stale := ps.projectPath != "" && filepath.Clean(ps.projectPath) == target &&
			ps.currentBranch != "" && !branchKept
		if stale {
			if ps.migrationCancel != nil {
				ps.migrationCancel()
				ps.migrationCancel = nil
			}
			// No sidecar flush: the directory is about to be removed
			// (the same deliberate skip DeleteProjectData makes).
			s.closeStateLocked(ps)
			continue
		}
		kept = append(kept, ps)
	}
	s.parked = kept
	s.mu.Unlock()

	removed := 0
	// The vector index: per-branch chromem DB roots. The orphan root is the
	// migration's own keep-forever pseudo-branch.
	removed += s.pruneMissingEntries(filepath.Join(target, branchRootsDirName),
		keepCollections, orphanBranchRootName)
	// The lexical index: per-branch bleve directories. The synthetic default
	// directory is already in keepLexical; no extra protected name.
	removed += s.pruneMissingEntries(filepath.Join(target, lexicalDirName),
		keepLexical, "")
	// The per-branch files at the storage root: file-hash sidecars and
	// content-less migration markers.
	removed += s.pruneMissingSidecars(target, keepCollections)
	return removed
}

// DeleteBranchData removes the per-branch artifacts of exactly one branch
// under the storage root projectPath — BOTH indexes (the chromem vector DB
// root under branches/ and the bleve lexical directory under lexical/) plus
// the branch's file-hash sidecar and content-less marker — returning how many
// on-disk artifacts were removed. It is the targeted counterpart of
// PruneMissingBranchData: the backend fires it right after a git branch
// deletion made through the Git panel, so the branch's data is cleaned up
// immediately instead of waiting for the next project-switch sweep.
//
// branch is the branch's short name (refs/heads spelling). The caller passes
// the repository's surviving local branches (listed AFTER the deletion) so
// the lossy branch ⇒ directory mapping can be respected: when a surviving
// branch sanitizes to the same collection or lexical identity, that shared
// artifact is kept — the collision rule of PruneMissingBranchData, applied
// per identity (the collection identity also guards the sidecar pair, which
// is keyed on it). A stale list that still names the deleted branch is
// filtered out defensively.
//
// Three identities are never touched: the synthetic DefaultBranch (a real
// branch literally named "default" sanitizes to it and is indistinguishable
// on disk), the legacy-migration orphan root, and — defensively — the branch
// of a live state rooted at projectPath (git refuses deleting a checked-out
// branch, but the refs may have changed underneath the service). Parked
// states of the deleted branch rooted at projectPath leave the park LRU with
// their handles released (no sidecar flush, mirroring both the sweep and
// DeleteProjectData), so a later return never revives a state whose
// directories are gone.
//
// The operation is fail-soft, best-effort and idempotent: a missing storage
// root or already-absent artifact removes nothing (and is not counted),
// per-entry removal failures are logged at Debug and skipped, and the
// embedding cache is never touched (branch-independent by design). Safe to
// call concurrently with the sweep or a live service on the same storage —
// the same graceful degradation documented on PruneMissingBranchData.
func (s *Service) DeleteBranchData(projectPath, branch string, remainingBranches []string) int {
	if projectPath == "" || branch == "" {
		return 0
	}
	target := filepath.Clean(projectPath)

	col := collectionName(branch)
	lex := lexicalBranchDirName(branch)
	if col == defaultSyntheticCollectionName || lex == defaultSyntheticLexicalDirName ||
		col == orphanBranchRootName {
		// Indistinguishable from an identity the layout protects.
		return 0
	}

	// Collision guard, per identity: an artifact shared with a surviving
	// branch stays (the deleted branch itself is filtered out, so a stale
	// caller-side list cannot turn the purge into a silent no-op).
	sharedCollection, sharedLexical := false, false
	for _, other := range remainingBranches {
		if other == "" || other == branch {
			continue
		}
		if collectionName(other) == col {
			sharedCollection = true
		}
		if lexicalBranchDirName(other) == lex {
			sharedLexical = true
		}
	}

	// Live-state protection plus park eviction under one lock: the current
	// state's branch must survive the purge, and parked states of the
	// deleted branch must not hold open handles (or get revived later) once
	// their directories are removed.
	s.mu.Lock()
	active := false
	if cur := s.current; cur != nil && cur.projectPath != "" &&
		filepath.Clean(cur.projectPath) == target && cur.currentBranch == branch {
		active = true
	}
	kept := s.parked[:0]
	for _, ps := range s.parked {
		stale := ps.projectPath != "" && filepath.Clean(ps.projectPath) == target &&
			ps.currentBranch == branch
		if stale {
			if ps.migrationCancel != nil {
				ps.migrationCancel()
				ps.migrationCancel = nil
			}
			// No sidecar flush: the directory is about to be removed
			// (the same deliberate skip DeleteProjectData makes).
			s.closeStateLocked(ps)
			continue
		}
		kept = append(kept, ps)
	}
	s.parked = kept
	s.mu.Unlock()
	if active {
		return 0
	}

	removed := 0
	if !sharedCollection {
		removed += s.removeBranchArtifact(filepath.Join(target, branchRootsDirName, col))
		removed += s.removeBranchArtifact(filepath.Join(target, "file_hashes_"+col+".json"))
		removed += s.removeBranchArtifact(filepath.Join(target, "contentless_"+col+".done"))
	}
	if !sharedLexical {
		removed += s.removeBranchArtifact(filepath.Join(target, lexicalDirName, lex))
	}
	return removed
}

// pruneMissingEntries removes every directory entry of dir whose name is not
// in keep (and not the protected pseudo-name, when non-empty). Only real
// directories are considered: both laid-out subtrees hold nothing but
// per-branch directories, and a conservative scope never removes a name the
// layout does not document. A missing dir is a silent no-op that creates
// nothing; other read failures and per-entry removal failures are Debug-logged
// and skipped. Returns how many entries were removed.
func (s *Service) pruneMissingEntries(dir string, keep map[string]struct{}, protected string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.logger.Debug("vector index: branch prune cannot read directory",
				"dir", dir, "error", err)
		}
		return 0
	}
	removed := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if name == protected {
			continue
		}
		if _, ok := keep[name]; ok {
			continue
		}
		path := filepath.Join(dir, name)
		// RemoveAll over a directory entry cannot escape dir (name is a
		// single ReadDir segment) and unlinks a planted symlink instead of
		// traversing into its target.
		if err := os.RemoveAll(path); err != nil {
			s.logger.Debug("vector index: branch prune could not remove stale branch directory",
				"path", path, "error", err)
			continue
		}
		removed++
	}
	return removed
}

// pruneMissingSidecars removes the per-branch files sitting directly at the
// storage root — file_hashes_<collectionName>.json and
// contentless_<collectionName>.done — for collection identities that are not
// in keep. A name qualifies only in the exact shape the layout writes (known
// prefix and suffix around a collectionName-shaped identity, see
// isSafeBranchRootName); anything else is not a per-branch sidecar and is
// left alone. Returns how many files were removed.
func (s *Service) pruneMissingSidecars(root string, keep map[string]struct{}) int {
	entries, err := os.ReadDir(root)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.logger.Debug("vector index: branch prune cannot read storage root",
				"dir", root, "error", err)
		}
		return 0
	}
	removed := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		identity, ok := sidecarCollectionIdentity(entry.Name())
		if !ok {
			continue
		}
		if _, ok := keep[identity]; ok {
			continue
		}
		path := filepath.Join(root, entry.Name())
		if err := os.Remove(path); err != nil {
			s.logger.Debug("vector index: branch prune could not remove stale sidecar",
				"path", path, "error", err)
			continue
		}
		removed++
	}
	return removed
}

// sidecarCollectionIdentity parses a storage-root file name into the
// collection identity it belongs to, reporting whether the name matches the
// exact sidecar shape file_hashes_<collectionName>.json or
// contentless_<collectionName>.done with a well-formed collection identity.
func sidecarCollectionIdentity(name string) (string, bool) {
	for _, shape := range []struct{ prefix, suffix string }{
		{"file_hashes_", ".json"},
		{"contentless_", ".done"},
	} {
		rest, ok := strings.CutPrefix(name, shape.prefix)
		if !ok {
			continue
		}
		rest, ok = strings.CutSuffix(rest, shape.suffix)
		if !ok {
			continue
		}
		if !isSafeBranchRootName(rest) {
			return "", false
		}
		return rest, true
	}
	return "", false
}

// removeBranchArtifact removes one per-branch artifact of DeleteBranchData —
// a directory (the chromem branch root or the bleve lexical directory) or a
// file (a sidecar). An already-absent path removes nothing and is not
// counted, so repeated purges stay idempotent in their telemetry too;
// RemoveAll unlinks a planted symlink instead of traversing into its target
// (the path is joined from single sanitized segments, so it cannot escape the
// storage root). Failures are Debug-logged and skipped. Reports whether an
// on-disk artifact was removed.
func (s *Service) removeBranchArtifact(path string) int {
	if _, err := os.Lstat(path); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.logger.Debug("vector index: branch data removal cannot stat artifact",
				"path", path, "error", err)
		}
		return 0
	}
	if err := os.RemoveAll(path); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.logger.Debug("vector index: branch data removal could not remove artifact",
				"path", path, "error", err)
			return 0
		}
	}
	return 1
}
