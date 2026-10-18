package config

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/v0lka/sp4rk/tools/builtins/websearch"
)

// ValidateSearchBaseURL checks search.base_url for the given provider against
// the RAW config value (${ENV_VAR} placeholders unresolved):
//
//   - only the searxng provider uses it; for every other provider any value
//     is accepted (and ignored);
//   - an empty value fails: ApplyDefaults seeds the local-instance default
//     (websearch.DefaultSearxngBaseURL), so an empty base_url reaching this
//     gate means a programmatic config bypassed the defaults;
//   - a ${ENV_VAR} placeholder passes load validation — it resolves at
//     runtime, and the consumption-time gate (core/tools
//     CreateSearchProviderWithClient) re-checks the EXPANDED value fail-closed;
//   - otherwise it must be an absolute http(s) URL with a host.
//
// The Settings save path (UpdateSearchSettings) runs the same check so an
// invalid value is rejected up front instead of surfacing on the next launch.
func ValidateSearchBaseURL(provider, raw string) error {
	if !strings.EqualFold(provider, "searxng") {
		return nil
	}
	if strings.TrimSpace(raw) == "" {
		return fmt.Errorf(
			"search.provider %q requires search.base_url (the SearXNG instance URL, e.g. %s)",
			provider, websearch.DefaultSearxngBaseURL,
		)
	}
	if strings.Contains(raw, "${") {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("search.base_url %q is not a valid URL: %w", raw, err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("search.base_url %q must be an absolute http(s) URL with a host", raw)
	}
	return nil
}
