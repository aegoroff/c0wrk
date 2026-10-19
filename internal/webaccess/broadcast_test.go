// SPDX-License-Identifier: Apache-2.0
//
// broadcast_test.go — the event fan-out contract: envelope shape, per-client
// FIFO order and payload integrity, fan-out to multiple clients, the
// backpressure drop (overflow → Warn + close, producer never blocks), and
// the recovers on both goroutines (write pump, tap).

package webaccess

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// captureHandler and its helpers (count, snapshot) live in webaccess_test.go
// — shared across the package's test files. Expected diagnostics are
// intercepted and asserted, never silently discarded.

// newCaptureTestServer builds a real-listener server whose diagnostics land
// in a capture the test can assert on.
func newCaptureTestServer(t *testing.T) (srv *Server, ts *httptest.Server, capture *captureHandler) {
	t.Helper()
	capture = &captureHandler{}
	srv = mustNew(t, newTestOptions(stubDispatch{}, func(o *Options) {
		o.Logger = slog.New(capture)
	}))
	ts = httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts, capture
}

// registerStalledClient registers a client whose socket nobody ever reads:
// net.Pipe is unbuffered, so the write pump blocks on the very first frame
// — a deterministic, fully stalled client. Returns the client end (reads
// hit an error once the server drops it).
func registerStalledClient(t *testing.T, srv *Server) (c *WSConn, clientEnd net.Conn) {
	t.Helper()
	serverEnd, clientEnd := net.Pipe()
	t.Cleanup(func() {
		_ = serverEnd.Close()
		_ = clientEnd.Close()
	})
	c = &WSConn{
		srv:     srv,
		conn:    serverEnd,
		br:      bufio.NewReader(serverEnd),
		bw:      bufio.NewWriter(serverEnd),
		outbox:  make(chan []byte, wsEventQueueCap),
		closing: make(chan struct{}),
	}
	srv.registerWS(c)
	go srv.wsWritePump(c)
	return c, clientEnd
}

// tapEvents invokes the tap for i in [0,n) sequentially, mimicking the
// desktop event goroutine.
func tapEvents(tap func(name string, args []interface{}), n int) {
	for i := 0; i < n; i++ {
		tap("ev:flood", []interface{}{i})
	}
}

// dialRealClient performs an authenticated, same-origin upgrade against ts
// and returns the frame reader.
func dialRealClient(t *testing.T, srv *Server, ts *httptest.Server, key string) *bufio.Reader {
	t.Helper()
	host := strings.TrimPrefix(ts.URL, "http://")
	client := loginClient(t, ts.URL, srv.AuthToken())
	conn := dialWS(t, ts, cookieHeader(t, client, ts.URL), "http://"+host, key)
	resp := readWSResponse(t, conn)
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade status = %d", resp.StatusCode)
	}
	return bufio.NewReader(conn)
}

func TestEventTapEnvelopeOrderAndPayloadIntegrity(t *testing.T) {
	srv, ts, _ := newCaptureTestServer(t)
	br := dialRealClient(t, srv, ts, "c3RpY2tleS1rZXktMTIzNDU=")

	type ev struct {
		name string
		args []interface{}
	}
	sent := []ev{
		{name: "ev:no-args"}, // nil args → "args":null on the wire
		{name: "ev:multi", args: []interface{}{"text", 2, true}},
		{name: "ev:nested", args: []interface{}{map[string]interface{}{"k": []interface{}{1.5, "v"}}}},
	}
	tap := srv.EventTap()
	for _, e := range sent {
		tap(e.name, e.args)
	}

	for _, want := range sent {
		fin, op, payload := expectFrameOrDie(t, br)
		if !fin || op != opText {
			t.Fatalf("frame = (fin=%t op=%d), want a single text frame", fin, op)
		}
		// Wire shape: exactly the keys "name" and "args".
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(payload, &fields); err != nil {
			t.Fatalf("payload %s is not an object: %v", payload, err)
		}
		if len(fields) != 2 || fields["name"] == nil || fields["args"] == nil {
			t.Fatalf("payload %s must carry exactly {name,args}", payload)
		}
		// Byte-exact integrity against the marshaled envelope.
		wantPayload, err := json.Marshal(eventEnvelope{Name: want.name, Args: want.args})
		if err != nil {
			t.Fatalf("marshal expected envelope: %v", err)
		}
		if !bytes.Equal(payload, wantPayload) {
			t.Fatalf("payload = %s, want %s", payload, wantPayload)
		}
	}
}

