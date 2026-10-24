// SPDX-License-Identifier: Apache-2.0
//
// tls_test.go — the TLS stage (ADR-100): certificate generation (the four
// SAN bind classes, self-signed leaf properties, the 825-day window, atomic
// publication with exact modes, regeneration), the fail-closed New gate on
// an enabled-but-unreadable pair, and a real TLS listener round trip —
// MinVersion 1.2 enforced from below, hostname verified against the
// generated IP SANs, and the session cookie flipping to Secure exactly under
// TLS (plain HTTP keeps its byte-identical cookie shape, pinned in
// webaccess_test.go).
//
// Deliberately exercised failure paths (bad binds, unreadable pairs, a TLS
// 1.1 probe, a plaintext probe) assert on the returned errors and on the
// server's diagnostics captured through the injected slog handler — the test
// output stays clean on success.

package webaccess

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
)

// tempPairPaths returns the standard pair layout inside a fresh temp dir.
func tempPairPaths(t *testing.T) (certPath, keyPath string) {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "web-access.crt"), filepath.Join(dir, "web-access.key")
}

// loopbackSANSet is the SAN base every bind class receives: the browser-facing
// host of any local bind is reachable as localhost on this machine.
func loopbackSANSet() []net.IP {
	return []net.IP{net.IPv4(127, 0, 0, 1), net.ParseIP("::1")}
}

// ipSetsEqual compares IP slices by value (net.IP.Equal, so 4- and 16-byte
// encodings of the same address compare equal).
func ipSetsEqual(a, b []net.IP) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !a[i].Equal(b[i]) {
			return false
		}
	}
	return true
}

// TestCertSANs_BindClasses pins the SAN derivation for every bind class
// (ADR-100 decision 3): the loopback set {localhost, 127.0.0.1, ::1} is
// always present; the "localhost" name, a loopback literal and a wildcard
// bind add nothing; a specific non-loopback IP adds itself (mapped IPv4
// forms normalize to their 4-byte encoding); anything unparsable is refused.
func TestCertSANs_BindClasses(t *testing.T) {
	cases := []struct {
		name    string
		bind    string
		wantIPs []net.IP
		wantErr bool
	}{
		{"class 1: localhost name", "localhost", loopbackSANSet(), false},
		{"class 2: loopback IPv4", "127.0.0.1", loopbackSANSet(), false},
		{"class 2: loopback IPv6", "::1", loopbackSANSet(), false},
		{"class 3: wildcard IPv4 names localhost", "0.0.0.0", loopbackSANSet(), false},
		{"class 3: wildcard IPv6 names localhost", "::", loopbackSANSet(), false},
		{"class 4: specific IPv4 names itself", "192.168.1.10",
			append(loopbackSANSet(), net.IPv4(192, 168, 1, 10)), false},
		{"class 4: specific IPv6 names itself", "2001:db8::1",
			append(loopbackSANSet(), net.ParseIP("2001:db8::1")), false},
		{"class 4: mapped IPv4 normalizes to 4-byte", "::ffff:192.168.1.10",
			append(loopbackSANSet(), net.IPv4(192, 168, 1, 10)), false},
		{"hostname refused", "example.com", nil, true},
		{"empty refused", "", nil, true},
		{"garbage refused", "999.999.1.1", nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dns, ips, err := certSANs(tc.bind)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("certSANs(%q) = %v, %v; want error", tc.bind, dns, ips)
				}
				return
			}
			if err != nil {
				t.Fatalf("certSANs(%q): %v", tc.bind, err)
			}
			if len(dns) != 1 || dns[0] != "localhost" {
				t.Errorf("dns SANs = %v, want [localhost]", dns)
			}
			if !ipSetsEqual(ips, tc.wantIPs) {
				t.Errorf("ip SANs = %v, want %v", ips, tc.wantIPs)
			}
		})
	}
}

// parseGeneratedPair loads the published pair exactly the way New does and
// returns the parsed leaf.
func parseGeneratedPair(t *testing.T, certPath, keyPath string) *x509.Certificate {
	t.Helper()
	if _, err := tls.LoadX509KeyPair(certPath, keyPath); err != nil {
		t.Fatalf("tls.LoadX509KeyPair (the exact New load): %v", err)
	}
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatalf("read cert: %v", err)
	}
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatal("certificate PEM has no CERTIFICATE block")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse certificate: %v", err)
	}
	return leaf
}

