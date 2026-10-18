package updater

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

// This file behaviorally tests the Makefile's OpenVINO flavor stamp policy —
// the mutual-exclusion guards between fetch-onnx-openvino and fetch-onnx-gpu
// (the ADR-045/ADR-046 "stamp trap" class of bugs): the CPU wrapper laid by
// the OpenVINO flavor must never land on top of a CUDA GPU install, the GPU
// target must never replace the CPU base an OpenVINO install is built on,
// and the fetch itself must be reproducible by pinned digests. The tests run
// the real make targets against sandbox directories and a fixture wheel
// served over file://, so no network access and no real artifacts are
// involved; every pinned digest is computed from the fixture itself. The
// expected stamp values are parsed from the Makefile so the tests track the
// recipe by construction instead of hardcoding versions.

const (
	// fixturePluginContent is the payload of the fixture plugin library (the
	// file ONNX Runtime registers at run time); its digest is verified after
	// extraction, separately from the wheel digest.
	fixturePluginContent = "openvino-plugin-bytes"
	// fixtureCPUORerContent is the payload the tests seed into the sandbox
	// as the pre-installed CPU libonnxruntime.so (the targets never re-verify
	// an installed main library — the version stamp is their signal).
	fixtureCPUORerContent = "cpu-onnxruntime-bytes"
)

// makefileVersion reads a plain `NAME := value` assignment from the repo
// Makefile so the expected stamp values are derived from the recipe itself.
func makefileVersion(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(workflowRoot(t), "Makefile"))
	if err != nil {
		t.Fatalf("reading Makefile: %v", err)
	}
	re := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(name) + ` := (\S+)\s*$`)
	m := re.FindSubmatch(raw)
	if m == nil {
		t.Fatalf("Makefile does not define %s", name)
	}
	return string(m[1])
}

// fixtureWheel builds a minimal stand-in for the onnxruntime_ep_openvino
// wheel: same entry layout (flat onnxruntime_ep_openvino/ package with the
// libraries and the license note, plus files the flavor must NOT install),
// tiny placeholder payloads. Returns the wheel path and its sha256.
func fixtureWheel(t *testing.T, dir string) (path, wheelSHA, pluginSHA string) {
	t.Helper()
	entries := []struct {
		name string
		data string
	}{
		{"onnxruntime_ep_openvino/__init__.py", "python-package-file-must-not-be-installed"},
		{"onnxruntime_ep_openvino/cache.json", `{"jit": "cache-must-not-be-installed"}`},
		{"onnxruntime_ep_openvino/libonnxruntime_providers_openvino_plugin.so", fixturePluginContent},
		{"onnxruntime_ep_openvino/libonnxruntime_providers_openvino_plugin.so.1", fixturePluginContent},
		{"onnxruntime_ep_openvino/libopenvino.so.2641", "openvino-core-bytes"},
		{"onnxruntime_ep_openvino/libopenvino_intel_gpu_plugin.so", "openvino-gpu-plugin-bytes"},
		{"onnxruntime_ep_openvino/libtbb.so.12", "tbb-bytes"},
		{"onnxruntime_ep_openvino/third-party-programs.txt", "openvino-license-text"},
		{"onnxruntime_ep_openvino-1.8.0.dist-info/METADATA", "dist-info-must-not-be-installed"},
	}
	path = filepath.Join(dir, "onnxruntime_ep_openvino-1.8.0-py3-none-manylinux_2_28_x86_64.whl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("creating fixture wheel: %v", err)
	}
	pluginHash := sha256.New()
	zw := zip.NewWriter(f)
	for _, e := range entries {
		w, err := zw.Create(e.name)
		if err != nil {
			t.Fatalf("creating zip entry %s: %v", e.name, err)
		}
		if _, err := w.Write([]byte(e.data)); err != nil {
			t.Fatalf("writing zip entry %s: %v", e.name, err)
		}
		// Exact match: the .so.1 alias must not bleed into the digest the
		// Makefile verifies for the plain plugin file.
		if e.name == "onnxruntime_ep_openvino/libonnxruntime_providers_openvino_plugin.so" {
			pluginHash.Write([]byte(e.data))
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("closing zip writer: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("closing fixture wheel: %v", err)
	}
	// The Makefile pins the digest of the whole wheel FILE (the zip
	// container), so hash the finished file, not the entry payloads.
	wheelBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading finished fixture wheel: %v", err)
	}
	wheelSum := sha256.Sum256(wheelBytes)
	return path, hex.EncodeToString(wheelSum[:]), hex.EncodeToString(pluginHash.Sum(nil))
}

// openvinoSandbox seeds a sandbox install tree that looks exactly like the
// state `make build` leaves behind: a CPU libonnxruntime.so plus a matching
// plain version stamp, so the target's `$(MAKE) fetch-onnx` delegation
// short-circuits without network access. Returns the bundle and cache dirs.
func openvinoSandbox(t *testing.T, onnxVersion string) (bundle, cache string) {
	t.Helper()
	root := t.TempDir()
	bundle = filepath.Join(root, "bin")
	cache = filepath.Join(root, "cache")
	for _, d := range []string{bundle, cache, filepath.Join(cache, "onnx-openvino")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("creating sandbox dir %s: %v", d, err)
		}
	}
	if err := os.WriteFile(filepath.Join(bundle, "libonnxruntime.so"), []byte(fixtureCPUORerContent), 0o644); err != nil {
		t.Fatalf("seeding CPU library: %v", err)
	}
	if err := os.WriteFile(filepath.Join(bundle, ".onnxruntime-version"), []byte(onnxVersion), 0o644); err != nil {
		t.Fatalf("seeding CPU stamp: %v", err)
	}
	return bundle, cache
}

