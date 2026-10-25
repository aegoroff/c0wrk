package core

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/v0lka/c0wrk/core/prompts"
	"github.com/v0lka/sp4rk/agent"
	"github.com/v0lka/sp4rk/llm"
	"github.com/v0lka/sp4rk/oneshot"
)

// Prompt-suggestion generation (ADR-088): after a task finishes full/partial,
// the backend assembles a recent-history window and asks a one-shot service
// call (ServiceKindPromptSuggest) for a small set of follow-up prompts the
// user could send next. This file owns the core side of that pipeline — the
// generation input assembly (window caps, the is_nudge filter, prompt→answer
// pairing, latest-priority trimming), the LLM round-trip under the shared
// service-call pipeline, and the fail-safe response parsing. Triggering,
// persistence, and the RPC/event surface live in the backend (D7/D8/D9).

// SuggestionKind selects which suggestion family one generation pass
// produces (ADR-088 D1). The two kinds share this pipeline; they differ in
// the embedded prompt and the session window.
type SuggestionKind string

const (
	// SuggestionKindNextTask offers follow-up prompts after a finished task —
	// "what should I ask next" — generated from the last project sessions.
	SuggestionKindNextTask SuggestionKind = "next_task"
	// SuggestionKindGoalAdvance offers prompts for advancing an active goal —
	// "how do I keep driving this goal" — generated from the recent history
	// bound to the same goal.
	SuggestionKindGoalAdvance SuggestionKind = "goal_advance"
)

// PromptSuggestion is one persisted follow-up prompt row (ADR-088 D7): the
// chat input offers it after a task finishes with outcome full or partial.
// Rows hang off their session: deleting the session deletes its suggestions
// (ON DELETE CASCADE) and a fork does not copy them. This is the canonical
// in-memory shape the whole pipeline shares; the backend session store
// persists it in SQLite with CreatedAt as an RFC 3339 string, and the wire
// (GetPromptSuggestions, the prompt_suggestions event) marshals it with the
// same snake_case keys — a time.Time always renders as RFC 3339 there.
type PromptSuggestion struct {
	ID        string         `json:"id"`
	SessionID string         `json:"session_id"`
	TaskID    string         `json:"task_id"` // triggering task; "" for kind-less/session-level rows
	Kind      SuggestionKind `json:"kind"`    // SuggestionKindNextTask or SuggestionKindGoalAdvance
	Text      string         `json:"text"`
	Status    string         `json:"status"`     // "active" | "accepted" | "dismissed" | "stale"
	CreatedAt time.Time      `json:"created_at"` // zero until the store normalizes it per pass
}

// Compile-time generation limits. v1 has no config surface (ADR-088 D9):
// these are the windows (D3/D4), the per-pass cap (D7), and the transcript
// budgets that keep the generation input bounded.
const (
	// nextTaskWindowSessions is the next_task window: the last 10 sessions of
	// the project (D3).
	nextTaskWindowSessions = 10
	// maxSuggestionsPerPass caps one generation pass (D7).
	maxSuggestionsPerPass = 3
	// promptSuggestMaxMessageChars caps one transcript message's rendered
	// content, in runes (never splits a multi-byte character).
	promptSuggestMaxMessageChars = 2000
	// promptSuggestSessionBudget is the per-session transcript budget, in
	// bytes of rendered text.
	promptSuggestSessionBudget = 4000
	// promptSuggestTranscriptBudget is the whole-transcript budget across the
	// window, in bytes of rendered text.
	promptSuggestTranscriptBudget = 12000
	// promptSuggestMaxTokens is the generation ceiling. Suggestions are short
	// lines; a generous ceiling only bounds a runaway answer.
	promptSuggestMaxTokens = 600
)

var (
	// errPromptSuggestEmptyWindow reports that the assembled generation
	// window contained no complete prompt→answer pair (D9: an empty window is
	// a Debug-logged no-suggestion outcome, never a failure of anything
	// else).
	errPromptSuggestEmptyWindow = errors.New("prompt suggest: empty generation window")
	// errPromptSuggestEmptyResponse marks a response with no parseable
	// suggestion line. It drives the oneshot nudge loop and, when every
	// attempt fails, the fail-safe fallback (no suggestions, nil error).
	errPromptSuggestEmptyResponse = errors.New("prompt suggest: no suggestion line in response")
)

