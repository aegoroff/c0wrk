// SPDX-License-Identifier: Apache-2.0
//
// webaccess_tls_test.go — the TLS surface of the web-access control RPCs
// (ADR-092): SetWebAccessTLS toggles the web_access.tls subsection with the
// section's persist + hot-restart + rollback discipline (an unloadable pair
// fails closed and never leaves the sidecar down), GenerateWebAccessCertificate
// writes the fixed app-owned pair for the pinned bind into an isolated agent
// dir and persists its paths, and GetWebAccessInfo classifies the configured
// certificate against the pinned bind (ok/mismatch/unreadable/expired).

package desktop

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/internal/webaccess"
)

// writeTLSPairFiles writes an arbitrary self-signed PEM pair (the certgen
// helper only produces valid 825-day pairs; the cert_status matrix needs an
// expired one too) and returns the file paths.
func writeTLSPairFiles(t *testing.T, dir, certName, keyName string, notBefore, notAfter time.Time, ips ...string) (certPath, keyPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	ipSANs := make([]net.IP, 0, len(ips))
	for _, s := range ips {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test SAN %q is not an IP", s)
		}
		ipSANs = append(ipSANs, ip)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "webaccess_tls_test"},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
		DNSNames:              []string{"localhost"},
		IPAddresses:           ipSANs,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	certPath = filepath.Join(dir, certName)
	keyPath = filepath.Join(dir, keyName)
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return certPath, keyPath
}

// writeGeneratedPair generates a valid app-shaped pair through the real
// certgen helper and returns the paths.
func writeGeneratedPair(t *testing.T, dir, certName, keyName string) (certPath, keyPath string) {
	t.Helper()
	certPath = filepath.Join(dir, certName)
	keyPath = filepath.Join(dir, keyName)
	if err := webaccess.GenerateWebAccessCertificate("127.0.0.1", certPath, keyPath); err != nil {
		t.Fatalf("generate pair: %v", err)
	}
	return certPath, keyPath
}

// tlsRootPool builds a RootCAs pool from a PEM certificate file.
func tlsRootPool(t *testing.T, certPath string) *x509.CertPool {
	t.Helper()
	pemBytes, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatalf("read cert %s: %v", certPath, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemBytes) {
		t.Fatalf("no certificates parsed from %s", certPath)
	}
	return pool
}

// dialWebAccessTLSLeaf performs a hostname-verified TLS handshake against the
// sidecar's resolved address and returns the served leaf certificate. The
// connection is closed before returning — an open conn would stall the next
// hot restart on the server's graceful-drain budget.
func dialWebAccessTLSLeaf(t *testing.T, addr string, roots *x509.CertPool) *x509.Certificate {
	t.Helper()
	dialer := &tls.Dialer{
		NetDialer: &net.Dialer{Timeout: 2 * time.Second},
		Config: &tls.Config{
			RootCAs:    roots,
			ServerName: "127.0.0.1",
			MinVersion: tls.VersionTLS12,
		},
	}
	conn, err := dialer.DialContext(t.Context(), "tcp", addr)
	if err != nil {
		t.Fatalf("TLS dial %s: %v", addr, err)
	}
	defer func() { _ = conn.Close() }()
	tlsConn, ok := conn.(*tls.Conn)
	if !ok {
		t.Fatalf("dial returned %T, want *tls.Conn", conn)
	}
	certs := tlsConn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		t.Fatal("TLS handshake returned no peer certificates")
	}
	return certs[0]
}

// plainHTTPReachable reports whether a plain HTTP request against addr
// gets an HTTP response (any status — the point is that plaintext is what
// answers).
func plainHTTPReachable(t *testing.T, addr string) bool {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+addr, http.NoBody)
	if err != nil {
		return false
	}
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return true
}

