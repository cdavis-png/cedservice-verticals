/* ============================================================
   SM-1 — partial data must never read as complete data
   ------------------------------------------------------------
   The failure this file exists to prevent is not a wrong number.
   It is a RIGHT number with a wrong label: a total computed from
   two of three offerings that looks exactly like a total of
   three, or a ranking of what was entered presented as a ranking
   of the business.

   Six properties, each stated as the thing that would be
   misleading if it were false:

     1. a total that leaves offerings out says so
     2. a missing value is never a zero
     3. a revenue leader is not the business's leader unless the
        evidence supports that claim
     4. taking up many hours is not by itself a problem
     5. Stage 1 never manufactures a pricing, profitability,
        contribution, bundle, or add-on conclusion
     6. measurement gaps reduce confidence and qualify what is
        said

   docs/SERVICE_MIX_REVIEW.md sections 6 and 7.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import values from '../shared/service-mix-engine/value.schema.js';
import calculate from '../shared/service-mix-engine/calculate.js';
import classify from '../shared/service-mix-engine/classify.js';
import guidance from '../shared/service-mix-engine/guidance.js';
import bir from '../shared/service-mix-engine/generate-service-mix-bir.js';
import { makeOffering, makeServiceMixPayload } from './helpers/service-mix-fixtures.mjs';

const portfolioOf = (list, coverage = 'all_offerings') =>
  calculate.calculatePortfolio({ offerings: list, coverage });

const reportOf = (offerings, coverage = 'all_offerings') =>
  bir.generateServiceMixBir({
    submission: makeServiceMixPayload({ serviceMix: { coverage, offerings } }),
    birId: randomUUID(),
    generatedAt: '2026-08-05T12:00:00.000Z'
  });

/* Two complete offerings and one whose price the owner did not know. */
const withOneGap = () => ([
  makeOffering({ name: 'Known A', price: 60, duration: 60, volume: 50 }),
  makeOffering({ name: 'Known B', price: 80, duration: 60, volume: 20 }),
  makeOffering({ name: 'No price', price: 40, duration: 60, volume: 30,
                 kinds: { sellingPrice: 'unknown' } })
]);

/* ============================================================
   1. A partial total says it is partial
   ============================================================ */

test('a total that excludes an offering is labelled partial, in words', () => {
  const portfolio = portfolioOf(withOneGap());
  const basis = portfolio.totals.monthlyRevenueBasis;

  assert.equal(basis.complete, false);
  assert.equal(basis.counted, 2);
  assert.equal(basis.skipped, 1);
  assert.match(basis.label, /^Partial revenue total: 2 of 3 offerings entered/);
  assert.match(basis.label, /not counted as zero/,
    'the reader must be told what was done with the missing figure');
});

test('a complete total says so, and still never claims to be the business', () => {
  const complete = portfolioOf([
    makeOffering({ name: 'A', price: 60, duration: 60, volume: 50 }),
    makeOffering({ name: 'B', price: 80, duration: 60, volume: 20 })
  ], 'all_offerings');
  const basis = complete.totals.monthlyRevenueBasis;

  assert.equal(basis.complete, true);
  assert.equal(basis.skipped, 0);
  assert.equal(basis.scope, 'entered_offerings',
    'even "all offerings" is the owner’s claim, not a measurement of the business');
  assert.equal(basis.supportsBusinessWideClaim, true);
  assert.match(basis.label, /whole business/);
});

test('a complete total over a declared sample never supports a business-wide claim', () => {
  const sample = portfolioOf([
    makeOffering({ name: 'A', price: 60, duration: 60, volume: 50 }),
    makeOffering({ name: 'B', price: 80, duration: 60, volume: 20 })
  ], 'selected_sample');
  const basis = sample.totals.monthlyRevenueBasis;

  assert.equal(basis.complete, true, 'every entered offering did contribute');
  assert.equal(basis.supportsBusinessWideClaim, false,
    'and it is still only part of the business');
  assert.match(basis.label, /only part of the business/);
});

