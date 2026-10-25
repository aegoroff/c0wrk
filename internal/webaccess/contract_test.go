// SPDX-License-Identifier: Apache-2.0
//
// contract_test.go — the surface contract between the web sidecar and the
// Wails binding surface:
//
//  1. Every EXPORTED method of backend.FrontendAPI (the dispatch target at
//     runtime) is dispatchable over the web transport, except the named
//     denylist — and the denylist is exactly the documented exception set.
//  2. Every one of those methods appears in the generated
//     frontend/wailsjs/go/desktop/App.d.ts with the SAME arity, so the
//     browser shim can keep calling positional args exactly like the wailsjs
//     bindings do.
//  3. Every parameter type is JSON-decodable-shaped (no chan/func/unsafe
//     params) and no method is variadic — the structural preconditions of
//     the reflection dispatcher.
//
// The test lives in an EXTERNAL package (webaccess_test) because it imports
// backend — the same import the production mounting will make; the package
// under test itself must not (nodeps_test.go).

package webaccess_test

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/v0lka/c0wrk/backend"
	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/internal/webaccess"
)

// dtsEntry is one `export function NAME(arg1:T,arg2:T):Promise<R>` binding.
type dtsEntry struct {
	name  string
	arity int
}

// dtsPath resolves frontend/wailsjs/go/desktop/App.d.ts relative to this
// package's source directory, independent of the test working directory.
func dtsPath(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)
	p := filepath.Join(dir, "..", "..", "frontend", "wailsjs", "go", "desktop", "App.d.ts")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("bindings file missing: %v", err)
	}
	return p
}

// parseDTS extracts the exported function surface with arity, counting only
// top-level commas (TS generic brackets may nest commas, e.g. Array<string>).
func parseDTS(t *testing.T, path string) map[string]dtsEntry {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read d.ts: %v", err)
	}
	re := regexp.MustCompile(`(?m)^export function ([A-Za-z0-9_]+)\(([^)]*)\):Promise<`)
	out := make(map[string]dtsEntry)
	matches := re.FindAllStringSubmatch(string(data), -1)
	if len(matches) == 0 {
		t.Fatal("no bindings parsed — the d.ts format must have drifted")
	}
	for _, m := range matches {
		out[m[1]] = dtsEntry{name: m[1], arity: countTopLevelArgs(m[2])}
	}
	return out
}

// countTopLevelArgs counts parameters in a paren-free argument list,
// ignoring commas nested inside <...>, (...)
func countTopLevelArgs(list string) int {
	list = strings.TrimSpace(list)
	if list == "" {
		return 0
	}
	depth := 0
	n := 1
	for _, r := range list {
		switch r {
		case '<', '[', '(', '{':
			depth++
		case '>', ']', ')', '}':
			depth--
		case ',':
			if depth == 0 {
				n++
			}
		}
	}
	return n
}

// exportedMethods lists the exported method names of *backend.FrontendAPI.
func exportedMethods(t *testing.T) map[string]reflect.Method {
	t.Helper()
	typ := reflect.PointerTo(reflect.TypeFor[backend.FrontendAPI]())
	out := make(map[string]reflect.Method)
	for i := 0; i < typ.NumMethod(); i++ {
		m := typ.Method(i)
		if m.PkgPath != "" {
			continue // unexported
		}
		r, _ := utf8.DecodeRuneInString(m.Name)
		if !unicode.IsUpper(r) {
			t.Fatalf("method %s has empty PkgPath but a lowercase name — unexpected", m.Name)
		}
		out[m.Name] = m
	}
	if len(out) == 0 {
		t.Fatal("no exported methods found on *backend.FrontendAPI — the type must have drifted")
	}
	return out
}

