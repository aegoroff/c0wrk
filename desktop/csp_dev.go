//go:build dev

package desktop

import (
	"net/http"

	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// CSPMiddleware is a no-op in dev builds (`wails dev` compiles with the
// `dev` build tag). The dev asset server proxies the Vite/HMR pipeline —
// websocket reloads and inline HMR scripts — which the production CSP would
// break. Production hardening lives in csp.go (build tag !dev).
func CSPMiddleware() assetserver.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r)
		})
	}
}
