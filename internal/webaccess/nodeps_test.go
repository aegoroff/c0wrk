// SPDX-License-Identifier: Apache-2.0
//
// nodeps_test.go — import-hygiene guard for the webaccess package: the
// sidecar core depends on the STDLIB and backend/config only (backend itself
// appears solely in _test files), and NEVER on desktop or Wails. This is the
// executable form of the ADR-099 isolation rule: webaccess is mountable from
// any layer because it drags none of them in.

package webaccess

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// allowedNonTestImport reports whether an import path is legal in a
// production (non-test) file of this package.
func allowedNonTestImport(path string) bool {
	if strings.HasPrefix(path, "github.com/v0lka/c0wrk/backend/") || path == "github.com/v0lka/c0wrk/backend" {
		return true
	}
	// Stdlib heuristic: no dot in the first path segment (net/http, io/fs…)
	first := path
	if i := strings.IndexByte(path, '/'); i >= 0 {
		first = path[:i]
	}
	return !strings.Contains(first, ".")
}

func TestPackageImportHygiene(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	fset := token.NewFileSet()
	scanned := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") {
			continue
		}
		isTest := strings.HasSuffix(name, "_test.go")
		f, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		for _, imp := range f.Imports {
			path := strings.Trim(imp.Path.Value, `"`)
			// Absolute bans for every file in the directory — including
			// tests: the sidecar core and its tests must both stay free of
			// the desktop layer and Wails.
			if strings.HasPrefix(path, "github.com/v0lka/c0wrk/desktop") {
				t.Errorf("%s imports %q — webaccess must never import desktop", name, path)
				continue
			}
			if strings.HasPrefix(path, "github.com/wailsapp/") {
				t.Errorf("%s imports %q — webaccess must never import Wails", name, path)
				continue
			}
			if isTest {
				// Tests may additionally import backend (surface contract).
				continue
			}
			if !allowedNonTestImport(path) {
				t.Errorf("%s imports %q — production files may import only stdlib and backend/…", name, path)
			}
		}
		scanned++
	}
	if scanned == 0 {
		t.Fatal("no Go files scanned — the guard must never pass vacuously")
	}
}
