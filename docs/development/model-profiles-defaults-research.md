# Model Profiles Defaults: External Evidence Review (Qwen3.8-27B-MTP)

- **Date:** 2026-08-29
- **Scope:** every default value of the pre-catalog inline `small_llm.*` profile then stored in `config.example.yaml` / `backend/config/defaults.go` (the knobs now live in the profile catalog — see the 2026-09-13 addendum) — 27 values, not only the ones proposed for change — plus the executor/sp4rk baselines they override.
- **Target model:** Qwen3.8-27B-MTP (27B dense, hybrid attention, vision, native MTP head; thinking ON by default, `reasoning_effort` xhigh/medium/low).
- **Method:** each default is checked against (a) the official Qwen3.8-27B model card and vendor docs, (b) independent measurements and industry practice (vLLM, Unsloth, WorkOS, Pydantic, LangChain, Anthropic, peer-reviewed arXiv), and (c) c0wrk/sp4rk source code. Verdicts: ✅ confirmed · ⚠️ partially refuted · ❌ refuted · ➕ gap (missing parameter).

> **Note (2026-09-09):** `essential_tools.max_tools`, router tool matching, and the over-budget diagnostic were **removed** by [ADR-035](../../specs/decisions/035-remove-small-llm-tool-budget.md). The `max_tools` table row, its detailed analysis, and the R6 entries below are retained for provenance but are now moot by construction; the 10–20-tool selection-accuracy evidence survives as operator-side guidance in `specs/domains/model-profiles.md`.
>
> **Note (2026-09-13):** this review was authored against the pre-catalog inline model and originally named its keys `small_llm.*`. That namespace was renamed to `model_profiles.*` (`small_llm.enabled` → `model_profiles.enabled`) and the 25 knob values now live in the profile catalog rather than `config.yaml` — see the 2026-09-13 addendum below and [ADR-041](../../specs/decisions/041-slm-profiles.md). References below use the current `model_profiles.*` keys.
>
> **Note (2026-09-14):** the shipped default `always_present` list grew from 13 to 17 names (12 → 16 effective per-host, since `bash_exec`/`posh_exec` are platform alternatives): the 4 added pins are the ReAct-critical read/recovery tools `read_attachment`, `read_skill_resource`, `tool_result_read` and the step-checklist tool `update_checklist` — and the protected set grew from 5 to 8 (the same three read/recovery tools added, so `update_checklist` and the three read/recovery tools are both pinned and protected). These tools are guaranteed in every session because the ReAct loop cannot function without them (read an accepted attachment, open an activated skill, page back a truncated result, track steps). The study-time counts below (12 always-present / 13 guaranteed) remain historical. The effective per-host set (16) now sits above this review's ideal routing subset (5–15) but inside its safe zone (10–20); the tools are individually narrowable in the settings UI, so an operator whose model is tool-count-sensitive can drop the optional pins while the protected core stays. See `specs/domains/model-profiles.md` for the current list and rationale.

## Executive Summary

