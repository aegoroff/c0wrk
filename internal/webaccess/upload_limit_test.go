// SPDX-License-Identifier: Apache-2.0
//
// upload_limit_test.go — the per-method RPC body limit: upload-carrying
// methods (AttachFileContent) accept bodies up to maxUploadBodyBytes while
// every other method keeps the default maxBodyBytes.
package webaccess

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// attachProbeDispatch mirrors the real AttachFileContent shape so the raised
// limit can be exercised through the full HTTP path (the method must EXIST on
// the dispatch target, or handleRPC 404s before the body is ever read).
type attachProbeDispatch struct{}

func (attachProbeDispatch) Echo(s string) string { return "echo:" + s }

func (attachProbeDispatch) AttachFileContent(sessionID, fileName, mimeType string, data []byte) string {
	return fmt.Sprintf("%s/%s/%s/%d", sessionID, fileName, mimeType, len(data))
}

// TestUploadMethodBodyLimit: a body between the default and the upload cap is
// accepted for AttachFileContent and still rejected (413) for an ordinary
// method on the same server; the payload arrives intact as a base64 []byte.
func TestUploadMethodBodyLimit(t *testing.T) {
	_, ts := newTestServer(t, func(o *Options) { o.Dispatch = attachProbeDispatch{} })
	base := ts.URL
	client := loginClient(t, base, "static-test-token-0123456789")

	// Strictly between the two limits: past maxBodyBytes (so ordinary methods
	// must refuse it) yet well under maxUploadBodyBytes (so the upload method
	// must accept it). The byte value is chosen to be valid inside a JSON
	// string as-is.
	big := strings.Repeat("a", int(maxBodyBytes)+1)

	t.Run("ordinary method keeps the default cap", func(t *testing.T) {
		resp := doJSON(t, client, "POST", base+"/api/rpc/Echo", `["`+big+`"]`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusRequestEntityTooLarge {
			t.Errorf("status = %d, want 413", resp.StatusCode)
		}
	})

	t.Run("upload method accepts the raised cap", func(t *testing.T) {
		// The base64 of 1 MiB + 1 'a's is ~1.37 MiB — past the default cap,
		// far under the upload cap. arg4 is a base64 string: the wire form of
		// a Go []byte argument.
		payload := `["sess-1","shot.png","image/png","` +
			base64.StdEncoding.EncodeToString([]byte(big)) + `"]`
		resp := doJSON(t, client, "POST", base+"/api/rpc/AttachFileContent", payload)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("status = %d, want 200", resp.StatusCode)
		}
	})

	t.Run("upload method still refuses bodies above its cap", func(t *testing.T) {
		over := strings.Repeat("a", int(maxUploadBodyBytes)+1)
		resp := doJSON(t, client, "POST", base+"/api/rpc/AttachFileContent", `["`+over+`"]`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusRequestEntityTooLarge {
			t.Errorf("status = %d, want 413", resp.StatusCode)
		}
	})
}

// bodyLimitFor routes every non-upload method to maxBodyBytes.
func TestBodyLimitForDefaults(t *testing.T) {
	if got := bodyLimitFor("Echo"); got != maxBodyBytes {
		t.Errorf("bodyLimitFor(Echo) = %d, want %d", got, maxBodyBytes)
	}
	if got := bodyLimitFor("AttachFileContent"); got != maxUploadBodyBytes {
		t.Errorf("bodyLimitFor(AttachFileContent) = %d, want %d", got, maxUploadBodyBytes)
	}
}
