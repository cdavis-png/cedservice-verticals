/* ============================================================
   SM-1 — the audit's verified defects, pinned
   ------------------------------------------------------------
   One test per behaviour the independent audit found wrong, so a
   regression names the defect it is reintroducing rather than
   producing a puzzling failure somewhere else.

   Grouped by the audit's own numbering.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { handleRequest } from '../api/assessments.mjs';
import events from '../shared/analytics/events.js';
import values from '../shared/service-mix-engine/value.schema.js';
import offerings from '../shared/service-mix-engine/offering.schema.js';
import calculate from '../shared/service-mix-engine/calculate.js';
import classify from '../shared/service-mix-engine/classify.js';
import bir from '../shared/service-mix-engine/generate-service-mix-bir.js';
import continuation from '../shared/security/continuation.js';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload } from './helpers/fixtures.mjs';
import {
  makeServiceMixPayload, makeServiceMixRequest, makeOffering, makePortfolio, smDeps
} from './helpers/service-mix-fixtures.mjs';

const send = async (db, payload, opts = {}) => {
  const res = await handleRequest(makeServiceMixRequest(payload, opts), smDeps(db));
  return { res, body: await res.json().catch(() => null) };
};

const fresh = (overrides = {}) => makeServiceMixPayload({
  submissionId: randomUUID(),
  assessmentSessionId: randomUUID(),
  serviceMix: { offerings: makePortfolio() },
  ...overrides
});

const portfolioOf = (list, coverage = 'all_offerings') =>
  calculate.calculatePortfolio({ offerings: list, coverage });

/* ============================================================
   Defect 2 — no Business Record identifier in Service Mix
   ============================================================ */

test('D2 — the Service Mix response carries no Business Record identifier', async () => {
  const db = createFakeDb();
  const { res, body } = await send(db, fresh());

  assert.equal(res.status, 201);
  assert.equal('businessId' in body, false,
    'a permanent identifier in the browser becomes one in every event it emits');
  assert.equal('birId' in body, false);
  assert.equal('assessmentId' in body, false);
  assert.equal('timelineEventIds' in body, false);

  /* What it DOES carry: the client's own idempotency key, whether identity
     is settled, and nothing that names a record. */
  assert.deepEqual(Object.keys(body).sort(), [
    'assessmentSessionId', 'continuationToken', 'correlationId', 'identityResolved',
    'nextAction', 'ok', 'receivedAt', 'replayed', 'reviewType', 'submissionId'
  ]);
  assert.equal(body.identityResolved, true);

  /* The record exists; the browser is simply not told which one. */
  assert.equal(db.state.business_records.length, 1);
});

test('D2 — the Growth response is unchanged, businessId included', async () => {
  const db = createFakeDb();
  const res = await handleRequest(makeServiceMixRequest(makePayload()), smDeps(db));
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.ok(body.businessId, 'Growth has a published contract and it is not changed here');
  assert.ok(body.birId);
  assert.equal(body.reviewType, 'growth_review');
});

test('D2 — a Service Mix analytics event may never carry a businessId', () => {
  const base = {
    eventId: randomUUID(), eventVersion: 1, schemaVersion: 2,
    occurredAt: '2026-08-05T09:00:00.000Z',
    assessmentSessionId: randomUUID(), submissionId: null,
    verticalId: 'nails', assessmentStage: 1,
    attribution: { firstTouch: null, latestTouch: null },
    device: { deviceClass: 'phone' },
    activeElapsedMs: 0, totalElapsedMs: 0, stepElapsedMs: null,
    visibleQuestionCount: null, completedQuestionCount: null,
    consentStatus: 'product_allowed', metadata: {}
  };

  /* By its own name. */
  const byName = events.validateEvent({
    ...base, eventName: 'service_mix.results_viewed', businessId: randomUUID()
  });
  assert.equal(byName.valid, false);
  assert.ok(byName.errors.some(e => e.code === 'business_id_in_service_mix'));

  /* And on a SHARED event that merely declares the review type — a step view
     from the Service Mix page is still a Service Mix event. */
  const byDeclaration = events.validateEvent({
    ...base, eventName: 'assessment.step_viewed', stepId: 'figures',
    reviewType: 'service_mix', businessId: randomUUID()
  });
  assert.equal(byDeclaration.valid, false);
  assert.ok(byDeclaration.errors.some(e => e.code === 'business_id_in_service_mix'));

  /* Growth keeps it: a funnel row joined to a record is part of that
     contract. */
  const growth = events.validateEvent({
    ...base, eventName: 'assessment.step_viewed', stepId: '4',
    reviewType: 'growth_review', businessId: randomUUID()
  });
  assert.equal(growth.valid, true);
});

