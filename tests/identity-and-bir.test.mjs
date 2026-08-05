import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makePayload, DISCLAIMER } from './helpers/fixtures.mjs';

const require = createRequire(import.meta.url);
const identity = require('../shared/business-record/resolve-identity.js');
const bie = require('../shared/business-intelligence/generate-bir.js');
const schema = require('../shared/business-intelligence/report.schema.js');

const BIR_ID = '33333333-3333-4333-8333-333333333333';
const BUSINESS_ID = '44444444-4444-4444-8444-444444444444';
const GENERATED_AT = '2026-08-04T12:00:05.000Z';

/* ---------------- identity resolution ---------------- */

test('normalizers are conservative and reject what they cannot be sure of', () => {
  assert.equal(identity.normalizeEmail('  Owner+Tag@Polished.TEST '), 'owner@polished.test');
  assert.equal(identity.normalizeEmail('not-an-email'), null);
  assert.equal(identity.emailDomain('someone@gmail.com'), null, 'free mail carries no identity');
  assert.equal(identity.emailDomain('owner@polished.test'), 'polished.test');
  assert.equal(identity.normalizePhone('(864) 555-0134'), '+18645550134');
  assert.equal(identity.normalizePhone('12'), null);
  assert.equal(identity.normalizeDomain('https://www.Polished.test/book?x=1'), 'polished.test');
  assert.equal(identity.normalizeName('  Polished Nail Studio, LLC '), 'polished nail studio');
  assert.equal(identity.normalizeName('a'), null);
});

test('signals are extracted only from what the payload actually contains', () => {
  const signals = identity.extractIdentitySignals(makePayload());
  const types = signals.map(s => s.type);
  assert.ok(types.includes('email_exact'));
  assert.ok(types.includes('business_name'));
  assert.ok(!types.includes('gbp_place_id'), 'not collected today');
  assert.ok(!types.includes('mobile_phone'), 'blank mobile produces no signal');
  assert.ok(signals.every(s => s.normalizedValue));
});

test('session linkage is deterministic and outranks everything else', () => {
  const decision = identity.decideIdentity({
    sessionBusinessId: BUSINESS_ID,
    candidates: [{ businessId: 'other', matchedTypes: ['gbp_place_id'] }]
  });
  assert.equal(decision.action, 'link_to_existing');
  assert.equal(decision.businessId, BUSINESS_ID);
  assert.equal(decision.linkMethod, 'session');
});

test('no candidates creates a new record', () => {
  const decision = identity.decideIdentity({ candidates: [] });
  assert.equal(decision.action, 'create_new_record');
  assert.equal(decision.resolutionStatus, 'no_match');
  assert.equal(decision.businessId, null);
});

test('weak signals never auto-link, alone or combined', () => {
  const weakSets = [
    ['business_name'], ['email_exact'], ['mobile_phone'], ['email_domain'],
    ['business_name', 'email_exact', 'mobile_phone', 'email_domain']
  ];
  for (const matchedTypes of weakSets) {
    const decision = identity.decideIdentity({
      candidates: [{ businessId: BUSINESS_ID, matchedTypes }]
    });
    assert.equal(decision.action, 'queue_for_review', matchedTypes.join('+'));
    assert.equal(decision.identityStatus, 'resolution_pending');
    assert.equal(decision.businessId, null);
  }
});