// runOpenVINOFetch invokes `make fetch-onnx-openvino` with every path- and
// digest-bearing variable redirected into the sandbox and the fixture wheel.
func runOpenVINOFetch(t *testing.T, bundle, cache, wheelPath, wheelSHA, pluginSHA string) (string, error) {
	t.Helper()
	return runMake(t, "fetch-onnx-openvino",
		"APP_BUNDLE_DIR="+bundle,
		"ONNX_CACHE_DIR="+cache,
		"ONNX_OV_CACHE_DIR="+filepath.Join(cache, "onnx-openvino"),
		"ONNX_STAMP="+filepath.Join(bundle, ".onnxruntime-version"),
		"ONNX_GPU_STAMP="+filepath.Join(bundle, ".onnxruntime-gpu-version"),
		"ONNX_OV_WHEEL_URL=file://"+wheelPath,
		"ONNX_OV_WHEEL_SHA256="+wheelSHA,
		"ONNX_OV_PLUGIN_SHA256="+pluginSHA,
	)
}

// runMake executes a Makefile target from the repo root with command-line
// variable overrides and returns combined output. The context is a bounded
// watchdog (not a timing assertion): these recipes finish in well under a
// second over a fixture wheel, so a hang means the recipe is wedged and
// should fail the test long before go test's global timeout.
func runMake(t *testing.T, target string, overrides ...string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "make", append([]string{target}, overrides...)...)
	cmd.Dir = workflowRoot(t)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// requireNoOpenVINOFiles asserts the bundle carries neither the plugin nor
// the flavor stamp — the "nothing installed" state every refusal path must
// leave behind.
func requireNoOpenVINOFiles(t *testing.T, bundle string) {
	t.Helper()
	for _, f := range []string{"libonnxruntime_providers_openvino_plugin.so", ".onnxruntime-openvino-version", "openvino-third-party-programs.txt"} {
		if _, err := os.Stat(filepath.Join(bundle, f)); err == nil {
			t.Errorf("refused run left %s in the bundle — the guard must install nothing", f)
		}
	}
}

