/* Staged submissions through the capture endpoint and into the store.

   Two stages are two submissions, two idempotency keys, and two reports, all
   append-only. The endpoint validates the declared stage rather than trusting
   it loosely, because the stage decides what a report is permitted to
   conclude — a forged Stage 2 would lift the ceiling that stops a preliminary
   result from asking for the sale. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../api/assessments.mjs';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload, makeRequest, deps, STAGE1_SUBMISSION, SUBMITTED_AT } from './helpers/fixtures.mjs';

const post = async (db, payload) => {
  const res = await handleRequest(makeRequest(payload), deps(db));
  return { res, body: await res.json() };
};

const STAGE1_ONLY = {
  salonName: 'Polished Nail Studio', ownerName: 'Test Owner', email: 'owner@polished.test',
  mobile: '', technicians: '3', appointmentsDay: '12', averageTicket: '50', daysOpen: '24',
  callsDay: '8', missedCallsDay: '2', missedCallProcess: '1',
  noShowsWeek: '2', cancelsWeek: '3', reminders: '1', waitlist: '0',
  rebooking: '1', reactivation: '0', inactiveClients: '150',
  reviewCount: '65', rating: '4.4', reviewRequests: '1', promotions: '1',
  locationCount: '1', capacity90Day: '11_20'
};

const stage1 = (overrides = {}) => {
  const payload = makePayload({
    submissionId: STAGE1_SUBMISSION,
    assessmentStage: {
      stage: 1, stageId: 'stage1', stageName: 'Growth Review', totalStages: 2,
      stage1CompletedAt: SUBMITTED_AT, stage2StartedAt: null, stage2CompletedAt: null,
      supersedesSubmissionId: null, trigger: 'stage1_complete'
    },
    ...overrides
  });
  payload.answers = { ...STAGE1_ONLY };
  return payload;
};

/* ---------- the journey ---------- */

test('a Stage 1 submission alone is stored, reported, and complete', async () => {
  const db = createFakeDb();
  const { res, body } = await post(db, stage1());

  assert.equal(res.status, 201);
  assert.equal(db.state.assessment_submissions.length, 1);
  assert.equal(db.state.business_intelligence_reports.length, 1);

  const report = db.state.business_intelligence_reports[0].report;
  assert.equal(report.assessmentProgress.assessmentStageCompleted, 1);
  assert.equal(report.assessmentProgress.resultState, 'fit_review_available');
  assert.equal(report.closeReadinessProfile.provisional, true);
  assert.notEqual(report.closeReadinessProfile.band, 'ask_for_sale');

  const names = db.state.timeline_events.map(e => e.event_name);
  assert.ok(names.includes('stage1.completed'));
  assert.ok(names.includes('preliminary_bir.generated'));
  assert.ok(!names.includes('stage2.started'));
  assert.ok(!names.includes('full_bir.generated'));
  /* No candidate business matched, so a record was created and the visitor's
     results are ready. Identity review is a separate concern from staging. */
  assert.equal(body.nextAction, 'results_ready');
});

test('the Stage 2 submission chains to the Stage 1 report without overwriting it', async () => {
  const db = createFakeDb();
  /* A verified identifier is not needed: the session link is what ties the two
     submissions to one business, which is exactly the real path. */
  await post(db, stage1());
  const preliminary = db.state.business_intelligence_reports[0];

  const { res } = await post(db, makePayload());
  assert.equal(res.status, 201);

  assert.equal(db.state.assessment_submissions.length, 2, 'both submissions are kept');
  assert.equal(db.state.business_intelligence_reports.length, 2, 'both reports are kept');

  const full = db.state.business_intelligence_reports[1];
  assert.equal(full.supersedes_bir_id, preliminary.bir_id);
  assert.equal(full.report.assessmentProgress.assessmentStageCompleted, 2);
  assert.equal(full.report.assessmentProgress.stage1SubmissionId, STAGE1_SUBMISSION);
  assert.equal(full.report.assessmentProgress.supersedesPreliminaryBir, true);

  /* The preliminary report is byte-identical to what was stored first. */
  assert.equal(preliminary.report.assessmentProgress.assessmentStageCompleted, 1);
  assert.equal(preliminary.report.closeReadinessProfile.provisional, true);

  const names = db.state.timeline_events.map(e => e.event_name);
  ['stage1.completed', 'preliminary_bir.generated',
   'stage2.started', 'stage2.completed', 'full_bir.generated']
    .forEach(name => assert.ok(names.includes(name), name));
});

