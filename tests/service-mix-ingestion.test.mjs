/* ============================================================
   SM-1 — ingestion, identity, and the continuation context
   ------------------------------------------------------------
   The properties these tests exist to hold:

     · Growth and Service Mix attach to ONE Business Record
     · and stay independently current
     · a Service Mix report NEVER supersedes a Growth report
     · a client-supplied businessId is refused, never honoured
     · replay creates nothing
     · an ambiguous standalone review still completes

   docs/SERVICE_MIX_REVIEW.md section 8.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';

import { handleRequest, VERSIONS } from '../api/assessments.mjs';
import continuation from '../shared/security/continuation.js';
import serviceMixBir from '../shared/service-mix-engine/generate-service-mix-bir.js';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload } from './helpers/fixtures.mjs';
import {
  makeServiceMixPayload, makeServiceMixRequest, makePortfolio,
  smDeps, SM_ENV, NOW_MS
} from './helpers/service-mix-fixtures.mjs';

const hmac = (secret, input) => createHmac('sha256', secret).update(input).digest('hex');

const send = async (db, payload, opts = {}, extraDeps = {}) => {
  const res = await handleRequest(makeServiceMixRequest(payload, opts), smDeps(db, extraDeps));
  const body = await res.json().catch(() => null);
  return { res, body };
};

/* A fresh Service Mix payload with its own ids, so several can run against
   one database without colliding on the idempotency key. */
const fresh = (overrides = {}) => makeServiceMixPayload({
  submissionId: randomUUID(),
  assessmentSessionId: randomUUID(),
  serviceMix: { offerings: makePortfolio() },
  ...overrides
});

/* The Service Mix response deliberately carries neither birId nor
   businessId — see api/assessments.mjs. Everything a test needs to assert
   about the stored record is therefore looked up from the database by the
   one identifier the client does get back: its own submission id. */
const reportFor = (db, submissionId) =>
  db.state.business_intelligence_reports.find(r => r.assessment_submission_id === submissionId);
const businessFor = (db, submissionId) =>
  db.state.assessment_submissions.find(s => s.submission_id === submissionId).business_id;

const issue = businessId => continuation.issueContinuationContext({
  businessId, verticalId: 'nails', reviewType: 'growth_review',
  issuedAtMs: NOW_MS, secret: SM_ENV.CED_CONTINUATION_SECRET, hmacFn: hmac
});

/* ---------- it works at all ---------- */

test('a standalone Service Mix review is accepted and stored', async () => {
  const db = createFakeDb();
  const { res, body } = await send(db, fresh());

  assert.equal(res.status, 201);
  assert.equal(body.reviewType, 'service_mix');
  assert.equal(db.state.assessment_submissions.length, 1);
  assert.equal(db.state.assessment_submissions[0].review_type, 'service_mix');
  assert.equal(db.state.assessment_sessions[0].review_type, 'service_mix');

  const [report] = db.state.business_intelligence_reports;
  assert.equal(report.review_type, 'service_mix');
  assert.equal(report.schema_version, 5);
  assert.equal(report.report.reportType, 'service_mix');
});

test('a Service Mix payload declaring a Growth schema version is refused', async () => {
  const db = createFakeDb();
  const { res, body } = await send(db, fresh({ schemaVersion: 5 }));
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'version_review_type_mismatch');
  assert.deepEqual(VERSIONS.PAYLOAD_SCHEMAS_BY_REVIEW.service_mix, [6]);
});

test('a Growth payload declaring the Service Mix version is refused too', async () => {
  const db = createFakeDb();
  const payload = makePayload({ schemaVersion: 6 });
  const res = await handleRequest(makeServiceMixRequest(payload), smDeps(db));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'version_review_type_mismatch');
});

test('an invented review type is refused rather than defaulted', async () => {
  const db = createFakeDb();
  const { res, body } = await send(db, fresh({ reviewType: 'vibes_review' }));
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'unsupported_review_type');
});

test('a Service Mix submission with no serviceMix block is refused', async () => {
  const db = createFakeDb();
  const { res, body } = await send(db, fresh({ serviceMix: undefined }));
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'missing_section');
});

