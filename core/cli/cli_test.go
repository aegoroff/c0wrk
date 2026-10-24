package cli

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/core/version"
)

func TestParse(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		want    Request
		wantErr string // empty: expect success; non-empty: substring of the error
	}{
		{
			name: "empty args mean run",
			args: nil,
			want: Request{Action: ActionRun},
		},
		{
			name: "short help",
			args: []string{"-h"},
			want: Request{Action: ActionHelp},
		},
		{
			name: "long help",
			args: []string{"--help"},
			want: Request{Action: ActionHelp},
		},
		{
			name: "short version",
			args: []string{"-v"},
			want: Request{Action: ActionVersion},
		},
		{
			name: "long version",
			args: []string{"--version"},
			want: Request{Action: ActionVersion},
		},
		{
			name: "first action wins: help beats self-update",
			args: []string{"--help", "--self-update"},
			want: Request{Action: ActionHelp},
		},
		{
			name:    "first action wins: self-update beats help then demands pid",
			args:    []string{"--self-update", "--help"},
			wantErr: "--self-update requires --pid",
		},
		{
			name: "self-update with all companions",
			args: []string{"--self-update", "--pid", "12345", "--stage", "/stage", "--target", "/target"},
			want: Request{
				Action:     ActionSelfUpdate,
				SelfUpdate: &SelfUpdateRequest{PID: 12345, Stage: "/stage", Target: "/target"},
			},
		},
		{
			name: "self-update companions may precede the action",
			args: []string{"--pid", "7", "--stage", "/s", "--target", "/t", "--self-update"},
			want: Request{
				Action:     ActionSelfUpdate,
				SelfUpdate: &SelfUpdateRequest{PID: 7, Stage: "/s", Target: "/t"},
			},
		},
		{
			name:    "self-update without pid",
			args:    []string{"--self-update", "--stage", "/s", "--target", "/t"},
			wantErr: "--self-update requires --pid",
		},
		{
			name:    "self-update without stage",
			args:    []string{"--self-update", "--pid", "5", "--target", "/t"},
			wantErr: "--self-update requires --stage",
		},
		{
			name:    "self-update without target",
			args:    []string{"--self-update", "--pid", "5", "--stage", "/s"},
			wantErr: "--self-update requires --target",
		},
		{
			name: "repeated flags: last wins",
			args: []string{
				"--self-update",
				"--pid", "1", "--pid", "2",
				"--stage", "a", "--stage", "b",
				"--target", "c", "--target", "d",
			},
			want: Request{
				Action:     ActionSelfUpdate,
				SelfUpdate: &SelfUpdateRequest{PID: 2, Stage: "b", Target: "d"},
			},
		},
		{
			name:    "dangling pid without self-update",
			args:    []string{"--pid", "42"},
			wantErr: "unknown argument: --pid",
		},
		{
			name:    "companion without self-update loses to an earlier action",
			args:    []string{"-h", "--pid", "42"},
			wantErr: "unknown argument: --pid",
		},
		{
			name:    "unknown flag",
			args:    []string{"--bogus"},
			wantErr: "unknown argument: --bogus",
		},
		{
			name:    "unknown positional",
			args:    []string{"serve"},
			wantErr: "unknown argument: serve",
		},
		{
			name:    "unknown flag after a chosen action",
			args:    []string{"--self-update", "--pid", "5", "--stage", "/s", "--target", "/t", "--bogus"},
			wantErr: "unknown argument: --bogus",
		},
		{
			name:    "pid not a number",
			args:    []string{"--self-update", "--pid", "abc", "--stage", "/s", "--target", "/t"},
			wantErr: `invalid --pid "abc"`,
		},
		{
			name:    "pid zero rejected",
			args:    []string{"--self-update", "--pid", "0", "--stage", "/s", "--target", "/t"},
			wantErr: `invalid --pid "0"`,
		},
		{
			name:    "pid negative rejected",
			args:    []string{"--self-update", "--pid", "-5", "--stage", "/s", "--target", "/t"},
			wantErr: `invalid --pid "-5"`,
		},
		{
			name:    "pid plus sign rejected",
			args:    []string{"--self-update", "--pid", "+5", "--stage", "/s", "--target", "/t"},
			wantErr: `invalid --pid "+5"`,
		},
		{
			name:    "pid overflow rejected",
			args:    []string{"--self-update", "--pid", "99999999999999999999", "--stage", "/s", "--target", "/t"},
			wantErr: `invalid --pid "99999999999999999999"`,
		},
		{
			name:    "pid without a value",
			args:    []string{"--self-update", "--pid"},
			wantErr: "--pid requires a value",
		},
		{
			name:    "stage without a value",
			args:    []string{"--self-update", "--pid", "5", "--stage"},
			wantErr: "--stage requires a value",
		},
		{
			name:    "target without a value",
			args:    []string{"--self-update", "--pid", "5", "--stage", "/s", "--target"},
			wantErr: "--target requires a value",
		},
		{
			name:    "pid empty value",
			args:    []string{"--self-update", "--pid", "", "--stage", "/s", "--target", "/t"},
			wantErr: `invalid --pid ""`,
		},
		{
			name:    "stage empty value",
			args:    []string{"--self-update", "--pid", "5", "--stage", ""},
			wantErr: "--stage requires a non-empty value",
		},
		{
			name:    "target empty value",
			args:    []string{"--self-update", "--pid", "5", "--stage", "/s", "--target", ""},
			wantErr: "--target requires a non-empty value",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Parse(tt.args)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("Parse(%q) = %+v, want error containing %q", tt.args, got, tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("Parse(%q) error = %q, want containing %q", tt.args, err.Error(), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Parse(%q) unexpected error: %v", tt.args, err)
			}
			if got.Action != tt.want.Action {
				t.Errorf("Parse(%q) Action = %v, want %v", tt.args, got.Action, tt.want.Action)
			}
			switch {
			case got.SelfUpdate == nil && tt.want.SelfUpdate != nil:
				t.Errorf("Parse(%q) SelfUpdate = nil, want %+v", tt.args, tt.want.SelfUpdate)
			case got.SelfUpdate != nil && tt.want.SelfUpdate == nil:
				t.Errorf("Parse(%q) SelfUpdate = %+v, want nil", tt.args, got.SelfUpdate)
			case got.SelfUpdate != nil && *got.SelfUpdate != *tt.want.SelfUpdate:
				t.Errorf("Parse(%q) SelfUpdate = %+v, want %+v", tt.args, *got.SelfUpdate, *tt.want.SelfUpdate)
			}
		})
	}
}

func TestPrintVersion(t *testing.T) {
	var buf bytes.Buffer
	PrintVersion(&buf)
	want := fmt.Sprintf("c0wrk %s (commit %s, built %s)\n", version.Version, version.GitCommit, version.BuildDate)
	if got := buf.String(); got != want {
		t.Errorf("PrintVersion output = %q, want %q", got, want)
	}
}

func TestPrintHelp(t *testing.T) {
	var buf bytes.Buffer
	PrintHelp(&buf)
	out := buf.String()

	for _, want := range []string{"Usage:", "-h", "--help", "-v", "--version"} {
		if !strings.Contains(out, want) {
			t.Errorf("PrintHelp output missing %q: %q", want, out)
		}
	}
	// --self-update and its companions are internal re-exec plumbing: the
	// user-facing help must not mention them.
	lower := strings.ToLower(out)
	for _, leaked := range []string{"self-update", "selfupdate", "--pid", "--stage", "--target"} {
		if strings.Contains(lower, leaked) {
			t.Errorf("PrintHelp output leaks internal flag %q: %q", leaked, out)
		}
	}
}
