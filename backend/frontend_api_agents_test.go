package backend

import (
	"testing"

	"github.com/v0lka/sp4rk/agents"
)

// TestRefreshAgents_ForcesRediscovery verifies that RefreshAgents bypasses
// the agent cache: every call re-invokes GetAgentDescriptors, returns the
// fresh catalog, and keeps hidden profiles excluded — the manual
// re-discovery path behind the Capabilities tab's refresh button.
func TestRefreshAgents_ForcesRediscovery(t *testing.T) {
	mock := &mockBuilder{
		getAgentDescriptorsRes: []agents.AgentDescriptor{
			{Name: "code-reviewer", Description: "Reviews code."},
			{Name: "secret-agent", Description: "Hidden profiles stay excluded.", Hidden: true},
		},
	}
	f := &FrontendAPI{emitEvent: func(string, ...any) {}}
	f.builderOverride = mock

	if got := f.ListAgents(); len(got) != 1 || got[0].Name != "code-reviewer" {
		t.Fatalf("ListAgents initial: got %v", got)
	}
	// A plain second ListAgents is served from the cache.
	if got := f.ListAgents(); len(got) != 1 {
		t.Fatalf("ListAgents cached: got %v", got)
	}
	if mock.getAgentDescriptorsCalls != 1 {
		t.Fatalf("expected 1 GetAgentDescriptors call after cached reload, got %d", mock.getAgentDescriptorsCalls)
	}

	// A profile appears on disk (no watcher for it); RefreshAgents must see it.
	mock.getAgentDescriptorsRes = append(mock.getAgentDescriptorsRes,
		agents.AgentDescriptor{Name: "new-agent", Description: "Created after startup."})
	fresh := f.RefreshAgents()
	if mock.getAgentDescriptorsCalls != 2 {
		t.Fatalf("expected RefreshAgents to re-scan (2 GetAgentDescriptors calls), got %d", mock.getAgentDescriptorsCalls)
	}
	if len(fresh) != 2 || fresh[0].Name != "code-reviewer" || fresh[1].Name != "new-agent" {
		t.Fatalf("RefreshAgents: got %v", fresh)
	}
	// The re-scan result replaces the cache: the next ListAgents is fresh too.
	if got := f.ListAgents(); len(got) != 2 || got[1].Name != "new-agent" {
		t.Fatalf("ListAgents after refresh: got %v", got)
	}
	if mock.getAgentDescriptorsCalls != 2 {
		t.Fatalf("expected the refresh result to be cached (still 2 calls), got %d", mock.getAgentDescriptorsCalls)
	}
}
