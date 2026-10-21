package embeddedllm

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
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

// ---------------------------------------------------------------------------
// The hermetic provisioning flow: installMLX end to end against a tiny fake
// asset set, a recorded "interpreter", and the real Downloader on an
// httptest server — no network, no real pip, no real Python.
// ---------------------------------------------------------------------------

// mlxFlowAssets builds the tiny fake asset set the flow tests provision: one
// staged-extracted CPython archive, two wheels, two pack files.
func mlxFlowAssets(t *testing.T, base string) (assetSet []Asset, served map[string][]byte) {
	t.Helper()
	pythonBody := tarGzBytes(t, []archiveFile{
		{name: "python/bin/python3.12", body: "#!/bin/sh\n", mode: 0o755},
	})
	files := map[string][]byte{
		"cpython-test-install_only.tar.gz": pythonBody,
		"fake_a-1.0-py3-none-any.whl":      []byte("fake wheel a bytes"),
		"fake_b-2.0-py3-none-any.whl":      []byte("fake wheel b bytes"),
		"model.safetensors":                bytes.Repeat([]byte{0xA5}, 4096),
		"config.json":                      []byte(`{"model_type":"bonsai"}`),
	}
	asset := func(component Component, name string) Asset {
		body := files[name]
		sum := sha256.Sum256(body)
		return Asset{
			Component:   component,
			URL:         base + "/" + name,
			SHA256:      hex.EncodeToString(sum[:]),
			SizeBytes:   int64(len(body)),
			ArchiveName: name,
		}
	}
	assets := []Asset{
		asset(ComponentPython, "cpython-test-install_only.tar.gz"),
		asset(ComponentEngineWheels, "fake_a-1.0-py3-none-any.whl"),
		asset(ComponentEngineWheels, "fake_b-2.0-py3-none-any.whl"),
		asset(ComponentMLXPack, "model.safetensors"),
		asset(ComponentMLXPack, "config.json"),
	}
	return assets, files
}

// mlxChildCall is one recorded interpreter invocation: the argv and the
// complete environment the installer handed the child.
type mlxChildCall struct {
	name string
	args []string
	env  []string
}

// mlxInterpreter is the fake staged interpreter: it records every invocation
// and behaves like the pinned tree's toolchain — "pip" materializes the files
// a real install would leave in the tree, the smoke import reports the pinned
// version (or fails, for the rebuild-failure case).
type mlxInterpreter struct {
	mu        sync.Mutex
	calls     []mlxChildCall
	failSmoke bool
}

func (m *mlxInterpreter) run(_ context.Context, name string, opts *RunOptions, args ...string) (string, error) {
	var env []string
	if opts != nil {
		env = append([]string(nil), opts.Env...)
	}
	m.mu.Lock()
	m.calls = append(m.calls, mlxChildCall{name: name, args: append([]string(nil), args...), env: env})
	failSmoke := m.failSmoke
	m.mu.Unlock()

	switch {
	case len(args) > 3 && args[0] == "-I" && args[1] == "-m" && args[2] == "pip":
		// "pip install" wrote its wheels into the staged tree.
		tree := filepath.Dir(filepath.Dir(filepath.Dir(name)))
		if err := mkdirAll(filepath.Join(tree, "bin")); err != nil {
			return "", err
		}
		script := filepath.Join(tree, "bin", "mtplx")
		if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 0\n"), 0o750); err != nil {
			return "", err
		}
		return "", nil
	case len(args) > 1 && args[0] == "-I" && args[1] == "-c":
		if failSmoke {
			return "boom", errors.New("exit status 1")
		}
		return MTPLXVersion + "\n", nil
	default:
		return "", errors.New("unexpected child invocation")
	}
}

// call picks the recorded invocation args wants as a prefix of its argv.
func (m *mlxInterpreter) call(match func(args []string) bool) (mlxChildCall, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.calls {
		if match(c.args) {
			return c, true
		}
	}
	return mlxChildCall{}, false
}

