package data

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

func queueSnapshot(payload []byte) model.ApplicationQueueSnapshot {
	sum := sha256.Sum256(payload)
	return model.ApplicationQueueSnapshot{
		Hash:      hex.EncodeToString(sum[:]),
		CreatedAt: "2026-01-01T00:00:00Z",
		Materials: []string{"output/resume.pdf"},
		Payload:   payload,
	}
}

func writeQueue(t *testing.T, root string, item model.ApplicationQueueItem) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := saveApplicationQueue(root, model.ApplicationQueue{Version: 1, Items: []model.ApplicationQueueItem{item}}); err != nil {
		t.Fatal(err)
	}
}

func TestApproveApplicationQueueItemBindsSnapshotAndExpires(t *testing.T) {
	root := t.TempDir()
	payload := []byte(`{"answers":{"workAuthorization":"yes"},"url":"https://example.test/jobs/1"}`)
	item := model.ApplicationQueueItem{ID: "q-1", Company: "Acme", Role: "Intern", URL: "https://example.test/jobs/1", State: QueueStateReadyForReview, Snapshot: queueSnapshot(payload)}
	writeQueue(t, root, item)
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	approved, err := ApproveApplicationQueueItem(root, "q-1", "dashboard", now)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if approved.State != QueueStateApproved || approved.Approval == nil {
		t.Fatalf("expected approved item, got %+v", approved)
	}
	if approved.Approval.SnapshotHash != approved.Snapshot.Hash {
		t.Fatalf("approval must bind snapshot hash")
	}
	if approved.Approval.ExpiresAt != now.Add(queueApprovalWindow).Format(time.RFC3339Nano) {
		t.Fatalf("unexpected expiry: %s", approved.Approval.ExpiresAt)
	}

	queue, err := RefreshApplicationQueueExpiry(root, now.Add(queueApprovalWindow))
	if err != nil {
		t.Fatalf("expire: %v", err)
	}
	if got := queue.Items[0].State; got != QueueStateApprovalExpired {
		t.Fatalf("expected approval expiry, got %s", got)
	}
}

func TestApproveApplicationQueueItemRejectsTamperedSnapshot(t *testing.T) {
	root := t.TempDir()
	item := model.ApplicationQueueItem{ID: "q-2", Company: "Acme", Role: "Intern", State: QueueStateReadyForReview, Snapshot: queueSnapshot([]byte(`{"url":"https://example.test"}`))}
	item.Snapshot.Payload = []byte(`{"url":"https://attacker.test"}`)
	writeQueue(t, root, item)
	if _, err := ApproveApplicationQueueItem(root, "q-2", "dashboard", time.Now()); err == nil {
		t.Fatal("expected tampered payload to block approval")
	}
}

func TestDashboardCannotMarkQueueItemSubmitted(t *testing.T) {
	root := t.TempDir()
	item := model.ApplicationQueueItem{ID: "q-3", Company: "Acme", Role: "Intern", State: QueueStateReadyForUserSubmit, Snapshot: queueSnapshot([]byte(`{"url":"https://example.test"}`))}
	writeQueue(t, root, item)
	if _, err := MoveApplicationQueueItem(root, "q-3", QueueStateSubmitted, "", time.Now()); err == nil {
		t.Fatal("dashboard must not mark a role submitted")
	}
}
