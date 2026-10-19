// SPDX-License-Identifier: Apache-2.0
//
// ws_test.go — the /ws admission matrix (cookie, Origin) and the frame
// codec round-trip over a real socket: handshake accept value, server
// broadcast, client inbound delivery, ping/pong, and close.

package webaccess

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"

	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// dialWS performs the raw upgrade handshake and returns the open connection.
func dialWS(t *testing.T, ts *httptest.Server, cookie, origin, key string) net.Conn {
	t.Helper()
	var dialer net.Dialer
	conn, err := dialer.DialContext(context.Background(), "tcp", strings.TrimPrefix(ts.URL, "http://"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() }) //nolint:errcheck // best-effort cleanup
	req := "GET /ws HTTP/1.1\r\n" +
		"Host: " + strings.TrimPrefix(ts.URL, "http://") + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n"
	if cookie != "" {
		req += "Cookie: " + cookie + "\r\n"
	}
	if origin != "" {
		req += "Origin: " + origin + "\r\n"
	}
	req += "\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write handshake: %v", err)
	}
	return conn
}

// readWSResponse reads the HTTP response of the handshake.
func readWSResponse(t *testing.T, conn net.Conn) *http.Response {
	t.Helper()
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return resp
}

// writeClientFrame writes one MASKED client frame (clients must mask).
func writeClientFrame(t *testing.T, conn net.Conn, fin bool, opcode byte, payload []byte) {
	t.Helper()
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b0 := byte(0)
	if fin {
		b0 = 0x80
	}
	b0 |= opcode
	hdr := make([]byte, 0, 2+len(mask)+len(payload))
	hdr = append(hdr, b0, 0x80|byte(len(payload))) // always masked; len < 126 in tests
	hdr = append(hdr, mask[:]...)
	masked := make([]byte, len(payload))
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	if _, err := conn.Write(append(hdr, masked...)); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

// readServerFrame reads one unmasked server frame.
func readServerFrame(conn *bufio.Reader) (fin bool, opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(conn, hdr[:]); err != nil {
		return false, 0, nil, err
	}
	fin = hdr[0]&0x80 != 0
	opcode = hdr[0] & 0x0F
	if hdr[1]&0x80 != 0 {
		return false, 0, nil, errors.New("server frame is masked")
	}
	length := int(hdr[1] & 0x7F)
	payload = make([]byte, length)
	if _, err = io.ReadFull(conn, payload); err != nil {
		return false, 0, nil, err
	}
	return fin, opcode, payload, nil
}

// expectFrameOrDie wraps readServerFrame with a watchdog so a missing frame
// fails the test instead of hanging it.
func expectFrameOrDie(t *testing.T, conn *bufio.Reader) (fin bool, opcode byte, payload []byte) {
	t.Helper()
	type result struct {
		fin     bool
		opcode  byte
		payload []byte
		err     error
	}
	ch := make(chan result, 1)
	go func() {
		f, o, p, err := readServerFrame(conn)
		ch <- result{f, o, p, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("read frame: %v", r.err)
		}
		return r.fin, r.opcode, r.payload
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for a websocket frame")
		return false, 0, nil
	}
}

func TestWSAdmissionMatrix(t *testing.T) {
	srv, ts := newTestServer(t, nil)
	host := strings.TrimPrefix(ts.URL, "http://")
	client := loginClient(t, ts.URL, srv.AuthToken())

	// Extract the session cookie value for raw requests.
	u := mustParse(t, ts.URL)
	cookies := client.Jar.Cookies(u)
	if len(cookies) == 0 {
		t.Fatal("no session cookie after login")
	}
	cookie := cookies[0].Name + "=" + cookies[0].Value

	cases := []struct {
		name       string
		cookie     string
		origin     string
		wantStatus int
	}{
		{"no cookie is 401", "", hostOrigin(host), http.StatusUnauthorized},
		{"cookie but wrong origin is 403", cookie, "http://evil.example", http.StatusForbidden},
		{"cookie but missing origin is 403", cookie, "", http.StatusForbidden},
		{"cookie and same-origin upgrades", cookie, hostOrigin(host), http.StatusSwitchingProtocols},
		{"https origin on http host is a mismatch", cookie, "https://" + host, http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			conn := dialWS(t, ts, tc.cookie, tc.origin, "dGhlIHNhbXBsZSBub25jZQ==")
			resp := readWSResponse(t, conn)
			if resp.StatusCode != tc.wantStatus {
				_ = resp.Body.Close()
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.wantStatus)
			}
			_ = resp.Body.Close()
		})
	}
}

func hostOrigin(host string) string { return "http://" + host }

