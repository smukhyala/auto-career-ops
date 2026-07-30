package screens

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

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
type InboxMoveStageMsg struct {
	Selector string
	Stage    string
}

type InboxModel struct {
	roles         []model.PendingRole
	cursor        int
	expandDetails bool
	width, height int
	theme         theme.Theme
	careerOpsPath string
	lastUpdated   time.Time
	sortMode      string
	search        string
	searching     bool
	flash         string
}

func NewInboxModel(t theme.Theme, careerOpsPath string, width, height int) InboxModel {
	return InboxModel{
		roles: data.ParseInternshipLeads(careerOpsPath), theme: t, careerOpsPath: careerOpsPath, sortMode: "score",
		width: width, height: height, lastUpdated: time.Now(),
	}
}

func (m *InboxModel) Resize(width, height int) { m.width, m.height = width, height }
func (m *InboxModel) SetFlash(value string)    { m.flash = value }

// Reload keeps the same posting selected when an auto-refresh adds or removes
// other roles. Falling back to the nearest valid row makes the inbox stable
// during an unattended scan.
func (m *InboxModel) Reload() {
	selectedURL := ""
	if m.cursor >= 0 && m.cursor < len(m.roles) {
		selectedURL = m.roles[m.cursor].URL
	}
	m.roles = data.ParseInternshipLeads(m.careerOpsPath)
	if selectedURL != "" {
		for i, role := range m.roles {
			if role.URL == selectedURL {
				m.cursor = i
				m.lastUpdated = time.Now()
				return
			}
		}
	}
	if m.cursor >= len(m.roles) {
		m.cursor = max(0, len(m.roles)-1)
	}
	m.lastUpdated = time.Now()
}

func (m InboxModel) Update(msg tea.Msg) (InboxModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.Resize(msg.Width, msg.Height)
	case tea.KeyMsg:
		if m.searching {
			switch msg.String() {
			case "esc", "enter":
				m.searching = false
			case "backspace":
				if len(m.search) > 0 {
					m.search = m.search[:len(m.search)-1]
				}
			default:
				if len(msg.Runes) > 0 {
					m.search += string(msg.Runes)
				}
			}
			m.clampCursor()
			return m, nil
		}
		switch msg.String() {
		case "esc", "q":
			return m, func() tea.Msg { return InboxClosedMsg{} }
		case "R":
			return m, func() tea.Msg { return InboxRefreshMsg{} }
		case "/":
			m.searching = true
		case "s":
			if m.sortMode == "score" {
				m.sortMode = "posted"
			} else if m.sortMode == "posted" {
				m.sortMode = "company"
			} else {
				m.sortMode = "score"
			}
			m.sortRoles()
		case "n", "v", "a", "r", "i", "f", "x", "z":
			stages := map[string]string{"n": "New", "v": "Saved", "a": "Applied", "r": "Responded", "i": "Interview", "f": "Offer", "x": "Rejected", "z": "Archived"}
			if role := m.selected(); role != nil {
				selector := role.ID
				if selector == "" {
					selector = role.URL
				}
				return m, func() tea.Msg { return InboxMoveStageMsg{Selector: selector, Stage: stages[msg.String()]} }
			}
		case "enter", "space":
			m.expandDetails = !m.expandDetails
		case "down", "j":
			if m.cursor < len(m.roles)-1 {
				m.cursor++
			}
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "o":
			if role := m.selected(); role != nil {
				url := role.URL
				return m, func() tea.Msg { return InboxOpenURLMsg{URL: url} }
			}
		}
	}
	return m, nil
}

func (m InboxModel) View() string {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text).Background(m.theme.Surface).Width(m.width).Padding(0, 2)
	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render("Internship discovery board")
	notice := lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(fmt.Sprintf("%d leads · sort %s · checked %s", len(m.filteredRoles()), m.sortMode, m.lastUpdated.Format("15:04")))
	gap := max(1, m.width-lipgloss.Width(title)-lipgloss.Width(notice)-4)
	lines := []string{headerStyle.Render(title + strings.Repeat(" ", gap) + notice)}
	if m.flash != "" {
		lines = append(lines, lipgloss.NewStyle().Foreground(m.theme.Green).Padding(0, 2).Render(inboxTruncate(m.flash, max(20, m.width-4))))
	}

	if len(m.roles) == 0 {
		lines = append(lines, lipgloss.NewStyle().Padding(2, 2).Foreground(m.theme.Subtext).Render(
			"No internship leads yet. Run npm run intake (daily discovery) or npm run leads:refresh, then press R."))
	} else if m.width >= 100 && m.height >= 14 {
		listWidth := max(36, m.width*42/100)
		detailWidth := max(38, m.width-listWidth-2)
		contentHeight := max(7, m.height-4)
		lines = append(lines, lipgloss.JoinHorizontal(lipgloss.Top,
			m.renderRoleList(listWidth, contentHeight),
			" ",
			m.renderDetailPane(detailWidth, contentHeight),
		))
	} else {
		listHeight := max(3, m.height/2-2)
		lines = append(lines, m.renderRoleList(m.width, listHeight), m.renderDetailPane(m.width, max(5, m.height-listHeight-5)))
	}

	help := lipgloss.NewStyle().Foreground(m.theme.Subtext).Background(m.theme.Surface).Width(m.width).Padding(0, 2).Render(
		"↑↓/jk select  / search  s sort  o open URL  v save  a applied  r responded  i interview  f offer  x reject  z archive  R refresh  q tracker")
	lines = append(lines, help)
	return lipgloss.JoinVertical(lipgloss.Left, lines...)
}

