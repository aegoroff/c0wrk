package config

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// Named SLM profiles: fixed presets over the 25 small-LLM variant knobs.
//
// A profile carries the complete value set of the five small-LLM variants
// (essential_tools, system_prompt, sampling, loop_hardening, context) but
// NOT the master `small_llm.enabled` toggle — that switch stays in
// config.yaml outside any profile, so selecting a profile can never
// silently flip the whole mode on or off (docs/development/slm-defaults-research.md,
// verdict #1 and the 2026-09-13 addendum).
//
// The predefined catalog values come from the completed four-model study
// (Qwen3.8-27B, Qwen3.6-35B-A3B, Gemma-4-26B-A4B-it, Gemma-4-31B-it) and
// the model-agnostic research addendum; see the per-entry comments below.

// SLMProfileKind distinguishes the hard-coded predefined profiles from
// operator-authored custom ones. The kind is metadata: it drives UI
// affordances (predefined entries are read-only, customs are editable) and
// persistence routing, never value semantics.
type SLMProfileKind string

const (
	// SLMProfileKindPredefined marks the fixed catalog compiled into the binary.
	SLMProfileKindPredefined SLMProfileKind = "predefined"
	// SLMProfileKindCustom marks operator-authored profiles stored outside config.yaml.
	SLMProfileKindCustom SLMProfileKind = "custom"
)

// SLMGenericProfileID is the id of the model-agnostic "generic" profile —
// the default active profile and the soft fallback when the configured
// active profile id no longer resolves.
const SLMGenericProfileID = "generic"

// SLMProfileConfig carries the 25 knob values of the five small-LLM
// variants: essential_tools (3), system_prompt (3), sampling (7),
// loop_hardening (6), context (6). It is SLMConfig minus the master
// Enabled toggle. Every knob carries a concrete value regardless of its
// variant gate, so flipping a gate on never requires re-editing the
// profile; gate state controls application, not value presence.
type SLMProfileConfig struct {
	EssentialTools EssentialToolsConfig `yaml:"essential_tools"`
	SystemPrompt   SystemPromptConfig   `yaml:"system_prompt"`
	Sampling       SLMSamplingConfig    `yaml:"sampling"`
	LoopHardening  LoopHardeningConfig  `yaml:"loop_hardening"`
	Context        SLMContextConfig     `yaml:"context"`
}

// SLMProfile is one named, validated small-LLM preset.
type SLMProfile struct {
	// ID is the stable slug identifying the profile (e.g. "qwen3.8-27b").
	ID string `yaml:"id"`
	// Name is the human-readable display name shown in the UI.
	Name string `yaml:"name"`
	// Kind distinguishes predefined catalog entries from custom ones.
	Kind SLMProfileKind `yaml:"kind"`
	// Config holds the 25 variant knob values.
	Config SLMProfileConfig `yaml:"config"`
}

// slmProfileIDPattern constrains profile ids to lowercase slugs built of
// [a-z0-9] segments joined by '.' or '-' (model-shaped ids such as
// "qwen3.8-27b", "gemma-4-26b-a4b-it", or the bare "generic").
var slmProfileIDPattern = regexp.MustCompile(`^[a-z0-9]+(?:[.-][a-z0-9]+)*$`)

// validSLMProfileReasoningEfforts mirrors backend.validSLMReasoningEfforts:
// empty means "inherit the model default" (seeded to "medium" by
// ApplyDefaults when the sampling variant is active) and is always allowed.
var validSLMProfileReasoningEfforts = map[string]struct{}{
	"":       {},
	"off":    {},
	"low":    {},
	"medium": {},
}

// NewSLMProfile is the single constructor-validator for SLMProfile: it
// validates the id slug, the display name, the kind, and every knob value
// (via ValidateSLMProfileConfig), then returns the profile with its
// always_present list defensively cloned. All predefined-catalog and
// custom-profile construction must go through it so no unvalidated profile
// can exist.
func NewSLMProfile(id, name string, kind SLMProfileKind, cfg SLMProfileConfig) (SLMProfile, error) {
	id = strings.TrimSpace(id)
	if !slmProfileIDPattern.MatchString(id) {
		return SLMProfile{}, fmt.Errorf("slm profile id %q is invalid: must be a lowercase slug of [a-z0-9] segments joined by '.' or '-'", id)
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return SLMProfile{}, errors.New("slm profile name must not be empty")
	}
	switch kind {
	case SLMProfileKindPredefined, SLMProfileKindCustom:
	default:
		return SLMProfile{}, fmt.Errorf("slm profile kind %q is invalid (allowed: %q, %q)", kind, SLMProfileKindPredefined, SLMProfileKindCustom)
	}
	if err := ValidateSLMProfileConfig(cfg); err != nil {
		return SLMProfile{}, fmt.Errorf("slm profile %q: %w", id, err)
	}
	return SLMProfile{ID: id, Name: name, Kind: kind, Config: cloneSLMProfileConfig(cfg)}, nil
}

