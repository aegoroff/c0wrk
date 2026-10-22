package embeddedllm

// MLX memory planning (ADR-092): the mtplx engine's decision layer.
//
// The llama family plans a SPLIT (device weights vs host spill, `-ngl`, KV
// precision, `--fit` delegation); MLX on Apple Silicon has no split to plan —
// everything is resident in ONE unified pool, MTPLX sizes its own wired limit
// and KV quantization at load, and the only decision left to c0wrk is the
// context window the server is launched with. This file makes that decision
// from the pinned pack's OWN measured memory evidence, with the same
// discipline as plan.go: pure inputs, cited constants, a gate that is the
// first check, and a refusal that carries the arithmetic.
//
// Every constant below is a measurement carried inside the pinned pack
// (`mtplx_runtime.json` → `memory_evidence`, captured for MLXPackRevision on
// an M5 Max, deterministic text prompts, draft head and vision tower
// resident), cross-checked against the registry's own byte counts at pin
// time. Re-measuring is part of a pack bump.

import "fmt"

// MLXMemoryTerms is the measured memory model of the pinned MLX pack. Every
// figure is the pack contract's own, in bytes.
type MLXMemoryTerms struct {
	// WeightsBytes is the trunk + MTP head + vision tower residency: the pack
	// contract's `weights_bytes` (8,834,412,216), which is exactly the sum of
	// the registry's model.safetensors + mtp.safetensors pins — the vision
	// tower is inside model.safetensors.
	WeightsBytes int64
	// RuntimeTransientsBytes is what the measurements show the engine needs
	// ABOVE weights and KV in every run ("the peak sits about 3.1 GiB above
	// the weights and the KV cache"): allocator scratch, compiled-verify
	// programs, prefill transients, MTP draft state.
	RuntimeTransientsBytes int64
	// BankSteadyBytes is the steady-state session-bank residency the planner
	// keeps beside live KV. On a 16 GiB-class machine the bank's RAM floor is
	// dropped entirely (restores come from SSD); this is the remaining steady
	// term, not the dropped floor.
	BankSteadyBytes int64
	// KVBytesPerToken is the DENSE cache width (65,536). MTPLX's dynamic paged
	// KV may quantize at load; the planner counts dense in its own verdicts,
	// and so does this one — quantization then only widens the margin.
	KVBytesPerToken int64
	// MaxContext is the pack contract's `model_max_context` (262,144), also
	// the trunk's training context.
	MaxContext int
	// MinContext is the smallest window this planner emits (8,192): the
	// measured verdict on the tightest machine the pack is offered on, and
	// the floor MTPLX itself falls back to.
	MinContext int
}

// The measured engine-budget fraction: on every measured RAM class the
// engine's usable budget is exactly three quarters of physical RAM
// (16 GiB → 12.0 GiB, 18 → 13.5, 24 → 18.0 — the pack's `memory_limit_bytes`).
const (
	mlxBudgetNum   = 3
	mlxBudgetDenom = 4
)

// The arithmetic-window policy margin. The measured classes resolve BELOW the
// raw arithmetic ceiling (an M5 Max resolved 20,480 of 32,768 possible at
// 18 GiB, 94,208 of 106,496 at 24 GiB — per-chip wired-limit and bank policy
// c0wrk cannot see), so a window computed for a NON-measured RAM size keeps a
// 1/8 margin over the ceiling and snaps to 4,096-token granules. The measured
// classes do not apply it: their windows are the pack's own verdicts.
const (
	mlxPolicyMarginNum   = 7
	mlxPolicyMarginDenom = 8
	mlxWindowGranule     = 4096
)

// mlxMeasuredWindows are the pack memory evidence's resolved context windows
// for the RAM classes it actually measured, taken verbatim. Keyed by whole
// GiB of physical RAM (Apple's nominal sizes ARE the binary GiB the probe
// reports: a "24 GB" Mac's hw.memsize is exactly 24×2³⁰).
var mlxMeasuredWindows = map[int]int{
	16: 8192,
	18: 20480,
	24: 94208,
}

// PinnedMLXMemoryTerms returns the measured terms for the pinned pack,
// cross-checked against the registry: the two weight pins must still sum to
// the contract's weights figure, or the pin tables have drifted apart and the
// planner refuses rather than price the wrong weights.
func PinnedMLXMemoryTerms() (MLXMemoryTerms, error) {
	model, ok := MLXPackFile("model.safetensors")
	if !ok {
		return MLXMemoryTerms{}, fmt.Errorf("%w: pack pin missing model.safetensors", ErrArtifactNotPinned)
	}
	mtp, ok := MLXPackFile("mtp.safetensors")
	if !ok {
		return MLXMemoryTerms{}, fmt.Errorf("%w: pack pin missing mtp.safetensors", ErrArtifactNotPinned)
	}
	const contractWeightsBytes = int64(8834412216)
	if model.SizeBytes+mtp.SizeBytes != contractWeightsBytes {
		return MLXMemoryTerms{}, fmt.Errorf(
			"embeddedllm: MLX pack pins drifted: model+mtp = %d bytes, the pinned memory contract says %d — re-measure and re-pin together",
			model.SizeBytes+mtp.SizeBytes, contractWeightsBytes)
	}
	return MLXMemoryTerms{
		WeightsBytes:           contractWeightsBytes,
		RuntimeTransientsBytes: 3489660928,
		BankSteadyBytes:        23957832,
		KVBytesPerToken:        65536,
		MaxContext:             maxTrainingContext,
		MinContext:             8192,
	}, nil
}

