/* Milestone 1.1 — F. Public endpoint hardening.

   The endpoint is public and unauthenticated by necessity: it accepts
   submissions from people who have no account. Before this milestone that
   meant it had no defences at all — a missing Origin header was explicitly
   allowed, the honeypot was checked only in the browser, and nothing counted
   requests. Anyone with the URL could create unlimited permanent, append-only
   records.

   Four independent layers now apply. None is sufficient alone; that is why
   there are four. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { handleRequest } from '../api/assessments.mjs';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload, makeRequest, deps, ENV, ALLOWED_ORIGIN, NOW_MS } from './helpers/fixtures.mjs';

const require = createRequire(import.meta.url);
const challenge = require('../shared/security/verify-challenge.js');
const rateLimit = require('../shared/security/rate-limit.js');

const send = async (db, payload, reqOpts = {}, extraDeps = {}) => {
  const res = await handleRequest(makeRequest(payload, reqOpts), deps(db, extraDeps));
  return { res, body: await res.json() };
};

const fresh = () => makePayload({ assessmentSessionId: randomUUID(), submissionId: randomUUID() });

/* ---------- F1. Origin enforcement ---------- */

test('a missing Origin is refused on this browser endpoint', async () => {
  const db = createFakeDb();
  const { res, body } = await send(db, makePayload(), { origin: null });
  assert.equal(res.status, 403);
  assert.equal(body.error.code, 'origin_required');
  assert.equal(db.state.assessment_submissions.length, 0, 'nothing was written');
});