// mlxFlowFixture wires the whole flow: layout, fake asset seam, downloader
// against the file server, recorded interpreter, fixed clock — and seeds the
// persistent downloads area with one stale foreign wheel the sweep must
// remove. The returned map holds the served bytes for content assertions.
func mlxFlowFixture(t *testing.T) (inst *Installer, interpreter *mlxInterpreter, lay Layout, served map[string][]byte, staleWheel string) {
	t.Helper()
	var files map[string][]byte
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := files[strings.TrimPrefix(r.URL.Path, "/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)

	agentDir := t.TempDir()
	layout, err := NewLayout(
		filepath.Join(agentDir, "runtimes"),
		filepath.Join(agentDir, "models", "bonsai-2-27b"),
		filepath.Join(agentDir, "models", "bonsai-2-27b-mlx"),
	)
	if err != nil {
		t.Fatalf("NewLayout: %v", err)
	}
	if err := layout.EnsureRoots(); err != nil {
		t.Fatalf("EnsureRoots: %v", err)
	}
	assets, files := mlxFlowAssets(t, srv.URL)

	// A foreign wheel the CURRENT pin table does not carry, surviving in the
	// persistent cache from an older table.
	downloads, err := layout.DownloadsDir()
	if err != nil {
		t.Fatalf("DownloadsDir: %v", err)
	}
	stale := filepath.Join(downloads, "stale-9.9-py3-none-any.whl")
	if err := os.WriteFile(stale, []byte("stale bytes from an old pin table"), 0o640); err != nil {
		t.Fatalf("seeding the stale wheel: %v", err)
	}
	prevAssets := mlxProvisionAssets
	mlxProvisionAssets = func(string) ([]Asset, error) { return assets, nil }
	t.Cleanup(func() { mlxProvisionAssets = prevAssets })

	interp := &mlxInterpreter{}
	dl := NewDownloader(srv.Client(), dlDiscardLogger())
	dl.FreeSpace = func(string) (int64, error) { return 1 << 40, nil }
	installer := &Installer{
		Layout:     layout,
		Sink:       &recordingSink{},
		Logger:     dlDiscardLogger(),
		Downloader: dl,
		Probe: func(context.Context, *slog.Logger) (Hardware, error) {
			return Hardware{Platform: PlatformDarwinARM64, Arch: "arm64", RAMGiB: 24, Backend: BackendMetal}, nil
		},
		RunCommand:   interp.run,
		AllocatePort: func(context.Context) (int, error) { return 41977, nil },
		Now:          func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) },
		HostOS:       "darwin",
	}
	return installer, interp, layout, files, stale
}

