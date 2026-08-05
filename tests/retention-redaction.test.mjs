/* Milestone 1.1 — H (retention and redaction) and M (idempotency cleanup).

   The gap: an append-only store holding names, emails and phone numbers with
   no erasure path at all. DELETE on submissions is refused by trigger, and
   deleting a business record would violate the identity-consistency CHECK, so
   a deletion request could not be honoured by any means.

   Redaction, not deletion, is the answer: direct identifiers are destroyed in
   the mutable surfaces while the structural record survives. These tests
   prove the structure survives — they do NOT establish that any law is
   satisfied, and nothing here should be read as claiming that. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handleRequest } from '../api/assessments.mjs';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload, makeRequest, deps, NOW_MS } from './helpers/fixtures.mjs';

const send = async (db, payload) => {
  const res = await handleRequest(makeRequest(payload), deps(db));
  return { res, body: await res.json() };
};

const seeded = async () => {
  const db = createFakeDb();
  const { body } = await send(db, makePayload());
  return { db, businessId: body.businessId };
};

const redact = (db, args) => db.rpc('redact_business_pii', {
  p_business_id: args.businessId,
  p_reason: args.reason ?? 'Verified erasure request from the business owner.',
  p_actor: args.actor ?? 'operator:cdavis',
  p_actor_type: args.actorType ?? 'human'
});

/* ---------- H. redaction ---------- */

test('redaction requires a reason and an actor', async () => {
  const { db, businessId } = await seeded();

  const noReason = await redact(db, { businessId, reason: 'short' });
  assert.match(noReason.error.message, /redaction_reason_required/);

  const noActor = await redact(db, { businessId, actor: '' });
  assert.match(noActor.error.message, /redaction_actor_required/);

  const badActor = await redact(db, { businessId, actorType: 'anonymous' });
  assert.match(badActor.error.message, /redaction_actor_type_invalid/);
});

test('an unknown business is refused', async () => {
  const { db } = await seeded();
  const missing = await redact(db, { businessId: randomUUID() });
  assert.match(missing.error.message, /business_not_found/);
});

test('direct identifiers are removed from every mutable surface', async () => {
  const { db, businessId } = await seeded();
  const before = JSON.stringify(db.state);
  assert.ok(before.includes('owner@polished.test'), 'the email really was stored');
  assert.ok(before.includes('Test Owner'));

  const { data, error } = await redact(db, { businessId });
  assert.equal(error, null);

  const after = JSON.stringify(db.state);
  assert.ok(!after.includes('owner@polished.test'), 'email gone');
  assert.ok(!after.includes('Test Owner'), 'owner name gone');
  assert.ok(!after.includes('Polished Nail Studio'), 'business name gone');

  assert.equal(data.redacted.assessmentSubmissionContact, 1);
  assert.ok(data.redacted.identityEvidenceRows > 0);
  assert.equal(data.redacted.birDisplayName, 1);
});

test('structural integrity survives redaction', async () => {
  const { db, businessId } = await seeded();
  const before = {
    businesses: db.state.business_records.length,
    submissions: db.state.assessment_submissions.length,
    birs: db.state.business_intelligence_reports.length,
    events: db.state.timeline_events.length
  };

  await redact(db, { businessId });

  assert.equal(db.state.business_records.length, before.businesses, 'no record is deleted');
  assert.equal(db.state.assessment_submissions.length, before.submissions);
  assert.equal(db.state.business_intelligence_reports.length, before.birs);
  assert.equal(db.state.timeline_events.length, before.events, 'history is untouched');
  assert.equal(db.state.business_records[0].business_id, businessId, 'the permanent id survives');
});

