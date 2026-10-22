package backend

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/sp4rk/safeio"
)

// WebviewGpuPolicyEnvVar overrides the Linux webview hardware-acceleration
// policy with the highest precedence — above the persisted Settings choice.
// Accepted values are case-insensitive and whitespace-tolerant:
//
//	always     hardware acceleration always on
//	on-demand  hardware acceleration as requested by web contents
//	           ("ondemand" is accepted as an alias)
//	never      hardware acceleration always off
//
// An unset value falls through to the persisted setting (webview_state.json,
// Settings → General) and its "auto" resolution; an invalid value logs a Warn
// and also falls through. The variable has no effect on macOS and Windows.
const WebviewGpuPolicyEnvVar = "C0WRK_WEBVIEW_GPU_POLICY"

// Canonical webview GPU-policy spellings — the alphabet of the env var, the
// persisted setting, the Settings UI, and the RPC wire values. The Linux
// webview receives these through desktop's Wails-enum mapping; everything
// string-level lives here so the backend never imports the desktop layer.
const (
	WebviewGpuPolicyAlways   = "always"
	WebviewGpuPolicyOnDemand = "on-demand"
	WebviewGpuPolicyNever    = "never"
	// WebviewGpuPolicyAuto is a SETTING value, not an effective policy: it
	// resolves to on-demand unless the failure watchdog has persisted an
	// auto-fallback to never.
	WebviewGpuPolicyAuto = "auto"
)

// Where the effective policy of a launch came from — reported by the Settings
// RPCs and the startup logs.
const (
	WebviewGpuSourceEnv          = "env"
	WebviewGpuSourceSetting      = "setting"
	WebviewGpuSourceAuto         = "auto"
	WebviewGpuSourceAutoFallback = "auto-fallback"
	// WebviewGpuSourceAutoUnobserved names a launch where fresh auto would
	// have resolved to the accelerated on-demand, but this run's stderr is
	// not observable (the crash capture is unavailable), so the DMABUF
	// watchdog could never detect a grey window — the resolution is demoted
	// to never for the launch. Distinct from auto-fallback: nothing was
	// detected and nothing is persisted; the next launch with a usable
	// capture resolves on-demand again.
	WebviewGpuSourceAutoUnobserved = "auto-unobserved"
)

// GpuFallbackReasonDmabufFailure is the fallback reason the startup watchdog
// writes when the captured stderr of the current run carries the DMABUF
// renderer failure signatures (the grey/blank-window class, wails#2977).
const GpuFallbackReasonDmabufFailure = "dmabuf_render_failure"

// GpuFallbackReasonWaylandProtocolError is the fallback reason the next-start
// post-mortem writes when the previous fresh-auto run died on a fatal Wayland
// protocol error (GDK exits the process before DomReady, so the in-run
// watchdog never gets to scan).
const GpuFallbackReasonWaylandProtocolError = "wayland_protocol_error"

// NormalizeWebviewGpuPolicy parses a WebviewGpuPolicyEnvVar value into the
// canonical spelling. The env alphabet carries no "auto": the variable is an
// explicit override, and auto resolution belongs to the persisted setting.
func NormalizeWebviewGpuPolicy(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case WebviewGpuPolicyAlways:
		return WebviewGpuPolicyAlways, nil
	case WebviewGpuPolicyOnDemand, "ondemand":
		return WebviewGpuPolicyOnDemand, nil
	case WebviewGpuPolicyNever:
		return WebviewGpuPolicyNever, nil
	default:
		return WebviewGpuPolicyNever, fmt.Errorf("unknown webview GPU policy %q: want always, on-demand, or never", raw)
	}
}

// NormalizeWebviewGpuSetting parses a persisted webview_state.json gpu_policy
// value — the same alphabet the Settings UI offers, plus "auto". Case-
// insensitive and whitespace-tolerant like the env parser; "ondemand" is an
// alias of "on-demand".
func NormalizeWebviewGpuSetting(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case WebviewGpuPolicyAuto:
		return WebviewGpuPolicyAuto, nil
	case WebviewGpuPolicyAlways:
		return WebviewGpuPolicyAlways, nil
	case WebviewGpuPolicyOnDemand, "ondemand":
		return WebviewGpuPolicyOnDemand, nil
	case WebviewGpuPolicyNever:
		return WebviewGpuPolicyNever, nil
	default:
		return WebviewGpuPolicyAuto, fmt.Errorf("unknown webview GPU policy setting %q: want auto, always, on-demand, or never", raw)
	}
}

