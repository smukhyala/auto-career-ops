#!/usr/bin/env node
/**
 * Build a local, reviewable application-queue item from an evaluated report.
 *
 * This is the bridge between the tracker and the headed worker: it may open an
 * employer's initial application form to inspect fields, but does not fill or
 * submit it. The generated answers are deliberately limited to unambiguous
 * profile fields; everything else remains for the candidate to review.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { ApplyWorker } from './apply-worker-core.mjs';

function stageError(error) {
  const message = String(error?.message || error).replace(/\s+/g, ' ').trim();
  if (/Could not start local Chrome|launchPersistentContext|Target page, context or browser has been closed/i.test(message)) {
    return 'Could not start the local application browser. Quit any stale career-ops browser window, restart the dashboard from your normal macOS Terminal, and retry.';
  }
  return message || 'Unknown application staging error.';
}
process.on('uncaughtException', (error) => {
  process.stderr.write(`Application staging error: ${stageError(error)}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  process.stderr.write(`Application staging error: ${stageError(error)}\n`);
  process.exit(1);
});

const root = new URL('.', import.meta.url).pathname;
const reportNumber = process.argv[2]?.replace(/^0+/, '') || '';
if (!/^\d+$/.test(reportNumber)) fail('Usage: node application-stage.mjs <report-number>');

function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
function normalized(value) { return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function reportFor(number) {
  const prefix = `${number.padStart(3, '0')}-`;
  const name = readdirSync(join(root, 'reports')).find((entry) => entry.startsWith(prefix) && entry.endsWith('.md'));
  if (!name) fail(`No evaluation report found for #${number}.`);
  const text = readFileSync(join(root, 'reports', name), 'utf8');
  const title = text.match(/^# Evaluation:\s*(.+?)\s+—\s+(.+)$/m);
  const url = text.match(/^\*\*URL:\*\*\s*(https:\/\/\S+)$/m)?.[1];
  if (!title || !url) fail(`Report #${number} is missing its title or HTTPS posting URL.`);
  return { number: number.padStart(3, '0'), path: join('reports', name), company: title[1], role: title[2], url };
}
function findResumePDF(report) {
  const tokens = normalized(`${report.company} ${report.role}`).split(' ').filter((word) => word.length > 3);
  const matches = readdirSync(join(root, 'output')).filter((name) => name.endsWith('.pdf'));
  return matches.find((name) => tokens.some((word) => normalized(name).includes(word))) || '';
}
function answerFor(field, profile, resumePath) {
  const key = normalized(`${field.label} ${field.name} ${field.selector}`);
  const text = (value) => value ? { selector: field.selector, label: field.label || field.name, type: 'text', value } : null;
  if (/\bfirst name\b|first name|firstname/.test(key)) return text(profile.candidate?.full_name?.split(/\s+/)[0]);
  if (/\blast name\b|last name|lastname/.test(key)) return text(profile.candidate?.full_name?.split(/\s+/).slice(1).join(' '));
  if (/\b(full )?name\b/.test(key) && !/user.?name/.test(key)) return text(profile.candidate?.full_name);
  if (/e ?mail/.test(key)) return text(profile.candidate?.email);
  if (/phone|mobile/.test(key)) return text(profile.candidate?.phone);
  if (/linkedin/.test(key)) return text(profile.candidate?.linkedin);
  if (/portfolio|website|personal site/.test(key)) return text(profile.candidate?.portfolio_url);
  if ((field.type || '').toLowerCase() === 'file' && /resume|cv/.test(key) && resumePath) {
    return { selector: field.selector, label: field.label || field.name || 'Resume', type: 'file', filePath: resumePath };
  }
  return null;
}

const report = reportFor(reportNumber);
const profile = load(readFileSync(join(root, 'config', 'profile.yml'), 'utf8')) ?? {};
const worker = new ApplyWorker();
let prepared;
try {
  prepared = await worker.prepare({
    applyUrl: report.url,
    expectedCompany: report.company,
    expectedTitle: report.role,
    // Explicit tracker action permits the non-final "Apply"/"Start" control
    // only when needed to reveal a blank employer form. Submit controls are
    // never considered by the worker.
    openApplication: true,
		timeoutMs: 20_000,
  });
} finally {
  await worker.close().catch(() => {});
}
if (!Array.isArray(prepared.fields) || prepared.fields.length === 0) {
  fail('Could not find fillable fields. The employer may require login, CAPTCHA, or a manual initial Apply step; open the posting and retry after the form is visible.');
}

const resumeName = findResumePDF(report);
const resumePath = resumeName ? resolve(root, 'output', resumeName) : '';
const answers = prepared.fields.map((field) => answerFor(field, profile, resumePath)).filter(Boolean);
if (answers.length === 0) fail('The form has no safely mappable profile fields. Open the posting and complete it manually.');

const drafts = join(root, 'data', 'application-drafts');
mkdirSync(drafts, { recursive: true, mode: 0o700 });
const answersPath = join(drafts, `${report.number}-review.json`);
writeFileSync(answersPath, `${JSON.stringify({ answers }, null, 2)}\n`, { mode: 0o600 });
const args = ['application-queue.mjs', 'add', report.number, '--answers', answersPath];
if (resumePath) args.push('--material', resumePath);
const queued = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
if (queued.status !== 0) fail(queued.stderr.trim() || queued.stdout.trim() || 'Could not create application queue item.');
const item = JSON.parse(queued.stdout);
process.stdout.write(`${JSON.stringify({ ok: true, report: report.number, queueItem: item.item.id, answers: answers.length, resumeAttached: Boolean(resumePath), note: resumePath ? 'Review the exact answers and attachment, then approve from the queue.' : 'No tailored PDF was found; the packet fills supported profile fields, but attach a resume manually before submitting.' })}\n`);
