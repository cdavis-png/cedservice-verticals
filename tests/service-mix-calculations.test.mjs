/* ============================================================
   SM-1 — deterministic Stage 1 calculations
   ------------------------------------------------------------
   What the evidence supports, and nothing else. The boundary
   these tests defend: an offering with a missing figure is left
   OUT of the total it would have contributed to, and is never
   counted as zero.

   docs/SERVICE_MIX_REVIEW.md section 6.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import values from '../shared/service-mix-engine/value.schema.js';
import calculate from '../shared/service-mix-engine/calculate.js';
import offerings from '../shared/service-mix-engine/offering.schema.js';
import { makeOffering, makePortfolio } from './helpers/service-mix-fixtures.mjs';

const portfolioOf = (list, coverage = 'all_offerings') =>
  calculate.calculatePortfolio({ offerings: list, coverage });

/* ---------- exact arithmetic ---------- */

test('monthly revenue, hours, and revenue per hour are computed from exact figures', () => {
  const offering = makeOffering({ price: 60, duration: 30, volume: 100 });
  const { offeringAnalyses: [a] } = portfolioOf([offering, makeOffering({ name: 'Other' })]);

  assert.deepEqual(a.monthlyRevenue, { low: 6000, high: 6000, known: true });
  /* 30 minutes x 100 = 3000 minutes = 50 hours. */
  assert.deepEqual(a.capacityHours, { low: 50, high: 50, known: true });
  assert.equal(values.midpoint(a.revenuePerCapacityHour), 120);
});

test('an estimate widens every figure derived from it', () => {
  const offering = makeOffering({
    price: 60, duration: 30, volume: 100, kinds: { monthlyVolume: 'estimate' }
  });
  const { offeringAnalyses: [a] } = portfolioOf([offering, makeOffering({ name: 'Other' })]);

  /* Volume ±25% → 75..125, so revenue is 4500..7500. */
  assert.deepEqual(a.monthlyRevenue, { low: 4500, high: 7500, known: true });
  /* Revenue per hour is unchanged in the middle: volume cancels. The band
     widens because the two intervals are treated as independent, which is
     the conservative reading. */
  assert.ok(a.revenuePerCapacityHour.low < 120 && a.revenuePerCapacityHour.high > 120);
});

test('a range is used as given, not re-derived', () => {
  const offering = makeOffering({ price: 100, kinds: { sellingPrice: 'range' }, duration: 60, volume: 10 });
  const { offeringAnalyses: [a] } = portfolioOf([offering, makeOffering({ name: 'Other' })]);
  /* The fixture builds a range of ±20% around the value. */
  assert.deepEqual(a.inputs.sellingPrice, { low: 80, high: 120, known: true });
});

/* ---------- the boundary that matters ---------- */

test('a missing figure removes an offering from that total rather than zeroing it', () => {
  const known = makeOffering({ name: 'Known', price: 50, duration: 60, volume: 20 });
  const noPrice = makeOffering({ name: 'No price', kinds: { sellingPrice: 'unknown' },
                                 duration: 60, volume: 20 });
  const portfolio = portfolioOf([known, noPrice]);

  /* One offering contributed revenue; the other was skipped, not counted. */
  assert.deepEqual(portfolio.totals.monthlyRevenue, { low: 1000, high: 1000, known: true });
  assert.equal(portfolio.totals.monthlyRevenueOfferingsCounted, 1);
  assert.equal(portfolio.totals.monthlyRevenueOfferingsSkipped, 1);

  /* Both had a duration and a volume, so both contributed hours. */
  assert.equal(portfolio.totals.capacityHoursOfferingsCounted, 2);

  const [, unpriced] = portfolio.offeringAnalyses;
  assert.equal(unpriced.monthlyRevenue.known, false);
  assert.equal(unpriced.shareOfEnteredRevenue.known, false,
    'no share can be computed for a figure that does not exist');
});

