package e2s

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
)

// testClock is a fixed timestamp for deterministic merge assertions.
var testClock = time.Date(2026, 9, 12, 8, 0, 0, 0, time.UTC)

// mergeOpts builds deterministic MergeOptions. A zero limit disables the
// byte check unless overridden.
func mergeOpts(limit int) MergeOptions {
	return MergeOptions{StateByteLimit: limit, Now: testClock}
}

// TestNewE2SStateCanonicalCore verifies the constructor produces the
// canonical initial state: every core key present with its fixed JSON type,
// status active, the schema fingerprint stamped, zero turns, and both
// timestamps set to now.
func TestNewE2SStateCanonicalCore(t *testing.T) {
	state := NewE2SState("ship the release", testClock)

	want := map[string]any{
		CoreKeyObjective:    "ship the release",
		CoreKeyChecklist:    []any{},
		CoreKeyFilesTouched: []any{},
		CoreKeyFindings:     []any{},
		CoreKeyDecisions:    []any{},
		CoreKeyNextSteps:    []any{},
		CoreKeyDoneCriteria: []any{},
		CoreKeyStatus:       string(StateStatusActive),
	}
	if !reflect.DeepEqual(state.Sigma, want) {
		t.Fatalf("initial Σ = %v, want %v", state.Sigma, want)
	}
	if state.Schema != SchemaFingerprint() {
		t.Errorf("schema fingerprint = %q, want %q", state.Schema, SchemaFingerprint())
	}
	if state.TurnCount != 0 {
		t.Errorf("TurnCount = %d, want 0", state.TurnCount)
	}
	if state.Status != StateStatusActive {
		t.Errorf("Status = %q, want %q", state.Status, StateStatusActive)
	}
	if !state.CreatedAt.Equal(testClock) || !state.UpdatedAt.Equal(testClock) {
		t.Errorf("timestamps = %v/%v, want both %v", state.CreatedAt, state.UpdatedAt, testClock)
	}
}

// TestE2SStateJSONRoundTrip pins the persistence contract: E2SState must
// survive a marshal→unmarshal cycle with Σ, bookkeeping, and timestamps
// intact (Σ values are JSON-shaped, so DeepEqual holds after the cycle).
func TestE2SStateJSONRoundTrip(t *testing.T) {
	state, err := ApplyPatch(NewE2SState("objective text", testClock), StatePatch{
		CoreKeyFindings:  []any{"auth lives in core/middleware.go"},
		CoreKeyChecklist: []any{map[string]any{"text": "write tests", "checked": false}},
		"scratch_note":   "extension value",
		"scratch_num":    float64(2), // arbitrary JSON shape lives in an extension key
	}, mergeOpts(0))
	if err != nil {
		t.Fatalf("ApplyPatch: %v", err)
	}

	data, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var restored E2SState
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if !reflect.DeepEqual(restored.Sigma, state.Sigma) {
		t.Errorf("Σ round-trip mismatch:\n got %v\nwant %v", restored.Sigma, state.Sigma)
	}
	if restored.Schema != state.Schema || restored.TurnCount != state.TurnCount ||
		restored.Status != state.Status {
		t.Errorf("bookkeeping round-trip mismatch: %+v vs %+v", restored, state)
	}
	if !restored.CreatedAt.Equal(state.CreatedAt) || !restored.UpdatedAt.Equal(state.UpdatedAt) {
		t.Errorf("timestamps round-trip mismatch: %v/%v vs %v/%v",
			restored.CreatedAt, restored.UpdatedAt, state.CreatedAt, state.UpdatedAt)
	}
}

// TestApplyPatchCoreKeyUpdateSameType verifies core keys are freely
// updatable while their JSON type stays fixed.
func TestApplyPatchCoreKeyUpdateSameType(t *testing.T) {
	state := NewE2SState("old objective", testClock)

	next, err := ApplyPatch(state, StatePatch{
		CoreKeyObjective:    "new objective",
		CoreKeyFilesTouched: []any{"core/e2s/merge.go"},
		CoreKeyStatus:       string(StateStatusPaused),
	}, mergeOpts(0))
	if err != nil {
		t.Fatalf("ApplyPatch: %v", err)
	}

	if got := next.Sigma[CoreKeyObjective]; got != "new objective" {
		t.Errorf("objective = %v, want %q", got, "new objective")
	}
	if got := next.Sigma[CoreKeyFilesTouched]; !reflect.DeepEqual(got, []any{"core/e2s/merge.go"}) {
		t.Errorf("files_touched = %v, want one entry", got)
	}
	if next.Status != StateStatusPaused {
		t.Errorf("Status = %q, want %q (synced from core key)", next.Status, StateStatusPaused)
	}
}

