package data

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

type scanDetail struct {
	Source      string `json:"source"`
	Description string `json:"description"`
}

// internshipLead mirrors data/internship-leads.json. It is deliberately
// separate from applications: discovering or saving a lead is not applying.
type internshipLead struct {
	ID             string   `json:"id"`
	URL            string   `json:"url"`
	Company        string   `json:"company"`
	Role           string   `json:"role"`
	Location       string   `json:"location"`
	PostedAt       string   `json:"postedAt"`
	Source         string   `json:"source"`
	Description    string   `json:"description"`
	Stage          string   `json:"stage"`
	RelevanceScore int      `json:"relevanceScore"`
	RankingReasons []string `json:"rankingReasons"`
	FirstSeenAt    string   `json:"firstSeenAt"`
	LastSeenAt     string   `json:"lastSeenAt"`
}

type internshipLeadStore struct {
	Leads []internshipLead `json:"leads"`
}

func loadScanDetails(careerOpsPath string) map[string]scanDetail {
	contents, err := os.ReadFile(filepath.Join(careerOpsPath, "data", "scan-details.json"))
	if err != nil {
		return map[string]scanDetail{}
	}
	details := map[string]scanDetail{}
	if err := json.Unmarshal(contents, &details); err != nil {
		return map[string]scanDetail{}
	}
	return details
}

func eligibleForAutomaticIntake(title string) bool {
	title = strings.ToLower(title)
	technicalTerms := []string{"engineer", "software", "developer", "product", "platform", "technical", "ai", "ml", "machine learning", "data", "infrastructure", "system", "robot", "autonomy", "research"}
	// Internship titles are evaluated later for subject-matter fit; title alone
	// still needs to indicate technical or product-building work.
	if strings.Contains(title, "intern") || strings.Contains(title, "co-op") || strings.Contains(title, "coop") || strings.Contains(title, "fellow") || strings.Contains(title, "student program") {
		for _, adjacent := range technicalTerms {
			if strings.Contains(title, adjacent) {
				return true
			}
		}
		return false
	}
	return false
}

// ParseInternshipLeads is the stage-aware source of truth for the terminal
// board. A pipeline fallback keeps existing installations usable until their
// first refresh.
func ParseInternshipLeads(careerOpsPath string) []model.PendingRole {
	contents, err := os.ReadFile(filepath.Join(careerOpsPath, "data", "internship-leads.json"))
	if err != nil {
		return ParsePendingRoles(careerOpsPath)
	}
	var store internshipLeadStore
	if err := json.Unmarshal(contents, &store); err != nil {
		return []model.PendingRole{}
	}
	roles := make([]model.PendingRole, 0, len(store.Leads))
	for _, lead := range store.Leads {
		if lead.URL == "" || lead.Role == "" {
			continue
		}
		roles = append(roles, model.PendingRole{ID: lead.ID, URL: lead.URL, Company: lead.Company, Role: lead.Role, Location: lead.Location, Posted: lead.PostedAt, Source: lead.Source, Description: lead.Description, Stage: lead.Stage, RelevanceScore: lead.RelevanceScore, RankingReasons: lead.RankingReasons, FirstSeenAt: lead.FirstSeenAt, LastSeenAt: lead.LastSeenAt})
	}
	return roles
}

// ParsePendingRoles reads the scanner inbox. It intentionally accepts only
// unchecked Markdown tasks, so evaluated/reconciled roles cannot reappear as
// new discovery work in the dashboard.
func ParsePendingRoles(careerOpsPath string) []model.PendingRole {
	contents, err := os.ReadFile(filepath.Join(careerOpsPath, "data", "pipeline.md"))
	if err != nil {
		return []model.PendingRole{}
	}
	details := loadScanDetails(careerOpsPath)
	roles := make([]model.PendingRole, 0)
	for _, line := range strings.Split(string(contents), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "- [ ] ") {
			continue
		}
		parts := strings.Split(strings.TrimSpace(strings.TrimPrefix(line, "- [ ] ")), " | ")
		if len(parts) < 3 || !strings.HasPrefix(parts[0], "https://") {
			continue
		}
		role := model.PendingRole{URL: strings.TrimSpace(parts[0]), Company: strings.TrimSpace(parts[1]), Role: strings.TrimSpace(parts[2])}
		if !eligibleForAutomaticIntake(role.Role) {
			continue
		}
		for _, part := range parts[3:] {
			part = strings.TrimSpace(part)
			if strings.HasPrefix(part, "posted: ") {
				role.Posted = strings.TrimSpace(strings.TrimPrefix(part, "posted: "))
				continue
			}
			// The first unlabeled trailing field is the optional location. Later
			// fields may be compensation/trust/note values and must not replace it.
			if role.Location == "" && !strings.Contains(part, ":") && !strings.Contains(part, "USD") {
				role.Location = part
			}
		}
		if detail, ok := details[role.URL]; ok {
			role.Source = detail.Source
			role.Description = detail.Description
		}
		roles = append(roles, role)
	}
	return roles
}