Of the 27 defaults, **23 are confirmed** by external sources (including all master toggles, loop-hardening thresholds, compaction knobs, tool-narrowing and system-prompt defaults). **3 are refuted for Qwen3.8-27B in thinking mode** — the inherited sp4rk qwen temperature preset (0.6 is the Qwen3-2507-era value; official thinking value is 1.0), `reasoning_effort: ""` (inherits xhigh, measured at 22,276 reasoning tokens / 21 min for a trivial SVG), and `output_token_reserve: 8192` (reasoning traces alone span 3.7K–22.3K tokens; the generation ceiling is the resolved per-model/per-provider `OutputLimit`, not this reserve — see R4). **1 gap**: `presence_penalty` (Qwen's recommended anti-repetition lever, 0–2) is absent from the sampling variant although the field already exists in sp4rk's request model. Overall confidence: **High** — every verdict is backed by the official model card plus at least one independent source.

## Verdict Summary (all 27 values)

| # | Parameter | Default | Baseline | Verdict | Key evidence |
|---|---|---|---|---|---|
| 1 | `model_profiles.enabled` | `false` | — | ✅ | manual-only by design; model is AA ~52, not a 7B [1][6] |
| 2 | `essential_tools.enabled` | `false` | — | ✅ | opt-in per variant; dual-gate design |
| 3 | `essential_tools.always_present` | 12 tools | all | ✅ | routing subset ideal 5–15 [15]; guaranteed set = 13 unique |
| 4 | `essential_tools.max_tools` | ~~`16`~~ | — | ➖ removed | budget removed in ADR-035 (static tool selection, no slot count); the 10–20-tool selection-accuracy evidence [15][16][17] survives as operator-side guidance |
| 5 | `essential_tools.compact_descriptions` | `false` | — | ✅ | "tool documentation is a prompt, not a comment" [15][21] |
| 6 | `system_prompt.lite` | `false` | — | ✅ | model post-trained for popular harnesses, incl. Claude Code's large prompt [1][6] |
| 7 | `system_prompt.few_shot` | `false` | — | ✅ | helps weaker models [20]; marginal for harness-trained 27B; A/B candidate |
| 8 | `system_prompt.reasoning_scaffold` | `false` | — | ✅ | adaptive thinking makes a fixed scaffold redundant/conflicting [1][2] |
| 9 | `sampling.enabled` | `false` | — | ✅ | opt-in; inheritance protects vendor presets ("27–30B regression" comment in code) |
| 10 | `sampling.temperature` | unset → **0.6** (qwen preset) | — | ❌ | official Qwen3.8 thinking = **1.0** [1][2][22]; 0.6 is Qwen3-2507-era [9] |
| 11 | `sampling.top_p` | unset → 0.95 | — | ✅ | 0.95 official thinking value (both eras) [1][9] |
| 12 | `sampling.top_k` | unset → 20 | — | ✅ | 20 official in both modes [1][9] |
| 13 | `sampling.repetition_penalty` | unset → 1.0 | — | ✅ | Qwen: keep at 1.0; use presence_penalty instead [1][9] |
| 14 | `sampling.reasoning_effort` | `""` → **xhigh** | — | ⚠️ | xhigh = measured overthinking (22,276 tok / 21 min) [3][4][5]; recommend `medium` [2][6]; blocked by qwen plumbing (R1) |
| 15 | `loop_hardening.enabled` | `false` | — | ✅ | opt-in variant gate |
| 16 | `loop_hardening.repeat_nudge` | `2` | 3 | ✅ | industry reference nudge = 3rd repeat [12]; 2 = tighter, fits small models |
| 17 | `loop_hardening.parse_error_abort` | `3` | 3 | ✅ | unchanged from baseline; no external contradiction |
| 18 | `loop_hardening.fruitless_nudge` | `3` | 4 | ✅ | no-op loop detection is on-by-default elsewhere [12] |
| 19 | `loop_hardening.fruitless_abort` | `5` | 6 | ✅ | warn→error escalation pattern [12] |
| 20 | `loop_hardening.same_tool_repeat_nudge` | `4` | 6 | ✅ | identical-call pattern; threshold ≤ Pydantic's 3-warn [12] |
| 21 | `context.enabled` | `false` | — | ✅ | opt-in variant gate |
| 22 | `context.compaction.keep_last` | `6` | 10 | ✅ | tighter window for weaker model; quality degrades as context grows [18][19] |
| 23 | `context.compaction.block_size` | `5` | 7 | ✅ | same direction; no external standard (internal telemetry to calibrate) |
| 24 | `context.compaction.trigger_percent` | `80` | 85 | ✅ | Claude Code: ~83–95% or window-minus-reserve [18][19]; 80 = earlier, justified |
| 25 | `context.tool_output_keep_last_n` | `2` | 3 | ✅ | "hot tail" of fresh tool results, older pruned [10][15] |
| 26 | `context.output_token_reserve` | `8192` | 8192 | ❌ | generation ceiling = resolved `OutputLimit` (per-model/per-provider tiers), not this reserve; reasoning 3.7K–22.3K tok [3][4]; Qwen harness uses 32768 [1]; WorkOS: 16384 is already the "weak link" [10][11] |
| 27 | *(gap)* `sampling.presence_penalty` | **absent** | — | ➕ | Qwen's anti-repetition lever (0–2; instruct default 1.5) [1][9]; field exists in sp4rk |

## Detailed Analysis

### Master toggle (1 value)

**`model_profiles.enabled: false` — ✅ confirmed.** The profile is manual-only: no auto-detection, operator opts in explicitly; each variant additionally requires its own sub-toggle (double gate). Externally justified: Qwen3.8-27B is an "agentic executor" scoring on par with markedly larger models on agentic benchmarks (SWE-bench Pro 61.7, Terminal-Bench 2.1 73.0 per the official card [1]; independent guides rank it with the strongest local coding agents and note it spends ~2× tokens vs its predecessor precisely because of deep reasoning [6]). A model of this class does not warrant auto-enabled "small model" crutches — but the opt-in variant remains useful for constrained local setups (quantized inference, small context, limited VRAM). No source recommends force-enabling such optimizations for a 27B agentic model.

### Essential tools (4 values) — `backend/config/defaults.go:411–432`

**`enabled: false` — ✅.** Variant gate, consistent with the double-gating design.

**`always_present` = 12 tools (read_file, write_file, edit_file, list_directory, glob, ripgrep, bash_exec, semantic_search, store_fact, search_facts, ask_user, finish) — ✅ confirmed.** The guaranteed set (12 always-present ∪ 5 protected: finish, memory, ask_user, MCP; 4 overlap → 13 unique) lands inside the externally documented ideal routing subset of 5–15 tools per reasoning context [15]. The list covers exactly one capability per workflow stage (read → edit → search → run → persist → interact → finish), matching the "single responsibility, no overlapping descriptions" guidance in [15][21].

**`max_tools: 16` — ➖ removed (ADR-035).** The parameter no longer exists: tool narrowing is now a static selection with no slot budget, so the "safe zone" sizing below is moot as a config value. The underlying selection-accuracy evidence is retained for provenance — independent synthesis puts the practical "safe zone" at 10–20 tools per reasoning context, with degradation beginning above it and production unreliability at 40–50 [15]; Berkeley Function-Calling-Leaderboard-style degradation is described as a property of attention over large discrete choice sets, not of a specific model [15]. Peer-reviewed evidence: on the RAG-MCP benchmark, exposing only a retrieved subset tripled tool-selection accuracy (13.62% → 43.13%) and cut prompt tokens by >50% [16]; at 100+ tools accuracy collapses to ~13%, near random [17]. This now informs only the operator-side 10–20-tool guidance in `specs/domains/model-profiles.md`, not an enforced guard.

**`compact_descriptions: false` — ✅ confirmed (conservative).** A tool description is read by the model at inference time to decide whether to call the tool — "documentation is a prompt, not a comment"; explicitly stating when *not* to use a tool is often more valuable than the positive case [15][21]. A typical schema costs only 150–400 tokens [15], so the saving from one-liners is small relative to the selection-accuracy risk. Keeping full descriptions is the right default; compaction remains an operator option.

**Risk to document (R6):** ➖ moot by construction. With the `max_tools` budget removed (ADR-035) there is no over-budget condition to detect: the guaranteed set is never trimmed and all MCP tools join it by design, with sizing left entirely to the operator (the 10–20-tool guidance above).

### System prompt (3 values) — `config.example.yaml:824–867`

**`lite: false` — ✅ confirmed.** The model is post-trained against popular agent harnesses (including Claude Code, whose system prompt is large) and its official benchmarks are run through such a harness [1][6]. Swapping the orchestrator directive for a compact variant targets models that drown in long instructions; for Qwen3.8-27B the verbose guidance is affordable and the risk of losing behavioral guarantees is not.

**`few_shot: false` — ✅ confirmed as default, A/B candidate.** Few-shot prompting measurably improves tool-calling accuracy (LangChain experiments show large gains on hard selection tasks, "few-shotting of any kind helps fairly significantly" [20]). However those experiments predate harness-post-trained models; for Qwen3.8-27B the marginal benefit is smaller and each example costs context. Correct as an off-default; worth an internal A/B before enabling.

**`reasoning_scaffold: false` — ✅ confirmed.** The scaffold (goal → tool+why → args) compensates for models that skip planning before tool calls. Qwen3.8's thinking mode already produces adaptive step-by-step planning [1][2]; a fixed scaffold risks duplicating or contradicting the model's own reasoning trace. Off by default is right, and the variant remains useful for instruct/non-thinking mode.

### Sampling (6 values) — `backend/config/defaults.go:434–446`

**`enabled: false` — ✅.** Opt-in gate.

**Architecture note (verified in code):** sampling numeric fields are deliberately NOT seeded — zero means "inherit the vendor preset" (`sp4rk/prompt/sampling.go:53`, qwen family: temp 0.6 / top_p 0.95 / top_k 20). The code comment records that seeding constants previously caused "the 27–30B regression". The inheritance *architecture* is externally sound — clobbering vendor-tuned presets is a known failure mode. The problem is the *preset value* it inherits (see temperature below).

**`temperature: unset → 0.6` — ❌ refuted at the preset level (R2, fix in sp4rk).** The sp4rk qwen preset's 0.6 traces to the Qwen quickstart recommendation for **Qwen3-Thinking-2507-generation** models [9]. For **Qwen3.8-27B thinking mode** the official card specifies **temperature 1.0** (top_p 0.95, top_k 20), and instruct mode 0.7 / top_p 0.80 [1]. Independent sources agree: Unsloth documents Qwen3.8 as "a hybrid thinking model with different default settings for thinking and non-thinking modes" [2]; fine-tuning guides explicitly carry 1.0/0.95 into serving configs for the 27B thinking mode [22]. Running a Qwen3.8 thinking model at 0.6 deviates from the trained distribution. The c0wrk-side default (unset = inherit) is itself correct — the fix belongs in the sp4rk preset (or an explicit override).

**`top_p: unset → 0.95` — ✅ confirmed.** 0.95 is the official thinking-mode value and coincides across generations [1][9]. (Instruct mode would want 0.80 — another reason the preset should be mode-aware; see R2.)

**`top_k: unset → 20` — ✅ confirmed.** 20 is official in both modes and both generations [1][9].

**`repetition_penalty: unset → 1.0` — ✅ confirmed.** Qwen explicitly recommends repetition_penalty 1.0 (neutral) and points to **presence_penalty 0–2** as the sanctioned anti-repetition lever; pushing repetition_penalty above 1 is not recommended for this family [1][9]. Do not seed it.

**`reasoning_effort: ""` (inherit → xhigh) — ⚠️ partially refuted (R3, prerequisite R1).** The inherited model default is xhigh, the costliest of the three levels [2][4]. Measured impact on trivial tasks: 22,276 reasoning tokens / 21 minutes for an SVG pelican, vs 3,715 output tokens / 137 s with thinking disabled [4]; a ~7× thinking-token overhead with near-identical results, and low/medium effort typically cuts thinking-token spend 60–90% [5]. Unsloth explicitly notes "Extra high is enabled by default so if you want shorter thinking traces, you can adjust the thinking effort" [2]. **`medium` is the right default** — it is the model's native pre-training regime with no effort instruction injected [6], unlike `low` which injects a shortening instruction and carries Qwen's own warning that in multi-turn agentic tasks reduced effort can *increase* total time via failures and retries [1]. **Blocked by plumbing:** c0wrk's validator accepts `""|off|low|medium` (`backend/frontend_api_config.go`), but sp4rk maps qwen effort binary — `enable_thinking = (ReasoningEffort == "On")` (`sp4rk/llm/provider_openai.go:283`) — so today `low`/`medium` silently *disable* thinking entirely rather than selecting a level. Native levels are reachable via the API (vLLM serves Qwen3.8-27B with `reasoning_effort` xhigh/medium/low per request [7]; non-standard fields go through `extra_body`/extra fields [8]), and sp4rk already has a version-aware precedent in `applyGLMReasoning`. Fix the mapping first (R1), then default to `medium` (R3).

### Loop hardening (6 values) — `backend/config/defaults.go:436–452`

Baseline CircuitBreaker (executor): RepeatNudge 3 / ParseErrorAbort 3 / FruitlessNudge 4 / FruitlessAbort 6 / SameToolRepeatNudge 6 (`backend/config/defaults.go:186–210`).

**`enabled: false` — ✅.** Variant gate.

**`repeat_nudge: 2` (base 3) — ✅ confirmed.** The reference implementation of stuck-loop detection (Pydantic Deep Agents) ships the capability **on by default** with `max_repeated = 3` (count must be ≥ 2) and `action = "warn"` first, escalating to error [12]. c0wrk's model-profile nudge at the 2nd repeat is one notch tighter — defensible for a model more prone to mechanical repetition; the warn-before-abort escalation shape matches.

**`parse_error_abort: 3` (= base) — ✅ confirmed.** Deliberately NOT tightened (comment in code). Malformed tool calls are a hard signal; no external source suggests tolerating more than the baseline for small models.

**`fruitless_nudge: 3` (base 4) — ✅ confirmed.** No-op/same-result loops are one of the three canonical stuck patterns (repeated identical, A-B-A-B alternating, no-op same-result) that industry frameworks break by default [12]. Tightening 4→3 for the profile is consistent.

**`fruitless_abort: 5` (base 6) — ✅ confirmed.** Preserves the warn(3)→abort(5) gap of exactly 2 observations, mirroring the warn→error escalation pattern [12].

**`same_tool_repeat_nudge: 4` (base 6) — ✅ confirmed.** Same-tool repetition is the "repeated identical calls" pattern with reference threshold 3 [12]; nudging at 4 (base 6) is between the reference and the baseline — reasonable. Note: exact industry-wide numbers do not exist; these thresholds should be calibrated against c0wrk telemetry, but no external evidence contradicts the chosen values or their direction.

### Context management (6 values) — `backend/config/defaults.go:454–472`, applied in `core/builder.go:2460–2472`

Executor baselines: SlidingWindow KeepLast 10 / Summarization BlockSize 7 (`backend/config/defaults.go:101–107`), PredictivePercent 85 (`sp4rk/memory/defaults.go`, `sp4rk/framework.go:278`), ToolOutputPruning KeepLastN 3 (`backend/config/defaults.go:169`), OutputTokenReserve 8192 (`backend/config/defaults.go:88`).

**`enabled: false` — ✅.** Variant gate.

**`compaction.keep_last: 6` (base 10) — ✅ confirmed (direction).** Context quality degrades as conversations grow — compaction exists precisely because long raw histories hurt [19]; for a smaller model the working window should be tighter. No public standard exists for the exact number (internal telemetry is the calibration tool), but tightening 10→6 is directionally supported.

**`compaction.block_size: 5` (base 7) — ✅ confirmed (direction).** Smaller summarization blocks = finer-grained history folding, matching the tighter-window rationale above. Same caveat: no external standard; telemetry to calibrate.

**`compaction.trigger_percent: 80` (base 85) — ✅ confirmed.** Claude Code — the most-watched reference — triggers auto-compaction at roughly 83% on a 200K window and ~95%+ elsewhere; its trigger is "context window minus a roughly fixed token reserve", not a universal constant [18][19]. Triggering *earlier* for a weaker model (80 vs 85) sits inside the documented industry range and follows the principle that quality loss from a bloated context hurts smaller models sooner [19].

**`tool_output_keep_last_n: 2` (base 3) — ✅ confirmed.** The "hot tail" pattern: keep the freshest tool outputs verbatim for immediate reasoning, prune/summarize older ones — standard practice in production agents [10][15]. Tightening 3→2 keeps the most recent observation pair intact while halving retained noise.

**`output_token_reserve: 8192` (= baseline 8192) — ❌ refuted for thinking mode (R4).** Two independent problems:

1. **The generation ceiling must cover the reasoning trace.** The per-request MaxTokens ceiling is the model's resolved `ModelMetadata.OutputLimit`, not this reserve: the reserve reaches the router only as `llm.RouterConfig.OutputTokenReserve` (`core/builder.go:1791`), the fallback consulted in context-window validation when metadata carries no `OutputLimit` — and the registry resolves a non-zero `OutputLimit` for every model (built-in catalog / probe cache / 32768 static fallback), so the fallback tier is effectively unreachable. The actionable ceiling lever is `llm.models.<model>.output_limit` or the per-provider `llm.<provider>.output_token_reserve` (`core/builder.go applyProviderOutputReserves` seeds it into the registry overrides). For reasoning models, thinking tokens are generated *before* content and draw from the same ceiling [13][14] — real billing/latency data shows reasoning consume 4–15× the visible output on hard tasks [14]. Qwen3.8-27B's own agentic harness runs at `max_tokens = 32768` [1], and its card budgets up to 262,144 reasoning + 131,072 response tokens for agentic work [1].
2. **Measured reasoning traces exceed the reserve.** 3,715–22,276 reasoning tokens on trivial-to-simple tasks [3][4]; with a 4096–8192 cap, thinking can exhaust the budget and yield an empty/truncated answer — the documented "thinking eats max_tokens" failure mode [13][14].

Industry reference points: pi's default `reserveTokens` is 16384 and WorkOS's analysis calls that value "the weak link … because it does two jobs at once" (compaction trigger + summarizer output budget) [10][11]. Recommendation: **16384** for the Model Profiles feature when thinking is enabled (optionally effort-aware: 8192 only when effort is off). Trade-off to document: on small local context windows (16–32K) a large reserve shrinks the usable input budget — the knob must stay operator-tunable, which it already is.

### Gap: `presence_penalty` (➕, R5)

Qwen's sanctioned anti-repetition parameter (range 0–2; instruct-mode default 1.5; higher values risk language mixing and slight quality loss) [1][9]. It is absent from the c0wrk model-profile sampling variant, while `ChatRequest.PresencePenalty` already exists in sp4rk and is a standard OpenAI-schema field forwarded by the OpenAI-compatible provider. Adding it (default unset = inherit) closes the loop for instruct-mode users and gives a non-destructive lever against repetition loops (complementary to loop-hardening, per Qwen's explicit guidance *against* raising repetition_penalty [1][9]).

