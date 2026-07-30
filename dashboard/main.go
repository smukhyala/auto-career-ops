package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/santifer/career-ops/dashboard/internal/applyworker"
	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/i18n"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
	"github.com/santifer/career-ops/dashboard/internal/ui/screens"
)

type viewState int

const (
	viewPipeline viewState = iota
	viewReport
	viewProgress
	viewQueue
	viewInbox
)

type appModel struct {
	pipeline        screens.PipelineModel
	viewer          screens.ViewerModel
	progress        screens.ProgressModel
	queue           screens.QueueModel
	inbox           screens.InboxModel
	state           viewState
	careerOpsPath   string
	theme           theme.Theme
	progressMetrics model.ProgressMetrics
	applyWorker     *applyworker.Client
}

// QueueWorkerResultMsg is delivered after an approved worker handoff or a
// receipt check. The worker process stays alive in appModel across both calls.
type QueueWorkerResultMsg struct {
	ID        string
	State     string
	Reason    string
	ReceiptID string
	Err       string
}

type workerResult struct {
	State   string `json:"state"`
	Reason  string `json:"reason"`
	Receipt *struct {
		ReceiptID *string `json:"receiptId"`
	} `json:"receipt"`
}

func (m *appModel) reloadPipelineData() {
	apps := data.ParseApplications(m.careerOpsPath)
	metrics := data.ComputeMetrics(apps)
	m.progressMetrics = data.ComputeProgressMetrics(apps)
	m.pipeline = m.pipeline.WithReloadedData(apps, metrics)
}

func (m appModel) Init() tea.Cmd {
	return nil
}

