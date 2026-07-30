/**
 * application-queue-core.mjs
 *
 * Small, dependency-free safety primitives shared by the local application
 * queue, dashboard and browser worker.  This module deliberately knows
 * nothing about a specific ATS or persistence layer: it makes queue decisions
 * deterministic and gives those callers a safe, redacted audit representation.
 *
 * A queue item persists snapshots as `{ snapshot: { hash, payload } }` and an
 * approval as `{ approval: { id, snapshotHash, createdAt, expiresAt } }`.
 * Never put answers, cookies, tokens, or raw browser data in an audit event.
 */

import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000;

export const APPLICATION_QUEUE_STATES = Object.freeze([
  'Drafted',
  'ReadyForReview',
  'Approved',
  'Preparing',
  'ReadyForUserSubmit',
  'Submitted',
  'NeedsUserAction',
  'Failed',
  'Expired',
  'ApprovalExpired',
  'Rejected',
  'Cancelled',
]);

const TERMINAL_STATES = new Set(['Submitted', 'Expired', 'Rejected', 'Cancelled']);
const TRANSITIONS = Object.freeze({
  Drafted: new Set(['ReadyForReview', 'Failed', 'Rejected', 'Cancelled']),
  ReadyForReview: new Set(['Approved', 'NeedsUserAction', 'Failed', 'Expired', 'Rejected', 'Cancelled']),
  Approved: new Set(['Preparing', 'NeedsUserAction', 'Failed', 'ApprovalExpired', 'Cancelled']),
  Preparing: new Set(['ReadyForUserSubmit', 'NeedsUserAction', 'Failed', 'ApprovalExpired', 'Cancelled']),
  ReadyForUserSubmit: new Set(['Submitted', 'NeedsUserAction', 'Failed', 'ApprovalExpired', 'Cancelled']),
  NeedsUserAction: new Set(['ReadyForReview', 'Preparing', 'Failed', 'Expired', 'Rejected', 'Cancelled']),
  Failed: new Set(['ReadyForReview', 'Preparing', 'NeedsUserAction', 'Expired', 'Rejected', 'Cancelled']),
  ApprovalExpired: new Set(['ReadyForReview', 'Rejected', 'Cancelled']),
  Submitted: new Set(),
  Expired: new Set(),
  Rejected: new Set(),
  Cancelled: new Set(),
});

const OMIT = Symbol('omit');
// Deliberately broad: audit records can retain workflow metadata, but never
// applicant identity, authentication, compensation, or EEO information. This
// catches both snake_case and common camelCase keys (for example accessToken).
const SENSITIVE_KEY = /(password|passcode|token|secret|cookie|authorization|auth|api[_-]?key|session|ssn|social[_-]?security|date[_-]?of[_-]?birth|dob|birthdate|email|phone|mobile|address|street|postal|zip|salary|compensation|race|ethnicity|gender|disability|veteran|full[_-]?name)/i;
const SENSITIVE_VALUE = /(?:bearer\s+|basic\s+|password\s*[:=]|(?:api[_ -]?key|token|secret)\s*[:=])/i;

export class ApplicationQueueSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApplicationQueueSafetyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApplicationQueueSafetyError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// This is JSON-compatible canonicalization: object keys sort recursively;
// undefined object properties are omitted and undefined array cells become null.
function canonicalValue(value, seen = new WeakSet(), inArray = false) {
  if (value === undefined) return inArray ? null : OMIT;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid-snapshot', 'snapshot contains a non-finite number');
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail('invalid-snapshot', 'snapshot contains an invalid date');
    return value.toISOString();
  }
  if (typeof value !== 'object' || !isPlainObject(value) && !Array.isArray(value)) {
    fail('invalid-snapshot', `snapshot contains unsupported value type: ${typeof value}`);
  }
  if (seen.has(value)) fail('invalid-snapshot', 'snapshot cannot contain circular data');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => canonicalValue(entry, seen, true));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = canonicalValue(value[key], seen, false);
      if (normalized !== OMIT) result[key] = normalized;
    }
  }
  seen.delete(value);
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function iso(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('invalid-time', `${field} must be a valid date`);
  return date.toISOString();
}

/** Return the deterministic SHA-256 of a JSON-compatible snapshot payload. */
export function hashSnapshotPayload(payload) {
  const canonical = canonicalValue(payload);
  if (canonical === OMIT) fail('invalid-snapshot', 'snapshot payload is required');
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Build an immutable, self-verifying snapshot for a reviewed application. */
export function createImmutableSnapshot(payload) {
  const normalized = canonicalValue(payload);
  if (normalized === OMIT) fail('invalid-snapshot', 'snapshot payload is required');
  const snapshot = { hash: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'), payload: normalized };
  return deepFreeze(snapshot);
}

/** Validate an on-disk snapshot before using an approval tied to it. */
export function validateImmutableSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || typeof snapshot.hash !== 'string' || !Object.hasOwn(snapshot, 'payload')) {
    return { valid: false, reason: 'malformed-snapshot' };
  }
  if (!/^[a-f0-9]{64}$/i.test(snapshot.hash)) return { valid: false, reason: 'malformed-hash' };
  try {
    const actualHash = hashSnapshotPayload(snapshot.payload);
    return actualHash === snapshot.hash
      ? { valid: true, hash: actualHash }
      : { valid: false, reason: 'snapshot-tampered', expectedHash: snapshot.hash, actualHash };
  } catch (error) {
    return { valid: false, reason: error.code || 'invalid-snapshot' };
  }
}