test('one verified strong identifier links; two compete and go to review', () => {
  const one = identity.decideIdentity({
    candidates: [{
      businessId: BUSINESS_ID,
      matchedTypes: ['gbp_place_id', 'business_name'],
      verifiedStrongTypes: ['gbp_place_id']
    }]
  });
  assert.equal(one.action, 'link_to_existing');
  assert.equal(one.confidence, 0.95);

  const two = identity.decideIdentity({
    candidates: [
      { businessId: 'a', matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id'] },
      { businessId: 'b', matchedTypes: ['payment_customer_id'], verifiedStrongTypes: ['payment_customer_id'] }
    ]
  });
  assert.equal(two.action, 'queue_for_review');
  assert.equal(two.resolutionStatus, 'possible_duplicate');
  assert.equal(two.conflictingSignals.length, 2);
});

test('merged-away records are never link targets', () => {
  const decision = identity.decideIdentity({
    candidates: [{
      businessId: 'gone',
      matchedTypes: ['gbp_place_id'],
      verifiedStrongTypes: ['gbp_place_id'],
      recordStatus: 'merged_away'
    }]
  });
  assert.equal(decision.action, 'create_new_record');
});

test('no merge capability is exposed', () => {
  assert.equal(typeof identity.merge, 'undefined');
  assert.equal(typeof identity.autoMerge, 'undefined');
  assert.ok(!identity.RESOLUTION_ACTIONS.includes('merge'));
});

/* ---------------- BIR generation ---------------- */

const generate = (overrides = {}, opts = {}) => bie.generateBir({
  submission: makePayload(overrides),
  birId: BIR_ID,
  businessId: 'businessId' in opts ? opts.businessId : BUSINESS_ID,
  identityStatus: opts.identityStatus ?? 'linked',
  generatedAt: GENERATED_AT
});

test('a generated BIR validates against the schema contract', () => {
  const result = bie.validateGeneratedBir(generate());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('the BIR is schema v4 and carries identity and provenance', () => {
  const bir = generate();
  assert.equal(bir.schemaVersion, 4);
  assert.equal(bir.identity.businessId, BUSINESS_ID);
  assert.equal(bir.identity.identityStatus, 'linked');
  assert.equal(bir.identity.legacyBusinessKey, null);
  assert.equal(bir.identity.birId, BIR_ID);
  assert.equal(bir.identity.submissionId, makePayload().submissionId);
  assert.equal(bir.provenance.payloadSchemaVersion, 5);
  assert.equal(bir.provenance.assessmentVersion, '1.1.0');
  assert.equal(bir.provenance.isCurrent, true);
  assert.ok(bir.provenance.inputHash);
});

test('generation is deterministic', () => {
  const a = generate();
  const b = generate();
  assert.deepEqual(a, b);
  assert.equal(a.provenance.inputHash, b.provenance.inputHash);
});

test('scoring and pricing are carried through, never recomputed', () => {
  const payload = makePayload();
  const bir = generate();
  assert.equal(bir.financialOpportunityProfile.unconstrained.point, payload.results.opportunity);
  assert.equal(bir.operationsProfile.appointmentProtectionScore, payload.results.dimensions.appointmentProtection);
  assert.equal(bir.customerProfile.retentionScore, payload.results.dimensions.retention);
  assert.equal(bir.marketingProfile.marketingScore, payload.results.dimensions.marketing);
  assert.equal(bir.packageRecommendation.packageId, 'salon-growth');
  assert.equal(bir.packageRecommendation.priceMonthly, 597);
  assert.equal(bir.packageRecommendation.label, 'Salon Growth — $597/month');
});

test('the opportunity stays a range with its disclaimer', () => {
  const fin = generate().financialOpportunityProfile;
  assert.equal(fin.isDiagnosticEstimate, true);
  assert.equal(fin.disclaimer, DISCLAIMER);
  assert.ok(fin.unconstrained.low < fin.unconstrained.point);
  assert.ok(fin.unconstrained.point < fin.unconstrained.high);
  /* The fixture reports 6-10 additional appointments per week, comfortably
     above the new demand in this estimate, so no clamp is required. */
  assert.equal(fin.capacityAdjusted.clampApplied, false);
  assert.match(fin.capacityAdjusted.clampReason, /exceeds the newly created demand/i);
  assert.ok(fin.capacityAdjusted.ceiling > 0);
});

test('confidence cannot reach high while capacity is unknown', () => {
  const bir = generate({ answers: { capacity90Day: '' } });
  assert.notEqual(bir.estimateConfidence.band, 'high');
  assert.ok(bir.estimateConfidence.score < 0.8);
  assert.ok(bir.estimateConfidence.reasons.some(r => /capacity/i.test(r)));
});

test('an explicit "unsure" about capacity is unknown, never favourable', () => {
  const bir = generate({ answers: { capacity90Day: 'unsure' } });
  assert.notEqual(bir.estimateConfidence.band, 'high');
  assert.equal(bir.capacityProfile.headroomBand, 'unknown');
  assert.equal(bir.financialOpportunityProfile.capacityAdjusted.clampApplied, false);
  assert.ok(bir.estimateConfidence.reasons.some(r => /does not know/i.test(r)));
});

test('known capacity lifts the cap that unknown capacity imposed', () => {
  const unknown = generate({ answers: { capacity90Day: '' } });
  const known = generate();
  assert.ok(known.estimateConfidence.score > unknown.estimateConfidence.score,
    'collecting the ceiling is exactly what the cap was waiting for');
});

/* Everything the intelligence expansion collects, stripped back out. */
const NO_INTELLIGENCE = {
  locationCount: '', yearsInBusiness: '', capacity90Day: '', willingnessToExpand: '',
  staffingExpandable: '', hoursExpandable: '', spaceConstraint: '',
  respondentRole: '', canApprove: '', decisionTiming: '', startTiming: '', urgency: '',
  budgetSignal: '', bookingPlatform: '', bookingPlatformStaying: '', phoneSetup: '',
  keepNumber: '', willingToChangeSoftware: '', customIntegrationNeeded: '',
  migrationConcern: '', primaryConcern: ''
};

test('unknown fields stay unknown and are never invented', () => {
  const bir = generate({ answers: NO_INTELLIGENCE });
  assert.equal(bir.businessProfile.locationCount, null);
  assert.equal(bir.capacityProfile.additionalCapacity90Day, null);
  assert.equal(bir.capacityProfile.headroomBand, 'unknown');
  assert.equal(bir.capacityProfile.oversellRisk, 'unknown');
  assert.equal(bir.technologyProfile.bookingSystem, null);
  assert.equal(bir.technologyProfile.integrationCompatibility, 'unknown');
  assert.equal(bir.riskProfile.churnRisk, 'unknown');
  assert.equal(bir.riskProfile.implementationRisk, 'unknown');
  assert.equal(bir.qualificationProfile.outcome, 'insufficient_data');
  /* Every dimension reports null rather than a convenient midpoint. */
  ['capacityReadiness', 'decisionReadiness', 'budgetReadiness',
   'implementationCompatibility', 'multiLocationComplexity', 'objectionSeverity']
    .forEach(key => assert.equal(bir.intelligenceDimensions[key].score, null, key));
});

test('missing critical fields are listed explicitly', () => {
  const missing = generate({ answers: NO_INTELLIGENCE })
    .qualificationProfile.missingCriticalFields;
  ['answers.locationCount', 'answers.capacity90Day', 'answers.bookingPlatform',
   'answers.canApprove', 'answers.urgency', 'answers.budgetSignal']
    .forEach(field => assert.ok(missing.includes(field), field));
});

test('a question that did not apply is not reported as unanswered', () => {
  const bir = generate();
  /* The fixture never showed multiLocationSystems, so its absence is a fact
     about the path taken, not a gap in the evidence. */
  assert.ok(!bir.qualificationProfile.missingCriticalFields.includes('answers.multiLocationSystems'));
  assert.ok(bir.evidencePath.notApplicable.includes('multiLocationSystems'));
});

test('close readiness stays limited while its evidence is unknown', () => {
  const readiness = generate({ answers: NO_INTELLIGENCE }).closeReadinessProfile;
  assert.equal(readiness.signals.decisionAuthority.known, false);
  assert.equal(readiness.signals.capacity.known, false);
  assert.ok(readiness.unknownSignals.length >= 6);
  assert.ok(readiness.softBlockers.includes('unknown_decision_authority'));
  assert.ok(['educate', 'clarify'].includes(readiness.band),
    `band was ${readiness.band}; unknown evidence must not produce a sellable band`);
  assert.equal(readiness.approvedLanguageKey, null, 'approved close language is never set here');
  assert.equal(Object.keys(readiness.signals).length, schema.CLOSE_READINESS_SIGNALS.length);
});

test('an unresolved identity produces a BIR with a null businessId and a review action', () => {
  const bir = generate({}, { businessId: null, identityStatus: 'resolution_pending' });
  assert.equal(bir.identity.businessId, null);
  assert.equal(bir.identity.identityStatus, 'resolution_pending');
  assert.equal(bir.recommendedNextAction.action, 'await_identity_review');
  assert.equal(bie.validateGeneratedBir(bir).valid, true);
});

test('attribution is preserved, first touch unchanged', () => {
  const bir = generate();
  assert.equal(bir.marketingProfile.attribution.firstTouch.utm.utm_source, 'qr_card');
  assert.equal(bir.marketingProfile.attribution.firstTouch.referrer, 'https://qr.example/');
  assert.equal(bir.marketingProfile.attribution.latestTouch.occurredAt, makePayload().submittedAt);
});

test('lifecycle is a snapshot, and consent is recorded per purpose', () => {
  const bir = generate();
  assert.equal(bir.lifecycle.stage, 'lead_assessed');
  assert.equal(bir.lifecycle.consentState.results_delivery.granted, true);
  assert.equal(bir.lifecycle.consentState.email_marketing.granted, false);
  assert.equal(bir.lifecycle.consentState.transactional_service, null,
    'no transactional basis is collected yet, so it must stay null');
  const due = Date.parse(bir.lifecycle.nextReassessmentDueAt) - Date.parse(makePayload().submittedAt);
  assert.equal(Math.round(due / 86400000), schema.LIFECYCLE_POLICY.unconvertedLeadReassessDays);
});

test('every scored claim carries evidence', () => {
  const evidence = generate().explanation.evidence;
  assert.ok(evidence.length >= 5);
  evidence.forEach(e => {
    assert.ok(e.id && e.kind && e.field && e.statement);
    assert.ok(schema.VOCAB.evidenceKind.includes(e.kind));
  });
});

test('blank scored answers reduce completeness and are listed', () => {
  const bir = generate({ answers: { reminders: '', waitlist: '' } });
  assert.ok(bir.estimateConfidence.completeness < 1);
  assert.ok(bir.qualificationProfile.missingCriticalFields.includes('answers.reminders'));
  assert.ok(bir.qualificationProfile.missingCriticalFields.includes('answers.waitlist'));
});

test('contradictory answers reduce consistency without throwing', () => {
  const bir = generate({ answers: { missedCallsDay: '40', callsDay: '2' } });
  assert.ok(bir.estimateConfidence.consistency < 1);
  assert.ok(bir.estimateConfidence.reasons.some(r => /exceed/i.test(r)));
  assert.equal(bie.validateGeneratedBir(bir).valid, true);
});

test('generation refuses to run without its required inputs', () => {
  assert.throws(() => bie.generateBir({ birId: BIR_ID, generatedAt: GENERATED_AT }), /submission is required/);
  assert.throws(() => bie.generateBir({ submission: makePayload(), generatedAt: GENERATED_AT }), /birId is required/);
  assert.throws(() => bie.generateBir({ submission: makePayload(), birId: BIR_ID }), /generatedAt is required/);
});
