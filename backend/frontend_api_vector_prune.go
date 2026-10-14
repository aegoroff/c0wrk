package backend

import (
	"strings"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/backend/project"
)

// Background stale-branch index cleanup. Every git branch a repository ever
// had leaves per-branch artifacts in the vector-index storage of the project
// checkout AND of every managed worktree whose tree ever indexed it: the
// chromem vector DB root under branches/, the bleve lexical directory under
// lexical/, and the branch's file-hash sidecar and content-less marker
// (core/vectorindex owns the layout). When the branch disappears from the
// local clone — merged and deleted on the remote, dropped by hand, worktree
// pruned — nothing ever re-opens those artifacts and they silently
// accumulate. On every project switch (the same fire-and-forget seam the
// auto-fetch funnel rides) a detached goroutine lists the repository's
// existing local branches once — refs/heads is shared by all worktrees, so
// the list covers branches checked out in managed trees — and sweeps every
// storage root of the project, deleting BOTH indexes of every branch that is
// absent. Silent by contract, exactly like the auto-fetch quiet-failure
// convention: Debug-only logs, no events, no toasts, never a step that can
// fail or delay the switch. Details: specs/domains/workspace.md.

// pruneAbsentBranchVectorIndexes removes the stored indexes of branches
// absent from the local clone, across the project checkout's vector-index
// storage root and every managed-worktree storage root under it. Best-effort
// and silent: every skip and failure path is a Debug log. Safe to call on a
// detached goroutine — the switch that fires it has already committed.
func (f *FrontendAPI) pruneAbsentBranchVectorIndexes(p *project.ProjectInfo) {
	if p == nil || p.IsNoProject {
		return
	}
	f.seedAcquire()
	// Single-flight: rapid toggles fire one sweep per switch; the running
	// sweep reads fresh git state, so a duplicate would only redo work.
	if !f.pruneStaleBranchesInFlight.CompareAndSwap(false, true) {
		return
	}
	defer f.pruneStaleBranchesInFlight.Store(false)

	viRoot := config.ProjectVectorIndexPath(f.agentDir, p.ID)
	branches, err := f.localBranchNames(p.WorkspacePath)
	if err != nil {
		f.log().Debug("vector index: stale-branch prune skipped: cannot list local branches",
			"project", p.ID, "error", err)
		return
	}

	// The registry accessor lazily creates (the same entry every vector
	// path uses), so it never returns nil; on a not-yet-wired factory
	// ManagerForCleanup reports no manager and the sweep is skipped below.
	mgr, disposable := f.vectorRootsRegistry().ManagerForCleanup()
	if mgr == nil {
		// Embedder still loading or unavailable: nothing is readable right
		// now. The next switch retries; the stale data is disk garbage
		// until then, not a correctness problem.
		f.log().Debug("vector index: stale-branch prune skipped: no vector manager available",
			"project", p.ID)
		return
	}
	if disposable {
		defer mgr.Shutdown()
	}

	roots := make([]string, 0, 8)
	roots = append(roots, viRoot)
	roots = append(roots, worktreeStorageNames(viRoot)...)
	for _, root := range roots {
		// PruneMissingBranchData is fail-soft internally (missing root is a
		// no-op, per-entry failures are Debug-logged and skipped); a zero
		// return needs no log — most switches prune nothing.
		if removed := mgr.Service().PruneMissingBranchData(root, branches); removed > 0 {
			f.log().Debug("vector index: pruned index data of branches absent from the local clone",
				"project", p.ID, "storage", root, "artifacts_removed", removed)
		}
	}
}

// localBranchNames lists the repository's existing local branch names
// (refs/heads — the set every worktree of the clone shares, checked-out
// branches included). An empty result is valid: a repository without refs
// keeps nothing.
func (f *FrontendAPI) localBranchNames(repoPath string) ([]string, error) {
	out, err := f.runGitCmd(repoPath, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			names = append(names, line)
		}
	}
	return names, nil
}

// purgeDeletedBranchIndexes resolves the active project with the same guards
// the git-panel RPCs apply and fires the targeted purge on a detached
// goroutine. No Project (and any unresolved project) has no storage to clean.
// The launch goes through the purgeBranchLaunchFn seam (nil in production —
// a plain `go`), which tests swap for a synchronous call.
func (f *FrontendAPI) purgeDeletedBranchIndexes(branch string) {
	path, id, err := f.activeGitProjectRoot()
	if err != nil {
		return
	}
	launch := f.purgeBranchLaunchFn
	if launch == nil {
		launch = func(fn func()) { go fn() }
	}
	launch(func() {
		f.purgeBranchIndexData(&project.ProjectInfo{ID: id, WorkspacePath: path}, branch)
	})
}

// purgeBranchIndexData removes the stored index data of a just-deleted branch
// — BOTH indexes plus the sidecar pair — across the project checkout's
// vector-index storage root and every managed-worktree storage root. It is
// the delete-triggered counterpart of pruneAbsentBranchVectorIndexes: a
// Git-panel branch deletion fires it so the branch's artifacts go away
// immediately instead of waiting for the next switch sweep.
//
// The surviving-branch list is taken AFTER the git deletion (the caller's
// ordering), because DeleteBranchData needs it for the lossy-sanitizer
// collision guard; a listing failure skips the whole purge with a Debug log —
// the next switch sweep catches the branch up, the purge never guesses.
//
// Deliberately NOT single-flighted, unlike the switch sweep: the purge is
// surgical and idempotent, and it must run even while a sweep is in flight —
// that sweep may have listed the refs before the deletion and would otherwise
// keep the branch's data until the next switch. Concurrent purge and sweep
// are safe (both fail-soft; DeleteBranchData's removals tolerate racing
// no-ops). Silent by the same contract as the sweep: Debug-only logs, no
// events, no toasts, never a failure path of the caller.
func (f *FrontendAPI) purgeBranchIndexData(p *project.ProjectInfo, branch string) {
	if p == nil || p.IsNoProject || branch == "" {
		return
	}
	f.seedAcquire()

	remaining, err := f.localBranchNames(p.WorkspacePath)
	if err != nil {
		f.log().Debug("vector index: deleted-branch purge skipped: cannot list remaining local branches",
			"project", p.ID, "branch", branch, "error", err)
		return
	}

	// The registry accessor lazily creates (the same entry every vector
	// path uses), so it never returns nil; on a not-yet-wired factory
	// ManagerForCleanup reports no manager and the purge is skipped below.
	mgr, disposable := f.vectorRootsRegistry().ManagerForCleanup()
	if mgr == nil {
		f.log().Debug("vector index: deleted-branch purge skipped: no vector manager available",
			"project", p.ID, "branch", branch)
		return
	}
	if disposable {
		defer mgr.Shutdown()
	}

	viRoot := config.ProjectVectorIndexPath(f.agentDir, p.ID)
	roots := make([]string, 0, 8)
	roots = append(roots, viRoot)
	roots = append(roots, worktreeStorageNames(viRoot)...)
	for _, root := range roots {
		// DeleteBranchData is fail-soft internally (missing root or
		// already-absent artifacts remove nothing; per-entry failures are
		// Debug-logged and skipped); a zero return needs no log — most
		// deletions purge data from only some of the storage roots.
		if removed := mgr.Service().DeleteBranchData(root, branch, remaining); removed > 0 {
			f.log().Debug("vector index: purged index data of the deleted branch",
				"project", p.ID, "branch", branch, "storage", root, "artifacts_removed", removed)
		}
	}
}
