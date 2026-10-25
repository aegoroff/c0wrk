package backend

import "testing"

// TestSanitizeAttachmentName pins the untrusted-name reduction: separator
// stripping, the MIME extension fallback for extensionless image drops, and
// the Windows reserved-device escape ("nul.png" → "nul_.png" — Windows
// resolves a reserved device name even with an extension, so the staged
// name must never carry one verbatim). The escape keys on the FIRST-dot
// stem: "nul.tar.gz" would resolve the NUL device too, so a last-extension
// check is not enough.
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
		// Reserved stem BEFORE THE FIRST DOT: multi-dot names resolve the
		// device on Windows just like their single-extension spellings.
		{"nul.tar.gz", "", "nul_.tar.gz"},
		{"COM1.docx.bak", "", "COM1_.docx.bak"},
		{"aux.aux", "", "aux_.aux"},
		// A reserved name as a prefix of a longer base is a regular name.
		{"nullified.png", "", "nullified.png"},
		{"nul.tar.noext.reserved", "", "nul_.tar.noext.reserved"},
		{" econ", "", "econ"},
	}
	for _, tc := range cases {
		if got := sanitizeAttachmentName(tc.name, tc.mime); got != tc.want {
			t.Errorf("sanitizeAttachmentName(%q, %q) = %q, want %q", tc.name, tc.mime, got, tc.want)
		}
	}
}
