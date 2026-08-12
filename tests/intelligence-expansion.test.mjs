/* Assessment Intelligence Expansion — dimensions, capacity clamp, and
   close-readiness bands.

   The one rule every test here is really defending: unknown evidence is never
   favourable. A prospect we know nothing about must never look ready, and
   collecting more evidence must be the only thing that moves a band upward. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makePayload, DISCLAIMER } from './helpers/fixtures.mjs';

const require = createRequire(import.meta.url);
const intel = require('../shared/assessment-engine/intelligence.js');
const bie = require('../shared/business-intelligence/generate-bir.js');
const schema = require('../shared/business-intelligence/report.schema.js');

const BIR_ID = '33333333-3333-4333-8333-333333333333';
const BUSINESS_ID = '44444444-4444-4444-8444-444444444444';

const bir = (answers = {}, overrides = {}) => bie.generateBir({
  submission: makePayload({ answers, ...overrides }),
  birId: BIR_ID,
  businessId: BUSINESS_ID,
  identityStatus: 'linked',
  generatedAt: '2026-08-04T12:00:05.000Z'
});

const dims = answers => intel.computeDimensions({ ...makePayload().answers, ...answers });

/* Answers that make everything else favourable, so a single variable can be
   isolated without another blocker masking it. */
const READY = {
  locationCount: '1', capacity90Day: 'over_20', willingnessToExpand: 'yes',
  canApprove: 'yes', decisionTiming: 'this_week', startTiming: 'immediately',
  urgency: 'critical', budgetSignal: 'budgeted', bookingPlatform: 'square',
  bookingPlatformStaying: 'keep', keepNumber: 'no', willingToChangeSoftware: 'yes',
  customIntegrationNeeded: 'no', migrationConcern: 'none', phoneSetup: 'voip',
  primaryConcern: 'none', staffingExpandable: 'yes', hoursExpandable: 'yes',
  spaceConstraint: 'none', capacityLeadTime: 'immediate'
};

const NOTHING = Object.fromEntries(intel.ALL_FIELDS.map(f => [f, '']));

/* ---------- C. the nine dimensions ---------- */

test('every dimension declares range, polarity, confidence and evidence', () => {
  const d = dims(READY);
  const expected = ['capacityReadiness', 'expansionReadiness', 'decisionReadiness',
    'budgetReadiness', 'implementationCompatibility', 'multiLocationComplexity',
    'objectionSeverity', 'identityConfidenceInput', 'closeReadinessEvidence'];

  expected.forEach(key => {
    const dim = d[key];
    assert.ok(dim, `${key} is missing`);
    assert.equal(dim.range, '0..100', key);
    assert.ok([intel.HIGHER_BETTER, intel.HIGHER_WORSE].includes(dim.polarity), key);
    assert.ok(typeof dim.confidence === 'number' && dim.confidence >= 0 && dim.confidence <= 1, key);
    assert.ok(Array.isArray(dim.evidence), key);
    assert.ok(typeof dim.note === 'string' && dim.note.length > 0, key);
  });
  assert.equal(Object.keys(d).filter(k => k !== 'version').length, expected.length);
});

test('the two inverted dimensions declare their polarity explicitly', () => {
  const d = dims(READY);
  assert.equal(d.multiLocationComplexity.polarity, intel.HIGHER_WORSE);
  assert.equal(d.objectionSeverity.polarity, intel.HIGHER_WORSE);
  assert.match(d.multiLocationComplexity.note, /HIGHER MEANS MORE COMPLEX/);
  assert.match(d.objectionSeverity.note, /HIGHER MEANS MORE RESISTANCE/);

  /* And everything else runs the other way. */
  ['capacityReadiness', 'expansionReadiness', 'decisionReadiness', 'budgetReadiness',
   'implementationCompatibility', 'identityConfidenceInput', 'closeReadinessEvidence']
    .forEach(k => assert.equal(dims(READY)[k].polarity, intel.HIGHER_BETTER, k));
});

