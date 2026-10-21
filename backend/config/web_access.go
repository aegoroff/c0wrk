// SPDX-License-Identifier: Apache-2.0
//
// web_access.go — the `web_access` config section: the operator switch for the
// browser web-access sidecar (specs/decisions/090-browser-web-access.md), an
// HTTP/WebSocket server that mirrors the desktop UI into a browser window.
//
// Design contract (ADR-090, stage 2):
//   - The section is pure data: it knows nothing about the webaccess sidecar
//     package (backend/config never imports application layers). The sidecar
//     reads the resolved section at start.
//   - Default OFF: an absent section — or `enabled: false` — starts nothing
//     and the app behaves exactly as before the section existed.
//   - Externally gated (compound with the experimental master switch): the
//     section is pure data and starts nothing by itself — the sidecar mounts
//     only while config.Experimental.Enabled is ALSO on, and the desktop
//     layer follows a mid-session flip of either switch live (mount on
//     open, bounded stop on close). web_access.enabled=true under a closed
//     experimental gate simply stays unmounted.
//   - Bind validity (stage 2): while enabled, bind must be a VALID address —
//     an IP literal (loopback, the unspecified "0.0.0.0"/"::", or a specific
//     IPv4/IPv6 address) or the "localhost" name. The stage-1 loopback-only
//     rule survives as a WARNING classification (IsLoopbackBind), not as
//     validity: a valid non-loopback bind is a deliberate LAN-exposed
//     listener that loads with a visible warning and persists as-is.
//   - Load-time VALIDITY problems are FAIL-SOFT (the shell_exec precedent):
//     an invalid section (unparseable bind, out-of-range port) produces a
//     visible load warning and is reset to the safe default state (disabled,
//     loopback bind, auto port, empty token). A broken section must never
//     keep the app from starting — and must never silently leave an unsafe
//     listener configured either.
//   - Save-time VALIDITY problems are FAIL-CLOSED: Save refuses to persist an
//     enabled section with an invalid bind or an out-of-range port. A valid
//     non-loopback bind is saved as-is — the operator's explicit stage-2
//     choice. The load path heals invalid states before they can ever be
//     re-saved, so hitting the save error means an in-memory mutation tried
//     to persist a section the sidecar must never run with.
//   - Port 0 (the zero value) means AUTO: the sidecar picks a free port at
//     start. An empty token means GENERATED: the desktop layer mints a fresh
//     crypto/rand token at the first start and persists it back here through
//     the same config save every other setting uses — the credential is
//     stable across restarts from then on (ADR-090, decision 10).
//   - TLS (ADR-092): the `web_access.tls` subsection is the explicit HTTPS
//     switch — the protocol is never parsed out of the address field. The
//     same validity layering applies one level down: a structurally invalid
//     subsection (tls enabled with an empty cert or key path) is FAIL-SOFT
//     at load — it resets ALONE (the sidecar stays on plain HTTP) with a
//     visible warning — and FAIL-CLOSED at save. A configured-but-unreadable
//     pair is deliberately NOT this layer's concern: it fails closed at
//     sidecar mount, where silently downgrading an operator-configured
//     encryption to plaintext is never an outcome.

package config

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// DefaultWebAccessBind is the seeded bind address: loopback IPv4. Seeding the
// value keeps the persisted shape explicit even for an operator who only
// flips `enabled` on. Stage 2 widens the accepted bind class to any valid
// address, but the safe default remains loopback-only.
const DefaultWebAccessBind = "127.0.0.1"

// WebAccessConfig is the top-level `web_access:` section.
type WebAccessConfig struct {
	// Enabled turns the browser web-access sidecar on. Default false: no
	// listener is created. An absent section is this zero value — off.
	Enabled bool `yaml:"enabled"`
	// Bind is the interface the sidecar listens on. Valid values (stage 2):
	// any IP literal — loopback, the unspecified "0.0.0.0"/"::", or a
	// specific IPv4/IPv6 address — or the "localhost" name. A valid
	// non-loopback bind is a LAN-exposed listener: warned about at load,
	// persisted as-is at save. Invalid values (unparseable; empty while
	// enabled) are fail-soft at load (warning + reset to the default state)
	// and refused at save.
	Bind string `yaml:"bind"`
	// Port is the TCP port the sidecar listens on. 0 (the default) = auto:
	// a free port is picked at sidecar start. Out-of-range values (negative
	// or above 65535) are fail-soft at load and refused at save.
	Port int `yaml:"port"`
	// Token is the credential the sidecar authenticates browser requests
	// with. Empty (the default) = GENERATED: the first start mints a fresh
	// crypto/rand token and persists it back into config.yaml, so the
	// credential is stable across restarts (ADR-090, decision 10). A
	// hand-edited static value is honored and warned when shorter than 16
	// characters; the Settings surface writes it through desktop's
	// SetWebAccessToken (an operator-typed value, bounds-checked by
	// ValidateWebAccessToken) and rotates it through
	// RegenerateWebAccessToken — both serialize on desktop's webAccessMu.
	Token string `yaml:"token"`
	// TLS is the `tls:` subsection (ADR-092): the HTTPS transport switch for
	// the sidecar. Validated only while the sidecar itself is enabled — a
	// disabled web_access section is inert, subsection included (the same
	// doctrine as the bind/port fields). See WebAccessTLSConfig.
	TLS WebAccessTLSConfig `yaml:"tls"`
}

