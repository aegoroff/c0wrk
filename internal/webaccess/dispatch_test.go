// SPDX-License-Identifier: Apache-2.0
//
// dispatch_test.go — the reflection RPC matrix: happy paths across every
// Wails return convention, argument/arity errors, method resolution, the
// denylist, variadic refusal, and panic isolation of dispatched methods.

package webaccess

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// rpcEcho calls method over the wired handler with the given JSON body and
// returns status + raw body.
func rpcEcho(t *testing.T, srv *Server, method, body string) (status int, respBody string) {
	t.Helper()
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	client := loginClient(t, ts.URL, srv.AuthToken())
	resp := doJSON(t, client, "POST", ts.URL+"/api/rpc/"+method, body)
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode, bodyString(t, resp)
}

// newAuthedDispatchServer wires a fresh stub server with a capture logger.
func newDispatchServer(t *testing.T) (srv *Server, ts *httptest.Server) {
	t.Helper()
	return newTestServer(t, nil)
}

func TestDispatchHappyPaths(t *testing.T) {
	srv, _ := newDispatchServer(t)

	cases := []struct {
		name       string
		method     string
		body       string
		wantStatus int
		wantBody   string
	}{
		{"single string arg, value-only return", "Echo", `["hi"]`, http.StatusOK, "\"echo:hi\"\n"},
		{"zero args via bare POST", "NoArgs", "", http.StatusOK, "\"bare\"\n"},
		{"zero args via []", "NoArgs", `[]`, http.StatusOK, "\"bare\"\n"},
		{"zero args via null", "NoArgs", `null`, http.StatusOK, "\"bare\"\n"},
		{"typed args", "Multi", `[3,true]`, http.StatusOK, "\"3-true\"\n"},
		{"(T, error) success", "Failing", `[true]`, http.StatusOK, "\"fine\"\n"},
		{"(error) success", "OnlyError", ``, http.StatusOK, "null\n"},
		{"two non-error returns become an array", "Pair", ``, http.StatusOK, "[7,\"seven\"]\n"},
		{"object argument decodes into a struct-shaped any", "Echo", `["multi\nline"]`, http.StatusOK, "\"echo:multi\\nline\"\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := rpcEcho(t, srv, tc.method, tc.body)
			if status != tc.wantStatus || body != tc.wantBody {
				t.Fatalf("got (%d, %q), want (%d, %q)", status, body, tc.wantStatus, tc.wantBody)
			}
		})
	}
}

func TestDispatchFailures(t *testing.T) {
	srv, _ := newDispatchServer(t)

	cases := []struct {
		name       string
		method     string
		body       string
		wantStatus int
		wantSubstr string
	}{
		{"method-returned error becomes the 500 envelope", "Failing", `[false]`, http.StatusInternalServerError, "kaboom"},
		{"unknown method is 404", "NoSuchMethod", ``, http.StatusNotFound, "unknown method"},
		{"lowercase names are not the surface", "echo", `["x"]`, http.StatusNotFound, "unknown method"},
		{"arity too few", "Echo", ``, http.StatusBadRequest, "expects 1 argument(s), got 0"},
		{"arity too many", "Echo", `["a","b"]`, http.StatusBadRequest, "expects 1 argument(s), got 2"},
		{"type mismatch is 400", "Multi", `["not-an-int",true]`, http.StatusBadRequest, "argument 1"},
		{"malformed json body", "Echo", `{nope`, http.StatusBadRequest, "JSON array"},
		{"variadic methods are refused", "VariadicProbe", `[1,2]`, http.StatusNotImplemented, "variadic"},
		{"non-decodable arg type is 400", "ChanParamProbe", `[123]`, http.StatusBadRequest, "argument 1"},
		{"non-decodable func arg is 400", "FuncParamProbe", `[123]`, http.StatusBadRequest, "argument 1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := rpcEcho(t, srv, tc.method, tc.body)
			if status != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", status, tc.wantStatus, body)
			}
			var env errorEnvelope
			if err := json.Unmarshal([]byte(body), &env); err != nil {
				t.Fatalf("body %q is not an error envelope: %v", body, err)
			}
			if env.Error == "" || (tc.wantSubstr != "" && !strings.Contains(env.Error, tc.wantSubstr)) {
				t.Fatalf("error envelope = %q, want substring %q", env.Error, tc.wantSubstr)
			}
		})
	}
}

