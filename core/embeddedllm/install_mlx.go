package embeddedllm

// The mtplx engine's provisioning flow (ADR-078). It mirrors the llama
// install's gate order — stop first, probe, resolve (whose gate is the first
// check), disk guard, port, engine stack, smoke test, weights, manifest,
// config — with three deliberate deviations the engine's shape dictates:
//
//   - the engine stack is a RELOCATABLE plain-file tree (a pinned CPython with
//     the wheels installed into it), not a signed binary: there is no
//     quarantine/codesign step, and the rebuild replaces the previous tree
//     after the step-0 stop instead of swapping a live binary's tree;
//   - the smoke test is an import of the pinned engine in the provisioned
//     interpreter, not a `--version` of a downloaded binary — the real
//     readiness proof remains the load path's /v1/models poll;
//   - the weights are a DIRECTORY of pinned files (the pack), fetched into
//     MLXPackDir exactly like the GGUFs are, verified by the same fail-closed
//     SHA256 gate.
//
// Nothing here ever runs `mtplx pull` or lets the engine fetch its own bytes:
// every artifact the tree contains was downloaded and verified by this
// package's Downloader against the pins in mlxpins.go.

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	// mlxPipInstallTimeout bounds the offline wheel installation. The wheels
	// are local files and the dependency set is closed, so this bounds only
	// disk work; a wedged pip cannot hold the install past it.
	mlxPipInstallTimeout = 10 * time.Minute
	// mlxSmokeTimeout bounds the import smoke test.
	mlxSmokeTimeout = 2 * time.Minute
	// mlxProvisionHeadroomBytes is the disk the engine stack needs BEYOND the
	// archives themselves: the extracted CPython (~120 MiB) plus the wheel set
	// unpacked into site-packages (~1 GiB), rounded up to a policy 2 GiB.
	mlxProvisionHeadroomBytes = int64(2) << 30
)

// splitMLXAssets orders the engine's artifact set into the engine stack (the
// managed CPython archive, then the closed wheel set) and the weight pack.
func splitMLXAssets(assets []Asset) (engineAssets, packAssets []Asset) {
	engineAssets = make([]Asset, 0, 1+len(mtplxWheelPins))
	packAssets = make([]Asset, 0, len(mlxPackPins))
	for _, asset := range assets {
		switch asset.Component {
		case ComponentPython, ComponentEngineWheels:
			engineAssets = append(engineAssets, asset)
		case ComponentMLXPack:
			packAssets = append(packAssets, asset)
		}
	}
	return engineAssets, packAssets
}