// TestInstallMLXProvisioningFlow runs installMLX end to end hermetically and
// asserts what a real install must leave behind: the promoted tree, the
// swapped pack, a manifest with per-file digests, the registered install
// state, the offline pip and smoke invocations, and a downloads cache cleaned
// of foreign files.
func TestInstallMLXProvisioningFlow(t *testing.T) {
	installer, interp, layout, files, stale := mlxFlowFixture(t)

	report, err := installer.Install(context.Background(), InstallOptions{
		Engine:   EngineMTPLX,
		Platform: PlatformDarwinARM64,
	})
	if err != nil {
		t.Fatalf("Install: %v", err)
	}

	// The promoted tree carries the materialized interpreter stack and the
	// files "pip" wrote; no staging tree survives.
	runtimeDir := report.RuntimeDir
	if !pathExists(filepath.Join(runtimeDir, "python", "bin", pythonBinName)) {
		t.Fatal("the promoted tree is missing the managed interpreter")
	}
	if !pathExists(filepath.Join(runtimeDir, "bin", "mtplx")) {
		t.Fatal("the promoted tree is missing the console script pip wrote")
	}
	workDir, err := layout.MLXRuntimeWorkDir()
	if err != nil {
		t.Fatalf("MLXRuntimeWorkDir: %v", err)
	}
	if pathExists(workDir) {
		t.Fatal("the staging work tree survived the promotion")
	}

	// The pack was swapped whole: both files, byte-identical, no staging left.
	packStaging, err := layout.MLXPackStagingDir()
	if err != nil {
		t.Fatalf("MLXPackStagingDir: %v", err)
	}
	if pathExists(packStaging) {
		t.Fatal("the pack staging tree survived the swap")
	}
	packOld, err := layout.MLXPackRetiredDir()
	if err != nil {
		t.Fatalf("MLXPackRetiredDir: %v", err)
	}
	if pathExists(packOld) {
		t.Fatal("the retired pack tree survived the swap")
	}
	for _, name := range []string{"model.safetensors", "config.json"} {
		got, err := os.ReadFile(filepath.Join(report.ModelFile, name))
		if err != nil {
			t.Fatalf("reading the promoted %s: %v", name, err)
		}
		if !bytes.Equal(got, files[name]) {
			t.Fatalf("promoted %s does not match the served bytes", name)
		}
	}

	// The manifest: mtplx identity fields, the machine snapshot, and PER-FILE
	// digests — one key per artifact, never one per component.
	manifestPath, err := layout.ManifestPath()
	if err != nil {
		t.Fatalf("ManifestPath: %v", err)
	}
	manifest, err := ReadManifest(manifestPath)
	if err != nil {
		t.Fatalf("ReadManifest: %v", err)
	}
	if manifest.Engine != EngineMTPLX || manifest.PythonVersion != pythonInstallVersion || manifest.PackRevision != MLXPackRevision {
		t.Fatalf("manifest identity = (%s, %s, %s)", manifest.Engine, manifest.PythonVersion, manifest.PackRevision)
	}
	if manifest.Topology == nil || manifest.Topology.HostRAMGiB != 24 || !manifest.Topology.Unified {
		t.Fatalf("manifest topology = %+v, want the 24 GiB unified snapshot", manifest.Topology)
	}
	if manifest.Checksums["python"] == "" {
		t.Fatal("the python archive recorded no digest under its component key")
	}
	for _, name := range []string{"fake_a-1.0-py3-none-any.whl", "fake_b-2.0-py3-none-any.whl", "model.safetensors", "config.json"} {
		if manifest.Checksums[name] == "" {
			t.Fatalf("checksums has no per-file digest for %s (keys: %v)", name, manifest.Checksums)
		}
	}
	if manifest.Checksums["model.safetensors"] == manifest.Checksums["config.json"] {
		t.Fatal("two different pack files collapsed to one digest — the component-key bug")
	}

	// The install state the sink received: every identity field filled.
	sink, ok := installer.Sink.(*recordingSink)
	if !ok {
		t.Fatalf("the sink is %T, want *recordingSink", installer.Sink)
	}
	states := sink.installCalls()
	if len(states) != 1 {
		t.Fatalf("ApplyInstalled calls = %d, want 1", len(states))
	}
	state := states[0]
	if state.Engine != EngineMTPLX || state.PythonVersion == "" || state.PackRevision == "" {
		t.Fatalf("InstallState identity = (%q, %q, %q), want engine and both mtplx pins set",
			state.Engine, state.PythonVersion, state.PackRevision)
	}

	// The pip child: isolated interpreter, offline, hash-pinned, scrubbed env.
	pip, ok := interp.call(func(args []string) bool {
		return len(args) > 3 && args[0] == "-I" && args[1] == "-m" && args[2] == "pip"
	})
	if !ok {
		t.Fatal("the installer never invoked pip in the staged interpreter")
	}
	pipArgs := strings.Join(pip.args, " ")
	for _, flag := range []string{"--no-index", "--no-deps", "--only-binary=:all:", "--require-hashes", "--find-links", "-r"} {
		if !strings.Contains(pipArgs, flag) {
			t.Fatalf("pip argv %q is missing %s", pipArgs, flag)
		}
	}
	if strings.Contains(pipArgs, "-c import") {
		t.Fatal("pip argv is polluted with the smoke invocation")
	}
	envByName := map[string]string{}
	for _, entry := range pip.env {
		if name, value, found := strings.Cut(entry, "="); found {
			envByName[name] = value
		}
	}
	if envByName["PYTHONNOUSERSITE"] != "1" {
		t.Fatal("pip env does not disable user site-packages")
	}
	if envByName["MTPLX_CONFIG"] == "" || envByName["MTPLX_MODEL_DIR"] == "" {
		t.Fatal("pip env does not set the engine state isolation")
	}
	for _, name := range []string{"PIP_FIND_LINKS", "PYTHONPATH", "PYTHONHOME", "MTPLX_CONFIG", "PIP_INDEX_URL"} {
		if count := strings.Count(strings.Join(pip.env, "\n"), name+"="); count > 1 {
			t.Fatalf("pip env carries %s more than once (%d) — the inherited duplicate hazard", name, count)
		}
	}
	if !strings.HasPrefix(envByName["PATH"], filepath.Dir(pip.name)+":") {
		t.Fatalf("PATH %q does not lead with the pinned bin dir", envByName["PATH"])
	}

	// The smoke child: same isolation, the import probe.
	smoke, ok := interp.call(func(args []string) bool {
		return len(args) > 1 && args[0] == "-I" && args[1] == "-c"
	})
	if !ok {
		t.Fatal("the installer never ran the import smoke test")
	}
	smokeEnv := strings.Join(smoke.env, "\n")
	if strings.Contains(smokeEnv, "PYTHONPATH=") || strings.Contains(smokeEnv, "PIP_FIND_LINKS=") {
		t.Fatal("the smoke child inherited a steering environment")
	}

	// The downloads cache: the foreign wheel is swept, the pinned files stay.
	if pathExists(stale) {
		t.Fatal("the stale foreign wheel survived the downloads sweep")
	}
	downloads, err := layout.DownloadsDir()
	if err != nil {
		t.Fatalf("DownloadsDir: %v", err)
	}
	for _, name := range []string{"cpython-test-install_only.tar.gz", "fake_a-1.0-py3-none-any.whl", "fake_b-2.0-py3-none-any.whl"} {
		if !pathExists(filepath.Join(downloads, name)) {
			t.Fatalf("the cache lost its verified %s", name)
		}
	}
}

