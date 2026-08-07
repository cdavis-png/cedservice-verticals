/* ============================================================
   SM-1 — health classification and findings
   ------------------------------------------------------------
   The rule under test throughout: a concern or an opportunity is
   raised only when its INTERVAL clears the threshold, never its
   midpoint. A threshold the interval straddles is not cleared,
   however favourable the middle looks.

   And the ordering rule: a portfolio with a real concern AND
   thin measurement is `undermeasured`, not `attention_needed` —
   sending an owner to change a price on the strength of a guess
   is the failure that ordering prevents.

   docs/SERVICE_MIX_REVIEW.md section 7.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import values from '../shared/service-mix-engine/value.schema.js';
import calculate from '../shared/service-mix-engine/calculate.js';
import classify from '../shared/service-mix-engine/classify.js';
import guidance from '../shared/service-mix-engine/guidance.js';
import { makeOffering, makePortfolio } from './helpers/service-mix-fixtures.mjs';

const run = (list, coverage = 'all_offerings') => {
  const portfolio = calculate.calculatePortfolio({ offerings: list, coverage });
  return { portfolio, classified: classify.classifyPortfolio(portfolio) };
};

/* ---------- the ladder, in order ---------- */

test('fewer than two usable offerings is insufficient evidence', () => {
  const { classified } = run([
    makeOffering({ name: 'Only one' }),
    makeOffering({ name: 'Unmeasured',
      kinds: { sellingPrice: 'unknown', durationMinutes: 'unknown', monthlyVolume: 'unknown' } })
  ]);
  assert.equal(classified.health.classification, 'insufficient_evidence');
  assert.equal(classified.health.deciding.usableOfferingCount, 1);
});

test('confidence below 0.45 is insufficient evidence however many offerings there are', () => {
  /* Two offerings, every figure an estimate, coverage unknown:
     0.60·0.70 + 0.30·0.20 + 0·0.10 = 0.48. Push completeness lower with an
     unknown and it drops under the bar. */
  const estimated = kinds => makeOffering({ kinds, name: `S${Math.random()}` });
  const { portfolio, classified } = run([
    estimated({ sellingPrice: 'estimate', durationMinutes: 'unknown', monthlyVolume: 'estimate' }),
    estimated({ sellingPrice: 'estimate', durationMinutes: 'unknown', monthlyVolume: 'estimate' })
  ], 'unknown');
  assert.ok(portfolio.dataConfidence.confidence < classify.THRESHOLDS.minConfidence);
  assert.equal(classified.health.classification, 'insufficient_evidence');
});

test('enough offerings but completeness below 0.65 is undermeasured', () => {
  const estimated = name => makeOffering({
    name, kinds: { sellingPrice: 'estimate', durationMinutes: 'estimate', monthlyVolume: 'estimate' }
  });
  const { portfolio, classified } = run([
    estimated('A'), estimated('B'), estimated('C')
  ], 'all_offerings');
  /* Every figure an estimate scores exactly 0.60 completeness. */
  assert.equal(portfolio.dataConfidence.completeness, 0.6);
  assert.ok(portfolio.dataConfidence.confidence >= classify.THRESHOLDS.minConfidence);
  assert.equal(classified.health.classification, 'undermeasured');
});

test('a supported concern is attention_needed', () => {
  /* "Slow soak" reserves 200 of the 220 hours entered (91%) and returns 45%
     of the revenue, and an hour of it earns $10 against the portfolio's $20.
     Both intervals clear their thresholds outright. */
  const { classified } = run([
    makeOffering({ name: 'Quick polish', price: 40, duration: 20, volume: 60 }),
    makeOffering({ name: 'Slow soak', price: 20, duration: 120, volume: 100 })
  ]);
  assert.equal(classified.health.classification, 'attention_needed');
  assert.ok(classified.concerns.length >= 1);
  assert.deepEqual(classified.health.deciding.concernIds, classified.concerns.map(c => c.id));
});

test('no concern plus a supported opportunity is generally_healthy_with_opportunities', () => {
  const { classified } = run(makePortfolio());
  assert.equal(classified.health.classification, 'generally_healthy_with_opportunities');
  assert.deepEqual(classified.opportunities.map(o => o.id), ['strong_demand_high_return']);
});

test('nothing supported either way is generally_healthy, which is a real result', () => {
  /* Three offerings at the same revenue per hour and steady demand: nothing
     is far enough from the middle for any rule to fire. */
  const flat = name => makeOffering({ name, price: 60, duration: 60, volume: 40, demand: 'steady' });
  const { classified } = run([flat('A'), flat('B'), flat('C')]);
  assert.equal(classified.health.classification, 'generally_healthy');
  assert.deepEqual(classified.concerns, []);
  assert.deepEqual(classified.opportunities, []);
});

