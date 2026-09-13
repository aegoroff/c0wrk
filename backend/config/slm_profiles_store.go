package config

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Persistence layer for custom SLM profiles: a versioned YAML file at
// ~/.c0wrk/slm-profiles.yaml (path from SLMProfilesPath) holding the
// operator-authored profiles alongside the hard-coded predefined catalog
// from slm_profiles.go.
//
// Format (version 1):
//
//	version: 1
//	profiles:
//	  - id: my-tuned-profile
//	    name: My Tuned Profile
//	    kind: custom
//	    config: { ...the 25 profile knobs... }
//
// Loading is fail-soft by design: a fully broken file (unreadable,
// unparseable, wrong version) degrades to an empty profile list with a
// warning instead of failing startup, and a partially broken file keeps
// its valid entries while the broken ones are discarded with per-entry
// warnings. Saving is fail-closed: the whole set is validated before any
// byte is written, and the write itself is an atomic tmp+rename full
// rewrite (mirroring Save), so a half-written file can never exist.

// slmProfilesFormatVersion is the only file format version this build
// understands. A file with any other version value is treated as
// uninterpretable: load degrades to an empty list with a warning (the
// file content is left untouched for a newer build to read).
const slmProfilesFormatVersion = 1

// slmProfileNameMaxLength bounds a custom profile display name. The limit
// keeps generated ids sane and UI lists readable; predefined names are all
// far below it.
const slmProfileNameMaxLength = 64

// slmProfilesFile is the on-disk document.
type slmProfilesFile struct {
	Version  int          `yaml:"version"`
	Profiles []SLMProfile `yaml:"profiles"`
}

// LoadCustomSLMProfiles reads the custom profiles from path (fail-soft).
// It never returns an error: a missing file is the pristine "no custom
// profiles" state, and any brokenness — unreadable file, YAML parse
// failure, unsupported version, invalid entry, id/name collision with the
// predefined catalog or within the file — degrades to dropping the
// offending entries and reporting each drop as a warning string. The
// caller surfaces warnings in the UI; the returned profiles are validated
// clones safe to hand out.
func LoadCustomSLMProfiles(path string) (profiles []SLMProfile, warnings []string) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// Pristine state: no file means no custom profiles, no warning.
			return nil, nil
		}
		return nil, []string{fmt.Sprintf("slm profiles: cannot read %s: %v (using no custom profiles)", path, err)}
	}

	var file slmProfilesFile
	if err := yaml.Unmarshal(data, &file); err != nil {
		return nil, []string{fmt.Sprintf("slm profiles: %s is not valid YAML: %v (using no custom profiles)", path, err)}
	}
	if file.Version != slmProfilesFormatVersion {
		return nil, []string{fmt.Sprintf("slm profiles: %s has unsupported format version %d (expected %d); using no custom profiles", path, file.Version, slmProfilesFormatVersion)}
	}

	predefined := PredefinedSLMProfiles()
	seenIDs := make(map[string]struct{}, len(predefined)+len(file.Profiles))
	seenNames := make(map[string]struct{}, len(predefined)+len(file.Profiles))
	for _, p := range predefined {
		seenIDs[p.ID] = struct{}{}
		seenNames[p.Name] = struct{}{}
	}

	profiles = make([]SLMProfile, 0, len(file.Profiles))
	for i, raw := range file.Profiles {
		validated, err := validateCustomSLMProfile(raw, seenIDs, seenNames)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("slm profiles: entry %d skipped: %v", i+1, err))
			continue
		}
		profiles = append(profiles, validated)
	}
	return profiles, warnings
}

// SaveCustomSLMProfiles validates the entire set and writes it to path as
// an atomic full rewrite (write to a .tmp sibling, then rename — mirroring
// Save for config.yaml). Unlike loading, saving is fail-closed: any
// invalid entry or id/name collision (with the predefined catalog or
// within the set) aborts the save with an error and leaves the file
// untouched. Saving an empty set is legal and writes a version marker with
// an empty list; the file is created lazily here if it does not exist yet.
func SaveCustomSLMProfiles(path string, profiles []SLMProfile) error {
	predefined := PredefinedSLMProfiles()
	seenIDs := make(map[string]struct{}, len(predefined)+len(profiles))
	seenNames := make(map[string]struct{}, len(predefined)+len(profiles))
	for _, p := range predefined {
		seenIDs[p.ID] = struct{}{}
		seenNames[p.Name] = struct{}{}
	}

	validated := make([]SLMProfile, 0, len(profiles))
	for i, raw := range profiles {
		v, err := validateCustomSLMProfile(raw, seenIDs, seenNames)
		if err != nil {
			return fmt.Errorf("slm profiles: entry %d is invalid, refusing to save: %w", i+1, err)
		}
		validated = append(validated, v)
	}

	data, err := yaml.Marshal(&slmProfilesFile{
		Version:  slmProfilesFormatVersion,
		Profiles: validated,
	})
	if err != nil {
		return fmt.Errorf("slm profiles: failed to marshal: %w", err)
	}

	// Write atomically: temp file, then rename (same pattern as Save).
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return fmt.Errorf("slm profiles: failed to write temp file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("slm profiles: failed to rename into place: %w", err)
	}
	return nil
}

