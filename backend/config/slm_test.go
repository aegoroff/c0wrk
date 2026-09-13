package config

import (
	"slices"
	"testing"

	"github.com/v0lka/c0wrk/core/slm"
)

// TestSLMDefaultAlwaysPresentUnionProtected pins the invariant that the
// shipped default always-present list ∪ the protected ReAct-mandatory tools
// (finish, store_fact, search_facts, ask_user, update_checklist,
// read_attachment, read_skill_resource, tool_result_read; all 8 are also
// pinned by default) is exactly the guaranteed core. The static selection
// (slm.SelectTools) serves exactly this union — the user's pins, the
// protected tools, and every MCP tool — with no slot budget. bash_exec and
// posh_exec are platform alternatives (only one is registered per host), so
// the list carries 17 names while the effective per-host set is 16.
func TestSLMDefaultAlwaysPresentUnionProtected(t *testing.T) {
	guaranteed := make(map[string]struct{}, 20)
	for _, n := range defaultSLMAlwaysPresent {
		guaranteed[n] = struct{}{}
	}
	for _, n := range slm.ProtectedToolNames() {
		guaranteed[n] = struct{}{}
	}
	const wantGuaranteed = 17
	if len(guaranteed) != wantGuaranteed {
		names := make([]string, 0, len(guaranteed))
		for n := range guaranteed {
			names = append(names, n)
		}
		slices.Sort(names)
		t.Fatalf("expected %d unique guaranteed tools from the defaults, got %d: %v",
			wantGuaranteed, len(guaranteed), names)
	}
}

// TestSLMPersistDefaultsSeeded verifies the slim persisted section's
// defaults: the master toggle stays off (manual only) and the active profile
// seeds to the model-agnostic "generic" id, so a config without an slm:
// section resolves cleanly with no fallback warning.
func TestSLMPersistDefaultsSeeded(t *testing.T) {
	cfg := &Config{}
	ApplyDefaults(cfg)

	if cfg.SLM.Enabled {
		t.Error("slm.enabled must default to false (manual only)")
	}
	if got := cfg.SLM.ActiveProfile; got != SLMGenericProfileID {
		t.Errorf("slm.active_profile default = %q, want %q", got, SLMGenericProfileID)
	}
}

// TestResolveSLMConfig_GenericProfileDefaults verifies the effective defaults
// a fresh config resolves to through the generic profile — the researched
// variant values that used to be seeded by ApplyDefaults (reasoning_effort
// "medium", loop thresholds 2/3/3/5/4, context 6/5/80/2/16384, the default
// always-present list) now live in the catalog and must still arrive intact.
// The context variant defaults are tighter than the general executor
// baselines (10 / 7 / 85 / 3); the reserve is deliberately LARGER than the
// general 8192 (see defaults.go history / docs/development/slm-defaults-research.md).
func TestResolveSLMConfig_GenericProfileDefaults(t *testing.T) {
	cfg := &Config{}
	ApplyDefaults(cfg)

	resolved, warnings := ResolveSLMConfig(cfg.SLM, PredefinedSLMProfiles())

	if len(warnings) != 0 {
		t.Errorf("fresh config must resolve without warnings, got %v", warnings)
	}
	if resolved.Sampling.ReasoningEffort != "medium" {
		t.Errorf("resolved sampling.reasoning_effort = %q, want the seeded default %q (docs/development/slm-defaults-research.md, R3)", resolved.Sampling.ReasoningEffort, "medium")
	}
	if got := resolved.LoopHardening; got.RepeatNudgeThreshold != 2 || got.ParseErrorAbortThreshold != 3 ||
		got.FruitlessNudgeThreshold != 3 || got.FruitlessAbortThreshold != 5 || got.SameToolRepeatNudgeThreshold != 4 {
		t.Errorf("resolved loop_hardening thresholds = %+v, want 2/3/3/5/4", got)
	}
	ctx := resolved.Context
	if ctx.Compaction.KeepLast != 6 || ctx.Compaction.BlockSize != 5 || ctx.Compaction.TriggerPercent != 80 ||
		ctx.ToolOutputKeepLastN != 2 || ctx.OutputTokenReserve != 16384 {
		t.Errorf("resolved context values = %+v, want 6/5/80/2/16384", ctx)
	}
	if !slices.Equal(resolved.EssentialTools.AlwaysPresent, defaultSLMAlwaysPresent) {
		t.Errorf("resolved always_present = %v, want the shipped default list", resolved.EssentialTools.AlwaysPresent)
	}
}