func TestDenylistMethodsAreUnavailable(t *testing.T) {
	for _, method := range []string{"EmitSessionEvent", "PasteFromClipboard"} {
		t.Run(method, func(t *testing.T) {
			srv, _ := newDispatchServer(t)
			status, body := rpcEcho(t, srv, method, `[]`)
			if status != http.StatusForbidden {
				t.Fatalf("status = %d, want 403", status)
			}
			var env errorEnvelope
			if err := json.Unmarshal([]byte(body), &env); err != nil || env.Error == "" {
				t.Fatalf("body %q: expected a reason envelope", body)
			}
		})
	}
	t.Run("denylist wins over an existing method", func(t *testing.T) {
		// A target that actually HAS the denylisted methods must still be
		// refused: the denylist check precedes reflection.
		srv := mustNew(t, newTestOptions(deniedTarget{}, nil))
		if srv.Dispatchable("EmitSessionEvent") {
			t.Fatal("EmitSessionEvent must not be dispatchable")
		}
		status, body := rpcEcho(t, srv, "EmitSessionEvent", `[]`)
		if status != http.StatusForbidden {
			t.Fatalf("status = %d, want 403 (body %s)", status, body)
		}
	})
}

// deniedTarget actually defines the denylisted methods, proving the denylist
// suppresses present methods, not just absent ones.
type deniedTarget struct{}

func (deniedTarget) EmitSessionEvent()                   {}
func (deniedTarget) PasteFromClipboard() (string, error) { return "", nil }

func TestDefaultDenylistShape(t *testing.T) {
	dl := DefaultDenylist()
	if len(dl) == 0 {
		t.Fatal("denylist must not be empty")
	}
	for name, reason := range dl {
		if reason == "" {
			t.Errorf("denylist entry %q has an empty reason — every entry needs its inline justification", name)
		}
	}
	// The map returned must be a copy: mutating it must not affect the server.
	dl["Intruder"] = "x"
	if _, ok := DefaultDenylist()["Intruder"]; ok {
		t.Fatal("DefaultDenylist must return a copy")
	}
}

func TestDispatchablePredicate(t *testing.T) {
	srv, _ := newDispatchServer(t)
	if !srv.Dispatchable("Echo") {
		t.Error("Echo must be dispatchable")
	}
	if srv.Dispatchable("unexportedNotOnSurface") {
		t.Error("unexported methods must not be dispatchable")
	}
	if srv.Dispatchable("NoSuch") {
		t.Error("unknown methods must not be dispatchable")
	}
	if srv.Dispatchable("EmitSessionEvent") || srv.Dispatchable("PasteFromClipboard") {
		t.Error("denylisted methods must not be dispatchable")
	}
}

func TestDispatchedMethodPanicIsIsolated(t *testing.T) {
	capture := &captureHandler{}
	srv, ts := newTestServer(t, func(o *Options) { o.Logger = slog.New(capture) })

	status, body := rpcEcho(t, srv, "Boom", ``)
	if status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", status)
	}
	if !strings.Contains(body, "internal error") {
		t.Fatalf("body = %q, want generic internal error (never the panic value)", body)
	}
	if n := capture.count(t, "webaccess: rpc panic"); n != 1 {
		t.Fatalf("captured 'rpc panic' records = %d, want 1", n)
	}

	// The server keeps serving after the panic.
	client := loginClient(t, ts.URL, srv.AuthToken())
	resp := doJSON(t, client, "POST", ts.URL+"/api/rpc/Echo", `["alive"]`)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("post-panic status = %d, want 200", resp.StatusCode)
	}
}