test('the hours total carries its own basis, independently of revenue', () => {
  /* One offering has no price and one has no duration, so the two totals
     exclude DIFFERENT offerings and cannot share a label. */
  const portfolio = portfolioOf([
    makeOffering({ name: 'Full', price: 60, duration: 60, volume: 50 }),
    makeOffering({ name: 'No price', price: 40, duration: 60, volume: 30,
                   kinds: { sellingPrice: 'unknown' } }),
    makeOffering({ name: 'No duration', price: 55, duration: 60, volume: 25,
                   kinds: { durationMinutes: 'unknown' } })
  ]);

  assert.equal(portfolio.totals.monthlyRevenueBasis.skipped, 1);
  assert.equal(portfolio.totals.capacityHoursBasis.skipped, 1);
  assert.match(portfolio.totals.capacityHoursBasis.label, /Partial hours total/);
  assert.notEqual(portfolio.totals.monthlyRevenueBasis.label,
    portfolio.totals.capacityHoursBasis.label);
});

test('a ratio of two partial totals is marked partial twice over', () => {
  const portfolio = portfolioOf(withOneGap());
  const basis = portfolio.totals.revenuePerCapacityHourBasis;
  assert.equal(basis.complete, false);
  assert.equal(basis.supportsBusinessWideClaim, false);
  assert.match(basis.label, /only the offerings whose price, time and volume were all known/);
});

test('the report refuses to carry a partial total marked complete', () => {
  const report = reportOf(withOneGap());
  assert.equal(bir.validateServiceMixBir(report).valid, true);

  report.portfolioTotals.monthlyRevenueBasis.complete = true;
  const tampered = bir.validateServiceMixBir(report);
  assert.equal(tampered.valid, false);
  assert.ok(tampered.errors.some(e => e.code === 'partial_total_marked_complete'));
});

test('the report refuses a partial total that claims to describe the business', () => {
  const report = reportOf(withOneGap());
  /* Revenue is the partial one here: only the price was unknown, so the hours
     total is complete and would not violate anything. */
  assert.ok(report.portfolioTotals.monthlyRevenueOfferingsSkipped > 0);
  report.portfolioTotals.monthlyRevenueBasis.supportsBusinessWideClaim = true;
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'partial_total_claims_business'));
});

/* ============================================================
   2. A missing value is never a zero
   ============================================================ */

test('an unknown figure is excluded from the total, not added as zero', () => {
  const portfolio = portfolioOf(withOneGap());
  /* 60x50 + 80x20 = 4600. Treating the third as zero would give the same
     total — so the test is the COUNT, which distinguishes them. */
  assert.equal(values.midpoint(portfolio.totals.monthlyRevenue), 4600);
  assert.equal(portfolio.totals.monthlyRevenueOfferingsCounted, 2,
    'two offerings contributed; a zero would have made it three');
  assert.equal(portfolio.totals.monthlyRevenueOfferingsSkipped, 1);
});

test('an offering with an unknown figure has no figure, rather than a zero one', () => {
  const portfolio = portfolioOf(withOneGap());
  const gap = portfolio.offeringAnalyses.find(a => a.name === 'No price');

  assert.equal(gap.monthlyRevenue.known, false);
  assert.equal(gap.monthlyRevenue.low, null);
  assert.equal(gap.shareOfEnteredRevenue.known, false,
    'no share exists for a figure that does not exist');
  assert.equal(gap.revenuePerCapacityHour.known, false);
  /* And nowhere does a zero appear standing in for it. */
  assert.notEqual(values.midpoint(gap.monthlyRevenue), 0);
});

test('an unknown never becomes a last place in a ranking', () => {
  const portfolio = portfolioOf(withOneGap());
  assert.deepEqual(portfolio.revenueLeaders.map(l => l.name), ['Known A', 'Known B']);
  assert.equal(portfolio.revenueLeaders.some(l => l.name === 'No price'), false,
    'ranking an unknown last asserts it is the smallest, which is not known');
  assert.ok(portfolio.measurementGaps.some(g => g.measure === 'sellingPrice'),
    'it is reported as a gap instead');
});

test('an unknown lowers completeness rather than passing as an answer', () => {
  const complete = portfolioOf([
    makeOffering({ name: 'A', price: 60, duration: 60, volume: 50 }),
    makeOffering({ name: 'B', price: 80, duration: 60, volume: 20 })
  ]);
  const gapped = portfolioOf([
    makeOffering({ name: 'A', price: 60, duration: 60, volume: 50 }),
    makeOffering({ name: 'B', price: 80, duration: 60, volume: 20,
                   kinds: { sellingPrice: 'unknown' } })
  ]);
  assert.equal(complete.dataConfidence.completeness, 1);
  assert.ok(gapped.dataConfidence.completeness < 1);
  assert.equal(gapped.dataConfidence.unknownMeasures, 1);
});

