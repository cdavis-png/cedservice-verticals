/* Milestone 1.1 — B. Retry classification.

   The bug: the browser classified retryability by HTTP status alone, and 409
   carries two opposite meanings. `request_in_flight` means "a concurrent
   request holds this key, try again"; `idempotency_key_conflict` means "this
   key was used for different content, never retry". Treating both as
   permanent silently discarded completed assessments — the exact outcome the
   retry queue exists to prevent.

   These tests drive the real submission.js against a stub fetch and a stub
   localStorage. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/* ---------- browser stubs ---------- */

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

globalThis.localStorage = new MemoryStorage();
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

const require = createRequire(import.meta.url);
const submission = require('../shared/assessment-engine/submission.js');

/* Quiet the adapter's console reporting; it is behaviour, not output, under test. */
const silence = () => {
  const original = { warn: console.warn, info: console.info, error: console.error };
  console.warn = () => {}; console.info = () => {}; console.error = () => {};
  return () => Object.assign(console, original);
};

const jsonResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  json: async () => body
});

const errorResponse = (status, code, extra = {}, headers = {}) =>
  jsonResponse(status, { ok: false, error: { code, message: 'x', ...extra } }, headers);

const OPTS = { endpoint: 'https://example.test/api/assessments', queueKey: 'test:queue' };

const payload = (id = '22222222-2222-4222-8222-222222222222') => ({
  submissionId: id, schemaVersion: 3
});

const runSubmit = async (response, opts = {}) => {
  const restore = silence();
  globalThis.localStorage = new MemoryStorage();
  globalThis.fetch = async () => (typeof response === 'function' ? response() : response);
  try {
    const outcome = await submission.submitAssessment(payload(), { ...OPTS, ...opts });
    const queue = submission.pendingSubmissions({ ...OPTS, ...opts });
    return { outcome, queue };
  } finally {
    restore();
  }
};

/* ---------- classification by code ---------- */

test('request_in_flight is retryable and stays queued', async () => {
  const { outcome, queue } = await runSubmit(errorResponse(409, 'request_in_flight'));

  assert.equal(outcome.status, 'queued');
  assert.equal(outcome.errorCode, 'request_in_flight');
  assert.equal(outcome.permanent, false, 'a concurrent holder clears; retrying is correct');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].permanent, false);
  assert.ok(queue[0].nextRetryAt, 'a retry is scheduled');
});

test('idempotency_key_conflict is permanent and never retried', async () => {
  const { outcome, queue } = await runSubmit(errorResponse(409, 'idempotency_key_conflict'));

  assert.equal(outcome.status, 'queued', 'retained for inspection, never discarded');
  assert.equal(outcome.permanent, true, 'the same key with different content cannot succeed');
  assert.equal(queue[0].permanent, true);
});

test('the two 409s are classified oppositely despite sharing a status', async () => {
  const inFlight = await runSubmit(errorResponse(409, 'request_in_flight'));
  const conflict = await runSubmit(errorResponse(409, 'idempotency_key_conflict'));
  assert.equal(inFlight.outcome.httpStatus, 409);
  assert.equal(conflict.outcome.httpStatus, 409);
  assert.notEqual(inFlight.outcome.permanent, conflict.outcome.permanent);
});

test('a temporarily unavailable database is retryable', async () => {
  for (const [status, code] of [[502, 'ingestion_failed'], [504, 'ingestion_timeout'], [503, 'not_configured']]) {
    const { outcome } = await runSubmit(errorResponse(status, code));
    assert.equal(outcome.permanent, false, `${code} must retry`);
  }
});

test('validation errors are permanent', async () => {
  for (const [status, code] of [
    [400, 'malformed_json'], [400, 'unsupported_version'], [422, 'payload_limit_exceeded'],
    [422, 'prohibited_data'], [422, 'results_consent_required'], [413, 'payload_too_large']
  ]) {
    const { outcome } = await runSubmit(errorResponse(status, code));
    assert.equal(outcome.permanent, true, `${code} must not retry`);
  }
});

