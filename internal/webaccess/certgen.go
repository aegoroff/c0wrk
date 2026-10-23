// SPDX-License-Identifier: Apache-2.0
//
// certgen.go — self-signed certificate generation for the web-access sidecar
// (ADR-092): the Generate control writes the fixed app-owned PEM pair, a
// leaf certificate scoped to the currently pinned bind address.
//
// The file is deliberately STDLIB-ONLY (crypto/x509, crypto/ecdsa,
// encoding/pem, os) — the same isolation rule the package's import-hygiene
// test enforces for the whole sidecar core.
//
// Security posture (ADR-092 decision 3):
//   - ECDSA P-256 key, self-signed leaf: KeyUsage DigitalSignature,
//     ExtKeyUsage ServerAuth, BasicConstraintsValid with IsCA=false, a fresh
//     crypto/rand 128-bit serial per generation.
//   - 825-day validity — the longest leaf validity mainstream browsers still
//     honor. A long-lived install can silently cross the expiry; the desktop
//     surface computes cert_status=expired and regeneration is the fix.
//   - SANs cover the pinned bind (certSANs): {localhost, 127.0.0.1, ::1}
//     always, plus the bind's browser-facing host — a wildcard bind names
//     localhost, a specific IP names itself.
//   - Atomic publication: both files are fully staged in the target
//     directory (fsync'd, exact fchmod — the published mode survives any
//     ambient umask) and renamed into place; the private key is published
//     0600, the certificate 0644. A crash between the two renames can pair
//     a new key with the previous certificate — the mount refuses such a
//     pair fail-closed (ADR-092 decision 2) and regeneration is the fix;
//     a plaintext fallback never is.

package webaccess

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// webAccessCertValidity is the generated leaf's validity window (ADR-092
// decision 3): 825 days.
const webAccessCertValidity = 825 * 24 * time.Hour

