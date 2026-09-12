package e2s

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/v0lka/sp4rk/llm"
	sdktools "github.com/v0lka/sp4rk/tools"
)

func TestStepTool_Metadata(t *testing.T) {
	tool := NewStepTool()
	if tool.Name() != "e2s_step" {
		t.Errorf("name = %q, want e2s_step", tool.Name())
	}
	if got := sdktools.ToolGroupOf(tool); got != sdktools.GroupSystem {
		t.Errorf("group = %q, want system (ADR-024)", got)
	}
	if tool.DefaultPolicy() != sdktools.PolicyAlwaysAllow {
		t.Errorf("policy = %v, want always allow (dispatch-only envelope)", tool.DefaultPolicy())
	}
	if tool.IsUntrusted() {
		t.Error("envelope tool must not be marked untrusted")
	}
	// The schema must declare the envelope contract.
	schema := string(tool.InputSchema())
	for _, want := range []string{`"state_patch"`, `"action"`, `"tool"`, `"args"`, `"required"`} {
		if !strings.Contains(schema, want) {
			t.Errorf("input schema missing %s", want)
		}
	}
	// The schema itself must be valid JSON.
	var probe map[string]any
	if err := json.Unmarshal(tool.InputSchema(), &probe); err != nil {
		t.Fatalf("input schema is not valid JSON: %v", err)
	}
}

func TestStepTool_ExecuteRefusesDirectDispatch(t *testing.T) {
	tool := NewStepTool()
	result, err := tool.Execute(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("Execute returned err: %v (must report via ToolResult)", err)
	}
	if !result.IsError {
		t.Error("Execute on the envelope tool must return an error result")
	}
	if !strings.Contains(result.Content, "must not be executed") {
		t.Errorf("unexpected content: %q", result.Content)
	}
}

func TestParseStepCall_ValidToolCall(t *testing.T) {
	calls := []llm.ToolCall{{
		ID:    "call_9",
		Name:  StepToolName,
		Input: json.RawMessage(`{"state_patch":{"findings":["f"]},"action":{"tool":"read_file","args":{"path":"x.go"}}}`),
	}}
	call, err := ParseStepCall(calls)
	if err != nil {
		t.Fatalf("ParseStepCall: %v", err)
	}
	if call.ID != "call_9" {
		t.Errorf("ID = %q, want call_9", call.ID)
	}
	if len(call.StatePatch) != 1 {
		t.Errorf("StatePatch = %v, want one key", call.StatePatch)
	}
	if call.Action.Tool != "read_file" {
		t.Errorf("action tool = %q", call.Action.Tool)
	}
	if string(call.Action.Args) != `{"path":"x.go"}` {
		t.Errorf("action args = %s (want compact form)", call.Action.Args)
	}
	if call.Action.IsFinish() {
		t.Error("IsFinish = true for a tool action")
	}
	if err := call.Action.Validate(); err != nil {
		t.Errorf("Validate: %v", err)
	}
}

func TestParseStepCall_Finish(t *testing.T) {
	call, err := ParseStepCall([]llm.ToolCall{{
		ID:    "c1",
		Name:  StepToolName,
		Input: json.RawMessage(`{"state_patch":{},"action":{"tool":"finish","args":{"answer":"all done"}}}`),
	}})
	if err != nil {
		t.Fatalf("ParseStepCall: %v", err)
	}
	if !call.Action.IsFinish() {
		t.Fatal("IsFinish = false")
	}
	if call.Action.Answer != "all done" {
		t.Errorf("answer = %q", call.Action.Answer)
	}
}

