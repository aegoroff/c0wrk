package session

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/v0lka/sp4rk/orchestration"
)

// TestToAttachmentInfos_MapsFields verifies that orchestration.Attachment
// records are correctly mapped to the metadata-only AttachmentInfo view.
func TestToAttachmentInfos_MapsFields(t *testing.T) {
	attachments := []orchestration.Attachment{
		{
			ID:              "att-1",
			OriginalName:    "report.pdf",
			OriginalPath:    "/tmp/report.pdf",
			Format:          "pdf",
			SizeBytes:       1024,
			MarkdownContent: "# Report",
			AttachedAt:      time.Now(),
		},
		{
			ID:              "att-2",
			OriginalName:    "notes.md",
			OriginalPath:    "/tmp/notes.md",
			Format:          "md",
			SizeBytes:       256,
			MarkdownContent: "# Notes",
			AttachedAt:      time.Now(),
		},
	}

	got := toAttachmentInfos(attachments)
	if len(got) != 2 {
		t.Fatalf("expected 2 AttachmentInfo, got %d", len(got))
	}

	// MarkdownContent must NOT leak into the metadata-only view.
	for _, info := range got {
		if reflect.DeepEqual(info, attachments[0]) {
			t.Error("AttachmentInfo should not contain MarkdownContent")
		}
	}

	if got[0].ID != "att-1" || got[0].OriginalName != "report.pdf" {
		t.Errorf("got[0] = %+v, want ID=att-1 OriginalName=report.pdf", got[0])
	}
	if got[1].Format != "md" || got[1].SizeBytes != 256 {
		t.Errorf("got[1] = %+v, want Format=md SizeBytes=256", got[1])
	}
}

// TestToAttachmentInfos_DefensiveCopy verifies that mutating the returned
// slice does not affect a subsequent call (each call returns a fresh slice).
func TestToAttachmentInfos_DefensiveCopy(t *testing.T) {
	attachments := []orchestration.Attachment{
		{ID: "a1", OriginalName: "a.txt", Format: "txt", SizeBytes: 1},
	}
	first := toAttachmentInfos(attachments)
	first[0].ID = "MUTATED"

	second := toAttachmentInfos(attachments)
	if second[0].ID != "a1" {
		t.Errorf("defensive copy violated: got ID=%s, want a1", second[0].ID)
	}
}

// TestToAttachmentInfos_Empty returns an empty (non-nil) slice for empty input.
func TestToAttachmentInfos_Empty(t *testing.T) {
	got := toAttachmentInfos(nil)
	if got == nil {
		t.Error("expected non-nil empty slice for nil input")
	}
	if len(got) != 0 {
		t.Errorf("expected length 0, got %d", len(got))
	}
}

// TestCombinedAttachmentInfos_ImageCarriesPathAndMediaType verifies that image
// entries carry Path and MediaType so the UI can mirror them into the
// optimistic user-message metadata (StoredImageMetadata) at send time, and
// that document entries omit both fields.
func TestCombinedAttachmentInfos_ImageCarriesPathAndMediaType(t *testing.T) {
	docs := []orchestration.Attachment{
		{ID: "d1", OriginalName: "report.pdf", Format: "pdf", SizeBytes: 100},
	}
	images := []ImageAttachment{
		{
			ID:           "img-1",
			OriginalName: "shot.png",
			MediaType:    "image/png",
			SizeBytes:    2048,
			ThumbnailB64: "data:image/jpeg;base64,abc",
			FilePath:     "/tmp/shot.png",
		},
	}

	got := combinedAttachmentInfos(docs, images)
	if len(got) != 2 {
		t.Fatalf("expected 2 AttachmentInfo, got %d", len(got))
	}

	doc, img := got[0], got[1]
	if doc.ID != "d1" || doc.IsImage {
		t.Errorf("doc entry = %+v, want ID=d1 IsImage=false", doc)
	}
	if doc.Path != "" || doc.MediaType != "" {
		t.Errorf("doc entry must omit path/media_type, got %+v", doc)
	}

	if !img.IsImage || img.MediaType != "image/png" || img.Path != "/tmp/shot.png" {
		t.Errorf("img entry = %+v, want IsImage=true MediaType=image/png Path=/tmp/shot.png", img)
	}
	if img.Format != "png" || img.Thumbnail != "data:image/jpeg;base64,abc" {
		t.Errorf("img entry = %+v, want Format=png with thumbnail", img)
	}
}

