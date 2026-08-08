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

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '22222222-2222-4222-8222-222222222222';
const BUSINESS = '33333333-3333-4333-8333-333333333333';
const SUBMISSION = '44444444-4444-4444-8444-444444444444';

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-never-real',
  SUPABASE_SERVICE_ROLE_KEY: 'service-never-real',
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
const makeDb = ({ rpc = async () => ({ data: null, error: null }), submission } = {}) => {
  const calls = [];
  return {
    calls,
    async rpc(name, args) { calls.push({ name, args }); return rpc(name, args); },
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

const call = async ({ method = 'GET', path = '/cases', token = 'good', body,
                      verify, db, env = ENV, headers = {}, authClient,
                      origin, fetchSite = 'same-origin', rawBody } = {}) => {
  /* `undefined` defers to the method; `null` means explicitly none. */
  const effectiveOrigin = origin === undefined
    ? (['GET', 'HEAD'].includes(method) ? null : ORIGIN)
    : origin;
  const request = new Request(`https://staff.example.com/api/staff/identity-resolution${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-proto': 'https',
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
  assert.deepEqual(db.calls, [], 'nothing was read on an unauthenticated request');
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

    /* The guard, and nothing else. No `from()` call was recorded — those push
       a {table, value} entry — and the mutation was never reached. */
    assert.deepEqual(db.calls.map(c => c.name || c.table), ['staff_operator_guard'],
      `${code}: nothing was read on an unauthorized request`);
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
    'staff_operator_guard',
    'identity_resolution_cases',
    'assessment_submissions',
    'resolve_identity_case_link_existing'
  ], 'guard first, then the reads it authorized, then the mutation');
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
      headers: { authorization: 'Bearer good', 'x-forwarded-proto': 'http',
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

  assert.equal(lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: 'new' }), 'new');
  assert.equal(lowPrivilegeKey({ SUPABASE_ANON_KEY: 'legacy' }), 'legacy',
    'an existing project keeps working');
  assert.equal(lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: 'new', SUPABASE_ANON_KEY: 'legacy' }),
    'new', 'the current name wins');
  assert.equal(lowPrivilegeKey({}), '');

  assert.equal(elevatedKey({ SUPABASE_SECRET_KEY: 'new' }), 'new');
  assert.equal(elevatedKey({ SUPABASE_SERVICE_ROLE_KEY: 'legacy' }), 'legacy');
  assert.equal(elevatedKey({ SUPABASE_SECRET_KEY: 'new', SUPABASE_SERVICE_ROLE_KEY: 'legacy' }),
    'new');
  assert.equal(elevatedKey({}), '');

  /* The two must never be read from each other's variable: the low-privilege
     key is used to verify a token, the elevated one to call RPC, and a
     deployment that crosses them must fail rather than quietly change
     privilege. */
  assert.equal(lowPrivilegeKey({ SUPABASE_SECRET_KEY: 'secret' }), '');
  assert.equal(elevatedKey({ SUPABASE_PUBLISHABLE_KEY: 'publishable' }), '');
});

test('an unconfigured deployment says so rather than failing obscurely', async () => {
  const bare = { CED_LOG_LEVEL: 'error' };
  const request = new Request('https://staff.example.com/api/staff/identity-resolution/cases', {
    headers: { authorization: 'Bearer good', 'x-forwarded-proto': 'https', origin: ORIGIN }
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
  const db = makeDb({ rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'check_rate_limit') return { data: { allowed: true }, error: null };
    return { data: [], error: null };
  }});

  await call({ db, env });
  const limit = calls.find(c => c.name === 'check_rate_limit');
  assert.ok(limit, 'the same check_rate_limit function the public endpoint calls');
  assert.equal(limit.args.p_max_requests, 240,
    'the staff budget, not the public one');
  assert.deepEqual(limit.args.p_keys.map(k => k.scope).sort(), ['session'],
    'scoped by operator; no address header was sent in this request');
  /* The operator UUID is hashed, never stored or sent in the clear. */
  assert.equal(JSON.stringify(limit.args.p_keys).includes(OPERATOR), false);
  assert.match(limit.args.p_keys[0].key, /^[0-9a-f]{64}$/);

  /* And it runs BEFORE the guard, so an unauthorized caller cannot use the
     guard as an unlimited database round trip. */
  assert.equal(calls[0].name, 'check_rate_limit');
  assert.equal(calls[1].name, 'staff_operator_guard');
});

test('a rate-limited request is refused with Retry-After and reads nothing', async () => {
  const env = { ...ENV, CED_RATE_LIMIT_SECRET: 'test-secret' };
  const db = makeDb({ rpc: async name =>
    name === 'check_rate_limit'
      ? { data: { allowed: false, retryAfterSeconds: 42 }, error: null }
      : { data: [], error: null } });

  const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`,
    body: linkBody(), db, env });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'rate_limited');
  assert.equal(res.headers.get('retry-after'), '42');
  assert.deepEqual(db.calls.map(c => c.name || c.table), ['check_rate_limit'],
    'nothing was read, and the guard was never even asked');
});

test('a rate limiter that cannot answer does not take the console down', async () => {
  const env = { ...ENV, CED_RATE_LIMIT_SECRET: 'test-secret' };
  const db = makeDb({ rpc: async name =>
    name === 'check_rate_limit'
      ? { data: null, error: { message: 'connection reset' } }
      : { data: [], error: null } });

  const res = await call({ db, env });
  assert.equal(res.status, 200, 'the remaining layers still apply');
});

/* ---------- the deployment entrypoint ---------- */

test('the default export takes one argument and ignores a second', async () => {
  /* handleRequest's second parameter is the test injection seam. The
     entrypoint must not forward whatever the platform passes second into it:
     `deps.env`, `deps.db`, `deps.authClient` and `deps.verifyAccessToken`
     would all be read off it.

     Imported from the DEPLOYMENT ENTRYPOINT, which is now the only module
     that has a default export at all — the implementation lives outside api/
     and exports no handler, so it cannot be deployed as a second function. */
  const { default: entrypoint } = await import('../api/staff/identity-resolution/[...path].mjs');
  assert.equal(entrypoint.length, 1, 'one declared parameter');

  const request = new Request('https://staff.example.com/api/staff/identity-resolution/cases', {
    headers: { 'x-forwarded-proto': 'https', origin: ORIGIN }
  });
  /* A hostile second argument that would grant access if it were treated as
     injected dependencies. The origin is valid so the request reaches the
     token check — a 403 here would prove only that it stopped earlier. */
  const hostile = {
    env: { ...ENV, CED_ALLOW_INSECURE_STAFF: 'true' },
    verifyAccessToken: async () => AUTHORIZED,
    db: makeDb({ rpc: async () => ({ data: [], error: null }) })
  };
  const res = await entrypoint(request, hostile);
  assert.equal(res.status, 401, 'the second argument was not treated as dependencies');
  assert.equal((await res.json()).code, 'unauthenticated');
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
    'link_existing', CASE_ID, BUSINESS, OPERATOR, false, null])).digest('hex'));
});
