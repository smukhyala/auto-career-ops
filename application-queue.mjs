#!/usr/bin/env node

/**
 * application-queue.mjs — create a reviewed, immutable local apply-queue item.
 *
 * This command intentionally does not fill or submit a form. It stages a report
 * plus a human-reviewed answers JSON document for approval in the terminal
 * dashboard. The resulting queue and audit data remain under data/ (user layer).
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createImmutableSnapshot } from './application-queue-core.mjs';

const root = new URL('.', import.meta.url).pathname;
const usage = `Usage:
  node application-queue.mjs add <report#> --answers <reviewed-answers.json> [--material <path>]...
  node application-queue.mjs list

The answers JSON must be an object with an "answers" array. Each answer uses
the browser-worker shape: {"selector":"#field","type":"text","value":"..."}.
It is stored locally in the immutable review snapshot and never committed.`;

const args = process.argv.slice(2);
const command = args.shift();
if (!command || command === '--help' || command === '-h') fail(usage);

const queuePath = join(root, 'data', 'application-queue.json');
function fail(message) { console.error(message); process.exit(1); }
function loadQueue() {
  if (!existsSync(queuePath)) return { version: 1, items: [] };
  try {
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
    if (queue.version !== 1 || !Array.isArray(queue.items)) throw new Error('unsupported queue schema');
    return queue;
  } catch (error) { fail(`Cannot read ${queuePath}: ${error.message}`); }
}
function saveQueue(queue) {
  mkdirSync(join(root, 'data'), { recursive: true });
  const temp = `${queuePath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, queuePath);
}
if (command === 'list') {
  const queue = loadQueue();
  for (const item of queue.items) console.log(`${item.id}\t${item.state}\t${item.company}\t${item.role}`);
  process.exit(0);
}

if (command !== 'add') fail(usage);
const reportNumber = args.shift();
if (!/^\d+$/.test(reportNumber || '')) fail('add requires a numeric report number');
let answersPath = '';
const materials = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--answers') answersPath = args[++i] || '';
  else if (args[i] === '--material') materials.push(args[++i] || '');
  else fail(`Unknown argument: ${args[i]}\n${usage}`);
}
if (!answersPath || !existsSync(answersPath)) fail('--answers must point to an existing reviewed answers JSON file');

const { readdirSync } = await import('node:fs');
const prefix = `${String(reportNumber).padStart(3, '0')}-`;
const reportFile = readdirSync(join(root, 'reports')).find((name) => name.startsWith(prefix) && name.endsWith('.md'));
if (!reportFile) fail(`No report found for #${reportNumber}`);
const reportPath = join('reports', reportFile);
const report = readFileSync(join(root, reportPath), 'utf8');
const title = report.match(/^# Evaluation:\s*(.+?)\s+—\s+(.+)$/m);
const url = report.match(/^\*\*URL:\*\*\s*(https:\/\/\S+)$/m)?.[1];
if (!title || !url) fail(`Report ${reportPath} must include an Evaluation title and HTTPS URL`);
let answerDoc;
try { answerDoc = JSON.parse(readFileSync(answersPath, 'utf8')); } catch (error) { fail(`Invalid answers JSON: ${error.message}`); }
if (!Array.isArray(answerDoc.answers) || answerDoc.answers.length === 0) fail('answers JSON must contain a non-empty answers array');
for (const answer of answerDoc.answers) {
  if (!answer || typeof answer.selector !== 'string' || !answer.selector || /submit|apply now|send application/i.test(`${answer.type || ''} ${answer.label || ''}`)) {
    fail('answers must have selectors and may not contain a submit control');
  }
}
const materialMetadata = materials.filter(Boolean).map((path) => {
  if (!existsSync(path)) fail(`material not found: ${path}`);
  return { name: basename(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
});
const now = new Date().toISOString();
const snapshot = createImmutableSnapshot({
  version: 1,
  report: { number: String(reportNumber).padStart(3, '0'), path: reportPath, company: title[1], role: title[2], url },
  answers: answerDoc.answers,
  materials: materialMetadata,
});
const queue = loadQueue();
if (queue.items.some((item) => item.reportNumber === String(reportNumber).padStart(3, '0') && !['Submitted', 'Rejected', 'Cancelled', 'Expired'].includes(item.state))) {
  fail(`An active queue item already exists for report #${reportNumber}`);
}
const item = {
  id: `apply-${randomUUID()}`,
  reportNumber: String(reportNumber).padStart(3, '0'), company: title[1], role: title[2], url,
  state: 'ReadyForReview',
  snapshot: { hash: snapshot.hash, payload: snapshot.payload, createdAt: now, reportPath, materials: materialMetadata.map((m) => m.name) },
  createdAt: now, updatedAt: now,
};
queue.items.push(item);
saveQueue(queue);
console.log(JSON.stringify({ ok: true, item: { id: item.id, reportNumber: item.reportNumber, state: item.state, snapshotHash: item.snapshot.hash } }));