// ValidateSLMProfileConfig is the pure value validator for the 25 profile
// knobs. It mirrors the platform validation semantics of the inline
// small_llm.* config (backend.validateSLMConfig): every sampling parameter
// uses 0 as the "inherit the vendor preset" sentinel and is range-checked
// regardless of whether its variant is enabled, so a stored out-of-range
// value cannot go live the moment a toggle flips on; loop-hardening and
// context values must be non-negative always and fall under tighter
// positive/window constraints when their variant is enabled. It is reused
// for custom profiles.
func ValidateSLMProfileConfig(cfg SLMProfileConfig) error {
	// Essential tools: always_present may be empty — protected orchestration
	// tools (finish, fact memory, ask_user) and every MCP tool are always
	// kept implicitly; no tool-count budget exists (ADR-035).

	// Sampling.
	s := cfg.Sampling
	if s.Temperature < 0 {
		return fmt.Errorf("small_llm.sampling.temperature must be > 0 when set, got %v (0 inherits the vendor preset)", s.Temperature)
	}
	if s.TopP < 0 || s.TopP > 1 {
		return fmt.Errorf("small_llm.sampling.top_p must be in the range (0, 1] when set, got %v (0 inherits the vendor preset)", s.TopP)
	}
	if s.TopK < 0 {
		return fmt.Errorf("small_llm.sampling.top_k must be >= 1 when set, got %d (0 inherits the vendor preset)", s.TopK)
	}
	if rp := s.RepetitionPenalty; rp != 0 && (rp < 1 || rp > 2) {
		return fmt.Errorf("small_llm.sampling.repetition_penalty must be in the range [1, 2] when set, got %v (0 inherits the vendor preset)", rp)
	}
	// Qwen card: presence_penalty 0–2 is the sanctioned anti-repetition
	// lever (instruct default 1.5); values above 2 increase language mixing.
	if pp := s.PresencePenalty; pp != 0 && (pp < 0 || pp > 2) {
		return fmt.Errorf("small_llm.sampling.presence_penalty must be in the range [0, 2] when set, got %v (0 inherits the vendor preset)", pp)
	}
	if _, ok := validSLMProfileReasoningEfforts[s.ReasoningEffort]; !ok {
		return fmt.Errorf("small_llm.sampling.reasoning_effort %q is invalid (allowed: off, low, medium; empty inherits the model default)", s.ReasoningEffort)
	}

	// Loop hardening.
	lh := cfg.LoopHardening
	thresholds := []int{
		lh.RepeatNudgeThreshold,
		lh.ParseErrorAbortThreshold,
		lh.FruitlessNudgeThreshold,
		lh.FruitlessAbortThreshold,
		lh.SameToolRepeatNudgeThreshold,
	}
	for _, threshold := range thresholds {
		if threshold < 0 {
			return errors.New("small_llm.loop_hardening thresholds must be non-negative")
		}
	}
	if lh.Enabled {
		for _, threshold := range thresholds {
			if threshold < 1 {
				return errors.New("small_llm.loop_hardening thresholds must be positive when loop_hardening is enabled")
			}
		}
	}

	// Context management.
	ctx := cfg.Context
	contextInts := []int{
		ctx.Compaction.KeepLast,
		ctx.Compaction.BlockSize,
		ctx.Compaction.TriggerPercent,
		ctx.ToolOutputKeepLastN,
		ctx.OutputTokenReserve,
	}
	for _, v := range contextInts {
		if v < 0 {
			return errors.New("small_llm.context values must be non-negative")
		}
	}
	if ctx.Enabled {
		if ctx.Compaction.KeepLast < 2 {
			return fmt.Errorf("small_llm.context.compaction.keep_last must be >= 2 when context is enabled, got %d", ctx.Compaction.KeepLast)
		}
		if ctx.Compaction.BlockSize < 2 {
			return fmt.Errorf("small_llm.context.compaction.block_size must be >= 2 when context is enabled, got %d", ctx.Compaction.BlockSize)
		}
		if ctx.Compaction.TriggerPercent < 1 || ctx.Compaction.TriggerPercent >= 100 {
			return fmt.Errorf("small_llm.context.compaction.trigger_percent must be in [1, 100) when context is enabled, got %d", ctx.Compaction.TriggerPercent)
		}
		if ctx.ToolOutputKeepLastN < 1 {
			return fmt.Errorf("small_llm.context.tool_output_keep_last_n must be >= 1 when context is enabled, got %d", ctx.ToolOutputKeepLastN)
		}
		if ctx.OutputTokenReserve < 1 {
			return fmt.Errorf("small_llm.context.output_token_reserve must be >= 1 when context is enabled, got %d", ctx.OutputTokenReserve)
		}
	}

	return nil
}