## Recommendations (each backed by external sources)

| ID | Change | Where | External confirmation |
|---|---|---|---|
| **R1** (P0) | Map qwen `reasoning_effort` natively: `low`/`medium`/`xhigh` → per-request parameter (vLLM/OpenAI-compatible: `reasoning_effort`, non-standard via extra fields), not binary `enable_thinking`. Keep `"off"` → `enable_thinking:false`, `"On"` unchanged. | sp4rk `llm/reasoning.go` (qwen options), `llm/provider_openai.go:283`; precedent `applyGLMReasoning` | vLLM serves Qwen3.8-27B with per-request `reasoning_effort` xhigh/medium/low [7]; extra-fields pattern for non-standard params [8]; effort-injection mechanics (xhigh injects "think carefully", medium = native, nothing injected) [6] |
| **R2** (P0) | Update sp4rk qwen sampling preset: thinking temperature **0.6 → 1.0** (ideally mode-aware: thinking 1.0/0.95, instruct 0.7/0.80). | sp4rk `prompt/sampling.go` (qwen preset) | Official card: thinking temp 1.0, top_p 0.95; instruct 0.7/0.80/1.5 [1]; Unsloth: per-mode defaults differ [2]; 0.6 documented as the Qwen3-2507-generation value [9]; corroboration [22] |
| **R3** (P1, after R1) | Default `model_profiles.sampling.reasoning_effort` = `"medium"` (when sampling variant enabled). | c0wrk `generic` catalog profile (`backend/config/model_profiles.go`) | Unsloth: adjust effort down from default xhigh for shorter traces [2]; measured 22,276 tok / 21 min at xhigh vs 3,715 tok / 137 s off [4]; 60–90% thinking-token cut at low/medium [5]; medium = native regime [6]; Qwen's own caveat against `low` in agentic multi-turn (retries) → medium [1] |
| **R4** (P1) | `model_profiles.context.output_token_reserve`: **8192 → 16384** (thinking-aware router-validation fallback). The generation ceiling is a separate lever — `llm.models.<model>.output_limit` / per-provider `llm.<provider>.output_token_reserve`; raise those for thinking models whose catalog ceiling (e.g. 8192) truncates reasoning + answer. | c0wrk `backend/config/defaults.go:471` | Reasoning burns the ceiling first [13][14]; traces 3.7K–22.3K [3][4]; Qwen harness 32768 [1]; 16384 = pi default reserve [10][11] |
| **R5** (P2) | Add `presence_penalty` to `model_profiles.sampling` (default unset/inherit). | c0wrk config struct/validator/UI; sp4rk field exists | Qwen card: presence_penalty 0–2, instruct default 1.5, repetition_penalty stays 1.0 [1]; quickstart: adjust 0–2 to reduce repetitions [9] |
| **R6** (P2) | Document/metricize the guaranteed-set risk: always-present ∪ protected (13) ∪ MCP is never trimmed; several MCP servers breach the 20-tool safe zone. | c0wrk docs (`specs/domains/model-profiles.md`), config comments, optional runtime warning | Safe zone 10–20/context, unreliability at 40–50 [15]; 13.62%→43.13% with subset routing [16]; ~13% near-random at 100+ tools [17] |