test('missing evidence produces null, never a midpoint', () => {
  const d = intel.computeDimensions(NOTHING);
  ['capacityReadiness', 'expansionReadiness', 'decisionReadiness', 'budgetReadiness',
   'implementationCompatibility', 'multiLocationComplexity', 'objectionSeverity']
    .forEach(k => {
      assert.equal(d[k].score, null, k);
      assert.equal(d[k].known, false, k);
      assert.equal(d[k].confidence, 0, k);
    });
});

test('an explicit "unsure" scores as unknown but is recorded as answered', () => {
  const d = dims({ capacity90Day: 'unsure', staffingExpandable: 'unsure',
                   hoursExpandable: 'unsure', spaceConstraint: 'unsure' });
  assert.equal(d.capacityReadiness.score, null);
  const entry = d.capacityReadiness.evidence.find(e => e.field === 'capacity90Day');
  assert.equal(entry.state, 'answered_unknown', 'not the same as never being asked');
  assert.equal(entry.value, 'unsure');
});

test('dimension computation is deterministic', () => {
  assert.deepEqual(dims(READY), dims(READY));
});

test('closeReadinessEvidence measures coverage, not favourability', () => {
  const bad = dims({ ...READY, capacity90Day: 'none', canApprove: 'no',
                     urgency: 'curious', budgetSignal: 'not_budgeted',
                     primaryConcern: 'price' });
  assert.equal(bad.closeReadinessEvidence.score, 100,
    'every question answered means full coverage, however unfavourably');
  assert.ok(bad.decisionReadiness.score < 50, 'while readiness itself is low');
});

/* ---------- capacity ---------- */

test('the approved capacity options all map to a headroom band', () => {
  const bands = {};
  ['none', '1_5', '6_10', '11_20', 'over_20'].forEach(v => {
    bands[v] = bir({ capacity90Day: v }).capacityProfile.headroomBand;
  });
  assert.deepEqual(bands, {
    none: 'none', '1_5': 'limited', '6_10': 'moderate',
    '11_20': 'ample', over_20: 'ample'
  });
  assert.equal(bir({ capacity90Day: 'unsure' }).capacityProfile.headroomBand, 'unknown');
});

test('headroom "none" is the worst case, not the best', () => {
  const worst = bir({ capacity90Day: 'none' }).capacityProfile;
  const best = bir({ capacity90Day: 'over_20' }).capacityProfile;
  assert.equal(worst.headroomBand, 'none');
  assert.equal(worst.oversellRisk, 'high');
  assert.equal(best.oversellRisk, 'low');
  assert.ok(worst.additionalCapacity90Day < best.additionalCapacity90Day);
});

/* ---------- D. capacity clamp ---------- */

test('unknown capacity leaves the estimate uncapped and records the missing ceiling', () => {
  const fin = bir({ capacity90Day: '' }).financialOpportunityProfile;
  assert.equal(fin.capacityAdjusted.point, fin.unconstrained.point);
  assert.equal(fin.capacityAdjusted.clampApplied, false);
  assert.equal(fin.capacityAdjusted.ceiling, null);
  assert.match(fin.capacityAdjusted.clampReason, /no ceiling can be applied/i);
  assert.equal(bir({ capacity90Day: '' }).capacityProfile.ceilingKnown, false);
});

test('insufficient capacity clamps the range', () => {
  const full = bir({ capacity90Day: 'over_20' }).financialOpportunityProfile;
  const none = bir({ capacity90Day: 'none' }).financialOpportunityProfile;

  assert.equal(none.capacityAdjusted.clampApplied, true);
  assert.ok(none.capacityAdjusted.point < none.unconstrained.point);
  assert.ok(none.capacityAdjusted.point < full.capacityAdjusted.point);
  assert.ok(none.capacityAdjusted.low < none.capacityAdjusted.point);
  assert.ok(none.capacityAdjusted.point < none.capacityAdjusted.high);
  assert.match(none.capacityAdjusted.clampReason, /Capacity-limited/);
});

