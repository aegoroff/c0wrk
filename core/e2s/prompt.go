package e2s

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/v0lka/sp4rk/security"
	"github.com/v0lka/sp4rk/strutil"
	sdktools "github.com/v0lka/sp4rk/tools"

	"github.com/v0lka/c0wrk/core/prompts"
)

// SkillSection is one activated skill body injected into the E2S system
// prompt. The host (which owns skill resolution) supplies the parsed sections;
// the loop treats them as directives to follow, mirroring the orchestrator's
// "Active Skills" section.
type SkillSection struct {
	Name        string
	Description string
	Body        string
}

// BuildSystemPrompt assembles the E2S system prompt P: the compact core
// directive from core/prompts/e2s.md (role + E2S protocol), followed by the
// workspace sections, the Available Tools catalog (from the registry
// descriptors), the optional delegation directive, and the active-skill
// sections. The composition is deterministic and session-stable: the same
// config and descriptor set always produce the same prompt, so provider-side
// prefix caching applies across the loop's fresh one-shot dialogs.
func BuildSystemPrompt(cfg Config, descriptors []sdktools.ToolDescriptor) string {
	var sb strings.Builder
	sb.WriteString(strings.TrimSpace(prompts.E2SSystem))
	sb.WriteString(workspaceSection(cfg))
	sb.WriteString(availableToolsSection(descriptors))
	if cfg.DelegateDirective != "" {
		sb.WriteString("\n\n## Delegation\n")
		sb.WriteString(cfg.DelegateDirective)
	}
	sb.WriteString(skillsSection(cfg.Skills))
	return sb.String()
}

// workspaceSection renders the workspace/temp-directory containment sections,
// mirroring the orchestrator's Workspace block.
func workspaceSection(cfg Config) string {
	if cfg.WorkspacePath == "" {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n\n## Workspace\n")
	sb.WriteString("Your session workspace is: " + cfg.WorkspacePath + "\n")
	sb.WriteString("All artifacts you create (files, directories, temporary files) MUST be placed strictly inside this workspace directory, unless the task explicitly requires creating artifacts at a specific external location.")
	if cfg.TempDir != "" {
		sb.WriteString("\nYour session temp directory is: " + cfg.TempDir + "\n")
		sb.WriteString("Use this directory for ANY intermediate files — drafts, partial results, scratch data, inter-step artifacts. These files are NOT part of the final deliverable and will be cleaned up when the session ends.")
	}
	return sb.String()
}

// availableToolsSection renders the catalog of tools the action dispatch can
// target. Descriptors are sorted by name for a stable, cache-friendly list;
// the description is reduced to its first line to keep the section compact.
func availableToolsSection(descriptors []sdktools.ToolDescriptor) string {
	if len(descriptors) == 0 {
		return "\n\n## Available Tools\nNone — call " + FinishActionName + " with your best answer."
	}
	sorted := make([]sdktools.ToolDescriptor, len(descriptors))
	copy(sorted, descriptors)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })

	var sb strings.Builder
	sb.WriteString("\n\n## Available Tools\n")
	fmt.Fprintf(&sb, "Actions dispatch to these tools via `%s.action.tool`. The special target %q ends the task.\n", StepToolName, FinishActionName)
	for _, d := range sorted {
		sb.WriteString("- `" + d.Name + "`")
		if desc := firstLine(d.Description); desc != "" {
			sb.WriteString(": " + desc)
		}
		if d.SourceCategory == sdktools.SourceCategoryMCP {
			sb.WriteString(" [MCP]")
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

// skillsSection renders the active-skill bodies. Skill bodies are emitted
// verbatim — truncating guidance silently degrades execution fidelity.
func skillsSection(skills []SkillSection) string {
	if len(skills) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n\n## Active Skills\n")
	sb.WriteString("The following skills have been activated for this task. Follow their instructions carefully.\n\n")
	for _, s := range skills {
		sb.WriteString("### Skill: " + s.Name + "\n")
		if s.Description != "" {
			sb.WriteString("Description: " + s.Description + "\n")
		}
		sb.WriteString("\n")
		sb.WriteString(s.Body)
		sb.WriteString("\n\n")
	}
	return sb.String()
}

// BuildUserMessage renders the per-turn user message: the current turn number,
// the full working state Σₜ as compact JSON, and the latest observation Oₜ.
// This message (plus the system prompt) is the ENTIRE request — previous
// turns never leak in, keeping the context bounded at O(1).
func BuildUserMessage(state map[string]any, observation string, turn int) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "[turn %d]\n", turn)
	sb.WriteString("<state>\n")
	sb.WriteString(renderStateJSON(state))
	sb.WriteString("\n</state>\n")
	sb.WriteString("<observation>\n")
	sb.WriteString(observation)
	sb.WriteString("\n</observation>\n")
	return sb.String()
}

// BuildCorrectionSuffix renders the corrective tail appended to the user
// message for the bounded retry after an invalid e2s_step call.
func BuildCorrectionSuffix(validationErr error) string {
	return "\n<correction>\nYour previous turn was INVALID and was not applied. Error:\n" +
		validationErr.Error() +
		"\nRespond now with a corrected `" + StepToolName + "` call following the E2S protocol exactly: a state_patch object and an action object with tool and args.\n</correction>\n"
}

// untrustedWrap wraps an observation from an untrusted source (MCP, web,
// filesystem) in untrusted-content boundary tags. It delegates to the canonical
// SDK helper so the MANDATORY tag-breakout sanitization (security.StripUntrustedTags)
// and attribute escaping apply exactly as on the orchestrator/engine path — a
// literal </untrusted-content> in tool output must not be able to close the
// boundary early (SECURITY.md "Tag-breakout protection is mandatory").
func untrustedWrap(source, content string) string {
	return security.WrapUntrustedContent(content, source, nil)
}

// renderStateJSON marshals the state compactly. A state that fails to
// marshal (should never happen — values come from JSON patches) is rendered
// as an error marker instead of failing the turn.
func renderStateJSON(state map[string]any) string {
	if len(state) == 0 {
		return "{}"
	}
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Sprintf("<state marshal error: %v>", err)
	}
	return string(data)
}

// firstLine extracts the first non-empty line of a tool description.
func firstLine(desc string) string {
	for _, line := range strings.Split(desc, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return strutil.TruncateUTF8(trimmed, 160)
		}
	}
	return ""
}