test('offering limits are enforced at the endpoint, not only in the page', async () => {
  const db = createFakeDb();
  const tooFew = await send(db, fresh({ serviceMix: { offerings: makePortfolio().slice(0, 1) } }));
  assert.equal(tooFew.res.status, 422);
  assert.equal(tooFew.body.error.code, 'invalid_service_mix');

  const six = Array.from({ length: 6 }, () => makePortfolio()[0]);
  const tooMany = await send(db, fresh({ serviceMix: { offerings: six } }));
  assert.equal(tooMany.res.status, 422);
});

test('a direct cost the Quick Review never collects is refused', async () => {
  const db = createFakeDb();
  const offerings = makePortfolio();
  offerings[0].directCost = { kind: 'exact', value: 12, low: null, high: null };
  const { res, body } = await send(db, fresh({ serviceMix: { offerings } }));
  assert.equal(res.status, 422);
  assert.ok(['invalid_service_mix', 'direct_cost_not_collected'].includes(body.error.code));
});

test('results delivery consent still gates ingestion', async () => {
  const db = createFakeDb();
  const { res, body } = await send(db, fresh({
    consent: { resultsDeliveryConsent: { granted: false } }
  }));
  assert.equal(res.status, 422);
  assert.equal(body.error.code, 'results_consent_required');
});

/* ---------- one Business Record, two reviews ----------

   Connected by the SERVER-ISSUED continuation context, never by a shared
   session id. Two reviews are two sessions: reusing one under a second
   review type is refused outright, because it would attribute a Service Mix
   submission to a Growth session's funnel and to its first-touch
   attribution. */

/* Completes a Growth Review and returns what the endpoint gave the browser,
   including the context a connected review continues with. */
const growthReview = async (db, overrides = {}) => {
  const res = await handleRequest(
    makeServiceMixRequest(makePayload({
      submissionId: randomUUID(), assessmentSessionId: randomUUID(), ...overrides })),
    smDeps(db));
  const body = await res.json();
  assert.equal(res.status, 201, 'the Growth Review must succeed for the rest to mean anything');
  return body;
};

/* A connected Service Mix review: its own session, the context in a header. */
const connectedMix = (db, token, overrides = {}) =>
  send(db, fresh({ assessmentSessionId: randomUUID(), ...overrides }),
    { extraHeaders: { 'X-CED-Continuation': token } });

test('a session may not be reused under a second review type', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();

  await handleRequest(
    makeServiceMixRequest(makePayload({ submissionId: randomUUID(), assessmentSessionId: sessionId })),
    smDeps(db));

  const { res, body } = await send(db, fresh({ assessmentSessionId: sessionId }));
  assert.equal(res.status, 502, 'the ingestion refuses it rather than blending two funnels');
  assert.equal(body.error.code, 'ingestion_failed');
  assert.equal(db.state.assessment_submissions.filter(s => s.review_type === 'service_mix').length, 0,
    'and nothing is stored');
});

test('Growth then Service Mix attach to one Business Record through the context', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db);
  assert.ok(growth.continuationToken, 'the endpoint issues a context to continue with');

  const mix = await connectedMix(db, growth.continuationToken);
  assert.equal(mix.res.status, 201);
  assert.equal(businessFor(db, mix.body.submissionId), growth.businessId);
  assert.equal(db.state.business_records.length, 1,
    'a second review must never create a second permanent record');
});

test('Growth and Service Mix reports stay independently current', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db);
  const mix = await connectedMix(db, growth.continuationToken);
  const mixReport = reportFor(db, mix.body.submissionId);

  const states = db.state.business_review_states.filter(s => s.business_id === growth.businessId);
  assert.equal(states.length, 2);
  assert.equal(states.find(s => s.review_type === 'growth_review').current_bir_id, growth.birId);
  assert.equal(states.find(s => s.review_type === 'service_mix').current_bir_id, mixReport.bir_id);

  /* The legacy pointer keeps meaning "the current GROWTH report". */
  const record = db.state.business_records.find(b => b.business_id === growth.businessId);
  assert.equal(record.current_bir_id, growth.birId,
    'a Service Mix report must never displace the Growth pointer');
});