test('the capacity-adjusted range never tops out above the ceiling it states', () => {
  /* The report used to state a ceiling and then print a range above it. With
     headroom for 4.33 appointments a month at a 50 USD ticket the ceiling is
     216.50, and the high bound was 281.45 — the same report contradicting
     itself, and capacity appearing to RAISE an estimate it may only reduce.

     Checked across every confidence band, because the defect was the spread
     being applied to an already-clamped point. */
  ['none', '1_5', '6_10', '11_20'].forEach(band => {
    const fin = bir({ capacity90Day: band, averageTicket: '50' }).financialOpportunityProfile;
    const adj = fin.capacityAdjusted;
    if (adj.ceiling === null) return;

    /* Recover the spread from the UNCONSTRAINED range, which the clamp never
       touches, then subtract the backfill the ceiling does not bound. What is
       left is newly created demand at the top of the range, and that is what
       must sit under the ceiling. Derived independently of adj.high on
       purpose: computing it from adj.high would assert a tautology. */
    const spreadHigh = fin.unconstrained.high / fin.unconstrained.point;
    const newDemandAtHigh = adj.high - (adj.backfillPortion * spreadHigh);
    assert.ok(newDemandAtHigh <= adj.ceiling + 0.01,
      `${band}: new demand at the high bound is ${newDemandAtHigh.toFixed(2)}, ` +
      `above the stated ceiling ${adj.ceiling}`);
    assert.ok(adj.low <= adj.point && adj.point <= adj.high,
      `${band}: range is out of order`);
    assert.ok(adj.high <= fin.unconstrained.high + 0.01,
      `${band}: capacity raised the estimate above the unconstrained range`);
  });
});

test('the reproduced contradiction stays fixed at its exact figures', () => {
  const range = bie.visibleOpportunityRange({
    point: 10000,
    answers: { capacity90Day: '1_5', averageTicket: '50' }
  });
  assert.equal(range.point, 216.5);
  assert.equal(range.clampApplied, true);
  /* Was 281.45 — 30% above the stated ceiling. */
  assert.ok(range.high <= 216.5, `high ${range.high} exceeds the 216.50 ceiling`);
});

test('a clamp never touches the unconstrained figure the visitor was shown', () => {
  const b = bir({ capacity90Day: 'none' });
  assert.equal(b.financialOpportunityProfile.unconstrained.point,
    makePayload().results.opportunity);
});

test('recovering an existing booked slot is not capped by headroom', () => {
  /* With zero headroom the estimate is reduced but not to zero: filling a
     no-show uses a slot the business already had. */
  const fin = bir({ capacity90Day: 'none' }).financialOpportunityProfile;
  assert.ok(fin.capacityAdjusted.point > 0,
    'backfill survives a total capacity constraint');
  assert.ok(fin.capacityAdjusted.backfillPortion > 0);
  assert.equal(fin.capacityAdjusted.point, fin.capacityAdjusted.backfillPortion);
});

test('drivers declare whether they need new capacity', () => {
  const drivers = bir().financialOpportunityProfile.drivers;
  assert.ok(drivers.length === 4);
  const byName = Object.fromEntries(drivers.map(d => [d.driver, d]));
  assert.equal(byName.missed_calls.needsNewCapacity, true);
  assert.equal(byName.reactivation.needsNewCapacity, true);
  assert.equal(byName.no_shows.needsNewCapacity, false);
  assert.equal(byName.cancellations.needsNewCapacity, false);
  assert.ok(Math.abs(drivers.reduce((s, d) => s + d.share, 0) - 1) < 0.02);
});

test('the diagnostic-estimate labelling survives the clamp', () => {
  const fin = bir({ capacity90Day: 'none' }).financialOpportunityProfile;
  assert.equal(fin.isDiagnosticEstimate, true);
  assert.equal(fin.disclaimer, DISCLAIMER);
});

