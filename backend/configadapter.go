package backend

import (
	"log/slog"
	"os"
	"path/filepath"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/core"
	"github.com/v0lka/c0wrk/core/proxy"
)

// derefBool safely dereferences a *bool, defaulting to true when nil.
func derefBool(b *bool) bool {
	if b == nil {
		return true
	}
	return *b
}

// loadSLMCatalog loads the full small-LLM profile catalog (predefined ∪
// custom), logging store-level warnings. Callers that must surface warnings
// in the UI instead (config load time) use config.LoadSLMCatalog directly —
// see config.ResolveAndLoad.
func loadSLMCatalog(agentDir string, log *slog.Logger) []config.SLMProfile {
	catalog, warnings := config.LoadSLMCatalog(agentDir)
	if log != nil {
		for _, w := range warnings {
			log.Warn("small-LLM profile warning", "warning", w)
		}
	}
	return catalog
}

// effectiveSLMConfig resolves the persisted `slm:` section against the given
// profile catalog (predefined ∪ custom — see config.LoadSLMCatalog) and
// returns the runtime profile with the master toggle forced off when
// experimental features are disabled. The stored profile choice is preserved
// (only the effective master toggle flips), so re-enabling experimental
// features restores the prior profile. Resolution warnings are returned for
// the caller to surface (load time) or log (runtime re-resolves).
func effectiveSLMConfig(cfg *config.Config, slmCatalog []config.SLMProfile) (profile config.SLMConfig, warnings []string) {
	profile, warnings = config.ResolveSLMConfig(cfg.SLM, slmCatalog)
	if !cfg.Experimental.Enabled {
		profile.Enabled = false
	}
	return profile, warnings
}

// activeSLMProfile returns the catalog entry the persisted `slm:` section
// resolves to, applying the same soft fallback config.ResolveSLMConfig uses
// for the effective values: an empty or dangling active_profile id falls
// back to the model-agnostic "generic" profile. The entry identifies the
// active profile (id + kind) for agent_metrics annotation — reported even
// when the master toggle is off. The zero entry is returned only when even
// "generic" is missing from the catalog (never the case with the shipped
// predefined catalog); the metrics meta then carries no profile fields.
func activeSLMProfile(persist config.SLMPersistConfig, catalog []config.SLMProfile) config.SLMProfile {
	id := persist.ActiveProfile
	if id == "" {
		id = config.SLMGenericProfileID
	}
	if p, ok := config.FindSLMProfile(catalog, id); ok {
		return p
	}
	generic, _ := config.FindSLMProfile(catalog, config.SLMGenericProfileID)
	return generic
}

