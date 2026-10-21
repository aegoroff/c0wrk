package embeddedllm

import (
	"errors"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Engine vocabulary
// ---------------------------------------------------------------------------

func TestResolveEngine(t *testing.T) {
	cases := []struct {
		label     string
		requested Engine
		platform  string
		want      Engine
		wantErr   error
	}{
		{"empty spelling is auto on Apple Silicon", "", PlatformDarwinARM64, EngineMTPLX, nil},
		{"auto on Apple Silicon is mtplx", EngineAuto, PlatformDarwinARM64, EngineMTPLX, nil},
		{"auto on Intel Mac is llama", EngineAuto, PlatformDarwinAMD64, EngineLlama, nil},
		{"auto on linux is llama", EngineAuto, PlatformLinuxAMD64, EngineLlama, nil},
		{"auto on windows is llama", EngineAuto, PlatformWindowsAMD64, EngineLlama, nil},
		{"explicit llama on linux is honored", EngineLlama, PlatformLinuxAMD64, EngineLlama, nil},
		{"explicit llama on Apple Silicon is honored", EngineLlama, PlatformDarwinARM64, EngineLlama, nil},
		{"explicit mtplx on Apple Silicon is honored", EngineMTPLX, PlatformDarwinARM64, EngineMTPLX, nil},
		{"explicit mtplx on linux is refused", EngineMTPLX, PlatformLinuxAMD64, "", ErrEngineUnsupportedPlatform},
		{"explicit mtplx on Intel Mac is refused", EngineMTPLX, PlatformDarwinAMD64, "", ErrEngineUnsupportedPlatform},
		{"explicit mtplx on windows is refused", EngineMTPLX, PlatformWindowsAMD64, "", ErrEngineUnsupportedPlatform},
		{"unknown spelling is refused", Engine("vllm"), PlatformDarwinARM64, "", ErrEngineUnknown},
		{"llama on an unsupported platform is refused", EngineLlama, "plan9-amd64", "", ErrEngineUnsupportedPlatform},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			got, err := ResolveEngine(tc.requested, tc.platform)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("ResolveEngine(%q, %q) error = %v, want %v", tc.requested, tc.platform, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveEngine(%q, %q): %v", tc.requested, tc.platform, err)
			}
			if got != tc.want {
				t.Fatalf("ResolveEngine(%q, %q) = %q, want %q", tc.requested, tc.platform, got, tc.want)
			}
		})
	}
}

func TestNormalizeEngine(t *testing.T) {
	if got := NormalizeEngine(""); got != EngineAuto {
		t.Fatalf("NormalizeEngine(\"\") = %q, want %q", got, EngineAuto)
	}
	if got := NormalizeEngine(EngineMTPLX); got != EngineMTPLX {
		t.Fatalf("NormalizeEngine(mtplx) = %q, want mtplx", got)
	}
}

// ---------------------------------------------------------------------------
// The engine pins themselves
// ---------------------------------------------------------------------------

func TestValidateMLXPins(t *testing.T) {
	if err := ValidateMLXPins(); err != nil {
		t.Fatalf("ValidateMLXPins: %v", err)
	}
	// The llama-family validator and the engine validator are joined by
	// ValidateRegistry, so one bad table fails the whole registry check.
	if err := ValidateRegistry(); err != nil {
		t.Fatalf("ValidateRegistry (joined): %v", err)
	}
}

// TestMLXPinsMatchUpstream locks the three large pack files to the Hugging
// Face LFS metadata of MLXPackRevision. The LFS OID *is* the SHA256, so these
// are the supply-chain anchor for ~8.7 GiB of weights (ADR-090).
func TestMLXPinsMatchUpstream(t *testing.T) {
	cases := []struct {
		file string
		size int64
		sha  string
	}{
		{"model.safetensors", 8595477990, "130de5925082c168b7866b2e91b52e44abbafc99017e3ca352b77b5b55a269ed"},
		{"mtp.safetensors", 238934226, "f803737b0e64bcce54fcfa22f2c7ee342ad37192b8e2a3299fc940387a828c9d"},
		{"tokenizer.json", 12809320, "0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3"},
	}
	for _, tc := range cases {
		a, ok := MLXPackFile(tc.file)
		if !ok {
			t.Fatalf("MLXPackFile(%q): not pinned", tc.file)
		}
		if a.SizeBytes != tc.size || a.SHA256 != tc.sha {
			t.Fatalf("pack pin %q = (%d, %s), want (%d, %s)", tc.file, a.SizeBytes, a.SHA256, tc.size, tc.sha)
		}
		if !strings.HasPrefix(a.URL, "https://huggingface.co/Youssofal/Ternary-Bonsai-2-27B-MTPLX-Optimized-Speed/resolve/"+MLXPackRevision+"/") {
			t.Fatalf("pack pin %q URL %q is not under the pinned revision", tc.file, a.URL)
		}
	}
}

