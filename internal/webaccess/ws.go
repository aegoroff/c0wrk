// SPDX-License-Identifier: Apache-2.0
//
// ws.go — the /ws event channel: RFC6455 handshake and a minimal frame
// codec, hand-rolled on the stdlib because the sidecar's dependency set is
// stdlib + backend/config by contract (no websocket library).
//
// Admission is layered: requireAuth (session cookie) runs before this
// handler in the route table; the same-origin Origin check runs here —
// browsers always send Origin on a WebSocket handshake, and a mismatched or
// missing one is a cross-site hijack attempt (cookie-based auth alone would
// otherwise ride along on any page's behalf).
//
// Stage-1 scope: text frames in and out, ping/pong/close handled, control
// frames interleaved with fragmented messages, fragment total capped. No
// compression (permessage-deflate is never offered). A dead peer is
// reclaimed when a write fails or the read loop errors; there is no
// keepalive timer yet (stage 2).

package webaccess

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// wsGUID is the RFC6455 handshake GUID.
	wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	// wsMaxMessageSize caps a single (possibly fragmented) inbound message.
	wsMaxMessageSize = maxBodyBytes
	// wsMaxControlPayload is the RFC6455 §5.5 ceiling for one control
	// frame's payload; a larger control frame is a protocol violation.
	wsMaxControlPayload = 125
	// wsWriteTimeout bounds a single frame write so one stuck client cannot
	// stall broadcasts to every other client.
	wsWriteTimeout = 10 * time.Second
	// wsHandshakeTimeout bounds reading the (already-arrived) handshake bytes.
	wsHandshakeTimeout = 10 * time.Second
)

// WebSocket opcodes (RFC6455 §5.2).
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// Close codes used by this server.
const (
	closeNormal      = 1000
	closeGoingAway   = 1001
	closeProtocolErr = 1002
	closeTooBig      = 1009
)

// ws errors (connection-fatal by definition; the read loop closes on them).
var (
	errWSProtocol = errors.New("websocket protocol violation")
	errWSTooBig   = errors.New("websocket message too large")
)

// WSConn is one accepted websocket connection. Safe for concurrent use.
type WSConn struct {
	srv  *Server
	conn net.Conn
	br   *bufio.Reader
	bw   *bufio.Writer

	// outbox is the per-client bounded outbound queue (broadcast.go): the
	// fan-out never blocks on a slow client — overflow aborts the client
	// instead (it reconnects with backoff).
	outbox chan []byte
	// closing is closed exactly once when the connection is torn down; it
	// wakes the write pump so it never drains a dead queue.
	closing chan struct{}

	writeMu sync.Mutex
	closed  sync.Once
}

// handleWS upgrades an authenticated, same-origin request to a websocket and
// hands the connection to the fan-out registry. The HTTP handler returns
// after the pump goroutine takes over (the hijacked conn outlives it).
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(r) {
		writeJSONError(w, http.StatusForbidden, "cross-origin websocket connections are rejected")
		return
	}
	key := wsHandshakeKey(r)
	if key == "" {
		writeJSONError(w, http.StatusBadRequest, "websocket upgrade required")
		return
	}
	// RFC6455 §4.2.2: only version 13 is spoken here; a mismatched request is
	// refused with the supported version named back. Checked after the
	// upgrade-header gate so a non-upgrade request keeps its 400.
	if v := r.Header.Get("Sec-WebSocket-Version"); v != "13" {
		w.Header().Set("Sec-WebSocket-Version", "13")
		writeJSONError(w, http.StatusUpgradeRequired, "unsupported websocket version")
		return
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "connection cannot be upgraded")
		return
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "connection cannot be upgraded")
		return
	}
	// From here on the raw conn is ours; every exit path closes it.
	c := &WSConn{
		srv:     s,
		conn:    conn,
		br:      brw.Reader,
		bw:      brw.Writer,
		outbox:  make(chan []byte, wsEventQueueCap),
		closing: make(chan struct{}),
	}
	// Register BEFORE the 101 goes on the wire. A client that has observed
	// the 101 may broadcast immediately (the web shim subscribes the moment
	// the socket opens), and a hub snapshot taken before registration would
	// legally drop that frame under at-most-once semantics — a delivery hole
	// with no client-side remedy. With this ordering, registration strictly
	// precedes the handshake write, so any broadcast triggered by the 101 is
	// guaranteed to snapshot the connection; frames landing between
	// registration and pump start queue in the bounded outbox and the write
	// pump drains them right after the handshake, keeping 101-first wire
	// ordering intact.
	s.registerWS(c)
	if err := wsWriteHandshake(conn, key); err != nil {
		c.Close() //nolint:errcheck // nothing left to report to a dead peer
		return
	}
	// The handshake deadline must not leak into the live connection.
	conn.SetDeadline(time.Time{}) //nolint:errcheck // best-effort bound
	go s.wsWritePump(c)
	go s.wsReadPump(c)
}

