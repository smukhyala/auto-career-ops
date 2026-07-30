/** Pure helpers for the high-volume, no-LLM internship discovery board. */
import { createHash } from 'node:crypto';

export const LEAD_STAGES = ['New', 'Saved', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Archived'];
export const TRACKER_STAGES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected']);

// The closing word boundary is important: without it, "Internal" and
// "International" look like internship signals and poison a high-recall scan.
const INTERN_SIGNAL = /\b(intern(?:ship)?\b|co[ -]?op\b|fellow(?:ship)?\b|student(?:\s+program|\s+researcher|\s+developer)?)\b/i;
const TECHNICAL_SIGNAL = /\b(software|swe\b|engineer(?:ing)?|developer|machine learning|\bml\b|\bai\b|artificial intelligence|data|product|platform|infrastructure|systems?|robotics?|autonomy|research|full[ -]?stack|backend|frontend)\b/i;
const SENIOR_OR_NONTECH = /\b(senior|staff|principal|director|vice president|\bvp\b|head of|chief|manager|recruit(?:er|ing)?|sales|marketing|operations|human resources|account executive|customer success)\b/i;
const FULL_TIME_ONLY = /\b(full[ -]?time|new grad|graduate program|entry[ -]?level)\b/i;

export function canonicalLeadURL(value) {
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gh_src|source|ref)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value ?? '').trim();
  }
}

export function leadID(url) {
  return createHash('sha256').update(canonicalLeadURL(url)).digest('hex').slice(0, 16);
}

/** A lead must be a technical internship/co-op/fellowship/student program. */
export function classifyInternshipEligibility(role) {
  const title = String(role?.role ?? role?.title ?? '');
  if (!INTERN_SIGNAL.test(title)) return { eligible: false, reason: 'missing_internship_signal' };
  if (SENIOR_OR_NONTECH.test(title)) return { eligible: false, reason: 'senior_or_nontechnical_title' };
  if (!TECHNICAL_SIGNAL.test(title)) return { eligible: false, reason: 'not_technical_or_product_title' };
  // A title such as "Full-time Software Engineer" is already rejected by the
  // missing internship signal. Explicit internships remain valid even if they
  // describe their schedule as full time.
  return { eligible: true, kind: 'internship', reason: FULL_TIME_ONLY.test(title) ? 'explicit_internship_schedule' : 'technical_internship_title' };
}

function recencyPoints(postedAt, now = new Date()) {
  const time = Date.parse(postedAt || '');
  if (!Number.isFinite(time)) return 1;
  const days = Math.max(0, (now.getTime() - time) / 86_400_000);
  if (days <= 3) return 12;
  if (days <= 7) return 9;
  if (days <= 14) return 6;
  if (days <= 30) return 3;
  return 0;
}

function locationPoints(location) {
  const value = String(location || '').toLowerCase();
  if (/san francisco|bay area|new york/.test(value)) return [12, 'preferred location'];
  if (/remote/.test(value) && /united states|\bu\.s\.?\b|\busa\b/.test(value)) return [10, 'remote US'];
  if (/remote/.test(value)) return [7, 'remote (confirm US eligibility)'];
  if (/united states|\bu\.s\.?\b|\busa\b|california|new york|austin|seattle|boston|chicago/.test(value)) return [7, 'US location'];
  return [0, 'location needs confirmation'];
}

export function rankInternshipLead(lead, now = new Date()) {
  const eligibility = classifyInternshipEligibility(lead);
  if (!eligibility.eligible) return { score: 0, reasons: [eligibility.reason], eligibility };
  const title = String(lead.role ?? lead.title ?? '').toLowerCase();
  const reasons = ['technical internship eligibility'];
  let score = 45;
  if (/agent|llm|generative ai|machine learning|\bai\b|artificial intelligence|retrieval|rag|evaluation/.test(title)) {
    score += 28; reasons.push('applied AI / ML alignment');
  } else if (/software|\bswe\b|full[ -]?stack|backend|frontend|platform|infrastructure|systems?/.test(title)) {
    score += 22; reasons.push('software engineering alignment');
  } else if (/product/.test(title)) {
    score += 20; reasons.push('technical product alignment');
  } else if (/robotics?|autonomy/.test(title)) {
    score += 20; reasons.push('robotics / autonomy interest');
  } else if (/data|research/.test(title)) {
    score += 14; reasons.push('technical data / research alignment');
  }
  const [location, locationReason] = locationPoints(lead.location);
  score += location;
  reasons.push(locationReason);
  const recency = recencyPoints(lead.postedAt, now);
  score += recency;
  if (recency >= 9) reasons.push('recent posting');
  return { score: Math.min(100, score), reasons, eligibility };
}

export function extractReqID(value) {
  const found = String(value ?? '').match(/\b(?:job\s*id|posting\s*id|requisition|req|jr|job|posting|ref(?:erence)?|r_)[\s:#_-]*([a-z][a-z0-9-]*\d[a-z0-9-]*|\d[a-z0-9-]*)\b/i);
  return found ? found[1].toUpperCase() : '';
}
