# ADR-089: OpenVINO Embedding Flavor (plugin EP, wheel-harvested packaging, device-level verification)

## Status

Accepted

## Context

[ADR-045](045-gpu-embedding-provider.md) gave the vector-index embedder a CUDA
route for NVIDIA machines (a swap of the ONNX Runtime library build, the
never-silent fallback contract, external `nvidia-smi` verification) and
[ADR-046](046-cuda-release-artifact.md) turned it into a release artifact with
flavor-pinned updates. Intel machines — where integrated Arc GPUs ship on
mainstream mobile and desktop CPUs — stayed on the CPU provider. Extending the
same contract to Intel hardware raised four questions the CUDA flavor never
had to answer:

1. **There is no OpenVINO flavor of ONNX Runtime to download.** Intel's
   official release vehicle for the OpenVINO execution provider is the PyPI
   wheel `onnxruntime-ep-openvino`: ORT ≥ 1.23 ships a **decoupled
   execution-provider plugin API** (`RegisterExecutionProviderLibrary`), and
   the plugin library `libonnxruntime_providers_openvino_plugin.so` registers
   into the *stock CPU runtime* at run time. The alternatives — rebuilding ORT
   with the EP compiled in, or installing a native OpenVINO runtime and
   pointing a custom build at it — both fork the pinned upstream artifact that
   the whole packaging posture (ADR-045/046, ADR-023) is built on.
2. **Device selection and observability moved.** With the CUDA EP the session
   options name the provider and a device index; the OpenVINO plugin instead
   appends its own `OrtEpDevice` handles (GPU, CPU, and AUTO pseudo-devices)
   and requires the V2 session-options API
   (`AppendExecutionProvider`-for-devices). The live gate (2026-10, ORT 1.28.1
   + plugin 1.8.0 on an Arrow Lake-P Arc iGPU) established: registration is
   once-per-process (a duplicate errors "library is already registered");
   device selection happens only through `OrtEpDevice` handles, and the Go
   wrapper exposes no `ep_metadata` accessors — so **in-process code cannot
   tell which device class (GPU or CPU) the plugin picked**; the plugin's
   `device_type` provider option is ignored by the plugin itself.
3. **The ADR-045 verification rule is not portable.** `nvidia-smi` answers
   "is this PID a compute app"; `xpu-smi` on these iGPUs exposes
   `utilization.compute` but **no per-PID process attribution**. The PID rule
   cannot be carried over verbatim; the observable that remains is the
   device-level utilization counter (live-validated: ~0% idle vs >80% during
   sustained jina-v2-small inference).
4. **The wheel is a package, not a runtime dependency.** c0wrk's
   supply-chain posture is pinned-digest fail-closed verification of every
   fetched byte; the plugin wheel is ~52 MiB and bundles the full OpenVINO
   runtime (device plugins, TBB, hwloc) with `RUNPATH=$ORIGIN`, so the
   libraries resolve from their own directory when co-installed next to the
   binary — no `LD_LIBRARY_PATH`, no system OpenVINO install, no Python at
   runtime.

The payoff measured at the gate: 3.9× over the native CPU provider at
B1/S64 (1.45 ms vs 5.58 ms) and 8.2× at B8/S512 (33.7 ms vs 278.4 ms); the
first GPU session-create pays a one-time 0.4–1.35 s kernel JIT; the plugin's
AUTO pseudo-devices add overhead without benefit on the reference hardware.

## Decision

1. **The plugin EP is the official route; the runtime is never rebuilt.**
   OpenVINO support rides the decoupled provider API: the stock CPU
   `libonnxruntime.so` stays byte-identical, and sp4rk's embedding package
   registers `libonnxruntime_providers_openvino_plugin.so` at run time
   (`ort.RegisterExecutionProviderLibrary`, absolute path, once per process).
   Device selection goes through the V2 `OrtEpDevice` surface
   (`onnxruntime_go` ≥ v1.29.0); for the c0wrk `openvino` provider value the
   device index is pinned to `0` — the only value the plugin surface accepts
   — and the plugin chooses the concrete Intel device itself. Config
   validation (`backend/config`) and the settings RPC check `device_id >= 0`
   for every provider — they do not reject non-zero ids under `openvino`;
   the settings UI is what enforces the pin (it normalizes a non-zero id to
   `0` on a switch to `openvino` and pins the picker control). A hand-edited
   config can persist `openvino` with a non-zero id: that pair passes load
   validation and fails at embedder creation, into the loud CPU fallback
   (decision 4).
