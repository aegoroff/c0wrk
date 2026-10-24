package core

import "testing"

// TestIsAbsolutePath covers the three absolute dialects the @file resolver
// recognizes (POSIX leading "/", Windows drive-rooted, Windows UNC) and the
// look-alike forms that must stay relative.
func TestIsAbsolutePath(t *testing.T) {
	tests := []struct {
		name string
		path string
		want bool
	}{
		{"empty", "", false},
		{"plain relative", "x.go", false},
		{"nested posix relative", "dir/x.go", false},
		{"nested windows relative", `dir\x.go`, false},
		{"posix root", "/", true},
		{"posix absolute", "/abs/path/x.go", true},
		{"unc forward slashes", "//server/share", true},
		{"unc backslashes", `\\server\share\f.md`, true},
		{"unc mixed separators", `\/server/share`, true},
		{"drive rooted backslashes", `C:\Documents\f.md`, true},
		{"drive rooted forward slashes", "C:/Documents/f.md", true},
		{"drive rooted lowercase", `c:\temp`, true},
		{"drive rooted last letter", `z:/x`, true},
		{"drive relative missing separator", "C:x", false},
		{"bare drive colon", "C:", false},
		{"digit is not a drive letter", `1:\x`, false},
		{"tilde is not absolute", "~", false},
		{"home relative", "~/notes/x.go", false},
		{"single leading backslash", `\x`, false},
		{"leading space", ` C:\x`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsAbsolutePath(tt.path); got != tt.want {
				t.Errorf("IsAbsolutePath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

// TestNormalizeAbsPath pins the canonical forward-slash forms the frontend
// consumes (localFileLink.ts normalizeAbsolute): POSIX "/a/b", drive-rooted
// "C:/a/b" (no leading slash before the drive letter), UNC
// "//server/share/a/b" (double-slash prefix preserved), with ".." clamped at
// the anchored root.
func TestNormalizeAbsPath(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{"drive separators normalized", `C:\Documents\f.md`, "C:/Documents/f.md"},
		{"drive mixed separators", `C:/mixed\path/f.md`, "C:/mixed/path/f.md"},
		{"unc separators normalized", `\\server\share\f.md`, "//server/share/f.md"},
		{"unc duplicate separators collapsed", "//a//b///c.md", "//a/b/c.md"},
		{"drive dot segments resolved", `C:\a\.\b\..\c.md`, "C:/a/c.md"},
		{"unc dotdot cannot cross the share", `\\server\share\..\other\f.md`, "//server/share/other/f.md"},
		{"drive dotdot clamped at drive root", `C:\..\x.md`, "C:/x.md"},
		{"unc dotdot clamped at share", `\\srv\share\..\..\f.md`, "//srv/share/f.md"},
		{"posix dotdot clamped at root", "/a/../../b.md", "/b.md"},
		{"drive root", `C:\`, "C:/"},
		{"bare unc prefix", "//", "//"},
		{"unc trailing separator", `\\server\share\`, "//server/share"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NormalizeAbsPath(tt.path); got != tt.want {
				t.Errorf("NormalizeAbsPath(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}
