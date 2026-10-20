package updater

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// findInstallRoot resolves the .app bundle enclosing the running executable on
// macOS. The executable lives at <bundle>.app/Contents/MacOS/<name>; we climb
// ancestors until we find a directory whose suffix is ".app". A bare dev binary
// (no enclosing .app bundle) has no safe install root — the directory it was
// placed in may contain unrelated user files, and swapping that directory in
// place would displace them — so it is refused with ErrNonStandardLocation.
func findInstallRoot() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		// Fall back to the raw path if symlink resolution fails.
		exe = filepath.Clean(exe)
	}
	dir := filepath.Dir(exe)
	for d := dir; d != "/" && d != "."; d = filepath.Dir(d) {
		if filepath.Ext(d) == ".app" {
			return d, nil
		}
	}
	// No .app ancestor: refuse a bare-binary in-place update.
	return "", ErrNonStandardLocation
}

// hasInstallMarker reports whether root is a macOS .app bundle — the only
// install-root shape the updater swaps on this platform.
func hasInstallMarker(root string) bool {
	return filepath.Ext(root) == ".app"
}

// resolveNewTreePlatform locates the top-level *.app bundle inside the
// extraction directory. macOS update archives package exactly one .app.
func resolveNewTreePlatform(extractDir string) (string, error) {
	entries, err := os.ReadDir(extractDir)
	if err != nil {
		return "", fmt.Errorf("read extraction dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() && filepath.Ext(e.Name()) == ".app" {
			return filepath.Join(extractDir, e.Name()), nil
		}
	}
	return "", fmt.Errorf("no .app bundle found in extraction dir %s", extractDir)
}

// relaunchApp launches the freshly swapped .app bundle using `open -n` so the
// new process starts independently of the (exiting) updater.
func relaunchApp(targetDir string, log *slog.Logger) error {
	cmd := exec.CommandContext(context.Background(), "open", "-n", targetDir)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("open %s: %w (%s)", targetDir, err, string(out))
	}
	log.Info("relaunched app via open", "target", targetDir)
	return nil
}

// updaterStagingBase is the directory under which staging directories are
// created.
func updaterStagingBase() string { return os.TempDir() }

// normalizedTempRoot returns the cleaned OS temporary directory.
func normalizedTempRoot() (string, error) {
	return filepath.EvalSymlinks(os.TempDir())
}

// copyExecutable copies src to dst and marks it executable (Unix perms).
//
// The copy is then RE-SIGNED with an ad-hoc signature. The running binary's
// embedded signature is sealed against its bundle context (the CodeDirectory's
// special slots cover the bundle's Info.plist), so a bare copy outside the
// .app bundle fails macOS's exec-time validation: on recent macOS releases
// amfid rejects it with "The signature on the file is invalid" and SIGKILLs
// the process the moment exec(2) runs. Because the kill is asynchronous, the
// launching cmd.Start() still reports success and the self-update silently
// never happens (observed on macOS 27: the whole flow "succeeds" — quit,
// no swap, no relaunch). A fresh `codesign --force --sign -` on the copy
// produces a self-contained ad-hoc signature that validates as a bare
// executable, so the staged updater actually runs. This does not weaken the
// update integrity gate (ADR-023): the copied bytes are the SHA256-verified
// release's own bytes; only the signature wrapper is regenerated locally.
func copyExecutable(src, dst string) (string, error) {
	if err := copyFile(src, dst, 0o755); err != nil {
		return "", fmt.Errorf("copy staging updater: %w", err)
	}
	// A bounded context (not the app's): the caller has none to pass, and a
	// wedged codesign must not hang the apply path — a valid ad-hoc re-sign of
	// a ~80 MB Mach-O completes in well under a second.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "codesign", "--force", "--sign", "-", dst)
	if out, err := cmd.CombinedOutput(); err != nil {
		_ = os.Remove(dst)
		return "", fmt.Errorf("re-sign staging updater (codesign): %w (%s)", err, string(out))
	}
	return dst, nil
}

// processAlive reports whether the given PID currently has a live process, via
// signal 0.
func processAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		// ESRCH = no such process; EPERM = exists but not ours.
		return errors.Is(err, syscall.EPERM)
	}
	return true
}

// cleanupStaleUpdatersPlatform removes leftover c0wrk-update-* staging dirs in
// the OS temp directory from prior crashed runs.
func cleanupStaleUpdatersPlatform(log *slog.Logger) {
	cleanupTempGlobs(os.TempDir(), log, "c0wrk-update-*", "c0wrk-extract-*")
}