/* ---------- E. close-readiness bands ---------- */

const band = answers => bir(answers).closeReadinessProfile;

test('a fully favourable single-location prospect reaches ask_for_sale', () => {
  const r = band(READY);
  assert.equal(r.band, 'ask_for_sale');
  assert.equal(r.hardBlockers.length, 0);
  assert.equal(r.approvedLanguageKey, 'ask_for_sale');
});

test('the approved close language is exact and lives in the schema', () => {
  assert.equal(
    schema.APPROVED_CLOSE_LANGUAGE.ask_for_sale,
    'Based on your assessment results, the next logical step is to activate the system and begin onboarding.');
  const r = band(READY);
  assert.equal(schema.APPROVED_CLOSE_LANGUAGE[r.approvedLanguageKey],
    'Based on your assessment results, the next logical step is to activate the system and begin onboarding.');
});

test('the approved language is never emitted below ask_for_sale', () => {
  [{}, { canApprove: 'no' }, { primaryConcern: 'price' }, { locationCount: '3' },
   { capacity90Day: '' }].forEach(answers => {
    const r = band({ ...READY, ...answers });
    if (r.band !== 'ask_for_sale') {
      assert.equal(r.approvedLanguageKey, null,
        `band ${r.band} must not carry the close language`);
    }
  });
});

test('unknown evidence cannot produce a sellable band', () => {
  const r = bir(NOTHING).closeReadinessProfile;
  assert.ok(['educate', 'clarify'].includes(r.band), `band was ${r.band}`);
  assert.ok(r.unknownSignals.length >= 6);
  assert.equal(r.approvedLanguageKey, null);
});

test('a non-decision-maker with no approval path is escalated, not sold to', () => {
  const r = band({ ...READY, canApprove: 'no', otherApprovers: '' });
  assert.equal(r.band, 'escalate');
  assert.ok(r.hardBlockers.includes('authority_absent'));
  assert.equal(r.approvedLanguageKey, null);
});

test('a non-decision-maker WITH an approval path is capped, not blocked', () => {
  const r = band({ ...READY, canApprove: 'no', otherApprovers: 'one_partner' });
  assert.ok(!r.hardBlockers.includes('authority_absent'), 'a named path is a next step');
  assert.notEqual(r.band, 'ask_for_sale');
  assert.ok(['clarify', 'present_offer', 'educate'].includes(r.band));
});

test('a severe objection caps the band at clarify', () => {
  ['prior_bad_experience', 'results_skepticism', 'contract'].forEach(concern => {
    const r = band({ ...READY, primaryConcern: concern });
    assert.ok(r.softBlockers.includes('severe_objection'), concern);
    assert.ok(['educate', 'clarify'].includes(r.band),
      `${concern} produced ${r.band}; severe objections cap at clarify`);
  });
});

test('a mild objection is recorded without capping as hard', () => {
  const r = band({ ...READY, primaryConcern: 'setup' });
  assert.ok(r.softBlockers.includes('unresolved_objection'));
  assert.ok(!r.softBlockers.includes('severe_objection'));
  assert.equal(r.unresolvedObjections.length, 1);
  assert.equal(r.unresolvedObjections[0].concern, 'setup');
});

test('a high score cannot override a hard blocker', () => {
  const r = band({ ...READY, customIntegrationNeeded: 'yes' });
  assert.ok(r.score >= 80, 'the underlying score is still high');
  assert.equal(r.band, 'escalate', 'but a hard blocker wins');
  assert.ok(r.hardBlockers.includes('unsupported_integration'));
  assert.equal(r.approvedLanguageKey, null);
});

