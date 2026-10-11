package backend

import (
	"os"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
	sdktools "github.com/v0lka/sp4rk/tools"
	"github.com/v0lka/sp4rk/tools/mcp"
	"gopkg.in/yaml.v3"
)

// --- UpdateMCPServers locking ---

// TestUpdateMCPServers_ReadersNotBlockedDuringReconfigure verifies that
// GetConfig completes while UpdateMCPServers is inside its propagation
// phase. That phase (ReconfigureMCP) reconnects every changed server and
// retries every previously-failed one with no deadline of its own; the whole
// update used to hold configMu.Lock across it, convoying every reader — the
// settings dialog froze for as long as the reconfigure took (observed at
// 169 s). Mirrors TestUpdateProxySettings_ReadersNotBlockedDuringRebuild.
func TestUpdateMCPServers_ReadersNotBlockedDuringReconfigure(t *testing.T) {
	f, mock, _ := newTestAPI(t)
	f.config.MCP = config.MCPConfig{Servers: make(map[string]config.MCPServerConfig)}

	reconfigureStarted := make(chan struct{})
	release := make(chan struct{})
	mock.reconfigureMCPHook = func() {
		select {
		case <-reconfigureStarted:
		default:
			close(reconfigureStarted)
		}
		<-release // hold the propagation phase open
	}

	updateDone := make(chan error, 1)
	go func() {
		updateDone <- f.UpdateMCPServers(map[string]config.MCPServerConfig{
			"test-server": {Transport: "stdio", Command: "cmd"},
		})
	}()

	select {
	case <-reconfigureStarted:
	case <-time.After(10 * time.Second):
		t.Fatal("MCP reconfigure phase never started")
	}

	// A reader must return promptly and observe the already-applied mutation.
	readerDone := make(chan map[string]config.MCPServerConfig, 1)
	go func() { readerDone <- f.GetMCPServers() }()

	select {
	case servers := <-readerDone:
		if _, ok := servers["test-server"]; !ok {
			t.Error("GetMCPServers did not observe the applied MCP mutation")
		}
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("GetMCPServers blocked while UpdateMCPServers was in its reconfigure phase — configMu lock convoy present")
	}

	// A WRITER must get in too. Two readers never block each other, but a
	// queued writer also stops every subsequent reader — that is what froze
	// the dialog.
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		f.configMu.Lock()
		f.configLoadErrors = nil
		f.configMu.Unlock()
	}()
	select {
	case <-writerDone:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("a config writer blocked while UpdateMCPServers was in its reconfigure phase")
	}

	close(release)
	select {
	case err := <-updateDone:
		if err != nil {
			t.Fatalf("UpdateMCPServers: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("UpdateMCPServers did not return after the hook was released")
	}
}

// The reconfigure phase must be bounded. UpdateMCPServers hands its context
// to ReconfigureMCP, whose server.Connect honours it, so one unreachable
// endpoint can no longer stall the update indefinitely.
func TestUpdateMCPServers_ReconfigureContextBounded(t *testing.T) {
	f, mock, _ := newTestAPI(t)
	f.config.MCP = config.MCPConfig{Servers: make(map[string]config.MCPServerConfig)}

	if err := f.UpdateMCPServers(map[string]config.MCPServerConfig{
		"test-server": {Transport: "stdio", Command: "cmd"},
	}); err != nil {
		t.Fatalf("UpdateMCPServers: %v", err)
	}

	ctx := mock.ReconfigureMCPCtx()
	if ctx == nil {
		t.Fatal("ReconfigureMCP received no context")
	}
	if _, ok := ctx.Deadline(); !ok {
		t.Fatal("ReconfigureMCP received a context with no deadline — one unreachable MCP endpoint can stall the update indefinitely")
	}
}

func TestUpdateMCPServers_PersistsAndReconfigures(t *testing.T) {
	f, mock, _ := newTestAPI(t)
	// Initialize MCP config section.
	f.config.MCP = config.MCPConfig{
		Servers: make(map[string]config.MCPServerConfig),
	}

	err := f.UpdateMCPServers(map[string]config.MCPServerConfig{
		"test-server": {Command: "cmd", Args: []string{"--arg"}},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mock.reconfigureMCPCalls != 1 {
		t.Errorf("ReconfigureMCP called %d times, want 1", mock.reconfigureMCPCalls)
	}
	if _, ok := f.config.MCP.Servers["test-server"]; !ok {
		t.Error("test-server not persisted in config")
	}
}

func TestUpdateMCPServers_InvalidStdioNoCommand(t *testing.T) {
	f, mock, _ := newTestAPI(t)
	f.config.MCP = config.MCPConfig{
		Servers: make(map[string]config.MCPServerConfig),
	}

	err := f.UpdateMCPServers(map[string]config.MCPServerConfig{
		"bad": {Transport: "stdio", Command: ""},
	})
	if err == nil {
		t.Fatal("expected validation error for empty command")
	}
	if mock.reconfigureMCPCalls != 0 {
		t.Error("ReconfigureMCP should not be called on invalid input")
	}
}

func TestUpdateMCPServers_InvalidHTTPNoURL(t *testing.T) {
	f, _, _ := newTestAPI(t)
	f.config.MCP = config.MCPConfig{Servers: make(map[string]config.MCPServerConfig)}

	err := f.UpdateMCPServers(map[string]config.MCPServerConfig{
		"bad-http": {Transport: "http", URL: ""},
	})
	if err == nil {
		t.Fatal("expected validation error for empty URL on http transport")
	}
}

func TestUpdateMCPServers_UnsupportedTransport(t *testing.T) {
	f, _, _ := newTestAPI(t)
	f.config.MCP = config.MCPConfig{Servers: make(map[string]config.MCPServerConfig)}

	err := f.UpdateMCPServers(map[string]config.MCPServerConfig{
		"bad": {Transport: "grpc", Command: "cmd"},
	})
	if err == nil {
		t.Fatal("expected error for unsupported transport")
	}
}

func TestUpdateMCPServers_DeepCopy(t *testing.T) {
	f, _, _ := newTestAPI(t)
	f.config.MCP = config.MCPConfig{Servers: make(map[string]config.MCPServerConfig)}

	args := []string{"--port", "9000"}
	env := map[string]string{"KEY": "VAL"}
	err := f.UpdateMCPServers(map[string]config.MCPServerConfig{
		"srv": {Command: "cmd", Args: args, Env: env},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Mutate the caller's slice + map after the call.
	args[0] = "MUTATED"
	env["KEY"] = "MUTATED"

	stored := f.config.MCP.Servers["srv"]
	if stored.Args[0] == "MUTATED" {
		t.Error("stored Args[0] was mutated — deep copy missing")
	}
	if stored.Env["KEY"] == "MUTATED" {
		t.Error("stored Env['KEY'] was mutated — deep copy missing")
	}
}

// yamlMCPServers parses a persisted config file and returns its
// mcp.servers mapping, for key-level assertions on the legacy mode key (a
// substring check would false-positive on the unrelated silent-mode
// `mode:` YAML keys).
func yamlMCPServers(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read persisted config: %v", err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse persisted config: %v", err)
	}
	mcpSection, _ := doc["mcp"].(map[string]any)
	servers, _ := mcpSection["servers"].(map[string]any)
	return servers
}

// TestUpdateMCPServers_WipesLegacyMode pins the RPC-side guarantee that the
// legacy per-server activation key cannot be (re)introduced through
// UpdateMCPServers: the wire format stopped carrying it (json:"-") and even
// a Go-native caller's value is wiped, so the persisted YAML can never grow
// a mode key next to the capabilities entry it migrated into.
func TestUpdateMCPServers_WipesLegacyMode(t *testing.T) {
	f, _, cfgPath := newTestAPI(t)
	f.config.MCP = config.MCPConfig{Servers: make(map[string]config.MCPServerConfig)}

	err := f.UpdateMCPServers(map[string]config.MCPServerConfig{
		"srv": {Command: "cmd", Mode: config.MCPServerModeManual},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stored := f.config.MCP.Servers["srv"].Mode; stored != "" {
		t.Errorf("stored Mode = %q, want wiped (activation modes live in capabilities.mcp now)", stored)
	}
	srv, ok := yamlMCPServers(t, cfgPath)["srv"].(map[string]any)
	if !ok {
		t.Fatal("persisted YAML has no mcp.servers.srv entry")
	}
	if _, ok := srv["mode"]; ok {
		t.Errorf("persisted mcp.servers.srv carries a mode key: %+v", srv)
	}
}

// yamlCapabilitiesMCP parses a persisted config file and returns its
// capabilities.mcp mapping, for key-level assertions on the raw stored
// section (config.Load would normalize the section on the way in and hide
// orphans, so the durable bytes must be checked directly).
func yamlCapabilitiesMCP(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read persisted config: %v", err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse persisted config: %v", err)
	}
	caps, _ := doc["capabilities"].(map[string]any)
	mcpSection, _ := caps["mcp"].(map[string]any)
	return mcpSection
}

// TestUpdateMCPServers_TrimsOrphanedCapabilities pins the name invariant
// between the two sections: a capabilities.mcp entry exists only for a name
// in mcp.servers. UpdateMCPServers replaces the server set wholesale, so a
// server dropped from the payload must lose its modes entry too — from the
// in-memory config, from the persisted YAML (Save writes the section
// verbatim, so only this trim keeps the durable bytes clean), and from the
// GetCapabilityModes wire view. A stale entry predating the update is
// included to prove the trim is a full sweep against the new server set,
// not just the payload delta.
func TestUpdateMCPServers_TrimsOrphanedCapabilities(t *testing.T) {
	f, mock, cfgPath := newTestAPI(t)
	f.config.MCP = config.MCPConfig{Servers: map[string]config.MCPServerConfig{
		"keeper": {Transport: "stdio", Command: "cmd"},
		"doomed": {Transport: "stdio", Command: "cmd"},
	}}
	f.config.Capabilities.MCP = map[string]config.CapabilityModes{
		"keeper": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeDisabled},
		"doomed": {ChatMode: config.MCPServerModeDisabled, CodeMode: config.MCPServerModeDisabled},
		"ghost":  {ChatMode: config.MCPServerModeManual}, // orphaned before the update
	}

	err := f.UpdateMCPServers(map[string]config.MCPServerConfig{
		"keeper": {Transport: "stdio", Command: "cmd"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mock.reconfigureMCPCalls != 1 {
		t.Errorf("ReconfigureMCP called %d times, want 1", mock.reconfigureMCPCalls)
	}

	for _, name := range []string{"doomed", "ghost"} {
		if _, ok := f.config.Capabilities.MCP[name]; ok {
			t.Errorf("in-memory capabilities.mcp still has %q after its server was removed", name)
		}
	}
	if got, ok := f.config.Capabilities.MCP["keeper"]; !ok {
		t.Error("in-memory capabilities.mcp lost keeper — surviving names must keep their entry")
	} else if got != (config.CapabilityModes{ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeDisabled}) {
		t.Errorf("keeper modes = %+v, want the stored values untouched", got)
	}

	persisted := yamlCapabilitiesMCP(t, cfgPath)
	for _, name := range []string{"doomed", "ghost"} {
		if _, ok := persisted[name]; ok {
			t.Errorf("persisted capabilities.mcp still has orphan %q: %+v", name, persisted)
		}
	}
	if _, ok := persisted["keeper"]; !ok {
		t.Errorf("persisted capabilities.mcp lost keeper: %+v", persisted)
	}

	got := f.GetCapabilityModes()
	for _, name := range []string{"doomed", "ghost"} {
		if _, ok := got.MCP[name]; ok {
			t.Errorf("GetCapabilityModes still reports %q after its server was removed", name)
		}
	}
	if _, ok := got.MCP["keeper"]; !ok {
		t.Error("GetCapabilityModes lost keeper")
	}
}

// TestUpdateMCPServers_NilServersClearCapabilities pins the nil-payload
// reading of the same invariant: replacing the server set with nothing
// clears the whole capabilities.mcp section — nil in memory and absent from
// the persisted YAML — rather than leaving modes for servers that no longer
// exist.
func TestUpdateMCPServers_NilServersClearCapabilities(t *testing.T) {
	f, _, cfgPath := newTestAPI(t)
	f.config.MCP = config.MCPConfig{Servers: map[string]config.MCPServerConfig{
		"srv": {Transport: "stdio", Command: "cmd"},
	}}
	f.config.Capabilities.MCP = map[string]config.CapabilityModes{
		"srv": {ChatMode: config.MCPServerModeManual},
	}

	if err := f.UpdateMCPServers(nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(f.config.Capabilities.MCP) != 0 {
		t.Errorf("in-memory capabilities.mcp = %+v, want empty after a nil server payload", f.config.Capabilities.MCP)
	}
	if persisted := yamlCapabilitiesMCP(t, cfgPath); len(persisted) != 0 {
		t.Errorf("persisted capabilities.mcp = %+v, want absent/empty after a nil server payload", persisted)
	}
}

// --- GetMCPServers ---

func TestGetMCPServers_DeepCopy(t *testing.T) {
	f, _, _ := newTestAPI(t)
	f.config.MCP = config.MCPConfig{
		Servers: map[string]config.MCPServerConfig{
			"srv": {Command: "cmd", Args: []string{"a"}, Env: map[string]string{"K": "V"}},
		},
	}

	got := f.GetMCPServers()
	got["srv"] = config.MCPServerConfig{Command: "HACK"} // mutate returned map

	// Internal config must NOT be affected.
	if f.config.MCP.Servers["srv"].Command != "cmd" {
		t.Error("GetMCPServers returned a live reference instead of a deep copy")
	}
}

// --- mcpConfigSnapshot ---

// TestMCPConfigSnapshot verifies the coherent one-lock view behind
// GetMCPStatus and GetMCPMentionableServers: the server map is a deep copy,
// the capabilities.mcp copy drops stale names, and both maps describe the
// same moment of the config (every caps key resolves to a configured server
// in the same snapshot). Reading the two maps via separate lock acquisitions
// (the former GetMCPServers + capabilitiesSnapshot pairing) let a concurrent
// UpdateMCPServers / UpdateCapabilityModes land in between and pair servers
// of one moment with modes of another.
func TestMCPConfigSnapshot(t *testing.T) {
	f, _, _ := newTestAPI(t)
	f.config.MCP = config.MCPConfig{
		Servers: map[string]config.MCPServerConfig{
			"srv": {Command: "cmd", Args: []string{"a"}, Env: map[string]string{"K": "V"}},
		},
	}
	f.config.Capabilities = config.CapabilitiesConfig{
		MCP: map[string]config.CapabilityModes{
			"srv":   {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeAuto},
			"ghost": {ChatMode: config.MCPServerModeDisabled, CodeMode: config.MCPServerModeDisabled},
		},
	}

	servers, caps := f.mcpConfigSnapshot()

	// Deep copy: mutating the returned snapshot must not touch the live
	// config. Slice elements and map entries are mutated through the shared
	// backing storage; the struct entry itself is replaced wholesale.
	servers["srv"].Args[0] = "HACK"
	servers["srv"].Env["K"] = "HACK"
	servers["srv"] = config.MCPServerConfig{Command: "HACK"}
	if f.config.MCP.Servers["srv"].Command != "cmd" ||
		f.config.MCP.Servers["srv"].Args[0] != "a" ||
		f.config.MCP.Servers["srv"].Env["K"] != "V" {
		t.Error("mcpConfigSnapshot shared the returned map or its args/env backing arrays with the live config")
	}
	if _, ok := caps["ghost"]; ok {
		t.Error("mcpConfigSnapshot kept a capabilities entry for an unconfigured server")
	}
	if got := caps["srv"]; got.ChatMode != config.MCPServerModeManual || got.CodeMode != config.MCPServerModeAuto {
		t.Errorf("caps[srv] = %+v, want chat=%s code=%s", got, config.MCPServerModeManual, config.MCPServerModeAuto)
	}
	// Coherence: every capabilities name has its server in the same snapshot.
	for name := range caps {
		if _, ok := servers[name]; !ok {
			t.Errorf("caps entry %q has no configured server in the same snapshot", name)
		}
	}
}

// TestMCPConfigSnapshot_NoConfig verifies the uninitialized-config safety of
// the snapshot: both maps come back empty, never nil.
func TestMCPConfigSnapshot_NoConfig(t *testing.T) {
	f := &FrontendAPI{} // f.config == nil
	f.seedPublished.Store(true)
	f.seedPublished.Store(true)

	servers, caps := f.mcpConfigSnapshot()
	if servers == nil || caps == nil {
		t.Fatalf("expected non-nil empty maps, got servers=%v caps=%v", servers, caps)
	}
	if len(servers) != 0 || len(caps) != 0 {
		t.Errorf("expected empty maps, got servers=%v caps=%v", servers, caps)
	}
}

// --- GetMCPStatus ---

// TestGetMCPStatus_NoApp verifies the nil-app early return.
//
// The remaining branches of GetMCPStatus (the non-blocking Starting-placeholder
// while MCPStartupDone()==false, the startup-error placeholder, and the live
// gateway status) are exercised indirectly through the core builder
// tests in core/builder_mcp_test.go (TestMCPStartupDone, TestMCPGatewayNoWait),
// which verify the exact builder methods Application.GetMCPStatus delegates to.
// Constructing an Application with MCPStartupDone()==false from this package is
// not feasible without a racy NewOrchestratorBuilder call: the mcpDone channel
// and gateway field are private to core, so the placeholder state cannot be set
// deterministically from the backend package.
func TestGetMCPStatus_NoApp(t *testing.T) {
	f := &FrontendAPI{} // f.app == nil
	f.seedPublished.Store(true)
	f.seedPublished.Store(true)
	got := f.GetMCPStatus()
	if got == nil {
		t.Fatal("expected non-nil empty slice")
	}
	if len(got) != 0 {
		t.Errorf("expected empty slice, got %d", len(got))
	}
}

// --- GetMCPStatus merge (configured servers always visible) ---

// TestMergeConfiguredMCPServers verifies the pure core of the
// "configured servers are always visible" contract: every configured name
// missing from the live gateway status is appended as a disconnected entry
// with a defaulted transport, every entry is enriched with its configured
// mode (gateway-only names default to "auto"), and the result stays sorted
// by name.
func TestMergeConfiguredMCPServers(t *testing.T) {
	status := []mcp.ServerStatus{
		{Name: "live", Transport: "stdio", Connected: true, Tools: []string{}},
		{Name: "dead", Transport: "http", Connected: false, Tools: []string{}, Error: "conn refused"},
		{Name: "ghost", Transport: "stdio", Connected: true, Tools: []string{}}, // gateway-only name
	}
	configured := map[string]config.MCPServerConfig{
		"live":    {Transport: "stdio", Command: "cmd"},
		"dead":    {Transport: "http", URL: "http://x"},
		"unknown": {Command: "cmd"}, // transport empty → defaults to stdio
		"remote":  {Transport: "http", URL: "http://y"},
	}
	caps := map[string]config.CapabilityModes{
		"dead": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual},
		// Per-context independence: the two contexts resolve separately.
		"remote": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeDisabled},
	}

	got := mergeConfiguredMCPServers(status, configured, caps)

	if len(got) != 5 {
		t.Fatalf("expected 5 entries, got %d: %+v", len(got), got)
	}
	// Sorted by name: dead, ghost, live, remote, unknown.
	wantOrder := []string{"dead", "ghost", "live", "remote", "unknown"}
	for i, want := range wantOrder {
		if got[i].Name != want {
			t.Errorf("got[%d].Name = %q, want %q", i, got[i].Name, want)
		}
	}
	// Existing entries must pass through untouched.
	if !got[2].Connected || got[2].Name != "live" {
		t.Errorf("live server status mutated: %+v", got[2])
	}
	// Missing configured servers are synthesized as disconnected.
	unknown := got[4]
	if unknown.Connected || unknown.Error != "unavailable" || unknown.Transport != "stdio" {
		t.Errorf("unknown = %+v, want disconnected stdio entry with error", unknown)
	}
	remote := got[3]
	if remote.Connected || remote.Transport != "http" {
		t.Errorf("remote = %+v, want disconnected http entry", remote)
	}
	// Mode exposure: configured capabilities are normalized onto every entry,
	// and a gateway-only name (not in the config) defaults to auto/auto.
	wantModes := map[string][2]string{
		"dead":    {config.MCPServerModeManual, config.MCPServerModeManual},
		"ghost":   {config.MCPServerModeAuto, config.MCPServerModeAuto},
		"live":    {config.MCPServerModeAuto, config.MCPServerModeAuto},
		"remote":  {config.MCPServerModeManual, config.MCPServerModeDisabled},
		"unknown": {config.MCPServerModeAuto, config.MCPServerModeAuto},
	}
	for _, entry := range got {
		want := wantModes[entry.Name]
		if entry.ChatMode != want[0] || entry.CodeMode != want[1] {
			t.Errorf("%s modes = {%q, %q}, want {%q, %q}",
				entry.Name, entry.ChatMode, entry.CodeMode, want[0], want[1])
		}
	}
}

// TestMergeConfiguredMCPServers_DisabledNeutral pins the neutral rendering
// contract for disabled servers in BOTH shapes it can take:
//   - configured-but-absent (the normal case — the gateway config never
//     includes it, so the synthesized entry must carry NO "unavailable"
//     error: absence is what "never dialed" produces);
//   - still reported by a stale gateway (a reconfigure that failed
//     mid-flight can leave the old connection behind) — the config mode is
//     authoritative, so connected/tools/error are cleared.
func TestMergeConfiguredMCPServers_DisabledNeutral(t *testing.T) {
	status := []mcp.ServerStatus{
		{
			Name:      "stale-disabled",
			Transport: "stdio",
			Connected: true,
			Unhealthy: true,
			ToolCount: 3,
			Tools:     []string{"t1", "t2", "t3"},
			Error:     "old error",
		},
	}
	configured := map[string]config.MCPServerConfig{
		"stale-disabled": {Transport: "stdio", Command: "cmd"},
		"fresh-disabled": {Transport: "http", URL: "http://x"},
		"normal":         {Transport: "stdio", Command: "cmd"},
	}
	// Neutralization keys on BOTH contexts being disabled — the only
	// combination under which the server is never dialed.
	caps := map[string]config.CapabilityModes{
		"stale-disabled": {ChatMode: config.MCPServerModeDisabled, CodeMode: config.MCPServerModeDisabled},
		"fresh-disabled": {ChatMode: config.MCPServerModeDisabled, CodeMode: config.MCPServerModeDisabled},
	}

	got := mergeConfiguredMCPServers(status, configured, caps)

	if len(got) != 3 {
		t.Fatalf("expected 3 entries, got %d: %+v", len(got), got)
	}
	byName := make(map[string]MCPServerStatusInfo, len(got))
	for _, entry := range got {
		byName[entry.Name] = entry
	}
	for _, name := range []string{"stale-disabled", "fresh-disabled"} {
		entry := byName[name]
		if entry.ChatMode != config.MCPServerModeDisabled || entry.CodeMode != config.MCPServerModeDisabled {
			t.Errorf("%s modes = {%q, %q}, want {%q, %q}",
				name, entry.ChatMode, entry.CodeMode,
				config.MCPServerModeDisabled, config.MCPServerModeDisabled)
		}
		if entry.Connected || entry.Unhealthy || entry.Starting {
			t.Errorf("%s = %+v, want every activity flag cleared (inert, not live)", name, entry.ServerStatus)
		}
		if entry.ToolCount != 0 || len(entry.Tools) != 0 {
			t.Errorf("%s = %+v, want tools cleared", name, entry.ServerStatus)
		}
		if entry.Error != "" {
			t.Errorf("%s.Error = %q, want empty (neutral — disabled is not a failure state)", name, entry.Error)
		}
	}
	// A server disabled in only ONE context stays live for the other — no
	// neutralization, even though it may be absent from the gateway status.
	partiallyDisabled := map[string]config.CapabilityModes{
		"stale-disabled": {ChatMode: config.MCPServerModeDisabled, CodeMode: config.MCPServerModeManual},
	}
	partial := mergeConfiguredMCPServers(status, configured, partiallyDisabled)
	byName = make(map[string]MCPServerStatusInfo, len(partial))
	for _, entry := range partial {
		byName[entry.Name] = entry
	}
	if entry := byName["stale-disabled"]; entry.Error != "old error" {
		t.Errorf("partially disabled stale entry Error = %q, want the live status kept (%q)",
			entry.Error, "old error")
	}
	// A non-disabled configured-but-absent server keeps the classic
	// "unavailable" synthesis — only the both-disabled render neutrally.
	if normal := byName["normal"]; normal.Error != "unavailable" {
		t.Errorf("normal.Error = %q, want %q (disabled-only neutralization)", normal.Error, "unavailable")
	}
}

// TestMergeConfiguredMCPServers_EmptyConfig verifies that an empty (or nil)
// configuration leaves the gateway status entries as-is (capabilities
// defaulting to auto/auto on each).
func TestMergeConfiguredMCPServers_EmptyConfig(t *testing.T) {
	status := []mcp.ServerStatus{{Name: "live", Connected: true}}
	got := mergeConfiguredMCPServers(status, nil, nil)
	if len(got) != 1 {
		t.Errorf("expected untouched status for nil config, got %+v", got)
	}
	if got[0].ChatMode != config.MCPServerModeAuto || got[0].CodeMode != config.MCPServerModeAuto {
		t.Errorf("live modes = {%q, %q}, want auto/auto", got[0].ChatMode, got[0].CodeMode)
	}
	got = mergeConfiguredMCPServers(status, map[string]config.MCPServerConfig{}, map[string]config.CapabilityModes{})
	if len(got) != 1 {
		t.Errorf("expected untouched status for empty config, got %+v", got)
	}
}

// --- GetMCPMentionableServers ---

// TestGetMCPMentionableServers verifies the secret-free mentionable listing:
// every configured server as {name, chat_mode, code_mode}, sorted by name,
// with modes normalized (empty resolves to "auto"). The wire shape carries
// nothing beyond name+modes — the struct itself is the guarantee that
// command args, env and headers (which can embed secrets) never reach the
// completion path.
func TestGetMCPMentionableServers(t *testing.T) {
	f, _, _ := newTestAPI(t)
	f.config.MCP = config.MCPConfig{
		Servers: map[string]config.MCPServerConfig{
			"zeta":   {Transport: "stdio", Command: "cmd"},
			"alpha":  {Transport: "http", URL: "http://x"},
			"mid":    {Transport: "stdio", Command: "cmd"},
			"empty":  {Transport: "stdio", Command: "cmd"},
			"bearer": {Transport: "stdio", Command: "cmd", Env: map[string]string{"TOKEN": "secret"}},
		},
	}
	f.config.Capabilities = config.CapabilitiesConfig{
		MCP: map[string]config.CapabilityModes{
			"zeta":  {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual},
			"alpha": {ChatMode: config.MCPServerModeDisabled, CodeMode: config.MCPServerModeDisabled},
			"mid":   {ChatMode: config.MCPServerModeAuto, CodeMode: config.MCPServerModeAuto},
			// A stale entry (no such server) must not leak into the listing.
			"ghost": {ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual},
		},
	}

	got := f.GetMCPMentionableServers()

	want := []MCPMentionableServer{
		{Name: "alpha", ChatMode: config.MCPServerModeDisabled, CodeMode: config.MCPServerModeDisabled},
		{Name: "bearer", ChatMode: config.MCPServerModeAuto, CodeMode: config.MCPServerModeAuto},
		{Name: "empty", ChatMode: config.MCPServerModeAuto, CodeMode: config.MCPServerModeAuto},
		{Name: "mid", ChatMode: config.MCPServerModeAuto, CodeMode: config.MCPServerModeAuto},
		{Name: "zeta", ChatMode: config.MCPServerModeManual, CodeMode: config.MCPServerModeManual},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d mentionable servers, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("got[%d] = %+v, want %+v", i, got[i], w)
		}
	}
}

// TestGetMCPMentionableServers_NoConfig verifies the uninitialized-config
// early return: an empty (never nil) slice, not a null payload.
func TestGetMCPMentionableServers_NoConfig(t *testing.T) {
	f := &FrontendAPI{} // f.config == nil
	f.seedPublished.Store(true)
	f.seedPublished.Store(true)
	got := f.GetMCPMentionableServers()
	if got == nil {
		t.Fatal("expected non-nil empty slice")
	}
	if len(got) != 0 {
		t.Errorf("expected empty slice, got %d entries", len(got))
	}
}

// TestIsMCPStartupPlaceholder pins the placeholder detection that suppresses
// the config merge while the gateway is still starting.
func TestIsMCPStartupPlaceholder(t *testing.T) {
	starting := []mcp.ServerStatus{{Name: "_gateway", Starting: true}}
	if !isMCPStartupPlaceholder(starting) {
		t.Error("starting placeholder not detected")
	}
	failed := []mcp.ServerStatus{{Name: "_gateway", Error: "boom"}}
	if isMCPStartupPlaceholder(failed) {
		t.Error("startup-error placeholder must not be treated as starting (config merge must apply)")
	}
	live := []mcp.ServerStatus{{Name: "srv", Connected: true}}
	if isMCPStartupPlaceholder(live) {
		t.Error("live status must not be treated as placeholder")
	}
	if isMCPStartupPlaceholder(nil) {
		t.Error("nil status must not be treated as placeholder")
	}
}

// --- GetToolList ---

func TestGetToolList_NoApp(t *testing.T) {
	f := &FrontendAPI{} // f.app == nil
	f.seedPublished.Store(true)
	f.seedPublished.Store(true)
	got := f.GetToolList()
	if got == nil {
		t.Fatal("expected non-nil empty slice")
	}
	if len(got) != 0 {
		t.Errorf("expected empty slice when app is nil, got %d", len(got))
	}
}

func TestGetToolList_BuildToolInfos(t *testing.T) {
	// buildToolInfos is the pure core of GetToolList (the full method needs a
	// live Application with heavyweight builder infra). It must skip
	// system-group tools BY GROUP, label every tool with its group, and
	// resolve the effective policy from the live registry map.
	descriptors := []sdktools.ToolDescriptor{
		{Name: "bash_exec", Description: "shell", Source: "core", Group: sdktools.GroupExecute},
		{Name: "read_file", Description: "read", Source: "core", Group: sdktools.GroupLocalRead},
		{Name: "finish", Description: "internal", Source: "core", Group: sdktools.GroupSystem},
		{Name: "mcp_query", Description: "mcp tool", Source: "mcp:test-server", Group: sdktools.GroupLocalMCP},
		{Name: "web_fetch", Description: "web", Source: "core", Group: sdktools.GroupRemoteRead},
	}
	policies := map[sdktools.ToolGroup]sdktools.ToolPolicy{
		sdktools.GroupExecute:   sdktools.PolicyAlwaysDeny,
		sdktools.GroupLocalRead: sdktools.PolicyAlwaysAllow,
		sdktools.GroupLocalMCP:  sdktools.PolicyUserConfirm,
		// GroupRemoteRead deliberately absent → fail-safe user_confirm.
	}

	got := buildToolInfos(descriptors, policies)

	byName := make(map[string]ToolInfo, len(got))
	for _, info := range got {
		byName[info.Name] = info
	}
	if _, ok := byName["finish"]; ok {
		t.Error("system-group tool 'finish' must be filtered out by group")
	}
	if len(got) != 4 {
		t.Fatalf("expected 4 tools after filtering, got %d: %+v", len(got), got)
	}

	exec := byName["bash_exec"]
	if exec.Group != "execute" || exec.Policy != "deny" {
		t.Errorf("bash_exec = group %q policy %q, want execute/deny", exec.Group, exec.Policy)
	}
	read := byName["read_file"]
	if read.Group != "local_read" || read.Policy != "allow" {
		t.Errorf("read_file = group %q policy %q, want local_read/allow", read.Group, read.Policy)
	}
	mcpTool := byName["mcp_query"]
	if mcpTool.Group != "local_mcp" || mcpTool.Policy != "user_confirm" {
		t.Errorf("mcp_query = group %q policy %q, want local_mcp/user_confirm", mcpTool.Group, mcpTool.Policy)
	}
	// A group without a registry entry fails safe to user_confirm.
	web := byName["web_fetch"]
	if web.Policy != "user_confirm" {
		t.Errorf("web_fetch policy = %q, want fail-safe user_confirm", web.Policy)
	}
}

// --- validateMCPServerConfig ---

func TestValidateMCPServerConfig(t *testing.T) {
	tests := []struct {
		name    string
		cfg     config.MCPServerConfig
		wantErr bool
	}{
		{name: "stdio valid", cfg: config.MCPServerConfig{Command: "cmd"}, wantErr: false},
		{name: "stdio no command", cfg: config.MCPServerConfig{Transport: "stdio"}, wantErr: true},
		{name: "http valid", cfg: config.MCPServerConfig{Transport: "http", URL: "http://x"}, wantErr: false},
		{name: "http no url", cfg: config.MCPServerConfig{Transport: "http"}, wantErr: true},
		{name: "unknown transport", cfg: config.MCPServerConfig{Transport: "grpc"}, wantErr: true},
		{name: "default transport needs command", cfg: config.MCPServerConfig{}, wantErr: true},
		{name: "empty timeouts ok", cfg: config.MCPServerConfig{Command: "cmd", Timeout: "", CallTimeout: ""}, wantErr: false},
		{name: "valid timeout", cfg: config.MCPServerConfig{Command: "cmd", Timeout: "30s"}, wantErr: false},
		{name: "valid call_timeout", cfg: config.MCPServerConfig{Command: "cmd", CallTimeout: "2m"}, wantErr: false},
		{name: "invalid timeout", cfg: config.MCPServerConfig{Command: "cmd", Timeout: "abc"}, wantErr: true},
		{name: "zero timeout", cfg: config.MCPServerConfig{Command: "cmd", Timeout: "0s"}, wantErr: true},
		{name: "negative timeout", cfg: config.MCPServerConfig{Command: "cmd", Timeout: "-5s"}, wantErr: true},
		{name: "invalid call_timeout", cfg: config.MCPServerConfig{Command: "cmd", CallTimeout: "abc"}, wantErr: true},
		{name: "zero call_timeout", cfg: config.MCPServerConfig{Command: "cmd", CallTimeout: "0s"}, wantErr: true},
		{name: "negative call_timeout", cfg: config.MCPServerConfig{Command: "cmd", CallTimeout: "-5s"}, wantErr: true},
		// Activation modes are NOT validated here: the wire format no longer
		// carries mode, and the per-context values gate on their own save
		// path (UpdateCapabilityModes → config.ValidateCapabilities).
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateMCPServerConfig("test", tt.cfg)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateMCPServerConfig = error %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
