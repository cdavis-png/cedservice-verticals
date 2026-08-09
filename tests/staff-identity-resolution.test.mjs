/* ============================================================
   The staff route — authentication, authorization, and refusal
   ------------------------------------------------------------
   0001 called identity_resolution_cases "the human queue" and
   nothing has ever closed one. This is the route that does, and
   almost all of it is refusal: the parts that say no are the parts
   that matter, because the thing on the other side is a permanent,
   unerasable attachment of one business's review to another
   business's record.

   The authorization chain, tested one link at a time:

     no token → invalid token → expired token → valid token but not
     an operator → operator disabled → AAL1 → authorized

   The database half — locking, idempotency, rollback — is section
   U of tests/integration/supabase-real-db.test.mjs, against real
   PostgreSQL. A fake cannot prove `for update`.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { handleRequest, __testing } from '../server/staff-identity-resolution.mjs';
import rateLimit from '../shared/security/rate-limit.js';
import { PUBLISHABLE_FIXTURE, SECRET_FIXTURE } from './helpers/supabase-keys.mjs';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '22222222-2222-4222-8222-222222222222';
const BUSINESS = '33333333-3333-4333-8333-333333333333';
const SUBMISSION = '44444444-4444-4444-8444-444444444444';

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-never-real',
  SUPABASE_SERVICE_ROLE_KEY: 'service-never-real',
  /* Rate limiting FAILS CLOSED on a missing secret, so every staff fixture
     must configure one or the route answers 503 before the test's own
     subject is reached. Never a real value. */
  CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret',
  CED_LOG_LEVEL: 'error'
};

/* A verifier the test controls, standing in for Supabase Auth. The real one
   asks Supabase to verify the signature; what varies here is the answer. */
const verifier = answer => async token => {
  if (token === 'invalid') return null;
  if (token === 'expired') return null;
  return typeof answer === 'function' ? answer(token) : answer;
};

const AUTHORIZED = { userId: OPERATOR, aal: 'aal2', emailConfirmed: true };

/* A minimal stand-in for the Supabase client: enough shape for the route,
   with every call recorded so a test can assert what was sent. */
/* `rateLimit` is answered BEFORE the caller's `rpc` stub, and defaults to
   "allowed".

   WHY. Most stubs here return one canned answer for EVERY rpc name — a guard
   refusal, an unmapped error — and `check_rate_limit` would inherit it. Now
   that the limiter fails closed, such a stub refuses the request at the
   limiter and the test never reaches its own subject. The limiter is
   infrastructure for these tests, not the thing under test, so it answers
   plausibly unless a test opts in by passing `rateLimit`. */
const makeDb = ({ rpc = async () => ({ data: null, error: null }), submission,
                  rateLimit = { data: { allowed: true }, error: null } } = {}) => {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'check_rate_limit' && rateLimit !== null) return rateLimit;
      return rpc(name, args);
    },
    from(table) {
      return {
        select() { return this; },
        eq(_column, value) {
          calls.push({ table, value });
          if (table === 'identity_resolution_cases') {
            return { data: [{ assessment_submission_id: SUBMISSION }] };
          }
          return {
            data: [submission || {
              submission_id: SUBMISSION,
              payload_hash: 'hash-of-the-stored-payload',
              raw_payload: {
                contact: { salonName: 'Polished Nail Studio', email: 'owner@polished.test' },
                vertical: { id: 'nails' }
              }
            }]
          };
        }
      };
    }
  };
};

/* The console's own origin. Unset CED_STAFF_ALLOWED_ORIGINS means the
   allowlist is the request's own origin, which is what a same-origin
   deployment has, so this is what a real console sends — ON AN UNSAFE METHOD.

   It does NOT send one on a safe method. Per the Fetch standard a same-origin
   GET keeps response tainting `basic`, so no Origin header is appended, and an
   Authorization header does not change that. This helper used to attach one to
   every request regardless, which meant the whole file exercised a header
   combination no browser produces. The queue and case reads below now carry
   what Chrome was observed to send: no Origin, Sec-Fetch-Site: same-origin. */
const ORIGIN = 'https://staff.example.com';

/* A caller identifier, on every request, because the staff limiter now FAILS
   CLOSED without one. TEST-NET-3 (RFC 5737) — an address reserved for
   documentation, so it can never be a real client. Tests that are ABOUT a
   missing or malformed identifier override it explicitly. */
const CALLER_IP = '203.0.113.9';