// TestGenerateWebAccessCertificate_LeafProperties pins the generated leaf:
// self-signed, non-CA, ECDSA P-256, DigitalSignature/ServerAuth usage only,
// the fixed 825-day window, a fresh positive serial, and SANs that survive
// the marshal/unmarshal round trip.
func TestGenerateWebAccessCertificate_LeafProperties(t *testing.T) {
	certPath, keyPath := tempPairPaths(t)
	if err := GenerateWebAccessCertificate("192.168.1.10", certPath, keyPath); err != nil {
		t.Fatalf("GenerateWebAccessCertificate: %v", err)
	}
	leaf := parseGeneratedPair(t, certPath, keyPath)

	// Self-signed: issuer equals subject and the signature verifies with the
	// leaf's own key. (CheckSignatureFrom would refuse here by design — it
	// enforces the parent-must-be-a-CA rule, which a leaf self-signature
	// deliberately does not satisfy.)
	if !bytes.Equal(leaf.RawIssuer, leaf.RawSubject) {
		t.Errorf("issuer %q != subject %q — not self-signed", leaf.RawIssuer, leaf.RawSubject)
	}
	if err := leaf.CheckSignature(leaf.SignatureAlgorithm, leaf.RawTBSCertificate, leaf.Signature); err != nil {
		t.Errorf("self-signature does not verify: %v", err)
	}
	if leaf.IsCA || !leaf.BasicConstraintsValid {
		t.Errorf("leaf must not be a CA (IsCA=%v, BasicConstraintsValid=%v)", leaf.IsCA, leaf.BasicConstraintsValid)
	}
	key, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		t.Fatalf("public key is %T, want *ecdsa.PublicKey", leaf.PublicKey)
	}
	if key.Curve != elliptic.P256() {
		t.Errorf("curve = %v, want P-256", key.Curve)
	}
	if leaf.KeyUsage != x509.KeyUsageDigitalSignature {
		t.Errorf("KeyUsage = %v, want DigitalSignature only", leaf.KeyUsage)
	}
	if len(leaf.ExtKeyUsage) != 1 || leaf.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth {
		t.Errorf("ExtKeyUsage = %v, want [ServerAuth]", leaf.ExtKeyUsage)
	}
	if got := leaf.NotAfter.Sub(leaf.NotBefore); got != 825*24*time.Hour {
		t.Errorf("validity window = %v, want 825 days", got)
	}
	if leaf.SerialNumber == nil || leaf.SerialNumber.Sign() <= 0 {
		t.Errorf("serial = %v, want a fresh positive value", leaf.SerialNumber)
	}
	if len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != "localhost" {
		t.Errorf("published dns SANs = %v, want [localhost]", leaf.DNSNames)
	}
	if want := append(loopbackSANSet(), net.IPv4(192, 168, 1, 10)); !ipSetsEqual(leaf.IPAddresses, want) {
		t.Errorf("published ip SANs = %v, want %v", leaf.IPAddresses, want)
	}
}

// TestGenerateWebAccessCertificate_RegeneratesAndReplaces pins regeneration:
// the second generation replaces both files in place (fresh serial), the
// pair stays loadable after every generation, and no staging files linger.
func TestGenerateWebAccessCertificate_RegeneratesAndReplaces(t *testing.T) {
	certPath, keyPath := tempPairPaths(t)
	if err := GenerateWebAccessCertificate("127.0.0.1", certPath, keyPath); err != nil {
		t.Fatalf("first generation: %v", err)
	}
	first := parseGeneratedPair(t, certPath, keyPath)
	if err := GenerateWebAccessCertificate("127.0.0.1", certPath, keyPath); err != nil {
		t.Fatalf("regeneration: %v", err)
	}
	second := parseGeneratedPair(t, certPath, keyPath)
	if first.SerialNumber.Cmp(second.SerialNumber) == 0 {
		t.Error("regeneration must mint a fresh certificate, got the same serial twice")
	}
	entries, err := os.ReadDir(filepath.Dir(certPath))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("pair dir holds %d entries, want exactly the published 2 (staging files must not linger): %v",
			len(entries), entries)
	}
}

