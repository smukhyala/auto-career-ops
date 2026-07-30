import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEligibility, parsePendingRoles, selectAutoIntakeCandidates } from '../auto-intake-core.mjs';

test('strict discovery accepts technical internship programs only', () => {
  assert.equal(classifyEligibility({ role: 'Software Engineering Intern' }).eligible, true);
  assert.equal(classifyEligibility({ role: 'Machine Learning Fellowship' }).eligible, true);
  assert.equal(classifyEligibility({ role: 'Founding Product Manager' }).eligible, false);
  assert.equal(classifyEligibility({ role: 'Founding Sales Lead' }).eligible, false);
  assert.equal(classifyEligibility({ role: 'Finance Fellow' }).eligible, false);
  assert.equal(classifyEligibility({ role: 'Senior Machine Learning Engineer' }).eligible, false);
});

test('legacy parser only returns eligible internship records', () => {
  const roles = parsePendingRoles('- [ ] https://example.com/a | A | Founding Product Manager | Remote | posted: 2026-07-20\n- [ ] https://example.com/b | B | AI Engineer Intern | Remote | posted: 2026-07-19\n- [ ] https://example.com/c | C | Product Manager | Remote | posted: 2026-07-29');
  const selected = selectAutoIntakeCandidates(roles, 1, { preferredCompanies: ['A'] });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].company, 'B');
});
