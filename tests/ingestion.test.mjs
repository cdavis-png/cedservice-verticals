import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handleRequest } from '../api/assessments.mjs';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload, makeRequest, deps } from './helpers/fixtures.mjs';

const send = async (db, payload, reqOpts = {}) => {
  const res = await handleRequest(makeRequest(payload, reqOpts), deps(db));
  return { res, body: await res.json() };
};

const counts = db => ({
  businesses: db.state.business_records.length,
  submissions: db.state.assessment_submissions.length,
  birs: db.state.business_intelligence_reports.length,
  events: db.state.timeline_events.length,
  cases: db.state.identity_resolution_cases.length
});

test('first submission creates exactly one business, submission, BIR and timeline', async () => {
  const db = createFakeDb();
  const { res, body } = await send(db, makePayload());

  assert.equal(res.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.replayed, false);
  assert.equal(body.identityStatus, 'linked');
  assert.equal(body.nextAction, 'results_ready');
  assert.ok(body.businessId);
  assert.ok(body.birId);
  assert.equal(body.assessmentId, body.submissionId);

  const c = counts(db);
  assert.deepEqual({ businesses: c.businesses, submissions: c.submissions, birs: c.birs, cases: c.cases },
    { businesses: 1, submissions: 1, birs: 1, cases: 0 });

  /* assessment.completed and bir.generated are unchanged: they are a published
     contract and a rename would rewrite history. The stage events added by
     migration 0004 are additional facts alongside them. */
  const names = db.state.timeline_events.map(e => e.event_name);
  assert.deepEqual(names,
    ['business.created', 'identity.resolved', 'identity.linked',
     'assessment.completed', 'bir.generated',
     'stage2.started', 'stage2.completed', 'full_bir.generated']);
  assert.equal(body.timelineEventIds.length, 8);
  assert.equal(db.state.audit_events.length, 1);
});

test('replaying an Idempotency-Key returns the original response and creates nothing', async () => {
  const db = createFakeDb();
  const payload = makePayload();
  const first = await send(db, payload);
  const before = counts(db);

  const second = await send(db, payload);
  assert.equal(second.res.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.businessId, first.body.businessId);
  assert.equal(second.body.birId, first.body.birId);
  assert.deepEqual(second.body.timelineEventIds, first.body.timelineEventIds);
  assert.deepEqual(counts(db), before);

  /* And a third time, for good measure. */
  await send(db, payload);
  assert.deepEqual(counts(db), before);
});

test('same key with a different body is a conflict, not a silent overwrite', async () => {
  const db = createFakeDb();
  const payload = makePayload();
  await send(db, payload);

  const tampered = makePayload({ results: { score: 91 } });
  const { res, body } = await send(db, tampered);
  assert.equal(res.status, 409);
  assert.equal(body.error.code, 'idempotency_key_conflict');
  assert.equal(counts(db).submissions, 1);
});

test('a second submission in the same session links to the same business', async () => {
  const db = createFakeDb();
  const first = await send(db, makePayload());

  const second = makePayload({ submissionId: randomUUID(), results: { score: 31 } });
  const out = await send(db, second);

  assert.equal(out.res.status, 201);
  assert.equal(out.body.businessId, first.body.businessId);
  assert.equal(out.body.identityStatus, 'linked');
  assert.notEqual(out.body.birId, first.body.birId);

  const c = counts(db);
  assert.equal(c.businesses, 1, 'no second business');
  assert.equal(c.submissions, 2);
  assert.equal(c.birs, 2);

  /* The session proposed the same record and nothing in this submission
     contradicts it — same business, same contact — so it links and no second
     business.created event is written. A session that is CONTRADICTED does
     not link; see tests/identity-proposals.test.mjs, rule B0. */
  assert.equal(db.state.timeline_events.filter(e => e.event_name === 'business.created').length, 1);
  const linkEvent = db.state.timeline_events.find(
    e => e.event_name === 'identity.linked' && e.payload.linkedArtifactId === second.submissionId);
  assert.equal(linkEvent.payload.linkMethod, 'session');
});

