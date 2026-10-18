package vectorindex

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
)

// ovRecHandler is a test slog.Handler recording "LEVEL message" entries so
// the expected diagnostics of each deliberate failure path are asserted at
// their source (severity + message), never silently dropped.
type ovRecHandler struct {
	mu      sync.Mutex
	entries []string
}

func (h *ovRecHandler) Enabled(_ context.Context, _ slog.Level) bool { return true }

func (h *ovRecHandler) Handle(_ context.Context, r slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.entries = append(h.entries, r.Level.String()+" "+r.Message)
	return nil
}

func (h *ovRecHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *ovRecHandler) WithGroup(string) slog.Handler      { return h }

func (h *ovRecHandler) snapshot() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.entries...)
}

func ovLogger() (*ovRecHandler, *slog.Logger) {
	h := &ovRecHandler{}
	return h, slog.New(h)
}

// TestOvDeviceVerdict pins the tri-state mapping of
// embedding.VerifyOpenVINOExecution's (verified, err) outcome onto the
// embedder-info device string: threshold crossing → "gpu", a concluded
// below-threshold window → "cpu", and — critically — ANY error → ""
// (unverified). A probe failure must never be misreported as a "cpu"
// verdict, even when the sp4rk result carried verified=true alongside the
// error.
func TestOvDeviceVerdict(t *testing.T) {
	tests := []struct {
		name     string
		verified bool
		err      error
		want     string
		wantLog  string
	}{
		{
			name:     "threshold reached is gpu",
			verified: true,
			want:     "gpu",
			wantLog:  "INFO OpenVINO GPU device verified via xpu-smi",
		},
		{
			name:     "below threshold is cpu",
			verified: false,
			want:     "cpu",
			wantLog:  "WARN no GPU compute utilization during inference — OpenVINO picked a CPU device",
		},
		{
			name:     "probe error is unverified, never cpu",
			verified: false,
			err:      errors.New("querying xpu-smi compute utilization: exit 1"),
			want:     "",
			wantLog:  "WARN OpenVINO device verification probe failed",
		},
		{
			name:     "error wins over a threshold crossing (honest unverified)",
			verified: true,
			err:      errors.New("sustained verification inference failed"),
			want:     "",
			wantLog:  "WARN OpenVINO device verification probe failed",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, log := ovLogger()
			got := ovDeviceVerdict(tt.verified, tt.err, log)
			if got != tt.want {
				t.Errorf("ovDeviceVerdict(verified=%v, err=%v) = %q, want %q", tt.verified, tt.err, got, tt.want)
			}
			entries := h.snapshot()
			if len(entries) != 1 {
				t.Fatalf("logged %d entries, want exactly 1: %v", len(entries), entries)
			}
			if entries[0] != tt.wantLog {
				t.Errorf("log entry = %q, want %q", entries[0], tt.wantLog)
			}
		})
	}
}

// TestVerifyEmbedderOvDevice_MissingXpuSmi pins the one distinction the
// sp4rk boolean cannot carry: with xpu-smi absent from PATH the verdict is
// unverified "" — never "cpu" (sp4rk reports the absent tool as (false, nil),
// the same shape as a below-threshold window; the LookPath guard must turn
// it into "" plus the visible WARN).
func TestVerifyEmbedderOvDevice_MissingXpuSmi(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	h, log := ovLogger()
	got := VerifyEmbedderOvDevice(context.Background(), nil, log)
	if got != "" {
		t.Errorf("VerifyEmbedderOvDevice without xpu-smi = %q, want %q (unverified)", got, "")
	}
	entries := h.snapshot()
	if len(entries) != 1 {
		t.Fatalf("logged %d entries, want exactly 1: %v", len(entries), entries)
	}
	if want := "WARN OpenVINO device verification unavailable: xpu-smi not found"; entries[0] != want {
		t.Errorf("log entry = %q, want %q", entries[0], want)
	}
}