// TestSetWebAccessTLS_TogglePersistsAndHotRestarts: enabling TLS hot-restarts
// the running sidecar onto HTTPS with the derived key path persisted; the
// browser URL renders https; disabling returns the sidecar to plain HTTP and
// wipes the subsection the request carried.
func TestSetWebAccessTLS_TogglePersistsAndHotRestarts(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writeGeneratedPair(t, dir, "custom.pem", "custom.key")
	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: true\n")
	a := newWebAccessTestApp(t, cfg, path)
	a.initWebAccess(cfg, a.log())
	first := a.webAccess.Load()
	if first == nil {
		t.Fatal("sidecar did not mount")
	}

	// ── Enable: derived key (empty key argument), live HTTPS restart ──
	if err := a.SetWebAccessTLS(true, certPath, ""); err != nil {
		t.Fatalf("SetWebAccessTLS(true): %v", err)
	}
	sec := a.webAccess.Load()
	if sec == nil || sec == first {
		t.Fatal("enabling TLS did not rebuild the sidecar")
	}
	if !sec.TLSEnabled() {
		t.Fatal("sidecar does not terminate TLS after the toggle")
	}
	addr, ok := sec.Addr()
	if !ok {
		t.Fatal("restarted sidecar has no resolved address")
	}
	dialWebAccessTLSLeaf(t, addr, tlsRootPool(t, certPath))
	reloaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if !reloaded.WebAccess.TLS.Enabled ||
		reloaded.WebAccess.TLS.Cert != certPath ||
		reloaded.WebAccess.TLS.Key != keyPath {
		t.Errorf("disk TLS subsection = %+v, want enabled with cert %q and the DERIVED key %q",
			reloaded.WebAccess.TLS, certPath, keyPath)
	}
	info := a.GetWebAccessInfo()
	if !info.TLSEnabled || info.TLSCert != certPath || info.TLSKey != keyPath {
		t.Errorf("info TLS fields = (%v, %q, %q), want (true, %q, %q)",
			info.TLSEnabled, info.TLSCert, info.TLSKey, certPath, keyPath)
	}
	if !strings.HasPrefix(info.URL, "https://") {
		t.Errorf("info.URL = %q, want the https scheme while TLS serves", info.URL)
	}
	if info.CertStatus != webAccessCertStatusOK {
		t.Errorf("info.CertStatus = %q (%q), want ok for the generated pair", info.CertStatus, info.CertDetail)
	}

	// ── Disable: back to plain HTTP, byte-identical pre-ADR behavior ──
	if err := a.SetWebAccessTLS(false, "", ""); err != nil {
		t.Fatalf("SetWebAccessTLS(false): %v", err)
	}
	third := a.webAccess.Load()
	if third == nil || third == sec {
		t.Fatal("disabling TLS did not rebuild the sidecar")
	}
	if third.TLSEnabled() {
		t.Fatal("sidecar still terminates TLS after the toggle off")
	}
	addr3, ok := third.Addr()
	if !ok {
		t.Fatal("restarted sidecar has no resolved address")
	}
	if !plainHTTPReachable(t, addr3) {
		t.Error("plain HTTP does not answer after the toggle off")
	}
	// A verified TLS dial (RootCAs + ServerName) cannot succeed against a
	// plaintext listener — no cert is ever served to verify.
	plainRefuser := &tls.Dialer{
		NetDialer: &net.Dialer{Timeout: 2 * time.Second},
		Config: &tls.Config{
			RootCAs:    tlsRootPool(t, certPath),
			ServerName: "127.0.0.1",
			MinVersion: tls.VersionTLS12,
		},
	}
	if _, err := plainRefuser.DialContext(t.Context(), "tcp", addr3); err == nil {
		t.Error("a TLS handshake succeeded against the plain-HTTP sidecar")
	}
	reloaded, err = config.Load(path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if reloaded.WebAccess.TLS != (config.WebAccessTLSConfig{}) {
		t.Errorf("disk TLS subsection after disable = %+v, want the zero subsection (the request carried no paths)", reloaded.WebAccess.TLS)
	}
	info = a.GetWebAccessInfo()
	if strings.HasPrefix(info.URL, "https://") {
		t.Errorf("info.URL = %q, want the http scheme on plain HTTP", info.URL)
	}
	if info.TLSEnabled || info.TLSCert != "" || info.CertStatus != "" {
		t.Errorf("info after disable = (tls %v, cert %q, status %q), want all empty",
			info.TLSEnabled, info.TLSCert, info.CertStatus)
	}
}

// TestSetWebAccessTLS_UnreadablePairFailsClosedAndRollsBack: a toggle onto a
// pair the sidecar cannot load must not take the sidecar down — the restart
// fails closed (plaintext-downgrade is never an outcome, ADR-092 decision 2),
// the previous subsection is restored on disk, and the sidecar is running
// again on plain HTTP.
func TestSetWebAccessTLS_UnreadablePairFailsClosedAndRollsBack(t *testing.T) {
	dir := t.TempDir()
	garbageCert := filepath.Join(dir, "garbage.crt")
	garbageKey := filepath.Join(dir, "garbage.key")
	for _, p := range []string{garbageCert, garbageKey} {
		if err := os.WriteFile(p, []byte("this is not a PEM file"), 0o600); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: true\n  token: keep-me\n")
	a := newWebAccessTestApp(t, cfg, path)
	a.initWebAccess(cfg, a.log())
	before := a.webAccess.Load()
	if before == nil {
		t.Fatal("sidecar did not mount")
	}

	for name, cert := range map[string]string{"garbage": garbageCert, "missing": filepath.Join(dir, "absent.crt")} {
		if err := a.SetWebAccessTLS(true, cert, filepath.Join(dir, "absent.key")); err == nil {
			t.Fatalf("SetWebAccessTLS with a %s pair: expected an error", name)
		} else if !strings.Contains(err.Error(), "previous settings were restored") {
			t.Errorf("SetWebAccessTLS with a %s pair: error = %v, want the restored-previous-settings message", name, err)
		}
		restored := a.webAccess.Load()
		if restored == nil {
			t.Fatalf("%s pair: sidecar did not come back after the rollback", name)
		}
		if restored.TLSEnabled() {
			t.Errorf("%s pair: sidecar came back terminating TLS", name)
		}
		addr, ok := restored.Addr()
		if !ok || !plainHTTPReachable(t, addr) {
			t.Errorf("%s pair: restored sidecar is not serving plain HTTP", name)
		}
		reloaded, err := config.Load(path)
		if err != nil {
			t.Fatalf("reload config: %v", err)
		}
		if reloaded.WebAccess.TLS != (config.WebAccessTLSConfig{}) {
			t.Errorf("%s pair: disk TLS subsection after rollback = %+v, want the zero subsection", name, reloaded.WebAccess.TLS)
		}
	}
}

// TestSetWebAccessTLS_ValidationNoopAndGuards: the structural rule runs
// through config.ValidateWebAccessTLS (enabled ⇒ non-empty cert), a matching
// request is a no-op that does not rewrite the file, and the RPC shares the
// other control RPCs' config-ref guard.
func TestSetWebAccessTLS_ValidationNoopAndGuards(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writeGeneratedPair(t, dir, "pair.crt", "pair.key")
	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: false\n")
	a := newWebAccessTestApp(t, cfg, path)

	// Enabled with no cert: the shared structural message, nothing persisted.
	if err := a.SetWebAccessTLS(true, "", ""); err == nil {
		t.Fatal("expected the structural error for an enabled subsection without a cert")
	} else if !strings.Contains(err.Error(), "tls.cert is required") {
		t.Errorf("error = %v, want the shared tls.cert message", err)
	}
	reloaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if reloaded.WebAccess.TLS.Enabled {
		t.Error("a refused request changed the persisted subsection")
	}

	// The subsection persists while the sidecar section is disabled (the pin
	// semantics of the connection fields): applies at the next gated start.
	if err := a.SetWebAccessTLS(true, certPath, keyPath); err != nil {
		t.Fatalf("SetWebAccessTLS while disabled: %v", err)
	}
	reloaded, err = config.Load(path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if !reloaded.WebAccess.TLS.Enabled || reloaded.WebAccess.TLS.Cert != certPath || reloaded.WebAccess.TLS.Key != keyPath {
		t.Errorf("disk TLS subsection = %+v, want enabled with the pair", reloaded.WebAccess.TLS)
	}
	if a.webAccess.Load() != nil {
		t.Error("the call started the sidecar while web access is disabled")
	}

	// A matching request is a no-op: the config file is not rewritten.
	stat, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}
	if err := a.SetWebAccessTLS(true, certPath, keyPath); err != nil {
		t.Fatalf("matching SetWebAccessTLS: %v", err)
	}
	stat2, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat config after no-op: %v", err)
	}
	if !stat.ModTime().Equal(stat2.ModTime()) {
		t.Error("a matching request rewrote the config file")
	}

	// The config-ref guard mirrors SetWebAccessEnabled.
	bare := NewApp()
	if err := bare.SetWebAccessTLS(true, certPath, keyPath); err == nil {
		t.Fatal("expected an error without a config ref, got nil")
	} else if !strings.Contains(err.Error(), "config not initialized") {
		t.Errorf("error = %v, want the config-not-initialized message", err)
	}
	if err := bare.GenerateWebAccessCertificate(); err == nil {
		t.Fatal("expected an error without a config ref, got nil")
	} else if !strings.Contains(err.Error(), "config not initialized") {
		t.Errorf("error = %v, want the config-not-initialized message", err)
	}
}

// TestGenerateWebAccessCertificate_IsolatedHome: generation writes the fixed
// app-owned pair under the agent dir (an isolated HOME — never the real
// one), persists the pair's paths without ever flipping tls.enabled, and the
// pair classifies as ok for the pinned bind.
func TestGenerateWebAccessCertificate_IsolatedHome(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	t.Setenv("USERPROFILE", fakeHome) // os.UserHomeDir on Windows
	agentDir := config.AgentDir()
	if agentDir != filepath.Join(fakeHome, config.DefaultAgentDir) {
		t.Fatalf("AgentDir = %q, want under the isolated HOME %q", agentDir, fakeHome)
	}
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatalf("mkdir agent dir: %v", err)
	}

	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: false\n")
	a := newWebAccessTestApp(t, cfg, path)

	if err := a.GenerateWebAccessCertificate(); err != nil {
		t.Fatalf("GenerateWebAccessCertificate: %v", err)
	}
	certPath := config.WebAccessCertPath(agentDir)
	keyPath := config.WebAccessKeyPath(agentDir)
	for _, p := range []string{certPath, keyPath} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("expected the generated pair at %s: %v", p, err)
		}
	}
	if runtime.GOOS != "windows" {
		keyStat, err := os.Stat(keyPath)
		if err != nil {
			t.Fatalf("stat key: %v", err)
		}
		if keyStat.Mode().Perm() != 0o600 {
			t.Errorf("key mode = %v, want 0600", keyStat.Mode().Perm())
		}
		certStat, err := os.Stat(certPath)
		if err != nil {
			t.Fatalf("stat cert: %v", err)
		}
		if certStat.Mode().Perm() != 0o644 {
			t.Errorf("cert mode = %v, want 0644", certStat.Mode().Perm())
		}
	}

	reloaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if reloaded.WebAccess.TLS.Enabled {
		t.Error("generation flipped tls.enabled on (it must never, ADR-092 decision 3)")
	}
	if reloaded.WebAccess.TLS.Cert != certPath || reloaded.WebAccess.TLS.Key != keyPath {
		t.Errorf("disk TLS paths = (%q, %q), want the standard pair (%q, %q)",
			reloaded.WebAccess.TLS.Cert, reloaded.WebAccess.TLS.Key, certPath, keyPath)
	}
	info := a.GetWebAccessInfo()
	if info.CertStatus != webAccessCertStatusOK || info.CertDetail != "" {
		t.Errorf("info.CertStatus = %q (%q), want ok for the freshly generated pair on the default bind", info.CertStatus, info.CertDetail)
	}
	if info.TLSEnabled {
		t.Error("info reports TLS enabled although generation never flips the switch")
	}
}

