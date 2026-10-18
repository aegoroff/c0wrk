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
// os/exec's /dev/null for a nil Stdin), and then exits the way a
// stdin-supervised server does when its stdin hits EOF: a marker on stdout
// followed by a non-zero exit code.
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
// The child is real process integration, so no synctest: readiness is a
// barrier (the child's own stdout lines), the stdin shape is asserted from
// the child's own report (deterministic), and only the absence-of-a-death
// check needs a bounded window — a watchdog for an exit that must NOT
// happen, the only honest form that assertion can take against a live
// process. Idempotent release is registered before any fatal assertion.
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

	// The bounded half: the child's only self-exit is stdin EOF, and the launch
	// keeps the pipe open, so it must stay alive on its own.
	select {
	case line, ok := <-lines:
		if !ok || line == "STDIN-EOF" {
			t.Fatal("the child exited on its own after readiness: its stdin hit EOF — the launch left it unsupervised")
		}
	case <-time.After(300 * time.Millisecond):
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