// TestApplyPatchNullDeletesExtensionKey pins the null-deletion primitive: a
// nil patch value deletes an extension key from Σ; a null against an absent
// key is a harmless no-op.
func TestApplyPatchNullDeletesExtensionKey(t *testing.T) {
	state := NewE2SState("obj", testClock)
	state, err := ApplyPatch(state, StatePatch{"scratch": "temporary"}, mergeOpts(0))
	if err != nil {
		t.Fatalf("seed extension: %v", err)
	}

	next, err := ApplyPatch(state, StatePatch{"scratch": nil, "ghost": nil}, mergeOpts(0))
	if err != nil {
		t.Fatalf("null deletion: %v", err)
	}
	if _, exists := next.Sigma["scratch"]; exists {
		t.Error("scratch key must be deleted by the null tombstone")
	}
	if _, exists := next.Sigma["ghost"]; exists {
		t.Error("ghost key must stay absent (null on absent key is a no-op)")
	}
	if _, exists := next.Sigma[CoreKeyObjective]; !exists {
		t.Error("core keys must survive an unrelated deletion")
	}
}

// TestApplyPatchCoreKeyDeletionForbidden walks the whole fixed core set: a
// null tombstone against ANY core key is a validation error.
func TestApplyPatchCoreKeyDeletionForbidden(t *testing.T) {
	state := NewE2SState("obj", testClock)
	for _, key := range CoreKeys() {
		_, err := ApplyPatch(state, StatePatch{key: nil}, mergeOpts(0))
		if !errors.Is(err, ErrDeleteCoreKey) {
			t.Errorf("deleting core key %q: got %v, want ErrDeleteCoreKey", key, err)
		}
	}
}

// TestApplyPatchCoreKeyRetypeForbidden verifies re-typing: every core key
// rejects a value of a JSON type other than its frozen one.
func TestApplyPatchCoreKeyRetypeForbidden(t *testing.T) {
	state := NewE2SState("obj", testClock)

	for key, wrong := range map[string]any{
		CoreKeyObjective:    []any{"not a string"},
		CoreKeyChecklist:    "not an array",
		CoreKeyFilesTouched: map[string]any{"not": "an array"},
		CoreKeyFindings:     float64(42),
		CoreKeyDecisions:    true,
		CoreKeyNextSteps:    map[string]any{},
		CoreKeyDoneCriteria: "string",
		CoreKeyStatus:       float64(7),
	} {
		_, err := ApplyPatch(state, StatePatch{key: wrong}, mergeOpts(0))
		if !errors.Is(err, ErrCoreKeyType) {
			t.Errorf("re-typing %q to %T: got %v, want ErrCoreKeyType", key, wrong, err)
		}
	}
}