/* ============================================================
   3. A revenue leader is not the business's leader
   ============================================================ */

test('a leader is not claimed business-wide while any revenue is unknown', () => {
  const portfolio = portfolioOf(withOneGap(), 'all_offerings');
  const basis = portfolio.revenueLeadersBasis;

  assert.equal(basis.ranked, 2);
  assert.equal(basis.unranked, 1);
  assert.equal(basis.supportsBusinessWideClaim, false);
  assert.match(basis.label, /not necessarily the highest overall/);
});

test('a leader is not claimed business-wide when the entered offerings are a sample', () => {
  const complete = [
    makeOffering({ name: 'A', price: 60, duration: 60, volume: 50 }),
    makeOffering({ name: 'B', price: 80, duration: 60, volume: 20 })
  ];
  ['most_revenue', 'selected_sample', 'unknown'].forEach(coverage => {
    const basis = portfolioOf(complete, coverage).revenueLeadersBasis;
    assert.equal(basis.supportsBusinessWideClaim, false, coverage);
    assert.match(basis.label, /not necessarily the highest overall/);
  });
});

test('a leader IS claimed business-wide only when both conditions hold', () => {
  const basis = portfolioOf([
    makeOffering({ name: 'A', price: 60, duration: 60, volume: 50 }),
    makeOffering({ name: 'B', price: 80, duration: 60, volume: 20 })
  ], 'all_offerings').revenueLeadersBasis;

  assert.equal(basis.unranked, 0);
  assert.equal(basis.coverage, 'all_offerings');
  assert.equal(basis.supportsBusinessWideClaim, true);
  assert.match(basis.label, /whole business/);
});

test('the report refuses a leader that claims the business without the evidence', () => {
  const report = reportOf(withOneGap());
  assert.equal(report.revenueLeadersBasis.supportsBusinessWideClaim, false);

  report.revenueLeadersBasis.supportsBusinessWideClaim = true;
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'leader_claims_business'));
});

test('the page renders the ranking scope, so the screen cannot claim more than the report', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = new URL('../verticals/beauty-wellness-fitness/nails/service-mix/site/', import.meta.url);
  const html = readFileSync(new URL('index.html', dir), 'utf8');
  const page = readFileSync(new URL('page.js', dir), 'utf8');

  ['data-revenue-leaders-basis', 'data-revenue-total-basis',
   'data-capacity-basis', 'data-capacity-total-basis']
    .forEach(hook => {
      assert.ok(html.includes(hook), `the page must have a place for ${hook}`);
      assert.ok(page.includes(hook), `the page must fill ${hook}`);
    });
  assert.match(page, /portfolio\.revenueLeadersBasis\.label/);
  assert.match(page, /portfolio\.totals\.monthlyRevenueBasis\.label/);
});

/* ============================================================
   4. Many hours is not a problem
   ============================================================ */

test('the capacity list is a description and says so', () => {
  const portfolio = portfolioOf([
    makeOffering({ name: 'Long and lucrative', price: 300, duration: 180, volume: 30 }),
    makeOffering({ name: 'Quick', price: 30, duration: 20, volume: 40 })
  ]);
  const basis = portfolio.capacityHeavyBasis;

  assert.equal(basis.isFinding, false);
  assert.match(basis.label, /not a problem in itself/);
});

test('an offering that eats the diary AND earns well raises no concern', () => {
  /* 84% of the hours and 96% of the revenue. Capacity-heavy by any reading,
     and doing exactly what it should. */
  const { classified } = (() => {
    const portfolio = portfolioOf([
      makeOffering({ name: 'Long and lucrative', price: 300, duration: 180, volume: 30 }),
      makeOffering({ name: 'Quick', price: 30, duration: 20, volume: 40 })
    ]);
    return { portfolio, classified: classify.classifyPortfolio(portfolio) };
  })();

  assert.deepEqual(classified.concerns.map(c => c.offeringName)
    .filter(n => n === 'Long and lucrative'), [],
    'consuming time is what a long, well-priced service is supposed to do');
});