// TestPendingAttachments_CarryAcrossEviction pins the snapshot/restore seam
// the send-time workspace binding relies on: the pending lists live only on
// the in-memory session, so a flow that evicts the session (the bind path
// does, to rebuild the orchestrator in the new workspace) must carry them
// across explicitly — the first send's metadata read and task-start snapshot
// depend on seeing them.
func TestPendingAttachments_CarryAcrossEviction(t *testing.T) {
	mgr, _, _ := testManager(t)
	store, cleanup := setupTestStore(t)
	t.Cleanup(cleanup)
	mgr.SetSessionStore(store)
	mgr.SetProjectResolver(func(string) (string, error) { return runtimeTempDir(t), nil })

	info, err := mgr.CreateSession(testProjectID, runtimeTempDir(t))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	// Persist the row the way the production CreateSession RPC does — the
	// lazy restore after the eviction reads it from the store.
	if err := store.SaveSession(context.Background(), *info); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	sess, ok := mgr.GetSession(info.ID)
	if !ok {
		t.Fatal("session not found after creation")
	}
	sess.mu.Lock()
	sess.pendingAttachments = append(sess.pendingAttachments, orchestration.Attachment{
		ID: "att-1", OriginalName: "spec.md", Format: "md", MarkdownContent: "# Spec",
	})
	sess.pendingImageAttachments = append(sess.pendingImageAttachments, ImageAttachment{
		ID: "img-1", OriginalName: "shot.png", MediaType: "image/png", FilePath: "/tmp/shot.png",
	})
	sess.mu.Unlock()

	if !mgr.HasPendingAttachments(info.ID) {
		t.Fatal("precondition: staged attachments must be visible")
	}
	snap := mgr.SnapshotPendingAttachments(info.ID)
	if snap.Empty() || len(snap.Docs) != 1 || len(snap.Images) != 1 {
		t.Fatalf("snapshot must carry both lists, got docs=%d images=%d", len(snap.Docs), len(snap.Images))
	}

	if err := mgr.EvictSession(info.ID); err != nil {
		t.Fatalf("EvictSession: %v", err)
	}
	// The eviction is exactly what loses the memory-only lists — this
	// assertion pins the premise the carry-over exists for.
	if mgr.HasPendingAttachments(info.ID) {
		t.Fatal("eviction must drop the in-memory pending lists (that is the hazard)")
	}

	if err := mgr.RestorePendingAttachments(info.ID, snap); err != nil {
		t.Fatalf("RestorePendingAttachments: %v", err)
	}
	if !mgr.HasPendingAttachments(info.ID) {
		t.Fatal("restored attachments must be staged on the restored session")
	}
	restored, ok := mgr.GetSession(info.ID)
	if !ok {
		t.Fatal("session not found after the restore")
	}
	restored.mu.Lock()
	gotDocs, gotImages := len(restored.pendingAttachments), len(restored.pendingImageAttachments)
	restored.mu.Unlock()
	if gotDocs != 1 || gotImages != 1 {
		t.Fatalf("restored session must carry both lists, got docs=%d images=%d", gotDocs, gotImages)
	}

	// An empty (or nil) snapshot is a no-op restore, never an error.
	if err := mgr.RestorePendingAttachments(info.ID, nil); err != nil {
		t.Fatalf("empty-snapshot restore must be a no-op, got: %v", err)
	}
}