// TestGenerateWebAccessCertificate_RestartsLiveSidecarOntoFreshPair: with TLS
// already serving the standard pair, regeneration replaces the key material
// on disk and hot-restarts the sidecar so the NEW certificate is what a
// browser is served — even though the persisted paths did not change.
func TestGenerateWebAccessCertificate_RestartsLiveSidecarOntoFreshPair(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	t.Setenv("USERPROFILE", fakeHome)
	agentDir := config.AgentDir()
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatalf("mkdir agent dir: %v", err)
	}

	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: true\n")
	a := newWebAccessTestApp(t, cfg, path)
	a.initWebAccess(cfg, a.log())

	// First generation persists the standard paths; the toggle turns TLS on
	// with them (the derived key resolves to the standard key path).
	if err := a.GenerateWebAccessCertificate(); err != nil {
		t.Fatalf("first GenerateWebAccessCertificate: %v", err)
	}
	certPath := config.WebAccessCertPath(agentDir)
	if err := a.SetWebAccessTLS(true, certPath, ""); err != nil {
		t.Fatalf("SetWebAccessTLS(true): %v", err)
	}
	before := a.webAccess.Load()
	if before == nil || !before.TLSEnabled() {
		t.Fatal("sidecar is not serving TLS after the toggle")
	}
	firstLeaf := dialWebAccessTLSLeaf(t, mustSidecarAddr(t, a), tlsRootPool(t, certPath))

	// Regeneration: fresh key material, same persisted paths, live restart.
	if err := a.GenerateWebAccessCertificate(); err != nil {
		t.Fatalf("second GenerateWebAccessCertificate: %v", err)
	}
	after := a.webAccess.Load()
	if after == nil || after == before {
		t.Fatal("regeneration did not rebuild the live sidecar")
	}
	if !after.TLSEnabled() {
		t.Fatal("sidecar lost TLS after regeneration")
	}
	secondLeaf := dialWebAccessTLSLeaf(t, mustSidecarAddr(t, a), tlsRootPool(t, certPath))
	if firstLeaf.SerialNumber.Cmp(secondLeaf.SerialNumber) == 0 {
		t.Error("the sidecar still serves the previous certificate (same serial) after regeneration")
	}
	reloaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if !reloaded.WebAccess.TLS.Enabled {
		t.Error("regeneration flipped tls.enabled off")
	}
}