func TestEventTapFansOutToBothClientsInOrder(t *testing.T) {
	srv, ts, _ := newCaptureTestServer(t)
	readerA := dialRealClient(t, srv, ts, "ZmFuLW91dC1rZXktMTIzNA==")
	readerB := dialRealClient(t, srv, ts, "ZmFuLW91dC1rZXktNDU2Nw==")

	tap := srv.EventTap()
	tap("ev:one", []interface{}{1})
	tap("ev:two", []interface{}{"two"})

	for i, br := range []*bufio.Reader{readerA, readerB} {
		_, op, p1 := expectFrameOrDie(t, br)
		if op != opText {
			t.Fatalf("client %d: first frame op = %d", i, op)
		}
		_, op, p2 := expectFrameOrDie(t, br)
		if op != opText {
			t.Fatalf("client %d: second frame op = %d", i, op)
		}
		var n1, n2 eventEnvelope
		if err := json.Unmarshal(p1, &n1); err != nil || n1.Name != "ev:one" {
			t.Fatalf("client %d: first event = %q (%v), want ev:one", i, n1.Name, err)
		}
		if err := json.Unmarshal(p2, &n2); err != nil || n2.Name != "ev:two" {
			t.Fatalf("client %d: second event = %q (%v), want ev:two", i, n2.Name, err)
		}
	}
}

func TestEventTapStalledClientDoesNotImpedeHealthyClient(t *testing.T) {
	srv, ts, capture := newCaptureTestServer(t)
	stalled, _ := registerStalledClient(t, srv)
	br := dialRealClient(t, srv, ts, "aGVhbHRoeS1rZXktMTIzNDU2")

	// Bounded load (far below the queue cap): the stalled client's queue
	// absorbs, the healthy client receives everything in order.
	const n = 20
	tap := srv.EventTap()
	tapEvents(tap, n)

	for i := 0; i < n; i++ {
		_, op, payload := expectFrameOrDie(t, br)
		if op != opText {
			t.Fatalf("healthy frame %d: op = %d", i, op)
		}
		var env eventEnvelope
		if err := json.Unmarshal(payload, &env); err != nil {
			t.Fatalf("healthy frame %d: %v", i, err)
		}
		got, ok := env.Args[0].(float64)
		if !ok || got != float64(i) {
			t.Fatalf("healthy frame %d: arg = %#v, want %d", i, env.Args[0], i)
		}
	}
	if queued := len(stalled.outbox); queued == 0 {
		t.Fatalf("stalled client's queue is empty — the stall was not exercised")
	}
	if records := capture.snapshot(); len(records) != 0 {
		t.Fatalf("bounded load must not drop anybody, got diagnostics: %+v", records)
	}
}

func TestEventTapOverflowsStalledClient(t *testing.T) {
	srv, _, capture := newCaptureTestServer(t)
	_, clientEnd := registerStalledClient(t, srv)

	// A burst beyond the cap: the pump is wedged on frame one, so the
	// outbox fills and overflows. The tap loop below never blocks — it is
	// the producer side of the contract.
	tapEvents(srv.EventTap(), wsEventQueueCap+2)

	// Exactly one overflow → one Warn → the client is dropped.
	records := capture.snapshot()
	if len(records) != 1 {
		t.Fatalf("diagnostics = %d records, want exactly 1 overflow Warn", len(records))
	}
	if records[0].Level != slog.LevelWarn || !strings.Contains(records[0].Message, "outbox overflow") {
		t.Fatalf("diagnostic = (%s %q), want a Warn naming the overflow", records[0].Level, records[0].Message)
	}

	// The drop closed the socket: reads fail promptly instead of hanging.
	_ = clientEnd.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := clientEnd.Read(make([]byte, 1)); err == nil {
		t.Fatal("stalled client socket still readable after overflow drop")
	}
	if conns := srv.liveConns(); len(conns) != 0 {
		t.Fatalf("dropped client still registered: %d conns", len(conns))
	}

	// Post-drop taps touch nobody: still exactly one Warn, no re-drops.
	tapEvents(srv.EventTap(), 10)
	if records := capture.snapshot(); len(records) != 1 {
		t.Fatalf("post-drop diagnostics = %d records, want still 1: %+v", len(records), records)
	}
}