// TestPendingAttachments_ConcurrentStageSurvivesEviction pins the append
// re-validation: a stage whose append raced into the bind's snapshot→evict
// window holds an ORPHANED session reference (the eviction deleted the
// registered object). The append must detect the eviction after the fact and
// re-stage on the lazily restored session — the send-time workspace bind must
// never silently lose a concurrently attached file.
func TestPendingAttachments_ConcurrentStageSurvivesEviction(t *testing.T) {
	mgr, _, _ := testManager(t)
	store, cleanup := setupTestStore(t)
	t.Cleanup(cleanup)
	mgr.SetSessionStore(store)
	mgr.SetProjectResolver(func(string) (string, error) { return runtimeTempDir(t), nil })

	info, err := mgr.CreateSession(testProjectID, runtimeTempDir(t))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := store.SaveSession(context.Background(), *info); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	orphaned, ok := mgr.GetSession(info.ID)
	if !ok {
		t.Fatal("session not found after creation")
	}

	// A staging append that lost the race: the eviction completed between
	// the stager's session lookup and its append.
	if err := mgr.EvictSession(info.ID); err != nil {
		t.Fatalf("EvictSession: %v", err)
	}

	doc := orchestration.Attachment{ID: "late-1", OriginalName: "late.md", Format: "md", MarkdownContent: "# Late"}
	infos, live, stageErr := mgr.appendPendingAttachments(info.ID, orphaned, []orchestration.Attachment{doc}, nil)
	if stageErr != nil {
		t.Fatalf("appendPendingAttachments across eviction: %v", stageErr)
	}
	if live == orphaned {
		t.Fatal("the live session must be the lazily restored one, not the orphaned object")
	}
	if len(infos) != 1 || infos[0].ID != "late-1" {
		t.Fatalf("infos must reflect the staged file, got %+v", infos)
	}
	if !mgr.HasPendingAttachments(info.ID) {
		t.Fatal("the re-staged file must be visible on the registered session")
	}
	got, ok := mgr.GetSession(info.ID)
	if !ok || got != live {
		t.Fatal("the re-staged file must live on the session registered under the id")
	}
	got.mu.Lock()
	count := len(got.pendingAttachments)
	got.mu.Unlock()
	if count != 1 {
		t.Fatalf("restored session must carry exactly the re-staged file, got %d", count)
	}

	// The no-eviction path stages in place: same object, correct infos.
	doc2 := orchestration.Attachment{ID: "in-place-1", OriginalName: "now.md", Format: "md", MarkdownContent: "# Now"}
	infos2, live2, stageErr := mgr.appendPendingAttachments(info.ID, live, []orchestration.Attachment{doc2}, nil)
	if stageErr != nil {
		t.Fatalf("appendPendingAttachments in place: %v", stageErr)
	}
	if live2 != live {
		t.Fatal("without an eviction the append must land on the same session")
	}
	if len(infos2) != 2 {
		t.Fatalf("infos must carry both staged files, got %+v", infos2)
	}
}