// PromptSuggestMessage is one persisted-history message in a generation
// window. Role is "user" or "assistant" (other roles carry no
// prompt→answer signal and are ignored); IsNudge mirrors the persisted
// is_nudge metadata stamp (ADR-088 D5) and is meaningful for user messages
// only.
type PromptSuggestMessage struct {
	Role    string
	Content string
	IsNudge bool
}

// PromptSuggestSession is one session's transcript inside a generation
// window, in chronological order.
type PromptSuggestSession struct {
	ID       string
	Messages []PromptSuggestMessage
}

// PromptSuggestInput is the assembled generation input for one pass.
type PromptSuggestInput struct {
	// Sessions is the recency window in CHRONOLOGICAL order (oldest first,
	// the most recent session LAST — the caller passes the triggering
	// session last). The window cap is enforced here: at most
	// nextTaskWindowSessions (next_task) sessions are read; goal_advance
	// reads exactly one — the triggering session (the ADR-088 D4
	// multi-session goal window is a deferred extension point).
	Sessions []PromptSuggestSession
}

// promptSuggestPair is one "prompt → final answer" pair recovered from a
// session transcript: the user's request (an is_nudge-free user message) and
// the assistant's FINAL answer to it.
type promptSuggestPair struct {
	prompt string
	answer string
}

// promptSuggestPairs recovers prompt→final-answer pairs from a chronological
// transcript. is_nudge user messages are dropped entirely (D5): they open no
// pair and close none — assistant text following a dropped nudge still
// updates the open pair's final answer. A non-nudge user message closes the
// open pair and opens a new one; every assistant message updates the open
// pair's answer, so the LAST assistant message before the next user message
// wins. Pairs missing either side are discarded. Both sides are capped to
// promptSuggestMaxMessageChars runes.
func promptSuggestPairs(msgs []PromptSuggestMessage) []promptSuggestPair {
	var (
		pairs []promptSuggestPair
		open  *promptSuggestPair
	)
	closeOpen := func() {
		if open != nil && open.prompt != "" && open.answer != "" {
			pairs = append(pairs, *open)
		}
		open = nil
	}
	for _, m := range msgs {
		content := promptSuggestTruncate(strings.TrimSpace(m.Content), promptSuggestMaxMessageChars)
		switch m.Role {
		case "user":
			// D5: nudges describe no work — they neither open nor close a
			// pair, so the answer continuation after a nudge stays attached
			// to the pair the nudge interrupted.
			if m.IsNudge || content == "" {
				continue
			}
			closeOpen()
			open = &promptSuggestPair{prompt: content}
		case "assistant":
			if open == nil || content == "" {
				continue
			}
			open.answer = content
		}
	}
	closeOpen()
	return pairs
}

// promptSuggestTruncate caps s to maxRunes runes, so a multi-byte character
// is never split. A non-positive cap returns the empty string; s already
// within the cap is returned unchanged.
func promptSuggestTruncate(s string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	// Byte length ≥ rune count, so len(s) <= maxRunes implies s fits.
	if len(s) <= maxRunes {
		return s
	}
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return string(runes[:maxRunes])
}

// promptSuggestPairCost is a pair's transcript cost in bytes: both sides plus
// the rendered line prefixes and the line join.
func promptSuggestPairCost(p promptSuggestPair) int {
	return len("User: ") + len(p.prompt) + len("\nAssistant: ") + len(p.answer) + len("\n\n")
}

// promptSuggestTrimPairsLatestFirst keeps the most recent pairs that fit the
// byte budget, latest priority: walk from the newest pair and stop at the
// first one that no longer fits — an older pair is never resurrected past a
// newer non-fitting one. The single most recent pair is always kept, so a
// session with any complete pair never trims to nothing.
func promptSuggestTrimPairsLatestFirst(pairs []promptSuggestPair, budget int) []promptSuggestPair {
	if len(pairs) == 0 || budget <= 0 {
		return nil
	}
	used, keep := 0, 0
	for i := len(pairs) - 1; i >= 0; i-- {
		cost := promptSuggestPairCost(pairs[i])
		if keep > 0 && used+cost > budget {
			break
		}
		used += cost
		keep++
	}
	return pairs[len(pairs)-keep:]
}

// promptSuggestSessionBlock is one session's rendered, already per-session-
// budgeted transcript block. The header is assigned after the global
// latest-priority trim, when the final session count is known.
type promptSuggestSessionBlock struct {
	body string
}