// mlxEngineBudgetBytes is the measured fraction of physical RAM the engine
// may spend: ⌊ramGiB⌋ × ¾. The fraction was verbatim on every measured class.
func mlxEngineBudgetBytes(ramGiB float64) int64 {
	whole := int64(ramGiB) // truncate toward zero == floor for positive RAM
	return whole * (1 << 30) / mlxBudgetDenom * mlxBudgetNum
}

// mlxFixedBytes is the pool footprint that does not scale with context.
func (t MLXMemoryTerms) mlxFixedBytes() int64 {
	return t.WeightsBytes + t.RuntimeTransientsBytes + t.BankSteadyBytes
}

// mlxArithmeticWindow computes the context window for a RAM size the pack
// evidence did not measure: the raw ceiling ((budget − fixed) / dense KV),
// shaved by the 1/8 policy margin, snapped down to a 4,096 granule and
// clamped to [MinContext, MaxContext]. The clamp UP at the floor matches the
// measured 16 GiB class, whose ceiling is exactly MinContext.
func (t MLXMemoryTerms) mlxArithmeticWindow(budgetBytes int64) int {
	kvBudget := budgetBytes - t.mlxFixedBytes()
	if kvBudget < 0 {
		kvBudget = 0
	}
	ceiling := kvBudget / t.KVBytesPerToken
	window := ceiling * mlxPolicyMarginNum / mlxPolicyMarginDenom
	window -= window % mlxWindowGranule
	if window < int64(t.MinContext) {
		window = int64(t.MinContext)
	}
	if window > int64(t.MaxContext) {
		window = int64(t.MaxContext)
	}
	return int(window)
}

// PlanMLX is the mtplx engine's pure planner: (physical RAM, tuning, measured
// terms) → the context window the server is launched with, gated against the
// measured budget. No I/O, no probing, no clock — the same purity contract as
// Plan, and held by the same kind of structural test.
//
// The llama-family override vocabulary does not apply here: there is no
// offload to pin, no fit pass to delegate to, no KV precision c0wrk chooses,
// and no packing to swap (the engine ships one quantization). A tuning that
// sets any of those is a configuration error and is refused with
// ErrTuningInvalid naming the engine — never silently ignored — while the
// context override works exactly as on the llama family.
func PlanMLX(ramGiB float64, tuning Tuning, terms MLXMemoryTerms) (MemoryPlan, error) {
	for _, no := range mlxForbiddenOverrides(tuning) {
		return MemoryPlan{}, fmt.Errorf("%w: embedded_llm.tuning.%s does not apply to engine %q (no offload, no fit pass, no KV or packing choice; use context.mode for the window)",
			ErrTuningInvalid, no, EngineMTPLX)
	}
	if ramGiB <= 0 {
		return MemoryPlan{}, fmt.Errorf("%w: the MLX memory gate needs a total to derive the engine budget from", ErrRAMUnknown)
	}

	budget := mlxEngineBudgetBytes(ramGiB)
	fixed := terms.mlxFixedBytes()

	var window int
	var source string
	if tuning.Context.Mode == ContextExact {
		if tuning.Context.Tokens <= 0 || tuning.Context.Tokens > terms.MaxContext {
			return MemoryPlan{}, fmt.Errorf("%w: context %d outside the modelled range [1, %d]",
				ErrContextOutOfRange, tuning.Context.Tokens, terms.MaxContext)
		}
		window = tuning.Context.Tokens
		source = "operator override (context.mode exact)"
	} else if measured, ok := mlxMeasuredWindows[int(ramGiB)]; ok {
		window = measured
		source = fmt.Sprintf("the pinned pack's measured verdict for the %d GiB class", int(ramGiB))
	} else {
		window = terms.mlxArithmeticWindow(budget)
		source = "arithmetic from the pinned pack's measured terms with the 1/8 policy margin"
	}

	// THE GATE — one unified pool, one comparison. `need` is additive because
	// on this engine every byte it names lives in the same pool.
	need := fixed + int64(window)*terms.KVBytesPerToken
	if need > budget {
		return MemoryPlan{}, &MLXInsufficientMemoryError{
			Window:      window,
			NeedBytes:   need,
			BudgetBytes: budget,
			RAMGiB:      ramGiB,
			Terms:       terms,
		}
	}

	plan := MemoryPlan{
		// No fit pass and no -ngl exist on this engine: Layers stays nil (the
		// launcher omits the flag) and Fit is false.
		Fit:         false,
		ContextSize: window,
		// KVType, Packing and the whole llama flag vocabulary stay at their
		// zero values: the launcher reads none of them for this engine, and a
		// rendered "f16 KV" would describe a decision nobody made.
		KVType:            "",
		Packing:           "",
		GPUFamily:         GPUFamilyAppleSilicon,
		DeviceBudgetMiB:   mibCeil(budget),
		HostBudgetMiB:     mibCeil(budget),
		ExpectedDeviceMiB: mibCeil(need),
		ExpectedHostMiB:   mibCeil(need),
		Notes: []string{
			fmt.Sprintf("MLX engine budget: %s = %d GiB RAM × ¾ (the pack evidence's measured fraction on every class)", mibGiB(mibCeil(budget)), int64(ramGiB)),
			fmt.Sprintf("fixed footprint: weights %s + runtime transients %s + session bank %s, all measured inside the pinned pack", mibGiB(mibCeil(terms.WeightsBytes)), mibGiB(mibCeil(terms.RuntimeTransientsBytes)), mibGiB(mibCeil(terms.BankSteadyBytes))),
			fmt.Sprintf("context %d from %s; KV counted at its dense %d B/token — MTPLX's dynamic paged KV can only widen the margin", window, source, terms.KVBytesPerToken),
			"the runtime re-checks admission at load against its own budget and the Metal wired limit; this plan is the launch shape, not the runtime's decision",
		},
	}
	if tuning.Context.Mode == ContextExact {
		plan.Notes = append(plan.Notes,
			"an exact context override replaces the measured/arithmetic window; the gate above still priced it")
	}
	return plan, nil
}

