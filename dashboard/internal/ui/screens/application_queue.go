package screens

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// QueueClosedMsg returns to the normal pipeline dashboard.
type QueueClosedMsg struct{}
type QueueRefreshMsg struct{}
type QueueOpenURLMsg struct{ URL string }
type QueueApproveMsg struct{ ID string }

// QueueVerifySubmissionMsg asks the retained local worker to inspect the page
// after the candidate personally clicked the employer's Submit control.
type QueueVerifySubmissionMsg struct{ ID string }
type QueueMoveMsg struct {
	ID     string
	To     string
	Reason string
}

// QueueModel is the explicit human approval surface for local browser handoff.
// Its controls never emit a final-submit action.
type QueueModel struct {
	queue         model.ApplicationQueue
	cursor        int
	width, height int
	theme         theme.Theme
	careerOpsPath string
	flash         string
}

func NewQueueModel(t theme.Theme, careerOpsPath string, width, height int) QueueModel {
	queue, err := data.RefreshApplicationQueueExpiry(careerOpsPath, time.Now())
	m := QueueModel{queue: queue, theme: t, careerOpsPath: careerOpsPath, width: width, height: height}
	if err != nil {
		m.flash = "Could not load application queue: " + err.Error()
	}
	return m
}

func (m QueueModel) Init() tea.Cmd             { return nil }
func (m *QueueModel) Resize(width, height int) { m.width, m.height = width, height }
func (m QueueModel) Width() int                { return m.width }
func (m QueueModel) Height() int               { return m.height }

func (m *QueueModel) Reload() {
	queue, err := data.RefreshApplicationQueueExpiry(m.careerOpsPath, time.Now())
	if err != nil {
		m.flash = "Could not reload application queue: " + err.Error()
		return
	}
	m.queue = queue
	if m.cursor >= len(m.queue.Items) {
		m.cursor = max(0, len(m.queue.Items)-1)
	}
}

func (m QueueModel) CurrentItem() (model.ApplicationQueueItem, bool) {
	if m.cursor < 0 || m.cursor >= len(m.queue.Items) {
		return model.ApplicationQueueItem{}, false
	}
	return m.queue.Items[m.cursor], true
}

func (m QueueModel) Update(msg tea.Msg) (QueueModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.Resize(msg.Width, msg.Height)
	case tea.KeyMsg:
		m.flash = ""
		switch msg.String() {
		case "esc", "q":
			return m, func() tea.Msg { return QueueClosedMsg{} }
		case "down", "j":
			if m.cursor < len(m.queue.Items)-1 {
				m.cursor++
			}
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "r":
			return m, func() tea.Msg { return QueueRefreshMsg{} }
		case "o":
			if item, ok := m.CurrentItem(); ok && item.URL != "" {
				return m, func() tea.Msg { return QueueOpenURLMsg{URL: item.URL} }
			}
		case "y":
			if item, ok := m.CurrentItem(); ok {
				return m, func() tea.Msg { return QueueApproveMsg{ID: item.ID} }
			}
		case "v":
			if item, ok := m.CurrentItem(); ok {
				return m, func() tea.Msg { return QueueVerifySubmissionMsg{ID: item.ID} }
			}
		case "x":
			if item, ok := m.CurrentItem(); ok {
				return m, func() tea.Msg {
					return QueueMoveMsg{ID: item.ID, To: data.QueueStateNeedsUserAction, Reason: "cancelled by dashboard user"}
				}
			}
		case "R":
			if item, ok := m.CurrentItem(); ok {
				return m, func() tea.Msg {
					return QueueMoveMsg{ID: item.ID, To: data.QueueStatePreparing, Reason: "retry requested by dashboard user"}
				}
			}
		}
	}
	return m, nil
}

func (m QueueModel) View() string {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text).Background(m.theme.Surface).Width(m.width).Padding(0, 2)
	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render("Application queue")
	notice := lipgloss.NewStyle().Foreground(m.theme.Yellow).Render("Final Submit is always yours")
	gap := max(1, m.width-lipgloss.Width(title)-lipgloss.Width(notice)-4)
	header := headerStyle.Render(title + strings.Repeat(" ", gap) + notice)

	lines := []string{header, m.renderTable(), m.renderDetails(), m.renderHelp()}
	return lipgloss.JoinVertical(lipgloss.Left, lines...)
}

func (m QueueModel) renderTable() string {
	if len(m.queue.Items) == 0 {
		return lipgloss.NewStyle().Foreground(m.theme.Subtext).Padding(2, 2).Render("No reviewed applications are ready for handoff.")
	}
	header := lipgloss.NewStyle().Foreground(m.theme.Subtext).Bold(true).Padding(0, 2).Render("STATE                 COMPANY                 ROLE")
	lines := []string{header}
	for i, item := range m.queue.Items {
		state := truncateRunes(item.State, 21)
		company := truncateRunes(item.Company, 23)
		role := truncateRunes(item.Role, max(18, m.width-54))
		line := fmt.Sprintf("%-21s %-23s %s", state, company, role)
		style := lipgloss.NewStyle().Padding(0, 2).Foreground(m.theme.Text)
		if i == m.cursor {
			style = style.Background(m.theme.Overlay).Bold(true)
		}
		lines = append(lines, style.Render(line))
	}
	return strings.Join(lines, "\n")
}