// TestOpenVINOFetch_InstallsFromPinnedWheel covers the acceptance criterion
// "fetch reproducible by digest": the target downloads the fixture wheel over
// the overridden URL, verifies the pinned wheel digest, extracts the library
// set, re-verifies the plugin digest, installs everything flat next to the
// binary (and nothing else — no Python package files, no JIT cache), and
// writes the openvino stamp plus the .cache wheel stamp while leaving the
// CPU stamp untouched (the main library is unchanged — the flavor is
// additive).
func TestOpenVINOFetch_InstallsFromPinnedWheel(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skipf("fetch-onnx-openvino is Linux x64-only by design; skipping on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	onnxVersion := makefileVersion(t, "ONNX_VERSION")
	wheelVersion := makefileVersion(t, "ONNX_OV_WHEEL_VERSION")

	bundle, cache := openvinoSandbox(t, onnxVersion)
	wheelPath, wheelSHA, pluginSHA := fixtureWheel(t, t.TempDir())

	out, err := runOpenVINOFetch(t, bundle, cache, wheelPath, wheelSHA, pluginSHA)
	if err != nil {
		t.Fatalf("fetch-onnx-openvino failed: %v\n%s", err, out)
	}

	// Installed library set: exactly the wheel's .so entries plus the license
	// note (renamed to its openvino-prefixed install name).
	for _, f := range []string{
		"libonnxruntime.so",
		"libonnxruntime_providers_openvino_plugin.so",
		"libonnxruntime_providers_openvino_plugin.so.1",
		"libopenvino.so.2641",
		"libopenvino_intel_gpu_plugin.so",
		"libtbb.so.12",
		"openvino-third-party-programs.txt",
	} {
		if _, err := os.Stat(filepath.Join(bundle, f)); err != nil {
			t.Errorf("expected installed file %s missing: %v", f, err)
		}
	}
	for _, f := range []string{"__init__.py", "cache.json", "METADATA"} {
		if _, err := os.Stat(filepath.Join(bundle, f)); err == nil {
			t.Errorf("Python/JIT artifact %s must not be installed into the bundle", f)
		}
	}

	// The plugin install copy must be byte-identical to the fixture entry.
	got, err := os.ReadFile(filepath.Join(bundle, "libonnxruntime_providers_openvino_plugin.so"))
	if err != nil {
		t.Fatalf("reading installed plugin: %v", err)
	}
	if string(got) != fixturePluginContent {
		t.Fatalf("installed plugin content = %q, want the fixture bytes", got)
	}

	// Stamps: the openvino flavor value derived from the Makefile, mirrored
	// into the .cache wheel stamp; the CPU stamp stays the plain version.
	wantStamp := onnxVersion + "-openvino-ep" + wheelVersion
	ovStamp, err := os.ReadFile(filepath.Join(bundle, ".onnxruntime-openvino-version"))
	if err != nil {
		t.Fatalf("reading openvino stamp: %v", err)
	}
	if strings.TrimSpace(string(ovStamp)) != wantStamp {
		t.Fatalf("openvino stamp = %q, want %q", strings.TrimSpace(string(ovStamp)), wantStamp)
	}
	cacheStamp, err := os.ReadFile(filepath.Join(cache, "onnx-openvino", ".openvino-wheel-version"))
	if err != nil {
		t.Fatalf("reading .cache wheel stamp: %v", err)
	}
	if strings.TrimSpace(string(cacheStamp)) != wantStamp {
		t.Fatalf(".cache wheel stamp = %q, want %q", strings.TrimSpace(string(cacheStamp)), wantStamp)
	}
	cpuStamp, err := os.ReadFile(filepath.Join(bundle, ".onnxruntime-version"))
	if err != nil {
		t.Fatalf("reading CPU stamp: %v", err)
	}
	if strings.TrimSpace(string(cpuStamp)) != onnxVersion {
		t.Fatalf("CPU stamp changed to %q — fetch-onnx-openvino must leave the CPU base state untouched", strings.TrimSpace(string(cpuStamp)))
	}
}

// TestOpenVINOFetch_IdempotentRerun covers the already-installed short
// circuit: a second run over a stamped install succeeds without re-extracting
// (observable via the "already installed" message).
func TestOpenVINOFetch_IdempotentRerun(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skipf("fetch-onnx-openvino is Linux x64-only by design; skipping on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	bundle, cache := openvinoSandbox(t, makefileVersion(t, "ONNX_VERSION"))
	wheelPath, wheelSHA, pluginSHA := fixtureWheel(t, t.TempDir())

	if out, err := runOpenVINOFetch(t, bundle, cache, wheelPath, wheelSHA, pluginSHA); err != nil {
		t.Fatalf("first run failed: %v\n%s", err, out)
	}
	plugin := filepath.Join(bundle, "libonnxruntime_providers_openvino_plugin.so")
	first, err := os.Stat(plugin)
	if err != nil {
		t.Fatalf("plugin not installed by first run: %v", err)
	}

	out, err := runOpenVINOFetch(t, bundle, cache, wheelPath, wheelSHA, pluginSHA)
	if err != nil {
		t.Fatalf("second run failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, "already installed") {
		t.Fatalf("second run did not take the already-installed short circuit; output:\n%s", out)
	}
	second, err := os.Stat(plugin)
	if err != nil {
		t.Fatalf("plugin missing after rerun: %v", err)
	}
	if !second.ModTime().Equal(first.ModTime()) {
		t.Fatal("second run reinstalled the plugin instead of short-circuiting")
	}
}

// TestOpenVINOFetch_RefusesWrongWheelDigest covers digest reproducibility
// failing closed: a wheel whose bytes do not match the pinned digest aborts
// the target, installs nothing, and leaves no flavor stamp behind.
func TestOpenVINOFetch_RefusesWrongWheelDigest(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skipf("fetch-onnx-openvino is Linux x64-only by design; skipping on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	bundle, cache := openvinoSandbox(t, makefileVersion(t, "ONNX_VERSION"))
	wheelPath, _, pluginSHA := fixtureWheel(t, t.TempDir())

	out, err := runOpenVINOFetch(t, bundle, cache, wheelPath, strings.Repeat("ab", 32), pluginSHA)
	if err == nil {
		t.Fatalf("target succeeded with a wrong wheel digest; output:\n%s", out)
	}
	if !strings.Contains(out, "SHA256 mismatch") {
		t.Fatalf("failure does not name the digest mismatch; output:\n%s", out)
	}
	requireNoOpenVINOFiles(t, bundle)
}

// TestOpenVINOFetch_RefusesWrongPluginDigest covers the second verification
// layer: even with a verified wheel, a plugin digest mismatch (what the
// Makefile pins for the file ONNX Runtime loads) aborts before any bundle
// mutation.
func TestOpenVINOFetch_RefusesWrongPluginDigest(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skipf("fetch-onnx-openvino is Linux x64-only by design; skipping on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	bundle, cache := openvinoSandbox(t, makefileVersion(t, "ONNX_VERSION"))
	wheelPath, wheelSHA, _ := fixtureWheel(t, t.TempDir())

	out, err := runOpenVINOFetch(t, bundle, cache, wheelPath, wheelSHA, strings.Repeat("cd", 32))
	if err == nil {
		t.Fatalf("target succeeded with a wrong plugin digest; output:\n%s", out)
	}
	if !strings.Contains(out, "SHA256 mismatch") {
		t.Fatalf("failure does not name the digest mismatch; output:\n%s", out)
	}
	requireNoOpenVINOFiles(t, bundle)
	// The CPU base must be untouched by the aborted run.
	cpu, err := os.ReadFile(filepath.Join(bundle, "libonnxruntime.so"))
	if err != nil || string(cpu) != fixtureCPUORerContent {
		t.Fatalf("CPU base disturbed by aborted openvino fetch: %v (%q)", err, cpu)
	}
}

// TestOpenVINOFetch_RefusesGPUInstall is the core stamp-policy acceptance
// criterion: the stamp does not allow the CPU wrapper to land on top of a GPU
// install. With the CUDA provider library in the bundle (the marker flavor.go
// reads) or the GPU stamp matching its flavor value, the target must refuse
// before downloading or touching anything.
func TestOpenVINOFetch_RefusesGPUInstall(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skipf("fetch-onnx-openvino is Linux x64-only by design; skipping on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	onnxVersion := makefileVersion(t, "ONNX_VERSION")

	t.Run("CUDA provider library present", func(t *testing.T) {
		bundle, cache := openvinoSandbox(t, onnxVersion)
		if err := os.WriteFile(filepath.Join(bundle, "libonnxruntime_providers_cuda.so"), []byte("x"), 0o644); err != nil {
			t.Fatalf("seeding CUDA marker: %v", err)
		}
		wheelPath, wheelSHA, pluginSHA := fixtureWheel(t, t.TempDir())
		out, err := runOpenVINOFetch(t, bundle, cache, wheelPath, wheelSHA, pluginSHA)
		if err == nil {
			t.Fatalf("target installed over a CUDA install; output:\n%s", out)
		}
		if !strings.Contains(out, "CUDA") {
			t.Fatalf("refusal does not name the CUDA conflict; output:\n%s", out)
		}
		requireNoOpenVINOFiles(t, bundle)
	})

	t.Run("GPU version stamp matches", func(t *testing.T) {
		bundle, cache := openvinoSandbox(t, onnxVersion)
		gpuStampValue := onnxVersion + "-gpu-cuda13"
		if err := os.WriteFile(filepath.Join(bundle, ".onnxruntime-gpu-version"), []byte(gpuStampValue), 0o644); err != nil {
			t.Fatalf("seeding GPU stamp: %v", err)
		}
		wheelPath, wheelSHA, pluginSHA := fixtureWheel(t, t.TempDir())
		out, err := runOpenVINOFetch(t, bundle, cache, wheelPath, wheelSHA, pluginSHA)
		if err == nil {
			t.Fatalf("target installed over a GPU-stamped tree; output:\n%s", out)
		}
		if !strings.Contains(out, "CUDA") {
			t.Fatalf("refusal does not name the CUDA conflict; output:\n%s", out)
		}
		requireNoOpenVINOFiles(t, bundle)
	})
}

// TestGPUFetch_RefusesOpenVINOInstall covers the symmetric guard: the CUDA
// target must refuse over an OpenVINO install (the GPU libonnxruntime.so
// would replace the CPU base the plugin stack is validated against, and the
// updater reading the CUDA marker would hand out archives that drop the
// plugin). The guard fires before any download, so the run needs only the
// bundle marker — no fixture archives.
func TestGPUFetch_RefusesOpenVINOInstall(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skipf("fetch-onnx-gpu is Linux x64-only by design; skipping on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	bundle, cache := openvinoSandbox(t, makefileVersion(t, "ONNX_VERSION"))
	if err := os.WriteFile(filepath.Join(bundle, "libonnxruntime_providers_openvino_plugin.so"), []byte("x"), 0o644); err != nil {
		t.Fatalf("seeding OpenVINO marker: %v", err)
	}

	out, err := runMake(t, "fetch-onnx-gpu",
		"APP_BUNDLE_DIR="+bundle,
		"ONNX_CACHE_DIR="+cache,
		"ONNX_GPU_CACHE_DIR="+filepath.Join(cache, "onnx-gpu"),
		"ONNX_STAMP="+filepath.Join(bundle, ".onnxruntime-version"),
		"ONNX_GPU_STAMP="+filepath.Join(bundle, ".onnxruntime-gpu-version"),
	)
	if err == nil {
		t.Fatalf("fetch-onnx-gpu installed over an OpenVINO install; output:\n%s", out)
	}
	if !strings.Contains(out, "OpenVINO") {
		t.Fatalf("refusal does not name the OpenVINO conflict; output:\n%s", out)
	}
	// The GPU target must not have touched the tree either.
	if _, err := os.Stat(filepath.Join(bundle, "libonnxruntime_providers_cuda.so")); err == nil {
		t.Error("refused GPU run left the CUDA provider library in the bundle")
	}
	if _, err := os.Stat(filepath.Join(bundle, ".onnxruntime-gpu-version")); err == nil {
		t.Error("refused GPU run wrote the GPU stamp")
	}
	// And the OpenVINO install must survive untouched.
	if _, err := os.Stat(filepath.Join(bundle, "libonnxruntime_providers_openvino_plugin.so")); err != nil {
		t.Errorf("OpenVINO marker damaged by refused GPU run: %v", err)
	}
}

// TestOpenVINOFetch_ServedFromCache covers the cache branch: with the wheel
// already in .cache (digest-verified on every reuse), the target installs
// without a download step and rewrites the stamps identically.
func TestOpenVINOFetch_ServedFromCache(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skipf("fetch-onnx-openvino is Linux x64-only by design; skipping on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	bundle, cache := openvinoSandbox(t, makefileVersion(t, "ONNX_VERSION"))
	wheelPath, wheelSHA, pluginSHA := fixtureWheel(t, t.TempDir())

	// Seed the cache by a first (download-branch) run, then remove the
	// install state so the second run must take the cache branch.
	if out, err := runOpenVINOFetch(t, bundle, cache, wheelPath, wheelSHA, pluginSHA); err != nil {
		t.Fatalf("seeding run failed: %v\n%s", err, out)
	}
	for _, f := range []string{"libonnxruntime_providers_openvino_plugin.so", "libopenvino.so.2641", "libtbb.so.12", "openvino-third-party-programs.txt", ".onnxruntime-openvino-version"} {
		if err := os.Remove(filepath.Join(bundle, f)); err != nil {
			t.Fatalf("resetting install state: %v", err)
		}
	}

	out, err := runOpenVINOFetch(t, bundle, cache, wheelPath, wheelSHA, pluginSHA)
	if err != nil {
		t.Fatalf("cache-branch run failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Using cached ONNX Runtime OpenVINO EP wheel") {
		t.Fatalf("cache branch not taken; output:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(bundle, ".onnxruntime-openvino-version")); err != nil {
		t.Fatalf("cache-branch run did not write the flavor stamp: %v", err)
	}
	if _, err := os.Stat(filepath.Join(bundle, "libonnxruntime_providers_openvino_plugin.so")); err != nil {
		t.Fatalf("cache-branch run did not install the plugin: %v", err)
	}
}

// TestOpenVINOFetch_RefusesOnUnsupportedPlatform pins the fail-closed
// platform gate on the level the CI arm64 leg asserts live: the Makefile's
// else-branch exists and exits non-zero. (The test itself cannot change
// GOARCH; this checks the recipe's guard text is present for the
// non-x86_64 branch so a regression in the gate structure is caught by the
// matrix-level CI step instead of shipping silently.)
func TestOpenVINOFetch_RefusesOnUnsupportedPlatform(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skipf("the live refusal is asserted on the CI arm64 leg; this structural check runs on linux/amd64 only, got %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	raw, err := os.ReadFile(filepath.Join(workflowRoot(t), "Makefile"))
	if err != nil {
		t.Fatalf("reading Makefile: %v", err)
	}
	if !strings.Contains(string(raw), "fetch-onnx-openvino is Linux x64 only") {
		t.Fatal("Makefile lost the fail-closed else-branch message for fetch-onnx-openvino on non-x86_64 platforms")
	}
}
