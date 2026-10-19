package desktop

import (
	"encoding/json"
	"log/slog"

	"github.com/v0lka/c0wrk/backend"
	"github.com/v0lka/c0wrk/backend/session"
	"github.com/v0lka/c0wrk/internal/webaccess"
)

// webWSInboundDispatcher returns the WSInbound handler mounted into the
// web-access sidecar (ADR-090): the browser-side twin of
// wireWailsEventListeners. An authenticated browser tab sends the same
// {name, args} envelope the outbound tap broadcasts; this handler resolves
// the narrow frontend→backend event set — the seven HITL response events —
// through exactly the same App handlers the Wails runtime path uses.
//
// Security model (specs/domains/web-access.md): the bridge is a deliberate
// WHITELIST, never the generic forge path — EmitSessionEvent stays denied on
// the RPC surface and arbitrary event names are dropped here. A browser tab
// holds the same trust level as the desktop webview (the session cookie is
// the boundary), so resolving a pending HITL action is an authorized
// operation; two clients racing one action inherit the handlers'
// first-responder-wins semantics.
//
// Every dropped frame is logged at Debug only: network input must not be
// able to write unbounded Warn/Error lines into the log.
func (a *App) webWSInboundDispatcher(log *slog.Logger) func(*webaccess.WSConn, []byte) {
	// One emitter per dispatcher lifetime — the same buildUIEmitFunc product
	// the Wails listeners run with, rebuilt when the sidecar (re)mounts.
	uiEmit := a.buildUIEmitFunc()
	return func(_ *webaccess.WSConn, data []byte) {
		a.dispatchWebInboundFrame(data, uiEmit, log)
	}
}

// dispatchWebInboundFrame decodes one inbound WS frame and dispatches it to
// the shared HITL handlers. Anything malformed, unnamed, or outside the
// whitelist is dropped with a Debug record and never touches the handlers;
// the connection stays alive (the server only closes it on a handler panic,
// which the handlers do not produce).
func (a *App) dispatchWebInboundFrame(data []byte, uiEmit func(session.Event), log *slog.Logger) {
	var env struct {
		Name string `json:"name"`
		Args []any  `json:"args"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		log.Debug("web inbound: malformed frame dropped", "error", err)
		return
	}

	// The whitelist mirrors wireWailsEventListeners one-to-one: the same
	// event constants, the same payload extraction, the same handlers. JSON
	// numbers arrive as float64, which parseConfirmDecision already accepts.
	switch env.Name {
	case backend.EventToolConfirmResponse:
		payload, ok := extractPayload(env.Name, env.Args, log)
		if !ok {
			return
		}
		a.handleToolConfirmResponse(payload, log)
	case backend.EventToolJudgeRequest:
		payload, ok := extractPayload(env.Name, env.Args, log)
		if !ok {
			return
		}
		a.handleToolJudgeRequest(payload, uiEmit, log)
	case backend.EventAskUserResponse:
		payload, ok := extractPayload(env.Name, env.Args, log)
		if !ok {
			return
		}
		a.handleAskUserResponse(payload, log)
	case backend.EventStepLimitResponse:
		payload, ok := extractPayload(env.Name, env.Args, log)
		if !ok {
			return
		}
		a.handleStepLimitResponse(payload, log)
	case backend.EventPlanApprovalResponse:
		payload, ok := extractPayload(env.Name, env.Args, log)
		if !ok {
			return
		}
		a.handlePlanApprovalResponse(payload, log)
	case backend.EventGoalProposalResponse:
		payload, ok := extractPayload(env.Name, env.Args, log)
		if !ok {
			return
		}
		a.handleGoalProposalResponse(payload, log)
	case backend.EventGoalSuggestionResponse:
		payload, ok := extractPayload(env.Name, env.Args, log)
		if !ok {
			return
		}
		a.handleGoalSuggestionResponse(payload, log)
	default:
		log.Debug("web inbound: event not allowed from the web dropped", "event", env.Name)
	}
}
