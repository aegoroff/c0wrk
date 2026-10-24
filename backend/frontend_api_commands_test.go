package backend

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeCommandMD writes a command template file into dir and returns its path.
func writeCommandMD(t *testing.T, dir, file, content string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile %s: %v", file, err)
	}
}

// newCommandTestAPI returns a minimal FrontendAPI for ListCommands tests.
func newCommandTestAPI() *FrontendAPI {
	f := &FrontendAPI{
		emitEvent: func(string, ...any) {},
	}
	f.seedPublished.Store(true)
	return f
}

// TestListCommands_DiscoveryAndPrecedence verifies three-level discovery:
// the project-local dir wins over the c0wrk global dir, which wins over the
// user dir; frontmatter fields parse; non-.md files and uninvocable names are
// skipped; the catalog is cached until the project dir changes.
func TestListCommands_DiscoveryAndPrecedence(t *testing.T) {
	ws := t.TempDir()
	wsCmdDir := filepath.Join(ws, ".agents", "commands")
	globalDir := t.TempDir()
	userDir := t.TempDir()

	writeCommandMD(t, wsCmdDir, "deploy.md", "---\ndescription: from project\nagent: reviewer\nmodel: gpt-x\n---\n\nDeploy the service.\n")
	writeCommandMD(t, globalDir, "deploy.md", "---\ndescription: from global\n---\n\nShadowed.\n")
	writeCommandMD(t, userDir, "deploy.md", "---\ndescription: from user\n---\n\nShadowed.\n")
	writeCommandMD(t, globalDir, "review.md", "Plain body, no frontmatter.\n")
	writeCommandMD(t, userDir, "notes.txt", "ignored extension\n")
	writeCommandMD(t, userDir, "has space.md", "uninvocable name\n")
	writeCommandMD(t, userDir, "second.md", "---\ndescription: from user\n---\n\nUser-only command.\n")

	f := newCommandTestAPI()
	f.activeProjectPath = ws
	f.setCommandBaseDirs([]string{globalDir, userDir})

	got := f.ListCommands()
	byName := map[string]CommandDescriptorDTO{}
	for _, c := range got {
		byName[c.Name] = c
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 commands (deploy, review, second), got %d: %+v", len(got), got)
	}
	deploy := byName["deploy"]
	if deploy.Description != "from project" || deploy.Agent != "reviewer" || deploy.Model != "gpt-x" {
		t.Errorf("deploy frontmatter: got %+v", deploy)
	}
	if deploy.Template != "Deploy the service." {
		t.Errorf("deploy template: got %q", deploy.Template)
	}
	if byName["review"].Template != "Plain body, no frontmatter." {
		t.Errorf("review (no frontmatter): got %+v", byName["review"])
	}
	if byName["second"].Description != "from user" {
		t.Errorf("second (user level): got %+v", byName["second"])
	}
	if _, ok := byName["has space"]; ok {
		t.Error("uninvocable command name must be skipped")
	}

	// Cached: the second call is served without a rescan — mutate the file
	// and expect the CACHED template back.
	writeCommandMD(t, wsCmdDir, "deploy.md", "changed\n")
	got = f.ListCommands()
	for _, c := range got {
		if c.Name == "deploy" && c.Template != "Deploy the service." {
			t.Fatalf("cache must serve the first scan, got %+v", c)
		}
	}

	// A project switch (no active project) invalidates the cache: the global
	// deploy now wins.
	f.activeProjectMu.Lock()
	f.activeProjectPath = ""
	f.activeProjectMu.Unlock()
	got = f.ListCommands()
	if len(got) != 3 {
		t.Fatalf("no-project scan: expected 3 commands, got %d", len(got))
	}
	for _, c := range got {
		if c.Name == "deploy" && c.Description != "from global" {
			t.Errorf("without a project the global deploy must win, got %+v", c)
		}
	}
}

