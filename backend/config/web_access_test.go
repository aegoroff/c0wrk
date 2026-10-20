// SPDX-License-Identifier: Apache-2.0

package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// loadWebAccessYAML loads a config from an in-memory YAML document through
// the real pipeline.
func loadWebAccessYAML(t *testing.T, doc string) (cfg *Config, warnings []string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(doc), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	result, err := LoadWithResult(path)
	if err != nil {
		t.Fatalf("LoadWithResult: %v", err)
	}
	return result.Config, result.LoadErrors
}

// minimalWebAccessYAML is the smallest document the loader accepts (default_model
// + one provider with an enabled model), plus an optional web_access block.
func minimalWebAccessYAML(webAccess string) string {
	doc := `
llm:
  default_model: claude-3-haiku
  anthropic:
    api_key: "test-key"
    models:
      - claude-3-haiku
`
	if webAccess != "" {
		doc += "\n" + webAccess + "\n"
	}
	return doc
}

func TestWebAccess_AbsentSectionDefaultsOff(t *testing.T) {
	// The acceptance contract: an absent section is the zero value — the
	// sidecar stays off and nothing is seeded except the explicit loopback
	// bind default.
	cfg, warnings := loadWebAccessYAML(t, minimalWebAccessYAML(""))
	if len(warnings) != 0 {
		t.Fatalf("absent section must load without warnings, got %v", warnings)
	}
	if cfg.WebAccess.Enabled {
		t.Error("absent section must default to disabled")
	}
	if got := cfg.WebAccess.Bind; got != DefaultWebAccessBind {
		t.Errorf("bind = %q, want seeded default %q", got, DefaultWebAccessBind)
	}
	if got := cfg.WebAccess.Port; got != 0 {
		t.Errorf("port = %d, want 0 (auto)", got)
	}
	if got := cfg.WebAccess.Token; got != "" {
		t.Errorf("token = %q, want empty (ephemeral per-launch)", got)
	}
}

func TestWebAccess_ValidSectionLoads(t *testing.T) {
	// Every loopback bind class rides the full pipeline warning-free.
	for _, bind := range []string{"127.0.0.1", "::1", "localhost", "127.8.8.8", "::ffff:127.0.0.1"} {
		cfg, warnings := loadWebAccessYAML(t, minimalWebAccessYAML(`
web_access:
  enabled: true
  bind: "`+bind+`"
  port: 8765
  token: s3cret-token
`))
		if len(warnings) != 0 {
			t.Fatalf("bind %q: valid section must load without warnings, got %v", bind, warnings)
		}
		if !cfg.WebAccess.Enabled {
			t.Errorf("bind %q: section must stay enabled", bind)
		}
		if cfg.WebAccess.Bind != bind {
			t.Errorf("bind %q: round-tripped as %q", bind, cfg.WebAccess.Bind)
		}
		if cfg.WebAccess.Port != 8765 {
			t.Errorf("bind %q: port = %d, want 8765", bind, cfg.WebAccess.Port)
		}
		if cfg.WebAccess.Token != "s3cret-token" {
			t.Errorf("bind %q: token = %q", bind, cfg.WebAccess.Token)
		}
	}
	// Port variants over the default bind: 0 = auto, explicit = verbatim. An
	// omitted bind is seeded with the default (flipping just `enabled` on is
	// the documented safe shortcut).
	for name, port := range map[string]int{"auto-port": 0, "explicit": 8765} {
		cfg, warnings := loadWebAccessYAML(t, minimalWebAccessYAML(`
web_access:
  enabled: true
  port: `+strconv.Itoa(port)+`
`))
		if len(warnings) != 0 {
			t.Fatalf("%s: valid section must load without warnings, got %v", name, warnings)
		}
		if !cfg.WebAccess.Enabled {
			t.Errorf("%s: section must stay enabled", name)
		}
		if cfg.WebAccess.Bind != DefaultWebAccessBind {
			t.Errorf("%s: omitted bind = %q, want seeded %q", name, cfg.WebAccess.Bind, DefaultWebAccessBind)
		}
		if cfg.WebAccess.Port != port {
			t.Errorf("%s: port = %d, want %d", name, cfg.WebAccess.Port, port)
		}
		if cfg.WebAccess.Token != "" {
			t.Errorf("%s: token = %q, want empty (ephemeral)", name, cfg.WebAccess.Token)
		}
	}
}

