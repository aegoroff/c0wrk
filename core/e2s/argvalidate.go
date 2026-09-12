package e2s

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Action-argument validation. The e2s_step envelope declares action.args as
// a free-form object, so the provider-side JSON-schema validation that the
// Conductor gets for free (one native tool definition per tool) never runs
// in E2S. Wrong argument names (e.g. read_file{offset, limit} instead of
// start_line/end_line) would otherwise be silently ignored by Go's
// json.Unmarshal — the tool executes with defaulted parameters and the model
// receives a bewildering whole-file result. The structural validator below
// catches the failure cheaply BEFORE dispatch and returns an actionable
// error observation naming the valid parameters.
//
// The validator is deliberately lightweight (no external JSON-schema
// dependency): it checks presence of required keys, JSON types of declared
// properties, and unknown keys against the declared property set — the
// failure modes models actually produce. Schemas without a "properties"
// object (or unparseable ones) skip validation fail-open: an open schema
// must never block a legitimate call.

// argTypeError describes a structural violation of action.args against the
// target tool's input schema. It renders as an actionable message for the
// model (valid parameter names included), so the raw error text is the
// product.
type argTypeError struct {
	tool   string
	reason string
	// valid lists the schema's declared property names (rendered into the
	// message; sorted for determinism).
	valid []string
}

func (e *argTypeError) Error() string {
	msg := fmt.Sprintf("action arguments for %q are invalid: %s", e.tool, e.reason)
	if len(e.valid) > 0 {
		msg += "; valid parameters: " + strings.Join(e.valid, ", ")
	}
	return msg
}

// ValidateActionArgs checks raw action arguments against a tool's raw JSON
// input schema. It returns nil when the args are structurally compatible
// (or when the schema declares no closed property set, in which case
// validation is skipped fail-open) and a *argTypeError describing the first
// problem otherwise. Both inputs are raw JSON: args is the normalized
// compact object from StepAction.Args.
func ValidateActionArgs(tool string, schema, args json.RawMessage) error {
	var sch struct {
		Properties           map[string]json.RawMessage `json:"properties"`
		Required             []string                   `json:"required"`
		AdditionalProperties json.RawMessage            `json:"additionalProperties"`
	}
	if err := json.Unmarshal(schema, &sch); err != nil {
		return nil //nolint:nilerr // unparseable schema: fail-open by design
	}
	if len(sch.Properties) == 0 {
		return nil // open/undocumented schema: fail-open
	}

	var obj map[string]json.RawMessage
	if len(bytes.TrimSpace(args)) == 0 {
		obj = map[string]json.RawMessage{}
	} else if err := json.Unmarshal(args, &obj); err != nil {
		return &argTypeError{tool: tool, reason: "args must be a JSON object", valid: propertyNames(sch.Properties)}
	}

	names := propertyNames(sch.Properties)
	nameSet := make(map[string]struct{}, len(sch.Properties))
	for k := range sch.Properties {
		nameSet[k] = struct{}{}
	}

	// Required keys must be present.
	for _, req := range sch.Required {
		if _, ok := obj[req]; !ok {
			return &argTypeError{tool: tool, reason: fmt.Sprintf("missing required parameter %q", req), valid: names}
		}
	}

	// Unknown keys are rejected when the schema is a closed set.
	additionalAllowed := false
	if len(sch.AdditionalProperties) > 0 {
		var asBool bool
		if err := json.Unmarshal(sch.AdditionalProperties, &asBool); err == nil {
			additionalAllowed = asBool
		} else {
			additionalAllowed = true // object-form constraint: extra keys allowed
		}
	}
	argNames := make([]string, 0, len(obj))
	for k := range obj {
		argNames = append(argNames, k)
	}
	sort.Strings(argNames)
	for _, k := range argNames {
		if _, ok := nameSet[k]; !ok && !additionalAllowed {
			return &argTypeError{
				tool:   tool,
				reason: fmt.Sprintf("unknown parameter %q (not accepted by this tool; check the tool's schema in Available Tools)", k),
				valid:  names,
			}
		}
	}

	// Type check present keys against their declared property type.
	for _, k := range argNames {
		prop, ok := sch.Properties[k]
		if !ok {
			continue
		}
		if err := checkPropertyType(tool, k, prop, obj[k], names); err != nil {
			return err
		}
	}
	return nil
}

// checkPropertyType verifies the JSON type of one present argument against
// the "type" declared by its property schema. A property without "type"
// (or with a type form we do not model, e.g. oneOf) skips the check.
func checkPropertyType(tool, key string, prop, value json.RawMessage, names []string) error {
	var p struct {
		Type json.RawMessage `json:"type"`
	}
	if err := json.Unmarshal(prop, &p); err != nil || len(p.Type) == 0 {
		return nil //nolint:nilerr // unmodeled property form (no/complex type): skip the check
	}

	allowed := decodeSchemaTypes(p.Type)
	if len(allowed) == 0 {
		return nil
	}

	actual := jsonTypeNameOf(value)
	for _, want := range allowed {
		if typesCompatible(want, actual) {
			return nil
		}
	}
	return &argTypeError{
		tool:   tool,
		reason: fmt.Sprintf("parameter %q must be of type %s, got %s", key, strings.Join(allowed, "|"), actual),
		valid:  names,
	}
}

// decodeSchemaTypes parses the schema "type" value, which may be a string
// ("integer") or an array of strings (["string","null"]).
func decodeSchemaTypes(raw json.RawMessage) []string {
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return []string{single}
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err == nil {
		return many
	}
	return nil
}

// typesCompatible maps schema type names onto observed JSON value types.
func typesCompatible(want, actual string) bool {
	if want == actual {
		return true
	}
	// JSON Schema "integer" accepts any integral JSON number; encoding/json
	// decodes all numbers as float64, so both number kinds arrive as "number".
	if want == "integer" && actual == "number" {
		return true
	}
	return false
}

// jsonTypeNameOf reports the JSON type name of a raw value ("null" for an
// explicit null). It assumes valid JSON (args passed normalizeArgs first).
func jsonTypeNameOf(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "null"
	}
	switch trimmed[0] {
	case '"':
		return "string"
	case 't', 'f':
		return "boolean"
	case 'n':
		return "null"
	case '[':
		return "array"
	case '{':
		return "object"
	default:
		return "number"
	}
}

// propertyNames returns the sorted declared property names of a schema's
// properties map (for deterministic error messages).
func propertyNames(props map[string]json.RawMessage) []string {
	names := make([]string, 0, len(props))
	for k := range props {
		names = append(names, k)
	}
	sort.Strings(names)
	return names
}