/* ============================================================
   Defect 3 — measured values and health
   ============================================================ */

test('D3 — sellingPrice and monthlyVolume may never be not_applicable', () => {
  ['sellingPrice', 'monthlyVolume'].forEach(measure => {
    offerings.CATEGORIES.forEach(category => {
      assert.equal(offerings.mayBeNotApplicable(measure, category), false,
        `${measure} may not be not_applicable for ${category}`);
    });

    const portfolio = makePortfolio();
    portfolio[0].category = 'core_service';
    portfolio[0][measure] = { kind: 'not_applicable', value: null, low: null, high: null };
    const result = offerings.validateServiceMix({ coverage: 'all_offerings', offerings: portfolio });

    assert.equal(result.valid, false);
    const error = result.errors.find(e => e.code === 'not_applicable_not_permitted');
    assert.ok(error, `${measure} must be refused`);
    assert.match(error.message, /Use "unknown"/,
      'the owner is told what the honest answer is');
  });
});

test('D3 — durationMinutes is not_applicable only for categories with no appointment', () => {
  offerings.CATEGORIES_WITHOUT_DURATION.forEach(category => {
    assert.equal(offerings.mayBeNotApplicable('durationMinutes', category), true);

    const portfolio = makePortfolio();
    portfolio[0].category = category;
    portfolio[0].durationMinutes = { kind: 'not_applicable', value: null, low: null, high: null };
    assert.equal(
      offerings.validateServiceMix({ coverage: 'all_offerings', offerings: portfolio }).valid,
      true, `${category} genuinely has no appointment time`);
  });

  offerings.APPOINTMENT_CATEGORIES.forEach(category => {
    assert.equal(offerings.mayBeNotApplicable('durationMinutes', category), false);

    const portfolio = makePortfolio();
    portfolio[0].category = category;
    portfolio[0].durationMinutes = { kind: 'not_applicable', value: null, low: null, high: null };
    const result = offerings.validateServiceMix({ coverage: 'all_offerings', offerings: portfolio });

    assert.equal(result.valid, false, `${category} takes time even when the time is not known`);
    assert.ok(result.errors.some(e => e.code === 'not_applicable_not_permitted'));
  });
});

test('D3 — a manipulated payload claiming not_applicable is refused at the endpoint', async () => {
  const db = createFakeDb();

  /* The browser omits the control entirely for these; a payload that carries
     it anyway did not come from the page. */
  const manipulated = makePortfolio();
  manipulated[0].category = 'core_service';
  manipulated[0].durationMinutes = { kind: 'not_applicable', value: null, low: null, high: null };

  const { res, body } = await send(db, fresh({ serviceMix: { offerings: manipulated } }));
  assert.equal(res.status, 422);
  assert.equal(body.error.code, 'invalid_service_mix');
  assert.ok(body.error.details.violations.some(v => v.code === 'not_applicable_not_permitted'));
  assert.equal(db.state.assessment_submissions.length, 0, 'and nothing is stored');
});