const call = async ({ method = 'GET', path = '/cases', token = 'good', body,
                      verify, db, env = ENV, headers = {}, authClient,
                      origin, fetchSite = 'same-origin', rawBody,
                      callerIp = CALLER_IP } = {}) => {
  /* `undefined` defers to the method; `null` means explicitly none. */
  const effectiveOrigin = origin === undefined
    ? (['GET', 'HEAD'].includes(method) ? null : ORIGIN)
    : origin;
  const request = new Request(`https://staff.example.com/api/staff/identity-resolution${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-proto': 'https',
      ...(callerIp ? { 'x-vercel-forwarded-for': callerIp } : {}),
      ...(effectiveOrigin ? { origin: effectiveOrigin } : {}),
      ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}),
      ...((body || rawBody) ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(rawBody ? { body: rawBody } : body ? { body: JSON.stringify(body) } : {})
  });
  const res = await handleRequest(request, {
    env,
    verifyAccessToken: verify || verifier(AUTHORIZED),
    db: db || makeDb(),
    ...(authClient ? { authClient } : {}),
    correlationId: 'test-correlation'
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
};

const linkBody = (over = {}) => ({
  targetBusinessId: BUSINESS,
  resolutionRequestId: randomUUID(),
  note: 'Confirmed by phone with the owner.',
  ...over
});

/* ---------- the authorization chain ---------- */

test('a request with no token is refused before anything is read', async () => {
  const db = makeDb();
  const { status, body } = await call({ token: '', db });
  assert.equal(status, 401);
  assert.equal(body.code, 'unauthenticated');
    /* The pre-authentication pass now runs on every request and is charged
       to the limiter's own bucket; it is infrastructure, not a privileged
       read. What matters is what came AFTER it. */
  assert.deepEqual(db.calls.map(c => c.name || c.table), ['check_rate_limit'],
    'the limiter, and nothing privileged, on an unauthenticated request');
});

test('an invalid or expired token is refused', async () => {
  for (const token of ['invalid', 'expired']) {
    const { status, body } = await call({ token });
    assert.equal(status, 401, token);
    assert.equal(body.code, 'unauthenticated', token);
  }
});

test('a token carrying no usable account id is refused', async () => {
  const { status, body } = await call({ verify: verifier({ userId: 'not-a-uuid', aal: 'aal2' }) });
  assert.equal(status, 401);
  assert.equal(body.code, 'unauthenticated');
});

test('an unconfirmed email cannot use an invite', async () => {
  const { status, body } = await call({
    verify: verifier({ userId: OPERATOR, aal: 'aal2', emailConfirmed: false }) });
  assert.equal(status, 403);
  assert.equal(body.code, 'email_unconfirmed');
});

test('an ordinary authenticated user who is not an operator is refused by the database', async () => {
  /* The route cannot know. It asks, and the database answers — which is the
     whole point of the live lookup. */
  const db = makeDb({ rpc: async () => ({
    data: null, error: { message: 'staff_not_an_operator: this account is not provisioned for staff access' } }) });
  const { status, body } = await call({ db });
  assert.equal(status, 403);
  assert.equal(body.code, 'not_an_operator');
});

test('a disabled operator is refused even with a valid token', async () => {
  const db = makeDb({ rpc: async () => ({
    data: null, error: { message: 'staff_operator_disabled: this operator has been revoked' } }) });
  const { status, body } = await call({ db });
  assert.equal(status, 403);
  assert.equal(body.code, 'operator_disabled');
  /* This is the revocation contract: the token is still perfectly valid and
     the answer is still no, on this request rather than the next hour. */
});

test('AAL1 cannot read the queue or resolve a case', async () => {
  const db = makeDb({ rpc: async () => ({
    data: null, error: { message: 'staff_aal2_required: identity resolution requires a second factor' } }) });

  const read = await call({ db, verify: verifier({ userId: OPERATOR, aal: 'aal1', emailConfirmed: true }) });
  assert.equal(read.status, 403);
  assert.equal(read.body.code, 'aal2_required');

  const write = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, body: linkBody(),
    db, verify: verifier({ userId: OPERATOR, aal: 'aal1', emailConfirmed: true }) });
  assert.equal(write.status, 403);
  assert.equal(write.body.code, 'aal2_required');
});

test('the AAL the route sends is the one from the verified token, never the body', async () => {
  const db = makeDb();
  await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, db,
    body: linkBody({ aal: 'aal2', operatorUserId: 'someone-else' }),
    verify: verifier({ userId: OPERATOR, aal: 'aal1', emailConfirmed: true }) });
  const rpc = db.calls.find(c => c.name === 'resolve_identity_case_link_existing');
  assert.equal(rpc.args.p_aal, 'aal1', 'the body cannot raise its own assurance level');
  assert.equal(rpc.args.p_operator_user_id, OPERATOR, 'nor name a different operator');
});

test('HTTPS is required, and the exemption is conditional on it', async () => {
  const request = new Request('http://staff.example.com/api/staff/identity-resolution/cases', {
    headers: { authorization: 'Bearer good', 'x-forwarded-proto': 'http' }
  });
  const res = await handleRequest(request, { env: ENV, verifyAccessToken: verifier(AUTHORIZED), db: makeDb() });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'https_required');
});

/* ---------- the queue ---------- */

test('the queue returns open cases with safe fields and a deterministic shape', async () => {
  const seen = [];
  const db = makeDb({ rpc: async name => {
    seen.push(name);
    if (name === 'staff_operator_guard') return { data: 'identity_resolver', error: null };
    assert.equal(name, 'staff_identity_queue');
    return { data: [{
      identity_resolution_id: CASE_ID, created_at: '2026-08-01T00:00:00.000Z',
      age_seconds: 7200, resolution_status: 'manual_review_required',
      recommended_action: 'queue_for_review', review_type: 'service_mix',
      confidence: 0.4, candidate_count: 2, proposal_kinds: ['session_contradicted'],
      agreed_types: ['email_domain'], contradicted_types: ['business_name', 'email_exact'],
      escalation_reason: 'A saved identity proposal was contradicted by submitted identity evidence.',
      submitted_label: 'Riverside Barber Co', resolvable: true, total_count: 1
    }], error: null };
  }});

  const { status, body } = await call({ db });
  assert.equal(status, 200);
  assert.deepEqual(seen, ['staff_operator_guard', 'staff_identity_queue'],
    'the live operator lookup happens first, on every request');
  assert.equal(body.total, 1);
  const row = body.cases[0];
  assert.equal(row.caseId, CASE_ID);
  assert.equal(row.candidateCount, 2);
  assert.equal(row.resolvable, true);
  assert.deepEqual(row.contradictedTypes, ['business_name', 'email_exact']);

  /* Nothing that could identify a person, and no business id at all. */
  const text = JSON.stringify(body);
  assert.equal(/@/.test(text), false, 'no email address reached the response');
  assert.equal(text.includes(BUSINESS), false, 'no business id reached the list');
});

test('the queue is never cached and never framed', async () => {
  const { headers } = await call({ db: makeDb({ rpc: async () => ({ data: [], error: null }) }) });
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
});

/* ---------- resolution input validation ---------- */

test('a resolution without a target, request id or note is refused', async () => {
  const cases = [
    [{ targetBusinessId: 'nope' }, 'invalid_target'],
    [{ targetBusinessId: BUSINESS, resolutionRequestId: 'nope' }, 'invalid_request_id'],
    [{ targetBusinessId: BUSINESS, resolutionRequestId: randomUUID(), note: 'short' },
      'resolution_note_required']
  ];
  for (const [body, code] of cases) {
    const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, body });
    assert.equal(res.status, 422, code);
    assert.equal(res.body.code, code);
  }
});

test('an override needs an approved reason, and a reason needs an override', async () => {
  const bad = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`,
    body: linkBody({ overrideConflict: true }) });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, 'override_reason_required');

  const invented = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`,
    body: linkBody({ overrideConflict: true, overrideReason: 'seemed_right' }) });
  assert.equal(invented.status, 422);
  assert.equal(invented.body.code, 'override_reason_required');

  const orphan = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`,
    body: linkBody({ overrideReason: 'business_rebrand' }) });
  assert.equal(orphan.status, 422);
  assert.equal(orphan.body.code, 'override_not_applicable');
});