// CreateCustomSLMProfile builds a new custom profile for name+cfg with a
// generated id. The name must be unique against the predefined catalog
// names and the existing custom profile names (existing is the currently
// stored custom set, e.g. from LoadCustomSLMProfiles); the id is derived
// deterministically from the name (lowercase slug, see
// generateCustomSLMProfileID) and deduplicated against every predefined
// and existing custom id, so it is stable across save→load round-trips —
// the id is written to the file once and never regenerated. Values are
// validated by NewSLMProfile.
func CreateCustomSLMProfile(name string, cfg SLMProfileConfig, existing []SLMProfile) (SLMProfile, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return SLMProfile{}, errors.New("slm profile name must not be empty")
	}
	if len(name) > slmProfileNameMaxLength {
		return SLMProfile{}, fmt.Errorf("slm profile name must be at most %d characters, got %d", slmProfileNameMaxLength, len(name))
	}
	for _, p := range PredefinedSLMProfiles() {
		if p.Name == name {
			return SLMProfile{}, fmt.Errorf("slm profile name %q collides with the predefined profile %q", name, p.ID)
		}
	}
	for _, p := range existing {
		if p.Name == name {
			return SLMProfile{}, fmt.Errorf("slm profile name %q is already used by custom profile %q", name, p.ID)
		}
	}

	taken := make(map[string]struct{}, len(existing)+len(predefinedSLMProfiles))
	for _, p := range PredefinedSLMProfiles() {
		taken[p.ID] = struct{}{}
	}
	for _, p := range existing {
		taken[p.ID] = struct{}{}
	}
	id := generateCustomSLMProfileID(name, taken)
	return NewSLMProfile(id, name, SLMProfileKindCustom, cfg)
}

// DeleteCustomSLMProfile removes the custom profile with the given id from
// the file at path and persists the remainder atomically. It returns the
// remaining profiles. Deleting an id that is not stored (including any
// predefined id — the file only ever holds customs) is an error and leaves
// the file untouched. Warnings from the internal fail-soft load are
// irrelevant here: entries a load would discard are already absent from
// the stored set this function operates on.
func DeleteCustomSLMProfile(path, id string) ([]SLMProfile, error) {
	profiles, _ := LoadCustomSLMProfiles(path)
	remaining := make([]SLMProfile, 0, len(profiles))
	found := false
	for _, p := range profiles {
		if p.ID == id {
			found = true
			continue
		}
		remaining = append(remaining, p)
	}
	if !found {
		return nil, fmt.Errorf("slm profile %q is not a stored custom profile", id)
	}
	if err := SaveCustomSLMProfiles(path, remaining); err != nil {
		return nil, err
	}
	return remaining, nil
}

// validateCustomSLMProfile is the shared load/save gate for one stored
// profile. It enforces everything NewSLMProfile enforces (id slug, name,
// kind, the 25 knob values) plus the store-level rules: the entry must be
// kind=custom (the file never stores predefined entries), the name must
// respect slmProfileNameMaxLength, and the id/name must not collide with
// the ids/names registered in seenIDs/seenNames (pre-seeded with the
// predefined catalog by the callers). On success the profile is registered
// in both maps and a validated, defensively cloned copy is returned.
func validateCustomSLMProfile(raw SLMProfile, seenIDs, seenNames map[string]struct{}) (SLMProfile, error) {
	if raw.Kind != SLMProfileKindCustom {
		return SLMProfile{}, fmt.Errorf("profile %q has kind %q but the profile file only stores custom profiles", raw.ID, raw.Kind)
	}
	name := strings.TrimSpace(raw.Name)
	if len(name) > slmProfileNameMaxLength {
		return SLMProfile{}, fmt.Errorf("profile %q: name must be at most %d characters, got %d", raw.ID, slmProfileNameMaxLength, len(name))
	}
	validated, err := NewSLMProfile(raw.ID, raw.Name, raw.Kind, raw.Config)
	if err != nil {
		return SLMProfile{}, err
	}
	// Canonicalize an empty always_present list to nil: YAML renders a nil
	// slice as [] and parses it back as a non-nil empty slice, so without
	// this normalization a nil-vs-empty difference would make save→load
	// round-trips fail DeepEqual and flip-flop the file content.
	if len(validated.Config.EssentialTools.AlwaysPresent) == 0 {
		validated.Config.EssentialTools.AlwaysPresent = nil
	}
	if _, dup := seenIDs[validated.ID]; dup {
		return SLMProfile{}, fmt.Errorf("duplicate slm profile id %q", validated.ID)
	}
	if _, dup := seenNames[validated.Name]; dup {
		return SLMProfile{}, fmt.Errorf("slm profile name %q collides with a predefined or earlier profile", validated.Name)
	}
	seenIDs[validated.ID] = struct{}{}
	seenNames[validated.Name] = struct{}{}
	return validated, nil
}

// slmProfileNameSlugSeparators matches every character that is not a
// lowercase ASCII alphanum; runs of them become single '-' separators when
// turning a display name into an id slug.
var slmProfileNameSlugSeparators = regexp.MustCompile(`[^a-z0-9]+`)

// generateCustomSLMProfileID derives a fresh profile id from a display
// name: the name is lowercased, every non-[a-z0-9] run collapses to a
// single '-' separator, and the result is trimmed — yielding ids that
// satisfy slmProfileIDPattern ("My Tuned Model 2" → "my-tuned-model-2",
// "Феникс" → "" → the "profile" fallback). If the slug is already taken,
// "-2", "-3", … suffixes are tried; past a sanity cap the suffix becomes
// time-based so generation always terminates with a unique, valid id.
func generateCustomSLMProfileID(name string, taken map[string]struct{}) string {
	base := strings.Trim(slmProfileNameSlugSeparators.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if base == "" {
		base = "profile"
	}
	if _, exists := taken[base]; !exists {
		return base
	}
	for i := 2; i <= 10000; i++ {
		candidate := base + "-" + strconv.Itoa(i)
		if _, exists := taken[candidate]; !exists {
			return candidate
		}
	}
	// Pathological fallback (more than 10000 colliding slugs): a
	// time-based suffix keeps the id unique and pattern-valid.
	return fmt.Sprintf("%s-t%d", base, time.Now().UnixNano())
}
