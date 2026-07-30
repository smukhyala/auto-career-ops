/**
 * Local, headed browser worker for reviewed application drafts.
 *
 * This module deliberately has no submission primitive. It will never invoke
 * `click`, `press('Enter')`, `evaluate(form.submit)`, or navigate a POST form.
 * The only transition out of a completed form is `handoff`, which brings the
 * page forward for the candidate's own visible final Submit action.
 */

import { verifyApproval } from './application-queue-core.mjs';

const SUPPORTED_ATS = Object.freeze(['greenhouse', 'ashby', 'lever', 'workday']);

export function detectAts(applyUrl) {
  let url;
  try { url = new URL(applyUrl); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'boards.greenhouse.io' || host.endsWith('.greenhouse.io')) return 'greenhouse';
  if (host === 'jobs.ashbyhq.com' || host.endsWith('.ashbyhq.com')) return 'ashby';
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co' || host.endsWith('.lever.co')) return 'lever';
  if (host.includes('myworkdayjobs.com') || host.includes('workday.com')) return 'workday';
  return null;
}

function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('applyUrl must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:') throw new Error('applyUrl must use HTTPS');
  return url.toString();
}

function asText(value) { return typeof value === 'string' ? value : ''; }

function isSubmissionControl(field) {
  const type = asText(field.type).toLowerCase();
  const name = `${field.name ?? ''} ${field.label ?? ''} ${field.selector ?? ''}`.toLowerCase();
  return ['submit', 'button', 'image'].includes(type) || /\b(submit|apply now|send application)\b/.test(name);
}

function noValueField(field) {
  const type = asText(field.type).toLowerCase();
  return ['checkbox', 'radio', 'file'].includes(type);
}

/** A small adapter boundary so unit tests and the dashboard can inject a fake browser. */
export class ApplyWorker {
  constructor({ browserFactory, launchOptions = {} } = {}) {
    this.browserFactory = browserFactory ?? defaultBrowserFactory;
    this.launchOptions = launchOptions;
    this.context = null;
    this.page = null;
    this.job = null;
  }

  async ensurePage() {
    if (this.page) return this.page;
    this.context = await this.browserFactory(this.launchOptions);
    this.page = typeof this.context.newPage === 'function'
      ? await this.context.newPage()
      : this.context.page;
    if (!this.page) throw new Error('browser factory returned no page');
    return this.page;
  }

  validateJob(payload) {
    const applyUrl = safeUrl(payload.applyUrl);
    const ats = detectAts(applyUrl);
    if (!ats) throw new Error(`unsupported ATS host; supported providers: ${SUPPORTED_ATS.join(', ')}`);
    this.job = { applyUrl, ats, expectedTitle: asText(payload.expectedTitle), expectedCompany: asText(payload.expectedCompany) };
    return this.job;
  }