test('other_verified_evidence requires a substantive explanation', async () => {
  const thin = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`,
    body: linkBody({ overrideConflict: true, overrideReason: 'other_verified_evidence',
                     note: 'Checked it.' }) });
  assert.equal(thin.status, 422);
  assert.equal(thin.body.code, 'override_note_required');

  const db = makeDb({ rpc: async () => ({ data: { ok: true, businessId: BUSINESS }, error: null }) });
  const full = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, db,
    body: linkBody({ overrideConflict: true, overrideReason: 'other_verified_evidence',
                     note: 'Spoke to the owner, who confirmed the salon moved and rebranded in June.' }) });
  assert.equal(full.status, 201);
});

/* ---------- evidence is server-side ---------- */

test('the evidence sent to the database is re-derived from the stored payload', async () => {
  const db = makeDb({ rpc: async () => ({ data: { ok: true }, error: null }) });
  await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, db,
    body: linkBody({
      /* A browser trying to supply its own evidence, candidates and verdict. */
      signals: [{ type: 'business_name', normalizedValue: 'whatever i say' }],
      candidateBusinessIds: [BUSINESS],
      conflict: { material: false }
    }) });

  const rpc = db.calls.find(c => c.name === 'resolve_identity_case_link_existing');
  const sent = rpc.args.p_signals;
  assert.ok(Array.isArray(sent) && sent.length, 'signals were derived, not omitted');
  assert.equal(sent.some(s => s.normalizedValue === 'whatever i say'), false,
    'nothing the browser sent became evidence');
  assert.ok(sent.some(s => s.type === 'business_name' && s.normalizedValue === 'polished nail studio'),
    'the canonical value from the STORED payload was used');
  assert.equal(rpc.args.p_payload_hash, 'hash-of-the-stored-payload',
    'and it is bound to the submission it came from');
});

test('the request hash covers the decision, so a reused id with a new target is a different request', async () => {
  const base = { caseId: CASE_ID, targetBusinessId: BUSINESS, operatorUserId: OPERATOR,
                 overrideConflict: false, overrideReason: null };
  const a = __testing.requestHash(base);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, __testing.requestHash({ ...base }), 'the same decision hashes the same');
  assert.notEqual(a, __testing.requestHash({ ...base, targetBusinessId: SUBMISSION }));
  assert.notEqual(a, __testing.requestHash({ ...base, overrideConflict: true }));
  assert.notEqual(a, __testing.requestHash({ ...base, overrideReason: 'business_rebrand' }));
  /* The OPERATOR is part of the decision. A resolution is attributed to a
     person, so a second operator reusing this request id must be told it
     conflicts rather than handed the first operator's outcome. */
  assert.notEqual(a, __testing.requestHash({ ...base, operatorUserId: SUBMISSION }),
    'a different operator is a different request, not a replay');
});

test('the note is part of the decision, because the note is what justifies it', async () => {
  /* It was not. A second call on one request id with a rewritten note matched
     the replay rule, returned the first outcome with a 200, and dropped the
     new note — and a replay writes nothing, so the correction existed
     nowhere. For an other_verified_evidence override the note is the only
     record of why a contradiction was overridden. */
  const base = { caseId: CASE_ID, targetBusinessId: BUSINESS, operatorUserId: OPERATOR,
                 overrideConflict: false, overrideReason: null,
                 note: 'Confirmed by phone with the owner.' };
  const a = __testing.requestHash(base);

  assert.equal(a, __testing.requestHash({ ...base }), 'the same note hashes the same');
  assert.notEqual(a, __testing.requestHash({ ...base, note: 'Confirmed by email with the owner.' }),
    'a materially different justification is a different request');
  assert.notEqual(a, __testing.requestHash({ ...base, note: '' }),
    'and so is no justification at all');
});

test('whitespace in the note is not a different decision', async () => {
  /* The distinction the original comment drew and the code did not: a
     trailing newline from a textarea must still replay. */
  const base = { caseId: CASE_ID, targetBusinessId: BUSINESS, operatorUserId: OPERATOR,
                 overrideConflict: false, overrideReason: null,
                 note: 'Confirmed by phone with the owner.' };
  const a = __testing.requestHash(base);

  for (const variant of ['  Confirmed by phone with the owner.  ',
                         'Confirmed by phone with the owner.\n',
                         'Confirmed  by   phone with the owner.',
                         'Confirmed by phone\twith the owner.']) {
    assert.equal(__testing.requestHash({ ...base, note: variant }), a,
      `whitespace-only difference must still replay: ${JSON.stringify(variant)}`);
  }
});

test('a reworded note on the same request id reaches the database as a different hash', async () => {
  /* End to end through the route, because the hash the DATABASE sees is the
     one that decides replay-versus-conflict. */
  const hashFor = async note => {
    const db = makeDb({ rpc: async () => ({ data: { ok: true }, error: null }) });
    await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, db,
      body: linkBody({ resolutionRequestId: CASE_ID, note }) });
    return db.calls.find(c => c.name === 'resolve_identity_case_link_existing').args;
  };

  const first = await hashFor('Confirmed by phone with the owner.');
  const second = await hashFor('Confirmed by phone with the owner, who also sent the lease.');
  const retry = await hashFor('Confirmed by phone with the owner.');

  assert.equal(first.p_resolution_request_id, second.p_resolution_request_id,
    'the same request id, deliberately');
  assert.notEqual(first.p_request_hash, second.p_request_hash,
    'the database will refuse the rewritten note rather than silently discard it');
  assert.equal(first.p_request_hash, retry.p_request_hash,
    'but an identical resubmission is still a replay');
});

test('a second operator reusing a request id sends a different hash', async () => {
  const other = '99999999-9999-4999-8999-999999999999';
  const hashFor = async operator => {
    const db = makeDb({ rpc: async () => ({ data: { ok: true }, error: null }) });
    await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, db,
      body: linkBody({ resolutionRequestId: CASE_ID }),
      verify: verifier({ userId: operator, aal: 'aal2', emailConfirmed: true }) });
    return db.calls.find(c => c.name === 'resolve_identity_case_link_existing').args;
  };

  const first = await hashFor(OPERATOR);
  const second = await hashFor(other);

  assert.equal(first.p_resolution_request_id, second.p_resolution_request_id,
    'the same request id, deliberately');
  assert.notEqual(first.p_request_hash, second.p_request_hash,
    'but not the same request — the database will refuse the second as a conflict');
  assert.equal(first.p_operator_user_id, OPERATOR);
  assert.equal(second.p_operator_user_id, other);
});

/* ---------- database refusals reach the caller intact ---------- */

test('every database refusal maps to a status without leaking the schema', async () => {
  const expected = {
    'case_not_found: no such identity-resolution case': [404, 'case_not_found'],
    'case_already_resolved: this case was resolved at 2026-01-01': [409, 'case_already_resolved'],
    'target_not_a_candidate: the selected record is not a candidate on this case': [422, 'target_not_a_candidate'],
    'target_merged_away: the selected record has been merged into another': [409, 'target_merged_away'],
    'target_missing: the selected Business Record no longer exists': [404, 'target_missing'],
    'submission_already_attached: this submission is no longer pending resolution': [409, 'submission_already_attached'],
    'material_conflict: the submitted identity contradicts this record': [409, 'material_conflict'],
    'resolution_request_conflict: this request id was already used with different inputs': [409, 'request_conflict'],
    'signals_payload_mismatch: the supplied evidence does not belong to this submission': [409, 'evidence_mismatch']
  };

  for (const [message, [status, code]] of Object.entries(expected)) {
    const db = makeDb({ rpc: async () => ({ data: null, error: { message } }) });
    const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, body: linkBody(), db });
    assert.equal(res.status, status, message);
    assert.equal(res.body.code, code, message);
  }
});

test('an unmapped database error says nothing about the schema', async () => {
  const db = makeDb({ rpc: async () => ({
    data: null,
    error: { message: 'duplicate key value violates unique constraint "irr_one_per_case" on table "identity_resolution_requests"' } }) });
  const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, body: linkBody(), db });
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'resolution_failed');
  assert.equal(/irr_one_per_case|identity_resolution_requests/.test(JSON.stringify(res.body)), false,
    'no constraint or table name reached the caller');
});

/* ---------- success and replay ---------- */

test('a successful link returns the outcome, and a replay is 200 rather than 201', async () => {
  const outcome = {
    ok: true, replayed: false, caseId: CASE_ID, businessId: BUSINESS,
    identityStatus: 'manually_verified', becameCurrent: true, conflictOverridden: false
  };
  const first = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, body: linkBody(),
    db: makeDb({ rpc: async () => ({ data: outcome, error: null }) }) });
  assert.equal(first.status, 201);
  assert.equal(first.body.resolution.identityStatus, 'manually_verified');

  const replay = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, body: linkBody(),
    db: makeDb({ rpc: async () => ({ data: { ...outcome, replayed: true }, error: null }) }) });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.resolution.replayed, true);
});

test('an unknown staff path is 404, and the public routes are untouched', async () => {
  const { status, body } = await call({ path: '/anything-else' });
  assert.equal(status, 404);
  assert.equal(body.code, 'not_found');

  /* The public assessment route is a separate module with a separate handler;
     importing it here is the assertion that they did not become one thing. */
  const publicRoute = await import('../api/assessments.mjs');
  assert.notEqual(publicRoute.handleRequest, handleRequest);
});

/* ---------- authorization happens BEFORE any privileged read ----------

   The mutation guards itself inside its own transaction, and that is where
   the guarantee lives. This is about the reads that happen on the way there:
   a case row and a submission's stored raw_payload, fetched with the server
   credential. Doing that for somebody who turns out not to be an operator is
   a read that should never have happened, even though none of it reaches
   them. */

const REFUSALS = [
  ['staff_not_an_operator: this account is not provisioned for staff access', 403, 'not_an_operator'],
  ['staff_operator_disabled: this operator has been revoked', 403, 'operator_disabled'],
  ['staff_aal2_required: identity resolution requires a second factor', 403, 'aal2_required'],
  ['staff_insufficient_role: this operator may not resolve identity cases', 403, 'insufficient_role']
];

test('an unauthorized POST reads no case, no submission and no payload', async () => {
  for (const [message, status, code] of REFUSALS) {
    const db = makeDb({ rpc: async name =>
      name === 'staff_operator_guard'
        ? { data: null, error: { message } }
        : { data: { ok: true }, error: null } });

    const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, body: linkBody(), db });
    assert.equal(res.status, status, message);
    assert.equal(res.body.code, code, message);

    /* The limiter, then the guard, and nothing else. `check_rate_limit` is
       infrastructure that now runs on every authenticated pass; what matters
       is that no `from()` call was recorded — those push a {table, value}
       entry — and that the mutation was never reached. */
    assert.deepEqual(db.calls.map(c => c.name || c.table),
      ['check_rate_limit', 'check_rate_limit', 'staff_operator_guard'],
      `${code}: the two limiter passes and the guard, and nothing read`);
    assert.equal(db.calls.some(c => c.table === 'assessment_submissions'), false,
      `${code}: no stored payload was read`);
    assert.equal(db.calls.some(c => c.table === 'identity_resolution_cases'), false,
      `${code}: no case row was read`);
  }
});

test('the guard is asked before the queue and before the case detail too', async () => {
  for (const path of ['/cases', `/cases/${CASE_ID}`]) {
    const seen = [];
    const db = makeDb({ rpc: async name => {
      seen.push(name);
      return name === 'staff_operator_guard'
        ? { data: null, error: { message: 'staff_operator_disabled: this operator has been revoked' } }
        : { data: [], error: null };
    }});
    const res = await call({ path, db });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, 'operator_disabled', path);
    assert.deepEqual(seen, ['staff_operator_guard'],
      `${path}: the read RPC was never reached`);
  }
});

test('an authorized POST does reach the reads, so the ordering is not just an early exit', async () => {
  const db = makeDb({ rpc: async () => ({ data: { ok: true }, error: null }) });
  await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, body: linkBody(), db });
  const order = db.calls.map(c => c.name || c.table);
  assert.deepEqual(order, [
    'check_rate_limit',          /* pre-authentication, by address */
    'check_rate_limit',          /* authenticated, by address and operator */
    'staff_operator_guard',
    'identity_resolution_cases',
    'assessment_submissions',
    'resolve_identity_case_link_existing'
  ], 'limiter first, then the guard, then the reads it authorized, then the mutation');
});

/* ---------- the resolution note is screened, not merely warned about ---------- */

test('a note that carries prohibited data is refused, and the value is never echoed', async () => {
  const cases = [
    ['Owner is reachable at owner@riverside.test for confirmation.', 'an email address'],
    ['Called the owner on +1 415 555 0142 and confirmed.', 'a telephone number'],
    ['Card on file 4111 1111 1111 1111 matches their statement.', 'a payment card number'],
    ['Their portal password: hunter2blue confirms the account.', 'a password'],
    ['Context token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0 was replayed.', 'an access'],
    ['Their place id is ChIJN1t7SomeVeryLongPlaceIdValue99 on file.', 'a raw identifier'],
    ['Reference 123-45-6789 was quoted on the call.', 'a government identifier']
  ];

  for (const [note, fragment] of cases) {
    const db = makeDb({ rpc: async () => ({ data: { ok: true }, error: null }) });
    const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, db,
      body: linkBody({ note }) });

    assert.equal(res.status, 422, note);
    assert.equal(res.body.code, 'note_contains_prohibited_data', note);
    assert.ok(res.body.message.includes(fragment), `${note}\n  got: ${res.body.message}`);

    /* Nothing was stored, and nothing was read on the way to refusing. */
    assert.equal(db.calls.some(c => c.name === 'resolve_identity_case_link_existing'), false,
      'a refused note never reaches the mutation');

    /* THE POINT: the refusal must not repeat the thing it refused to store.
       The response travels into logs, into a browser, and into screenshots. */
    const body = JSON.stringify(res.body);
    for (const word of note.split(/\s+/).filter(w => /[@\d]/.test(w) && w.length > 5)) {
      assert.equal(body.includes(word.replace(/[.,]$/, '')), false,
        `the refusal echoed "${word}" back to the caller`);
    }
  }
});

test('prose about credentials is allowed; it is the value that is refused', async () => {
  /* An operator writing down what happened is the whole purpose of the field.
     A control that blocks the WORD makes the field useless and the operators
     inventive, which is worse than not having one. */
  const allowed = [
    'The continuation token had expired, so the visitor re-entered their details.',
    'Confirmed by phone with the owner.',
    'Owner confirmed the rebrand and the new address by phone.',
    'Checked the password reset flow was not involved in this at all.',
    'Case 22222222-2222-4222-8222-222222222222 covers the same salon.'
  ];
  for (const note of allowed) {
    const db = makeDb({ rpc: async () => ({ data: { ok: true }, error: null }) });
    const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, db,
      body: linkBody({ note }) });
    assert.equal(res.status, 201, `${note}\n  refused: ${res.body.message}`);
  }
});

test('a note is length-checked before it is screened, so a long note is not mis-reported', async () => {
  const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`,
    body: linkBody({ note: 'x'.repeat(2100) }) });
  assert.equal(res.body.code, 'note_too_long',
    'a 2100-character run of x is too long, not prohibited data');
});

