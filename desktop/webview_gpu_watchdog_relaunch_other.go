//go:build !linux

package desktop

import (
	"errors"
	"log/slog"
)

// relaunchDetachedSelf is unreachable: NewWebviewGpuWatchdog arms only on
// Linux. It exists so the watchdog file compiles unchanged on macOS and
// Windows.
func relaunchDetachedSelf(*slog.Logger) error {
	return errors.New("webview GPU watchdog relaunch is Linux-only")
}
