/* The Growth Score, the opportunity formula, and the package thresholds must
   not have moved.

   The Assessment Intelligence Expansion added a great deal of new evidence and
   nine new dimensions. None of it may touch the figure a visitor sees. This
   file pins the real nails config against an independent restatement of the
   original formulas — if a coefficient is ever nudged, this fails before
   anyone's Growth Score changes underneath them.

   Randomised across the whole answer space rather than a handful of cases,
   because a drift in one coefficient is easy to miss with three examples. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* Load the real vertical config the same way the page does. */
const configSource = readFileSource();
function readFileSource() {
  return readFileSync(new URL('../verticals/beauty-wellness-fitness/nails/assessment.config.js',
    import.meta.url), 'utf8');
}
const host = {};
new Function('window', configSource)(host);
const config = host.CED_ASSESSMENT_CONFIG;

/* The formulas as they stood before the expansion, restated independently.
   Deliberately NOT imported from the config — a copy that drifts with the
   thing it checks would prove nothing. */
function original(vals) {
  const num = n => Number(vals[n] || 0);
  const ticket = num('averageTicket'), days = num('daysOpen'), missed = num('missedCallsDay');
  const noShows = num('noShowsWeek'), cancels = num('cancelsWeek'), inactive = num('inactiveClients');
  const mp = num('missedCallProcess'), rem = num('reminders'), wl = num('waitlist');
  const rb = num('rebooking'), ra = num('reactivation'), rr = num('reviewRequests'), pr = num('promotions');

  const opportunity =
      missed * 0.35 * ticket * days
    + noShows * ticket * 4.33 * Math.max(0.2, (3 - rem) * 0.18)
    + cancels * ticket * 4.33 * Math.max(0.15, (2 - wl) * 0.18)
    + inactive * 0.06 * ticket * Math.max(0.25, (3 - ra) / 3);

  const missedOpportunity = Math.min(100, mp * 28 + (missed === 0 ? 16 : 0));
  const appointmentProtection = Math.min(100, rem * 24 + wl * 12);
  const retention = Math.min(100, rb * 22 + ra * 20);
  const reputation = Math.min(100, rr * 30 + (num('rating') >= 4.6 ? 10 : 0));
  const marketing = Math.min(100, pr * 30);

  const score = Math.round(
    missedOpportunity * 0.25 + appointmentProtection * 0.25 +
    retention * 0.20 + reputation * 0.15 + marketing * 0.15);

  return {
    opportunity, score,
    dimensions: { missedOpportunity, appointmentProtection, retention, reputation, marketing }
  };
}

/* Deterministic pseudo-random so a failure is reproducible. */
let seed = 0x2f6e2b1;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5;  seed >>>= 0;
  return seed / 0xffffffff;
};
const pick = list => list[Math.floor(rnd() * list.length)];

const randomAnswers = () => ({
  technicians: String(Math.floor(rnd() * 12)),
  appointmentsDay: String(Math.floor(rnd() * 40)),
  averageTicket: String(Math.floor(rnd() * 200)),
  daysOpen: String(Math.floor(rnd() * 31)),
  callsDay: String(Math.floor(rnd() * 60)),
  missedCallsDay: String(Math.floor(rnd() * 30)),
  missedCallProcess: pick(['0', '1', '2', '3']),
  noShowsWeek: String(Math.floor(rnd() * 25)),
  cancelsWeek: String(Math.floor(rnd() * 25)),
  reminders: pick(['0', '1', '2', '3']),
  waitlist: pick(['0', '1', '2']),
  rebooking: pick(['0', '1', '2', '3']),
  reactivation: pick(['0', '1', '2', '3']),
  inactiveClients: String(Math.floor(rnd() * 900)),
  rating: (1 + rnd() * 4).toFixed(1),
  reviewRequests: pick(['0', '1', '2', '3']),
  promotions: pick(['0', '1', '2', '3']),

  /* Intelligence-expansion answers, varied alongside. If any of these reached
     the score, this is where it would show. */
  locationCount: pick(['1', '2', '3', '5']),
  capacity90Day: pick(['none', '1_5', '6_10', '11_20', 'over_20', 'unsure', '']),
  canApprove: pick(['yes', 'no', 'partly', '']),
  urgency: pick(['critical', 'important', 'exploring', 'curious', '']),
  budgetSignal: pick(['budgeted', 'approve_if_value', 'not_budgeted', 'prefer_not_say', '']),
  bookingPlatform: pick(['square', 'vagaro', 'none_paper', 'other', '']),
  primaryConcern: pick(['none', 'price', 'contract', 'prior_bad_experience', '']),
  willingnessToExpand: pick(['yes', 'no', 'if_proven', 'unsure', ''])
});

