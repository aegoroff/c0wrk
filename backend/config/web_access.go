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
//     listener that persists as-is. The LOAD warning is reserved for the
//     plain-HTTP combination (ADR-092) — a TLS-encrypted non-loopback bind
//     loads warning-free, its exposure staying surfaced by the Settings
//     section banner and the sidecar start log.
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
//   - TLS (ADR-092): the `web_access.tls` subsection is the
//     explicit HTTPS switch — the protocol is never parsed out of the
//     address field. A TLS subsection the sidecar cannot actually serve —
//     structurally incomplete (enabled with an empty cert or key path) or
//     a certificate pair that fails to load from disk — is FAIL-SOFT at
//     load by turning the WHOLE section off with a visible warning
//     (ADR-092): a requested TLS is never downgraded to plain HTTP, so no
//     listener is the only safe state. The same usability predicate
//     (structure + LoadX509KeyPair) FAIL-CLOSED at the interactive
//     boundaries — the TLS commit RPC and the enable flip — and the
//     sidecar mount keeps its fail-closed backstop for the race the load
//     path cannot see (files vanishing between load and mount).

package config

import (
	"crypto/tls"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"strings"
	"time"
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
	// plain-HTTP shape; TLS turns `Secure` on and nothing else). Usability
	// is checked as a whole (ADR-092): enabled with an EMPTY cert or key
	// path — or with a pair that fails to load from disk — makes the
	// subsection UNUSABLE: the load path turns the whole web_access section
	// off with a warning (a requested TLS is never downgraded to plain
	// HTTP), and the interactive TLS commit refuses the state up front.
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
	// surface authors both paths explicitly — the key path is never derived
	// from the cert path — and the interactive commit (desktop's
	// SetWebAccessTLS) loads the pair before anything persists, refusing a
	// key that does not match its certificate and an unreadable pair. The
	// persisted config always carries both paths, so an enabled subsection
	// with an empty key is structurally invalid exactly like an empty cert;
	// a subsection pointing at files that cannot be loaded is unusable the
	// same way (ADR-092): both shapes turn the section off at load with a
	// warning instead of serving plain HTTP.
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
func validateWebAccessTLS(tlsCfg WebAccessTLSConfig) error {
	if !tlsCfg.Enabled {
		return nil
	}
	if tlsCfg.Cert == "" {
		return errors.New("web_access: tls.cert is required when tls is enabled (generate a pair in Settings → Web Access or point cert/key at PEM files)")
	}
	if tlsCfg.Key == "" {
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
func ValidateWebAccessTLS(tlsCfg WebAccessTLSConfig) error {
	return validateWebAccessTLS(tlsCfg)
}

// webAccessTLSProbeTimeout bounds the certificate-pair probe (CS #47): the
// probe reads both PEM files on EVERY config load, so a path on a hanging
// mount (or a FIFO) would otherwise stall startup unboundedly. The
// deliberate fail-closed stance (ADR-092) is preserved — a pair that cannot
// be verified within the budget is reported unusable (the load path then
// keeps the whole section off), never downgraded to plain HTTP. The
// goroutine left blocked on a wedged file past the budget is bounded by the
// probe's rarity (config loads and the interactive TLS/enable boundaries),
// and its eventual result is drained into the buffered channel.
const webAccessTLSProbeTimeout = 5 * time.Second

// webAccessTLSPairError is the usability predicate of a tls subsection
// (ADR-092): structural completeness first (validateWebAccessTLS), then —
// for an enabled subsection — the pair itself: the config layer READS the
// certificate files here, the deliberate ADR-092 reversal of the
// never-reads-the-files doctrine. A subsection that fails either check is
// UNUSABLE: the sidecar it configures cannot honor the requested TLS, and
// ADR-092 forbids downgrading a requested TLS to plain HTTP. A disabled
// subsection is usable by definition — inert, exactly like the whole
// section when web_access.enabled is off.
func webAccessTLSPairError(tlsCfg WebAccessTLSConfig) error {
	if err := validateWebAccessTLS(tlsCfg); err != nil {
		return err
	}
	if !tlsCfg.Enabled {
		return nil
	}
	errCh := make(chan error, 1)
	go func() {
		_, err := tls.LoadX509KeyPair(tlsCfg.Cert, tlsCfg.Key)
		errCh <- err
	}()
	select {
	case err := <-errCh:
		if err == nil {
			return nil
		}
		// Classify the missing-file family into platform-neutral wording:
		// the raw strerror is OS-localized ("no such file or directory"
		// on Linux/macOS, "The system cannot find the file specified." on
		// Windows), and the operator-facing warning text — and the tests
		// pinning it — must not depend on the host OS.
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("certificate pair failed to load: certificate or key file not found: %w", err)
		}
		return fmt.Errorf("certificate pair failed to load: %w", err)
	case <-time.After(webAccessTLSProbeTimeout):
		return fmt.Errorf("certificate pair failed to load: reading %s did not complete within %s",
			tlsCfg.Cert, webAccessTLSProbeTimeout)
	}
}

// ValidateWebAccessTLSPair is the exported form of the subsection's
// usability rule (ADR-092) for callers outside the package that turn the
// sidecar on at runtime (desktop's SetWebAccessEnabled): an enabled
// subsection must be structurally complete AND its certificate pair must
// load — a flip onto an unusable TLS is refused before anything persists,
// because the sidecar must never come up on plain HTTP in its place.
func ValidateWebAccessTLSPair(tlsCfg WebAccessTLSConfig) error {
	return webAccessTLSPairError(tlsCfg)
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

// webAccessLoopbackWarning is the load warning for a valid non-loopback bind
// served over PLAIN HTTP: the listener becomes reachable beyond the machine
// while the traffic stays unencrypted — the token-over-plaintext combination
// is the one exposure shape that belongs in the UI's config_errors banner.
// A TLS-encrypted non-loopback bind (ADR-092) deliberately does NOT draw this
// warning: it loads warning-free, its exposure staying surfaced by the
// Settings → Web Access section banner and the sidecar start log (ADR-092).
// The classification is a warned operator decision either way — never a gate.
func webAccessLoopbackWarning(bind string) string {
	return fmt.Sprintf("web_access: bind %q is not loopback — the listener is network-accessible, traffic is plain HTTP without TLS", bind)
}

// WebAccessLoadWarnings is the pure, state-only counterpart of the
// normalizeWebAccess warning tail (ADR-092), for callers that mutate the
// section at runtime (desktop's control RPCs) and must keep the UI's
// config-load-warning channel — GetConfig().config_errors → the Settings
// "Configuration warning" banner — in step with the live section instead of
// freezing it on the launch-time snapshot. It returns the warnings the
// section's CURRENT state draws without touching anything, so a runtime
// recompute is idempotent and safe after failures and rollbacks alike.
//
// Only the exposure warning is computable here, and only from state. The
// interactive writers preflight a TLS pair fail-closed (the TLS commit loads
// the pair, the enable flip refuses an unusable one), so a runtime-mutated
// section can never carry an unusable TLS — pair files that rot UNDER an
// already-persisted usable TLS stay owned by the section's cert_status
// banner and the sidecar mount's fail-closed backstop, not by this function.
// Semantics mirror the load pipeline exactly: a disabled section warns
// nothing (no listener, nothing to expose); an enabled non-loopback bind
// warns only while the effective transport is plain HTTP (ADR-092) — a
// TLS-encrypted exposure stays a section-banner + start-log matter.
func WebAccessLoadWarnings(section WebAccessConfig) []string {
	if !section.Enabled {
		return nil
	}
	if IsLoopbackBind(section.Bind) || section.TLS.Enabled {
		return nil
	}
	return []string{webAccessLoopbackWarning(section.Bind)}
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
// unparseable bind or an out-of-range port is warned about and has its
// connection/credential fields reset to the default state (the sidecar stays
// off) while the authored tls subsection survives — the same
// preserve-the-subsection contract as the TLS branch below, so a bind/port
// typo can never silently wipe a hand-authored certificate pair or static
// token — never fatal, because a broken section must
// not keep the app from starting, and must not leave a half-applied unsafe
// listener either. A VALID non-loopback bind is not a validity problem: the
// section stays enabled and — while the effective transport is plain HTTP
// AND the experimental master gate is open (only then can the sidecar
// actually mount, CS #65) — draws the network-exposure warning (a stage-2
// LAN listener; IsLoopbackBind classifies it, ADR-092 scopes the warning to
// TLS-off). A disabled section
// is inert and accepts anything, exactly like an inactive shell_exec
// override.
//
// The tls subsection (ADR-092) is validated one level down: a
// subsection the sidecar cannot serve — structurally incomplete, or a pair
// that fails to load from disk — turns the whole section OFF with a visible
// warning, the subsection itself preserved as authored (the operator's
// paths survive the reset; a disabled section is inert, so the persisted
// shape stays valid). A requested TLS is never downgraded to plain HTTP, so
// no listener is the only safe state. Must run AFTER ApplyDefaults (which
// seeds the default bind) and BEFORE validate, so the persisted shape is
// always valid.
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
		// The reset mirrors the sibling ADR-092 branch below: only the
		// connection/credential fields return to the default state and the
		// authored tls subsection survives (only Enabled/Bind/Port/Token are
		// reset). A disabled section is inert — the persisted shape stays
		// valid either way — and silently wiping a hand-authored PEM pair or
		// static token because of a bind/port typo would destroy real
		// operator config on the next unrelated save (the warning names
		// bind/port alone, so nothing would hint at the loss).
		authored := cfg.WebAccess
		cfg.WebAccess = defaultWebAccessState()
		cfg.WebAccess.TLS = authored.TLS
		warnings = append(warnings, warning)
	}
	// ADR-092: a tls subsection the sidecar cannot serve — structurally
	// incomplete, or a pair that fails to load from disk — turns the whole
	// section off: a requested TLS is never downgraded to plain HTTP, so no
	// listener is the only safe state. The subsection is preserved as
	// authored (the operator's paths survive; a disabled section is inert),
	// and the warning names the reason. The bind/port reset above preserves
	// the subsection the same way, so a bad bind WITH an unusable subsection
	// stacks this warning on top — both repair flows are named, and the
	// section ends up disabled either way.
	if err := webAccessTLSPairError(cfg.WebAccess.TLS); err != nil {
		warning := "web_access.tls unusable (the sidecar stays disabled — a configured TLS is never downgraded to plain HTTP; fix the certificate pair or turn tls off, then enable web_access again): " +
			err.Error()
		cfg.WebAccess.Enabled = false
		warnings = append(warnings, warning)
	}
	// Fires only for a SURVIVING enabled section — the resets above leave
	// either the loopback default or a disabled master switch. The tail
	// delegates to WebAccessLoadWarnings (ADR-092) so the load pipeline and
	// the runtime recompute can never drift apart in text or condition: an
	// unusable TLS never reaches this gate (its section is disabled above,
	// so there is no listener left to expose), and only the PLAIN-HTTP
	// combination warns — a TLS-encrypted non-loopback bind loads
	// warning-free (its exposure stays surfaced by the Settings section
	// banner and the sidecar start log).
	//
	// Suppressed while the experimental master switch is closed (CS #65):
	// the compound gate guarantees the sidecar cannot mount, so the
	// present-tense "listener is network-accessible, traffic is plain HTTP"
	// warning would overstate the actual exposure at load time. The runtime
	// recompute after a live gate flip calls WebAccessLoadWarnings directly
	// (desktop's refreshWebAccessLoadWarnings) — that is the case the
	// warning is written for, and it keeps firing there.
	if cfg.Experimental.Enabled {
		warnings = append(warnings, WebAccessLoadWarnings(cfg.WebAccess)...)
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
//
// The certificate pair's on-disk usability is deliberately NOT a save gate
// (ADR-092): filesystem state must never brick an unrelated settings save.
// The pair is checked fail-soft at load (the section turns off with a
// warning), fail-closed at the interactive boundaries (the TLS commit and
// the enable flip), and fail-closed again at sidecar mount.
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
