package config

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// storeTestConfigA/B are two distinct valid knob sets used for round-trip
// and collision tests. A carries sentinel values of every value shape
// (floats, ints, strings, a string list) so byte-in-value fidelity is
// actually exercised.
func storeTestConfigA() SLMProfileConfig {
	return SLMProfileConfig{
		EssentialTools: EssentialToolsConfig{
			Enabled:             true,
			AlwaysPresent:       []string{"read_file", "edit_file"},
			CompactDescriptions: true,
		},
		SystemPrompt: SystemPromptConfig{Lite: true},
		Sampling: SLMSamplingConfig{
			Enabled:           true,
			Temperature:       0.7,
			TopP:              0.95,
			TopK:              64,
			RepetitionPenalty: 1.1,
			PresencePenalty:   1.5,
			ReasoningEffort:   "medium",
		},
		LoopHardening: LoopHardeningConfig{
			Enabled:                      true,
			RepeatNudgeThreshold:         2,
			ParseErrorAbortThreshold:     3,
			FruitlessNudgeThreshold:      3,
			FruitlessAbortThreshold:      5,
			SameToolRepeatNudgeThreshold: 4,
		},
		Context: SLMContextConfig{
			Enabled:             true,
			Compaction:          SLMCompactionConfig{KeepLast: 6, BlockSize: 5, TriggerPercent: 80},
			ToolOutputKeepLastN: 2,
			OutputTokenReserve:  16384,
		},
	}
}

func storeTestConfigB() SLMProfileConfig {
	return SLMProfileConfig{
		Sampling: SLMSamplingConfig{Enabled: true, ReasoningEffort: "low"},
	}
}

// writeRawSLMProfilesFile marshals raw (unvalidated) profiles into the
// versioned on-disk document, letting tests plant entries that would never
// pass the constructor.
func writeRawSLMProfilesFile(t *testing.T, path string, version int, profiles []SLMProfile) {
	t.Helper()
	data, err := yaml.Marshal(&slmProfilesFile{Version: version, Profiles: profiles})
	if err != nil {
		t.Fatalf("marshal raw file: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write raw file: %v", err)
	}
}

func TestSLMProfilesPath(t *testing.T) {
	if got, want := SLMProfilesPath(filepath.Join("home", ".c0wrk")), filepath.Join("home", ".c0wrk", "slm-profiles.yaml"); got != want {
		t.Fatalf("SLMProfilesPath() = %q, want %q", got, want)
	}
}

func TestCustomSLMProfilesRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slm-profiles.yaml")

	// No file before the first save: lazy creation.
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("profile file must not exist before the first save, stat err = %v", err)
	}

	p1, err := CreateCustomSLMProfile("My Tuned Model", storeTestConfigA(), nil)
	if err != nil {
		t.Fatalf("create p1: %v", err)
	}
	p2, err := CreateCustomSLMProfile("Aggressive Compaction", storeTestConfigB(), []SLMProfile{p1})
	if err != nil {
		t.Fatalf("create p2: %v", err)
	}
	if p1.Kind != SLMProfileKindCustom || p2.Kind != SLMProfileKindCustom {
		t.Fatalf("created profiles must be kind=custom, got %q/%q", p1.Kind, p2.Kind)
	}

	if err := SaveCustomSLMProfiles(path, []SLMProfile{p1, p2}); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, warnings := LoadCustomSLMProfiles(path)
	if len(warnings) != 0 {
		t.Fatalf("load after clean save produced warnings: %v", warnings)
	}
	if len(loaded) != 2 {
		t.Fatalf("loaded %d profiles, want 2", len(loaded))
	}
	if !reflect.DeepEqual(loaded[0], p1) || !reflect.DeepEqual(loaded[1], p2) {
		t.Fatalf("round-trip changed profiles:\n got[0]=%+v\nwant[0]=%+v\n got[1]=%+v\nwant[1]=%+v", loaded[0], p1, loaded[1], p2)
	}

	// The file carries the format version.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	var doc slmProfilesFile
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal saved file: %v", err)
	}
	if doc.Version != slmProfilesFormatVersion {
		t.Fatalf("saved version = %d, want %d", doc.Version, slmProfilesFormatVersion)
	}

	// Save the loaded set back and reload: ids stay stable and values stay
	// identical between saves.
	if err := SaveCustomSLMProfiles(path, loaded); err != nil {
		t.Fatalf("re-save: %v", err)
	}
	reloaded, warnings := LoadCustomSLMProfiles(path)
	if len(warnings) != 0 {
		t.Fatalf("load after re-save produced warnings: %v", warnings)
	}
	if !reflect.DeepEqual(reloaded, loaded) {
		t.Fatalf("ids/values not stable between saves:\n got=%+v\nwant=%+v", reloaded, loaded)
	}
	for i := range reloaded {
		if reloaded[i].ID != loaded[i].ID {
			t.Fatalf("profile %d id drifted: %q -> %q", i, loaded[i].ID, reloaded[i].ID)
		}
	}
}

func TestLoadCustomSLMProfilesMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
	profiles, warnings := LoadCustomSLMProfiles(path)
	if len(profiles) != 0 {
		t.Fatalf("missing file must load an empty list, got %d profiles", len(profiles))
	}
	if len(warnings) != 0 {
		t.Fatalf("missing file must not warn, got %v", warnings)
	}
}

func TestLoadCustomSLMProfilesFullyBroken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
	if err := os.WriteFile(path, []byte("version: 1\nprofiles:\n  - id: [unclosed\n"), 0o644); err != nil {
		t.Fatalf("write broken file: %v", err)
	}
	profiles, warnings := LoadCustomSLMProfiles(path)
	if len(profiles) != 0 {
		t.Fatalf("unparseable file must load an empty list, got %d profiles", len(profiles))
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "not valid YAML") {
		t.Fatalf("unparseable file must warn exactly once about YAML, got %v", warnings)
	}
}

func TestLoadCustomSLMProfilesUnsupportedVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
	writeRawSLMProfilesFile(t, path, 2, []SLMProfile{{ID: "future", Name: "Future", Kind: SLMProfileKindCustom}})
	profiles, warnings := LoadCustomSLMProfiles(path)
	if len(profiles) != 0 {
		t.Fatalf("future version must load an empty list, got %d profiles", len(profiles))
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "unsupported format version") {
		t.Fatalf("future version must warn about the version, got %v", warnings)
	}
}

func TestLoadCustomSLMProfilesPartiallyBroken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
	good, err := NewSLMProfile("good-one", "Good One", SLMProfileKindCustom, storeTestConfigA())
	if err != nil {
		t.Fatalf("build good profile: %v", err)
	}
	badValue := good
	badValue.ID = "bad-value"
	badValue.Name = "Bad Value"
	badValue.Config.Sampling.TopP = 5 // out of (0, 1]
	badName := good
	badName.ID = "bad-name"
	badName.Name = "" // empty name
	writeRawSLMProfilesFile(t, path, slmProfilesFormatVersion, []SLMProfile{good, badValue, badName})

	profiles, warnings := LoadCustomSLMProfiles(path)
	if len(profiles) != 1 || profiles[0].ID != "good-one" {
		t.Fatalf("partially broken file must keep only the valid entry, got %+v", profiles)
	}
	if len(warnings) != 2 {
		t.Fatalf("want one warning per discarded entry, got %v", warnings)
	}
}

func TestLoadCustomSLMProfilesCollisions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
	good, err := NewSLMProfile("first", "First Custom", SLMProfileKindCustom, storeTestConfigB())
	if err != nil {
		t.Fatalf("build first: %v", err)
	}
	predefinedName := good
	predefinedName.ID = "not-generic"
	predefinedName.Name = "Generic (model-agnostic)" // collides with predefined name
	predefinedID := good
	predefinedID.ID = SLMGenericProfileID // collides with predefined id
	predefinedID.Name = "Another Name"
	dupName := good
	dupName.ID = "second"
	dupName.Name = "First Custom" // collides with the earlier custom
	dupID := good
	dupID.ID = "first" // collides with the earlier custom id
	dupID.Name = "Second Custom"
	writeRawSLMProfilesFile(t, path, slmProfilesFormatVersion,
		[]SLMProfile{good, predefinedName, predefinedID, dupName, dupID})

	profiles, warnings := LoadCustomSLMProfiles(path)
	if len(profiles) != 1 || profiles[0].ID != "first" {
		t.Fatalf("colliding entries must be dropped, got %+v", profiles)
	}
	if len(warnings) != 4 {
		t.Fatalf("want one warning per colliding entry, got %v", warnings)
	}
	for _, w := range warnings {
		if !strings.Contains(w, "skipped") {
			t.Fatalf("warnings must name the skipped entries, got %q", w)
		}
	}
}

