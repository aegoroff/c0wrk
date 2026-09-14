# ADR-043: Rename "Small LLM" / "SLM" to "Model Profiles"

## Status

Accepted → Partially supersedes [ADR-041](./041-slm-profiles.md) (the `SLM` nomenclature and the "Small LLM" user-facing tab label; the profile-catalog architecture itself stands unchanged)

## Context

The tuning-profile feature shipped as the "Small-LLM profile" (ADR-022), then moved to a named profile catalog carrying `SLM*`/`slm*` nomenclature and a "Small LLM" settings tab (ADR-041). Both names rest on the word "small": ADR-022 framed it as a profile for "small or local models", and the domain spec described running the Conductor against a "'small' (low-capacity / cheaper) LLM".

That framing is inaccurate for the feature's actual target. The predefined catalog is built for 10–35B models (Qwen3.8-27B, Qwen3.6-35B-A3B, Gemma-4-26B-A4B-it, Gemma-4-31B-it) — the class an operator runs locally or on a modest hosted tier — while "SLM" (small language model) is traditionally reserved in the field for sub-10B models. A user reading "Small LLM" therefore under- or mis-identifies their model, and the settings tab, config key and docs give no hint that a 27B or 31B model is the intended customer. The name also drifts as the catalog grows.

## Decision

Rename the feature to **Model Profiles** and apply the rename mechanically to every surface. "Model Profiles" needs no explanation — the profile is tuned for the model you run — and makes no size claim that can go stale as the catalog grows.

- **User-facing name.** The settings tab, its headings, tooltips, aria-labels, error/toast messages, `config.example.yaml` and the living specs all read "Model Profiles". The settings tab id becomes `model-profiles` (was `small-llm`).
- **Config.** `config.yaml` persists `model_profiles.enabled` + `model_profiles.active_profile` (was `slm.*`); the custom-profile store moves to `~/.c0wrk/model-profiles.yaml` (was `slm-profiles.yaml`).
- **Wire.** The `agent_metrics` payload's profile block key becomes `model_profiles`. The frontend metrics guard/normalizer accept the legacy `slm` and `small_llm` keys so rows persisted by earlier builds still validate and normalize.
- **Code.** Go types and functions become `ModelProfile*` / `ModelProfiles*` (`ModelProfile`, `ModelProfileConfig`, `ModelProfilesConfig`, `ResolveModelProfilesConfig`, `SetModelProfilesEnabled`, `ErrGoalBlockedByModelProfiles`, …); the package is `core/modelprofiles`; files are `model_profiles*.go`, `ModelProfiles*.tsx`, `modelProfilesTools.ts`, `modelProfilesGateStore.ts`. The six RPCs become `GetModelProfiles` / `CreateModelProfile` / `UpdateModelProfile` / `DeleteModelProfile` / `SelectModelProfile` / `SetModelProfilesEnabled` (Wails bindings regenerated).
- **Docs.** The domain spec is `specs/domains/model-profiles.md`; the evidence review is `docs/development/model-profiles-defaults-research.md`. Historical ADRs (022, 035, 041, 042) keep their original names and prose — they are records, not living docs.
- **Clean break, no value migration.** Consistent with ADR-041's treatment of the earlier `small_llm:` → `slm:` switch, a legacy `slm:` config section and an old `slm-profiles.yaml` are ignored (the YAML decoder is non-strict, and the store path simply changed), so custom profiles defined under the old store are not carried over and the active profile resolves to `generic`. The `experimental.enabled` gate and the one-way master-toggle reset (closing the gate persists `model_profiles.enabled = false`) are unchanged.

## Consequences

- Positive: the name matches the 10–35B target audience and survives catalog growth; a 27B/31B operator is no longer told their model is "small".
- Positive: every surface uses one term (Model Profiles / `model_profiles` / `ModelProfile`), removing the `SmallLLM*` → `slm*` → `small_llm*` drift ADR-041 complained about.
- Negative: a breaking config / store / wire rename — operators must re-create custom profiles and re-select their active profile; external consumers of `agent_metrics` that keyed on `slm` must switch to `model_profiles` (the frontend reads both).
- Negative: historical ADRs and CHANGELOG entries now use the old names; the discrepancy is intentional (records are immutable) and flagged in the ADR-041 and ADR-042 status lines.

## Alternatives Considered

- **"Local Models".** Clear for self-hosters, but the feature is defined by capacity, not location — a hosted 27B is equally in scope.
- **"Mid-Size Models".** Accurate, but an explicitly relative, size-anchored term that ages as soon as the catalog grows past its band.
- **"Efficiency Mode".** "Efficiency" is already claimed by inference optimizations (quantization, KV-cache) and mis-states the intent (countering model weakness, not saving compute).
- **Keep `SLM` / "Small LLM".** Rejected: it is the drift ADR-041 set out to end, and it mis-describes the target class.
- **Rename only the code identifiers, keep the user-facing "Small LLM" label.** Rejected: the label is the surface the user actually reads; a split name preserves exactly the confusion the rename exists to remove.
- **Migrate the old profile store into the new file.** Rejected for the same reason ADR-041 rejected value migration: interpreting a foreign file under a new format adds failure modes for a one-time convenience, and the experiment-gated feature's operators can re-create their profiles.
- **Rename historical ADR files/prose.** Rejected: ADRs are immutable records; renaming files would break inbound links and falsify history.
