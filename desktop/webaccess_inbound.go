package desktop

import (
	"encoding/json"
	"log/slog"

	"github.com/v0lka/c0wrk/backend"
	"github.com/v0lka/c0wrk/backend/session"
	"github.com/v0lka/c0wrk/internal/webaccess"
)

// webWSInboundDispatcher returns the WSInbound handler mounted into the
// web-access sidecar (ADR-099): the browser-side twin of
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
// which the handlers do not produce). The payload-shape gate is inline and
// Debug-only — the shared extractPayload helper logs the same two failure
// shapes at Warn, which would hand a network peer an unbounded Warn stream
// (see the security model above); the Wails path keeps those Warns.
// Whitelist first: an unrecognized name is dropped before its payload is
// judged.
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
	// event constants, the same handlers. An unrecognized name is dropped
	// before anything is said about its payload. JSON numbers arrive as
	// float64, which parseConfirmDecision already accepts.
	var dispatch func(map[string]any)
	switch env.Name {
	case backend.EventToolConfirmResponse:
		dispatch = func(payload map[string]any) { a.handleToolConfirmResponse(payload, log) }
	case backend.EventToolJudgeRequest:
		dispatch = func(payload map[string]any) { a.handleToolJudgeRequest(payload, uiEmit, log) }
	case backend.EventAskUserResponse:
		dispatch = func(payload map[string]any) { a.handleAskUserResponse(payload, log) }
	case backend.EventStepLimitResponse:
		dispatch = func(payload map[string]any) { a.handleStepLimitResponse(payload, log) }
	case backend.EventPlanApprovalResponse:
		dispatch = func(payload map[string]any) { a.handlePlanApprovalResponse(payload, log) }
	case backend.EventGoalProposalResponse:
		dispatch = func(payload map[string]any) { a.handleGoalProposalResponse(payload, log) }
	case backend.EventGoalSuggestionResponse:
		dispatch = func(payload map[string]any) { a.handleGoalSuggestionResponse(payload, log) }
	default:
		log.Debug("web inbound: event not allowed from the web dropped", "event", env.Name)
		return
	}

	// The shape contract of the shared handlers, checked here instead of
	// through extractPayload so the drop stays Debug: exactly one argument,
	// a JSON object (the payload map). The Wails path tolerates extra args
	// and logs Warn; this path is network input — strict and silent.
	if len(env.Args) != 1 {
		log.Debug("web inbound: payload dropped", "event", env.Name, "reason", "missing payload")
		return
	}
	payload, ok := env.Args[0].(map[string]any)
	if !ok {
		log.Debug("web inbound: payload dropped", "event", env.Name, "reason", "unexpected payload type")
		return
	}
	dispatch(payload)
}