// WebAccessTLSConfig is the `web_access.tls:` subsection (ADR-092): the
// operator switch for serving the sidecar over HTTPS with a PEM
// certificate/key pair instead of plaintext HTTP.
type WebAccessTLSConfig struct {
	// Enabled serves the sidecar over HTTPS. Default false: plain HTTP,
	// byte-identical to pre-ADR-092 behavior (the session cookie keeps its
	// plain-HTTP shape; TLS turns `Secure` on and nothing else). Structural
	// validity (decision 2): enabled with an EMPTY cert or key path is
	// INVALID — fail-soft at load (this subsection resets alone with a
	// warning) and fail-closed at save. A non-empty but unreadable pair is
	// NOT this layer's concern: the config layer never reads the files —
	// that pair fails closed at sidecar mount.
	Enabled bool `yaml:"enabled"`
	// Cert is the path to the PEM-encoded TLS certificate (full chain when
	// the operator has one). The standard app-owned pair lives at
	// WebAccessCertPath (~/.c0wrk/web-access.crt): desktop's certificate
	// generator writes it for the pinned bind and persists the pair's paths
	// back here (minting-is-part-of-configuring, the token precedent).
	// Operator-authored certificates (e.g. certbot's fullchain.pem) are
	// configured by hand-editing this file — the config file stays the
	// escape hatch.
	Cert string `yaml:"cert"`
	// Key is the path to the PEM-encoded TLS private key. The standard pair
	// lives at WebAccessKeyPath (~/.c0wrk/web-access.key). The Settings
	// surface authors only tls.cert and derives this at commit time
	// (decision 4); the persisted config always carries both paths, so an
	// enabled subsection with an empty key is structurally invalid exactly
	// like an empty cert.
	Key string `yaml:"key"`
}

// IsLoopbackBind reports whether bind names a loopback interface: an IP
// literal whose IsLoopback is true (including IPv4-mapped forms such as
// "::ffff:127.0.0.1"), or the exact "localhost" name. Empty, unparseable and
// non-loopback values are all false. Since stage 2 this is a WARNING
// classification over valid binds — not the validity predicate (see
// IsValidWebAccessBind).
func IsLoopbackBind(bind string) bool {
	if bind == "localhost" {
		return true
	}
	ip := net.ParseIP(bind)
	return ip != nil && ip.IsLoopback()
}

// IsValidWebAccessBind reports whether bind is a valid listener address for
// the sidecar (ADR-090, stage 2): any IP literal — loopback, the unspecified
// "0.0.0.0"/"::", or a specific IPv4/IPv6 address, including IPv4-mapped
// forms such as "::ffff:192.168.1.10" — or the exact "localhost" name.
// Empty, other hostnames and unparseable values are false. Loopback
// classification is deliberately NOT part of validity: a valid non-loopback
// bind is a LAN-exposed listener (warning at load, saved as-is), and
// IsLoopbackBind tells it apart.
func IsValidWebAccessBind(bind string) bool {
	if bind == "localhost" {
		return true
	}
	return net.ParseIP(bind) != nil
}

// validateWebAccessBind checks the VALIDITY of the bind address of an enabled
// section (IsValidWebAccessBind) — not its loopback class. An invalid bind is
// fail-soft at load and fail-closed at save; a valid non-loopback bind passes
// both and only draws the network-exposure load warning.
func validateWebAccessBind(bind string) error {
	if IsValidWebAccessBind(bind) {
		return nil
	}
	if bind == "" {
		return errors.New("web_access: bind is required when enabled")
	}
	return fmt.Errorf("web_access: bind %q is not a valid IP literal or \"localhost\" (default %q)", bind, DefaultWebAccessBind)
}