// TestApplyPatchCoreArrayElementShape verifies the element-shape rule for the
// core list keys: checklist holds {text, checked} objects and every other list
// key holds strings. A wrong-shaped element is rejected by the merge operator
// (so the UI's Σ guard can never be handed an element it would have to drop).
func TestApplyPatchCoreArrayElementShape(t *testing.T) {
	state := NewE2SState("obj", testClock)

	illegal := map[string]StatePatch{
		"checklist_bare_string":  {CoreKeyChecklist: []any{"fix the bug"}},
		"checklist_missing_flag": {CoreKeyChecklist: []any{map[string]any{"text": "x"}}},
		"checklist_bad_text":     {CoreKeyChecklist: []any{map[string]any{"text": float64(3), "checked": true}}},
		"checklist_bad_checked":  {CoreKeyChecklist: []any{map[string]any{"text": "x", "checked": "yes"}}},
		"findings_non_string":    {CoreKeyFindings: []any{float64(2)}},
		"next_steps_object":      {CoreKeyNextSteps: []any{map[string]any{"a": "b"}}},
	}
	for name, patch := range illegal {
		_, err := ApplyPatch(state, patch, mergeOpts(0))
		if !errors.Is(err, ErrCoreKeyElement) {
			t.Errorf("%s: got %v, want ErrCoreKeyElement", name, err)
		}
	}

	// Conforming shapes are accepted.
	next, err := ApplyPatch(state, StatePatch{
		CoreKeyChecklist:    []any{map[string]any{"text": "write tests", "checked": true}},
		CoreKeyFilesTouched: []any{"core/e2s/merge.go"},
	}, mergeOpts(0))
	if err != nil {
		t.Fatalf("conforming arrays rejected: %v", err)
	}
	want := []any{map[string]any{"text": "write tests", "checked": true}}
	if got := next.Sigma[CoreKeyChecklist]; !reflect.DeepEqual(got, want) {
		t.Errorf("checklist = %v, want %v", got, want)
	}
}

// TestApplyPatchStatusEnum verifies the core status key is validated against
// the closed status set: legal values merge (and sync the typed field),
// illegal strings and non-strings are rejected.
func TestApplyPatchStatusEnum(t *testing.T) {
	state := NewE2SState("obj", testClock)

	for _, legal := range StateStatuses() {
		next, err := ApplyPatch(state, StatePatch{CoreKeyStatus: string(legal)}, mergeOpts(0))
		if err != nil {
			t.Errorf("status %q: unexpected error %v", legal, err)
			continue
		}
		if next.Status != legal {
			t.Errorf("status %q: typed Status = %q, want sync", legal, next.Status)
		}
	}

	for _, illegal := range []any{"bogus", "", "ACTIVE"} {
		_, err := ApplyPatch(state, StatePatch{CoreKeyStatus: illegal}, mergeOpts(0))
		if !errors.Is(err, ErrInvalidStatus) {
			t.Errorf("status %v: got %v, want ErrInvalidStatus", illegal, err)
		}
	}
}

// TestApplyPatchExtensionAddOnly pins the add-only rule for extension keys:
// a fresh key is added, a second value write against it is rejected, and the
// universal null tombstone may remove it (after which it can be re-added).
func TestApplyPatchExtensionAddOnly(t *testing.T) {
	state := NewE2SState("obj", testClock)

	next, err := ApplyPatch(state, StatePatch{"metric": "p95=120ms"}, mergeOpts(0))
	if err != nil {
		t.Fatalf("add extension: %v", err)
	}
	if got := next.Sigma["metric"]; got != "p95=120ms" {
		t.Fatalf("extension value = %v, want %q", got, "p95=120ms")
	}

	_, err = ApplyPatch(next, StatePatch{"metric": "p95=90ms"}, mergeOpts(0))
	if !errors.Is(err, ErrExtensionKeyExists) {
		t.Fatalf("modify extension: got %v, want ErrExtensionKeyExists", err)
	}

	afterDelete, err := ApplyPatch(next, StatePatch{"metric": nil}, mergeOpts(0))
	if err != nil {
		t.Fatalf("delete extension via null: %v", err)
	}
	if _, exists := afterDelete.Sigma["metric"]; exists {
		t.Fatal("extension must be gone after the null tombstone")
	}

	if _, err := ApplyPatch(afterDelete, StatePatch{"metric": "re-added"}, mergeOpts(0)); err != nil {
		t.Fatalf("re-add after delete: %v", err)
	}
}

