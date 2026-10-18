package embeddedllm

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// helperStdinWatchEnv guards the child process
// TestSpawnOSServerKeepsTheChildsStdinAlive re-executes: a fake endpoint that
// reports readiness and then watches its own stdin — the supervision shape a
// llama-server build can ship (shut down when stdin reaches EOF), which is
// what os/exec's nil Stdin kills: the child then reads /dev/null and tears
// itself down within milliseconds of a successful launch.
const helperStdinWatchEnv = "EMBEDDEDLLM_HELPER_STDIN_WATCH"

// TestHelperWatchesStdin is not a test. It is the child process the spawn
// stdin test re-executes: it prints READY, reports what its stdin actually is
// (a pipe — the launch kept it open — or a character device, which is
// os/exec's /dev/null for a nil Stdin), acks a byte written through the
// supervisor's write end with a STDIN-LIVE line (the liveness probe the spawn
// test joins on), and then exits the way a stdin-supervised server does when
// its stdin hits EOF: a marker on stdout followed by a non-zero exit code.
func TestHelperWatchesStdin(t *testing.T) {
	if os.Getenv(helperStdinWatchEnv) != "1" {
		t.Skip("helper mode only; re-executed by TestSpawnOSServerKeepsTheChildsStdinAlive")
	}
	kind := "unknown"
	if info, err := os.Stdin.Stat(); err == nil {
		switch {
		case info.Mode()&os.ModeCharDevice != 0:
			kind = "chardev"
		case info.Mode()&os.ModeNamedPipe != 0:
			kind = "pipe"
		}
	}
	out := bufio.NewWriter(os.Stdout)
	_, _ = out.WriteString("READY\n")
	_, _ = out.WriteString("STDIN=" + kind + "\n")
	_ = out.Flush()
	buf := make([]byte, 1)
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 {
			// The parent's liveness probe reached us through the supervisor's
			// held write end — ack on stdout so its barrier can join.
			_, _ = out.WriteString("STDIN-LIVE\n")
			_ = out.Flush()
			continue
		}
		if err != nil {
			_, _ = out.WriteString("STDIN-EOF\n")
			_ = out.Flush()
			os.Exit(42)
		}
	}
}

// TestSpawnOSServerKeepsTheChildsStdinAlive drives the REAL production spawn
// path (spawnOSServer) with a fake endpoint that watches its own stdin. A
// launch that leaves the child's stdin at EOF — what os/exec's nil Stdin
// means (the null device) — lets a stdin-supervised child terminate itself
// the moment its main loop starts reading, reproducing the "ready, then gone
// within milliseconds" shape; this pins the contract that the supervisor
// keeps the child's stdin open for the child's whole lifetime.
//
// The child is real process integration, so no synctest, and no wall-clock
// window either: readiness is a barrier (the child's own stdout lines), the
// stdin shape is asserted from the child's own report (deterministic), and
// liveness is a bidirectional barrier — the test writes one byte through the
// supervisor's held stdin write end and joins on the child's STDIN-LIVE ack,
// which a launch that left stdin at EOF can never deliver. Idempotent release
// is registered before any fatal assertion.
func TestSpawnOSServerKeepsTheChildsStdinAlive(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatalf("resolving the test binary: %v", err)
	}
	proc, err := spawnOSServer(context.Background(), LaunchCommand{
		Binary: binary,
		Args:   []string{"-test.run=TestHelperWatchesStdin", "-test.v=false"},
		Env:    append(os.Environ(), helperStdinWatchEnv+"=1"),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("spawnOSServer: %v", err)
	}

	var once sync.Once
	var waitErr error
	stop := func() {
		once.Do(func() {
			_ = proc.Kill()
			waitErr = proc.Wait()
		})
	}
	t.Cleanup(stop)

	lines := make(chan string, 16)
	go func() {
		scanner := bufio.NewScanner(proc.Stdout())
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()

	readLine := func(what string) string {
		t.Helper()
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatalf("%s: the child's output ended before readiness (it exited on its own)", what)
			}
			return line
		case <-time.After(10 * time.Second):
			t.Fatalf("%s: timed out waiting for the child's output", what)
			return ""
		}
	}

	if line := readLine("readiness"); line != "READY" {
		t.Fatalf("first child line = %q, want READY", line)
	}
	// The deterministic half of the repro: what stdin did the launch give the
	// child? A chardev is os/exec's null device — the unsupervised launch this
	// test exists to catch.
	kind := strings.TrimPrefix(readLine("stdin report"), "STDIN=")
	if kind != "pipe" {
		t.Fatalf("the child's stdin is %q, want \"pipe\": the launch left it at the null device, so a stdin-supervised server tears itself down right after readiness", kind)
	}

	// The liveness half, as a deterministic barrier instead of a wall-clock
	// absence window: write one byte through the supervisor's own stdin write
	// end and join on the child's ack. A launch that left the stdin at EOF
	// ends the child before the byte can be delivered, so the probe write or
	// the ack read fails deterministically — no clock involved. The round trip
	// is also the stronger proof: the byte crosses the real pipe, so the
	// supervision contract holds end to end, not just for one bounded instant.
	stdin, ok := proc.(*osProcess)
	if !ok {
		t.Fatalf("spawnOSServer returned %T, want *osProcess", proc)
	}
	if _, err := stdin.stdinWrite.Write([]byte{0}); err != nil {
		t.Fatalf("writing the stdin liveness probe: the child's read end is gone — it exited on its own after readiness, so its stdin hit EOF and the launch left it unsupervised: %v", err)
	}
	if line := readLine("stdin liveness ack"); line != "STDIN-LIVE" {
		t.Fatalf("stdin liveness ack = %q, want \"STDIN-LIVE\": the child died before the probe arrived — its stdin hit EOF, the launch left it unsupervised", line)
	}

	stop()
	var exitErr *exec.ExitError
	if !errors.As(waitErr, &exitErr) {
		t.Fatalf("the child did not die from the kill: %v", waitErr)
	}
	if exitErr.ExitCode() != -1 && exitErr.ExitCode() != 42 && !strings.Contains(strings.ToLower(exitErr.String()), "terminated") {
		t.Fatalf("the child died from something other than the stop: %v", waitErr)
	}
}