test('an offering with no figures at all is entered but not usable', () => {
  const empty = makeOffering({
    name: 'Unmeasured',
    kinds: { sellingPrice: 'unknown', durationMinutes: 'unknown', monthlyVolume: 'unknown' }
  });
  const portfolio = portfolioOf([makeOffering(), empty]);
  assert.equal(portfolio.offeringCount, 2);
  assert.equal(portfolio.usableOfferingCount, 1);
});

test('every gap is named individually with what it prevents', () => {
  const offering = makeOffering({
    name: 'Nail art', kinds: { durationMinutes: 'unknown', monthlyVolume: 'unknown' }
  });
  const portfolio = portfolioOf([makeOffering(), offering]);

  const gaps = portfolio.measurementGaps.filter(g => g.offeringId === offering.offeringId);
  assert.equal(gaps.length, 2);
  assert.deepEqual(gaps.map(g => g.measure).sort(), ['durationMinutes', 'monthlyVolume']);
  gaps.forEach(g => assert.ok(g.prevents.length > 10,
    '"three gaps" tells an owner nothing; what it prevents tells them what to do'));
});

test('a not-applicable figure is not a gap', () => {
  const product = makeOffering({
    name: 'Cuticle oil', category: 'retail_product', price: 18, volume: 30,
    kinds: { durationMinutes: 'unknown' }
  });
  const portfolio = portfolioOf([makeOffering(), product]);
  const gaps = portfolio.measurementGaps.filter(g => g.offeringId === product.offeringId);
  assert.deepEqual(gaps, [], 'a retail product has no appointment time and never had one');
  assert.equal(portfolio.dataConfidence.notApplicableMeasures >= 1, true);
});

/* ---------- shares ---------- */

test('shares are shares of what was entered, and sum to about one', () => {
  const portfolio = portfolioOf(makePortfolio());
  const shares = portfolio.offeringAnalyses.map(a => values.midpoint(a.shareOfEnteredRevenue));
  shares.forEach(s => assert.ok(s !== null && s > 0 && s < 1));
  const total = shares.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 0.001);
});

test('the portfolio revenue per hour comes from the totals, not an average of ratios', () => {
  /* A tiny high-margin offering must not weigh the same as the one filling
     the diary. Totals: revenue 5200+2700+1000 = 8900; hours 80+75+30 = 185. */
  const portfolio = portfolioOf(makePortfolio());
  assert.equal(values.midpoint(portfolio.totals.monthlyRevenue), 8900);
  assert.equal(values.midpoint(portfolio.totals.capacityHours), 185);
  assert.equal(values.midpoint(portfolio.totals.revenuePerCapacityHour), 48.1081);
});

/* ---------- ordering ---------- */

test('leaders are ranked, and only what is actually known can be ranked', () => {
  const portfolio = portfolioOf([
    makeOffering({ name: 'Big', price: 100, duration: 60, volume: 100 }),
    makeOffering({ name: 'Small', price: 10, duration: 60, volume: 10 }),
    makeOffering({ name: 'Unknown', kinds: { sellingPrice: 'unknown' }, duration: 60, volume: 50 })
  ]);
  assert.deepEqual(portfolio.revenueLeaders.map(l => l.name), ['Big', 'Small'],
    'an unknown is reported as a gap, never as a last place');
});

test('two identical offerings always come back in the same order', () => {
  const a = makeOffering({ name: 'A', price: 50, duration: 60, volume: 10 });
  const b = makeOffering({ name: 'B', price: 50, duration: 60, volume: 10 });
  const first = portfolioOf([a, b]).revenueLeaders.map(l => l.offeringId);
  const second = portfolioOf([b, a]).revenueLeaders.map(l => l.offeringId);
  assert.deepEqual(first, second,
    'two runs of one input must produce one report');
});

test('capacity-heavy offerings are ranked by share of hours', () => {
  const portfolio = portfolioOf(makePortfolio());
  const names = portfolio.capacityHeavyOfferings.map(o => o.name);
  assert.equal(names[0], 'Gel manicure');
  assert.equal(names.length, 3);
});

