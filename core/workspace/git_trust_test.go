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

// writeWorktreeOverlay enables extensions.worktreeConfig in the common config
// and writes the given content to the linked worktree's own config.worktree
// overlay (the per-worktree config source git reads live for that worktree).
func writeWorktreeOverlay(t *testing.T, repo *gittest.Repo, wt, content string) {
	t.Helper()
	repo.AppendConfig(t, "[extensions]\n\tworktreeConfig = true\n")
	wtGitDir := filepath.Join(evalDir(t, repo.Root), ".git", "worktrees", filepath.Base(wt))
	if err := os.MkdirAll(wtGitDir, 0o755); err != nil {
		t.Fatalf("mkdir worktree gitdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wtGitDir, "config.worktree"), []byte(content), 0o644); err != nil {
		t.Fatalf("write config.worktree: %v", err)
	}
}

// TestGitCmdInRepoTrustedWorktreeDirtyOverlayHardens pins the per-worktree
// overlay gate: the repository trust decision (keyed on the MAIN root, the
// form backend's TrustGitRepo stores) never bound a linked worktree's own
// config.worktree overlay — the one per-worktree config source git reads
// live — so a worktree whose overlay arms a dangerous key keeps the hardened
// baseline, which neutralizes the overlay's keys from the same scan, instead
// of executing configuration the user never reviewed. This is the hole the
// pre-unification model covered by keying trust on the worktree itself and
// the unification re-opened: without the gate the overlay runs raw on every
// worktree operation, plantable at any time after the trust decision with no
// detection path. Covers both the worktree root and a subdirectory inside it
// (both resolve to the same worktree gitdir and trust root).
func TestGitCmdInRepoTrustedWorktreeDirtyOverlayHardens(t *testing.T) {
	gittest.RequirePOSIXShell(t)
	gittrust.Clear()
	t.Cleanup(gittrust.Clear)

	repo, wt := worktreeFixture(t)
	writeWorktreeOverlay(t, repo, wt, "[core]\n\tfsmonitor = /tmp/evil-wt-fsmonitor.sh\n")

	// Trust recorded for the MAIN root: the snapshot scanned the main
	// checkout and never saw the overlay written above.
	gittrust.Trust(repo.Root)

	sub := filepath.Join(wt, "sub", "dir")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir worktree subdir: %v", err)
	}
	for _, path := range []string{wt, sub} {
		cmd, err := GitCmdInRepo(context.Background(), path, "status", "--porcelain")
		if err != nil {
			t.Fatalf("GitCmdInRepo (trusted worktree, dirty overlay, %s): %v", path, err)
		}
		joined := strings.Join(cmd.Args, " ")
		if !strings.Contains(joined, "-c core.fsmonitor=false") {
			t.Errorf("argv (%s) = %q, want the hardened baseline with the overlay's core.fsmonitor neutralized", path, cmd.Args)
		}
		if !slices.Contains(cmd.Env, "GIT_EDITOR=true") {
			t.Errorf("cmd.Env (%s) missing the hardened GIT_EDITOR pin: %q", path, cmd.Env)
		}
	}
}

