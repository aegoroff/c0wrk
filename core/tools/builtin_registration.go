package tools

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/v0lka/sp4rk/agent"
	sdktools "github.com/v0lka/sp4rk/tools"
	"github.com/v0lka/sp4rk/tools/builtins"
	"github.com/v0lka/sp4rk/tools/builtins/websearch"
)

// BuiltinToolsConfig holds configuration for registering built-in tools.
// All limit and callback types are imported directly from their source packages
// per ADR-008 (no type re-exports).
type BuiltinToolsConfig struct {
	FileLimits    builtins.FileLimits
	RipgrepLimits builtins.RipgrepLimits
	GlobLimits    builtins.GlobLimits
	// GlobLimitsExplicit selects the no-fallback glob constructor (see
	// BuilderToolLimitsConfig.GlobLimitsExplicit): true registers via
	// NewGlobToolWithLimitsOverride so an explicitly all-zero config — the
	// documented "0 disables" on all three glob knobs — is honored verbatim;
	// false keeps NewGlobToolWithLimits, whose zero-struct→defaults fallback
	// protects a fully-unset BuiltinToolsConfig from registering an unbounded
	// walk.
	GlobLimitsExplicit bool
	WebFetchLimits     builtins.WebFetchLimits
	WebSearchLimits    builtins.WebSearchLimits
	BashTimeouts       builtins.BashTimeouts
	ShellBlocklist     []string
	// BashShellInvocation / PoshShellInvocation carry the operator's optional
	// launch-shape override for the shell-exec tool (sp4rk
	// tools.ShellInvocation). Only the platform-matching entry is consumed
	// (bash on Unix, posh on Windows — see newShellExecTool); nil = built-in
	// default launch shape.
	BashShellInvocation *sdktools.ShellInvocation
	PoshShellInvocation *sdktools.ShellInvocation

	// Search provider configuration. SearchAPIKey and SearchBaseURL carry
	// EXPANDED values (${ENV_VAR} patterns already resolved by the caller —
	// see BuilderConfig.ExpandEnvVars).
	SearchProvider string
	SearchAPIKey   string
	SearchBaseURL  string
	SearchTimeout  time.Duration

	// HTTPClient is an optional proxy-configured client for web tools.
	// If nil, tools create their own default clients.
	HTTPClient *http.Client

	// AskUserFunc is the callback for the ask_user tool.
	// If nil, the ask_user tool is not registered.
	AskUserFunc AskUserFunc

	// SilentMode is the security.silent_mode sub-policy posture. When the
	// autonomy mode is silent AND AskUser is "disable" (see AskUserDisabled),
	// the ask_user tool is registered with a nil callback, so a call resolves
	// to the explicit "not available" result and the agent can never block on
	// a question.
	SilentMode SilentModeState

	// AutonomyMode is the security.autonomy_mode posture
	// (standard|assisted|silent). It decides whether the silent-mode
	// sub-policies above are live (only "silent" activates them).
	AutonomyMode string

	// PlanApprovalFunc is the callback for the declare_plan tool's await_approval mode.
	// If nil, declare_plan is still registered but await_approval mode returns an error.
	PlanApprovalFunc ApprovalFunc

	// VectorSearchFunc is the callback for the semantic_search tool.
	// If nil, the semantic_search tool is not registered.
	VectorSearchFunc builtins.VectorSearchFunc

	// VectorSearchWaitFunc blocks until the vector index is ready.
	VectorSearchWaitFunc builtins.VectorSearchWaitFunc

	// Logger is threaded through to tools that log (e.g. the read_file document
	// converter). If nil, those tools fall back to a discard handler.
	Logger *slog.Logger

	// MarkitdownPythonPath lazily resolves the managed venv interpreter used
	// by the read_file document wrapper for vision-assisted conversion (nil
	// or an empty result disables vision assistance; plain conversions are
	// unaffected). Probed at the wrapper's first converter init because the
	// tool-manager installs the venv asynchronously after startup.
	// See BuilderConfig.MarkitdownPythonPath.
	MarkitdownPythonPath func() string
}