## Explored and Pruned Branches

- **"Small model → determinism → low temperature 0.1–0.3."** Pruned: contradicts the official 1.0 (thinking) / 0.7 (instruct) [1]; c0wrk's own recorded "27–30B regression" came from forcing constants onto vendor presets.
- **"27B = weak model → enable every aggressive simplification."** Pruned: Qwen3.8-27B is a harness-post-trained agentic executor with frontier-local scores [1][6]; defaults staying off is correct, the profile is for constrained deployments.
- **"Raise repetition_penalty against repetition loops."** Pruned: Qwen explicitly keeps 1.0 and prescribes presence_penalty 0–2 instead [1][9]; loop-hardening thresholds are the structural fix [12].
- **"MTP (multi-token prediction) changes sampling recommendations."** Pruned: MTP is a decode-side speed feature (draft+verify), orthogonal to the sampling distribution; it affects throughput/acceptance, not temperature/effort guidance.
- **"Default reasoning_effort to `low` (max savings)."** Pruned: Qwen warns lower effort can increase total latency/tokens in multi-turn agentic tasks via failures and retries [1]; `low` also injects a shortening instruction unlike native `medium` [6].
- **"Search academia for exact compaction/loop threshold standards."** Pruned: no such standard exists; replaced by industry practice references (Claude Code thresholds, pi reserve semantics, Pydantic loop defaults) + recommendation to calibrate on internal telemetry.

