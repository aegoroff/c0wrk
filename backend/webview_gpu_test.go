package backend

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
)

func TestNormalizeWebviewGpuPolicy(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    string
		wantErr bool
	}{
		{name: "always", raw: "always", want: WebviewGpuPolicyAlways},
		{name: "on-demand hyphenated", raw: "on-demand", want: WebviewGpuPolicyOnDemand},
		{name: "ondemand alias", raw: "ondemand", want: WebviewGpuPolicyOnDemand},
		{name: "never", raw: "never", want: WebviewGpuPolicyNever},
		{name: "case-insensitive", raw: "  ALWAYS ", want: WebviewGpuPolicyAlways},
		{name: "empty is invalid", raw: "", wantErr: true},
		{name: "unknown value", raw: "speed", wantErr: true},
		{name: "no auto in the env alphabet", raw: "auto", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeWebviewGpuPolicy(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got policy %q", tc.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse %q: %v", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("parse %q: want %q, got %q", tc.raw, tc.want, got)
			}
		})
	}
}

func TestNormalizeWebviewGpuPolicyErrorContainsAllowedValues(t *testing.T) {
	_, err := NormalizeWebviewGpuPolicy("turbo")
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"turbo", "always", "on-demand", "never"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q should mention %q", err.Error(), want)
		}
	}
}

func TestNormalizeWebviewGpuSetting(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    string
		wantErr bool
	}{
		{name: "auto", raw: "auto", want: WebviewGpuPolicyAuto},
		{name: "always", raw: "always", want: WebviewGpuPolicyAlways},
		{name: "on-demand hyphenated", raw: "on-demand", want: WebviewGpuPolicyOnDemand},
		{name: "ondemand alias", raw: "ondemand", want: WebviewGpuPolicyOnDemand},
		{name: "never", raw: "never", want: WebviewGpuPolicyNever},
		{name: "case-insensitive", raw: "  Auto ", want: WebviewGpuPolicyAuto},
		{name: "empty is invalid", raw: "", wantErr: true},
		{name: "unknown value", raw: "speed", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeWebviewGpuSetting(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got setting %q", tc.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse %q: %v", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("parse %q: want %q, got %q", tc.raw, tc.want, got)
			}
		})
	}
}

func TestNormalizeWebviewGpuSettingErrorContainsAllowedValues(t *testing.T) {
	_, err := NormalizeWebviewGpuSetting("turbo")
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"turbo", "auto", "always", "on-demand", "never"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q should mention %q", err.Error(), want)
		}
	}
}

func TestResolveWebviewGpuPolicy(t *testing.T) {
	cases := []struct {
		name         string
		setting      string
		fallback     bool
		wantPolicy   string
		wantSourceSt string
	}{
		{name: "auto resolves on-demand", setting: WebviewGpuPolicyAuto, wantPolicy: WebviewGpuPolicyOnDemand, wantSourceSt: WebviewGpuSourceAuto},
		{name: "auto + fallback resolves never", setting: WebviewGpuPolicyAuto, fallback: true, wantPolicy: WebviewGpuPolicyNever, wantSourceSt: WebviewGpuSourceAutoFallback},
		{name: "explicit always", setting: WebviewGpuPolicyAlways, wantPolicy: WebviewGpuPolicyAlways, wantSourceSt: WebviewGpuSourceSetting},
		{name: "explicit on-demand", setting: WebviewGpuPolicyOnDemand, wantPolicy: WebviewGpuPolicyOnDemand, wantSourceSt: WebviewGpuSourceSetting},
		{name: "explicit never", setting: WebviewGpuPolicyNever, wantPolicy: WebviewGpuPolicyNever, wantSourceSt: WebviewGpuSourceSetting},
		{name: "explicit always ignores stale fallback", setting: WebviewGpuPolicyAlways, fallback: true, wantPolicy: WebviewGpuPolicyAlways, wantSourceSt: WebviewGpuSourceSetting},
		{name: "explicit never ignores stale fallback", setting: WebviewGpuPolicyNever, fallback: true, wantPolicy: WebviewGpuPolicyNever, wantSourceSt: WebviewGpuSourceSetting},
		{name: "unknown setting value degrades to auto", setting: "turbo", wantPolicy: WebviewGpuPolicyOnDemand, wantSourceSt: WebviewGpuSourceAuto},
		{name: "empty setting is auto", setting: "", wantPolicy: WebviewGpuPolicyOnDemand, wantSourceSt: WebviewGpuSourceAuto},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotPolicy, gotSource := ResolveWebviewGpuPolicy(tc.setting, tc.fallback)
			if gotPolicy != tc.wantPolicy {
				t.Fatalf("policy: want %q, got %q", tc.wantPolicy, gotPolicy)
			}
			if gotSource != tc.wantSourceSt {
				t.Fatalf("source: want %q, got %q", tc.wantSourceSt, gotSource)
			}
		})
	}
}

