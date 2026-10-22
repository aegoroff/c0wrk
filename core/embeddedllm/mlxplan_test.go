package embeddedllm

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

func mlxTerms(t *testing.T) MLXMemoryTerms {
	t.Helper()
	terms, err := PinnedMLXMemoryTerms()
	if err != nil {
		t.Fatalf("PinnedMLXMemoryTerms: %v", err)
	}
	return terms
}

// TestPinnedMLXMemoryTermsCrossCheck pins the measured terms and proves the
// cross-check would fire if the pack pins drifted away from the contract.
func TestPinnedMLXMemoryTermsCrossCheck(t *testing.T) {
	terms := mlxTerms(t)
	if terms.WeightsBytes != 8834412216 {
		t.Fatalf("WeightsBytes = %d, want the pack contract's 8834412216", terms.WeightsBytes)
	}
	if terms.RuntimeTransientsBytes != 3489660928 || terms.BankSteadyBytes != 23957832 {
		t.Fatalf("fixed terms drifted: %d/%d, want 3489660928/23957832",
			terms.RuntimeTransientsBytes, terms.BankSteadyBytes)
	}
	if terms.KVBytesPerToken != 65536 || terms.MaxContext != 262144 || terms.MinContext != 8192 {
		t.Fatalf("kv/context terms drifted: %+v", terms)
	}

	original := mlxPackPins
	defer func() { mlxPackPins = original }()
	pack := append([]Asset(nil), mlxPackPins...)
	pack[0].SizeBytes++ // model.safetensors grows; the contract does not
	mlxPackPins = pack
	if _, err := PinnedMLXMemoryTerms(); err == nil || !strings.Contains(err.Error(), "drifted") {
		t.Fatalf("PinnedMLXMemoryTerms error = %v, want a drift complaint", err)
	}
}

// TestPlanMLXMeasuredClasses locks the three measured RAM classes to the
// pack evidence's own resolved windows, verbatim.
func TestPlanMLXMeasuredClasses(t *testing.T) {
	cases := []struct {
		ramGiB  float64
		wantCtx int
	}{
		{16, 8192},
		{18, 20480},
		{24, 94208},
	}
	for _, tc := range cases {
		plan, err := PlanMLX(tc.ramGiB, Tuning{}, mlxTerms(t))
		if err != nil {
			t.Fatalf("PlanMLX(%v): %v", tc.ramGiB, err)
		}
		if plan.ContextSize != tc.wantCtx {
			t.Fatalf("PlanMLX(%v) context = %d, want the measured %d", tc.ramGiB, plan.ContextSize, tc.wantCtx)
		}
		// The plan must actually fit the budget it was gated against: the
		// fixed footprint plus the dense KV of the chosen window.
		budget := mlxEngineBudgetBytes(tc.ramGiB)
		need := plan.ExpectedDeviceMiB
		if need > mibCeil(budget) {
			t.Fatalf("PlanMLX(%v) plan needs %d MiB over the %d MiB budget", tc.ramGiB, need, mibCeil(budget))
		}
		if plan.Fit {
			t.Fatalf("PlanMLX(%v) Fit = true, the mtplx engine has no fit pass", tc.ramGiB)
		}
		if plan.Layers != nil {
			t.Fatalf("PlanMLX(%v) Layers non-nil, there is no -ngl on this engine", tc.ramGiB)
		}
	}
}

// TestPlanMLXArithmeticClasses checks the unmeasured RAM sizes: the policy
// margin, the granule snap, the floor and the training-context cap.
func TestPlanMLXArithmeticClasses(t *testing.T) {
	terms := mlxTerms(t)
	cases := []struct {
		ramGiB  float64
		wantCtx int
	}{
		// 32 GiB: budget 24 GiB; ceiling (24−11.486)×2³⁰/65536 = 204,800;
		// ×7/8 = 179,200; snap 4096 → 176,128.
		{32, 176128},
		// 17 GiB sits between measured classes: budget 12.75 GiB, arithmetic
		// with the margin lands on 16,384.
		{17, 16384},
		// Cap: from ~66 GiB up the arithmetic ceiling passes the training
		// context; the plan must not exceed 262,144.
		{64, 262144},
		{128, 262144},
		// A 12 GiB Mac is below the smallest shape the terms can serve: the
		// gate refuses with arithmetic, it does not clamp to a fantasy.
	}
	for _, tc := range cases {
		plan, err := PlanMLX(tc.ramGiB, Tuning{}, terms)
		if err != nil {
			t.Fatalf("PlanMLX(%v): %v", tc.ramGiB, err)
		}
		if plan.ContextSize != tc.wantCtx {
			t.Fatalf("PlanMLX(%v) context = %d, want %d", tc.ramGiB, plan.ContextSize, tc.wantCtx)
		}
	}
}

