// SPDX-License-Identifier: Apache-2.0
//
// web_access.go — the `web_access` config section: the operator switch for the
// browser web-access sidecar (specs/decisions/090-browser-web-access.md), a
// loopback-only HTTP/WebSocket server that mirrors the desktop UI into a
// browser window.
//
// Design contract (ADR-090):
//   - The section is pure data: it knows nothing about the webaccess sidecar
//     package (backend/config never imports application layers). The sidecar
//     reads the resolved section at start.
//   - Default OFF: an absent section — or `enabled: false` — starts nothing
//     and the app behaves exactly as before the section existed.
//   - Loopback-only: while enabled, bind must name a loopback interface (an
//     IP literal whose IsLoopback is true, or the "localhost" name). A
//     LAN-exposed stage is a future, separate decision (ADR-090, stage 2) —
//     this section deliberately cannot express it.
//   - Load-time problems are FAIL-SOFT (the shell_exec precedent): an unsafe
//     section produces a visible load warning and is reset to the safe
//     default state (disabled, loopback bind, auto port, ephemeral token). A
//     broken section must never keep the app from starting — and must never
//     silently leave an unsafe listener configured either.
//   - Save-time problems are FAIL-CLOSED: Save refuses to persist an enabled
//     section that fails the same checks. The load path heals such a state
//     before it can ever be re-saved, so hitting the save error means an
//     in-memory mutation tried to persist a section the sidecar must never
//     run with.
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

// DefaultWebAccessBind is the seeded bind address: loopback IPv4. The sidecar
// never listens on a non-loopback interface in the shipped design (ADR-090,
// stage 1); seeding the value keeps the persisted shape explicit even for an
// operator who only flips `enabled` on.
const DefaultWebAccessBind = "127.0.0.1"

// WebAccessConfig is the top-level `web_access:` section.
type WebAccessConfig struct {
	// Enabled turns the browser web-access sidecar on. Default false: no
	// listener is created. An absent section is this zero value — off.
	Enabled bool `yaml:"enabled"`
	// Bind is the interface the sidecar listens on. Default (and the only
	// class accepted while enabled): a loopback address — an IP literal such
	// as "127.0.0.1" or "::1", or the "localhost" name. Anything else is
	// fail-soft at load (warning + reset to the default state) and refused
	// at save.
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
// non-loopback values are all false — the caller picks the failure mode
// (fail-soft at load, fail-closed at save).
func IsLoopbackBind(bind string) bool {
	if bind == "localhost" {
		return true
	}
	ip := net.ParseIP(bind)
	return ip != nil && ip.IsLoopback()
}

// validateWebAccessBind checks the bind-address class of an enabled section.
func validateWebAccessBind(bind string) error {
	if IsLoopbackBind(bind) {
		return nil
	}
	if bind == "" {
		return errors.New("web_access: bind is required when enabled")
	}
	return fmt.Errorf("web_access: bind %q is not a loopback address — the sidecar listens on loopback only (default %q)", bind, DefaultWebAccessBind)
}

// validateWebAccessPort checks the port of an enabled section: 0 = auto,
// 1–65535 explicit.
func validateWebAccessPort(port int) error {
	if port < 0 || port > 65535 {
		return fmt.Errorf("web_access: port %d is out of range (0 = auto, 1-65535 explicit)", port)
	}
	return nil
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
// load warnings. Problems are FAIL-SOFT: an enabled section with a non-loopback
// bind or an out-of-range port is warned about and reset to the default state
// (the sidecar stays off), never fatal — a broken section must not keep the
// app from starting, and must not leave a half-applied unsafe listener either.
// A disabled section is inert and accepts anything, exactly like an inactive
// shell_exec override. Must run AFTER ApplyDefaults (which seeds the default
// bind) and BEFORE validate, so the persisted shape is always valid.
func normalizeWebAccess(cfg *Config) []string {
	if !cfg.WebAccess.Enabled {
		return nil
	}
	var reasons []string
	if err := validateWebAccessBind(cfg.WebAccess.Bind); err != nil {
		reasons = append(reasons, err.Error())
	}
	if err := validateWebAccessPort(cfg.WebAccess.Port); err != nil {
		reasons = append(reasons, err.Error())
	}
	if len(reasons) == 0 {
		return nil
	}
	warning := "web_access ignored (the sidecar stays disabled; fix bind/port and re-enable): " +
		strings.Join(reasons, "; ")
	cfg.WebAccess = defaultWebAccessState()
	return []string{warning}
}

// validateWebAccessForSave is the save-time counterpart of the fail-soft load
// normalization: an UNSAFE enabled section must never be persisted. The load
// path resets such a state before it can be re-saved, so this only fires on
// in-memory mutations — and refusing the write keeps config.yaml from ever
// becoming the source of an unsafe listener.
func validateWebAccessForSave(cfg *Config) error {
	if !cfg.WebAccess.Enabled {
		return nil
	}
	if err := validateWebAccessBind(cfg.WebAccess.Bind); err != nil {
		return err
	}
	return validateWebAccessPort(cfg.WebAccess.Port)
}