test('a concern found on thin evidence is reported as undermeasured, not acted on', () => {
  /* The same shape as the attention_needed case, but every figure is an
     owner estimate. The concern would still fire; the ordering withholds it. */
  const kinds = { sellingPrice: 'estimate', durationMinutes: 'estimate', monthlyVolume: 'estimate' };
  const { classified } = run([
    makeOffering({ name: 'Quick polish', price: 40, duration: 20, volume: 60, kinds }),
    makeOffering({ name: 'Slow soak', price: 30, duration: 120, volume: 100, kinds })
  ]);
  assert.equal(classified.health.classification, 'undermeasured');
  assert.deepEqual(classified.concerns, [], 'findings rest on figures that are not solid enough to act on');
  assert.equal(classified.findingsWithheld, true);
  assert.ok(classified.withheldReason.includes('not a finding of none'));
});

/* ---------- the interval rule ---------- */

test('a threshold the interval straddles does not raise a concern', () => {
  /* Exact figures put "Nail art" clearly below the portfolio; widening the
     same answers into estimates makes its interval overlap the threshold and
     the concern disappears. */
  const exact = run([
    makeOffering({ name: 'Rich', price: 120, duration: 60, volume: 50 }),
    makeOffering({ name: 'Thin', price: 20, duration: 60, volume: 50 })
  ]);
  assert.ok(exact.classified.concerns.some(c => c.id === 'revenue_per_hour_far_below_portfolio'));

  const nearMiss = run([
    makeOffering({ name: 'Rich', price: 100, duration: 60, volume: 50 }),
    makeOffering({ name: 'Nearly', price: 62, duration: 60, volume: 50 })
  ]);
  assert.equal(
    nearMiss.classified.concerns.some(c => c.id === 'revenue_per_hour_far_below_portfolio'),
    false,
    'a midpoint just under the line is not evidence; the whole interval must clear it');
});

test('an unknown figure raises nothing at all', () => {
  const { classified } = run([
    makeOffering({ name: 'Known', price: 100, duration: 60, volume: 50 }),
    makeOffering({ name: 'No duration', price: 20, volume: 50,
                   kinds: { durationMinutes: 'unknown' } }),
    makeOffering({ name: 'Filler', price: 60, duration: 60, volume: 20 })
  ]);
  const named = [...classified.concerns, ...classified.opportunities]
    .map(f => f.offeringName);
  assert.equal(named.includes('No duration'), false,
    'no revenue-per-hour exists for it, so no rule about revenue per hour can fire');
});

test('weak demand holding a large share of hours is raised as a scheduling question', () => {
  const { classified } = run([
    makeOffering({ name: 'Popular', price: 60, duration: 30, volume: 60, demand: 'strong' }),
    makeOffering({ name: 'Held open', price: 50, duration: 90, volume: 40, demand: 'weak' })
  ]);
  const opportunity = classified.opportunities.find(o => o.id === 'weak_demand_high_capacity');
  assert.ok(opportunity);
  assert.equal(opportunity.offeringName, 'Held open');
});

/* ---------- what SM-1 refuses to say ---------- */

test('contribution, underpricing, add-on and bundle analyses are declared unavailable', () => {
  const { classified } = run(makePortfolio());
  const unavailable = classified.unavailableAnalyses;
  ['contributionLeaders', 'underpricingCandidates', 'addOnOpportunities', 'bundleOpportunities']
    .forEach(key => {
      assert.equal(unavailable[key].available, false);
      assert.equal(unavailable[key].reason, 'requires_detailed_review');
      assert.ok(unavailable[key].explanation.includes('direct costs'));
    });
});

test('present-and-unavailable, so an empty array is never read as a finding of none', () => {
  const { classified } = run(makePortfolio());
  classify.UNAVAILABLE_ANALYSES.forEach(key => {
    assert.ok(Object.prototype.hasOwnProperty.call(classified.unavailableAnalyses, key));
  });
});

test('the approved wording is "estimated contribution", never "profit leader"', () => {
  assert.equal(classify.CONTRIBUTION_LANGUAGE.leader, 'Estimated contribution leader');
  classify.CONTRIBUTION_LANGUAGE.prohibited.forEach(phrase => {
    assert.equal(classify.CONTRIBUTION_LANGUAGE.leader.toLowerCase().includes(phrase), false);
  });
});

/* ---------- findings ---------- */