// AskUserDisabled reports whether the unattended posture is live AND its
// ask_user sub-policy disables the tool (AutonomyModeSilent + "disable") —
// the single predicate behind ask_user registration suppression, kept in
// lockstep with the config-level SecurityConfig.AskUserDisabled and the
// builder-level BuilderSecurityConfig.AskUserDisabled.
func (c BuiltinToolsConfig) AskUserDisabled() bool {
	return c.AutonomyMode == AutonomyModeSilent && c.SilentMode.AskUser == SilentAskUserDisable
}

// RegisterBuiltinTools creates and registers all built-in tools into the registry.
func RegisterBuiltinTools(registry *ToolRegistry, cfg BuiltinToolsConfig) error {
	// Shell execution (bash_exec on Unix, posh_exec on Windows). The
	// platform-specific constructor call lives in shelltool_{unix,windows}.go
	// behind build tags, because sp4rk's bash.go and posh.go are mutually
	// exclusive per OS.
	shellTool, err := newShellExecTool(cfg.ShellBlocklist, cfg.BashTimeouts, cfg.BashShellInvocation, cfg.PoshShellInvocation)
	if err != nil {
		return fmt.Errorf("shell tool: %w", err)
	}
	registry.Register(shellTool)

	// File operations
	// read_file is wrapped to transparently convert document formats (pdf,
	// docx, pptx, etc.) to markdown via markitdown. Plain-text files delegate
	// to the inner sp4rk ReadFileTool unchanged.
	registry.Register(NewReadFileDocTool(cfg.FileLimits, cfg.Logger, cfg.MarkitdownPythonPath))
	registry.Register(builtins.NewWriteFileTool())
	registry.Register(builtins.NewEditFileTool())
	registry.Register(builtins.NewListDirectoryTool())
	registry.Register(builtins.NewCreateDirectoryTool())
	registry.Register(builtins.NewDeleteDirectoryTool())
	registry.Register(builtins.NewDeleteFileTool())

	// Finish
	registry.Register(agent.NewFinishTool())

	// Web fetch
	registry.Register(builtins.NewWebFetchToolWithClient(cfg.WebFetchLimits, cfg.HTTPClient))

	// Web search (optional)
	searchProvider, err := CreateSearchProviderWithClient(cfg.SearchProvider, cfg.SearchAPIKey, cfg.SearchBaseURL, cfg.SearchTimeout, cfg.HTTPClient)
	if err != nil {
		return err
	}
	if searchProvider != nil {
		registry.Register(websearch.NewTool(searchProvider, cfg.WebSearchLimits))
	}

	// Glob and ripgrep. An explicitly customized glob config goes through the
	// no-fallback constructor so the all-zero "disable every bound" case
	// survives; anything else keeps the zero-struct→defaults fallback.
	if cfg.GlobLimitsExplicit {
		registry.Register(builtins.NewGlobToolWithLimitsOverride(cfg.GlobLimits))
	} else {
		registry.Register(builtins.NewGlobToolWithLimits(cfg.GlobLimits))
	}
	registry.Register(builtins.NewRipgrepToolWithLimits(cfg.RipgrepLimits))

	// Tool result cache reader
	registry.Register(builtins.NewToolResultReadTool())

	// Batch meta-tool
	registry.Register(builtins.NewBatchTool())

	// Step output tools
	registry.Register(builtins.NewReadStepOutputTool())
	registry.Register(builtins.NewListStepOutputsTool())
	registry.Register(builtins.NewReadFinalResultTool())

	// Checklist tool (update_checklist) + inline step completion (declare_step_complete)
	registry.Register(builtins.NewUpdateChecklistTool())
	registry.Register(NewDeclareStepCompleteTool())

	// Fact memory tools
	registry.Register(builtins.NewStoreFactTool())
	registry.Register(builtins.NewSearchFactsTool())

	// Attachment reader — reads user-attached files from the blackboard via
	// the context-injected AttachmentStore. The attachment IDs are surfaced to
	// the LLM in the user message (see Orchestrator.augmentWithAttachments).
	registry.Register(builtins.NewReadAttachmentTool())

	// Semantic search (optional — requires vector index backend)
	if cfg.VectorSearchFunc != nil {
		registry.Register(builtins.NewVectorSearchTool(cfg.VectorSearchFunc, cfg.VectorSearchWaitFunc))
	}

	// Ask user. A nil AskUserFunc (no callback channel — e.g. CLI) means the
	// tool is not registered at all. When silent mode's ask_user sub-policy
	// disables it, the tool IS registered but with a nil callback: a call then
	// resolves to the explicit "ask_user is not available in this mode" result
	// — never blocking the agent — instead of surfacing a missing-tool error.
	if cfg.AskUserFunc != nil {
		askUser := cfg.AskUserFunc
		if cfg.AskUserDisabled() {
			askUser = nil
		}
		registry.Register(NewAskUserTool(askUser))
	}

	// Conductor tools — delegate, cancel_delegation, reflect read their
	// dependencies from the request context (DelegationLauncher, DelegationRegistry,
	// ReflectionRunner), so they are safe to register unconditionally. They are
	// no-ops outside a Conductor run (the context values will be nil).
	registry.Register(NewDelegateTool())
	registry.Register(NewCancelDelegationTool())
	registry.Register(NewReflectTool())

	// Declare plan (approval callback optional; present mode works without it)
	registry.Register(NewDeclarePlanTool(cfg.PlanApprovalFunc))

	// Propose goal — reads the goal proposer from the request context, so it
	// is safe to register unconditionally. It is a no-op outside a Conductor
	// run (the context value will be nil), matching declare_plan's pattern.
	registry.Register(NewProposeGoalTool())

	// Declare goal status — writes a self-evaluation verdict into the
	// context-injected GoalStatusSink. Safe to register unconditionally; it is
	// a no-op outside a goal-loop run (the sink will be nil), matching
	// propose_goal's pattern. Status "met" requires non-empty evidence.
	registry.Register(NewDeclareGoalStatusTool())

	// Declare verification — writes a verifier verdict into the
	// context-injected VerificationSink. Safe to register unconditionally; it
	// is a no-op outside a verification run (the sink will be nil), matching
	// declare_goal_status's pattern. confirmed=true requires non-empty
	// evidence.
	registry.Register(NewDeclareVerificationTool())

	// Execute plan — reads the declared plan from the blackboard via a
	// PlanStepExecutor injected into the Conductor context. No-op outside a
	// Conductor run (the context value will be nil).
	registry.Register(NewExecutePlanTool())

	return nil
}

