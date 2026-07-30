import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplyWorker, detectAts } from '../apply-worker-core.mjs';
import { createApproval, createImmutableSnapshot } from '../application-queue-core.mjs';

function pageMock({ text = 'Application form', url = 'https://boards.greenhouse.io/example/jobs/123' } = {}) {
  const calls = [];
  return {
    calls,
    async goto(...args) { calls.push(['goto', ...args]); }, url: () => url,
    async evaluate() { return undefined; }, // mocked page has no DOM
    async fill(...args) { calls.push(['fill', ...args]); },
    async check(...args) { calls.push(['check', ...args]); },
    async uncheck(...args) { calls.push(['uncheck', ...args]); },
    async selectOption(...args) { calls.push(['selectOption', ...args]); },
    async setInputFiles(...args) { calls.push(['setInputFiles', ...args]); },
    async bringToFront() { calls.push(['bringToFront']); },
  };
}

function workerFor(page) {
  return new ApplyWorker({ browserFactory: async () => ({ page, close: async () => page.calls.push(['close']) }) });
}

test('recognizes the four supported ATS providers and rejects arbitrary hosts', () => {
  assert.equal(detectAts('https://boards.greenhouse.io/acme/jobs/1'), 'greenhouse');
  assert.equal(detectAts('https://jobs.ashbyhq.com/acme/abc'), 'ashby');
  assert.equal(detectAts('https://jobs.lever.co/acme/id'), 'lever');
  assert.equal(detectAts('https://acme.myworkdayjobs.com/en-US/job/x'), 'workday');
  assert.equal(detectAts('https://example.com/apply'), null);
});

test('fills reviewed fields but rejects every submission control', async () => {
  const page = pageMock();
  const result = await workerFor(page).dispatch({ command: 'fill', payload: {
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/123', answers: [
      { selector: '#name', type: 'text', value: 'Candidate' },
      { selector: '#submit', type: 'submit', value: 'ignored' },
    ],
  } });
  assert.deepEqual(page.calls.filter(([name]) => name === 'fill'), [['fill', '#name', 'Candidate']]);
  assert.equal(result.results[1].reason, 'submission_controls_are_user_only');
  assert.equal(page.calls.some(([name]) => name === 'click'), false);
});

test('handoff only foregrounds the prepared application', async () => {
  const page = pageMock();
  const result = await workerFor(page).dispatch({ command: 'handoff', payload: { applyUrl: 'https://jobs.lever.co/acme/abc' } });
  assert.equal(result.status, 'ready_for_user_submit');
  assert.deepEqual(page.calls.filter(([name]) => name === 'bringToFront'), [['bringToFront']]);
  assert.equal(page.calls.some(([name]) => name === 'click' || name === 'press'), false);
});

test('prepare, fill, and handoff retain one visible page without a reload', async () => {
  const page = pageMock();
  const worker = workerFor(page);
  const payload = { applyUrl: 'https://boards.greenhouse.io/acme/jobs/123' };
  await worker.dispatch({ command: 'prepare', payload });
  await worker.dispatch({ command: 'fill', payload: { ...payload, answers: [{ selector: '#name', type: 'text', value: 'Candidate' }] } });
  await worker.dispatch({ command: 'handoff', payload });
  assert.equal(page.calls.filter(([name]) => name === 'goto').length, 1);
  assert.deepEqual(page.calls.filter(([name]) => name === 'fill'), [['fill', '#name', 'Candidate']]);
});

test('accepts a persisted queue item and emits dashboard state names', async () => {
  const page = pageMock();
  const result = await workerFor(page).dispatch({ command: 'preflight', payload: { item: {
    id: 'queue-1', reportNumber: 42, company: 'Acme', role: 'Intern',
    url: 'https://boards.greenhouse.io/acme/jobs/123', state: 'Approved',
    snapshot: { hash: 'abc' }, approval: { expiresAt: '2099-01-01T00:00:00Z' },
  } } });
  assert.equal(result.state, 'ReadyForReview');
});

