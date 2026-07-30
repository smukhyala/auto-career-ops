package data

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

const (
	QueueStateDrafted            = "Drafted"
	QueueStateReadyForReview     = "ReadyForReview"
	QueueStateApproved           = "Approved"
	QueueStatePreparing          = "Preparing"
	QueueStateReadyForUserSubmit = "ReadyForUserSubmit"
	QueueStateSubmitted          = "Submitted"
	QueueStateNeedsUserAction    = "NeedsUserAction"
	QueueStateFailed             = "Failed"
	QueueStateExpired            = "Expired"
	QueueStateApprovalExpired    = "ApprovalExpired"
)

const queueApprovalWindow = 30 * time.Minute

// applicationQueueMu serializes dashboard read-modify-write operations. Writes
// use a same-directory rename, so a worker always sees a complete JSON file.
// The queue is local user data, not a tracker replacement.
var applicationQueueMu sync.Mutex

func ApplicationQueuePath(careerOpsPath string) string {
	return filepath.Join(careerOpsPath, "data", "application-queue.json")
}

func emptyApplicationQueue() model.ApplicationQueue {
	return model.ApplicationQueue{Version: 1, Items: []model.ApplicationQueueItem{}}
}

// LoadApplicationQueue returns an empty v1 queue before the first role is
// queued. A malformed queue is surfaced to the caller rather than discarded.
func LoadApplicationQueue(careerOpsPath string) (model.ApplicationQueue, error) {
	path := ApplicationQueuePath(careerOpsPath)
	content, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return emptyApplicationQueue(), nil
	}
	if err != nil {
		return model.ApplicationQueue{}, fmt.Errorf("read application queue: %w", err)
	}
	var queue model.ApplicationQueue
	if err := json.Unmarshal(content, &queue); err != nil {
		return model.ApplicationQueue{}, fmt.Errorf("parse application queue: %w", err)
	}
	if queue.Version == 0 {
		queue.Version = 1
	}
	if queue.Version != 1 {
		return model.ApplicationQueue{}, fmt.Errorf("unsupported application queue version %d", queue.Version)
	}
	if queue.Items == nil {
		queue.Items = []model.ApplicationQueueItem{}
	}
	return queue, nil
}

func saveApplicationQueue(careerOpsPath string, queue model.ApplicationQueue) error {
	queue.Version = 1
	if queue.Items == nil {
		queue.Items = []model.ApplicationQueueItem{}
	}
	content, err := json.MarshalIndent(queue, "", "  ")
	if err != nil {
		return fmt.Errorf("encode application queue: %w", err)
	}
	path := ApplicationQueuePath(careerOpsPath)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create application queue directory: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".application-queue-*.tmp")
	if err != nil {
		return fmt.Errorf("create application queue temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(append(content, '\n')); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write application queue: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("protect application queue: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close application queue: %w", err)
	}
	if err := replaceFileAtomic(tmpName, path); err != nil {
		return fmt.Errorf("replace application queue: %w", err)
	}
	return nil
}

// ValidApplicationQueueTransition is shared validation for dashboard commands.
// Submitted is terminal: only a receipt-verifying worker may create it.
func ValidApplicationQueueTransition(from, to string) bool {
	if from == to {
		return true
	}
	allowed := map[string]map[string]bool{
		QueueStateDrafted:            {QueueStateReadyForReview: true, QueueStateExpired: true, QueueStateNeedsUserAction: true},
		QueueStateReadyForReview:     {QueueStateApproved: true, QueueStateNeedsUserAction: true, QueueStateExpired: true},
		QueueStateApproved:           {QueueStatePreparing: true, QueueStateApprovalExpired: true, QueueStateNeedsUserAction: true},
		QueueStatePreparing:          {QueueStateReadyForUserSubmit: true, QueueStateNeedsUserAction: true, QueueStateFailed: true, QueueStateExpired: true},
		QueueStateReadyForUserSubmit: {QueueStateSubmitted: true, QueueStateNeedsUserAction: true, QueueStateFailed: true, QueueStateExpired: true},
		QueueStateNeedsUserAction:    {QueueStateReadyForReview: true, QueueStatePreparing: true, QueueStateExpired: true},
		QueueStateFailed:             {QueueStatePreparing: true, QueueStateNeedsUserAction: true, QueueStateExpired: true},
		QueueStateApprovalExpired:    {QueueStateReadyForReview: true, QueueStateExpired: true},
	}
	return allowed[from][to]
}

