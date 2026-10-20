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
//   - Bind validity (stage 2): while enabled, bind must be a VALID address —
//     an IP literal (loopback, the unspecified "0.0.0.0"/"::", or a specific
//     IPv4/IPv6 address) or the "localhost" name. The stage-1 loopback-only
//     rule survives as a WARNING classification (IsLoopbackBind), not as
//     validity: a valid non-loopback bind is a deliberate LAN-exposed
//     listener that loads with a visible warning and persists as-is.
//   - Load-time VALIDITY problems are FAIL-SOFT (the shell_exec precedent):
//     an invalid section (unparseable bind, out-of-range port) produces a
//     visible load warning and is reset to the safe default state (disabled,
//     loopback bind, auto port, ephemeral token). A broken section must never
//     keep the app from starting — and must never silently leave an unsafe
//     listener configured either.
//   - Save-time VALIDITY problems are FAIL-CLOSED: Save refuses to persist an
//     enabled section with an invalid bind or an out-of-range port. A valid
//     non-loopback bind is saved as-is — the operator's explicit stage-2
//     choice. The load path heals invalid states before they can ever be
//     re-saved, so hitting the save error means an in-memory mutation tried
//     to persist a section the sidecar must never run with.
//   - Port 0 (the zero value) means AUTO: the sidecar picks a free port at
//     start. An empty token means EPHEMERAL: the sidecar generates a fresh
//     per-launch token instead of authenticating with a persisted secret.

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
	// Token is the static token the sidecar authenticates browser requests
	// with. Empty (the default) = ephemeral per-launch: the sidecar generates
	// a fresh token every start instead of persisting a secret in config.yaml.
	Token string `yaml:"token"`
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

// webAccessLoopbackWarning is the load warning for a valid non-loopback bind:
// the listener becomes reachable beyond the machine, and the shipped design
// carries no transport encryption (ADR-090 records TLS as a follow-up).
func webAccessLoopbackWarning(bind string) string {
	return fmt.Sprintf("web_access: bind %q is not loopback — the listener is network-accessible, traffic is unencrypted", bind)
}

// defaultWebAccessState is the canonical default section state the fail-soft
// load path resets an invalid section to: disabled, loopback bind, auto port,
// ephemeral token. Resetting to THIS state (rather than the bare zero value)
// keeps the persisted shape always valid and self-describing — the same
// doctrine as shell_exec's "persisted shape is always valid".
func defaultWebAccessState() WebAccessConfig {
	return WebAccessConfig{
		Enabled: false,
		Bind:    DefaultWebAccessBind,
		Port:    0,
		Token:   "",
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
// and accepts anything, exactly like an inactive shell_exec override. Must
// run AFTER ApplyDefaults (which seeds the default bind) and BEFORE validate,
// so the persisted shape is always valid.
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
	// A reset lands on the loopback default, so this fires exactly for a
	// surviving valid non-loopback bind — never stacked on the reset warning.
	if !IsLoopbackBind(cfg.WebAccess.Bind) {
		warnings = append(warnings, webAccessLoopbackWarning(cfg.WebAccess.Bind))
	}
	return warnings
}

// validateWebAccessForSave is the save-time counterpart of the fail-soft load
// normalization: an INVALID enabled section (unparseable bind, out-of-range
// port) must never be persisted. A valid non-loopback bind is saved as-is —
// a deliberate stage-2 LAN listener, not a validity problem. The load path
// resets invalid states before they can be re-saved, so this only fires on
// in-memory mutations — and refusing the write keeps config.yaml from ever
// becoming the source of a broken listener.
func validateWebAccessForSave(cfg *Config) error {
	if !cfg.WebAccess.Enabled {
		return nil
	}
	if err := validateWebAccessBind(cfg.WebAccess.Bind); err != nil {
		return err
	}
	return validateWebAccessPort(cfg.WebAccess.Port)
}