func (m InboxModel) renderRoleList(width, height int) string {
	border := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(m.theme.Overlay).Width(width).Height(height).Padding(0, 1)
	header := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky).Render("AVAILABLE ROLES")
	rows := []string{header}
	roles := m.filteredRoles()
	visible := max(1, height-3)
	start := m.cursor - visible + 1
	if start < 0 {
		start = 0
	}
	end := min(len(roles), start+visible)
	for i := start; i < end; i++ {
		r := roles[i]
		prefix := "  "
		style := lipgloss.NewStyle().Foreground(m.theme.Text).Width(width - 4)
		if i == m.cursor {
			prefix = "› "
			style = style.Background(m.theme.Overlay).Bold(true)
		}
		rows = append(rows, style.Render(prefix+inboxTruncate(fmt.Sprintf("%d  %s", r.RelevanceScore, r.Role), max(12, width-6))))
		company := inboxTruncate(r.Company, max(10, width-8))
		location := inboxTruncate(r.Location, max(10, width-8))
		stage := r.Stage
		if stage == "" {
			stage = "New"
		}
		rows = append(rows, lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("    "+company+" · "+location+" · "+stage))
	}
	return border.Render(strings.Join(rows, "\n"))
}

func (m InboxModel) renderDetailPane(width, height int) string {
	border := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(m.theme.Blue).Width(width).Height(height).Padding(0, 1)
	r := m.selected()
	if r == nil {
		return border.Render(lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("Select a role to inspect it."))
	}
	label := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text).Render(inboxTruncate(r.Role, max(16, width-6)))
	meta := []string{r.Company}
	if r.Location != "" {
		meta = append(meta, r.Location)
	}
	if r.Posted != "" {
		meta = append(meta, "posted "+r.Posted)
	}
	if r.Source != "" {
		meta = append(meta, "via "+r.Source)
	}
	lines := []string{
		label.Render("SELECTED ROLE"),
		title,
		lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(inboxTruncate(strings.Join(meta, " · "), max(16, width-6))),
		"",
		label.Render(fmt.Sprintf("RELEVANCE %d/100 · %s", r.RelevanceScore, r.Stage)),
		lipgloss.NewStyle().Foreground(m.theme.Text).Render(inboxWrap(strings.Join(r.RankingReasons, " · "), width-4, 2)),
		"",
		label.Render("POSTING TL;DR (SCRAPED TEXT)"),
	}
	description := strings.TrimSpace(r.Description)
	if description == "" {
		description = "This source did not provide a description in its listing feed. Open the employer posting to read the full job description."
	}
	maxLines := 4
	if m.expandDetails {
		maxLines = max(5, height-12)
	}
	lines = append(lines, lipgloss.NewStyle().Foreground(m.theme.Text).Render(inboxWrap(description, width-4, maxLines)))
	if !m.expandDetails && utf8.RuneCountInString(description) > (width-4)*maxLines {
		lines = append(lines, lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("Enter/Space: show more"))
	}
	lines = append(lines, "", lipgloss.NewStyle().Foreground(m.theme.Green).Bold(true).Render("o  Open posting · stage changes only track this lead; they never submit an application"))
	return border.Render(strings.Join(lines, "\n"))
}

func (m *InboxModel) filteredRoles() []model.PendingRole {
	roles := make([]model.PendingRole, 0, len(m.roles))
	query := strings.ToLower(strings.TrimSpace(m.search))
	for _, role := range m.roles {
		if query == "" || strings.Contains(strings.ToLower(role.Company+" "+role.Role+" "+role.Location+" "+role.Stage), query) {
			roles = append(roles, role)
		}
	}
	return roles
}
func (m *InboxModel) selected() *model.PendingRole {
	roles := m.filteredRoles()
	if m.cursor < 0 || m.cursor >= len(roles) {
		return nil
	}
	return &roles[m.cursor]
}
func (m *InboxModel) clampCursor() {
	if m.cursor >= len(m.filteredRoles()) {
		m.cursor = max(0, len(m.filteredRoles())-1)
	}
}
func (m *InboxModel) sortRoles() {
	for i := range m.roles {
		for j := i + 1; j < len(m.roles); j++ {
			swap := false
			if m.sortMode == "company" {
				swap = m.roles[j].Company < m.roles[i].Company
			} else if m.sortMode == "posted" {
				swap = m.roles[j].Posted > m.roles[i].Posted
			} else {
				swap = m.roles[j].RelevanceScore > m.roles[i].RelevanceScore
			}
			if swap {
				m.roles[i], m.roles[j] = m.roles[j], m.roles[i]
			}
		}
	}
}

func inboxWrap(value string, width, maxLines int) string {
	if width < 8 {
		return inboxTruncate(value, width)
	}
	words := strings.Fields(value)
	if len(words) == 0 {
		return ""
	}
	lines := make([]string, 0, maxLines)
	current := ""
	for _, word := range words {
		candidate := word
		if current != "" {
			candidate = current + " " + word
		}
		if utf8.RuneCountInString(candidate) <= width {
			current = candidate
			continue
		}
		if current != "" {
			lines = append(lines, current)
		}
		if len(lines) >= maxLines {
			return strings.Join(lines[:maxLines], "\n") + "…"
		}
		current = inboxTruncate(word, width)
	}
	if current != "" && len(lines) < maxLines {
		lines = append(lines, current)
	}
	if len(lines) > maxLines {
		lines = lines[:maxLines]
	}
	return strings.Join(lines, "\n")
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