test('an unlisted Origin is refused', async () => {
  const { res, body } = await send(createFakeDb(), makePayload(), { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(body.error.code, 'origin_not_allowed');
});

test('the literal string null is refused', async () => {
  const { res, body } = await send(createFakeDb(), makePayload(), { origin: 'null' });
  assert.equal(res.status, 403);
  assert.equal(body.error.code, 'origin_not_allowed');
});

test('a wildcard Origin is refused', async () => {
  const { res } = await send(createFakeDb(), makePayload(), { origin: '*' });
  assert.equal(res.status, 403);
});

test('malformed Origins are refused', async () => {
  for (const origin of ['not-a-url', 'https://', 'javascript:alert(1)', 'file:///etc/passwd']) {
    const { res } = await send(createFakeDb(), makePayload(), { origin });
    assert.equal(res.status, 403, `${origin} must be refused`);
  }
});

test('an Origin carrying a path or query is refused even if the host matches', async () => {
  for (const origin of [`${ALLOWED_ORIGIN}/callback`, `${ALLOWED_ORIGIN}?x=1`]) {
    const { res } = await send(createFakeDb(), makePayload(), { origin });
    assert.equal(res.status, 403, `${origin} is not a bare origin`);
  }
});

test('a near-miss host is refused', async () => {
  for (const origin of ['https://nails.cedservice.com.evil.test',
    'http://nails.cedservice.com', 'https://evil.nails.cedservice.com']) {
    const { res } = await send(createFakeDb(), makePayload(), { origin });
    assert.equal(res.status, 403, `${origin} must not match by suffix or scheme swap`);
  }
});

test('an allowed Origin proceeds and receives CORS headers', async () => {
  const { res } = await send(createFakeDb(), makePayload());
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(res.headers.get('vary'), 'Origin');
});

test('OPTIONS uses the same allowlist as POST', async () => {
  const allowed = await handleRequest(
    makeRequest(undefined, { method: 'OPTIONS', origin: ALLOWED_ORIGIN }), deps(createFakeDb()));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-methods'), 'POST, OPTIONS');

  const refused = await handleRequest(
    makeRequest(undefined, { method: 'OPTIONS', origin: 'https://evil.example' }), deps(createFakeDb()));
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('access-control-allow-origin'), null);

  const missing = await handleRequest(
    makeRequest(undefined, { method: 'OPTIONS', origin: null }), deps(createFakeDb()));
  assert.equal(missing.status, 403);
});

/* ---------- F2. Server-side honeypot ---------- */

test('a filled honeypot is refused server-side and writes nothing', async () => {
  const db = createFakeDb();
  const payload = makePayload({ integrity: { honeypotFilled: true } });
  const { res } = await send(db, payload);

  assert.equal(db.state.assessment_submissions.length, 0);
  assert.equal(db.state.business_records.length, 0);
  assert.equal(db.state.timeline_events.length, 0);
  assert.equal(db.state.idempotency_records.length, 0, 'not even a key is claimed');
  assert.equal(res.status, 200, 'answered generically');
});

test('the honeypot response teaches a bot nothing', async () => {
  const trapped = await send(createFakeDb(), makePayload({ integrity: { honeypotFilled: true } }));
  const serialised = JSON.stringify(trapped.body).toLowerCase();

  assert.ok(!serialised.includes('honeypot'));
  assert.ok(!serialised.includes('bot'));
  assert.ok(!serialised.includes('reject'));
  assert.ok(!serialised.includes('trap'));
  assert.equal(trapped.body.ok, true, 'shaped like a success');
  assert.equal(trapped.body.nextAction, 'results_ready');
});

test('the honeypot value itself is never transmitted or stored', async () => {
  /* The engine sends only a boolean. Even if a value is smuggled into the
     envelope, nothing about it can reach storage, because the request is
     refused before any write. */
  const db = createFakeDb();
  const payload = makePayload({ integrity: { honeypotFilled: true } });
  await send(db, payload);
  assert.equal(JSON.stringify(db.state).includes('honeypot'), false);
});

test('a payload with no integrity envelope is not treated as trapped', async () => {
  const payload = makePayload({ schemaVersion: 2 });
  delete payload.integrity;
  const { res } = await send(createFakeDb(), payload);
  assert.equal(res.status, 201, 'an older client simply has no indicator');
});

test('the engine and the markup agree on the honeypot field name', async () => {
  const { readFileSync } = await import('node:fs');
  const engine = readFileSync(new URL('../shared/assessment-engine/engine.js', import.meta.url), 'utf8');
  const html = readFileSync(
    new URL('../verticals/beauty-wellness-fitness/nails/site/index.html', import.meta.url), 'utf8');

  const name = engine.match(/const HONEYPOT_FIELD = '([^']+)'/)[1];
  assert.notEqual(name, 'website', 'must not collide with the future legitimate website field');
  assert.ok(html.includes(`name="${name}"`), 'the markup uses the same name');
  assert.ok(!html.includes('name="website"'), 'the old trap name is gone');
});

/* ---------- F3. Challenge verification ---------- */

const challengeEnv = (extra = {}) => ({
  ...ENV,
  CED_CHALLENGE_VERIFY_URL: 'https://verify.example/siteverify',
  CED_CHALLENGE_SECRET: 'test-secret-never-real',
  ...extra
});

const verifierReturning = body => async () => ({
  status: 200, json: async () => body
});

/* A fresh submission carrying a challenge token, as a schema-3 page sends. */
const challenged = () => makePayload({
  assessmentSessionId: randomUUID(),
  submissionId: randomUUID(),
  integrity: { honeypotFilled: false, challengeToken: 'test-challenge-token' }
});

test('a submission with no token is refused before the verifier is consulted', async () => {
  let called = false;
  const { res, body } = await send(createFakeDb(), fresh(), {}, {
    env: challengeEnv(),
    fetchImpl: async () => { called = true; return { status: 200, json: async () => ({ success: true }) }; }
  });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'challenge_invalid');
  assert.equal(body.error.details.challengeStatus, 'malformed');
  assert.equal(called, false, 'no point asking the provider about a token we do not have');
});