func TestLoadCustomSLMProfilesNameAndKindRules(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
	base, err := NewSLMProfile("base", "Base", SLMProfileKindCustom, storeTestConfigB())
	if err != nil {
		t.Fatalf("build base: %v", err)
	}
	tooLong := base
	tooLong.ID = "too-long"
	tooLong.Name = strings.Repeat("x", slmProfileNameMaxLength+1)
	wrongKind := base
	wrongKind.ID = "wrong-kind"
	wrongKind.Name = "Wrong Kind"
	wrongKind.Kind = SLMProfileKindPredefined
	writeRawSLMProfilesFile(t, path, slmProfilesFormatVersion, []SLMProfile{base, tooLong, wrongKind})

	profiles, warnings := LoadCustomSLMProfiles(path)
	if len(profiles) != 1 || profiles[0].ID != "base" {
		t.Fatalf("only the conforming entry may load, got %+v", profiles)
	}
	if len(warnings) != 2 {
		t.Fatalf("want warnings for the long name and the wrong kind, got %v", warnings)
	}
}

func TestSaveCustomSLMProfilesRejectsInvalidSets(t *testing.T) {
	good, err := NewSLMProfile("one", "One", SLMProfileKindCustom, storeTestConfigB())
	if err != nil {
		t.Fatalf("build good: %v", err)
	}

	t.Run("duplicate names within the set", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
		dup := good
		dup.ID = "one-b"
		err := SaveCustomSLMProfiles(path, []SLMProfile{good, dup})
		if err == nil || !strings.Contains(err.Error(), "collides") {
			t.Fatalf("duplicate names must fail the save, got err = %v", err)
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Fatalf("a rejected save must not create the file, stat err = %v", statErr)
		}
	})

	t.Run("predefined name collision", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
		clash := good
		clash.ID = "clash"
		clash.Name = "Generic (model-agnostic)"
		if err := SaveCustomSLMProfiles(path, []SLMProfile{clash}); err == nil {
			t.Fatal("predefined name collision must fail the save")
		}
	})

	t.Run("invalid knob value", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
		bad := good
		bad.Config.Sampling.TopP = 5
		if err := SaveCustomSLMProfiles(path, []SLMProfile{bad}); err == nil {
			t.Fatal("invalid knob values must fail the save")
		}
	})

	t.Run("predefined kind is not storable", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
		pre, ok := FindPredefinedSLMProfile(SLMGenericProfileID)
		if !ok {
			t.Fatal("generic profile must exist")
		}
		if err := SaveCustomSLMProfiles(path, []SLMProfile{pre}); err == nil {
			t.Fatal("saving a predefined-kind entry must fail")
		}
	})
}

