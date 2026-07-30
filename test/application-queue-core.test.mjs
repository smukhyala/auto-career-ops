import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApplicationQueueSafetyError,
  canTransition,
  createApproval,
  createAuditEvent,
  createImmutableSnapshot,
  hashSnapshotPayload,
  isTerminalQueueState,
  redactAuditData,
  transitionQueueItem,
  validateImmutableSnapshot,
  verifyApproval,
} from '../application-queue-core.mjs';

test('snapshots hash deterministically and are immutable', () => {
  const first = createImmutableSnapshot({ role: 'Intern', answers: { name: 'Ada', location: 'Remote' }, ids: [7, 8] });
  const second = createImmutableSnapshot({ ids: [7, 8], answers: { location: 'Remote', name: 'Ada' }, role: 'Intern' });
  assert.equal(first.hash, second.hash);
  assert.equal(first.hash, hashSnapshotPayload(first.payload));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.payload.answers), true);
  assert.throws(() => { first.payload.role = 'Changed'; }, TypeError);
  assert.deepEqual(validateImmutableSnapshot(first), { valid: true, hash: first.hash });
});

test('snapshot tampering invalidates an approval even before its deadline', () => {
  const snapshot = createImmutableSnapshot({ jobId: '42', url: 'https://jobs.example/42', answers: { workAuthorization: 'Yes' } });
  const approval = createApproval(snapshot, { id: 'approve-42', now: '2026-01-01T12:00:00.000Z' });
  const changed = { hash: snapshot.hash, payload: { ...snapshot.payload, jobId: '43' } };
  const result = verifyApproval(approval, changed, { now: '2026-01-01T12:01:00.000Z' });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'snapshot-tampered');
});

test('approval expires at the precise expiry boundary', () => {
  const snapshot = createImmutableSnapshot({ jobId: '42' });
  const approval = createApproval(snapshot, { id: 'approve-42', now: '2026-01-01T12:00:00.000Z', ttlMs: 1000 });
  assert.equal(verifyApproval(approval, snapshot, { now: '2026-01-01T12:00:00.999Z' }).valid, true);
  const expired = verifyApproval(approval, snapshot, { now: '2026-01-01T12:00:01.000Z' });
  assert.deepEqual(expired, { valid: false, reason: 'approval-expired', expiresAt: '2026-01-01T12:00:01.000Z' });
});

test('queue transitions are explicit and immutable', () => {
  assert.equal(canTransition('ReadyForReview', 'Approved'), true);
  assert.equal(canTransition('ReadyForUserSubmit', 'Preparing'), false);
  assert.equal(isTerminalQueueState('Submitted'), true);
  const original = { id: 'q1', state: 'ReadyForReview' };
  const updated = transitionQueueItem(original, 'Approved', { now: '2026-01-01T12:00:00.000Z', reason: 'user approved' });
  assert.deepEqual(updated, { id: 'q1', state: 'Approved', updatedAt: '2026-01-01T12:00:00.000Z', stateReason: 'user approved' });
  assert.deepEqual(original, { id: 'q1', state: 'ReadyForReview' });
  assert.throws(() => transitionQueueItem(updated, 'Submitted'), (error) => error instanceof ApplicationQueueSafetyError && error.code === 'invalid-transition');
});

test('audit data redacts applicant PII, credentials, and sensitive URL parameters', () => {
  const details = {
    queueId: 'q1', snapshotHash: 'a'.repeat(64),
    email: 'ada@example.com', nested: { phone: '+1 555 0100', authorization: 'Bearer abc', accessToken: 'not-for-audit' },
    url: 'https://jobs.example/apply?job=42&token=secret-token',
    safe: 'screening complete',
  };
  const redacted = redactAuditData(details);
  assert.deepEqual(redacted, {
    queueId: 'q1', snapshotHash: 'a'.repeat(64),
    email: '[REDACTED]', nested: { phone: '[REDACTED]', authorization: '[REDACTED]', accessToken: '[REDACTED]' },
    url: 'https://jobs.example/apply?job=42&token=%5BREDACTED%5D', safe: 'screening complete',
  });
  const event = createAuditEvent('approval-created', details, { now: '2026-01-01T12:00:00.000Z' });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(event.details.email, '[REDACTED]');
});
