package model

import "encoding/json"

// ApplicationQueue is the local, user-layer application handoff queue. It is
// deliberately separate from the tracker: a tracker row records an outcome,
// while a queue item records the reviewed, single-use instruction to prepare a
// form. The browser worker must never treat an item as permission to submit.
type ApplicationQueue struct {
	Version int                    `json:"version"`
	Items   []ApplicationQueueItem `json:"items"`
}

// ApplicationQueueItem is an immutable-review snapshot plus its current
// handoff state. Timestamps are RFC3339 UTC strings so the Node worker and the
// dashboard can share the file without a language-specific codec.
type ApplicationQueueItem struct {
	ID           string                    `json:"id"`
	ReportNumber string                    `json:"reportNumber,omitempty"`
	Company      string                    `json:"company"`
	Role         string                    `json:"role"`
	URL          string                    `json:"url"`
	State        string                    `json:"state"`
	Snapshot     ApplicationQueueSnapshot  `json:"snapshot"`
	Approval     *ApplicationQueueApproval `json:"approval,omitempty"`
	CreatedAt    string                    `json:"createdAt"`
	UpdatedAt    string                    `json:"updatedAt"`
	LastError    string                    `json:"lastError,omitempty"`
}

type ApplicationQueueSnapshot struct {
	Hash       string   `json:"hash"`
	CreatedAt  string   `json:"createdAt"`
	ReportPath string   `json:"reportPath,omitempty"`
	Materials  []string `json:"materials"`
	// Payload is the exact, canonical JSON bytes hashed into Hash. It contains
	// the reviewed report URL/title, generated answers, and material metadata;
	// it is intentionally opaque to the terminal UI so it cannot be altered
	// during approval.
	Payload json.RawMessage `json:"payload"`
}

type ApplicationQueueApproval struct {
	ApprovedAt   string `json:"approvedAt"`
	ExpiresAt    string `json:"expiresAt"`
	Actor        string `json:"actor"`
	SnapshotHash string `json:"snapshotHash"`
}
