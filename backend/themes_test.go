package backend

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// validThemeCSS is a minimal theme that passes every validation rule.
const validThemeCSS = `/* c0wrk-theme: Nord | dark */
:root {
  --color-background: #2e3440;
  --color-foreground: #d8dee9;
}
`

func TestParseThemeCSS_Header(t *testing.T) {
	name, typ := ParseThemeCSS("nord.css", validThemeCSS)
	if name != "Nord" {
		t.Errorf("name: got %q, want %q", name, "Nord")
	}
	if typ != "dark" {
		t.Errorf("type: got %q, want %q", typ, "dark")
	}
}

func TestParseThemeCSS_HeaderCaseInsensitiveType(t *testing.T) {
	content := "/* c0wrk-theme: Solarized Light | LIGHT */\n:root { --color-background: #fdf6e3; --color-foreground: #657b83; }"
	name, typ := ParseThemeCSS("solarized-light.css", content)
	if name != "Solarized Light" {
		t.Errorf("name: got %q, want %q", name, "Solarized Light")
	}
	if typ != "light" {
		t.Errorf("type: got %q, want %q", typ, "light")
	}
}

func TestParseThemeCSS_NoHeaderFallsBackToFileName(t *testing.T) {
	content := ":root { --color-background: #fff; --color-foreground: #000; }"
	name, typ := ParseThemeCSS("solarized-light.css", content)
	if name != "Solarized Light" {
		t.Errorf("name: got %q, want %q", name, "Solarized Light")
	}
	if typ != "dark" {
		t.Errorf("type: got %q, want %q", typ, "dark")
	}
}

func TestParseThemeCSS_ColorSchemeFallback(t *testing.T) {
	content := ":root { color-scheme: light; --color-background: #fdf6e3; --color-foreground: #657b83; }"
	_, typ := ParseThemeCSS("paper.css", content)
	if typ != "light" {
		t.Errorf("type: got %q, want %q", typ, "light")
	}
}

func TestParseThemeCSS_ColorSchemeFallbackQuoted(t *testing.T) {
	content := ":root { COLOR-SCHEME: \"dark\"; --color-background: #1d2025; --color-foreground: #abb2bf; }"
	_, typ := ParseThemeCSS("quoted.css", content)
	if typ != "dark" {
		t.Errorf("type: got %q, want %q", typ, "dark")
	}
}

func TestParseThemeCSS_PrefersColorSchemeMediaNotFalsePositive(t *testing.T) {
	content := "@media (prefers-color-scheme: light) { :root { --color-background: #fff; --color-foreground: #000; } }"
	_, typ := ParseThemeCSS("adaptive.css", content)
	if typ != "dark" {
		t.Errorf("prefers-color-scheme must not set the theme type: got %q, want %q", typ, "dark")
	}
}

func TestParseThemeCSS_HeaderNotAtStartIgnored(t *testing.T) {
	content := ":root { --color-background: #fff; --color-foreground: #000; }\n/* c0wrk-theme: Ghost | light */"
	name, typ := ParseThemeCSS("file.css", content)
	if name != "File" {
		t.Errorf("name: got %q, want %q (mid-file marker must not be a header)", name, "File")
	}
	if typ != "dark" {
		t.Errorf("type: got %q, want %q (mid-file marker must not set light)", typ, "dark")
	}
}

func TestParseThemeCSS_EmptyContent(t *testing.T) {
	name, typ := ParseThemeCSS("my_theme.css", "")
	if name != "My Theme" {
		t.Errorf("name: got %q, want %q", name, "My Theme")
	}
	if typ != "dark" {
		t.Errorf("type: got %q, want %q", typ, "dark")
	}
}

func TestParseThemeCSS_EmptyFileName(t *testing.T) {
	name, _ := ParseThemeCSS("", "")
	if name != "Theme" {
		t.Errorf("name: got %q, want %q", name, "Theme")
	}
}

func TestValidateThemeCSS_AcceptsMinimal(t *testing.T) {
	if err := ValidateThemeCSS(validThemeCSS); err != nil {
		t.Fatalf("expected valid theme to pass, got %v", err)
	}
}