2. **Delivery channel: digest-pinned PyPI wheel, harvested at install time.**
   `make fetch-onnx-openvino` (Linux x86_64 only; fails closed on any other
   platform) downloads the pinned wheel
   `onnxruntime_ep_openvino-1.8.0-py3-none-manylinux_2_28_x86_64.whl` from
   files.pythonhosted.org and SHA256-verifies **two** digests: the whole
   wheel (one digest governs the entire extracted library set; unzip CRC
   guards the extraction) and the extracted plugin library itself (the same
   post-extraction re-verification role `ONNX_LIB_SHA256` plays for the base
   runtime). It extracts the shared libraries plus the third-party-programs
   notice flat into the app bundle (Python package files, `__init__.py`, and
   the kernel-JIT `cache.json` are not installed), delegates the CPU base to
   `make fetch-onnx`, and writes the stamp
   `.onnxruntime-openvino-version = 1.28.1-openvino-ep1.8.0`
   (`$(ONNX_VERSION)-openvino-ep$(ONNX_OV_WHEEL_VERSION)`). The install is
   **additive**: the CPU stamp is left untouched and `make build` keeps
   working over an OpenVINO install — the ADR-045 stamp policy adapted to a
   flavor that layers on top of the CPU flavor instead of replacing it.
3. **Flavor identity, mutual exclusion, release channel — the ADR-046
   machinery extends to a third linux/amd64 flavor.** `CurrentFlavor()`
   recognizes the plugin library file as the `openvino` flavor (precedence
   cuda13 > openvino > cpu); the updater's asset matrix lists linux/amd64 a
   third time (`c0wrk-desktop-linux-amd64-openvino.tar.gz`), same-flavor
   updates hold, a release without the flavor's asset is a hard
   `ErrNoAssetForPlatform`, and flavor switches stay manual reinstalls. The
   Makefile enforces mutual exclusion in **both** directions:
   `fetch-onnx-openvino` refuses to lay the plugin stack over a CUDA install
   (the stack requires the CPU base), and `fetch-onnx-gpu` refuses to replace
   the CPU base under a plugin install. The release workflow gains a
   `build-linux-openvino` job (`make build` → `make fetch-onnx-openvino` →
   tar `build/bin` including both stamps) wired into the release job's
   `needs`, and the linux/amd64 CI leg runs a networked
   `make fetch-onnx-openvino` smoke plus the arm64 fail-closed assertion.
   Drift note, recorded here because ADR-046 is immutable: ADR-046's
   decision 3 describes a ci.yml `fetch-onnx-gpu` recipe smoke that the
   workflow does not actually contain — the OpenVINO flavor is the one whose
   fetch recipe CI exercises today (2026-10-18: recorded as a dated
   corrigendum section in ADR-046 itself).
4. **Provider surface, auto ladder, fallback — the ADR-045 loud contract,
   verbatim.** `vector_index.execution_provider` accepts `openvino` (load
   validation and `UpdateVectorIndexSettings` share the same wording);
   `auto` walks the ladder CUDA → OpenVINO → CPU, skipping a rung whose
   libraries are missing next to the binary; an explicit `openvino` that
   cannot come up falls back to CPU in the startup layer — WARN log,
   `runtime_error` toast `error_code: vector_openvino_fallback` with the
   `make fetch-onnx-openvino` fix hint, requested-vs-effective mismatch
   recorded in every status payload; at the sp4rk layer an explicit
   `openvino` stays a hard error. `auto → openvino` is a success (Auto's
   middle rung), never a fallback.
