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
/* A Business Record id is a UUID everywhere else in the platform, and the
   proposal API now enforces the same contract. */
const BUSINESS_A = '11111111-1111-4111-8111-111111111111';
const BUSINESS_B = '22222222-2222-4222-8222-222222222222';
const BUSINESS_C = '33333333-3333-4333-8333-333333333333';

/* A well-formed candidate. All three evidence arrays are present because a
   lookup that produced a candidate produced all three, and an absent one
   silently changes which branch the decision takes. */
const candidate = (businessId, over = {}) => ({
  businessId,
  matchedTypes: [],
  verifiedStrongTypes: [],
  claimedStrongTypes: [],
  ...over
});
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

/* ---------- rule B0, in the exported resolver ----------

   This test used to read "session linkage is deterministic and outranks
   everything else", and that sentence was the defect written down. A saved
   session is a PROPOSAL: it proves that a previous submission carrying the
   same journey identifier resolved to a record, which is a statement about a
   browser and not about the business now being described.

   `decideIdentity` is exported, so it is what an external caller reaches for.
   It therefore has to reach the same answer as ingest_review and the fake
   database — and it does so by making ONE call to `resolveIdentityProposals`,
   the single public entry point, which validates the proposals, compares each
   through `proposalConflict`, and resolves B0/B0b through a module-private
   judged-proposal resolver. It restates none of that. */

const SALON_A_HELD = [
  { type: 'business_name', normalizedValue: 'polished nail studio' },
  { type: 'email_exact', normalizedValue: 'owner@polished.test' }
];

const signalsFor = contact =>
  identity.persistableSignals(identity.extractIdentitySignals({ contact }));

const SALON_A_CONTACT = { salonName: 'Polished Nail Studio', email: 'owner@polished.test' };
const SALON_B_CONTACT = { salonName: 'Riverside Barber Co', email: 'someone@riverside.test' };

test('a consistent session proposal links', () => {
  const decision = identity.decideIdentity({
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }],
    signals: signalsFor(SALON_A_CONTACT)
  });
  assert.equal(decision.action, 'link_to_existing');
  assert.equal(decision.businessId, BUSINESS_ID);
  assert.equal(decision.linkMethod, 'session');
  assert.deepEqual(decision.contributingSignals, ['assessment_session_link']);
});

test('a materially contradicted session proposal enters review', () => {
  const decision = identity.decideIdentity({
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }],
    signals: signalsFor(SALON_B_CONTACT)
  });
  assert.equal(decision.action, 'queue_for_review');
  assert.equal(decision.identityStatus, 'resolution_pending');
  assert.equal(decision.businessId, null, 'not linked to the record the session named');
  assert.equal(decision.linkMethod, null);

  const contradiction = decision.conflictingSignals
    .find(c => c.kind === 'session_contradicted');
  assert.ok(contradiction);
  assert.equal(contradiction.businessId, BUSINESS_ID);
  assert.ok(contradiction.contradictedTypes.includes('business_name'));
  assert.ok(contradiction.contradictedTypes.includes('email_exact'));
  assert.deepEqual(contradiction.agreedTypes, []);

  /* No identifier value travels with the verdict. */
  const text = JSON.stringify(decision);
  assert.equal(text.includes('someone@riverside.test'), false);
  assert.equal(text.includes('Riverside Barber Co'), false);
});

test('a session cannot outrank contradictory identity, even with a candidate to fall back on', () => {
  /* The old rule returned the session's record here without looking at
     anything else. Contradicted, it now looks at everything else — and weak
     matches still do not link. */
  const decision = identity.decideIdentity({
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }],
    signals: signalsFor(SALON_B_CONTACT),
    candidates: [candidate(BUSINESS_C, { matchedTypes: ['business_name'] })]
  });
  assert.equal(decision.action, 'queue_for_review');
  assert.notEqual(decision.businessId, BUSINESS_ID);
  assert.notEqual(decision.businessId, BUSINESS_C);
});

test('a rebrand or a contact change alone still links through the session', () => {
  const renamed = identity.decideIdentity({
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }],
    signals: signalsFor({ ...SALON_A_CONTACT, salonName: 'Polished Nails and Spa' })
  });
  assert.equal(renamed.action, 'link_to_existing', 'a name change alone is a rebrand');

  const moved = identity.decideIdentity({
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }],
    signals: signalsFor({ ...SALON_A_CONTACT, email: 'newowner@polished.test' })
  });
  assert.equal(moved.action, 'link_to_existing', 'a contact change alone is an update');
});

test('the legacy sessionBusinessId argument is refused, not ignored', () => {
  /* Ignoring it would be worse than refusing it. A session proposal with no
     heldIdentifiers is indistinguishable from a record that genuinely holds
     none — and a record holding nothing comparable cannot contradict, so it
     links. A caller who forgot to look the identifiers up would reintroduce
     the exact defect, silently. */
  assert.throws(
    () => identity.decideIdentity({ sessionBusinessId: BUSINESS_ID }),
    /sessionBusinessId/);
  assert.throws(
    () => identity.decideIdentity({ sessionBusinessId: null, candidates: [] }),
    /rule B0/,
    'refused even when the value is falsy: the intent is what matters');
});

test('every exported identity path agrees with rule B0', () => {
  /* decideIdentity does not restate the rule — it calls it. Proven by making
     the shared functions the authority and checking the resolver follows. */
  const contradicted = identity.proposalConflict({
    signals: signalsFor(SALON_B_CONTACT), heldIdentifiers: SALON_A_HELD
  });
  assert.equal(contradicted.material, true);

  const decision = identity.decideIdentity({
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }],
    signals: signalsFor(SALON_B_CONTACT)
  });
  assert.equal(decision.action, 'queue_for_review',
    'proposalConflict said contradicted; no exported path may still link');

  /* And the same for a continuation context: one rule, both kinds. */
  const context = identity.decideIdentity({
    proposals: [{ kind: 'continuation_context', businessId: BUSINESS_ID,
                  heldIdentifiers: SALON_A_HELD }],
    signals: signalsFor(SALON_B_CONTACT)
  });
  assert.equal(context.action, 'queue_for_review');

  /* Two surviving proposals naming different records: review, per B0b. */
  const disagreeing = identity.decideIdentity({
    proposals: [
      { kind: 'session', businessId: BUSINESS_A, heldIdentifiers: SALON_A_HELD },
      { kind: 'continuation_context', businessId: BUSINESS_B,
        heldIdentifiers: [{ type: 'email_exact', normalizedValue: 'someone@riverside.test' }] }
    ],
    signals: signalsFor({ salonName: 'Polished Nail Studio', email: 'someone@riverside.test' })
  });
  assert.equal(disagreeing.action, 'queue_for_review');
  assert.equal(disagreeing.businessId, null);
  assert.ok(disagreeing.conflictingSignals.some(c => c.kind === 'proposals_disagree'));

  /* Both naming the same uncontradicted record: link, and the context is
     named as the method because it is the stronger statement. */
  const agreeing = identity.decideIdentity({
    proposals: [
      { kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD },
      { kind: 'continuation_context', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }
    ],
    signals: signalsFor(SALON_A_CONTACT)
  });
  assert.equal(agreeing.action, 'link_to_existing');
  assert.equal(agreeing.linkMethod, 'continuation_context');
});

test('a vetoed proposal may not create a record', () => {
  const decision = identity.decideIdentity({
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }],
    signals: signalsFor(SALON_B_CONTACT),
    candidates: []
  });
  assert.equal(decision.action, 'queue_for_review',
    'the only evidence that this is a new business just contradicted a saved proposal');
  assert.notEqual(decision.action, 'create_new_record');
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
      candidates: [candidate(BUSINESS_ID, { matchedTypes })]
    });
    assert.equal(decision.action, 'queue_for_review', matchedTypes.join('+'));
    assert.equal(decision.identityStatus, 'resolution_pending');
    assert.equal(decision.businessId, null);
  }
});