// TestValidateThemeCSS_SpecExampleTheme keeps the author-facing example theme
// in frontend/src/assets/themes/example-theme.css importable: it must pass every validation
// rule and parse with the metadata it declares. If this test fails after an
// edit to the example (or to the validator), fix the file — the documented
// starting point for theme authors must stay valid.
func TestValidateThemeCSS_SpecExampleTheme(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "frontend", "src", "assets", "themes", "example-theme.css"))
	if err != nil {
		t.Fatalf("read spec example theme: %v", err)
	}
	css := string(b)
	if err := ValidateThemeCSS(css); err != nil {
		t.Fatalf("spec example theme must pass validation: %v", err)
	}
	name, typ := ParseThemeCSS("example-theme.css", css)
	if name != "Solar Light" {
		t.Errorf("spec example theme name: got %q, want %q", name, "Solar Light")
	}
	if typ != "light" {
		t.Errorf("spec example theme type: got %q, want %q", typ, "light")
	}
}

// bundledThemeFiles lists every bundled palette theme shipped under
// frontend/src/assets/themes/. Each entry pins the parsed display name and type the
// theme must carry — the file's basename (sans .css) must equal the theme id.
var bundledThemeFiles = map[string]struct {
	name string
	typ  string
}{
	"nord.css":                {name: "Nord", typ: themeTypeDark},
	"tokyo-night.css":         {name: "Tokyo Night", typ: themeTypeDark},
	"catppuccin-mocha.css":    {name: "Catppuccin Mocha", typ: themeTypeDark},
	"high-contrast-dark.css":  {name: "High Contrast Dark", typ: themeTypeDark},
	"high-contrast-light.css": {name: "High Contrast Light", typ: themeTypeLight},
	"catppuccin-latte.css":    {name: "Catppuccin Latte", typ: themeTypeLight},
	"rose-pine-dawn.css":      {name: "Rosé Pine Dawn", typ: themeTypeLight},
	"gruvbox-light.css":       {name: "Gruvbox Light", typ: themeTypeLight},
}

// TestValidateThemeCSS_BundledThemes keeps every bundled palette theme under
// frontend/src/assets/themes/ importable: each must pass all validation rules,
// parse with the metadata it declares, and own a slug that neither collides
// with the built-ins nor contradicts its filename. If this test fails after
// an edit to a bundled theme (or to the validator), fix the file — the
// bundled themes must always stay valid.
func TestValidateThemeCSS_BundledThemes(t *testing.T) {
	dir := filepath.Join("..", "frontend", "src", "assets", "themes")
	for filename, want := range bundledThemeFiles {
		t.Run(filename, func(t *testing.T) {
			b, err := os.ReadFile(filepath.Join(dir, filename))
			if err != nil {
				t.Fatalf("read bundled theme: %v", err)
			}
			css := string(b)
			if err := ValidateThemeCSS(css); err != nil {
				t.Fatalf("bundled theme must pass validation: %v", err)
			}
			name, typ := ParseThemeCSS(filename, css)
			if name != want.name {
				t.Errorf("name: got %q, want %q", name, want.name)
			}
			if typ != want.typ {
				t.Errorf("type: got %q, want %q", typ, want.typ)
			}
			slug, err := themeSlug(filename)
			if err != nil {
				t.Fatalf("themeSlug(%q): unexpected error %v", filename, err)
			}
			// Import derives the id from the user-chosen path; guard that the
			// canonical in-repo filename round-trips to itself.
			if slug != strings.TrimSuffix(filename, ".css") {
				t.Errorf("slug: got %q, want %q", slug, strings.TrimSuffix(filename, ".css"))
			}
		})
	}
}

func TestValidateThemeCSS_RejectsImport(t *testing.T) {
	cases := []string{
		"@import url('https://evil.example/x.css');\n:root { --color-background: #fff; --color-foreground: #000; }",
		"@IMPORT url('x.css');\n:root { --color-background: #fff; --color-foreground: #000; }",
		"@import \"local.css\";\n:root { --color-background: #fff; --color-foreground: #000; }",
	}
	for i, css := range cases {
		if err := ValidateThemeCSS(css); err == nil {
			t.Errorf("case %d: expected @import rejection, got nil", i)
		}
	}
}

