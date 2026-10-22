package backend

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/core/workspace"
	"gopkg.in/yaml.v3"
)

// commandFileExt is the only file extension the command discovery recognizes.
const commandFileExt = ".md"

// commandFrontmatter is the YAML frontmatter schema of a command template
// file (ADR-092). Unknown keys are ignored; every field is optional.
type commandFrontmatter struct {
	Description string `yaml:"description"`
	Agent       string `yaml:"agent"`
	Model       string `yaml:"model"`
}

// ListCommands returns the custom command descriptors for /-autocomplete and
// send-time template expansion (ADR-092): the project-local .agents/commands
// directory (highest precedence, when a project is active) plus the configured
// global command dirs in priority order. The first file claiming a name wins;
// results are cached and invalidated on project switches and by the
// global-dir watchers. Command discovery is backend-owned — core never
// consumes commands — so this scan mirrors ListSkills structurally without
// going through the builder.
func (f *FrontendAPI) ListCommands() []CommandDescriptorDTO {
	// Snapshot active project info for the cache key (same pattern as ListSkills).
	f.activeProjectMu.RLock()
	wsPath := f.activeProjectPath
	f.activeProjectMu.RUnlock()

	projectCommandDir := ""
	if wsPath != "" {
		projectCommandDir = config.ProjectCommandsPath(wsPath)
	}

	// Check cache: valid if gen matches and project path hasn't changed.
	gen := atomic.LoadUint64(&f.commandCacheGen)
	f.commandCacheMu.Lock()
	if f.commandCache != nil && f.commandCacheGenSnapshot == gen && f.commandCacheProjectDir == projectCommandDir {
		cached := f.commandCache
		f.commandCacheMu.Unlock()
		return cached
	}
	f.commandCacheMu.Unlock()

	result := f.scanCommands(projectCommandDir, f.commandBaseDirs())

	// Store cache.
	f.commandCacheMu.Lock()
	f.commandCache = result
	f.commandCacheGenSnapshot = gen
	f.commandCacheProjectDir = projectCommandDir
	f.commandCacheMu.Unlock()

	return result
}

// setCommandBaseDirs stores the resolved global command directories for
// ListCommands's discovery. Called once at startup with the same resolved
// list the watchers get: like the watchers, the list is fixed until the next
// app restart (the accepted skills/agents trade-off — directories configured
// later are picked up on restart).
func (f *FrontendAPI) setCommandBaseDirs(dirs []string) {
	f.commandWatchersMu.Lock()
	defer f.commandWatchersMu.Unlock()
	f.commandDirs = append([]string(nil), dirs...)
}

// commandBaseDirs returns the stored resolved global command directories.
func (f *FrontendAPI) commandBaseDirs() []string {
	f.commandWatchersMu.Lock()
	defer f.commandWatchersMu.Unlock()
	return f.commandDirs
}

// invalidateCommandCache bumps the generation counter so the next ListCommands
// call re-scans the command directories.
func (f *FrontendAPI) invalidateCommandCache() {
	atomic.AddUint64(&f.commandCacheGen, 1)
}

// startCommandsWatchers creates a debounced file watcher for each existing
// global command directory. When any change is detected the command cache is
// invalidated and a commands:changed event is emitted so the frontend
// autocomplete refreshes. Non-existent directories are silently skipped; the
// caller may create them later, but changes inside them won't be detected
// until an app restart — the same accepted trade-off as the skill watchers.
// Commands are flat .md files, so — unlike skills — no subdirectory watches
// are needed.
func (f *FrontendAPI) startCommandsWatchers(dirs []string) {
	f.seedAcquire()
	f.commandWatchersMu.Lock()
	defer f.commandWatchersMu.Unlock()

	for _, dir := range dirs {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		watcher, err := workspace.NewWatcher(dir, func(_ []string) {
			f.invalidateCommandCache()
			f.emitEvent(EventCommandsChanged, nil)
		}, f.log())
		if err != nil {
			f.log().Warn("failed to watch command directory", "dir", dir, "error", err)
			continue
		}
		f.commandWatchers = append(f.commandWatchers, watcher)
	}
}

// closeCommandsWatchers stops all command directory watchers. Safe to call
// multiple times.
func (f *FrontendAPI) closeCommandsWatchers() {
	f.commandWatchersMu.Lock()
	defer f.commandWatchersMu.Unlock()
	for _, w := range f.commandWatchers {
		_ = w.Close()
	}
	f.commandWatchers = nil
}