// TestInstallMLXFailedRebuildKeepsPreviousTree is the #4 regression guard: a
// rebuild whose smoke test fails must leave the PREVIOUS working tree, its
// manifest and its registration fully intact.
func TestInstallMLXFailedRebuildKeepsPreviousTree(t *testing.T) {
	installer, interp, layout, _, _ := mlxFlowFixture(t)
	ctx := context.Background()

	if _, err := installer.Install(ctx, InstallOptions{Engine: EngineMTPLX, Platform: PlatformDarwinARM64}); err != nil {
		t.Fatalf("first Install: %v", err)
	}
	runtimeDir, err := layout.MLXRuntimeDir()
	if err != nil {
		t.Fatalf("MLXRuntimeDir: %v", err)
	}
	manifestPath, err := layout.ManifestPath()
	if err != nil {
		t.Fatalf("ManifestPath: %v", err)
	}
	before, err := ReadManifest(manifestPath)
	if err != nil {
		t.Fatalf("ReadManifest(before): %v", err)
	}

	// The rebuild: same fixture, the fake smoke now fails.
	interp.mu.Lock()
	interp.failSmoke = true
	interp.mu.Unlock()
	_, err = installer.Install(ctx, InstallOptions{Engine: EngineMTPLX, Platform: PlatformDarwinARM64})
	if !errors.Is(err, ErrSmokeTestFailed) {
		t.Fatalf("rebuild error = %v, want ErrSmokeTestFailed", err)
	}

	// The previous tree still runs: interpreter, pip-written console script.
	if !pathExists(filepath.Join(runtimeDir, "python", "bin", pythonBinName)) {
		t.Fatal("the failed rebuild removed the previous interpreter")
	}
	if !pathExists(filepath.Join(runtimeDir, "bin", "mtplx")) {
		t.Fatal("the failed rebuild removed the previous console script")
	}
	// The manifest and the registration still describe the surviving install.
	after, err := ReadManifest(manifestPath)
	if err != nil {
		t.Fatalf("ReadManifest(after): %v", err)
	}
	if after.InstalledAt != before.InstalledAt || after.ContextSize != before.ContextSize {
		t.Fatalf("the failed rebuild rewrote the manifest: %+v vs %+v", after, before)
	}
	sink, ok := installer.Sink.(*recordingSink)
	if !ok {
		t.Fatalf("the sink is %T, want *recordingSink", installer.Sink)
	}
	if calls := sink.installCalls(); len(calls) != 1 {
		t.Fatalf("ApplyInstalled calls = %d, want 1 (the failed rebuild must not re-register)", len(calls))
	}
}