func TestWebAccess_NonLoopbackBindLoadsWithWarning(t *testing.T) {
	// Stage 2: a valid non-loopback bind is a deliberate LAN-exposed listener,
	// not a validity problem — it loads ENABLED with exactly one
	// network-exposure warning and its values preserved verbatim.
	for _, bind := range []string{"0.0.0.0", "::", "192.168.1.10", "10.0.0.5"} {
		cfg, warnings := loadWebAccessYAML(t, minimalWebAccessYAML(`
web_access:
  enabled: true
  bind: "`+bind+`"
  port: 8765
  token: s3cret-token
`))
		if len(warnings) != 1 {
			t.Fatalf("bind %q: expected exactly one load warning, got %v", bind, warnings)
		}
		if !strings.Contains(warnings[0], "web_access") ||
			!strings.Contains(warnings[0], "not loopback") ||
			!strings.Contains(warnings[0], "network-accessible") {
			t.Errorf("bind %q: warning must name the section and the network exposure, got %q", bind, warnings[0])
		}
		if !cfg.WebAccess.Enabled {
			t.Errorf("bind %q: a valid non-loopback section must stay enabled", bind)
		}
		if cfg.WebAccess.Bind != bind || cfg.WebAccess.Port != 8765 || cfg.WebAccess.Token != "s3cret-token" {
			t.Errorf("bind %q: section values must be preserved, got %+v", bind, cfg.WebAccess)
		}
	}
}

func TestWebAccess_InvalidBindFailsSoft(t *testing.T) {
	// Only INVALID binds reset the section: unparseable literals and
	// non-"localhost" hostnames. "0.0.0.0" and LAN IPs are valid since stage
	// 2 (covered by TestWebAccess_NonLoopbackBindLoadsWithWarning). An
	// explicit empty bind is NOT in this table: ApplyDefaults seeds it with
	// the default before normalization, so `enabled: true` with no bind is
	// the valid "default bind" shortcut, never a warning; the in-memory
	// empty-bind reset is pinned by TestWebAccess_EmptyBindFailsSoftInMemory.
	for _, bind := range []string{"garbage", "example.com", "localhost.localdomain", "127.0.0.1:8080"} {
		cfg, warnings := loadWebAccessYAML(t, minimalWebAccessYAML(`
web_access:
  enabled: true
  bind: "`+bind+`"
  port: 8765
`))
		if len(warnings) != 1 {
			t.Fatalf("bind %q: expected exactly one load warning, got %v", bind, warnings)
		}
		if !strings.Contains(warnings[0], "web_access") || !strings.Contains(warnings[0], "ignored") {
			t.Errorf("bind %q: warning must name the section and the reset, got %q", bind, warnings[0])
		}
		// Reset to the safe default state: sidecar off, default bind, auto
		// port, ephemeral token.
		if cfg.WebAccess.Enabled {
			t.Errorf("bind %q: invalid section must be disabled", bind)
		}
		if cfg.WebAccess.Bind != DefaultWebAccessBind {
			t.Errorf("bind %q: reset bind = %q, want %q", bind, cfg.WebAccess.Bind, DefaultWebAccessBind)
		}
		if cfg.WebAccess.Port != 0 || cfg.WebAccess.Token != "" {
			t.Errorf("bind %q: reset section carries port %d / token %q", bind, cfg.WebAccess.Port, cfg.WebAccess.Token)
		}
	}
}

func TestWebAccess_EmptyBindFailsSoftInMemory(t *testing.T) {
	// The load pipeline never sees an empty bind (ApplyDefaults seeds the
	// default first), but an in-memory mutation can produce one — and the
	// fail-soft normalize contract must treat it as INVALID, not as a valid
	// class: one warning and a reset to the safe default state.
	cfg := &Config{WebAccess: WebAccessConfig{Enabled: true, Bind: "", Port: 8765}}
	warnings := normalizeWebAccess(cfg)
	if len(warnings) != 1 {
		t.Fatalf("expected exactly one load warning, got %v", warnings)
	}
	if !strings.Contains(warnings[0], "web_access") || !strings.Contains(warnings[0], "ignored") {
		t.Errorf("warning must name the section and the reset, got %q", warnings[0])
	}
	if cfg.WebAccess != defaultWebAccessState() {
		t.Errorf("empty-bind section must reset to the default state, got %+v", cfg.WebAccess)
	}
}

func TestWebAccess_BadPortFailsSoft(t *testing.T) {
	for _, port := range []string{"-1", "65536", "70000"} {
		cfg, warnings := loadWebAccessYAML(t, minimalWebAccessYAML(`
web_access:
  enabled: true
  bind: "127.0.0.1"
  port: `+port+`
`))
		if len(warnings) != 1 {
			t.Fatalf("port %s: expected exactly one load warning, got %v", port, warnings)
		}
		if !strings.Contains(warnings[0], "port") {
			t.Errorf("port %s: warning must name the port, got %q", port, warnings[0])
		}
		if cfg.WebAccess.Enabled {
			t.Errorf("port %s: invalid section must be disabled", port)
		}
		if cfg.WebAccess.Port != 0 {
			t.Errorf("port %s: reset port = %d, want 0 (auto)", port, cfg.WebAccess.Port)
		}
	}
}

