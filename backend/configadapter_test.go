package backend

import (
	"path/filepath"
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
)

// TestAgentsMDSearchPaths verifies that agentsMDSearchPaths resolves the global
// and c0wrk-specific AGENTS.md paths relative to the user home directory in the
// documented priority order (global first, c0wrk second).
func TestAgentsMDSearchPaths(t *testing.T) {
	// os.UserHomeDir reads $HOME on Unix and %USERPROFILE% on Windows
	// (not %HOME%); override both to a temp dir for a deterministic result
	// on every platform Go supports.
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("USERPROFILE", tmpHome)

	got := agentsMDSearchPaths()
	want := []string{
		filepath.Join(tmpHome, ".agents", "AGENTS.md"),
		filepath.Join(tmpHome, ".c0wrk", ".agents", "AGENTS.md"),
	}
	if len(got) != len(want) {
		t.Fatalf("expected %d paths, got %d: %v", len(want), len(got), got)
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("path[%d]: got %q, want %q", i, got[i], w)
		}
	}
}

// TestAgentsMDSearchPaths_NoHomeDir verifies that a failure to resolve the home
// directory yields nil (no search paths) rather than panicking.
func TestAgentsMDSearchPaths_NoHomeDir(t *testing.T) {
	// Unset HOME and USERPROFILE so os.UserHomeDir returns an error.
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")

	got := agentsMDSearchPaths()
	if got != nil {
		t.Errorf("expected nil when home dir is unavailable, got %v", got)
	}
}

// slmTestCatalog returns the predefined catalog plus one custom profile
// ("test-profile") carrying fully-on variant values, for ToBuilderConfig
// mapping tests: the effective profile is resolved from the catalog, so test
// values live in a profile with cfg.SLM.ActiveProfile pointing at it.
func slmTestCatalog() []config.SLMProfile {
	customCfg := config.SLMProfileConfig{
		SystemPrompt: config.SystemPromptConfig{Lite: true, FewShot: true, ReasoningScaffold: true},
		Context: config.SLMContextConfig{
			Enabled:             true,
			Compaction:          config.SLMCompactionConfig{KeepLast: 6, BlockSize: 5, TriggerPercent: 80},
			ToolOutputKeepLastN: 2,
			OutputTokenReserve:  8192,
		},
	}
	custom, err := config.NewSLMProfile("test-profile", "Test Profile", config.SLMProfileKindCustom, customCfg)
	if err != nil {
		panic(err)
	}
	return append(config.PredefinedSLMProfiles(), custom)
}

// TestToBuilderConfig_SLMSystemPrompt verifies the config→builder mapping
// for the prompt-simplification variant: the active profile's
// SystemPrompt.{Lite, FewShot, ReasoningScaffold} all flow into
// BuilderSLMSystemPromptConfig so a profile change takes effect on rebuild.
func TestToBuilderConfig_SLMSystemPrompt(t *testing.T) {
	cfg := &config.Config{}
	cfg.Experimental.Enabled = true
	cfg.SLM.Enabled = true
	cfg.SLM.ActiveProfile = "test-profile"

	bc := ToBuilderConfig(cfg, slmTestCatalog())

	if !bc.SLM.Enabled {
		t.Error("SLM.Enabled not mapped")
	}
	// Lite is the SystemPrompt variant master toggle (there is no separate
	// Enabled field in config/builder — see SystemPromptConfig). It must map
	// straight through so a profile change takes effect on rebuild.
	if !bc.SLM.SystemPrompt.Lite {
		t.Error("SystemPrompt.Lite not mapped")
	}
	if !bc.SLM.SystemPrompt.FewShot {
		t.Error("SystemPrompt.FewShot not mapped")
	}
	if !bc.SLM.SystemPrompt.ReasoningScaffold {
		t.Error("SystemPrompt.ReasoningScaffold not mapped")
	}

	// Master off — even with Lite true, Enabled carries the master gate only.
	cfg.SLM.Enabled = false
	bc = ToBuilderConfig(cfg, slmTestCatalog())
	if bc.SLM.Enabled {
		t.Error("master Enabled should be false")
	}
	// The variant sub-toggle still reflects the profile value (master gating is
	// applied at runtime, not stripped at the mapping layer).
	if !bc.SLM.SystemPrompt.Lite {
		t.Error("SystemPrompt.Lite should still map the profile value")
	}
}

