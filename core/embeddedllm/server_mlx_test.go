package embeddedllm

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func probeTimeoutForTest() time.Duration { return 2 * time.Second }

func mlxLaunchSpec() LaunchSpec {
	return LaunchSpec{
		Engine:       EngineMTPLX,
		ServerBinary: "/runtimes/mtplx-" + MTPLXVersion + "/python/bin/python3.12",
		ModelFile:    "/models/bonsai-2-27b-mlx/pack",
		Host:         LoopbackHost,
		Port:         18432,
		ContextSize:  94208,
	}
}

// TestMLXArgsRendersTheEngineContract locks the mtplx argv: fixed order, typed
// values, loopback bind, explicit window, rate limiting off, and the model
// given as the verified pack directory.
func TestMLXArgsRendersTheEngineContract(t *testing.T) {
	spec := mlxLaunchSpec()
	// The deliberate split (see the Args rendering guard): Args is ALWAYS the
	// llama renderer; spawn selects mlxArgs by spec.Engine. Assert both sides.
	if spec.Args() == nil || len(spec.Args()) == 0 {
		t.Fatal("Args rendered nothing")
	}
	if strings.Join(spec.Args(), " ") == strings.Join(spec.mlxArgs(), " ") {
		t.Fatal("the llama and mtplx renderers coincide; the selector is meaningless")
	}
	argv := spec.mlxArgs()
	want := []string{
		"-m", spec.ModelFile,
		"--host", LoopbackHost,
		"--port", "18432",
		"--context-window", "94208",
		"--rate-limit", "0",
	}
	if len(argv) != len(want) {
		t.Fatalf("argv = %v, want %v", argv, want)
	}
	for i := range want {
		if argv[i] != want[i] {
			t.Fatalf("argv[%d] = %q, want %q (full: %v)", i, argv[i], want[i], argv)
		}
	}
	// The dash-prefixed set is exactly the flags the engine contract chose —
	// nothing a hostile ModelFile string could add.
	dashes := 0
	for _, a := range argv {
		if strings.HasPrefix(a, "-") {
			dashes++
		}
	}
	if dashes != 5 {
		t.Fatalf("argv carries %d flags, want exactly 5 (-m, host, port, context-window, rate-limit)", dashes)
	}
}

func TestMLXValidate(t *testing.T) {
	good := mlxLaunchSpec()
	if err := good.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}

	cases := []struct {
		name    string
		mutate  func(*LaunchSpec)
		wantSub string
	}{
		{"no pack dir", func(s *LaunchSpec) { s.ModelFile = "" }, "pack directory is required"},
		{"relative pack dir", func(s *LaunchSpec) { s.ModelFile = "models/pack" }, "must be absolute"},
		{"non-loopback bind", func(s *LaunchSpec) { s.Host = "0.0.0.0" }, "loopback"},
		{"bad port", func(s *LaunchSpec) { s.Port = 0 }, "usable TCP port"},
		{"zero context", func(s *LaunchSpec) { s.ContextSize = 0 }, "context size"},
		{"over-training context", func(s *LaunchSpec) { s.ContextSize = maxTrainingContext + 1 }, "context size"},
		{"fit leaked from llama", func(s *LaunchSpec) { s.Fit = true }, "llama-family launch fields"},
		{"mmproj leaked from llama", func(s *LaunchSpec) { s.MMProjFile = "/x/mmproj.gguf" }, "llama-family launch fields"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			spec := mlxLaunchSpec()
			tc.mutate(&spec)
			err := spec.Validate()
			if err == nil || !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("Validate error = %v, want it to contain %q", err, tc.wantSub)
			}
		})
	}
}