func TestValidateThemeCSS_RejectsExternalURL(t *testing.T) {
	base := ":root { --color-background: #fff; --color-foreground: #000; }"
	cases := []string{
		":root { --icon: url('https://evil.example/i.svg'); " + strings.TrimPrefix(base, ":root ") + " }",
		":root { background-image: url(\"http://evil.example/i.png\"); " + strings.TrimPrefix(base, ":root ") + " }",
		":root { background-image: url(//evil.example/i.png); " + strings.TrimPrefix(base, ":root ") + " }",
		":root { background-image: url(file:///etc/passwd); " + strings.TrimPrefix(base, ":root ") + " }",
		":root { background-image: url(images/bg.png); " + strings.TrimPrefix(base, ":root ") + " }",
		":root { background-image: url(HTTPS://EVIL.EXAMPLE/I.SVG); " + strings.TrimPrefix(base, ":root ") + " }",
	}
	for i, css := range cases {
		if err := ValidateThemeCSS(css); err == nil {
			t.Errorf("case %d: expected external url rejection, got nil", i)
		}
	}
}

func TestValidateThemeCSS_AllowsDataURL(t *testing.T) {
	css := ":root { --color-background: #fff; --color-foreground: #000; --icon: url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=); }"
	if err := ValidateThemeCSS(css); err != nil {
		t.Fatalf("expected data: url to pass, got %v", err)
	}
}

func TestValidateThemeCSS_AllowsUppercaseDataURL(t *testing.T) {
	css := ":root { --color-background: #fff; --color-foreground: #000; --icon: url(DATA:image/svg+xml;base64,AAAA); }"
	if err := ValidateThemeCSS(css); err != nil {
		t.Fatalf("expected DATA: url to pass, got %v", err)
	}
}

func TestValidateThemeCSS_RejectsOversize(t *testing.T) {
	css := ":root { --color-background: #fff; --color-foreground: #000; }\n" + strings.Repeat("/* padding */\n", 40*1024)
	if len(css) <= maxThemeCSSSize {
		t.Fatalf("test setup: payload too small (%d bytes)", len(css))
	}
	if err := ValidateThemeCSS(css); err == nil {
		t.Fatal("expected oversize rejection")
	}
}

func TestValidateThemeCSS_RejectsMissingTokens(t *testing.T) {
	cases := map[string]string{
		"no background": ":root { --color-foreground: #fff; }",
		"no foreground": ":root { --color-background: #fff; }",
	}
	for label, css := range cases {
		if err := ValidateThemeCSS(css); err == nil {
			t.Errorf("%s: expected rejection, got nil", label)
		}
	}
}

func TestThemeSlug(t *testing.T) {
	cases := map[string]string{
		"nord.css":                 "nord",
		"Solarized-Light.css":      "solarized-light",
		"My_Awesome Theme.css":     "my-awesome-theme",
		"../escaped/nord.CSS":      "nord",
		"emoji-🚀-rocket.css":       "emoji-rocket",
		"double--dash.css":         "double-dash",
		"--leading-trailing--.css": "leading-trailing",
	}
	for in, want := range cases {
		got, err := themeSlug(in)
		if err != nil {
			t.Errorf("themeSlug(%q): unexpected error %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("themeSlug(%q): got %q, want %q", in, got, want)
		}
	}
}

func TestThemeSlug_RejectsEmpty(t *testing.T) {
	for _, in := range []string{"", ".css", "---.css", "///"} {
		if _, err := themeSlug(in); err == nil {
			t.Errorf("themeSlug(%q): expected error, got nil", in)
		}
	}
}

func TestThemeSlug_RejectsReserved(t *testing.T) {
	for _, in := range []string{"default-dark.css", "Default-Light.css"} {
		if _, err := themeSlug(in); err == nil {
			t.Errorf("themeSlug(%q): expected reserved-id error, got nil", in)
		}
	}
}