// TestToBuilderConfig_SLMContext verifies the config→builder mapping for
// the context-management variant: the active profile's Context.{Enabled,
// Compaction, ToolOutputKeepLastN, OutputTokenReserve} all flow into
// BuilderSLMContext so a profile change takes effect on rebuild.
func TestToBuilderConfig_SLMContext(t *testing.T) {
	cfg := &config.Config{}
	cfg.Experimental.Enabled = true
	cfg.SLM.Enabled = true
	cfg.SLM.ActiveProfile = "test-profile"

	bc := ToBuilderConfig(cfg, slmTestCatalog())

	if !bc.SLM.Context.Enabled {
		t.Error("Context.Enabled not mapped")
	}
	if bc.SLM.Context.Compaction.KeepLast != 6 {
		t.Errorf("Context.Compaction.KeepLast = %d, want 6", bc.SLM.Context.Compaction.KeepLast)
	}
	if bc.SLM.Context.Compaction.BlockSize != 5 {
		t.Errorf("Context.Compaction.BlockSize = %d, want 5", bc.SLM.Context.Compaction.BlockSize)
	}
	if bc.SLM.Context.Compaction.TriggerPercent != 80 {
		t.Errorf("Context.Compaction.TriggerPercent = %d, want 80", bc.SLM.Context.Compaction.TriggerPercent)
	}
	if bc.SLM.Context.ToolOutputKeepLastN != 2 {
		t.Errorf("Context.ToolOutputKeepLastN = %d, want 2", bc.SLM.Context.ToolOutputKeepLastN)
	}
	if bc.SLM.Context.OutputTokenReserve != 8192 {
		t.Errorf("Context.OutputTokenReserve = %d, want 8192", bc.SLM.Context.OutputTokenReserve)
	}

	// Master off — Enabled carries the master gate only; the variant values
	// still map through (gating is applied at runtime by
	// applyContextManagement, not stripped at the mapping layer).
	cfg.SLM.Enabled = false
	bc = ToBuilderConfig(cfg, slmTestCatalog())
	if bc.SLM.Enabled {
		t.Error("master Enabled should be false")
	}
	if !bc.SLM.Context.Enabled {
		t.Error("Context.Enabled should still map the profile value")
	}
}

// TestToBuilderConfig_SLMSamplingReasoningEffortDefault verifies the
// seeded reasoning-effort default (docs/development/slm-defaults-research.md, R3)
// end to end on the c0wrk side: a freshly defaulted config (active profile
// "generic") with the sampling variant enabled resolves to reasoning effort
// "medium" in the builder config. applySLMPresets (core) then seeds it as
// the builder-level default, and sp4rk's qwen mapping sends the native
// reasoning_effort parameter per request.
func TestToBuilderConfig_SLMSamplingReasoningEffortDefault(t *testing.T) {
	cfg := &config.Config{}
	config.ApplyDefaults(cfg)
	cfg.Experimental.Enabled = true
	cfg.SLM.Enabled = true
	// Enable the sampling variant on a writable copy of the generic profile so
	// the variant is actually active (values are profile-owned now).
	catalog := config.PredefinedSLMProfiles()
	for i := range catalog {
		if catalog[i].ID != config.SLMGenericProfileID {
			continue
		}
		variantCfg := catalog[i].Config
		variantCfg.Sampling.Enabled = true
		withSampling, err := config.NewSLMProfile(catalog[i].ID, catalog[i].Name, catalog[i].Kind, variantCfg)
		if err != nil {
			t.Fatalf("NewSLMProfile: %v", err)
		}
		catalog[i] = withSampling
		break
	}

	bc := ToBuilderConfig(cfg, catalog)

	if got := bc.SLM.Sampling.ReasoningEffort; got != "medium" {
		t.Errorf("fresh config with the sampling variant enabled resolves ReasoningEffort = %q, want the seeded default %q", got, "medium")
	}
}

// TestToBuilderConfig_ExperimentalGatesSLM verifies the experimental
// master switch forces the Small-LLM profile off regardless of the stored
// SLM.Enabled value, and restores it when experimental features are on.
func TestToBuilderConfig_ExperimentalGatesSLM(t *testing.T) {
	cfg := &config.Config{}
	cfg.SLM.Enabled = true

	// Experimental off (zero value) → the effective Small-LLM master is off.
	if bc := ToBuilderConfig(cfg, config.PredefinedSLMProfiles()); bc.SLM.Enabled {
		t.Error("experimental off should force SLM.Enabled false")
	}

	// Experimental on → the stored Small-LLM master flows through.
	cfg.Experimental.Enabled = true
	if bc := ToBuilderConfig(cfg, config.PredefinedSLMProfiles()); !bc.SLM.Enabled {
		t.Error("experimental on should preserve SLM.Enabled true")
	}
}