func parseQueueTime(value string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// ValidateApplicationQueueSnapshot checks the immutable approval payload
// without interpreting its answers. Producers must serialize the payload in a
// stable/canonical form and set Hash to its lowercase SHA-256 digest.
func ValidateApplicationQueueSnapshot(snapshot model.ApplicationQueueSnapshot) error {
	if strings.TrimSpace(snapshot.Hash) == "" {
		return errors.New("snapshot hash is missing")
	}
	if !json.Valid(snapshot.Payload) || len(snapshot.Payload) == 0 {
		return errors.New("snapshot payload is missing or invalid JSON")
	}
	// json.MarshalIndent may re-indent a RawMessage when persisting the enclosing
	// queue. Hash its compact JSON representation so formatting cannot silently
	// invalidate an otherwise identical reviewed payload.
	var canonical bytes.Buffer
	if err := json.Compact(&canonical, snapshot.Payload); err != nil {
		return errors.New("snapshot payload cannot be canonicalized")
	}
	sum := sha256.Sum256(canonical.Bytes())
	if !strings.EqualFold(snapshot.Hash, hex.EncodeToString(sum[:])) {
		return errors.New("snapshot hash does not match payload")
	}
	return nil
}

func expireApprovals(queue *model.ApplicationQueue, now time.Time) bool {
	changed := false
	for i := range queue.Items {
		item := &queue.Items[i]
		if item.State != QueueStateApproved || item.Approval == nil {
			continue
		}
		expires, ok := parseQueueTime(item.Approval.ExpiresAt)
		if !ok || !now.Before(expires) {
			item.State = QueueStateApprovalExpired
			item.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
			item.LastError = "approval expired before preparation started"
			changed = true
		}
	}
	return changed
}

// RefreshApplicationQueueExpiry makes a stale approval visible as expired in
// every dashboard session, including ones opened after the 30-minute window.
func RefreshApplicationQueueExpiry(careerOpsPath string, now time.Time) (model.ApplicationQueue, error) {
	applicationQueueMu.Lock()
	defer applicationQueueMu.Unlock()
	queue, err := LoadApplicationQueue(careerOpsPath)
	if err != nil {
		return model.ApplicationQueue{}, err
	}
	if expireApprovals(&queue, now) {
		if err := saveApplicationQueue(careerOpsPath, queue); err != nil {
			return model.ApplicationQueue{}, err
		}
	}
	return queue, nil
}

func updateApplicationQueueItem(careerOpsPath, id string, now time.Time, mutate func(*model.ApplicationQueueItem) error) (model.ApplicationQueueItem, error) {
	applicationQueueMu.Lock()
	defer applicationQueueMu.Unlock()
	queue, err := LoadApplicationQueue(careerOpsPath)
	if err != nil {
		return model.ApplicationQueueItem{}, err
	}
	_ = expireApprovals(&queue, now)
	for i := range queue.Items {
		if queue.Items[i].ID != id {
			continue
		}
		if err := mutate(&queue.Items[i]); err != nil {
			return model.ApplicationQueueItem{}, err
		}
		queue.Items[i].UpdatedAt = now.UTC().Format(time.RFC3339Nano)
		if err := saveApplicationQueue(careerOpsPath, queue); err != nil {
			return model.ApplicationQueueItem{}, err
		}
		return queue.Items[i], nil
	}
	return model.ApplicationQueueItem{}, fmt.Errorf("application queue item %q not found", id)
}

// ApproveApplicationQueueItem grants a single dashboard approval for 30
// minutes. It does not start a browser or submit an application.
func ApproveApplicationQueueItem(careerOpsPath, id, actor string, now time.Time) (model.ApplicationQueueItem, error) {
	if strings.TrimSpace(actor) == "" {
		actor = "dashboard"
	}
	return updateApplicationQueueItem(careerOpsPath, id, now, func(item *model.ApplicationQueueItem) error {
		if item.State != QueueStateReadyForReview {
			return fmt.Errorf("cannot approve item in %s", item.State)
		}
		if err := ValidateApplicationQueueSnapshot(item.Snapshot); err != nil {
			return fmt.Errorf("cannot approve item without a valid immutable snapshot: %w", err)
		}
		item.State = QueueStateApproved
		item.LastError = ""
		item.Approval = &model.ApplicationQueueApproval{
			ApprovedAt:   now.UTC().Format(time.RFC3339Nano),
			ExpiresAt:    now.UTC().Add(queueApprovalWindow).Format(time.RFC3339Nano),
			Actor:        actor,
			SnapshotHash: item.Snapshot.Hash,
		}
		return nil
	})
}

// MoveApplicationQueueItem applies a validated non-submission transition.
// Deliberately rejecting Submitted here prevents a dashboard shortcut from
// claiming an application was sent; only the receipt-verifying worker owns it.
func MoveApplicationQueueItem(careerOpsPath, id, to, reason string, now time.Time) (model.ApplicationQueueItem, error) {
	return updateApplicationQueueItem(careerOpsPath, id, now, func(item *model.ApplicationQueueItem) error {
		if to == QueueStateSubmitted {
			return errors.New("dashboard cannot mark an application submitted")
		}
		if !ValidApplicationQueueTransition(item.State, to) {
			return fmt.Errorf("invalid application queue transition %s → %s", item.State, to)
		}
		item.State = to
		item.LastError = strings.TrimSpace(reason)
		if to != QueueStateApproved {
			item.Approval = nil
		}
		return nil
	})
}

// ConfirmApplicationQueueSubmission records only a receipt-confirmed outcome.
// The dashboard calls this after the candidate made the employer's visible
// final click and the retained worker found a confirmation screen or ID.
func ConfirmApplicationQueueSubmission(careerOpsPath, id, receiptID string, now time.Time) (model.ApplicationQueueItem, error) {
	if strings.TrimSpace(receiptID) == "" {
		return model.ApplicationQueueItem{}, errors.New("cannot confirm submission without an employer receipt")
	}
	item, err := updateApplicationQueueItem(careerOpsPath, id, now, func(item *model.ApplicationQueueItem) error {
		if item.State != QueueStateReadyForUserSubmit {
			return fmt.Errorf("cannot confirm submission in %s", item.State)
		}
		item.State = QueueStateSubmitted
		item.LastError = ""
		item.Approval = nil
		return nil
	})
	if err != nil {
		return model.ApplicationQueueItem{}, err
	}
	_ = appendApplicationQueueAudit(careerOpsPath, map[string]string{
		"type": "submission-confirmed", "queueId": item.ID, "reportNumber": item.ReportNumber,
		"snapshotHash": item.Snapshot.Hash, "receiptId": receiptID, "at": now.UTC().Format(time.RFC3339Nano),
	})
	return item, nil
}

// appendApplicationQueueAudit writes operational, deliberately non-PII events
// to a user-layer JSONL file. Answers, uploads, browser cookies, credentials,
// and raw form content never enter this log.
func appendApplicationQueueAudit(careerOpsPath string, event map[string]string) error {
	path := filepath.Join(careerOpsPath, "data", "application-queue-audit.jsonl")
	encoded, err := json.Marshal(event)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(encoded, '\n'))
	return err
}