test('every finding carries all eleven approved fields', () => {
  const { portfolio, classified } = run(makePortfolio());
  const advice = guidance.buildGuidance(portfolio, classified);
  assert.ok(advice.findings.length >= 1);

  advice.findings.forEach(finding => {
    guidance.REQUIRED_FINDING_FIELDS.forEach(field => {
      assert.ok(finding[field] !== undefined && finding[field] !== null && finding[field] !== '',
        `a finding missing ${field} is a conclusion an owner cannot audit`);
    });
    assert.equal(finding.test.durationDays, 30);
    assert.ok(finding.test.keepIf && finding.test.changeIf && finding.test.reverseIf,
      'a test with no pre-agreed reversal condition is a change with a story attached');
    assert.match(finding.findingId, guidance.FINDING_ID_PATTERN);
    assert.match(finding.test.testId, guidance.FINDING_ID_PATTERN);
  });
});

test('a finding is never more confident than the portfolio it came from', () => {
  const { portfolio, classified } = run(makePortfolio());
  const advice = guidance.buildGuidance(portfolio, classified);
  advice.findings.forEach(finding => {
    assert.ok(finding.confidence <= portfolio.dataConfidence.confidence);
  });
});

test('every finding names the evidence and the assumptions behind it', () => {
  const { portfolio, classified } = run(makePortfolio());
  const advice = guidance.buildGuidance(portfolio, classified);
  advice.findings.forEach(finding => {
    assert.ok(finding.evidenceRefs.measures);
    assert.equal(finding.evidenceRefs.uncertaintyVersion, values.UNCERTAINTY.version);
    assert.ok(finding.assumptions.length >= 3);
    assert.ok(finding.missingInformation.some(m => m.toLowerCase().includes('direct cost')));
  });
});

test('no finding, action, or test promises a result', () => {
  const { portfolio, classified } = run(makePortfolio());
  const advice = guidance.buildGuidance(portfolio, classified);
  const text = JSON.stringify(advice).toLowerCase();
  ['guarantee', 'you will earn', 'you will get', 'will increase', 'roi of', 'payback period']
    .forEach(phrase => assert.equal(text.includes(phrase), false,
      `guidance must never contain "${phrase}"`));
});

test('an immediate action is never "buy something"', () => {
  const { portfolio, classified } = run(makePortfolio());
  const advice = guidance.buildGuidance(portfolio, classified);
  const text = advice.immediateActions.map(a => `${a.action} ${a.why}`).join(' ').toLowerCase();
  ['buy', 'purchase', 'sign up', 'checkout', 'per month', 'package']
    .forEach(word => assert.equal(text.includes(word), false,
      `SM-1 is a diagnostic and has asked nothing about fit, budget, or authority — found "${word}"`));
});

test('an unmeasured portfolio is told what to measure, in words', () => {
  const { portfolio, classified } = run([
    makeOffering({ name: 'A', kinds: { durationMinutes: 'unknown' } }),
    makeOffering({ name: 'B', kinds: { durationMinutes: 'unknown' } })
  ]);
  const advice = guidance.buildGuidance(portfolio, classified);
  const ids = advice.immediateActions.map(a => a.id);
  assert.ok(ids.includes('close_measurement_gaps'));
  assert.ok(ids.includes('record_appointment_times'),
    'without appointment times nothing can be said about where the hours go');
});

test('a 30-day test is derived from its finding and cannot drift from it', () => {
  const { portfolio, classified } = run(makePortfolio());
  const advice = guidance.buildGuidance(portfolio, classified);
  assert.equal(advice.thirtyDayTests.length, advice.findings.length);
  advice.thirtyDayTests.forEach((t, i) => {
    assert.equal(t.findingId, advice.findings[i].findingId);
    assert.equal(t.testId, advice.findings[i].test.testId);
    assert.equal(t.what, advice.findings[i].test.what);
    assert.equal(t.keepIf, advice.findings[i].test.keepIf);
    assert.equal(t.durationDays, 30);
    assert.ok(t.caution.includes('small sample'));
  });
});

/* ---------- versioning ---------- */

test('the classifier stamps its version and its thresholds', () => {
  const { classified } = run(makePortfolio());
  assert.equal(classified.classifierVersion, 'service-mix-health-v1');
  assert.equal(classified.thresholds.minConfidence, 0.45);
  assert.equal(classified.thresholds.minCompleteness, 0.65);
  assert.equal(classified.thresholds.minUsableOfferings, 2);
});

test('the health vocabulary is exactly the five the contract names', () => {
  assert.deepEqual(classify.HEALTH_CLASSIFICATIONS, [
    'insufficient_evidence',
    'undermeasured',
    'attention_needed',
    'generally_healthy_with_opportunities',
    'generally_healthy'
  ]);
});

test('classification is deterministic: one input always gives one answer', () => {
  const list = makePortfolio();
  const first = run(list).classified;
  const second = run(list).classified;
  assert.deepEqual(first, second);
});