test('rate limiting is retryable', async () => {
  const { outcome } = await runSubmit(errorResponse(429, 'rate_limited', { retryAfterSeconds: 120 }));
  assert.equal(outcome.permanent, false);
});

test('challenge verification unavailable is retryable; rejected is permanent', async () => {
  const unavailable = await runSubmit(errorResponse(503, 'challenge_unavailable'));
  assert.equal(unavailable.outcome.permanent, false, 'a provider outage is never the visitor’s fault');

  const rejected = await runSubmit(errorResponse(403, 'challenge_rejected'));
  assert.equal(rejected.outcome.permanent, true);
});

test('an aged-out challenge token is retryable because the server exempts old queued work', async () => {
  const { outcome } = await runSubmit(errorResponse(400, 'challenge_invalid'));
  assert.equal(outcome.permanent, false);
});

test('an unrecognised code falls back to the status heuristic', async () => {
  const server = await runSubmit(errorResponse(500, 'something_new'));
  assert.equal(server.outcome.permanent, false, '5xx retries');

  const client = await runSubmit(errorResponse(418, 'something_new'));
  assert.equal(client.outcome.permanent, true, 'unknown 4xx does not');
});

test('a response with no parseable body still classifies by status', async () => {
  const broken = {
    ok: false, status: 409,
    headers: { get: () => null },
    json: async () => { throw new Error('not json'); }
  };
  const { outcome } = await runSubmit(broken);
  assert.equal(outcome.permanent, true, 'without a code, 409 is treated conservatively');
});

/* ---------- Retry-After ---------- */

test('a server Retry-After body field extends the backoff', async () => {
  const { queue } = await runSubmit(errorResponse(429, 'rate_limited', { retryAfterSeconds: 900 }));
  const waitMs = Date.parse(queue[0].nextRetryAt) - Date.parse(queue[0].lastAttemptAt);
  assert.ok(waitMs >= 900_000, `expected at least the advised 900s, got ${waitMs}ms`);
});

test('a Retry-After header is honoured when the body carries no advice', async () => {
  const { queue } = await runSubmit(errorResponse(429, 'rate_limited', {}, { 'retry-after': '300' }));
  const waitMs = Date.parse(queue[0].nextRetryAt) - Date.parse(queue[0].lastAttemptAt);
  assert.ok(waitMs >= 300_000, `expected at least 300s, got ${waitMs}ms`);
});

test('Retry-After never shortens the exponential backoff', async () => {
  const { queue } = await runSubmit(errorResponse(429, 'rate_limited', { retryAfterSeconds: 1 }));
  const waitMs = Date.parse(queue[0].nextRetryAt) - Date.parse(queue[0].lastAttemptAt);
  assert.ok(waitMs >= 60_000, 'the base backoff still applies');
});

test('advice is clamped to the maximum backoff', async () => {
  const advised = submission.backoffMs(1, submission.DEFAULTS, { retryAfterSeconds: 99999 });
  assert.equal(advised, submission.DEFAULTS.maxRetryMs);
});

/* ---------- the queue actually retries ---------- */

test('a queued request_in_flight is re-attempted and delivered', async () => {
  const restore = silence();
  globalThis.localStorage = new MemoryStorage();
  try {
    globalThis.fetch = async () => errorResponse(409, 'request_in_flight');
    const first = await submission.submitAssessment(payload(), OPTS);
    assert.equal(first.status, 'queued');
    assert.equal(submission.pendingSubmissions(OPTS).length, 1);

    /* Due now: the concurrent holder has cleared. */
    const entry = JSON.parse(globalThis.localStorage.getItem(OPTS.queueKey));
    entry[0].nextRetryAt = new Date(Date.now() - 1000).toISOString();
    globalThis.localStorage.setItem(OPTS.queueKey, JSON.stringify(entry));

    globalThis.fetch = async () => jsonResponse(201, { ok: true, businessId: 'b1' });
    const result = await submission.retryPendingSubmissions(OPTS);

    assert.equal(result.attempted, 1);
    assert.equal(result.sent, 1);
    assert.equal(result.remaining, 0, 'delivered entries are removed immediately');
  } finally {
    restore();
  }
});

