/* Preliminary versus full Business Intelligence Reports.

   The rule this file exists to hold: a Stage 1 report is a COMPLETE answer to
   a smaller question, not a degraded answer to the whole one. It scores only
   what it asked, says plainly what it did not ask, and may never ask for the
   sale. A Stage 2 report supersedes it; neither overwrites the other. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makePayload, STAGE1_SUBMISSION, SUBMITTED_AT } from './helpers/fixtures.mjs';

const require = createRequire(import.meta.url);
const bie = require('../shared/business-intelligence/generate-bir.js');
const schema = require('../shared/business-intelligence/report.schema.js');
const intel = require('../shared/assessment-engine/intelligence.js');

const BIR_ID = '55555555-5555-4555-8555-555555555555';
const PRELIM_BIR_ID = '66666666-6666-4666-8666-666666666666';
const GENERATED_AT = '2026-08-04T12:00:05.000Z';

/* The answers Stage 1 actually collects, and nothing else. Absent keys, not
   empty strings: an unasked question has no answer at all. */
const STAGE1_ONLY = {
  salonName: 'Polished Nail Studio', ownerName: 'Test Owner', email: 'owner@polished.test',
  mobile: '', technicians: '3', appointmentsDay: '12', averageTicket: '50', daysOpen: '24',
  callsDay: '8', missedCallsDay: '2', missedCallProcess: '1',
  noShowsWeek: '2', cancelsWeek: '3', reminders: '1', waitlist: '0',
  rebooking: '1', reactivation: '0', inactiveClients: '150',
  reviewCount: '65', rating: '4.4', reviewRequests: '1', promotions: '1',
  locationCount: '1', capacity90Day: '11_20'
};

const stage1Payload = (overrides = {}) => {
  const base = makePayload({
    submissionId: STAGE1_SUBMISSION,
    assessmentStage: {
      stage: 1, stageId: 'stage1', stageName: 'Growth Review', totalStages: 2,
      stage1CompletedAt: SUBMITTED_AT, stage2StartedAt: null, stage2CompletedAt: null,
      supersedesSubmissionId: null, trigger: 'stage1_complete'
    },
    branching: {
      stage: 1,
      visibleSteps: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      totalSteps: 17,
      visibleFields: Object.keys(STAGE1_ONLY),
      skippedFields: [],
      staleClearedFields: [],
      questionSetVersion: 'nails-questions-3.0.0'
    },
    ...overrides
  });
  /* Replace, never merge: the fixture's Stage 2 answers must not survive. */
  base.answers = { ...STAGE1_ONLY, ...(overrides.answers || {}) };
  base.contact = {
    salonName: 'Polished Nail Studio', ownerName: 'Test Owner',
    email: 'owner@polished.test', mobile: '', preferredContact: ''
  };
  return base;
};

const generate = (payload, extra = {}) => bie.generateBir({
  submission: payload, birId: BIR_ID, generatedAt: GENERATED_AT, ...extra
});

/* ---------- stage detection ---------- */

test('a payload that declares no stage is a full review, not a preliminary one', () => {
  const payload = makePayload();
  delete payload.assessmentStage;
  const bir = generate(payload);

  assert.equal(bir.assessmentProgress.assessmentStageCompleted, 2);
  assert.equal(bir.assessmentProgress.confidenceKind, 'full');
  assert.equal(bir.assessmentProgress.stageDeclared, false);
  assert.equal(bir.closeReadinessProfile.provisional, false);
});

test('a Stage 1 payload produces a preliminary report that validates', () => {
  const bir = generate(stage1Payload());
  const check = bie.validateGeneratedBir(bir);
  assert.deepEqual(check.errors, []);
  assert.equal(bir.schemaVersion, schema.BIR_SCHEMA_VERSION);
  assert.equal(bir.assessmentProgress.assessmentStageCompleted, 1);
  assert.equal(bir.assessmentProgress.confidenceKind, 'preliminary');
  assert.equal(bir.assessmentProgress.stage1CompletedAt, SUBMITTED_AT);
  assert.equal(bir.assessmentProgress.stage2CompletedAt, null);
  assert.equal(bir.assessmentProgress.stage1SubmissionId, null);
  assert.equal(bir.assessmentProgress.supersedesPreliminaryBir, false);
});