// ToBuilderConfig converts a *config.Config into a *core.BuilderConfig.
// This is the single conversion point so that core never imports backend/config.
// slmCatalog is the profile catalog (predefined ∪ custom) used to resolve the
// effective small-LLM profile; callers that have an agent dir should build it
// via config.LoadSLMCatalog so custom profiles apply without a restart.
func ToBuilderConfig(cfg *config.Config, slmCatalog []config.SLMProfile) *core.BuilderConfig {
	// Build provider configs map from all enabled providers.
	allProviders := cfg.LLM.GetAllProviderConfigs()
	providerConfigs := make(map[string]core.BuilderProviderConfig, len(allProviders))
	for _, p := range allProviders {
		providerConfigs[p.Name] = core.BuilderProviderConfig{
			ProviderType: p.ProviderType,
			APIKey:       p.APIKey,
			BaseURL:      p.BaseURL,
			Models:       p.Models,

			OutputTokenReserve: p.OutputTokenReserve,
		}
	}

	// Convert model overrides.
	models := make(map[string]core.BuilderModelOverride, len(cfg.LLM.Models))
	for name, m := range cfg.LLM.Models {
		models[name] = core.BuilderModelOverride{
			ContextWindow: m.ContextWindow,
			OutputLimit:   m.OutputLimit,
			TokenizerType: m.TokenizerType,
			Family:        m.Family,
			Protocol:      m.Protocol,
			Capabilities:  m.Capabilities,
		}
	}

	// Convert tool groups (the security schema). The system group is not
	// configurable and config validation already rejects it; entries are
	// copied verbatim — the builder skips anything invalid defensively.
	groups := make(map[string]core.BuilderGroupPolicy, len(cfg.Security.Groups))
	for name, g := range cfg.Security.Groups {
		groups[name] = core.BuilderGroupPolicy{
			Policy:    g.Policy,
			Blacklist: g.Blacklist,
		}
	}
	// Effective view for the core layer: an unset (nil) execute blacklist
	// means the shipped defaults are in force (the same derivation
	// ApplyDefaults applies at load), so a runtime security-settings save
	// that stored "unset" still registers the shell tool with the default
	// patterns. An explicitly emptied list is used as stored. The key is
	// also CREATED when absent: the core consumers of BuilderConfig treat a
	// missing execute entry as an empty blacklist, and the defaults are the
	// fail-safe reading (every other incomplete-config fallback in this
	// schema degrades to user_confirm, not to allow).
	if g, ok := groups[config.ToolGroupExecute]; !ok {
		groups[config.ToolGroupExecute] = core.BuilderGroupPolicy{
			Blacklist: config.DefaultExecuteGroupBlacklist(),
		}
	} else if g.Blacklist == nil {
		g.Blacklist = config.DefaultExecuteGroupBlacklist()
		groups[config.ToolGroupExecute] = g
	}

	// Convert MCP servers.
	mcpServers := make(map[string]core.BuilderMCPServer, len(cfg.MCP.Servers))
	for name, srv := range cfg.MCP.Servers {
		mcpServers[name] = core.BuilderMCPServer{
			Transport: srv.Transport,
			Command:   srv.Command,
			Args:      srv.Args,
			Env:       srv.Env,
			URL:       srv.URL,
			Headers:   srv.Headers,
		}
	}

	// Effective view for the core layer: the E2S mode has no separate master
	// toggle — its availability is exactly the experimental gate, so
	// BuilderE2SConfig.Enabled is mapped from cfg.Experimental.Enabled below
	// (fail-closed). The section's numeric knobs are always seeded so tuning
	// never requires a rebuild.
	//
	// The small-LLM profile is resolved from the active profile in the
	// catalog (the experimental gate is folded in by effectiveSLMConfig;
	// resolution warnings are surfaced at load time, not here).
	slm, _ := effectiveSLMConfig(cfg, slmCatalog)
	return &core.BuilderConfig{
		LLM: core.BuilderLLMConfig{
			DefaultModel:    cfg.LLM.DefaultModel,
			ProviderConfigs: providerConfigs,
			Retry: core.BuilderRetryConfig{
				MaxRetries:     cfg.LLM.Retry.MaxRetries,
				InitialBackoff: cfg.LLM.Retry.InitialBackoff,
				MaxBackoff:     cfg.LLM.Retry.MaxBackoff,
			},
			Models: models,
		},

		Router: core.BuilderRouterConfig{
			HistoryWindow: cfg.Router.HistoryWindow,
		},
		Executor: core.BuilderExecutorConfig{
			MaxRetries:         cfg.Executor.MaxRetries,
			OutputTokenReserve: cfg.Executor.OutputTokenReserve,
			Compaction: core.BuilderCompactionConfig{
				SlidingWindow: core.BuilderSlidingWindow{
					KeepFirst: cfg.Executor.Compaction.SlidingWindow.KeepFirst,
					KeepLast:  cfg.Executor.Compaction.SlidingWindow.KeepLast,
				},
				Summarization: core.BuilderSummarization{
					BlockSize: cfg.Executor.Compaction.Summarization.BlockSize,
					KeepLast:  cfg.Executor.Compaction.Summarization.KeepLast,
				},
				Hierarchical: core.BuilderHierarchical{
					EnabledAboveSteps: cfg.Executor.Compaction.Hierarchical.EnabledAboveSteps,
					DistantRatio:      cfg.Executor.Compaction.Hierarchical.DistantRatio,
					MiddleRatio:       cfg.Executor.Compaction.Hierarchical.MiddleRatio,
					RecentRatio:       cfg.Executor.Compaction.Hierarchical.RecentRatio,
				},
				Thresholds: core.BuilderCompactionThresholds{
					PredictivePercent: cfg.Executor.Compaction.Thresholds.PredictivePercent,
					WarningPercent:    cfg.Executor.Compaction.Thresholds.WarningPercent,
					EmergencyPercent:  cfg.Executor.Compaction.Thresholds.EmergencyPercent,
					PreWarningPercent: cfg.Executor.Compaction.Thresholds.PreWarningPercent,
				},
				MaxSummarizeTokens:  cfg.Executor.Compaction.MaxSummarizeTokens,
				ObservationTruncate: cfg.Executor.Compaction.ObservationTruncate,
				SafetyMarginPercent: cfg.Executor.Compaction.SafetyMarginPercent,
				Forecast: core.BuilderCompactionForecast{
					SummarizationRatio:       cfg.Executor.Compaction.Forecast.SummarizationRatio,
					HierarchicalDistantRatio: cfg.Executor.Compaction.Forecast.HierarchicalDistantRatio,
					HierarchicalMiddleRatio:  cfg.Executor.Compaction.Forecast.HierarchicalMiddleRatio,
				},
			},
			ToolResultBudget: core.BuilderToolResultBudget{
				HardCapTokens:   cfg.Executor.ToolResultBudget.HardCapTokens,
				MaxFillFraction: cfg.Executor.ToolResultBudget.MaxFillFraction,
				CacheTTLSeconds: cfg.Executor.ToolResultBudget.CacheTTLSeconds,
			},
			ToolOutputPruning: core.BuilderToolOutputPruning{
				KeepLastN:        cfg.Executor.ToolOutputPruning.KeepLastN,
				ProtectedTools:   cfg.Executor.ToolOutputPruning.ProtectedTools,
				ThresholdPercent: cfg.Executor.ToolOutputPruning.ThresholdPercent,
			},
			HistoryMutation: core.BuilderHistoryMutation{
				ToolResultEvictionStep: cfg.Executor.HistoryMutation.ToolResultEvictionStep,
				EvictStepStatus:        cfg.Executor.HistoryMutation.EvictStepStatus,
				DedupRepeatedReads:     cfg.Executor.HistoryMutation.DedupRepeatedReads,
			},
			CircuitBreaker: core.BuilderCircuitBreaker{
				RepeatNudgeThreshold:         cfg.Executor.CircuitBreaker.RepeatNudgeThreshold,
				RepeatAbortThreshold:         cfg.Executor.CircuitBreaker.RepeatAbortThreshold,
				TruncationAbortThreshold:     cfg.Executor.CircuitBreaker.TruncationAbortThreshold,
				ParseErrorAbortThreshold:     cfg.Executor.CircuitBreaker.ParseErrorAbortThreshold,
				FruitlessNudgeThreshold:      cfg.Executor.CircuitBreaker.FruitlessNudgeThreshold,
				FruitlessAbortThreshold:      cfg.Executor.CircuitBreaker.FruitlessAbortThreshold,
				FruitlessMaxResultLen:        cfg.Executor.CircuitBreaker.FruitlessMaxResultLen,
				SameToolRepeatNudgeThreshold: cfg.Executor.CircuitBreaker.SameToolRepeatNudgeThreshold,
				SameToolRepeatAbortThreshold: cfg.Executor.CircuitBreaker.SameToolRepeatAbortThreshold,
				SameToolResultSizeDelta:      cfg.Executor.CircuitBreaker.SameToolResultSizeDelta,
			},
			VerifyOnEdit: core.BuilderVerifyOnEditConfig{
				Enabled:        cfg.Executor.VerifyOnEdit.Enabled,
				Command:        cfg.Executor.VerifyOnEdit.Command,
				Timeout:        cfg.Executor.VerifyOnEdit.Timeout,
				MaxOutputChars: cfg.Executor.VerifyOnEdit.MaxOutputChars,
			},
		},
		Security: core.BuilderSecurityConfig{
			JudgeModel:                 cfg.Security.Judge.Model,
			InjectionDefenseEnabled:    derefBool(cfg.Security.InjectionDefense.Enabled),
			Groups:                     groups,
			AutoApproveWorkspaceWrites: cfg.Security.AutoApproveWorkspaceWrites,
			SmartApprove:               cfg.Security.SmartApprove,
			AgentsMDMaxBytes:           cfg.Security.AgentsMDMaxBytes,
			AgentsMDSearchPaths:        agentsMDSearchPaths(),
		},
		Skills: core.BuilderSkillsConfig{
			Dirs: cfg.Skills.Dirs,
		},
		Search: core.BuilderSearchConfig{
			Provider: cfg.Search.Provider,
			APIKey:   cfg.Search.APIKey,
		},
		MCP: core.BuilderMCPConfig{
			Servers: mcpServers,
		},
		Orchestration: core.BuilderOrchestrationConfig{
			MaxDependencyContextChars: cfg.Orchestration.MaxDependencyContextChars,
			MaxJudgeCacheSize:         cfg.Orchestration.MaxJudgeCacheSize,
			MaxRedelegationDepth:      cfg.Orchestration.MaxRedelegationDepth,
		},
		GoalLoop: core.BuilderGoalLoopConfig{
			Verification: cfg.GoalLoop.Verification,
		},
		E2S: core.BuilderE2SConfig{
			Enabled:              cfg.Experimental.Enabled,
			MaxSteps:             cfg.E2S.MaxSteps,
			StateByteLimit:       cfg.E2S.StateByteLimit,
			PatchRetries:         cfg.E2S.PatchRetries,
			MaxObservationChars:  cfg.E2S.ObservationTruncate,
			RepeatNudgeThreshold: cfg.E2S.RepeatNudgeThreshold,
			RepeatAbortThreshold: cfg.E2S.RepeatAbortThreshold,
		},
		SLM: core.BuilderSLMConfig{
			Enabled: slm.Enabled,
			EssentialTools: core.BuilderSLMEssentialConfig{
				Enabled:             slm.EssentialTools.Enabled,
				AlwaysPresent:       slm.EssentialTools.AlwaysPresent,
				CompactDescriptions: slm.EssentialTools.CompactDescriptions,
			},
			Sampling: core.BuilderSLMSampling{
				Enabled:           slm.Sampling.Enabled,
				Temperature:       slm.Sampling.Temperature,
				TopP:              slm.Sampling.TopP,
				TopK:              slm.Sampling.TopK,
				RepetitionPenalty: slm.Sampling.RepetitionPenalty,
				PresencePenalty:   slm.Sampling.PresencePenalty,
				ReasoningEffort:   slm.Sampling.ReasoningEffort,
			},
			LoopHardening: core.BuilderLoopHardening{
				Enabled:                      slm.LoopHardening.Enabled,
				RepeatNudgeThreshold:         slm.LoopHardening.RepeatNudgeThreshold,
				ParseErrorAbortThreshold:     slm.LoopHardening.ParseErrorAbortThreshold,
				FruitlessNudgeThreshold:      slm.LoopHardening.FruitlessNudgeThreshold,
				FruitlessAbortThreshold:      slm.LoopHardening.FruitlessAbortThreshold,
				SameToolRepeatNudgeThreshold: slm.LoopHardening.SameToolRepeatNudgeThreshold,
			},
			SystemPrompt: core.BuilderSLMSystemPromptConfig{
				Lite:              slm.SystemPrompt.Lite,
				FewShot:           slm.SystemPrompt.FewShot,
				ReasoningScaffold: slm.SystemPrompt.ReasoningScaffold,
			},
			Context: core.BuilderSLMContext{
				Enabled: slm.Context.Enabled,
				Compaction: core.BuilderSLMCompaction{
					KeepLast:       slm.Context.Compaction.KeepLast,
					BlockSize:      slm.Context.Compaction.BlockSize,
					TriggerPercent: slm.Context.Compaction.TriggerPercent,
				},
				ToolOutputKeepLastN: slm.Context.ToolOutputKeepLastN,
				OutputTokenReserve:  slm.Context.OutputTokenReserve,
			},
		},
		ToolLimits: core.BuilderToolLimitsConfig{
			ReadDefaultLines:    cfg.ToolLimits.ReadDefaultLines,
			WebSearchMaxResults: cfg.ToolLimits.WebSearchMaxResults,
			PerToolTruncation:   convertTruncationMap(cfg.ToolLimits.PerToolTruncation),
		},
		Timeouts: core.BuilderTimeoutsConfig{
			BashMaxTimeout:       cfg.Timeouts.BashMaxTimeout,
			BashWaitDelay:        cfg.Timeouts.BashWaitDelay,
			RipgrepTimeout:       cfg.Timeouts.RipgrepTimeout,
			WebFetchTimeout:      cfg.Timeouts.WebFetchTimeout,
			WebFetchProxyTimeout: cfg.Timeouts.WebFetchProxyTimeout,
			WebFetchRetries:      cfg.Timeouts.WebFetchRetries,
			WebSearchTimeout:     cfg.Timeouts.WebSearchTimeout,
			LLMRequestTimeout:    cfg.Timeouts.LLMRequestTimeout,
		},
		Proxy: proxy.Config{
			Enabled:      cfg.Proxy.Enabled,
			URL:          config.ExpandEnvVars(cfg.Proxy.URL),
			BypassList:   cfg.Proxy.BypassList,
			TLSCertDir:   config.ExpandEnvVars(cfg.Proxy.TLSCertDir),
			SetGlobalEnv: derefBool(cfg.Proxy.SetGlobalEnv),
		},
		ExpandEnvVars: config.ExpandEnvVars,
	}
}

