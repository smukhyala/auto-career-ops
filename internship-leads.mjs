#!/usr/bin/env node
/**
 * Persistent internship discovery board. It only manages discovered leads;
 * it never opens a browser, evaluates a JD, fills a form, or submits anything.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { canonicalLeadURL, classifyInternshipEligibility, extractReqID, leadID, LEAD_STAGES, rankInternshipLead, TRACKER_STAGES } from './internship-leads-core.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA = process.env.CAREER_OPS_LEADS || path.join(ROOT, 'data', 'internship-leads.json');
const PIPELINE = process.env.CAREER_OPS_PIPELINE || path.join(ROOT, 'data', 'pipeline.md');
const DETAILS = process.env.CAREER_OPS_SCAN_DETAILS || path.join(ROOT, 'data', 'scan-details.json');
const TRACKER = process.env.CAREER_OPS_TRACKER || path.join(ROOT, 'data', 'applications.md');
const ADDITIONS = process.env.CAREER_OPS_ADDITIONS || path.join(ROOT, 'batch', 'tracker-additions');
const args = process.argv.slice(2);
const command = args[0] || 'list';
const json = args.includes('--json');

function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
function option(name, fallback = '') { const index = args.indexOf(name); return index >= 0 ? (args[index + 1] || fallback) : fallback; }
function writeAtomic(file, value) { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, file); }
function loadStore() { if (!existsSync(DATA)) return { version: 1, leads: [] }; try { const data = JSON.parse(readFileSync(DATA, 'utf8')); return { version: 1, leads: Array.isArray(data.leads) ? data.leads : [] }; } catch { fail(`Unreadable lead store: ${DATA}`); } }
function print(value) { process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`); }
function parsePipeline() {
  if (!existsSync(PIPELINE)) return [];
  let details = {}; try { details = existsSync(DETAILS) ? JSON.parse(readFileSync(DETAILS, 'utf8')) : {}; } catch {}
  return readFileSync(PIPELINE, 'utf8').split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^- \[ \] (https:\/\/\S+) \| ([^|]+) \| ([^|]+)(?: \| ([^|]*))?(.*)$/);
    if (!match) return [];
    const [, url, company, role, location = '', rest = ''] = match;
    const postedAt = rest.match(/\|\s*posted:\s*([^|]+)/i)?.[1]?.trim() || '';
    const detail = details[url] || details[canonicalLeadURL(url)] || {};
    return [{ url, company: company.trim(), role: role.trim(), location: location.trim(), postedAt, source: detail.source || 'pipeline', description: detail.description || '' }];
  });
}
function refresh(store) {
  const byURL = new Map(store.leads.map(lead => [canonicalLeadURL(lead.url), lead]));
  let added = 0, updated = 0, rejected = 0;
  for (const incoming of parsePipeline()) {
    const eligibility = classifyInternshipEligibility(incoming);
    if (!eligibility.eligible) { rejected++; continue; }
    const url = canonicalLeadURL(incoming.url); const rank = rankInternshipLead(incoming); const old = byURL.get(url); const now = new Date().toISOString();
    const next = { id: old?.id || leadID(url), url, company: incoming.company, role: incoming.role, location: incoming.location, postedAt: incoming.postedAt, source: incoming.source, description: incoming.description, reqId: extractReqID(`${incoming.role} ${incoming.description} ${incoming.url}`), relevanceScore: rank.score, rankingReasons: rank.reasons, stage: old?.stage || 'New', firstSeenAt: old?.firstSeenAt || now, lastSeenAt: now, updatedAt: old?.updatedAt || now };
    if (old) { Object.assign(old, next, { stage: old.stage, firstSeenAt: old.firstSeenAt, updatedAt: old.updatedAt }); updated++; } else { store.leads.push(next); byURL.set(url, next); added++; }
  }
  writeAtomic(DATA, store); return { added, updated, rejected, total: store.leads.length };
}
function selector(store, value) {
  const key = String(value || '').trim().toLowerCase();
  const matches = store.leads.filter(lead => lead.id === key || lead.url.toLowerCase() === key || `${lead.company} ${lead.role}`.toLowerCase().includes(key));
  if (matches.length !== 1) fail(matches.length ? `Lead selector is ambiguous: ${matches.map(l => `${l.id} (${l.company} — ${l.role})`).join(', ')}` : `No lead matches: ${value}`);
  return matches[0];
}
function trackerRows() {
  if (!existsSync(TRACKER)) return [];
  return readFileSync(TRACKER, 'utf8').split(/\r?\n/).flatMap(line => {
    if (!line.startsWith('|')) return []; const cells = line.split('|').map(x => x.trim()); if (!/^\d+$/.test(cells[1])) return [];
    return [{ num: cells[1], company: cells[3] || '', role: cells[4] || '', notes: cells.at(-2) || '' }];
  });
}
function norm(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function promote(lead, stage) {
  const existing = trackerRows().find(row => norm(row.company) === norm(lead.company) && norm(row.role) === norm(lead.role) && (!lead.reqId || !extractReqID(row.notes) || extractReqID(row.notes) === lead.reqId));
  const note = `Internship discovery lead; URL: ${lead.url}${lead.reqId ? `; req ${lead.reqId}` : ''}`;
  if (existing) {
    execFileSync(process.execPath, ['set-status.mjs', existing.num, stage, '--note', note], { cwd: ROOT, stdio: 'pipe' });
    return { action: 'updated', trackerNumber: existing.num };
  }
  const max = Math.max(0, ...trackerRows().map(row => Number(row.num)));
  const number = max + 1;
  const additions = ADDITIONS; mkdirSync(additions, { recursive: true });
  const file = path.join(additions, `${String(number).padStart(3, '0')}-internship-lead-${lead.id}.tsv`);
  writeFileSync(file, `${number}\t${new Date().toISOString().slice(0, 10)}\t${lead.company}\t${lead.role}\t${stage}\tN/A\t❌\t\t${note}\n`, { mode: 0o600 });
  execFileSync(process.execPath, ['merge-tracker.mjs'], { cwd: ROOT, stdio: 'pipe' });
  return { action: 'created', trackerNumber: String(number) };
}

const store = loadStore();
if (command === 'refresh') print(refresh(store));
else if (command === 'list') {
  const stage = option('--stage'); const search = option('--search'); const sort = option('--sort', 'score');
  const leads = store.leads.filter(lead => (!stage || lead.stage === stage) && (!search || `${lead.company} ${lead.role} ${lead.location}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => sort === 'company' ? a.company.localeCompare(b.company) : sort === 'posted' ? String(b.postedAt).localeCompare(String(a.postedAt)) : b.relevanceScore - a.relevanceScore || String(b.postedAt).localeCompare(String(a.postedAt)));
  if (json) print(leads); else print(leads.length ? leads.map(l => `${String(l.relevanceScore).padStart(3)}  ${l.stage.padEnd(9)}  ${l.company} — ${l.role} · ${l.location || 'location TBD'} · ${l.url}`).join('\n') : 'No internship leads. Run: node internship-leads.mjs refresh');
} else if (command === 'move' || command === 'archive' || command === 'promote') {
  const lead = selector(store, args[1]); const stage = command === 'archive' ? 'Archived' : args[2];
  if (!LEAD_STAGES.includes(stage)) fail(`Invalid stage. Choose: ${LEAD_STAGES.join(', ')}`);
  let tracker = null; if (TRACKER_STAGES.has(stage)) tracker = promote(lead, stage);
  lead.stage = stage; lead.updatedAt = new Date().toISOString(); writeAtomic(DATA, store); print({ id: lead.id, stage, tracker });
} else fail('Usage: internship-leads.mjs [refresh|list|move <id|url|unique search> <stage>|archive <selector>] [--json]');
