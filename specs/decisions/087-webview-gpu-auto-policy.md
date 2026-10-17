# ADR-087: Linux Webview GPU Auto Policy — On-Demand by Default with a Detected Fallback

## Status

Accepted

## Context

Since [PR #25](https://github.com/v0lka/c0wrk/pull/25), c0wrk pinned the Linux webview's hardware-acceleration policy to `never` by default — the same policy Wails applies for its nil-options workaround for [wails#2977](https://github.com/wailsapp/wails/issues/2977), where the NVIDIA GBM driver fails DMABUF buffer allocation and the window renders grey/blank. That default protects every user from the blank window, and the `C0WRK_WEBVIEW_GPU_POLICY` env var offered an opt-in escape hatch.

The protection had a cost measured in [issue #34](https://github.com/v0lka/c0wrk/issues/34): with software rendering, every CSS animation frame is a full CPU paint, and c0wrk's UI keeps at least one animation on screen almost always (`animate-spin` loaders, the streaming-cursor `animate-pulse`, the pulsing activity indicator — ~110 usages across 69 files). On the reporter's Arch + NVIDIA machine a laptop core sat pinned near 100% at idle; on the developer machine with the same GPUs the WebKitWebProcess burned ~0.5 core with the window visible. The env workaround was undiscoverable — most users never learn it exists.

Meanwhile the upstream picture moved: wails#2977 remains open (a bump cannot fix it), `WEBKIT_DISABLE_DMABUF_RENDERER=1` crashes current WebKitGTK, `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` keeps software rendering (it removes the crash, not the CPU burn), and modern NVIDIA driver + WebKitGTK stacks — including both known c0wrk machines — run `on-demand` (WebKit's own default) without the grey window. The failure class is version-dependent, not universal: pinning `never` for everyone punishes the healthy majority for the broken minority, while `always`-for-everyone would reintroduce the blank window exactly where the workaround was born.

Design had to settle four questions:

1. **What should the default be, given the failure cannot be predicted before the webview exists?** The policy is consumed at webview creation, before any rendering failure can be observed.
2. **Can the failure be detected at all from Go?** The grey window is a buffer-allocation failure that logs distinctive markers to the process's stderr — which crash capture already persists to a file from before `wails.Run`.
3. **Where does a user-facing choice persist, given config.yaml is unavailable at decision time?** The full config loads in `app.Startup`, after the window exists.
4. **How does a fallback reach the user, when the broken surface is the UI itself?** A grey webview cannot show a toast.

## Decision

1. **The default setting is `auto`, resolving to `on-demand`.** `on-demand` is WebKit's own default: hardware acceleration engages when web contents request it, trivial CSS animations composite on the GPU, and idle CPU cost drops to ~0. `always` stays available as an explicit choice but is never the automatic answer — auto requests acceleration only the way the engine itself would.
2. **A startup watchdog detects the grey window and falls back once, automatically.** When the fresh-`auto` resolution is accelerated, main arms the watchdog after crash capture (offset snapshot of the append-only stderr.log) and DomReady starts a bounded scan (2 s interval, 30 s window) over this run's stderr tail for the failure signatures (`Failed to create EGL images for DMABufs`, `DRM_IOCTL_NVIDIA_GEM_ALLOC_NVKMS_MEMORY failed`). On a match it persists an `auto_fallback` record (policy `never`, reason, timestamp) into `webview_state.json`, relaunches the app detached, and quits; the fresh instance resolves `auto` + fallback to `never`. Detection is bound to startup — the failure is a first-paint allocation error, and an unbounded scan would risk a hostile self-relaunch mid-work.
3. **Persist-before-relaunch, and never relaunch on a failed persist.** The persisted record is what makes the relaunched instance resolve `never`; without it the loop would restart forever. A failed relaunch keeps the current (albeit blank) session alive — the fallback already applies on the next manual start.
4. **Explicit choices are never second-guessed.** A valid env value or a concrete setting (including `never`) disarms detection entirely; an invalid env value is not an explicit choice — it Warns, falls through to the setting, and stays armed. The fallback is sticky until the user acts: any `SetWebviewGpuPolicy` clears it, so re-choosing `auto` is the "retry GPU acceleration" action and the watchdog re-arms. `RestartRequired` reports false under an env override, where no restart could apply anything.
5. **The choice lives in `webview_state.json`, not config.yaml.** The policy must be readable before `wails.Run`, config.yaml loads only in `app.Startup` — the same constraint that keeps window geometry out of config.yaml. The file is read defensively (corrupt → zero state, startup can never be blocked) and written atomically through safeio. The Settings section (Settings → General, Linux-only, `Get/SetWebviewGpuPolicy`) makes the choice visible and remembered; the canonical policy alphabet and the shared launch-resolution formula live in `backend/webview_gpu.go`, with desktop keeping only the Wails-enum leaf.
6. **The relaunched child waits for the dying instance's advisory lock.** The watchdog spawns detached and quits; the child carries `C0WRK_GPU_RELAUNCH_WAIT_LOCK=1` and polls the single-instance lock (bounded, fail-open) before starting, so the fresh instance cannot lose the Wails single-instance relay race to the exiting predecessor.

## Consequences

Positive:

- Both acceptance criteria of issue #34 hold out of the box: healthy stacks (including both known NVIDIA machines) get GPU compositing with near-zero idle CPU, and broken stacks converge to software rendering after one bounded grey-window episode plus a relaunch — no persistent regression to the blank window.
- The protection that motivated the original workaround survives: the failure path is detected, recorded, and self-healing, and the user can always pin `never` explicitly.
- The setting is discoverable (Settings → General) instead of a hidden env var, with the failure surfaced verbatim (reason, timestamp) and a one-click retry.
- The canonical resolution lives once in the backend, shared by `wails.Run` options and the Settings RPCs; the Wails enum/C mismatch stays quarantined behind the existing numeric pins and canary.

Negative:

- Users on broken stacks see one grey/blank window and an automatic app relaunch on first run — a visible, bounded, self-explaining episode recorded in the logs and the Settings UI.
- Detection matches stderr signatures: an unknown failure wording stays undetected (the manual `never` remains the escape hatch), and a false match on a healthy stack costs one unnecessary software-rendering fallback (recoverable in Settings).
- The self-relaunch depends on the stderr capture being armed and the failure printing to stderr; if crash capture is disabled (`C0WRK_DISABLE_CRASH_CAPTURE=1`), auto simply cannot fall back and stays on the accelerated policy — the operator who disabled capture owns that trade-off.
- Two state stores now exist for adjacent concerns (config.yaml for the app configuration, webview_state.json for this pre-window policy) — the boundary is documented in the domain spec to keep future tunables from drifting into the wrong store.

## Related

- [webview-gpu-policy.md](../domains/webview-gpu-policy.md) — the domain spec this decision is implemented by
- [wails#2977](https://github.com/wailsapp/wails/issues/2977), [c0wrk#34](https://github.com/v0lka/c0wrk/issues/34), [c0wrk PR #25](https://github.com/v0lka/c0wrk/pull/25) — the upstream failure, the symptom report, the env-var workaround this decision supersedes as the default path
- [018-macos-webview-recovery.md](018-macos-webview-recovery.md) — the other platform-specific webview workaround
