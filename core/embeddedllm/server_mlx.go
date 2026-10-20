package embeddedllm

// The mtplx engine's supervision surface (ADR-078): the argv, the validation,
// the launch identity, the state isolation environment and the /health context
// readback. The supervisor machinery — the single-instance gate, the readiness
// polling loop, crash detection, the idle unload, the stop budgets — is
// runtime-agnostic and lives in server.go untouched; this file is only the
// engine-shaped half.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ── argv ─────────────────────────────────────────────────────────────────────

// mlxArgs renders the mtplx engine's command line. This is the only place an
// mtplx argv exists, mirroring LaunchSpec.Args's llama monopoly. The run shape
// is fixed by the same invariants as the llama argv: loopback bind, explicit
// context (the plan's computed window — "an explicit --context-window still
// wins" is the runtime's own documented precedence), rate limiting off (one
// local client, one request at a time), and the model given as the pack
// DIRECTORY the installer verified (never an HF id, so the runtime can never
// resolve it to different bytes).
func (spec LaunchSpec) mlxArgs() []string {
	args := make([]string, 0, 12)
	args = append(args,
		"-m", spec.ModelFile, // mtplx reuses -m for the model reference (path)
		"--host", spec.Host,
		"--port", strconv.Itoa(spec.Port),
		"--context-window", strconv.Itoa(spec.ContextSize),
		"--rate-limit", "0",
	)
	return args
}

// mlxValidate refuses a specification that must never reach exec. The llama
// fields (fit, layers, KV precision, slots, the projector) are not part of
// this engine's vocabulary: a non-zero one means a llama plan leaked into an
// mtplx launch, which is a programming error, not a default to inherit.
func (spec LaunchSpec) mlxValidate() error {
	if spec.ModelFile == "" {
		return fmt.Errorf("%w: the model pack directory is required", ErrLaunchSpecInvalid)
	}
	if !filepath.IsAbs(spec.ModelFile) {
		return fmt.Errorf("%w: the model pack directory %q must be absolute", ErrLaunchSpecInvalid, spec.ModelFile)
	}
	if spec.Host != LoopbackHost {
		return fmt.Errorf("%w: the bind must be the loopback host, got %q", ErrLaunchSpecInvalid, spec.Host)
	}
	if !usablePort(spec.Port) {
		return fmt.Errorf("%w: port %d is not a usable TCP port", ErrLaunchSpecInvalid, spec.Port)
	}
	// The context is the ONE memory decision this engine launches with; it is
	// always explicit and bounded by the model's own training context.
	if spec.ContextSize <= 0 || spec.ContextSize > maxTrainingContext {
		return fmt.Errorf("%w: context size %d outside (0, %d]", ErrLaunchSpecInvalid, spec.ContextSize, maxTrainingContext)
	}
	if _, emitsLayers := spec.Layers.arg(); emitsLayers {
		return fmt.Errorf("%w: -ngl does not exist on the %s engine", ErrLaunchSpecInvalid, EngineMTPLX)
	}
	if spec.Fit || spec.Parallel != 0 ||
		spec.KVType != "" || spec.MMProjFile != "" || len(spec.Devices) > 0 ||
		spec.SplitMode != SplitModeAuto {
		return fmt.Errorf("%w: llama-family launch fields set on an %s spec (fit=%t, layers=%v, parallel=%d, kv=%q, mmproj=%q)",
			ErrLaunchSpecInvalid, EngineMTPLX, spec.Fit, spec.Layers, spec.Parallel, spec.KVType, spec.MMProjFile)
	}
	return nil
}

// ── launch identity ──────────────────────────────────────────────────────────

