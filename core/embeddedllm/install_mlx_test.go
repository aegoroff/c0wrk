package embeddedllm

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Layout: the MLX roots and their containment
// ---------------------------------------------------------------------------

func TestLayoutMLXPaths(t *testing.T) {
	agentDir := t.TempDir()
	layout, err := NewLayout(
		filepath.Join(agentDir, "runtimes"),
		filepath.Join(agentDir, "models", "bonsai-2-27b"),
		filepath.Join(agentDir, "models", "bonsai-2-27b-mlx"),
	)
	if err != nil {
		t.Fatalf("NewLayout: %v", err)
	}

	if got, want := MLXRuntimeDirName(), "mtplx-"+MTPLXVersion; got != want {
		t.Fatalf("MLXRuntimeDirName = %q, want %q", got, want)
	}
	runtimeDir, err := layout.MLXRuntimeDir()
	if err != nil || runtimeDir != filepath.Join(agentDir, "runtimes", MLXRuntimeDirName()) {
		t.Fatalf("MLXRuntimeDir = %q (%v)", runtimeDir, err)
	}
	packDir, err := layout.MLXPackDir()
	if err != nil || packDir != filepath.Join(agentDir, "models", "bonsai-2-27b-mlx", "pack") {
		t.Fatalf("MLXPackDir = %q (%v)", packDir, err)
	}

	// The engine's downloads stage in the shared downloads area; the pack
	// lands in its own root.
	python, _ := PythonArchiveAsset()
	dst, err := layout.Destination(python)
	if err != nil || !strings.HasSuffix(dst, filepath.Join("downloads", python.ArchiveName)) {
		t.Fatalf("python destination = %q (%v), want the downloads area", dst, err)
	}
	wheel, _ := EngineWheel("mtplx")
	dst, err = layout.Destination(wheel.Asset)
	if err != nil || !strings.HasSuffix(dst, filepath.Join("downloads", wheel.Asset.ArchiveName)) {
		t.Fatalf("wheel destination = %q (%v), want the downloads area", dst, err)
	}
	packFile, _ := MLXPackFile("model.safetensors")
	dst, err = layout.Destination(packFile)
	if err != nil || dst != filepath.Join(packDir, "model.safetensors") {
		t.Fatalf("pack destination = %q (%v), want the pack dir", dst, err)
	}

	// Containment: the third root is owned, the pack dir is a launch-time
	// boundary, and everything outside stays outside.
	if !layout.Owns(filepath.Join(agentDir, "models", "bonsai-2-27b-mlx", "pack", "config.json")) {
		t.Fatal("Owns rejects the MLX model root")
	}
	if !layout.OwnsMLXPack(filepath.Join(packDir, "model.safetensors")) {
		t.Fatal("OwnsMLXPack rejects a pack file")
	}
	if layout.OwnsMLXPack(filepath.Join(agentDir, "models", "bonsai-2-27b", "Ternary-Bonsai-2-27B-PQ2_0.gguf")) {
		t.Fatal("OwnsMLXPack accepts a llama GGUF")
	}
	if layout.OwnsMLXPack(agentDir) {
		t.Fatal("OwnsMLXPack accepts the agent dir")
	}

	// The llama and MLX roots must not nest: a NewLayout that tried would be
	// refused.
	if _, err := NewLayout(
		filepath.Join(agentDir, "runtimes"),
		filepath.Join(agentDir, "models"),
		filepath.Join(agentDir, "models", "bonsai-2-27b-mlx"),
	); !errors.Is(err, ErrLayoutInvalid) {
		t.Fatalf("nested MLX root error = %v, want ErrLayoutInvalid", err)
	}
}

func TestMLXServerPythonPath(t *testing.T) {
	dir := t.TempDir()
	got, err := MLXServerPythonPath(dir)
	if err != nil {
		t.Fatalf("MLXServerPythonPath: %v", err)
	}
	if want := filepath.Join(dir, "python", "bin", "python3.12"); got != want {
		t.Fatalf("MLXServerPythonPath = %q, want %q", got, want)
	}
	if _, err := MLXServerPythonPath(""); err == nil {
		t.Fatal("empty runtime dir accepted")
	}
}