test('the challenge token never reaches storage', async () => {
  const db = createFakeDb();
  await send(db, challenged(), {}, {
    env: challengeEnv(),
    fetchImpl: verifierReturning({ success: true, action: 'assessment_submit' })
  });
  const stored = JSON.stringify(db.state);
  assert.ok(!stored.includes('test-challenge-token'), 'a credential is never persisted');
  assert.equal(db.state.assessment_submissions[0].raw_payload.integrity.challengePresented, true,
    'only the fact that one was presented is kept');
  assert.ok(!('challengeToken' in db.state.assessment_submissions[0].raw_payload.integrity));
});

test('a verified token proceeds', async () => {
  const db = createFakeDb();
  const { res } = await send(db, challenged(), {}, {
    env: challengeEnv(),
    fetchImpl: verifierReturning({ success: true, action: 'assessment_submit' })
  });
  assert.equal(res.status, 201);
});

test('a rejected token is refused permanently', async () => {
  const { res, body } = await send(createFakeDb(), challenged(), {}, {
    env: challengeEnv(),
    fetchImpl: verifierReturning({ success: false, 'error-codes': ['invalid-input'] })
  });
  assert.equal(res.status, 403);
  assert.equal(body.error.code, 'challenge_rejected');
});

test('expired and malformed tokens are distinguished from rejection', async () => {
  const expired = await send(createFakeDb(), challenged(), {}, {
    env: challengeEnv(),
    fetchImpl: verifierReturning({ success: false, 'error-codes': ['timeout-or-duplicate'] })
  });
  assert.equal(expired.res.status, 400);
  assert.equal(expired.body.error.code, 'challenge_invalid');
  assert.equal(expired.body.error.details.challengeStatus, 'expired');

  const malformed = await send(createFakeDb(), challenged(), {}, {
    env: challengeEnv(),
    fetchImpl: verifierReturning({ success: false, 'error-codes': ['invalid-input-response'] })
  });
  assert.equal(malformed.body.error.details.challengeStatus, 'malformed');
});

test('a verifier outage fails closed and is retryable', async () => {
  const db = createFakeDb();
  const { res, body } = await send(db, challenged(), {}, {
    env: challengeEnv(),
    fetchImpl: async () => ({ status: 503, json: async () => ({}) })
  });
  assert.equal(res.status, 503);
  assert.equal(body.error.code, 'challenge_unavailable');
  assert.equal(res.headers.get('retry-after'), '30');
  assert.equal(db.state.assessment_submissions.length, 0, 'failed closed, not open');
});

test('a bad secret is our problem, not the visitor’s', async () => {
  const { body } = await send(createFakeDb(), challenged(), {}, {
    env: challengeEnv(),
    fetchImpl: verifierReturning({ success: false, 'error-codes': ['invalid-input-secret'] })
  });
  assert.equal(body.error.code, 'challenge_unavailable',
    'a misconfiguration must not be reported as the visitor failing a test');
});

test('a verifier that never answers times out as unavailable', async () => {
  const verdict = await challenge.verifyChallenge({
    token: 'tok', expectedAction: 'assessment_submit',
    env: challengeEnv(), timeoutMs: 30,
    fetchImpl: () => new Promise(() => {})
  });
  assert.equal(verdict.status, 'unavailable');
  assert.equal(verdict.reason, 'timeout');
});

test('an action mismatch is a replayed token', async () => {
  const verdict = await challenge.verifyChallenge({
    token: 'tok', expectedAction: 'assessment_submit', env: challengeEnv(),
    fetchImpl: verifierReturning({ success: true, action: 'newsletter_signup' })
  });
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.reason, 'action_mismatch');
});

test('verification fails closed in production when not configured', async () => {
  const verdict = await challenge.verifyChallenge({
    token: 'tok',
    env: { CED_CHALLENGE_REQUIRED: 'true', NODE_ENV: 'production' }
  });
  assert.equal(verdict.status, 'unavailable');
  assert.equal(verdict.reason, 'not_configured');
  assert.equal(verdict.ok, false);
});

