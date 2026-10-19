package backend

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/v0lka/c0wrk/backend/project"
	"github.com/v0lka/c0wrk/backend/session"
	"github.com/v0lka/c0wrk/core"
	"github.com/v0lka/sp4rk/orchestration"
)

// newAttachmentTestAPI builds a minimal FrontendAPI whose session manager
// creates real in-memory sessions (zero-value orchestrator — the guarded
// stub every restore-free test in this package uses). Returns the api plus
// the two session ids: the first stages via AttachFiles, the second via
// AttachFileContent, so the tests can compare the two paths side by side.
func newAttachmentTestAPI(t *testing.T) (api *FrontendAPI, pathsSessionID, contentSessionID string) {
	t.Helper()
	factory := func(core.Emitter, *slog.Logger, string, core.BlackboardFactory, io.Writer, *orchestration.StepDumpTracker) (*core.Orchestrator, error) {
		// Non-nil: CreateSession calls SetNoProjectMode on the orchestrator
		// for CHAT sessions. The zero value is fine (nil registry is guarded).
		return &core.Orchestrator{}, nil
	}
	manager := session.NewManager(factory, func(session.Event) {}, t.TempDir())
	manager.SetLogger(slog.New(slog.DiscardHandler))
	t.Cleanup(manager.Shutdown)

	api = &FrontendAPI{app: &Application{manager: manager}}
	for _, want := range []*string{&pathsSessionID, &contentSessionID} {
		info, err := manager.CreateSession(project.NoProjectID, "")
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		*want = info.ID
	}
	return api, pathsSessionID, contentSessionID
}