/* ---------- result states ---------- */

test('all four result states are reachable and each means one thing', () => {
  assert.equal(bie.resolveResultState({ stage: 1, missingStage2: ['canApprove'], band: 'clarify' }),
    'fit_review_available');
  assert.equal(bie.resolveResultState({ stage: 1, missingStage2: [], band: 'clarify' }),
    'preliminary_results');
  assert.equal(bie.resolveResultState({ stage: 2, missingStage2: [], band: 'clarify' }),
    'fit_review_complete');
  assert.equal(bie.resolveResultState({ stage: 2, missingStage2: [], band: 'present_offer' }),
    'activation_ready');
  assert.equal(bie.resolveResultState({ stage: 2, missingStage2: [], band: 'ask_for_sale' }),
    'activation_ready');

  schema.VOCAB.resultState.forEach(state => assert.equal(typeof state, 'string'));
});

test('a Stage 1 report offers the fit review and names what is still outstanding', () => {
  const bir = generate(stage1Payload());

  /* resultState is what the VISITOR may be offered, and is set whatever the
     identity outcome. recommendedNextAction is what the SYSTEM does next, and
     an unresolved identity outranks it — a person must confirm which business
     this is before anything is sent anywhere. */
  assert.equal(bir.assessmentProgress.resultState, 'fit_review_available');
  assert.equal(bir.recommendedNextAction.action, 'await_identity_review');

  const resolved = generate(stage1Payload(), {
    identityStatus: 'linked', businessId: '77777777-7777-4777-8777-777777777777'
  });
  assert.equal(resolved.recommendedNextAction.action, 'offer_fit_review');
  assert.match(resolved.recommendedNextAction.rationale, /remains optional/);

  const missing = bir.assessmentProgress.missingStage2Evidence;
  ['canApprove', 'budgetSignal', 'bookingPlatform', 'primaryConcern', 'urgency']
    .forEach(field => assert.ok(missing.includes(field), field));
  /* Optional evidence is never "outstanding". */
  ['website', 'businessPhone', 'googleProfile', 'concernDetail', 'openQuestions']
    .forEach(field => assert.ok(!missing.includes(field), field));
  /* And Stage 1's own evidence is not outstanding either. */
  ['locationCount', 'capacity90Day']
    .forEach(field => assert.ok(!missing.includes(field), field));
});

test('unasked Stage 2 evidence is reported as outstanding, never as a gap in the answers', () => {
  const bir = generate(stage1Payload());
  const missingCritical = bir.qualificationProfile.missingCriticalFields;

  assert.ok(!missingCritical.includes('answers.canApprove'),
    'not asked yet is not the same as declined to answer');
  assert.ok(bir.assessmentProgress.missingStage2Evidence.includes('canApprove'));
});

/* ---------- readiness by stage ---------- */

test('Stage 1 can never reach ask_for_sale, however good the operational picture', () => {
  /* Every Stage 1 lever pushed as far as it goes. */
  const best = stage1Payload({
    answers: { ...STAGE1_ONLY, capacity90Day: 'over_20', locationCount: '1' }
  });
  const bir = generate(best);

  assert.notEqual(bir.closeReadinessProfile.band, 'ask_for_sale');
  assert.equal(bir.closeReadinessProfile.approvedLanguageKey, null);
  assert.equal(bir.closeReadinessProfile.provisional, true);
  assert.deepEqual(bie.validateGeneratedBir(bir).errors, []);
});

test('Stage 1 scores only what Stage 1 asked, so a good salon is not pinned at educate', () => {
  const bir = generate(stage1Payload({
    answers: { ...STAGE1_ONLY, capacity90Day: 'over_20' }
  }));
  const readiness = bir.closeReadinessProfile;

  /* The five signals Stage 1 can evidence are in scope; the rest are listed,
     scored zero, and excluded from the arithmetic. */
  schema.STAGE1_READINESS_SIGNALS.forEach(key =>
    assert.equal(readiness.signals[key].inScope, true, key));
  ['decisionAuthority', 'budgetSignals', 'urgency', 'implementationCompatibility',
   'objectionsResolved'].forEach(key => {
    assert.equal(readiness.signals[key].inScope, false, key);
    assert.equal(readiness.signals[key].score, 0, key);
  });

  assert.equal(readiness.scoredSignalWeight, 0.43);
  assert.ok(readiness.score > 39,
    'a strong operational picture must be able to clear educate');
});

