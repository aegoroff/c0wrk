package vectorindex

import (
	"context"
	"log/slog"
	"os/exec"

	"github.com/v0lka/sp4rk/embedding"
)

// VerifyEmbedderOvDevice performs the one-shot external device verification
// after a successful OpenVINO embedder init and returns the device class the
// provider actually drives: "gpu", "cpu", or "" (unverified).
//
// The OpenVINO plugin appends both its GPU and CPU devices and OpenVINO picks
// the concrete device itself, so no in-process API can tell them apart — the
// driver-side compute-utilization counter (xpu-smi `utilization.compute`,
// device-level) is the only observable. The probe mechanics — the 30s
// whole-probe budget, sustained inference during the sampling window, the ≤12
// bounded readings with a 25% threshold and early stop — are owned by
// sp4rk's embedding.VerifyOpenVINOExecution; this wrapper only translates its
// (verified, err) outcome onto the tri-state verdict and carries the one
// distinction the boolean alone cannot express: on a machine without xpu-smi
// sp4rk reports (false, nil) — the same shape as a concluded below-threshold
// window — so the LookPath guard here pins that case to the "unverified"
// verdict. A missing verdict is never a "cpu" verdict.
//
// The probe is diagnostics-only: the result never blocks startup, never fails
// the embedder, and every failure shape — missing tool, probe error, expired
// budget, failed sustained inference — is treated as unverified (""), never
// as "cpu". A separate warmup pass is unnecessary: the probe's
// sustained-inference loop materializes the lazily-created OpenVINO context
// on its first call, and a provider broken end-to-end surfaces as the probe
// error, i.e. unverified. ctx governs cancellation; with a deadline-free ctx
// the effective budget is sp4rk's internal 30s.
func VerifyEmbedderOvDevice(ctx context.Context, emb *embedding.Embedder, log *slog.Logger) string {
	if _, err := exec.LookPath("xpu-smi"); err != nil {
		// Missing tool ≠ "not on GPU": treated as unverified, the ov_device
		// verdict stays empty, and the user still gets a WARN — a missing
		// verdict is suspicious enough to be visible, never silent.
		log.Warn("OpenVINO device verification unavailable: xpu-smi not found",
			"hint", "treated as unverified, not as a CPU-device verdict")
		return ""
	}
	verified, err := embedding.VerifyOpenVINOExecution(ctx, emb)
	return ovDeviceVerdict(verified, err, log)
}

// ovDeviceVerdict maps the (verified, err) outcome of
// embedding.VerifyOpenVINOExecution onto the embedder-info tri-state and
// logs the verdict either way: any error (probe failure, expired budget,
// failed sustained inference) is unverified — "" — never "cpu"; a concluded
// sample window that never reached the threshold is the "cpu" verdict; a
// threshold crossing is "gpu". The raw utilization reading is deliberately
// not logged: the core probe does not expose it, the threshold crossing (or
// its absence) is the verdict. Factored out pure for tests.
func ovDeviceVerdict(verified bool, err error, log *slog.Logger) string {
	switch {
	case err != nil:
		// Probe failure ≠ "on a CPU device": treated as unverified, the
		// ov_device verdict stays empty, and the user still gets a WARN.
		log.Warn("OpenVINO device verification probe failed",
			"error", err,
			"hint", "treated as unverified, not as a CPU-device verdict")
		return ""
	case verified:
		log.Info("OpenVINO GPU device verified via xpu-smi")
		return "gpu"
	default:
		log.Warn("no GPU compute utilization during inference — OpenVINO picked a CPU device",
			"hint", "the plugin registered both its GPU and CPU devices; inference ran on the CPU one")
		return "cpu"
	}
}