// TestPendingAttachments_RaceDedupe pins both settling orders of the
// snapshot/re-stage overlap: a staging append that raced into the bind's
// snapshot→evict window is carried EITHER by the bind's snapshot (restore
// re-stages it) or by its own re-validation (re-stage after the restore) —
// never by both. Either order must leave the file staged exactly once.
func TestPendingAttachments_RaceDedupe(t *testing.T) {
	mgr, _, _ := testManager(t)
	store, cleanup := setupTestStore(t)
	t.Cleanup(cleanup)
	mgr.SetSessionStore(store)
	mgr.SetProjectResolver(func(string) (string, error) { return runtimeTempDir(t), nil })

	info, err := mgr.CreateSession(testProjectID, runtimeTempDir(t))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := store.SaveSession(context.Background(), *info); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	sess, ok := mgr.GetSession(info.ID)
	if !ok {
		t.Fatal("session not found after creation")
	}
	doc := orchestration.Attachment{ID: "race-1", OriginalName: "race.md", Format: "md", MarkdownContent: "# Race"}
	snap := &PendingAttachmentSnapshot{Docs: []orchestration.Attachment{doc}}

	countStaged := func() int {
		s, _ := mgr.GetSessionAttachments(info.ID)
		return len(s)
	}

	// Order 1: restore carried the file, then the racing append re-stages —
	// the re-stage must be a dedupe no-op.
	if err := mgr.EvictSession(info.ID); err != nil {
		t.Fatalf("EvictSession: %v", err)
	}
	if err := mgr.RestorePendingAttachments(info.ID, snap); err != nil {
		t.Fatalf("RestorePendingAttachments: %v", err)
	}
	if _, _, stageErr := mgr.appendPendingAttachments(info.ID, sess, []orchestration.Attachment{doc}, nil); stageErr != nil {
		t.Fatalf("appendPendingAttachments after restore: %v", stageErr)
	}
	if got := countStaged(); got != 1 {
		t.Fatalf("restore→re-stage must stage the file once, got %d", got)
	}

	// Order 2: the racing append re-stages first, then the snapshot restore
	// lands — the restore must be a dedupe no-op.
	if err := mgr.EvictSession(info.ID); err != nil {
		t.Fatalf("EvictSession: %v", err)
	}
	if _, _, stageErr := mgr.appendPendingAttachments(info.ID, sess, []orchestration.Attachment{doc}, nil); stageErr != nil {
		t.Fatalf("appendPendingAttachments after eviction: %v", stageErr)
	}
	if err := mgr.RestorePendingAttachments(info.ID, snap); err != nil {
		t.Fatalf("RestorePendingAttachments after re-stage: %v", err)
	}
	if got := countStaged(); got != 1 {
		t.Fatalf("re-stage→restore must stage the file once, got %d", got)
	}
}

// TestPendingAttachments_RestoreSurvivesRacingEviction pins the restore-side
// re-validation: a restore whose append raced into a SECOND eviction's
// snapshot→evict window (the retrying send's bind of the still-fresh session)
// holds an ORPHANED session reference — and nothing else will ever re-stage
// the snapshot items (the second eviction's capture already ran before they
// landed). The restore must detect the eviction after the fact and re-stage
// on the lazily restored session, mirroring the append side.
func TestPendingAttachments_RestoreSurvivesRacingEviction(t *testing.T) {
	mgr, _, _ := testManager(t)
	store, cleanup := setupTestStore(t)
	t.Cleanup(cleanup)
	mgr.SetSessionStore(store)
	mgr.SetProjectResolver(func(string) (string, error) { return runtimeTempDir(t), nil })

	info, err := mgr.CreateSession(testProjectID, runtimeTempDir(t))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := store.SaveSession(context.Background(), *info); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	orphaned, ok := mgr.GetSession(info.ID)
	if !ok {
		t.Fatal("session not found after creation")
	}

	// A restore that lost the race: a second eviction completed between the
	// restore's session lookup and its append.
	if err := mgr.EvictSession(info.ID); err != nil {
		t.Fatalf("EvictSession: %v", err)
	}

	snap := &PendingAttachmentSnapshot{
		Docs: []orchestration.Attachment{{ID: "late-doc-1", OriginalName: "late.md", Format: "md", MarkdownContent: "# Late"}},
		Images: []ImageAttachment{{
			ID: "late-img-1", OriginalName: "late.png", MediaType: "image/png", FilePath: "/tmp/late.png",
		}},
	}
	if err := mgr.restorePendingAttachments(info.ID, orphaned, snap); err != nil {
		t.Fatalf("restorePendingAttachments across eviction: %v", err)
	}
	if !mgr.HasPendingAttachments(info.ID) {
		t.Fatal("the re-staged snapshot must be visible on the registered session")
	}
	infos, _ := mgr.GetSessionAttachments(info.ID)
	if len(infos) != 2 {
		t.Fatalf("restored session must carry both snapshot entries, got %+v", infos)
	}
	got, ok := mgr.GetSession(info.ID)
	if !ok {
		t.Fatal("session not found after the restore")
	}
	got.mu.Lock()
	gotDocs, gotImages := len(got.pendingAttachments), len(got.pendingImageAttachments)
	got.mu.Unlock()
	if gotDocs != 1 || gotImages != 1 {
		t.Fatalf("restored session must carry both lists on the LIVE object, got docs=%d images=%d", gotDocs, gotImages)
	}

	// The no-eviction path restores in place: same object, snapshot applied.
	snap2 := &PendingAttachmentSnapshot{
		Docs: []orchestration.Attachment{{ID: "in-place-doc-1", OriginalName: "now.md", Format: "md"}},
	}
	if err := mgr.restorePendingAttachments(info.ID, got, snap2); err != nil {
		t.Fatalf("restorePendingAttachments in place: %v", err)
	}
	got.mu.Lock()
	count := len(got.pendingAttachments)
	got.mu.Unlock()
	if count != 2 {
		t.Fatalf("in-place restore must land on the same session, got %d docs", count)
	}
}