// TestGitCmdInRepoTrustedWorktreeCleanOverlaySpawnsRaw pins the other side of
// the overlay gate: a worktree whose overlay carries nothing dangerous — the
// common case, git users legitimately keep per-worktree settings there —
// still runs raw git under the repository's trust decision. The gate costs
// one scan per operation, not the trust itself.
func TestGitCmdInRepoTrustedWorktreeCleanOverlaySpawnsRaw(t *testing.T) {
	gittest.RequirePOSIXShell(t)
	gittrust.Clear()
	t.Cleanup(gittrust.Clear)

	repo, wt := worktreeFixture(t)
	writeWorktreeOverlay(t, repo, wt, "[alias]\n\tst = status\n")
	gittrust.Trust(repo.Root)

	cmd, err := GitCmdInRepo(context.Background(), wt, "status", "--porcelain")
	if err != nil {
		t.Fatalf("GitCmdInRepo (trusted worktree, clean overlay): %v", err)
	}
	want := []string{"git", "status", "--porcelain"}
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

// TestGitCmdInRepoTrustedWorktreeOverlayIncludeHardens pins the include
// direction of the overlay gate: an include directive in the overlay points
// at a source the scanner deliberately does not follow (ADR-033), so its
// content can never be proven safe — the gate refuses the raw spawn (the
// ignored-include warning fires exactly once, from the scan that retained
// the overlay parse) and the hardened baseline runs instead.
func TestGitCmdInRepoTrustedWorktreeOverlayIncludeHardens(t *testing.T) {
	gittest.RequirePOSIXShell(t)
	gittrust.Clear()
	t.Cleanup(gittrust.Clear)

	repo, wt := worktreeFixture(t)
	writeWorktreeOverlay(t, repo, wt, "[include]\n\tpath = ./evil\n")
	gittrust.Trust(repo.Root)

	logger := expectedDiagnostics(t, ignoredIncludeDiagnostic(2, "./evil"))
	ctx := gitDiagnosticContext(context.Background(), logger)

	cmd, err := GitCmdInRepo(ctx, wt, "status", "--porcelain")
	if err != nil {
		t.Fatalf("GitCmdInRepo (trusted worktree, overlay include): %v", err)
	}
	joined := strings.Join(cmd.Args, " ")
	if !strings.Contains(joined, "-c core.fsmonitor=false") {
		t.Errorf("argv = %q, want the hardened baseline for an include-bearing overlay", cmd.Args)
	}
}

// TestWorktreeOverlayClean pins the overlay predicate the trusted-worktree
// spawn gate consults, per shape: no overlay in play is trivially clean; a
// benign overlay is clean; a dangerous overlay key, an overlay re-arming a
// common-config key with a new value, an include directive, a parse error,
// and a named-but-unretained overlay are not. Signing siblings follow the
// merged model's inert classification: dead without an armed commit.gpgsign
// anywhere, live (and gate-tripping) when the trusted common config arms it.
func TestWorktreeOverlayClean(t *testing.T) {
	t.Run("nil info", func(t *testing.T) {
		var info *GitConfigInfo
		if !info.WorktreeOverlayClean() {
			t.Error("nil info must be trivially clean")
		}
	})

	t.Run("no overlay in play", func(t *testing.T) {
		_, wt := worktreeFixture(t)
		info, err := ScanGitConfig(wt)
		if err != nil {
			t.Fatalf("ScanGitConfig: %v", err)
		}
		if info.WorktreeConfigPath != "" {
			t.Fatalf("WorktreeConfigPath = %q, want empty with the extension disabled", info.WorktreeConfigPath)
		}
		if !info.WorktreeOverlayClean() {
			t.Error("a scan without an overlay in play must be trivially clean")
		}
	})

	t.Run("benign overlay", func(t *testing.T) {
		repo, wt := worktreeFixture(t)
		writeWorktreeOverlay(t, repo, wt, "[alias]\n\tst = status\n")
		info, err := ScanGitConfig(wt)
		if err != nil {
			t.Fatalf("ScanGitConfig: %v", err)
		}
		if !info.WorktreeOverlayClean() {
			t.Error("a benign overlay must be clean")
		}
	})

	t.Run("dangerous overlay key", func(t *testing.T) {
		repo, wt := worktreeFixture(t)
		writeWorktreeOverlay(t, repo, wt, "[core]\n\tfsmonitor = /tmp/evil.sh\n")
		info, err := ScanGitConfig(wt)
		if err != nil {
			t.Fatalf("ScanGitConfig: %v", err)
		}
		if info.WorktreeOverlayClean() {
			t.Error("an overlay arming core.fsmonitor must not be clean")
		}
	})

	t.Run("overlay re-arms a common-config key", func(t *testing.T) {
		repo, wt := worktreeFixture(t)
		writeWorktreeOverlay(t, repo, wt, "[core]\n\tfsmonitor = /tmp/evil.sh\n")
		// The COMMON config also sets the key (a value the trust snapshot
		// may have bound); the overlay's value wins git's layering and must
		// gate the spawn even though the key itself was reviewed.
		cfg := filepath.Join(evalDir(t, repo.Root), ".git", "config")
		data, err := os.ReadFile(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(cfg, append([]byte("[core]\n\tfsmonitor = /tmp/safe.sh\n"), data...), 0o644); err != nil {
			t.Fatal(err)
		}
		info, err := ScanGitConfig(wt)
		if err != nil {
			t.Fatalf("ScanGitConfig: %v", err)
		}
		if info.WorktreeOverlayClean() {
			t.Error("an overlay re-arming a reviewed key with a new value must not be clean")
		}
	})

	t.Run("signing sibling without arming stays clean", func(t *testing.T) {
		repo, wt := worktreeFixture(t)
		writeWorktreeOverlay(t, repo, wt, "[user]\n\tsigningkey = ABCDEF\n")
		info, err := ScanGitConfig(wt)
		if err != nil {
			t.Fatalf("ScanGitConfig: %v", err)
		}
		if !info.WorktreeOverlayClean() {
			t.Error("a dead signing sibling (nothing arms commit.gpgsign) must stay clean")
		}
	})

	t.Run("signing sibling with common-config arming gates", func(t *testing.T) {
		repo, wt := worktreeFixture(t)
		writeWorktreeOverlay(t, repo, wt, "[user]\n\tsigningkey = ABCDEF\n")
		// The trusted common config arms signing: the overlay's gpg.program
		// would EXECUTE as the signing program, so the sibling is live.
		repo.AppendConfig(t, "[commit]\n\tgpgsign = true\n")
		info, err := ScanGitConfig(wt)
		if err != nil {
			t.Fatalf("ScanGitConfig: %v", err)
		}
		if info.WorktreeOverlayClean() {
			t.Error("an overlay signing sibling under an armed commit.gpgsign must not be clean")
		}
	})

	t.Run("overlay include directive", func(t *testing.T) {
		repo, wt := worktreeFixture(t)
		writeWorktreeOverlay(t, repo, wt, "[include]\n\tpath = ./evil\n")
		logger := expectedDiagnostics(t, ignoredIncludeDiagnostic(2, "./evil"))
		info, err := ScanGitConfig(wt, logger)
		if err != nil {
			t.Fatalf("ScanGitConfig: %v", err)
		}
		if info.WorktreeOverlayClean() {
			t.Error("an include-bearing overlay must not be clean (the target is never read)")
		}
	})

	t.Run("overlay parse error", func(t *testing.T) {
		repo, wt := worktreeFixture(t)
		writeWorktreeOverlay(t, repo, wt, "[core\n\tfsmonitor = x\n")
		info, err := ScanGitConfig(wt)
		if err != nil {
			t.Fatalf("ScanGitConfig: %v", err)
		}
		if info.WorktreeOverlayClean() {
			t.Error("a malformed overlay must not be clean (fail closed)")
		}
	})

	t.Run("named overlay not retained", func(t *testing.T) {
		info := &GitConfigInfo{WorktreeConfigPath: "/some/config.worktree"}
		if info.WorktreeOverlayClean() {
			t.Error("an overlay the scan did not retain cannot be proven safe (fail closed)")
		}
	})
}