// TestPlanMLXRefusesTooSmallMachine proves the gate refuses a machine no
// window can serve, with the arithmetic in the message and both sentinels
// reachable through Unwrap.
func TestPlanMLXRefusesTooSmallMachine(t *testing.T) {
	_, err := PlanMLX(12, Tuning{}, mlxTerms(t))
	if err == nil {
		t.Fatal("PlanMLX(12): want a refusal")
	}
	var infeasible *MLXInsufficientMemoryError
	if !errors.As(err, &infeasible) {
		t.Fatalf("error = %v, want *MLXInsufficientMemoryError", err)
	}
	if !errors.Is(err, ErrMemoryPlanInfeasible) || !errors.Is(err, ErrInsufficientMemory) {
		t.Fatalf("error %v unwraps to neither ErrMemoryPlanInfeasible nor ErrInsufficientMemory", err)
	}
	if !strings.Contains(err.Error(), "12 GiB") || !strings.Contains(err.Error(), "8192") {
		t.Fatalf("refusal %q does not name its arithmetic", err)
	}
}

// TestPlanMLXExactContextOverride pins the operator override: honored when it
// fits, refused with arithmetic when it does not.
func TestPlanMLXExactContextOverride(t *testing.T) {
	terms := mlxTerms(t)
	plan, err := PlanMLX(32, Tuning{Context: ContextTuning{Mode: ContextExact, Tokens: 32768}}, terms)
	if err != nil {
		t.Fatalf("PlanMLX(32, exact 32768): %v", err)
	}
	if plan.ContextSize != 32768 {
		t.Fatalf("context = %d, want the override 32768", plan.ContextSize)
	}
	found := false
	for _, n := range plan.Notes {
		if strings.Contains(n, "exact context override") {
			found = true
		}
	}
	if !found {
		t.Fatalf("notes %v do not record the override", plan.Notes)
	}

	_, err = PlanMLX(16, Tuning{Context: ContextTuning{Mode: ContextExact, Tokens: 262144}}, terms)
	if !errors.Is(err, ErrMemoryPlanInfeasible) {
		t.Fatalf("PlanMLX(16, exact 262144) error = %v, want an infeasibility", err)
	}

	if _, err := PlanMLX(32, Tuning{Context: ContextTuning{Mode: ContextExact, Tokens: 0}}, terms); !errors.Is(err, ErrContextOutOfRange) {
		t.Fatalf("exact 0 error = %v, want ErrContextOutOfRange", err)
	}
	if _, err := PlanMLX(32, Tuning{Context: ContextTuning{Mode: ContextExact, Tokens: 999999}}, terms); !errors.Is(err, ErrContextOutOfRange) {
		t.Fatalf("exact 999999 error = %v, want ErrContextOutOfRange", err)
	}
}

