package e2s

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/v0lka/sp4rk/agent"
	"github.com/v0lka/sp4rk/llm"
	sdktools "github.com/v0lka/sp4rk/tools"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// scriptedCaller returns canned responses in order and records every request.
type scriptedCaller struct {
	mu        sync.Mutex
	responses []*llm.ChatResponse
	errs      []error
	requests  []llm.ChatRequest
}

func (c *scriptedCaller) Call(_ context.Context, req llm.ChatRequest) (*llm.ChatResponse, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, req)
	idx := len(c.requests) - 1
	if idx < len(c.errs) && c.errs[idx] != nil {
		return nil, c.errs[idx]
	}
	if idx >= len(c.responses) {
		return nil, fmt.Errorf("scriptedCaller: unexpected call #%d (no response scripted)", idx+1)
	}
	return c.responses[idx], nil
}

func (c *scriptedCaller) request(i int) llm.ChatRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.requests[i]
}

func (c *scriptedCaller) callCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.requests)
}

// stepResponse builds a ChatResponse carrying one e2s_step tool call.
func stepResponse(patch, tool, args string) *llm.ChatResponse {
	input := fmt.Sprintf(`{"state_patch":%s,"action":{"tool":%q,"args":%s}}`, patch, tool, args)
	return &llm.ChatResponse{
		Message: llm.Message{
			Role:      "assistant",
			ToolCalls: []llm.ToolCall{{ID: "call_1", Name: StepToolName, Input: json.RawMessage(input)}},
		},
		Reasoning: "thinking about it",
	}
}

// rawToolResponse builds a ChatResponse whose assistant calls an arbitrary tool.
func rawToolResponse(name, input string) *llm.ChatResponse {
	return &llm.ChatResponse{
		Message: llm.Message{
			Role:      "assistant",
			ToolCalls: []llm.ToolCall{{ID: "call_1", Name: name, Input: json.RawMessage(input)}},
		},
	}
}

// mockRegistry records Execute dispatches and returns canned results.
type mockRegistry struct {
	mu          sync.Mutex
	descriptors []sdktools.ToolDescriptor
	dispatches  []dispatchRecord
	untrusted   map[string]bool
}

type dispatchRecord struct {
	name string
	args json.RawMessage
}

func (r *mockRegistry) List() []sdktools.ToolDescriptor { return r.descriptors }

func (r *mockRegistry) Execute(_ context.Context, name string, input json.RawMessage) (sdktools.ToolResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dispatches = append(r.dispatches, dispatchRecord{name: name, args: input})
	if name == "boom" {
		return sdktools.ToolResult{}, errors.New("registry exploded")
	}
	if name == "bad_tool" {
		return sdktools.ToolResult{Content: "tool failed", IsError: true}, nil
	}
	return sdktools.ToolResult{Content: "ok result for " + name, IsError: false}, nil
}

func (r *mockRegistry) IsToolUntrusted(name string) bool { return r.untrusted[name] }

func (r *mockRegistry) dispatched() []dispatchRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]dispatchRecord, len(r.dispatches))
	copy(out, r.dispatches)
	return out
}

// recordingEmitter captures every emitted event, including the optional
// e2s_state capability.
type recordingEmitter struct {
	mu       sync.Mutex
	events   []string
	states   []map[string]any
	thoughts []string
}

func (e *recordingEmitter) record(kind string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, kind)
}

func (e *recordingEmitter) StepStart(int) { e.record("StepStart") }
func (e *recordingEmitter) Thought(_ int, content, _ string) {
	e.mu.Lock()
	e.thoughts = append(e.thoughts, content)
	e.mu.Unlock()
}
func (e *recordingEmitter) ToolCall(_, _ int, toolName, _, _ string) {
	e.record("ToolCall:" + toolName)
}
func (e *recordingEmitter) ToolResult(_, _, _ int, _ string, _ bool) { e.record("ToolResult") }
func (e *recordingEmitter) StepComplete(int, time.Duration)          { e.record("StepComplete") }
func (e *recordingEmitter) AssistantChunk(string)                    { e.record("AssistantChunk") }
func (e *recordingEmitter) AssistantDone(string, int, int)           { e.record("AssistantDone") }
func (e *recordingEmitter) ContextFill(float64, int, int, string, string) {
	e.record("ContextFill")
}
func (e *recordingEmitter) Finishing(int, string) { e.record("Finishing") }
func (e *recordingEmitter) ExecutorDiagnostic(_ int, event string, _ map[string]any) {
	e.record("Diagnostic:" + event)
}

