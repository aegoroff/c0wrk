# SLM Profiles

> Historical name: "Small-LLM profile" (kept in [ADR-022](../decisions/022-small-llm-profile.md), [ADR-035](../decisions/035-remove-small-llm-tool-budget.md), and the settings tab label "Small LLM"). Code, config keys, RPCs, and files use the `slm` / `SLM` nomenclature.

## Purpose

SLM profiles are the tuning mechanism for running the Conductor against a "small" (low-capacity / cheaper) LLM. A **profile** is a named set of 25 variant knobs across five sections — tool-set narrowing (`essential_tools`), system-prompt Lite swap (`system_prompt`), sampling override (`sampling`), loop hardening (`loop_hardening`), and context-management overrides (`context`). Exactly two durable choices live in `config.yaml`: the MANUAL-ONLY master toggle (`slm.enabled`, no auto-detection — normally flipped from the settings UI via `SetSLMEnabled`, which persists it here) and the active profile id (`slm.active_profile`). The knob values themselves come from a **catalog** — five read-only **predefined** profiles compiled into the app plus operator-authored **custom** profiles persisted to `~/.c0wrk/slm-profiles.yaml` — resolved at load into the effective runtime configuration. See [ADR-041](../decisions/041-slm-profiles.md).

## Key Files

- `backend/config/slm_profiles.go` — `SLMProfile` (`{id, name, kind, config}`), `SLMProfileKind` (`predefined` | `custom`), `SLMProfileConfig` (the 25 knobs, no master toggle), the constructor-validator `NewSLMProfile`, pure value validation `ValidateSLMProfileConfig`, `ValidateSLMProfilesUnique`, `PredefinedSLMProfiles` / `FindPredefinedSLMProfile`, `SLMGenericProfileID = "generic"`
- `backend/config/slm_profiles_store.go` — the custom-profile store over `~/.c0wrk/slm-profiles.yaml` (format version 1): `LoadCustomSLMProfiles` (fail-soft), `SaveCustomSLMProfiles` (fail-closed, atomic rewrite), `CreateCustomSLMProfile` (slug-id generation with dedup), `DeleteCustomSLMProfile`
- `backend/config/paths.go` — `SLMProfilesPath(agentDir)` → `<agentDir>/slm-profiles.yaml` (the only path constructor for the store)
- `backend/config/config.go` — `SLMPersistConfig` (the two persisted `slm:` fields), runtime `SLMConfig` + sub-configs (`EssentialToolsConfig`, `SystemPromptConfig`, `SLMSamplingConfig`, `LoopHardeningConfig`, `SLMContextConfig`), the resolver `ResolveSLMConfig`, `LoadSLMCatalog` (predefined ∪ custom), `FindSLMProfile`
- `backend/config/defaults.go` — `defaultSLMAlwaysPresent` (the 17-tool default pin list shared by every predefined profile); `ApplyDefaults` seeds `slm.active_profile = "generic"` (the 25 knobs are no longer seeded here — their defaults live in the predefined catalog)
- `backend/configadapter.go` — `ToBuilderConfig(cfg, slmCatalog)` (core never imports `backend/config`), `effectiveSLMConfig` (applies the experimental gate), `activeSLMProfile` (identity for metrics, generic fallback)
- `core/builderconfig.go` — `BuilderSLMConfig` + sub-structs (the core-layer mirror)
- `core/builder.go` — `applySLMPresets` (seeds the builder-level reasoning-effort default from the profile's explicit value), `applyLoopHardening` (overrides circuit-breaker thresholds), `applyContextManagement` (overrides compaction/pruning/reserve on the executor config), `resolveSamplingFunc` (overrides router sampling)
- `core/slm/tools_filter.go` — pure, deterministic `SelectTools` (with turn-scoped `extraGuaranteed` names) + `ProtectedToolNames` (static tool-set assembly)
- `core/slm/tool_groups.go` — `ToolGroupCatalog`: the static workflow clusters (plan / subagents) the always-present picker offers atomically
- `core/orchestrator.go` — `SLM SLMSettings` mirror on `OrchestratorConfig`; `applySLMToolFilter` (the single call site in `HandleMessage`) + `slmAgentGuaranteedTools` (turn-scoped delegate guarantee) + `slmEssentialToolsEnabled` (the goal-block predicate: master toggle AND essential-tools variant)
- `core/orchestrator_handle.go` — `prepareRequestContext` carries the SystemPrompt sub-toggle flags into context (`withSLMPromptProfile`)
- `core/systemprompt.go` — `buildSystemPromptWith` swaps the core directive for its Lite counterpart and appends the scaffold / few-shot blocks under the context flags (`slmPromptProfileFromCtx`); `systemPromptSpec.allowLiteVariants` / `liteCoreDirective` + `buildSpecializedSystemPromptWithLite` extend the same swap to the goal derivation and verification agents (subagent-profile specialized runs never opt in)
- `core/prompts/orchestrator_lite.md` — compact core directive (the Lite swap)
- `core/prompts/orchestrator_lite_scaffold.md` — three-step reasoning scaffold
- `core/prompts/orchestrator_lite_fewshot.md` — curated worked-example ReAct cycles
- `core/prompts/goal_derivation_lite.md` — compact Lite counterpart of the goal derivation directive (no placeholders; selected in `deriveGoal` via `buildSpecializedSystemPromptWithLite(..., prompts.GoalDerivation, prompts.GoalDerivationLite)`)
- `core/prompts/goal_verification_lite.md` / `goal_rederivation_lite.md` — compact Lite counterparts of the verification / re-derivation directives (the same `GoalVerificationSubstitute` placeholder set, selected by `GoalVerificationLiteDirectiveByMode`)
- `core/orchestrator_goal.go` — `ErrGoalBlockedBySLM`, the sentinel returned for a fresh goal (via `HandleMessage`'s goal branch, in `core/orchestrator.go`) or a resumed goal (at `resumeGoalLoop` entry) while the Small-LLM essential-tools narrowing is active (defense-in-depth behind the frontend rejection); `deriveGoal` / `defaultGoalVerifier` render the Lite goal directives via `buildSpecializedSystemPromptWithLite`
- `backend/frontend_api_config.go` — the SLM RPC surface (`GetSLMProfiles` / `CreateSLMProfile` / `UpdateSLMProfile` / `DeleteSLMProfile` / `SelectSLMProfile` plus the master-toggle `SetSLMEnabled`) + the suggestion matcher (`normalizeSLMModelToken` / `suggestSLMProfileID`) + `slmGoalBlocked()` (the effective `Enabled && EssentialTools.Enabled` gate) + the `ConfigResponse.slm` block (`SLMSettingsResponse`)
- `backend/frontend_api_session.go` — `SendMessage` / `ResumeTask` / `ResumeSession` refuse a goal (explicit flag OR `/goal` prefix) and a paused-goal resume while `slmGoalBlocked()`; `goalResumeBlockedBySLM` reads the session's unfinished task + goal state to decide
- `backend/session/agent_metrics.go`, `backend/session/manager.go`, `backend/session/emitter.go` — `SetSLMProfile` threads the active profile's identity into every session's `agent_metrics` payload
- `frontend/src/components/settings/SLMSettings.tsx` / `SLMProfileSelector.tsx` / `SLMProfileDialog.tsx` / `SLMControls.tsx` / `SLMSections.tsx` / `SLMContextSection.tsx` — settings UI (the `slm.enabled` master toggle + profile block + values editor)
- `frontend/src/lib/slmTools.ts` — `essentialToolPickerOptions` (always-present picker universe: clusters + ungrouped tools) plus the display-only markdown formatters `toolDescriptionMarkdown` / `toolGroupTooltipMarkdown`
- `frontend/src/api/config.ts` — typed wrappers for the six SLM RPCs (five profile-scoped + the master toggle)
- `frontend/src/stores/slmGateStore.ts` + `frontend/src/lib/goalGate.ts` + `frontend/src/hooks/useSLMGate.ts` — the frontend goal-gate mirror: a `{enabled, essentialToolsEnabled, loaded}` store latched from `GetConfig`, the single `isGoalBlockedBySLM()` composition (`loaded && enabled && essentialToolsEnabled`), and the one-shot fetch hook (retried on `backend:ready` / `config:updated`, fail-safe while unloaded)

## Core Types

```go
// What config.yaml persists — exactly two fields (backend/config/config.go).
type SLMPersistConfig struct {
    Enabled       bool   `yaml:"enabled"`        // manual-only master toggle
    ActiveProfile string `yaml:"active_profile"` // catalog id; ApplyDefaults seeds "generic"
}

// One catalog entry. Kind is predefined (compiled in, read-only) or custom
// (stored in ~/.c0wrk/slm-profiles.yaml).
type SLMProfile struct {
    ID     string          `yaml:"id"`     // slug: ^[a-z0-9]+([.-][a-z0-9]+)*$
    Name   string          `yaml:"name"`   // unique display name (≤64 chars for custom)
    Kind   SLMProfileKind  `yaml:"kind"`   // "predefined" | "custom"
    Config SLMProfileConfig `yaml:"config"` // the 25 knobs, NO master toggle
}

// Effective runtime configuration — the resolver's output. The master
// Enabled gates every variant; when false, no variant activates regardless
// of its sub-toggle.
type SLMConfig struct {
    Enabled        bool
    EssentialTools EssentialToolsConfig
    SystemPrompt   SystemPromptConfig
    Sampling       SLMSamplingConfig
    LoopHardening  LoopHardeningConfig
    Context        SLMContextConfig
}

// Runtime mirror carried to the orchestrator via OrchestratorConfig.
type SLMSettings struct {
    Enabled        bool
    EssentialTools SLMEssentialSettings
    SystemPrompt   SLMSystemPromptSettings
}
```

`SLMProfileConfig` exposes exactly **25 leaf knobs** (essential_tools 3 + system_prompt 3 + sampling 7 + loop_hardening 6 + context 6), guarded by a reflection test; the master `slm.enabled` is deliberately outside the profile so selecting a profile never flips the master toggle.

## Profiles

### Value sources: the catalog

The effective 25 knobs come from the **active profile** in the catalog — never from `config.yaml`:

- **Predefined profiles** (5, compiled into the binary via `PredefinedSLMProfiles()`, values from [docs/development/slm-defaults-research.md](../../docs/development/slm-defaults-research.md) incl. the generic addendum). They are **read-only**: `UpdateSLMProfile`/`DeleteSLMProfile` reject them ("duplicate it to edit"); the UI renders their values disabled and offers **Duplicate**.

  | Slug | Tuning intent |
  | ---- | ------------- |
  | `qwen3.8-27b` | minimal — essential_tools/context variants off (context values still seeded), sampling inherits vendor presets, `reasoning_effort: medium` |
  | `qwen3.6-35b-a3b` | medium — lite+compact on, `presence_penalty: 1.5`, `reasoning_effort: medium` |
  | `gemma-4-26b-a4b-it` | maximal — lite+compact on, explicit `top_p: 0.95` / `top_k: 64`, `reasoning_effort` empty (no-op) |
  | `gemma-4-31b-it` | moderate — compact/lite off, explicit `top_p: 0.95` / `top_k: 64` |
  | `generic` (`SLMGenericProfileID`) | model-agnostic maximum support — sampling inherits, `reasoning_effort: medium`, lite+compact on |

  All five share `always_present` = `defaultSLMAlwaysPresent` (17 tools) and loop-hardening 2/3/3/5/4.

- **Custom profiles** — operator-authored via the Settings UI, persisted to `~/.c0wrk/slm-profiles.yaml` (`SLMProfilesPath`), format `{version: 1, profiles: [{id, name, kind, config}]}`. The file is created lazily on first write; `SaveCustomSLMProfiles` validates the whole set (uniqueness vs predefined ∪ custom, value ranges via `NewSLMProfile`) and rewrites atomically (tmp + rename). Loading is **fail-soft**: a missing file is pristine `(nil, nil)`; an unreadable/corrupt/foreign-version file yields an empty list + warning; individual invalid entries (out-of-range values, name collisions, non-custom kind) are dropped, each with its own warning. All warnings ride the `configLoadErrors` channel into the UI. The profile **id is a deterministic slug of the name** (lowercase, non-alphanumerics → `-`, `-2`/`-3`… dedup against every existing id), written once and stable across saves — renaming a profile changes only its display name. A custom profile is created only as a **duplicate of a catalog profile** (`CreateSLMProfile(baseID, name)`, empty base = `generic`), so every custom profile starts from researched values.

### Resolution and fallback

`LoadSLMCatalog(agentDir)` merges the predefined catalog with the custom store; `ResolveSLMConfig(persist, catalog)` then produces the effective `SLMConfig`:

- a known id (predefined ∪ custom) → that profile's values (cloned — the catalog is never mutated), with `Enabled` passed through from `slm.enabled`;
- an empty or dangling `slm.active_profile` (e.g. a custom profile deleted by hand) → **soft fallback to `generic`** plus exactly one warning — the run never breaks. The settings UI mirrors the same semantics: a dangling active id renders the effective `generic` values read-only behind an "active profile not found" banner.

The experimental-features master switch (`experimental.enabled`) gates the whole feature at the `ToBuilderConfig` boundary: when off, the builder sees `Enabled = false` regardless of the stored `slm.enabled`. The gate and the master toggle are coupled **one-way**: closing the gate also persists `slm.enabled = false` in the same write, so re-enabling experimental features does NOT resurrect the profile — the operator must turn it back on explicitly; and the SLM tab can never touch the experimental gate (which lives on the General tab). The master `slm.enabled` toggle is otherwise managed from the SLM settings UI via the `SetSLMEnabled` RPC (persisted to `config.yaml`, applied through `applySLMChange`).

### Active-profile lifecycle

- `SelectSLMProfile(id)` — makes a catalog profile active; persisted to `slm.active_profile` (in-memory rollback on a failed write); no-op when already active.
- `UpdateSLMProfile(id, {name?, config?})` — custom only; partial update (nil fields keep stored values); validated before any write, so an invalid payload produces no partial store write.
- `DeleteSLMProfile(id)` — custom only; deleting the **active** profile first persists `slm.active_profile = "generic"` and reports the switch as a one-shot notice on the next `GetSLMProfiles`.
- `SetSLMEnabled(enabled)` — flips the master `slm.enabled` toggle, persisted to `config.yaml` (in-memory rollback on a failed write). Enabling fails closed while `experimental.enabled` is off; disabling is always allowed; a set matching the stored value is a no-op. Closing the gate via `UpdateExperimentalFeatures(false)` also persists `slm.enabled = false` (see the gate note above).
- Every mutation (profile CRUD and `SetSLMEnabled`) funnels through `applySLMChange()`: `config:updated` emit + router rebuild + `SetSLMProfile`, so a change takes effect for new sessions without an app restart.

### Suggested profile

`GetSLMProfiles` returns `suggested_profile_id` (`*string`, null when nothing matches): the **default model's** id is normalized (lowercase → last `/`-segment → strip `:`-decorations like `:free` → strip `-instruct`/`-it`/`-latest`/`-free` suffixes → drop non-alphanumerics) and matched by containment against each predefined slug (the slug is a SUBSTRING OF the normalized id, so a decorated id like `qwen3.8-27b-instruct-2507` still matches `qwen3.8-27b`); the longest matching slug wins; `generic` is never suggested. The suggestion is a **hint only** — the UI shows an Apply/Hide banner when the suggestion differs from the active profile, and nothing is ever auto-applied.

### Metrics

Every session's `agent_metrics` payload carries the `slm` block with the master toggle, the active variant list, and — new — the active profile's identity: `profile` (the **id slug**, the same key `slm.active_profile` / `active_id` use, not the display name, so renaming never fragments metric series) and `profile_kind` (`predefined` | `custom`). Both are annotated **even when the master toggle is off** (the active profile is a fact independent of variant activation) and are `omitempty` on the wire, so payloads from sessions without a profile stay byte-for-byte legacy-compatible. See [../contracts/event-catalog.md](../contracts/event-catalog.md) (`agent_metrics`).

## Variants

Every variant is gated by BOTH the master `slm.enabled` toggle AND its own sub-toggle **inside the active profile's values** (defense-in-depth) — with one exception: the `system_prompt` variant has no `Enabled` field of its own and engages through its content toggles (`lite`, further gated by `few_shot`/`reasoning_scaffold`). When the master toggle is off, the whole feature is inert — behavior is identical to the un-profiled baseline.

### Essential Tools (narrowing)

Narrows the Conductor's advertised tool set once per task (before the ReAct loop, in `HandleMessage`) to reduce per-prompt JSON-schema/token overhead. Selection is purely static — there is no router matching, no quantitative budget, and no domain-specific allow-list; the profile's selection IS the narrowing. `slm.SelectTools` unions four sources:

1. **always-present tools** — the profile's pinned list (`essential_tools.always_present`).
2. **protected ReAct-mandatory tools** — the loop's own minimum, never dropped in any session regardless of the profile's pins: `finish` (completion channel), `store_fact` / `search_facts` (fact memory), `ask_user` (human-interaction channel), `update_checklist` (step checklist), and the read/recovery tools — `read_attachment` (read a user-attached file), `read_skill_resource` (read an activated skill's resource), and `tool_result_read` (page through a truncated tool result).
3. **every MCP-sourced tool** — user-installed, always included whole (a server's tools are never partially dropped).
4. **turn-scoped extra guarantees** — e.g. `delegate` when the task's directives require it (see below).

The assigned set is exactly this union — nothing more, nothing less — emitted in registry order. Every tool in it is guaranteed and never trimmed: the pins are explicit choices, MCP tools are user-installed integrations, and the protected set carries the completion channel and the read/recovery tools the loop needs; dropping any of it would silently break a pinned workflow, a user-installed MCP server, or the conductor loop's ability to terminate — or leave a narrowed session unable to read an attachment it accepted, open a skill it activated, or page back a result the transport truncated. The protected set is guaranteed in every session because the ReAct loop cannot function normally without it, so an active profile must never remove it. There is no slot budget and no over-budget concept (the 10–20-tool selection-accuracy safe zone from `docs/development/slm-defaults-research.md` remains operator-side guidance, not an enforced guard).

**Turn-scoped delegate guarantee.** When the task context carries requested subagents — an explicit `#agent-name` mention, surfaced to the model as the `## Requested Subagents` directive that mandates delegation via `delegate(agent: ...)` — the orchestrator passes `["delegate"]` into `slm.SelectTools` as the turn-scoped `extraGuaranteed` set (`slmAgentGuaranteedTools` in `core/orchestrator.go`). The name joins the set for that task alone, and unknown names are silently ignored. This closes the cross-feature gap where an active `#agent` mention could meet a narrowed tool set that lacks the `delegate` tool the directive requires.

**Compact descriptions.** With `compact_descriptions` on, every known builtin's full rubric description (purpose/when-to-use/inputs/outputs/example/anti-example, 480-1100 chars) is replaced by a one-line compact variant; unknown tools (e.g. MCP) keep their original descriptions.

**Always-present picker (settings UI).** The operator edits `always_present` through a chip list whose add control is a **combobox**, not a free-text field. The combobox offers two kinds of entry, each with a **markdown** hover tooltip: a **workflow cluster** (see below), which pins all of its still-selectable members at once so a workflow is never added only in part, and whose tooltip carries the cluster description plus a bulleted list of its full member set; and an **individual built-in tool**, whose tooltip is that tool's registry description. The plain rubric text is reformatted for display into heading-free, bold-labelled paragraphs (`toolDescriptionMarkdown`), and a cluster tooltip is its description paragraph plus a bold `**Tools:**` bullet list (`toolGroupTooltipMarkdown`) — both in `frontend/src/lib/slmTools.ts` and rendered through the shared `Markdown` component with the compact `.prose-tooltip` spacing. This conversion is **display-only**: the underlying tool descriptions the model sees are untouched. Both classes exclude what is already allowed explicitly (`always_present`) or implicitly (the protected set, plus every MCP tool and every goal-mode-only tool). The universe arrives read-only in the RPC payload: `GetSLMProfiles` returns top-level `builtin_tools` (every registered built-in that is neither MCP-sourced nor goal-mode-only, with its description, sorted — it still carries the always-protected tools, which the picker subtracts as already-allowed) and `tool_groups` (the workflow clusters, each with title, description and member list); the frontend derives the entries itself (`essentialToolPickerOptions` in `frontend/src/lib/slmTools.ts`) so a pick re-filters without a refetch. The reserved system/orchestration group is included — its tools are narrowable, so pinning e.g. `delegate` is meaningful — while MCP tools never appear (the selection always keeps them whole). Protected tools render as locked chips and are never offered; when no entry remains the picker shows an "already included" note.

**Workflow clusters.** `core/slm` `ToolGroupCatalog` (`tool_groups.go`) defines the ordered clusters whose tools are useless in isolation: **Planning & steps** (`declare_plan`, `execute_plan`, `declare_step_complete`, `update_checklist`) and **Subagents & reflection** (`delegate`, `cancel_delegation`, `read_step_output`, `list_step_outputs`, `read_final_result`, `reflect`). The catalog is static data; the RPC restricts each cluster to the picker universe and drops a cluster with no surviving member, so the picker never advertises a tool the registry lacks. Goal-mode tools (`propose_goal`, `declare_goal_status`, `declare_verification`) deliberately have no cluster and are excluded from the universe altogether: they are stripped from every non-goal run before the selection runs and the selection is not applied in goal mode, so their availability never depends on the profile's selection and offering them would be an inert control. Capability areas whose tools stand alone (files, search, web, memory, shell) stay ungrouped and are offered individually — narrowing a read-only agent to file reads without file writes stays expressible. In the picker each cluster renders as one entry whose markdown tooltip pairs the cluster description with a bulleted list of every member (already-pinned ones included), so the workflow is documented as a whole.

**No chat surfaced events.** The narrowing is a silent, deterministic background step: it emits no `tools_assigned` card and no budget diagnostics into the chat (the former `tools_assigned` event and `small_llm_tool_budget_overflow` diagnostic were removed alongside the `max_tools` budget — see [../decisions/035-remove-small-llm-tool-budget.md](../decisions/035-remove-small-llm-tool-budget.md)).

**Goal mode is refused, not narrowed, while the narrowing is active.** The filter itself runs only on `HandleMessage`'s Conductor path and inside the E2S branch (`runE2SWithState`) — both AFTER the goal-mode early return — so goal mode would otherwise keep the full tool set (the goal-loop tools, including the verifier-required `declare_verification`, would be dropped by `SelectTools`). Rather than let that silent divergence stand, goal mode is **unavailable** whenever the effective profile narrows the tool set — see [Goal-mode gate (`goalBlocked`)](#goal-mode-gate-goalblocked).

### Goal-mode gate (`goalBlocked`)

Goal mode and the essential-tools narrowing are mutually exclusive:

```
goalBlocked = SLM.Enabled && EssentialTools.Enabled
            (the resolved form of `slm.enabled && essential_tools.enabled`,
             experimental gate already folded into SLM.Enabled)
```

`SLM.Enabled` is the **effective** master toggle (the experimental gate already folded in by `effectiveSLMConfig`, so closing the gate also clears it) and `EssentialTools.Enabled` is the active profile's essential-tools variant sub-toggle. The two operands are DISTINCT and both must hold: master-on with the variant off leaves the tool set untouched, so goal mode stays available. `goalBlocked` is therefore a property of the RESOLVED configuration (not the raw persisted `slm:` section) and tracks a runtime profile switch — the catalog is re-read, so a `SelectSLMProfile` / `SetSLMEnabled` takes effect without a restart.

The narrowing applies only to the non-goal Conductor path and the E2S branch (both run after goal mode's early return), so it never narrows a goal run; if it were applied to a goal run it would hide the goal-loop tooling (`propose_goal`, `declare_goal_status`, `declare_verification`) and make the loop unrunnable — which is why goal mode is refused while the narrowing is active. Refusing the request is honest where entering an unrunnable loop is not. Enforcement is defense-in-depth:

- **Frontend (UX, fail-safe).** `slmGateStore` latches `{enabled, essentialToolsEnabled, loaded}` from `GetConfig` (the `ConfigResponse.slm` block — see [../contracts/desktop-frontend.md](../contracts/desktop-frontend.md)); the goal toggle is disabled with an explanatory reason (`isGoalBlockedBySLM()` in `lib/goalGate.ts`), and any stale `goalEnabled` arming is cleared (`inputModeStore.disarmGoal`). An unloaded ("unknown") gate does NOT block — the backend remains authoritative.
- **Backend session API (authoritative).** `FrontendAPI.SendMessage` refuses a goal request — the explicit flag OR a `/goal` prefix on the POST-preprocess text — with a descriptive error BEFORE any side effect (no activity timestamp, no persisted message, no task), and `ResumeTask` / `ResumeSession` refuse resuming a session whose unfinished task carries a non-terminal goal state (`goalResumeBlockedBySLM`).
- **Orchestrator (invariant).** `HandleMessage`'s goal branch and `resumeGoalLoop` entry return `ErrGoalBlockedBySLM` when `slmEssentialToolsEnabled()`, so a direct caller bypassing the API hits the same wall.

Fail-open by design: a not-yet-loaded config never blocks (the invariant is enforced downstream regardless), and a task-store read failure is treated as "not blocked" (fail-open): the resume is independently re-checked by the session manager (`Manager.ResumeTask`, before any task activation) and `resumeGoalLoop` is the ultimate authority, so a transient read error must not strand a legitimate resume.

### System Prompt Simplification

Shrinks the system prompt injected for a small model. Applied in `buildSystemPromptWith` (gated on the context-carried profile flags from `prepareRequestContext`):

- **Lite** — swaps the verbose `OrchestratorSystem` core directive for the compact `OrchestratorSystemLite` directive. The lite directive drops verbose operational docs (checklist/table mechanics, progress-tracking internals) that an SLM cannot hold, but keeps compact versions of the behavioral guards that must never be lost: a short **Git Policy** (no state-modifying git commands unless explicitly requested — the behavioral layer above the `execute` group's `user_confirm` policy) and the **Efficiency Hints** micro-hints (truncated-output mechanics via `tool_result_read`, fact-memory discipline — `store_fact` early/often, `search_facts` before a new sub-step — and `[MCP]`-tool priority, plus files-are-deliverables and minimal shell output). The `Edit → Verify Cycle` section appears exactly once in the lite directive and exactly once in the full directive. It carries NO injection-defense content — that section is injected separately and unchanged (strict constraint).
- **ReasoningScaffold** — appends a three-step thought template (goal → tool choice + rationale → exact args). Only honored when Lite is on.
- **FewShot** — appends curated worked-example ReAct cycles (correct tool-call format, tool choice, error recovery, finish). Only honored when Lite is on.

**Prompt-variant parity for goal agents.** A specialized run carries its own core directive instead of `OrchestratorSystem`, so it was previously never swapped at all — which meant the goal derivation and verification passes (the very passes that run *under* an active profile) ignored the profile's `system_prompt` variant entirely. They now opt into the same swap through `buildSpecializedSystemPromptWithLite` (`systemPromptSpec.allowLiteVariants` + `liteCoreDirective`): `deriveGoal` swaps `prompts.GoalDerivation` for `prompts.GoalDerivationLite`, and `defaultGoalVerifier` swaps the mode's verbose directive for its Lite counterpart (`GoalVerificationLite` / `GoalReDerivationLite`, resolved through the SAME `GoalVerificationSubstitute` placeholder set by `GoalVerificationLiteDirectiveByMode`); the `ReasoningScaffold` / `FewShot` blocks are appended per their sub-toggles exactly as on the orchestrator path. Subagent-profile specialized runs (`core/conductor.go`) deliberately do NOT opt in — their `allowLiteVariants` stays false — so a profile's body remains authoritative even under Lite. When SLM is off or `lite` is off, every specialized directive is emitted byte-identically to the un-swapped baseline (the Lite directives are ignored). The shared sections (family overlay, verification mandate, injection defense, workspace, env, AGENTS.md, skills) are appended UNCHANGED in both modes.

### Sampling Overrides

Overrides LLM sampling parameters for more deterministic, lower-effort generation. Applied in `resolveSamplingFunc` at router construction.

**Inherit-by-default semantics:** the per-family vendor preset (`prompt.DefaultSampling`) is always the base for the numeric parameters. Only parameters the profile sets explicitly (non-zero) override the preset; every unset parameter inherits the vendor value — zero means "inherit the vendor preset" end-to-end (profile → resolver → adapter → builder → router).

- **Temperature** — when set (must be > 0), overrides the per-family default. Unset (0) inherits.
- **TopP** — when set (must be in (0, 1]), overrides the per-family default; plumbed to all providers via the router's `SamplingFunc` (sp4rk `llm.ChatRequest.TopP`). Unset (0) inherits.
- **TopK** — when set (must be >= 1), overrides the per-family default; sent only to providers that support it (Anthropic, Google, LM Studio/vLLM-style OpenAI-compatible endpoints). Unset (0) inherits.
- **RepetitionPenalty** — when set (must be in [1, 2]), overrides the per-family default; sent only to OpenAI-compatible endpoints with a custom base URL (LM Studio/vLLM; strict api.openai.com rejects unknown fields). Unset (0) inherits. The Qwen card keeps this at the vendor 1.0 and prescribes `presence_penalty` as the sanctioned anti-repetition lever instead.
- **PresencePenalty** — when set (must be in [0, 2]), overrides the per-family default. Part of the official OpenAI Chat Completions schema (unlike `repetition_penalty`/`top_k`), so it is sent to every OpenAI-compatible endpoint when set, including strict api.openai.com; the Anthropic and Google providers do not serialize it. Qwen card: 0–2, instruct-mode default 1.5; higher values increase language mixing. Unset (0) inherits — no family preset sets it, so the field is simply not sent.
- **ReasoningEffort** — profile-set only: `applySLMPresets` seeds the builder-level default when the variant is on and the value is non-empty; an empty value inherits the model default (there is no global seeding — the predefined profiles that want `medium` carry it explicitly, per `docs/development/slm-defaults-research.md` R3: the qwen vendor default `xhigh` measured 22,276 reasoning tokens / 21 min on a trivial SVG vs 3,715 tokens / 137 s with thinking off, while `medium` is the model's native pre-training regime and cuts thinking-token spend 60–90%). Per-request overrides (`HandleOptions.ReasoningEffort`) still take precedence; the vendor default remains reachable by leaving the value empty or disabling the variant.

Range validation lives in `config.ValidateSLMProfileConfig` (mirrored by the constructor `NewSLMProfile`) and runs at every write boundary — custom-store load, `CreateSLMProfile`/`UpdateSLMProfile`, and catalog construction — regardless of the toggles, so an out-of-range value cannot go live the moment a variant is switched on. Allowed efforts: `off` | `low` | `medium` (empty inherits the model default).

### Loop Hardening

Tightens the executor's circuit-breaker `CircuitBreakerConfig` (applied in `applyLoopHardening` at builder construction; inert when the master or variant toggle is off):

- `repeat_nudge_threshold`
- `parse_error_abort_threshold`
- `fruitless_nudge_threshold`
- `fruitless_abort_threshold`
- `same_tool_repeat_nudge_threshold`

These are tighter than, or equal to, the baseline `executor.circuitBreaker` values. Four are strictly tighter; `parse_error_abort_threshold` matches the baseline (`3`), since small models do not parse-fail more often than the baseline abort point intends.

### Context Management

Aggressive context management for small context windows. Applied in `applyContextManagement` — a pure helper invoked at every place an executor config is materialized (`Build`, `buildRouter`, `buildContextFactory`), so the overrides hold for the orchestrator executor, the router fallback executor, and the subagent context factory alike. When the master or variant toggle is off it returns the executor config byte-for-byte unchanged; when on, each knob is overridden independently (a zero value keeps the baseline for that knob):

- `compaction.keep_last` → `ExecutorConfig.Compaction.SlidingWindow.KeepLast` — messages kept verbatim at the conversation tail (generic default 6 vs the general 10).
- `compaction.block_size` → `Compaction.Summarization.BlockSize` — batch size for pruning per compaction round (generic default 5 vs the general 7).
- `compaction.trigger_percent` → `Compaction.Thresholds.PredictivePercent` — percentage of the context window at which compaction triggers (generic default 80 vs the general 85).
- `tool_output_keep_last_n` → `ToolOutputPruning.KeepLastN` — only the N most recent tool outputs are kept verbatim (generic default 2 vs the general 3); stricter than the conversation-wide compaction.
- `output_token_reserve` → `OutputTokenReserve` — overrides the global `executor.output_token_reserve` while the variant is on. The value reaches the router as `llm.RouterConfig.OutputTokenReserve`, where it is consulted only as the output reserve in pre-submission context-window validation (`validateContextWindow`) for models whose resolved metadata carries no `OutputLimit`; the registry resolves every model to a non-zero `OutputLimit` (built-in catalog, probe cache, or the 32768 static fallback), so the fallback tier is effectively unreachable. The knob does not change the per-request MaxTokens generation ceiling: that ceiling is the model's resolved `ModelMetadata.OutputLimit` — per-model `llm.models.<model>.output_limit` > per-provider `llm.<provider>.output_token_reserve` > catalog/probe tiers (see [llm-providers.md](llm-providers.md)). For a thinking-capable small model whose catalog output limit truncates reasoning + answer (thinking tokens are spent first, measured ~3.7K–22.3K per turn), raise `llm.models.<model>.output_limit` or the per-provider reserve. The generic default (16384, vs the general executor 8192) keeps the fallback tier thinking-aware; the knob exists to override the reserve per-profile without touching the global executor setting.

When the context variant is enabled, `ValidateSLMProfileConfig` range-checks the values: `keep_last ≥ 2`, `block_size ≥ 2`, `1 ≤ trigger_percent < 100`, `tool_output_keep_last_n ≥ 1`, `output_token_reserve ≥ 1`.

## Flow

```
config.yaml `slm:` (enabled, active_profile)   ~/.c0wrk/slm-profiles.yaml (custom)
        │                                              │
        └───────────────┬──────────────────────────────┘
                        ▼
  config.LoadSLMCatalog(agentDir) = predefined ∪ custom
                        ▼
  config.ResolveSLMConfig(persist, catalog)
    known id → profile values | empty/dangling → generic + 1 warning
                        ▼
backend/configadapter.go: ToBuilderConfig(cfg, catalog)
  (experimental gate: off ⇒ Enabled = false)
  → core.BuilderSLMConfig
                        ▼
core/builder.go: NewOrchestratorBuilder
  ├─ applySLMPresets       → builder reasoning-effort default
  ├─ buildRouter           → resolveSamplingFunc (sampling override)
  │                        + applyContextManagement (router fallback executor)
  ├─ buildContextFactory   → applyContextManagement (subagent context factory)
  └─ Build                 → applyLoopHardening (circuit-breaker thresholds)
                           + applyContextManagement (orchestrator executor)
                           + OrchestratorConfig.SLM (SLMSettings)
                        ▼
per-session Orchestrator.HandleMessage (Conductor path; the E2S branch applies the same filter):
  ├─ opts.Goal && slmEssentialToolsEnabled() → ErrGoalBlockedBySLM
  │     (goal refused: goalBlocked = SLM.Enabled && EssentialTools.Enabled;
  │      FrontendAPI.SendMessage already refused it before any side effect)
  ├─ applySLMToolFilter (ONCE) → slm.SelectTools (static union,
  │     silent — no events emitted)
  └─ prepareRequestContext → withSLMPromptProfile (ctx flags)
       → buildSystemPromptWith → Lite swap (goal derivation/verification
         swap too, via buildSpecializedSystemPromptWithLite) + scaffold + few-shot

backend/session: Manager.SetSLMProfile(effective cfg, active profile)
  → every session's agent_metrics payload carries slm.{enabled,
    profile, profile_kind, variants[]}
```

## Invariants

- The master `slm.enabled` toggle (managed from the SLM settings UI via `SetSLMEnabled`, persisted to `config.yaml`) gates every variant; when it is off, behavior is identical to the un-profiled baseline (zero behavior change at every variant's call site).
- The experimental-features master switch (`experimental.enabled`) gates the whole feature at the `ToBuilderConfig` boundary: when off, the builder sees `Enabled = false` regardless of the stored `slm.enabled`, so the feature is inert for every session. The gate couples one-way with the master toggle: closing the gate also persists `slm.enabled = false` (no silent reactivation on re-enable), while the SLM UI can never touch the gate.
- Each variant is independently gated by BOTH the master toggle and its own sub-toggle **in the active profile's values** (defense-in-depth) — except `system_prompt`, whose sole profile-side gate is `lite` (it carries no separate `Enabled` field).
- `config.yaml` persists exactly two SLM fields — `slm.enabled` and `slm.active_profile`; the 25 knob values always come from a catalog profile. A legacy inline `small_llm:` section is ignored at load and dropped by the next save (sanctioned reset migration — knob values do not carry over).
- Predefined profiles are read-only everywhere (catalog construction, store save, RPC mutations); a custom profile is always born as a duplicate of a catalog profile.
- An empty or dangling `slm.active_profile` resolves to `generic` with exactly one warning — never an error; the effective run is unaffected.
- Custom-store loading never fails the app: broken entries are dropped with warnings that reach the UI; saving is fail-closed (an invalid set is rejected whole, atomically, without touching the file).
- Profile ids are stable slugs; renaming changes only the display name. The metrics `profile` field carries the id slug, so renames never fragment metric series.
- The essential-tools filter runs exactly once per task on the Conductor path (before the ReAct loop) and once in the E2S branch; goal mode is never narrowed, but it is **REFUSED** while the narrowing is active (`goalBlocked = SLM.Enabled && EssentialTools.Enabled`), enforced by the session API before any side effect and by `ErrGoalBlockedBySLM` in the orchestrator.
- **The assigned set is exactly always-present ∪ protected ∪ MCP ∪ turn-scoped guarantees, in registry order.** There is no slot budget and no router matching: nothing in the assigned set is ever trimmed, and the filter emits no events.
- A task whose context carries requested subagents (an explicit `#agent` mention) always has `delegate` in its curated tool set, even though it is neither pinned nor MCP-sourced.
- The lite directive retains the compact Git Policy and the Efficiency Hints micro-hints (truncated-output mechanics, fact-memory discipline, MCP priority); the `Edit → Verify Cycle` section appears exactly once in each of the lite and full directives.
- `finish`, the fact-memory / human-interaction tools, the step checklist (`update_checklist`), and the ReAct read/recovery tools (`read_attachment`, `read_skill_resource`, `tool_result_read`) are always preserved regardless of the always-present list, so a narrowed session is never left unable to complete its loop; every MCP-sourced tool is always kept whole.
- The injection-defense section is never removed or altered by the Lite swap (strict constraint); the lite directive carries no injection-defense content because it is injected separately and unchanged.
- FewShot and ReasoningScaffold are only honored when Lite is active (both are tailored to the lite directive's style).
- Goal derivation and verification specialized runs DO honor the `system_prompt` variant through their own Lite directives (`buildSpecializedSystemPromptWithLite`); subagent-profile specialized runs are never swapped. With SLM off or `lite` off, every specialized directive is byte-identical to the un-swapped baseline.
- Sampling overrides are inherit-by-default: only explicitly set (non-zero) parameters override the vendor preset; unset parameters inherit it. All set parameters (temperature, top_p, top_k, repetition_penalty, presence_penalty) reach the providers that support them through the sp4rk router plumbing (per-parameter provider notes above). `reasoning_effort` is profile-set only — empty inherits the model default.
- Context-management overrides are applied identically at every executor-config materialization site (`Build`, `buildRouter`, `buildContextFactory`), so the orchestrator executor, the router fallback, and the subagent context factory never disagree when the variant is on.
- When the master toggle or the `context` variant toggle is off, the executor config is returned byte-for-byte unchanged; every override knob is independent (`> 0` per-field gate), and general compaction/pruning defaults are never modified.
- Every mutating profile RPC validates through `config.NewSLMProfile`/`ValidateSLMProfileConfig` BEFORE any write, so an invalid payload produces no partial write to the store or config.yaml; `applySLMChange` rebuilds the LLM router and re-snapshots the session metrics on success, so changes take effect for new sessions without an app restart.
- The suggestion hint never auto-applies: switching profiles is always an explicit user action.

## Configuration

Only two keys are persisted in `config.yaml` (the authoritative reference is `config.example.yaml`):

| Parameter | Default | Description |
| --------- | ------- | ----------- |
| `slm.enabled` | false | Master toggle. Manual only — no auto-detection. Normally flipped from the Settings → Small LLM master switch via `SetSLMEnabled` (persisted here); enabling requires `experimental.enabled`, and closing that gate resets it to false. |
| `slm.active_profile` | `generic` | Id of the profile whose 25 knob values form the effective runtime configuration. Empty/dangling → soft fallback to `generic` + load warning. |

The 25 knob values live in profile entries (`essential_tools.*`, `system_prompt.*`, `sampling.*`, `loop_hardening.*`, `context.*` inside each profile's `config`) — predefined ones in the compiled catalog, custom ones in `~/.c0wrk/slm-profiles.yaml`. Their semantics, ranges, and per-profile defaults are documented in the Variants section above and in [docs/development/slm-defaults-research.md](../../docs/development/slm-defaults-research.md); range validation runs at every write boundary regardless of toggles.

## RPC Surface

The catalog and the master toggle are managed at runtime via the settings UI: `GetSLMProfiles` / `CreateSLMProfile` / `UpdateSLMProfile` / `DeleteSLMProfile` / `SelectSLMProfile` plus `SetSLMEnabled` (the `slm.enabled` master toggle) — full semantics in [../contracts/desktop-frontend.md](../contracts/desktop-frontend.md).

## Extension Points

- **New variant knob** — add the field to the relevant sub-config of `SLMProfileConfig` (`backend/config/slm_profiles.go`) and its mirrors (`SLMConfig` in `backend/config/config.go`, `BuilderSLMConfig` in `core/builderconfig.go`), copy it in `configadapter.ToBuilderConfig`, apply it in a dedicated `apply*` helper in `core/builder.go` gated on BOTH the master toggle and its variant's sub-toggle, range-check it in `ValidateSLMProfileConfig` (this also guards the 25-knob reflection test), and document it in `config.example.yaml`'s slm section comment and the Variants section above.
- **New predefined profile** — add an entry built through `NewSLMProfile` in `PredefinedSLMProfiles()` (invalid entries panic at catalog construction — the golden test fixes all values), update the suggestion universe if it should be suggestible, and document it in the catalog table above.
- **New sampling knob** — extend `SLMSamplingConfig` and the builder mirror with inherit-by-default semantics (zero = vendor preset), wire it through `resolveSamplingFunc` into the corresponding sp4rk `ChatRequest` field, and range-check it in `ValidateSLMProfileConfig`.
- **New protected tool** — add it to `ProtectedToolNames` in `core/slm/tools_filter.go`. The protected core grows with it; the locked chips in the settings UI follow automatically (the UI renders `protected_tools` from the RPC payload).

## Related Specs

- [orchestration/README.md](orchestration/README.md) — HandleMessage flow where the essential-tools filter applies
- [orchestration/conductor.md](orchestration/conductor.md) — Conductor system prompt (the Lite swap target)
- [orchestration/router.md](orchestration/router.md) — routing (domain/complexity/skills); router tool matching is NOT used by the narrowing
- [orchestration/executor.md](orchestration/executor.md) — circuit breakers (the loop-hardening target)
- [memory/compaction.md](memory/compaction.md) — compaction semantics (the context-management override target)
- [llm-providers.md](llm-providers.md) — LLM router / sampling (the sampling override target)
- [../contracts/desktop-frontend.md](../contracts/desktop-frontend.md) — the SLM profile RPCs and the `SetSLMEnabled` master toggle
- [../contracts/event-catalog.md](../contracts/event-catalog.md) — `agent_metrics` (`slm.profile` / `slm.profile_kind`)
- [../decisions/022-small-llm-profile.md](../decisions/022-small-llm-profile.md) — the original variant-and-master-toggle design (inline-knob storage; superseded by ADR-041's catalog model)
- [../decisions/035-remove-small-llm-tool-budget.md](../decisions/035-remove-small-llm-tool-budget.md) — removal of the `max_tools` budget, router tool matching, and the tool chat cards
- [../decisions/041-slm-profiles.md](../decisions/041-slm-profiles.md) — the profile-catalog model: predefined/custom profiles, `slm-profiles.yaml`, reset migration, SLM nomenclature
- [../../docs/development/slm-defaults-research.md](../../docs/development/slm-defaults-research.md) — external-evidence review behind every profile default; the evidence base for the `medium` reasoning-effort default, the 16384 output-token reserve, `presence_penalty`, and the 10–20-tool selection-accuracy guidance