test('a low-confidence estimate cannot reach ask_for_sale', () => {
  /* Contradictory answers drive confidence down without touching readiness. */
  const r = bir({ ...READY, missedCallsDay: '80', callsDay: '1', rating: '9',
                  noShowsWeek: '200' });
  if (r.estimateConfidence.band === 'low') {
    assert.notEqual(r.closeReadinessProfile.band, 'ask_for_sale');
    assert.ok(r.closeReadinessProfile.softBlockers.includes('low_estimate_confidence'));
  }
});

test('a capacity-constrained business is not pushed into an aggressive offer', () => {
  const r = band({ ...READY, capacity90Day: 'none' });
  assert.ok(r.softBlockers.includes('capacity_oversell_risk'));
  assert.ok(['educate', 'clarify'].includes(r.band),
    `band was ${r.band}; a full business must not be sold growth`);
});

test('multi-location escalates while no standardized scope exists', () => {
  const r = band({ ...READY, locationCount: '3', multiLocationSystems: 'shared' });
  assert.equal(r.band, 'escalate');
  assert.ok(r.hardBlockers.includes('multiple_locations'));
  assert.equal(bir({ ...READY, locationCount: '3' }).packageRecommendation.scopeStandard, false);
});

test('escalate is orthogonal, not the top of the ladder', () => {
  const ladder = schema.READINESS_BANDS.map(b => b.id);
  assert.ok(!ladder.includes('escalate'), 'escalate is not a rung');
  const r = band({ ...READY, customIntegrationNeeded: 'yes' });
  assert.equal(r.band, 'escalate');
  assert.equal(r.bandBeforeBlockers, 'ask_for_sale',
    'the pre-blocker band is preserved so the reason is legible');
});

test('every readiness signal reports its own basis', () => {
  const r = band(READY);
  schema.CLOSE_READINESS_SIGNALS.forEach(({ key }) => {
    assert.ok(r.signals[key], key);
    assert.ok(Array.isArray(r.signals[key].basis) && r.signals[key].basis.length, key);
    assert.equal(typeof r.signals[key].known, 'boolean', key);
  });
});

test('objection severity is inverted exactly once on the way into readiness', () => {
  const clean = band({ ...READY, primaryConcern: 'none' });
  const concerned = band({ ...READY, primaryConcern: 'price' });
  assert.equal(clean.signals.objectionsResolved.score, 100);
  assert.ok(concerned.signals.objectionsResolved.score < 100,
    'more severity must mean less resolution');
});

/* ---------- D. BIR population ---------- */

test('the BIR populates every profile the expansion promised', () => {
  const b = bir(READY);
  assert.equal(b.capacityProfile.additionalCapacity90DayBand, 'over_20');
  assert.equal(b.decisionProfile.canApprove, 'yes');
  assert.equal(b.decisionProfile.urgency, 'critical');
  assert.equal(b.budgetProfile.signal, 'budgeted');
  assert.equal(b.technologyProfile.bookingSystem, 'square');
  assert.equal(b.technologyProfile.integrationCompatibility, 'supported');
  assert.equal(b.objectionProfile.primaryConcern, 'none');
  assert.equal(b.businessProfile.locationCount, 1);
  assert.equal(b.businessProfile.yearsInBusiness, '4_10');
  assert.equal(b.intelligenceDimensions.version, 'intelligence-v1');
  assert.ok(b.evidencePath);
  assert.ok(b.identityEvidence);
});

test('the Growth Score and pricing are untouched by all of this', () => {
  const before = makePayload();
  [{}, READY, NOTHING, { capacity90Day: 'none' }, { locationCount: '5' }].forEach(answers => {
    const b = bir(answers);
    assert.equal(b.performanceSnapshot?.growthScore ?? before.results.score,
      before.results.score, 'the Growth Score is carried through, never recomputed');
    assert.equal(b.packageRecommendation.priceMonthly, 597, 'pricing never moves');
    assert.equal(b.packageRecommendation.packageId, 'salon-growth');
  });
});

