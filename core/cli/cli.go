// Package cli implements the unified command-line parser for the c0wrk
// binary: a single place that turns raw argv (os.Args[1:]) into a Request
// naming the action the process should perform.
//
// Parsing is fail-closed: any argument that is not a recognized flag is an
// error naming that argument, and the --self-update re-exec plumbing
// validates its companion flags only when --self-update is the selected
// action. The package is pure (no logger, no global state); the only
// dependencies are the standard library and core/version.
package cli

import (
	"errors"
	"fmt"
	"io"
	"strconv"

	"github.com/v0lka/c0wrk/core/version"
)

// Action identifies what the process should do after parsing.
type Action int

const (
	// ActionRun starts the normal application. It is the zero value so an
	// empty argv parses to a plain run request.
	ActionRun Action = iota
	// ActionHelp prints the usage text.
	ActionHelp
	// ActionVersion prints the version banner.
	ActionVersion
	// ActionSelfUpdate runs the staging self-updater. Internal re-exec
	// plumbing: hidden from the user-facing help output.
	ActionSelfUpdate
)

// SelfUpdateRequest carries the companion values of a --self-update
// invocation. It is populated exactly when Action is ActionSelfUpdate.
type SelfUpdateRequest struct {
	// PID is the process id of the parent (old) app that launched the
	// staging updater; the updater waits for it to exit before swapping.
	PID int
	// Stage is the staging directory holding the update archive (and the
	// updater binary itself).
	Stage string
	// Target is the install root to replace.
	Target string
}

// Request is the fully parsed command line.
type Request struct {
	Action Action
	// SelfUpdate is non-nil exactly when Action is ActionSelfUpdate.
	SelfUpdate *SelfUpdateRequest
}

// Parse converts raw command-line arguments (os.Args[1:]) into a Request.
//
// The first recognized action flag wins; later action flags are ignored.
// Repeated flags take the last value. Companion flags (--pid, --stage,
// --target) may appear anywhere on the line; their presence is validated
// only once the whole line is parsed — required when --self-update is the
// selected action, an error anywhere else. Value errors (a missing or empty
// value, a non-positive --pid) abort the scan immediately. Any unknown
// argument — an unrecognized flag, a bare positional, or a companion without
// --self-update — is an error naming the argument.
func Parse(args []string) (Request, error) {
	req := Request{Action: ActionRun}
	chosen := false
	accept := func(a Action) {
		if !chosen {
			chosen = true
			req.Action = a
		}
	}

	var pid int
	var stage, target string
	var pidSeen, stageSeen, targetSeen bool
	var companion string // first companion flag seen without --self-update

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-h", "--help":
			accept(ActionHelp)
		case "-v", "--version":
			accept(ActionVersion)
		case "--self-update":
			accept(ActionSelfUpdate)
		case "--pid":
			if companion == "" {
				companion = "--pid"
			}
			val, ok := nextArg(args, &i)
			if !ok {
				return Request{}, errors.New("--pid requires a value")
			}
			p, perr := parseInt(val)
			if perr != nil {
				return Request{}, fmt.Errorf("invalid --pid %q: %w", val, perr)
			}
			pid, pidSeen = p, true
		case "--stage":
			if companion == "" {
				companion = "--stage"
			}
			val, ok := nextArg(args, &i)
			if !ok {
				return Request{}, errors.New("--stage requires a value")
			}
			if val == "" {
				return Request{}, errors.New("--stage requires a non-empty value")
			}
			stage, stageSeen = val, true
		case "--target":
			if companion == "" {
				companion = "--target"
			}
			val, ok := nextArg(args, &i)
			if !ok {
				return Request{}, errors.New("--target requires a value")
			}
			if val == "" {
				return Request{}, errors.New("--target requires a non-empty value")
			}
			target, targetSeen = val, true
		default:
			return Request{}, errors.New("unknown argument: " + args[i])
		}
	}

	if req.Action == ActionSelfUpdate {
		if !pidSeen {
			return Request{}, errors.New("--self-update requires --pid")
		}
		if !stageSeen {
			return Request{}, errors.New("--self-update requires --stage")
		}
		if !targetSeen {
			return Request{}, errors.New("--self-update requires --target")
		}
		req.SelfUpdate = &SelfUpdateRequest{PID: pid, Stage: stage, Target: target}
		return req, nil
	}
	if companion != "" {
		return Request{}, errors.New("unknown argument: " + companion)
	}
	return req, nil
}

// nextArg consumes and returns the value following args[*i] (a flag's
// argument), reporting whether one exists. Ported from core/updater.
func nextArg(args []string, i *int) (string, bool) {
	if *i+1 >= len(args) {
		return "", false
	}
	*i++
	return args[*i], true
}

// parseInt parses a strict positive integer: decimal digits only (so a
// leading '+' or '-' is rejected), with strconv.Atoi providing the
// platform-int overflow bound. Ported from core/updater.parseInt.
func parseInt(s string) (int, error) {
	if s == "" {
		return 0, errors.New("not a positive integer")
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, errors.New("not a positive integer")
		}
	}
	// strconv.Atoi rejects values outside the platform int range, closing the
	// overflow wrap that a hand-rolled accumulation would allow on long input.
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return 0, errors.New("not a positive integer")
	}
	return n, nil
}

// helpText is the user-facing usage. --self-update and its companion flags
// are internal re-exec plumbing and deliberately not listed.
const helpText = `Usage: c0wrk [flags]

Flags:
  -h, --help      Print this help and exit
  -v, --version   Print version and exit
`

// PrintHelp writes the usage text to w.
func PrintHelp(w io.Writer) {
	_, _ = fmt.Fprint(w, helpText)
}

// PrintVersion writes the one-line version banner to w, sourced from the
// build-time metadata in core/version.
func PrintVersion(w io.Writer) {
	_, _ = fmt.Fprintf(w, "c0wrk %s (commit %s, built %s)\n", version.Version, version.GitCommit, version.BuildDate)
}
