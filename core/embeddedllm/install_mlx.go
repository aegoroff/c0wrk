package embeddedllm

// The mtplx engine's provisioning flow (ADR-092). It mirrors the llama
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
//   - the weights are a DIRECTORY of pinned files (the pack): every file is
//     fetched and verified into a staging sibling and the directory is swapped
//     atomically, so no mid-fetch failure can ever leave two pack revisions
//     mixed under one manifest.
//
// Nothing here ever runs `mtplx pull` or lets the engine fetch its own bytes:
// every artifact the tree contains was downloaded and verified by this
// package's Downloader against the pins in mlxpins.go.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
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
	// mlxRequirementsName is the pin-generated requirements file the offline
	// pip install runs against, written into the staging tree and removed
	// before the tree is promoted.
	mlxRequirementsName = "mlx-requirements.txt"
)

// mlxProvisionAssets is the provisioning seam over EngineArtifactSet. The
// production value IS EngineArtifactSet; a test replaces it to provision a
// tiny fake artifact set hermetically (no network, no real pins), the same
// way the llama path tests through the assetTable seam.
var mlxProvisionAssets = EngineArtifactSet

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
	// whose memory no window fits plans no assets and downloads nothing. The
	// plan is made from the operator's tuning (the same one the preflight
	// CheckMemoryBudget priced), so `context.mode: exact` is honored here and
	// the persisted plan is what the operator configured.
	terms, err := PinnedMLXMemoryTerms()
	if err != nil {
		return nil, err
	}
	plan, err := PlanMLX(hw.RAMGiB, opts.Tuning, terms)
	if err != nil {
		return nil, fmt.Errorf("embeddedllm: %w", err)
	}
	assets, err := mlxProvisionAssets(platform)
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
	// a previous attempt's staging is rebuilt from scratch: a partial rebuild
	// is a cache of verified downloads, never a half-installed engine. The
	// PREVIOUS engine tree is left untouched until the promotion below — a
	// failed pip run or smoke test here must leave the working install in
	// place (layout.go's staging invariant).
	runtimeDir, err := in.Layout.MLXRuntimeDir()
	if err != nil {
		return nil, err
	}
	workDir, err := in.Layout.MLXRuntimeWorkDir()
	if err != nil {
		return nil, err
	}
	if err := in.prepareStaging(workDir); err != nil {
		return nil, err
	}
	// The downloads area is a persistent cache shared across installs and pin
	// bumps. Anything it holds that the CURRENT pin table does not name is a
	// stale artifact of an older table: sweep it before fetching, so the pip
	// step's --find-links source only ever carries files this build's pins
	// own (the files themselves are verified against the current pins by the
	// downloader gate regardless).
	if err := in.mlxSweepDownloads(); err != nil {
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

	// 4. The wheels, offline: the download directory is the only source and
	// the requirements file pins every distribution to its exact sha256, so
	// pip accepts no bytes this table did not verify — a stale or foreign
	// wheel of the same name==version fails HERE instead of installing. The
	// child runs on mlxChildEnv (no inherited PIP_*/PYTHON*/MTPLX_* influence)
	// and an isolated interpreter (-I), so neither the operator's environment
	// nor user site-packages can steer the build. The engine tree is the cache
	// and everything in it is already verified; there is nothing for pip to
	// fetch and nowhere to phone home (--no-index).
	if err := in.mlxPipInstall(ctx, stagedPython, workDir); err != nil {
		return nil, err
	}

	// 5. Smoke test: the pinned engine must import in THIS interpreter before
	// the multi-gigabyte pack is fetched.
	if err := in.mlxSmoke(ctx, stagedPython, workDir); err != nil {
		return nil, err
	}

	// 6. Promote the finished tree. This is the FIRST touch of the previous
	// tree: it survives every failure above, so a failed rebuild leaves the
	// machine with a working engine.
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

	// 7. The weight pack, staged and swapped WHOLE. The pack is a set of 16
	// files that only make sense together (weights, MTP head, tokenizer stack
	// and serving contract from ONE revision), so per-file verify-then-promote
	// is not atomicity enough: a mid-fetch failure would leave two revisions
	// mixed under the old manifest and the next launch would serve it
	// silently. Every file is fetched and hash-verified into a staging
	// sibling first; the swap below is two renames, so the pack directory is
	// always exactly one revision.
	packDir, err := in.Layout.MLXPackDir()
	if err != nil {
		return nil, err
	}
	packStaging, err := in.Layout.MLXPackStagingDir()
	if err != nil {
		return nil, err
	}
	if err := in.prepareStaging(packStaging); err != nil {
		return nil, err
	}
	for _, asset := range packAssets {
		dst, derr := in.Layout.safeJoin(packStaging, asset.ArchiveName)
		if derr != nil {
			return nil, derr
		}
		digest, ferr := in.fetchOneTo(ctx, opts, asset, dst)
		if ferr != nil {
			return nil, fmt.Errorf("embeddedllm: fetching the MLX weight pack: %w", ferr)
		}
		checksums[checksumKey(asset)] = digest
		in.emit(opts, Progress{Component: asset.Component, Stage: StageDone,
			BytesDone: asset.SizeBytes, BytesTotal: asset.SizeBytes})
	}
	// The swap: the previous pack steps aside, the staged revision takes its
	// place, and only then is the old tree deleted. A failure before this
	// point leaves the previous pack and the previous manifest fully
	// consistent; the only window left is a crash BETWEEN the swap and the
	// manifest write below, which leaves the NEW (complete) revision recorded
	// under the OLD manifest — stale, never a mixture.
	packOld, err := in.Layout.MLXPackRetiredDir()
	if err != nil {
		return nil, err
	}
	if pathExists(packDir) {
		if err := in.removeOwned(packOld); err != nil {
			return nil, err
		}
		if err := os.Rename(packDir, packOld); err != nil {
			return nil, fmt.Errorf("embeddedllm: retiring the previous MLX weight pack: %w", err)
		}
	}
	if err := os.Rename(packStaging, packDir); err != nil {
		return nil, fmt.Errorf("embeddedllm: promoting the staged MLX weight pack: %w", err)
	}
	if err := in.removeOwned(packOld); err != nil {
		return nil, err
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
		// The machine shape this plan was priced from: the RAM probe is the
		// only evidence this engine has (no llama device inventory), the pool
		// is unified, and the budget is the measured ¾-of-RAM the planner
		// spent. The launch's live re-plan takes the RAM from here.
		Topology: &MemoryTopology{
			HostRAMGiB:        hw.RAMGiB,
			Unified:           true,
			DeviceBudgetBytes: mlxEngineBudgetBytes(hw.RAMGiB),
			HostBudgetBytes:   mlxEngineBudgetBytes(hw.RAMGiB),
			ProbedAt:          installedAt,
		},
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
		Engine:            EngineMTPLX,
		Packing:           manifest.Packing,
		Backend:           manifest.Backend,
		Port:              manifest.Port,
		ModelFile:         manifest.ModelFile,
		RuntimeVersion:    manifest.RuntimeVersion,
		InstalledAt:       manifest.InstalledAt,
		ContextSize:       manifest.ContextSize,
		PythonVersion:     manifest.PythonVersion,
		PackRevision:      manifest.PackRevision,
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
// offline. The requirements file is generated from the pin table — one
// `name==version --hash=sha256:<pin>` line per wheel — and pip is run with
// --require-hashes against the verified downloads directory, so the bytes it
// installs cannot be anything but the pinned files: a foreign find-links
// source, a stale same-version wheel that survived a pin bump, or any other
// substitute fails HERE instead of entering the engine tree. Environment
// hygiene is mlxChildEnv's: no inherited PIP_*/PYTHON*/MTPLX_* influence, no
// user site-packages, and the interpreter runs isolated (-I).
func (in *Installer) mlxPipInstall(ctx context.Context, stagedPython, workDir string) error {
	downloads, err := in.Layout.DownloadsDir()
	if err != nil {
		return err
	}
	wheels := EngineWheels()
	reqPath, err := in.Layout.safeJoin(workDir, mlxRequirementsName)
	if err != nil {
		return err
	}
	var req strings.Builder
	for _, w := range wheels {
		fmt.Fprintf(&req, "%s==%s --hash=sha256:%s\n", w.Name, w.Version, w.Asset.SHA256)
	}
	if err := os.WriteFile(reqPath, []byte(req.String()), 0o640); err != nil {
		return fmt.Errorf("embeddedllm: writing the pinned wheel requirements: %w", err)
	}
	defer func() { _ = os.Remove(reqPath) }() // never promoted with the tree

	pipCtx, cancel := context.WithTimeout(ctx, mlxPipInstallTimeout)
	defer cancel()
	env := mlxChildEnv(os.Environ(), in.hostOS(), stagedPython)
	args := []string{
		"-I", "-m", "pip", "install",
		"--no-index", "--no-deps", "--only-binary=:all:", "--require-hashes",
		"--no-cache-dir", "--disable-pip-version-check", "--no-input",
		"--find-links", downloads,
		"-r", reqPath,
	}
	if _, err := in.runCommand()(pipCtx, stagedPython, &RunOptions{Env: env}, args...); err != nil {
		return fmt.Errorf("embeddedllm: installing the pinned engine wheels (offline, %d distributions): %w", len(wheels), err)
	}
	in.logger().Info("embedded LLM engine wheels installed",
		"distributions", len(wheels), "source", downloads)
	return nil
}

// mlxSmoke proves the pinned engine imports in the provisioned interpreter
// before the multi-gigabyte pack is fetched. It deliberately does NOT import
// MLX or touch Metal: the load path's /v1/models readiness poll is the proof
// that the GPU stack runs, and a smoke test that allocated a Metal context
// here would hold memory the gate just finished pricing. The child runs on
// mlxChildEnv and an isolated interpreter (-I), so the import it proves is
// the pinned tree's own, not an operator shadow.
func (in *Installer) mlxSmoke(ctx context.Context, stagedPython, workDir string) error {
	smokeCtx, cancel := context.WithTimeout(ctx, mlxSmokeTimeout)
	defer cancel()
	env := mlxChildEnv(os.Environ(), in.hostOS(), stagedPython)
	out, err := in.runCommand()(smokeCtx, stagedPython, &RunOptions{Env: env},
		"-I", "-c", "import mtplx, mtplx.cli; v = getattr(mtplx, '__version__', 'unknown'); print(v)")
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

// mlxSweepDownloads prunes the persistent downloads area of everything the
// CURRENT pin table does not name. The area survives installs and pin bumps
// by design (cache hits), but its occupants must stay this build's own: a
// wheel left by an older table can satisfy the same distribution name while
// carrying different bytes. --require-hashes is the primary enforcement at
// the pip step; this sweep is what keeps the --find-links source itself
// clean. Files the current table DOES name are left for the downloader to
// reuse (it re-verifies them against the pins on every cache hit).
func (in *Installer) mlxSweepDownloads() error {
	downloads, err := in.Layout.DownloadsDir()
	if err != nil {
		return err
	}
	pinned := make(map[string]bool, 1+len(mtplxWheelPins))
	pinned[pythonArchiveAsset.ArchiveName] = true
	for _, w := range mtplxWheelPins {
		pinned[w.Asset.ArchiveName] = true
	}
	entries, err := os.ReadDir(downloads)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil // nothing downloaded yet: nothing to sweep
		}
		return fmt.Errorf("embeddedllm: reading the downloads area: %w", err)
	}
	for _, entry := range entries {
		if pinned[entry.Name()] {
			continue
		}
		stale, serr := in.Layout.safeJoin(downloads, entry.Name())
		if serr != nil {
			return serr
		}
		if err := in.removeOwned(stale); err != nil {
			return err
		}
		in.logger().Info("removed a download the current pin table does not carry",
			"name", entry.Name())
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