// Update manages global app state and routes incoming messages to active screens.
func (m appModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if keyMsg, ok := msg.(tea.KeyMsg); ok {
		switch keyMsg.String() {
		case "t", "T":
			// Toggle language globally, unless the user is actively typing in a text input field
			if !(m.state == viewPipeline && m.pipeline.IsTextInputActive()) {
				i18n.ToggleLang()
			}
		}
	}

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.pipeline.Resize(msg.Width, msg.Height)
		if m.state == viewReport {
			m.viewer.Resize(msg.Width, msg.Height)
		}
		if m.state == viewProgress {
			m.progress.Resize(msg.Width, msg.Height)
		}
		if m.state == viewQueue {
			m.queue.Resize(msg.Width, msg.Height)
		}
		if m.state == viewInbox {
			m.inbox.Resize(msg.Width, msg.Height)
		}
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd

	case screens.PipelineClosedMsg:
		return m, tea.Quit

	case screens.PipelineLoadReportMsg:
		archetype, tldr, remote, comp := data.LoadReportSummary(msg.CareerOpsPath, msg.ReportPath)
		m.pipeline.EnrichReport(msg.ReportPath, archetype, tldr, remote, comp)
		return m, nil

	case screens.PipelineUpdateStatusMsg:
		err := data.UpdateApplicationStatus(msg.CareerOpsPath, msg.App, msg.NewStatus)
		if err != nil {
			// Log the error but still reload data to keep UI consistent
			fmt.Fprintf(os.Stderr, "WARN: status update failed: %v\n", err)
		}
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineUpdateStatusAndNotesMsg:
		// Issue 1380: atomic status + notes write from the discard reason picker.
		err := data.UpdateApplicationStatusAndNotes(msg.CareerOpsPath, msg.App, msg.NewStatus, msg.NotesAppend)
		if err != nil {
			fmt.Fprintf(os.Stderr, "WARN: status+notes update failed: %v\n", err)
		}
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineRefreshMsg:
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineOpenReportMsg:
		m.viewer = screens.NewViewerModel(
			m.theme,
			m.careerOpsPath,
			msg.Path, msg.Title,
			m.pipeline.Width(), m.pipeline.Height(),
			msg.App,
		)
		m.state = viewReport
		return m, nil

	case screens.ViewerClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.ViewerOpenCoverLetterMsg:
		path := msg.Path
		return m, func() tea.Msg {
			if err := openWithDefaultApp(path); err != nil {
				fmt.Fprintf(os.Stderr, "WARN: could not open cover letter: %v\n", err)
			}
			return nil
		}

	case screens.ViewerUpdateStatusMsg:
		normalized := data.NormalizeStatus(msg.NewStatus)
		if normalized == "hired" {
			err := data.UpdateApplicationStatus(m.careerOpsPath, msg.App, msg.NewStatus)
			if err != nil {
				fmt.Fprintf(os.Stderr, "WARN: status update failed: %v\n", err)
				m.reloadPipelineData()
				return m, nil
			}
			m.state = viewPipeline
			m.pipeline, _ = m.pipeline.StartHiredFlow(msg.App)
			m.reloadPipelineData()
			return m, nil
		}
		if normalized == "discarded" || normalized == "skip" {
			m.state = viewPipeline
			m.pipeline, _ = m.pipeline.StartDiscardReasonFlow(msg.App, msg.NewStatus)
			m.reloadPipelineData()
			return m, nil
		}

		err := data.UpdateApplicationStatus(m.careerOpsPath, msg.App, msg.NewStatus)
		if err != nil {
			fmt.Fprintf(os.Stderr, "WARN: status update failed: %v\n", err)
		}
		m.viewer.UpdateAppStatus(msg.NewStatus)
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineOpenProgressMsg:
		m.progress = screens.NewProgressModel(
			theme.NewTheme("catppuccin-mocha"),
			m.progressMetrics,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewProgress
		return m, nil

	case screens.PipelineOpenQueueMsg:
		m.queue = screens.NewQueueModel(m.theme, m.careerOpsPath, m.pipeline.Width(), m.pipeline.Height())
		m.state = viewQueue
		return m, nil

	case screens.PipelineOpenInboxMsg:
		m.inbox = screens.NewInboxModel(m.theme, m.careerOpsPath, m.pipeline.Width(), m.pipeline.Height())
		m.state = viewInbox
		return m, nil

	case screens.ProgressClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.QueueClosedMsg:
		if m.applyWorker != nil {
			_ = m.applyWorker.Close()
			m.applyWorker = nil
		}
		m.state = viewPipeline
		return m, nil

	case screens.InboxClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.InboxRefreshMsg:
		m.inbox.Reload()
		return m, nil

	case screens.InboxOpenURLMsg:
		return m, openCmd(msg.URL)

	case screens.QueueRefreshMsg:
		m.queue.Reload()
		return m, nil

	case screens.QueueOpenURLMsg:
		return m, openCmd(msg.URL)

	case screens.QueueApproveMsg:
		item, err := data.ApproveApplicationQueueItem(m.careerOpsPath, msg.ID, "dashboard", time.Now())
		if err != nil {
			m.queue.SetFlash("Approval blocked: " + err.Error())
			m.queue.Reload()
			return m, nil
		}
		if _, err := data.MoveApplicationQueueItem(m.careerOpsPath, msg.ID, data.QueueStatePreparing, "approved handoff started", time.Now()); err != nil {
			m.queue.SetFlash("Could not start preparation: " + err.Error())
			m.queue.Reload()
			return m, nil
		}
		if m.applyWorker != nil {
			_ = m.applyWorker.Close()
		}
		m.applyWorker, err = applyworker.Start(m.careerOpsPath)
		if err != nil {
			_, _ = data.MoveApplicationQueueItem(m.careerOpsPath, msg.ID, data.QueueStateNeedsUserAction, "could not start local browser worker", time.Now())
			m.queue.SetFlash("Browser worker unavailable: " + err.Error())
			m.applyWorker = nil
			m.queue.Reload()
			return m, nil
		}
		m.queue.Reload()
		return m, runReviewedQueueItem(m.applyWorker, item)

	case QueueWorkerResultMsg:
		if msg.Err != "" {
			_, _ = data.MoveApplicationQueueItem(m.careerOpsPath, msg.ID, data.QueueStateNeedsUserAction, msg.Err, time.Now())
			m.queue.SetFlash("Application needs your attention: " + msg.Err)
			m.queue.Reload()
			return m, nil
		}
		switch msg.State {
		case data.QueueStateReadyForUserSubmit:
			_, err := data.MoveApplicationQueueItem(m.careerOpsPath, msg.ID, data.QueueStateReadyForUserSubmit, "form filled and handed off for visible review", time.Now())
			if err != nil {
				m.queue.SetFlash("Could not record handoff: " + err.Error())
			} else {
				m.queue.SetFlash("Form is open. Review it and click the employer's Submit button yourself; then press v here.")
			}
		case data.QueueStateSubmitted:
			if err := confirmQueueSubmission(m.careerOpsPath, msg.ID, msg.ReceiptID); err != nil {
				m.queue.SetFlash("Receipt found, but tracking update needs attention: " + err.Error())
			} else {
				m.queue.SetFlash("Receipt confirmed. Tracker is now Applied and follow-up cadence was seeded.")
			}
		default:
			reason := msg.Reason
			if reason == "" {
				reason = "worker stopped before a verified handoff"
			}
			_, _ = data.MoveApplicationQueueItem(m.careerOpsPath, msg.ID, data.QueueStateNeedsUserAction, reason, time.Now())
			m.queue.SetFlash("Application needs your attention: " + reason)
		}
		m.queue.Reload()
		return m, nil

	case screens.QueueVerifySubmissionMsg:
		if m.applyWorker == nil {
			m.queue.SetFlash("No retained browser session. Re-open the application and verify the employer receipt manually.")
			return m, nil
		}
		return m, verifyQueueSubmission(m.applyWorker, msg.ID)

	case screens.QueueMoveMsg:
		if _, err := data.MoveApplicationQueueItem(m.careerOpsPath, msg.ID, msg.To, msg.Reason, time.Now()); err != nil {
			m.queue.SetFlash("Queue action blocked: " + err.Error())
		} else {
			m.queue.SetFlash("Queue updated.")
		}
		m.queue.Reload()
		return m, nil

	case screens.PipelineOpenURLMsg:
		return m, openCmd(msg.URL)

	case screens.PipelineOpenPDFMsg:
		return m, openCmd(msg.Path)

	case screens.PipelineGeneratePDFMsg:
		return m, runGeneratePDF(msg)

	default:
		if m.state == viewReport {
			vm, cmd := m.viewer.Update(msg)
			m.viewer = vm
			return m, cmd
		}
		if m.state == viewProgress {
			pg, cmd := m.progress.Update(msg)
			m.progress = pg
			return m, cmd
		}
		if m.state == viewQueue {
			qm, cmd := m.queue.Update(msg)
			m.queue = qm
			return m, cmd
		}
		if m.state == viewInbox {
			im, cmd := m.inbox.Update(msg)
			m.inbox = im
			return m, cmd
		}
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd
	}
}