// TestPendingAttachments_CapturedByEviction pins the loss-proof ordering: the
// eviction captures the staged attachments under the same critical section
// that deletes the session, so ANY staging append racing the bind's eviction
// is either carried by the capture (committed before it) or re-stages on the
// restored session (appendPendingAttachments' re-validation) — the separate
// snapshot-then-evict pair this replaced had a third interleaving (append
// committed and re-validated live between the snapshot and the delete) that
// silently dropped the file.
func TestPendingAttachments_CapturedByEviction(t *testing.T) {
	mgr, _, _ := testManager(t)
	store, cleanup := setupTestStore(t)
	t.Cleanup(cleanup)
	mgr.SetSessionStore(store)
	mgr.SetProjectResolver(func(string) (string, error) { return runtimeTempDir(t), nil })

	info, err := mgr.CreateSession(testProjectID, runtimeTempDir(t))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := store.SaveSession(context.Background(), *info); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	sess, ok := mgr.GetSession(info.ID)
	if !ok {
		t.Fatal("session not found after creation")
	}
	doc := orchestration.Attachment{ID: "cap-1", OriginalName: "cap.md", Format: "md", MarkdownContent: "# Cap"}
	img := ImageAttachment{ID: "cap-img", OriginalName: "cap.png", MediaType: "image/png", FilePath: "/tmp/cap.png"}
	sess.mu.Lock()
	sess.pendingAttachments = append(sess.pendingAttachments, doc)
	sess.pendingImageAttachments = append(sess.pendingImageAttachments, img)
	sess.mu.Unlock()

	snap, evictErr := mgr.EvictSessionCarryingAttachments(info.ID)
	if evictErr != nil {
		t.Fatalf("EvictSessionCarryingAttachments: %v", evictErr)
	}
	if snap == nil || len(snap.Docs) != 1 || len(snap.Images) != 1 {
		t.Fatalf("capture must carry both lists, got %+v", snap)
	}
	if snap.Docs[0].ID != "cap-1" || snap.Images[0].ID != "cap-img" {
		t.Fatalf("capture must preserve the items, got %+v", snap)
	}
	// The eviction itself took effect: the registered session no longer
	// holds the lists.
	if mgr.HasPendingAttachments(info.ID) {
		t.Fatal("the captured lists must not survive on the registered session")
	}
	// EvictSession delegates to the carrying variant: same effect, capture
	// discarded, and a not-in-memory session stays a nil-error no-op (before
	// any lazy restore re-registers it).
	snap2, evictErr := mgr.EvictSessionCarryingAttachments(info.ID)
	if evictErr != nil || snap2 != nil {
		t.Fatalf("evicting an absent session must be a no-op, got snap=%v err=%v", snap2, evictErr)
	}
	if err := mgr.EvictSession(info.ID); err != nil {
		t.Fatalf("EvictSession delegation: %v", err)
	}
	// The next access lazily restores a FRESH object — never the evicted one.
	restored, _ := mgr.GetSession(info.ID)
	if restored == sess {
		t.Fatal("the session must have been evicted — a fresh restore must replace the object")
	}
}