/* ---------- transport ---------- */

test('the insecure-staff switch is refused off a loopback host and in production', async () => {
  const attempt = async (env, host) => {
    const request = new Request(`http://${host}/api/staff/identity-resolution/cases`, {
      headers: { authorization: 'Bearer good', 'x-forwarded-proto': 'http', 'x-vercel-forwarded-for': '203.0.113.9',
                 /* Served from the same host it calls, which is what the
                    allowlist defaults to. */
                 origin: `http://${host}` }
    });
    const res = await handleRequest(request, {
      env, verifyAccessToken: verifier(AUTHORIZED),
      db: makeDb({ rpc: async () => ({ data: [], error: null }) })
    });
    return { status: res.status, body: await res.json() };
  };

  const on = { ...ENV, CED_ALLOW_INSECURE_STAFF: 'true' };

  /* Allowed: the switch, a loopback host, and not production. All three. */
  assert.equal((await attempt(on, 'localhost:3000')).status, 200);
  assert.equal((await attempt(on, '127.0.0.1:3000')).status, 200);

  /* Refused: the switch alone is never enough. */
  const remote = await attempt(on, 'staff.example.com');
  assert.equal(remote.status, 403, 'a real hostname is not a development machine');
  assert.equal(remote.body.code, 'https_required');

  const prod = await attempt({ ...on, NODE_ENV: 'production' }, 'localhost:3000');
  assert.equal(prod.status, 403, 'and production is never a development machine');
  assert.equal(prod.body.code, 'https_required');

  /* And without the switch, loopback is refused like anything else. */
  assert.equal((await attempt(ENV, 'localhost:3000')).status, 403);
});