test('scoring and analysis are preserved exactly', async () => {
  const { db, businessId } = await seeded();
  const bir = db.state.business_intelligence_reports[0].report;
  const before = {
    score: db.state.assessment_submissions[0].raw_payload.results.score,
    opportunity: JSON.stringify(bir.financialOpportunityProfile),
    confidence: JSON.stringify(bir.estimateConfidence),
    readiness: JSON.stringify(bir.closeReadinessProfile),
    pkg: JSON.stringify(bir.packageRecommendation)
  };

  await redact(db, { businessId });

  const after = db.state.business_intelligence_reports[0].report;
  assert.equal(db.state.assessment_submissions[0].raw_payload.results.score, before.score);
  assert.equal(JSON.stringify(after.financialOpportunityProfile), before.opportunity);
  assert.equal(JSON.stringify(after.estimateConfidence), before.confidence);
  assert.equal(JSON.stringify(after.closeReadinessProfile), before.readiness);
  assert.equal(JSON.stringify(after.packageRecommendation), before.pkg,
    'pricing is never rewritten by redaction');
});

test('the one intelligence field that changes is declared, not silent', async () => {
  const { db, businessId } = await seeded();
  const { data } = await redact(db, { businessId });

  assert.equal(db.state.business_intelligence_reports[0].report.businessProfile.displayName, '[redacted]');
  assert.equal(data.redacted.birDisplayName, 1, 'the change is reported to the caller');

  const audit = db.state.audit_events.find(e => e.action === 'business.pii_redacted');
  assert.equal(audit.new_value.reportsDisplayNameRedacted, 1, 'and recorded in the audit trail');
});

test('operational answers and consent records are retained', async () => {
  const { db, businessId } = await seeded();
  await redact(db, { businessId });

  const answers = db.state.assessment_submissions[0].raw_payload.answers;
  assert.equal(answers.technicians, '3', 'scoring inputs survive');
  assert.equal(answers.averageTicket, '50');
  assert.equal(answers.email, '[redacted]', 'identity answers do not');

  const consent = db.state.assessment_submissions[0].consent_snapshot;
  assert.equal(consent.resultsDeliveryConsent.granted, true);
  assert.ok(consent.resultsDeliveryConsent.statement.length > 10,
    'the exact wording shown is retained as proof of what was agreed');
});

test('identity evidence is closed as well as emptied', async () => {
  const { db, businessId } = await seeded();
  await redact(db, { businessId });

  const pii = db.state.business_identifiers.filter(i =>
    ['email_exact', 'email_domain', 'mobile_phone', 'business_name'].includes(i.identifier_type));
  pii.forEach(i => {
    assert.equal(i.raw_value, null);
    assert.match(i.normalized_value, /^redacted:/);
    assert.equal(i.verified, false);
    assert.ok(i.valid_to, 'the row is closed, so it can never match again');
  });
});

test('redaction writes an audit event and never violates a constraint', async () => {
  const { db, businessId } = await seeded();
  const { data, error } = await redact(db, { businessId });
  assert.equal(error, null, 'no CHECK constraint is broken');

  const audit = db.state.audit_events.find(e => e.audit_event_id === data.auditEventId);
  assert.equal(audit.action, 'business.pii_redacted');
  assert.equal(audit.actor_type, 'human');
  assert.equal(audit.actor_id, 'operator:cdavis');
  assert.match(audit.reason, /erasure request/);
  assert.ok(!JSON.stringify(audit).includes('owner@polished.test'),
    'the audit record does not reintroduce what was removed');
});

test('the result states what was removed and what remains', async () => {
  const { db, businessId } = await seeded();
  const { data } = await redact(db, { businessId });

  assert.ok(Object.keys(data.redacted).length >= 5);
  assert.ok(Object.keys(data.preserved).length >= 5);
  assert.ok(data.preserved.timelineEvents.includes('append-only'));
  assert.ok(data.notes.some(n => /no claim of compliance/i.test(n)),
    'the function does not claim to satisfy any law');
  assert.ok(data.notes.some(n => /External systems/i.test(n)),
    'external systems are explicitly out of scope');
});

