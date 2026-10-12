package workspace

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/core/gittrust"
	"github.com/v0lka/c0wrk/internal/gittest"
)

// Trusted-repository spawn carve-out tests ─────────────────────────────────
//
// security.trusted_git_repos now opts a repository back into its own git
// configuration: core/workspace consults the process-wide core/gittrust
// registry (written by backend) and, for a trusted work-tree root, spawns
// raw git via sysproc.GitCmdRaw — no baseline overrides, no per-repo
// NeutralizingArgv, no GIT_EDITOR pin. Untrusted / hardened repositories keep
// the full neutralization (the existing canary suite). The registry is
// process-wide, so every test here clears it up front and on teardown.

// TestGitCmdInRepoTrustedRepoSpawnsRawGit plants a filter finding (which the
// hardened path would neutralize with -c filter.* overrides) and then trusts
// the repository: GitCmdInRepo must produce argv == [git, <args...>] with
// cmd.Env equal to the inherited parent environment plus only the
// GIT_OPTIONAL_LOCKS=0 watcher-loop pin, proving no baseline, no
// NeutralizingArgv and no GIT_EDITOR pin reach a trusted spawn.
func TestGitCmdInRepoTrustedRepoSpawnsRawGit(t *testing.T) {
	gittest.RequirePOSIXShell(t)
	gittrust.Clear()
	t.Cleanup(gittrust.Clear)

	f := newCanaryFixture(t, "hello\n")
	f.repo.AppendConfig(t, "[filter \"lfs\"]\n\tprocess = /tmp/evil-filter.sh\n\tclean = /tmp/evil-clean.sh\n\tsmudge = /tmp/evil-smudge.sh\n")
	f.requireFinding(GitConfigFindingFilter) // armed: hardened path would neutralize it

	root := f.repo.Root
	gittrust.Trust(root)

	cmd, err := GitCmdInRepo(f.ctx, root, "status", "--porcelain")
	if err != nil {
		t.Fatalf("GitCmdInRepo (trusted): %v", err)
	}

	want := []string{"git", "status", "--porcelain"}
	if !slices.Equal(cmd.Args, want) {
		t.Errorf("trusted argv = %q, want raw %q (no -c overrides)", cmd.Args, want)
	}
	if cmd.Env == nil {
		t.Fatal("trusted cmd.Env must carry the GIT_OPTIONAL_LOCKS pin, got nil")
	}
	if want := pinGitEnv(os.Environ(), "GIT_OPTIONAL_LOCKS", "0"); !slices.Equal(cmd.Env, want) {
		t.Errorf("trusted cmd.Env must be the parent environment plus the pin only:\n got %q\nwant %q", cmd.Env, want)
	}
	if slices.Contains(cmd.Env, "GIT_EDITOR=true") {
		t.Error("trusted cmd.Env must not carry the hardened GIT_EDITOR pin")
	}
	if cmd.Dir != root {
		t.Errorf("trusted cmd.Dir = %q, want %q", cmd.Dir, root)
	}

	// The raw path must still be functional.
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("trusted raw git status: %v", err)
	}
	if strings.TrimSpace(out.String()) != "" {
		t.Errorf("trusted raw git status unexpected output: %q", out.String())
	}
}

// TestGitCmdInRepoTrustedBySubdirectory verifies the trust decision keys on
// the work-tree root git discovers, not the exact path: a workspace opened at
// a subdirectory of a trusted repository still spawns raw git, matching the
// backend's "trust any path inside a repo trusts the whole repo" semantics.
func TestGitCmdInRepoTrustedBySubdirectory(t *testing.T) {
	gittest.RequirePOSIXShell(t)
	gittrust.Clear()
	t.Cleanup(gittrust.Clear)

	f := newCanaryFixture(t, "hello\n")
	gittrust.Trust(f.repo.Root)

	sub := filepath.Join(f.repo.Root, "nested", "deeper")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir subdir: %v", err)
	}

	cmd, err := GitCmdInRepo(f.ctx, sub, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		t.Fatalf("GitCmdInRepo (trusted subdir): %v", err)
	}
	want := []string{"git", "rev-parse", "--is-inside-work-tree"}
	if !slices.Equal(cmd.Args, want) {
		t.Errorf("trusted-subdir argv = %q, want raw %q", cmd.Args, want)
	}
	if !slices.Contains(cmd.Env, "GIT_OPTIONAL_LOCKS=0") {
		t.Errorf("trusted-subdir cmd.Env missing the GIT_OPTIONAL_LOCKS=0 pin: %q", cmd.Env)
	}
}

// TestGitCmdInRepoTrustedByLinkedWorktree pins the worktree unification: the
// trust decision keys on the repository trust root (ResolveGitTrustRoot —
// the MAIN work-tree root), so a repository trusted through its main
// checkout runs raw git from a linked worktree too. The hooks and common
// config a worktree commit executes are shared with the main checkout;
// keying on the worktree path instead would leave commits in a "trusted
// repository's" worktrees hardened, with the Commit-withheld dialog's Trust
// action looping on the already-stored root (the bug this fixes).
func TestGitCmdInRepoTrustedByLinkedWorktree(t *testing.T) {
	gittest.RequirePOSIXShell(t)
	gittrust.Clear()
	t.Cleanup(gittrust.Clear)

	repo, wt := worktreeFixture(t)
	// Trust recorded for the MAIN root — the form backend's TrustGitRepo
	// stores once normalized through ResolveGitTrustRoot.
	gittrust.Trust(repo.Root)

	cmd, err := GitCmdInRepo(context.Background(), wt, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		t.Fatalf("GitCmdInRepo (trusted worktree): %v", err)
	}
	want := []string{"git", "rev-parse", "--is-inside-work-tree"}
	if !slices.Equal(cmd.Args, want) {
		t.Errorf("trusted-worktree argv = %q, want raw %q (no -c overrides)", cmd.Args, want)
	}
	if !slices.Contains(cmd.Env, "GIT_OPTIONAL_LOCKS=0") {
		t.Errorf("trusted-worktree cmd.Env missing the GIT_OPTIONAL_LOCKS=0 pin: %q", cmd.Env)
	}
	if slices.Contains(cmd.Env, "GIT_EDITOR=true") {
		t.Error("trusted-worktree cmd.Env must not carry the hardened GIT_EDITOR pin")
	}
}

