package tools

import (
	"strings"
	"testing"
	"time"
)

// TestCreateSearchProviderWithClient_Searxng pins the searxng case: a valid
// instance URL builds the SearXNG provider, while a missing or malformed one
// is an explicit error — never a silently missing web_search tool.
func TestCreateSearchProviderWithClient_Searxng(t *testing.T) {
	t.Run("valid url builds the provider", func(t *testing.T) {
		p, err := CreateSearchProviderWithClient("SearXNG", "", "http://127.0.0.1:8888", time.Second, nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p == nil {
			t.Fatal("expected a provider, got nil")
		}
		if got := p.Name(); got != "searxng" {
			t.Errorf("provider name = %q, want searxng", got)
		}
	})

	tests := []struct {
		name    string
		baseURL string
		wantErr string
	}{
		{name: "missing url", baseURL: "", wantErr: "requires search.base_url"},
		{name: "whitespace url", baseURL: "   ", wantErr: "requires search.base_url"},
		{name: "malformed url", baseURL: "not a url", wantErr: "absolute http(s) URL"},
		{name: "unparseable url", baseURL: "http://exa\x7fmple.com", wantErr: "not a valid URL"},
		{name: "wrong scheme", baseURL: "ftp://127.0.0.1:8888", wantErr: "absolute http(s) URL"},
		{name: "no host", baseURL: "http://", wantErr: "absolute http(s) URL"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p, err := CreateSearchProviderWithClient("searxng", "", tc.baseURL, time.Second, nil)
			if err == nil {
				t.Fatalf("expected an error for base_url %q, got provider %v", tc.baseURL, p)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error = %q, want it to contain %q", err.Error(), tc.wantErr)
			}
		})
	}
}

// TestCreateSearchProviderWithClient_APIKeyProvidersUnchanged pins the
// existing nil-provider contract for the key-bearing providers: no key means
// no provider and NO error (the tool stays unregistered), while a key builds
// the provider.
func TestCreateSearchProviderWithClient_APIKeyProvidersUnchanged(t *testing.T) {
	for _, name := range []string{"tavily", "", "brave", "exa", "something-unknown"} {
		p, err := CreateSearchProviderWithClient(name, "", "", time.Second, nil)
		if err != nil {
			t.Fatalf("provider %q without a key: unexpected error %v", name, err)
		}
		if p != nil {
			t.Errorf("provider %q without a key = %v, want nil (unregistered tool)", name, p)
		}
	}
}
