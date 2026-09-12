package config

import (
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/core/e2s"

	"gopkg.in/yaml.v3"
)

// TestE2SDefaultsSeeded verifies ApplyDefaults seeds the E2S section (zero →
// default) while the master toggle stays off — mirroring the Small-LLM
// profile: values are visible/editable while the mode itself is a no-op
// until BOTH experimental.enabled and e2s.enabled are true.
func TestE2SDefaultsSeeded(t *testing.T) {
	cfg := &Config{}
	ApplyDefaults(cfg)

	if cfg.E2S.Enabled {
		t.Error("e2s.enabled must default to false")
	}
	if got := cfg.E2S.MaxSteps; got != 50 {
		t.Errorf("e2s.max_steps default = %d, want 50", got)
	}
	if got := cfg.E2S.StateByteLimit; got != e2s.DefaultStateByteLimit {
		t.Errorf("e2s.state_byte_limit default = %d, want %d (core/e2s.DefaultStateByteLimit)", got, e2s.DefaultStateByteLimit)
	}
	if got := cfg.E2S.PatchRetries; got != 1 {
		t.Errorf("e2s.patch_retries default = %d, want 1", got)
	}
	if got := cfg.E2S.ObservationTruncate; got != 2000 {
		t.Errorf("e2s.observation_truncate default = %d, want 2000", got)
	}
	if got := cfg.E2S.RepeatNudgeThreshold; got != 3 {
		t.Errorf("e2s.repeat_nudge_threshold default = %d, want 3", got)
	}
	if got := cfg.E2S.RepeatAbortThreshold; got != 5 {
		t.Errorf("e2s.repeat_abort_threshold default = %d, want 5", got)
	}
}

// TestE2SExplicitValuesPreserved pins the seeding guard: explicit non-zero
// values from YAML must never be overwritten by the defaults.
func TestE2SExplicitValuesPreserved(t *testing.T) {
	cfg := &Config{
		E2S: E2SConfig{
			Enabled:              true,
			MaxSteps:             12,
			StateByteLimit:       4096,
			PatchRetries:         3,
			ObservationTruncate:  512,
			RepeatNudgeThreshold: 2,
			RepeatAbortThreshold: 4,
		},
	}
	ApplyDefaults(cfg)

	if cfg.E2S.MaxSteps != 12 || cfg.E2S.StateByteLimit != 4096 || cfg.E2S.PatchRetries != 3 ||
		cfg.E2S.ObservationTruncate != 512 || cfg.E2S.RepeatNudgeThreshold != 2 ||
		cfg.E2S.RepeatAbortThreshold != 4 {
		t.Errorf("explicit e2s values overwritten by ApplyDefaults: %+v", cfg.E2S)
	}
	if !cfg.E2S.Enabled {
		t.Error("explicit e2s.enabled=true must be preserved by ApplyDefaults (the experimental gate is applied later, at read time)")
	}
}

// TestE2SYAMLParsing verifies the e2s: section parses from YAML into the
// typed struct with defaults still seeding unset fields.
func TestE2SYAMLParsing(t *testing.T) {
	raw := `
e2s:
  enabled: true
  max_steps: 25
  state_byte_limit: 8192
`
	var cfg Config
	if err := yaml.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	ApplyDefaults(&cfg)

	if !cfg.E2S.Enabled {
		t.Error("e2s.enabled = false, want true")
	}
	if cfg.E2S.MaxSteps != 25 {
		t.Errorf("e2s.max_steps = %d, want 25", cfg.E2S.MaxSteps)
	}
	if cfg.E2S.StateByteLimit != 8192 {
		t.Errorf("e2s.state_byte_limit = %d, want 8192", cfg.E2S.StateByteLimit)
	}
	// Unset fields keep their defaults.
	if cfg.E2S.PatchRetries != 1 || cfg.E2S.ObservationTruncate != 2000 {
		t.Errorf("unset e2s fields lost their defaults: %+v", cfg.E2S)
	}
}

// minimalValidConfig builds the smallest config that passes validate() (the
// LLM section must resolve a default model), so the e2s validation rules can
// be exercised in isolation.
func minimalValidConfig() *Config {
	cfg := &Config{}
	ApplyDefaults(cfg)
	cfg.LLM.DefaultModel = "claude-3-haiku"
	cfg.LLM.Anthropic = AnthropicConfig{APIKey: "key", Models: []string{"claude-3-haiku"}}
	return cfg
}

// TestE2SNegativeValuesRejected verifies validate() fails fast on negative
// numeric e2s values (only a hand-written YAML can produce them — the
// seeded defaults are positive).
func TestE2SNegativeValuesRejected(t *testing.T) {
	for name, mutate := range map[string]func(*E2SConfig){
		"max_steps":              func(c *E2SConfig) { c.MaxSteps = -1 },
		"state_byte_limit":       func(c *E2SConfig) { c.StateByteLimit = -100 },
		"patch_retries":          func(c *E2SConfig) { c.PatchRetries = -1 },
		"observation_truncate":   func(c *E2SConfig) { c.ObservationTruncate = -5 },
		"repeat_nudge_threshold": func(c *E2SConfig) { c.RepeatNudgeThreshold = -2 },
		"repeat_abort_threshold": func(c *E2SConfig) { c.RepeatAbortThreshold = -3 },
	} {
		cfg := minimalValidConfig()
		mutate(&cfg.E2S)
		err := validate(cfg)
		if err == nil || !strings.Contains(err.Error(), "e2s."+name) {
			t.Errorf("%s: got %v, want an e2s.%s validation error", name, err, name)
		}
	}
}

// TestE2SThresholdOrderingRejected verifies the anti-spin invariant: the
// nudge threshold must never exceed the abort threshold, so the model always
// sees at least one corrective nudge before the loop stops.
func TestE2SThresholdOrderingRejected(t *testing.T) {
	cfg := minimalValidConfig()
	cfg.E2S.RepeatNudgeThreshold = 6 // default abort is 5
	if err := validate(cfg); err == nil || !strings.Contains(err.Error(), "repeat_nudge_threshold") {
		t.Fatalf("got %v, want a repeat_nudge_threshold ordering error", err)
	}

	cfg.E2S.RepeatAbortThreshold = 6
	if err := validate(cfg); err != nil {
		t.Fatalf("nudge 6 <= abort 6 must validate, got %v", err)
	}
}

// TestE2SSectionValidByDefault verifies a default-configured e2s section
// survives validate() cleanly.
func TestE2SSectionValidByDefault(t *testing.T) {
	if err := validate(minimalValidConfig()); err != nil {
		t.Fatalf("default e2s section must validate, got %v", err)
	}
}
