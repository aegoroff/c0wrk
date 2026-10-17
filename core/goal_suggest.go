package core

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"

	"github.com/v0lka/c0wrk/core/prompts"
	"github.com/v0lka/sp4rk/agent/router"
	"github.com/v0lka/sp4rk/llm"
	"github.com/v0lka/sp4rk/oneshot"
)

// errGoalSuggestNoCaller is returned when the orchestrator has no LLM caller
// to classify with (direct-constructed test orchestrators); the gate treats
// it as no-suggestion.
var errGoalSuggestNoCaller = errors.New("goal suggest: no LLM caller")

// GoalSuggestion is the goal-mode suitability classifier's verdict for one
// fresh user message (see Orchestrator.SuggestGoalMode). Suggest=true means
// goal mode is OBVIOUSLY the better fit for the request — the orchestrator may
// then offer the user to activate it before the task starts. Reason is a short
// user-facing explanation (in the user's language); empty when Suggest=false.
type GoalSuggestion struct {
	Suggest bool   `json:"suggest"`
	Reason  string `json:"reason"`
}

// GoalSuggester is the orchestrator-side seam for the goal-mode suitability
// classifier. The production implementation rides the session's LLM caller
// through the shared serviceCall pipeline; tests inject a stub. A nil field
// on Orchestrator resolves to the production implementation (mirroring the
// goalVerifier seam).
type GoalSuggester func(ctx context.Context, message string, routing *router.RoutingDecision) (GoalSuggestion, error)

// GoalSuggestionProposer bridges the orchestrator's post-routing suggestion
// gate to the desktop UI. The production implementation (desktop layer,
// mirroring the goal-proposal adapter) emits a goal_suggestion session event,
// renders a pending-action card, and BLOCKS until the user answers — an
// accepted suggestion must turn goal mode on before the task starts, so the
// gate cannot continue speculatively. Err on the returned pair means the wait
// failed (context cancelled, UI unavailable, shutdown drain) — the gate fails
// OPEN to the plain Conductor path and never suppresses future suggestions;
// (false, nil) is a USER decline and engages the session-scoped suppression.
type GoalSuggestionProposer interface {
	ProposeGoalSuggestion(ctx context.Context, sessionID string, suggestion GoalSuggestion) (accepted bool, err error)
}

// goalSuggestGateOutcome classifies what the post-routing suggestion gate
// decided for one fresh task message.
type goalSuggestGateOutcome int

const (
	// gateNoSuggestion — the classifier was not consulted (preconditions),
	// judged the message not goal-suited, or failed; the plain path continues
	// and future suggestions stay armed.
	gateNoSuggestion goalSuggestGateOutcome = iota
	// gateAccepted — the user accepted the offer; the caller must enter the
	// goal loop with the already-established routing.
	gateAccepted
	// gateDeclined — the user explicitly declined; the session suppresses
	// further suggestions.
	gateDeclined
)

// parseGoalSuggestion extracts the classifier's JSON verdict. The zero value
// is a valid "no suggestion" (Go JSON decoding of a malformed or absent
// "suggest" field yields false), so a model that answers garbage fails closed
// to no-offer; oneshot.ParseJSON still fails on a response with no JSON at
// all, which the caller treats as fail-open to the normal path.
func parseGoalSuggestion(resp *llm.ChatResponse) (GoalSuggestion, error) {
	s, err := oneshot.ParseJSON[GoalSuggestion](resp)
	if err != nil {
		return GoalSuggestion{}, err
	}
	s.Reason = strings.TrimSpace(s.Reason)
	if !s.Suggest {
		s.Reason = ""
	}
	return s, nil
}

// goalSuggestRoutingContext renders the advisory routing line appended to the
// user message so the classifier sees the already-computed classification.
func goalSuggestRoutingContext(routing *router.RoutingDecision) string {
	if routing == nil {
		return "Routing classification (advisory): unavailable"
	}
	return "Routing classification (advisory): domain=" + routing.Domain +
		", complexity=" + strconv.Itoa(routing.Complexity) + "/5"
}

// suggestGoalModeWithCaller is the production classifier pass: one one-shot
// service call (ServiceKindGoalSuggest) over the embedded goal_suggest prompt
// with the user's request as the user turn. Errors (transport, unparseable
// JSON after the nudge loop) are returned to the caller, which fails OPEN to
// the normal execution path — the suggestion feature can never break a send.
func suggestGoalModeWithCaller(
	ctx context.Context,
	caller oneshot.Caller,
	metrics *ServiceMetrics,
	logger *slog.Logger,
	model string,
	message string,
	routing *router.RoutingDecision,
) (GoalSuggestion, error) {
	req := llm.ChatRequest{
		Messages: []llm.Message{
			{Role: "system", Content: prompts.GoalSuggest},
			{Role: "user", Content: "Request:\n" + message + "\n\n" + goalSuggestRoutingContext(routing)},
		},
		MaxTokens:       200,
		Temperature:     &oneshotTempGoalSuggest, // oneshot service policy — explicit value wins over any profile
		ReasoningEffort: serviceReasoningEffort(model, oneshotTierGoalSuggest),
		// Classification call — same budget class as routing itself.
		CallPurpose: llm.CallPurposeRouting,
	}
	return serviceCall(ctx, metrics, logger, ServiceKindGoalSuggest, model, caller, req, parseGoalSuggestion, oneshot.Options[GoalSuggestion]{})
}