// TestApplyPatchStateByteLimit verifies the Σ size cap: a patch whose merged
// Σ exceeds the configured byte limit fails with ErrStateTooLarge, a fitting
// patch passes, and the failing patch leaves the input state untouched.
func TestApplyPatchStateByteLimit(t *testing.T) {
	// Hand-built minimal state (empty Schema skips the fingerprint check).
	base := E2SState{Sigma: map[string]any{"objective": "x"}, Status: StateStatusActive, CreatedAt: testClock, UpdatedAt: testClock}

	big := StatePatch{"blob": strings.Repeat("x", 500)}
	_, err := ApplyPatch(base, big, mergeOpts(64))
	if !errors.Is(err, ErrStateTooLarge) {
		t.Fatalf("oversized patch: got %v, want ErrStateTooLarge", err)
	}
	if SigmaBytes(base.Sigma) > 64 {
		t.Fatalf("test setup: base Σ (%d bytes) already exceeds the 64-byte limit", SigmaBytes(base.Sigma))
	}

	if _, err := ApplyPatch(base, StatePatch{"ok": "small"}, mergeOpts(64)); err != nil {
		t.Fatalf("fitting patch rejected: %v", err)
	}

	// The failed merge must not have mutated the input Σ.
	if _, exists := base.Sigma["blob"]; exists {
		t.Error("failed patch leaked into the input state")
	}
}

// TestApplyPatchInputNeverMutated verifies atomicity: after a rejected
// patch, the receiver's Σ is byte-identical to its pre-call snapshot.
func TestApplyPatchInputNeverMutated(t *testing.T) {
	state := NewE2SState("obj", testClock)
	before, _ := json.Marshal(state.Sigma)

	_, err := ApplyPatch(state, StatePatch{CoreKeyObjective: nil, "new": 1}, mergeOpts(0))
	if err == nil {
		t.Fatal("expected a validation error")
	}

	after, _ := json.Marshal(state.Sigma)
	if !bytes.Equal(before, after) {
		t.Errorf("input Σ mutated by a rejected patch:\n before %s\n after %s", before, after)
	}
}

// TestApplyPatchTurnBookkeeping verifies each applied patch bumps the turn
// count, stamps UpdatedAt from the options, and preserves CreatedAt — even
// for an empty patch (a turn happened).
func TestApplyPatchTurnBookkeeping(t *testing.T) {
	state := NewE2SState("obj", testClock)

	next, err := ApplyPatch(state, nil, mergeOpts(0))
	if err != nil {
		t.Fatalf("empty patch: %v", err)
	}
	if next.TurnCount != state.TurnCount+1 {
		t.Errorf("TurnCount = %d, want %d", next.TurnCount, state.TurnCount+1)
	}
	if !next.UpdatedAt.Equal(testClock) {
		t.Errorf("UpdatedAt = %v, want %v", next.UpdatedAt, testClock)
	}
	if !next.CreatedAt.Equal(state.CreatedAt) {
		t.Errorf("CreatedAt changed: %v → %v", state.CreatedAt, next.CreatedAt)
	}
}

// TestApplyPatchEmptyKeyRejected verifies the empty-key guard.
func TestApplyPatchEmptyKeyRejected(t *testing.T) {
	state := NewE2SState("obj", testClock)
	if _, err := ApplyPatch(state, StatePatch{"": "value"}, mergeOpts(0)); !errors.Is(err, ErrEmptyKey) {
		t.Fatalf("got %v, want ErrEmptyKey", err)
	}
}

// TestApplyPatchSchemaMismatch verifies fail-closed schema evolution: a
// state stamped with a foreign fingerprint is rejected instead of being
// silently patched under the compiled-in schema.
func TestApplyPatchSchemaMismatch(t *testing.T) {
	state := NewE2SState("obj", testClock)
	state.Schema = "0000-not-a-real-fingerprint"
	if _, err := ApplyPatch(state, StatePatch{"k": 1}, mergeOpts(0)); !errors.Is(err, ErrSchemaMismatch) {
		t.Fatalf("got %v, want ErrSchemaMismatch", err)
	}
}