  async visit(payload) {
    const preparedUrl = this.job?.applyUrl;
    const job = this.validateJob(payload);
    const page = await this.ensurePage();
    // A worker owns one browser page at a time. Reusing an already-open job is
    // essential: `prepare → fill → handoff` must not discard typed answers.
    if (preparedUrl !== job.applyUrl || payload.reload === true) {
      await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: payload.timeoutMs ?? 30_000 });
    }
    return { job, page };
  }

  async preflight(payload) {
    const { job, page } = await this.visit(payload);
    const inspection = await inspectPage(page);
    const location = typeof page.url === 'function' ? page.url() : job.applyUrl;
    const sameHost = new URL(location).hostname === new URL(job.applyUrl).hostname;
    const blocked = inspection.blocked || !sameHost;
    return {
      status: blocked ? 'needs_user_action' : 'ready',
      state: blocked ? 'NeedsUserAction' : 'ReadyForReview',
      ats: job.ats,
      url: location,
      active: !blocked,
      warnings: [
        ...(sameHost ? [] : ['redirected_off_expected_host']),
        ...(inspection.blocked ? [inspection.blocked] : []),
        ...inspection.warnings,
      ],
      // A preflight is evidence, not permission to submit.
      finalSubmitRequiresUser: true,
    };
  }

  async prepare(payload) {
    const { job, page } = await this.visit(payload);
    const fields = await extractFields(page);
    return {
      status: 'prepared', state: 'ReadyForReview', ats: job.ats, url: typeof page.url === 'function' ? page.url() : job.applyUrl,
      fields, finalSubmitRequiresUser: true,
    };
  }

  async fill(payload) {
    const { job, page } = await this.visit(payload);
    const supplied = Array.isArray(payload.answers) ? payload.answers : [];
    const results = [];
    for (const answer of supplied) {
      if (!answer || typeof answer.selector !== 'string' || !answer.selector.trim()) {
        results.push({ status: 'skipped', reason: 'missing_selector' });
        continue;
      }
      if (isSubmissionControl(answer)) {
        results.push({ selector: answer.selector, status: 'rejected', reason: 'submission_controls_are_user_only' });
        continue;
      }
      try {
        await fillOne(page, answer);
        results.push({ selector: answer.selector, status: 'filled' });
      } catch (error) {
        results.push({ selector: answer.selector, status: 'needs_user_action', reason: error.message });
      }
    }
    return {
      status: results.some((item) => item.status === 'needs_user_action') ? 'needs_user_action' : 'filled',
      state: results.some((item) => item.status === 'needs_user_action') ? 'NeedsUserAction' : 'Preparing',
      ats: job.ats, results, finalSubmitRequiresUser: true,
    };
  }

  async handoff(payload) {
    const preparedUrl = this.job?.applyUrl;
    const job = this.validateJob(payload);
    // Handoff must preserve the exact visible, filled form. Never reload it.
    if (preparedUrl && preparedUrl !== job.applyUrl) throw new Error('handoff URL does not match the prepared application');
    const page = await this.ensurePage();
    if (typeof page.bringToFront === 'function') await page.bringToFront();
    return {
      status: 'ready_for_user_submit', ats: job.ats,
      state: 'ReadyForUserSubmit',
      url: typeof page.url === 'function' ? page.url() : job.applyUrl,
      message: 'Application is prepared. Review every field and click the employer\'s final Submit button yourself.',
      finalSubmitRequiresUser: true,
    };
  }

  async verifySubmission() {
    const page = await this.ensurePage();
    const receipt = await detectReceipt(page);
    return receipt
      ? { status: 'confirmed_submitted', state: 'Submitted', receipt }
      : { status: 'needs_user_action', state: 'NeedsUserAction', reason: 'no_submission_receipt_detected' };
  }

  /**
   * Execute the approved, reviewed handoff as one long-lived worker request.
   * The browser process remains alive after the response so the candidate can
   * review and submit the exact filled employer form, then ask for receipt
   * verification through the same session.
   */
  async runReviewed(payload) {
    const approval = approvalGate(payload);
    if (!approval.valid) return {
      status: 'needs_user_action', state: 'NeedsUserAction', reason: approval.reason,
      approval, finalSubmitRequiresUser: true,
    };
    const preflight = await this.preflight(payload);
    if (preflight.state !== 'ReadyForReview') return preflight;
    const prepared = await this.prepare(payload);
    const answers = Array.isArray(payload?.snapshot?.payload?.answers) ? payload.snapshot.payload.answers : [];
    if (answers.length === 0) return {
      status: 'needs_user_action', state: 'NeedsUserAction', reason: 'reviewed_answers_missing',
      fields: prepared.fields, finalSubmitRequiresUser: true,
    };
    const filled = await this.fill({ ...payload, answers });
    if (filled.state !== 'Preparing') return { ...filled, fields: prepared.fields };
    return { ...(await this.handoff(payload)), fields: prepared.fields, fillResults: filled.results };
  }

  async close() {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.job = null;
    if (context && typeof context.close === 'function') await context.close();
    return { status: 'closed', state: 'Closed' };
  }

  async dispatch(command) {
    const rawPayload = command?.payload ?? command ?? {};
    // Dashboard requests pass the persisted queue item verbatim. Flatten only
    // its public metadata; explicit payload properties take precedence.
    const payload = rawPayload.item ? { ...rawPayload.item, ...rawPayload } : rawPayload;
    if (!payload.applyUrl && payload.url) payload.applyUrl = payload.url;
    // An approval is checked immediately before the two browser-mutating
    // workflow phases. It is intentionally a non-throwing response so the
    // dashboard can atomically move the item to NeedsUserAction.
    if (command?.command === 'fill' || command?.command === 'handoff') {
      const approval = approvalGate(payload);
      if (!approval.valid) return {
        status: 'needs_user_action', state: 'NeedsUserAction',
        reason: approval.reason, approval,
        finalSubmitRequiresUser: true,
      };
    }
    switch (command?.command) {
      case 'preflight': return this.preflight(payload);
      case 'prepare': return this.prepare(payload);
      case 'fill': return this.fill(payload);
      case 'handoff': return this.handoff(payload);
      case 'run-reviewed': return this.runReviewed(payload);
      case 'verify-submission': return this.verifySubmission(payload);
      case 'close': return this.close();
      default: throw new Error('unknown command; use preflight, prepare, fill, handoff, run-reviewed, verify-submission, or close');
    }
  }
}