// installMLX provisions the pinned MTPLX engine stack and the pinned MLX
// weight pack. Dispatched from Install after the step-0 stop.
func (in *Installer) installMLX(ctx context.Context, opts InstallOptions) (*InstallReport, error) {
	// 1. Hardware probe: RAM is the gate's only machine input on this engine.
	hw, err := in.probe()(ctx, in.logger())
	if err != nil {
		return nil, fmt.Errorf("embeddedllm: hardware probe: %w", err)
	}
	platform := hw.Platform
	if opts.Platform != "" {
		platform = opts.Platform
	}
	if platform != PlatformDarwinARM64 {
		return nil, fmt.Errorf("%w: engine %q needs %q, got %q (use engine %q)",
			ErrEngineUnsupportedPlatform, EngineMTPLX, PlatformDarwinARM64, platform, EngineLlama)
	}

	// 2. Resolve: the single-pool memory gate is the FIRST check — a machine
	// whose memory no window fits plans no assets and downloads nothing.
	terms, err := PinnedMLXMemoryTerms()
	if err != nil {
		return nil, err
	}
	plan, err := PlanMLX(hw.RAMGiB, Tuning{}, terms)
	if err != nil {
		return nil, fmt.Errorf("embeddedllm: %w", err)
	}
	assets, err := EngineArtifactSet(platform)
	if err != nil {
		return nil, err
	}

	if err := in.Layout.EnsureRoots(); err != nil {
		return nil, err
	}
	if err := in.checkWholeSetDiskSpaceMLX(assets); err != nil {
		return nil, err
	}

	port := opts.Port
	if port == 0 {
		port, err = in.allocatePort(ctx)
		if err != nil {
			return nil, fmt.Errorf("embeddedllm: allocating a loopback port: %w", err)
		}
	}

	// 3. The engine stack. The step-0 stop guaranteed nothing is resident, so
	// a previous attempt's trees are rebuilt from scratch: a partial rebuild
	// is a cache of verified downloads, never a half-installed engine.
	runtimeDir, err := in.Layout.MLXRuntimeDir()
	if err != nil {
		return nil, err
	}
	workDir, err := in.Layout.MLXRuntimeWorkDir()
	if err != nil {
		return nil, err
	}
	if err := in.removeOwned(runtimeDir); err != nil {
		return nil, err
	}
	if err := in.prepareStaging(workDir); err != nil {
		return nil, err
	}

	engineAssets, packAssets := splitMLXAssets(assets)
	checksums := make(map[string]string, len(assets))
	// The Python archive is staged-extracted (the tree the wheels go into);
	// fetchComponents emits the extracting stage and the code below closes the
	// component's stream when the stack is actually usable.
	if err := in.fetchComponents(ctx, opts, engineAssets[:1], workDir, checksums); err != nil {
		return nil, fmt.Errorf("embeddedllm: provisioning the managed Python: %w", err)
	}
	if err := in.fetchComponents(ctx, opts, engineAssets[1:], "", checksums); err != nil {
		return nil, fmt.Errorf("embeddedllm: fetching the engine wheel set: %w", err)
	}

	stagedPython, err := MLXServerPythonPath(workDir)
	if err != nil {
		return nil, err
	}
	if !pathExists(stagedPython) {
		return nil, fmt.Errorf("embeddedllm: the managed Python archive did not extract the expected tree (missing %q)", stagedPython)
	}

	// 4. The wheels, offline: the download directory is the only source, the
	// dependency set is closed by the pin, and every byte in it already passed
	// the verification gate. pip's own index traffic is disabled twice — by
	// --no-index and by the environment — so a mispinned name fails HERE, as
	// "wheel not found", instead of becoming an unpinned download.
	if err := in.mlxPipInstall(ctx, stagedPython); err != nil {
		return nil, err
	}

	// 5. Smoke test: the pinned engine must import in THIS interpreter before
	// the multi-gigabyte pack is fetched.
	if err := in.mlxSmoke(ctx, stagedPython); err != nil {
		return nil, err
	}

	// 6. Promote the finished tree.
	if err := in.removeOwned(runtimeDir); err != nil {
		return nil, err
	}
	if err := os.Rename(workDir, runtimeDir); err != nil {
		return nil, fmt.Errorf("embeddedllm: promoting the provisioned engine tree: %w", err)
	}
	finalPython, err := MLXServerPythonPath(runtimeDir)
	if err != nil {
		return nil, err
	}
	for _, asset := range engineAssets {
		in.emit(opts, Progress{Component: asset.Component, Stage: StageDone,
			BytesDone: asset.SizeBytes, BytesTotal: asset.SizeBytes})
	}

	// 7. The weight pack, straight to its final directory — the artifact IS
	// the file, so the downloader's verify-then-promote is the atomicity.
	packDir, err := in.Layout.MLXPackDir()
	if err != nil {
		return nil, err
	}
	if err := mkdirAll(packDir); err != nil {
		return nil, err
	}
	if err := in.fetchComponents(ctx, opts, packAssets, "", checksums); err != nil {
		return nil, fmt.Errorf("embeddedllm: fetching the MLX weight pack: %w", err)
	}

	installedAt := in.now().UTC().Format(time.RFC3339)
	manifest := Manifest{
		Packing:        "", // the pack ships one quantization; the reason says so
		Backend:        BackendMetal,
		RuntimeVersion: MTPLXVersion,
		Engine:         EngineMTPLX,
		PythonVersion:  pythonInstallVersion,
		PackRevision:   MLXPackRevision,
		Checksums:      checksums,
		Port:           port,
		ContextSize:    recordableContext(plan, plan.ContextSize),
		ModelFile:      packDir,
		InstalledAt:    installedAt,
		PackingReason:  PackingReasonMLXPack,
		GPUFamily:      GPUFamilyAppleSilicon,
		Plan:           &plan,
	}
	manifestPath, err := in.Layout.ManifestPath()
	if err != nil {
		return nil, err
	}
	if err := writeManifest(manifestPath, manifest, in.logger()); err != nil {
		return nil, err
	}
	in.logger().Info("embedded LLM installed",
		"engine", string(EngineMTPLX), "runtime_version", manifest.RuntimeVersion,
		"python", manifest.PythonVersion, "pack_revision", manifest.PackRevision,
		"backend", manifest.Backend, "packing_reason", manifest.PackingReason,
		"port", manifest.Port, "context_size", manifest.ContextSize,
		"model_dir", manifest.ModelFile)

	state := InstallState{
		Packing:           manifest.Packing,
		Backend:           manifest.Backend,
		Port:              manifest.Port,
		ModelFile:         manifest.ModelFile,
		RuntimeVersion:    manifest.RuntimeVersion,
		InstalledAt:       manifest.InstalledAt,
		ContextSize:       manifest.ContextSize,
		AutoUnloadEnabled: DefaultAutoUnloadEnabled,
		AutoUnloadMinutes: DefaultAutoUnloadMinutes,
	}
	if err := in.Sink.ApplyInstalled(ctx, state); err != nil {
		// The bytes are fine and the manifest describes them accurately; only
		// the registration failed, and a retry is idempotent (cache hits).
		return nil, fmt.Errorf("embeddedllm: registering the installed model in config: %w", err)
	}

	return &InstallReport{
		Manifest: manifest,
		Resolution: Resolution{
			Engine:        EngineMTPLX,
			Assets:        assets,
			Backend:       BackendMetal,
			PackingReason: PackingReasonMLXPack,
			GPU:           GPUFamilyAppleSilicon,
			ContextSize:   plan.ContextSize,
			Memory:        plan,
		},
		Hardware:      hw,
		RuntimeDir:    runtimeDir,
		ServerBinary:  finalPython,
		ModelFile:     packDir,
		PackingReason: PackingReasonMLXPack,
	}, nil
}