// ResolveWebviewGpuPolicy maps the persisted setting (plus the watchdog's
// auto-mode fallback) onto the canonical effective policy, naming the layer
// that decided it. The fallback applies only while the setting is "auto": an
// explicit user choice is never second-guessed, and the Settings RPC clears
// the record whenever a concrete value is persisted.
func ResolveWebviewGpuPolicy(setting string, fallbackActive bool) (policy, source string) {
	switch setting {
	case WebviewGpuPolicyAlways:
		return WebviewGpuPolicyAlways, WebviewGpuSourceSetting
	case WebviewGpuPolicyOnDemand:
		return WebviewGpuPolicyOnDemand, WebviewGpuSourceSetting
	case WebviewGpuPolicyNever:
		return WebviewGpuPolicyNever, WebviewGpuSourceSetting
	default:
		if fallbackActive {
			return WebviewGpuPolicyNever, WebviewGpuSourceAutoFallback
		}
		// Auto resolves to on-demand — the WebKit default, which composites
		// trivial CSS animations on the GPU instead of pegging a CPU core
		// (issue #34).
		return WebviewGpuPolicyOnDemand, WebviewGpuSourceAuto
	}
}

// WebviewGpuAutoFallback records why auto mode is pinned to software
// rendering: the watchdog detected a DMABUF renderer failure at startup and
// relaunched the app with the never policy. The record is sticky until the
// user acts on it — the Settings RPC clears it whenever any value is chosen,
// and re-choosing auto is the "retry" action.
type WebviewGpuAutoFallback struct {
	Policy     string `json:"policy"`      // always "never" today; kept explicit for future fallback targets
	Reason     string `json:"reason"`      // a GpuFallbackReason* constant
	DetectedAt string `json:"detected_at"` // RFC3339 UTC
}

// WebviewGpuState is the on-disk shape of webview_state.json. GPUPolicy is
// the user setting ("" = nothing chosen yet → auto); AutoFallback is nil
// unless the watchdog has fallen back.
type WebviewGpuState struct {
	GPUPolicy    string                  `json:"gpu_policy,omitempty"`
	AutoFallback *WebviewGpuAutoFallback `json:"auto_fallback,omitempty"`
}

// Setting returns the canonical setting; an unparsable persisted value (a
// hand edit) degrades to auto — LoadWebviewGpuState has already logged it.
func (s WebviewGpuState) Setting() string {
	setting, err := NormalizeWebviewGpuSetting(s.GPUPolicy)
	if err != nil {
		return WebviewGpuPolicyAuto
	}
	return setting
}

// FallbackActive reports whether the watchdog has persisted an auto-fallback.
func (s WebviewGpuState) FallbackActive() bool {
	return s.AutoFallback != nil
}

// LoadWebviewGpuState reads webview_state.json defensively: a missing file
// (nothing chosen yet), a malformed file, or an unknown gpu_policy value all
// resolve to the zero state (setting auto, no fallback) so a corrupt state
// file can never prevent the app from starting. main.go calls this before
// wails.Run to resolve the webview GPU policy.
func LoadWebviewGpuState(agentDir string, logger *slog.Logger) WebviewGpuState {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	var st WebviewGpuState
	data, err := safeio.ReadFile(config.WebviewStatePath(agentDir))
	if err != nil {
		// Missing on first run is expected — zero state silently.
		return st
	}
	if err := json.Unmarshal(data, &st); err != nil {
		logger.Debug("webview state file unreadable; using defaults",
			"path", config.WebviewStatePath(agentDir), "error", err)
		return WebviewGpuState{}
	}
	if st.GPUPolicy != "" {
		if _, err := NormalizeWebviewGpuSetting(st.GPUPolicy); err != nil {
			logger.Debug("unknown webview GPU policy setting; treating as auto",
				"path", config.WebviewStatePath(agentDir), "value", st.GPUPolicy, "error", err)
		}
	}
	return st
}