// E2SState implements the optional StateEmitter capability.
func (e *recordingEmitter) E2SState(data map[string]any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.states = append(e.states, data)
}

func (e *recordingEmitter) eventList() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]string, len(e.events))
	copy(out, e.events)
	return out
}

func (e *recordingEmitter) stateCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.states)
}

func (e *recordingEmitter) stateAt(i int) map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.states[i]
}

// memTrajectory is an in-memory agent.TrajectoryStore.
type memTrajectory struct {
	mu    sync.Mutex
	steps []agent.Step
}

func (t *memTrajectory) Sync(steps []agent.Step) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.steps = append([]agent.Step(nil), steps...)
}

func (t *memTrajectory) Steps() []agent.Step {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.steps
}

func testConfig() Config {
	return Config{
		Model:  "test-model",
		Task:   "count to three",
		Logger: slogDiscard(),
	}
}

// ---------------------------------------------------------------------------
// Acceptance: one LLM call per step; no history leaks between steps
// ---------------------------------------------------------------------------

func TestRun_FreshOneShotDialogPerStep(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{"scratchpad":"turn one"}`, "alpha", `{"q":1}`),
		stepResponse(`{}`, "beta", `{"q":2}`),
		stepResponse(`{}`, "finish", `{"answer":"done"}`),
	}}
	reg := &mockRegistry{}
	loop := New(caller, reg, nil, testConfig())

	res, err := loop.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.Finished || res.Status != RunStatusFinished {
		t.Fatalf("status = %s (%v), want finished", res.Status, res.Finished)
	}

	if got := caller.callCount(); got != 3 {
		t.Fatalf("LLM call count = %d, want 3 (one per step)", got)
	}

	// Every request is a fresh one-shot dialog: exactly [system, user], no
	// assistant/tool roles, no tool calls riding along.
	for i := 0; i < 3; i++ {
		req := caller.request(i)
		if len(req.Messages) != 2 {
			t.Fatalf("request %d has %d messages, want exactly 2", i+1, len(req.Messages))
		}
		if req.Messages[0].Role != "system" || req.Messages[1].Role != "user" {
			t.Errorf("request %d roles = %s/%s, want system/user", i+1, req.Messages[0].Role, req.Messages[1].Role)
		}
		for j, m := range req.Messages {
			if len(m.ToolCalls) != 0 {
				t.Errorf("request %d message %d carries tool calls from a previous step", i+1, j)
			}
		}
	}

	// The state Σ is the ONLY thing carried forward: step 2 sees the turn-1
	// patch (by design), but step 3 must NOT see step 1's observation —
	// only the latest O₃ survives (bounded O(1) context).
	step2User := caller.request(1).Messages[1].Content
	if !strings.Contains(step2User, `"scratchpad":"turn one"`) {
		t.Error("step 2 request missing the applied state (Σ must carry forward)")
	}
	if !strings.Contains(step2User, "ok result for alpha") {
		t.Error("step 2 request missing observation O₂ (alpha result)")
	}
	step3User := caller.request(2).Messages[1].Content
	if !strings.Contains(step3User, "ok result for beta") {
		t.Error("step 3 request missing observation O₃ (beta result)")
	}
	if strings.Contains(step3User, "ok result for alpha") {
		t.Error("step 1 observation leaked into step 3 request — context is not O(1)")
	}
	// Turn markers advance.
	if !strings.Contains(step2User, "[turn 2]") || !strings.Contains(step3User, "[turn 3]") {
		t.Error("turn markers missing from user messages")
	}
	// The model's reasoning never rides along.
	for i := 0; i < 3; i++ {
		if strings.Contains(caller.request(i).Messages[1].Content, "thinking about it") {
			t.Errorf("request %d user message contains assistant reasoning", i+1)
		}
	}
	// Exactly one tool definition is offered: the e2s_step envelope.
	req := caller.request(0)
	if len(req.Tools) != 1 || req.Tools[0].Name != StepToolName {
		t.Errorf("tool definitions = %v, want exactly [e2s_step]", req.Tools)
	}
}

// TestRun_AttachesContentBlocksToEveryTurn pins the image-threading contract:
// configured ContentBlocks ride on EVERY turn's user message (each turn is a
// fresh dialog, so the model must keep seeing them), while the per-turn Σ +
// observation text stays in Content.
func TestRun_AttachesContentBlocksToEveryTurn(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{}`, "alpha", `{"q":1}`),
		stepResponse(`{}`, "finish", `{"answer":"done"}`),
	}}
	reg := &mockRegistry{}
	cfg := testConfig()
	cfg.ContentBlocks = []llm.ContentBlock{{Type: "image", ImageB64: "AAAA", MediaType: "image/png"}}
	loop := New(caller, reg, nil, cfg)

	if _, err := loop.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if caller.callCount() != 2 {
		t.Fatalf("LLM call count = %d, want 2", caller.callCount())
	}
	for i := 0; i < 2; i++ {
		msg := caller.request(i).Messages[1]
		if len(msg.ContentBlocks) != 1 || msg.ContentBlocks[0].Type != "image" || msg.ContentBlocks[0].ImageB64 != "AAAA" {
			t.Errorf("request %d user ContentBlocks = %+v, want the staged image on every turn", i+1, msg.ContentBlocks)
		}
		if msg.Content == "" {
			t.Errorf("request %d user Content is empty; the turn text must remain", i+1)
		}
	}
}