test('fill fails closed when a persisted approval is expired', async () => {
  const page = pageMock();
  const snapshot = createImmutableSnapshot({ jobId: '123', url: 'https://boards.greenhouse.io/acme/jobs/123' });
  const approval = createApproval(snapshot, { id: 'approval-1', now: '2026-01-01T12:00:00.000Z', ttlMs: 1 });
  const result = await workerFor(page).dispatch({ command: 'fill', payload: {
    item: { id: 'queue-1', url: 'https://boards.greenhouse.io/acme/jobs/123', snapshot, approval },
    now: '2026-01-01T12:00:01.000Z', answers: [{ selector: '#name', type: 'text', value: 'Candidate' }],
  } });
  assert.equal(result.state, 'NeedsUserAction');
  assert.equal(result.reason, 'approval-expired');
  assert.equal(page.calls.length, 0);
});

test('handoff fails closed when a persisted snapshot was changed after approval', async () => {
  const page = pageMock();
  const snapshot = createImmutableSnapshot({ jobId: '123', url: 'https://boards.greenhouse.io/acme/jobs/123' });
  const approval = createApproval(snapshot, { id: 'approval-1', now: '2099-01-01T12:00:00.000Z' });
  const tampered = { hash: snapshot.hash, payload: { ...snapshot.payload, jobId: '124' } };
  const result = await workerFor(page).dispatch({ command: 'handoff', payload: {
    item: { id: 'queue-1', url: 'https://boards.greenhouse.io/acme/jobs/123', snapshot: tampered, approval },
  } });
  assert.equal(result.state, 'NeedsUserAction');
  assert.equal(result.reason, 'snapshot-tampered');
  assert.equal(page.calls.length, 0);
});

test('fill honors a valid immutable queue approval', async () => {
  const page = pageMock();
  const snapshot = createImmutableSnapshot({ jobId: '123', url: 'https://boards.greenhouse.io/acme/jobs/123' });
  const approval = createApproval(snapshot, { id: 'approval-1', now: '2099-01-01T12:00:00.000Z' });
  const result = await workerFor(page).dispatch({ command: 'fill', payload: {
    item: { id: 'queue-1', url: 'https://boards.greenhouse.io/acme/jobs/123', snapshot, approval },
    answers: [{ selector: '#name', type: 'text', value: 'Candidate' }],
  } });
  assert.equal(result.state, 'Preparing');
  assert.deepEqual(page.calls.filter(([name]) => name === 'fill'), [['fill', '#name', 'Candidate']]);
});

test('run-reviewed fills the immutable answer snapshot and stops at visible handoff', async () => {
  const page = pageMock();
  const snapshot = createImmutableSnapshot({
    url: 'https://boards.greenhouse.io/acme/jobs/123',
    answers: [{ selector: '#name', type: 'text', value: 'Candidate' }],
  });
  const approval = createApproval(snapshot, { id: 'approval-run', now: '2099-01-01T12:00:00.000Z' });
  const result = await workerFor(page).dispatch({ command: 'run-reviewed', payload: {
    item: { url: 'https://boards.greenhouse.io/acme/jobs/123', snapshot, approval },
  } });
  assert.equal(result.state, 'ReadyForUserSubmit');
  assert.deepEqual(page.calls.filter(([name]) => name === 'fill'), [['fill', '#name', 'Candidate']]);
  assert.deepEqual(page.calls.filter(([name]) => name === 'bringToFront'), [['bringToFront']]);
  assert.equal(page.calls.some(([name]) => name === 'click'), false);
});

test('close releases the local context and unknown commands fail closed', async () => {
  const page = pageMock(); const worker = workerFor(page);
  await worker.dispatch({ command: 'prepare', payload: { applyUrl: 'https://jobs.ashbyhq.com/acme/123' } });
  assert.equal((await worker.dispatch({ command: 'close' })).status, 'closed');
  assert.deepEqual(page.calls.filter(([name]) => name === 'close'), [['close']]);
  await assert.rejects(() => worker.dispatch({ command: 'submit' }), /unknown command/);
});