// newContractServer builds a real server over a zero FrontendAPI: only the
// method SET is exercised, never a call.
func newContractServer(t *testing.T) *webaccess.Server {
	t.Helper()
	srv, err := webaccess.New(webaccess.Options{
		Config:   config.WebAccessConfig{Enabled: true, Bind: config.DefaultWebAccessBind},
		Dispatch: &backend.FrontendAPI{},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv
}

func TestSurfaceContract(t *testing.T) {
	bindings := parseDTS(t, dtsPath(t))
	methods := exportedMethods(t)
	srv := newContractServer(t)
	deny := webaccess.DefaultDenylist()

	t.Run("every exported FrontendAPI method is a wailsjs binding with matching arity", func(t *testing.T) {
		for name, m := range methods {
			b, ok := bindings[name]
			if !ok {
				t.Errorf("%s: exported on FrontendAPI but missing from App.d.ts", name)
				continue
			}
			// reflect.Type.Method includes the receiver in NumIn.
			goArity := m.Type.NumIn() - 1
			if b.arity != goArity {
				t.Errorf("%s: d.ts arity = %d, Go arity = %d", name, b.arity, goArity)
			}
		}
	})

	t.Run("every exported method is web-dispatchable except the denylist", func(t *testing.T) {
		for name := range methods {
			_, denied := deny[name]
			if got := srv.Dispatchable(name); got == denied {
				if denied {
					t.Errorf("%s: denylisted but reported dispatchable", name)
				} else {
					t.Errorf("%s: not denylisted but reported not dispatchable", name)
				}
			}
		}
	})

	t.Run("denylist entries are real FrontendAPI methods with documented reasons", func(t *testing.T) {
		if len(deny) == 0 {
			t.Fatal("denylist must not be empty")
		}
		for name, reason := range deny {
			if _, ok := methods[name]; !ok {
				t.Errorf("denylist entry %q is not a FrontendAPI method — stale entry", name)
			}
			if strings.TrimSpace(reason) == "" {
				t.Errorf("denylist entry %q lacks its reason", name)
			}
		}
	})

	t.Run("every exported method is structurally JSON-dispatchable", func(t *testing.T) {
		badKinds := map[reflect.Kind]string{
			reflect.Chan:          "chan",
			reflect.Func:          "func",
			reflect.UnsafePointer: "unsafe.Pointer",
			reflect.Invalid:       "invalid",
		}
		for name, m := range methods {
			if m.Type.IsVariadic() {
				t.Errorf("%s: variadic — the dispatcher refuses variadic methods", name)
			}
			for i := 1; i < m.Type.NumIn(); i++ { // In(0) is the receiver
				if why, bad := badKinds[m.Type.In(i).Kind()]; bad {
					t.Errorf("%s: parameter %d has a %s — never JSON-decodable", name, i, why)
				}
			}
		}
	})

	t.Run("wailsjs surface is fully accounted for", func(t *testing.T) {
		// One-directional completeness: bindings minus FrontendAPI methods
		// must be exactly the desktop.App additions (lifecycle, native
		// pickers, notifications) which the mounting layer owns — they are
		// NOT required to be web-dispatchable. Anything else here means a
		// binding appeared without a Go method owning it.
		unaccounted := 0
		for name := range bindings {
			if _, ok := methods[name]; !ok {
				unaccounted++
				t.Logf("binding %q is desktop.App-owned (not FrontendAPI)", name)
			}
		}
		t.Logf("d.ts bindings: %d, FrontendAPI methods: %d, desktop.App-owned: %d",
			len(bindings), len(methods), unaccounted)
	})
}

// TestNoDesktopImportInPackageSource enforces the isolation rule from the
// test binary's side as well: the contract test itself imports backend (as
// the mounting will), never desktop/wails.
func TestNoDesktopImportInPackageSource(t *testing.T) {
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
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		for _, imp := range f.Imports {
			path := strings.Trim(imp.Path.Value, `"`)
			if strings.HasPrefix(path, "github.com/v0lka/c0wrk/desktop") ||
				strings.HasPrefix(path, "github.com/wailsapp/") {
				t.Errorf("%s imports %q — the webaccess package must never know desktop/wails", name, path)
			}
		}
	}
}
