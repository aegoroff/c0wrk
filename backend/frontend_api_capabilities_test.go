package backend

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/core"
	"github.com/v0lka/sp4rk/tools/mcp"
)

func capMCPInfo(m CapabilitiesInfo, name string) CapabilityModesInfo {
	return m.MCP[name]
}

// --- GetCapabilityModes ---

// TestGetCapabilityModes verifies the read shape: canonical enum values on
// the wire (empty resolves to "auto"), all three sections non-nil, and
// stale capabilities.mcp names (no such configured server) filtered out.
func TestGetCapabilityModes(t *testing.T) {
	f, _, _ := newTestAPI(t)
	f.config.MCP = config.MCPConfig{
		Servers: map[string]config.MCPServerConfig{
			"srv": {Command: "cmd"},
		},
	}
	f.config.Capabilities = config.CapabilitiesConfig{
		Skills: map[string]config.CapabilityModes{
			"my-skill": {ChatMode: config.MCPServerModeManual},
		},
		MCP: map[string]config.CapabilityModes{
			"srv":   {CodeMode: config.MCPServerModeDisabled},
			"ghost": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual}, // stale
		},
	}

	got := f.GetCapabilityModes()

	if got.Skills == nil || got.Agents == nil || got.MCP == nil {
		t.Fatalf("expected non-nil sections, got %+v", got)
	}
	if len(got.Agents) != 0 {
		t.Errorf("Agents = %+v, want empty", got.Agents)
	}
	skill := got.Skills["my-skill"]
	if skill.ChatMode != config.MCPServerModeManual || skill.CodeMode != config.MCPServerModeAuto {
		t.Errorf("skills[my-skill] = %+v, want chat manual / code auto", skill)
	}
	// Stale name filtered; the live one normalized (empty chat_mode → auto).
	if _, ok := got.MCP["ghost"]; ok {
		t.Error("stale capabilities.mcp entry 'ghost' leaked into GetCapabilityModes")
	}
	if srv := capMCPInfo(got, "srv"); srv.ChatMode != config.MCPServerModeAuto || srv.CodeMode != config.MCPServerModeDisabled {
		t.Errorf("mcp[srv] = %+v, want chat auto / code disabled", srv)
	}
}

// TestGetCapabilityModes_NoConfig verifies the uninitialized-config early
// return: empty (never nil) sections.
func TestGetCapabilityModes_NoConfig(t *testing.T) {
	f := &FrontendAPI{}
	f.seedPublished.Store(true)
	got := f.GetCapabilityModes()
	if got.Skills == nil || got.Agents == nil || got.MCP == nil {
		t.Fatalf("expected non-nil empty sections, got %+v", got)
	}
	if len(got.Skills) != 0 || len(got.Agents) != 0 || len(got.MCP) != 0 {
		t.Errorf("expected empty sections, got %+v", got)
	}
}

// --- UpdateCapabilityModes ---

