/** Deterministic, zero-token gate for automatic evaluation intake. */

const INTERN_RE = /\b(intern(?:ship)?|co[ -]?op|fellow(?:ship)?)\b/i;
const INTERN_ADJACENT_RE = /\b(engineer(?:ing)?|software|developer|product|platform|technical|ai|ml|machine learning|data|infrastructure|systems?|robotics?|autonomy|research)\b/i;
const FOUNDING_RE = /\bfounding\b/i;
const FOUNDING_ADJACENT_RE = /\b(engineer(?:ing)?|software|developer|product|platform|technical|ai|ml|machine learning|data|infrastructure|systems?)\b/i;
const EXCLUDED_RE = /\b(senior|staff|principal|director|vice president|vp\.?|head of|chief|manager|sales|marketing|operations|recruit(?:er|ing)?|human resources|account executive|customer success)\b/i;
const FOUNDING_NONTECH_RE = /\b(sales|marketing|operations|recruit(?:er|ing)?|human resources|account executive|customer success|finance)\b/i;

export function parsePendingRoles(markdown) {
  return markdown.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- [ ] ')) return [];
    const fields = trimmed.slice(6).split(' | ').map((value) => value.trim());
    if (fields.length < 3 || !/^https:\/\//.test(fields[0])) return [];
    const labels = fields.slice(3).filter((value) => /^(posted|trust|note):/i.test(value));
    const positional = fields.slice(3).filter((value) => !/^(posted|trust|note):/i.test(value));
    const posted = labels.find((value) => /^posted:/i.test(value))?.replace(/^posted:\s*/i, '') ?? '';
    return [{ url: fields[0], company: fields[1], role: fields[2], location: positional[0] ?? '', posted }];
  });
}

export function classifyEligibility(role) {
  const title = role.role ?? '';
  if (INTERN_RE.test(title) && INTERN_ADJACENT_RE.test(title)) return { eligible: true, kind: 'internship', reason: 'technical_internship_or_fellowship_title' };
  if (FOUNDING_RE.test(title) && FOUNDING_ADJACENT_RE.test(title) && !FOUNDING_NONTECH_RE.test(title)) {
    return { eligible: true, kind: 'founding', reason: 'founding_engineering_adjacent_title' };
  }
  if (EXCLUDED_RE.test(title)) return { eligible: false, reason: 'senior_or_non_builder_title' };
  return { eligible: false, reason: 'outside_internship_or_founding_engineering_scope' };
}

function postedRank(posted) {
  const millis = Date.parse(posted);
  return Number.isFinite(millis) ? millis / 1e12 : 0;
}

export function selectAutoIntakeCandidates(roles, limit = 5, { preferredCompanies = [] } = {}) {
  const preferred = new Set(preferredCompanies.map((company) => company.toLowerCase()));
  return roles
    .map((role) => ({ ...role, eligibility: classifyEligibility(role) }))
    .filter((role) => role.eligibility.eligible)
    .sort((a, b) => {
      const score = (role) => (role.eligibility.kind === 'internship' ? 100 : 90)
        + (preferred.has(role.company.toLowerCase()) ? 25 : 0)
        + (INTERN_ADJACENT_RE.test(role.role) ? 10 : 0);
      return score(b) - score(a) || postedRank(b.posted) - postedRank(a.posted) || a.company.localeCompare(b.company);
    })
    .slice(0, Math.max(0, limit));
}