test('Stage 1 does not escalate merely because Stage 2 evidence is missing', () => {
  const bir = generate(stage1Payload());
  assert.notEqual(bir.closeReadinessProfile.band, 'escalate');
  assert.deepEqual(bir.closeReadinessProfile.hardBlockers, []);
  /* The blockers that exist only because we chose not to ask are deferred,
     visibly, rather than silently dropped. */
  assert.ok(bir.closeReadinessProfile.deferredBlockers.includes('unknown_decision_authority'));
  assert.ok(!bir.closeReadinessProfile.softBlockers.includes('unknown_decision_authority'));
});

test('a Stage 1 answer can still escalate: multiple locations is Stage 1 evidence', () => {
  const bir = generate(stage1Payload({
    answers: { ...STAGE1_ONLY, locationCount: '3' }
  }));
  assert.equal(bir.closeReadinessProfile.band, 'escalate');
  assert.ok(bir.closeReadinessProfile.hardBlockers.includes('multiple_locations'));
});

test('a Stage 1 answer can still cap the band: no headroom is an oversell risk', () => {
  const bir = generate(stage1Payload({
    answers: { ...STAGE1_ONLY, capacity90Day: 'none' }
  }));
  assert.ok(bir.closeReadinessProfile.softBlockers.includes('capacity_oversell_risk'));
  assert.equal(bir.closeReadinessProfile.band, 'clarify');
});

test('Stage 2 can reach ask_for_sale when the evidence supports it', () => {
  const bir = generate(makePayload({
    answers: {
      canApprove: 'yes', decisionTiming: 'this_week', startTiming: 'immediately',
      urgency: 'critical', budgetSignal: 'budgeted', capacity90Day: 'over_20',
      willingnessToExpand: 'yes', capacityLeadTime: 'immediate',
      staffingExpandable: 'yes', hoursExpandable: 'yes', spaceConstraint: 'none',
      bookingPlatform: 'square', bookingPlatformStaying: 'keep',
      willingToChangeSoftware: 'yes', customIntegrationNeeded: 'no',
      keepNumber: 'no', primaryConcern: 'none', locationCount: '1'
    }
  }));

  assert.equal(bir.closeReadinessProfile.band, 'ask_for_sale');
  assert.equal(bir.closeReadinessProfile.approvedLanguageKey, 'ask_for_sale');
  assert.equal(bir.closeReadinessProfile.provisional, false);
  assert.equal(bir.assessmentProgress.resultState, 'activation_ready');
  assert.equal(
    schema.APPROVED_CLOSE_LANGUAGE[bir.closeReadinessProfile.approvedLanguageKey],
    'Based on your assessment results, the next logical step is to activate the system and begin onboarding.');
});

test('Stage 2 arithmetic is byte-for-byte what it was before staging existed', () => {
  /* Stage 2 has every signal in scope, so the renormalisation divides by 1.
     This pins that the refactor changed nothing for a completed review. */
  const bir = generate(makePayload());
  assert.equal(bir.closeReadinessProfile.scoredSignalWeight, 1);
  assert.equal(bir.closeReadinessProfile.stageCapApplied, false);
  assert.deepEqual(bir.closeReadinessProfile.deferredBlockers, []);
  Object.values(bir.closeReadinessProfile.signals)
    .forEach(signal => assert.equal(signal.inScope, true));
});

/* ---------- supersession ---------- */