test('one verified strong identifier links; two compete and go to review', () => {
  const one = identity.decideIdentity({
    candidates: [candidate(BUSINESS_ID, {
      matchedTypes: ['gbp_place_id', 'business_name'],
      verifiedStrongTypes: ['gbp_place_id']
    })]
  });
  assert.equal(one.action, 'link_to_existing');
  assert.equal(one.confidence, 0.95);

  const two = identity.decideIdentity({
    candidates: [
      candidate(BUSINESS_A, { matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id'] }),
      candidate(BUSINESS_B, { matchedTypes: ['payment_customer_id'], verifiedStrongTypes: ['payment_customer_id'] })
    ]
  });
  assert.equal(two.action, 'queue_for_review');
  assert.equal(two.resolutionStatus, 'possible_duplicate');
  assert.equal(two.conflictingSignals.length, 2);
});

test('merged-away records are never link targets', () => {
  const decision = identity.decideIdentity({
    candidates: [candidate(BUSINESS_C, {
      matchedTypes: ['gbp_place_id'],
      verifiedStrongTypes: ['gbp_place_id'],
      recordStatus: 'merged_away'
    })]
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

/* ---------- the proposal contract, enforced ----------

   Every rule in B0 is a comparison, and a comparison with nothing to compare
   against always says "no contradiction". So the dangerous input is not a
   malformed proposal — it is an INCOMPLETE one, which is indistinguishable
   from a record that genuinely holds no comparable identifiers, and links
   with confidence 1.

   The previous revision refused the legacy `sessionBusinessId` argument for
   exactly this reason and then wrote `heldIdentifiers: p.heldIdentifiers || []`
   two lines further down. Independent reproduction: a session proposal with
   no `heldIdentifiers`, or with `heldIdentifiers: null`, produced a
   confidence-1 session link; so did a continuation proposal. */

const wellFormed = (kind = 'session') => ({
  kind, businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD
});

test('a proposal that omits heldIdentifiers throws, for either kind', () => {
  for (const kind of ['session', 'continuation_context']) {
    assert.throws(
      () => identity.decideIdentity({
        proposals: [{ kind, businessId: BUSINESS_ID }],
        signals: signalsFor(SALON_B_CONTACT)
      }),
      /must carry heldIdentifiers/,
      `${kind}: omitting the evidence must not be treated as "nothing to compare"`);
  }
});

test('heldIdentifiers: null throws rather than defaulting to empty', () => {
  for (const kind of ['session', 'continuation_context']) {
    assert.throws(
      () => identity.decideIdentity({
        proposals: [{ kind, businessId: BUSINESS_ID, heldIdentifiers: null }],
        signals: signalsFor(SALON_B_CONTACT)
      }),
      /heldIdentifiers must be an array/,
      `${kind}: null is not an empty array`);
  }
});

test('a non-array heldIdentifiers throws', () => {
  [{}, 'business_name', 42, true, new Set()].forEach(value => {
    assert.throws(
      () => identity.decideIdentity({
        proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: value }],
        signals: signalsFor(SALON_A_CONTACT)
      }),
      /heldIdentifiers must be an array/,
      `${JSON.stringify(value)} is not an array`);
  });
});

test('a missing or malformed businessId throws — and non-empty is not enough', () => {
  /* A Business Record id is a UUID everywhere else: `business_records.business_id`
     is `uuid`, and PostgreSQL would refuse anything else. Accepting "any
     non-empty string" let a caller link to "not-a-uuid" with confidence 1 and
     be told it had worked. */
  [undefined, null, '', '   ', 42, {}, [],
   'not-a-uuid', 'business-1', '44444444-4444-4444-8444', 'zzzzzzzz-4444-4444-8444-444444444444',
   '44444444444444448444444444444444']
    .forEach(value => {
      assert.throws(
        () => identity.decideIdentity({
          proposals: [{ kind: 'session', businessId: value, heldIdentifiers: [] }],
          signals: signalsFor(SALON_A_CONTACT)
        }),
        /businessId must be a UUID/,
        `${JSON.stringify(value)} is not a business id`);
    });

  /* And a real one is accepted. */
  assert.equal(identity.isBusinessId(BUSINESS_ID), true);
  assert.equal(identity.isBusinessId('not-a-uuid'), false);
});

test('the UUID contract is the platform-wide one, not a local variant', () => {
  const offerings = require('../shared/service-mix-engine/offering.schema.js');
  [BUSINESS_ID, BUSINESS_A, BUSINESS_B,
   '00000000-0000-4000-8000-000000000000'].forEach(value => {
    assert.equal(identity.isBusinessId(value), offerings.isUuid(value), value);
  });
  ['not-a-uuid', '', 'business-1', '44444444-4444-0444-8444-444444444444']
    .forEach(value => {
      assert.equal(identity.isBusinessId(value), offerings.isUuid(value), value);
    });
});

test('an unknown proposal kind throws rather than being ignored', () => {
  ['browser', 'cookie', '', null, undefined, 'SESSION'].forEach(kind => {
    assert.throws(
      () => identity.decideIdentity({
        proposals: [{ kind, businessId: BUSINESS_ID, heldIdentifiers: [] }],
        signals: signalsFor(SALON_A_CONTACT)
      }),
      /kind must be one of/,
      `${JSON.stringify(kind)} is not a proposal kind`);
  });

  /* And a non-object entry. */
  [null, undefined, 'session', 7, []].forEach(entry => {
    assert.throws(
      () => identity.decideIdentity({ proposals: [entry], signals: [] }),
      /must be an object|kind must be one of/);
  });
});

/* ---------- the COMPOSITION, not each function alone ----------

   The exact reproduction the v7 audit reported, for both proposal kinds:

     1. proposalConflict({ signals })         — heldIdentifiers omitted
     2. it defaulted to [] and returned material: false
     3. resolveProposals([{ kind, businessId, conflict }])
     4. outcome: "link"

   Two exported functions, each defensible alone, wrong together. Testing
   `decideIdentity` and `assertProposals` proved nothing about the seam
   between them — which is why the previous test named "no exported path can
   link after the comparison evidence was omitted" was false. */

test('proposalConflict itself refuses to compare against evidence it was not given', () => {
  const signals = signalsFor(SALON_B_CONTACT);

  assert.throws(() => identity.proposalConflict({ signals }),
    /requires heldIdentifiers/,
    'omitted must not default to "nothing to compare"');
  assert.throws(() => identity.proposalConflict({ signals, heldIdentifiers: null }),
    /requires heldIdentifiers/);
  /* With neither operand supplied it refuses on the first one it reaches.
     Both are required; which is named first is not the point. */
  assert.throws(() => identity.proposalConflict({}),
    /requires (signals|heldIdentifiers)/);

  [{}, 'business_name', 42, true, new Set()].forEach(value => {
    assert.throws(() => identity.proposalConflict({ signals, heldIdentifiers: value }),
      /heldIdentifiers to be an array/, JSON.stringify(value));
  });

  /* Explicit [] stays valid and still means "nothing comparable". */
  assert.equal(identity.proposalConflict({ signals, heldIdentifiers: [] }).material, false);
});

test('the verdict-only resolver is not exported at all', () => {
  /* It takes verdicts rather than evidence, so on its own it cannot tell a
     computed verdict from a fabricated one. The public surface is
     resolveIdentityProposals, which takes the evidence and does both steps,
     so there is no seam to compose through. */
  assert.equal(identity.resolveProposals, undefined);
  assert.equal(identity.resolveJudgedProposals, undefined);
  assert.equal(typeof identity.resolveIdentityProposals, 'function');
});

test('the reported composition cannot be reassembled from the exported API', () => {
  for (const kind of ['session', 'continuation_context']) {
    const signals = signalsFor(SALON_B_CONTACT);

    /* Step 1 of the reproduction now throws, so there is no clean verdict to
       carry to step 3. */
    assert.throws(() => identity.proposalConflict({ signals }), /requires heldIdentifiers/,
      `${kind}: step 1`);
    assert.throws(() => identity.proposalConflict({ signals, heldIdentifiers: null }),
      /requires heldIdentifiers/, `${kind}: step 1, null`);

    /* And step 3 has no exported resolver to reach. */
    assert.equal(identity.resolveProposals, undefined, `${kind}: step 3`);

    /* The safe entry point refuses the same input outright. */
    assert.throws(() => identity.resolveIdentityProposals({
      signals, proposals: [{ kind, businessId: BUSINESS_ID }]
    }), /must carry heldIdentifiers/, `${kind}: safe path, omitted`);
    assert.throws(() => identity.resolveIdentityProposals({
      signals, proposals: [{ kind, businessId: BUSINESS_ID, heldIdentifiers: null }]
    }), /heldIdentifiers must be an array/, `${kind}: safe path, null`);
  }
});

test('a fabricated clean verdict cannot produce a public link', () => {
  /* A caller who hand-writes `{ material: false }` has nowhere to take it:
     the only exported resolver wants evidence, and a `conflict` property on
     an input proposal is simply not read. */
  const forged = { material: false, agreedTypes: [], contradictedTypes: [] };

  assert.throws(() => identity.resolveIdentityProposals({
    signals: signalsFor(SALON_B_CONTACT),
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, conflict: forged }]
  }), /must carry heldIdentifiers/,
    'a verdict is not a substitute for the evidence it claims to summarise');

  /* Supplied ALONGSIDE real evidence, it is ignored: the comparison is
     recomputed and the contradiction stands. */
  const decision = identity.decideIdentity({
    signals: signalsFor(SALON_B_CONTACT),
    proposals: [{
      kind: 'session', businessId: BUSINESS_ID,
      heldIdentifiers: SALON_A_HELD,
      conflict: forged
    }]
  });
  assert.equal(decision.action, 'queue_for_review',
    'the forged verdict must not override the real comparison');
});

test('the safe entry point returns the verdict and the per-proposal results', () => {
  const resolved = identity.resolveIdentityProposals({
    signals: signalsFor(SALON_A_CONTACT),
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }]
  });
  assert.equal(resolved.outcome, 'link');
  assert.equal(resolved.businessId, BUSINESS_ID);
  assert.equal(resolved.linkMethod, 'session');
  assert.equal(resolved.judged.length, 1);
  assert.equal(resolved.judged[0].conflict.material, false);

  const contradicted = identity.resolveIdentityProposals({
    signals: signalsFor(SALON_B_CONTACT),
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }]
  });
  assert.equal(contradicted.outcome, 'review');
  assert.deepEqual(contradicted.vetoedKinds, ['session']);
  assert.equal(contradicted.mayCreate, false);
  assert.equal(contradicted.judged[0].conflict.material, true);
});

test('one malformed proposal among several throws, rather than being dropped', () => {
  /* Dropping it would leave a single surviving proposal and a clean link —
     the caller would never learn that half its input was ignored. */
  assert.throws(
    () => identity.decideIdentity({
      proposals: [
        wellFormed('session'),
        { kind: 'continuation_context', businessId: BUSINESS_B }   /* no evidence */
      ],
      signals: signalsFor(SALON_A_CONTACT)
    }),
    /proposals\[1\] must carry heldIdentifiers/);

  /* And the reverse order, so the check is not merely "the last one wins". */
  assert.throws(
    () => identity.decideIdentity({
      proposals: [
        { kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: null },
        wellFormed('continuation_context')
      ],
      signals: signalsFor(SALON_A_CONTACT)
    }),
    /proposals\[0\]\.heldIdentifiers must be an array/);
});

test('a proposals value that is not an array throws', () => {
  [{}, 'session', 5, true].forEach(value => {
    assert.throws(
      () => identity.decideIdentity({ proposals: value, signals: [] }),
      /proposals must be an array/);
  });

  /* Absent and null mean "no proposals", which is a different statement from
     a broken one and stays legal. */
  assert.equal(identity.decideIdentity({ candidates: [] }).action, 'create_new_record');
  assert.equal(identity.decideIdentity({ proposals: null, candidates: [] }).action,
    'create_new_record');
  assert.equal(identity.decideIdentity({ proposals: [], candidates: [] }).action,
    'create_new_record');
});

test('an explicitly empty heldIdentifiers stays valid and links', () => {
  /* The documented behaviour for a record that genuinely holds nothing
     comparable — a redacted one, or one whose identifiers were never
     recorded. It cannot contradict, so it links. The point of the contract is
     that the CALLER states this, rather than this file inferring it from an
     omission. */
  const decision = identity.decideIdentity({
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: [] }],
    signals: signalsFor(SALON_B_CONTACT)
  });
  assert.equal(decision.action, 'link_to_existing');
  assert.equal(decision.businessId, BUSINESS_ID);
  assert.equal(decision.linkMethod, 'session');

  /* Identical to what the shared rule says on its own. */
  assert.equal(
    identity.proposalConflict({
      signals: signalsFor(SALON_B_CONTACT), heldIdentifiers: []
    }).material,
    false);
});