// wsHandshakeKey validates the upgrade headers and returns the client key,
// or "" when this is not a websocket upgrade.
func wsHandshakeKey(r *http.Request) string {
	if !tokenListContains(r.Header, "Connection", "upgrade") ||
		!strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return ""
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return ""
	}
	return key
}

// wsWriteHandshake writes the 101 response with the derived accept value.
func wsWriteHandshake(conn net.Conn, key string) error {
	sum := sha1.Sum([]byte(key + wsGUID)) //nolint:gosec // SHA-1 is mandated by RFC6455 for the handshake
	accept := base64.StdEncoding.EncodeToString(sum[:])
	conn.SetDeadline(time.Now().Add(wsHandshakeTimeout)) //nolint:errcheck // best-effort bound
	_, err := fmt.Fprintf(conn,
		"HTTP/1.1 101 Switching Protocols\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: Upgrade\r\n"+
			"Sec-WebSocket-Accept: %s\r\n\r\n", accept)
	return err
}

// tokenListContains reports whether the named header's comma-separated token
// list contains want (case-insensitive), per RFC 7230 list-of-tokens.
func tokenListContains(h http.Header, name, want string) bool {
	for _, v := range h.Values(name) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), want) {
				return true
			}
		}
	}
	return false
}

// sameOrigin reports whether the request's Origin header (mandatory on
// browser websocket handshakes) matches the request host exactly — scheme
// and host:port. Missing Origin is a non-browser client; the handshake is
// rejected because cookie credentials make every origin potentially hostile.
// The Host header itself is additionally checked against the configured
// bind (or the loopback set): an Origin==Host pair whose host is a rebound
// DNS name would otherwise pass the equality check. This is
// defense-in-depth on top of the host-scoped SameSite=Strict cookie — a
// rebinding attacker without the cookie is already rejected by requireAuth.
func (s *Server) sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	if !hostMatchesBind(r.Host, s.cfg.Bind) {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	allowed := scheme + "://" + r.Host
	return origin == allowed
}

// hostMatchesBind reports whether a Host header value (host or host:port)
// names the configured bind or the loopback set. A wildcard bind (the
// unspecified address) names no single serving host, so every Host is
// accepted there — the cookie scope remains the gate for that class, as for
// every class this check alone cannot cover.
func hostMatchesBind(hostHeader, bind string) bool {
	if bind == "0.0.0.0" || bind == "::" {
		return true
	}
	host := hostHeader
	if h, _, err := net.SplitHostPort(hostHeader); err == nil {
		host = h
	}
	if strings.EqualFold(host, bind) || strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// registry ---------------------------------------------------------------------

func (s *Server) registerWS(c *WSConn) {
	s.wsMu.Lock()
	s.wsConns[c] = struct{}{}
	s.wsMu.Unlock()
}

func (s *Server) unregisterWS(c *WSConn) {
	s.wsMu.Lock()
	delete(s.wsConns, c)
	s.wsMu.Unlock()
}

func (s *Server) closeAllWS() {
	s.wsMu.Lock()
	conns := make([]*WSConn, 0, len(s.wsConns))
	for c := range s.wsConns {
		conns = append(conns, c)
	}
	s.wsConns = make(map[*WSConn]struct{})
	s.wsMu.Unlock()
	for _, c := range conns {
		// Stop-path teardown aborts instead of Close: the close frame write
		// carries a 10s deadline per client, so a wedged peer would stall
		// shutdown tab-by-tab after the stop budget already expired. The
		// browser reconnects with backoff.
		c.abort()
	}
}

// BroadcastText fans one text frame out to every connected browser. The
// frame is enqueued on each client's bounded outbox (never written on the
// caller's goroutine): a slow client fills its own queue and is aborted on
// overflow, so one wedged tab can neither block nor lose other clients'
// delivery. Per-client FIFO order is preserved end-to-end.
func (s *Server) BroadcastText(data []byte) {
	for _, c := range s.liveConns() {
		c.enqueue(data)
	}
}

// BroadcastJSON marshals v and broadcasts it as one text frame.
func (s *Server) BroadcastJSON(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		s.log.Error("webaccess: ws broadcast marshal failed", "err", err)
		return
	}
	s.BroadcastText(data)
}

// WSConn methods -----------------------------------------------------------------

// SendText writes one unmasked server text frame.
func (c *WSConn) SendText(data []byte) error { return c.writeFrame(opText, data) }

// liveConns snapshots the currently registered connections.
func (s *Server) liveConns() []*WSConn {
	s.wsMu.Lock()
	conns := make([]*WSConn, 0, len(s.wsConns))
	for c := range s.wsConns {
		conns = append(conns, c)
	}
	s.wsMu.Unlock()
	return conns
}

// Close tears the connection down (idempotent) and unregisters it. The
// best-effort close frame keeps graceful per-client paths (read-loop end,
// protocol close) clean; it is bounded by wsWriteTimeout. The server stop
// path uses abort instead — shutdown must never wait on a peer-bound write.
func (c *WSConn) Close() {
	c.closed.Do(func() {
		c.srv.unregisterWS(c)
		close(c.closing) // wake the write pump before the socket goes away
		_ = c.writeFrame(opClose, wsClosePayload(closeNormal))
		_ = c.conn.Close()
	})
}