// TestResolveSLMConfig_ProfileLookup verifies the resolver's three
// resolution paths against a catalog of predefined ∪ custom entries:
// a predefined id returns that profile's values, a custom id returns the
// custom values (explicit values preserved verbatim — the former
// "explicit value wins over the seed" guard), and the master Enabled flag is
// carried over from the persist section untouched.
func TestResolveSLMConfig_ProfileLookup(t *testing.T) {
	customCfg := SLMProfileConfig{}
	customCfg.Context.OutputTokenReserve = 8192 // explicit value must survive resolution
	customCfg.Sampling.PresencePenalty = 1.5
	custom, err := NewSLMProfile("my-tuned", "My Tuned", SLMProfileKindCustom, customCfg)
	if err != nil {
		t.Fatalf("NewSLMProfile: %v", err)
	}
	catalog := append(PredefinedSLMProfiles(), custom)

	// Predefined id → that profile's values.
	predefined, warnings := ResolveSLMConfig(SLMPersistConfig{Enabled: true, ActiveProfile: "qwen3.8-27b"}, catalog)
	if len(warnings) != 0 {
		t.Errorf("predefined id must resolve without warnings, got %v", warnings)
	}
	if !predefined.Enabled {
		t.Error("master Enabled must carry over from the persist section")
	}
	want, _ := FindPredefinedSLMProfile("qwen3.8-27b")
	if !slices.Equal(predefined.EssentialTools.AlwaysPresent, want.Config.EssentialTools.AlwaysPresent) {
		t.Error("predefined profile values did not flow into the resolved config")
	}

	// Custom id → the custom profile's values.
	resolved, warnings := ResolveSLMConfig(SLMPersistConfig{ActiveProfile: "my-tuned"}, catalog)
	if len(warnings) != 0 {
		t.Errorf("custom id must resolve without warnings, got %v", warnings)
	}
	if got := resolved.Context.OutputTokenReserve; got != 8192 {
		t.Errorf("explicit custom output_token_reserve = %d, want the preserved 8192", got)
	}
	if got := resolved.Sampling.PresencePenalty; got != 1.5 {
		t.Errorf("custom presence_penalty = %v, want 1.5", got)
	}
}

// TestResolveSLMConfig_FallbackToGeneric verifies the soft fallback: an
// empty or unknown active_profile id resolves to the generic profile and
// yields exactly one warning each — a stale id (e.g. a custom profile
// deleted by hand) must never break the run.
func TestResolveSLMConfig_FallbackToGeneric(t *testing.T) {
	generic, _ := FindPredefinedSLMProfile(SLMGenericProfileID)

	for _, tc := range []struct {
		name string
		id   string
	}{
		{name: "unknown id", id: "deleted-externally"},
		{name: "empty id", id: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resolved, warnings := ResolveSLMConfig(SLMPersistConfig{ActiveProfile: tc.id}, PredefinedSLMProfiles())
			if len(warnings) != 1 {
				t.Fatalf("warnings = %v, want exactly one fallback warning", warnings)
			}
			if resolved.Context.OutputTokenReserve != generic.Config.Context.OutputTokenReserve {
				t.Errorf("fallback did not resolve to the generic profile values: %+v", resolved.Context)
			}
		})
	}
}