test('D3 — a not_applicable price would have inflated completeness; unknown does not', () => {
  /* This is WHY the rule exists. `not_applicable` leaves the denominator, so
     a portfolio with no prices at all would have scored complete. */
  const noPrices = makePortfolio().map(o => ({
    ...o, sellingPrice: values.UNKNOWN
  }));
  const honest = portfolioOf(noPrices);
  assert.ok(honest.dataConfidence.completeness < 1,
    'unknown prices lower completeness, which is the point');
  assert.equal(honest.dataConfidence.unknownMeasures, 3);

  /* And the shape that would have hidden it is now unrepresentable. */
  const dishonest = makePortfolio().map(o => ({
    ...o, sellingPrice: { kind: 'not_applicable', value: null, low: null, high: null }
  }));
  assert.equal(
    offerings.validateServiceMix({ coverage: 'all_offerings', offerings: dishonest }).valid,
    false);
});

test('D3 — nothing calculable is never healthy', () => {
  /* Two offerings with a price each and nothing else. Both count as usable,
     confidence clears the bar, no rule can fire — and the old ladder called
     that `generally_healthy`. */
  const priceOnly = [
    makeOffering({ name: 'A', price: 60, kinds: { durationMinutes: 'unknown', monthlyVolume: 'unknown' } }),
    makeOffering({ name: 'B', price: 80, kinds: { durationMinutes: 'unknown', monthlyVolume: 'unknown' } })
  ];
  const portfolio = portfolioOf(priceOnly);

  assert.equal(portfolio.usableOfferingCount, 2, 'both offerings are "usable"');
  assert.equal(portfolio.totals.monthlyRevenue.known, false);
  assert.equal(portfolio.totals.capacityHours.known, false);

  const classified = classify.classifyPortfolio(portfolio);
  assert.equal(classified.health.classification, 'insufficient_evidence');
  assert.match(classified.health.because, /nothing to compare/);
  assert.equal(classified.health.deciding.monthlyRevenueKnown, false);
  assert.equal(classified.health.deciding.capacityHoursKnown, false);
});

test('D3 — one calculable total is enough to be measured against', () => {
  /* Revenue calculable, hours not. There IS something to say, so the review
     proceeds to the ordinary ladder rather than refusing outright. */
  const noDurations = [
    makeOffering({ name: 'A', price: 60, volume: 50, kinds: { durationMinutes: 'unknown' } }),
    makeOffering({ name: 'B', price: 80, volume: 20, kinds: { durationMinutes: 'unknown' } }),
    makeOffering({ name: 'C', price: 40, volume: 30, kinds: { durationMinutes: 'unknown' } })
  ];
  const classified = classify.classifyPortfolio(portfolioOf(noDurations));
  assert.notEqual(classified.health.classification, 'insufficient_evidence');
});

test('D3 — the health boundaries are exactly at the stated thresholds', () => {
  const { minConfidence, minCompleteness, minUsableOfferings } = classify.THRESHOLDS;
  assert.equal(minConfidence, 0.45);
  assert.equal(minCompleteness, 0.65);
  assert.equal(minUsableOfferings, 2);

  /* Just under the completeness bar is undermeasured; just over is not. */
  const estimated = name => makeOffering({
    name, price: 60, duration: 60, volume: 40,
    kinds: { sellingPrice: 'estimate', durationMinutes: 'estimate', monthlyVolume: 'estimate' }
  });
  const under = portfolioOf([estimated('A'), estimated('B'), estimated('C')]);
  assert.ok(under.dataConfidence.completeness < minCompleteness);
  assert.equal(classify.classifyPortfolio(under).health.classification, 'undermeasured');

  /* Ranges score 0.80, which clears it. */
  const ranged = name => makeOffering({
    name, price: 60, duration: 60, volume: 40,
    kinds: { sellingPrice: 'range', durationMinutes: 'range', monthlyVolume: 'range' }
  });
  const over = portfolioOf([ranged('A'), ranged('B'), ranged('C')]);
  assert.ok(over.dataConfidence.completeness >= minCompleteness);
  assert.notEqual(classify.classifyPortfolio(over).health.classification, 'undermeasured');
});