func TestCreateCustomSLMProfile(t *testing.T) {
	t.Run("slug from name", func(t *testing.T) {
		p, err := CreateCustomSLMProfile("  My Cool Model  ", storeTestConfigB(), nil)
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		if p.ID != "my-cool-model" {
			t.Fatalf("id = %q, want %q", p.ID, "my-cool-model")
		}
		if p.Name != "My Cool Model" {
			t.Fatalf("name = %q, want trimmed %q", p.Name, "My Cool Model")
		}
	})

	t.Run("id deduplicated against predefined and existing ids", func(t *testing.T) {
		// "Generic" slugs to the predefined id "generic" but does not
		// collide with any predefined *name* — the id must dedupe to -2.
		p, err := CreateCustomSLMProfile("Generic", storeTestConfigB(), nil)
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		if p.ID != "generic-2" {
			t.Fatalf("id = %q, want %q", p.ID, "generic-2")
		}
	})

	t.Run("name collision with existing custom rejected", func(t *testing.T) {
		p1, err := CreateCustomSLMProfile("Twin", storeTestConfigB(), nil)
		if err != nil {
			t.Fatalf("create p1: %v", err)
		}
		if _, err := CreateCustomSLMProfile("Twin", storeTestConfigA(), []SLMProfile{p1}); err == nil {
			t.Fatal("duplicate custom name must be rejected")
		}
	})

	t.Run("name collision with predefined rejected", func(t *testing.T) {
		if _, err := CreateCustomSLMProfile("Generic (model-agnostic)", storeTestConfigB(), nil); err == nil {
			t.Fatal("predefined name must be rejected")
		}
	})

	t.Run("empty and oversized names rejected", func(t *testing.T) {
		if _, err := CreateCustomSLMProfile("   ", storeTestConfigB(), nil); err == nil {
			t.Fatal("empty name must be rejected")
		}
		if _, err := CreateCustomSLMProfile(strings.Repeat("n", slmProfileNameMaxLength+1), storeTestConfigB(), nil); err == nil {
			t.Fatal("oversized name must be rejected")
		}
	})

	t.Run("invalid config rejected", func(t *testing.T) {
		cfg := storeTestConfigB()
		cfg.Sampling.TopP = 5
		if _, err := CreateCustomSLMProfile("Valid Name", cfg, nil); err == nil {
			t.Fatal("invalid knob values must be rejected")
		}
	})

	t.Run("non-latin name falls back to a valid slug", func(t *testing.T) {
		p, err := CreateCustomSLMProfile("Феникс", storeTestConfigB(), nil)
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		if !slmProfileIDPattern.MatchString(p.ID) || p.ID == "" {
			t.Fatalf("id %q must be a non-empty valid slug", p.ID)
		}
		if p.ID != "profile" {
			t.Fatalf("id fallback = %q, want %q", p.ID, "profile")
		}
	})
}

func TestDeleteCustomSLMProfile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
	p1, err := CreateCustomSLMProfile("First", storeTestConfigA(), nil)
	if err != nil {
		t.Fatalf("create p1: %v", err)
	}
	p2, err := CreateCustomSLMProfile("Second", storeTestConfigB(), []SLMProfile{p1})
	if err != nil {
		t.Fatalf("create p2: %v", err)
	}
	if err := SaveCustomSLMProfiles(path, []SLMProfile{p1, p2}); err != nil {
		t.Fatalf("save: %v", err)
	}

	remaining, err := DeleteCustomSLMProfile(path, p1.ID)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(remaining) != 1 || remaining[0].ID != p2.ID {
		t.Fatalf("delete must return the remainder, got %+v", remaining)
	}
	loaded, warnings := LoadCustomSLMProfiles(path)
	if len(warnings) != 0 || len(loaded) != 1 || loaded[0].ID != p2.ID {
		t.Fatalf("post-delete load = %+v, warnings = %v", loaded, warnings)
	}

	// Unknown and predefined ids are rejected; the file keeps its content.
	if _, err := DeleteCustomSLMProfile(path, p1.ID); err == nil {
		t.Fatal("deleting an absent id must fail")
	}
	if _, err := DeleteCustomSLMProfile(path, SLMGenericProfileID); err == nil {
		t.Fatal("deleting a predefined id must fail")
	}
	loaded, _ = LoadCustomSLMProfiles(path)
	if len(loaded) != 1 || loaded[0].ID != p2.ID {
		t.Fatalf("failed deletes must leave the file untouched, got %+v", loaded)
	}

	// Deleting the last profile persists an empty set.
	if _, err := DeleteCustomSLMProfile(path, p2.ID); err != nil {
		t.Fatalf("delete last: %v", err)
	}
	loaded, warnings = LoadCustomSLMProfiles(path)
	if len(loaded) != 0 || len(warnings) != 0 {
		t.Fatalf("empty store after last delete: profiles=%v warnings=%v", loaded, warnings)
	}
}