// ---------------------------------------------------------------------------
// Acceptance: action dispatch goes through Registry.Execute
// ---------------------------------------------------------------------------

func TestRun_DispatchesActionThroughRegistry(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{}`, "read_file", `{"path":"a.txt"}`),
		stepResponse(`{}`, "finish", `{"answer":"read it"}`),
	}}
	reg := &mockRegistry{}
	loop := New(caller, reg, nil, testConfig())

	if _, err := loop.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	dispatches := reg.dispatched()
	if len(dispatches) != 1 {
		t.Fatalf("registry dispatches = %d, want 1", len(dispatches))
	}
	if dispatches[0].name != "read_file" {
		t.Errorf("dispatched tool = %q, want read_file", dispatches[0].name)
	}
	var args map[string]any
	if err := json.Unmarshal(dispatches[0].args, &args); err != nil {
		t.Fatalf("dispatch args not JSON: %v", err)
	}
	if args["path"] != "a.txt" {
		t.Errorf("dispatch args = %v, want path a.txt", args)
	}
}

// ---------------------------------------------------------------------------
// Acceptance: finish terminates the loop and carries the answer
// ---------------------------------------------------------------------------

func TestRun_FinishTerminatesWithAnswer(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{"findings":["f1"]}`, "finish", `{"answer":"the final answer"}`),
	}}
	em := &recordingEmitter{}
	loop := New(caller, &mockRegistry{}, em, testConfig())

	res, err := loop.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Answer != "the final answer" {
		t.Errorf("answer = %q, want the final answer", res.Answer)
	}
	if !res.Finished {
		t.Error("Finished = false, want true")
	}
	if res.Turns != 1 {
		t.Errorf("turns = %d, want 1", res.Turns)
	}
	events := em.eventList()
	if !contains(events, "Finishing") {
		t.Errorf("Finishing event not emitted: %v", events)
	}
	if !contains(events, "AssistantChunk") || !contains(events, "AssistantDone") {
		t.Errorf("assistant events not emitted for finish answer: %v", events)
	}
	// The last trajectory step records the finish action with the answer.
	if n := len(res.Steps); n != 1 {
		t.Fatalf("trajectory steps = %d, want 1", n)
	}
	last := res.Steps[0]
	if last.Action.Name != "finish" {
		t.Errorf("last step action = %q, want finish", last.Action.Name)
	}
	if !strings.Contains(string(last.Action.Input), "the final answer") {
		t.Errorf("last step input = %s, want the answer embedded", last.Action.Input)
	}
	// The finish-turn patch was applied before finishing.
	if got := res.Snapshot.Sigma["findings"]; fmt.Sprint(got) != "[f1]" {
		t.Errorf("finish-turn patch not applied: findings = %v", got)
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Acceptance: invalid patch → bounded retry → error observation, Σ intact
// ---------------------------------------------------------------------------

func TestRun_InvalidPatchRetriesOnceThenErrorObservation(t *testing.T) {
	// Turn 1: patch violates the domain schema (objective re-typed to a
	// number). Retry: still invalid. Then the turn's error becomes O₂.
	// Turn 2 (new step): valid finish.
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		rawStepResponse(`{"state_patch":{"objective":42},"action":{"tool":"probe","args":{}}}`),
		rawStepResponse(`{"state_patch":{"objective":43},"action":{"tool":"probe","args":{}}}`),
		stepResponse(`{}`, "finish", `{"answer":"recovered"}`),
	}}
	reg := &mockRegistry{}
	em := &recordingEmitter{}
	loop := New(caller, reg, em, testConfig())

	res, err := loop.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != RunStatusFinished {
		t.Fatalf("status = %s, want finished (loop must survive invalid turns)", res.Status)
	}

	// Exactly one extra call (the bounded retry) — not more.
	if got := caller.callCount(); got != 3 {
		t.Fatalf("LLM calls = %d, want 3 (turn + one retry + final turn)", got)
	}
	// The retry request carries the correction tail.
	retryUser := caller.request(1).Messages[1].Content
	if !strings.Contains(retryUser, "<correction>") {
		t.Error("retry user message missing correction tail")
	}
	// The invalid action was never dispatched.
	if d := reg.dispatched(); len(d) != 0 {
		t.Errorf("invalid turn leaked into dispatch: %v", d)
	}
	// Σ was not damaged: objective keeps its seeded string value.
	if got, _ := res.Snapshot.Sigma[CoreKeyObjective].(string); got != "count to three" {
		t.Errorf("objective = %v, want untouched string", res.Snapshot.Sigma[CoreKeyObjective])
	}
	// The invalid turn surfaced as an error observation in the NEXT request.
	nextUser := caller.request(2).Messages[1].Content
	if !strings.Contains(nextUser, "invalid and was NOT applied") {
		t.Errorf("next user message missing error observation: %q", nextUser)
	}
	// Trajectory records the invalid turn with IsError.
	found := false
	for _, s := range res.Steps {
		if s.Action.Name == StepToolName && s.IsError {
			found = true
		}
	}
	if !found {
		t.Error("invalid turn not recorded as an error step in the trajectory")
	}
}