// openCmd wraps openWithDefaultApp (OS-specific) as a tea.Cmd. Shared by the
// job-URL (`o`) and CV-PDF (`d`) actions.
func openCmd(target string) tea.Cmd {
	return func() tea.Msg {
		if err := openWithDefaultApp(target); err != nil {
			fmt.Fprintf(os.Stderr, "WARN: failed to open %q: %v\n", target, err)
		}
		return nil
	}
}

// runGeneratePDF shells out to node generate-pdf.mjs in the career-ops root,
// opens the resulting PDF on success, and reports the outcome back to the
// pipeline screen as a PipelinePDFGeneratedMsg. Runs in a tea.Cmd goroutine,
// so the UI stays responsive while Chromium renders.
func runGeneratePDF(msg screens.PipelineGeneratePDFMsg) tea.Cmd {
	return func() tea.Msg {
		args := []string{"generate-pdf.mjs", msg.HTMLPath, msg.PDFPath}
		if msg.Format != "" {
			args = append(args, "--format="+msg.Format)
		}
		if msg.ReportNumber != "" {
			args = append(args, "--report="+msg.ReportNumber)
		}
		cmd := exec.Command("node", args...)
		cmd.Dir = msg.CareerOpsPath
		out, err := cmd.CombinedOutput()
		if err != nil {
			return screens.PipelinePDFGeneratedMsg{Err: summarizeCmdError(err, out)}
		}
		pdfAbs := filepath.Join(msg.CareerOpsPath, filepath.FromSlash(msg.PDFPath))
		if err := openWithDefaultApp(pdfAbs); err != nil {
			return screens.PipelinePDFGeneratedMsg{Err: fmt.Sprintf("PDF generated but could not open: %v", err)}
		}
		return screens.PipelinePDFGeneratedMsg{Path: pdfAbs}
	}
}

// summarizeCmdError condenses a failed command into one help-bar-sized line:
// the last non-empty output line when there is one (generate-pdf.mjs prints
// its error there), otherwise the exec error itself.
func summarizeCmdError(err error, out []byte) string {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return err.Error()
}

func (m appModel) View() string {
	switch m.state {
	case viewReport:
		return m.viewer.View()
	case viewProgress:
		return m.progress.View()
	case viewQueue:
		return m.queue.View()
	case viewInbox:
		return m.inbox.View()
	default:
		return m.pipeline.View()
	}
}