test('the review state records the original and the latest submission separately', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db);
  const first = await connectedMix(db, growth.continuationToken);
  const second = await connectedMix(db, growth.continuationToken);

  const state = db.state.business_review_states
    .find(s => s.business_id === growth.businessId && s.review_type === 'service_mix');

  /* Every approved field, present. */
  ['business_id', 'review_type', 'current_bir_id', 'original_submission_id',
   'latest_submission_id', 'last_completed_at', 'next_reassessment_due_at',
   'next_reassessment_kind', 'updated_at']
    .forEach(field => assert.notEqual(state[field], undefined, `missing ${field}`));

  assert.equal(state.original_submission_id, first.body.submissionId,
    'the original is written once and never moves — it is the root of the chain');
  assert.equal(state.latest_submission_id, second.body.submissionId);
  assert.equal(state.completed_count, 2);
  assert.equal(state.next_reassessment_kind, 'quarterly_review');
  assert.ok(Date.parse(state.next_reassessment_due_at) > Date.parse(state.last_completed_at));
});

test('a Service Mix report never supersedes a Growth report', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db);
  const mix = await connectedMix(db, growth.continuationToken);

  const mixReport = reportFor(db, mix.body.submissionId);
  assert.equal(mixReport.supersedes_bir_id, null,
    'the first report of a review type supersedes nothing, whatever else the business has');
  assert.equal(mixReport.report.provenance.supersedes, null);
});

test('a second Service Mix review supersedes the first, and only the first', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db);
  const first = await connectedMix(db, growth.continuationToken);
  const second = await connectedMix(db, growth.continuationToken);

  const firstReport = reportFor(db, first.body.submissionId);
  const secondReport = reportFor(db, second.body.submissionId);
  assert.equal(secondReport.supersedes_bir_id, firstReport.bir_id);
  assert.equal(secondReport.review_type, 'service_mix');

  /* Everything stays readable. Nothing was rewritten. */
  assert.equal(db.state.business_intelligence_reports.length, 3);
  assert.equal(db.state.assessment_submissions.length, 3);
});

test('a Growth reassessment after a Service Mix review still chains to Growth', async () => {
  const db = createFakeDb();
  const growthSession = randomUUID();
  const firstGrowth = await growthReview(db, { assessmentSessionId: growthSession });
  await connectedMix(db, firstGrowth.continuationToken);

  const secondGrowth = await growthReview(db, { assessmentSessionId: growthSession });
  const report = db.state.business_intelligence_reports
    .find(r => r.bir_id === secondGrowth.birId);
  assert.equal(report.supersedes_bir_id, firstGrowth.birId,
    'the Service Mix report in between must not appear in the Growth chain');
});

/* ---------- the stored Growth reference ---------- */

test('a connected Service Mix report stores the Growth reference, and copies nothing', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db);
  const mix = await connectedMix(db, growth.continuationToken, {
    serviceMix: { prefilledFields: ['salonName', 'email'] }
  });

  const stored = reportFor(db, mix.body.submissionId).report;
  const related = stored.relatedGrowthReview;

  assert.ok(related, 'a connected review must name the Growth report it continues from');
  assert.equal(related.birId, growth.birId);
  assert.equal(related.freshness, 'fresh', 'the Growth report was generated moments ago');
  assert.deepEqual(related.prefilledFields, ['salonName', 'email']);
  assert.equal(related.usedInCalculations, false,
    'no Growth figure enters any Service Mix calculation');

  /* Exactly the five approved fields, and nothing beside them. The field is
     called relatedGrowthReview, so a reviewType saying 'growth_review' would
     restate its own name — and the validator refuses a sixth field. */
  assert.deepEqual(Object.keys(related).sort(),
    ['birId', 'freshness', 'generatedAt', 'prefilledFields', 'usedInCalculations']);

  /* And no Growth analysis crossed over. */
  const text = JSON.stringify(stored);
  assert.equal(/growthScore|closeReadiness|financialOpportunity|packageRecommendation/.test(text), false);


  /* The stored report is still a valid Service Mix BIR after the database
     wrote the reference into it. */
  const validation = serviceMixBir.validateServiceMixBir(stored);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);

  /* The Growth report is untouched. */
  const growthReport = db.state.business_intelligence_reports.find(r => r.bir_id === growth.birId);
  assert.equal(growthReport.supersedes_bir_id, null);
  assert.equal(growthReport.report.relatedGrowthReview, undefined);
});

