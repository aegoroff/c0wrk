package desktop

import (
	"io"
	"log/slog"
	"testing"
	"time"
)

// discardLogger returns a logger that drops everything, so watchdog tests do
// not pollute the test output with the expected expiry Error record.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestShutdownWatchdog_FiresOnExpiry verifies the hard-deadline guarantee: when
// teardown does not complete within the deadline, the watchdog logs at Error
// and invokes the forced-exit action — the mechanism that makes the app always
// close instead of beach-balling until it is killed.
func TestShutdownWatchdog_FiresOnExpiry(t *testing.T) {
	expired := make(chan struct{})
	w := startShutdownWatchdog(25*time.Millisecond, discardLogger(), func() { close(expired) })
	defer w.stop()

	select {
	case <-expired:
	case <-time.After(5 * time.Second):
		t.Fatal("watchdog did not fire onExpiry within the budget")
	}
}

// TestShutdownWatchdog_StopDisarms verifies the normal path: once teardown
// completes and stop() is called, the watchdog goroutine exits and never fires.
func TestShutdownWatchdog_StopDisarms(t *testing.T) {
	fired := make(chan struct{}, 1)
	w := startShutdownWatchdog(time.Hour, discardLogger(), func() { fired <- struct{}{} })
	w.stop()

	select {
	case <-w.finished:
	case <-time.After(5 * time.Second):
		t.Fatal("watchdog goroutine did not exit after stop")
	}

	select {
	case <-fired:
		t.Fatal("watchdog fired onExpiry after stop disarmed it")
	default:
	}
}

// TestShutdownWatchdog_DeadlineFallback verifies a non-positive (unset)
// deadline falls back to the built-in default and a nil exit action is accepted
// (production default: os.Exit).
func TestShutdownWatchdog_DeadlineFallback(t *testing.T) {
	w := startShutdownWatchdog(0, nil, func() {})
	defer w.stop()
	if w.deadline != defaultShutdownHardDeadline {
		t.Fatalf("deadline = %v, want the default %v", w.deadline, defaultShutdownHardDeadline)
	}
}

// TestApp_ShutdownDeadline verifies the App resolves the configured shutdown
// deadline and falls back to the default when Startup never set it.
func TestApp_ShutdownDeadline(t *testing.T) {
	a := &App{}
	if got := a.shutdownDeadline(); got != defaultShutdownHardDeadline {
		t.Fatalf("unset deadline = %v, want %v", got, defaultShutdownHardDeadline)
	}
	a.shutdownHardDeadline = 5 * time.Second
	if got := a.shutdownDeadline(); got != 5*time.Second {
		t.Fatalf("configured deadline = %v, want 5s", got)
	}
}

// TestEffectiveShutdownDeadline pins the single configured-deadline mapping
// both the shutdown watchdog and the GPU-relaunch handover budget consume: a
// positive config value passes through, an unset (0) or nonsense value
// resolves to the built-in cumulative default. The GPU-relaunch handover waits
// exactly this long (plus margin) for the predecessor — sized against
// anything shorter, a legitimate slow teardown (the ~46 s embedded-LLM stop)
// would outlast the wait and lose the replacement window (review finding
// #155.1).
func TestEffectiveShutdownDeadline(t *testing.T) {
	cases := []struct {
		name              string
		configuredSeconds int
		want              time.Duration
	}{
		{"unset falls back to the default", 0, defaultShutdownHardDeadline},
		{"negative falls back to the default", -5, defaultShutdownHardDeadline},
		{"configured passes through", 120, 120 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := EffectiveShutdownDeadline(tc.configuredSeconds); got != tc.want {
				t.Fatalf("EffectiveShutdownDeadline(%d) = %v, want %v", tc.configuredSeconds, got, tc.want)
			}
		})
	}
}

// TestGpuRelaunchHandoverBudgetSizedFromShutdownDeadline pins the budget
// derivation: the handover wait must cover the predecessor's whole bounded
// teardown (its effective shutdown deadline) plus the fixed exit slack — a
// budget below that made the relaunched child give up waiting mid-teardown,
// relay into the quitting instance, and exit (the one-shot relay of review
// finding #155.1).
func TestGpuRelaunchHandoverBudgetSizedFromShutdownDeadline(t *testing.T) {
	if got := GpuRelaunchHandoverBudget(0); got != defaultShutdownHardDeadline+gpuRelaunchHandoverMargin {
		t.Fatalf("budget from the default deadline = %v, want %v", got, defaultShutdownHardDeadline+gpuRelaunchHandoverMargin)
	}
	if got := GpuRelaunchHandoverBudget(2 * time.Minute); got != 2*time.Minute+gpuRelaunchHandoverMargin {
		t.Fatalf("budget from a configured deadline = %v, want %v", got, 2*time.Minute+gpuRelaunchHandoverMargin)
	}
	// The default budget must exceed the handover timeout that preceded this
	// fix — the regression this test exists for.
	if GpuRelaunchHandoverBudget(0) <= 15*time.Second {
		t.Fatalf("default budget %v does not exceed the legacy 15s handover timeout", GpuRelaunchHandoverBudget(0))
	}
}