test('no exported path can link after the comparison evidence was omitted', () => {
  /* The property, stated once over every exported entry point: if the
     evidence is missing, nothing returns a link. It throws. */
  const incomplete = [
    { kind: 'session', businessId: BUSINESS_ID },
    { kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: null },
    { kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: undefined },
    { kind: 'continuation_context', businessId: BUSINESS_ID },
    { kind: 'continuation_context', businessId: BUSINESS_ID, heldIdentifiers: 'none' }
  ];

  incomplete.forEach((proposal, i) => {
    assert.throws(() => identity.decideIdentity({
      proposals: [proposal], signals: signalsFor(SALON_A_CONTACT)
    }), TypeError, `decideIdentity accepted incomplete proposal ${i}`);

    assert.throws(() => identity.assertProposals([proposal]),
      TypeError, `assertProposals accepted incomplete proposal ${i}`);
  });

  /* And the legacy argument is still refused, so there is no way round it. */
  assert.throws(() => identity.decideIdentity({ sessionBusinessId: BUSINESS_ID }),
    /sessionBusinessId/);
});

/* ---------- the candidate contract ----------

   Candidates come from a database lookup rather than from a browser, which is
   why they were left unchecked — a row from our own query is easy to assume
   is well formed. It is an assumption, and it failed in the same two
   directions the proposal contract already had.

   The v8 audit's reproductions:

     · `businessId: "not-a-uuid"` with `verifiedStrongTypes: ['gbp_place_id']`
       returned `link_to_existing` with confidence 0.95, and handed that
       string back as the Business Record id. Nothing downstream would ever
       have found that record.
     · The same invalid candidate beat a valid weak one.
     · `null`, `{}`, a missing `businessId` and an empty one were silently
       filtered out — and a list that filters down to empty reads as "nothing
       matched", which CREATES a second permanent record for a business that
       may already exist.

   Both outcomes are worse than an exception. A broken lookup should stop the
   decision, not quietly become one of its two most consequential answers. */

test('an invalid candidate businessId throws, verified-strong or not', () => {
  /* The reproduction: it used to LINK, and return the invalid id. */
  assert.throws(
    () => identity.decideIdentity({
      candidates: [candidate('not-a-uuid', {
        matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id']
      })]
    }),
    /candidates\[0\]\.businessId must be a UUID/);

  ['not-a-uuid', 'business-1', '44444444-4444-4444-8444',
   'zzzzzzzz-4444-4444-8444-444444444444', '44444444444444448444444444444444']
    .forEach(value => {
      assert.throws(
        () => identity.decideIdentity({ candidates: [candidate(value)] }),
        /businessId must be a UUID/, value);
    });
});

test('a missing, null or empty candidate businessId throws rather than vanishing', () => {
  [undefined, null, '', '   ', 42, {}, []].forEach(value => {
    assert.throws(
      () => identity.decideIdentity({ candidates: [candidate(value)] }),
      /businessId must be a UUID/,
      `${JSON.stringify(value)} must not be filtered into "nothing matched"`);
  });

  /* Absent entirely, rather than present-and-invalid. */
  assert.throws(
    () => identity.decideIdentity({
      candidates: [{ matchedTypes: [], verifiedStrongTypes: [], claimedStrongTypes: [] }]
    }),
    /businessId must be a UUID/);
});

test('a non-object candidate entry throws', () => {
  [null, undefined, 'business', 7, [], true].forEach(entry => {
    assert.throws(
      () => identity.decideIdentity({ candidates: [entry] }),
      /must be an object|businessId must be a UUID/,
      JSON.stringify(entry));
  });

  [{}, 'candidates', 5, true].forEach(value => {
    assert.throws(
      () => identity.decideIdentity({ candidates: value }),
      /candidates must be an array/, JSON.stringify(value));
  });

  /* Absent and null mean "no candidates", which is a different statement from
     a broken lookup and stays legal. */
  assert.equal(identity.decideIdentity({}).action, 'create_new_record');
  assert.equal(identity.decideIdentity({ candidates: null }).action, 'create_new_record');
  assert.equal(identity.decideIdentity({ candidates: [] }).action, 'create_new_record');
});

test('one invalid candidate beside valid ones fails the whole decision', () => {
  /* The audit's second reproduction: the invalid verified-strong candidate
     won. Dropping it instead would be no better — the decision would proceed
     on a lookup half of which could not be read. */
  assert.throws(
    () => identity.decideIdentity({
      candidates: [
        candidate(BUSINESS_A, { matchedTypes: ['business_name'] }),
        candidate('not-a-uuid', {
          matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id']
        })
      ]
    }),
    /candidates\[1\]\.businessId must be a UUID/);

  /* Either order, so the check is not "the last one wins". */
  assert.throws(
    () => identity.decideIdentity({
      candidates: [
        candidate('not-a-uuid', { verifiedStrongTypes: ['gbp_place_id'] }),
        candidate(BUSINESS_A, { matchedTypes: ['business_name'] })
      ]
    }),
    /candidates\[0\]\.businessId must be a UUID/);
});

test('a candidate must carry its evidence arrays, not have them defaulted', () => {
  /* Each omission changes which branch the decision takes:
       verifiedStrongTypes absent -> a unique match is downgraded to review
       claimedStrongTypes absent  -> manual_review_required becomes probable_match
       matchedTypes absent        -> a candidate that matched nothing is not one */
  ['matchedTypes', 'verifiedStrongTypes', 'claimedStrongTypes'].forEach(field => {
    const partial = candidate(BUSINESS_A);
    delete partial[field];
    assert.throws(
      () => identity.decideIdentity({ candidates: [partial] }),
      new RegExp(`must carry ${field}`), `${field} omitted`);

    [null, {}, 'gbp_place_id', 42].forEach(value => {
      assert.throws(
        () => identity.decideIdentity({ candidates: [candidate(BUSINESS_A, { [field]: value })] }),
        new RegExp(`${field} must be an array`), `${field} = ${JSON.stringify(value)}`);
    });
  });
});

test('no exported identity path can report an invalid Business Record id', () => {
  /* The property, over every branch that returns one. Nothing that reaches a
     result can carry a value the database would refuse. */
  const decisions = [
    identity.decideIdentity({ candidates: [] }),
    identity.decideIdentity({
      candidates: [candidate(BUSINESS_A, {
        matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id']
      })]
    }),
    identity.decideIdentity({
      candidates: [candidate(BUSINESS_A, { matchedTypes: ['business_name'] })]
    }),
    identity.decideIdentity({
      proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }],
      signals: signalsFor(SALON_A_CONTACT)
    })
  ];

  decisions.forEach((decision, i) => {
    if (decision.businessId !== null) {
      assert.equal(identity.isBusinessId(decision.businessId), true, `decision ${i}`);
    }
    (decision.candidateBusinessIds || []).forEach(value =>
      assert.equal(identity.isBusinessId(value), true, `decision ${i} candidate id`));
    (decision.conflictingSignals || []).forEach(c => {
      if (c.businessId) assert.equal(identity.isBusinessId(c.businessId), true);
      (c.businessIds || []).forEach(v => assert.equal(identity.isBusinessId(v), true));
    });
  });
});

/* ---------- the valid cases are untouched ---------- */

test('a valid verified-strong candidate still links', () => {
  const decision = identity.decideIdentity({
    candidates: [candidate(BUSINESS_A, {
      matchedTypes: ['gbp_place_id', 'business_name'],
      verifiedStrongTypes: ['gbp_place_id']
    })]
  });
  assert.equal(decision.action, 'link_to_existing');
  assert.equal(decision.businessId, BUSINESS_A);
  assert.equal(decision.confidence, 0.95);
  assert.equal(decision.linkMethod, 'auto');
});