test('a unique verified strong identifier links automatically to the existing business', async () => {
  const db = createFakeDb();
  /* Verified, from a trusted source — the only kind that may auto-link. */
  const existing = db.seedBusiness({
    displayName: 'Polished Nail Studio',
    identifiers: [{
      type: 'gbp_place_id', normalizedValue: 'ChIJ_test_place_id',
      verified: true, source: 'manual_verification', verificationMethod: 'operator_review'
    }]
  });

  const payload = makePayload({
    assessmentSessionId: randomUUID(),
    submissionId: randomUUID(),
    contact: { googlePlaceId: 'ChIJ_test_place_id' }
  });
  const { res, body } = await send(db, payload);

  assert.equal(res.status, 201);
  assert.equal(body.businessId, existing);
  assert.equal(body.identityStatus, 'linked');
  assert.equal(counts(db).businesses, 1, 'linked, not duplicated');
  const resolved = db.state.timeline_events.find(e => e.event_name === 'identity.resolved');
  assert.equal(resolved.payload.resolutionStatus, 'unique_match');
  assert.ok(db.state.timeline_events.some(e => e.event_name === 'identity.linked'));
  assert.equal(db.state.timeline_events.filter(e => e.event_name === 'business.created').length, 0);
});

test('no candidate at all creates a new business', async () => {
  const db = createFakeDb();
  db.seedBusiness({
    displayName: 'Somebody Else',
    identifiers: [{ type: 'email_exact', normalizedValue: 'other@elsewhere.test' }]
  });

  const { body } = await send(db, makePayload({
    assessmentSessionId: randomUUID(), submissionId: randomUUID()
  }));
  assert.equal(body.identityStatus, 'linked');
  assert.equal(counts(db).businesses, 2);
  assert.ok(db.state.timeline_events.some(e => e.event_name === 'business.created'));
});

test('name-only match does not auto-link and does not create a second business', async () => {
  const db = createFakeDb();
  const existing = db.seedBusiness({
    displayName: 'Polished Nail Studio',
    identifiers: [{ type: 'business_name', normalizedValue: 'polished nail studio' }]
  });

  const { res, body } = await send(db, makePayload({
    assessmentSessionId: randomUUID(),
    submissionId: randomUUID(),
    contact: { email: 'different@somewhere-else.test' }
  }));

  assert.equal(res.status, 201);
  assert.equal(body.identityStatus, 'resolution_pending');
  assert.equal(body.businessId, null);
  assert.equal(body.nextAction, 'identity_review_pending');
  assert.equal(counts(db).businesses, 1, 'no second permanent business');
  assert.equal(counts(db).cases, 1);
  assert.equal(db.state.identity_resolution_cases[0].resolution_status, 'probable_match');
  assert.deepEqual(db.state.identity_resolution_cases[0].candidate_business_ids.map(c => c.businessId), [existing]);
  assert.ok(db.state.timeline_events.some(e => e.event_name === 'identity.review_required'));
  assert.equal(db.state.timeline_events.filter(e => e.event_name === 'identity.linked').length, 0);
});

test('email-only match does not auto-link', async () => {
  const db = createFakeDb();
  db.seedBusiness({
    displayName: 'A Different Salon',
    identifiers: [{ type: 'email_exact', normalizedValue: 'owner@polished.test' }]
  });

  const { body } = await send(db, makePayload({
    assessmentSessionId: randomUUID(), submissionId: randomUUID(),
    contact: { salonName: 'Totally Different Name' }
  }));

  assert.equal(body.identityStatus, 'resolution_pending');
  assert.equal(body.businessId, null);
  assert.equal(counts(db).businesses, 1);
});

test('mobile-only match does not auto-link', async () => {
  const db = createFakeDb();
  db.seedBusiness({
    displayName: 'Another Salon',
    identifiers: [{ type: 'mobile_phone', normalizedValue: '+18645550134' }]
  });

  const { body } = await send(db, makePayload({
    assessmentSessionId: randomUUID(), submissionId: randomUUID(),
    contact: { salonName: 'Unrelated Studio', email: 'nobody@unrelated.test', mobile: '864-555-0134' }
  }));

  assert.equal(body.identityStatus, 'resolution_pending');
  assert.equal(counts(db).businesses, 1);
});

