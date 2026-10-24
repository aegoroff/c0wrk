package backend

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestResolveReadablePath_PathDialects pins the lexical path-dialect handling
// shared by every read-path RPC (ReadFile, GetFileIcon, ReadImageAsDataURL,
// GetFileDiff) through resolveReadablePath. Windows drive and UNC paths must
// pass through verbatim — never joined onto the process CWD as rooted junk
// ("/C:\x\f.md") — the legacy rooted spelling "/C:/x/f.md" must un-root to
// its native form, and POSIX absolute/relative paths must keep resolving
// byte-for-byte as before. The table is GOOS-independent by design: the
// resolver is purely lexical, so every row asserts identically on every
// platform.
func TestResolveReadablePath_PathDialects(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	f := &FrontendAPI{}
	f.seedPublished.Store(true)

	tests := []struct {
		name string
		in   string
		want string
	}{
		// Windows drive paths: verbatim, never CWD-joined.
		{"drive backslashes", `C:\x\f.md`, `C:\x\f.md`},
		{"drive forward slashes", "C:/x/f.md", "C:/x/f.md"},
		{"drive lowercase", `d:\notes\todo.txt`, `d:\notes\todo.txt`},
		{"drive root only", `C:\`, `C:\`},
		{"drive mixed separators", `C:/x\y\f.md`, `C:/x\y\f.md`},
		{"drive with line anchor", `C:\x\f.md#L20-L36`, `C:\x\f.md`},
		// Legacy rooted spelling: the bolt-on POSIX slash is stripped.
		{"legacy rooted drive", "/C:/x/f.md", "C:/x/f.md"},
		{"legacy rooted drive backslashes", `/C:\x\f.md`, `C:\x\f.md`},
		{"legacy rooted drive with anchor", "/C:/x/f.md#L5-L10", "C:/x/f.md"},
		{"legacy rooted lowercase drive", "/d:/notes/todo.txt", "d:/notes/todo.txt"},
		// UNC paths: verbatim, including the canonical forward-slash form
		// whose leading slash must NOT be stripped as legacy rooting.
		{"UNC backslashes", `\\server\share\f.md`, `\\server\share\f.md`},
		{"UNC forward slashes", "//server/share/f.md", "//server/share/f.md"},
		{"UNC forward slashes with anchor", "//server/share/f.md#L3", "//server/share/f.md"},
		{"UNC with line anchor", `\\server\share\f.md#L3`, `\\server\share\f.md`},
		// POSIX absolute paths: byte-for-byte; a directory named "C" is
		// NOT a drive letter (no colon).
		{"POSIX absolute", "/etc/passwd", "/etc/passwd"},
		{"POSIX absolute C dir not a drive", "/C/x/f.md", "/C/x/f.md"},
		{"POSIX root", "/", "/"},
		// Relative paths: the historical filepath.Abs behaviour.
		{"relative", "x/f.md", filepath.Join(cwd, "x", "f.md")},
		{"dot relative", "./x/f.md", filepath.Join(cwd, "x", "f.md")},
		{"empty resolves to CWD", "", cwd},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := f.resolveReadablePath(tt.in)
			if err != nil {
				t.Fatalf("resolveReadablePath(%q): unexpected error: %v", tt.in, err)
			}
			if got != tt.want {
				t.Errorf("resolveReadablePath(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// TestReadPathRPCs_SharedResolutionTable drives the read-path RPC family
// (ReadFile, GetFileIcon, ReadImageAsDataURL, ReadFileAsDataURL, GetFileDiff)
// through one shared table of path spellings pointing at a real file inside a
// real git repository, proving every RPC resolves each spelling to the same
// file. ReadFileAsDataURL resolves via the workspace-contained
// resolveWorkspacePath rather than resolveReadablePath (security boundary);
// it is in the table because every spelling here lands inside the workspace,
// so the contained resolver must succeed on them exactly like the readable
// one — its out-of-workspace refusals are guarded by
// TestReadFileAsDataURL_RetainsContainment.
func TestReadPathRPCs_SharedResolutionTable(t *testing.T) {
	tmpDir := t.TempDir()
	f := &FrontendAPI{activeProjectPath: tmpDir}
	f.seedPublished.Store(true)
	gitInit(t, tmpDir)

	content := "# readme\n\nsome text\n"
	filePath := filepath.Join(tmpDir, "notes", "readme.md")
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	rel := filepath.Join("notes", "readme.md")
	spellings := []struct {
		name  string
		in    string
		chdir bool
	}{
		{"absolute", filePath, false},
		{"absolute with line anchor", filePath + "#L1-L2", false},
		{"relative", rel, true},
		{"dot relative", "." + string(filepath.Separator) + rel, true},
	}

	for _, tc := range spellings {
		t.Run(tc.name, func(t *testing.T) {
			if tc.chdir {
				t.Chdir(tmpDir)
			}

			// ReadFile returns the file content.
			got, err := f.ReadFile(tc.in)
			if err != nil {
				t.Fatalf("ReadFile(%q): %v", tc.in, err)
			}
			if got != content {
				t.Errorf("ReadFile(%q) = %q, want %q", tc.in, got, content)
			}

			// GetFileIcon resolves far enough to classify the extension.
			icon, err := f.GetFileIcon(tc.in)
			if err != nil {
				t.Fatalf("GetFileIcon(%q): %v", tc.in, err)
			}
			if icon.Icon == "" {
				t.Errorf("GetFileIcon(%q) returned an empty icon", tc.in)
			}

			// ReadImageAsDataURL encodes the very same bytes.
			dataURL, err := f.ReadImageAsDataURL(tc.in)
			if err != nil {
				t.Fatalf("ReadImageAsDataURL(%q): %v", tc.in, err)
			}
			assertDataURLPayload(t, "ReadImageAsDataURL", tc.in, dataURL, content)

			// ReadFileAsDataURL (workspace-contained resolver) encodes the
			// same bytes for in-workspace spellings.
			containedURL, err := f.ReadFileAsDataURL(tc.in)
			if err != nil {
				t.Fatalf("ReadFileAsDataURL(%q): %v", tc.in, err)
			}
			assertDataURLPayload(t, "ReadFileAsDataURL", tc.in, containedURL, content)

			// GetFileDiff resolves into the repo: the untracked file yields
			// its standard untracked diff.
			diff, err := f.GetFileDiff(tc.in)
			if err != nil {
				t.Fatalf("GetFileDiff(%q): %v", tc.in, err)
			}
			if diff == "" {
				t.Errorf("GetFileDiff(%q) = \"\", want the untracked-file diff", tc.in)
			}
			if !strings.Contains(diff, "readme.md") {
				t.Errorf("GetFileDiff(%q) = %q, want it to mention readme.md", tc.in, diff)
			}
		})
	}
}

// TestReadPathRPCs_DriveSpellingIconNoError proves a Windows drive/UNC
// spelling survives the full GetFileIcon RPC on any host: the resolution is
// purely lexical, so the viewer gets an icon instead of a resolution error
// even when no filesystem exists behind the path.
func TestReadPathRPCs_DriveSpellingIconNoError(t *testing.T) {
	f := &FrontendAPI{}
	f.seedPublished.Store(true)

	for _, in := range []string{`C:\x\f.md`, "C:/x/f.md", "/C:/x/f.md", `\\server\share\f.md`, "//server/share/f.md"} {
		icon, err := f.GetFileIcon(in)
		if err != nil {
			t.Fatalf("GetFileIcon(%q): unexpected error: %v", in, err)
		}
		if icon.Icon == "" {
			t.Errorf("GetFileIcon(%q) returned an empty icon", in)
		}
	}
}

// assertDataURLPayload asserts that got is an RFC 2397 data URL whose base64
// payload decodes to exactly want — the shared encoding check for the two
// data-URL RPCs in the resolution table.
func assertDataURLPayload(t *testing.T, rpc, in, got, want string) {
	t.Helper()
	_, payload, ok := strings.Cut(got, "data:")
	if !ok {
		t.Fatalf("%s(%q) = %q, want a data: URL", rpc, in, got)
	}
	_, b64, ok := strings.Cut(payload, ";base64,")
	if !ok {
		t.Fatalf("%s(%q) = %q, want a ;base64, payload", rpc, in, got)
	}
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("%s(%q): bad base64 payload: %v", rpc, in, err)
	}
	if string(decoded) != want {
		t.Errorf("%s(%q) payload = %q, want %q", rpc, in, decoded, want)
	}
}