test('the same offering DOES raise a concern once the return stops following', () => {
  const portfolio = portfolioOf([
    makeOffering({ name: 'Long and cheap', price: 30, duration: 180, volume: 30 }),
    makeOffering({ name: 'Quick', price: 60, duration: 20, volume: 40 })
  ]);
  const classified = classify.classifyPortfolio(portfolio);
  const concern = classified.concerns.find(c => c.offeringName === 'Long and cheap');

  assert.ok(concern, 'the hours are the same; only the return changed');
  assert.equal(concern.id, 'capacity_heavy_low_return');
});

test('the report refuses to mark the capacity list as a finding', () => {
  const report = reportOf(withOneGap());
  report.capacityHeavyBasis.isFinding = true;
  const result = bir.validateServiceMixBir(report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'capacity_list_as_finding'));
});

/* ============================================================
   5. Stage 1 manufactures no pricing or profitability conclusion
   ============================================================ */

test('no finding SM-1 can raise is about profit, contribution, or margin', () => {
  const everyRule = [...classify.CONCERN_IDS, ...classify.OPPORTUNITY_IDS];
  everyRule.forEach(id => {
    assert.equal(/profit|contribution|margin|underpric|bundle|add_?on/i.test(id), false,
      `${id} names a conclusion Stage 1 cannot support`);
  });
  /* Every rule is about a price, an hour, or demand — and nothing else. */
  assert.deepEqual(everyRule.sort(), [
    'capacity_heavy_low_return',
    'revenue_per_hour_far_below_portfolio',
    'strong_demand_high_return',
    'weak_demand_high_capacity'
  ]);
});

test('the four cost-dependent analyses are unavailable in every health state', () => {
  const cases = {
    insufficient_evidence: [makeOffering({ name: 'Only one', price: 40, duration: 30, volume: 10 })],
    generally_healthy: [
      makeOffering({ name: 'A', price: 60, duration: 60, volume: 40 }),
      makeOffering({ name: 'B', price: 60, duration: 60, volume: 40 }),
      makeOffering({ name: 'C', price: 60, duration: 60, volume: 40 })
    ],
    attention_needed: [
      makeOffering({ name: 'Quick', price: 40, duration: 20, volume: 60 }),
      makeOffering({ name: 'Slow', price: 20, duration: 120, volume: 100 })
    ]
  };

  Object.entries(cases).forEach(([expected, offerings]) => {
    const classified = classify.classifyPortfolio(portfolioOf(offerings));
    assert.equal(classified.health.classification, expected);
    classify.UNAVAILABLE_ANALYSES.forEach(key => {
      assert.equal(classified.unavailableAnalyses[key].available, false,
        `${expected}: ${key} must stay unavailable`);
      assert.equal(classified.unavailableAnalyses[key].reason, 'requires_detailed_review');
    });
  });
});

test('a health classification never asserts a price is wrong, only that it is worth testing', () => {
  const portfolio = portfolioOf([
    makeOffering({ name: 'Quick', price: 40, duration: 20, volume: 60 }),
    makeOffering({ name: 'Slow', price: 20, duration: 120, volume: 100 })
  ]);
  const classified = classify.classifyPortfolio(portfolio);
  const advice = guidance.buildGuidance(portfolio, classified);

  const text = JSON.stringify(advice).toLowerCase();
  ['is underpriced', 'is overpriced', 'is unprofitable', 'losing money',
   'costs you', 'your margin']
    .forEach(claim => assert.equal(text.includes(claim), false,
      `SM-1 has seen no costs and may not say "${claim}"`));

  advice.findings.forEach(f => {
    assert.ok(f.test.what, 'every finding is expressed as something to try');
    assert.ok(f.test.reverseIf, 'and carries the result that would undo it');
  });
});

test('bundles and add-ons are never inferred from a category the owner picked', () => {
  /* An add-on category and a membership are entered. Nothing may conclude
     anything about bundling them: that needs Stage 2 evidence. */
  const portfolio = portfolioOf([
    makeOffering({ name: 'Core', price: 60, duration: 60, volume: 50 }),
    makeOffering({ name: 'Extra', price: 15, duration: 15, volume: 40, category: 'add_on' }),
    makeOffering({ name: 'Plan', price: 90, duration: 0, volume: 10, category: 'membership' })
  ]);
  const classified = classify.classifyPortfolio(portfolio);

  assert.equal(classified.unavailableAnalyses.addOnOpportunities.available, false);
  assert.equal(classified.unavailableAnalyses.bundleOpportunities.available, false);
  const text = JSON.stringify(classified.concerns.concat(classified.opportunities)).toLowerCase();
  assert.equal(text.includes('bundle'), false);
});