test('the development bypass is available only outside production', async () => {
  const dev = await challenge.verifyChallenge({
    token: null, env: { CED_CHALLENGE_REQUIRED: 'true', NODE_ENV: 'development' }
  });
  assert.equal(dev.status, 'skipped');
  assert.equal(dev.reason, 'development_bypass');
});

test('an unset CED_CHALLENGE_REQUIRED defaults to required', async () => {
  const verdict = await challenge.verifyChallenge({ token: 'tok', env: { NODE_ENV: 'production' } });
  assert.equal(verdict.status, 'unavailable',
    'a missing variable must not silently disable the protection');
});

test('neither the token nor the secret appears in any verdict', async () => {
  const verdict = await challenge.verifyChallenge({
    token: 'SUPER-SECRET-TOKEN', env: challengeEnv({ CED_CHALLENGE_SECRET: 'SUPER-SECRET-KEY' }),
    fetchImpl: verifierReturning({ success: false, 'error-codes': ['invalid-input'] })
  });
  const serialised = JSON.stringify(verdict);
  assert.ok(!serialised.includes('SUPER-SECRET-TOKEN'));
  assert.ok(!serialised.includes('SUPER-SECRET-KEY'));
});

test('an old queued submission is exempt from the challenge', async () => {
  /* Its token cannot be refreshed by a background retry, so requiring one
     would permanently discard a completed assessment. Documented trade-off. */
  const db = createFakeDb();
  const payload = makePayload({
    assessmentSessionId: randomUUID(), submissionId: randomUUID(),
    submittedAt: new Date(NOW_MS - 3 * 86400000).toISOString()
  });
  let called = false;
  const { res } = await send(db, payload, {}, {
    env: challengeEnv(),
    fetchImpl: async () => { called = true; return { status: 200, json: async () => ({ success: false }) }; }
  });
  assert.equal(res.status, 201);
  assert.equal(called, false, 'the verifier was not consulted for a stale queued submission');
});

test('a schema-2 client is exempt during the migration window', async () => {
  const payload = makePayload({ schemaVersion: 2, assessmentSessionId: randomUUID(), submissionId: randomUUID() });
  delete payload.integrity;
  const { res } = await send(createFakeDb(), payload, {}, {
    env: challengeEnv(),
    fetchImpl: async () => { throw new Error('must not be called'); }
  });
  assert.equal(res.status, 201);
});

/* ---------- F4. Rate limiting ---------- */

const withAddress = address => ({ extraHeaders: { 'x-forwarded-for': address } });

test('requests under the limit are allowed', async () => {
  const db = createFakeDb();
  for (let i = 0; i < 3; i++) {
    const { res } = await send(db, fresh(), withAddress('203.0.113.10'));
    assert.equal(res.status, 201, `request ${i + 1}`);
  }
});

test('exceeding the limit returns 429 with Retry-After', async () => {
  const db = createFakeDb();
  const env = { ...ENV, CED_RATE_LIMIT_MAX_REQUESTS: '3', CED_RATE_LIMIT_WINDOW_SECONDS: '900' };

  for (let i = 0; i < 3; i++) {
    const { res } = await send(db, fresh(), withAddress('203.0.113.20'), { env });
    assert.equal(res.status, 201);
  }

  const { res, body } = await send(db, fresh(), withAddress('203.0.113.20'), { env });
  assert.equal(res.status, 429);
  assert.equal(body.error.code, 'rate_limited');
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal(body.error.retryAfterSeconds, Number(res.headers.get('retry-after')));
});

test('the limit is enforced before any permanent record is created', async () => {
  const db = createFakeDb();
  const env = { ...ENV, CED_RATE_LIMIT_MAX_REQUESTS: '1' };

  await send(db, fresh(), withAddress('203.0.113.30'), { env });
  const before = {
    businesses: db.state.business_records.length,
    submissions: db.state.assessment_submissions.length,
    keys: db.state.idempotency_records.length
  };

  const { res } = await send(db, fresh(), withAddress('203.0.113.30'), { env });
  assert.equal(res.status, 429);
  assert.equal(db.state.business_records.length, before.businesses);
  assert.equal(db.state.assessment_submissions.length, before.submissions);
  assert.equal(db.state.idempotency_records.length, before.keys, 'no key was claimed');
});