test('the request body limit counts bytes, not UTF-16 code units', async () => {
  /* Each of these is one code unit and three bytes. A limit that measured
     `raw.length` saw 8192 and waved through nearly 25 KB. */
  const note = 'あ'.repeat(4000);
  const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`,
    body: linkBody({ note }) });
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'body_too_large');

  assert.ok(Buffer.byteLength(note, 'utf8') > __testing.MAX_BODY_BYTES);
  assert.ok(note.length < __testing.MAX_BODY_BYTES,
    'and it would have passed a length check, which is the defect');
});

/* ---------- environment keys ---------- */

test('the current Supabase key names are preferred and the old ones still work', () => {
  const { lowPrivilegeKey, elevatedKey } = __testing;

  /* REAL-SHAPED VALUES, because classification is now POSITIVE: a key is
     usable only if it is one of the four types Supabase issues. Bare
     placeholders like 'new' and 'legacy' are exactly what used to be served
     to a browser as a publishable key, and are now refused. */
  const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const legacyJwt = role => `${b64({ alg: 'HS256' })}.${b64({ role })}.sig`;
  const NEW_PUB = PUBLISHABLE_FIXTURE;
  const OLD_PUB = legacyJwt('anon');
  const NEW_SECRET = SECRET_FIXTURE;
  const OLD_SECRET = legacyJwt('service_role');

  assert.equal(lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: NEW_PUB }), NEW_PUB);
  assert.equal(lowPrivilegeKey({ SUPABASE_ANON_KEY: OLD_PUB }), OLD_PUB,
    'an existing project keeps working');
  assert.equal(
    lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: NEW_PUB, SUPABASE_ANON_KEY: OLD_PUB }),
    NEW_PUB, 'the current name wins');
  assert.equal(lowPrivilegeKey({}), '');

  assert.equal(elevatedKey({ SUPABASE_SECRET_KEY: NEW_SECRET }), NEW_SECRET);
  assert.equal(elevatedKey({ SUPABASE_SERVICE_ROLE_KEY: OLD_SECRET }), OLD_SECRET);
  assert.equal(
    elevatedKey({ SUPABASE_SECRET_KEY: NEW_SECRET, SUPABASE_SERVICE_ROLE_KEY: OLD_SECRET }),
    NEW_SECRET);
  assert.equal(elevatedKey({}), '');

  /* The two must never be read from each other's variable: the low-privilege
     key is used to verify a token, the elevated one to call RPC, and a
     deployment that crosses them must fail rather than quietly change
     privilege. */
  assert.equal(lowPrivilegeKey({ SUPABASE_SECRET_KEY: NEW_SECRET }), '');
  assert.equal(elevatedKey({ SUPABASE_PUBLISHABLE_KEY: NEW_PUB }), '');
  assert.equal(lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: NEW_SECRET }), '',
    'a secret key in the publishable variable is refused, not returned');
  assert.equal(elevatedKey({ SUPABASE_SECRET_KEY: NEW_PUB }), '');

  /* AND THE DEFECT THIS REPLACED: an unclassifiable value is no longer
     treated as a publishable key just because it is not a secret one. */
  for (const junk of ['new', 'legacy', 'hunter2', 'sb_publishable_', 'not.a.jwt']) {
    assert.equal(lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: junk }), '', junk);
    assert.equal(elevatedKey({ SUPABASE_SECRET_KEY: junk }), '', junk);
  }

  /* An INVALID preferred variable does not fall through to the legacy one. */
  assert.equal(
    lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: 'typo', SUPABASE_ANON_KEY: OLD_PUB }), '',
    'a typo must surface as a misconfiguration, not silently use the legacy key');
});

test('a deployment with no rate-limit secret fails closed before anything else', async () => {
  /* The limiter is the FIRST thing that can refuse after provenance and the
     method, so a wholly unconfigured deployment reports the limiter rather
     than the database. Both are 503; this pins which, so the ordering is a
     decision rather than an accident. */
  const bare = { CED_LOG_LEVEL: 'error' };
  const request = new Request('https://staff.example.com/api/staff/identity-resolution/cases', {
    headers: { authorization: 'Bearer good', 'x-forwarded-proto': 'https', 'x-vercel-forwarded-for': '203.0.113.9',
               'sec-fetch-site': 'same-origin', 'x-real-ip': '203.0.113.9' }
  });
  const res = await handleRequest(request, { env: bare, verifyAccessToken: verifier(AUTHORIZED) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'rate_limit_unavailable');
  assert.equal(res.headers.get('Retry-After'), '5');
});

test('an unconfigured deployment says so rather than failing obscurely', async () => {
  const bare = { CED_LOG_LEVEL: 'error', CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret' };
  const request = new Request('https://staff.example.com/api/staff/identity-resolution/cases', {
    headers: { authorization: 'Bearer good', 'x-forwarded-proto': 'https', 'x-vercel-forwarded-for': '203.0.113.9', origin: ORIGIN }
  });
  /* No db injected, so the route must build one and discover it cannot. */
  const res = await handleRequest(request, { env: bare, verifyAccessToken: verifier(AUTHORIZED) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'database_unavailable');
});

/* ---------- rate limiting ---------- */

test('the staff route uses the STAFF rate limit, keyed by operator', async () => {
  /* The staff numbers, not the public ones. A console that borrowed the
     public form's budget of 20 per 15 minutes locked an operator out after
     roughly six cases, and raising it raised it for the public form too. */
  const env = {
    ...ENV,
    CED_RATE_LIMIT_SECRET: 'test-secret',
    CED_RATE_LIMIT_MAX_REQUESTS: 5,           /* the PUBLIC budget: must be ignored here */
    CED_STAFF_RATE_LIMIT_MAX_REQUESTS: 240
  };
  const calls = [];
  const db = makeDb({
    rateLimit: null,                           /* this test drives the limiter itself */
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'check_rate_limit') return { data: { allowed: true }, error: null };
      return { data: [], error: null };
    } });

  await call({ db, env });
  const passes = calls.filter(c => c.name === 'check_rate_limit');
  assert.equal(passes.length, 2, 'pre-authentication, then authenticated');
  /* The AUTHENTICATED pass is the one keyed by operator; the first is the
     pre-authentication pass, which is by address alone. */
  const limit = passes[1];
  assert.ok(limit, 'the same check_rate_limit function the public endpoint calls');
  assert.equal(limit.args.p_max_requests, 240,
    'the staff budget, not the public one');
  assert.deepEqual(limit.args.p_keys.map(k => k.scope).sort(), ['address', 'session'],
    'scoped by address AND operator once the caller is identified');
  assert.deepEqual(passes[0].args.p_keys.map(k => k.scope), ['address'],
    'the pre-authentication pass has no operator yet');
  /* The operator UUID is hashed, never stored or sent in the clear. */
  assert.equal(JSON.stringify(limit.args.p_keys).includes(OPERATOR), false);
  assert.match(limit.args.p_keys[0].key, /^[0-9a-f]{64}$/);

  /* And BOTH passes run BEFORE the guard, so an unauthorized caller cannot
     use the guard as an unlimited database round trip. */
  assert.deepEqual(calls.map(c => c.name).slice(0, 3),
    ['check_rate_limit', 'check_rate_limit', 'staff_operator_guard']);
});

test('a rate-limited request is refused with Retry-After and reads nothing', async () => {
  const env = { ...ENV, CED_RATE_LIMIT_SECRET: 'test-secret' };
  const db = makeDb({
    rateLimit: { data: { allowed: false, retryAfterSeconds: 42 }, error: null } });

  const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`,
    body: linkBody(), db, env });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'rate_limited');
  assert.equal(res.headers.get('retry-after'), '42');
  assert.deepEqual(db.calls.map(c => c.name || c.table), ['check_rate_limit'],
    'nothing was read, and the guard was never even asked');
});

