#!/usr/bin/env node
/**
 * Compatibility shim for the retired automatic-evaluation intake command.
 *
 * It may refresh discovery data, but it never evaluates a JD, launches a
 * browser, generates a report/PDF, fills a form, or submits an application.
 */
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const root = new URL('.', import.meta.url).pathname;

if (args.has('--scan')) {
  const scan = spawnSync(process.execPath, ['scan.mjs'], { cwd: root, encoding: 'utf8' });
  process.stdout.write(scan.stdout || '');
  process.stderr.write(scan.stderr || '');
  if (scan.status !== 0) process.exit(scan.status || 1);
}

const refresh = spawnSync(process.execPath, ['internship-leads.mjs', 'refresh', '--json'], { cwd: root, encoding: 'utf8' });
process.stdout.write(refresh.stdout || '');
process.stderr.write(refresh.stderr || '');
if (refresh.status !== 0) process.exit(refresh.status || 1);
process.stdout.write('Automatic evaluation intake has been retired. Full JD evaluation is manual after saving a lead.\n');
