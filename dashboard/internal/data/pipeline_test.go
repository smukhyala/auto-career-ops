package data

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParsePendingRoles(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	contents := "# Job Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Acme | Engineering Intern | Remote | 42-55 USD | posted: 2026-07-29\n- [ ] https://jobs.example.com/2 | FullTimeCo | Senior Product Manager | Remote\n- [ ] https://jobs.example.com/3 | Startup | Founding Product Manager | San Francisco\n- [ ] https://jobs.example.com/4 | ResearchCo | ML Fellowship | San Francisco\n- [x] https://jobs.example.com/5 | Done | Role | Remote\n"
	if err := os.WriteFile(filepath.Join(dir, "data", "pipeline.md"), []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	details := `{"https://jobs.example.com/1":{"source":"Greenhouse","description":"Build useful systems with a small team."}}`
	if err := os.WriteFile(filepath.Join(dir, "data", "scan-details.json"), []byte(details), 0o644); err != nil {
		t.Fatal(err)
	}
	roles := ParsePendingRoles(dir)
	if len(roles) != 2 {
		t.Fatalf("got %d roles, want 2", len(roles))
	}
	if roles[0].Company != "Acme" || roles[0].Role != "Engineering Intern" || roles[0].Location != "Remote" || roles[0].Posted != "2026-07-29" {
		t.Fatalf("unexpected role: %+v", roles[0])
	}
	if roles[0].Source != "Greenhouse" || roles[0].Description != "Build useful systems with a small team." {
		t.Fatalf("scan detail was not loaded: %+v", roles[0])
	}
	if roles[1].Company != "ResearchCo" || roles[1].Role != "ML Fellowship" {
		t.Fatalf("unexpected fellowship role: %+v", roles[1])
	}
}
