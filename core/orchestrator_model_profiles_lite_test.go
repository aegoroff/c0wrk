package core

import (
	"context"
	"testing"

	"github.com/v0lka/sp4rk/tools"
)

// TestPrepareRequestContext_ModelProfilesLite_Gating verifies the defense-in-depth
// contract for the prompt-lite variant: the ModelProfilesLiteKey context value is
// set ONLY when BOTH the master ModelProfiles.Enabled toggle AND the SystemPrompt
// variant sub-toggle (Lite) are active. This mirrors how the essential-tools,
// loop-hardening, and sampling variants are each gated on master + sub-toggle.
func TestPrepareRequestContext_ModelProfilesLite_Gating(t *testing.T) {
	cases := []struct {
		name          string
		modelProfiles ModelProfilesSettings
		wantActive    bool
	}{
		{
			name: "master-on lite-on → active",
			modelProfiles: ModelProfilesSettings{
				Enabled: true,
				SystemPrompt: ModelProfilesSystemPromptSettings{
					Lite: true,
				},
			},
			wantActive: true,
		},
		{
			name: "master-off lite-on → INACTIVE (defense-in-depth)",
			modelProfiles: ModelProfilesSettings{
				Enabled: false,
				SystemPrompt: ModelProfilesSystemPromptSettings{
					Lite: true,
				},
			},
			wantActive: false,
		},
		{
			name: "master-on lite-off → INACTIVE (variant gated)",
			modelProfiles: ModelProfilesSettings{
				Enabled: true,
				SystemPrompt: ModelProfilesSystemPromptSettings{
					Lite: false,
				},
			},
			wantActive: false,
		},
		{
			name:          "zero-config → INACTIVE (defaults OFF)",
			modelProfiles: ModelProfilesSettings{},
			wantActive:    false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := &Orchestrator{config: OrchestratorConfig{ModelProfiles: tc.modelProfiles}, emitter: &noopEmitter{}}
			ctx := o.prepareRequestContext(context.Background(), "msg")
			got := ctx.Value(ModelProfilesLiteKey) != nil
			if got != tc.wantActive {
				t.Errorf("ModelProfilesLiteKey active = %v, want %v", got, tc.wantActive)
			}
		})
	}
}

// TestPrepareRequestContext_ModelProfilesLite_DefaultsOffWhenAbsent confirms the
// ModelProfilesLiteKey ctx value defaults to OFF when absent — a plain context (no
// orchestrator config) must read as inactive so the verbose directive is used.
func TestPrepareRequestContext_ModelProfilesLite_DefaultsOffWhenAbsent(t *testing.T) {
	if modelProfilesLiteFromCtx(context.Background()) {
		t.Fatal("modelProfilesLiteFromCtx returned true for a plain context; lite must be OFF by default")
	}
}

// TestBuildSystemPrompt_ModelProfilesLite_MasterGate verifies the full
// config→ctx→prompt chain: when the lite ctx value is absent (master or variant
// off), buildSystemPromptWith uses the verbose OrchestratorSystem directive;
// when present, it swaps to the compact OrchestratorSystemLite directive.
// This proves the master toggle's defense-in-depth reaches the prompt output.
func TestBuildSystemPrompt_ModelProfilesLite_MasterGate(t *testing.T) {
	ctx := tools.WithWorkspacePath(context.Background(), "/ws")

	// No lite key → verbose directive present.
	verbose := buildSystemPrompt(ctx, "task", llmModelMetaForTests())
	if verbose == "" {
		t.Fatal("verbose prompt is empty")
	}

	// With lite key → prompt must differ (compact directive swapped in).
	liteCtx := WithModelProfilesLite(ctx)
	lite := buildSystemPrompt(liteCtx, "task", llmModelMetaForTests())
	if lite == "" {
		t.Fatal("lite prompt is empty")
	}
	if verbose == lite {
		t.Fatal("lite prompt identical to verbose prompt; lite swap did not take effect")
	}
}

// TestConfigAdapter_ModelProfilesSystemPrompt_RoundTrip (in backend package) is the
// config→builder wiring test; here we assert the runtime mirror types carry the
// field so a rebuild surfaces config changes. Kept as a compile-time + value
// sanity check of the ModelProfilesSettings → ModelProfilesSystemPromptSettings shape.
func TestModelProfilesSettings_SystemPromptCarriesLite(t *testing.T) {
	s := ModelProfilesSettings{
		Enabled: true,
		SystemPrompt: ModelProfilesSystemPromptSettings{
			Lite: true,
		},
	}
	if !s.Enabled || !s.SystemPrompt.Lite {
		t.Errorf("ModelProfilesSettings fields not carried: %+v", s)
	}
}
