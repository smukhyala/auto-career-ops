#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyInternshipEligibility, rankInternshipLead } from '../internship-leads-core.mjs';

assert.equal(classifyInternshipEligibility({ role: 'Software Engineering Intern' }).eligible, true);
assert.equal(classifyInternshipEligibility({ role: 'ML Research Fellow' }).eligible, true);
assert.equal(classifyInternshipEligibility({ role: 'International Product Manager' }).eligible, false);
assert.equal(classifyInternshipEligibility({ role: 'Founding Engineer' }).eligible, false);
assert.equal(classifyInternshipEligibility({ role: 'Senior Software Engineer Intern' }).eligible, false);
assert.equal(classifyInternshipEligibility({ role: 'Software Engineer' }).eligible, false);

const strong = rankInternshipLead({ role: 'Applied AI / Machine Learning Intern', location: 'San Francisco, CA', postedAt: new Date().toISOString() }).score;
const weak = rankInternshipLead({ role: 'Data Research Intern', location: 'Remote', postedAt: '2020-01-01' }).score;
assert.ok(strong > weak, `${strong} should outrank ${weak}`);

const dir = mkdtempSync(join(tmpdir(), 'career-ops-leads-'));
const pipeline = join(dir, 'pipeline.md'); const store = join(dir, 'leads.json'); const tracker = join(dir, 'applications.md'); const additions = join(dir, 'additions');
writeFileSync(pipeline, '# Pipeline\n\n## Pending\n- [ ] https://jobs.example.test/42?utm_source=test | Acme | Applied AI Intern | San Francisco, CA | posted: 2026-07-29\n- [ ] https://jobs.example.test/43 | Acme | Founding Engineer | San Francisco, CA\n');
writeFileSync(tracker, '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
const env = { ...process.env, CAREER_OPS_PIPELINE: pipeline, CAREER_OPS_LEADS: store, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: additions, CAREER_OPS_SCAN_DETAILS: join(dir, 'details.json') };
const run = (...args) => execFileSync(process.execPath, ['internship-leads.mjs', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
const refreshed = JSON.parse(run('refresh', '--json'));
assert.equal(refreshed.added, 1);
const leads = JSON.parse(run('list', '--json'));
assert.equal(leads.length, 1);
run('move', leads[0].id, 'Applied', '--json');
assert.match(readFileSync(tracker, 'utf8'), /\| N\/A \| Applied \|/);
assert.match(readFileSync(tracker, 'utf8'), /https:\/\/jobs\.example\.test\/42/);
run('move', leads[0].id, 'Responded', '--json');
assert.match(readFileSync(tracker, 'utf8'), /\| N\/A \| Responded \|/);
const moved = JSON.parse(run('list', '--json'));
assert.equal(moved[0].stage, 'Responded');
console.log('internship-leads tests passed');
