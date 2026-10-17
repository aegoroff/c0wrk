package backend

import (
	"runtime"
)

// WebviewGpuPolicyInfo is the Get/SetWebviewGpuPolicy wire shape (issue #34):
// the persisted setting, what the RUNNING webview resolved at launch, the
// active watchdog fallback, and whether a restart is needed to apply the
// pending setting. Effective on Linux only — on other platforms the values
// persist harmlessly and LinuxOnly gates the Settings section in the UI.
type WebviewGpuPolicyInfo struct {
	// Setting is the persisted user choice (auto | always | on-demand |
	// never); "auto" when nothing was chosen yet.
	Setting string `json:"setting"`
	// Running is the canonical policy this launch resolved to, RunningSource
	// the layer that decided it (env | setting | auto | auto-fallback |
	// auto-unobserved — the last being a fresh auto demoted to never because
	// this launch has no usable stderr capture and the failure watchdog could
	// not observe it).
	Running       string `json:"running"`
	RunningSource string `json:"running_source"`
	// Fallback is non-nil while the watchdog has pinned auto to software
	// rendering after a detected DMABUF renderer failure.
	Fallback *WebviewGpuAutoFallback `json:"fallback,omitempty"`
	// RestartRequired reports whether a restart would move the running
	// policy to what the current setting resolves to. Always false while an
	// env override is in force: the override wins on the next launch too.
	RestartRequired bool `json:"restart_required"`
	LinuxOnly       bool `json:"linux_only"`
}

// GetWebviewGpuPolicy reports the webview GPU-policy state: the persisted
// setting, the running policy derived at launch, the watchdog fallback, and
// whether a restart would apply the pending setting.
func (f *FrontendAPI) GetWebviewGpuPolicy() WebviewGpuPolicyInfo {
	return f.webviewGpuPolicyInfo()
}

// SetWebviewGpuPolicy persists the user's choice (auto | always | on-demand |
// never; case-insensitive, "ondemand" accepted as an alias). ANY explicit
// choice clears the watchdog fallback: a concrete policy pins itself, and
// re-choosing auto is the "retry accelerated rendering" action — the watchdog
// re-arms for the next launch. Applies on the next app start (the policy is
// consumed at webview creation).
func (f *FrontendAPI) SetWebviewGpuPolicy(setting string) (WebviewGpuPolicyInfo, error) {
	normalized, err := NormalizeWebviewGpuSetting(setting)
	if err != nil {
		return WebviewGpuPolicyInfo{}, err
	}
	// The RMW runs under the webview_state lock, serialized against the
	// watchdog's fallback persist: both writers rewrite the whole file, and
	// an unlocked last-writer-wins could drop either side's change.
	err = UpdateWebviewGpuState(f.agentDir, f.logger, func(state *WebviewGpuState) {
		state.GPUPolicy = normalized
		state.AutoFallback = nil
	})
	if err != nil {
		return WebviewGpuPolicyInfo{}, err
	}
	f.log().Info("webview GPU policy setting changed", "setting", normalized)
	return f.webviewGpuPolicyInfo(), nil
}

// webviewGpuPolicyInfo assembles the wire shape: the live state file (the
// pending truth) against the launch-time running snapshot.
func (f *FrontendAPI) webviewGpuPolicyInfo() WebviewGpuPolicyInfo {
	f.configMu.RLock()
	running, runningSource := f.webviewGpuRunning, f.webviewGpuRunningSource
	f.configMu.RUnlock()

	state := LoadWebviewGpuState(f.agentDir, f.logger)
	pending, _ := ResolveWebviewGpuPolicy(state.Setting(), state.FallbackActive())
	return WebviewGpuPolicyInfo{
		Setting:         state.Setting(),
		Running:         running,
		RunningSource:   runningSource,
		Fallback:        state.AutoFallback,
		RestartRequired: runningSource != WebviewGpuSourceEnv && pending != running,
		LinuxOnly:       runtime.GOOS == "linux",
	}
}