test('a successful retry returns its continuation with the original queued payload', async () => {
  const restore = silence();
  globalThis.localStorage = new MemoryStorage();
  const original = {
    ...payload(),
    contact: { salonName: 'Queued Nail Studio', email: 'queued-owner@example.test' }
  };
  let announced = null;
  try {
    globalThis.fetch = async () => errorResponse(503, 'challenge_unavailable');
    await submission.submitAssessment(original, OPTS);

    const entry = JSON.parse(globalThis.localStorage.getItem(OPTS.queueKey));
    entry[0].nextRetryAt = new Date(Date.now() - 1000).toISOString();
    globalThis.localStorage.setItem(OPTS.queueKey, JSON.stringify(entry));

    const responseBody = {
      ok: true,
      reviewType: 'growth_review',
      continuationToken: 'growth.retry.issued.context'
    };
    globalThis.fetch = async () => jsonResponse(201, responseBody);
    await submission.retryPendingSubmissions({
      ...OPTS,
      onContinuation: (token, body, queuedPayload) => {
        announced = { token, body, queuedPayload };
      }
    });

    assert.equal(announced.token, responseBody.continuationToken);
    assert.deepEqual(announced.body, responseBody);
    assert.deepEqual(announced.queuedPayload, original);
  } finally {
    restore();
  }
});

test('a queued idempotency_key_conflict is skipped, not re-attempted', async () => {
  const restore = silence();
  globalThis.localStorage = new MemoryStorage();
  try {
    globalThis.fetch = async () => errorResponse(409, 'idempotency_key_conflict');
    await submission.submitAssessment(payload(), OPTS);

    let calls = 0;
    globalThis.fetch = async () => { calls++; return jsonResponse(201, { ok: true }); };
    const result = await submission.retryPendingSubmissions(OPTS);

    assert.equal(calls, 0, 'a permanent failure is never sent again');
    assert.equal(result.attempted, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.remaining, 1, 'retained rather than discarded');
  } finally {
    restore();
  }
});

test('a visitor-requested retry can bypass backoff without bypassing permanent failures', async () => {
  const restore = silence();
  globalThis.localStorage = new MemoryStorage();
  try {
    globalThis.fetch = async () => errorResponse(503, 'challenge_unavailable');
    await submission.submitAssessment(payload(), OPTS);

    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return jsonResponse(201, { ok: true, businessId: 'b1' });
    };
    const result = await submission.retryPendingSubmissions({ ...OPTS, force: true });
    assert.equal(calls, 1, 'force means retry now, not after the scheduled backoff');
    assert.equal(result.sent, 1);
    assert.equal(result.remaining, 0);
  } finally {
    restore();
  }
});

test('one submissionId is reused across every retry of the same result', async () => {
  const restore = silence();
  globalThis.localStorage = new MemoryStorage();
  const seen = [];
  try {
    globalThis.fetch = async (_url, init) => {
      seen.push(init.headers['Idempotency-Key']);
      return errorResponse(503, 'not_configured');
    };
    await submission.submitAssessment(payload(), OPTS);

    const entry = JSON.parse(globalThis.localStorage.getItem(OPTS.queueKey));
    entry[0].nextRetryAt = new Date(Date.now() - 1000).toISOString();
    globalThis.localStorage.setItem(OPTS.queueKey, JSON.stringify(entry));
    await submission.retryPendingSubmissions(OPTS);

    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1], 'the idempotency key never changes between retries');
  } finally {
    restore();
  }
});

test('the code tables do not overlap', () => {
  for (const code of submission.RETRYABLE_CODES) {
    assert.ok(!submission.PERMANENT_CODES.has(code), `${code} is classified twice`);
  }
});