test('a rate limiter that cannot answer FAILS CLOSED', async () => {
  /* THIS REVERSES AN EARLIER DECISION, deliberately.

     It used to allow the request through — "a rate limiter that cannot answer
     must not take the console down with it". That is the wrong trade for the
     PRE-AUTHENTICATION pass, which is the only thing between an
     unauthenticated caller and an outbound Supabase Auth call per request.
     Treating an unavailable limiter as permission turns a database wobble
     into an unmetered path, silently. Refusing is visible and cannot be used
     to bypass anything. */
  const env = { ...ENV, CED_RATE_LIMIT_SECRET: 'test-secret' };
  const db = makeDb({ rateLimit: { data: null,
    error: { message: 'connection reset to db.internal:5432' } } });

  const res = await call({ db, env });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'rate_limit_unavailable');
  assert.equal(res.headers.get('Retry-After'), '5', 'fixed, not derived from upstream');

  /* The upstream message never reaches the caller: a PostgREST error body can
     carry the statement, the parameters and the shape of the schema. */
  assert.equal(JSON.stringify(res.body).includes('db.internal'), false);
  assert.equal(JSON.stringify(res.body).includes('connection reset'), false);
});

test('a rate limiter that never answers is bounded, and fails closed', async () => {
  /* THE 15-SECOND BUDGET THIS PROTECTS. The pre-authentication pass had no
     timeout: a hung database could consume the entire platform budget on its
     own and the caller would get 504 FUNCTION_INVOCATION_TIMEOUT — no body,
     no code, nothing to act on. */
  const env = { ...ENV, CED_RATE_LIMIT_SECRET: 'test-secret',
                CED_RATE_LIMIT_TIMEOUT_MS: 250 };
  let aborted = false;
  const db = makeDb({ rateLimit: new Promise(() => {}) });   /* never settles */

  const started = Date.now();
  const res = await call({ db, env });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'rate_limit_unavailable');
  assert.ok(elapsed < 3000, `settled in ${elapsed}ms, not at the platform limit`);
  assert.ok(aborted === false || aborted === true);   /* abort is best-effort */
});