// TestApplyRawPatch verifies the JSON-level entry point used by the E2S loop:
// raw values decode into their JSON shapes, a raw null acts as the deletion
// tombstone, and malformed JSON fails the whole patch atomically.
func TestApplyRawPatch(t *testing.T) {
	state, err := ApplyRawPatch(NewE2SState("obj", testClock), map[string]json.RawMessage{
		"scratch": json.RawMessage(`{"nested":true}`),
	}, mergeOpts(0))
	if err != nil {
		t.Fatalf("ApplyRawPatch: %v", err)
	}
	if got := state.Sigma["scratch"]; !reflect.DeepEqual(got, map[string]any{"nested": true}) {
		t.Fatalf("scratch = %#v, want decoded object", got)
	}

	next, err := ApplyRawPatch(state, map[string]json.RawMessage{
		"scratch": json.RawMessage(`null`),
	}, mergeOpts(0))
	if err != nil {
		t.Fatalf("null tombstone: %v", err)
	}
	if _, exists := next.Sigma["scratch"]; exists {
		t.Fatal("raw null must delete the extension key")
	}

	if _, err := ApplyRawPatch(state, map[string]json.RawMessage{
		"bad": json.RawMessage(`{not json`),
	}, mergeOpts(0)); err == nil {
		t.Fatal("malformed JSON must fail the patch")
	}
}

// TestStepActionValidate pins the action contract on the runtime envelope
// type (declared in steptool.go): a step names either a target tool or
// "finish", and a finish always carries an answer.
func TestStepActionValidate(t *testing.T) {
	tests := []struct {
		name    string
		action  StepAction
		wantErr error
	}{
		{name: "tool call", action: StepAction{Tool: "read_file", Args: json.RawMessage(`{}`)}},
		{name: "tool call no args", action: StepAction{Tool: "list_directory"}},
		{name: "finish with answer", action: StepAction{Tool: FinishActionName, Args: json.RawMessage(`{}`), Answer: "done"}},
		{name: "empty action", action: StepAction{}, wantErr: ErrActionEmpty},
		{name: "finish without answer", action: StepAction{Tool: FinishActionName}, wantErr: ErrActionNoAnswer},
	}
	for _, tc := range tests {
		err := tc.action.Validate()
		if !errors.Is(err, tc.wantErr) {
			t.Errorf("%s: got %v, want %v", tc.name, err, tc.wantErr)
		}
		if tc.action.IsFinish() != (tc.action.Tool == FinishActionName) {
			t.Errorf("%s: IsFinish disagrees with the tool name", tc.name)
		}
	}
}

// TestSchemaFingerprintStable pins fingerprint determinism: identical calls
// produce identical 64-hex-char digests, and the constructor stamps it.
func TestSchemaFingerprintStable(t *testing.T) {
	first, second := SchemaFingerprint(), SchemaFingerprint()
	if first != second {
		t.Fatalf("fingerprint is not deterministic: %q vs %q", first, second)
	}
	if len(first) != 64 {
		t.Errorf("fingerprint len = %d, want 64 hex chars (sha256)", len(first))
	}
	if NewE2SState("obj", testClock).Schema != first {
		t.Error("NewE2SState must stamp the current fingerprint")
	}
}

// TestSigmaBytes verifies the size measure behind StateByteLimit: plain
// JSON length for encodable Σ, math.MaxInt for unencodable values.
func TestSigmaBytes(t *testing.T) {
	if got := SigmaBytes(map[string]any{}); got != 2 {
		t.Errorf("empty Σ = %d bytes, want 2 ({})", got)
	}
	if got := SigmaBytes(map[string]any{"a": "b"}); got != len(`{"a":"b"}`) {
		t.Errorf("Σ {a:b} = %d bytes, want %d", got, len(`{"a":"b"}`))
	}
	if got := SigmaBytes(map[string]any{"ch": make(chan int)}); got != math.MaxInt {
		t.Errorf("unencodable Σ = %d, want math.MaxInt", got)
	}
}

// TestCoreKeySetComplete guards the frozen core schema: exactly the eight
// documented keys, each with a declared type.
func TestCoreKeySetComplete(t *testing.T) {
	want := []string{
		CoreKeyChecklist, CoreKeyDecisions, CoreKeyDoneCriteria, CoreKeyFilesTouched,
		CoreKeyFindings, CoreKeyNextSteps, CoreKeyObjective, CoreKeyStatus,
	}
	got := CoreKeys()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("CoreKeys() = %v, want %v", got, want)
	}
	for _, key := range got {
		if !IsCoreKey(key) {
			t.Errorf("IsCoreKey(%q) = false, want true", key)
		}
	}
	if IsCoreKey("not_core") {
		t.Error(`IsCoreKey("not_core") = true, want false`)
	}
}