test('a different address has its own budget', async () => {
  const db = createFakeDb();
  const env = { ...ENV, CED_RATE_LIMIT_MAX_REQUESTS: '1' };
  await send(db, fresh(), withAddress('203.0.113.40'), { env });
  const blocked = await send(db, fresh(), withAddress('203.0.113.40'), { env });
  assert.equal(blocked.res.status, 429);

  const other = await send(db, fresh(), withAddress('198.51.100.7'), { env });
  assert.equal(other.res.status, 201);
});

test('a single session is limited even from shifting addresses', async () => {
  const db = createFakeDb();
  const env = { ...ENV, CED_RATE_LIMIT_MAX_REQUESTS: '2' };
  const sessionId = randomUUID();
  const same = () => makePayload({ assessmentSessionId: sessionId, submissionId: randomUUID() });

  await send(db, same(), withAddress('203.0.113.51'), { env });
  await send(db, same(), withAddress('203.0.113.52'), { env });
  const { res } = await send(db, same(), withAddress('203.0.113.53'), { env });
  assert.equal(res.status, 429, 'the session scope catches a rotating address');
});

test('no raw address or session id is ever stored', async () => {
  const db = createFakeDb();
  const sessionId = '11111111-1111-4111-8111-111111111111';
  await send(db, makePayload({ assessmentSessionId: sessionId, submissionId: randomUUID() }),
    withAddress('203.0.113.99'));

  const buckets = JSON.stringify(db.state.rate_limit_buckets);
  assert.ok(buckets.length > 2, 'buckets were written');
  assert.ok(!buckets.includes('203.0.113.99'), 'the address is not stored');
  assert.ok(!buckets.includes(sessionId), 'the session id is not stored');
  db.state.rate_limit_buckets.forEach(b => {
    assert.match(b.bucket_key, /^[0-9a-f]{64}$/, 'keys are HMAC digests');
  });
});

test('rotating the secret invalidates every historical key', () => {
  const { createHmac } = require('node:crypto');
  const hmacFn = (secret, input) => createHmac('sha256', secret).update(input).digest('hex');
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.1' });

  const a = rateLimit.buildRateLimitKeys({ headers, sessionId: 'sess', env: { CED_RATE_LIMIT_SECRET: 'one' }, hmacFn });
  const b = rateLimit.buildRateLimitKeys({ headers, sessionId: 'sess', env: { CED_RATE_LIMIT_SECRET: 'two' }, hmacFn });
  assert.notEqual(a[0].key, b[0].key);
});

test('with no secret configured no keys are derived', () => {
  const keys = rateLimit.buildRateLimitKeys({
    headers: new Headers({ 'x-forwarded-for': '203.0.113.1' }),
    sessionId: 'sess', env: {}, hmacFn: () => 'x'
  });
  assert.deepEqual(keys, []);
});

test('a rate limiter that errors does not take the endpoint down', async () => {
  const db = createFakeDb();
  const broken = {
    ...db,
    rpc: async (name, args) =>
      name === 'check_rate_limit' ? { data: null, error: { message: 'boom' } } : db.rpc(name, args)
  };
  const { res } = await send(broken, fresh());
  assert.equal(res.status, 201, 'the remaining layers still apply');
});

test('policy defaults are sane and configurable', () => {
  assert.deepEqual(rateLimit.rateLimitPolicy({}), { windowSeconds: 900, maxRequests: 20 });
  assert.deepEqual(
    rateLimit.rateLimitPolicy({ CED_RATE_LIMIT_WINDOW_SECONDS: '60', CED_RATE_LIMIT_MAX_REQUESTS: '5' }),
    { windowSeconds: 60, maxRequests: 5 });
});