func TestWSHandshakeAcceptValue(t *testing.T) {
	srv, ts := newTestServer(t, nil)
	host := strings.TrimPrefix(ts.URL, "http://")

	client := loginClient(t, ts.URL, srv.AuthToken())
	cookie := cookieHeader(t, client, ts.URL)
	conn := dialWS(t, ts, cookie, hostOrigin(host), "dGhlIHNhbXBsZSBub25jZQ==")
	resp := readWSResponse(t, conn)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	// RFC6455 §1.3 example: the known key must produce the known accept.
	want := base64.StdEncoding.EncodeToString(sha1Sum([]byte("dGhlIHNhbXBsZSBub25jZQ==" + wsGUID)))
	if got := resp.Header.Get("Sec-WebSocket-Accept"); got != want {
		t.Fatalf("accept = %q, want %q", got, want)
	}
}

func sha1Sum(b []byte) []byte {
	s := sha1.Sum(b) //nolint:gosec // RFC6455 mandates SHA-1 for the handshake
	return s[:]
}

// mustParse parses a raw URL for the test.
func mustParse(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return u
}

func cookieHeader(t *testing.T, client *http.Client, rawURL string) string {
	t.Helper()
	u := mustParse(t, rawURL)
	cookies := client.Jar.Cookies(u)
	if len(cookies) == 0 {
		t.Fatal("no cookie")
	}
	parts := make([]string, 0, len(cookies))
	for _, c := range cookies {
		parts = append(parts, c.Name+"="+c.Value)
	}
	return strings.Join(parts, "; ")
}

func TestWSFrameRoundTrip(t *testing.T) {
	inbound := make(chan []byte, 4)
	srv, ts := newTestServer(t, func(o *Options) {
		o.WSInbound = func(_ *WSConn, data []byte) {
			inbound <- data
		}
	})
	host := strings.TrimPrefix(ts.URL, "http://")

	client := loginClient(t, ts.URL, srv.AuthToken())
	cookie := cookieHeader(t, client, ts.URL)
	conn := dialWS(t, ts, cookie, hostOrigin(host), "c2VydmVyLXNpZGUtdGVzdA==")
	resp := readWSResponse(t, conn)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	br := bufio.NewReader(conn)

	// 1. Client → server inbound text; the callback must receive it. The
	// callback firing proves the read pump is running, which proves the
	// connection is registered for broadcasts.
	writeClientFrame(t, conn, true, opText, []byte(`{"hello":"web"}`))
	select {
	case got := <-inbound:
		if string(got) != `{"hello":"web"}` {
			t.Fatalf("inbound = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for inbound message")
	}

	// 2. Server → client broadcast.
	srv.BroadcastText([]byte("push-1"))
	fin, op, payload := expectFrameOrDie(t, br)
	if !fin || op != opText || string(payload) != "push-1" {
		t.Fatalf("broadcast frame = (fin=%t op=%d %q)", fin, op, payload)
	}

	// 3. BroadcastJSON marshals before sending.
	srv.BroadcastJSON(map[string]string{"kind": "event"})
	_, op, payload = expectFrameOrDie(t, br)
	if op != opText {
		t.Fatalf("json frame op = %d, want text", op)
	}
	var decoded map[string]string
	if err := json.Unmarshal(payload, &decoded); err != nil || decoded["kind"] != "event" {
		t.Fatalf("json payload = %q (%v)", payload, err)
	}

	// 4. Ping → pong.
	writeClientFrame(t, conn, true, opPing, []byte("keepalive"))
	_, op, payload = expectFrameOrDie(t, br)
	if op != opPong || string(payload) != "keepalive" {
		t.Fatalf("pong = (op=%d %q)", op, payload)
	}

	// 5. Client close is echoed, then the server drops the connection.
	writeClientFrame(t, conn, true, opClose, wsClosePayload(closeNormal))
	_, op, _ = expectFrameOrDie(t, br)
	if op != opClose {
		t.Fatalf("close echo = op %d", op)
	}
}

func TestWSFragmentedMessageReassembles(t *testing.T) {
	inbound := make(chan []byte, 4)
	srv, ts := newTestServer(t, func(o *Options) {
		o.WSInbound = func(_ *WSConn, data []byte) { inbound <- data }
	})
	host := strings.TrimPrefix(ts.URL, "http://")
	client := loginClient(t, ts.URL, srv.AuthToken())
	cookie := cookieHeader(t, client, ts.URL)
	conn := dialWS(t, ts, cookie, hostOrigin(host), "ZnJhZ21lbnQta2V5LTEyMw==")
	resp := readWSResponse(t, conn)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	// three fragments: text !FIN, continuation !FIN, continuation FIN
	writeClientFrame(t, conn, false, opText, []byte("frag-"))
	writeClientFrame(t, conn, false, opContinuation, []byte("mid-"))
	writeClientFrame(t, conn, true, opContinuation, []byte("end"))
	select {
	case got := <-inbound:
		if string(got) != "frag-mid-end" {
			t.Fatalf("assembled = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for fragmented message")
	}
}

func TestWSBroadcastReachesMultipleClientsAndDropsDead(t *testing.T) {
	srv, ts := newTestServer(t, nil)
	host := strings.TrimPrefix(ts.URL, "http://")

	conns := make([]net.Conn, 0, 2)
	readers := make([]*bufio.Reader, 0, 2)
	for i := 0; i < 2; i++ {
		client := loginClient(t, ts.URL, srv.AuthToken())
		cookie := cookieHeader(t, client, ts.URL)
		conn := dialWS(t, ts, cookie, hostOrigin(host), "bXVsdGktY2xpZW50LWtleQ==")
		resp := readWSResponse(t, conn)
		if resp.StatusCode != http.StatusSwitchingProtocols {
			_ = resp.Body.Close()
			t.Fatalf("client %d: status = %d", i, resp.StatusCode)
		}
		_ = resp.Body.Close()
		conns = append(conns, conn)
		readers = append(readers, bufio.NewReader(conn))
	}
	srv.BroadcastText([]byte("to-all"))
	for i, r := range readers {
		_, op, payload := expectFrameOrDie(t, r)
		if op != opText || string(payload) != "to-all" {
			t.Fatalf("client %d: op=%d payload=%q", i, op, payload)
		}
	}

	// A dead peer must not wedge the next broadcast: kill one conn, then
	// broadcast again; the broadcast write to the dead peer fails and drops
	// it, while the survivor still receives.
	conns[0].Close() //nolint:errcheck // simulating an abrupt disconnect
	srv.BroadcastText([]byte("after-death"))
	_, op, payload := expectFrameOrDie(t, readers[1])
	if op != opText || string(payload) != "after-death" {
		t.Fatalf("survivor: op=%d payload=%q", op, payload)
	}
}

func TestWSMethodMismatchIsRefused(t *testing.T) {
	srv, ts := newTestServer(t, nil)
	client := loginClient(t, ts.URL, srv.AuthToken())
	// A plain GET with websocket-ish headers but no Upgrade token → 400.
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.URL+"/ws", http.NoBody)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Origin", hostOrigin(strings.TrimPrefix(ts.URL, "http://")))
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (non-upgrade request)", resp.StatusCode)
	}
}

