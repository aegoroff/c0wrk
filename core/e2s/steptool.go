// Package e2s implements the Environment-to-State (E2S) execution loop: a
// self-contained alternative to agent.Executor that runs on raw sp4rk
// primitives (llm.Caller + a tool registry + an event emitter).
//
// Unlike the ReAct executor, which replays a growing message history, the E2S
// loop keeps the model's context bounded at O(1): every step is a FRESH
// one-shot dialog consisting of exactly [system, user] messages, where the
// user message carries the full working state Σₜ (compact JSON) and the
// latest observation Oₜ. The model responds with a single e2s_step meta-tool
// call that (a) patches the state and (b) names the next action; the loop
// validates and applies the patch, dispatches the action through the tool
// registry (inheriting every security gate: group policies, judge, HITL
// confirmation, verify-on-edit), and feeds the truncated result back as Oₜ₊₁.
package e2s

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/v0lka/sp4rk/llm"
	sdktools "github.com/v0lka/sp4rk/tools"
)

// StepToolName is the name of the E2S meta-tool offered to the model as the
// ONLY tool definition on every LLM call.
const StepToolName = "e2s_step"

// FinishActionName is the reserved action target that terminates the loop.
const FinishActionName = "finish"

const toolStepDescription = `Purpose: advance the E2S loop one step — patch your working state and name the next action.
Use when: on EVERY turn. This is the only tool you may call; a turn without an e2s_step call is invalid and will be retried once, then reported back as an error observation.
Inputs: state_patch (a JSON object shallow-merged into your working state Σ — record here everything the next turn needs: findings, decisions, file locations, partial results; keep it compact, the merged state is size-capped); action (object: tool = a name from the Available Tools list with args = that tool's arguments object, OR tool = "finish" with args = {"answer": "..."} when the task is complete).
Outputs: the action's result (truncated) comes back to you as the next observation; the merged state is echoed to the user as a live snapshot.
Example: {"state_patch": {"found": "auth lives in core/middleware.go"}, "action": {"tool": "read_file", "args": {"path": "core/middleware.go"}}}.
Anti-example: do not put the action inside state_patch, do not emit text instead of calling this tool, and do not call finish while work remains.`

// StepTool is the E2S meta-tool. It exists to give the LLM a tool definition
// to call; the E2S loop intercepts the call and never routes it through a
// registry. Executing it directly is a configuration error and returns an
// error result instead of performing anything.
//
// Group: GroupSystem (ADR-024). The tool has no filesystem or network side
// effect of its own — it only describes the state-patch + action envelope.
// The real policy gates apply to the TARGET tool when the loop dispatches it
// via ToolRegistry.Execute, so a malicious e2s_step envelope cannot bypass
// group policies, the judge, or HITL confirmation.
type StepTool struct {
	*sdktools.BaseTool
}

// NewStepTool creates the e2s_step meta-tool.
func NewStepTool() *StepTool {
	return &StepTool{BaseTool: &sdktools.BaseTool{
		ToolGroup:       sdktools.GroupSystem,
		ToolName:        StepToolName,
		ToolDescription: toolStepDescription,
		Schema:          json.RawMessage(stepToolSchema),
		Policy:          sdktools.PolicyAlwaysAllow,
		Untrusted:       false,
	}}
}

const stepToolSchema = `{
	"type": "object",
	"properties": {
		"state_patch": {
			"type": "object",
			"description": "Shallow-merge patch into the working state. Core keys keep their fixed types; extension keys add or update in place (delete with an explicit null). Omit keys you want to keep. Keep the merged state compact — oversized patches are rejected.",
			"additionalProperties": true
		},
		"action": {
			"type": "object",
			"description": "The next action: a target tool call, or finish to end the task.",
			"properties": {
				"tool": {
					"type": "string",
					"description": "Target tool name from the Available Tools list, or \"finish\" to deliver the final answer."
				},
				"args": {
					"type": "object",
					"description": "Arguments object for the target tool. For finish: {\"answer\": \"...\"}."
				}
			},
			"required": ["tool", "args"]
		}
	},
	"required": ["state_patch", "action"]
}`