test('timeline and audit payloads carry no contact data — the invariant redaction depends on', async () => {
  const { db } = await seeded();
  const forbidden = ['owner@polished.test', 'Test Owner', 'Polished Nail Studio', '864-555'];

  db.state.timeline_events.forEach(e => {
    const serialised = JSON.stringify(e.payload);
    forbidden.forEach(v => assert.ok(!serialised.includes(v),
      `${e.event_name} must not carry contact data: it can never be updated`));
  });
  db.state.audit_events.forEach(e => {
    const serialised = JSON.stringify(e.new_value);
    forbidden.forEach(v => assert.ok(!serialised.includes(v), 'audit payloads likewise'));
  });
});

test('redaction is idempotent in effect', async () => {
  const { db, businessId } = await seeded();
  await redact(db, { businessId });
  const afterFirst = JSON.stringify(db.state.business_records[0]);

  const second = await redact(db, { businessId });
  assert.equal(second.error, null);
  assert.equal(second.data.redacted.birDisplayName, 0, 'nothing further to change');
  assert.equal(JSON.stringify(db.state.business_records[0]), afterFirst);
});

/* ---------- M. idempotency cleanup ---------- */

const expire = (db, key, at) => {
  db.state.idempotency_records.find(r => r.idempotency_key === key).expires_at = at;
};

test('cleanup removes only records past expiry', async () => {
  const db = createFakeDb();
  const live = makePayload({ assessmentSessionId: randomUUID(), submissionId: randomUUID() });
  const stale = makePayload({ assessmentSessionId: randomUUID(), submissionId: randomUUID() });
  await send(db, live);
  await send(db, stale);
  assert.equal(db.state.idempotency_records.length, 2);

  expire(db, stale.submissionId, new Date(NOW_MS - 1000).toISOString());

  const { data, error } = await db.rpc('purge_expired_idempotency_records', {
    p_now: new Date(NOW_MS).toISOString()
  });

  assert.equal(error, null);
  assert.equal(data, 1, 'exactly one record removed');
  assert.equal(db.state.idempotency_records.length, 1);
  assert.equal(db.state.idempotency_records[0].idempotency_key, live.submissionId,
    'the live key is untouched');
});

test('cleanup removes nothing when nothing has expired', async () => {
  const db = createFakeDb();
  await send(db, makePayload());
  const { data } = await db.rpc('purge_expired_idempotency_records', {
    p_now: new Date(NOW_MS).toISOString()
  });
  assert.equal(data, 0);
  assert.equal(db.state.idempotency_records.length, 1);
});

test('a record expiring exactly now is not yet removed', async () => {
  const db = createFakeDb();
  const payload = makePayload();
  await send(db, payload);
  expire(db, payload.submissionId, new Date(NOW_MS).toISOString());

  const { data } = await db.rpc('purge_expired_idempotency_records', {
    p_now: new Date(NOW_MS).toISOString()
  });
  assert.equal(data, 0, 'strictly past expiry, never at it');
});

test('cleanup is batched', async () => {
  const db = createFakeDb();
  for (let i = 0; i < 5; i++) {
    const p = makePayload({ assessmentSessionId: randomUUID(), submissionId: randomUUID() });
    await send(db, p);
    expire(db, p.submissionId, new Date(NOW_MS - 1000).toISOString());
  }

  const first = await db.rpc('purge_expired_idempotency_records', {
    p_now: new Date(NOW_MS).toISOString(), p_limit: 2
  });
  assert.equal(first.data, 2, 'a large backlog cannot hold one long transaction open');
  assert.equal(db.state.idempotency_records.length, 3);
});

test('purging an expired key does not resurrect the assessment', async () => {
  const db = createFakeDb();
  const payload = makePayload();
  await send(db, payload);
  expire(db, payload.submissionId, new Date(NOW_MS - 1000).toISOString());
  await db.rpc('purge_expired_idempotency_records', { p_now: new Date(NOW_MS).toISOString() });

  assert.equal(db.state.assessment_submissions.length, 1, 'the assessment itself is untouched');
  assert.equal(db.state.business_records.length, 1);
  assert.equal(db.state.timeline_events.length, 8);
});