test('valid weak and claimed-strong candidates keep their outcomes', () => {
  const weak = identity.decideIdentity({
    candidates: [candidate(BUSINESS_A, { matchedTypes: ['business_name', 'email_exact'] })]
  });
  assert.equal(weak.action, 'queue_for_review');
  assert.equal(weak.resolutionStatus, 'probable_match');
  assert.equal(weak.businessId, null);

  const claimed = identity.decideIdentity({
    candidates: [candidate(BUSINESS_A, {
      matchedTypes: ['gbp_place_id'], claimedStrongTypes: ['gbp_place_id']
    })]
  });
  assert.equal(claimed.action, 'queue_for_review');
  assert.equal(claimed.resolutionStatus, 'manual_review_required',
    'an unverified claim is an assertion, not evidence of identity');

  const twoVerified = identity.decideIdentity({
    candidates: [
      candidate(BUSINESS_A, { matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id'] }),
      candidate(BUSINESS_B, { matchedTypes: ['payment_customer_id'], verifiedStrongTypes: ['payment_customer_id'] })
    ]
  });
  assert.equal(twoVerified.action, 'queue_for_review');
  assert.equal(twoVerified.resolutionStatus, 'possible_duplicate');
});

test('a valid merged-away candidate is still ineligible — after validation, not instead of it', () => {
  const decision = identity.decideIdentity({
    candidates: [candidate(BUSINESS_A, {
      matchedTypes: ['gbp_place_id'],
      verifiedStrongTypes: ['gbp_place_id'],
      recordStatus: 'merged_away'
    })]
  });
  assert.equal(decision.action, 'create_new_record',
    'excluded as a link target, which is a decision about a well-formed candidate');

  /* And a merged-away candidate with an invalid id is still a broken lookup:
     the exclusion does not excuse the structure. */
  assert.throws(
    () => identity.decideIdentity({
      candidates: [candidate('not-a-uuid', {
        verifiedStrongTypes: ['gbp_place_id'], recordStatus: 'merged_away'
      })]
    }),
    /businessId must be a UUID/);
});

test('assertCandidates is exported and returns the list unchanged', () => {
  const list = [candidate(BUSINESS_A), candidate(BUSINESS_B)];
  assert.equal(identity.assertCandidates(list), list, 'the same array, not a copy');
  assert.deepEqual(identity.assertCandidates(null), []);
  assert.deepEqual(identity.assertCandidates(undefined), []);
  assert.throws(() => identity.assertCandidates([candidate('not-a-uuid')]),
    /businessId must be a UUID/);
});

/* ---------- sparse arrays ----------

   `Array.prototype.forEach` skips holes. So does `map`, `filter`, `some`,
   `every` and `reduce` — the whole family treats a hole as "not there". Both
   contracts were built on `forEach`, so `new Array(1)` had `length === 1`,
   no index `0`, and validated successfully while inspecting nothing.

   The v9 audit's reproductions, and they are the two worst outcomes this
   module has:

     · `decideIdentity({ candidates: new Array(1) })` -> create_new_record.
       A second permanent record, from a lookup nobody read.
     · `decideIdentity({ proposals: new Array(1), candidates: [] })` ->
       `link_to_existing`, confidence 1, `businessId: undefined`,
       `candidateBusinessIds: [undefined]`, `linkMethod: 'session'`.
       `map` preserved the hole, `new Set([<hole>])` yielded `undefined`, and
       the link branch found exactly one "distinct" business id.

   A hole is not an absent element. It is a position the caller declared and
   did not fill. */

const hole = () => new Array(1);

const sparseBefore = value => {
  const list = new Array(2);
  list[1] = value;
  return list;
};

const sparseAfter = value => {
  const list = new Array(2);
  list[0] = value;
  return list;
};

const goodCandidate = () => candidate(BUSINESS_A, {
  matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id']
});

const goodProposal = (kind = 'session') => ({
  kind, businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD
});

/* ---------- candidates ---------- */

test('a sparse candidate array cannot become create_new_record', () => {
  assert.throws(() => identity.decideIdentity({ candidates: hole() }),
    /position 0 of 1 is a hole/i);
  assert.throws(() => identity.assertCandidates(hole()),
    /position 0 of 1 is a hole/i);

  /* The reproduction returned create_new_record — a permanent record from a
     lookup that was never read. */
  assert.throws(() => identity.decideIdentity({ candidates: new Array(3) }),
    /position 0 of 3 is a hole/i);
});

test('a hole before or after a valid candidate still throws', () => {
  assert.throws(
    () => identity.decideIdentity({ candidates: sparseBefore(goodCandidate()) }),
    /position 0 of 2 is a hole/i,
    'the hole is first; the valid candidate must not carry the array');

  assert.throws(
    () => identity.decideIdentity({ candidates: sparseAfter(goodCandidate()) }),
    /position 1 of 2 is a hole/i,
    'the hole is last; it used to be skipped and the valid one linked at 0.95');
});

test('a sparse candidate array cannot become link_to_existing', () => {
  /* Exactly the audit's second candidate reproduction. */
  const list = new Array(2);
  list[0] = goodCandidate();
  assert.throws(() => identity.decideIdentity({ candidates: list }),
    /is a hole/);

  /* And nothing about it reaches a decision at all. */
  let decision = null;
  try { decision = identity.decideIdentity({ candidates: list }); } catch { /* expected */ }
  assert.equal(decision, null);
});

/* ---------- proposals ---------- */

test('a sparse proposal array cannot become a link, for either kind', () => {
  for (const kind of ['session', 'continuation_context']) {
    assert.throws(
      () => identity.resolveIdentityProposals({ proposals: hole(), signals: [] }),
      /position 0 of 1 is a hole/i, `${kind}: resolveIdentityProposals`);

    assert.throws(
      () => identity.decideIdentity({ proposals: hole(), candidates: [] }),
      /position 0 of 1 is a hole/i, `${kind}: decideIdentity`);

    assert.throws(
      () => identity.decideIdentity({ proposals: sparseBefore(goodProposal(kind)), candidates: [] }),
      /position 0 of 2 is a hole/i, `${kind}: hole first`);

    assert.throws(
      () => identity.decideIdentity({ proposals: sparseAfter(goodProposal(kind)), candidates: [] }),
      /position 1 of 2 is a hole/i, `${kind}: hole last`);
  }

  assert.throws(() => identity.assertProposals(hole()), /position 0 of 1 is a hole/i);
});

test('sparse input can put undefined into nothing at all', () => {
  /* The reproduction returned businessId: undefined and
     candidateBusinessIds: [undefined]. Now no decision is returned, so there
     is nothing to inspect — which is the assertion. */
  const shapes = [
    () => identity.decideIdentity({ proposals: hole(), candidates: [] }),
    () => identity.decideIdentity({ candidates: hole() }),
    () => identity.decideIdentity({ proposals: sparseAfter(goodProposal()), candidates: [] }),
    () => identity.decideIdentity({ candidates: sparseAfter(goodCandidate()) }),
    () => identity.resolveIdentityProposals({ proposals: hole(), signals: [] })
  ];

  shapes.forEach((run, i) => {
    let result = null;
    assert.throws(() => { result = run(); }, TypeError, `shape ${i}`);
    assert.equal(result, null, `shape ${i} returned something`);
  });
});

test('the link postcondition refuses a link target that is not a UUID', () => {
  /* A defensive invariant rather than an input check: every input path
     already validates its ids, so this can only fire if a future change lets
     one through — which is precisely what the hole did, reaching the link
     branch through `map` and `new Set` rather than through any input. */
  assert.equal(typeof identity.isBusinessId, 'function');

  const linked = identity.decideIdentity({
    proposals: [goodProposal()], signals: signalsFor(SALON_A_CONTACT)
  });
  assert.equal(linked.action, 'link_to_existing');
  assert.equal(identity.isBusinessId(linked.businessId), true,
    'a link always carries a UUID');

  const viaCandidate = identity.decideIdentity({ candidates: [goodCandidate()] });
  assert.equal(viaCandidate.action, 'link_to_existing');
  assert.equal(identity.isBusinessId(viaCandidate.businessId), true);

  const viaResolver = identity.resolveIdentityProposals({
    proposals: [goodProposal()], signals: signalsFor(SALON_A_CONTACT)
  });
  assert.equal(viaResolver.outcome, 'link');
  assert.equal(identity.isBusinessId(viaResolver.businessId), true);
});

/* ---------- dense arrays are untouched ---------- */

test('dense empty arrays remain legal', () => {
  assert.equal(identity.decideIdentity({ candidates: [] }).action, 'create_new_record');
  assert.equal(identity.decideIdentity({ proposals: [], candidates: [] }).action,
    'create_new_record');
  assert.deepEqual(identity.assertCandidates([]), []);
  assert.deepEqual(identity.assertProposals([]), []);
  assert.equal(
    identity.resolveIdentityProposals({ proposals: [], signals: [] }).outcome,
    'no_proposal');

  /* Absent and null stay legal too — "none supplied" is not "malformed". */
  assert.equal(identity.decideIdentity({}).action, 'create_new_record');
  assert.equal(identity.decideIdentity({ candidates: null, proposals: null }).action,
    'create_new_record');
});

test('dense valid candidates and proposals behave exactly as before', () => {
  const linked = identity.decideIdentity({ candidates: [goodCandidate()] });
  assert.equal(linked.action, 'link_to_existing');
  assert.equal(linked.businessId, BUSINESS_A);
  assert.equal(linked.confidence, 0.95);

  const proposed = identity.decideIdentity({
    proposals: [goodProposal()], signals: signalsFor(SALON_A_CONTACT)
  });
  assert.equal(proposed.action, 'link_to_existing');
  assert.equal(proposed.businessId, BUSINESS_ID);
  assert.equal(proposed.linkMethod, 'session');
  assert.equal(proposed.confidence, 1);

  const contradicted = identity.decideIdentity({
    proposals: [goodProposal()], signals: signalsFor(SALON_B_CONTACT)
  });
  assert.equal(contradicted.action, 'queue_for_review');
  assert.equal(contradicted.businessId, null);

  /* An explicitly dense two-element array with both positions filled. */
  const two = identity.decideIdentity({
    candidates: [
      candidate(BUSINESS_A, { matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id'] }),
      candidate(BUSINESS_B, { matchedTypes: ['payment_customer_id'], verifiedStrongTypes: ['payment_customer_id'] })
    ]
  });
  assert.equal(two.action, 'queue_for_review');
  assert.equal(two.resolutionStatus, 'possible_duplicate');
});

test('the id property walks every exported decision shape, including the sparse ones', () => {
  /* The v9 version of this test walked only shapes that RETURN. A shape that
     throws returns no ids at all, which is the stronger guarantee — but it
     has to be checked rather than assumed. */
  const returning = [
    identity.decideIdentity({ candidates: [] }),
    identity.decideIdentity({ candidates: [goodCandidate()] }),
    identity.decideIdentity({
      candidates: [candidate(BUSINESS_A, { matchedTypes: ['business_name'] })]
    }),
    identity.decideIdentity({
      candidates: [
        candidate(BUSINESS_A, { matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id'] }),
        candidate(BUSINESS_B, { matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id'] })
      ]
    }),
    identity.decideIdentity({
      proposals: [goodProposal()], signals: signalsFor(SALON_A_CONTACT)
    }),
    identity.decideIdentity({
      proposals: [goodProposal()], signals: signalsFor(SALON_B_CONTACT)
    }),
    identity.decideIdentity({
      proposals: [goodProposal('session'),
                  { kind: 'continuation_context', businessId: BUSINESS_B,
                    heldIdentifiers: [{ type: 'email_exact', normalizedValue: 'someone@riverside.test' }] }],
      signals: signalsFor({ salonName: 'Polished Nail Studio', email: 'someone@riverside.test' })
    })
  ];

  /* Collects the ids a decision actually REPORTS. An absent property is not a
     reported id — `conflictingSignals` entries of kind `proposals_disagree`
     carry `businessIds` and no singular `businessId`, and reading the missing
     one would test how this list was gathered rather than what was returned.
     A property that IS present must be a UUID or an explicit null. */
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  const ids = decision => {
    const found = [];
    if (has(decision, 'businessId')) found.push(decision.businessId);
    (decision.candidateBusinessIds || []).forEach(v => found.push(v));
    (decision.conflictingSignals || []).forEach(c => {
      if (has(c, 'businessId')) found.push(c.businessId);
      (c.businessIds || []).forEach(v => found.push(v));
    });
    return found;
  };

  returning.forEach((decision, i) => {
    const reported = ids(decision);
    assert.ok(reported.length >= 1, `decision ${i}: nothing collected`);
    reported.forEach(value => {
      if (value === null) return;      /* "no record", stated explicitly */
      assert.notEqual(value, undefined,
        `decision ${i}: an id slot may be null, never undefined`);
      assert.equal(identity.isBusinessId(value), true,
        `decision ${i}: ${JSON.stringify(value)} is not a Business Record id`);
    });
  });

  /* And the resolver's own judged list. */
  const judged = identity.resolveIdentityProposals({
    proposals: [goodProposal()], signals: signalsFor(SALON_A_CONTACT)
  }).judged;
  judged.forEach(p => assert.equal(identity.isBusinessId(p.businessId), true));
});

/* ---------- the OTHER operand, and every nested list ----------

   Two defects, one shape. `heldIdentifiers` was made required and
   `signals = []` was left sitting beside it doing the identical job from the
   other direction — `proposalConflict({ heldIdentifiers })` returned
   `material: false` and linked with confidence 1. And the position walker
   protected the outer `candidates` and `proposals` while every nested
   decision-bearing list still used hole-skipping iteration.

   The reproductions, all of which linked or weakened a review:

     · omitted or null `signals`
     · `heldIdentifiers: new Array(1)`
     · a real name contradiction plus a hole where contact evidence belongs
     · `heldIdentifiers: [null]`
     · sparse submitted signals
     · sparse `matchedTypes` — links at 0.95 and puts `undefined` into
       `contributingSignals`
     · sparse verified or claimed arrays — silently reclassifies the review */

const HELD_A = SALON_A_HELD;
const sparseWith = (value, position) => {
  const list = new Array(2);
  list[position] = value;
  return list;
};

/* ---------- 1. the submitted operand ---------- */

test('omitted or null signals throw at the primitive', () => {
  assert.throws(() => identity.proposalConflict({ heldIdentifiers: HELD_A }),
    /requires signals/, 'omitted');
  assert.throws(() => identity.proposalConflict({ signals: null, heldIdentifiers: HELD_A }),
    /requires signals/, 'null');
  [{}, 'business_name', 42, true, new Set()].forEach(value => {
    assert.throws(() => identity.proposalConflict({ signals: value, heldIdentifiers: HELD_A }),
      /signals to be an array/, JSON.stringify(value));
  });

  /* Explicit [] stays valid: "the submission genuinely carries none". */
  assert.equal(
    identity.proposalConflict({ signals: [], heldIdentifiers: HELD_A }).material, false);
});

test('omitted or null signals throw at the resolver and at decideIdentity', () => {
  const proposals = [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: HELD_A }];

  assert.throws(() => identity.resolveIdentityProposals({ proposals }),
    /requires signals/);
  assert.throws(() => identity.resolveIdentityProposals({ signals: null, proposals }),
    /requires signals/);
  assert.throws(() => identity.decideIdentity({ proposals, candidates: [] }),
    /requires signals/);
  assert.throws(() => identity.decideIdentity({ signals: null, proposals, candidates: [] }),
    /requires signals/);

  /* Candidate-only resolution never compares signals against a proposed
     record, so it keeps working without them. */
  assert.equal(identity.decideIdentity({ candidates: [] }).action, 'create_new_record');
  assert.equal(
    identity.decideIdentity({ candidates: [goodCandidate()] }).action, 'link_to_existing');
});

test('sparse signals throw, hole before or after a valid one', () => {
  /* Canonical: normalizeName strips 'co' as a legal suffix, so the value the
     platform actually stores for "Riverside Barber Co" is 'riverside barber'. */
  const valid = { type: 'business_name', normalizedValue: 'riverside barber' };
  [0, 1].forEach(position => {
    assert.throws(() => identity.proposalConflict({
      signals: sparseWith(valid, position === 0 ? 1 : 0), heldIdentifiers: HELD_A
    }), /signals: position \d of 2 is a hole/, `hole at ${position}`);
  });
  assert.throws(() => identity.proposalConflict({
    signals: new Array(1), heldIdentifiers: HELD_A
  }), /signals: position 0 of 1 is a hole/);
});

/* ---------- 2. the held operand ---------- */

test('sparse heldIdentifiers throw, for both proposal kinds', () => {
  for (const kind of ['session', 'continuation_context']) {
    assert.throws(() => identity.decideIdentity({
      signals: signalsFor(SALON_B_CONTACT),
      proposals: [{ kind, businessId: BUSINESS_ID, heldIdentifiers: new Array(1) }],
      candidates: []
    }), /heldIdentifiers: position 0 of 1 is a hole/, kind);
  }
});

test('a hole where contact evidence belongs cannot survive beside a real contradiction', () => {
  /* The dangerous one: the name genuinely contradicts, and the hole is where
     the contact evidence that would make it MATERIAL should be. Skipping it
     turned a different business into a rebrand, and linked. */
  const held = new Array(2);
  held[0] = { type: 'business_name', normalizedValue: 'polished nail studio' };
  /* held[1] — the email — is a hole */

  assert.throws(() => identity.proposalConflict({
    signals: signalsFor(SALON_B_CONTACT), heldIdentifiers: held
  }), /heldIdentifiers: position 1 of 2 is a hole/);

  /* Dense, it is material — which is what the hole was hiding. */
  held[1] = { type: 'email_exact', normalizedValue: 'owner@polished.test' };
  assert.equal(identity.proposalConflict({
    signals: signalsFor(SALON_B_CONTACT), heldIdentifiers: held
  }).material, true);
});

test('dense malformed evidence entries throw rather than being ignored', () => {
  const bad = [
    [null, /must be an object/],
    [undefined, /must be an object/],
    [{}, /type must be a recognized identifier type/],
    ['business_name', /must be an object/],
    [42, /must be an object/],
    [[], /must be an object/],
    [{ type: 'business_name' }, /normalizedValue must be a non-empty/],
    [{ normalizedValue: 'polished nail studio' }, /type must be a recognized/],
    [{ type: 'not_a_type', normalizedValue: 'x' }, /type must be a recognized/],
    [{ type: 'business_name', normalizedValue: '' }, /normalizedValue must be a non-empty/],
    [{ type: 'business_name', normalizedValue: '   ' }, /normalizedValue must be a non-empty/],
    [{ type: 'business_name', normalizedValue: 42 }, /normalizedValue must be a non-empty/]
  ];

  bad.forEach(([entry, pattern]) => {
    assert.throws(() => identity.proposalConflict({
      signals: signalsFor(SALON_B_CONTACT), heldIdentifiers: [entry]
    }), pattern, `held ${JSON.stringify(entry)}`);

    assert.throws(() => identity.proposalConflict({
      signals: [entry], heldIdentifiers: HELD_A
    }), pattern, `signal ${JSON.stringify(entry)}`);
  });
});

test('one malformed entry among valid ones fails the whole comparison', () => {
  const held = [
    { type: 'business_name', normalizedValue: 'polished nail studio' },
    null,
    { type: 'email_exact', normalizedValue: 'owner@polished.test' }
  ];
  assert.throws(() => identity.proposalConflict({
    signals: signalsFor(SALON_A_CONTACT), heldIdentifiers: held
  }), /heldIdentifiers\[1\] must be an object/);

  /* And the error names the position, so a caller can find it. */
  assert.throws(() => identity.decideIdentity({
    signals: signalsFor(SALON_A_CONTACT),
    proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: held }],
    candidates: []
  }), /heldIdentifiers\[1\]/);
});

/* ---------- 3. candidate evidence ---------- */

test('sparse candidate evidence arrays throw, hole before and after', () => {
  ['matchedTypes', 'verifiedStrongTypes', 'claimedStrongTypes'].forEach(field => {
    [0, 1].forEach(holeAt => {
      const list = new Array(2);
      list[holeAt === 0 ? 1 : 0] = 'gbp_place_id';
      const c = candidate(BUSINESS_A, {
        matchedTypes: field === 'matchedTypes' ? list : ['gbp_place_id'],
        [field]: list
      });
      assert.throws(() => identity.decideIdentity({ candidates: [c] }),
        new RegExp(`${field}: position \\d of 2 is a hole`),
        `${field}, hole at ${holeAt}`);
    });

    const c = candidate(BUSINESS_A, {
      matchedTypes: field === 'matchedTypes' ? new Array(1) : ['gbp_place_id'],
      [field]: new Array(1)
    });
    assert.throws(() => identity.decideIdentity({ candidates: [c] }),
      new RegExp(`${field}: position 0 of 1 is a hole`), field);
  });
});

test('a candidate evidence entry must be a recognized identifier type', () => {
  [null, undefined, {}, 42, 'not_a_type', ''].forEach(entry => {
    assert.throws(() => identity.decideIdentity({
      candidates: [candidate(BUSINESS_A, { matchedTypes: [entry] })]
    }), /matchedTypes\[0\] must be one of/, JSON.stringify(entry));
  });

  /* The strong arrays use the established strong vocabulary — a lookup
     calling email_exact a strong type has misread the schema. These are all
     REAL identifier types, so `matchedTypes` accepts them and the refusal
     comes from the strong vocabulary rather than from the wider one. */
  ['email_exact', 'business_name', 'vertical'].forEach(type => {
    assert.throws(() => identity.decideIdentity({
      candidates: [candidate(BUSINESS_A, {
        matchedTypes: [type], verifiedStrongTypes: [type]
      })]
    }), /verifiedStrongTypes\[0\] must be one of/, type);
  });

  /* An unknown type is refused by whichever array reaches it first —
     `matchedTypes` is validated before the strong arrays. */
  assert.throws(() => identity.decideIdentity({
    candidates: [candidate(BUSINESS_A, {
      matchedTypes: ['not_a_type'], verifiedStrongTypes: ['not_a_type']
    })]
  }), /matchedTypes\[0\] must be one of/);
  assert.throws(() => identity.decideIdentity({
    candidates: [candidate(BUSINESS_A, {
      matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['not_a_type']
    })]
  }), /verifiedStrongTypes\[0\] must be one of/);
});

test('a strong type the candidate did not match is a lookup contradicting itself', () => {
  /* The dangerous combination: matchedTypes empty, verifiedStrongTypes set.
     It auto-linked at 0.95 while reporting that it had matched nothing. */
  assert.throws(() => identity.decideIdentity({
    candidates: [candidate(BUSINESS_A, {
      matchedTypes: [], verifiedStrongTypes: ['gbp_place_id']
    })]
  }), /verifiedStrongTypes names gbp_place_id, which .*matchedTypes does not contain/);

  assert.throws(() => identity.decideIdentity({
    candidates: [candidate(BUSINESS_A, {
      matchedTypes: ['business_name'], claimedStrongTypes: ['payment_customer_id']
    })]
  }), /claimedStrongTypes names payment_customer_id/);

  /* Represented, it is accepted and links. */
  const ok = identity.decideIdentity({
    candidates: [candidate(BUSINESS_A, {
      matchedTypes: ['gbp_place_id', 'business_name'], verifiedStrongTypes: ['gbp_place_id']
    })]
  });
  assert.equal(ok.action, 'link_to_existing');
  assert.equal(ok.confidence, 0.95);
});

test('one malformed nested array among otherwise valid candidates fails the decision', () => {
  assert.throws(() => identity.decideIdentity({
    candidates: [
      candidate(BUSINESS_A, { matchedTypes: ['business_name'] }),
      candidate(BUSINESS_B, { matchedTypes: new Array(1) })
    ]
  }), /candidates\[1\]\.matchedTypes: position 0 of 1 is a hole/);

  assert.throws(() => identity.decideIdentity({
    candidates: [
      candidate(BUSINESS_A, { matchedTypes: [null] }),
      candidate(BUSINESS_B, { matchedTypes: ['business_name'] })
    ]
  }), /candidates\[0\]\.matchedTypes\[0\] must be one of/);
});

test('no malformed nested evidence can create, link, or weaken a review', () => {
  const shapes = [
    () => identity.decideIdentity({ candidates: [candidate(BUSINESS_A, { matchedTypes: new Array(1) })] }),
    () => identity.decideIdentity({ candidates: [candidate(BUSINESS_A, {
      matchedTypes: ['gbp_place_id'], verifiedStrongTypes: new Array(1) })] }),
    () => identity.decideIdentity({ candidates: [candidate(BUSINESS_A, {
      matchedTypes: ['gbp_place_id'], claimedStrongTypes: new Array(1) })] }),
    () => identity.decideIdentity({ candidates: [candidate(BUSINESS_A, {
      matchedTypes: [], verifiedStrongTypes: ['gbp_place_id'] })] }),
    () => identity.decideIdentity({
      signals: signalsFor(SALON_B_CONTACT),
      proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: [null] }],
      candidates: [] }),
    () => identity.decideIdentity({
      signals: [null],
      proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: HELD_A }],
      candidates: [] })
  ];

  shapes.forEach((run, i) => {
    let result = null;
    assert.throws(() => { result = run(); }, TypeError, `shape ${i}`);
    assert.equal(result, null,
      `shape ${i} produced a decision from malformed evidence`);
  });
});

test('no returned signal field carries undefined or an unknown identifier type', () => {
  const decisions = [
    identity.decideIdentity({
      candidates: [candidate(BUSINESS_A, {
        matchedTypes: ['gbp_place_id', 'business_name'], verifiedStrongTypes: ['gbp_place_id']
      })]
    }),
    identity.decideIdentity({
      candidates: [candidate(BUSINESS_A, { matchedTypes: ['business_name', 'email_exact'] })]
    }),
    identity.decideIdentity({
      candidates: [
        candidate(BUSINESS_A, { matchedTypes: ['gbp_place_id'], verifiedStrongTypes: ['gbp_place_id'] }),
        candidate(BUSINESS_B, { matchedTypes: ['payment_customer_id'], claimedStrongTypes: ['payment_customer_id'] })
      ]
    }),
    identity.decideIdentity({
      signals: signalsFor(SALON_B_CONTACT),
      proposals: [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: HELD_A }],
      candidates: []
    })
  ];

  const known = new Set(identity.IDENTIFIER_TYPE_NAMES
    .concat(['assessment_session_link', 'server_issued_continuation_context']));

  decisions.forEach((decision, i) => {
    (decision.contributingSignals || []).forEach(value => {
      assert.notEqual(value, undefined, `decision ${i}: undefined in contributingSignals`);
      assert.ok(known.has(value), `decision ${i}: ${JSON.stringify(value)} is not a known signal`);
    });
    (decision.conflictingSignals || []).forEach(c => {
      [...(c.matchedTypes || []), ...(c.claimedStrongTypes || []),
       ...(c.agreedTypes || []), ...(c.contradictedTypes || [])].forEach(type => {
        assert.notEqual(type, undefined, `decision ${i}: undefined identifier type`);
        assert.ok(identity.IDENTIFIER_TYPE_NAMES.includes(type),
          `decision ${i}: ${JSON.stringify(type)} is not an identifier type`);
      });
    });
  });
});