// TestUpdateCapabilityModes_PersistsAllSections covers the happy path for
// every kind: the section is written to the live config, persisted through
// the common pipeline (atomic YAML rewrite), and reads back normalized via
// GetCapabilityModes. Every update is also pushed to the live builder
// (UpdateCapabilities) — orchestrators read modes from the builder's
// immutable snapshots at task entry, so a save without the push would stay
// invisible until the next app restart. The persisted file must not contain
// a legacy mode key.
func TestUpdateCapabilityModes_PersistsAllSections(t *testing.T) {
	f, mock, cfgPath := newTestAPI(t)
	f.config.MCP = config.MCPConfig{
		Servers: map[string]config.MCPServerConfig{
			"srv": {Command: "cmd"},
		},
	}

	if err := f.UpdateCapabilityModes(CapabilitySectionSkills, map[string]CapabilityModesInfo{
		"my-skill": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeAuto},
	}); err != nil {
		t.Fatalf("UpdateCapabilityModes(skills): %v", err)
	}
	if err := f.UpdateCapabilityModes(CapabilitySectionAgents, map[string]CapabilityModesInfo{
		"code-reviewer": {ChatMode: config.MCPServerModeDisabled, CodeMode: config.MCPServerModeDisabled},
	}); err != nil {
		t.Fatalf("UpdateCapabilityModes(agents): %v", err)
	}
	if err := f.UpdateCapabilityModes(CapabilitySectionMCP, map[string]CapabilityModesInfo{
		"srv": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeDisabled},
	}); err != nil {
		t.Fatalf("UpdateCapabilityModes(mcp): %v", err)
	}

	if mock.reconfigureMCPCalls != 0 {
		t.Errorf("ReconfigureMCP called %d times, want 0 (the server set is unchanged)", mock.reconfigureMCPCalls)
	}

	// The runtime-edit push: one UpdateCapabilities per RPC, and the last one
	// carries the full saved state — the skill/agent sections verbatim and
	// the MCP modes projected onto the server entries (the same shape the
	// constructor and ReconfigureMCP publish from).
	if mock.updateCapabilitiesCalls != 3 {
		t.Errorf("UpdateCapabilities called %d times, want 3 (one per section update)", mock.updateCapabilitiesCalls)
	}
	last := mock.updateCapabilitiesLastCfg
	if last == nil {
		t.Fatal("UpdateCapabilities never captured a BuilderConfig")
	}
	if s, ok := last.Capabilities.Skills["my-skill"]; !ok || s != (core.CapabilityModes{ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeAuto}) {
		t.Errorf("pushed skills[my-skill] = %+v (present %t), want chat manual / code auto", s, ok)
	}
	if a, ok := last.Capabilities.Agents["code-reviewer"]; !ok || a != (core.CapabilityModes{ChatMode: config.MCPServerModeDisabled, CodeMode: config.MCPServerModeDisabled}) {
		t.Errorf("pushed agents[code-reviewer] = %+v (present %t), want disabled/disabled", a, ok)
	}
	if srv := last.MCP.Servers["srv"]; srv.ChatMode != config.MCPServerModeManual || srv.CodeMode != config.MCPServerModeDisabled {
		t.Errorf("pushed mcp server modes = {chat %q, code %q}, want manual/disabled", srv.ChatMode, srv.CodeMode)
	}

	// In-memory state is normalized.
	got := f.GetCapabilityModes()
	if s := got.Skills["my-skill"]; s.ChatMode != config.MCPServerModeManual || s.CodeMode != config.MCPServerModeAuto {
		t.Errorf("skills[my-skill] = %+v, want chat manual / code auto", s)
	}
	if a := got.Agents["code-reviewer"]; a.ChatMode != config.MCPServerModeDisabled || a.CodeMode != config.MCPServerModeDisabled {
		t.Errorf("agents[code-reviewer] = %+v, want disabled/disabled", a)
	}
	if m := capMCPInfo(got, "srv"); m.ChatMode != config.MCPServerModeManual || m.CodeMode != config.MCPServerModeDisabled {
		t.Errorf("mcp[srv] = %+v, want chat manual / code disabled", m)
	}

	// The persisted YAML carries the capabilities section and no legacy mode
	// under mcp.servers.
	srv, ok := yamlMCPServers(t, cfgPath)["srv"].(map[string]any)
	if !ok {
		t.Fatal("persisted YAML has no mcp.servers.srv entry")
	}
	if _, ok := srv["mode"]; ok {
		t.Errorf("persisted mcp.servers.srv carries a mode key: %+v", srv)
	}
	reloaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("reload persisted config: %v", err)
	}
	if s := reloaded.Capabilities.Skills["my-skill"]; s.ChatMode != config.MCPServerModeManual || s.CodeMode != config.MCPServerModeAuto {
		t.Errorf("reloaded skills[my-skill] = %+v, want chat manual / code auto", s)
	}
	if m := reloaded.Capabilities.MCP["srv"]; m.ChatMode != config.MCPServerModeManual || m.CodeMode != config.MCPServerModeDisabled {
		t.Errorf("reloaded mcp[srv] = %+v, want chat manual / code disabled", m)
	}
}