// TestParseCommandFile_FrontmatterVariants covers the parser edge cases:
// full and partial frontmatter, CRLF delimiters, unterminated frontmatter,
// unparsable YAML (fail-soft with a captured warning), and body trimming.
func TestParseCommandFile_FrontmatterVariants(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		file    string
		content string
		check   func(t *testing.T, desc CommandDescriptorDTO)
	}{
		{
			name:    "partial frontmatter keeps unknown keys ignored",
			file:    "a.md",
			content: "---\ndescription: Only desc\nbogus: 42\n---\n\nBody line.\n",
			check: func(t *testing.T, d CommandDescriptorDTO) {
				if d.Description != "Only desc" || d.Agent != "" || d.Model != "" {
					t.Errorf("partial frontmatter: %+v", d)
				}
				if d.Template != "Body line." {
					t.Errorf("template: %q", d.Template)
				}
			},
		},
		{
			name:    "CRLF frontmatter",
			file:    "b.md",
			content: "---\r\ndescription: crlf\r\n---\r\n\r\nBody.\r\n",
			check: func(t *testing.T, d CommandDescriptorDTO) {
				if d.Description != "crlf" {
					t.Errorf("crlf description: %+v", d)
				}
				if d.Template != "Body." {
					t.Errorf("crlf template: %q", d.Template)
				}
			},
		},
		{
			name:    "unterminated frontmatter degrades to body",
			file:    "c.md",
			content: "---\ndescription: never closed\nBody.\n",
			check: func(t *testing.T, d CommandDescriptorDTO) {
				if d.Description != "" || !strings.Contains(d.Template, "description: never closed") {
					t.Errorf("unterminated frontmatter: %+v", d)
				}
			},
		},
		{
			name:    "empty frontmatter block",
			file:    "d.md",
			content: "---\n---\nBody only.\n",
			check: func(t *testing.T, d CommandDescriptorDTO) {
				if d.Template != "Body only." {
					t.Errorf("empty frontmatter template: %q", d.Template)
				}
			},
		},
		{
			name:    "body keeps first-line indentation",
			file:    "e.md",
			content: "---\n---\n\n  indented first line\n",
			check: func(t *testing.T, d CommandDescriptorDTO) {
				if d.Template != "  indented first line" {
					t.Errorf("indentation: %q", d.Template)
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			writeCommandMD(t, dir, tc.file, tc.content)
			desc, ok := parseCommandFile(filepath.Join(dir, tc.file), strings.TrimSuffix(tc.file, ".md"), nil)
			if !ok {
				t.Fatal("parseCommandFile reported !ok")
			}
			tc.check(t, desc)
		})
	}

	t.Run("unparsable yaml warns and keeps the command", func(t *testing.T) {
		var buf bytes.Buffer
		log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn}))
		writeCommandMD(t, dir, "broken.md", "---\ndescription: [unclosed\n---\n\nBody.\n")
		desc, ok := parseCommandFile(filepath.Join(dir, "broken.md"), "broken", log)
		if !ok || desc.Template != "Body." || desc.Description != "" {
			t.Fatalf("fail-soft parse: ok=%v %+v", ok, desc)
		}
		if !strings.Contains(buf.String(), "command frontmatter unparsable") {
			t.Errorf("expected a captured warning, log: %s", buf.String())
		}
	})

	t.Run("unreadable file drops the command", func(t *testing.T) {
		if _, ok := parseCommandFile(filepath.Join(dir, "missing.md"), "missing", nil); ok {
			t.Fatal("missing file must not parse")
		}
	})
}

// TestValidCommandName pins the invocable-name character class (the same set
// the backend mention scanner tolerates).
func TestValidCommandName(t *testing.T) {
	valid := []string{"a", "deploy", "run-tests", "v2_beta", "Test-1"}
	invalid := []string{"", "has space", "dot.name", "slash/name", "emoji🎉", "café"}
	for _, n := range valid {
		if !validCommandName(n) {
			t.Errorf("validCommandName(%q) = false, want true", n)
		}
	}
	for _, n := range invalid {
		if validCommandName(n) {
			t.Errorf("validCommandName(%q) = true, want false", n)
		}
	}
}

// TestStartCommandsWatchers_InvalidatesCacheAndEmits verifies the watcher
// wiring: a change in a watched global dir invalidates the command cache and
// emits commands:changed.
func TestStartCommandsWatchers_InvalidatesCacheAndEmits(t *testing.T) {
	globalDir := t.TempDir()
	writeCommandMD(t, globalDir, "first.md", "First body.\n")

	// Event barrier: the emitEvent double signals the channel instead of
	// bumping a counter, so the wait below blocks on a real event rather
	// than polling with time.Sleep. Buffered + non-blocking send keeps the
	// watcher callback safe if more than one emission arrives.
	changed := make(chan struct{}, 1)
	f := &FrontendAPI{
		emitEvent: func(name string, _ ...any) {
			if name == EventCommandsChanged {
				select {
				case changed <- struct{}{}:
				default:
				}
			}
		},
	}
	f.seedPublished.Store(true)
	t.Cleanup(f.closeCommandsWatchers)

	f.setCommandBaseDirs([]string{globalDir})
	f.startCommandsWatchers([]string{globalDir})
	if len(f.commandWatchers) != 1 {
		t.Fatalf("expected 1 command watcher, got %d", len(f.commandWatchers))
	}

	if got := f.ListCommands(); len(got) != 1 || got[0].Template != "First body." {
		t.Fatalf("ListCommands initial: %+v", got)
	}

	// Modify the file to trigger the watcher.
	writeCommandMD(t, globalDir, "first.md", "Updated body.\n")

	// Wait for the debounced commands:changed emission (fsnotify latency on
	// macOS + the watcher debounce window) by selecting on the barrier vs a
	// bounded timeout.
	timer := time.NewTimer(3 * time.Second)
	t.Cleanup(func() { timer.Stop() })
	select {
	case <-changed:
	case <-timer.C:
		t.Fatal("expected commands:changed emission after command file modification")
	}

	got := f.ListCommands()
	if len(got) != 1 || got[0].Template != "Updated body." {
		t.Fatalf("ListCommands after change (cache must be invalidated): %+v", got)
	}
}

// TestStartCommandsWatchers_SkipsMissingDirs verifies that non-existent
// command directories are silently skipped.
func TestStartCommandsWatchers_SkipsMissingDirs(t *testing.T) {
	f := newCommandTestAPI()
	f.startCommandsWatchers([]string{"/nonexistent/commands/dir"})
	if len(f.commandWatchers) != 0 {
		t.Errorf("expected 0 watchers for non-existent dir, got %d", len(f.commandWatchers))
	}
}

// TestCloseCommandsWatchers_Idempotent verifies that closeCommandsWatchers
// can be called multiple times safely.
func TestCloseCommandsWatchers_Idempotent(t *testing.T) {
	f := newCommandTestAPI()
	f.startCommandsWatchers([]string{t.TempDir()})
	f.closeCommandsWatchers()
	f.closeCommandsWatchers() // must not panic
	if len(f.commandWatchers) != 0 {
		t.Errorf("expected 0 watchers after close, got %d", len(f.commandWatchers))
	}
}