## Areas of Consensus

- Thinking-mode sampling for Qwen3.8: temp 1.0 / top_p 0.95 / top_k 20 / repetition_penalty 1.0 — official card [1], Unsloth [2], serving guides [22], quickstart-era distinction [9].
- xhigh-by-default is an overthinking/cost hazard on simple tasks; medium is the practical everyday level — Unsloth [2], Willison [3], implicator [4], APIRank [5], codersera [6].
- Reasoning tokens draw from the same output budget as content — Meta docs [13], token-mix analysis [14], Qwen's own 32K harness setting [1].
- Tool-count degradation is real and steep (safe zone 10–20; retrieval/routing restores it) — synthesis [15], arXiv RAG-MCP [16], particula [17].
- Stuck-loop detection with warn→abort escalation is a default-on industry capability — Pydantic Deep Agents [12].

## Areas of Debate / Uncertainty

- **Thinking ON (medium) vs OFF for a 27B coder:** consensus leans medium for agentic tool work; Willison personally prefers starting low/off for trivial tasks [3]; Qwen cautions low can *cost* more in multi-turn agents [1]. A single c0wrk-side default cannot capture task-dependence — keep it operator-tunable.
- **Exact loop-hardening numbers (2/3/3/5/4) and compaction windows (6/5/80/2):** directionally supported, numerically unstandardized; only internal telemetry can validate the precise values.
- **Reserve 16384 vs higher:** on 262K-context hosted inference, 16K+ is clearly safe [1][10]; on 16–32K local windows it trades input budget for output headroom — must remain configurable.
- **Few-shot/lite prompt effects specifically on Qwen3.8-27B:** benefits are documented for earlier/smaller models [20]; unmeasured for this one — A/B before enabling.

## Sources

1. Qwen/Qwen3.8-27B model card, Hugging Face — https://huggingface.co/Qwen/Qwen3.8-27B. Official primary source: per-mode sampling (1.0/0.95/20 vs 0.7/0.80/1.5), reasoning_effort levels & xhigh default, presence_penalty 0–2, preserve_thinking, agentic token budgets, harness settings (temp 1.0, max_tokens 32768), benchmarks. **Credibility: high (vendor primary).**
2. Unsloth Documentation, "Qwen3.8 — How to Run Locally" — https://unsloth.ai/docs/models/qwen3.8. Confirms hybrid thinking model, per-mode defaults, xhigh-by-default with explicit advice to lower effort for shorter traces. **High (widely-used vendor tooling docs).**
3. Simon Willison, "Qwen 3.8 27B is excellent, but it defaults to wildly overthinking things" (2026-08-16) — https://simonwillison.net/2026/Aug/16/qwen-38-27b/. First-hand measurements: SVG pelican 21 min / 22,276 reasoning tokens; circle case reasoning about palettes/animation. **High (independent, reproducible methodology).**
4. implicator.ai, "Qwen 3.8 27B Defaults to Its Costliest Reasoning Setting" — https://www.implicator.ai/qwen-3-8-27b-xhigh-reasoning-default/. Quantifies xhigh default: 22,276 tokens / 21 min vs 3,715 tokens / 137 s thinking-off on the same prompt. **Medium-high (independent measurement).**
5. APIRank, "Qwen 3.8 27B reasoning_effort: Stop Overthinking" — https://apirank.vip/tutorials/qwen-3-8-27b-reasoning-effort-overthinking-tokens-2026/. ~7× thinking-token overhead at xhigh; low/medium cut spend 60–90%. **Medium (secondary analysis).**
6. codersera, "Qwen3.8-27B Complete Guide" — https://codersera.com/blog/qwen-3-8-27b-complete-guide-2026/. Explains effort-injection mechanics (xhigh injects "think carefully"; medium = native, nothing injected); harness affinity; ~2× token spend vs predecessor. **Medium-high.**
7. vLLM (Ascend) tutorial, "Qwen3.8-27B" — https://docs.vllm.ai/projects/ascend/en/latest/tutorials/models/Qwen3.8-27B.html. Official serving docs: thinking on by default, per-request `reasoning_effort` (xhigh/medium/low), `preserve_thinking`. **High (vendor serving stack).**
8. QwenCloud docs (DeepSeek/third-party models page) — https://docs.qwencloud.com/developer-guides/third-party-models/deepseek. Documents the `extra_body` pattern for non-standard fields (`enable_thinking`) vs standard `reasoning_effort`. **High (vendor API docs).**
9. Qwen Quickstart, qwen.readthedocs.io — https://qwen.readthedocs.io/en/latest/getting_started/quickstart.html. Temperature 0.6 recommendation scoped to Qwen3-Thinking-2507-generation models (the stale source of the sp4rk preset); presence_penalty 0–2 guidance. **High (vendor docs; note the generation scoping).**
10. WorkOS, "Stop giving your coding agent a million-token context window" — https://workos.com/blog/coding-agent-context-window-compaction-settings. `reserveTokens: 16384` is "the weak link … two jobs at once" (compaction trigger + summarizer output budget); keepRecentTokens practice. **Medium-high (industry engineering blog with pi internals).**
11. earendil-works/pi issue #8133, "Per-model compaction settings" — https://github.com/earendil-works/pi/issues/8133. Documents pi's 16384 reserveTokens default and trigger = contextWindow − reserveTokens. **Medium-high (primary repo discussion).**
12. Pydantic Deep Agents, "Stuck-loop detection" — https://vstorm-co.github.io/pydantic-deepagents/advanced/stuck-loop-detection/. On-by-default capability; three patterns (identical / A-B-A-B / no-op); `max_repeated` default 3; warn (ModelRetry) → error escalation. **High (framework docs).**
13. Meta dev.ai, "Model API — Reasoning / thinking tokens" — https://dev.meta.ai/docs/cookbook/reasoning-thinking-tokens. Thinking tokens surface as `reasoning_tokens` in usage and draw from the output budget. **High (vendor API docs).**
14. tokenmix.ai, "Thinking Tokens Trap: How Reasoning Models Burn max_tokens" — https://tokenmix.ai/blog/thinking-tokens-billing-trap-2026. Real data: reasoning consumes max_tokens before content; 4–15× multipliers across providers. **Medium (independent analysis).**
15. tianpan.co, "The Over-Tooled Agent Problem" (2026-04-19) — https://tianpan.co/blog/2026-04-19-over-tooled-agent-problem. Safe zone 10–20 tools/context, ideal routed subset 5–15, unreliability at 40–50; 150–400 tokens per schema; BFCL-style degradation; "documentation is a prompt". **Medium-high (synthesis of primary benchmarks).**
16. RAG-MCP paper, arXiv:2505.03275 — https://arxiv.org/abs/2505.03275. Peer-reviewed: subset retrieval triples tool-selection accuracy (43.13% vs 13.62%) and cuts prompt tokens >50%. **High (peer-reviewed).**
17. particula.tech, "Agent Tool Selection at Scale" — https://particula.tech/blog/agent-tool-selection-at-scale-80-tools-wrong-one. Accuracy collapses to ~13% (near random) at 100+ tools; two-phase search-then-load fix. **Medium.**
18. bswen.com, "How to Configure Claude Code Auto-Compact Settings" — https://docs.bswen.com/blog/2026-03-21-claude-code-auto-compact-settings/. Percentage-based triggers and token-window limits for CC auto-compact. **Medium.**
19. GitHub claude-code issue #43981 (+ dotfiles.pro analysis) — https://github.com/anthropics/claude-code/issues/43981, https://dotfiles.pro/blog/claude-code-auto-compact-threshold. Auto-compact ≈ 83% on 200K / ~95%+ elsewhere; effectively window-minus-fixed-reserve; no fixed universal percentage. **Medium-high (primary repo + corroborating analysis).**
20. LangChain blog, "Few-shot prompting to improve tool-calling performance" — https://www.langchain.com/blog/few-shot-prompting-to-improve-tool-calling-performance. Few-shot examples significantly boost tool-calling accuracy (incl. hard selection). **Medium-high (vendor research; pre-harness-era models).**
21. Anthropic, "Writing effective tools for AI agents" — https://www.anthropic.com/engineering/writing-tools-for-agents. Tool descriptions as prompts; quality-over-quantity of tool surface. **High (vendor engineering guidance).**
22. yottalabs.ai, "How to Fine-Tune Qwen 3.8 27B with Unsloth" — https://www.yottalabs.ai/post/how-to-fine-tune-qwen-3-8-27b-with-unsloth-2026. Carries official per-mode sampling (thinking 1.0/0.95; instruct 0.7/0.80/1.5) into serving configs. **Medium.**
23. pi.dev docs, "Compaction & Branch Summarization" — https://pi.dev/docs/latest/compaction. Vendor-primary defaults: `reserveTokens: 16384` ("tokens to reserve for LLM response"), `keepRecentTokens: 20000` (verbatim recent tail; everything before the cut point is summarized). **High (vendor primary).**
24. earendil-works/pi issue #92, "Context compaction for long sessions" — https://github.com/earendil-works/pi/issues/92. Rationale for the 16384 default: summarizer output budget ~13K + ~3K safety margin; trigger = context window − reserve. **Medium-high (primary repo discussion).**
25. TurboAI, "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE Guide" — https://www.turboai.dev/blog/claude-autocompact-pct-override-guide. Claude Code's default auto-compact threshold ≈ 83% of the context window (~166K on 200K; the remainder is the response/summarization buffer). **Medium-high.**
26. claudefa.st, "Claude Code Context Buffer: The 33K-45K Token Problem" — https://claudefa.st/blog/guide/mechanics/context-buffer-management. Independent measurement: auto-compact fires at ≈ 83.5% of the window; buffer mechanics. **Medium.**
27. Qwen/Qwen3.6-35B-A3B model card, Hugging Face — https://huggingface.co/Qwen/Qwen3.6-35B-A3B. Per-recipe sampling (general 1.0/pp 1.5 · coding 0.6/pp 0.0 · instruct 0.7/0.80), binary `enable_thinking` only, no `reasoning_effort`. **High (vendor primary).**
28. google/gemma-4-26B-A4B-it model card, Hugging Face — https://huggingface.co/google/gemma-4-26B-A4B-it. Recommended sampling 1.0 / 0.95 / **top_k 64**; thinking via the `<|think|>` token only (binary). **High (vendor primary).**
29. google/gemma-4-31B-it model card, Hugging Face — https://huggingface.co/google/gemma-4-31B-it. Same best-practices sampling block (1.0 / 0.95 / 64). **High (vendor primary).**
30. DigitalApplied, "Context Engineering Playbook 2026" — https://www.digitalapplied.com/blog/context-engineering-agent-reliability-playbook-2026. Synthesizes Chroma "Context Rot", the BFCL/GeoEngine tool-count failure mode (8B-class model fails at 46 tools, works at 19), and Databricks effective-context limits. **Medium-high (synthesis of primary benchmarks).**