// GenerateWebAccessCertificate generates the app-owned self-signed pair for
// bind and publishes it atomically: the certificate at certPath (0644) and
// the matching ECDSA P-256 key at keyPath (0600). bind must be a valid
// sidecar bind (config.IsValidWebAccessBind): the certificate's SANs are
// derived from it (certSANs), so the browser-facing host of the CURRENT bind
// is always covered — regenerating after a bind change is the documented
// mismatch fix (ADR-092 decision 5).
//
// The function never reads pre-existing files (a pure overwrite of the
// standard pair it owns) and never creates parent directories — callers pass
// the fixed app-owned locations (config.WebAccessCertPath /
// config.WebAccessKeyPath under the agent dir), which exist by the time the
// desktop surface can be clicked. It never flips web_access.tls.enabled and
// never touches operator-authored paths; the persistence of the pair's paths
// into the config section and the sidecar hot-restart are the desktop
// layer's side of the Generate control (ADR-092 decision 3).
func GenerateWebAccessCertificate(bind, certPath, keyPath string) error {
	if certPath == "" || keyPath == "" {
		return errors.New("webaccess: tls: certificate and key paths are required")
	}
	tmpl, err := certTemplate(bind)
	if err != nil {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("webaccess: tls: generating key: %w", err)
	}
	// Self-signed: the leaf is its own issuer.
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("webaccess: tls: creating certificate: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return fmt.Errorf("webaccess: tls: marshaling key: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	// Stage both files completely, then publish — the key first, so a crash
	// mid-publication leaves a NEW key with the OLD certificate: a mismatch
	// the sidecar refuses fail-closed (ADR-092 decision 2), never a listener
	// serving a certificate whose key nobody holds anymore.
	if err := writeFileAtomic(keyPath, keyPEM, 0o600); err != nil {
		return err
	}
	if err := writeFileAtomic(certPath, certPEM, 0o644); err != nil {
		return err
	}
	// Both renames are in: fsync the directory entry too, so a power loss
	// cannot revert the renames or land the mixed state. Best-effort — the
	// pair is already published and readable, a sync failure here only
	// narrows the crash-durability window the staged-file syncs closed.
	if d, derr := os.Open(filepath.Dir(certPath)); derr == nil {
		_ = d.Sync() //nolint:errcheck // best-effort durability
		_ = d.Close()
	}
	return nil
}

// certSANs maps a validated sidecar bind to the certificate's SAN set — the
// four bind classes (ADR-092 decision 3):
//
//  1. the "localhost" name         → the loopback set;
//  2. a loopback IP literal        → the loopback set;
//  3. a wildcard bind (0.0.0.0/::) → the loopback set (the browser-facing
//     host of a wildcard bind is localhost on this machine);
//  4. a specific non-loopback IP   → the loopback set PLUS the bind itself,
//     the host the browser actually opens.
//
// The loopback set {localhost, 127.0.0.1, ::1} is always present so the
// default loopback bind keeps working and any bind stays reachable as
// localhost from the machine itself.
func certSANs(bind string) (dnsNames []string, ips []net.IP, err error) {
	dnsNames = []string{"localhost"}
	// Cap 3: the loopback pair, plus the bind itself for the specific-IP class.
	ips = make([]net.IP, 0, 3)
	ips = append(ips, net.IPv4(127, 0, 0, 1), net.ParseIP("::1"))
	if bind == "localhost" {
		return dnsNames, ips, nil
	}
	ip := net.ParseIP(bind)
	if ip == nil {
		return nil, nil, fmt.Errorf("webaccess: tls: bind %q is not a valid IP literal or \"localhost\"", bind)
	}
	if ip.IsLoopback() || ip.IsUnspecified() {
		return dnsNames, ips, nil
	}
	// Specific non-loopback bind: normalize IPv4-mapped forms to their 4-byte
	// representation so the SAN carries the canonical encoding browsers and
	// verifiers compare against.
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	return dnsNames, append(ips, ip), nil
}

// certTemplate builds the certificate body: SANs from the bind, a fresh
// serial, the fixed 825-day window, and the leaf-only usage set.
func certTemplate(bind string) (*x509.Certificate, error) {
	dnsNames, ips, err := certSANs(bind)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("webaccess: tls: generating serial: %w", err)
	}
	// Backdate one hour for clock skew between this machine and wherever the
	// pair is consumed; the tolerance costs nothing and spares the operator
	// an acausal-certificate browser error.
	notBefore := time.Now().Add(-time.Hour)
	return &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{Organization: []string{"c0wrk"}, CommonName: "c0wrk web access"},
		NotBefore:             notBefore,
		NotAfter:              notBefore.Add(webAccessCertValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
		DNSNames:              dnsNames,
		IPAddresses:           ips,
	}, nil
}

// writeFileAtomic stages data into path's directory (fsync, exact fchmod —
// the published mode survives any ambient umask) and renames it into place.
// On any failure the staging file is removed and the target is untouched.
func writeFileAtomic(path string, data []byte, mode os.FileMode) (err error) {
	dir, base := filepath.Dir(path), filepath.Base(path)
	tmp, err := os.CreateTemp(dir, "."+base+".tmp-")
	if err != nil {
		return fmt.Errorf("webaccess: tls: staging %s: %w", base, err)
	}
	tmpName := tmp.Name()
	defer func() {
		if err != nil {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err = tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("webaccess: tls: writing %s: %w", base, err)
	}
	if err = tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("webaccess: tls: syncing %s: %w", base, err)
	}
	// Exact published mode: Chmod is not umask-filtered, unlike the staging
	// create; the rename below publishes this entry verbatim.
	if err = tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("webaccess: tls: chmod %s: %w", base, err)
	}
	if err = tmp.Close(); err != nil {
		return fmt.Errorf("webaccess: tls: closing %s: %w", base, err)
	}
	if err = os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("webaccess: tls: publishing %s: %w", base, err)
	}
	return nil
}
