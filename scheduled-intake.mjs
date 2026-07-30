#!/usr/bin/env node
/**
 * Local scheduled discovery worker.
 *
 * Daily: scan the unrestricted reverse-ATS universe plus configured direct
 * boards, then refresh the persistent internship lead board. This worker never
 * evaluates a posting or opens an application form.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const root = new URL('.', import.meta.url).pathname;
const logPath = new URL('./data/scheduled-intake.log', import.meta.url);

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: 1, stdout, stderr: `${stderr}\ntimeout after ${Math.round(timeoutMs / 60_000)} minutes` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

async function log(event, result) {
  await mkdir(new URL('./data/', import.meta.url), { recursive: true, mode: 0o700 });
  const summary = `${result.stdout}\n${result.stderr}`.replace(/\s+/g, ' ').trim().slice(0, 700);
  await appendFile(logPath, `${new Date().toISOString()}\t${event}\texit=${result.code}\t${summary}\n`, { mode: 0o600 });
}

// No --limit: unrestricted company coverage is intentional. A partial broad
// scan is still useful, so direct boards and the board refresh always follow.
// Internship recruiting is seasonal: many Summer 2027 postings opened months
// ago, and several ATS vendors omit a trustworthy publish date. Keep a wider
// rolling discovery horizon; scan-history still makes daily runs incremental.
const broad = await run(process.execPath, ['scan-ats-full.mjs', '--since', '120', '--include-undated'], 90 * 60_000);
process.stdout.write(broad.stdout);
process.stderr.write(broad.stderr);
await log('reverse_ats_discovery', broad);

const direct = await run(process.execPath, ['scan.mjs'], 20 * 60_000);
process.stdout.write(direct.stdout);
process.stderr.write(direct.stderr);
await log('direct_board_discovery', direct);

const leads = await run(process.execPath, ['internship-leads.mjs', 'refresh', '--json'], 2 * 60_000);
process.stdout.write(leads.stdout);
process.stderr.write(leads.stderr);
await log('internship_lead_refresh', leads);
process.exitCode = broad.code || direct.code || leads.code;
