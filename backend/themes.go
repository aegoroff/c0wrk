package backend

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// User theme type constants as exposed in ThemeDTO.Type.
const (
	themeTypeDark  = "dark"
	themeTypeLight = "light"
)

// maxThemeCSSSize is the maximum accepted theme CSS size: 512 KiB. Themes are
// plain variable-definition stylesheets; anything larger is either malformed
// or embedding heavy assets (which the url() validation already rejects).
const maxThemeCSSSize = 512 * 1024

// reservedThemeIDs are theme identifiers owned by the built-in themes. An
// imported theme can never take one of these slugs. `default-dark` /
// `default-light` name the built-ins themselves; `dark` / `light` are the
// data-theme attribute keys the built-ins write, so a custom slug named
// `light` or `dark` could alias the built-in override blocks.
var reservedThemeIDs = map[string]struct{}{
	"default-dark":  {},
	"default-light": {},
	"dark":          {},
	"light":         {},
}

// ThemeDTO is a lightweight user-theme descriptor exposed to the frontend.
// ID is the stable slug (the CSS file name stem inside the themes directory);
// Type is one of "dark" or "light". CSS carries the theme body and is
// populated by both ImportThemeFromPath and ListThemes — the frontend
// activates a custom theme from either the import result or a list entry
// without a second RPC, and keeps its own persisted cache for the pre-paint
// apply.
type ThemeDTO struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	CSS  string `json:"css"`
}

// themeHeaderRe matches the metadata header comment that must open a theme
// file: `/* c0wrk-theme: <name> | <dark|light> */`. The keyword and the type
// keyword are matched case-insensitively; the name is free text. The regex is
// anchored to the start of the file (leading whitespace allowed) — a marker
// elsewhere in the body is not a header and is ignored.
var themeHeaderRe = regexp.MustCompile(`(?is)^\s*/\*\s*c0wrk-theme\s*:\s*(.+?)\s*\|\s*(dark|light)\s*\*/`)

// colorSchemeRe matches a `color-scheme: dark|light` declaration in the CSS
// body. The character preceding `color-scheme` must not be a word character
// or a hyphen so the `prefers-color-scheme` media feature does not
// false-positive as a type declaration.
var colorSchemeRe = regexp.MustCompile(`(?i)(?:^|[^-\w])color-scheme\s*:\s*["']?(dark|light)\b`)

// themeImportRe and the url() regex previously used by ValidateThemeCSS are
// gone: validation is now structural (see sanitizeThemeCSS), not a chain of
// pattern rejections.

// Slug normalization helpers: disallowed character runs and repeated hyphens
// both collapse to a single hyphen.
var (
	slugDisallowedRe = regexp.MustCompile(`[^a-z0-9-]+`)
	slugDashesRe     = regexp.MustCompile(`-{2,}`)
)

// ParseThemeCSS extracts a theme's display name and type from its CSS source
// using the fallback chain:
//
//  1. name/type from the `/* c0wrk-theme: <name> | <dark|light> */` header;
//  2. name falls back to a prettified file name (nord.css → "Nord");
//  3. type falls back to a `color-scheme: dark|light` declaration in the body;
//  4. type finally falls back to "dark".
//
// It never fails — a theme without recognizable metadata still lists under a
// derived name and defaults to the dark type.
func ParseThemeCSS(filename, content string) (name, typ string) {
	name, typ = "", ""
	if m := themeHeaderRe.FindStringSubmatch(content); m != nil {
		name = strings.TrimSpace(m[1])
		typ = strings.ToLower(m[2])
	}
	if name == "" {
		name = prettyThemeName(filename)
	}
	if typ == "" {
		if m := colorSchemeRe.FindStringSubmatch(content); m != nil {
			typ = strings.ToLower(m[1])
		} else {
			typ = themeTypeDark
		}
	}
	return name, typ
}

// ValidateThemeCSS checks that a CSS document is safe to install as a user
// theme. Themes are injected into the webview as a global <style> element, so
// the document is untrusted input: it is parsed with a real CSS tokenizer and
// must consist solely of custom-property declarations on a single :root rule
// (plus the metadata header comment and one optional color-scheme
// declaration). Values may reference only literal tokens, data: URLs, and a
// small allowlist of functions — every resource-referencing construct
// (@import, url(), image-set(), escaped identifiers, …) is rejected by
// construction rather than by enumeration. See sanitizeThemeCSS.
//
// The document must also declare both --color-background and
// --color-foreground (the minimal contract the frontend relies on) and stay
// within maxThemeCSSSize.
func ValidateThemeCSS(content string) error {
	if len(content) > maxThemeCSSSize {
		return fmt.Errorf("theme CSS is too large: %d bytes (limit %d)", len(content), maxThemeCSSSize)
	}
	_, err := sanitizeThemeCSS(content)
	return err
}

// themeSlug derives the stable theme identifier from a CSS file name: the
// base name without extension, lowercased, restricted to [a-z0-9-] with runs
// of disallowed characters collapsed to single hyphens and edge hyphens
// trimmed. It returns an error when the result is empty or collides with a
// reserved built-in theme id.
func themeSlug(filename string) (string, error) {
	base := strings.ToLower(filepath.Base(filename))
	base = strings.TrimSuffix(base, ".css")
	base = slugDisallowedRe.ReplaceAllString(base, "-")
	base = slugDashesRe.ReplaceAllString(base, "-")
	base = strings.Trim(base, "-")
	if base == "" {
		return "", fmt.Errorf("theme file name %q does not produce a valid theme id", filepath.Base(filename))
	}
	if _, reserved := reservedThemeIDs[base]; reserved {
		return "", fmt.Errorf("theme id %q is reserved for built-in themes", base)
	}
	return base, nil
}

// prettyThemeName turns a theme file name into a human-friendly display name:
// the extension is dropped, `-`/`_` become spaces, and every word is
// capitalized (nord.css → "Nord", solarized-light.css → "Solarized Light").
// Names that normalize to nothing fall back to "Theme".
func prettyThemeName(filename string) string {
	base := filepath.Base(filename)
	if ext := filepath.Ext(base); ext != "" {
		base = strings.TrimSuffix(base, ext)
	}
	base = strings.NewReplacer("-", " ", "_", " ").Replace(base)
	words := strings.Fields(base)
	if len(words) == 0 {
		return "Theme"
	}
	var b strings.Builder
	for i, w := range words {
		if i > 0 {
			b.WriteByte(' ')
		}
		r, size := utf8.DecodeRuneInString(w)
		b.WriteRune(unicode.ToUpper(r))
		b.WriteString(w[size:])
	}
	return b.String()
}