// TestUpdateCapabilityModes_ReplacesSection pins the replacement (not merge)
// semantics: a section update drops names absent from the payload.
func TestUpdateCapabilityModes_ReplacesSection(t *testing.T) {
	f, _, _ := newTestAPI(t)
	if err := f.UpdateCapabilityModes(CapabilitySectionSkills, map[string]CapabilityModesInfo{
		"old-skill": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual},
	}); err != nil {
		t.Fatalf("UpdateCapabilityModes: %v", err)
	}
	if err := f.UpdateCapabilityModes(CapabilitySectionSkills, map[string]CapabilityModesInfo{
		"new-skill": {ChatMode: config.MCPServerModeAuto, CodeMode: config.MCPServerModeManual},
	}); err != nil {
		t.Fatalf("UpdateCapabilityModes: %v", err)
	}
	got := f.GetCapabilityModes()
	if _, ok := got.Skills["old-skill"]; ok {
		t.Error("old-skill survived a section replacement — UpdateCapabilityModes merged instead of replaced")
	}
	if s, ok := got.Skills["new-skill"]; !ok || s.CodeMode != config.MCPServerModeManual {
		t.Errorf("skills[new-skill] = %+v (present %t), want code manual", s, ok)
	}
}

// TestUpdateCapabilityModes_UnknownKind verifies the kind gate.
func TestUpdateCapabilityModes_UnknownKind(t *testing.T) {
	f, _, _ := newTestAPI(t)
	err := f.UpdateCapabilityModes("tools", map[string]CapabilityModesInfo{
		"anything": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual},
	})
	if err == nil {
		t.Fatal("expected error for unknown kind")
	}
	for _, want := range []string{"tools", CapabilitySectionSkills, CapabilitySectionAgents, CapabilitySectionMCP} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

// TestUpdateCapabilityModes_RejectsInvalidValues pins the strict save-path
// enum gate: any non-empty unrecognized chat_mode / code_mode rejects the
// whole update with an error naming the valid values, and the live config
// stays untouched.
func TestUpdateCapabilityModes_RejectsInvalidValues(t *testing.T) {
	f, _, _ := newTestAPI(t)
	f.config.Capabilities = config.CapabilitiesConfig{
		Skills: map[string]config.CapabilityModes{
			"keep": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual},
		},
	}

	cases := []struct {
		name  string
		kind  string
		modes map[string]CapabilityModesInfo
	}{
		{
			name:  "bogus chat_mode",
			kind:  CapabilitySectionSkills,
			modes: map[string]CapabilityModesInfo{"my-skill": {ChatMode: "sometimes", CodeMode: config.MCPServerModeAuto}},
		},
		{
			name:  "bogus code_mode",
			kind:  CapabilitySectionSkills,
			modes: map[string]CapabilityModesInfo{"my-skill": {ChatMode: config.MCPServerModeAuto, CodeMode: "sometimes"}},
		},
		{
			name:  "case-sensitive enum",
			kind:  CapabilitySectionMCP,
			modes: map[string]CapabilityModesInfo{"srv": {ChatMode: "Manual", CodeMode: config.MCPServerModeManual}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := f.UpdateCapabilityModes(tc.kind, tc.modes)
			if err == nil {
				t.Fatal("expected validation error for an unrecognized mode value")
			}
			for _, want := range []string{config.MCPServerModeAuto, config.MCPServerModeManual, config.MCPServerModeDisabled} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not list valid value %q", err, want)
				}
			}
		})
	}

	// The live config is untouched by every rejected update.
	got := f.GetCapabilityModes()
	if len(got.Skills) != 1 {
		t.Fatalf("rejected updates mutated the config: %+v", got.Skills)
	}
	if s := got.Skills["keep"]; s.ChatMode != config.MCPServerModeManual || s.CodeMode != config.MCPServerModeManual {
		t.Errorf("skills[keep] = %+v, want the pre-existing entry preserved", s)
	}
}