/* ============================================================
   6. Gaps reduce confidence and qualify conclusions
   ============================================================ */

test('each additional gap lowers confidence monotonically', () => {
  const base = () => ([
    makeOffering({ name: 'A', price: 60, duration: 60, volume: 50 }),
    makeOffering({ name: 'B', price: 80, duration: 60, volume: 20 }),
    makeOffering({ name: 'C', price: 40, duration: 60, volume: 30 })
  ]);

  const none = portfolioOf(base()).dataConfidence.confidence;

  const one = base();
  one[0].sellingPrice = values.UNKNOWN;
  const withOne = portfolioOf(one).dataConfidence.confidence;

  const two = base();
  two[0].sellingPrice = values.UNKNOWN;
  two[1].monthlyVolume = values.UNKNOWN;
  const withTwo = portfolioOf(two).dataConfidence.confidence;

  assert.ok(none > withOne, `${none} should exceed ${withOne}`);
  assert.ok(withOne > withTwo, `${withOne} should exceed ${withTwo}`);
});

test('enough gaps push a portfolio below the evidence bar and findings are withheld', () => {
  /* A gap wide enough that the concern still clears its threshold even after
     every figure is widened into an estimate band — so something genuinely IS
     found, and the ordering is what withholds it. */
  const estimated = { sellingPrice: 'estimate', durationMinutes: 'estimate', monthlyVolume: 'estimate' };
  const thin = [
    makeOffering({ name: 'Quick', price: 60, duration: 10, volume: 60, kinds: estimated }),
    makeOffering({ name: 'Slow', price: 10, duration: 180, volume: 100, kinds: estimated })
  ];
  const classified = classify.classifyPortfolio(portfolioOf(thin));

  assert.equal(classified.health.classification, 'undermeasured');
  assert.equal(classified.findingsWithheld, true);
  assert.ok(classified.withheldCount >= 1,
    'something WAS found; it is being withheld, not absent');
  assert.match(classified.withheldReason, /not a finding of none/);
});

test('every gap names what it prevents, and the actions name what to measure', () => {
  const portfolio = portfolioOf(withOneGap());
  const classified = classify.classifyPortfolio(portfolio);
  const advice = guidance.buildGuidance(portfolio, classified);

  assert.ok(portfolio.measurementGaps.length >= 1);
  portfolio.measurementGaps.forEach(gap => {
    assert.ok(gap.prevents.length > 10);
    assert.ok(gap.offeringId, 'a gap belongs to an offering, not to the portfolio');
  });

  const closing = advice.immediateActions.find(a => a.id === 'close_measurement_gaps');
  assert.ok(closing, 'an owner with gaps is told which figures to find');
  assert.match(closing.why, /rather than counting it as zero/,
    'the action explains what was done with the missing figure, not just that it is missing');
});

test('the reasons behind a confidence figure are stated, not implied', () => {
  const portfolio = portfolioOf(withOneGap(), 'most_revenue');
  const reasons = portfolio.dataConfidence.reasons.join(' ');

  assert.match(reasons, /1 figure\(s\) were not known/);
  assert.match(reasons, /most revenue/);
  assert.match(reasons, /left out of the revenue total/);
  assert.match(reasons, /not counted as zero/);
});

test('a report built entirely from gaps is still valid, and still says nothing false', () => {
  const barelyThere = [
    makeOffering({ name: 'A', price: 60, duration: 60, volume: 50,
                   kinds: { durationMinutes: 'unknown', monthlyVolume: 'unknown' } }),
    makeOffering({ name: 'B', price: 80, duration: 60, volume: 20,
                   kinds: { durationMinutes: 'unknown', monthlyVolume: 'unknown' } })
  ];
  const report = reportOf(barelyThere, 'unknown');

  assert.equal(bir.validateServiceMixBir(report).valid, true);
  assert.equal(report.serviceMixHealth.classification, 'insufficient_evidence');
  assert.deepEqual(report.findings, []);
  assert.equal(report.portfolioTotals.capacityHours.known, false);
  assert.equal(report.portfolioTotals.capacityHoursBasis.complete, false);
  assert.equal(report.revenueLeadersBasis.supportsBusinessWideClaim, false);
  assert.ok(report.measurementGaps.length >= 4);
});