func TestWebAccess_DisabledSectionAcceptsAnything(t *testing.T) {
	// An inert section (enabled false or absent) accepts any values without
	// warning — exactly like an inactive shell_exec override. The values are
	// preserved as authored (nothing is validated, nothing is reset); the
	// bind default is only seeded when the key is empty.
	cfg, warnings := loadWebAccessYAML(t, minimalWebAccessYAML(`
web_access:
  enabled: false
  bind: "0.0.0.0"
  port: 70000
  token: whatever
`))
	if len(warnings) != 0 {
		t.Fatalf("disabled section must not warn, got %v", warnings)
	}
	if cfg.WebAccess.Enabled {
		t.Error("section must stay disabled")
	}
	if cfg.WebAccess.Bind != "0.0.0.0" || cfg.WebAccess.Port != 70000 || cfg.WebAccess.Token != "whatever" {
		t.Errorf("disabled section values must be preserved as authored, got %+v", cfg.WebAccess)
	}
}

func TestWebAccess_SaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	cfg := minimalValidConfig()
	if cfg.WebAccess.Enabled || cfg.WebAccess.Bind != DefaultWebAccessBind {
		t.Fatalf("defaults: unexpected web_access state %+v", cfg.WebAccess)
	}
	if err := Save(cfg, path); err != nil {
		t.Fatalf("Save (defaults): %v", err)
	}
	loaded, err := LoadWithResult(path)
	if err != nil {
		t.Fatalf("LoadWithResult (defaults): %v", err)
	}
	if len(loaded.LoadErrors) != 0 {
		t.Fatalf("defaults round trip must be warning-free, got %v", loaded.LoadErrors)
	}
	if loaded.Config.WebAccess != (WebAccessConfig{Bind: DefaultWebAccessBind}) {
		t.Errorf("defaults round trip = %+v, want {Bind: %q}", loaded.Config.WebAccess, DefaultWebAccessBind)
	}

	// An enabled, valid loopback section round-trips unchanged and
	// warning-free.
	cfg.WebAccess = WebAccessConfig{Enabled: true, Bind: "::1", Port: 8765, Token: "s3cret-token"}
	if err := Save(cfg, path); err != nil {
		t.Fatalf("Save (enabled): %v", err)
	}
	loaded, err = LoadWithResult(path)
	if err != nil {
		t.Fatalf("LoadWithResult (enabled): %v", err)
	}
	if len(loaded.LoadErrors) != 0 {
		t.Fatalf("enabled round trip must be warning-free, got %v", loaded.LoadErrors)
	}
	if loaded.Config.WebAccess != cfg.WebAccess {
		t.Errorf("enabled round trip = %+v, want %+v", loaded.Config.WebAccess, cfg.WebAccess)
	}
}

func TestWebAccess_NonLoopbackBindSaveRoundTrip(t *testing.T) {
	// A valid non-loopback bind is an operator decision, not a validity
	// problem: it saves without error and re-loads with exactly the
	// network-exposure warning, values intact.
	for _, bind := range []string{"0.0.0.0", "192.168.1.10"} {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.yaml")
		cfg := minimalValidConfig()
		cfg.WebAccess = WebAccessConfig{Enabled: true, Bind: bind, Port: 8765, Token: "s3cret-token"}
		if err := Save(cfg, path); err != nil {
			t.Fatalf("bind %q: Save must accept a valid non-loopback bind, got %v", bind, err)
		}
		if _, statErr := os.Stat(path); statErr != nil {
			t.Fatalf("bind %q: accepted save must create the file: %v", bind, statErr)
		}
		loaded, err := LoadWithResult(path)
		if err != nil {
			t.Fatalf("bind %q: LoadWithResult: %v", bind, err)
		}
		if len(loaded.LoadErrors) != 1 {
			t.Fatalf("bind %q: reload must carry exactly the loopback warning, got %v", bind, loaded.LoadErrors)
		}
		if !strings.Contains(loaded.LoadErrors[0], "not loopback") ||
			!strings.Contains(loaded.LoadErrors[0], "network-accessible") {
			t.Errorf("bind %q: reload warning must name the network exposure, got %q", bind, loaded.LoadErrors[0])
		}
		if loaded.Config.WebAccess != cfg.WebAccess {
			t.Errorf("bind %q: round trip = %+v, want %+v", bind, loaded.Config.WebAccess, cfg.WebAccess)
		}
	}
}