// TestGetWebAccessInfo_CertStatusMatrix pins the classification vocabulary
// (ADR-092 decision 5): empty when unconfigured, ok when the pair covers the
// pinned bind, mismatch after a bind change (the canonical trigger),
// unreadable for an unloadable pair, expired past NotAfter or not yet valid
// before NotBefore (the same clock-derived bucket) — and the
// wildcard-bind rewrite is shared with the URL renderer, so a pair covering
// localhost stays ok under 0.0.0.0.
func TestGetWebAccessInfo_CertStatusMatrix(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writeGeneratedPair(t, dir, "std.crt", "std.key")
	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: false\n")
	a := newWebAccessTestApp(t, cfg, path)

	status := func() (string, string) {
		t.Helper()
		info := a.GetWebAccessInfo()
		return info.CertStatus, info.CertDetail
	}

	if st, detail := status(); st != "" || detail != "" {
		t.Fatalf("unconfigured status = %q (%q), want empty", st, detail)
	}

	if err := a.SetWebAccessTLS(true, certPath, keyPath); err != nil {
		t.Fatalf("configure pair: %v", err)
	}
	if st, detail := status(); st != webAccessCertStatusOK || detail != "" {
		t.Fatalf("status with the covering pair = %q (%q), want ok with no detail", st, detail)
	}

	// Bind change → mismatch: the cert still covers the loopback set, the
	// pinned bind is now a LAN IP no SAN names.
	if err := a.SetWebAccessConnection("192.0.2.1", 0); err != nil {
		t.Fatalf("change bind: %v", err)
	}
	st, detail := status()
	if st != webAccessCertStatusMismatch {
		t.Fatalf("status after the bind change = %q (%q), want mismatch", st, detail)
	}
	if !strings.Contains(detail, "192.0.2.1") {
		t.Errorf("mismatch detail = %q, want it to name the uncovered host", detail)
	}

	// A wildcard bind rewrites to localhost (the URL renderer's rule), which
	// the loopback SAN set covers — ok again.
	if err := a.SetWebAccessConnection("0.0.0.0", 0); err != nil {
		t.Fatalf("wildcard bind: %v", err)
	}
	if st, detail := status(); st != webAccessCertStatusOK {
		t.Fatalf("status under the wildcard bind = %q (%q), want ok (localhost is covered)", st, detail)
	}

	// Unloadable pair → unreadable, with the load failure named.
	if err := a.SetWebAccessTLS(true, filepath.Join(dir, "absent.crt"), filepath.Join(dir, "absent.key")); err != nil {
		t.Fatalf("configure missing pair: %v", err)
	}
	st, detail = status()
	if st != webAccessCertStatusUnreadable || detail == "" {
		t.Fatalf("status with a missing pair = %q (%q), want unreadable with a detail", st, detail)
	}

	// Expired pair → expired, with the expiry date named.
	expCert, expKey := writeTLSPairFiles(t, dir, "old.crt", "old.key",
		time.Now().Add(-49*time.Hour), time.Now().Add(-24*time.Hour), "127.0.0.1")
	if err := a.SetWebAccessTLS(true, expCert, expKey); err != nil {
		t.Fatalf("configure expired pair: %v", err)
	}
	st, detail = status()
	if st != webAccessCertStatusExpired || detail == "" {
		t.Fatalf("status with the expired pair = %q (%q), want expired with a detail", st, detail)
	}

	// Not-yet-valid pair → the same clock-derived expired bucket, with the
	// validity start named (the vocabulary has no separate not-yet-valid
	// status; the detail tells the two cases apart).
	futureCert, futureKey := writeTLSPairFiles(t, dir, "future.crt", "future.key",
		time.Now().Add(24*time.Hour), time.Now().Add(48*time.Hour), "127.0.0.1")
	if err := a.SetWebAccessTLS(true, futureCert, futureKey); err != nil {
		t.Fatalf("configure not-yet-valid pair: %v", err)
	}
	st, detail = status()
	if st != webAccessCertStatusExpired || detail == "" {
		t.Fatalf("status with the not-yet-valid pair = %q (%q), want expired with a detail", st, detail)
	}
	if !strings.Contains(detail, "not valid until") {
		t.Errorf("not-yet-valid detail = %q, want it to name the validity start", detail)
	}
}