// ---------------------------------------------------------------------------
// splitMLXAssets: the engine stack and the pack never mix
// ---------------------------------------------------------------------------

func TestSplitMLXAssets(t *testing.T) {
	assets, err := EngineArtifactSet(PlatformDarwinARM64)
	if err != nil {
		t.Fatalf("EngineArtifactSet: %v", err)
	}
	engine, pack := splitMLXAssets(assets)
	if len(engine) != 1+len(EngineWheels()) {
		t.Fatalf("engine assets = %d, want 1 python + %d wheels", len(engine), len(EngineWheels()))
	}
	if len(pack) != len(MLXPackFiles()) {
		t.Fatalf("pack assets = %d, want %d", len(pack), len(MLXPackFiles()))
	}
	if engine[0].Component != ComponentPython {
		t.Fatalf("first engine asset is %q, want python", engine[0].Component)
	}
	for _, a := range engine[1:] {
		if a.Component != ComponentEngineWheels {
			t.Fatalf("engine asset %q is %q, want wheels", a.ArchiveName, a.Component)
		}
	}
	for _, a := range pack {
		if a.Component != ComponentMLXPack {
			t.Fatalf("pack asset %q is %q, want pack", a.ArchiveName, a.Component)
		}
	}
}

// ---------------------------------------------------------------------------
// Install dispatch: the engine branch refuses the wrong machine before any
// download, using the same probe seam the llama path uses.
// ---------------------------------------------------------------------------

func TestInstallMLXRefusesNonDarwinBeforeAnyDownload(t *testing.T) {
	agentDir := t.TempDir()
	layout, err := NewLayout(
		filepath.Join(agentDir, "runtimes"),
		filepath.Join(agentDir, "models", "bonsai-2-27b"),
		filepath.Join(agentDir, "models", "bonsai-2-27b-mlx"),
	)
	if err != nil {
		t.Fatalf("NewLayout: %v", err)
	}
	sink := &recordingSink{}
	installer := NewInstaller(layout, discardLogger())
	installer.Sink = sink
	// The platform override is what routes the refusal; the probe never gets
	// a chance to run (the dispatch precedes it on purpose).
	_, err = installer.Install(context.Background(), InstallOptions{
		Engine:   EngineMTPLX,
		Platform: PlatformLinuxAMD64,
	})
	if !errors.Is(err, ErrEngineUnsupportedPlatform) {
		t.Fatalf("Install(mtplx, linux) error = %v, want ErrEngineUnsupportedPlatform", err)
	}
	if len(sink.installCalls()) != 0 {
		t.Fatal("the refusal registered an install")
	}
	// And the refusal happened before anything was created beyond the layout
	// roots the probeless path never reached.
	if pathExists(filepath.Join(agentDir, "runtimes", MLXRuntimeDirName())) {
		t.Fatal("the refusal left an engine tree behind")
	}
}

// ---------------------------------------------------------------------------
// Scoped removal: projection is llama-only, and the engine decides from the
// on-disk manifest.
// ---------------------------------------------------------------------------

