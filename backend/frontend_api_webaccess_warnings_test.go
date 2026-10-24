package backend

import (
	"reflect"
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
)

// staleWebAccessExposure is a launch-time web_access warning of the exact
// shape the load pipeline produces (the text source is the same function the
// runtime recompute uses, so the stale and the fresh entries are
// interchangeable strings).
func staleWebAccessExposure(t *testing.T) string {
	t.Helper()
	warnings := config.WebAccessLoadWarnings(config.WebAccessConfig{Enabled: true, Bind: "10.1.2.3"})
	if len(warnings) != 1 {
		t.Fatalf("the fixture exposure warning = %v, want exactly one", warnings)
	}
	return warnings[0]
}

// newWarningTestAPI builds a bare FrontendAPI carrying the given live config,
// with the seed-publication flag set so GetConfig serves without the Init
// barrier (the git-hardening test's precedent for zero-value APIs).
func newWarningTestAPI(webAccess config.WebAccessConfig, seeded []string) *FrontendAPI {
	f := &FrontendAPI{config: &config.Config{WebAccess: webAccess}}
	f.seedPublished.Store(true)
	f.configLoadErrors = seeded
	return f
}

// TestRefreshWebAccessLoadWarnings pins the ADR-099 channel contract: the
// refresh surgically replaces the web_access entries of configLoadErrors
// with the warnings the section's CURRENT state draws, preserving every
// other section's warning — so the Settings banner follows the live control
// RPCs instead of freezing on the launch-time snapshot, without ever wiping
// unrelated load warnings (unlike the settings writers that nil the whole
// channel once their own section validated).
func TestRefreshWebAccessLoadWarnings(t *testing.T) {
	unrelated := "autonomy: legacy smart_approve folded into silent_mode"
	stale := staleWebAccessExposure(t)
	exposed := config.WebAccessConfig{Enabled: true, Bind: "10.1.2.3"}

	t.Run("replaces stale exposure, keeps unrelated, appends fresh", func(t *testing.T) {
		f := newWarningTestAPI(exposed, []string{stale, unrelated})

		f.Lifecycle().RefreshWebAccessLoadWarnings()

		fresh := config.WebAccessLoadWarnings(f.config.WebAccess)
		want := append([]string{unrelated}, fresh...)
		if got := f.GetConfig().ConfigErrors; !reflect.DeepEqual(got, want) {
			t.Errorf("ConfigErrors = %v, want %v", got, want)
		}
	})

	t.Run("HTTPS flip drops the exposure warning", func(t *testing.T) {
		f := newWarningTestAPI(exposed, []string{stale, unrelated})

		f.config.WebAccess.TLS.Enabled = true
		f.Lifecycle().RefreshWebAccessLoadWarnings()

		if got := f.GetConfig().ConfigErrors; !reflect.DeepEqual(got, []string{unrelated}) {
			t.Errorf("ConfigErrors after the TLS flip = %v, want only %q", got, unrelated)
		}
	})

	t.Run("disable drops the warning, re-enable brings it back once", func(t *testing.T) {
		f := newWarningTestAPI(exposed, []string{stale, unrelated})

		f.config.WebAccess.Enabled = false
		f.Lifecycle().RefreshWebAccessLoadWarnings()
		if got := f.GetConfig().ConfigErrors; !reflect.DeepEqual(got, []string{unrelated}) {
			t.Errorf("ConfigErrors after the disable = %v, want only %q", got, unrelated)
		}

		f.config.WebAccess.Enabled = true
		f.Lifecycle().RefreshWebAccessLoadWarnings()
		f.Lifecycle().RefreshWebAccessLoadWarnings() // idempotent: no duplication
		want := append([]string{unrelated}, staleWebAccessExposure(t))
		if got := f.GetConfig().ConfigErrors; !reflect.DeepEqual(got, want) {
			t.Errorf("ConfigErrors after the re-enable = %v, want %v", got, want)
		}
	})

	t.Run("no stale entries appends without duplication", func(t *testing.T) {
		f := newWarningTestAPI(exposed, []string{unrelated})

		f.Lifecycle().RefreshWebAccessLoadWarnings()
		f.Lifecycle().RefreshWebAccessLoadWarnings()

		want := append([]string{unrelated}, staleWebAccessExposure(t))
		if got := f.GetConfig().ConfigErrors; !reflect.DeepEqual(got, want) {
			t.Errorf("ConfigErrors = %v, want %v (exactly one exposure)", got, want)
		}
	})

	t.Run("nil config is a no-op", func(t *testing.T) {
		f := &FrontendAPI{}
		f.seedPublished.Store(true)
		f.configLoadErrors = []string{unrelated}

		f.Lifecycle().RefreshWebAccessLoadWarnings()

		// GetConfig answers Loaded=false for a nil config, so the channel is
		// observed through its field directly.
		if got := f.configLoadErrors; !reflect.DeepEqual(got, []string{unrelated}) {
			t.Errorf("configLoadErrors = %v, want the seeded channel untouched", got)
		}
	})
}