/* ---------- 4. dense regressions ---------- */

test('dense valid evidence behaves exactly as before', () => {
  /* Explicit empties on both operands. */
  assert.equal(identity.proposalConflict({ signals: [], heldIdentifiers: [] }).material, false);
  assert.equal(
    identity.proposalConflict({ signals: signalsFor(SALON_B_CONTACT), heldIdentifiers: [] }).material,
    false, 'a record holding nothing comparable cannot contradict');
  assert.equal(
    identity.proposalConflict({ signals: [], heldIdentifiers: HELD_A }).material,
    false, 'a submission carrying nothing cannot contradict either');

  /* The rule itself, unchanged. */
  assert.equal(
    identity.proposalConflict({ signals: signalsFor(SALON_A_CONTACT), heldIdentifiers: HELD_A }).material,
    false, 'same business');
  assert.equal(
    identity.proposalConflict({ signals: signalsFor(SALON_B_CONTACT), heldIdentifiers: HELD_A }).material,
    true, 'different business');
  assert.equal(
    identity.proposalConflict({
      signals: signalsFor({ ...SALON_A_CONTACT, salonName: 'Polished Nails and Spa' }),
      heldIdentifiers: HELD_A
    }).material, false, 'rebrand');

  /* Context types are still excluded from comparison rather than refused —
     a rule, not a tolerance. */
  const withVertical = identity.extractIdentitySignals({
    contact: SALON_B_CONTACT, vertical: { id: 'nails' }
  });
  assert.ok(withVertical.some(s => s.type === 'vertical'));
  assert.equal(
    identity.proposalConflict({ signals: withVertical, heldIdentifiers: HELD_A }).material, true);

  /* The low-level list validators are module-private — exporting them so a
     test could call them would be exporting them for no other reason, and an
     exported list validator that accepts a non-array is a validator with its
     own bypass. They are exercised through the public surface instead. */
  assert.equal(identity.assertEvidenceList, undefined);
  assert.equal(identity.assertTypeList, undefined);
});

