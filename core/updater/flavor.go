package updater

import (
	"os"
	"path/filepath"
	"runtime"
)

// Flavor identifies which ONNX Runtime packaging a running installation
// carries: the default CPU flavor or one of the opt-in GPU flavors (CUDA 13,
// OpenVINO). The flavor does NOT live in the binary — the executable is
// byte-identical across flavors — but in the install tree: `make
// fetch-onnx-gpu` (ADR-045) drops the CUDA provider library next to the
// binary, and `make fetch-onnx-openvino` drops the OpenVINO EP plugin
// library, and those files' presence is the only install-time signal of a
// flavored tree.
//
// The updater needs the flavor to pick the correct update payload: a CPU
// tree must keep receiving CPU libraries, and a GPU tree must not be
// silently downgraded by a CPU-flavored update archive.
type Flavor string

const (
	// FlavorCPU is the default installation flavor: ONNX Runtime CPU
	// execution provider only, no GPU libraries in the install tree.
	FlavorCPU Flavor = "cpu"

	// FlavorCUDA13 is the opt-in NVIDIA GPU flavor (ADR-045): a CUDA
	// 13-flavored ONNX Runtime with libonnxruntime_providers_cuda.so
	// installed next to the binary. One CUDA major is pinned deliberately
	// (see ADR-045 "Packaging: separate opt-in target, cuda13 flavor only")
	// — a cuda12 flavor is explicitly not supported.
	FlavorCUDA13 Flavor = "cuda13"

	// FlavorOpenVINO is the opt-in Intel GPU/NPU flavor: the stock CPU
	// ONNX Runtime plus the additive OpenVINO execution-provider stack
	// (libonnxruntime_providers_openvino_plugin.so and its OpenVINO/TBB
	// runtime libraries) installed next to the binary by
	// `make fetch-onnx-openvino`. Unlike FlavorCUDA13 the main library is
	// not replaced, so the flavor coexists with the CPU state machine of
	// the version stamps; it is still mutually exclusive with the CUDA
	// flavor (the Makefile's fetch targets refuse to mix them).
	FlavorOpenVINO Flavor = "openvino"
)

// cudaProviderLibrary is the file whose presence in the executable's
// directory marks a CUDA-flavored install tree. It matches ONNX_GPU_CUDA_LIB
// in the Makefile's fetch-onnx-gpu target and the library ONNX Runtime
// dlopens for the CUDA execution provider (symmetric to the rule sp4rk's
// embedding package documents for GPU-enabled LibraryPath builds).
const cudaProviderLibrary = "libonnxruntime_providers_cuda.so"

// openvinoPluginLibrary is the file whose presence in the executable's
// directory marks an OpenVINO-flavored install tree. It matches
// ONNX_OV_PLUGIN_LIB in the Makefile's fetch-onnx-openvino target and the
// library c0wrk registers via RegisterExecutionProviderLibrary at run time.
const openvinoPluginLibrary = "libonnxruntime_providers_openvino_plugin.so"

// CurrentFlavor determines the flavor of the running installation by
// inspecting the install tree (the directory containing the executable).
//
// It reports a GPU flavor only when every condition holds:
//   - the binary runs on linux/amd64 — the only platform for which GPU
//     flavors are published (the Makefile's fetch-onnx-gpu and
//     fetch-onnx-openvino targets refuse every other platform), and
//   - the flavor's marker library exists next to the executable — the
//     install-time footprint the matching make target leaves behind
//     (libonnxruntime_providers_cuda.so for FlavorCUDA13,
//     libonnxruntime_providers_openvino_plugin.so for FlavorOpenVINO).
//
// When both markers are present (a state the Makefile's mutual-exclusion
// guards make unreachable) the CUDA marker wins: the precedence is
// deterministic, and the CUDA archive is the conservative payload for a
// tree whose main library is the GPU build.
//
// Everything else — other platforms, a CPU install tree, or any error
// resolving/stat-ing the executable path — reports FlavorCPU. The function
// is therefore fail-closed: it never panics and never returns an error,
// because a wrong flavor guess must degrade to the safe default (CPU)
// rather than break the update flow.
func CurrentFlavor() Flavor {
	exePath, err := os.Executable()
	if err != nil {
		return FlavorCPU
	}
	return flavorFor(runtime.GOOS, runtime.GOARCH, exePath)
}

// flavorFor is the parameterized core of CurrentFlavor: it resolves the
// flavor for an explicit goos/goarch pair and executable path so the
// platform gate and the library probes are unit-testable on any host (the
// test cannot change runtime.GOOS, and os.Executable always succeeds once
// a process has started). The lookup rule mirrors CurrentFlavor: CUDA 13
// on linux/amd64 with the CUDA provider library present beside the binary,
// otherwise OpenVINO on linux/amd64 with the plugin library present, and
// FlavorCPU for any error or mismatch.
func flavorFor(goos, goarch, exePath string) Flavor {
	if goos != "linux" || goarch != "amd64" {
		return FlavorCPU
	}
	if exePath == "" {
		return FlavorCPU
	}
	dir := filepath.Dir(exePath)
	if _, err := os.Stat(filepath.Join(dir, cudaProviderLibrary)); err == nil {
		return FlavorCUDA13
	}
	if _, err := os.Stat(filepath.Join(dir, openvinoPluginLibrary)); err == nil {
		return FlavorOpenVINO
	}
	return FlavorCPU
}