// promptSuggestWindow is the kind's session-window cap (D3/D4): next_task
// reads the project window (10 sessions); goal_advance reads exactly the
// triggering session in v1 — the D4 multi-session goal window is a recorded
// extension point.
func promptSuggestWindow(kind SuggestionKind) int {
	if kind == SuggestionKindNextTask {
		return nextTaskWindowSessions
	}
	return 1
}

// promptSuggestSystemPrompt maps the kind onto its embedded prompt.
func promptSuggestSystemPrompt(kind SuggestionKind) (string, error) {
	switch kind {
	case SuggestionKindGoalAdvance:
		return prompts.PromptSuggestContinuation, nil
	case SuggestionKindNextTask:
		return prompts.PromptSuggestNewSession, nil
	default:
		return "", fmt.Errorf("prompt suggest: unknown kind %q", string(kind))
	}
}

// promptSuggestUserContent renders the user turn for one generation pass:
// the window's session transcripts — window cap enforced (keeping the most
// recent sessions), is_nudge filtered (D5), per-session and global budgets
// applied latest-first (D3). An error means the window yielded no complete
// pair (D9: no suggestions, fail open).
func promptSuggestUserContent(kind SuggestionKind, in PromptSuggestInput) (string, error) {
	sessions := in.Sessions
	if window := promptSuggestWindow(kind); len(sessions) > window {
		sessions = sessions[len(sessions)-window:] // keep the most recent
	}
	var blocks []promptSuggestSessionBlock
	for _, s := range sessions {
		pairs := promptSuggestTrimPairsLatestFirst(
			promptSuggestPairs(s.Messages), promptSuggestSessionBudget)
		if len(pairs) == 0 {
			continue
		}
		var b strings.Builder
		for _, p := range pairs {
			b.WriteString("User: ")
			b.WriteString(p.prompt)
			b.WriteString("\nAssistant: ")
			b.WriteString(p.answer)
			b.WriteString("\n\n")
		}
		blocks = append(blocks, promptSuggestSessionBlock{body: b.String()})
	}
	// Global budget across the window, latest session priority.
	used := 0
	keep := 0
	for i := len(blocks) - 1; i >= 0; i-- {
		if keep > 0 && used+len(blocks[i].body) > promptSuggestTranscriptBudget {
			break
		}
		used += len(blocks[i].body)
		keep++
	}
	blocks = blocks[len(blocks)-keep:]
	if len(blocks) == 0 {
		return "", errPromptSuggestEmptyWindow
	}

	var b strings.Builder
	n := len(blocks)
	for i, blk := range blocks {
		fmt.Fprintf(&b, "[Session %d of %d]\n", i+1, n)
		b.WriteString(blk.body)
	}
	b.WriteString("The last session listed is the most recent one — the session that just finished.")
	return b.String(), nil
}

// suggestionMarkerRe strips one leading list marker or ordinal ("1." / "1)")
// that models habitually prefix suggestion lines with. It tolerates leading
// indentation and requires whitespace after the marker, so a marker stripped
// bare by TrimSpace ("1. " → "1.") still cannot survive as a suggestion —
// such leftovers carry no letter or digit and are dropped below.
var suggestionMarkerRe = regexp.MustCompile(`^[ \t]*(?:[-*+•·]|\d{1,3}[.)])[ \t]+`)

// parsePromptSuggestions recovers up to maxSuggestionsPerPass one-line
// suggestions from the response. Fail-safe by construction: fence and
// preamble stripping (oneshot.Text), per-line decoration stripping (list
// markers, ordinals, quotes, markdown emphasis), and exact-duplicate
// dropping mean every returned string is clean — or the parse error engages
// the client's nudge loop and, when every attempt fails, the fail-safe
// fallback (no suggestions, nil error).
func parsePromptSuggestions(resp *llm.ChatResponse) ([]string, error) {
	text := oneshot.Text(resp)
	if text == "" {
		return nil, errPromptSuggestEmptyResponse
	}
	out := make([]string, 0, maxSuggestionsPerPass)
	seen := make(map[string]struct{}, maxSuggestionsPerPass)
	for _, line := range strings.Split(text, "\n") {
		s := parseSuggestionLine(line)
		if s == "" {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
		if len(out) == maxSuggestionsPerPass {
			break
		}
	}
	if len(out) == 0 {
		return nil, errPromptSuggestEmptyResponse
	}
	return out, nil
}

// parseSuggestionLine normalizes one response line into a suggestion:
// a leading list marker or ordinal, surrounding whitespace, and one layer of
// decorative quotes or markdown emphasis are stripped; the cleaned line is
// returned verbatim — no length cap truncates an already-formed suggestion
// (the prompt bounds the answer's shape instead). Decoration-only lines
// (markers, dashes, fences, ellipses — anything without a letter or digit)
// and colon-terminated header/preamble lines ("Here are three suggestions:")
// normalize to "".
func parseSuggestionLine(line string) string {
	s := suggestionMarkerRe.ReplaceAllString(line, "")
	s = strings.TrimSpace(s)
	if s == "" || strings.HasSuffix(s, ":") {
		return ""
	}
	s = strings.TrimSpace(oneshot.Unquote(s))
	// A suggestion always names work: a line with no letter or digit is
	// decoration left over after stripping ("1.", "-", "…", "```").
	if !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }) {
		return ""
	}
	// The cleaned line IS the suggestion — verbatim, no post-hoc length
	// cap. The prompt bounds the answer's shape; truncating here would
	// cut off an already-formed suggestion mid-sentence.
	return s
}