// TestPlanMLXRefusesLlamaTuning walks every llama-only override and refuses
// it by name; the zero tuning and a pure context override stay legal.
func TestPlanMLXRefusesLlamaTuning(t *testing.T) {
	no := false
	cases := map[string]func(*Tuning){
		"kv_cache_type":    func(t *Tuning) { t.KVType = KVTypeQ8_0 },
		"offload":          func(t *Tuning) { t.Offload = Offload{Mode: OffloadLayers, Layers: 32} },
		"fit":              func(t *Tuning) { v := true; t.FitEnabled = &v },
		"fit_target_mib":   func(t *Tuning) { v := 1024; t.FitTargetMiB = &v },
		"fit_min_context":  func(t *Tuning) { v := 65536; t.FitMinContext = &v },
		"kv_offload":       func(t *Tuning) { v := false; t.KVOffload = &v },
		"mmproj_offload":   func(t *Tuning) { v := false; t.MMProjOffload = &v },
		"packing":          func(t *Tuning) { t.Packing = PackingPQ2_0 },
		"parallel":         func(t *Tuning) { v := 2; t.Parallel = &v },
		"cache_ram_mib":    func(t *Tuning) { v := 8192; t.CacheRAMMiB = &v },
		"ctx_checkpoints":  func(t *Tuning) { v := 4; t.CtxCheckpoints = &v },
		"cache_idle_slots": func(t *Tuning) { v := false; t.CacheIdleSlots = &v },
		"host_reserve_gib": func(t *Tuning) { v := 4.0; t.HostReserveGiB = &v },
		"devices":          func(t *Tuning) { t.Devices = []string{"Metal"} },
		"split_mode":       func(t *Tuning) { t.SplitMode = SplitModeNone },
	}
	terms := mlxTerms(t)
	for name, set := range cases {
		t.Run(name, func(t *testing.T) {
			var tuning Tuning
			set(&tuning)
			_, err := PlanMLX(32, tuning, terms)
			if !errors.Is(err, ErrTuningInvalid) {
				t.Fatalf("PlanMLX error = %v, want ErrTuningInvalid", err)
			}
			if !strings.Contains(err.Error(), name) {
				t.Fatalf("error %q does not name the offending key %q", err, name)
			}
			if !strings.Contains(err.Error(), "mtplx") {
				t.Fatalf("error %q does not name the engine", err)
			}
		})
	}

	// A `fit: false` style negative pin is still a pin: refused like the rest.
	var neg Tuning
	neg.FitEnabled = &no
	if _, err := PlanMLX(32, neg, terms); !errors.Is(err, ErrTuningInvalid) {
		t.Fatalf("explicit-false fit error = %v, want ErrTuningInvalid", err)
	}

	// The zero tuning and a context-only override are the whole legal surface.
	if _, err := PlanMLX(32, Tuning{}, terms); err != nil {
		t.Fatalf("zero tuning: %v", err)
	}
	if _, err := PlanMLX(32, Tuning{Context: ContextTuning{Mode: ContextExact, Tokens: 65536}}, terms); err != nil {
		t.Fatalf("context-only tuning: %v", err)
	}
}

func TestPlanMLXNeedsRAM(t *testing.T) {
	if _, err := PlanMLX(0, Tuning{}, mlxTerms(t)); !errors.Is(err, ErrRAMUnknown) {
		t.Fatalf("PlanMLX(0) error = %v, want ErrRAMUnknown", err)
	}
	if _, err := PlanMLX(-4, Tuning{}, mlxTerms(t)); !errors.Is(err, ErrRAMUnknown) {
		t.Fatalf("PlanMLX(-4) error = %v, want ErrRAMUnknown", err)
	}
}

// TestPlanMLXBudgetFraction locks the measured ¾ fraction.
func TestPlanMLXBudgetFraction(t *testing.T) {
	cases := map[float64]int64{
		16: 12884901888,
		18: 14495514624,
		24: 19327352832,
	}
	for ram, want := range cases {
		if got := mlxEngineBudgetBytes(ram); got != want {
			t.Fatalf("mlxEngineBudgetBytes(%v) = %d, want the measured %d", ram, got, want)
		}
	}
}

// TestPlanMLXIsPure mirrors plan.go's purity guarantee: byte-identical plans
// across concurrent calls (no package state read, no clock in the path).
func TestPlanMLXIsPure(t *testing.T) {
	terms := mlxTerms(t)
	first, err := PlanMLX(48, Tuning{}, terms)
	if err != nil {
		t.Fatalf("PlanMLX(48): %v", err)
	}
	const workers = 16
	results := make(chan string, workers)
	for i := 0; i < workers; i++ {
		go func() {
			p, err := PlanMLX(48, Tuning{}, terms)
			if err != nil {
				results <- "error: " + err.Error()
				return
			}
			results <- p.Notes[0] + "|" + itoa(p.ContextSize)
		}()
	}
	for i := 0; i < workers; i++ {
		if got := <-results; got != first.Notes[0]+"|"+itoa(first.ContextSize) {
			t.Fatalf("impure plan: got %q on one worker", got)
		}
	}
}