func TestLaunchSpecMLX(t *testing.T) {
	agentDir := t.TempDir()
	layout, err := NewLayout(
		filepath.Join(agentDir, "runtimes"),
		filepath.Join(agentDir, "models", "bonsai-2-27b"),
		filepath.Join(agentDir, "models", "bonsai-2-27b-mlx"),
	)
	if err != nil {
		t.Fatalf("NewLayout: %v", err)
	}
	// A provisioned tree: the interpreter and the pack both exist.
	runtimeDir, err := layout.MLXRuntimeDir()
	if err != nil {
		t.Fatalf("MLXRuntimeDir: %v", err)
	}
	python, err := MLXServerPythonPath(runtimeDir)
	if err != nil {
		t.Fatalf("MLXServerPythonPath: %v", err)
	}
	if err := mkdirAll(filepath.Dir(python)); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(python, []byte("#!/bin/sh\n"), 0o750); err != nil {
		t.Fatalf("touch python: %v", err)
	}
	packDir, err := layout.MLXPackDir()
	if err != nil {
		t.Fatalf("MLXPackDir: %v", err)
	}
	if err := mkdirAll(packDir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	server := NewServer(layout, discardLogger())
	ctx := context.Background()

	// The recorded plan is the shape: its context is the window.
	plan := MemoryPlan{ContextSize: 20480}
	resolved, err := server.launchSpec(ctx, Manifest{
		Engine:      EngineMTPLX,
		ModelFile:   packDir,
		ContextSize: 20480,
		Plan:        &plan,
	}, 18432)
	if err != nil {
		t.Fatalf("launchSpec: %v", err)
	}
	if resolved.Spec.Engine != EngineMTPLX || resolved.Spec.ContextSize != 20480 {
		t.Fatalf("spec = %+v", resolved.Spec)
	}
	if resolved.Spec.ServerBinary != python {
		t.Fatalf("ServerBinary = %q, want %q", resolved.Spec.ServerBinary, python)
	}
	if resolved.Spec.ModelFile != packDir {
		t.Fatalf("ModelFile = %q, want the pack dir", resolved.Spec.ModelFile)
	}

	// A tampered record pointing outside the pack root falls back to the
	// layout-derived directory, loudly.
	resolved, err = server.launchSpec(ctx, Manifest{
		Engine:      EngineMTPLX,
		ModelFile:   "/elsewhere/pack",
		ContextSize: 8192,
	}, 18432)
	if err != nil {
		t.Fatalf("launchSpec(tampered): %v", err)
	}
	if resolved.Spec.ModelFile != packDir {
		t.Fatalf("tampered ModelFile = %q, want the derived %q", resolved.Spec.ModelFile, packDir)
	}

	// A plan-less manifest launches the recorded context tier.
	resolved, err = server.launchSpec(ctx, Manifest{
		Engine:      EngineMTPLX,
		ModelFile:   packDir,
		ContextSize: 8192,
	}, 18432)
	if err != nil {
		t.Fatalf("launchSpec(plan-less): %v", err)
	}
	if resolved.Spec.ContextSize != 8192 {
		t.Fatalf("plan-less context = %d, want the recorded 8192", resolved.Spec.ContextSize)
	}

	// A record with NO context anywhere is a refusal, not a guess.
	_, err = server.launchSpec(ctx, Manifest{Engine: EngineMTPLX, ModelFile: packDir}, 18432)
	if !errors.Is(err, ErrLaunchSpecInvalid) {
		t.Fatalf("launchSpec(no context) error = %v, want ErrLaunchSpecInvalid", err)
	}
}

func TestMLXStateEnv(t *testing.T) {
	spec := mlxLaunchSpec()
	env := mlxStateEnv(spec)
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "MTPLX_CONFIG=/runtimes/mtplx-"+MTPLXVersion+"/config.toml") {
		t.Fatalf("env %q does not isolate the config file", joined)
	}
	if !strings.Contains(joined, "MTPLX_MODEL_DIR=/runtimes/mtplx-"+MTPLXVersion) {
		t.Fatalf("env %q does not isolate the model dir", joined)
	}
}

func TestReadHealthContext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"ok": true, "context_window": 57344}`))
	}))
	defer srv.Close()

	client := srv.Client()
	got, ok := readHealthContext(context.Background(), client, srv.URL+"/health", probeTimeoutForTest())
	if !ok || got != 57344 {
		t.Fatalf("readHealthContext = (%d, %v), want (57344, true)", got, ok)
	}

	// Fail-soft on every malformed answer.
	for name, body := range map[string]string{
		"missing field": `{"ok": true}`,
		"zero":          `{"model_max_context": 0}`,
		"negative":      `{"model_max_context": -5}`,
		"absurd":        `{"model_max_context": 999999999}`,
		"not json":      `hello`,
		"wrong type":    `{"model_max_context": "big"}`,
	} {
		bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(body))
		}))
		if _, ok := readHealthContext(context.Background(), bad.Client(), bad.URL+"/health", probeTimeoutForTest()); ok {
			t.Fatalf("%s: readHealthContext accepted %q", name, body)
		}
		bad.Close()
	}
	if _, ok := readHealthContext(context.Background(), client, "http://127.0.0.1:1/health", probeTimeoutForTest()); ok {
		t.Fatal("a dead server answered the readback")
	}
}

func TestModelsReadyWindowPredicate(t *testing.T) {
	twentyK := 20480
	// llama shape: id only, no window fields — ready without the requirement.
	if !modelsReady(modelsPayload{Data: []struct {
		ID            string `json:"id"`
		ContextLength *int   `json:"context_length"`
		MaxContextLen *int   `json:"max_context_length"`
		MaxModelLen   *int   `json:"max_model_len"`
	}{{ID: "llama"}}}, false) {
		t.Fatal("llama shape refused without the requirement")
	}
	// mtplx shape before the backend resolved: id listed, no window yet.
	noWindow := modelsPayload{Data: []struct {
		ID            string `json:"id"`
		ContextLength *int   `json:"context_length"`
		MaxContextLen *int   `json:"max_context_length"`
		MaxModelLen   *int   `json:"max_model_len"`
	}{{ID: "mtplx-bonsai-2-27b-optimized-speed"}}}
	if modelsReady(noWindow, true) {
		t.Fatal("a windowless listing passed the mtplx readiness predicate")
	}
	withWindow := modelsPayload{Data: []struct {
		ID            string `json:"id"`
		ContextLength *int   `json:"context_length"`
		MaxContextLen *int   `json:"max_context_length"`
		MaxModelLen   *int   `json:"max_model_len"`
	}{{ID: "mtplx-bonsai-2-27b-optimized-speed", ContextLength: &twentyK}}}
	if !modelsReady(withWindow, true) {
		t.Fatal("a windowed listing failed the mtplx readiness predicate")
	}
}

func TestScanMLXFitFailure(t *testing.T) {
	msg := scanMLXFitFailure("boot log\nMODEL DOES NOT FIT\nmore log")
	if msg == "" {
		t.Fatal("the admission refusal marker was not recognized")
	}
	if scanFitFailure("MODEL DOES NOT FIT") == "" {
		t.Fatal("the shared scanner does not carry the mtplx marker")
	}
	if scanFitFailure("an ordinary boot log") != "" {
		t.Fatal("an ordinary log was reported as a fit failure")
	}
}
