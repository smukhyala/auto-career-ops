package screens

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

func TestQueueApproveEmitsExplicitApprovalMessage(t *testing.T) {
	m := NewQueueModel(theme.NewTheme("catppuccin-mocha"), t.TempDir(), 100, 30)
	m.queue = model.ApplicationQueue{Version: 1, Items: []model.ApplicationQueueItem{{ID: "q-1", Company: "Acme", Role: "Intern", State: data.QueueStateReadyForReview}}}
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	if cmd == nil {
		t.Fatal("approve key should emit a queue approval message")
	}
	if _, ok := cmd().(QueueApproveMsg); !ok {
		t.Fatalf("expected QueueApproveMsg, got %T", cmd())
	}
}

func TestQueueReadyForUserSubmitWarnsThatUserSubmits(t *testing.T) {
	m := NewQueueModel(theme.NewTheme("catppuccin-mocha"), t.TempDir(), 120, 30)
	m.queue = model.ApplicationQueue{Version: 1, Items: []model.ApplicationQueueItem{{ID: "q-1", Company: "Acme", Role: "Intern", State: data.QueueStateReadyForUserSubmit}}}
	if got := m.View(); !containsText(got, "personally click Submit") {
		t.Fatalf("expected explicit final submit warning, got %q", got)
	}
}

func containsText(value, want string) bool {
	for i := 0; i+len(want) <= len(value); i++ {
		if value[i:i+len(want)] == want {
			return true
		}
	}
	return false
}