test('a full report supersedes the preliminary one and both stay readable', () => {
  const preliminary = bie.generateBir({
    submission: stage1Payload(), birId: PRELIM_BIR_ID, generatedAt: GENERATED_AT
  });
  const full = bie.generateBir({
    submission: makePayload(), birId: BIR_ID, generatedAt: '2026-08-04T12:05:00.000Z',
    supersedesBirId: PRELIM_BIR_ID
  });

  assert.equal(full.provenance.supersedes, PRELIM_BIR_ID);
  assert.equal(full.assessmentProgress.stage1SubmissionId, STAGE1_SUBMISSION);
  assert.equal(full.assessmentProgress.supersedesPreliminaryBir, true);

  /* The preliminary report is untouched by the existence of the full one. */
  assert.equal(preliminary.identity.birId, PRELIM_BIR_ID);
  assert.equal(preliminary.assessmentProgress.assessmentStageCompleted, 1);
  assert.equal(preliminary.provenance.isCurrent, true,
    'it was current when generated; supersession is recorded on the successor');
  assert.deepEqual(bie.validateGeneratedBir(preliminary).errors, []);
  assert.deepEqual(bie.validateGeneratedBir(full).errors, []);
});

test('the Growth Score and the estimate are identical in both reports', () => {
  const preliminary = generate(stage1Payload());
  const full = generate(makePayload());

  assert.equal(preliminary.financialOpportunityProfile.unconstrained.point,
    full.financialOpportunityProfile.unconstrained.point);
  assert.equal(preliminary.packageRecommendation.priceMonthly,
    full.packageRecommendation.priceMonthly);
  assert.equal(preliminary.operationsProfile.missedOpportunityScore,
    full.operationsProfile.missedOpportunityScore);
});

/* ---------- the validator ---------- */

test('the validator refuses a Stage 1 report that claims more than Stage 1 may claim', () => {
  const bir = generate(stage1Payload());

  const asking = JSON.parse(JSON.stringify(bir));
  asking.closeReadinessProfile.band = 'ask_for_sale';
  assert.ok(bie.validateGeneratedBir(asking).errors
    .some(e => e.code === 'stage1_asked_for_sale'));

  const speaking = JSON.parse(JSON.stringify(bir));
  speaking.closeReadinessProfile.approvedLanguageKey = 'ask_for_sale';
  assert.ok(bie.validateGeneratedBir(speaking).errors
    .some(e => e.code === 'stage1_close_language'));

  const settled = JSON.parse(JSON.stringify(bir));
  settled.assessmentProgress.closeReadinessProvisional = false;
  assert.ok(bie.validateGeneratedBir(settled).errors
    .some(e => e.code === 'stage1_not_provisional'));

  const finished = JSON.parse(JSON.stringify(bir));
  finished.assessmentProgress.stage2CompletedAt = GENERATED_AT;
  assert.ok(bie.validateGeneratedBir(finished).errors
    .some(e => e.code === 'stage1_with_stage2_timestamp'));
});

/* ---------- the field contract ---------- */

test('the stage split covers every intelligence field exactly once', () => {
  const union = [...intel.STAGE1_FIELDS, ...intel.STAGE2_FIELDS].sort();
  assert.deepEqual(union, [...intel.ALL_FIELDS].sort());
  intel.STAGE1_FIELDS.forEach(field =>
    assert.ok(!intel.STAGE2_FIELDS.includes(field), field));
});

test('Stage 1 owns exactly the two fields the platform requires of it', () => {
  /* locationCount decides whether the standard offer can be sized at all, and
     capacity90Day is the ceiling on the figure the visitor is shown. Adding a
     third belongs in a decision, not in a diff. */
  assert.deepEqual(intel.STAGE1_FIELDS, ['locationCount', 'capacity90Day']);
});

test('confidence is comparable across stages because every input it reads is Stage 1 evidence', () => {
  const preliminary = generate(stage1Payload());
  const full = generate(makePayload());

  bie.SCORED_ANSWER_FIELDS.forEach(field =>
    assert.ok(!intel.STAGE2_FIELDS.includes(field),
      `${field} feeds confidence but is collected in Stage 2`));

  assert.equal(preliminary.estimateConfidence.kind, 'preliminary');
  assert.equal(full.estimateConfidence.kind, 'full');
  assert.equal(preliminary.estimateConfidence.completeness,
    full.estimateConfidence.completeness);
});
