//go:build !dev

package desktop

import (
	"net/http"

	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// productionCSP is the Content-Security-Policy applied to every response in
// production builds. It is the second half of the theme-trust story: themes
// are sanitized at import (only custom properties survive), but the CSP
// guarantees at the webview level that even a future sanitization bypass
// cannot turn an injected stylesheet into a network request.
//
//   - default-src 'none' — deny everything not explicitly allowed below.
//   - script-src 'self' — the app bundle plus the Wails runtime and IPC
//     scripts, which Wails serves from the same asset origin as external
//     <script src="/wails/..."> documents. No remote or inline scripts.
//   - style-src 'self' 'unsafe-inline' — the app's <link> stylesheets plus
//     injected style elements and style attributes (Tailwind utilities,
//     theme injection, CodeMirror/xterm inline styling).
//   - img-src 'self' data: — bundled assets and data: URIs (the markdown
//     image pipeline resolves local files to data: URLs; TRANSPARENT_PIXEL).
//   - font-src 'self' data: — bundled Nerd Font and data:-embedded fonts.
//   - connect-src 'self' — the desktop IPC transport (same origin). No
//     outbound websockets/fetches to anywhere.
//   - worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'
//     — nothing in this app runs in a worker/iframe/plugin, and <base> can
//     silently redirect every relative URL elsewhere.
//   - form-action 'none' — there is no form navigation anywhere in the UI.
//   - frame-ancestors 'none' — the webview is never embedded anywhere.
//
// Under `wails dev` (build tag `dev`) this middleware is compiled out: the
// dev asset server proxies the Vite/HMR pipeline (websocket + inline HMR
// scripts) which a strict CSP would break.
const productionCSP = "default-src 'none'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; " +
	"font-src 'self' data:; " +
	"connect-src 'self'; " +
	"worker-src 'none'; " +
	"frame-src 'none'; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"form-action 'none'; " +
	"frame-ancestors 'none'"

// CSPMiddleware returns the assetserver middleware that stamps the
// production CSP onto every response. See productionCSP for the rationale.
func CSPMiddleware() assetserver.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Security-Policy", productionCSP)
			next.ServeHTTP(w, r)
		})
	}
}