/* ============================================================
   Defect 8 — continuation never reaches a payload, submission,
   report, or analytics event
   ============================================================ */

test('D8 — the continuation context travels as a header and reaches no stored row', async () => {
  const db = createFakeDb();
  const token = '1.opaque.server.issued';
  const payload = fresh();

  const { res } = await send(db, payload, { extraHeaders: { 'X-CED-Continuation': token } });
  assert.equal(res.status, 201);

  const stored = db.state.assessment_submissions.find(s => s.submission_id === payload.submissionId);
  const serialised = JSON.stringify(stored);
  assert.equal(serialised.includes(token), false,
    'a bearer credential must never reach the stored submission');
  assert.equal(serialised.includes('continuationToken'), false);

  const report = db.state.business_intelligence_reports
    .find(r => r.assessment_submission_id === payload.submissionId);
  assert.equal(JSON.stringify(report).includes(token), false,
    'nor the report');
});

test('D8 — a token put in the body anyway is stripped before anything is hashed', async () => {
  const db = createFakeDb();
  const payload = fresh();
  payload.continuation = { continuationToken: '1.body.borne.token', businessId: randomUUID() };

  const { res } = await send(db, payload);
  assert.equal(res.status, 201);

  const stored = db.state.assessment_submissions.find(s => s.submission_id === payload.submissionId);
  assert.equal(stored.raw_payload.continuation.continuationToken, undefined);
  assert.equal(stored.raw_payload.continuation.businessId, undefined,
    'a client-supplied businessId is deleted, not ignored');
  assert.equal(stored.raw_payload.continuation.continuationPresented, true,
    'only whether one was presented survives');
});

test('D8 — the shared store binds a prefill to a token and refuses a UUID', () => {
  assert.equal(continuation.acceptableToken('1.a.b'), true);
  assert.equal(continuation.acceptableToken(randomUUID()), false,
    'the browser must never hold a Business Record id');
  assert.equal(continuation.acceptableToken('x'.repeat(600)), false);
  assert.equal(continuation.acceptableToken(''), false);

  /* Only contact the visitor typed. Not a phone number, not a website, not a
     Google profile — those are identity evidence and the server's to weigh. */
  const prefill = continuation.sanitizePrefill({
    salonName: 'Polished', ownerName: 'Owner', email: 'a@b.test',
    businessPhone: '555', website: 'example.test', googleProfile: 'x', locationCount: '2'
  });
  assert.deepEqual(Object.keys(prefill).sort(), ['email', 'ownerName', 'salonName']);
});

/* ============================================================
   Defect 5 — findings are deterministic and unique
   ============================================================ */

test('D5 — finding ids are derived from the finding, not from randomness', () => {
  const submission = makeServiceMixPayload();
  const a = bir.generateServiceMixBir({
    submission, birId: randomUUID(), generatedAt: '2026-08-05T12:00:00.000Z' });
  const b = bir.generateServiceMixBir({
    submission, birId: randomUUID(), generatedAt: '2026-08-05T23:59:59.000Z' });

  /* Different birId, different generation time, same findings — because the
     ids are derived from what the finding IS. */
  assert.deepEqual(a.findings.map(f => f.findingId), b.findings.map(f => f.findingId));
  assert.deepEqual(a.findings.map(f => f.test.testId), b.findings.map(f => f.test.testId));
  assert.equal(a.provenance.inputHash, b.provenance.inputHash);
});

test('D5 — the whole report is byte-identical across two generations', () => {
  const submission = makeServiceMixPayload();
  const fixed = { birId: randomUUID(), generatedAt: '2026-08-05T12:00:00.000Z' };
  const a = bir.generateServiceMixBir({ submission, ...fixed });
  const b = bir.generateServiceMixBir({ submission, ...fixed });
  assert.deepEqual(a, b, 'a regenerated report must not differ from the one it regenerates');
});
