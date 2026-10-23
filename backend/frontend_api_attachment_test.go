package backend

import "testing"

// TestSanitizeAttachmentName pins the untrusted-name reduction: separator
// stripping, the MIME extension fallback for extensionless image drops, and
// the Windows reserved-device escape ("nul.png" → "nul_.png" — Windows
// resolves a reserved device name even with an extension, so the staged
// name must never carry one verbatim).
func TestSanitizeAttachmentName(t *testing.T) {
	cases := []struct{ name, mime, want string }{
		{"report.pdf", "", "report.pdf"},
		{`..\..\etc\passwd`, "", "passwd"},
		{"notes.md", "", "notes.md"},
		{"screenshot", "image/png", "screenshot.png"},
		{"", "", ""},
		{".", "", ""},
		{"..", "", ""},
		// Windows reserved device names, escaped with an appended underscore.
		{"nul.png", "", "nul_.png"},
		{"NUL", "", "NUL_"},
		{"con.txt", "", "con_.txt"},
		{"com1", "", "com1_"},
		{"LPT4.log", "", "LPT4_.log"},
		{"aux", "image/gif", "aux_.gif"},
		// A reserved name as a prefix of a longer base is a regular name.
		{"nullified.png", "", "nullified.png"},
		{" econ", "", "econ"},
	}
	for _, tc := range cases {
		if got := sanitizeAttachmentName(tc.name, tc.mime); got != tc.want {
			t.Errorf("sanitizeAttachmentName(%q, %q) = %q, want %q", tc.name, tc.mime, got, tc.want)
		}
	}
}
