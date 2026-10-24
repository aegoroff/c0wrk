package backend

import (
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/core/workspace"
)

// ListSkills returns lightweight descriptors for all available skills,
// including project-local skills from the active project's .agents/skills directory.
// Results are cached; the cache is invalidated when the active project changes
// or when a skill directory watcher detects a change.
func (f *FrontendAPI) ListSkills() []SkillDescriptorDTO {
	b := f.builder()
	if b == nil {
		return []SkillDescriptorDTO{}
	}

	// Snapshot active project info for cache key.
	f.activeProjectMu.RLock()
	wsPath := f.activeProjectPath
	f.activeProjectMu.RUnlock()

	projectSkillDir := ""
	if wsPath != "" {
		projectSkillDir = config.ProjectSkillsPath(wsPath)
	}

	// Check cache: valid if gen matches and project path hasn't changed.
	gen := atomic.LoadUint64(&f.skillCacheGen)
	f.skillCacheMu.Lock()
	if f.skillCache != nil && f.skillCacheGenSnapshot == gen && f.skillCacheProjectDir == projectSkillDir {
		cached := f.skillCache
		f.skillCacheMu.Unlock()
		return cached
	}
	f.skillCacheMu.Unlock()

	descriptors := b.GetSkillDescriptors(projectSkillDir)
	result := make([]SkillDescriptorDTO, len(descriptors))
	for i, d := range descriptors {
		result[i] = SkillDescriptorDTO{Name: d.Name, Description: d.Description}
	}

	// Store in cache.
	f.skillCacheMu.Lock()
	f.skillCache = result
	f.skillCacheGenSnapshot = gen
	f.skillCacheProjectDir = projectSkillDir
	f.skillCacheMu.Unlock()

	return result
}

// RefreshSkills forces a re-discovery of every skill directory and returns
// the fresh descriptors — the manual path behind the Capabilities tab's
// refresh button. The directory watchers keep the cache fresh on file
// changes, but directories created after startup are never watched; the
// generation bump makes this call always re-scan.
func (f *FrontendAPI) RefreshSkills() []SkillDescriptorDTO {
	f.invalidateSkillCache()
	return f.ListSkills()
}

// ResolveSkillResourcePath resolves a read_skill_resource tool call's
// (skill, path) arguments to the absolute file path the tool actually read,
// so a tool-call card can open the resource in the viewer. The resolution is
// delegated to the builder (core/builder.go), which scans the same skill
// catalog the tool's per-session SkillManager does — the active project's
// .agents/skills directory first, then the shared base dirs — and applies the
// tool's own SafeResolvePath traversal guard. Returns an error when the
// backend is not ready, the skill is unknown, or the path escapes the skill
// directory; the frontend falls back to rendering the path as plain text.
func (f *FrontendAPI) ResolveSkillResourcePath(skill, path string) (string, error) {
	b := f.builder()
	if b == nil {
		return "", errors.New("backend is not ready")
	}

	// Same workspace snapshot ListSkills uses: the active project's
	// .agents/skills directory joins the front of the discovery set.
	f.activeProjectMu.RLock()
	wsPath := f.activeProjectPath
	f.activeProjectMu.RUnlock()

	projectSkillDir := ""
	if wsPath != "" {
		projectSkillDir = config.ProjectSkillsPath(wsPath)
	}

	return b.ResolveSkillResourcePath(projectSkillDir, skill, path)
}

// The c0wrk-owned skill packs (the research-* methodology skills and the
// study-paper skill) are seeded into this GLOBAL skills directory once per
// launch by seedGlobalPacks (see frontend_api_research.go); the project-local
// .agents/skills directory stays user-owned. See core/papers/skillpack.go and
// core/research/skillpack.go for the packs themselves.

// invalidateSkillCache bumps the generation counter so the next ListSkills
// call re-scans the skill directories.
func (f *FrontendAPI) invalidateSkillCache() {
	atomic.AddUint64(&f.skillCacheGen, 1)
}

// startSkillsWatchers creates a debounced file watcher for each existing
// skill directory. When any change is detected the skill cache is
// invalidated and a skills:changed event is emitted so the frontend
// autocomplete refreshes. Non-existent directories are silently skipped;
// the caller may create them later, but changes inside them won't be
// detected until an app restart. This is an acceptable trade-off — skill
// directories are typically created once during installation.
func (f *FrontendAPI) startSkillsWatchers(dirs []string) {
	f.seedAcquire()
	f.skillWatchersMu.Lock()
	defer f.skillWatchersMu.Unlock()

	for _, dir := range dirs {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		watcher, err := workspace.NewWatcher(dir, func(_ []string) {
			f.invalidateSkillCache()
			f.emitEvent(EventSkillsChanged, nil)
		}, f.log())
		if err != nil {
			f.log().Warn("failed to watch skill directory", "dir", dir, "error", err)
			continue
		}
		// Also watch each immediate subdirectory so that modifications to
		// an existing skill's SKILL.md are detected on platforms where
		// fsnotify does not watch recursively (e.g. Linux inotify).
		if entries, err := os.ReadDir(dir); err == nil {
			for _, entry := range entries {
				if entry.IsDir() {
					_ = watcher.WatchDir(filepath.Join(dir, entry.Name()))
				}
			}
		}
		f.skillWatchers = append(f.skillWatchers, watcher)
	}
}

// closeSkillsWatchers stops all skill directory watchers. Safe to call
// multiple times.
func (f *FrontendAPI) closeSkillsWatchers() {
	f.skillWatchersMu.Lock()
	defer f.skillWatchersMu.Unlock()
	for _, w := range f.skillWatchers {
		_ = w.Close()
	}
	f.skillWatchers = nil
}