// TestMLXPackCarriesServingEssentials fails the build if a pack bump drops a
// file the engine needs at serve time (or the NOTICE the attribution
// obligation requires).
func TestMLXPackCarriesServingEssentials(t *testing.T) {
	for _, name := range []string{
		"model.safetensors", "model.safetensors.index.json", "mtp.safetensors",
		"config.json", "generation_config.json", "hadamard.json",
		"tokenizer.json", "tokenizer_config.json", "chat_template.jinja",
		"mtplx_runtime.json", "MTPLX_PACK_MANIFEST.json",
		"preprocessor_config.json", "processor_config.json", "video_preprocessor_config.json",
		"README.md", "NOTICE.txt",
	} {
		if _, ok := MLXPackFile(name); !ok {
			t.Errorf("pack pin missing %q", name)
		}
	}
	if n := len(MLXPackFiles()); n != 16 {
		t.Errorf("pack pins %d files, want 16 (a bump must re-review the whole set)", n)
	}
}

// TestMLXWheelSetIsClosed locks the shape of the engine wheel set: the pinned
// engine, the upstream exactness pins, and no duplicates.
func TestMLXWheelSetIsClosed(t *testing.T) {
	wheels := EngineWheels()
	if len(wheels) != 46 {
		t.Fatalf("wheel set carries %d distributions, want 46 (a bump must re-resolve the whole set)", len(wheels))
	}
	seen := make(map[string]string, len(wheels))
	for _, w := range wheels {
		if prev, dup := seen[w.Name]; dup {
			t.Errorf("duplicate distribution %q (also pinned at %s)", w.Name, prev)
		}
		seen[w.Name] = w.Version
	}
	for name, want := range map[string]string{
		"mtplx":        MTPLXVersion,
		"mlx":          "0.32.2", // upstream's exactness-gated exact pin
		"mlx-metal":    "0.32.2",
		"mlx-lm":       "0.31.3",
		"transformers": "5.16.1",
		"llguidance":   "1.9.1",
	} {
		w, ok := EngineWheel(name)
		if !ok {
			t.Errorf("wheel set missing %q", name)
			continue
		}
		if w.Version != want {
			t.Errorf("wheel %q = %s, want %s", name, w.Version, want)
		}
	}
}

// TestMLXWheelPinsCarryURLTail proves each wheel's ArchiveName is the URL's
// own file name, so the installer's cache layout and its verification key can
// never disagree about what a wheel is.
func TestMLXWheelPinsCarryURLTail(t *testing.T) {
	for _, w := range EngineWheels() {
		idx := strings.LastIndex(w.Asset.URL, "/")
		if idx < 0 || w.Asset.URL[idx+1:] != w.Asset.ArchiveName {
			t.Errorf("wheel %q: archive name %q does not match URL tail %q",
				w.Name, w.Asset.ArchiveName, w.Asset.URL)
		}
		if !strings.HasPrefix(w.Asset.URL, "https://files.pythonhosted.org/packages/") {
			t.Errorf("wheel %q: URL %q is not a pinned files.pythonhosted.org path", w.Name, w.Asset.URL)
		}
	}
}

func TestPythonArchivePin(t *testing.T) {
	a, ok := PythonArchiveAsset()
	if !ok {
		t.Fatal("PythonArchiveAsset: not pinned")
	}
	if a.Component != ComponentPython {
		t.Fatalf("component = %q, want %q", a.Component, ComponentPython)
	}
	if a.SHA256 != "ba32036ad8f4c434d97a1ee7feef8b7edc0fac16777639b97e39c74a108e4440" || a.SizeBytes != 25180390 {
		t.Fatalf("python pin = (%s, %d), want the captured 20261013 values", a.SHA256, a.SizeBytes)
	}
	if !strings.Contains(a.ArchiveName, "cpython-3.12.15") || !strings.HasSuffix(a.ArchiveName, "aarch64-apple-darwin-install_only.tar.gz") {
		t.Fatalf("archive name %q is not the aarch64-apple-darwin 3.12 install_only build", a.ArchiveName)
	}
}

func TestEngineArtifactSet(t *testing.T) {
	set, err := EngineArtifactSet(PlatformDarwinARM64)
	if err != nil {
		t.Fatalf("EngineArtifactSet: %v", err)
	}
	// python + 46 wheels + 16 pack files.
	if len(set) != 1+len(EngineWheels())+len(MLXPackFiles()) {
		t.Fatalf("set carries %d artifacts, want %d", len(set), 1+len(EngineWheels())+len(MLXPackFiles()))
	}
	if set[0].Component != ComponentPython {
		t.Fatalf("first artifact is %q, want python", set[0].Component)
	}
	if _, err := EngineArtifactSet(PlatformLinuxAMD64); !errors.Is(err, ErrEngineUnsupportedPlatform) {
		t.Fatalf("EngineArtifactSet(linux) error = %v, want ErrEngineUnsupportedPlatform", err)
	}
}