/* ---------- the VALUE matters as much as the type ----------

   `evidenceFault` required a recognized type and a nonblank string, and
   nothing else. So `gbp_place_id: "x"` — a value `isAcceptableValue` has
   always refused — appeared on both sides, counted as AGREEMENT, and
   neutralised a genuine name-and-email contradiction. Two records sharing
   nothing but an impossible identifier linked at confidence 1.

   Agreement is the dangerous direction: a contradiction only sends a
   submission to review, while an agreement is what lets one link. So evidence
   this platform could not have produced is refused rather than compared. */

const SALON_A_SIGNALS = () => signalsFor(SALON_A_CONTACT);
const SALON_B_SIGNALS = () => signalsFor(SALON_B_CONTACT);

const withEvidence = (list, extra) => list.concat([extra]);

const proposalOf = (kind, held) => ({ kind, businessId: BUSINESS_ID, heldIdentifiers: held });

/* The audit's reproduction, end to end. */
test('an impossible strong identifier cannot become agreement', () => {
  const junk = { type: 'gbp_place_id', normalizedValue: 'x' };
  assert.equal(identity.isAcceptableValue('gbp_place_id', 'x'), false,
    'the module has always refused this value');

  assert.throws(() => identity.proposalConflict({
    signals: withEvidence(SALON_B_SIGNALS(), junk),
    heldIdentifiers: withEvidence(SALON_A_HELD, junk)
  }), /not an acceptable gbp_place_id value/);

  /* Without it, the same submission is a genuine contradiction — which is
     exactly what the junk was neutralising. */
  assert.equal(identity.proposalConflict({
    signals: SALON_B_SIGNALS(), heldIdentifiers: SALON_A_HELD
  }).material, true);
});

test('every strong identifier type enforces its own format', () => {
  const badly = {
    gbp_place_id: ['x', 'ab', 'has spaces', 'x'.repeat(129)],
    external_customer_id: ['ab', 'a b c', 'x'.repeat(129)],
    payment_customer_id: ['abc', 'has spaces', 'x'.repeat(129)]
  };

  Object.entries(badly).forEach(([type, values]) => {
    values.forEach(normalizedValue => {
      assert.equal(identity.isAcceptableValue(type, normalizedValue), false,
        `${type} ${JSON.stringify(normalizedValue)}`);
      assert.throws(() => identity.proposalConflict({
        signals: [{ type, normalizedValue }], heldIdentifiers: SALON_A_HELD
      }), new RegExp(`not an acceptable ${type} value`), `${type} ${normalizedValue}`);
    });
  });
});

test('a value longer than MAX_IDENTIFIER_LENGTH is refused for any type', () => {
  const tooLong = 'a'.repeat(257);
  ['business_name', 'email_exact', 'website_domain', 'vertical', 'gbp_place_id']
    .forEach(type => {
      assert.throws(() => identity.proposalConflict({
        signals: [{ type, normalizedValue: tooLong }], heldIdentifiers: SALON_A_HELD
      }), /is not an acceptable/, type);
    });

  /* And exactly at the limit, for a type with no format, it is accepted —
     the boundary itself is not moved. */
  const atLimit = 'a'.repeat(256);
  assert.equal(identity.isAcceptableValue('business_name', atLimit), true);
});

test('a non-canonical value is refused by the normalizer that would have produced it', () => {
  const notCanonical = [
    ['email_exact', 'Owner@Polished.TEST', identity.normalizeEmail],
    ['email_exact', 'owner+tag@polished.test', identity.normalizeEmail],
    ['email_exact', ' owner@polished.test ', identity.normalizeEmail],
    ['email_domain', 'Polished.TEST', identity.normalizeDomain],
    ['email_domain', 'www.polished.test', identity.normalizeDomain],
    ['website_domain', 'https://www.polished.test/book', identity.normalizeDomain],
    ['website_domain', 'Polished.TEST', identity.normalizeDomain],
    ['business_phone', '(864) 555-0134', identity.normalizePhone],
    ['mobile_phone', '864-555-0134', identity.normalizePhone],
    ['business_name', 'Polished Nail Studio', identity.normalizeName],
    ['business_name', 'Polished Nail Studio, LLC', identity.normalizeName],
    ['business_name', 'polished  nail  studio', identity.normalizeName]
  ];

  notCanonical.forEach(([type, normalizedValue, normalizer]) => {
    assert.notEqual(normalizer(normalizedValue), normalizedValue,
      `${type} ${JSON.stringify(normalizedValue)} should not be canonical`);
    assert.throws(() => identity.proposalConflict({
      signals: [{ type, normalizedValue }], heldIdentifiers: SALON_A_HELD
    }), new RegExp(`not canonical for ${type}`), `${type} ${normalizedValue}`);
  });

  /* A free-mail email_domain is not a value emailDomain can produce — the
     existing rule is that free mail carries no identity information. */
  assert.throws(() => identity.proposalConflict({
    signals: [{ type: 'email_domain', normalizedValue: 'gmail.com' }],
    heldIdentifiers: SALON_A_HELD
  }), /not canonical for email_domain/);
});

