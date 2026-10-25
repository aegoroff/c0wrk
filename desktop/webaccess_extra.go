// SPDX-License-Identifier: Apache-2.0
//
// webaccess_extra.go — the App-level methods the browser web surface
// explicitly mirrors, behind a MINIMAL adapter (webaccess.Options.
// ExtraDispatch).
//
// The web reflection dispatcher sees the *backend.FrontendAPI method
// surface. The control RPCs (SetWebAccessEnabled, GetWebAccessInfo, Quit, …)
// are App methods PRECISELY so a browser tab can never reach them — this
// file must never become a passthrough to the App itself: every method added
// to the adapter widens the browser attack surface and must be (a) justified
// here in prose and (b) pinned by the surface contract test
// (internal/webaccess/contract_test.go), which fails on any extra-surface
// method that is not exactly the pinned set.

package desktop

// webExtraSurface is the opted-in slice of App-level capabilities the
// mirrored UI needs. Passed to the sidecar as ExtraDispatch; consulted only
// when the FrontendAPI surface has no such method.
type webExtraSurface struct {
	app *App
}

// GetPendingActions mirrors App.GetPendingActions for the web transport.
// The session switch reconciles pending HITL prompts (whose live events can
// be missed while the session sat in the background) through this sweep in
// BOTH transports — the browser tab is the same UI, so it needs the same
// reconciliation. Read-only over app state; no control semantics.
func (w *webExtraSurface) GetPendingActions(sessionID string) (*PendingActionsResponse, error) {
	return w.app.GetPendingActions(sessionID)
}