// ValidateSLMProfilesUnique rejects a profile list that reuses an id or a
// display name. It is the invariant of the predefined catalog and, once
// custom profiles merge into the same namespace, of the combined list.
func ValidateSLMProfilesUnique(profiles []SLMProfile) error {
	seenIDs := make(map[string]struct{}, len(profiles))
	seenNames := make(map[string]struct{}, len(profiles))
	for _, p := range profiles {
		if _, dup := seenIDs[p.ID]; dup {
			return fmt.Errorf("duplicate slm profile id %q", p.ID)
		}
		seenIDs[p.ID] = struct{}{}
		if _, dup := seenNames[p.Name]; dup {
			return fmt.Errorf("duplicate slm profile name %q", p.Name)
		}
		seenNames[p.Name] = struct{}{}
	}
	return nil
}

// predefinedSLMProfiles is the fixed five-entry catalog. It is built
// through NewSLMProfile + ValidateSLMProfilesUnique at package init, so an
// invalid entry fails loudly at startup (programmer error) instead of
// shipping a half-valid preset.
var predefinedSLMProfiles = mustBuildPredefinedSLMProfiles()

// PredefinedSLMProfiles returns the hard-coded predefined catalog: four
// model-specific profiles (values from the four-model study) plus the
// model-agnostic "generic" maximum-support preset (values from the
// research addendum). The returned slice is a defensive copy.
func PredefinedSLMProfiles() []SLMProfile {
	out := make([]SLMProfile, len(predefinedSLMProfiles))
	for i, p := range predefinedSLMProfiles {
		out[i] = cloneSLMProfile(p)
	}
	return out
}

// FindPredefinedSLMProfile resolves a predefined profile by id. The
// returned profile is a defensive copy.
func FindPredefinedSLMProfile(id string) (SLMProfile, bool) {
	for _, p := range predefinedSLMProfiles {
		if p.ID == id {
			return cloneSLMProfile(p), true
		}
	}
	return SLMProfile{}, false
}

func mustBuildPredefinedSLMProfiles() []SLMProfile {
	profiles, err := buildPredefinedSLMProfiles()
	if err != nil {
		panic(fmt.Sprintf("backend/config: invalid predefined SLM profile catalog: %v", err))
	}
	return profiles
}