// abort tears the connection down without the best-effort close frame —
// the abrupt variant used when a client is dropped for backpressure
// overflow. It never writes (the write path may be wedged) and therefore
// never blocks the producer goroutine that calls it; the client sees the
// socket die and reconnects with backoff.
func (c *WSConn) abort() {
	c.closed.Do(func() {
		c.srv.unregisterWS(c)
		close(c.closing)
		_ = c.conn.Close()
	})
}

// wsClosePayload builds a close-frame body from a code.
func wsClosePayload(code int) []byte {
	b := make([]byte, 2)
	binary.BigEndian.PutUint16(b, uint16(code))
	return b
}

// writeFrame serializes one frame (server frames are never masked).
func (c *WSConn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout)) //nolint:errcheck // deadline is best-effort
	defer c.conn.SetWriteDeadline(time.Time{})              //nolint:errcheck // same

	var header [10]byte
	header[0] = 0x80 | opcode // FIN set: our payloads are always single-frame
	pos := 2
	switch plen := len(payload); {
	case plen < 126:
		header[1] = byte(plen)
	case plen <= 0xFFFF:
		header[1] = 126
		binary.BigEndian.PutUint16(header[2:], uint16(plen))
		pos = 4
	default:
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:], uint64(plen))
		pos = 10
	}
	if _, err := c.bw.Write(header[:pos]); err != nil {
		return err
	}
	if _, err := c.bw.Write(payload); err != nil {
		return err
	}
	return c.bw.Flush()
}

// wsReadPump drains frames until the peer goes away. Every message is
// delivered to the inbound callback (if wired); the goroutine carries its
// own recover so a misbehaving callback cannot take the process down.
func (s *Server) wsReadPump(c *WSConn) {
	defer func() {
		if p := recover(); p != nil {
			s.log.Error("webaccess: ws read pump panic", "panic", p)
		}
		c.Close()
	}()
	for {
		opcode, payload, err := c.readMessage()
		if err != nil {
			return
		}
		// readMessage answers interleaved control frames (ping/pong/close)
		// internally, so only data messages reach this switch.
		switch opcode {
		case opText, opBinary:
			if s.wsInbound != nil {
				s.wsInbound(c, payload)
			}
		}
	}
}

// readMessage assembles one complete message, answering interleaved control
// frames as they arrive.
func (c *WSConn) readMessage() (opcode byte, payload []byte, err error) {
	var (
		assembled  []byte
		firstOp    byte
		inFragment bool
	)
	for {
		var fin bool
		var op byte
		var data []byte
		fin, op, data, err = c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case opPing:
			if err := c.writeFrame(opPong, data); err != nil {
				return 0, nil, err
			}
		case opPong:
			// keepalive replies are absorbed silently
		case opClose:
			_ = c.writeFrame(opClose, data)
			return 0, nil, io.EOF
		case opText, opBinary:
			if inFragment {
				return 0, nil, errWSProtocol
			}
			if fin {
				return op, data, nil // the common case: single unfragmented frame
			}
			firstOp, inFragment = op, true
			assembled = append(assembled, data...)
			if len(assembled) > wsMaxMessageSize {
				return 0, nil, errWSTooBig
			}
		case opContinuation:
			if !inFragment {
				return 0, nil, errWSProtocol
			}
			assembled = append(assembled, data...)
			if len(assembled) > wsMaxMessageSize {
				return 0, nil, errWSTooBig
			}
			if fin {
				return firstOp, assembled, nil
			}
		default:
			return 0, nil, errWSProtocol
		}
	}
}

// readFrame reads exactly one frame, unmasks it, and enforces the protocol
// rules this server cares about: no reserved bits (no extensions), client
// frames must be masked, lengths within cap.
func (c *WSConn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(c.br, hdr[:]); err != nil {
		return false, 0, nil, err
	}
	fin = hdr[0]&0x80 != 0
	if hdr[0]&0x70 != 0 {
		return false, 0, nil, errWSProtocol // RSV bits: no extensions negotiated
	}
	opcode = hdr[0] & 0x0F
	masked := hdr[1]&0x80 != 0
	if !masked {
		// Clients MUST mask (RFC6455 §5.1); an unmasked client frame is a
		// smuggling attempt.
		return false, 0, nil, errWSProtocol
	}
	length := uint64(hdr[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if opcode&0x8 != 0 && length > wsMaxControlPayload {
		// RFC6455 §5.5: control frames (opcode high bit set) MUST have a
		// payload of 125 bytes or less.
		return false, 0, nil, errWSProtocol
	}
	if length > wsMaxMessageSize {
		return false, 0, nil, errWSTooBig
	}
	var mask [4]byte
	if _, err = io.ReadFull(c.br, mask[:]); err != nil {
		return false, 0, nil, err
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return false, 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return fin, opcode, payload, nil
}