func TestRemoveProjectionRefusedOnMLXManifest(t *testing.T) {
	agentDir := t.TempDir()
	layout, err := NewLayout(
		filepath.Join(agentDir, "runtimes"),
		filepath.Join(agentDir, "models", "bonsai-2-27b"),
		filepath.Join(agentDir, "models", "bonsai-2-27b-mlx"),
	)
	if err != nil {
		t.Fatalf("NewLayout: %v", err)
	}
	manifestPath, err := layout.ManifestPath()
	if err != nil {
		t.Fatalf("ManifestPath: %v", err)
	}
	manifest := Manifest{Engine: EngineMTPLX, RuntimeVersion: MTPLXVersion, Port: 1}
	if err := writeManifest(manifestPath, manifest, discardLogger()); err != nil {
		t.Fatalf("writeManifest: %v", err)
	}

	installer := NewInstaller(layout, discardLogger())
	sink := &recordingSink{}
	installer.Sink = sink
	err = installer.RemoveWithScope(context.Background(), RemoveProjection)
	if !errors.Is(err, ErrNoProjectionOnMLX) {
		t.Fatalf("RemoveWithScope(projection on mtplx) error = %v, want ErrNoProjectionOnMLX", err)
	}
	// Every scope still clears the manifest and the config: the on-disk state
	// is "not installed" even when the scope itself was refused.
	if sink.removedCalls != 1 {
		t.Fatalf("ApplyRemoved calls = %d, want 1", sink.removedCalls)
	}
	if _, err := ReadManifest(manifestPath); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("manifest read = %v, want ErrNotInstalled", err)
	}
}

func TestRecordedEngine(t *testing.T) {
	agentDir := t.TempDir()
	layout, err := NewLayout(
		filepath.Join(agentDir, "runtimes"),
		filepath.Join(agentDir, "models", "bonsai-2-27b"),
		filepath.Join(agentDir, "models", "bonsai-2-27b-mlx"),
	)
	if err != nil {
		t.Fatalf("NewLayout: %v", err)
	}
	installer := NewInstaller(layout, discardLogger())
	if got := installer.recordedEngine(); got != EngineLlama {
		t.Fatalf("no manifest: recordedEngine = %q, want llama", got)
	}
	manifestPath, err := layout.ManifestPath()
	if err != nil {
		t.Fatalf("ManifestPath: %v", err)
	}
	if err := writeManifest(manifestPath, Manifest{Engine: EngineMTPLX}, discardLogger()); err != nil {
		t.Fatalf("writeManifest: %v", err)
	}
	if got := installer.recordedEngine(); got != EngineMTPLX {
		t.Fatalf("mtplx manifest: recordedEngine = %q, want mtplx", got)
	}
	// A pre-engine manifest (empty Engine) reads as llama.
	if err := writeManifest(manifestPath, Manifest{RuntimeVersion: RuntimeTag}, discardLogger()); err != nil {
		t.Fatalf("writeManifest: %v", err)
	}
	if got := installer.recordedEngine(); got != EngineLlama {
		t.Fatalf("legacy manifest: recordedEngine = %q, want llama", got)
	}
}

// ---------------------------------------------------------------------------
// Leftovers: the mtplx tree counts as runtime residue.
// ---------------------------------------------------------------------------

func TestDetectLeftoversSeesMLXTrees(t *testing.T) {
	agentDir := t.TempDir()
	layout, err := NewLayout(
		filepath.Join(agentDir, "runtimes"),
		filepath.Join(agentDir, "models", "bonsai-2-27b"),
		filepath.Join(agentDir, "models", "bonsai-2-27b-mlx"),
	)
	if err != nil {
		t.Fatalf("NewLayout: %v", err)
	}
	installer := NewInstaller(layout, discardLogger())
	runtimeDir, err := layout.MLXRuntimeDir()
	if err != nil {
		t.Fatalf("MLXRuntimeDir: %v", err)
	}
	if err := mkdirAll(runtimeDir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	lo, err := installer.DetectLeftovers()
	if err != nil {
		t.Fatalf("DetectLeftovers: %v", err)
	}
	if !lo.Runtime {
		t.Fatal("an mtplx-* tree is not reported as runtime leftover")
	}
	packDir, err := layout.MLXPackDir()
	if err != nil {
		t.Fatalf("MLXPackDir: %v", err)
	}
	if err := mkdirAll(packDir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	lo, err = installer.DetectLeftovers()
	if err != nil {
		t.Fatalf("DetectLeftovers: %v", err)
	}
	if !lo.Weights {
		t.Fatal("an MLX pack dir is not reported as weights leftover")
	}
	if !lo.Any() {
		t.Fatal("leftovers report as empty")
	}
}
