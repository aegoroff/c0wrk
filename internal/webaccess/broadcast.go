// SPDX-License-Identifier: Apache-2.0
//
// broadcast.go — the event fan-out: a per-client bounded outbox with a
// writer goroutine each, and the web-agnostic event tap the desktop mount
// registers on (*desktop.App).emit's eventTap seam.
//
// Backpressure contract: the fan-out NEVER blocks its caller (the tap runs
// on the desktop event goroutine) and NEVER writes on it. Each frame is
// enqueued on the target client's outbox; a client that cannot keep up
// fills its own bounded queue and is dropped on overflow (Warn + abrupt
// close) — the browser reconnects with backoff and re-syncs its own state,
// which is strictly better than stalling the app's event path or growing
// memory without bound. Per-client FIFO order and payload bytes are
// preserved end-to-end: one queue and one writer per client, and the frame
// is marshaled once before fan-out.

package webaccess

import (
	"encoding/json"
)

// wsEventQueueCap bounds one client's outbound queue (in frames). Large
// enough to absorb a burst of coalesced desktop events during a GC pause or
// a tab throttling window; small enough that a dead client is dropped in
// bounded time instead of pinning memory.
const wsEventQueueCap = 1024

// enqueue queues one frame for the client's writer. It never blocks: a full
// queue means the client cannot keep up, so it is dropped (Warn + abort).
// Returns whether the frame was queued.
func (c *WSConn) enqueue(frame []byte) bool {
	select {
	case c.outbox <- frame:
		return true
	default:
		c.srv.log.Warn("webaccess: ws client outbox overflow — dropping client (it will reconnect)",
			"queued", len(c.outbox), "cap", cap(c.outbox))
		c.abort()
		return false
	}
}

// wsWritePump drains the client's outbox, writing one text frame at a time.
// One pump per client: writes are serialized by construction (writeFrame's
// mutex only guards the read pump's control-frame replies), and a slow or
// dead peer only ever delays its own queue. The pump carries its own
// recover — nothing on the write path can take the process down — and
// closes the connection on any exit, which also reclaims clients whose
// writes have failed.
func (s *Server) wsWritePump(c *WSConn) {
	defer func() {
		if p := recover(); p != nil {
			s.log.Error("webaccess: ws write pump panic", "panic", p)
		}
		c.Close()
	}()
	for {
		select {
		case frame := <-c.outbox:
			if err := c.SendText(frame); err != nil {
				return // the deferred Close reclaims the dead peer
			}
		case <-c.closing:
			return
		}
	}
}

// eventEnvelope is the wire shape of one backend event: exactly what the
// desktop webview receives from Wails EventsEmit, as JSON. args is null
// when the event carried no data; the browser-side shim normalizes (the
// server does not batch or reshape — one envelope per event, in order).
type eventEnvelope struct {
	Name string        `json:"name"`
	Args []interface{} `json:"args"`
}

// EventTap returns the tap for the desktop event seam: a func receiving
// (name, args) exactly as the app's emit sees them. The mount point
// assigns it to the app's eventTap field; the signature is deliberately
// generic — this package knows nothing about its consumers, and consumers
// know nothing about this package.
//
// The returned func is safe for concurrent use, never blocks for more than
// one bounded enqueue per live client, and never panics into its caller
// (the desktop event path must be untouchable from the web side).
func (s *Server) EventTap() func(name string, args []interface{}) {
	return s.tapEvent
}

// tapEvent marshals the envelope once and fans the frame out to every live
// client. Marshal failures (an unmarshalable payload) are logged and
// dropped for the web side only — the Wails dispatch is untouched by
// construction.
func (s *Server) tapEvent(name string, args []interface{}) {
	defer func() {
		if p := recover(); p != nil {
			s.log.Error("webaccess: event tap panic — desktop dispatch unaffected", "panic", p)
		}
	}()
	frame, err := json.Marshal(eventEnvelope{Name: name, Args: args})
	if err != nil {
		s.log.Warn("webaccess: event not deliverable to web clients",
			"event", name, "err", err)
		return
	}
	s.BroadcastText(frame)
}