func dmabufFallbackFixture() *WebviewGpuAutoFallback {
	return &WebviewGpuAutoFallback{
		Policy:     WebviewGpuPolicyNever,
		Reason:     GpuFallbackReasonDmabufFailure,
		DetectedAt: "2026-10-15T00:00:00Z",
	}
}

func TestWebviewGpuStateRoundTrip(t *testing.T) {
	agentDir := t.TempDir()

	// Missing file on a fresh agent dir: zero state.
	if st := LoadWebviewGpuState(agentDir, nil); st.Setting() != WebviewGpuPolicyAuto || st.FallbackActive() {
		t.Fatalf("fresh agent dir: want zero state, got %+v", st)
	}

	want := WebviewGpuState{
		GPUPolicy:    WebviewGpuPolicyOnDemand,
		AutoFallback: dmabufFallbackFixture(),
	}
	if err := SaveWebviewGpuState(agentDir, want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got := LoadWebviewGpuState(agentDir, nil)
	if got.GPUPolicy != want.GPUPolicy {
		t.Errorf("GPUPolicy = %q, want %q", got.GPUPolicy, want.GPUPolicy)
	}
	if got.AutoFallback == nil {
		t.Fatal("AutoFallback lost on round trip")
	}
	if *got.AutoFallback != *want.AutoFallback {
		t.Errorf("AutoFallback = %+v, want %+v", *got.AutoFallback, *want.AutoFallback)
	}
	if got.Setting() != WebviewGpuPolicyOnDemand {
		t.Errorf("Setting = %q, want on-demand", got.Setting())
	}
	if !got.FallbackActive() {
		t.Error("FallbackActive = false, want true")
	}
}

func TestWebviewGpuStateDefensiveLoad(t *testing.T) {
	agentDir := t.TempDir()
	path := config.WebviewStatePath(agentDir)

	t.Run("corrupt file yields zero state", func(t *testing.T) {
		if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		st := LoadWebviewGpuState(agentDir, nil)
		if st.Setting() != WebviewGpuPolicyAuto || st.FallbackActive() {
			t.Fatalf("corrupt file: want zero state, got %+v", st)
		}
	})

	t.Run("unknown setting value degrades to auto", func(t *testing.T) {
		if err := os.WriteFile(path, []byte(`{"gpu_policy":"turbo"}`), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		st := LoadWebviewGpuState(agentDir, nil)
		if st.Setting() != WebviewGpuPolicyAuto {
			t.Fatalf("Setting = %q, want auto", st.Setting())
		}
		if st.FallbackActive() {
			t.Fatal("FallbackActive = true, want false")
		}
	})

	t.Run("load never writes the file back", func(t *testing.T) {
		if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		LoadWebviewGpuState(agentDir, nil)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("state file vanished: %v", err)
		}
		if string(data) != "{not json" {
			t.Fatalf("load rewrote the state file: %q", data)
		}
	})
}

func TestDeriveWebviewGpuRun(t *testing.T) {
	agentDir := t.TempDir()
	writeState := func(t *testing.T, st WebviewGpuState) {
		t.Helper()
		if err := SaveWebviewGpuState(agentDir, st); err != nil {
			t.Fatalf("save state: %v", err)
		}
	}

	t.Run("unset env + no setting = auto", func(t *testing.T) {
		t.Setenv(WebviewGpuPolicyEnvVar, "")
		run := DeriveWebviewGpuRun("linux", agentDir, true, nil)
		if run.Policy != WebviewGpuPolicyOnDemand || run.Source != WebviewGpuSourceAuto || run.Setting != WebviewGpuPolicyAuto {
			t.Fatalf("got %+v, want on-demand/auto/auto", run)
		}
	})

	// Review finding #155.2: on Linux a fresh auto without a usable stderr
	// capture is demoted to never — the DMABUF watchdog could never detect
	// the grey window, so the accelerated default must not apply. Off Linux
	// the whole policy machinery is inert, so the resolution is unchanged.
	// The goos parameter makes both branches deterministic on every platform
	// (CI red fix: the formula must not read runtime.GOOS behind the
	// callers' backs — the desktop table's goos seam used to be ignored).
	t.Run("unobserved fresh auto demotes on linux only", func(t *testing.T) {
		t.Setenv(WebviewGpuPolicyEnvVar, "")
		run := DeriveWebviewGpuRun("linux", agentDir, false, nil)
		if run.Policy != WebviewGpuPolicyNever || run.Source != WebviewGpuSourceAutoUnobserved || run.Setting != WebviewGpuPolicyAuto {
			t.Fatalf("linux: got %+v, want never/auto-unobserved/auto", run)
		}
		run = DeriveWebviewGpuRun("darwin", agentDir, false, nil)
		if run.Policy != WebviewGpuPolicyOnDemand || run.Source != WebviewGpuSourceAuto || run.Setting != WebviewGpuPolicyAuto {
			t.Fatalf("darwin: got %+v, want on-demand/auto/auto off Linux (no policy machinery)", run)
		}
	})

	t.Run("unobserved explicit setting is never demoted", func(t *testing.T) {
		t.Setenv(WebviewGpuPolicyEnvVar, "")
		writeState(t, WebviewGpuState{GPUPolicy: WebviewGpuPolicyOnDemand})
		run := DeriveWebviewGpuRun("linux", agentDir, false, nil)
		if run.Policy != WebviewGpuPolicyOnDemand || run.Source != WebviewGpuSourceSetting {
			t.Fatalf("got %+v, want on-demand/setting (explicit choices survive)", run)
		}
	})

	t.Run("unobserved env override is never demoted", func(t *testing.T) {
		t.Setenv(WebviewGpuPolicyEnvVar, "always")
		run := DeriveWebviewGpuRun("linux", agentDir, false, nil)
		if run.Policy != WebviewGpuPolicyAlways || run.Source != WebviewGpuSourceEnv {
			t.Fatalf("got %+v, want always/env (explicit override survives)", run)
		}
	})

	t.Run("unobserved auto + fallback stays auto-fallback", func(t *testing.T) {
		t.Setenv(WebviewGpuPolicyEnvVar, "")
		writeState(t, WebviewGpuState{AutoFallback: dmabufFallbackFixture()})
		run := DeriveWebviewGpuRun("linux", agentDir, false, nil)
		if run.Policy != WebviewGpuPolicyNever || run.Source != WebviewGpuSourceAutoFallback {
			t.Fatalf("got %+v, want never/auto-fallback (already safe, no demotion)", run)
		}
	})

	t.Run("valid env wins over setting and fallback", func(t *testing.T) {
		t.Setenv(WebviewGpuPolicyEnvVar, "never")
		writeState(t, WebviewGpuState{GPUPolicy: WebviewGpuPolicyAlways, AutoFallback: dmabufFallbackFixture()})
		run := DeriveWebviewGpuRun("linux", agentDir, true, nil)
		if run.Policy != WebviewGpuPolicyNever || run.Source != WebviewGpuSourceEnv {
			t.Fatalf("got %+v, want never/env", run)
		}
		// The consumed setting rides along even when the env override wins —
		// the startup Debug log reports it without a second state-file read.
		if run.Setting != WebviewGpuPolicyAlways {
			t.Fatalf("Setting = %q, want always", run.Setting)
		}
	})

	t.Run("invalid env falls through to the setting", func(t *testing.T) {
		t.Setenv(WebviewGpuPolicyEnvVar, "  turbo ")
		writeState(t, WebviewGpuState{GPUPolicy: WebviewGpuPolicyNever})
		run := DeriveWebviewGpuRun("linux", agentDir, true, nil)
		if run.Policy != WebviewGpuPolicyNever || run.Source != WebviewGpuSourceSetting || run.Setting != WebviewGpuPolicyNever {
			t.Fatalf("got %+v, want never/setting/never", run)
		}
	})

	t.Run("auto + fallback", func(t *testing.T) {
		t.Setenv(WebviewGpuPolicyEnvVar, "")
		writeState(t, WebviewGpuState{AutoFallback: dmabufFallbackFixture()})
		run := DeriveWebviewGpuRun("linux", agentDir, true, nil)
		if run.Policy != WebviewGpuPolicyNever || run.Source != WebviewGpuSourceAutoFallback || run.Setting != WebviewGpuPolicyAuto {
			t.Fatalf("got %+v, want never/auto-fallback/auto", run)
		}
	})
}

// ensureWebviewGpuTestFiles pins that the state file path helper is used —
// the paths-centralization rule forbids inlining the file name.
func TestWebviewGpuStateUsesCentralPath(t *testing.T) {
	agentDir := t.TempDir()
	if err := SaveWebviewGpuState(agentDir, WebviewGpuState{GPUPolicy: WebviewGpuPolicyNever}); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(agentDir, "webview_state.json")); err != nil {
		t.Fatalf("expected webview_state.json via config.WebviewStatePath: %v", err)
	}
}