// SaveWebviewGpuState atomically writes webview_state.json. The write goes
// through safeio.WriteFileAtomic: the staging file is a random-suffix sibling
// created in the same directory, and the final rename REPLACES the directory
// entry itself — a symlink planted at webview_state.json is replaced, never
// written through.
func SaveWebviewGpuState(agentDir string, st WebviewGpuState) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return safeio.WriteFileAtomic(config.WebviewStatePath(agentDir), data, 0o600)
}

// webviewGpuStateMu serializes read-modify-write cycles on webview_state.json.
// Two independent writers RMW the whole file — the Settings RPC
// (SetWebviewGpuPolicy) and the desktop watchdog's fallback persist — and both
// go through UpdateWebviewGpuState, so a user choice landing between the
// watchdog's load and save can neither be clobbered by it nor wipe the
// fallback a moment before it is written back. Plain Load/Save callers stay
// lock-free: SaveWebviewGpuState replaces the file atomically, so readers
// always observe one complete state.
var webviewGpuStateMu sync.Mutex

// UpdateWebviewGpuState applies mutate to the freshly loaded state and saves
// the result atomically, under the webview_state.json RMW lock.
func UpdateWebviewGpuState(agentDir string, logger *slog.Logger, mutate func(*WebviewGpuState)) error {
	webviewGpuStateMu.Lock()
	defer webviewGpuStateMu.Unlock()
	state := LoadWebviewGpuState(agentDir, logger)
	mutate(&state)
	return SaveWebviewGpuState(agentDir, state)
}

// WebviewGpuRun is a fresh launch's webview GPU resolution, as returned by
// DeriveWebviewGpuRun.
type WebviewGpuRun struct {
	// Policy is the canonical effective policy; Source the layer that
	// decided it (env | setting | auto | auto-fallback | auto-unobserved).
	Policy string
	Source string
	// Setting is the canonical persisted setting the resolution consumed
	// ("auto" when nothing was chosen or the persisted value is unparsable).
	// Informational — the startup Debug log reports it — and deliberately
	// returned here so consumers never re-read webview_state.json just to
	// log it.
	Setting string
}

// DeriveWebviewGpuRun resolves the effective policy and its deciding layer
// for a fresh launch: a valid env override wins, otherwise the persisted
// setting (with its auto resolution). This is the single formula both
// consumers share — desktop's wails.Run options and Init's running-policy
// snapshot for the Settings RPCs — and the launch's single read of
// webview_state.json: the consumed setting rides along in the result.
//
// goos is the host platform the resolution targets ("linux" gates the
// demotion below — production passes runtime.GOOS, tests pass the platform
// explicitly so the linux branch is exercised on every runner).
// stderrObserved reports whether this launch has a usable stderr capture
// (crashlog.Install succeeded and capture is not opted out). The DMABUF
// watchdog detects the grey-window failure ONLY from that capture, so on
// Linux an unobserved run must not apply the accelerated fresh-auto default:
// enabling acceleration without any way to detect the resulting grey window
// trades a working-but-slow UI for a broken one with no recovery path. The
// resolution is demoted to never for the launch (source auto-unobserved,
// explicit Warn at the call site). Explicit user choices — env or setting —
// are never demoted, and an auto+fallback launch is already on never.
func DeriveWebviewGpuRun(goos, agentDir string, stderrObserved bool, logger *slog.Logger) WebviewGpuRun {
	state := LoadWebviewGpuState(agentDir, logger)
	setting := state.Setting()
	if raw := os.Getenv(WebviewGpuPolicyEnvVar); strings.TrimSpace(raw) != "" {
		if p, err := NormalizeWebviewGpuPolicy(raw); err == nil {
			return WebviewGpuRun{Policy: p, Source: WebviewGpuSourceEnv, Setting: setting}
		}
	}
	policy, source := ResolveWebviewGpuPolicy(setting, state.FallbackActive())
	if !stderrObserved && goos == "linux" && policy == WebviewGpuPolicyOnDemand && source == WebviewGpuSourceAuto {
		return WebviewGpuRun{Policy: WebviewGpuPolicyNever, Source: WebviewGpuSourceAutoUnobserved, Setting: setting}
	}
	return WebviewGpuRun{Policy: policy, Source: source, Setting: setting}
}