// promptSuggestRetryHint restates the output contract inside the oneshot
// "[System]" nudge (the failed output rides the assistant echo message).
const promptSuggestRetryHint = "Reply with AT MOST 3 plain lines — one suggested prompt per line. " +
	"No numbering, no bullets, no quotes, no markdown, no prose, no empty lines."

// suggestPromptsWithCaller is the production generation pass for one
// suggestion kind: input assembly (window cap D3/D4, is_nudge filter D5,
// latest-priority trimming) followed by one one-shot service call
// (ServiceKindPromptSuggest) under the shared service pipeline. Errors
// (unknown kind, empty window, transport failure, exhausted nudges) are
// returned to the caller, which fails open — the suggestion feature can
// never delay, block, or break a task finish (D9).
func suggestPromptsWithCaller(
	ctx context.Context,
	caller oneshot.Caller,
	metrics *ServiceMetrics,
	model string,
	logger *slog.Logger,
	kind SuggestionKind,
	in PromptSuggestInput,
) ([]string, error) {
	systemPrompt, err := promptSuggestSystemPrompt(kind)
	if err != nil {
		return nil, err
	}
	userContent, err := promptSuggestUserContent(kind, in)
	if err != nil {
		return nil, err
	}
	req := llm.ChatRequest{
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userContent},
		},
		MaxTokens:       promptSuggestMaxTokens,
		Temperature:     &oneshotTempPromptSuggest, // oneshot service policy — explicit value wins over any profile
		ReasoningEffort: serviceReasoningEffort(model, oneshotTierPromptSuggest),
		// Auxiliary text composition call — summarization class.
		CallPurpose: llm.CallPurposeSummarization,
	}
	return serviceCall(ctx, metrics, logger, ServiceKindPromptSuggest, model, caller, req,
		parsePromptSuggestions, oneshot.Options[[]string]{
			OnFailure:     oneshot.OnFailureFallback,
			FallbackValue: nil,
			RetryHint:     promptSuggestRetryHint,
		})
}

// GeneratePromptSuggestions generates chat-input follow-up prompt suggestions
// (ADR-088) for one suggestion kind from the assembled generation input: up
// to maxSuggestionsPerPass cleaned one-line prompts, written in the dominant
// language of the supplied history (D6). The call rides the cached LLM router
// under the oneshot service policy and the shared service-call pipeline
// (per-kind telemetry, ServiceKindPromptSuggest). The caller owns the
// deadline via ctx — the backend fires this on the service timeout
// (timeouts.serviceLLMRequestTimeout) — and must treat every error as
// fail-open "no suggestions" (D9).
func (b *OrchestratorBuilder) GeneratePromptSuggestions(ctx context.Context, kind SuggestionKind, in PromptSuggestInput) ([]string, error) {
	if err := b.waitReady(ctx); err != nil {
		return nil, err
	}

	b.mu.RLock()
	llmRouter := b.llmRouter
	b.mu.RUnlock()

	if llmRouter == nil {
		return nil, errors.New("llm router not available")
	}

	var caller oneshot.Caller = llmRouter
	if dw := agent.DumpWriterFromContext(ctx); dw != nil {
		caller = agent.NewLoggingLLMCaller(caller, llmRouter.ActiveProviderName(), b.logger)
		caller = agent.NewDumpCaller(caller, dw, b.logger)
	}
	return suggestPromptsWithCaller(ctx, caller, b.serviceMetrics, bareActiveModel(llmRouter), b.log(), kind, in)
}
