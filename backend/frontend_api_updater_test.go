package backend

import (
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/core/updater"
)

// newUpdaterTestAPI returns a minimal FrontendAPI suitable for the update RPC
// tests: the Init-publication flag raised so seedAcquire does not park, and a
// no-op event sink. The update subsystem only needs the config pointer and
// the lastCheckResult cache for GetLastUpdateCheck.
func newUpdaterTestAPI(t *testing.T) *FrontendAPI {
	t.Helper()
	f := &FrontendAPI{emitEvent: func(string, ...any) {}}
	f.seedPublished.Store(true)
	return f
}

// TestGetLastUpdateCheckNilCache covers the no-check-yet session: the RPC must
// report "nothing pending" (nil, nil) rather than an error, so the frontend's
// startup pull is a no-op on a fresh session.
func TestGetLastUpdateCheckNilCache(t *testing.T) {
	f := newUpdaterTestAPI(t)
	info, err := f.GetLastUpdateCheck()
	if err != nil {
		t.Fatalf("GetLastUpdateCheck() error = %v, want nil", err)
	}
	if info != nil {
		t.Fatalf("GetLastUpdateCheck() = %+v, want nil (no check has run)", info)
	}
}

// TestGetLastUpdateCheckNotAvailable covers a completed check that found no
// update: the cache holds a result but Available is false, and the RPC must
// report nothing pending.
func TestGetLastUpdateCheckNotAvailable(t *testing.T) {
	f := newUpdaterTestAPI(t)
	f.updateMu.Lock()
	f.lastCheckResult = &updater.Result{
		Available:      false,
		CurrentVersion: "v0.12.0",
		LatestVersion:  "v0.12.0",
	}
	f.updateMu.Unlock()

	info, err := f.GetLastUpdateCheck()
	if err != nil {
		t.Fatalf("GetLastUpdateCheck() error = %v, want nil", err)
	}
	if info != nil {
		t.Fatalf("GetLastUpdateCheck() = %+v, want nil (no update available)", info)
	}
}

// TestGetLastUpdateCheckAvailable covers the recovery path this RPC exists
// for: the startup auto-check found an update and cached it, but its
// update:available event raced (and lost against) the frontend's event
// subscription. The pull must return the cached release so the frontend can
// still surface the toast.
func TestGetLastUpdateCheckAvailable(t *testing.T) {
	f := newUpdaterTestAPI(t)
	want := &updater.Result{
		Available:      true,
		CurrentVersion: "v0.11.0",
		LatestVersion:  "v0.12.0",
		ReleaseNotes:   "notes",
		PublishedAt:    "2026-10-18T00:00:00Z",
		HTMLURL:        "https://github.com/v0lka/c0wrk/releases/tag/v0.12.0",
		AssetURL:       "https://github.com/v0lka/c0wrk/releases/download/v0.12.0/c0wrk-desktop-macos-arm64.zip",
		AssetName:      "c0wrk-desktop-macos-arm64.zip",
	}
	f.updateMu.Lock()
	f.lastCheckResult = want
	f.updateMu.Unlock()

	info, err := f.GetLastUpdateCheck()
	if err != nil {
		t.Fatalf("GetLastUpdateCheck() error = %v, want nil", err)
	}
	if info == nil {
		t.Fatal("GetLastUpdateCheck() = nil, want the cached available release")
	}
	if !info.Available || info.LatestVersion != want.LatestVersion ||
		info.CurrentVersion != want.CurrentVersion || info.AssetName != want.AssetName ||
		info.HTMLURL != want.HTMLURL || info.ReleaseNotes != want.ReleaseNotes ||
		info.PublishedAt != want.PublishedAt {
		t.Fatalf("GetLastUpdateCheck() = %+v, want the cached result %+v", info, want)
	}
}

// TestGetLastUpdateCheckOperatorDisabled covers the operator master gate: when
// config.yaml sets updates.enabled=false the whole subsystem is off and the
// RPC must report nothing pending regardless of any cached result.
func TestGetLastUpdateCheckOperatorDisabled(t *testing.T) {
	f := newUpdaterTestAPI(t)
	disabled := false
	disabledCfg := &config.Config{}
	disabledCfg.Updates.Enabled = &disabled
	f.configMu.Lock()
	f.config = disabledCfg
	f.configMu.Unlock()
	f.updateMu.Lock()
	f.lastCheckResult = &updater.Result{Available: true, LatestVersion: "v0.12.0"}
	f.updateMu.Unlock()

	info, err := f.GetLastUpdateCheck()
	if err != nil {
		t.Fatalf("GetLastUpdateCheck() error = %v, want nil", err)
	}
	if info != nil {
		t.Fatalf("GetLastUpdateCheck() = %+v, want nil (operator gate disabled)", info)
	}
}
