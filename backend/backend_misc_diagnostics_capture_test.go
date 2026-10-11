package backend

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"sync"
	"testing"
)

// miscExpectedDiagnostic describes the entire diagnostic contract, excluding time.
// For records whose payload is inherently variable (e.g. a goroutine dump with
// runtime addresses), set match instead of attrs: match receives the captured
// record and must verify the invariant parts. Exactly one of the two must be
// used; a record never matches both ways.
type miscExpectedDiagnostic struct {
	message string
	attrs   map[string]string
	match   func(got miscExpectedDiagnostic) bool
}

type miscDiagnosticSink struct {
	mu      sync.Mutex
	records []miscExpectedDiagnostic
	levels  []slog.Level
}

type miscDiagnosticHandler struct {
	next  slog.Handler
	sink  *miscDiagnosticSink
	attrs []slog.Attr
}

func (h *miscDiagnosticHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return level >= slog.LevelWarn || h.next.Enabled(ctx, level)
}

func (h *miscDiagnosticHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level < slog.LevelWarn {
		return h.next.Handle(ctx, r)
	}
	attrs := make(map[string]string)
	for _, a := range h.attrs {
		attrs[a.Key] = fmt.Sprint(a.Value.Resolve().Any())
	}
	r.Attrs(func(a slog.Attr) bool {
		attrs[a.Key] = fmt.Sprint(a.Value.Resolve().Any())
		return true
	})
	h.sink.mu.Lock()
	defer h.sink.mu.Unlock()
	h.sink.records = append(h.sink.records, miscExpectedDiagnostic{message: r.Message, attrs: attrs})
	h.sink.levels = append(h.sink.levels, r.Level)
	return nil
}

func (h *miscDiagnosticHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &miscDiagnosticHandler{next: h.next.WithAttrs(attrs), sink: h.sink, attrs: append(append([]slog.Attr(nil), h.attrs...), attrs...)}
}

func (h *miscDiagnosticHandler) WithGroup(name string) slog.Handler {
	// These API diagnostics do not use groups. Preserve any unexpected group
	// in the captured payload so it cannot silently match an expectation.
	return h.WithAttrs([]slog.Attr{slog.String("unexpected_group", name)})
}

func captureMiscDiagnostics(t *testing.T, f *FrontendAPI, want ...miscExpectedDiagnostic) {
	t.Helper()
	previous := f.logger
	sink := &miscDiagnosticSink{}
	f.logger = slog.New(&miscDiagnosticHandler{next: f.log().Handler(), sink: sink})
	t.Cleanup(func() {
		f.logger = previous
		sink.mu.Lock()
		defer sink.mu.Unlock()
		usesMatchers := false
		for i := range want {
			if want[i].match != nil {
				usesMatchers = true
				break
			}
		}
		if !usesMatchers && !reflect.DeepEqual(sink.records, want) {
			t.Errorf("backend diagnostics(%s) = %#v, want %#v", t.Name(), sink.records, want)
		}
		if len(sink.records) != len(want) {
			t.Errorf("backend diagnostics(%s): %d records, want %d: %#v", t.Name(), len(sink.records), len(want), sink.records)
		}
		for i, rec := range sink.records {
			if i >= len(want) {
				break
			}
			if want[i].match != nil {
				if !want[i].match(rec) {
					t.Errorf("backend diagnostics(%s) record %d = %#v, failed its matcher", t.Name(), i, rec)
				}
				continue
			}
			if !reflect.DeepEqual(rec, want[i]) {
				t.Errorf("backend diagnostics(%s) record %d = %#v, want %#v", t.Name(), i, rec, want[i])
			}
		}
		for i, level := range sink.levels {
			if level != slog.LevelWarn {
				t.Errorf("backend diagnostics(%s) record %d level = %v, want %v", t.Name(), i, level, slog.LevelWarn)
			}
		}
	})
}

func miscRemoteFailure(args string) miscExpectedDiagnostic {
	return miscExpectedDiagnostic{message: "git remote operation failed", attrs: map[string]string{"args": args, "error": "git: exit status 128"}}
}
