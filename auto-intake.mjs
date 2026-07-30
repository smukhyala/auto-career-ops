#!/usr/bin/env node
/**
 * Automatic intake: scan (optional) -> deterministic scope gate -> liveness
 * verification -> up to N bounded headless evaluations. It has no apply or
 * submit primitive; downstream workers receive an explicit evaluation-only
 * instruction and the project-wide submission gate still applies.
 */
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { load } from 'js-yaml';
import { parsePendingRoles, selectAutoIntakeCandidates } from './auto-intake-core.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
const args = new Set(process.argv.slice(2));
const run = args.has('--run');
const scanFirst = args.has('--scan');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));

function runCommand(command, commandArgs, { timeoutMs = 12 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: 1, stdout, stderr: `${stderr}command timed out after ${timeoutMs / 60_000} minutes` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

async function configuredLimit() {
  const profilePath = new URL('./config/profile.yml', import.meta.url);
  if (!existsSync(profilePath)) return 5;
  const profile = load(await readFile(profilePath, 'utf8')) ?? {};
  const configured = Number(profile?.automation?.max_auto_evaluations_per_scan);
  return Number.isInteger(configured) && configured > 0 ? configured : 5;
}

async function preferredCompanies() {
  const portals = load(await readFile(new URL('./portals.yml', import.meta.url), 'utf8')) ?? {};
  return (portals.tracked_companies ?? []).map((company) => company.name).filter(Boolean);
}

async function reportForURL(url) {
  const reportsDir = new URL('./reports/', import.meta.url);
  for (const name of await readdir(reportsDir)) {
    if (!name.endsWith('.md')) continue;
    const contents = await readFile(new URL(`./reports/${name}`, import.meta.url), 'utf8');
    if (contents.includes(`**URL:** ${url}`)) return { name, contents };
  }
  return null;
}

async function reconcileEvaluatedRole(candidate, report) {
  const pipelinePath = new URL('./data/pipeline.md', import.meta.url);
  const lines = (await readFile(pipelinePath, 'utf8')).split(/\r?\n/);
  const pendingIndex = lines.findIndex((line) => line.startsWith(`- [ ] ${candidate.url}`));
  if (pendingIndex < 0) return;
  const score = report.contents.match(/^\*\*Score:\*\*\s*([0-9.]+\/5)/m)?.[1] ?? 'N/A';
  const pdfField = report.contents.match(/^\*\*PDF:\*\*\s*(.+)$/im)?.[1] ?? '';
  const pdf = pdfField && !/not generated/i.test(pdfField) ? '✅' : '❌';
  const reportNumber = report.name.match(/^(\d+)-/)?.[1] ?? '?';
  lines.splice(pendingIndex, 1);
  let processedIndex = lines.findIndex((line) => /^##\s+Processed\s*$/i.test(line));
  if (processedIndex < 0) {
    if (lines.at(-1) !== '') lines.push('');
    lines.push('## Processed', '');
    processedIndex = lines.length - 2;
  }
  const entry = `- [x] [${reportNumber}](../reports/${report.name}) | ${candidate.url} | ${candidate.company} | ${candidate.role} | ${score} | PDF ${pdf}`;
  lines.splice(processedIndex + 1, 0, entry);
  const tempPath = new URL(`./data/pipeline.md.${process.pid}.tmp`, import.meta.url);
  await writeFile(tempPath, `${lines.join('\n').replace(/\n*$/, '\n')}`, { mode: 0o600 });
  await rename(tempPath, pipelinePath);
}

function evaluationPrompt(candidate) {
  return `Run career-ops auto-pipeline for exactly this URL: ${candidate.url}

This is evaluation only. Never apply, autofill, send, or submit anything. The parent process has already run the required liveness gate and received an active verdict for this exact URL; treat that as liveness evidence and do not stop solely because your own sandbox cannot launch a browser. Continue only if the JD confirms either (1) an internship/co-op/fellowship suitable for a currently enrolled undergraduate, or (2) a founding product/engineering role with materially engineering-adjacent scope and a credible student-term, summer, or deferral conversation. Exclude ordinary full-time roles and founding sales, marketing, operations, recruiting, or generic business product roles. If it fails the JD eligibility gate, record an auditable skip without a report, PDF, tracker application, or application queue item. Follow the repository AGENTS.md data contract and evaluate just this role.`;
}

async function log(event) {
  await appendFile(new URL('./data/auto-intake.log', import.meta.url), `${new Date().toISOString()}\t${event}\n`, { mode: 0o600 });
}

async function evaluatorSummaryPath(candidate) {
	const directory = new URL('./data/auto-intake-diagnostics/', import.meta.url);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const safeCompany = candidate.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
	return new URL(`./data/auto-intake-diagnostics/${Date.now()}-${safeCompany}.txt`, import.meta.url);
}

if (scanFirst) {
  const result = await runCommand(process.execPath, ['scan.mjs']);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) process.exit(result.code);
}

const source = await readFile(new URL('./data/pipeline.md', import.meta.url), 'utf8');
const requestedLimit = limitArg ? Number(limitArg.slice('--limit='.length)) : await configuredLimit();
const rankedCandidates = selectAutoIntakeCandidates(parsePendingRoles(source), Number.MAX_SAFE_INTEGER, { preferredCompanies: await preferredCompanies() });
const unevaluatedCandidates = [];
for (const candidate of rankedCandidates) {
  const existingReport = await reportForURL(candidate.url);
  if (existingReport) {
    if (run) await reconcileEvaluatedRole(candidate, existingReport);
    continue;
  }
  unevaluatedCandidates.push(candidate);
}
const candidates = unevaluatedCandidates.slice(0, Math.max(0, requestedLimit));
process.stdout.write(`${JSON.stringify({ mode: run ? 'run' : 'dry-run', selected: candidates.map(({ eligibility, ...role }) => ({ ...role, reason: eligibility.reason })), limit: requestedLimit }, null, 2)}\n`);

if (!run) {
  process.stdout.write('Dry run only. Re-run with --run to verify and evaluate these candidates.\n');
  process.exit(0);
}

for (const candidate of candidates) {
  const liveness = await runCommand(process.execPath, ['check-liveness.mjs', '--no-fallback', candidate.url]);
  if (!/✅\s+active\b/.test(liveness.stdout)) {
    await log(`SKIP_LIVENESS\t${candidate.url}\t${liveness.code === 0 ? 'no_active_verdict' : 'expired_or_uncertain'}`);
    continue;
  }
  const summaryPath = await evaluatorSummaryPath(candidate);
  const evaluation = await runCommand('codex', ['exec', '--output-last-message', summaryPath.pathname, evaluationPrompt(candidate)]);
  const report = evaluation.code === 0 ? await reportForURL(candidate.url) : null;
  const artifactCreated = Boolean(report);
  if (report) await reconcileEvaluatedRole(candidate, report);
  const summary = existsSync(summaryPath) ? (await readFile(summaryPath, 'utf8')).trim().replace(/\s+/g, ' ').slice(0, 240) : 'no_worker_summary';
  await log(`${artifactCreated ? 'EVALUATED' : 'EVALUATION_NO_ARTIFACT'}\t${candidate.url}\t${candidate.company}\t${candidate.role}\t${summary || 'empty_worker_summary'}`);
  process.stdout.write(evaluation.stdout);
  process.stderr.write(evaluation.stderr);
}