/* ---------- confidence ---------- */

test('confidence blends completeness, coverage, and how many offerings there are', () => {
  const exactAll = portfolioOf(makePortfolio(), 'all_offerings');
  assert.equal(exactAll.dataConfidence.completeness, 1);
  /* 1.00·0.70 + 1.00·0.20 + (1/3)·0.10 = 0.9333 → floored to 0.93. */
  assert.equal(exactAll.dataConfidence.confidence, 0.93);

  const sample = portfolioOf(makePortfolio(), 'selected_sample');
  assert.ok(sample.dataConfidence.confidence < exactAll.dataConfidence.confidence,
    'a sample describes the sample, not the business');
});

test('confidence is floored, never rounded up across a threshold', () => {
  const portfolio = portfolioOf([
    makeOffering({ kinds: { sellingPrice: 'estimate', durationMinutes: 'estimate', monthlyVolume: 'estimate' } }),
    makeOffering({ name: 'Two', kinds: { sellingPrice: 'estimate', durationMinutes: 'estimate', monthlyVolume: 'estimate' } })
  ], 'unknown');
  const c = portfolio.dataConfidence.confidence;
  assert.equal(c, Math.floor(c * 100) / 100);
});

test('five offerings score a higher count factor than two', () => {
  const two = portfolioOf([makeOffering(), makeOffering({ name: 'B' })]);
  const five = portfolioOf(Array.from({ length: 5 }, (_, i) => makeOffering({ name: `S${i}` })));
  assert.equal(two.dataConfidence.offeringCountFactor, 0);
  assert.equal(five.dataConfidence.offeringCountFactor, 1);
});

test('every reduction in confidence is explained rather than buried in arithmetic', () => {
  const portfolio = portfolioOf([
    makeOffering({ kinds: { sellingPrice: 'unknown' } }),
    makeOffering({ name: 'Two' })
  ], 'selected_sample');
  const reasons = portfolio.dataConfidence.reasons.join(' ');
  assert.match(reasons, /not known/);
  assert.match(reasons, /selected sample/);
  assert.match(reasons, /not counted as zero/);
});

/* ---------- versioning ---------- */

test('the portfolio stamps the versions it was computed under', () => {
  const portfolio = portfolioOf(makePortfolio());
  assert.equal(portfolio.calculationVersion, calculate.CALCULATION_VERSION);
  assert.equal(portfolio.uncertaintyVersion, values.UNCERTAINTY.version,
    'a report generated under v1 must stay interpretable after a recalibration');
});

test('the calculation names no contribution, margin, or profit figure', () => {
  const portfolio = portfolioOf(makePortfolio());

  /* Checked on KEYS, not on the whole serialised blob: `margin_builder` is a
     role the owner picked from a list, and refusing the word outright would
     mean refusing an answer rather than a computed figure. What must not
     exist is a field claiming to hold one. */
  const keys = new Set();
  const walk = (node, depth = 0) => {
    if (depth > 8 || !node || typeof node !== 'object') return;
    Object.keys(node).forEach(key => { keys.add(key.toLowerCase()); walk(node[key], depth + 1); });
  };
  walk(portfolio);

  ['contribution', 'margin', 'profit', 'directcost', 'cost'].forEach(word => {
    const offender = [...keys].find(k => k.includes(word));
    assert.equal(offender, undefined,
      `SM-1 collects no costs, so no calculated field may be named "${offender}"`);
  });
});

test('the shared limits are the ones the calculations use', () => {
  assert.equal(offerings.OFFERING_LIMITS.min, 2);
  assert.equal(offerings.OFFERING_LIMITS.max, 5);
  assert.equal(calculate.MINUTES_PER_HOUR, 60);
  const weights = calculate.CONFIDENCE_WEIGHTS;
  const total = weights.completeness + weights.coverage + weights.offeringCount;
  assert.ok(Math.abs(total - 1) < 1e-9, `confidence weights must total 1, got ${total}`);
});