function approvalGate(payload) {
  // Direct CLI use without a persisted queue stays usable for development and
  // manual recovery. Once either approval component is supplied, both must be
  // present and cryptographically consistent.
  if (!payload.snapshot && !payload.approval) return { valid: true, unchecked: true };
  return verifyApproval(payload.approval, payload.snapshot);
}

async function defaultBrowserFactory({ profileDir, headless = false } = {}) {
  const { chromium } = await import('playwright');
  // Persistent, headed context deliberately keeps user-owned ATS sessions local.
  // No credentials or cookies are written to the queue, tracker, or worker output.
  return chromium.launchPersistentContext(profileDir ?? '.career-ops-browser-profile', { headless });
}

async function inspectPage(page) {
  if (typeof page.evaluate !== 'function') return { blocked: null, warnings: [] };
  return (await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const warnings = [];
    if (/captcha|verify you are human|checking your browser/.test(text)) warnings.push('captcha_or_bot_challenge');
    if (/sign in|log in|single sign-on|sso/.test(text)) warnings.push('login_may_be_required');
    return {
      blocked: /this job (is no longer available|has been filled)|position has been closed/.test(text) ? 'posting_appears_closed' : null,
      warnings,
    };
  })) ?? { blocked: null, warnings: [] };
}

export async function extractFields(page) {
  if (typeof page.evaluate !== 'function') return [];
  return (await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea, select')).map((el, index) => {
    const label = el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    return {
      selector: el.id ? `#${CSS.escape(el.id)}` : `[name="${CSS.escape(el.getAttribute('name') || '')}"]`,
      name: el.getAttribute('name') || '', label: label.trim(), type: el.getAttribute('type') || el.tagName.toLowerCase(),
      required: el.required || el.getAttribute('aria-required') === 'true', index,
    };
  }).filter((field) => field.name || field.selector !== '[name=""]'))) ?? [];
}

async function fillOne(page, answer) {
  const type = asText(answer.type).toLowerCase();
  if (type === 'file') {
    if (!answer.filePath) throw new Error('missing_file_path');
    return page.setInputFiles(answer.selector, answer.filePath);
  }
  if (type === 'checkbox' || type === 'radio') {
    if (typeof answer.value !== 'boolean') throw new Error('boolean_value_required');
    return answer.value ? page.check(answer.selector) : page.uncheck(answer.selector);
  }
  if (type === 'select') return page.selectOption(answer.selector, String(answer.value ?? ''));
  if (noValueField(answer)) throw new Error('unsupported_field_type');
  if (typeof answer.value !== 'string') throw new Error('string_value_required');
  return page.fill(answer.selector, answer.value);
}

async function detectReceipt(page) {
  if (typeof page.evaluate !== 'function') return null;
  return (await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const receipt = text.match(/(?:application|confirmation|reference)\s*(?:number|id|#)?\s*[:#]?\s*([A-Z0-9-]{5,})/i);
    const confirmation = /thank you for (applying|your application)|application (submitted|received)|we received your application/i.test(text);
    return confirmation ? { confirmed: true, receiptId: receipt?.[1] || null } : null;
  })) ?? null;
}
