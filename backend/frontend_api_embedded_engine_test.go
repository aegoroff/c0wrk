package backend

import (
	"context"
	"errors"
	"log/slog"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/core/embeddedllm"
)

// Tests of the embedded local model's ENGINE RESOLUTION: which runtime family
// an install puts on this machine (embeddedResolveEngine in
// backend/frontend_api_embedded.go). The function decides the family the
// memory gate, the preflight and the background run all speak of, so its
// platform outcomes and its refusal path are pinned here — the empty config
// spelling is the documented writing of auto (→ mtplx on darwin/arm64), an
// unknown spelling is a typed refusal (never a silent llama substitution), and
// a refusal after the operation gate is claimed releases the gate.

// TestEmbeddedResolveEngineTable drives the resolution against explicit
// platforms through embeddedResolveEngineOn — the seam whose production caller
// passes only runtime.GOOS-GOARCH, so the darwin/arm64-only mtplx outcomes are
// exercisable on any machine with production behavior unchanged.
func TestEmbeddedResolveEngineTable(t *testing.T) {
	cases := []struct {
		name     string
		engine   string
		platform string
		want     embeddedllm.Engine
		wantErr  error
	}{
		{"the empty spelling is auto, which is mtplx on darwin/arm64", "", "darwin-arm64", embeddedllm.EngineMTPLX, nil},
		{"a spelled-out auto is mtplx on darwin/arm64", "auto", "darwin-arm64", embeddedllm.EngineMTPLX, nil},
		{"auto is llama on windows", "auto", "windows-amd64", embeddedllm.EngineLlama, nil},
		{"auto is llama on linux/amd64", "auto", "linux-amd64", embeddedllm.EngineLlama, nil},
		{"an explicit mtplx is honored on darwin/arm64", "mtplx", "darwin-arm64", embeddedllm.EngineMTPLX, nil},
		{"an explicit llama is honored on darwin/arm64", "llama", "darwin-arm64", embeddedllm.EngineLlama, nil},
		{"an explicit llama is honored on windows", "llama", "windows-amd64", embeddedllm.EngineLlama, nil},
		{"an unknown spelling is a typed refusal", "vllm", "darwin-arm64", "", embeddedllm.ErrEngineUnknown},
		{"mtplx off darwin/arm64 is a typed refusal", "mtplx", "windows-amd64", "", embeddedllm.ErrEngineUnsupportedPlatform},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f, _, _ := newEmbeddedTestAPI(t)
			f.configMu.Lock()
			f.config.EmbeddedLLM.Engine = tc.engine
			f.configMu.Unlock()

			got, err := f.embeddedResolveEngineOn(tc.platform)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("engine %q on %s: error = %v, want it to wrap %v",
						tc.engine, tc.platform, err, tc.wantErr)
				}
				if !strings.Contains(err.Error(), "cannot run on this machine") {
					t.Errorf("error %v is not translated into the operator-facing sentence", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("engine %q on %s: %v", tc.engine, tc.platform, err)
			}
			if got != tc.want {
				t.Errorf("engine %q on %s resolved to %q, want %q", tc.engine, tc.platform, got, tc.want)
			}
		})
	}
}

// TestInstallEmbeddedLLMResolveErrorReleasesTheGate pins the refusal path of
// the RPC itself: the engine resolves AFTER the operation gate is claimed and
// the run's cancel is published, so a resolution failure must exit through
// refuseEmbeddedInstall like every sibling refusal — a bare return would hold
// the gate (every embedded RPC refuses until restart) and leave the published
// cancel aimed at a run that never started.
func TestInstallEmbeddedLLMResolveErrorReleasesTheGate(t *testing.T) {
	f, _, _ := newEmbeddedTestAPI(t)
	f.configMu.Lock()
	f.config.EmbeddedLLM.Engine = "vllm" // unknown on every platform → typed refusal
	f.configMu.Unlock()

	err := f.InstallEmbeddedLLM()
	if err == nil {
		t.Fatal("InstallEmbeddedLLM accepted an unknown engine spelling")
	}
	if !errors.Is(err, embeddedllm.ErrEngineUnknown) {
		t.Errorf("error = %v, want it to wrap ErrEngineUnknown", err)
	}
	if got := f.embeddedBusyOperation(); got != embeddedOpIdle {
		t.Errorf("the gate is still held by %q after the resolution refusal", got)
	}
	if f.GetEmbeddedLLMStatus().Installing {
		t.Error("status.Installing = true after the resolution refusal")
	}
	f.embedded.mu.Lock()
	cancel := f.embedded.installCancel
	f.embedded.mu.Unlock()
	if cancel != nil {
		t.Error("the run's cancel is still published after the resolution refusal")
	}
}