test('the report recomputes dimensions rather than trusting the payload', () => {
  /* A client claiming perfect dimensions must not be believed. */
  const lying = makePayload({
    answers: NOTHING,
    intelligence: { capacityReadiness: { score: 100, known: true } }
  });
  const b = bie.generateBir({
    submission: lying, birId: BIR_ID, businessId: BUSINESS_ID,
    identityStatus: 'linked', generatedAt: '2026-08-04T12:00:05.000Z'
  });
  assert.equal(b.intelligenceDimensions.capacityReadiness.score, null,
    'the report derives its own dimensions from the answers');
});

/* ---------- H. identity evidence ---------- */

test('optional identity evidence improves ranking quality but never links', () => {
  const bare = bir(NOTHING).identityEvidence;
  assert.equal(bare.quality, 0);

  const rich = bie.generateBir({
    submission: makePayload({
      contact: { businessPhone: '864-555-0134', website: 'polished.test',
                 googleProfile: 'ChIJ_test_place' },
      answers: { locationCount: '1' }
    }),
    birId: BIR_ID, businessId: BUSINESS_ID, identityStatus: 'linked',
    generatedAt: '2026-08-04T12:00:05.000Z'
  }).identityEvidence;

  assert.equal(rich.quality, 100);
  assert.equal(rich.googleProfile, 'ChIJ_test_place');
  assert.equal(rich.verified, false, 'visitor-supplied is never verified');
  assert.equal(rich.autoLinkEligible, false, 'and never links on its own');
  assert.equal(rich.source, 'visitor_supplied');
});

test('identity evidence quality never affects the readiness band', () => {
  const withEvidence = bie.generateBir({
    submission: makePayload({ answers: READY,
      contact: { businessPhone: '864-555-0134', website: 'polished.test',
                 googleProfile: 'ChIJ_test_place' } }),
    birId: BIR_ID, businessId: BUSINESS_ID, identityStatus: 'linked',
    generatedAt: '2026-08-04T12:00:05.000Z'
  });
  assert.equal(withEvidence.closeReadinessProfile.band, band(READY).band);
});

/* ---------- privacy ---------- */

test('nothing in the expansion collects a financial position', () => {
  const source = require('node:fs')
    .readFileSync(new URL('../verticals/beauty-wellness-fitness/nails/site/index.html',
      import.meta.url), 'utf8');
  [/name="revenue/i, /name="bankAccount/i, /name="creditScore/i, /name="annualSales/i]
    .forEach(pattern => assert.ok(!pattern.test(source), `${pattern} must never be asked`));
  assert.match(source, /We do not ask for revenue, bank details, or credit information/);
});

test('free-text answers are carried as evidence, never parsed for meaning', () => {
  const b = bir({ ...READY, primaryConcern: 'price', concernDetail: 'Worried about the cost',
                  openQuestions: 'How long is setup?' });
  assert.equal(b.objectionProfile.detail, 'Worried about the cost');
  assert.equal(b.objectionProfile.openQuestions, 'How long is setup?');
  /* The severity comes from the enum, not the prose. */
  assert.equal(b.objectionProfile.severity, intel.SCALES.primaryConcern.price);
});

/* ============================================================
   The capacity ceiling may only ever SUBTRACT
   ------------------------------------------------------------
   CLAUDE.md section 4: capacity evidence may only ever reduce an
   estimate, never raise one. That has to hold for EACH BOUND
   INDEPENDENTLY, and the first version of these tests did not
   say so — they compared the adjusted range against the
   UNCONSTRAINED one, which is a far larger number, so a clamp
   that LIFTED the lower bound onto the ceiling still passed
   every assertion.

   Two defects were found in this code in turn, and both are
   pinned below:

     · spreading the clamped point without re-capping, which put
       the high bound 30% ABOVE the ceiling the report states;
     · capping the spread of the UNCAPPED new demand, which
       lifted the low bound from 151.55 to 216.50 and collapsed
       the range onto the ceiling.

   The second is the subtler one, and it is worse than what it
   replaced: a collapsed range asserts certainty the evidence
   does not support, and it raises a floor because of a capacity
   answer — the same prohibition broken from the other side.
   ============================================================ */