// TestSaveCustomSLMProfilesRefusesUnreadableExistingStore pins the pre-write
// guard: a full-set rewrite must never silently destroy content the fail-soft
// load cannot represent (foreign format version, unparseable YAML, or an entry
// the current validator rejects). Each refusal must leave the file byte-for-byte
// untouched.
func TestSaveCustomSLMProfilesRefusesUnreadableExistingStore(t *testing.T) {
	valid, err := CreateCustomSLMProfile("Keep Me", storeTestConfigB(), nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	t.Run("foreign format version", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
		writeRawSLMProfilesFile(t, path, 2, []SLMProfile{{ID: "future", Name: "Future", Kind: SLMProfileKindCustom}})
		before, _ := os.ReadFile(path)
		err := SaveCustomSLMProfiles(path, []SLMProfile{valid})
		if err == nil || !strings.Contains(err.Error(), "unsupported format version") {
			t.Fatalf("save over a foreign-version file must fail closed, got %v", err)
		}
		after, _ := os.ReadFile(path)
		if !bytes.Equal(before, after) {
			t.Fatal("a refused save must leave the foreign-version file untouched")
		}
	})

	t.Run("unparseable YAML", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
		if err := os.WriteFile(path, []byte("version: 1\nprofiles:\n  - id: [unclosed\n"), 0o644); err != nil {
			t.Fatalf("write broken file: %v", err)
		}
		before, _ := os.ReadFile(path)
		err := SaveCustomSLMProfiles(path, []SLMProfile{valid})
		if err == nil || !strings.Contains(err.Error(), "not valid YAML") {
			t.Fatalf("save over unparseable YAML must fail closed, got %v", err)
		}
		after, _ := os.ReadFile(path)
		if !bytes.Equal(before, after) {
			t.Fatal("a refused save must leave the unparseable file untouched")
		}
	})

	t.Run("invalid existing entry is not silently pruned", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
		good, err := NewSLMProfile("good-one", "Good One", SLMProfileKindCustom, storeTestConfigA())
		if err != nil {
			t.Fatalf("build good: %v", err)
		}
		bad := good
		bad.ID = "bad-value"
		bad.Name = "Bad Value"
		bad.Config.Sampling.TopP = 5 // out of (0, 1]
		writeRawSLMProfilesFile(t, path, slmProfilesFormatVersion, []SLMProfile{good, bad})
		before, _ := os.ReadFile(path)
		err = SaveCustomSLMProfiles(path, []SLMProfile{valid})
		if err == nil || !strings.Contains(err.Error(), "entry 2 is invalid") {
			t.Fatalf("save over a file with an invalid entry must fail closed, got %v", err)
		}
		after, _ := os.ReadFile(path)
		if !bytes.Equal(before, after) {
			t.Fatal("a refused save must leave the partially-invalid file untouched")
		}
	})

	t.Run("empty file is treated as pristine", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "slm-profiles.yaml")
		if err := os.WriteFile(path, nil, 0o644); err != nil {
			t.Fatalf("write empty file: %v", err)
		}
		if err := SaveCustomSLMProfiles(path, []SLMProfile{valid}); err != nil {
			t.Fatalf("an empty file must not block saving, got %v", err)
		}
		loaded, _ := LoadCustomSLMProfiles(path)
		if len(loaded) != 1 || loaded[0].ID != valid.ID {
			t.Fatalf("saved set not persisted: %+v", loaded)
		}
	})
}

// TestCustomSLMProfileNameLimitCountsRunes pins the rune-based (not byte-based)
// name-length bound: a name of exactly slmProfileNameMaxLength multibyte runes
// is accepted, one rune more is rejected.
func TestCustomSLMProfileNameLimitCountsRunes(t *testing.T) {
	name := strings.Repeat("ф", slmProfileNameMaxLength) // 64 runes, 128 bytes
	if _, err := CreateCustomSLMProfile(name, storeTestConfigB(), nil); err != nil {
		t.Fatalf("a %d-rune name must be accepted, got %v", slmProfileNameMaxLength, err)
	}
	if _, err := CreateCustomSLMProfile(name+"ф", storeTestConfigB(), nil); err == nil {
		t.Fatal("a name one rune over the limit must be rejected")
	}
}