test('two verified strong candidates are ambiguous and never merged', async () => {
  const verified = (type, value) => ({
    type, normalizedValue: value, verified: true,
    source: 'manual_verification', verificationMethod: 'operator_review'
  });

  const db = createFakeDb();
  const a = db.seedBusiness({ identifiers: [verified('gbp_place_id', 'place_a')] });
  db.seedBusiness({ identifiers: [verified('external_customer_id', 'ext_b')] });

  const { body } = await send(db, makePayload({
    assessmentSessionId: randomUUID(), submissionId: randomUUID(),
    contact: { googlePlaceId: 'place_a' }
  }));
  /* One verified strong candidate matches, so this links. */
  assert.equal(body.businessId, a);

  /* Now make one payload reach two different businesses, each holding a
     verified strong identifier. */
  const db2 = createFakeDb();
  db2.seedBusiness({ identifiers: [verified('gbp_place_id', 'place_a')] });
  db2.seedBusiness({ identifiers: [verified('external_customer_id', 'shared_ext')] });

  const payload = makePayload({ assessmentSessionId: randomUUID(), submissionId: randomUUID() });
  payload.contact.googlePlaceId = 'place_a';
  payload.contact.externalCustomerId = 'shared_ext';

  const before = counts(db2).businesses;
  const out = await send(db2, payload);
  assert.equal(counts(db2).businesses, before, 'never creates a third record');
  assert.equal(out.body.identityStatus, 'resolution_pending');
  assert.equal(out.body.businessId, null);
  assert.equal(db2.state.identity_resolution_cases.length, 1, 'a human is asked');
  assert.equal(db2.state.timeline_events.filter(e => e.event_name === 'business.merged').length, 0,
    'merging never happens automatically');
});

test('a failure mid-transaction rolls everything back', async () => {
  for (const stage of ['business', 'bir', 'timeline']) {
    const db = createFakeDb({ failAt: stage });
    const { res } = await send(db, makePayload());
    assert.equal(res.status, 502, stage);
    assert.deepEqual(counts(db),
      { businesses: 0, submissions: 0, birs: 0, events: 0, cases: 0 },
      `nothing persisted when failing at ${stage}`);
    assert.equal(db.state.idempotency_records.length, 0, 'the claim rolls back too, so a retry can succeed');
  }
});

test('a rolled-back request can be retried successfully with the same key', async () => {
  const db = createFakeDb({ failAt: 'timeline' });
  const payload = makePayload();
  const failed = await send(db, payload);
  assert.equal(failed.res.status, 502);

  const healthy = createFakeDb();
  const retried = await send(healthy, payload);
  assert.equal(retried.res.status, 201);
  assert.equal(counts(healthy).submissions, 1);
});

test('timeline rows are append-only in shape: no supersede or correction is set implicitly', async () => {
  const db = createFakeDb();
  await send(db, makePayload());
  for (const event of db.state.timeline_events) {
    assert.equal(event.supersedes_event_id, null);
    assert.equal(event.correction_of_event_id, null);
    assert.ok(event.idempotency_key, 'every event carries a replay key');
    assert.ok(event.occurred_at && event.recorded_at);
    assert.ok(Date.parse(event.recorded_at) >= Date.parse(event.occurred_at));
  }
  const keys = db.state.timeline_events.map(e => `${e.event_name}:${e.idempotency_key}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate event identity');
});

test('an unresolved submission is still stored durably with its consent and attribution', async () => {
  const db = createFakeDb();
  db.seedBusiness({ identifiers: [{ type: 'business_name', normalizedValue: 'polished nail studio' }] });
  await send(db, makePayload({ assessmentSessionId: randomUUID(), submissionId: randomUUID() }));

  const stored = db.state.assessment_submissions[0];
  assert.equal(stored.identity_status, 'resolution_pending');
  assert.equal(stored.business_id, null);
  assert.equal(stored.consent_snapshot.resultsDeliveryConsent.granted, true);
  assert.ok(stored.attribution_snapshot.firstTouch.utm.utm_source);
  /* The BIR is kept too — the intelligence is valid regardless of which
     business it turns out to belong to. */
  assert.equal(db.state.business_intelligence_reports.length, 1);
  assert.equal(db.state.business_intelligence_reports[0].business_id, null);
});