// TestTotalWheelBytesIsPositive guards the disk-guard input against a table
// that silently sums to zero.
func TestTotalWheelBytesIsPositive(t *testing.T) {
	if TotalWheelBytes() <= 0 {
		t.Fatalf("TotalWheelBytes = %d, want positive", TotalWheelBytes())
	}
	if MLXPackBytes() != 8847907212 {
		t.Fatalf("MLXPackBytes = %d, want 8847907212 (16 pinned files)", MLXPackBytes())
	}
	// The two weight files together are exactly the byte count the pack's own
	// documentation quotes as TIGHT_MACHINE_MAX_WEIGHTS_BYTES — a free
	// cross-check that the big pins still match the serving contract.
	model, _ := MLXPackFile("model.safetensors")
	mtp, _ := MLXPackFile("mtp.safetensors")
	if model.SizeBytes+mtp.SizeBytes != 8834412216 {
		t.Fatalf("weights total = %d, want the documented 8834412216", model.SizeBytes+mtp.SizeBytes)
	}
}

// ---------------------------------------------------------------------------
// The validator has teeth
// ---------------------------------------------------------------------------

// mlxFixtureTables returns deep-enough local copies of the pin tables so a
// teeth test can break one field without mutating shared registry state.
func mlxFixtureTables() (python Asset, wheels []WheelAsset, pack []Asset) {
	python = pythonArchiveAsset
	wheels = append([]WheelAsset(nil), mtplxWheelPins...)
	pack = append([]Asset(nil), mlxPackPins...)
	return python, wheels, pack
}

func TestValidateMLXPinsDetectsBrokenPackFile(t *testing.T) {
	cases := []struct {
		label  string
		mutate func(*Asset)
		want   string
	}{
		{"empty sha", func(a *Asset) { a.SHA256 = "" }, "invalid sha256"},
		{"wrong component", func(a *Asset) { a.Component = ComponentModel }, "component is"},
		{"url off the pinned revision", func(a *Asset) { a.URL = "https://example.com/x" }, "not under the pinned pack revision"},
		{"non-positive size", func(a *Asset) { a.SizeBytes = 0 }, "non-positive size"},
		{"path-y archive name", func(a *Asset) { a.ArchiveName = "../escape" }, "not a plain file name"},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			python, wheels, pack := mlxFixtureTables()
			tc.mutate(&pack[0])
			err := validateMLXPinTables(python, wheels, pack)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("validateMLXPinTables error = %v, want it to contain %q", err, tc.want)
			}
		})
	}
}

func TestValidateMLXPinsDetectsBrokenWheel(t *testing.T) {
	python, wheels, pack := mlxFixtureTables()
	wheels[0].Asset.SHA256 = "not-hex"
	err := validateMLXPinTables(python, wheels, pack)
	if err == nil || !strings.Contains(err.Error(), "invalid sha256") {
		t.Fatalf("validateMLXPinTables error = %v, want a sha256 complaint", err)
	}
}

func TestValidateMLXPinsDetectsForeignWheelURL(t *testing.T) {
	python, wheels, pack := mlxFixtureTables()
	wheels[1].Asset.URL = "https://evil.example/wheel.whl"
	err := validateMLXPinTables(python, wheels, pack)
	if err == nil || !strings.Contains(err.Error(), "files.pythonhosted.org") {
		t.Fatalf("validateMLXPinTables error = %v, want a host complaint", err)
	}
}

func TestValidateMLXPinsDetectsMissingEngineWheel(t *testing.T) {
	python, wheels, pack := mlxFixtureTables()
	idx := -1
	for i, w := range wheels {
		if w.Name == "mtplx" {
			idx = i
			break
		}
	}
	if idx < 0 {
		t.Fatal("fixture has no mtplx wheel")
	}
	wheels = append(wheels[:idx], wheels[idx+1:]...)
	err := validateMLXPinTables(python, wheels, pack)
	if err == nil || !strings.Contains(err.Error(), "missing the required distribution") {
		t.Fatalf("validateMLXPinTables error = %v, want a required-distribution complaint", err)
	}
}

func TestValidateMLXPinsDetectsBrokenPython(t *testing.T) {
	python, wheels, pack := mlxFixtureTables()
	python.SHA256 = ""
	err := validateMLXPinTables(python, wheels, pack)
	if err == nil || !strings.Contains(err.Error(), "invalid sha256") {
		t.Fatalf("validateMLXPinTables error = %v, want a sha256 complaint", err)
	}
}