/* prefilledFields names FIELDS the visitor did not have to retype. It is a
   list of names, and a list of names that accepts any string is a place to
   put a name, an email address, an offering, or a sentence — under a key that
   promises none of them, inside a record that is append-only. So the endpoint
   refuses an unapproved entry outright, and the database filters again. */
test('a malicious prefilledFields list never reaches the submission or the report', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db);

  const smuggled = [
    'owner@example.com',
    'Gel manicure',
    'The owner said she is ready to buy in September if the price drops.',
    '4f9f0e0a-2a9c-4d3a-9d2b-8a1b7c6d5e4f',
    'salonName'
  ];
  const mix = await connectedMix(db, growth.continuationToken, {
    serviceMix: { prefilledFields: smuggled }
  });

  /* Refused at the door: 422, with nothing stored. */
  assert.equal(mix.res.status, 422);
  assert.equal(mix.body.error.code, 'invalid_service_mix');
  assert.ok(mix.body.error.details.violations
    .some(v => v.code === 'unknown_prefilled_field'));

  /* The refusal itself must not become the leak. */
  const responseText = JSON.stringify(mix.body);
  smuggled.slice(0, 4).forEach(value => assert.equal(responseText.includes(value), false,
    'an error response must not echo the value it exists to keep out'));

  /* And nothing was written: one Growth submission, no Service Mix. */
  const everything = JSON.stringify(db.state);
  smuggled.slice(0, 4).forEach(value => assert.equal(everything.includes(value), false));
  assert.equal(db.state.assessment_submissions.filter(s => s.review_type === 'service_mix').length, 0);
  assert.equal(db.state.business_intelligence_reports.filter(r => r.review_type === 'service_mix').length, 0);
});

test('a prefilled entry that slips past the endpoint is still dropped by the database', async () => {
  /* The endpoint is one layer. ingest_review is reachable by a future
     server-to-server caller that never passed through it, so the function
     filters the list against the same enum rather than trusting its input.
     Called directly here, exactly as such a caller would. */
  const db = createFakeDb();
  const growth = await growthReview(db);
  const mix = await connectedMix(db, growth.continuationToken);
  const businessId = businessFor(db, mix.body.submissionId);

  const payload = fresh();
  payload.serviceMix = {
    ...payload.serviceMix,
    prefilledFields: ['owner@example.com', 'email', 'email', 'salonName']
  };

  const direct = await db.rpc('ingest_review', {
    p_idempotency_key: randomUUID(),
    p_request_hash: 'direct-call',
    p_payload: payload,
    p_signals: [],
    p_bir: reportFor(db, mix.body.submissionId).report,
    p_bir_id: randomUUID(),
    p_retention_days: 400,
    p_meta: {},
    p_review_type: 'service_mix',
    p_continuation_business_id: businessId
  });
  assert.equal(direct.error, null);

  const stored = db.state.business_intelligence_reports
    .find(r => r.bir_id === direct.data.birId).report;
  assert.deepEqual(stored.relatedGrowthReview.prefilledFields, ['salonName', 'email'],
    'filtered against the enum, de-duplicated, and in one deterministic order');

  /* Stated plainly: the submission row still holds the payload as it was
     received, because that is what a submission row is. What this layer
     guarantees is that the unapproved entry never becomes part of the
     REPORT — the durable, append-only artefact the platform reasons over.
     Keeping it out of the submission is the endpoint's job, and the test
     above proves the endpoint does it. */
  assert.equal(JSON.stringify(stored).includes('owner@example.com'), false);
});

test('a standalone Service Mix report carries no Growth reference', async () => {
  const db = createFakeDb();
  const mix = await send(db, fresh());
  const stored = reportFor(db, mix.body.submissionId).report;
  assert.equal(stored.relatedGrowthReview, null);
  assert.equal(serviceMixBir.validateServiceMixBir(stored).valid, true);
});

/* ---------- the continuation context ---------- */

