//go:build linux

package desktop

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"syscall"
)

// relaunchDetachedSelf spawns the current executable detached from this
// process's session so the relaunched app survives the quitting instance
// (same shape as the updater's relaunchApp). The child carries
// GpuRelaunchWaitEnvVar=1: mainImpl waits for this instance's advisory lock
// to release before starting up, so the spawn-then-quit ordering below
// cannot race the fresh instance into the single-instance relay exit.
func relaunchDetachedSelf(logger *slog.Logger) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving executable: %w", err)
	}
	cmd := exec.CommandContext(context.Background(), exe)
	cmd.Env = append(os.Environ(), GpuRelaunchWaitEnvVar+"=1")
	// Detach so the relaunched app survives this process's exit; stdio stays
	// unconnected — the child's crashlog.Install re-captures fd 1/2 into a
	// fresh stderr.log of its own.
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", exe, err)
	}
	// Release the child so it is not reaped when this process exits.
	if err := cmd.Process.Release(); err != nil {
		logger.Debug("could not release relaunched process (best-effort)", "error", err)
	}
	return nil
}