// convertTruncationMap converts config-level ToolTruncationConfig to builder-level.
func convertTruncationMap(src map[string]config.ToolTruncationConfig) map[string]core.BuilderToolTruncationConfig {
	if len(src) == 0 {
		return nil
	}
	dst := make(map[string]core.BuilderToolTruncationConfig, len(src))
	for k, v := range src {
		dst[k] = core.BuilderToolTruncationConfig{
			MaxLines: v.MaxLines,
			MaxBytes: v.MaxBytes,
		}
	}
	return dst
}

// agentsMDSearchPaths resolves the extra AGENTS.md search paths (outside the
// workspace) in priority order. The paths are searched ahead of the
// workspace-root AGENTS.md, so the first entry is the global file shared by
// all agents and the second is the c0wrk-specific file:
//
//  1. ~/.agents/AGENTS.md            — global, shared across all agents
//  2. ~/.c0wrk/.agents/AGENTS.md     — c0wrk-specific
//
// Each entry points directly at an AGENTS.md file. Missing files are silently
// skipped at read time (the orchestrator tolerates non-existent paths), so we
// always return both candidates unconditionally.
func agentsMDSearchPaths() []string {
	homeDir, err := os.UserHomeDir()
	if err != nil || homeDir == "" {
		return nil
	}
	return []string{
		filepath.Join(homeDir, ".agents", "AGENTS.md"),
		filepath.Join(homeDir, config.DefaultAgentDir, ".agents", "AGENTS.md"),
	}
}
