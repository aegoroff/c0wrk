package e2s

// Shared test fixtures for the e2s package.

// read_file-like schema: closed property set with one required key — the
// exact shape whose silent-misparse failure consumed the analyzed production
// session (offset/limit instead of start_line/end_line). Used by the loop
// tests' schema registry to exercise pre-dispatch input validation (the
// shared SDK validator, sdktools.ValidateToolInput).
const readFileSchema = `{
	"type": "object",
	"properties": {
		"path": {"type": "string", "description": "file path"},
		"start_line": {"type": "integer"},
		"end_line": {"type": "integer"}
	},
	"required": ["path"]
}`