// Execute is never called by the E2S loop (it intercepts e2s_step calls
// before dispatch). Registering the tool into a registry and executing it
// there is a wiring mistake — fail loudly instead of silently no-oping.
func (t *StepTool) Execute(_ context.Context, _ json.RawMessage) (sdktools.ToolResult, error) {
	return sdktools.ErrorResult(
		"%s is an E2S envelope tool: it is intercepted by the E2S loop and must not be executed through a registry",
		StepToolName,
	), nil
}

// StepAction is the validated action half of an e2s_step call.
type StepAction struct {
	// Tool is the target tool name ("finish" terminates the loop).
	Tool string
	// Args is the raw arguments object for the target tool (always a compact
	// JSON object).
	Args json.RawMessage
	// Answer is set when Tool == "finish" (parsed from args.answer).
	Answer string
}

// IsFinish reports whether the action terminates the loop.
func (a StepAction) IsFinish() bool { return a.Tool == FinishActionName }

// StepCall is a parsed and validated e2s_step tool call.
type StepCall struct {
	// ID is the LLM-assigned tool-call id, threaded into the synthesized
	// trajectory step.
	ID string
	// StatePatch holds the raw JSON values of the patch keys (nil for an
	// absent/empty patch). Values are kept raw so the merge round-trips
	// numbers, nested objects, and arrays without re-marshaling artifacts
	// until the state is rendered.
	StatePatch map[string]json.RawMessage
	// Action is the validated action.
	Action StepAction
}

// ParseStepCall extracts and validates the e2s_step tool call from an LLM
// response's tool calls. The first tool call must be e2s_step; a response
// with no tool calls, or whose first tool call names a different tool, is
// invalid (the loop offers exactly one tool definition, so any other name is
// a protocol violation).
func ParseStepCall(toolCalls []llm.ToolCall) (StepCall, error) {
	if len(toolCalls) == 0 {
		return StepCall{}, fmt.Errorf("response contains no tool call: every turn must call %s exactly once", StepToolName)
	}
	first := toolCalls[0]
	if first.Name != StepToolName {
		return StepCall{}, fmt.Errorf("unexpected tool %q: the only tool you may call is %s", first.Name, StepToolName)
	}
	call, err := parseStepInput(first.Input)
	if err != nil {
		return StepCall{}, err
	}
	call.ID = first.ID
	return call, nil
}