// TestGenerateWebAccessCertificate_PublishesExactModes pins the published
// permission bits: key 0600, certificate 0644 — exact fchmod, no umask
// filtering — and a pre-existing wider mode never survives the rename.
func TestGenerateWebAccessCertificate_PublishesExactModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission bits are unix-specific")
	}
	certPath, keyPath := tempPairPaths(t)
	assertModes := func(stage string) {
		t.Helper()
		ci, err := os.Stat(certPath)
		if err != nil {
			t.Fatalf("%s: stat cert: %v", stage, err)
		}
		if got := ci.Mode().Perm(); got != 0o644 {
			t.Errorf("%s: cert mode = %04o, want 0644", stage, got)
		}
		ki, err := os.Stat(keyPath)
		if err != nil {
			t.Fatalf("%s: stat key: %v", stage, err)
		}
		if got := ki.Mode().Perm(); got != 0o600 {
			t.Errorf("%s: key mode = %04o, want 0600 (owner-only)", stage, got)
		}
	}
	if err := GenerateWebAccessCertificate("127.0.0.1", certPath, keyPath); err != nil {
		t.Fatalf("GenerateWebAccessCertificate: %v", err)
	}
	assertModes("fresh generation")
	for _, p := range []string{certPath, keyPath} {
		if err := os.Chmod(p, 0o666); err != nil {
			t.Fatalf("chmod %s: %v", p, err)
		}
	}
	if err := GenerateWebAccessCertificate("127.0.0.1", certPath, keyPath); err != nil {
		t.Fatalf("regeneration: %v", err)
	}
	assertModes("regeneration over wider modes")
}

// TestGenerateWebAccessCertificate_Refuses pins the pure-input refusals: an
// invalid bind and missing output paths fail before anything is published.
func TestGenerateWebAccessCertificate_Refuses(t *testing.T) {
	certPath, keyPath := tempPairPaths(t)
	if err := GenerateWebAccessCertificate("example.com", certPath, keyPath); err == nil {
		t.Error("invalid bind must be refused")
	}
	if err := GenerateWebAccessCertificate("127.0.0.1", "", keyPath); err == nil {
		t.Error("empty cert path must be refused")
	}
	if err := GenerateWebAccessCertificate("127.0.0.1", certPath, ""); err == nil {
		t.Error("empty key path must be refused")
	}
	entries, err := os.ReadDir(filepath.Dir(certPath))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("refused generations must publish nothing, dir holds %v", entries)
	}
}

// TestNew_TLSFailClosed pins ADR-100 decision 2 at the mount: an enabled
// subsection whose pair is unreadable (missing, garbage, or mismatched)
// refuses New — the listener never silently downgrades to plaintext — while
// a disabled subsection ignores its paths entirely and a valid pair mounts.
func TestNew_TLSFailClosed(t *testing.T) {
	certA, keyA := tempPairPaths(t)
	if err := GenerateWebAccessCertificate("127.0.0.1", certA, keyA); err != nil {
		t.Fatalf("generate pair A: %v", err)
	}
	certB, keyB := tempPairPaths(t)
	if err := GenerateWebAccessCertificate("127.0.0.1", certB, keyB); err != nil {
		t.Fatalf("generate pair B: %v", err)
	}
	garbage := filepath.Join(t.TempDir(), "garbage.pem")
	if err := os.WriteFile(garbage, []byte("this is not a pem file"), 0o600); err != nil {
		t.Fatalf("write garbage: %v", err)
	}
	absent := filepath.Join(t.TempDir(), "absent.crt")

	cases := []struct {
		name    string
		tls     config.WebAccessTLSConfig
		wantErr string // empty = New must succeed
	}{
		{"enabled + missing files", config.WebAccessTLSConfig{Enabled: true, Cert: absent, Key: absent}, "unreadable"},
		{"enabled + empty paths", config.WebAccessTLSConfig{Enabled: true}, "empty"},
		{"enabled + mismatched pair", config.WebAccessTLSConfig{Enabled: true, Cert: certA, Key: keyB}, "unreadable"},
		{"enabled + garbage cert", config.WebAccessTLSConfig{Enabled: true, Cert: garbage, Key: keyA}, "unreadable"},
		{"disabled ignores paths", config.WebAccessTLSConfig{Enabled: false, Cert: garbage, Key: garbage}, ""},
		{"enabled + valid pair", config.WebAccessTLSConfig{Enabled: true, Cert: certA, Key: keyA}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New(newTestOptions(stubDispatch{}, func(o *Options) { o.Config.TLS = tc.tls }))
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("New: %v, want success", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("New succeeded, want an error mentioning %q", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not mention %q", err, tc.wantErr)
			}
		})
	}
}