func runReviewedQueueItem(worker *applyworker.Client, item model.ApplicationQueueItem) tea.Cmd {
	return func() tea.Msg {
		response, err := worker.Request(item.ID, "run-reviewed", map[string]any{"item": item})
		if err != nil {
			return QueueWorkerResultMsg{ID: item.ID, Err: err.Error()}
		}
		var result workerResult
		if err := json.Unmarshal(response.Result, &result); err != nil {
			return QueueWorkerResultMsg{ID: item.ID, Err: "could not read browser worker response: " + err.Error()}
		}
		return QueueWorkerResultMsg{ID: item.ID, State: result.State, Reason: result.Reason}
	}
}

func verifyQueueSubmission(worker *applyworker.Client, id string) tea.Cmd {
	return func() tea.Msg {
		response, err := worker.Request(id, "verify-submission", map[string]any{})
		if err != nil {
			return QueueWorkerResultMsg{ID: id, Err: err.Error()}
		}
		var result workerResult
		if err := json.Unmarshal(response.Result, &result); err != nil {
			return QueueWorkerResultMsg{ID: id, Err: "could not read receipt verification: " + err.Error()}
		}
		receiptID := "confirmation-page"
		if result.Receipt != nil && result.Receipt.ReceiptID != nil && *result.Receipt.ReceiptID != "" {
			receiptID = *result.Receipt.ReceiptID
		}
		return QueueWorkerResultMsg{ID: id, State: result.State, Reason: result.Reason, ReceiptID: receiptID}
	}
}

// confirmQueueSubmission updates the canonical tracker only after the retained
// worker has found an employer confirmation. The final status write continues
// to use the existing locked CLI path rather than editing applications.md.
func confirmQueueSubmission(careerOpsPath, queueID, receiptID string) error {
	queue, err := data.LoadApplicationQueue(careerOpsPath)
	if err != nil {
		return err
	}
	var item *model.ApplicationQueueItem
	for i := range queue.Items {
		if queue.Items[i].ID == queueID {
			item = &queue.Items[i]
			break
		}
	}
	if item == nil {
		return fmt.Errorf("queue item %q no longer exists", queueID)
	}
	if item.ReportNumber == "" {
		return fmt.Errorf("queue item has no report number")
	}
	status := exec.Command("node", "set-status.mjs", item.ReportNumber, "Applied", "--note", "Application receipt confirmed by local dashboard")
	status.Dir = careerOpsPath
	if output, err := status.CombinedOutput(); err != nil {
		return fmt.Errorf("set Applied status: %s", summarizeCmdError(err, output))
	}
	seed := exec.Command("node", "followup-seed.mjs", item.ReportNumber, "--json")
	seed.Dir = careerOpsPath
	if output, err := seed.CombinedOutput(); err != nil {
		return fmt.Errorf("seed follow-up: %s", summarizeCmdError(err, output))
	}
	_, err = data.ConfirmApplicationQueueSubmission(careerOpsPath, queueID, receiptID, time.Now())
	return err
}

func main() {
	pathFlag := flag.String("path", ".", "Path to career-ops directory")
	langFlag := flag.String("lang", "", "Language for UI (en, tr). Defaults to auto-detect/en.")
	flag.Parse()

	if *langFlag != "" {
		i18n.SetLang(*langFlag)
	} else if os.Getenv("LANG") != "" {
		i18n.SetLang(os.Getenv("LANG"))
	}

	careerOpsPath := *pathFlag

	// Load applications
	apps := data.ParseApplications(careerOpsPath)
	if apps == nil {
		fmt.Fprintf(os.Stderr, "Error: could not find applications.md in %s or %s/data/\n", careerOpsPath, careerOpsPath)
		os.Exit(1)
	}

	// Compute metrics
	metrics := data.ComputeMetrics(apps)
	progressMetrics := data.ComputeProgressMetrics(apps)

	// Batch-load all report summaries
	t := theme.NewTheme("auto")
	pm := screens.NewPipelineModel(t, apps, metrics, careerOpsPath, 120, 40)

	for _, app := range apps {
		if app.ReportPath == "" {
			continue
		}
		archetype, tldr, remote, comp := data.LoadReportSummary(careerOpsPath, app.ReportPath)
		if archetype != "" || tldr != "" || remote != "" || comp != "" {
			pm.EnrichReport(app.ReportPath, archetype, tldr, remote, comp)
		}
	}

	m := appModel{
		pipeline:        pm,
		careerOpsPath:   careerOpsPath,
		theme:           t,
		progressMetrics: progressMetrics,
	}

	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
