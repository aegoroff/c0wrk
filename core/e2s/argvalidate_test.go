package e2s

import (
	"encoding/json"
	"strings"
	"testing"
)

// read_file-like schema: closed property set with one required key — the
// exact shape whose silent-misparse failure consumed the analyzed production
// session (offset/limit instead of start_line/end_line).
const readFileSchema = `{
	"type": "object",
	"properties": {
		"path": {"type": "string", "description": "file path"},
		"start_line": {"type": "integer"},
		"end_line": {"type": "integer"}
	},
	"required": ["path"]
}`

func TestValidateActionArgs_UnknownParameterRejected(t *testing.T) {
	// Both offset and limit are unknown here; the validator reports the
	// first in sorted order — the assertion covers whichever surfaces.
	err := ValidateActionArgs("read_file", json.RawMessage(readFileSchema), json.RawMessage(`{"path":"a.txt","offset":1,"limit":100}`))
	if err == nil {
		t.Fatal("unknown parameter offset must be rejected")
	}
	msg := err.Error()
	if !strings.Contains(msg, "unknown parameter") ||
		(!strings.Contains(msg, `"offset"`) && !strings.Contains(msg, `"limit"`)) {
		t.Errorf("error must name an unknown parameter: %q", msg)
	}
	for _, valid := range []string{"path", "start_line", "end_line"} {
		if !strings.Contains(msg, valid) {
			t.Errorf("error must list valid parameter %q: %q", valid, msg)
		}
	}
}

func TestValidateActionArgs_ValidCallPasses(t *testing.T) {
	if err := ValidateActionArgs("read_file", json.RawMessage(readFileSchema), json.RawMessage(`{"path":"a.txt","start_line":321,"end_line":520}`)); err != nil {
		t.Fatalf("valid ranged read must pass: %v", err)
	}
	if err := ValidateActionArgs("read_file", json.RawMessage(readFileSchema), json.RawMessage(`{"path":"a.txt"}`)); err != nil {
		t.Fatalf("minimal valid read must pass: %v", err)
	}
}

func TestValidateActionArgs_MissingRequired(t *testing.T) {
	err := ValidateActionArgs("read_file", json.RawMessage(readFileSchema), json.RawMessage(`{"start_line":1}`))
	if err == nil || !strings.Contains(err.Error(), `missing required parameter "path"`) {
		t.Fatalf("missing required must be rejected: %v", err)
	}
}

func TestValidateActionArgs_TypeMismatch(t *testing.T) {
	err := ValidateActionArgs("read_file", json.RawMessage(readFileSchema), json.RawMessage(`{"path":42}`))
	if err == nil || !strings.Contains(err.Error(), `parameter "path" must be of type string`) {
		t.Fatalf("type mismatch must be rejected: %v", err)
	}
	// Integer-typed parameter accepts a JSON number (encoding/json decodes
	// all numbers as float64; the validator maps integer→number).
	if err := ValidateActionArgs("read_file", json.RawMessage(readFileSchema), json.RawMessage(`{"path":"a","start_line":5}`)); err != nil {
		t.Fatalf("integer parameter with number value must pass: %v", err)
	}
}

func TestValidateActionArgs_OpenSchemasFailOpen(t *testing.T) {
	cases := []struct {
		name   string
		schema string
		args   string
	}{
		{"no properties", `{"type":"object","additionalProperties":true}`, `{"whatever":"x"}`},
		{"empty schema", `{}`, `{"whatever":"x"}`},
		{"malformed schema", `{"properties":`, `{"whatever":"x"}`},
		{"additionalProperties true", `{"type":"object","properties":{"a":{"type":"string"}},"additionalProperties":true}`, `{"extra":"x","a":"s"}`},
		{"additionalProperties object form", `{"type":"object","properties":{"a":{"type":"string"}},"additionalProperties":{"type":"string"}}`, `{"extra":"x","a":"s"}`},
		{"array-typed type accepts null", `{"type":"object","properties":{"a":{"type":["string","null"]}}}`, `{"a":null}`},
		{"array-typed type accepts member", `{"type":"object","properties":{"a":{"type":["string","null"]}}}`, `{"a":"s"}`},
	}
	for _, tc := range cases {
		if err := ValidateActionArgs("t", json.RawMessage(tc.schema), json.RawMessage(tc.args)); err != nil {
			t.Errorf("%s: must fail open, got %v", tc.name, err)
		}
	}
}

func TestValidateActionArgs_NonObjectArgsRejected(t *testing.T) {
	if err := ValidateActionArgs("t", json.RawMessage(readFileSchema), json.RawMessage(`[1,2]`)); err == nil {
		t.Fatal("non-object args must be rejected")
	}
}

func TestValidateActionArgs_EmptyArgsWithRequiredRejected(t *testing.T) {
	if err := ValidateActionArgs("read_file", json.RawMessage(readFileSchema), json.RawMessage(`{}`)); err == nil {
		t.Fatal("empty args against required path must be rejected")
	}
	if err := ValidateActionArgs("read_file", json.RawMessage(readFileSchema), nil); err == nil {
		t.Fatal("nil args against required path must be rejected")
	}
}