func TestParseStepCall_Errors(t *testing.T) {
	tests := []struct {
		name     string
		calls    []llm.ToolCall
		wantErr  error
		wantText string
	}{
		{
			name:    "no tool calls",
			calls:   nil,
			wantErr: nil,
		},
		{
			name:  "wrong tool name",
			calls: []llm.ToolCall{{ID: "c", Name: "read_file", Input: json.RawMessage(`{}`)}},
		},
		{
			name:  "malformed envelope JSON",
			calls: []llm.ToolCall{{ID: "c", Name: StepToolName, Input: json.RawMessage(`{not json`)}},
		},
		{
			name:  "missing action",
			calls: []llm.ToolCall{{ID: "c", Name: StepToolName, Input: json.RawMessage(`{"state_patch":{}}`)}},
		},
		{
			name:    "empty tool",
			calls:   []llm.ToolCall{{ID: "c", Name: StepToolName, Input: json.RawMessage(`{"action":{"tool":"","args":{}}}`)}},
			wantErr: ErrActionEmpty,
		},
		{
			name:  "args not an object",
			calls: []llm.ToolCall{{ID: "c", Name: StepToolName, Input: json.RawMessage(`{"action":{"tool":"x","args":[1,2]}}`)}},
		},
		{
			name:  "args malformed JSON",
			calls: []llm.ToolCall{{ID: "c", Name: StepToolName, Input: json.RawMessage(`{"action":{"tool":"x","args":{"a":}}}`)}},
		},
		{
			name:    "finish without answer field",
			calls:   []llm.ToolCall{{ID: "c", Name: StepToolName, Input: json.RawMessage(`{"action":{"tool":"finish","args":{}}}`)}},
			wantErr: ErrActionNoAnswer,
		},
		{
			name:     "finish with non-string answer",
			calls:    []llm.ToolCall{{ID: "c", Name: StepToolName, Input: json.RawMessage(`{"action":{"tool":"finish","args":{"answer":7}}}`)}},
			wantText: "answer must be a string",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			call, err := ParseStepCall(tt.calls)
			if err == nil {
				t.Fatalf("ParseStepCall succeeded: %+v", call)
			}
			if tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
				t.Errorf("err = %v, want wrapping %v", err, tt.wantErr)
			}
			if tt.wantText != "" && !strings.Contains(err.Error(), tt.wantText) {
				t.Errorf("err = %v, want text %q", err, tt.wantText)
			}
		})
	}
}

func TestParseStepCall_AbsentStatePatchAndArgs(t *testing.T) {
	call, err := ParseStepCall([]llm.ToolCall{{
		ID:    "c",
		Name:  StepToolName,
		Input: json.RawMessage(`{"action":{"tool":"probe"}}`),
	}})
	if err != nil {
		t.Fatalf("ParseStepCall: %v (absent optional fields must default)", err)
	}
	if len(call.StatePatch) != 0 {
		t.Errorf("StatePatch = %v, want empty", call.StatePatch)
	}
	if string(call.Action.Args) != `{}` {
		t.Errorf("args = %s, want {}", call.Action.Args)
	}
}

func TestActionFingerprint_Canonical(t *testing.T) {
	// Whitespace differences must not defeat the anti-spin detector.
	a := ActionFingerprint("probe", json.RawMessage(`{"q": 1,   "z": "s"}`))
	b := ActionFingerprint("probe", json.RawMessage(`{"q":1,"z":"s"}`))
	if a != b {
		t.Errorf("fingerprints differ for identical args:\n%s\n%s", a, b)
	}
	c := ActionFingerprint("probe", json.RawMessage(`{"q":2}`))
	if a == c {
		t.Error("fingerprints collide for different args")
	}
	d := ActionFingerprint("other", json.RawMessage(`{"q":1,"z":"s"}`))
	if a == d {
		t.Error("fingerprints collide for different tools")
	}
}

func TestNormalizeArgs_RejectsInvalidJSON(t *testing.T) {
	if _, err := normalizeArgs(json.RawMessage(`{"broken":`)); err == nil {
		t.Error("expected error for malformed JSON")
	}
	got, err := normalizeArgs(json.RawMessage(`  {"a" : 1} `))
	if err != nil {
		t.Fatalf("normalizeArgs: %v", err)
	}
	if string(got) != `{"a":1}` {
		t.Errorf("normalized = %s, want compact {\"a\":1}", got)
	}
}