Code references: `backend/config/defaults.go:411–472` (profile defaults), `:88–210` (executor baselines), `core/builder.go:1791, 2460–2472` (reserve→router, context overrides), `sp4rk/prompt/sampling.go` (qwen preset), `sp4rk/llm/provider_openai.go:283` (binary qwen effort mapping), `sp4rk/llm/reasoning.go` (qwen options On/Off), `sp4rk/framework.go:278` + `sp4rk/memory/defaults.go` (PredictivePercent 85).

## Gaps and Further Research

1. **No public A/B exists for c0wrk's exact profile.** Run an internal SWE-like benchmark across {effort: off/low/medium} × {reserve: 8192/16384} × {temp: 0.6/1.0} to convert directional confirmations into measured optima.
2. **Loop-hardening and compaction exact numbers** (2/3/3/5/4; 6/5/80/2) lack external standards — validate against c0wrk telemetry (nudge/abort fire rates, post-compaction task success).
3. **presence_penalty=1.5 behavior in long agentic sessions** on Qwen3.8-27B (language-mixing risk noted by Qwen [1]) — measure before recommending a non-inherit default.
4. **Few-shot/lite prompt marginal effect on a harness-post-trained 27B** — A/B candidate, not a default change.
5. **MTP acceptance rate as a sampling-health proxy** — a falling speculative-acceptance rate signals deviation from the trained distribution; consider surfacing it as a metric.

## Addendum (2026-09-08): code-level verification follow-up

A follow-up verification pass against the actual code (`backend/config/defaults.go`, `config.example.yaml`, `core/prompts/*`, `core/systemprompt.go`, `core/modelprofiles/tools_filter.go`, sp4rk `prompt/sampling.go`, `llm/provider_openai.go`, `llm/modelregistry.go`) confirmed **all 27 defaults unchanged** and closed the open items of this review.

**Recommendation ledger (R1–R6):**