test('a client-supplied businessId is deleted, never honoured', async () => {
  const db = createFakeDb();
  const other = randomUUID();
  db.seedBusiness({ businessId: other, displayName: 'Someone Else' });

  const payload = fresh({
    assessmentSessionId: randomUUID(),
    continuation: { continuationToken: null, businessId: other }
  });
  const { res, body } = await send(db, payload);

  assert.equal(res.status, 201);
  assert.notEqual(body.businessId, other,
    'a public form may never name the record it attaches to');

  const stored = db.state.assessment_submissions.find(s => s.submission_id === payload.submissionId);
  assert.equal(stored.raw_payload.continuation.businessId, undefined,
    'the field is removed rather than ignored, so nobody can believe it was honoured');
});

test('a forged or edited context is ignored and the review still completes', async () => {
  const db = createFakeDb();
  const target = randomUUID();
  db.seedBusiness({ businessId: target, displayName: 'Target Salon' });

  const forged = `1.${Buffer.from(JSON.stringify({
    v: 1, businessId: target, verticalId: 'nails', iat: 1, exp: 9999999999
  })).toString('base64url')}.deadbeef`;

  const { res, body } = await send(db, fresh({
    assessmentSessionId: randomUUID(),
    continuation: { continuationToken: forged }
  }));

  assert.equal(res.status, 201, 'a visitor is never punished for a token they cannot see');
  assert.notEqual(body.businessId, target);
  assert.notEqual(body.linkMethod, 'continuation_context');
});

test('an expired context is ignored', async () => {
  const db = createFakeDb();
  const target = randomUUID();
  db.seedBusiness({ businessId: target });

  const expired = continuation.issueContinuationContext({
    businessId: target, verticalId: 'nails', reviewType: 'growth_review',
    issuedAtMs: NOW_MS - 400 * 24 * 60 * 60 * 1000,
    secret: SM_ENV.CED_CONTINUATION_SECRET, hmacFn: hmac, ttlSeconds: 60
  });

  const { res, body } = await send(db, fresh({
    assessmentSessionId: randomUUID(),
    continuation: { continuationToken: expired }
  }));
  assert.equal(res.status, 201);
  assert.notEqual(body.businessId, target);
});

test('a context issued for another vertical does not link', () => {
  const token = continuation.issueContinuationContext({
    businessId: randomUUID(), verticalId: 'hair', reviewType: 'growth_review',
    issuedAtMs: NOW_MS, secret: SM_ENV.CED_CONTINUATION_SECRET, hmacFn: hmac
  });
  const verdict = continuation.verifyContinuationContext({
    token, secret: SM_ENV.CED_CONTINUATION_SECRET, hmacFn: hmac,
    nowMs: NOW_MS, expectedVerticalId: 'nails'
  });
  assert.equal(verdict.status, continuation.OUTCOME.mismatch);
  assert.equal(verdict.businessId, null);
});

test('the token never reaches storage', async () => {
  const db = createFakeDb();
  const token = issue(randomUUID());
  const payload = fresh({
    assessmentSessionId: randomUUID(),
    continuation: { continuationToken: token }
  });
  await send(db, payload);

  const stored = db.state.assessment_submissions.find(s => s.submission_id === payload.submissionId);
  const serialised = JSON.stringify(stored);
  assert.equal(serialised.includes(token), false,
    'a bearer credential must never be stored, exactly as the challenge token is not');
  assert.equal(stored.raw_payload.continuation.continuationPresented, true,
    'only whether one was presented survives');
});

test('a context pointing at a merged-away record does not link', async () => {
  const db = createFakeDb();
  const gone = randomUUID();
  const survivor = randomUUID();
  db.seedBusiness({ businessId: survivor });
  db.seedBusiness({ businessId: gone });
  db.state.business_records.find(b => b.business_id === gone).merged_into_business_id = survivor;

  const { res, body } = await send(db, fresh({
    assessmentSessionId: randomUUID(),
    continuation: { continuationToken: issue(gone) }
  }));
  assert.equal(res.status, 201);
  assert.notEqual(body.businessId, gone);
});

test('with no secret configured, nothing links and everything still works', async () => {
  const db = createFakeDb();
  const { CED_CONTINUATION_SECRET, ...withoutSecret } = SM_ENV;
  const target = randomUUID();
  db.seedBusiness({ businessId: target });

  const res = await handleRequest(
    makeServiceMixRequest(fresh({
      assessmentSessionId: randomUUID(),
      continuation: { continuationToken: issue(target) }
    })),
    { env: withoutSecret, db, now: () => NOW_MS });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.notEqual(body.businessId, target);
  assert.equal(body.continuationToken, undefined,
    'no secret means no context is minted either');
});