// validateWebAccessPort checks the port of an enabled section: 0 = auto,
// 1–65535 explicit.
func validateWebAccessPort(port int) error {
	if port < 0 || port > 65535 {
		return fmt.Errorf("web_access: port %d is out of range (0 = auto, 1-65535 explicit)", port)
	}
	return nil
}

// ValidateWebAccessPort is the exported form of the section's port rule, for
// callers outside the package that mutate the web_access section at runtime
// (desktop's SetWebAccessConnection) and want the exact same message the
// load/save paths produce: 0 = auto, 1–65535 pinned, anything else rejected.
func ValidateWebAccessPort(port int) error {
	return validateWebAccessPort(port)
}

// ValidateWebAccessBind is the exported form of the section's bind rule — the
// mirror of ValidateWebAccessPort — for callers outside the package that
// mutate the web_access section at runtime (desktop) and want the exact same
// message the load/save paths produce: any IP literal or "localhost" is valid
// (loopback or not — IsLoopbackBind is the warning classification), empty and
// unparseable values are rejected.
func ValidateWebAccessBind(bind string) error {
	return validateWebAccessBind(bind)
}

// validateWebAccessTLS checks the STRUCTURAL validity of the TLS subsection
// (ADR-092, decision 2): an enabled subsection requires both PEM paths to be
// configured. A disabled subsection is inert and accepts anything — the same
// doctrine as the whole section when web_access.enabled is off. An empty path
// on an enabled subsection is fail-soft at load and fail-closed at save; a
// non-empty but unreadable pair passes here — the config layer never reads
// the files — and fails closed at sidecar mount instead.
func validateWebAccessTLS(tls WebAccessTLSConfig) error {
	if !tls.Enabled {
		return nil
	}
	if tls.Cert == "" {
		return errors.New("web_access: tls.cert is required when tls is enabled (generate a pair in Settings → Web Access or point cert/key at PEM files)")
	}
	if tls.Key == "" {
		return errors.New("web_access: tls.key is required when tls is enabled")
	}
	return nil
}

// ValidateWebAccessTLS is the exported form of the subsection's structural
// rule — the mirror of ValidateWebAccessBind/ValidateWebAccessPort — for
// callers outside the package that mutate the tls subsection at runtime
// (desktop's SetWebAccessTLS) and want the exact same message the load/save
// paths produce: an enabled subsection needs both PEM paths, a disabled one
// accepts anything (inert, like the whole section when it is off).
func ValidateWebAccessTLS(tls WebAccessTLSConfig) error {
	return validateWebAccessTLS(tls)
}

// Web access token input bounds (ADR-090): the interactive entry points —
// desktop's SetWebAccessToken and the Settings field that feeds it — refuse a
// credential outside this range. The floor keeps a typed token from being
// trivially guessable; the ceiling is an overflow guard, not a tuning
// opinion. A hand-edited config.yaml is deliberately NOT gated by these
// bounds: the load path keeps honoring any non-empty value (warned when
// shorter than 16 characters at sidecar start), so tightening the rule here
// can never lock an operator out of their own config.
const (
	MinWebAccessTokenLength = 8
	MaxWebAccessTokenLength = 256
)

// ValidateWebAccessToken is the interactive-input rule for the web access
// credential: length within [MinWebAccessTokenLength, MaxWebAccessTokenLength]
// after trimming. Callers outside the package (desktop's SetWebAccessToken)
// enforce the exact same message the Settings field shows. The empty value is
// rejected here too — emptiness means GENERATED and is represented by leaving
// the field alone (the first start mints and persists), never by "saving"
// an empty credential over an existing one.
func ValidateWebAccessToken(token string) error {
	if len(token) < MinWebAccessTokenLength {
		return fmt.Errorf("web_access: token must be at least %d characters (leave it empty to keep the generated one)", MinWebAccessTokenLength)
	}
	if len(token) > MaxWebAccessTokenLength {
		return fmt.Errorf("web_access: token is too long — at most %d characters", MaxWebAccessTokenLength)
	}
	return nil
}

// webAccessLoopbackWarning is the load warning for a valid non-loopback bind:
// the listener becomes reachable beyond the machine. The message describes
// the TLS-off default (plain HTTP, ADR-090); the operator can encrypt the
// transport with web_access.tls (ADR-092), and the classification itself
// stands unchanged either way — a LAN bind stays a deliberate exposure the
// operator is warned about, never refused.
func webAccessLoopbackWarning(bind string) string {
	return fmt.Sprintf("web_access: bind %q is not loopback — the listener is network-accessible, traffic is unencrypted", bind)
}

