package desktop

import (
	"log/slog"
	"os"
	"runtime"
)

// nvidiaDisableExplicitSyncEnvVar is read by NVIDIA's EGL Wayland platform
// (libnvidia-egl-wayland / -wayland2) when it sets up a window surface.
const nvidiaDisableExplicitSyncEnvVar = "__NV_DISABLE_EXPLICIT_SYNC"

// ApplyNvidiaExplicitSyncWorkaround disables NVIDIA's Wayland explicit sync
// for this process (and the WebKit children that inherit its environment)
// unless the operator has set the variable themselves.
//
// Why: WebKitGTK on GTK3 composites accelerated frames through an EGL
// surface on the toplevel's wl_surface while GTK3 keeps attaching its own
// wl_shm frames to the same surface. NVIDIA's EGL attaches a
// wp_linux_drm_syncobj_surface_v1 to that surface, and a compositor that
// enforces the protocol (mutter) then kills the connection on the next shm
// attach — "Explicit Sync only supported on dmabuf buffers", surfaced by GDK
// as `Error 71 (Protocol error) dispatching to Wayland display` and exit(1)
// before DomReady. Without explicit sync the driver falls back to implicit
// (dma-buf fence) sync and the accelerated policy renders normally.
//
// The variable is inert for non-NVIDIA drivers and for X11 sessions, so it
// is applied on every Linux launch. Must run before wails.Run — the EGL
// platform reads it at surface creation; with cgo, os.Setenv reaches the C
// environment libEGL and the spawned WebKit processes see.
func ApplyNvidiaExplicitSyncWorkaround(logger *slog.Logger) {
	applyNvidiaExplicitSyncWorkaround(runtime.GOOS, os.LookupEnv, os.Setenv, logger)
}

func applyNvidiaExplicitSyncWorkaround(goos string, lookup func(string) (string, bool), setenv func(string, string) error, logger *slog.Logger) {
	if goos != "linux" {
		return
	}
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	// An operator-set value (including "0" to re-enable explicit sync) is
	// an explicit choice and wins.
	if v, ok := lookup(nvidiaDisableExplicitSyncEnvVar); ok {
		logger.Debug("NVIDIA explicit-sync workaround skipped: variable set by the environment",
			"env", nvidiaDisableExplicitSyncEnvVar, "value", v)
		return
	}
	if err := setenv(nvidiaDisableExplicitSyncEnvVar, "1"); err != nil {
		logger.Warn("NVIDIA explicit-sync workaround not applied",
			"env", nvidiaDisableExplicitSyncEnvVar, "error", err)
		return
	}
	logger.Debug("NVIDIA explicit-sync workaround applied", "env", nvidiaDisableExplicitSyncEnvVar)
}