// launchSpecMLX turns an mtplx install record into a launch specification.
// The identity half is containment-checked against the layout exactly like the
// llama path: the interpreter is derived from the runtime tree, and the
// recorded pack directory must lie inside the MLX pack root (a tampered
// manifest cannot aim the launch at foreign bytes).
//
// The SHAPE half is the recorded plan's context window; there is no load-time
// re-plan on this engine because the compat probe is llama-specific
// (`llama-server --list-devices`) and the memory decision was made and
// re-checkable from the same pinned terms at install.
func (s *Server) launchSpecMLX(manifest Manifest, port int) (resolvedLaunch, error) {
	if manifest.Engine != EngineMTPLX {
		return resolvedLaunch{}, fmt.Errorf("%w: launchSpecMLX called for engine %q", ErrLaunchSpecInvalid, manifest.Engine)
	}
	runtimeDir, err := s.Layout.MLXRuntimeDir()
	if err != nil {
		return resolvedLaunch{}, err
	}
	binary, err := MLXServerPythonPath(runtimeDir)
	if err != nil {
		return resolvedLaunch{}, err
	}
	if !pathExists(binary) {
		return resolvedLaunch{}, fmt.Errorf("%w: the provisioned Python %q is missing — reinstall the model",
			ErrNotInstalled, binary)
	}

	modelFile := manifest.ModelFile
	if modelFile == "" || !s.Layout.OwnsMLXPack(modelFile) {
		derived, deriveErr := s.Layout.MLXPackDir()
		if deriveErr != nil {
			return resolvedLaunch{}, deriveErr
		}
		if modelFile != "" {
			s.logger().Warn("the recorded model directory is outside the MLX pack root; launching the layout-derived path instead",
				"recorded", modelFile, "derived", derived)
		}
		modelFile = derived
	}
	if !pathExists(modelFile) {
		return resolvedLaunch{}, fmt.Errorf("%w: the recorded model directory %q is missing — reinstall the model",
			ErrNotInstalled, modelFile)
	}

	spec := LaunchSpec{
		Engine:       EngineMTPLX,
		ServerBinary: binary,
		ModelFile:    modelFile,
		Host:         LoopbackHost,
		Port:         port,
	}
	plan := manifest.Plan
	switch {
	case plan != nil && plan.ContextSize > 0:
		spec.ContextSize = plan.ContextSize
	case plan == nil && manifest.ContextSize > 0:
		// A plan-less manifest: the recorded context tier IS the window.
		spec.ContextSize = manifest.ContextSize
	default:
		return resolvedLaunch{}, fmt.Errorf("%w: the mtplx install record carries no context to launch with",
			ErrLaunchSpecInvalid)
	}
	if err := spec.Validate(); err != nil {
		return resolvedLaunch{}, fmt.Errorf("embeddedllm: %w", err)
	}
	return resolvedLaunch{Spec: spec, Plan: plan}, nil
}

// ── state isolation ──────────────────────────────────────────────────────────

// mlxStateEnv is the environment that keeps the engine's own state OUT of
// ~/.mtplx: its config file and its model-search root both live inside the
// c0wrk layout, so an operator's MTPLX install (or a future download) can
// never mix with this one. Isolation here is why the engine never finds a
// model c0wrk did not pin.
func mlxStateEnv(spec LaunchSpec) []string {
	// ServerBinary is <runtimeDir>/python/bin/python3.12 — the runtime dir is
	// three levels up, and the config file sits at its root.
	runtimeDir := filepath.Dir(filepath.Dir(filepath.Dir(spec.ServerBinary)))
	return []string{
		"MTPLX_CONFIG=" + filepath.Join(runtimeDir, "config.toml"),
		"MTPLX_MODEL_DIR=" + runtimeDir, // never used for downloads (path-loaded), but never points at ~/.mtplx either
	}
}

// ── context readback ─────────────────────────────────────────────────────────

// healthURL is the mtplx engine's state endpoint (llama's /props twin).
func healthURL(port int) string {
	return "http://" + LoopbackHost + ":" + strconv.Itoa(port) + "/health"
}

// healthPayload is the slice of the /health response the context readback
// needs. The TOP-LEVEL `context_window` is the window the loaded backend is
// actually serving (verified against a live server: it mirrors the launched
// `--context-window`, and `/execution_window.basis` reads
// "configured_window"); the readback takes it and the caller clamps to the
// launched window.
type healthPayload struct {
	ContextWindow *int `json:"context_window"`
}

// readHealthContext asks a READY mtplx server what context it came up with.
// Fail-soft exactly like readPropsContext: (0, false) for every way the
// question can go wrong, because the answer refines a recorded value and must
// never become the reason a load that is already serving reports failure.
func readHealthContext(ctx context.Context, client *http.Client, url string, timeout time.Duration) (int, bool) {
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, http.NoBody)
	if err != nil {
		return 0, false
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, false
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPropsBodyLen))
	if err != nil || resp.StatusCode != http.StatusOK {
		return 0, false
	}
	var payload healthPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, false
	}
	if payload.ContextWindow == nil || *payload.ContextWindow <= 0 {
		return 0, false
	}
	if *payload.ContextWindow > maxTrainingContext {
		return 0, false
	}
	return *payload.ContextWindow, true
}

// ── failure markers ──────────────────────────────────────────────────────────

// mlxDoesNotFitMarker is the mtplx planner's admission refusal signature: a
// load that cannot fit gets the smallest window and a line that says so. The
// marker is engine-agnostic by construction — the llama fork never prints it —
// so the shared tail scanner can carry both.
const mlxDoesNotFitMarker = "MODEL DOES NOT FIT"

// scanMLXFitFailure renders the actionable message for an mtplx admission
// refusal found in the server's output tail. Empty means "not this failure".
func scanMLXFitFailure(tail string) string {
	if strings.Contains(tail, mlxDoesNotFitMarker) {
		return "the MTPLX planner refused the load as too big for its measured engine budget — " +
			"re-plan (a smaller context.mode) or use a machine with more memory"
	}
	return ""
}
