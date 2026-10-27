package desktop

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/v0lka/c0wrk/backend"
	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/core/vectorindex"
)

// newLauncherApp builds a minimal App whose FrontendAPI carries cfg (the
// launcher reads its knobs through the configMu-guarded snapshot accessor)
// and whose event emissions land in recorder.
func newLauncherApp(t *testing.T, cfg *config.Config, recorder *emitRecorder) *App {
	t.Helper()
	a := NewApp()
	a.logger = testLoggerForPhases()
	a.wailsEmit = recorder.emit
	a.FrontendAPI = backend.NewFrontendAPI(backend.FrontendAPIConfig{
		Config:     cfg,
		ConfigPath: filepath.Join(t.TempDir(), "config.yaml"),
		Logger:     a.logger,
		EmitEvent: func(name string, data ...any) {
			recorder.emit(name, data...)
		},
	})
	return a
}

// newEnabledConfig returns an ApplyDefaults-resolved config; when disabled is
// set, vector_index.enabled is explicitly false.
func newEnabledConfig(disabled bool) *config.Config {
	cfg := &config.Config{}
	config.ApplyDefaults(cfg)
	faux := !disabled
	cfg.VectorIndex.Enabled = &faux
	return cfg
}

// TestVectorIndexLauncher_DisabledConfigParksRegistry pins the boot-time arm
// of the restartable init: a config with vector_index.enabled: false never
// loads the ONNX runtime — the per-root registry is parked (every path fails
// fast with the disabled error, FactoryReady reports false) and the off
// state is emitted on the vector_index:status stream.
func TestVectorIndexLauncher_DisabledConfigParksRegistry(t *testing.T) {
	recorder := &emitRecorder{}
	a := newLauncherApp(t, newEnabledConfig(true), recorder)
	l := newVectorIndexLauncher(a, t.TempDir(), testLoggerForPhases())

	// Synchronous call — the disabled arm returns before any model-file or
	// ONNX work, so no goroutine timing is involved.
	l.runVectorIndexInit(1, make(chan struct{}))

	vr := a.frontendAPI().Lifecycle().VectorRoots()
	if !vr.Disabled() {
		t.Fatal("registry must be parked when the config boots with indexing off")
	}
	if vr.FactoryReady() {
		t.Error("no factory may be wired while disabled")
	}

	emittedDisabled := false
	for _, ev := range recorder.snapshot() {
		if ev.Name != backend.EventVectorIndexStatus || len(ev.Data) == 0 {
			continue
		}
		if st, ok := ev.Data[0].(backend.VectorIndexStatus); ok && st.State == "disabled" {
			emittedDisabled = true
		}
	}
	if !emittedDisabled {
		t.Error("the disabled arm must emit a vector_index:status snapshot with state \"disabled\"")
	}
}

// TestVectorIndexLauncher_MissingModelsKeepsRegistryIdle pins that a
// launched-but-unavailable init (model files absent) leaves the registry
// un-parked and un-wired: "unavailable" is a backend failure, not the
// user's off switch, and a later factory wiring (or restart) still applies.
func TestVectorIndexLauncher_MissingModelsKeepsRegistryIdle(t *testing.T) {
	recorder := &emitRecorder{}
	a := newLauncherApp(t, newEnabledConfig(false), recorder)
	// Empty agent dir: resolveModelPath finds no model files next to the
	// test binary (there is no app bundle) nor under the agent dir.
	l := newVectorIndexLauncher(a, t.TempDir(), testLoggerForPhases())

	l.runVectorIndexInit(1, make(chan struct{}))

	vr := a.frontendAPI().Lifecycle().VectorRoots()
	if vr.Disabled() {
		t.Error("missing model files must NOT park the registry (that is the enabled=false state)")
	}
	if vr.FactoryReady() {
		t.Error("no factory may be wired when the model files are missing")
	}

	foundUnavailable := false
	for _, ev := range recorder.snapshot() {
		if ev.Name != "vector_index:status" || len(ev.Data) == 0 {
			continue
		}
		if m, ok := ev.Data[0].(map[string]any); ok {
			if avail, isBool := m["available"].(bool); isBool && !avail {
				foundUnavailable = true
			}
		}
	}
	if !foundUnavailable {
		t.Error("the missing-models arm must emit an available:false status")
	}
}

// TestVectorIndexLauncher_WireIfCurrentSuperseded pins the epochal guard:
// only the CURRENT epoch may wire its factory into the registry. A disable
// (applyEnabledChange(false)) or a newer launch bumps the epoch, and the
// stale launch's wiring attempt is refused atomically — the registry keeps
// whatever the newer state installed instead of being resurrected.
func TestVectorIndexLauncher_WireIfCurrentSuperseded(t *testing.T) {
	recorder := &emitRecorder{}
	a := newLauncherApp(t, newEnabledConfig(false), recorder)
	l := newVectorIndexLauncher(a, t.TempDir(), testLoggerForPhases())

	// Mimic launch()'s epoch assignment without running the init body.
	l.mu.Lock()
	l.epoch++
	epoch := l.epoch
	l.mu.Unlock()

	// errLauncherProbe marks the probe factory so a test that accidentally
	// builds a manager through it fails loudly instead of constructing a real
	// vectorindex.Manager.
	errLauncherProbe := errors.New("launcher probe factory must never be invoked")
	noopFactory := func() (*vectorindex.Manager, error) { return nil, errLauncherProbe }
	ready := make(chan struct{})
	closeEmbedder := func() error { return nil }

	// Current epoch: wiring succeeds and the registry can build managers.
	if !l.wireIfCurrent(epoch, noopFactory, ready, closeEmbedder) {
		t.Fatal("the current epoch must wire successfully")
	}
	vr := a.frontendAPI().Lifecycle().VectorRoots()
	if !vr.FactoryReady() {
		t.Fatal("precondition: registry wired by the current epoch")
	}

	// Disable-side invalidation: the hook bumps the epoch; the STALE launch
	// must lose its wiring race and never reach the registry again.
	l.applyEnabledChange(false)
	if l.wireIfCurrent(epoch, noopFactory, ready, closeEmbedder) {
		t.Error("a stale epoch must not wire (disable or a newer launch superseded it)")
	}

	// A NEW launch (fresh epoch) wires again — the restart path.
	l.mu.Lock()
	l.epoch++
	nextEpoch := l.epoch
	l.mu.Unlock()
	if !l.wireIfCurrent(nextEpoch, noopFactory, ready, closeEmbedder) {
		t.Error("the fresh epoch must wire successfully")
	}
}
