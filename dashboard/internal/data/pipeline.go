package data

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

func eligibleForAutomaticIntake(title string) bool {
	title = strings.ToLower(title)
	technicalTerms := []string{"engineer", "software", "developer", "product", "platform", "technical", "ai", "ml", "machine learning", "data", "infrastructure", "system", "robot", "autonomy", "research"}
	// Internship titles are evaluated later for subject-matter fit; title alone
	// still needs to indicate technical or product-building work.
	if strings.Contains(title, "intern") || strings.Contains(title, "co-op") || strings.Contains(title, "coop") || strings.Contains(title, "fellow") {
		for _, adjacent := range technicalTerms {
			if strings.Contains(title, adjacent) {
				return true
			}
		}
		return false
	}
	if !strings.Contains(title, "founding") {
		return false
	}
	for _, blocked := range []string{"sales", "marketing", "operations", "recruit", "human resources", "account executive", "customer success", "finance"} {
		if strings.Contains(title, blocked) {
			return false
		}
	}
	for _, adjacent := range technicalTerms {
		if strings.Contains(title, adjacent) {
			return true
		}
	}
	return false
}

// ParsePendingRoles reads the scanner inbox. It intentionally accepts only
// unchecked Markdown tasks, so evaluated/reconciled roles cannot reappear as
// new discovery work in the dashboard.
func ParsePendingRoles(careerOpsPath string) []model.PendingRole {
	contents, err := os.ReadFile(filepath.Join(careerOpsPath, "data", "pipeline.md"))
	if err != nil {
		return []model.PendingRole{}
	}
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
		if len(parts) > 3 {
			role.Location = strings.TrimSpace(parts[3])
		}
		if len(parts) > 4 {
			role.Posted = strings.TrimSpace(strings.TrimPrefix(parts[4], "posted: "))
		}
		roles = append(roles, role)
	}
	return roles
}