test('invalid evidence on one side only still throws, and matching junk is not agreement', () => {
  const junk = { type: 'gbp_place_id', normalizedValue: 'x' };

  /* Submitted side only. */
  assert.throws(() => identity.proposalConflict({
    signals: withEvidence(SALON_B_SIGNALS(), junk), heldIdentifiers: SALON_A_HELD
  }), /signals\[\d+\]\.normalizedValue is not an acceptable/);

  /* Held side only. */
  assert.throws(() => identity.proposalConflict({
    signals: SALON_B_SIGNALS(), heldIdentifiers: withEvidence(SALON_A_HELD, junk)
  }), /heldIdentifiers\[\d+\]\.normalizedValue is not an acceptable/);

  /* Both sides — matching invalid data is not agreement, it is a refusal. */
  assert.throws(() => identity.proposalConflict({
    signals: withEvidence(SALON_B_SIGNALS(), junk),
    heldIdentifiers: withEvidence(SALON_A_HELD, junk)
  }), /not an acceptable/);
});

test('one invalid value among valid evidence fails the complete comparison', () => {
  const held = [
    { type: 'business_name', normalizedValue: 'polished nail studio' },
    { type: 'gbp_place_id', normalizedValue: 'x' },
    { type: 'email_exact', normalizedValue: 'owner@polished.test' }
  ];
  assert.throws(() => identity.proposalConflict({
    signals: SALON_A_SIGNALS(), heldIdentifiers: held
  }), /heldIdentifiers\[1\]\.normalizedValue is not an acceptable/,
    'the position is named so a caller can find it');
});

test('semantic-invalid evidence is refused at every surface, for both kinds', () => {
  const junk = { type: 'gbp_place_id', normalizedValue: 'x' };
  const held = withEvidence(SALON_A_HELD, junk);

  for (const kind of ['session', 'continuation_context']) {
    assert.throws(() => identity.proposalConflict({
      signals: SALON_B_SIGNALS(), heldIdentifiers: held
    }), /not an acceptable/, `${kind}: primitive`);

    assert.throws(() => identity.resolveIdentityProposals({
      signals: SALON_B_SIGNALS(), proposals: [proposalOf(kind, held)]
    }), /not an acceptable/, `${kind}: resolver`);

    assert.throws(() => identity.decideIdentity({
      signals: SALON_B_SIGNALS(), proposals: [proposalOf(kind, held)], candidates: []
    }), /not an acceptable/, `${kind}: decideIdentity`);

    /* And on the submitted side. */
    assert.throws(() => identity.decideIdentity({
      signals: withEvidence(SALON_B_SIGNALS(), junk),
      proposals: [proposalOf(kind, SALON_A_HELD)], candidates: []
    }), /not an acceptable/, `${kind}: submitted side`);
  }
});

test('no semantic-invalid evidence can create, link, or weaken a review', () => {
  const junk = { type: 'gbp_place_id', normalizedValue: 'x' };
  const shapes = [
    () => identity.decideIdentity({
      signals: withEvidence(SALON_B_SIGNALS(), junk),
      proposals: [proposalOf('session', withEvidence(SALON_A_HELD, junk))],
      candidates: [] }),
    () => identity.decideIdentity({
      signals: [{ type: 'business_name', normalizedValue: 'Polished Nail Studio' }],
      proposals: [proposalOf('session', SALON_A_HELD)], candidates: [] }),
    () => identity.decideIdentity({
      signals: SALON_B_SIGNALS(),
      proposals: [proposalOf('continuation_context',
        [{ type: 'email_exact', normalizedValue: 'OWNER@POLISHED.TEST' }])],
      candidates: [] }),
    () => identity.resolveIdentityProposals({
      signals: SALON_B_SIGNALS(),
      proposals: [proposalOf('session', [{ type: 'payment_customer_id', normalizedValue: 'ab' }])] }),
    () => identity.proposalConflict({
      signals: [{ type: 'business_name', normalizedValue: 'a'.repeat(257) }],
      heldIdentifiers: SALON_A_HELD })
  ];

  shapes.forEach((run, i) => {
    let result = null;
    assert.throws(() => { result = run(); }, TypeError, `shape ${i}`);
    assert.equal(result, null, `shape ${i} produced a result from invalid evidence`);
  });
});

/* ---------- the exported-validator gaps ---------- */

test('assertProposals validates every held-identifier entry, not just the container', () => {
  /* It used to confirm the array existed and stop, so a caller who validated
     first and acted on the result acted on evidence nobody had read. */
  assert.throws(() => identity.assertProposals([
    { kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: [null] }
  ]), /heldIdentifiers\[0\] must be an object/);

  assert.throws(() => identity.assertProposals([
    { kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: new Array(1) }
  ]), /heldIdentifiers: position 0 of 1 is a hole/);

  assert.throws(() => identity.assertProposals([
    { kind: 'session', businessId: BUSINESS_ID,
      heldIdentifiers: [{ type: 'gbp_place_id', normalizedValue: 'x' }] }
  ]), /not an acceptable gbp_place_id value/);

  /* Dense and valid still returns the list unchanged. */
  const good = [{ kind: 'session', businessId: BUSINESS_ID, heldIdentifiers: SALON_A_HELD }];
  assert.equal(identity.assertProposals(good), good);
});

test('every retained exported list validator refuses a non-array', () => {
  [{}, 'candidates', 5, true, () => {}].forEach(value => {
    assert.throws(() => identity.assertCandidates(value), /must be an array/,
      `assertCandidates ${JSON.stringify(value)}`);
    assert.throws(() => identity.assertProposals(value), /must be an array/,
      `assertProposals ${JSON.stringify(value)}`);
  });

  /* Absent and null still mean "none supplied". */
  assert.deepEqual(identity.assertCandidates(null), []);
  assert.deepEqual(identity.assertProposals(undefined), []);
});

test('proposalConflict enforces both operands itself, not only through a caller', () => {
  /* Called directly, with no outer validation anywhere. */
  assert.throws(() => identity.proposalConflict({
    signals: {}, heldIdentifiers: SALON_A_HELD
  }), /signals to be an array/);
  assert.throws(() => identity.proposalConflict({
    signals: SALON_A_SIGNALS(), heldIdentifiers: {}
  }), /heldIdentifiers to be an array/);
  assert.throws(() => identity.proposalConflict({
    signals: SALON_A_SIGNALS(), heldIdentifiers: [{ type: 'business_name' }]
  }), /normalizedValue must be a non-empty/);
});

/* ---------- valid boundaries and real extraction ---------- */

test('every signal extraction produces stays valid unchanged', () => {
  const payloads = [
    { contact: { salonName: 'Polished Nail Studio, LLC', ownerName: 'Test Owner',
                 email: 'Owner+Tag@Polished.TEST', mobile: '(864) 555-0134',
                 website: 'https://www.polished.test/book', businessPhone: '864-555-0135',
                 googlePlaceId: 'ChIJrTLr-GyuEmsRBfy61i59si0' },
      vertical: { id: 'nails' } },
    { contact: { salonName: 'Riverside Barber Co', email: 'someone@riverside.test' } },
    { contact: { salonName: 'A Salon', email: 'x@gmail.com' } },
    makePayload()
  ];

  payloads.forEach((payload, i) => {
    const signals = identity.extractIdentitySignals(payload);
    assert.ok(signals.length, `payload ${i} produced no signals`);

    /* Every one passes the contract the comparison now enforces. */
    signals.forEach(s => {
      assert.equal(identity.isAcceptableValue(s.type, s.normalizedValue), true,
        `payload ${i}: ${s.type} ${JSON.stringify(s.normalizedValue)}`);
    });

    /* And the comparison accepts them on both sides. */
    const persistable = identity.persistableSignals(signals);
    assert.doesNotThrow(() => identity.proposalConflict({
      signals, heldIdentifiers: persistable.map(
        s => ({ type: s.type, normalizedValue: s.normalizedValue }))
    }), `payload ${i}`);

    /* A submission compared with its own identifiers is the same business. */
    assert.equal(identity.proposalConflict({
      signals,
      heldIdentifiers: persistable.map(s => ({ type: s.type, normalizedValue: s.normalizedValue }))
    }).material, false, `payload ${i}`);
  });
});

test('valid boundary values are accepted', () => {
  const boundary = [
    ['gbp_place_id', 'abcdef'],                       /* shortest permitted */
    ['gbp_place_id', 'a'.repeat(128)],                /* longest permitted */
    ['external_customer_id', 'ab-c'],
    ['payment_customer_id', 'cus_1234'],
    ['business_name', 'a'.repeat(256)],
    ['email_exact', 'owner@polished.test'],
    ['email_domain', 'polished.test'],
    ['website_domain', 'polished.test'],
    ['business_phone', '+18645550134'],
    ['mobile_phone', '+18645550134'],
    ['vertical', 'nails'],
    ['locality', 'greenville sc']
  ];

  boundary.forEach(([type, normalizedValue]) => {
    assert.doesNotThrow(() => identity.proposalConflict({
      signals: [{ type, normalizedValue }], heldIdentifiers: [{ type, normalizedValue }]
    }), `${type} ${normalizedValue}`);
  });

  /* And a shared valid strong identifier IS agreement — the rule refuses
     impossible values, not real ones. */
  const place = { type: 'gbp_place_id', normalizedValue: 'ChIJrTLr-GyuEmsRBfy61i59si0' };
  const verdict = identity.proposalConflict({
    signals: withEvidence(SALON_B_SIGNALS(), place),
    heldIdentifiers: withEvidence(SALON_A_HELD, place)
  });
  assert.equal(verdict.material, false,
    'a real shared place id is continuity, and outranks a name and email change');
  assert.ok(verdict.agreedTypes.includes('gbp_place_id'));
});