// TestPlanMLXImportsNoIOPackage is the structural half of the purity
// guarantee: mlxplan.go must not import anything that can touch a file, a
// socket, a subprocess, the clock or global state, and its one package-level
// var must stay a constant map literal.
func TestPlanMLXImportsNoIOPackage(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "mlxplan.go", nil, 0)
	if err != nil {
		t.Fatalf("parse mlxplan.go: %v", err)
	}
	banned := map[string]bool{
		"os": true, "os/exec": true, "io": true, "bufio": true, "net": true,
		"net/http": true, "net/url": true, "time": true, "log": true,
		"log/slog": true, "path/filepath": true, "syscall": true,
		"database/sql": true, "encoding/json": true, "fmt": false,
	}
	for _, imp := range f.Imports {
		path := strings.Trim(imp.Path.Value, `"`)
		if banned[path] {
			t.Errorf("mlxplan.go imports %q; the MLX planner must stay free of I/O-capable packages", path)
		}
	}
	// Package-level `var` declarations would be mutable global state a plan
	// could read; only consts and types belong here. The one intentional var
	// (mlxMeasuredWindows) is checked to stay a map literal of constant
	// basic literals — a computed or mutable form would make the planner's
	// windows depend on state, not the pack's measured evidence.
	for _, decl := range f.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.VAR {
			continue
		}
		for _, spec := range gen.Specs {
			valueSpec, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, name := range valueSpec.Names {
				if name.Name != "mlxMeasuredWindows" {
					t.Errorf("mlxplan.go declares package-level var %s; only consts and types belong in the planner", name.Name)
				}
			}
		}
	}
	if err := checkMeasuredWindowsShape(f); err != nil {
		t.Errorf("mlxMeasuredWindows is not the constant map literal the planner promises: %v", err)
	}
}

// checkMeasuredWindowsShape asserts that a parsed file declares
// mlxMeasuredWindows as a map composite literal whose keys and values are all
// constant basic literals (an INT basic literal, possibly negated). It returns
// a descriptive error otherwise, so the negative subtest below can prove the
// check has teeth on synthetic input.
func checkMeasuredWindowsShape(f *ast.File) error {
	var spec *ast.ValueSpec
	for _, decl := range f.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.VAR {
			continue
		}
		for _, s := range gen.Specs {
			vs, ok := s.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, name := range vs.Names {
				if name.Name == "mlxMeasuredWindows" {
					spec = vs
				}
			}
		}
	}
	if spec == nil {
		return errors.New("no package-level var mlxMeasuredWindows declared")
	}
	if len(spec.Values) != 1 {
		return fmt.Errorf("mlxMeasuredWindows has %d values, want exactly one composite literal", len(spec.Values))
	}
	lit, ok := spec.Values[0].(*ast.CompositeLit)
	if !ok {
		return fmt.Errorf("mlxMeasuredWindows is %T, want a map composite literal", spec.Values[0])
	}
	if lit.Type == nil {
		return errors.New("mlxMeasuredWindows has no map type in its composite literal")
	}
	constInt := func(expr ast.Expr) error {
		switch e := expr.(type) {
		case *ast.BasicLit:
			if e.Kind == token.INT {
				return nil
			}
			return fmt.Errorf("literal %s is %s, want an integer constant", e.Value, e.Kind)
		case *ast.UnaryExpr:
			if inner, ok := e.X.(*ast.BasicLit); ok && e.Op == token.SUB && inner.Kind == token.INT {
				return nil
			}
			return errors.New("expression is not a negated integer literal")
		default:
			return fmt.Errorf("element %T is not a constant basic literal", expr)
		}
	}
	var errs []error
	for _, elt := range lit.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			errs = append(errs, fmt.Errorf("element %T is not a key:value entry", elt))
			continue
		}
		if err := constInt(kv.Key); err != nil {
			errs = append(errs, fmt.Errorf("map key: %w", err))
		}
		if err := constInt(kv.Value); err != nil {
			errs = append(errs, fmt.Errorf("map value: %w", err))
		}
	}
	return errors.Join(errs...)
}