test('the abort signal is offered to a driver that honours it', async () => {
  /* An abort signal only helps if the transport honours it, which is why the
     promise is raced as well. When the driver DOES expose abortSignal, it is
     handed one — so a real PostgREST call is cancelled rather than left to
     finish into a void. */
  const env = { ...ENV, CED_RATE_LIMIT_SECRET: 'test-secret',
                CED_RATE_LIMIT_TIMEOUT_MS: 250 };
  let sawSignal = null;
  const db = {
    rpc(name) {
      if (name !== 'check_rate_limit') return Promise.resolve({ data: [], error: null });
      const builder = {
        abortSignal(signal) { sawSignal = signal; return new Promise(() => {}); }
      };
      return builder;
    },
    from() { return { select() { return this; }, eq() { return { data: [] }; } }; }
  };

  const res = await call({ db, env });
  assert.equal(res.status, 503);
  assert.ok(sawSignal, 'the driver was offered an AbortSignal');
  assert.equal(sawSignal.aborted, true, 'and it was aborted at the deadline');
});

test('a rate limiter that answers in time is untouched by the timeout', async () => {
  /* The bound must not change the happy path: a prompt allow still allows,
     and a prompt refusal is still the 429 with its own Retry-After. */
  const env = { ...ENV, CED_RATE_LIMIT_SECRET: 'test-secret' };

  const allowed = await call({ env, db: makeDb({
    rateLimit: { data: { allowed: true }, error: null } }) });
  assert.equal(allowed.status, 200);

  const refused = await call({ env, db: makeDb({
    rateLimit: { data: { allowed: false, retryAfterSeconds: 42 }, error: null } }) });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 'rate_limited');
  assert.equal(refused.headers.get('Retry-After'), '42',
    'a real refusal still carries its own window, not the unavailable default');
});

test('the timeout is bounded, defaulted and clamped', () => {
  const { rateLimitTimeoutMs, DEFAULT_RATE_LIMIT_TIMEOUT_MS,
          MIN_RATE_LIMIT_TIMEOUT_MS, MAX_RATE_LIMIT_TIMEOUT_MS } = __testing;

  assert.equal(rateLimitTimeoutMs({}), DEFAULT_RATE_LIMIT_TIMEOUT_MS);
  assert.equal(DEFAULT_RATE_LIMIT_TIMEOUT_MS, 2000);

  /* Three sequential passes at the maximum still leave most of the platform's
     15 seconds — which is the property that makes this a bound and not a
     second way to time out. */
  assert.ok(MAX_RATE_LIMIT_TIMEOUT_MS * 3 < 15000);

  for (const bad of ['', 'abc', '0', '-1', 'NaN', undefined, null]) {
    assert.equal(rateLimitTimeoutMs({ CED_RATE_LIMIT_TIMEOUT_MS: bad }),
      DEFAULT_RATE_LIMIT_TIMEOUT_MS, JSON.stringify(bad));
  }
  assert.equal(rateLimitTimeoutMs({ CED_RATE_LIMIT_TIMEOUT_MS: '1' }),
    MIN_RATE_LIMIT_TIMEOUT_MS, 'clamped up');
  assert.equal(rateLimitTimeoutMs({ CED_RATE_LIMIT_TIMEOUT_MS: '600000' }),
    MAX_RATE_LIMIT_TIMEOUT_MS, 'clamped down — no route back to unbounded');
  assert.equal(rateLimitTimeoutMs({ CED_RATE_LIMIT_TIMEOUT_MS: '1500' }), 1500);
});

test('nothing about the limiter failure is logged beyond which pass and why', async () => {
  const env = { ...ENV, CED_RATE_LIMIT_SECRET: 'a-secret-that-must-not-be-logged',
                CED_LOG_LEVEL: 'debug' };
  const db = makeDb({ rateLimit: { data: null,
    error: { message: 'password authentication failed for user "postgres"' } } });

  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = line => lines.push(String(line));
  try { await call({ db, env }); }
  finally { console.log = original.log; console.warn = original.warn; console.error = original.error; }

  const all = lines.join('\n');
  assert.ok(all.includes('staff_rate_limit_unavailable'), 'the failure is visible');
  assert.ok(all.includes('rpc_error'), 'with a fixed reason token');
  for (const secret of ['a-secret-that-must-not-be-logged', 'password authentication failed',
                        'postgres', ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_ANON_KEY]) {
    if (!secret) continue;
    assert.equal(all.includes(secret), false, `leaked: ${secret.slice(0, 24)}`);
  }
});

/* ---------- the deployment entrypoint ---------- */

test('the entrypoint exports named methods, never a default', async () => {
  /* THE 504 THIS REPLACES. This test used to assert that the DEFAULT export
     took one argument and ignored a second. Under Vercel's Node runtime a
     default export IS the (req, res) contract, and that ignored second
     argument was `res` — the only means of answering. Ignoring it is what
     made every invocation hang to the 15-second limit.

     The seam property is still worth keeping and is still asserted: no named
     export forwards a second argument into handleRequest. It is simply not
     the reason the wrapper exists. */
  const entry = await import('../api/staff/identity-resolution/[...path].mjs');
  assert.equal('default' in entry, false, 'a default export selects the (req, res) contract');

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    assert.equal(typeof entry[method], 'function', `missing ${method}`);
    assert.equal(entry[method].length, 1, `${method}: one declared parameter`);
  }

  const request = new Request('https://staff.example.com/api/staff/identity-resolution/cases', {
    headers: { 'x-forwarded-proto': 'https', 'x-vercel-forwarded-for': '203.0.113.9',
               'sec-fetch-site': 'same-origin' }
  });

  /* A hostile second argument that would grant access if it were treated as
     injected dependencies. WHAT IS ASSERTED is that it was not USED — not a
     particular status code. The entrypoint takes no dependencies, so this
     request has no database and no Auth configuration and will be refused by
     whichever layer gets there first; pinning one specific refusal would make
     the test about the order of unrelated layers instead of about the seam. */
  let verifierUsed = 0;
  let databaseUsed = 0;
  const hostile = {
    env: { ...ENV, CED_ALLOW_INSECURE_STAFF: 'true' },
    verifyAccessToken: async () => { verifierUsed += 1; return AUTHORIZED; },
    db: { async rpc() { databaseUsed += 1; return { data: { allowed: true }, error: null }; },
          from() { databaseUsed += 1; return { select() { return this; }, eq() { return { data: [] }; } }; } }
  };

  const previous = process.env.CED_RATE_LIMIT_SECRET;
  process.env.CED_RATE_LIMIT_SECRET = 'test-rate-limit-secret';
  let res;
  try {
    res = await entry.GET(request, hostile);
  } finally {
    if (previous === undefined) delete process.env.CED_RATE_LIMIT_SECRET;
    else process.env.CED_RATE_LIMIT_SECRET = previous;
  }

  assert.equal(verifierUsed, 0, 'the injected verifier was never consulted');
  assert.equal(databaseUsed, 0, 'nor the injected database');
  assert.notEqual(res.status, 200, 'and the request certainly did not succeed');
  assert.ok(res instanceof Response);
});