func rawStepResponse(input string) *llm.ChatResponse {
	return rawToolResponse(StepToolName, input)
}

func TestRun_InvalidThenRetryRecovers(t *testing.T) {
	// Turn 1 first attempt calls the WRONG tool name (the loop offers only
	// e2s_step); the corrective retry returns a valid probe call, which
	// dispatches normally — no error observation is needed.
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		rawToolResponse("probe", `{"q":1}`),
		stepResponse(`{}`, "probe", `{"q":1}`),
		stepResponse(`{}`, "finish", `{"answer":"ok"}`),
	}}
	reg := &mockRegistry{}
	loop := New(caller, reg, nil, testConfig())

	res, err := loop.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != RunStatusFinished {
		t.Fatalf("status = %s, want finished", res.Status)
	}
	// First call was invalid (wrong tool name); the retry dispatched the
	// probe exactly once.
	if d := reg.dispatched(); len(d) != 1 || d[0].name != "probe" {
		t.Errorf("dispatches = %v, want one probe", d)
	}
}

// ---------------------------------------------------------------------------
// Acceptance: step limit stops the loop with a status
// ---------------------------------------------------------------------------

func TestRun_StepLimitStopsLoop(t *testing.T) {
	responses := make([]*llm.ChatResponse, 0, 10)
	for i := 0; i < 10; i++ {
		responses = append(responses, stepResponse(`{}`, "probe", fmt.Sprintf(`{"n":%d}`, i)))
	}
	caller := &scriptedCaller{responses: responses}
	cfg := testConfig()
	cfg.MaxSteps = 4
	loop := New(caller, &mockRegistry{}, nil, cfg)

	res, err := loop.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != RunStatusStepLimit {
		t.Errorf("status = %s, want step_limit", res.Status)
	}
	if res.Finished {
		t.Error("Finished = true on step limit, want false")
	}
	if res.Turns != 4 {
		t.Errorf("turns = %d, want 4", res.Turns)
	}
	if got := caller.callCount(); got != 4 {
		t.Errorf("LLM calls = %d, want 4", got)
	}
}

// ---------------------------------------------------------------------------
// Acceptance: anti-spin nudges then stops the loop with a status
// ---------------------------------------------------------------------------