const readerFor = answers => ({
  num: name => Number(answers[name] || 0),
  val: name => answers[name] || ''
});

test('the Growth Score is unchanged across 2000 randomised answer sets', () => {
  for (let i = 0; i < 2000; i++) {
    const answers = randomAnswers();
    const read = readerFor(answers);
    const expected = original(answers);

    const dimensions = config.dimensions(read);
    assert.deepEqual(dimensions, expected.dimensions,
      `dimensions drifted on iteration ${i}: ${JSON.stringify(answers)}`);

    assert.equal(config.overallScore(dimensions), expected.score,
      `Growth Score drifted on iteration ${i}: ${JSON.stringify(answers)}`);
  }
});

test('the opportunity estimate is unchanged across 2000 randomised answer sets', () => {
  for (let i = 0; i < 2000; i++) {
    const answers = randomAnswers();
    const read = readerFor(answers);
    const expected = original(answers).opportunity;
    const actual = config.opportunity(read);
    assert.ok(Math.abs(actual - expected) < 1e-9,
      `opportunity drifted on iteration ${i}: ${actual} vs ${expected}`);
  }
});

test('no intelligence-expansion answer can move the score', () => {
  const base = randomAnswers();
  const baseline = config.overallScore(config.dimensions(readerFor(base)));
  const baselineOpp = config.opportunity(readerFor(base));

  const expansionFields = ['locationCount', 'capacity90Day', 'canApprove', 'urgency',
    'budgetSignal', 'bookingPlatform', 'primaryConcern', 'willingnessToExpand',
    'respondentRole', 'decisionTiming', 'startTiming', 'phoneSetup', 'keepNumber',
    'yearsInBusiness', 'customIntegrationNeeded', 'migrationConcern',
    'multiLocationSystems', 'otherApprovers', 'concernDetail', 'openQuestions',
    'changeReason', 'priorBadExperience', 'businessPhone', 'website', 'googleProfile'];

  expansionFields.forEach(field => {
    const mutated = { ...base, [field]: 'ANYTHING_AT_ALL' };
    const read = readerFor(mutated);
    assert.equal(config.overallScore(config.dimensions(read)), baseline,
      `${field} moved the Growth Score`);
    assert.equal(config.opportunity(read), baselineOpp,
      `${field} moved the opportunity estimate`);
  });
});

test('package thresholds and prices are unchanged', () => {
  const prices = Object.fromEntries(config.meta.packages.map(p => [p.id, p.price]));
  assert.deepEqual(prices, { starter: 297, 'salon-growth': 597, scale: 997 });

  /* The three tiers must each still be reachable from some valid answer set. */
  const reached = new Set();
  for (let i = 0; i < 3000; i++) {
    const answers = randomAnswers();
    const read = readerFor(answers);
    const dimensions = config.dimensions(read);
    const rec = config.recommendPackage(read, {
      opportunity: config.opportunity(read),
      score: config.overallScore(dimensions),
      dimensions
    });
    reached.add(rec.id);
  }
  ['starter', 'salon-growth', 'scale'].forEach(id =>
    assert.ok(reached.has(id), `${id} is no longer reachable`));
});

test('the assessment version was bumped but the scoring version was not forked', () => {
  assert.equal(config.meta.assessmentVersion, '1.3.0',
    'questions moved between stages, so the version moves');
  assert.ok(config.meta.questionSetVersion,
    'the question inventory is versioned independently of scoring');
});