/** Create a single-use, time-bound approval for exactly one snapshot. */
export function createApproval(snapshot, { now = new Date(), ttlMs = DEFAULT_APPROVAL_TTL_MS, id = randomUUID() } = {}) {
  const checked = validateImmutableSnapshot(snapshot);
  if (!checked.valid) fail(checked.reason, 'cannot approve an invalid application snapshot');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) fail('invalid-approval-ttl', 'approval TTL must be a positive finite number');
  const createdAt = new Date(iso(now, 'now'));
  const expiresAt = new Date(createdAt.getTime() + ttlMs);
  return deepFreeze({ id: String(id), snapshotHash: checked.hash, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() });
}

/**
 * Check approval integrity and expiry. The caller must call this immediately
 * before filling; a false result must stop the worker rather than retrying.
 */
export function verifyApproval(approval, snapshot, { now = new Date() } = {}) {
  if (!isPlainObject(approval) || typeof approval.id !== 'string' || !approval.id || typeof approval.snapshotHash !== 'string') {
    return { valid: false, reason: 'malformed-approval' };
  }
  const checked = validateImmutableSnapshot(snapshot);
  if (!checked.valid) return { valid: false, reason: checked.reason };
  if (approval.snapshotHash !== checked.hash) {
    return { valid: false, reason: 'approval-invalidated', approvedHash: approval.snapshotHash, currentHash: checked.hash };
  }
  let expiresAt;
  let current;
  try {
    expiresAt = new Date(iso(approval.expiresAt, 'approval.expiresAt'));
    current = new Date(iso(now, 'now'));
  } catch (error) {
    return { valid: false, reason: error.code || 'malformed-approval' };
  }
  if (current.getTime() >= expiresAt.getTime()) return { valid: false, reason: 'approval-expired', expiresAt: expiresAt.toISOString() };
  return { valid: true, snapshotHash: checked.hash, expiresAt: expiresAt.toISOString() };
}

export function canTransition(from, to) {
  return APPLICATION_QUEUE_STATES.includes(from) && APPLICATION_QUEUE_STATES.includes(to) && TRANSITIONS[from].has(to);
}

export function assertQueueTransition(from, to) {
  if (!APPLICATION_QUEUE_STATES.includes(from)) fail('unknown-state', `unknown queue state: ${String(from)}`);
  if (!APPLICATION_QUEUE_STATES.includes(to)) fail('unknown-state', `unknown queue state: ${String(to)}`);
  if (!TRANSITIONS[from].has(to)) fail('invalid-transition', `queue transition ${from} → ${to} is not allowed`);
  return true;
}

/** Return a new item only after validating its state transition; never mutate caller input. */
export function transitionQueueItem(item, nextState, { now = new Date(), reason } = {}) {
  if (!isPlainObject(item)) fail('invalid-item', 'queue item must be an object');
  assertQueueTransition(item.state, nextState);
  const at = iso(now, 'now');
  const updated = { ...item, state: nextState, updatedAt: at };
  if (reason !== undefined) updated.stateReason = String(reason);
  return updated;
}

export function isTerminalQueueState(state) {
  return TERMINAL_STATES.has(state);
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    return url.toString();
  } catch { return value; }
}

/**
 * Produce a safe audit copy. Keyed PII/secrets and credential-looking values
 * are redacted recursively; URL query credentials are stripped as well.
 */
export function redactAuditData(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    // A job URL may legitimately contain a query parameter called token. Keep
    // the posting identity while redacting that parameter instead of treating
    // the whole URL as a credential-bearing free-form string.
    if (/(?:^|[_-])url$/i.test(key)) return redactUrl(value);
    if (SENSITIVE_VALUE.test(value)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactAuditData(entry));
  if (isPlainObject(value)) {
    const result = {};
    for (const [childKey, child] of Object.entries(value)) result[childKey] = redactAuditData(child, childKey);
    return result;
  }
  return value;
}

/** Build a timestamped, redacted event suitable for an append-only audit log. */
export function createAuditEvent(type, details = {}, { now = new Date() } = {}) {
  if (!type || typeof type !== 'string') fail('invalid-audit-event', 'audit event type is required');
  return deepFreeze({ at: iso(now, 'now'), type, details: redactAuditData(details) });
}
