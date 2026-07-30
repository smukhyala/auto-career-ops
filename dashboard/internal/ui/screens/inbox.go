package screens

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// InboxClosedMsg returns to the application tracker. The scan inbox contains
// discovered roles only; it never changes application status.
type InboxClosedMsg struct{}
type InboxRefreshMsg struct{}
type InboxOpenURLMsg struct{ URL string }

type InboxModel struct {
	roles         []model.PendingRole
	cursor        int
	width, height int
	theme         theme.Theme
	careerOpsPath string
}

func NewInboxModel(t theme.Theme, careerOpsPath string, width, height int) InboxModel {
	return InboxModel{roles: data.ParsePendingRoles(careerOpsPath), theme: t, careerOpsPath: careerOpsPath, width: width, height: height}
}

func (m *InboxModel) Resize(width, height int) { m.width, m.height = width, height }
func (m *InboxModel) Reload() {
	m.roles = data.ParsePendingRoles(m.careerOpsPath)
	if m.cursor >= len(m.roles) {
		m.cursor = max(0, len(m.roles)-1)
	}
}

func (m InboxModel) Update(msg tea.Msg) (InboxModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.Resize(msg.Width, msg.Height)
	case tea.KeyMsg:
		switch msg.String() {
		case "esc", "q":
			return m, func() tea.Msg { return InboxClosedMsg{} }
		case "r":
			return m, func() tea.Msg { return InboxRefreshMsg{} }
		case "down", "j":
			if m.cursor < len(m.roles)-1 {
				m.cursor++
			}
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "o":
			if m.cursor >= 0 && m.cursor < len(m.roles) {
				url := m.roles[m.cursor].URL
				return m, func() tea.Msg { return InboxOpenURLMsg{URL: url} }
			}
		}
	}
	return m, nil
}

func (m InboxModel) View() string {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text).Background(m.theme.Surface).Width(m.width).Padding(0, 2)
	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render("Scan inbox")
	notice := lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(fmt.Sprintf("%d pending roles — evaluate before applying", len(m.roles)))
	gap := max(1, m.width-lipgloss.Width(title)-lipgloss.Width(notice)-4)
	lines := []string{headerStyle.Render(title + strings.Repeat(" ", gap) + notice)}
	if len(m.roles) == 0 {
		lines = append(lines, lipgloss.NewStyle().Padding(2, 2).Foreground(m.theme.Subtext).Render("No pending roles. Run npm run scan, then press r here."))
	} else {
		lines = append(lines, lipgloss.NewStyle().Bold(true).Foreground(m.theme.Subtext).Padding(0, 2).Render("COMPANY                  ROLE                                  LOCATION"))
		visible := max(1, m.height-5)
		start := m.cursor - visible + 1
		if start < 0 {
			start = 0
		}
		end := min(len(m.roles), start+visible)
		for i := start; i < end; i++ {
			r := m.roles[i]
			line := fmt.Sprintf("%-24s %-37s %s", inboxTruncate(r.Company, 24), inboxTruncate(r.Role, 37), inboxTruncate(r.Location, max(12, m.width-70)))
			style := lipgloss.NewStyle().Padding(0, 2).Foreground(m.theme.Text)
			if i == m.cursor {
				style = style.Background(m.theme.Overlay).Bold(true)
			}
			lines = append(lines, style.Render(line))
		}
	}
	help := lipgloss.NewStyle().Foreground(m.theme.Subtext).Padding(0, 2).Render("↑↓/jk navigate   o open role   r refresh inbox   q return to tracker")
	lines = append(lines, help)
	return lipgloss.JoinVertical(lipgloss.Left, lines...)
}

func inboxTruncate(value string, width int) string {
	r := []rune(value)
	if len(r) <= width {
		return value
	}
	if width <= 1 {
		return string(r[:width])
	}
	return string(r[:width-1]) + "…"
}