// CreateSearchProvider creates a search provider based on the configured provider name.
// Returns a nil provider if the provider requires an API key but none is configured,
// and an explicit error when the provider configuration is invalid (e.g. the
// SearXNG instance URL is missing or malformed).
func CreateSearchProvider(providerName, apiKey, baseURL string, timeout time.Duration) (websearch.SearchProvider, error) {
	return CreateSearchProviderWithClient(providerName, apiKey, baseURL, timeout, nil)
}

// CreateSearchProviderWithClient creates a search provider with an optional HTTP client.
// Returns a nil provider (and no error) if the provider requires an API key but none is
// configured — the web_search tool then simply stays unregistered. Returns an explicit
// error when the provider IS configured but its configuration is invalid, so a broken
// search setup can never degrade into a silently missing tool.
// Provider name matching is case-insensitive; unrecognized names fall back to tavily.
func CreateSearchProviderWithClient(providerName, apiKey, baseURL string, timeout time.Duration, client *http.Client) (websearch.SearchProvider, error) {
	switch strings.ToLower(providerName) {
	case "tavily", "":
		if apiKey == "" {
			return nil, nil
		}
		return websearch.NewTavilyProviderWithClient(apiKey, timeout, client), nil
	case "brave":
		if apiKey == "" {
			return nil, nil
		}
		return websearch.NewBraveProviderWithClient(apiKey, timeout, client), nil
	case "exa":
		if apiKey == "" {
			return nil, nil
		}
		return websearch.NewExaProviderWithClient(apiKey, timeout, client), nil
	case "duckduckgo":
		return websearch.NewDuckDuckGoProviderWithClient(timeout, client), nil
	case "searxng":
		// A self-hosted SearXNG instance is mandatory configuration, unlike
		// the API keys above: a silently missing web_search tool would hide a
		// broken setup, so a missing/invalid instance URL is an explicit
		// error. (backend/config seeds and validates search.base_url too;
		// this is the consumption-time gate for values that reach the builder
		// through paths bypassing the config load — after ${VAR} expansion.)
		if err := validateSearxngBaseURL(baseURL); err != nil {
			return nil, err
		}
		return websearch.NewSearXNGProviderWithClient(baseURL, timeout, client), nil
	default:
		// Unrecognized provider name — treat as tavily.
		if apiKey == "" {
			return nil, nil
		}
		return websearch.NewTavilyProviderWithClient(apiKey, timeout, client), nil
	}
}