/* ============================================================
   v13 — opaque strong identifiers are case-preserving
   ------------------------------------------------------------
   `valuesByType` lower-cased every value before comparing. For the three
   opaque strong identifiers that is not a normalization, it is a collision:
   `Abcdef` and `abcdef` are two different places, two different external
   customers, two different processor handles — and two different rows under
   business_identifiers_strong_unique, which is a plain btree index.

   Reported as agreement, a case-distinct strong value outranks every
   contradiction there is. Each reproduction below carries a contradictory
   business NAME and a contradictory EMAIL, and before this change the folded
   strong value neutralised both and produced a confidence-1 link.
   ============================================================ */

const CASE_DISTINCT = [
  ['gbp_place_id',         'Abcdef',    'abcdef'],
  ['external_customer_id', 'Cust:Abcd', 'cust:abcd'],
  ['payment_customer_id',  'Cus_Abcd',  'cus_abcd']
];

test('case-distinct strong identifiers are not agreement, at every surface', () => {
  for (const [type, heldValue, submittedValue] of CASE_DISTINCT) {
    /* Both spellings are legitimate values — this is not the v12 rule
       refusing junk, it is the comparison telling two real values apart. */
    assert.equal(identity.isAcceptableValue(type, heldValue), true, `${type} held`);
    assert.equal(identity.isAcceptableValue(type, submittedValue), true, `${type} submitted`);

    const held = withEvidence(SALON_A_HELD, { type, normalizedValue: heldValue });
    const signals = withEvidence(SALON_B_SIGNALS(), { type, normalizedValue: submittedValue });

    const verdict = identity.proposalConflict({ signals, heldIdentifiers: held });
    assert.equal(verdict.agreedTypes.includes(type), false,
      `${type}: case-distinct values reported as agreement`);
    assert.ok(verdict.contradictedTypes.includes(type),
      `${type}: both sides hold a value of this type and they do not match`);
    assert.equal(verdict.material, true,
      `${type}: the real name and email contradiction must survive`);

    for (const kind of ['session', 'continuation_context']) {
      const resolved = identity.resolveIdentityProposals({
        signals, proposals: [proposalOf(kind, held)] });
      assert.notEqual(resolved.action, 'link_to_existing',
        `${type} ${kind}: resolver linked on a case-distinct value`);

      const decided = identity.decideIdentity({
        signals, proposals: [proposalOf(kind, held)], candidates: [] });
      assert.notEqual(decided.action, 'link_to_existing',
        `${type} ${kind}: decideIdentity linked on a case-distinct value`);
      assert.notEqual(decided.confidence, 1,
        `${type} ${kind}: confidence-1 on a case-distinct value`);
    }
  }
});

test('exact strong identifiers still establish continuity, all three types', () => {
  /* The approved rule is unchanged: one exact shared valid strong identifier
     outranks a name and email change. Only case folding was removed. */
  for (const [type, , value] of CASE_DISTINCT) {
    const shared = { type, normalizedValue: value };
    const verdict = identity.proposalConflict({
      signals: withEvidence(SALON_B_SIGNALS(), shared),
      heldIdentifiers: withEvidence(SALON_A_HELD, shared)
    });
    assert.ok(verdict.agreedTypes.includes(type), `${type} exact match is agreement`);
    assert.equal(verdict.material, false, `${type} exact match is continuity`);

    for (const kind of ['session', 'continuation_context']) {
      const decided = identity.decideIdentity({
        signals: withEvidence(SALON_B_SIGNALS(), shared),
        proposals: [proposalOf(kind, withEvidence(SALON_A_HELD, shared))],
        candidates: [] });
      assert.equal(decided.action, 'link_to_existing', `${type} ${kind}`);
      assert.equal(decided.businessId, BUSINESS_ID, `${type} ${kind}`);
    }
  }
});

test('case-distinct strong evidence cannot suppress a contradiction on its own', () => {
  /* Isolating the mechanism: the ONLY difference between these two runs is
     the case of the strong value. One is continuity, the other is a
     contradiction, and before this change both were continuity. */
  const [type, heldValue, submittedValue] = CASE_DISTINCT[0];
  const held = withEvidence(SALON_A_HELD, { type, normalizedValue: heldValue });

  const folded = identity.proposalConflict({
    signals: withEvidence(SALON_B_SIGNALS(), { type, normalizedValue: submittedValue }),
    heldIdentifiers: held });
  const exact = identity.proposalConflict({
    signals: withEvidence(SALON_B_SIGNALS(), { type, normalizedValue: heldValue }),
    heldIdentifiers: held });

  assert.equal(folded.material, true, 'differing case is a contradiction');
  assert.equal(exact.material, false, 'the same value is continuity');
  assert.notDeepEqual(folded.agreedTypes, exact.agreedTypes);
});

test('every comparable weak type arrives lower case, so exact comparison changed nothing', () => {
  /* This is what makes removing the fold safe rather than merely narrower:
     no weak type NEEDS case folding, because none can reach the comparison
     with an upper-case character in it. Pinned against IDENTIFIER_TYPES so a
     new weak type cannot be added without a canonicalizer. */
  const strongOrContext = ['gbp_place_id', 'external_customer_id', 'payment_customer_id',
                           'vertical', 'locality'];
  const samples = {
    email_exact: ['Owner@Polished.TEST', 'OWNER@polished.test'],
    email_domain: ['Polished.TEST'],
    website_domain: ['WWW.Polished.TEST'],
    business_phone: ['(864) 555-0134'],
    mobile_phone: ['864-555-0134'],
    business_name: ['Polished Nail Studio, LLC']
  };

  identity.IDENTIFIER_TYPE_NAMES.forEach(type => {
    if (strongOrContext.includes(type)) return;
    assert.ok(samples[type], `${type} has no sample — add one, or it is unproven`);
    samples[type].forEach(raw => {
      /* Whatever its canonicalizer produces has no upper case in it, so an
         exact comparison and a case-folded one give the same answer. */
      assert.throws(() => identity.proposalConflict({
        signals: [{ type, normalizedValue: raw }], heldIdentifiers: SALON_A_HELD
      }), /not canonical for/, `${type} ${raw} should be refused before comparison`);
    });
  });

  /* And the two context types never reach the comparison at all. */
  ['vertical', 'locality'].forEach(type => {
    const verdict = identity.proposalConflict({
      signals: [{ type, normalizedValue: 'Nails' }],
      heldIdentifiers: [{ type, normalizedValue: 'nails' }] });
    assert.deepEqual(verdict.agreedTypes, []);
    assert.deepEqual(verdict.contradictedTypes, []);
  });
});

/* ---------- the authoritative length definition ---------- */

test('length is counted in Unicode code points, at ASCII, BMP and astral boundaries', () => {
  /* PostgreSQL length() counts code points. JavaScript String#length counts
     UTF-16 code units, so an astral character counted twice and a 129-emoji
     value was refused here and accepted there — the same input, two verdicts.
     Section S of the integration suite asserts the agreement against real
     PostgreSQL; this pins the JavaScript half. */
  const MAX = 256;
  const ascii = 'a';                 /* 1 code unit,  1 code point            */
  const bmpLatin = 'é';         /* 1 code unit,  1 code point, non-ASCII */
  const bmpCjk = '中';           /* 1 code unit,  1 code point            */
  const astral = '\u{1f600}';        /* 2 code units, 1 code point            */

  [ascii, bmpLatin, bmpCjk, astral].forEach(ch => {
    assert.equal(identity.isAcceptableValue('locality', ch.repeat(MAX)), true,
      `${MAX} of ${JSON.stringify(ch)} must be accepted`);
    assert.equal(identity.isAcceptableValue('locality', ch.repeat(MAX + 1)), false,
      `${MAX + 1} of ${JSON.stringify(ch)} must be refused`);
  });

  /* The astral case is the one that used to disagree: 256 emoji are 512 UTF-16
     code units, which the old check refused and PostgreSQL accepted. */
  assert.equal('\u{1f600}'.repeat(256).length, 512, 'still 512 code units');
  assert.equal(identity.isAcceptableValue('locality', '\u{1f600}'.repeat(256)), true);
  assert.equal(identity.isAcceptableValue('locality', '\u{1f600}'.repeat(129)), true,
    'the 129-emoji value from the audit, which PostgreSQL always accepted');

  /* Mixed, straddling the boundary exactly. */
  assert.equal(identity.isAcceptableValue('locality', `${'a'.repeat(255)}\u{1f600}`), true);
  assert.equal(identity.isAcceptableValue('locality', `${'a'.repeat(256)}\u{1f600}`), false);

  /* The strong formats are ASCII-only and cap far below, and are unmoved. */
  assert.equal(identity.isAcceptableValue('gbp_place_id', 'a'.repeat(128)), true);
  assert.equal(identity.isAcceptableValue('gbp_place_id', 'a'.repeat(129)), false);
  assert.equal(identity.isAcceptableValue('gbp_place_id', '\u{1f600}'.repeat(10)), false);

  /* Empty is still empty under either definition. */
  assert.equal(identity.isAcceptableValue('locality', ''), false);
});

test('the three parallel copies of the identifier predicate answer identically', () => {
  /* resolve-identity.js and security/limits.js each hold one, deliberately, so
     both stay loadable as classic scripts. Deliberate duplication is only safe
     while it is pinned. PostgreSQL is the third; section S covers it. */
  const limits = require('../shared/security/limits.js');
  const cases = [
    ['gbp_place_id', 'abcdef'], ['gbp_place_id', 'abcde'], ['gbp_place_id', 'Abcdef'],
    ['gbp_place_id', 'has spaces'], ['gbp_place_id', 'a'.repeat(128)],
    ['gbp_place_id', 'a'.repeat(129)],
    ['external_customer_id', 'Cust:Abcd'], ['payment_customer_id', 'Cus_Abcd'],
    ['business_name', 'a'.repeat(256)], ['business_name', 'a'.repeat(257)],
    ['business_name', ''], ['locality', '\u{1f600}'.repeat(256)],
    ['locality', '\u{1f600}'.repeat(257)], ['locality', '中'.repeat(256)],
    ['locality', `${'a'.repeat(255)}\u{1f600}`]
  ];
  cases.forEach(([type, value]) => {
    assert.equal(identity.isAcceptableValue(type, value),
      limits.isAcceptableIdentifier(type, value),
      `${type} length ${[...value].length}`);
  });
});