// MLXInsufficientMemoryError is the mtplx engine's gate refusal. It carries
// the whole arithmetic — window, need, budget, RAM — because a refusal must
// show why, and it unwraps to BOTH ErrMemoryPlanInfeasible and
// ErrInsufficientMemory so a caller matching either sentinel matches this one.
type MLXInsufficientMemoryError struct {
	Window      int
	NeedBytes   int64
	BudgetBytes int64
	RAMGiB      float64
	Terms       MLXMemoryTerms
}

func (e *MLXInsufficientMemoryError) Error() string {
	fixed := e.Terms.mlxFixedBytes()
	return fmt.Sprintf(
		"%s: a %d-token window needs %s of KV (%d B/token) beside %s of measured fixed footprint (weights + runtime transients + session bank), and the MLX engine's budget on %d GiB of RAM is %s — %s short; lower context.mode, or use a machine with more memory",
		ErrMemoryPlanInfeasible, e.Window,
		mibGiB(mibCeil(e.NeedBytes-fixed)), e.Terms.KVBytesPerToken, mibGiB(mibCeil(fixed)),
		int64(e.RAMGiB), mibGiB(mibCeil(e.BudgetBytes)), mibGiB(mibCeil(e.NeedBytes-e.BudgetBytes)))
}

func (e *MLXInsufficientMemoryError) Unwrap() []error {
	return []error{ErrMemoryPlanInfeasible, ErrInsufficientMemory}
}

// ForbiddenLlamaTuning names every llama-family tuning key that is set and has
// no meaning under the mtplx engine. It is the config layer's cross-engine
// check (a `tuning:` that names llama-only knobs beside `engine: mtplx` is a
// contradiction refused at load) and it is the SAME list the planner refuses
// with, so the two layers cannot disagree about what "llama-only" means.
func ForbiddenLlamaTuning(tuning Tuning) []string {
	return mlxForbiddenOverrides(tuning)
}

// mlxForbiddenOverrides names every llama-family tuning field that is set and
// has no meaning under the mtplx engine. One name per finding, in struct
// order, so a misconfigured config names ALL its mistakes at once.
func mlxForbiddenOverrides(tuning Tuning) []string {
	var found []string
	if tuning.KVType != "" {
		found = append(found, "kv_cache_type")
	}
	if tuning.Offload.explicit() {
		found = append(found, "offload")
	}
	if tuning.FitEnabled != nil {
		found = append(found, "fit")
	}
	if tuning.FitTargetMiB != nil {
		found = append(found, "fit_target_mib")
	}
	if tuning.FitMinContext != nil {
		found = append(found, "fit_min_context")
	}
	if tuning.KVOffload != nil {
		found = append(found, "kv_offload")
	}
	if tuning.MMProjOffload != nil {
		found = append(found, "mmproj_offload")
	}
	if tuning.Packing != "" {
		found = append(found, "packing")
	}
	if tuning.Parallel != nil {
		found = append(found, "parallel")
	}
	if tuning.CacheRAMMiB != nil {
		found = append(found, "cache_ram_mib")
	}
	if tuning.CtxCheckpoints != nil {
		found = append(found, "ctx_checkpoints")
	}
	if tuning.CacheIdleSlots != nil {
		found = append(found, "cache_idle_slots")
	}
	if tuning.HostReserveGiB != nil {
		found = append(found, "host_reserve_gib")
	}
	if len(tuning.Devices) > 0 {
		found = append(found, "devices")
	}
	if tuning.SplitMode != SplitModeAuto {
		found = append(found, "split_mode")
	}
	return found
}
