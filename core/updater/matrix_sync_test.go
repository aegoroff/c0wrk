package updater

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// This file pins the three-way sync of the release asset matrix (ADR-046):
// supportedPlatforms in assets.go, the packaging/upload steps of
// .github/workflows/release.yml, and the human-facing artifact tables in
// README.md and CONTRIBUTING.md. ADR-046 records the drift risk as a
// consequence ("the artifact matrix stays in three places by hand; only the
// updater table is code-checked"); this test closes that gap for the
// declarative documents — any new flavor added to supportedPlatforms without
// its release job, upload path, and doc rows (or vice versa) fails here.

// workflowRoot resolves the repository root from the test's working directory
// (go test runs with the CWD set to the package directory, core/updater).
func workflowRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolving repo root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".github", "workflows", "release.yml")); err != nil {
		t.Fatalf("release.yml not found under repo root %s: %v", root, err)
	}
	return root
}

// collectYAMLStrings walks a decoded YAML tree and returns every scalar
// string value it contains.
func collectYAMLStrings(node any, out *[]string) {
	switch v := node.(type) {
	case string:
		*out = append(*out, v)
	case map[string]any:
		for _, child := range v {
			collectYAMLStrings(child, out)
		}
	case []any:
		for _, child := range v {
			collectYAMLStrings(child, out)
		}
	case map[any]any:
		for _, child := range v {
			collectYAMLStrings(child, out)
		}
	}
}

// TestReleaseMatrix_SyncsWithWorkflow asserts that every canonical asset name
// in supportedPlatforms is produced by .github/workflows/release.yml: the
// workflow text, with `${{ matrix.arch }}` expanded over the build-linux
// matrix values, must mention each basename as an artifact name/path, and the
// flavor jobs must be wired into the release job's needs so a broken flavor
// build blocks the release.
func TestReleaseMatrix_SyncsWithWorkflow(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile(filepath.Join(workflowRoot(t), ".github", "workflows", "release.yml"))
	if err != nil {
		t.Fatalf("reading release.yml: %v", err)
	}

	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parsing release.yml: %v", err)
	}
	jobs, _ := doc["jobs"].(map[string]any)
	if jobs == nil {
		t.Fatal("release.yml has no jobs mapping")
	}

	// Expand the templated linux arch dimension: every "${{ matrix.arch }}"
	// occurrence is materialized for each arch the build-linux matrix
	// declares, so the canonical linux asset names are comparable against
	// the workflow's strings.
	var arches []string
	if buildLinux, ok := jobs["build-linux"].(map[string]any); ok {
		if strat, ok := buildLinux["strategy"].(map[string]any); ok {
			if matrix, ok := strat["matrix"].(map[string]any); ok {
				if include, ok := matrix["include"].([]any); ok {
					for _, entry := range include {
						if m, ok := entry.(map[string]any); ok {
							if arch, ok := m["arch"].(string); ok {
								arches = append(arches, arch)
							}
						}
					}
				}
			}
		}
	}
	if len(arches) == 0 {
		t.Fatal("could not read the build-linux matrix arch values from release.yml")
	}

	var workflowTexts []string
	var allStrings []string
	collectYAMLStrings(doc, &allStrings)
	for _, s := range allStrings {
		if !strings.Contains(s, "${{ matrix.arch }}") {
			workflowTexts = append(workflowTexts, s)
			continue
		}
		for _, arch := range arches {
			workflowTexts = append(workflowTexts, strings.ReplaceAll(s, "${{ matrix.arch }}", arch))
		}
	}

	// The canonical basename must appear in some expanded workflow string
	// (upload-artifact name or path, or the packaging step's output name).
	for _, p := range supportedPlatforms {
		found := false
		for _, s := range workflowTexts {
			if strings.Contains(s, p.basename) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("release.yml does not produce/upload %q (platform %s/%s flavor %q) — the workflow matrix drifted from supportedPlatforms", p.basename, p.goos, p.goarch, p.flavor)
		}
	}

	// Every flavor job must gate the release: a failing flavor build must
	// block publishing rather than ship a release missing an asset the
	// updater may require (hard ErrNoAssetForPlatform for that install).
	releaseJob, ok := jobs["release"].(map[string]any)
	if !ok {
		t.Fatal("release.yml has no release job")
	}
	needs := map[string]bool{}
	switch n := releaseJob["needs"].(type) {
	case []any:
		for _, dep := range n {
			if s, ok := dep.(string); ok {
				needs[s] = true
			}
		}
	case string:
		for _, dep := range strings.Split(n, ",") {
			needs[strings.TrimSpace(dep)] = true
		}
	}
	for _, flavorJob := range []string{"build-linux-cuda", "build-linux-openvino"} {
		if !needs[flavorJob] {
			t.Errorf("release job does not depend on %q — a broken flavor build would not block the release", flavorJob)
		}
		if _, exists := jobs[flavorJob]; !exists {
			t.Errorf("release.yml has no %q job, but the flavor is part of supportedPlatforms", flavorJob)
		}
	}

	// The flavor jobs must run their make fetch targets (the recipe smoke
	// that keeps the pinned URLs/digests honest at release time).
	for job, target := range map[string]string{
		"build-linux-cuda":     "make fetch-onnx-gpu",
		"build-linux-openvino": "make fetch-onnx-openvino",
	} {
		body, ok := jobs[job]
		if !ok {
			continue // already reported above
		}
		var jobStrings []string
		collectYAMLStrings(body, &jobStrings)
		found := false
		for _, s := range jobStrings {
			if strings.Contains(s, target) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("job %q does not run %q — the flavor recipe would ship unexercised", job, target)
		}
	}
}

// TestReleaseMatrix_SyncsWithDocs asserts the human-facing artifact tables
// list every canonical asset name: README.md (end-user download table) and
// CONTRIBUTING.md (release-artifact table).
func TestReleaseMatrix_SyncsWithDocs(t *testing.T) {
	t.Parallel()

	for _, doc := range []string{"README.md", "CONTRIBUTING.md"} {
		raw, err := os.ReadFile(filepath.Join(workflowRoot(t), doc))
		if err != nil {
			t.Fatalf("reading %s: %v", doc, err)
		}
		for _, p := range supportedPlatforms {
			if !strings.Contains(string(raw), p.basename) {
				t.Errorf("%s does not mention %q (platform %s/%s flavor %q) — the docs matrix drifted from supportedPlatforms", doc, p.basename, p.goos, p.goarch, p.flavor)
			}
		}
	}
}