// mlxPipInstall installs the closed wheel set into the staged interpreter,
// offline. Environment hygiene: pip must not phone home for a version check,
// must never prompt, and must not write a cache — the downloads directory is
// the cache, and it is already verified.
func (in *Installer) mlxPipInstall(ctx context.Context, stagedPython string) error {
	downloads, err := in.Layout.DownloadsDir()
	if err != nil {
		return err
	}
	wheels := EngineWheels()
	specs := make([]string, 0, len(wheels))
	for _, w := range wheels {
		specs = append(specs, w.Name+"=="+w.Version)
	}
	pipCtx, cancel := context.WithTimeout(ctx, mlxPipInstallTimeout)
	defer cancel()
	env := append(os.Environ(), "PIP_DISABLE_PIP_VERSION_CHECK=1", "PIP_NO_INPUT=1")
	args := append([]string{
		"-m", "pip", "install",
		"--no-index", "--no-deps", "--no-cache-dir", "--find-links", downloads,
	}, specs...)
	if _, err := in.runCommand()(pipCtx, stagedPython, &RunOptions{Env: env}, args...); err != nil {
		return fmt.Errorf("embeddedllm: installing the pinned engine wheels (offline, %d distributions): %w", len(specs), err)
	}
	in.logger().Info("embedded LLM engine wheels installed",
		"distributions", len(specs), "source", downloads)
	return nil
}

// mlxSmoke proves the pinned engine imports in the provisioned interpreter
// before the multi-gigabyte pack is fetched. It deliberately does NOT import
// MLX or touch Metal: the load path's /v1/models readiness poll is the proof
// that the GPU stack runs, and a smoke test that allocated a Metal context
// here would hold memory the gate just finished pricing.
func (in *Installer) mlxSmoke(ctx context.Context, stagedPython string) error {
	smokeCtx, cancel := context.WithTimeout(ctx, mlxSmokeTimeout)
	defer cancel()
	out, err := in.runCommand()(smokeCtx, stagedPython, nil,
		"-c", "import mtplx, mtplx.cli; v = getattr(mtplx, '__version__', 'unknown'); print(v)")
	if err != nil {
		return fmt.Errorf("%w: the pinned MTPLX engine did not import in the provisioned Python (%s): %s",
			ErrSmokeTestFailed, strings.TrimSpace(out), mlxSmokeHint())
	}
	if !strings.Contains(out, MTPLXVersion) {
		in.logger().Warn("embedded LLM engine smoke test reported an unexpected version",
			"want", MTPLXVersion, "got", strings.TrimSpace(out))
	}
	return nil
}

func mlxSmokeHint() string {
	return "the wheel set in the pinned table and the interpreter it was installed into have to agree; " +
		"re-run the install, and if it persists the pin bump that changed mlxpins.go is suspect"
}

// checkWholeSetDiskSpaceMLX is the whole-set disk guard with the engine's
// extra headroom: the archives are not the footprint, because the CPython
// archive is extracted and the wheels are unpacked into it.
func (in *Installer) checkWholeSetDiskSpaceMLX(assets []Asset) error {
	required := RequiredFreeBytes(TotalBytes(assets)) + mlxProvisionHeadroomBytes
	free, err := in.freeSpace()(in.Layout.ModelRoot)
	if err != nil {
		in.logger().Warn("disk space check unavailable, proceeding without the whole-set guard",
			"path", in.Layout.ModelRoot, "required", required, "error", err)
		return nil //nolint:nilerr // best-effort guard; the write fails safely on ENOSPC
	}
	if free < required {
		return fmt.Errorf("%w for the full embedded-LLM set: %s available at %s, %s required "+
			"(artifacts %s + provisioning headroom %s)",
			ErrInsufficientDisk, formatBytes(free), in.Layout.ModelRoot,
			formatBytes(required), formatBytes(required-DefaultDiskHeadroom-mlxProvisionHeadroomBytes),
			formatBytes(mlxProvisionHeadroomBytes))
	}
	return nil
}

// runCommand is the Installer.RunCommand seam with its production default.
func (in *Installer) runCommand() CommandRunner {
	if in.RunCommand != nil {
		return in.RunCommand
	}
	return defaultCommandRunner
}