// TestInstallEmbeddedLLMTuningReachesThePreflightAndTheRun pins the operator's
// memory-plan overrides on BOTH ends of the install pipeline. `Resolve` — whose
// gate the preflight runs — documents "an operator who pinned a context" as its
// audience, and core's InstallOptions.Tuning promises "the same
// embedded_llm.tuning the preflight CheckMemoryBudget call carried", so the
// preflight must price the tuned shape and the run must receive it: a wiring
// gap on either side silently demotes `context.mode: exact` under mtplx to a
// dead-but-advertised setting.
func TestInstallEmbeddedLLMTuningReachesThePreflightAndTheRun(t *testing.T) {
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skipf("the mtplx engine gate refuses before pricing on %s/%s; the preflight pricing verdict under test is a darwin/arm64 one", runtime.GOOS, runtime.GOARCH)
	}
	pinnedExact := func(f *FrontendAPI) {
		t.Helper()
		f.configMu.Lock()
		f.config.EmbeddedLLM.Engine = "mtplx"
		mode := config.EmbeddedLLMContextExact
		tokens := 49152
		f.config.EmbeddedLLM.Tuning.Context = config.EmbeddedLLMContextConfig{Mode: &mode, Tokens: &tokens}
		f.configMu.Unlock()
	}
	forbiddenSpawn := func(t *testing.T) func(context.Context, embeddedllm.LaunchCommand) (embeddedllm.Process, error) {
		return func(context.Context, embeddedllm.LaunchCommand) (embeddedllm.Process, error) {
			t.Error("a process was spawned by an install that must not reach the server")
			return nil, errors.New("spawn forbidden")
		}
	}

	t.Run("an exact window the all-Auto plan would survive refuses the preflight", func(t *testing.T) {
		f, _, _ := newEmbeddedTestAPI(t)
		pinnedExact(f)
		// 16 GiB is a measured RAM class whose all-Auto verdict fits (core's
		// PlanMLX tests pin that), so a refusal HERE isolates the operator's
		// 49,152-token window: fixed footprint + its KV exceeds the ¾ budget.
		f.embedded.probeFn = func(context.Context, *slog.Logger) (embeddedllm.Hardware, error) {
			return embeddedllm.Hardware{Platform: "darwin-arm64", Arch: "arm64", RAMGiB: 16, Backend: embeddedllm.BackendMetal}, nil
		}
		f.embedded.spawnFn = forbiddenSpawn(t)
		f.embedded.installFn = func(context.Context, *embeddedllm.Installer, embeddedllm.InstallOptions) (*embeddedllm.InstallReport, error) {
			t.Error("the install run started on a shape the preflight must refuse")
			return nil, errors.New("install forbidden")
		}
		supervisorOf(t, f)

		err := f.InstallEmbeddedLLM()
		if err == nil {
			t.Fatal("InstallEmbeddedLLM priced the all-Auto plan instead of the operator's exact window")
		}
		if !errors.Is(err, embeddedllm.ErrInsufficientMemory) {
			t.Errorf("error = %v, want it to wrap ErrInsufficientMemory", err)
		}
		if !strings.Contains(err.Error(), "lower context.mode") {
			t.Errorf("refusal %v is not the actionable MLX gate sentence", err)
		}
		if got := f.embeddedBusyOperation(); got != embeddedOpIdle {
			t.Errorf("the gate is still held by %q after the preflight refusal", got)
		}
		if f.GetEmbeddedLLMStatus().Installing {
			t.Error("status.Installing = true after the preflight refusal")
		}
	})

	t.Run("the run's InstallOptions carry the same tuning the preflight priced", func(t *testing.T) {
		f, _, _ := newEmbeddedTestAPI(t)
		pinnedExact(f)
		hw := embeddedllm.Hardware{Platform: "darwin-arm64", Arch: "arm64", RAMGiB: 64, Backend: embeddedllm.BackendMetal}
		f.embedded.probeFn = func(context.Context, *slog.Logger) (embeddedllm.Hardware, error) { return hw, nil }
		f.embedded.spawnFn = forbiddenSpawn(t)
		entered := make(chan struct{}, 1)
		release := make(chan struct{})
		var gotOpts embeddedllm.InstallOptions
		f.embedded.installFn = func(_ context.Context, _ *embeddedllm.Installer, opts embeddedllm.InstallOptions) (*embeddedllm.InstallReport, error) {
			gotOpts = opts
			entered <- struct{}{}
			<-release
			return nil, errors.New("install forbidden")
		}
		supervisorOf(t, f)

		returned := make(chan error, 1)
		go func() { returned <- f.InstallEmbeddedLLM() }()
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("the run never started: the preflight did not accept the tuned shape")
		}
		close(release)
		if err := <-returned; err != nil {
			t.Fatalf("InstallEmbeddedLLM: %v", err)
		}
		want := embeddedllm.Tuning{Context: embeddedllm.ContextTuning{Mode: embeddedllm.ContextExact, Tokens: 49152}}
		if !reflect.DeepEqual(gotOpts.Tuning, want) {
			t.Errorf("InstallOptions.Tuning = %+v, want %+v", gotOpts.Tuning, want)
		}
		if gotOpts.Engine != embeddedllm.EngineMTPLX {
			t.Errorf("InstallOptions.Engine = %q, want %q", gotOpts.Engine, embeddedllm.EngineMTPLX)
		}
		waitForStatus(t, f, "the failed run to release the gate", func(s EmbeddedLLMStatus) bool {
			return !s.Installing
		})
	})
}