// validateSearxngBaseURL checks an EXPANDED SearXNG instance URL: it must be
// set and parse as an absolute http(s) URL with a host.
func validateSearxngBaseURL(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return fmt.Errorf("search.provider searxng requires search.base_url (the SearXNG instance URL, e.g. %s)", websearch.DefaultSearxngBaseURL)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("search.base_url %q is not a valid URL: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("search.base_url %q must be an absolute http(s) URL, got scheme %q", raw, u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("search.base_url %q must be an absolute http(s) URL with a host", raw)
	}
	return nil
}

// UpdateSearchTool replaces or removes the web_search tool in the registry
// based on the given search configuration.
func UpdateSearchTool(registry *ToolRegistry, providerName, apiKey, baseURL string, limits builtins.WebSearchLimits) error {
	return UpdateSearchToolWithClient(registry, providerName, apiKey, baseURL, limits, nil)
}

// UpdateShellTool re-registers the shell-execution tool (bash_exec on Unix,
// posh_exec on Windows) with an updated command blocklist and launch-shape
// override. The blocklist is compiled into the tool at construction time and
// the invocation shapes the description, so a runtime edit of
// security.groups.execute.blocklist or of the shell_exec config section takes
// effect by replacing the registered instance — mirroring UpdateSearchTool.
// The invocation entries are platform-keyed like BuiltinToolsConfig: only the
// platform-matching one is consumed, nil keeps the built-in default launch
// shape. A pattern that fails to compile or an invalid invocation is reported
// as an error and leaves the previously registered tool in place.
func UpdateShellTool(registry *ToolRegistry, blocklist []string, timeouts builtins.BashTimeouts, bashInvocation, poshInvocation *sdktools.ShellInvocation) error {
	shellTool, err := newShellExecTool(blocklist, timeouts, bashInvocation, poshInvocation)
	if err != nil {
		return fmt.Errorf("shell tool: %w", err)
	}
	registry.Register(shellTool)
	return nil
}

// UpdateSearchToolWithClient replaces or removes the web_search tool in the registry
// with an optional HTTP client for proxy support. An invalid provider
// configuration (e.g. a missing SearXNG instance URL) is an error and leaves
// the previously registered tool in place.
func UpdateSearchToolWithClient(registry *ToolRegistry, providerName, apiKey, baseURL string, limits builtins.WebSearchLimits, client *http.Client) error {
	provider, err := CreateSearchProviderWithClient(providerName, apiKey, baseURL, limits.Timeout, client)
	if err != nil {
		return fmt.Errorf("web_search provider: %w", err)
	}
	if provider != nil {
		registry.Register(websearch.NewTool(provider, limits))
	} else {
		registry.Unregister("web_search")
	}
	return nil
}

// UpdateWebFetchTool replaces the web_fetch tool in the registry with an optional HTTP client.
func UpdateWebFetchTool(registry *ToolRegistry, limits builtins.WebFetchLimits, client *http.Client) {
	registry.Register(builtins.NewWebFetchToolWithClient(limits, client))
}