const CAPACITY_BANDS = ['none', '1_5', '6_10', '11_20', '21_plus', undefined];
const TICKETS = ['0', '25', '50', '95', '250'];

const rangeFor = (band, point = 10000, ticket = '50') => {
  const answers = { averageTicket: ticket };
  if (band !== undefined) answers.capacity90Day = band;
  return bie.visibleOpportunityRange({ point, answers });
};

/* The same estimate with the capacity question left unanswered: no ceiling,
   so nothing is clamped. This is the unadjusted baseline every adjusted bound
   must sit at or below. */
const unadjustedFor = (point = 10000, ticket = '50') => rangeFor(undefined, point, ticket);

const r2 = n => Math.round(n * 100) / 100;

test('REGRESSION: the worked example lands on exactly the expected bounds', () => {
  /* Unadjusted point 10000, spread 0.70/1.30, ceiling 216.50, all of the
     opportunity newly created demand.

       pre-cap   low 151.55   high 281.45
       ceiling                216.50
       expected  low 151.55   high 216.50

     The high is capped because it exceeded the ceiling. The low is UNTOUCHED
     because it never did, and that is the whole point. */
  const r = rangeFor('1_5', 10000, '50');
  assert.equal(r.point, 216.5, 'the clamped point is the ceiling');
  assert.equal(r.low, 151.55, 'the low bound keeps its spread and is NOT lifted to the ceiling');
  assert.equal(r.high, 216.5, 'the high bound is capped at the ceiling');
  assert.equal(r.clampApplied, true);
  assert.ok(r.low < r.point, 'the range must not collapse onto the ceiling');
});

test('each adjusted bound is at or below its unadjusted counterpart, independently', () => {
  /* Stated per bound, because that is the invariant that was violated: a
     range can satisfy low <= high AND high <= unadjusted high while its low
     bound has been raised. */
  for (const band of CAPACITY_BANDS) {
    for (const ticket of TICKETS) {
      const adj = rangeFor(band, 10000, ticket);
      const un = unadjustedFor(10000, ticket);
      assert.ok(adj.low <= un.low + 0.001,
        `${band} @ ${ticket}: adjusted low ${adj.low} exceeds unadjusted low ${un.low}`);
      assert.ok(adj.high <= un.high + 0.001,
        `${band} @ ${ticket}: adjusted high ${adj.high} exceeds unadjusted high ${un.high}`);
      assert.ok(adj.point <= un.point + 0.001,
        `${band} @ ${ticket}: adjusted point ${adj.point} exceeds unadjusted point ${un.point}`);
      assert.ok(adj.low <= adj.high,
        `${band} @ ${ticket}: low ${adj.low} exceeds high ${adj.high}`);
    }
  }
});

test('the ceiling never lifts a bound that was already beneath it', () => {
  /* The direct statement of the second defect. Applying the spread to the
     clamped point gives the value the ceiling is allowed to cap DOWNWARD and
     nothing else. A bound may equal it or be lower; it may never be higher. */
  for (const band of CAPACITY_BANDS) {
    for (const ticket of TICKETS) {
      const r = rangeFor(band, 10000, ticket);
      const un = unadjustedFor(10000, ticket);
      if (un.point === 0) continue;
      const spreadLow = un.low / un.point;
      const spreadHigh = un.high / un.point;
      assert.ok(r.low <= r2(r.point * spreadLow) + 0.011,
        `${band} @ ${ticket}: low ${r.low} was lifted above the spread of its own point ` +
        `(${r2(r.point * spreadLow)})`);
      assert.ok(r.high <= r2(r.point * spreadHigh) + 0.011,
        `${band} @ ${ticket}: high ${r.high} exceeds the spread of its own point`);
    }
  }
});