func TestWSStopClosesConnections(t *testing.T) {
	srv, ts := newTestServer(t, nil)
	host := strings.TrimPrefix(ts.URL, "http://")
	client := loginClient(t, ts.URL, srv.AuthToken())
	cookie := cookieHeader(t, client, ts.URL)
	conn := dialWS(t, ts, cookie, hostOrigin(host), "c3RvcC10ZXN0LWtleS0xMg==")
	resp := readWSResponse(t, conn)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	if err := srv.Stop(context.Background()); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	// The hijacked conn must be closed by Stop: after the close frame (if
	// any) the reads hit EOF. io.ReadAll reports a clean EOF as nil; a
	// DEADLINE (never closed) is the failure.
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, rerr := io.ReadAll(conn)
	if errors.Is(rerr, os.ErrDeadlineExceeded) {
		t.Fatal("connection still open after Stop (read deadline hit)")
	}
	// Any other outcome — clean EOF or a reset — proves the conn is dead.
}

// TestStopWithExpiredDeadlineForceCloses pins the bounded-stop contract the
// desktop Shutdown (and SetWebAccessEnabled(false)) ride on: with a live
// hijacked WebSocket keeping the graceful drain busy, Stop under an EXPIRED
// caller deadline must still return promptly — never wait past the deadline —
// and the force close must take the connection down with it. An idle server's
// stop is instant under the same deadline (the listeners close first and
// nothing drains); this test pins the busy one, where the budget is what
// converts the stall into a close instead of a quit that hangs.
func TestStopWithExpiredDeadlineForceCloses(t *testing.T) {
	srv, ts := newTestServer(t, nil)
	host := strings.TrimPrefix(ts.URL, "http://")
	client := loginClient(t, ts.URL, srv.AuthToken())
	cookie := cookieHeader(t, client, ts.URL)
	conn := dialWS(t, ts, cookie, hostOrigin(host), "c3RvcC10ZXN0LWtleS0xMg==")
	resp := readWSResponse(t, conn)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	expired, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- srv.Stop(expired) }()
	select {
	case err := <-done:
		// Either outcome is contract-legal; only the BOUND is asserted here.
		// The drain losing to the deadline yields the ctx error (and the
		// force close below); a drain that finished first yields nil.
		_ = err
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not return within 5s of an expired deadline")
	}
	// The hijacked conn must be dead regardless of which path won.
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, rerr := io.ReadAll(conn); errors.Is(rerr, os.ErrDeadlineExceeded) {
		t.Fatal("connection still open after the expired-deadline Stop (read deadline hit)")
	}
}
