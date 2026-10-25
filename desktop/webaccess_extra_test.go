// SPDX-License-Identifier: Apache-2.0
//
// webaccess_extra_test.go — pins the App-level extra surface the browser web
// transport is allowed to reach (webaccess_extra.go → Options.ExtraDispatch).
//
// The adapter is the ONLY web-reachable slice of desktop.App: everything not
// on it (SetWebAccessEnabled, GetWebAccessInfo, Quit, …) stays unreachable
// from a browser tab by construction. These tests fail on silent widening:
// any method added to the adapter must consciously update the pinned set,
// appear in the generated wailsjs bindings (so the frontend shim can call
// it), and never collide with the control-RPC isolation.

package desktop

import (
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/backend"
	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/internal/webaccess"
)

// TestWebExtraSurfaceIsExactlyPinned fails on any adapter method that was
// not consciously added: the set must be exactly the pinned names.
func TestWebExtraSurfaceIsExactlyPinned(t *testing.T) {
	typ := reflect.TypeFor[*webExtraSurface]()
	got := make(map[string]bool, typ.NumMethod())
	for i := 0; i < typ.NumMethod(); i++ {
		got[typ.Method(i).Name] = true
	}
	want := map[string]bool{"GetPendingActions": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("web extra surface drifted: got %v, want exactly %v — widen the browser attack surface only with a deliberate test amendment", got, want)
	}
}

// TestWebExtraSurfaceMethodsAreWailsBindings keeps the shim able to call the
// adapter methods positionally: every pinned name must exist in the
// generated App.d.ts (the frontend's method universe).
func TestWebExtraSurfaceMethodsAreWailsBindings(t *testing.T) {
	data, err := os.ReadFile("../frontend/wailsjs/go/desktop/App.d.ts")
	if err != nil {
		t.Fatalf("read bindings: %v", err)
	}
	for _, name := range []string{"GetPendingActions"} {
		if !containsBinding(string(data), name) {
			t.Errorf("%s: adapter method missing from App.d.ts — regenerate the bindings (wails build) before exposing it to the web", name)
		}
	}
}

func containsBinding(dts, name string) bool {
	return strings.Contains(dts, "export function "+name+"(")
}

// TestWebExtraSurfaceIsTheOnlyAppSliceOverTheWeb is the security pin: on a
// server wired exactly like the real mount (FrontendAPI dispatch + the
// adapter), the adapter method is dispatchable while the App's control RPCs
// are not — a browser tab can reconcile HITL prompts but never touch the
// sidecar's own switch or credential view.
func TestWebExtraSurfaceIsTheOnlyAppSliceOverTheWeb(t *testing.T) {
	if _, ok := reflect.PointerTo(reflect.TypeFor[backend.FrontendAPI]()).MethodByName("GetPendingActions"); ok {
		t.Fatal("GetPendingActions moved onto FrontendAPI — the adapter (and this test) must be updated")
	}

	srv, err := webaccess.New(webaccess.Options{
		Config: config.WebAccessConfig{
			Enabled: true,
			Bind:    config.DefaultWebAccessBind,
			Port:    0,
			Token:   "webaccess-extra-surface-test-token",
		},
		Dispatch:      &backend.FrontendAPI{},
		ExtraDispatch: &webExtraSurface{app: &App{}},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if !srv.Dispatchable("GetPendingActions") {
		t.Error("GetPendingActions must be dispatchable through the extra surface")
	}
	for _, control := range []string{"GetWebAccessInfo", "SetWebAccessEnabled", "SetWebAccessAllowInsecureLAN", "SetWebAccessTLS", "GenerateWebAccessCertificate", "ConfirmExit", "Quit"} {
		if srv.Dispatchable(control) {
			t.Errorf("%s: an App control method must NOT be dispatchable over the web transport", control)
		}
	}
}