// SuggestGoalMode runs the goal-mode suitability classifier for a fresh user
// message that has already been routed. The verdict gates whether the
// orchestrator offers goal-mode activation to the user before the task starts
// (HandleMessage's post-routing gate).
//
// Contract:
//   - The classifier rides the session's own LLM caller (o.llm — the same
//     logging/dump-wrapped caller every per-step call uses) under the shared
//     oneshot service pipeline, so per-kind telemetry and the service-call
//     log record apply.
//   - A nil goalSuggester seam resolves to the production implementation; a
//     stub installed by tests always wins.
//   - A nil caller (direct-constructed orchestrators in tests) is an error —
//     the gate fails open to the normal path.
func (o *Orchestrator) SuggestGoalMode(ctx context.Context, message string, routing *router.RoutingDecision) (GoalSuggestion, error) {
	if fn := o.goalSuggester; fn != nil {
		return fn(ctx, message, routing)
	}
	if o.llm == nil {
		return GoalSuggestion{}, errGoalSuggestNoCaller
	}
	return suggestGoalModeWithCaller(ctx, o.llm, o.serviceMetrics, o.logger, bareActiveModel(o.modelSwitcher), message, routing)
}

// goalSuggestionApplicable reports the cheap, LLM-free preconditions of the
// post-routing goal-mode suggestion gate. The gate applies ONLY on the plain
// Conductor path's FRESH tasks: explicit goals (/goal or the toggle) return
// through the goal branch before routing, E2S requests return through the E2S
// branch before routing, continuations carry their own workflow (and the
// fast-path skips the router, leaving no fresh classification to reason
// about), and review-mode turns are corrections to an existing loop — never
// goal material.
func (o *Orchestrator) goalSuggestionApplicable(opts HandleOptions) bool {
	if opts.Goal || opts.ReviewMode || opts.TaskID != "" {
		return false
	}
	// The suggestion would offer a mode that is hard-blocked: Model Profiles
	// essential-tools narrowing refuses every goal entry (fresh and resumed),
	// so offering it would only produce a refusal after acceptance.
	if o.modelProfilesEssentialToolsEnabled() {
		return false
	}
	if !o.config.GoalLoop.Suggest.Enabled {
		return false
	}
	// Session-scoped suppression: the user already declined once on this
	// session (the orchestrator instance is per-session, so the flag's
	// lifetime IS the session's).
	if o.goalSuggestionDeclined.Load() {
		return false
	}
	return o.goalSuggestionProposer != nil
}

// goalSuggestRoutingEligible applies the advisory routing preconditions: the
// classifier is consulted only for domains that can plausibly carry a goal
// (general is conversational/unclear by definition) and at or above the
// configured complexity floor. Both are cost gates in front of the LLM call —
// the classifier's own judgment decides the actual offer.
func (o *Orchestrator) goalSuggestRoutingEligible(routing *router.RoutingDecision) bool {
	if routing == nil {
		return false
	}
	if routing.Domain == router.DomainGeneral {
		return false
	}
	return routing.Complexity >= o.config.GoalLoop.Suggest.MinComplexity
}

// runGoalSuggestionGate runs the classifier and, on an obvious fit, blocks on
// the user's answer. Fail-open contract: every error path returns
// gateNoSuggestion (the plain Conductor path continues, suppression stays
// armed); only an explicit user decline returns gateDeclined.
func (o *Orchestrator) runGoalSuggestionGate(ctx context.Context, sessionID, message string, routing *router.RoutingDecision) goalSuggestGateOutcome {
	suggestion, err := o.SuggestGoalMode(ctx, message, routing)
	if err != nil {
		o.logDebug("goal suggest: classifier failed — continuing without a suggestion", "error", err)
		return gateNoSuggestion
	}
	if !suggestion.Suggest {
		o.logDebug("goal suggest: classifier judged the message not goal-suited")
		return gateNoSuggestion
	}
	accepted, err := o.goalSuggestionProposer.ProposeGoalSuggestion(ctx, sessionID, suggestion)
	if err != nil {
		// UI unavailable / cancelled wait / shutdown drain — fail open, and
		// do NOT treat it as a decline (no suppression).
		o.logDebug("goal suggest: proposal wait failed — continuing as a plain task", "error", err)
		return gateNoSuggestion
	}
	if !accepted {
		o.goalSuggestionDeclined.Store(true)
		o.logInfo("goal suggest: user declined — suppressing suggestions for this session")
		return gateDeclined
	}
	o.logInfo("goal suggest: user accepted — entering the goal loop with the established routing")
	return gateAccepted
}