// panicWriteConn panics on its first Write, then reports a dead socket —
// exercising the write pump's recover without taking the process down
// (the pump's post-recover Close writes the close frame, which must NOT
// panic again).
type panicWriteConn struct {
	writes atomic.Int32
}

func (c *panicWriteConn) Read([]byte) (int, error) { return 0, io.EOF }
func (c *panicWriteConn) Write([]byte) (int, error) {
	if c.writes.Add(1) == 1 {
		panic("broadcast_test: injected write panic")
	}
	return 0, errors.New("dead")
}
func (c *panicWriteConn) Close() error                     { return nil }
func (c *panicWriteConn) LocalAddr() net.Addr              { return nil }
func (c *panicWriteConn) RemoteAddr() net.Addr             { return nil }
func (c *panicWriteConn) SetDeadline(time.Time) error      { return nil }
func (c *panicWriteConn) SetReadDeadline(time.Time) error  { return nil }
func (c *panicWriteConn) SetWriteDeadline(time.Time) error { return nil }

func TestWSWritePumpRecoversFromPanic(t *testing.T) {
	srv, _, capture := newCaptureTestServer(t)
	c := &WSConn{
		srv:     srv,
		conn:    &panicWriteConn{},
		br:      bufio.NewReader(&panicWriteConn{}),
		bw:      bufio.NewWriter(&panicWriteConn{}),
		outbox:  make(chan []byte, wsEventQueueCap),
		closing: make(chan struct{}),
	}
	srv.registerWS(c)
	go srv.wsWritePump(c)

	c.enqueue([]byte("boom"))
	select {
	case <-c.closing:
		// The pump recovered, logged, and tore the connection down.
	case <-time.After(5 * time.Second):
		t.Fatal("write pump did not exit after a panic (connection not closed)")
	}
	records := capture.snapshot()
	if len(records) != 1 {
		t.Fatalf("diagnostics = %d records, want exactly 1: %+v", len(records), records)
	}
	if records[0].Level != slog.LevelError || !strings.Contains(records[0].Message, "write pump panic") {
		t.Fatalf("diagnostic = (%s %q), want an Error naming the pump panic", records[0].Level, records[0].Message)
	}
	if conns := srv.liveConns(); len(conns) != 0 {
		t.Fatalf("panicked client still registered: %d conns", len(conns))
	}
}

func TestEventTapRecoversFromPanic(t *testing.T) {
	// A registry entry with a nil srv makes the fan-out's Warn path
	// dereference nil inside the tap — the tap's recover must contain it
	// so the desktop event goroutine (its caller) is never touched.
	capture := &captureHandler{}
	srv := &Server{log: slog.New(capture), wsConns: make(map[*WSConn]struct{})}
	srv.wsConns[&WSConn{}] = struct{}{}

	srv.tapEvent("ev:poison", []interface{}{"x"}) // must not panic out of the tap

	records := capture.snapshot()
	if len(records) != 1 {
		t.Fatalf("diagnostics = %d records, want exactly 1: %+v", len(records), records)
	}
	if records[0].Level != slog.LevelError || !strings.Contains(records[0].Message, "event tap panic") {
		t.Fatalf("diagnostic = (%s %q), want an Error naming the tap panic", records[0].Level, records[0].Message)
	}
}