// TestUpdateCapabilityModes_TrimsStaleMCPServers pins the staleness rule:
// capabilities.mcp names outside mcp.servers are trimmed instead of stored,
// while the resolvable ones persist.
func TestUpdateCapabilityModes_TrimsStaleMCPServers(t *testing.T) {
	f, _, cfgPath := newTestAPI(t)
	f.config.MCP = config.MCPConfig{
		Servers: map[string]config.MCPServerConfig{
			"real": {Command: "cmd"},
		},
	}

	err := f.UpdateCapabilityModes(CapabilitySectionMCP, map[string]CapabilityModesInfo{
		"real":  {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual},
		"stale": {ChatMode: config.MCPServerModeDisabled, CodeMode: config.MCPServerModeDisabled},
	})
	if err != nil {
		t.Fatalf("UpdateCapabilityModes: %v", err)
	}

	if _, ok := f.config.Capabilities.MCP["stale"]; ok {
		t.Error("stale capabilities.mcp name stored in the live config")
	}
	if m, ok := f.config.Capabilities.MCP["real"]; !ok || m.ChatMode != config.MCPServerModeManual {
		t.Errorf("capabilities.mcp[real] = %+v (present %t), want chat manual", m, ok)
	}
	reloaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("reload persisted config: %v", err)
	}
	if _, ok := reloaded.Capabilities.MCP["stale"]; ok {
		t.Error("persisted YAML carries the stale capabilities.mcp name")
	}
}

// TestUpdateCapabilityModes_DropsBothAndNormalizes verifies that entries
// whose values are both empty are dropped as meaningless while the remaining
// entries are normalized (empty → "auto") exactly like the load pipeline.
func TestUpdateCapabilityModes_DropsBothAndNormalizes(t *testing.T) {
	f, _, _ := newTestAPI(t)
	err := f.UpdateCapabilityModes(CapabilitySectionAgents, map[string]CapabilityModesInfo{
		"empty-entry": {},
		"partial":     {ChatMode: config.MCPServerModeManual},
		"explicit":    {ChatMode: config.MCPServerModeAuto, CodeMode: config.MCPServerModeAuto},
	})
	if err != nil {
		t.Fatalf("UpdateCapabilityModes: %v", err)
	}
	got := f.GetCapabilityModes()
	if _, ok := got.Agents["empty-entry"]; ok {
		t.Error("both-empty entry stored — want dropped")
	}
	if a, ok := got.Agents["partial"]; !ok || a.ChatMode != config.MCPServerModeManual || a.CodeMode != config.MCPServerModeAuto {
		t.Errorf("agents[partial] = %+v (present %t), want chat manual / code auto (normalized)", a, ok)
	}
}

// TestUpdateCapabilityModes_EmptyPayloadClearsSection verifies that an empty
// (or nil-mode) payload resets the whole section: no entry survives and the
// YAML omits the section entirely.
func TestUpdateCapabilityModes_EmptyPayloadClearsSection(t *testing.T) {
	f, _, cfgPath := newTestAPI(t)
	if err := f.UpdateCapabilityModes(CapabilitySectionSkills, map[string]CapabilityModesInfo{
		"my-skill": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual},
	}); err != nil {
		t.Fatalf("UpdateCapabilityModes: %v", err)
	}
	if err := f.UpdateCapabilityModes(CapabilitySectionSkills, nil); err != nil {
		t.Fatalf("UpdateCapabilityModes(nil): %v", err)
	}
	got := f.GetCapabilityModes()
	if len(got.Skills) != 0 {
		t.Errorf("skills section = %+v, want empty after a nil payload", got.Skills)
	}
	reloaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("reload persisted config: %v", err)
	}
	if len(reloaded.Capabilities.Skills) != 0 {
		t.Errorf("persisted skills section = %+v, want omitted after a nil payload", reloaded.Capabilities.Skills)
	}
}

// TestUpdateCapabilityModes_NoConfig verifies the uninitialized-config path.
func TestUpdateCapabilityModes_NoConfig(t *testing.T) {
	f := &FrontendAPI{}
	f.seedPublished.Store(true)
	if err := f.UpdateCapabilityModes(CapabilitySectionSkills, nil); err == nil {
		t.Fatal("expected error when config is not initialized")
	}
}

// TestUpdateCapabilityModes_NoLiveBuilder verifies the no-op publication
// branch: with a live config but no builder yet (fresh API before Init),
// the update still mutates and persists — the constructor projects the same
// section from the persisted config at build time, so there is nothing to
// push into and nothing is lost.
func TestUpdateCapabilityModes_NoLiveBuilder(t *testing.T) {
	f, _, cfgPath := newTestAPI(t)
	f.builderOverride = nil
	f.app = nil

	if err := f.UpdateCapabilityModes(CapabilitySectionSkills, map[string]CapabilityModesInfo{
		"my-skill": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual},
	}); err != nil {
		t.Fatalf("UpdateCapabilityModes without a live builder: %v", err)
	}
	if s := f.GetCapabilityModes().Skills["my-skill"]; s.ChatMode != config.MCPServerModeManual {
		t.Errorf("skills[my-skill] = %+v, want the update applied with no builder present", s)
	}
	reloaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("reload persisted config: %v", err)
	}
	if s := reloaded.Capabilities.Skills["my-skill"]; s.ChatMode != config.MCPServerModeManual {
		t.Errorf("persisted skills[my-skill] = %+v, want chat manual", s)
	}
}

