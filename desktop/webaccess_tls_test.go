// SPDX-License-Identifier: Apache-2.0
//
// webaccess_tls_test.go — the TLS surface of the web-access control RPCs
// (ADR-099): SetWebAccessTLS toggles the web_access.tls subsection with the
// section's persist + hot-restart + rollback discipline (an unloadable pair
// fails closed and never leaves the sidecar down), GenerateWebAccessCertificate
// writes the fixed app-owned pair for the pinned bind into an isolated agent
// dir and persists its paths, and GetWebAccessInfo classifies the configured
// certificate against the pinned bind (ok/mismatch/unreadable/expired).

package desktop

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend"
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

// TestSetWebAccessEnabled_BrokenTLSPairRefused: ADR-099's interactive gate
// on the enable flip — turning the section on while its TLS subsection
// points at an unloadable pair is refused before anything is mutated or
// persisted, so the toggle never produces a persisted-on switch above a
// silently-down sidecar and never downgrades the requested TLS to plain
// HTTP.
func TestSetWebAccessEnabled_BrokenTLSPairRefused(t *testing.T) {
	dir := t.TempDir()
	absentCert := filepath.Join(dir, "absent.crt")
	absentKey := filepath.Join(dir, "absent.key")
	doc := fmt.Sprintf("web_access:\n  enabled: false\n  tls:\n    enabled: true\n    cert: %q\n    key: %q\n", absentCert, absentKey)
	cfg, path := writeWebAccessConfig(t, doc)
	a := newWebAccessTestApp(t, cfg, path)

	err := a.SetWebAccessEnabled(true)
	if err == nil {
		t.Fatal("SetWebAccessEnabled onto an unloadable pair: expected an error")
	}
	if !strings.Contains(err.Error(), "certificate pair failed to load") {
		t.Errorf("error must name the load failure, got %q", err.Error())
	}
	if cfg.WebAccess.Enabled {
		t.Errorf("in-memory section must stay disabled, got %+v", cfg.WebAccess)
	}
	if !cfg.WebAccess.TLS.Enabled || cfg.WebAccess.TLS.Cert != absentCert || cfg.WebAccess.TLS.Key != absentKey {
		t.Errorf("in-memory subsection must be preserved as authored, got %+v", cfg.WebAccess.TLS)
	}
	if srv := a.webAccess.Load(); srv != nil {
		t.Errorf("the sidecar must stay down, got %+v", srv)
	}
	reloaded, err := config.LoadWithResult(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(reloaded.LoadErrors) != 0 {
		t.Errorf("the persisted config must be untouched (a disabled section is inert), got %v", reloaded.LoadErrors)
	}
	if reloaded.Config.WebAccess.Enabled || !reloaded.Config.WebAccess.TLS.Enabled ||
		reloaded.Config.WebAccess.TLS.Cert != absentCert || reloaded.Config.WebAccess.TLS.Key != absentKey {
		t.Errorf("disk section must equal the authored state, got %+v", reloaded.Config.WebAccess)
	}
}

// TestSetWebAccessEnabled_UsablePairEnables: the preflight must not
// over-block — a flip onto a REAL usable pair persists and mounts the
// sidecar with TLS on.
func TestSetWebAccessEnabled_UsablePairEnables(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writeTLSPairFiles(t, dir, "real.crt", "real.key", time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour), "127.0.0.1")
	doc := fmt.Sprintf("web_access:\n  enabled: false\n  tls:\n    enabled: true\n    cert: %q\n    key: %q\n", certPath, keyPath)
	cfg, path := writeWebAccessConfig(t, doc)
	a := newWebAccessTestApp(t, cfg, path)

	if err := a.SetWebAccessEnabled(true); err != nil {
		t.Fatalf("SetWebAccessEnabled onto a usable pair: %v", err)
	}
	srv := a.webAccess.Load()
	if srv == nil {
		t.Fatal("the sidecar must be up after the flip")
	}
	if !srv.TLSEnabled() {
		t.Error("the sidecar must serve TLS")
	}
	if !cfg.WebAccess.Enabled {
		t.Errorf("the in-memory section must be enabled, got %+v", cfg.WebAccess)
	}
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
// the running sidecar onto HTTPS with the authored pair persisted; the
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

	// ── Enable: the explicit pair, live HTTPS restart ──
	if err := a.SetWebAccessTLS(true, certPath, keyPath); err != nil {
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
		t.Errorf("disk TLS subsection = %+v, want enabled with the authored pair (%q, %q)",
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

// TestSetWebAccessTLS_UnreadablePairRejected: a commit onto a pair that
// cannot be loaded is refused BEFORE anything persists — the config on disk
// is untouched and a running sidecar is never rebuilt (the pair-load
// validation runs ahead of the persist and the restart, so the old
// rollback-on-restart path is not even reached). The mount-time fail-closed
// check stays as the backstop for hand-edited configs (ADR-099 decision 2).
func TestSetWebAccessTLS_UnreadablePairRejected(t *testing.T) {
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
		} else if !strings.Contains(err.Error(), "unreadable") {
			t.Errorf("SetWebAccessTLS with a %s pair: error = %v, want the unreadable-pair message", name, err)
		}
		// The refusal happens before any restart: the same sidecar instance
		// keeps serving plain HTTP on the state it started with.
		if got := a.webAccess.Load(); got != before {
			t.Errorf("%s pair: the sidecar was rebuilt on a refused commit", name)
		}
		addr, ok := before.Addr()
		if !ok || !plainHTTPReachable(t, addr) {
			t.Errorf("%s pair: sidecar is not serving plain HTTP", name)
		}
		reloaded, err := config.Load(path)
		if err != nil {
			t.Fatalf("reload config: %v", err)
		}
		if reloaded.WebAccess.TLS != (config.WebAccessTLSConfig{}) {
			t.Errorf("%s pair: disk TLS subsection after the refusal = %+v, want the zero subsection", name, reloaded.WebAccess.TLS)
		}
	}
}

// TestSetWebAccessTLS_MismatchPairRejected: a commit whose key does not
// match its certificate is refused with the mismatch message before
// anything persists — the config on disk keeps the previous pair and the
// TLS-serving sidecar keeps serving its certificate.
func TestSetWebAccessTLS_MismatchPairRejected(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writeGeneratedPair(t, dir, "std.crt", "std.key")
	_, otherKeyPath := writeGeneratedPair(t, dir, "other.crt", "other.key")
	cfg, path := writeWebAccessConfig(t, "web_access:\n  enabled: true\n  token: keep-me\n")
	a := newWebAccessTestApp(t, cfg, path)
	a.initWebAccess(cfg, a.log())
	if err := a.SetWebAccessTLS(true, certPath, keyPath); err != nil {
		t.Fatalf("configure the standard pair: %v", err)
	}
	serving := a.webAccess.Load()
	if serving == nil || !serving.TLSEnabled() {
		t.Fatal("sidecar is not serving TLS on the standard pair")
	}
	served := dialWebAccessTLSLeaf(t, mustSidecarAddr(t, a), tlsRootPool(t, certPath))

	// Valid cert + a foreign (valid, but different) key: the pair loads as
	// files but the key does not match the certificate — refused as a
	// mismatch, before the no-op check or any persist.
	if err := a.SetWebAccessTLS(true, certPath, otherKeyPath); err == nil {
		t.Fatal("committing a mismatched pair: expected an error")
	} else if !strings.Contains(err.Error(), "does not match") {
		t.Errorf("error = %v, want the key-does-not-match-certificate message", err)
	}
	if got := a.webAccess.Load(); got != serving {
		t.Error("the sidecar was rebuilt on a refused commit")
	}
	if again := dialWebAccessTLSLeaf(t, mustSidecarAddr(t, a), tlsRootPool(t, certPath)); again.SerialNumber.Cmp(served.SerialNumber) != 0 {
		t.Error("the sidecar is no longer serving the previous certificate")
	}
	reloaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if !reloaded.WebAccess.TLS.Enabled || reloaded.WebAccess.TLS.Cert != certPath || reloaded.WebAccess.TLS.Key != keyPath {
		t.Errorf("disk TLS subsection after the refusal = %+v, want the previous pair untouched", reloaded.WebAccess.TLS)
	}
}

// TestSetWebAccessTLS_ValidationNoopAndGuards: the structural rule runs
// through config.ValidateWebAccessTLS (enabled ⇒ non-empty cert AND key —
// the key path is never derived from the cert path), a non-empty pair is
// loaded (tls.LoadX509KeyPair) ahead of the structural rule and the no-op
// check, a matching readable request is a no-op that does not rewrite the
// file, and the RPC shares the other control RPCs' config-ref guard.
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

	// Enabled with a cert but no key: the shared structural key message —
	// no derivation happens at the RPC, both paths must be authored.
	if err := a.SetWebAccessTLS(true, certPath, ""); err == nil {
		t.Fatal("expected the structural error for an enabled subsection without a key")
	} else if !strings.Contains(err.Error(), "tls.key is required") {
		t.Errorf("error = %v, want the shared tls.key message", err)
	}
	reloaded, err = config.Load(path)
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

	// The pair-load validation runs ahead of the no-op check: once the
	// stored pair's key file disappears, re-committing the identical
	// subsection is refused (unreadable) instead of silently no-oping —
	// and the file is still not rewritten.
	if err := os.Remove(keyPath); err != nil {
		t.Fatalf("remove key: %v", err)
	}
	if err := a.SetWebAccessTLS(true, certPath, keyPath); err == nil {
		t.Fatal("re-committing the stored subsection with a deleted key: expected an error")
	} else if !strings.Contains(err.Error(), "unreadable") {
		t.Errorf("error = %v, want the unreadable-pair message", err)
	}
	stat3, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat config after the refused no-op: %v", err)
	}
	if !stat.ModTime().Equal(stat3.ModTime()) {
		t.Error("a refused no-op rewrote the config file")
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
		t.Error("generation flipped tls.enabled on (it must never, ADR-099 decision 3)")
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
	// with them.
	if err := a.GenerateWebAccessCertificate(); err != nil {
		t.Fatalf("first GenerateWebAccessCertificate: %v", err)
	}
	certPath := config.WebAccessCertPath(agentDir)
	keyPath := config.WebAccessKeyPath(agentDir)
	if err := a.SetWebAccessTLS(true, certPath, keyPath); err != nil {
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
// (ADR-099 decision 5): empty when unconfigured, ok when the pair covers the
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

	// Unloadable pair → unreadable, with the load failure named. Seeded
	// straight into the live config: SetWebAccessTLS refuses an unloadable
	// pair before it can persist — the classification still has to name the
	// state for hand-edited configs that carry it.
	ref, _ := a.configRef()
	ref.WebAccess.TLS = config.WebAccessTLSConfig{
		Enabled: true,
		Cert:    filepath.Join(dir, "absent.crt"),
		Key:     filepath.Join(dir, "absent.key"),
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
// case-insensitively, with the §6.4.3 wildcard form (a "*" left-most label
// covers exactly one label).
func TestWebAccessCertCoversHost(t *testing.T) {
	leaf := &x509.Certificate{
		DNSNames:    []string{"localhost", "MyHost.Example", "*.example.com"},
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
		// RFC 6125 §6.4.3 wildcard: a single "*" left-most label covers
		// exactly one label.
		{"app.example.com", true},
		{"APP.EXAMPLE.COM", true},
		{"example.com", false},
		{"a.b.example.com", false},
		{"example.com.", false},
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

// TestWebAccessControlRPCsRefreshConfigLoadWarnings pins the ADR-099 wire
// end-to-end: the transport-affecting control RPCs keep the UI's
// config-load-warning channel (GetConfig().config_errors → the Settings
// "Configuration warning" banner) in step with the live section — an
// HTTP→HTTPS flip drops the plain-HTTP exposure warning, the reverse flip
// and a re-bind onto a LAN address bring it back, a loopback re-bind and the
// disable drop it, and an unrelated section's load warning survives every
// transition untouched. The sidecar itself stays unmounted (persist-only
// transitions: no restart path has a running listener to rebuild), so the
// test never binds a socket.
func TestWebAccessControlRPCsRefreshConfigLoadWarnings(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "pair.crt")
	keyPath := filepath.Join(dir, "pair.key")
	if err := webaccess.GenerateWebAccessCertificate("192.168.23.2", certPath, keyPath); err != nil {
		t.Fatalf("generate the app-owned pair: %v", err)
	}
	cfg, path := writeWebAccessConfig(t, fmt.Sprintf(`
web_access:
  enabled: true
  bind: 192.168.23.2
  tls:
    enabled: false
    cert: %q
    key: %q
`, certPath, keyPath))

	exposure := config.WebAccessLoadWarnings(config.WebAccessConfig{Enabled: true, Bind: "192.168.23.2"})[0]
	unrelated := "autonomy: legacy smart_approve folded into silent_mode"

	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	// A standalone (nil-app) FrontendAPI so the channel is observable through
	// GetConfig; the swap happens before any goroutine, so the published-once
	// seed invariant is not at play.
	fapi := backend.NewFrontendAPI(backend.FrontendAPIConfig{Config: cfg, Logger: quiet})
	a := NewApp()
	a.FrontendAPI = fapi
	a.logger = quiet
	a.setConfigRef(cfg, path)
	t.Cleanup(func() { a.stopWebAccess(context.Background()) })

	// A plain-HTTP launch hands the exposure warning to the channel.
	fapi.Lifecycle().SetConfigLoadState([]string{exposure, unrelated})
	assertChannel := func(phase string, want ...string) {
		t.Helper()
		if got := fapi.GetConfig().ConfigErrors; !reflect.DeepEqual(got, want) {
			t.Errorf("%s: ConfigErrors = %v, want %v", phase, got, want)
		}
	}
	assertChannel("seeded", exposure, unrelated)

	if err := a.SetWebAccessTLS(true, certPath, keyPath); err != nil {
		t.Fatalf("SetWebAccessTLS(on): %v", err)
	}
	assertChannel("after TLS on", unrelated)

	if err := a.SetWebAccessTLS(false, certPath, keyPath); err != nil {
		t.Fatalf("SetWebAccessTLS(off): %v", err)
	}
	assertChannel("after TLS off", unrelated, exposure)

	if err := a.SetWebAccessConnection("127.0.0.1", 0); err != nil {
		t.Fatalf("SetWebAccessConnection(loopback): %v", err)
	}
	assertChannel("after re-bind to loopback", unrelated)

	if err := a.SetWebAccessConnection("192.168.23.2", 0); err != nil {
		t.Fatalf("SetWebAccessConnection(LAN): %v", err)
	}
	assertChannel("after re-bind to LAN", unrelated, exposure)

	if err := a.SetWebAccessEnabled(false); err != nil {
		t.Fatalf("SetWebAccessEnabled(false): %v", err)
	}
	assertChannel("after disable", unrelated)
}