// testPNG encodes a tiny 2×2 RGBA PNG (same fixture shape as the session
// package's clipboard tests: processImage decodes png natively, so no extra
// format registration and no markitdown involvement).
func testPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255})
	img.Set(1, 1, color.RGBA{G: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// TestAttachFileContent_MatchesAttachFiles: the same bytes staged through the
// web-content path produce an AttachmentInfo IDENTICAL to the native
// AttachFiles path for the same content on disk — same name/format/size,
// same image classification, same deterministic thumbnail, a fresh ID and a
// real on-disk mirror path each.
func TestAttachFileContent_MatchesAttachFiles(t *testing.T) {
	api, pathsSessionID, contentSessionID := newAttachmentTestAPI(t)
	pngBytes := testPNG(t)

	nativePath := filepath.Join(t.TempDir(), "shot.png")
	if err := os.WriteFile(nativePath, pngBytes, 0o644); err != nil {
		t.Fatalf("write native png: %v", err)
	}

	viaPaths, err := api.AttachFiles(pathsSessionID, []string{nativePath})
	if err != nil {
		t.Fatalf("AttachFiles: %v", err)
	}
	viaContent, err := api.AttachFileContent(contentSessionID, "shot.png", "image/png", pngBytes)
	if err != nil {
		t.Fatalf("AttachFileContent: %v", err)
	}

	if len(viaPaths) != 1 || len(viaContent) != 1 {
		t.Fatalf("expected one attachment each, got %d and %d", len(viaPaths), len(viaContent))
	}
	a, b := viaPaths[0], viaContent[0]

	if a.OriginalName != b.OriginalName {
		t.Errorf("OriginalName: native %q, content %q", a.OriginalName, b.OriginalName)
	}
	if a.Format != b.Format {
		t.Errorf("Format: native %q, content %q", a.Format, b.Format)
	}
	if a.SizeBytes != b.SizeBytes {
		t.Errorf("SizeBytes: native %d, content %d", a.SizeBytes, b.SizeBytes)
	}
	if !b.IsImage || a.IsImage != b.IsImage {
		t.Errorf("IsImage: native %t, content %t", a.IsImage, b.IsImage)
	}
	if a.MediaType != b.MediaType {
		t.Errorf("MediaType: native %q, content %q", a.MediaType, b.MediaType)
	}
	if b.Path == "" {
		t.Error("content path is empty — no on-disk mirror written")
	}
	if a.Thumbnail == "" || a.Thumbnail != b.Thumbnail {
		t.Errorf("Thumbnail mismatch: native %q, content %q", a.Thumbnail, b.Thumbnail)
	}
	if a.ID == "" || b.ID == "" || a.ID == b.ID {
		t.Errorf("IDs must be fresh and non-empty: native %q, content %q", a.ID, b.ID)
	}

	// Both sessions now report exactly one pending attachment.
	for _, id := range []string{pathsSessionID, contentSessionID} {
		infos, err := api.GetAttachments(id)
		if err != nil {
			t.Fatalf("GetAttachments(%s): %v", id, err)
		}
		if len(infos) != 1 {
			t.Errorf("session %s: expected 1 pending attachment, got %d", id, len(infos))
		}
	}
}

// TestAttachFileContent_SanitizesUntrustedName: a web-supplied name never
// carries path components into the staging area — only its bare base name is
// used — and an extensionless image name gains the extension derived from its
// MIME type so it routes through the image pipeline.
func TestAttachFileContent_SanitizesUntrustedName(t *testing.T) {
	pngBytes := testPNG(t)

	t.Run("path components are stripped", func(t *testing.T) {
		api, _, contentSessionID := newAttachmentTestAPI(t)
		infos, err := api.AttachFileContent(contentSessionID, "../evil.png", "image/png", pngBytes)
		if err != nil {
			t.Fatalf("AttachFileContent: %v", err)
		}
		if len(infos) != 1 || infos[0].OriginalName != "evil.png" {
			t.Errorf("expected staged as bare 'evil.png', got %+v", infos)
		}
	})

	t.Run("extensionless image name gains the mime extension", func(t *testing.T) {
		api, _, contentSessionID := newAttachmentTestAPI(t)
		infos, err := api.AttachFileContent(contentSessionID, "screenshot", "image/png", pngBytes)
		if err != nil {
			t.Fatalf("AttachFileContent: %v", err)
		}
		if len(infos) != 1 || infos[0].OriginalName != "screenshot.png" || !infos[0].IsImage {
			t.Errorf("expected 'screenshot.png' staged as an image, got %+v", infos)
		}
	})

	t.Run("unusable names are rejected without staging", func(t *testing.T) {
		api, _, contentSessionID := newAttachmentTestAPI(t)
		for _, name := range []string{"", ".", "..", "   "} {
			if _, err := api.AttachFileContent(contentSessionID, name, "", pngBytes); err == nil {
				t.Errorf("name %q: expected an error", name)
			}
		}
		infos, err := api.GetAttachments(contentSessionID)
		if err != nil {
			t.Fatalf("GetAttachments: %v", err)
		}
		if len(infos) != 0 {
			t.Errorf("expected no attachments from rejected names, got %d pending", len(infos))
		}
	})
}

// TestAttachFileContent_RejectsOversizePayload: a payload above the
// attachment cap fails fast with an explicit error and stages nothing.
func TestAttachFileContent_RejectsOversizePayload(t *testing.T) {
	api, _, contentSessionID := newAttachmentTestAPI(t)

	big := make([]byte, maxAttachContentBytes+1)
	if _, err := api.AttachFileContent(contentSessionID, "big.png", "image/png", big); err == nil {
		t.Fatal("expected an error for an oversize payload")
	} else if !strings.Contains(err.Error(), "exceeds") {
		t.Errorf("error should name the limit, got: %v", err)
	}
	infos, err := api.GetAttachments(contentSessionID)
	if err != nil {
		t.Fatalf("GetAttachments: %v", err)
	}
	if len(infos) != 0 {
		t.Errorf("expected nothing staged, got %d", len(infos))
	}
}

// TestAttachFileContent_UnsupportedFormatMatchesAttachFiles: content the
// pipeline cannot route (neither a known image extension nor a markitdown
// format) is rejected as a per-file failure — the same non-error, no-new-
// attachments contract AttachFiles has — so the web path never turns a file
// rejection into a generic RPC error.
func TestAttachFileContent_UnsupportedFormatMatchesAttachFiles(t *testing.T) {
	api, pathsSessionID, contentSessionID := newAttachmentTestAPI(t)

	junk := []byte("definitely not a document")
	nativePath := filepath.Join(t.TempDir(), "blob.xyz")
	if err := os.WriteFile(nativePath, junk, 0o644); err != nil {
		t.Fatalf("write junk: %v", err)
	}

	viaPaths, err := api.AttachFiles(pathsSessionID, []string{nativePath})
	if err != nil {
		t.Fatalf("AttachFiles: %v", err)
	}
	viaContent, err := api.AttachFileContent(contentSessionID, "blob.xyz", "", junk)
	if err != nil {
		t.Fatalf("AttachFileContent: %v", err)
	}

	if len(viaPaths) != 0 || len(viaContent) != 0 {
		t.Errorf("unsupported content must not stage: native %d, content %d", len(viaPaths), len(viaContent))
	}
	for _, id := range []string{pathsSessionID, contentSessionID} {
		infos, err := api.GetAttachments(id)
		if err != nil {
			t.Fatalf("GetAttachments(%s): %v", id, err)
		}
		if len(infos) != 0 {
			t.Errorf("session %s: expected no pending attachments, got %d", id, len(infos))
		}
	}
}

// TestAttachFileContent_RequiresManager: without an initialized application
// manager the method refuses exactly like its AttachFiles sibling.
func TestAttachFileContent_RequiresManager(t *testing.T) {
	api := &FrontendAPI{}
	if _, err := api.AttachFileContent("sess", "a.png", "image/png", []byte{1}); err == nil {
		t.Fatal("expected an error without a session manager")
	} else if !strings.Contains(err.Error(), "session manager not initialized") {
		t.Errorf("unexpected error: %v", err)
	}
}