| ID | Status | Verified at |
|---|---|---|
| R1 | ✅ closed in sp4rk — qwen `reasoning_effort` is native per-request for Qwen 3.8+ (`applyQwenReasoning` + `IsQwen38OrLater`); `off` → `enable_thinking: false` | `sp4rk/llm/provider_openai.go:364` |
| R2 | ✅ closed in sp4rk — qwen preset is 1.0 / 0.95 / 20 (official thinking recipe). The preset is family-keyed with no mode signal, so instruct-mode values (0.7 / 0.80 / top_k 20 + presence_penalty 1.5) must be set explicitly when thinking is off (a per-profile concern in the catalog now) | `sp4rk/prompt/sampling.go:53–68` |
| R3 | ✅ closed — the `generic` profile seeds `reasoning_effort: medium` (the former unconditional `ApplyDefaults` seeding is gone) | `backend/config/model_profiles.go` |
| R4 | ✅ reformulated — the reserve is a fallback-tier knob, not the generation ceiling; the catalog-check below (gap #5) removes the residual "catalog truncates the answer" concern for the target model | — |
| R5 | ✅ closed — `presence_penalty` added to `model_profiles.sampling` (range [0, 2]; unset = field not sent) | `backend/config`, `config.example.yaml` |
| R6 | ➖ moot by construction — the `max_tools` budget was removed in ADR-035; there is no over-budget condition to signal | — |

**Follow-up gap ledger (lite-prompt / integration verification, gaps #1–#6):**

1. **Git Policy lost in lite** — closed: compact Git Policy restored in `core/prompts/orchestrator_lite.md`.
2. **Micro-hints missing in lite** (truncated-output mechanics, fact-memory discipline, MCP priority) — closed: added in `orchestrator_lite.md`.
3. **Edit→Verify Cycle asymmetry** (duplicated ×3 across lite/scaffold/few-shot, absent from the full directive) — closed: deduplicated to exactly one occurrence per directive and added to `orchestrator_system.md`; the few-shot structural defect fixed.
4. **`delegate` not guaranteed under tool narrowing** — closed: `modelprofiles.SelectTools` accepts turn-scoped `extraGuaranteed` names and the orchestrator passes `["delegate"]` whenever the task context carries requested subagents (`core/modelprofiles/tools_filter.go`, `core/orchestrator.go`).
5. **Catalog ceiling for the target model** — **closed by catalog inspection, no code change**: sp4rk `llm/modelregistry.go:1912` carries `qwen/qwen3.8-27b` with `ContextWindow: 262144` / `OutputLimit: 65536` (plus Reasoning/Attachment/Temperature/ToolCall capabilities). The ceiling comfortably covers the measured 3.7K–22.3K reasoning traces, so `output_token_reserve` stays the fallback-tier knob it was reformulated to be (R4).
6. **Guaranteed-set over-budget silence (R6)** — moot by construction: the `max_tools` budget and its over-budget diagnostic were removed in ADR-035, so there is no over-budget condition to signal.

## Addendum (2026-09-13): the `generic` profile — model-agnostic maximum support

The named-profiles redesign introduces 5 predefined profiles: 4 model-specific ones from the completed four-model study (Qwen3.8-27B, Qwen3.6-35B-A3B, Gemma-4-26B-A4B-it, Gemma-4-31B-it) plus **`generic`** — the universal "maximum support" preset for *any* small model, the fallback when the active profile id is missing, and the duplication base for new custom profiles. A profile carries the **25 knobs of the 5 variants** (with their sub-toggles); the master `model_profiles.enabled` stays in `config.yaml` outside the profiles — switching a profile must never silently flip the whole mode on or off.

Two design rules fix the value set:

1. **"Maximum support" = maximum *validated* support, not "every boolean true".** All 5 variants are ON, but the two prompt-content additions whose benefit is unmeasured on the researched class (`few_shot`, `reasoning_scaffold`) stay OFF — an unvalidated per-turn token burn is not support. The four-model study confirms the reading: even its most aggressive preset (Gemma-4-26B-A4B-it) keeps both off.
2. **Model-agnostic sampling = inherit-by-default, one seeded exception.** The study's central sampling finding is that vendor recipes diverge by model *and* mode — Qwen3.8 thinking 1.0/0.95/20 (instruct 0.7/0.80/pp 1.5), Qwen3.6 general 1.0/pp 1.5 vs coding 0.6/pp 0.0, Gemma 1.0/0.95/**top_k 64** [1][27][28][29]. No seeded constant is right for the whole class (top_k alone: 20 vs 64), so every numeric sampling field inherits (0 = don't touch the vendor preset — the same architecture verdict as the main review and the same "27–30B regression" caution). `reasoning_effort` is the one seeded value, and it is safe across the class: native level for Qwen3.8+ (60–90% thinking-token cut vs the xhigh default), thinking-ON under Qwen3.6's binary mapping, harmless no-op for Gemma (sp4rk has no `google` branch in its reasoning mapping).

Note: the `system_prompt` variant has no `enabled` gate of its own — it engages through its content toggles, and `lite: true` is the engaging choice for generic.

### The 25 values

| # | Knob | Generic value | Why | Evidence |
|---|---|---|---|---|
| 1 | `essential_tools.enabled` | `true` | An unreduced tool surface is the steepest *measured* tax on the weak class: selection accuracy triples (13.62% → 43.13%) and prompt tokens drop >50% when the visible set is cut to a subset | [15][16][30] |
| 2 | `essential_tools.always_present` | built-in `defaultModelProfilesAlwaysPresent` (17 names incl. `posh_exec`, 16 effective per-host; 12 effective per-host at study time — see the 2026-09-14 note) | The original pins land inside the ideal routed subset 5–15 / safe zone 10–20; the 4 added pins (read/recovery + checklist) raise the effective per-host set from 12 to 16, still inside the safe zone; one capability per workflow stage (read → edit → search → run → persist → interact → finish) | [15][30] |
| 3 | `essential_tools.compact_descriptions` | `true` | Differs from the conservative platform default **on purpose**: verdict #5 governs a harness-post-trained 27B, where full schemas (150–400 tokens each) buy selection accuracy; generic targets the weakest class, where the per-step schema tax dominates. The four-model study turns compaction ON for its two weakest profiles; the documented trade is losing negative-guidance nuances | [15][16][21] + four-model study |
| 4 | `system_prompt.lite` | `true` | Verdict #6 ("lite off") was scoped to a model post-trained against large harness prompts; generic's class drowns in long directives — context quality degrades with volume for every model, sooner for weaker ones. The lite directive keeps the behavioral guard-rails (Git Policy — see the gap ledger above; the injection-defense section is injected separately and left unchanged by the Lite swap) | [19][30] + four-model study; exact wording: internal A/B |
| 5 | `system_prompt.few_shot` | `false` | Few-shot is the best-documented tool-calling booster for weak models, but every example costs context every turn and the effect is unmeasured on the researched class; all four study profiles keep it off; verdict #7 (off-default, A/B first) stands | [20] |
| 6 | `system_prompt.reasoning_scaffold` | `false` | A fixed scaffold duplicates/contradicts a thinking model's adaptive trace; generic covers thinking models (Qwen3.8/3.6), so the scaffold stays off; operators on pure instruct models may enable it (requires `lite`) | [1][2] (verdict #8) |
| 7 | `sampling.enabled` | `true` | Variant gate; safe to enable because the variant is inherit-only + the seeded effort — it cannot clobber vendor presets (the recorded "27–30B regression" failure mode). **Internal design property** (§Sampling architecture note); the gate itself needs no external standard | — (internal) |
| 8 | `sampling.temperature` | `0` (inherit) | Vendor recipes diverge by model and mode (1.0 qwen-thinking / 0.6–0.7 qwen coding-instruct / 1.0 gemma); no model-agnostic constant exists; inherit is the only correct generic value | [1][27][28] |
| 9 | `sampling.top_p` | `0` (inherit) | 0.95 happens to be common to all researched vendors, but "common today" ≠ universal; inherit keeps the family preset authoritative | [1][27][28][29] |
| 10 | `sampling.top_k` | `0` (inherit) | The decisive divergence: 20 (qwen) vs 64 (gemma); any seeded value is wrong for half the class. Gemma's own model profiles set 0.95/64 explicitly because the sp4rk google preset carries only temperature — a per-model concern, not a generic one | [1][28][29] |
| 11 | `sampling.repetition_penalty` | `0` (inherit → family default) | Qwen prescribes 1.0 and warns against raising it; Gemma does not regulate it; inherit is neutral everywhere | [1][9] |
| 12 | `sampling.presence_penalty` | `0` (unset → not sent) | Values diverge by vendor and mode (qwen3.8 thinking 0.0 / instruct 1.5; qwen3.6 general 1.5 / coding 0.0; gemma unregulated); unset is the only model-agnostic choice; standard OpenAI-schema field, settable per model when needed | [1][9][27] |
| 13 | `sampling.reasoning_effort` | `"medium"` | The one seeded value (R3, already platform behavior): native level for Qwen3.8+ (60–90% thinking-token cut vs xhigh default); Qwen3.6 binary → thinking ON; Gemma → no-op. Harmless-or-helpful across the entire class — exactly what a generic preset needs | [1][2][3][4][5][27] |
| 14 | `loop_hardening.enabled` | `true` | Stuck-loop detection is an on-by-default industry capability (three canonical patterns, warn→error escalation) | [12] |
| 15 | `loop_hardening.repeat_nudge_threshold` | `2` | Reference: `max_repeated` 3 with warn-first escalation; 2 = one notch tighter for the mechanical-repetition-prone class. Exact number: **internal telemetry** | [12] |
| 16 | `loop_hardening.parse_error_abort_threshold` | `3` | Inherits the executor baseline; deliberately not tightened — malformed calls are a hard signal (verdict #17). **Internal baseline**; no external standard | — (internal) |
| 17 | `loop_hardening.fruitless_nudge_threshold` | `3` | No-op loops are a canonical default-detected pattern; 3 (base 4) is tighter for the class. Direction external; exact number **internal telemetry** | [12] |
| 18 | `loop_hardening.fruitless_abort_threshold` | `5` | Preserves the warn(3)→abort(5) escalation gap. Direction external; exact number **internal telemetry** | [12] |
| 19 | `loop_hardening.same_tool_repeat_nudge_threshold` | `4` | Identical-call reference threshold is 3; 4 sits between the reference and the base 6. Direction external; exact number **internal telemetry** | [12] |
| 20 | `context.enabled` | `true` | Context rot: quality degrades as context grows, sooner for weaker models — compaction is the structural mitigation | [19][30] |
| 21 | `context.compaction.keep_last` | `6` | Keep a verbatim recent tail (pi's `keepRecentTokens` 20000 is the same hot-tail shape); tighter than base 10 for the class. Exact count **internal telemetry** (no public standard — the main review's own conclusion) | [23] + internal telemetry |
| 22 | `context.compaction.block_size` | `5` | Finer summarization blocks match the tighter window; **internal telemetry** (explicitly no external standard) | internal telemetry |
| 23 | `context.compaction.trigger_percent` | `80` | Claude Code's default trigger is ≈83–83.5% of the window; 80 fires earlier for the weaker class, inside the documented industry range | [18][19][25][26] |
| 24 | `context.tool_output_keep_last_n` | `2` | Hot-tail pruning of stale tool outputs is standard practice (keep the freshest results verbatim, summarize/prune older ones); 2 keeps the most recent observation pair. Direction external; exact **internal telemetry** | [10][15][23] |
| 25 | `context.output_token_reserve` | `16384` | pi's shipped default reserve, with the stated rationale (summarizer output ~13K + safety margin ~3K); reasoning tokens burn the ceiling before content; closes R4 for the profile | [13][14][23][24] |

### Consistency with the main review and the "all 5 variants on" decision

No verdict flips; every divergence is a documented scope change, not a contradiction:

- **`compact_descriptions` (#5) and `lite` (#6):** the review's "off" verdicts govern the *platform default* for a harness-post-trained 27B; `generic` is an operator-selected maximum-support preset for the weakest class, where the four-model study itself turns both ON. The evidence base is shared ([15][16][21] / [19][30]); the trade-off (lost negative guidance; shorter directive) is stated in rows 3–4.
- **`few_shot` (#7) and `reasoning_scaffold` (#8):** kept OFF — the verdicts stand as-is. Their OFF state is what makes "all 5 variants on" coherent rather than self-defeating: the variants are ON, their unvalidated content toggles are not.
- **Sampling (#10–#13, R2/R5):** generic inherits everywhere — precisely the architecture the review confirms; the preset-level qwen fix (R2, thinking 1.0/0.95/20) lives in sp4rk and flows to generic automatically. `reasoning_effort: medium` (R3) and `presence_penalty` unset (R5) match the closed recommendations exactly.
- **Loop-hardening (#16–#20) and context (#22–#26):** identical to the reviewed values; the reserve moves 8192 → 16384 exactly as R4 recommended (it is already the platform default).
- **`model_profiles.enabled`** stays outside the profile set (25 knobs only) — the manual-only doctrine of verdict #1 is untouched.

### Model-agnostic open points (internal telemetry)

The exact numeric thresholds with no external standard — loop nudge/abort counts (2/3/3/5/4), `keep_last` 6, `block_size` 5, `tool_output_keep_last_n` 2 — are directionally supported (rows 15–24) but numerically unstandardized industry-wide; c0wrk telemetry (nudge/abort fire rates, post-compaction task success) remains the only calibration tool, exactly as the main review concluded for the inline defaults.