func TestRun_AntiSpinNudgesThenStops(t *testing.T) {
	// Eight identical probe calls; nudge at 3, abort at 5 (defaults).
	responses := make([]*llm.ChatResponse, 0, 8)
	for i := 0; i < 8; i++ {
		responses = append(responses, stepResponse(`{}`, "probe", `{"q":"same"}`))
	}
	caller := &scriptedCaller{responses: responses}
	reg := &mockRegistry{}
	em := &recordingEmitter{}
	loop := New(caller, reg, em, testConfig())

	res, err := loop.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != RunStatusSpinStop {
		t.Errorf("status = %s, want spin_stop", res.Status)
	}

	events := em.eventList()
	nudges := 0
	for _, ev := range events {
		if ev == "Diagnostic:spin_nudge" {
			nudges++
		}
	}
	if nudges == 0 {
		t.Error("no spin_nudge diagnostic emitted before the stop")
	}

	// Redundant repeats were not re-dispatched: 2 executions (turns 1-2),
	// nudged from turn 3, aborted at turn 5.
	if d := reg.dispatched(); len(d) != 2 {
		t.Errorf("dispatch count = %d, want 2 (identical actions skipped after detection)", len(d))
	}
	// The nudge observation reached the model on the next turn.
	spinUser := caller.request(3).Messages[1].Content
	if !strings.Contains(spinUser, "repeated the identical action") {
		t.Errorf("turn 4 user message missing spin nudge: %q", spinUser)
	}
}

// ---------------------------------------------------------------------------
// Acceptance: e2s_state emitted after every applied patch
// ---------------------------------------------------------------------------

func TestRun_EmitsStateAfterEachAppliedPatch(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{"scratch":"one"}`, "probe", `{}`),
		stepResponse(`{"notes":"two"}`, "probe", `{}`),
		stepResponse(`{}`, "finish", `{"answer":"done"}`),
	}}
	em := &recordingEmitter{}
	loop := New(caller, &mockRegistry{}, em, testConfig())

	res, err := loop.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// Three turns, three applied patches (the finish turn's empty patch
	// still merges and bumps the domain turn count).
	if got := em.stateCount(); got != 3 {
		t.Fatalf("e2s_state emissions = %d, want 3", got)
	}
	first := em.stateAt(0)
	if first["turn"] != 1 {
		t.Errorf("first snapshot turn = %v, want 1", first["turn"])
	}
	sigma, ok := first["state"].(map[string]any)
	if !ok {
		t.Fatalf("snapshot state is %T, want map[string]any", first["state"])
	}
	if sigma["scratch"] != "one" {
		t.Errorf("snapshot Σ missing applied patch: %v", sigma)
	}
	// Snapshot turns are the domain TurnCount (patch counter).
	if em.stateAt(2)["turn"] != 3 {
		t.Errorf("last snapshot turn = %v, want 3", em.stateAt(2)["turn"])
	}
	if res.Snapshot.TurnCount != 3 {
		t.Errorf("final TurnCount = %d, want 3", res.Snapshot.TurnCount)
	}
}

// ---------------------------------------------------------------------------
// Pause, cancellation, fatal error
// ---------------------------------------------------------------------------

func TestRun_PauseCheckerStopsAtStepBoundary(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{}`, "probe", `{}`),
		stepResponse(`{}`, "finish", `{"answer":"never"}`),
	}}
	cfg := testConfig()
	cfg.PauseChecker = func(context.Context) bool { return true }
	loop := New(caller, &mockRegistry{}, nil, cfg)

	res, err := loop.Run(context.Background())
	if !errors.Is(err, ErrPaused) {
		t.Fatalf("err = %v, want ErrPaused", err)
	}
	if res.Status != RunStatusPaused {
		t.Errorf("status = %s, want paused", res.Status)
	}
	if got := caller.callCount(); got != 0 {
		t.Errorf("a paused run consumed %d LLM calls, want 0", got)
	}
}

func TestRun_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	caller := &scriptedCaller{}
	loop := New(caller, &mockRegistry{}, nil, testConfig())

	res, err := loop.Run(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if res.Status != RunStatusCanceled {
		t.Errorf("status = %s, want canceled", res.Status)
	}
}

// cancellingCaller cancels the task context from inside the call and returns
// the resulting cancellation error — modeling an app shutdown that lands while
// an LLM request is in flight.
type cancellingCaller struct{ cancel context.CancelFunc }

func (c *cancellingCaller) Call(ctx context.Context, _ llm.ChatRequest) (*llm.ChatResponse, error) {
	c.cancel()
	return nil, ctx.Err()
}