// defaultWebAccessState is the canonical default section state the fail-soft
// load path resets an invalid section to: disabled, loopback bind, auto port,
// empty token (the credential is minted at the first start). Resetting to
// THIS state (rather than the bare zero value) keeps the persisted shape
// always valid and self-describing — the same doctrine as shell_exec's
// "persisted shape is always valid".
func defaultWebAccessState() WebAccessConfig {
	return WebAccessConfig{
		Enabled: false,
		Bind:    DefaultWebAccessBind,
		Port:    0,
		Token:   "",
		TLS:     WebAccessTLSConfig{},
	}
}

// normalizeWebAccess validates the web_access section in place and returns
// load warnings. VALIDITY problems are FAIL-SOFT: an enabled section with an
// unparseable bind or an out-of-range port is warned about and reset to the
// default state (the sidecar stays off), never fatal — a broken section must
// not keep the app from starting, and must not leave a half-applied unsafe
// listener either. A VALID non-loopback bind is not a validity problem: the
// section stays enabled and draws the network-exposure warning (a stage-2
// LAN listener; IsLoopbackBind classifies it). A disabled section is inert
// and accepts anything, exactly like an inactive shell_exec override.
//
// The tls subsection (ADR-092) is validated one level down with the same
// layering: a structurally invalid subsection (enabled with an empty cert or
// key path) resets ALONE — the subsection zeroes, the sidecar stays enabled
// on plain HTTP — while a valid or disabled subsection is preserved as
// authored. Must run AFTER ApplyDefaults (which seeds the default bind) and
// BEFORE validate, so the persisted shape is always valid.
func normalizeWebAccess(cfg *Config) []string {
	if !cfg.WebAccess.Enabled {
		return nil
	}
	var warnings []string
	var reasons []string
	if err := validateWebAccessBind(cfg.WebAccess.Bind); err != nil {
		reasons = append(reasons, err.Error())
	}
	if err := validateWebAccessPort(cfg.WebAccess.Port); err != nil {
		reasons = append(reasons, err.Error())
	}
	if len(reasons) > 0 {
		warning := "web_access ignored (the sidecar stays disabled; fix bind/port and re-enable): " +
			strings.Join(reasons, "; ")
		cfg.WebAccess = defaultWebAccessState()
		warnings = append(warnings, warning)
	}
	// ADR-092: a structurally invalid tls subsection resets by itself — the
	// sidecar keeps running on plain HTTP instead of losing the whole
	// section to a half-typed subsection. The validator is inert on a
	// disabled subsection, which also covers the whole-section reset above:
	// it zeroes the subsection, so a bad bind never stacks a second tls
	// warning on top.
	if err := validateWebAccessTLS(cfg.WebAccess.TLS); err != nil {
		warning := "web_access.tls ignored (the sidecar stays on plain HTTP; set both tls.cert and tls.key, or turn tls off): " +
			err.Error()
		cfg.WebAccess.TLS = WebAccessTLSConfig{}
		warnings = append(warnings, warning)
	}
	// A reset lands on the loopback default, so this fires exactly for a
	// surviving valid non-loopback bind — never stacked on the reset warning.
	if !IsLoopbackBind(cfg.WebAccess.Bind) {
		warnings = append(warnings, webAccessLoopbackWarning(cfg.WebAccess.Bind))
	}
	return warnings
}

// validateWebAccessForSave is the save-time counterpart of the fail-soft load
// normalization: an INVALID enabled section (unparseable bind, out-of-range
// port) must never be persisted, and the same gate now covers a structurally
// invalid tls subsection (enabled with an empty cert or key path, ADR-092) —
// one half-typed toggle must not reach config.yaml either. A valid
// non-loopback bind is saved as-is — a deliberate stage-2 LAN listener, not a
// validity problem. The load path resets invalid states before they can be
// re-saved, so this only fires on in-memory mutations — and refusing the
// write keeps config.yaml from ever becoming the source of a broken listener.
func validateWebAccessForSave(cfg *Config) error {
	if !cfg.WebAccess.Enabled {
		return nil
	}
	if err := validateWebAccessBind(cfg.WebAccess.Bind); err != nil {
		return err
	}
	if err := validateWebAccessPort(cfg.WebAccess.Port); err != nil {
		return err
	}
	return validateWebAccessTLS(cfg.WebAccess.TLS)
}