// TestToBuilderConfig_ProviderOutputTokenReserve verifies the per-provider
// output_token_reserve plumbing (D4): provider-level values flow into
// BuilderProviderConfig.
func TestToBuilderConfig_ProviderOutputTokenReserve(t *testing.T) {
	cfg := &config.Config{}
	cfg.LLM.Anthropic.OutputTokenReserve = 12288
	cfg.LLM.OpenAICompatible = map[string]config.OpenAICompatibleConfig{
		"lmstudio": {
			BaseURL:            "http://localhost:1234/v1",
			Models:             []string{"qwen/qwen3-coder-30b"},
			OutputTokenReserve: 8192,
		},
	}

	bc := ToBuilderConfig(cfg, config.PredefinedSLMProfiles())

	if got := bc.LLM.ProviderConfigs["anthropic"].OutputTokenReserve; got != 12288 {
		t.Errorf("anthropic OutputTokenReserve = %d, want 12288", got)
	}
	if got := bc.LLM.ProviderConfigs["lmstudio"].OutputTokenReserve; got != 8192 {
		t.Errorf("lmstudio OutputTokenReserve = %d, want 8192", got)
	}
	// Providers without an explicit reserve must map zero (inherit), not
	// accidentally inherit some other provider's value.
	cfg.LLM.OpenAICompatible["other"] = config.OpenAICompatibleConfig{Models: []string{"m"}}
	bc = ToBuilderConfig(cfg, config.PredefinedSLMProfiles())
	if got := bc.LLM.ProviderConfigs["other"].OutputTokenReserve; got != 0 {
		t.Errorf("other OutputTokenReserve = %d, want 0 (inherit)", got)
	}
}

// TestToBuilderConfig_WebFetchTimeouts verifies the config→builder mapping for
// the web fetch timeout/retry knobs: the proxy-path timeout and the retry
// count flow into BuilderTimeoutsConfig so both reach sp4rk's web_fetch tool
// (each retry doubles the effective client timeout).
func TestToBuilderConfig_WebFetchTimeouts(t *testing.T) {
	cfg := &config.Config{}
	config.ApplyDefaults(cfg)

	bc := ToBuilderConfig(cfg, config.PredefinedSLMProfiles())
	if got := bc.Timeouts.WebFetchTimeout; got != 30 {
		t.Errorf("WebFetchTimeout default = %d, want 30", got)
	}
	if got := bc.Timeouts.WebFetchProxyTimeout; got != 30 {
		t.Errorf("WebFetchProxyTimeout default = %d, want 30", got)
	}
	if got := bc.Timeouts.WebFetchRetries; got != 2 {
		t.Errorf("WebFetchRetries default = %d, want 2", got)
	}

	cfg.Timeouts.WebFetchProxyTimeout = 45
	cfg.Timeouts.WebFetchRetries = 3

	bc = ToBuilderConfig(cfg, config.PredefinedSLMProfiles())
	if got := bc.Timeouts.WebFetchProxyTimeout; got != 45 {
		t.Errorf("WebFetchProxyTimeout = %d, want 45", got)
	}
	if got := bc.Timeouts.WebFetchRetries; got != 3 {
		t.Errorf("WebFetchRetries = %d, want 3", got)
	}
}

// TestE2SConfigExperimentalGate pins the fail-closed gate for the E2S
// execution mode: core's BuilderE2SConfig.Enabled is exactly the experimental
// master switch (there is no separate e2s toggle), while the numeric knobs
// pass through regardless so tuning survives the gate.
func TestE2SConfigExperimentalGate(t *testing.T) {
	cfg := &config.Config{}
	config.ApplyDefaults(cfg)
	cfg.E2S.MaxSteps = 42

	// Fail-closed: the experimental gate off disables E2S.
	cfg.Experimental.Enabled = false
	if ToBuilderConfig(cfg, config.PredefinedSLMProfiles()).E2S.Enabled {
		t.Error("BuilderE2SConfig.Enabled must be false while the experimental gate is off")
	}

	// Gate on: E2S is available and the stored knobs pass through verbatim.
	cfg.Experimental.Enabled = true
	got := ToBuilderConfig(cfg, config.PredefinedSLMProfiles()).E2S
	if !got.Enabled {
		t.Error("BuilderE2SConfig.Enabled must follow the experimental gate")
	}
	if got.MaxSteps != 42 {
		t.Errorf("BuilderE2SConfig.MaxSteps = %d, want 42 (values pass through)", got.MaxSteps)
	}
}