5. **Verification is device-level, not per-PID.** After a successful OpenVINO
   embedder init the startup layer drives sustained inference on the
   embedder's locked ONNX thread — no separate warmup pass: the loop's first
   call materializes the lazily-created OpenVINO context — while sampling
   `xpu-smi stats --device 0 -j`, parsing the compute-engine-utilization
   leaves out of the JSON payload (a bounded sample count, ≤ 12) under one
   whole-probe budget (30 s; there is no per-invocation timeout), with
   deliberately no sleep between samples (the spawn is the cadence). A
   sample that fails before the budget expires aborts the whole probe; a
   wedged invocation burns the remaining budget to the same end — a wedged
   invocation is never a skipped sample. The highest readable utilization
   decides: ≥ 25% → `ov_device: "gpu"` (INFO "OpenVINO GPU device verified
   via xpu-smi"); a concluded window whose samples all stayed below the
   threshold → `"cpu"` plus a WARN naming the CPU-device outcome — an
   unreadable payload is not a failure shape: a sample without a
   recognizable compute-utilization field reads as 0, so an xpu-smi whose
   schema the parser does not recognize idles through the window and
   concludes `"cpu"`; **missing tool, a sample or probe error, an expired
   budget, or failed sustained inference → the verdict stays empty
   (unverified)** — those failure shapes are never reported as `"cpu"`. The
   probe is diagnostics only: it never blocks or fails startup, and its
   result travels in the vector-index status payload (`ov_device`) exactly
   like `cuda_verified` does for CUDA.
6. **External verification for tests follows the same device-level shape.**
   Tests asserting Intel-GPU execution check the utilization counter moves
   under sustained inference (`utilization.compute`, not a compositor-noisy
   generic counter) and skip where `xpu-smi` is absent — the Intel
   counterpart of ADR-045's nvidia-smi PID rule, weakened from process
   attribution to device-level evidence.

## Consequences

**Positive:**

- Intel iGPU/dGPU embeddings work from official pinned artifacts with zero
  ORT forks: measured 3.9×–8.2× over the native CPU provider on the reference
  hardware, with the CPU flavor and the CUDA flavor untouched.
- The install is additive and reversible — `make build` over an OpenVINO
  install reinstalls nothing GPU-related, and `clean-onnx` removes the whole
  stack by the same globs that installed it.
- The third flavor rides the existing flavor-pinned update machinery with no
  new updater concepts: same-flavor updates, fail-closed asset selection,
  manual flavor switches.
- The observability contract stays uniform across providers: requested vs
  effective in every status, a per-provider external verdict (`cuda_verified`
  / `ov_device`), a per-provider fallback toast (`vector_cuda_fallback` /
  `vector_openvino_fallback`), and a settings surface that classifies
  outcomes the same way for both hardware providers.

**Negative:**

- The wheel version and the ORT version are coupled only by pinning: a bump
  is a coordinated change to the wheel URL, the wheel digest, the plugin
  digest, and the stamp value, plus a live hardware revalidation — there is
  no compatible-range logic to lean on (the plugin documents ORT ≥ 1.23, but
  c0wrk pins exact pairs).
- Device-level verification is weaker than per-PID attribution: the verdict
  is evidence that *some* compute ran on the Intel GPU during the probe
  window, not that *this process* did; the ≥ 25% threshold exists to exclude
  compositor noise, and a co-resident heavy compute process could in
  principle confound it.
- The verdict's completeness depends on an optional external tool: machines
  without `xpu-smi` carry an absent `ov_device` (unverified), which the UI
  renders as "no badge" rather than a CPU outcome.
- The first inference after startup pays the one-time OpenVINO kernel JIT
  (0.4–1.35 s session-create); the plugin stack also adds ~52 MiB to the
  openvino archive.
- Explicit GPU-vs-CPU device targeting within the OpenVINO provider would
  need `ep_metadata` accessors the Go wrapper does not expose (absent even in
  the latest wrapper releases); the AUTO pseudo-devices are deliberately not
  used. Per-device indexing stays impossible until the wrapper grows metadata
  accessors.
- The packaging matrix stays hand-synced in one more place per flavor
  (release.yml job, `supportedPlatforms`, README/CONTRIBUTING tables); the
  code-checked matrix test (`core/updater/matrix_sync_test.go`) is the drift
  guard, extended to the openvino job and asset.

## Alternatives Considered

- **Rebuild ONNX Runtime with the OpenVINO EP compiled in.** Rejected: it
  forks the pinned upstream library, doubles the packaging and digest matrix,
  and makes every ORT security bump a local rebuild; the decoupled plugin API
  exists precisely to avoid this.
- **Native OpenVINO install (system packages) + PATH discovery.** Rejected:
  an unmanaged, unpinned runtime dependency; version skew between the plugin
  and the system OpenVINO becomes an undiagnosable support surface; the
  co-installed `RUNPATH=$ORIGIN` layout needs no environment plumbing at all.
- **Runtime download of the plugin stack (tool-manager or app-managed).**
  Rejected for the reasons ADR-046 rejected runtime GPU downloads: it forks
  the pinned-digest posture into a second, weaker channel and adds a network
  dependency at first GPU use.
- **Per-PID verification (carry the nvidia-smi rule over).** Rejected:
  unavailable — `xpu-smi` on the reference iGPUs exposes no compute-process
  list; insisting on process attribution would have meant no verification at
  all. Device-level utilization is the strongest observable the tooling
  offers.
- **Target the plugin's AUTO pseudo-devices.** Rejected (measured): AUTO adds
  dispatch overhead without benefit on the reference hardware; the explicit
  device list is deterministic and keeps the verification probe meaningful.
- **Support NPU as a distinct selection.** Deferred — with the deferral
  reason a measured outcome, tracked across two same-day probes on the
  reference host (NPU validation, 2026-10-18): the machine the gate ran on
  DOES carry an NPU (Arrow Lake-P, PCI `8086:7d1d`, in-tree `intel_vpu`
  kernel driver loaded and bound, `/dev/accel/accel0` present). The first
  probe lacked the userspace driver entirely; after the operator installed
  `intel-npu-driver` 1.35.0-2, re-enumeration still listed the same five
  devices — ORT CPU, the Arc iGPU, OV CPU and the two AUTO pseudo-devices —
  and no NPU. The failure point moved measurably from "no UMD" to "no
  device access": the level-zero loader now finds and resolves
  `libze_intel_npu.so.1` (the 1.35 UMD name; `libze_intel_vpu.so` is gone)
  as a supported VPU/NPU driver, but its `zeInitDrivers` returns
  `ZE_RESULT_ERROR_UNINITIALIZED`, and the controlled contrast explains
  why — the package's udev rule makes `accel0` `root:render 0660` with no
  uaccess tag while the validation user is not in the `render` group
  (`open()` → EACCES), yet the GPU UMD initializes through the
  world-writable `renderD128`; `ZE_ENABLE_LOADER_DEBUG_TRACE=1` is the
  switch that makes the failing init visible where `OPENVINO_LOG_LEVEL=5`
  stays silent. The boot predates the install (the kernel loaded `vpu_37xx`
  firmware from linux-firmware rather than the package's `updates/` copies),
  so a reboot belongs to the remaining check. The remedy — `render` group
  membership or a uaccess rule, re-login, reboot, then re-enumeration — is
  a host-admin action outside c0wrk's reach; until it lands, the sixth
  `ov_device=NPU` entry stays the unverified expectation, NPU inference
  remains N/A (never attempted — not a skipped test), and the `ov_device`
  verdict vocabulary (`gpu`/`cpu`/unverified) leaves room without
  committing to an untested surface.
- **Reuse the tool-manager for the wheel.** Rejected: build-time packaging
  belongs to the Makefile next to the other ONNX flavors (ADR-045 precedent);
  the tool-manager serves agent-runtime binaries, and its offline-first
  reconciliation model does not match a build-time opt-in flavor.

## Related Specs

- [ADR-045](045-gpu-embedding-provider.md) — the provider-selection, loud
  fallback, locked-thread, and external-verification decisions this ADR
  extends with the plugin route and the Intel counterpart of the
  verification rule; ADR-045 stands unchanged.
- [ADR-046](046-cuda-release-artifact.md) — the flavor-aware updater and
  release matrix this ADR widens to a third linux/amd64 flavor; also records
  the decision-3 CI drift ADR-046 cannot fix about itself.
- [domains/workspace.md](../domains/workspace.md) — Embedding Execution
  Provider section (runtime behavior, status payload, settings surface).