// scanCommands discovers command template files across the precedence-ordered
// directory list: the project-local dir first (highest priority, may be empty
// when no project is active), then the resolved global dirs in config order.
// The first file claiming a name wins; every returned name is unique. The
// result is always non-nil so the cache can distinguish "scanned, empty"
// from "never scanned".
func (f *FrontendAPI) scanCommands(projectDir string, baseDirs []string) []CommandDescriptorDTO {
	dirs := make([]string, 0, len(baseDirs)+1)
	if projectDir != "" {
		dirs = append(dirs, projectDir)
	}
	dirs = append(dirs, baseDirs...)

	result := make([]CommandDescriptorDTO, 0)
	seen := make(map[string]struct{})
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			// A missing directory is normal (nothing created yet); anything
			// else is worth a warning but never fatal.
			if !os.IsNotExist(err) {
				f.log().Warn("command directory unreadable", "dir", dir, "error", err)
			}
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != commandFileExt {
				continue
			}
			name := strings.TrimSuffix(entry.Name(), commandFileExt)
			if !validCommandName(name) {
				f.log().Debug("skipping command file with uninvocable name", "path", filepath.Join(dir, entry.Name()))
				continue
			}
			if _, dup := seen[name]; dup {
				continue
			}
			desc, ok := parseCommandFile(filepath.Join(dir, entry.Name()), name, f.log())
			if !ok {
				continue
			}
			seen[name] = struct{}{}
			result = append(result, desc)
		}
	}
	return result
}

// parseCommandFile reads one command template file and fills the descriptor:
// the optional YAML frontmatter supplies description/agent/model, the
// remaining body is the template. Read failures drop the file (ok=false);
// frontmatter parse failures are fail-soft — the command stays listed with
// empty metadata (mirroring the capability-mode load philosophy), with a
// warning on log.
func parseCommandFile(path, name string, log *slog.Logger) (CommandDescriptorDTO, bool) {
	content, err := os.ReadFile(path)
	if err != nil {
		return CommandDescriptorDTO{}, false
	}
	var meta commandFrontmatter
	text := string(content)
	body := text
	if fm, rest, has := splitFrontmatter(text); has {
		if err := yaml.Unmarshal([]byte(fm), &meta); err != nil {
			// The file is user config: a broken frontmatter must be visible
			// but never disqualify the command (the body may still be fine).
			if log != nil {
				log.Warn("command frontmatter unparsable; metadata ignored", "path", path, "error", err)
			}
			meta = commandFrontmatter{}
		}
		body = rest
	}
	// Trim the leading newlines left by the frontmatter delimiter (both LF
	// and CRLF flavors) and the trailing whitespace; the first line's
	// indentation is preserved.
	body = strings.TrimLeft(body, "\r\n")
	body = strings.TrimRight(body, " \t\n\r")
	return CommandDescriptorDTO{
		Name:        name,
		Description: meta.Description,
		Agent:       meta.Agent,
		Model:       meta.Model,
		Template:    body,
	}, true
}

// splitFrontmatter splits a leading YAML frontmatter block off content: the
// first line must be exactly "---", followed by YAML lines terminated by a
// second exactly-"---" line. It returns the inner YAML text and everything
// after the closing delimiter. A missing or unterminated frontmatter yields
// has=false and the full content as the body.
func splitFrontmatter(content string) (fm, body string, has bool) {
	first, rest, found := cutLine(content)
	if !found || strings.TrimRight(first, "\r") != "---" {
		return "", content, false
	}
	var lines []string
	for {
		line, restAfter, found := cutLine(rest)
		if !found {
			// Unterminated frontmatter is a broken file; the conservative
			// reading is "no frontmatter" — the body is the full content.
			return "", content, false
		}
		if strings.TrimRight(line, "\r") == "---" {
			return strings.Join(lines, "\n"), restAfter, true
		}
		lines = append(lines, strings.TrimRight(line, "\r"))
		rest = restAfter
	}
}

// cutLine splits off the first line of s including its terminating newline
// (when present). found is false only for an empty remainder.
func cutLine(s string) (line, rest string, found bool) {
	if s == "" {
		return "", "", false
	}
	idx := strings.IndexByte(s, '\n')
	if idx < 0 {
		return s, "", true
	}
	return s[:idx], s[idx+1:], true
}

// validCommandName reports whether name can be invoked through the chat
// input's /-grammar: non-empty ASCII letters, digits, underscore, hyphen —
// the same character class the backend mention scanner tolerates (core's
// isMentionNameByte). Anything else cannot be typed as a ref and is skipped
// at discovery.
func validCommandName(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' {
			continue
		}
		return false
	}
	return true
}