func (m QueueModel) renderDetails() string {
	item, ok := m.CurrentItem()
	if !ok {
		return ""
	}
	label := lipgloss.NewStyle().Foreground(m.theme.Sky).Bold(true)
	value := lipgloss.NewStyle().Foreground(m.theme.Text)
	dim := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	lines := []string{lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(strings.Repeat("─", max(1, m.width-4)))}
	lines = append(lines, label.Render("Role: ")+value.Render(item.Company+" — "+item.Role))
	lines = append(lines, label.Render("Review snapshot: ")+value.Render(snapshotStatus(item)))
	if item.Approval != nil {
		lines = append(lines, label.Render("Approval: ")+value.Render("expires "+item.Approval.ExpiresAt))
	}
	if item.LastError != "" {
		lines = append(lines, label.Render("Attention: ")+value.Render(item.LastError))
	}
	for _, line := range reviewSnapshotLines(item) {
		lines = append(lines, dim.Render(line))
	}
	if item.State == data.QueueStateReadyForUserSubmit {
		lines = append(lines, lipgloss.NewStyle().Foreground(m.theme.Yellow).Bold(true).Render("Form is ready. Open it and personally click Submit; the dashboard will not submit it."))
	} else {
		lines = append(lines, dim.Render("Approve only after reviewing the report, answers, and attachments."))
	}
	return lipgloss.NewStyle().Padding(0, 2).Render(strings.Join(lines, "\n"))
}

// reviewSnapshotLines intentionally renders only the candidate's already
// reviewed local snapshot. It never reaches into a browser or generates an
// answer, which keeps dashboard approval a real, inspectable boundary.
func reviewSnapshotLines(item model.ApplicationQueueItem) []string {
	if len(item.Snapshot.Payload) == 0 {
		return []string{"Reviewed answers: missing"}
	}
	var payload struct {
		Answers []struct {
			Label    string `json:"label"`
			Selector string `json:"selector"`
			Type     string `json:"type"`
			Value    string `json:"value"`
			FilePath string `json:"filePath"`
		} `json:"answers"`
		Materials []struct {
			Name string `json:"name"`
		} `json:"materials"`
	}
	if err := json.Unmarshal(item.Snapshot.Payload, &payload); err != nil {
		return []string{"Reviewed answers: unreadable snapshot payload"}
	}
	lines := []string{fmt.Sprintf("Reviewed answers: %d", len(payload.Answers))}
	for i, answer := range payload.Answers {
		if i >= 4 {
			lines = append(lines, fmt.Sprintf("… %d more reviewed fields", len(payload.Answers)-i))
			break
		}
		name := answer.Label
		if name == "" {
			name = answer.Selector
		}
		value := answer.Value
		if answer.FilePath != "" {
			value = answer.FilePath
		}
		if value == "" {
			value = "(review required)"
		}
		lines = append(lines, "• "+truncateRunes(name, 28)+": "+truncateRunes(value, 64))
	}
	if len(payload.Materials) > 0 {
		names := make([]string, 0, len(payload.Materials))
		for _, material := range payload.Materials {
			names = append(names, material.Name)
		}
		lines = append(lines, "Attachments: "+strings.Join(names, ", "))
	}
	return lines
}

func snapshotStatus(item model.ApplicationQueueItem) string {
	if item.Snapshot.Hash == "" {
		return "missing — approval blocked"
	}
	if item.Snapshot.ReportPath == "" {
		return "hash " + truncateRunes(item.Snapshot.Hash, 16)
	}
	return "hash " + truncateRunes(item.Snapshot.Hash, 16) + " · " + item.Snapshot.ReportPath
}

func (m QueueModel) renderHelp() string {
	style := lipgloss.NewStyle().Foreground(m.theme.Subtext).Background(m.theme.Surface).Width(m.width).Padding(0, 1)
	key := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	desc := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	if m.flash != "" {
		return lipgloss.NewStyle().Foreground(m.theme.Yellow).Background(m.theme.Surface).Width(m.width).Padding(0, 1).Render(m.flash)
	}
	return style.Render(key.Render("↑↓/jk") + desc.Render(" navigate  ") + key.Render("y") + desc.Render(" approve & prepare  ") + key.Render("v") + desc.Render(" verify receipt  ") + key.Render("R") + desc.Render(" retry  ") + key.Render("x") + desc.Render(" cancel  ") + key.Render("o") + desc.Render(" open posting  ") + key.Render("r") + desc.Render(" refresh  ") + key.Render("Esc") + desc.Render(" back"))
}

func (m *QueueModel) SetFlash(value string) { m.flash = value }