// countSubstringRecords counts captured log records whose message contains
// substr — the expected server-side diagnostic for refused handshakes,
// intercepted at the source via the ErrorLog→slog plumbing in Start.
func countSubstringRecords(t *testing.T, h *captureHandler, substr string) int {
	t.Helper()
	n := 0
	for _, r := range h.snapshot() {
		if strings.Contains(r.Message, substr) {
			n++
		}
	}
	return n
}

// doGet performs a context-bound GET (the project's noctx discipline) with
// client and fails the test on a transport error; the response is the
// caller's to close.
func doGet(t *testing.T, client *http.Client, url string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, http.NoBody)
	if err != nil {
		t.Fatalf("build GET %s: %v", url, err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	return resp
}

// TestServer_TLSEndToEnd serves the sidecar over a REAL TLS listener started
// through Start (ServeTLS on the generated pair) and pins the wire contract:
// hostname verification against the generated IP SANs succeeds, TLS 1.2
// exactly is accepted, TLS 1.1 is refused by the pinned floor with a
// server-side diagnostic, the login cookie carries Secure only under TLS,
// a plaintext request against the TLS port never reaches the API, and the
// listener is pinned to HTTP/1.1 (never h2 — the /ws Upgrade handshake is a
// Hijacker flow an HTTP/2 stream cannot carry).
func TestServer_TLSEndToEnd(t *testing.T) {
	certPath, keyPath := tempPairPaths(t)
	if err := GenerateWebAccessCertificate("127.0.0.1", certPath, keyPath); err != nil {
		t.Fatalf("GenerateWebAccessCertificate: %v", err)
	}
	leaf := parseGeneratedPair(t, certPath, keyPath)
	pool := x509.NewCertPool()
	pool.AddCert(leaf)

	capture := &captureHandler{}
	srv := mustNew(t, newTestOptions(stubDispatch{}, func(o *Options) {
		o.Config.TLS = config.WebAccessTLSConfig{Enabled: true, Cert: certPath, Key: keyPath}
		o.Logger = slog.New(capture)
	}))
	if err := srv.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = srv.Stop(context.Background()) })
	addr, ok := srv.Addr()
	if !ok {
		t.Fatal("Start left no listener address")
	}
	base := "https://" + addr

	secureClient := func(lo, hi uint16) *http.Client {
		return &http.Client{Transport: &http.Transport{
			// RootCAs + default hostname verification: the generated IP SAN
			// must actually verify — no InsecureSkipVerify anywhere.
			TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: lo, MaxVersion: hi},
		}}
	}

	t.Run("serves over real TLS, hostname verified against generated SANs", func(t *testing.T) {
		resp := doGet(t, secureClient(tls.VersionTLS12, tls.VersionTLS13), base+"/api/transport")
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		var ti transportInfo
		if err := json.NewDecoder(resp.Body).Decode(&ti); err != nil {
			t.Fatalf("decode transport payload: %v", err)
		}
		if ti.Transport != "web" || ti.WS != wsPath {
			t.Errorf("transport payload = %+v", ti)
		}
	})

	t.Run("TLS 1.2 exactly is accepted", func(t *testing.T) {
		resp := doGet(t, secureClient(tls.VersionTLS12, tls.VersionTLS12), base+"/api/transport")
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
	})

	t.Run("TLS 1.1 is refused by the 1.2 floor", func(t *testing.T) {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
			base+"/api/transport", http.NoBody)
		if err != nil {
			t.Fatalf("build TLS 1.1 request: %v", err)
		}
		resp, err := secureClient(tls.VersionTLS10, tls.VersionTLS11).Do(req)
		if err == nil {
			_ = resp.Body.Close()
			t.Error("TLS 1.1 client must fail the handshake (server floor is 1.2)")
		}
		// The refusal is expected diagnostics: intercepted at the source
		// (ErrorLog → slog), asserted, never leaked to the test output.
		// The record is written from the server's connection goroutine and
		// can land after the client has already observed its handshake
		// error — the two sides share no synchronization primitive (real
		// socket, so no synctest bubble) — so the count is awaited through
		// a completion channel behind the bounded hang watchdog instead of
		// being asserted on the first snapshot.
		records := make(chan int, 1)
		go func() {
			for {
				if n := countSubstringRecords(t, capture, "TLS handshake error"); n > 0 {
					records <- n
					return
				}
				runtime.Gosched()
			}
		}()
		select {
		case <-records:
		case <-time.After(2 * time.Second):
			t.Error("server must record the refused handshake")
		}
	})

	t.Run("login over TLS issues a Secure cookie", func(t *testing.T) {
		resp := doJSON(t, secureClient(tls.VersionTLS12, tls.VersionTLS13),
			"POST", base+"/api/login", `{"token":"static-test-token-0123456789"}`)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		cookies := resp.Cookies()
		if len(cookies) != 1 || cookies[0].Name != cookieName {
			t.Fatalf("expected one %s cookie, got %#v", cookieName, cookies)
		}
		c := cookies[0]
		if !c.Secure {
			t.Error("cookie must carry Secure under TLS (ADR-100 decision 6)")
		}
		if !c.HttpOnly {
			t.Error("cookie must stay HttpOnly")
		}
		if c.SameSite != http.SameSiteStrictMode {
			t.Errorf("SameSite = %v, want Strict", c.SameSite)
		}
		if c.Value == srv.cfg.Token {
			t.Error("cookie must carry the per-launch session secret, not the configured token")
		}
	})

	t.Run("plaintext downgrade attempt never reaches the API", func(t *testing.T) {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
			"http://"+addr+"/api/transport", http.NoBody)
		if err != nil {
			t.Fatalf("build plaintext request: %v", err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			// A client-side transport error is the expected shape of the
			// refusal; the server side must have recorded it as well.
			if n := countSubstringRecords(t, capture, "TLS handshake error"); n == 0 {
				t.Error("server must record the refused plaintext connection")
			}
			return
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode == http.StatusOK {
			t.Error("plaintext request unexpectedly succeeded against the TLS listener")
		}
	})

	t.Run("server is pinned to HTTP/1.1 only", func(t *testing.T) {
		p := srv.httpSrv.Protocols
		if p == nil {
			t.Fatal("Server.Protocols is nil: ServeTLS auto-configures HTTP/2, and the /ws " +
				"Upgrade handshake cannot survive an h2 stream")
		}
		if !p.HTTP1() {
			t.Error("Protocols.HTTP1 = false, want true")
		}
		if p.HTTP2() {
			t.Error("Protocols.HTTP2 = true, want false: h2 would let browsers attempt " +
				"WebSocket-over-HTTP/2 against the Hijacker-based /ws handshake")
		}
		if p.UnencryptedHTTP2() {
			t.Error("Protocols.UnencryptedHTTP2 = true, want false")
		}
	})

	t.Run("TLS listener never offers h2 over ALPN", func(t *testing.T) {
		// The wire-level regression for the Protocols pin: a browser-shaped
		// ClientHello offering both h2 and http/1.1 must negotiate http/1.1.
		// A future Go (or a removed pin) that re-enables h2 flips this to h2
		// and fails here instead of silently killing /ws under TLS.
		d := tls.Dialer{
			NetDialer: &net.Dialer{Timeout: 2 * time.Second},
			Config: &tls.Config{
				RootCAs:    pool,
				ServerName: "localhost",
				MinVersion: tls.VersionTLS12,
				NextProtos: []string{"h2", "http/1.1"},
			},
		}
		raw, err := d.DialContext(context.Background(), "tcp", addr)
		if err != nil {
			t.Fatalf("TLS dial: %v", err)
		}
		conn, ok := raw.(*tls.Conn)
		if !ok {
			_ = raw.Close()
			t.Fatalf("dial returned %T, want *tls.Conn", raw)
		}
		defer func() { _ = conn.Close() }()
		if got := conn.ConnectionState().NegotiatedProtocol; got != "http/1.1" {
			t.Fatalf("ALPN negotiated %q, want %q — h2 must never be offered (the /ws "+
				"handshake is a Hijacker-based Upgrade that HTTP/2 cannot carry)", got, "http/1.1")
		}
	})
}