// TestWebAccessCertCoversHost pins the SAN coverage rule (RFC 6125): an IP
// host matches only IP SANs, a name host only DNS SANs, compared
// case-insensitively.
func TestWebAccessCertCoversHost(t *testing.T) {
	leaf := &x509.Certificate{
		DNSNames:    []string{"localhost", "MyHost.Example"},
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1), net.ParseIP("::1")},
	}
	cases := []struct {
		host string
		want bool
	}{
		{"localhost", true},
		{"LOCALHOST", true},
		{"127.0.0.1", true},
		{"::1", true},
		{"myhost.example", true},
		{"192.0.2.1", false},
		{"other.example", false},
		// net.IP.Equal — and browser verification with it — treats the
		// IPv4-mapped form as the same address as its 4-byte form: covered.
		{"::ffff:127.0.0.1", true},
	}
	for _, tc := range cases {
		if got := webAccessCertCoversHost(leaf, tc.host); got != tc.want {
			t.Errorf("webAccessCertCoversHost(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}

// mustSidecarAddr returns the running sidecar's resolved address.
func mustSidecarAddr(t *testing.T, a *App) string {
	t.Helper()
	srv := a.webAccess.Load()
	if srv == nil {
		t.Fatal("sidecar is not running")
	}
	addr, ok := srv.Addr()
	if !ok {
		t.Fatal("running sidecar has no resolved address")
	}
	return addr
}
