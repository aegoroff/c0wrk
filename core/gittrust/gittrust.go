// Package gittrust holds the process-wide set of git repository roots the
// user has explicitly trusted (security.trusted_git_repos).
//
// Backend is the sole writer: it mirrors its loaded config into the registry
// on startup and updates the registry on TrustGitRepo / RemoveTrustedGitRepo.
// core/workspace consults the registry (via IsTrusted) to decide whether a
// repository may spawn raw git — bypassing the sysproc baseline, the per-repo
// NeutralizingArgv scan, and the GIT_EDITOR pin — so a trusted repository
// behaves exactly as it would outside c0wrk, hooks/filters/signing included.
//
// The registry is deliberately process-wide and empty by default: nothing is
// trusted until backend populates it from config, so a fresh process (and any
// test that does not opt in) fails closed into the hardened spawn path.
package gittrust

import (
	"path/filepath"
	"sync"
)

var (
	mu    sync.RWMutex
	roots = make(map[string]struct{})
)

// spellings returns the cleaned path plus its symlink-resolved spelling
// (when different): the two forms a trust decision may be written or probed
// under. User-facing storage keeps the lexical form the user knows, while
// git's own worktree pointers carry canonical paths (macOS resolves
// /var → /private/var) — the registry treats the two as the same root so
// both sides of the spawn-layer decision agree regardless of which form the
// backend mirrored or the caller probes.
func spellings(root string) []string {
	cleaned := filepath.Clean(root)
	out := []string{cleaned}
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil && resolved != cleaned {
		out = append(out, resolved)
	}
	return out
}

// Trust adds root to the trusted set. Idempotent: trusting an already-trusted
// root is a no-op. Both spellings of root (lexical and symlink-resolved) are
// stored so either form of a later probe matches. The root is canonicalized
// with filepath.Clean before storage; callers are responsible for resolving
// the path to the repository trust root (the same normalization the trust
// list applies, see workspace.ResolveGitTrustRoot) so both sides of the
// comparison agree.
func Trust(root string) {
	root = filepath.Clean(root)
	if root == "" || root == "." || root == string(filepath.Separator) {
		return
	}
	mu.Lock()
	for _, spelling := range spellings(root) {
		roots[spelling] = struct{}{}
	}
	mu.Unlock()
}

// Untrust removes root from the trusted set (both spellings). Idempotent:
// removing an absent root is a no-op.
func Untrust(root string) {
	mu.Lock()
	for _, spelling := range spellings(root) {
		delete(roots, spelling)
	}
	mu.Unlock()
}

// IsTrusted reports whether root is present in the trusted set, matching
// either spelling (lexical or symlink-resolved).
func IsTrusted(root string) bool {
	mu.RLock()
	defer mu.RUnlock()
	for _, spelling := range spellings(root) {
		if _, ok := roots[spelling]; ok {
			return true
		}
	}
	return false
}

// Replace swaps the entire trusted set for the given roots (each stored
// under both spellings). It is the backend's mirror point: after loading or
// mutating security.trusted_git_repos, backend calls Replace with the full
// list so the registry never drifts from config. An empty or nil slice
// clears the set (fail-closed).
func Replace(trusted []string) {
	set := make(map[string]struct{}, 2*len(trusted))
	for _, r := range trusted {
		c := filepath.Clean(r)
		if c == "" || c == "." || c == string(filepath.Separator) {
			continue
		}
		for _, spelling := range spellings(c) {
			set[spelling] = struct{}{}
		}
	}
	mu.Lock()
	roots = set
	mu.Unlock()
}

// Snapshot returns a copy of the currently trusted roots (canonicalized,
// unsorted). Used by tests and diagnostics; the returned slice is safe to
// mutate without affecting the registry.
func Snapshot() []string {
	mu.RLock()
	out := make([]string, 0, len(roots))
	for r := range roots {
		out = append(out, r)
	}
	mu.RUnlock()
	return out
}

// Clear removes every trusted root. Intended for tests, which share the
// process-wide registry and must reset it so one test's trust decision never
// leaks into another.
func Clear() {
	mu.Lock()
	roots = make(map[string]struct{})
	mu.Unlock()
}
