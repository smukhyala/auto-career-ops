// Package applyworker owns the long-lived local Node/Playwright process used
// for an approved application handoff. It intentionally exposes no submit
// method: the only browser actions are preflight, fill, handoff, and receipt
// inspection after the candidate's own visible click.
package applyworker

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"sync"
)

type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Scanner
	mu     sync.Mutex
}

type Response struct {
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// Start launches the local JSONL worker in the career-ops checkout. The
// process must remain alive across handoff and receipt verification so the
// browser form is never recreated or accidentally discarded.
func Start(careerOpsPath string) (*Client, error) {
	cmd := exec.Command("node", "apply-worker.mjs")
	cmd.Dir = careerOpsPath
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("open application worker stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open application worker stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start application worker: %w", err)
	}
	return &Client{cmd: cmd, stdin: stdin, stdout: bufio.NewScanner(stdout)}, nil
}

func (c *Client) Request(id, command string, payload any) (Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	request, err := json.Marshal(map[string]any{"id": id, "command": command, "payload": payload})
	if err != nil {
		return Response{}, fmt.Errorf("encode worker request: %w", err)
	}
	if _, err := c.stdin.Write(append(request, '\n')); err != nil {
		return Response{}, fmt.Errorf("write worker request: %w", err)
	}
	if !c.stdout.Scan() {
		return Response{}, fmt.Errorf("application worker exited without a response")
	}
	var response Response
	if err := json.Unmarshal(c.stdout.Bytes(), &response); err != nil {
		return Response{}, fmt.Errorf("decode worker response: %w", err)
	}
	if !response.OK {
		return response, fmt.Errorf("application worker: %s", response.Error)
	}
	return response, nil
}

func (c *Client) Close() error {
	if c == nil || c.cmd == nil {
		return nil
	}
	_, _ = c.Request("close", "close", map[string]any{})
	_ = c.stdin.Close()
	err := c.cmd.Wait()
	c.cmd = nil
	return err
}

// WorkerPath is retained for tests and diagnostics without exposing a shell
// command or accepting a user-controlled path.
func WorkerPath(careerOpsPath string) string { return filepath.Join(careerOpsPath, "apply-worker.mjs") }
