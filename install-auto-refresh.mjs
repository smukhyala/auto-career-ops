#!/usr/bin/env node
/** Install the local macOS launchd worker for scheduled role discovery. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

if (process.platform !== 'darwin') {
  throw new Error('install-auto-refresh.mjs currently supports macOS launchd only. Run scheduled-intake.mjs from your platform scheduler instead.');
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const home = process.env.HOME;
if (!home) throw new Error('HOME is unavailable; cannot locate ~/Library/LaunchAgents.');
const label = 'io.career-ops.intake';
const uid = String(process.getuid());
const launchAgents = path.join(home, 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgents, `${label}.plist`);
const logPath = path.join(root, 'data', 'scheduled-intake-launchd.log');

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(root, 'scheduled-intake.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/Users/sanjay/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>8</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`;

mkdirSync(launchAgents, { recursive: true, mode: 0o755 });
writeFileSync(plistPath, plist, { mode: 0o644 });

// Reloading makes the action idempotent: it updates an earlier version of the
// worker without leaving two schedulers running. A missing prior job is normal.
try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch {}
execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' });
console.log(JSON.stringify({ installed: true, label, plistPath, schedule: 'daily 08:30 local; unrestricted reverse-ATS and direct-board discovery', runAtLoad: true }, null, 2));