func parseStepInput(raw json.RawMessage) (StepCall, error) {
	var input struct {
		StatePatch map[string]json.RawMessage `json:"state_patch"`
		Action     *struct {
			Tool string          `json:"tool"`
			Args json.RawMessage `json:"args"`
		} `json:"action"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		return StepCall{}, fmt.Errorf("invalid %s input JSON: %w", StepToolName, err)
	}

	if input.Action == nil {
		return StepCall{}, fmt.Errorf("%s.action is required (object with tool and args)", StepToolName)
	}

	args, err := normalizeArgs(input.Action.Args)
	if err != nil {
		return StepCall{}, fmt.Errorf("%s.action.args: %w", StepToolName, err)
	}

	call := StepCall{
		StatePatch: input.StatePatch,
		Action: StepAction{
			Tool: input.Action.Tool,
			Args: args,
		},
	}

	if call.Action.IsFinish() {
		answer, err := parseFinishAnswer(args)
		if err != nil {
			return StepCall{}, fmt.Errorf("%s.action.args: %w", StepToolName, err)
		}
		call.Action.Answer = answer
	}
	// Enforce the domain action contract (exactly-one-of tool call / finish
	// with an answer) on top of the envelope shape checks.
	if err := call.Action.Validate(); err != nil {
		return StepCall{}, err
	}
	return call, nil
}

// normalizeArgs validates that args is a JSON object (or absent → the empty
// object) and returns it in compact form so identical argument sets produce
// identical fingerprints. A non-object value (array, string, number) is a
// schema violation: every tool input in the registry is an object.
func normalizeArgs(raw json.RawMessage) (json.RawMessage, error) {
	if trimmed := bytes.TrimSpace(raw); len(trimmed) == 0 || string(trimmed) == "null" {
		return json.RawMessage(`{}`), nil
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("invalid JSON: %s", truncateForError(raw))
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("must be a JSON object, got: %s", truncateForError(raw))
	}
	return json.RawMessage(compactJSON(raw)), nil
}

// parseFinishAnswer extracts the answer string from finish args. A missing
// or empty answer is left for the domain contract check (StepAction.Validate
// → ErrActionNoAnswer); a present-but-non-string value is a shape error.
func parseFinishAnswer(args json.RawMessage) (string, error) {
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(args, &parsed); err != nil {
		return "", fmt.Errorf("invalid JSON: %w", err)
	}
	raw, ok := parsed["answer"]
	if !ok {
		return "", nil
	}
	var answer string
	if err := json.Unmarshal(raw, &answer); err != nil {
		return "", fmt.Errorf("answer must be a string: %w", err)
	}
	return answer, nil
}

// truncateForError renders a short preview of raw JSON for error messages.
func truncateForError(raw json.RawMessage) string {
	const maxPreviewBytes = 120
	if len(raw) <= maxPreviewBytes {
		return string(raw)
	}
	return string(raw[:maxPreviewBytes]) + "…"
}

// compactJSON removes insignificant whitespace so semantically identical
// argument objects produce byte-identical strings (used by the anti-spin
// fingerprint). Falls back to the raw string for malformed JSON.
func compactJSON(raw json.RawMessage) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return string(raw)
	}
	return buf.String()
}

// ActionFingerprint returns a canonical string identifying the action for
// the anti-spin detector. It is SEMANTIC, not byte-exact: the fingerprint
// anchors on the identity of the operation's TARGET — the tool name plus the
// "anchor" arguments that name what is acted on (path, pattern, command,
// query, url, name, skill, hash) — and deliberately ignores precision
// arguments such as line ranges or limits. Re-reading the same file with
// ever-shifting start_line/end_line (the classic small-model spin) produces
// a stable fingerprint and is caught; reading different files or searching
// different patterns does not. A tool exposing no anchor argument falls
// back to the full compact args (the legacy exact behavior), and a batch
// fingerprints per sub-call so a repeated identical batch still spins.
func ActionFingerprint(tool string, args json.RawMessage) string {
	if tool == sdktools.ToolBatch {
		return tool + ":" + batchAnchors(args)
	}
	if anchors := argAnchors(args); anchors != "" {
		return tool + ":" + anchors
	}
	return tool + ":" + compactJSON(args)
}

// anchorArgKeys are the argument names treated as operation-target anchors.
// Sorted for deterministic extraction.
var anchorArgKeys = []string{"command", "hash", "name", "path", "pattern", "query", "skill", "url"}

// argAnchors extracts the anchor key=value pairs from an args object
// (string-valued anchors only), sorted by key. Empty string when no anchor
// key carries a string value.
func argAnchors(args json.RawMessage) string {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(args, &obj); err != nil {
		return ""
	}
	pairs := make([]string, 0, len(anchorArgKeys))
	for _, key := range anchorArgKeys {
		raw, ok := obj[key]
		if !ok {
			continue
		}
		var val string
		if err := json.Unmarshal(raw, &val); err != nil {
			continue // non-string anchor (e.g. numeric name): not an anchor
		}
		pairs = append(pairs, key+"="+val)
	}
	if len(pairs) == 0 {
		return ""
	}
	return strings.Join(pairs, "\x00")
}

// batchAnchors fingerprints a batch action per sub-call: each sub-call's
// tool + anchors (or full args fallback), joined in order. A repeated
// identical batch matches; any changed target breaks the match.
func batchAnchors(args json.RawMessage) string {
	var input struct {
		Calls []struct {
			Tool  string          `json:"tool"`
			Input json.RawMessage `json:"input"`
		} `json:"calls"`
	}
	if err := json.Unmarshal(args, &input); err != nil || len(input.Calls) == 0 {
		return compactJSON(args)
	}
	parts := make([]string, 0, len(input.Calls))
	for _, sub := range input.Calls {
		if anchors := argAnchors(sub.Input); anchors != "" {
			parts = append(parts, sub.Tool+"="+anchors)
			continue
		}
		parts = append(parts, sub.Tool+"="+compactJSON(sub.Input))
	}
	return strings.Join(parts, "\x00")
}