// TestRun_CancellationDuringLLMCallStaysResumable pins the mid-call shutdown
// classification: a cancellation surfaced inside the LLM request must be a
// cancellation (non-terminal, resumable checkpoint), not a fatal failure.
func TestRun_CancellationDuringLLMCallStaysResumable(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	loop := New(&cancellingCaller{cancel: cancel}, &mockRegistry{}, nil, testConfig())

	res, err := loop.Run(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if res.Status != RunStatusCanceled {
		t.Errorf("status = %s, want canceled — a mid-call shutdown must keep the checkpoint resumable, not terminal", res.Status)
	}
}

func TestRun_FatalLLMError(t *testing.T) {
	caller := &scriptedCaller{
		errs: []error{errors.New("provider down")},
	}
	loop := New(caller, &mockRegistry{}, nil, testConfig())

	res, err := loop.Run(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if res.Status != RunStatusFailed {
		t.Errorf("status = %s, want failed", res.Status)
	}
}

// ---------------------------------------------------------------------------
// Tool result plumbing
// ---------------------------------------------------------------------------

func TestRun_ToolErrorBecomesObservation(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{}`, "bad_tool", `{}`),
		stepResponse(`{}`, "boom", `{}`),
		stepResponse(`{}`, "finish", `{"answer":"survived"}`),
	}}
	loop := New(caller, &mockRegistry{}, nil, testConfig())

	res, err := loop.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != RunStatusFinished {
		t.Fatalf("status = %s, want finished", res.Status)
	}
	// IsError tool result → error observation in the next request.
	if user := caller.request(1).Messages[1].Content; !strings.Contains(user, "tool failed") {
		t.Errorf("turn 2 missing error observation: %q", user)
	}
	// Registry-level error → error observation too.
	if user := caller.request(2).Messages[1].Content; !strings.Contains(user, "tool execution error") {
		t.Errorf("turn 3 missing registry-error observation: %q", user)
	}
	// Trajectory marks both as errors.
	errSteps := 0
	for _, s := range res.Steps {
		if s.IsError {
			errSteps++
		}
	}
	if errSteps != 2 {
		t.Errorf("error steps = %d, want 2", errSteps)
	}
}

func TestRun_UntrustedResultWrapped(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{}`, "web_fetch", `{}`),
		stepResponse(`{}`, "finish", `{"answer":"done"}`),
	}}
	reg := &mockRegistry{untrusted: map[string]bool{"web_fetch": true}}
	loop := New(caller, reg, nil, testConfig())

	if _, err := loop.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	user := caller.request(1).Messages[1].Content
	if !strings.Contains(user, "<untrusted-content") {
		t.Errorf("untrusted observation not wrapped: %q", user)
	}
}