test('tightening capacity never increases either adjusted bound', () => {
  /* Walked from least to most headroom: every bound must be non-decreasing,
     so going the other way — tightening capacity — can only hold or lower it. */
  for (const ticket of TICKETS) {
    let previous = null;
    for (const band of CAPACITY_BANDS) {
      const r = rangeFor(band, 10000, ticket);
      if (previous) {
        assert.ok(r.low >= previous.low - 0.001,
          `@ ${ticket}: low fell from ${previous.low} to ${r.low} as capacity INCREASED to ${band}`);
        assert.ok(r.high >= previous.high - 0.001,
          `@ ${ticket}: high fell from ${previous.high} to ${r.high} as capacity INCREASED to ${band}`);
      }
      previous = r;
    }
  }
});

test('capacity cannot create opportunity where there was none', () => {
  /* A zero unadjusted estimate must stay zero at every band and every bound.
     A ceiling is a cap, and a cap on nothing is nothing. */
  for (const band of CAPACITY_BANDS) {
    for (const ticket of TICKETS) {
      const r = rangeFor(band, 0, ticket);
      assert.equal(r.low, 0, `${band} @ ${ticket}: capacity created a low bound from a zero estimate`);
      assert.equal(r.point, 0, `${band} @ ${ticket}: capacity created a point from a zero estimate`);
      assert.equal(r.high, 0, `${band} @ ${ticket}: capacity created a high bound from a zero estimate`);
    }
  }
});

test('no bound sits above the ceiling the same report states', () => {
  /* The FIRST defect, still pinned. Backfill is taken out because the ceiling
     does not bound it: recovering an already-booked slot needs no headroom. */
  for (const band of CAPACITY_BANDS) {
    const fin = bir({ capacity90Day: band, averageTicket: '50' }).financialOpportunityProfile;
    const adj = fin.capacityAdjusted;
    if (adj.ceiling === null) continue;
    const spreadHigh = fin.unconstrained.high / fin.unconstrained.point;
    const newDemandAtHigh = adj.high - (adj.backfillPortion * spreadHigh);
    assert.ok(newDemandAtHigh <= adj.ceiling + 0.01,
      `${band}: new demand at the high bound is ${newDemandAtHigh.toFixed(2)}, above ceiling ${adj.ceiling}`);
    assert.ok(adj.low <= adj.point && adj.point <= adj.high, `${band}: range out of order`);
  }
});

test('the BIR keeps a real range when the clamp binds, rather than collapsing', () => {
  /* The visible consequence of the second defect, asserted where a visitor
     would have seen it: a clamped report must still express uncertainty. */
  const fin = bir({ capacity90Day: '1_5', averageTicket: '50' }).financialOpportunityProfile;
  const adj = fin.capacityAdjusted;
  assert.equal(adj.clampApplied, true, 'this fixture is meant to clamp');
  assert.ok(adj.low < adj.point,
    `the clamped range collapsed: low ${adj.low} is not below point ${adj.point}`);
  assert.ok(adj.point <= adj.high);
});

test('the repaired calculation is deterministic', () => {
  /* A returning visitor seeing a different number for the same answers is a
     trust problem, not a release note. */
  for (const band of CAPACITY_BANDS) {
    const first = JSON.stringify(rangeFor(band));
    for (let i = 0; i < 25; i++) {
      assert.equal(JSON.stringify(rangeFor(band)), first,
        `${band}: visibleOpportunityRange is not deterministic`);
    }
    const firstBir = JSON.stringify(
      bir({ capacity90Day: band, averageTicket: '50' }).financialOpportunityProfile);
    for (let i = 0; i < 5; i++) {
      assert.equal(
        JSON.stringify(bir({ capacity90Day: band, averageTicket: '50' }).financialOpportunityProfile),
        firstBir, `${band}: the BIR financial profile is not deterministic`);
    }
  }
});