func TestWebAccess_SaveRejectsUnsafeState(t *testing.T) {
	// Fail-closed keys on VALIDITY (stage 2): the load path heals an invalid
	// section before it can ever be re-saved, so these states are only
	// reachable through in-memory mutation — and the save must refuse to make
	// config.yaml their source. The empty-bind case is the in-memory
	// counterpart of the (valid) omitted-key load shortcut. A valid
	// non-loopback bind is NOT in this table: it saves (see
	// TestWebAccess_NonLoopbackBindSaveRoundTrip).
	cases := map[string]WebAccessConfig{
		"garbage bind":  {Enabled: true, Bind: "not-an-ip"},
		"hostname bind": {Enabled: true, Bind: "example.com"},
		"empty bind":    {Enabled: true},
		"negative port": {Enabled: true, Bind: "127.0.0.1", Port: -1},
		"port overflow": {Enabled: true, Bind: "127.0.0.1", Port: 65536},
	}
	for name, wa := range cases {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.yaml")
		cfg := minimalValidConfig()
		cfg.WebAccess = wa
		err := Save(cfg, path)
		if err == nil {
			t.Errorf("%s: Save must refuse an invalid enabled section", name)
			continue
		}
		if !strings.Contains(err.Error(), "web_access") {
			t.Errorf("%s: error must name the section, got %q", name, err.Error())
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Errorf("%s: refused save must not create the file", name)
		}
		// The disabled counterpart of the same state saves fine.
		wa.Enabled = false
		cfg.WebAccess = wa
		if err := Save(cfg, path); err != nil {
			t.Errorf("%s: the disabled state must save fine, got %v", name, err)
		}
	}
}

func TestIsLoopbackBind(t *testing.T) {
	loopback := []string{
		"127.0.0.1",
		"127.8.8.8",
		"::1",
		"localhost",
		"::ffff:127.0.0.1", // IPv4-mapped loopback
	}
	for _, bind := range loopback {
		if !IsLoopbackBind(bind) {
			t.Errorf("IsLoopbackBind(%q) = false, want true", bind)
		}
	}
	notLoopback := []string{
		"",
		"0.0.0.0",
		"192.168.1.10",
		"10.0.0.1",
		"example.com",
		"localhost.localdomain",
		"127.0.0.1:8080", // the port is a separate field, not part of bind
		"::ffff:192.168.1.10",
	}
	for _, bind := range notLoopback {
		if IsLoopbackBind(bind) {
			t.Errorf("IsLoopbackBind(%q) = true, want false", bind)
		}
	}
}

func TestIsValidWebAccessBind(t *testing.T) {
	// Validity (stage 2) accepts EVERY IP literal — loopback, unspecified,
	// specific IPv4/IPv6, IPv4-mapped — plus the one "localhost" name.
	valid := []string{
		"127.0.0.1",
		"127.8.8.8",
		"::1",
		"::ffff:127.0.0.1",
		"0.0.0.0",
		"::",
		"192.168.1.10",
		"10.0.0.1",
		"8.8.8.8",
		"fd00::1",
		"::ffff:192.168.1.10",
		"localhost",
	}
	for _, bind := range valid {
		if !IsValidWebAccessBind(bind) {
			t.Errorf("IsValidWebAccessBind(%q) = false, want true", bind)
		}
	}
	invalid := []string{
		"",
		"garbage",
		"example.com",
		"localhost.localdomain",
		"127.0.0.1:8080", // the port is a separate field, not part of bind
		" 127.0.0.1",     // whitespace is not an address
	}
	for _, bind := range invalid {
		if IsValidWebAccessBind(bind) {
			t.Errorf("IsValidWebAccessBind(%q) = true, want false", bind)
		}
	}
}

func TestValidateWebAccessBind(t *testing.T) {
	// The exported mirror of the section rule: valid binds — loopback or not
	// (loopback classification is a warning matter, IsLoopbackBind) — return
	// nil; empty and unparseable values are rejected.
	for _, bind := range []string{"127.0.0.1", "::1", "localhost", "0.0.0.0", "::", "192.168.1.10", "::ffff:10.0.0.1"} {
		if err := ValidateWebAccessBind(bind); err != nil {
			t.Errorf("ValidateWebAccessBind(%q) = %v, want nil", bind, err)
		}
	}
	for _, bind := range []string{"", "garbage", "example.com"} {
		err := ValidateWebAccessBind(bind)
		if err == nil {
			t.Errorf("ValidateWebAccessBind(%q) = nil, want error", bind)
			continue
		}
		if !strings.Contains(err.Error(), "web_access") {
			t.Errorf("ValidateWebAccessBind(%q): error must name the section, got %q", bind, err.Error())
		}
	}
	// The exact message the load/save paths produce for the empty bind.
	if got := ValidateWebAccessBind("").Error(); got != "web_access: bind is required when enabled" {
		t.Errorf("ValidateWebAccessBind(\"\") = %q, want the section-naming required-bind message", got)
	}
}