// TestPlanMLXMeasuredWindowsCheckerRefuses proves the structural check above
// CAN fail: a synthetic planner file whose var is computed, mutable or not a
// constant map must be rejected.
func TestPlanMLXMeasuredWindowsCheckerRefuses(t *testing.T) {
	cases := map[string]string{
		"not a map":          "package p\n\nvar mlxMeasuredWindows = 8192\n",
		"computed value":     "package p\n\nvar n = 8192\n\nvar mlxMeasuredWindows = map[int]int{16: n}\n",
		"function call":      "package p\n\nfunc w() int { return 8192 }\n\nvar mlxMeasuredWindows = map[int]int{16: w()}\n",
		"missing entirely":   "package p\n\nconst other = 1\n",
		"non-integer values": "package p\n\nvar mlxMeasuredWindows = map[int]int{16: 8192, 18: 20480, 24: 94208, 32: 1.5}\n",
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, "synthetic.go", src, 0)
			if err != nil {
				t.Fatalf("parse synthetic: %v", err)
			}
			if err := checkMeasuredWindowsShape(f); err == nil {
				t.Fatalf("checkMeasuredWindowsShape accepted the %q shape", name)
			}
		})
	}
	// The real shape must keep passing, pinned here so a future edit that
	// breaks the checker itself is caught in the same run.
	good := "package p\n\nvar mlxMeasuredWindows = map[int]int{16: 8192, 18: 20480, 24: 94208}\n"
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "good.go", good, 0)
	if err != nil {
		t.Fatalf("parse good: %v", err)
	}
	if err := checkMeasuredWindowsShape(f); err != nil {
		t.Fatalf("checkMeasuredWindowsShape refused the real shape: %v", err)
	}
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// TestResolveMLXEndToEnd runs the whole resolution path for the engine: the
// artifact set is the engine stack plus the pack, the backend records Metal,
// the packing reason explains the absence of a packing, and the context
// mirrors the plan.
func TestResolveMLXEndToEnd(t *testing.T) {
	res, err := Resolve(ResolveInput{
		MachineProfile: MachineProfile{Platform: PlatformDarwinARM64, RAMGiB: 24},
		Engine:         EngineMTPLX,
	})
	if err != nil {
		t.Fatalf("Resolve(mtplx, darwin-arm64, 24): %v", err)
	}
	if res.Engine != EngineMTPLX {
		t.Fatalf("Engine = %q, want mtplx", res.Engine)
	}
	if res.Backend != BackendMetal {
		t.Fatalf("Backend = %q, want metal (the accelerator MLX runs on)", res.Backend)
	}
	if res.PackingReason != PackingReasonMLXPack {
		t.Fatalf("PackingReason = %q, want mlx_pack", res.PackingReason)
	}
	if res.ContextSize != 94208 {
		t.Fatalf("ContextSize = %d, want the measured 94208", res.ContextSize)
	}
	wantLen := 1 + len(EngineWheels()) + len(MLXPackFiles())
	if len(res.Assets) != wantLen {
		t.Fatalf("Assets = %d, want 1 python + %d wheels + %d pack files",
			len(res.Assets), len(EngineWheels()), len(MLXPackFiles()))
	}
	if res.NeedsCudart {
		t.Fatal("NeedsCudart true on the mtplx engine")
	}
	if res.Memory.ContextSize != res.ContextSize {
		t.Fatalf("Memory.ContextSize %d disagrees with ContextSize %d", res.Memory.ContextSize, res.ContextSize)
	}
	// One pool, one number — the two projections must be the SAME bytes.
	if res.Memory.ExpectedDeviceMiB != res.Memory.ExpectedHostMiB {
		t.Fatalf("device/host projections differ (%d/%d) on a unified-pool engine",
			res.Memory.ExpectedDeviceMiB, res.Memory.ExpectedHostMiB)
	}
}

func TestResolveMLXRefusesOtherPlatforms(t *testing.T) {
	for _, platform := range []string{PlatformLinuxAMD64, PlatformDarwinAMD64, PlatformWindowsAMD64} {
		_, err := Resolve(ResolveInput{
			MachineProfile: MachineProfile{Platform: platform, RAMGiB: 64},
			Engine:         EngineMTPLX,
		})
		if !errors.Is(err, ErrEngineUnsupportedPlatform) {
			t.Fatalf("Resolve(mtplx, %s) error = %v, want ErrEngineUnsupportedPlatform", platform, err)
		}
	}
}

// TestCheckMemoryBudgetMLX keeps the desktop RPC's pre-download gate honest
// for the engine: it refuses the same machine the planner refuses, and passes
// the one it admits.
func TestCheckMemoryBudgetMLX(t *testing.T) {
	err := CheckMemoryBudget(ResolveInput{
		MachineProfile: MachineProfile{Platform: PlatformDarwinARM64, RAMGiB: 12},
		Engine:         EngineMTPLX,
	})
	if !errors.Is(err, ErrInsufficientMemory) {
		t.Fatalf("CheckMemoryBudget(12 GiB) error = %v, want ErrInsufficientMemory", err)
	}
	if err := CheckMemoryBudget(ResolveInput{
		MachineProfile: MachineProfile{Platform: PlatformDarwinARM64, RAMGiB: 24},
		Engine:         EngineMTPLX,
	}); err != nil {
		t.Fatalf("CheckMemoryBudget(24 GiB): %v", err)
	}
}
