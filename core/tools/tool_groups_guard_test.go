package tools

import (
	"testing"

	"github.com/v0lka/c0wrk/core/slm"
)

// TestToolGroupCatalogMembersAreRegistered guards against catalog drift: every
// tool named by the always-present picker's workflow clusters must be a
// registered built-in tool. Otherwise a cluster would silently lose a member
// (the backend filters clusters to the registered set) or ship a typo that
// never surfaces in the UI.
func TestToolGroupCatalogMembersAreRegistered(t *testing.T) {
	registry := NewToolRegistry()
	if err := RegisterBuiltinTools(registry, BuiltinToolsConfig{}); err != nil {
		t.Fatalf("RegisterBuiltinTools: %v", err)
	}

	registered := make(map[string]struct{})
	for _, d := range registry.List() {
		registered[d.Name] = struct{}{}
	}

	for _, g := range slm.ToolGroupCatalog() {
		for _, name := range g.Tools {
			if _, ok := registered[name]; !ok {
				t.Errorf("cluster %q lists %q, which is not a registered built-in tool", g.ID, name)
			}
		}
	}
}