// TestGitCmdInRepoTrustedWorktreeLegacyEntry pins backward compatibility: an
// entry stored under the WORKTREE root itself (the pre-unification keying,
// written by older builds or by hand) still opts the worktree into raw git.
func TestGitCmdInRepoTrustedWorktreeLegacyEntry(t *testing.T) {
	gittest.RequirePOSIXShell(t)
	gittrust.Clear()
	t.Cleanup(gittrust.Clear)

	_, wt := worktreeFixture(t)
	gittrust.Trust(wt)

	cmd, err := GitCmdInRepo(context.Background(), wt, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		t.Fatalf("GitCmdInRepo (legacy worktree trust): %v", err)
	}
	want := []string{"git", "rev-parse", "--is-inside-work-tree"}
	if !slices.Equal(cmd.Args, want) {
		t.Errorf("legacy-trusted-worktree argv = %q, want raw %q", cmd.Args, want)
	}
}

// TestGitCmdInRepoTrustedRepoPinsOptionalLocks pins the one deliberate
// deviation trusted spawns keep from the raw parent environment:
// GIT_OPTIONAL_LOCKS=0, c0wrk's own watcher-loop prevention (fcb592bf) —
// read-only status refreshes must not opportunistically rewrite .git/index,
// or the fsnotify REMOVE+CREATE events re-trigger the very status refresh
// that rewrote it. The pin must override a user-exported GIT_OPTIONAL_LOCKS
// inherited from the parent environment, and the spawn must stay
// functional.
func TestGitCmdInRepoTrustedRepoPinsOptionalLocks(t *testing.T) {
	gittest.RequirePOSIXShell(t)
	gittrust.Clear()
	t.Cleanup(gittrust.Clear)
	// A user-exported value must not re-enable the opportunistic index write.
	t.Setenv("GIT_OPTIONAL_LOCKS", "1")

	f := newCanaryFixture(t, "hello\n")
	gittrust.Trust(f.repo.Root)

	cmd, err := GitCmdInRepo(f.ctx, f.repo.Root, "status", "--porcelain")
	if err != nil {
		t.Fatalf("GitCmdInRepo (trusted): %v", err)
	}
	if cmd.Env == nil {
		t.Fatal("trusted cmd.Env must carry the GIT_OPTIONAL_LOCKS pin, got nil")
	}
	if !slices.Contains(cmd.Env, "GIT_OPTIONAL_LOCKS=0") {
		t.Errorf("trusted cmd.Env missing the GIT_OPTIONAL_LOCKS=0 pin: %q", cmd.Env)
	}
	if want := pinGitEnv(os.Environ(), "GIT_OPTIONAL_LOCKS", "0"); !slices.Equal(cmd.Env, want) {
		t.Errorf("trusted cmd.Env must be the parent environment plus the pin only (inherited value overridden):\n got %q\nwant %q", cmd.Env, want)
	}

	// The pinned spawn stays functional.
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("trusted pinned git status: %v", err)
	}
	if strings.TrimSpace(out.String()) != "" {
		t.Errorf("trusted pinned git status unexpected output: %q", out.String())
	}
}

// TestGitCmdInRepoUntrustedRepoStaysHardened is the inverse pin: without a
// trust decision the same repository goes through the full neutralization —
// baseline -c overrides plus the NeutralizingArgv derived from a planted
// filter, with a hardened (GIT_EDITOR-pinned) environment.
func TestGitCmdInRepoUntrustedRepoStaysHardened(t *testing.T) {
	gittest.RequirePOSIXShell(t)
	gittrust.Clear()
	t.Cleanup(gittrust.Clear)

	f := newCanaryFixture(t, "hello\n")
	f.repo.AppendConfig(t, "[filter \"lfs\"]\n\tprocess = /tmp/evil-filter.sh\n\tclean = /tmp/evil-clean.sh\n\tsmudge = /tmp/evil-smudge.sh\n")
	f.requireFinding(GitConfigFindingFilter)

	cmd, err := GitCmdInRepo(f.ctx, f.repo.Root, "status", "--porcelain")
	if err != nil {
		t.Fatalf("GitCmdInRepo (untrusted): %v", err)
	}

	joined := strings.Join(cmd.Args, " ")
	for _, want := range []string{
		"-c core.fsmonitor=false",
		"-c commit.gpgsign=false",
		"-c filter.lfs.process=",
		"-c filter.lfs.clean=cat",
		"-c filter.lfs.smudge=cat",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("untrusted argv missing %q: %q", want, cmd.Args)
		}
	}
	if cmd.Env == nil {
		t.Fatal("untrusted cmd.Env must be hardened (non-nil)")
	}
	if !slices.Contains(cmd.Env, "GIT_EDITOR=true") {
		t.Errorf("untrusted cmd.Env missing GIT_EDITOR pin: %q", cmd.Env)
	}
}