func buildPredefinedSLMProfiles() ([]SLMProfile, error) {
	// Shared value sets (docs/development/slm-defaults-research.md + four-model study):
	// every profile hardens the same loop-breaker shape 2/3/3/5/4, and every
	// profile exposes the built-in default always-present tool list.
	tools := func(enabled, compact bool) EssentialToolsConfig {
		return EssentialToolsConfig{
			Enabled:             enabled,
			AlwaysPresent:       slices.Clone(defaultSLMAlwaysPresent),
			CompactDescriptions: compact,
		}
	}
	loopHardening := LoopHardeningConfig{
		Enabled:                      true,
		RepeatNudgeThreshold:         2,
		ParseErrorAbortThreshold:     3,
		FruitlessNudgeThreshold:      3,
		FruitlessAbortThreshold:      5,
		SameToolRepeatNudgeThreshold: 4,
	}
	// Tight context window for the weaker profiles (study: 6/5/80/2).
	contextTight := SLMContextConfig{
		Enabled:             true,
		Compaction:          SLMCompactionConfig{KeepLast: 6, BlockSize: 5, TriggerPercent: 80},
		ToolOutputKeepLastN: 2,
		OutputTokenReserve:  16384,
	}

	defs := []struct {
		id   string
		name string
		cfg  SLMProfileConfig
	}{
		{
			// Minimal: a harness-post-trained agentic executor — only loop
			// hardening and the reasoning-effort trim pay for themselves.
			// Sampling numerics inherit the sp4rk qwen preset, which already
			// equals the official thinking recipe 1.0/0.95/20. Context
			// management stays off (262K window); its knobs are seeded to
			// the model-appropriate near-baseline set for a later flip.
			id:   "qwen3.8-27b",
			name: "Qwen3.8-27B (minimal)",
			cfg: SLMProfileConfig{
				EssentialTools: tools(false, false),
				Sampling: SLMSamplingConfig{
					Enabled:         true,
					ReasoningEffort: "medium", // native level vs the xhigh default: 60–90% fewer thinking tokens
				},
				LoopHardening: loopHardening,
				Context: SLMContextConfig{
					Compaction:          SLMCompactionConfig{KeepLast: 8, BlockSize: 5, TriggerPercent: 85},
					ToolOutputKeepLastN: 3,
					OutputTokenReserve:  16384,
				},
			},
		},
		{
			// Medium: a 3B-active MoE — tool narrowing, lite prompt, and
			// tight context all pay; sampling mostly inherits the qwen
			// preset (general thinking recipe), with the card's sanctioned
			// presence_penalty seeded for the general agent regime.
			id:   "qwen3.6-35b-a3b",
			name: "Qwen3.6-35B-A3B (medium)",
			cfg: SLMProfileConfig{
				EssentialTools: tools(true, true),
				SystemPrompt:   SystemPromptConfig{Lite: true},
				Sampling: SLMSamplingConfig{
					Enabled:         true,
					PresencePenalty: 1.5,      // general agent recipe (precise coding would want 0.6/0.0 instead)
					ReasoningEffort: "medium", // pre-3.8 binary mapping: thinking ON (no native level exists)
				},
				LoopHardening: loopHardening,
				Context:       contextTight,
			},
		},
		{
			// Maximal: the weakest agentic performer of the study — every
			// validated support variant on. The google preset ships only
			// temperature, so top_p/top_k must be seeded explicitly (Gemma's
			// top_k standard is 64, not Qwen's 20); reasoning_effort stays
			// unset because sp4rk has no google reasoning branch (no-op).
			id:   "gemma-4-26b-a4b-it",
			name: "Gemma-4-26B-A4B-it (maximal)",
			cfg: SLMProfileConfig{
				EssentialTools: tools(true, true),
				SystemPrompt:   SystemPromptConfig{Lite: true},
				Sampling: SLMSamplingConfig{
					Enabled: true,
					TopP:    0.95,
					TopK:    64,
				},
				LoopHardening: loopHardening,
				Context:       contextTight,
			},
		},
		{
			// Moderate: a dense 31B that handles the full prompt and tool
			// schemas — tool narrowing on (compaction of descriptions off),
			// full system prompt, near-baseline context window. Same explicit
			// Gemma sampling values as its 26B sibling.
			id:   "gemma-4-31b-it",
			name: "Gemma-4-31B-it (moderate)",
			cfg: SLMProfileConfig{
				EssentialTools: tools(true, false),
				Sampling: SLMSamplingConfig{
					Enabled: true,
					TopP:    0.95,
					TopK:    64,
				},
				LoopHardening: loopHardening,
				Context: SLMContextConfig{
					Enabled:             true,
					Compaction:          SLMCompactionConfig{KeepLast: 8, BlockSize: 5, TriggerPercent: 85},
					ToolOutputKeepLastN: 3,
					OutputTokenReserve:  16384,
				},
			},
		},
		{
			// Generic: model-agnostic maximum support (research addendum).
			// All five variants on, but the two unmeasured prompt-content
			// additions (few_shot, reasoning_scaffold) stay off. Sampling is
			// inherit-by-default — no seeded constant is right for the whole
			// class (top_k alone: 20 qwen vs 64 gemma) — with reasoning_effort
			// "medium" as the single safe seeded value (native for Qwen3.8+,
			// thinking-ON under Qwen3.6's binary mapping, harmless no-op for
			// Gemma).
			id:   SLMGenericProfileID,
			name: "Generic (model-agnostic)",
			cfg: SLMProfileConfig{
				EssentialTools: tools(true, true),
				SystemPrompt:   SystemPromptConfig{Lite: true},
				Sampling: SLMSamplingConfig{
					Enabled:         true,
					ReasoningEffort: "medium",
				},
				LoopHardening: loopHardening,
				Context:       contextTight,
			},
		},
	}

	profiles := make([]SLMProfile, 0, len(defs))
	for _, def := range defs {
		p, err := NewSLMProfile(def.id, def.name, SLMProfileKindPredefined, def.cfg)
		if err != nil {
			return nil, fmt.Errorf("predefined catalog entry %q: %w", def.id, err)
		}
		profiles = append(profiles, p)
	}
	if err := ValidateSLMProfilesUnique(profiles); err != nil {
		return nil, fmt.Errorf("predefined catalog: %w", err)
	}
	return profiles, nil
}

func cloneSLMProfile(p SLMProfile) SLMProfile {
	p.Config = cloneSLMProfileConfig(p.Config)
	return p
}

func cloneSLMProfileConfig(cfg SLMProfileConfig) SLMProfileConfig {
	cfg.EssentialTools.AlwaysPresent = slices.Clone(cfg.EssentialTools.AlwaysPresent)
	return cfg
}