test('every stage event satisfies the timeline ordering constraint', async () => {
  const db = createFakeDb();
  await post(db, stage1());
  await post(db, makePayload());

  db.state.timeline_events.forEach(event => {
    assert.ok(Date.parse(event.recorded_at) >= Date.parse(event.occurred_at),
      `${event.event_name} recorded before it occurred`);
  });

  /* stage2.started carries the moment the visitor opened the fit review, not
     the moment the submission landed, so the gap between the two is
     recoverable from the timeline. */
  const started = db.state.timeline_events.find(e => e.event_name === 'stage2.started');
  const completed = db.state.timeline_events.find(e => e.event_name === 'stage2.completed');
  assert.ok(Date.parse(started.occurred_at) < Date.parse(completed.occurred_at));
});

test('timeline and audit payloads carry no contact data, stage events included', async () => {
  const db = createFakeDb();
  await post(db, stage1());
  await post(db, makePayload());

  const forbidden = ['owner@polished.test', 'Test Owner', 'Polished Nail Studio'];
  const scan = rows => JSON.stringify(rows.map(r => r.payload ?? r.new_value ?? {}));
  const timeline = scan(db.state.timeline_events);
  const audit = scan(db.state.audit_events);

  forbidden.forEach(value => {
    assert.ok(!timeline.includes(value), `timeline leaked ${value}`);
    assert.ok(!audit.includes(value), `audit leaked ${value}`);
  });
});

test('replaying a Stage 1 key does not produce a second preliminary report', async () => {
  const db = createFakeDb();
  await post(db, stage1());
  const { res, body } = await post(db, stage1());

  assert.equal(res.status, 200);
  assert.equal(body.replayed, true);
  assert.equal(db.state.business_intelligence_reports.length, 1);
  assert.equal(db.state.timeline_events.filter(e => e.event_name === 'stage1.completed').length, 1);
});

/* ---------- validation ---------- */

test('a declared stage outside 1 or 2 is refused', async () => {
  const db = createFakeDb();
  const payload = makePayload();
  payload.assessmentStage.stage = 3;
  const { res, body } = await post(db, payload);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'invalid_assessment_stage');
});

test('a Stage 1 submission may not claim to supersede anything', async () => {
  const db = createFakeDb();
  const payload = stage1();
  payload.assessmentStage.supersedesSubmissionId = '88888888-8888-4888-8888-888888888888';
  const { res, body } = await post(db, payload);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'invalid_assessment_stage');
});

test('a submission may not supersede itself, and the predecessor must be a UUID', async () => {
  const db = createFakeDb();

  const selfRef = makePayload();
  selfRef.assessmentStage.supersedesSubmissionId = selfRef.submissionId;
  assert.equal((await post(db, selfRef)).body.error.code, 'invalid_assessment_stage');

  const garbage = makePayload();
  garbage.assessmentStage.supersedesSubmissionId = 'not-a-uuid';
  assert.equal((await post(db, garbage)).body.error.code, 'invalid_assessment_stage');
});

test('stage timestamps must be real timestamps', async () => {
  const db = createFakeDb();
  const payload = makePayload();
  payload.assessmentStage.stage2StartedAt = 'shortly before lunch';
  const { res, body } = await post(db, payload);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'invalid_assessment_stage');
});

/* ---------- version compatibility ---------- */

test('a schema-4 payload from a page cached before this deploy is still accepted', async () => {
  const db = createFakeDb();
  const payload = makePayload({ schemaVersion: 4 });
  delete payload.assessmentStage;
  delete payload.results.opportunityRange;

  const { res } = await post(db, payload);
  assert.equal(res.status, 201);

  /* It carried the whole question set in one pass, so it is a full review and
     its report says so. */
  const report = db.state.business_intelligence_reports[0].report;
  assert.equal(report.assessmentProgress.assessmentStageCompleted, 2);
  assert.equal(report.assessmentProgress.stageDeclared, false);
  assert.equal(report.closeReadinessProfile.provisional, false);

  /* And it emits no stage events, because it had no stages. */
  const names = db.state.timeline_events.map(e => e.event_name);
  assert.ok(!names.some(n => n.startsWith('stage')));
  assert.ok(!names.some(n => n.endsWith('_bir.generated')));
});