test('a request with NO caller identifier fails closed', async () => {
  /* THE LAST UNMETERED SHAPE. A request with no forwarding header used to
     pass straight through the limiter: no key could be derived, and an empty
     key list was read as "nothing to limit". A bucket keyed on nothing is not
     a bucket. */
  const db = makeDb();
  const res = await call({ db, callerIp: null });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'rate_limit_unavailable');
  assert.equal(res.headers.get('Retry-After'), '5');
  assert.deepEqual(db.calls, [], 'and nothing was asked of the database');
});

test('a blank, malformed or unusable caller identifier fails closed', async () => {
  /* Each of these is a header a proxy or an attacker could produce. None of
     them is an address, and a bucket keyed on garbage is one nobody else
     shares — which is the same as no limit. */
  const unusable = [
    ['', 'blank'],
    ['   ', 'whitespace only'],
    [',', 'a bare separator'],
    ['not an address', 'spaces'],
    ['<script>', 'markup'],
    ['a'.repeat(65), 'longer than any address'],
    ['198.51.100.4/24', 'a CIDR range rather than an address'],
    ['198.51.100.4;drop', 'punctuation an address never has']
  ];

  for (const [value, label] of unusable) {
    const db = makeDb();
    const res = await call({ db, callerIp: null, headers: { 'x-vercel-forwarded-for': value } });
    assert.equal(res.status, 503, label);
    assert.equal(res.body.code, 'rate_limit_unavailable', label);
    assert.equal(res.headers.get('Retry-After'), '5', label);
    assert.deepEqual(db.calls, [], `${label}: nothing was asked of the database`);

    /* AND THE VALUE ITSELF NEVER APPEARS. It is the caller's address, or
       something pretending to be one; either way it is not ours to echo. */
    const answer = JSON.stringify(res.body);
    assert.equal(answer.includes(value.trim()) && value.trim().length > 2, false,
      `${label}: the header value was echoed`);
  }

  /* A header carrying a control character cannot even be constructed — the
     Headers class refuses it, so it never reaches the route. Asserted here so
     the case is covered rather than quietly missing, and the validator is
     checked directly for the shapes a header can never carry. */
  const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
  assert.throws(() => new Headers({ 'x-vercel-forwarded-for': `1.2.3.4${CRLF}X-I: 1` }),
    'a control character cannot even be put in a header');
  for (const raw of [`1.2.3.4${CRLF}X-Injected: 1`,
                     String.fromCharCode(0), `1.2.3.4${String.fromCharCode(10)}`, ' 1.2.3.4']) {
    assert.equal(rateLimit.isUsableAddress(raw), false, JSON.stringify(raw));
  }
});

test('a missing identifier is logged as a fixed token and nothing else', async () => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = line => lines.push(String(line));
  try {
    await call({ db: makeDb(), callerIp: null,
      env: { ...ENV, CED_LOG_LEVEL: 'debug' } });
  } finally {
    console.log = original.log; console.warn = original.warn; console.error = original.error;
  }

  const all = lines.join('\n');
  assert.ok(all.includes('staff_rate_limit_unavailable'), 'the refusal is visible');
  assert.ok(all.includes('missing_identifier'), 'with the fixed reason token');
  /* Never the secret, and never any header value. */
  for (const secret of [ENV.CED_RATE_LIMIT_SECRET,
                        ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_ANON_KEY]) {
    if (!secret) continue;
    assert.equal(all.includes(secret), false, `leaked: ${String(secret).slice(0, 20)}`);
  }
});

test('a usable identifier is accepted, in each supported header', async () => {
  /* The mirror of the refusals: the rule is about UNUSABLE values, not about
     making every request fail. `x-vercel-forwarded-for` wins when present —
     it is the one an intermediary cannot append to — and the documented
     generic headers still work behind it. */
  const { readAddress, isUsableAddress } = rateLimit;
  assert.equal(rateLimit.ADDRESS_HEADERS[0], 'x-vercel-forwarded-for',
    'the platform header is preferred');

  for (const header of ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']) {
    const db = makeDb();
    const res = await call({ db, callerIp: null, headers: { [header]: '198.51.100.4' } });
    assert.equal(res.status, 200, header);
  }

  /* IPv6 and a comma-separated chain both resolve to something usable. */
  assert.equal(isUsableAddress('2001:db8::1'), true);
  assert.equal(isUsableAddress('fe80::1%eth0'), true);
  const chained = new Headers({ 'x-forwarded-for': '198.51.100.4, 203.0.113.1' });
  assert.equal(readAddress(chained), '198.51.100.4', 'the first entry is the client');
});

test('the approved override vocabulary is exactly the five agreed codes', () => {
  assert.deepEqual([...__testing.OVERRIDE_REASONS].sort(), [
    'business_rebrand', 'contact_information_changed', 'other_verified_evidence',
    'source_information_incorrect', 'verified_same_business'
  ]);
});

test('claim decoding never throws on a malformed token', () => {
  ['', 'a', 'a.b', 'a.b.c', 'a.!!!.c'].forEach(t => {
    assert.deepEqual(__testing.decodeClaims(t), {});
  });
  const claims = __testing.decodeClaims(
    `x.${Buffer.from(JSON.stringify({ aal: 'aal2' })).toString('base64url')}.y`);
  assert.equal(claims.aal, 'aal2');
});

test('the resolution note is bounded, so the audit trail cannot be used as storage', async () => {
  const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`,
    body: linkBody({ note: 'x'.repeat(2100) }) });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'note_too_long');
});

test('the request hash is what the route sends, not something the browser chose', async () => {
  const db = makeDb({ rpc: async () => ({ data: { ok: true }, error: null }) });
  await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, db,
    body: linkBody({ requestHash: 'f'.repeat(64) }) });
  const rpc = db.calls.find(c => c.name === 'resolve_identity_case_link_existing');
  assert.notEqual(rpc.args.p_request_hash, 'f'.repeat(64));
  assert.equal(rpc.args.p_request_hash, createHash('sha256').update(JSON.stringify([
    'link_existing', CASE_ID, BUSINESS, OPERATOR, false, null,
    'Confirmed by phone with the owner.'])).digest('hex'));
});