// TestRun_UntrustedErrorResultWrapped pins the error-recovery carve-out: an
// untrusted tool's ERROR diagnostic is attacker-influenceable and must be
// delivered inside the boundary exactly like successful output — wrapping is
// decided by tool class, not result type.
func TestRun_UntrustedErrorResultWrapped(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{}`, "bad_tool", `{}`),
		stepResponse(`{}`, "finish", `{"answer":"done"}`),
	}}
	reg := &mockRegistry{untrusted: map[string]bool{"bad_tool": true}}
	loop := New(caller, reg, nil, testConfig())

	if _, err := loop.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	user := caller.request(1).Messages[1].Content
	if !strings.Contains(user, "<untrusted-content") || !strings.Contains(user, "tool failed") {
		t.Errorf("untrusted error observation not wrapped: %q", user)
	}
}

func TestRun_ObservationTruncated(t *testing.T) {
	long := strings.Repeat("x", 10_000)
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		&llm.ChatResponse{Message: llm.Message{ToolCalls: []llm.ToolCall{{
			ID:    "c1",
			Name:  StepToolName,
			Input: json.RawMessage(`{"state_patch":{},"action":{"tool":"big","args":{}}}`),
		}}}},
		stepResponse(`{}`, "finish", `{"answer":"done"}`),
	}}
	reg := &bigResultRegistry{long: long}
	loop := New(caller, reg, nil, testConfig())

	if _, err := loop.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	user := caller.request(1).Messages[1].Content
	if strings.Contains(user, long) {
		t.Error("full 10k observation leaked into the request")
	}
	if !strings.Contains(user, "…") {
		t.Error("truncation marker missing")
	}
}

type bigResultRegistry struct{ long string }

func (r *bigResultRegistry) List() []sdktools.ToolDescriptor { return nil }

func (r *bigResultRegistry) Execute(_ context.Context, _ string, _ json.RawMessage) (sdktools.ToolResult, error) {
	return sdktools.ToolResult{Content: r.long}, nil
}

func (r *bigResultRegistry) IsToolUntrusted(string) bool { return false }

// ---------------------------------------------------------------------------
// Trajectory store sync
// ---------------------------------------------------------------------------

func TestRun_SyncsTrajectoryStore(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{}`, "probe", `{"q":1}`),
		stepResponse(`{}`, "finish", `{"answer":"done"}`),
	}}
	traj := &memTrajectory{}
	cfg := testConfig()
	cfg.Trajectory = traj
	loop := New(caller, &mockRegistry{}, nil, cfg)

	res, err := loop.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := traj.Steps(); len(got) != len(res.Steps) {
		t.Errorf("trajectory store steps = %d, want %d", len(got), len(res.Steps))
	}
	// Steps carry the dispatched action and its observation.
	first := traj.Steps()[0]
	if first.Action.Name != "probe" {
		t.Errorf("trajectory action = %q, want probe", first.Action.Name)
	}
	if !strings.Contains(first.Observation, "ok result for probe") {
		t.Errorf("trajectory observation = %q, want tool result", first.Observation)
	}
	if first.Thought != "thinking about it" {
		t.Errorf("trajectory thought = %q, want response reasoning", first.Thought)
	}
}

// ---------------------------------------------------------------------------
// Prompt shape
// ---------------------------------------------------------------------------

func TestSystemPrompt_Sections(t *testing.T) {
	cfg := testConfig()
	cfg.WorkspacePath = "/ws/project"
	cfg.TempDir = "/ws/tmp"
	cfg.DelegateDirective = "Delegate via delegate(agent:...)."
	cfg.Skills = []SkillSection{{Name: "explore", Description: "think first", Body: "Body of skill."}}
	reg := &mockRegistry{descriptors: []sdktools.ToolDescriptor{
		{Name: "read_file", Description: "Read a file.\nSecond line."},
		{Name: "bash_exec", Description: "Run a shell command."},
	}}

	prompt := BuildSystemPrompt(cfg, reg.List())

	for _, want := range []string{
		"E2S",          // core directive present
		"## Workspace", // workspace section
		"/ws/project",  // workspace path
		"/ws/tmp",      // temp dir
		"## Available Tools",
		"`read_file`",
		"`bash_exec`",
		"## Delegation",
		"## Active Skills",
		"Body of skill.",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("system prompt missing %q", want)
		}
	}
	// Only the first line of a description is inlined.
	if strings.Contains(prompt, "Second line.") {
		t.Error("tool description second line leaked into the catalog")
	}
}

func TestUserMessage_Shape(t *testing.T) {
	state := map[string]any{"objective": "do it", "k": 1}
	msg := BuildUserMessage(state, "obs-text", 7)
	for _, want := range []string{"[turn 7]", "<state>", `"objective":"do it"`, "<observation>", "obs-text"} {
		if !strings.Contains(msg, want) {
			t.Errorf("user message missing %q: %q", want, msg)
		}
	}
}

// ---------------------------------------------------------------------------
// Seed state
// ---------------------------------------------------------------------------

func TestSeedState_ObjectiveAndExtensions(t *testing.T) {
	caller := &scriptedCaller{responses: []*llm.ChatResponse{
		stepResponse(`{}`, "finish", `{"answer":"x"}`),
	}}
	cfg := testConfig()
	cfg.Task = "the objective"
	cfg.InitialState = map[string]any{"context": "extra", CoreKeyObjective: "IGNORED"}
	loop := New(caller, &mockRegistry{}, nil, cfg)

	res, err := loop.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	sigma := res.Snapshot.Sigma
	if sigma[CoreKeyObjective] != "the objective" {
		t.Errorf("objective = %v, want the objective (core keys are canonical)", sigma[CoreKeyObjective])
	}
	if sigma["context"] != "extra" {
		t.Errorf("extension seed missing: %v", sigma["context"])
	}
}

// slogDiscard returns a logger that drops output.
func slogDiscard() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