/* ---------- idempotency ---------- */

test('replaying a Service Mix submission creates nothing', async () => {
  const db = createFakeDb();
  const payload = fresh();

  const first = await send(db, payload);
  assert.equal(first.res.status, 201);
  assert.equal(first.body.replayed, false);

  const second = await send(db, payload);
  assert.equal(second.res.status, 200);
  assert.equal(second.body.replayed, true);

  assert.equal(db.state.assessment_submissions.length, 1);
  assert.equal(db.state.business_intelligence_reports.length, 1);
  assert.equal(db.state.business_review_states.length, 1);
  assert.equal(db.state.business_review_states[0].completed_count, 1);
});

test('the same key with different content is refused', async () => {
  const db = createFakeDb();
  const payload = fresh();
  await send(db, payload);

  const changed = { ...payload, serviceMix: { ...payload.serviceMix, coverage: 'selected_sample' } };
  const { res, body } = await send(db, changed);
  assert.equal(res.status, 409);
  assert.equal(body.error.code, 'idempotency_key_conflict');
});

/* ---------- ambiguous identity ---------- */

test('an ambiguous standalone review is queued for review and still completes', async () => {
  const db = createFakeDb();
  const placeId = 'ChIJ_ambiguous_service_mix';
  db.seedBusiness({
    businessId: randomUUID(),
    identifiers: [{ type: 'gbp_place_id', normalizedValue: placeId, verified: true }]
  });
  db.seedBusiness({
    businessId: randomUUID(),
    identifiers: [{ type: 'email_exact', normalizedValue: 'owner@polished.test' }]
  });

  const { res, body } = await send(db, fresh({
    assessmentSessionId: randomUUID(),
    contact: { email: 'owner@polished.test' }
  }));

  assert.equal(res.status, 201, 'the review completes and results are still delivered');
  assert.ok(db.state.assessment_submissions.some(s => s.review_type === 'service_mix'));
  if (body.identityStatus === 'resolution_pending') {
    assert.equal(body.businessId, null);
    assert.equal(body.nextAction, 'identity_review_pending');
    assert.ok(db.state.identity_resolution_cases.length >= 1);
    /* A report with no business joins no chain. */
    const report = db.state.business_intelligence_reports.find(r => r.bir_id === body.birId);
    assert.equal(report.supersedes_bir_id, null);
  }
});

/* ---------- the Growth path is untouched ---------- */

test('a Growth submission still reaches ingest_assessment by that name', async () => {
  const db = createFakeDb();
  const seen = [];
  const wrapped = {
    ...db,
    rpc: (name, args) => { seen.push(name); return db.rpc(name, args); }
  };
  await handleRequest(makeServiceMixRequest(makePayload()), smDeps(wrapped));
  assert.ok(seen.includes('ingest_assessment'));
  assert.equal(seen.includes('ingest_review'), false,
    'the Growth path is byte-for-byte what it was, so a queued submission is unaffected');
});

test('a Service Mix submission reaches ingest_review with its review type', async () => {
  const db = createFakeDb();
  const seen = [];
  const wrapped = {
    ...db,
    rpc: (name, args) => { seen.push([name, args.p_review_type]); return db.rpc(name, args); }
  };
  await handleRequest(makeServiceMixRequest(fresh()), smDeps(wrapped));
  const call = seen.find(([name]) => name === 'ingest_review');
  assert.ok(call);
  assert.equal(call[1], 'service_mix');
});

test('the Growth response is unchanged apart from the additions SM-1 declares', async () => {
  const db = createFakeDb();
  const res = await handleRequest(makeServiceMixRequest(makePayload()), smDeps(db));
  const body = await res.json();
  assert.equal(body.reviewType, 'growth_review');
  assert.equal(body.identityStatus, 'linked');
  assert.ok(body.birId);
  const report = db.state.business_intelligence_reports[0];
  assert.equal(report.schema_version, 4, 'a Growth report is still a v4 report');
  assert.equal(report.review_type, 'growth_review');
});