// --- wire format ---

// TestMCPServerWireFormatHasNoMode pins the wire contract of the mode
// removal: the JSON wire format carries no `mode` key anywhere — not on the
// server config (UpdateMCPServers input / GetMCPServers output), not on the
// status / mentionable DTOs — while the per-context chat_mode / code_mode
// keys are present where the UI expects them. An incoming `mode` key is
// silently ignored instead of populating the legacy field.
func TestMCPServerWireFormatHasNoMode(t *testing.T) {
	t.Run("server config marshals without mode", func(t *testing.T) {
		raw, err := json.Marshal(config.MCPServerConfig{Command: "cmd", Mode: config.MCPServerModeManual})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if _, ok := decoded["mode"]; ok {
			t.Errorf("MCPServerConfig wire format still carries mode: %s", raw)
		}
	})
	t.Run("incoming mode key is ignored", func(t *testing.T) {
		var cfg config.MCPServerConfig
		if err := json.Unmarshal([]byte(`{"mode":"manual","command":"cmd"}`), &cfg); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if cfg.Mode != "" {
			t.Errorf("wire payload populated the legacy Mode field with %q", cfg.Mode)
		}
		if cfg.Command != "cmd" {
			t.Errorf("Command = %q, want the regular fields unaffected", cfg.Command)
		}
	})
	t.Run("mentionable DTO shape", func(t *testing.T) {
		raw, err := json.Marshal(MCPMentionableServer{
			Name:     "srv",
			ChatMode: config.MCPServerModeManual,
			CodeMode: config.MCPServerModeDisabled,
		})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if _, ok := decoded["mode"]; ok {
			t.Errorf("MCPMentionableServer wire format still carries mode: %s", raw)
		}
		for _, key := range []string{"name", "chat_mode", "code_mode"} {
			if _, ok := decoded[key]; !ok {
				t.Errorf("MCPMentionableServer wire format misses %q: %s", key, raw)
			}
		}
	})
	t.Run("status DTO shape", func(t *testing.T) {
		raw, err := json.Marshal(MCPServerStatusInfo{
			ServerStatus: mcp.ServerStatus{Name: "srv", Transport: "stdio"},
			ChatMode:     config.MCPServerModeAuto,
			CodeMode:     config.MCPServerModeManual,
		})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if _, ok := decoded["mode"]; ok {
			t.Errorf("MCPServerStatusInfo wire format still carries mode: %s", raw)
		}
		for _, key := range []string{"chat_mode", "code_mode", "name"} {
			if _, ok := decoded[key]; !ok {
				t.Errorf("MCPServerStatusInfo wire format misses %q: %s", key, raw)
			}
		}
	})
	t.Run("capabilities info shape", func(t *testing.T) {
		raw, err := json.Marshal(CapabilitiesInfo{
			Skills: map[string]CapabilityModesInfo{
				"my-skill": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeAuto},
			},
		})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		for _, key := range []string{"skills", "agents", "mcp"} {
			if _, ok := decoded[key]; !ok {
				t.Errorf("CapabilitiesInfo wire format misses %q (sections must be non-null): %s", key, raw)
			}
		}
		skills, ok := decoded["skills"].(map[string]any)
		if !ok {
			t.Fatalf("skills section is not an object: %s", raw)
		}
		entry, ok := skills["my-skill"].(map[string]any)
		if !ok {
			t.Fatalf("skills[my-skill] is not an object: %s", raw)
		}
		if entry["chat_mode"] != config.MCPServerModeManual || entry["code_mode"] != config.MCPServerModeAuto {
			t.Errorf("skills[my-skill] = %+v, want chat manual / code auto", entry)
		}
	})
}
