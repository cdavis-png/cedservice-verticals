/* Funnel and drop-off arithmetic.

   The two rules that keep these numbers honest are the ones most of this file
   is about: a rate with no denominator is null rather than zero, and a rate
   with too little sample is withheld rather than reported. Both exist because
   the alternative reads as a finding and is noise. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const funnel = require('../shared/analytics/funnel.js');

/* ---------- the rate primitive ---------- */

test('a rate with no denominator is null, never zero and never complete', () => {
  const result = funnel.rate(0, 0);
  assert.equal(result.value, null);
  assert.equal(result.reportable, false);
  assert.equal(result.reason, 'no_denominator');
});

test('a rate below the sample floor is withheld with its sample size attached', () => {
  const result = funnel.rate(3, 5);
  assert.equal(result.value, null);
  assert.equal(result.reportable, false);
  assert.equal(result.reason, 'below_minimum_sample');
  assert.equal(result.sample, 5);
  assert.equal(result.minSample, funnel.MIN_SAMPLE);
});

test('a rate with enough sample is reported, rounded, with its inputs', () => {
  const result = funnel.rate(37, 100);
  assert.equal(result.value, 0.37);
  assert.equal(result.reportable, true);
  assert.equal(result.numerator, 37);
  assert.equal(result.denominator, 100);
});

test('the sample floor is configurable, because some questions need more', () => {
  assert.equal(funnel.rate(3, 5, { minSample: 1 }).value, 0.6);
  assert.equal(funnel.rate(60, 100, { minSample: 500 }).reportable, false);
});

/* ---------- the funnel ---------- */

const COUNTERS = {
  pageViews: 1000,
  starts: 600,
  resumes: 90,
  stage1Completions: 300,
  preliminaryResultViews: 290,
  stage2Starts: 120,
  stage2Completions: 84,
  fullResultViews: 80,
  personalReviewClicks: 29,
  recommendedSystemClicks: 58,
  checkoutIntents: 15,
  reportRequests: 40,
  abandonmentCount: 240,
  validationFailures: 150,
  questionInteractions: 9000,
  visibleQuestionTotal: 12000,
  medianStage1ActiveMs: 271000,
  medianStage2ActiveMs: 198000
};

test('every funnel step is computed from a named numerator and denominator', () => {
  const result = funnel.computeFunnel(COUNTERS);

  assert.equal(result.steps.view_to_start.value, 0.6);
  assert.equal(result.steps.start_to_stage1.value, 0.5);
  assert.equal(result.steps.result_to_stage2_start.value, funnel.rate(120, 290).value);
  assert.equal(result.steps.stage2_start_to_complete.value, 0.7);
  assert.equal(result.steps.result_to_recommended.value, funnel.rate(58, 290).value);
  assert.equal(result.steps.view_to_stage2.value, 0.084);

  /* The chain is readable rather than implied by ordering. */
  assert.equal(result.steps.start_to_stage1.numeratorField, 'stage1Completions');
  assert.equal(result.steps.start_to_stage1.denominatorField, 'starts');
  assert.equal(funnel.FUNNEL_STEPS.length, Object.keys(result.steps).length);
});

test('the funnel covers every rate the milestone asked for', () => {
  const ids = funnel.FUNNEL_STEPS.map(s => s.id);
  ['view_to_start', 'start_to_stage1', 'result_to_stage2_start',
   'stage2_start_to_complete', 'result_to_recommended',
   'result_to_personal_review', 'result_to_checkout_intent']
    .forEach(id => assert.ok(ids.includes(id), `missing ${id}`));

  const quality = funnel.computeFunnel(COUNTERS).quality;
  ['validationFailureRate', 'questionInteractionRate', 'resumeRate', 'abandonmentRate']
    .forEach(key => assert.ok(key in quality, `missing ${key}`));
});

test('quality rates measure the experience rather than progression', () => {
  const { quality } = funnel.computeFunnel(COUNTERS);
  assert.equal(quality.validationFailureRate.value, 0.25);
  assert.equal(quality.questionInteractionRate.value, 0.75);
  assert.equal(quality.resumeRate.value, 0.15);
  assert.equal(quality.abandonmentRate.value, 0.4);
});

test('missing counters default to zero rather than throwing', () => {
  const result = funnel.computeFunnel({ pageViews: 100, starts: 40 });
  assert.equal(result.steps.view_to_start.value, 0.4);
  assert.equal(result.steps.stage2_start_to_complete.value, null);
  assert.equal(result.steps.stage2_start_to_complete.reason, 'no_denominator');
});

test('median active times are carried through, not recomputed', () => {
  const result = funnel.computeFunnel(COUNTERS);
  assert.equal(result.medianStage1ActiveMs, 271000);
  assert.equal(result.medianStage2ActiveMs, 198000);
});

/* ---------- segmentation ---------- */

test('a funnel can be cut by campaign, device, and either version', () => {
  const rows = [
    { source: 'qr_card', deviceClass: 'phone', assessmentVersion: '1.3.0',
      questionSetVersion: 'nails-questions-3.0.0', pageViews: 500, starts: 350, stage1Completions: 200 },
    { source: 'qr_card', deviceClass: 'desktop', assessmentVersion: '1.3.0',
      questionSetVersion: 'nails-questions-3.0.0', pageViews: 200, starts: 100, stage1Completions: 40 },
    { source: 'one_pager', deviceClass: 'phone', assessmentVersion: '1.3.0',
      questionSetVersion: 'nails-questions-3.0.0', pageViews: 300, starts: 150, stage1Completions: 60 }
  ];

  const bySource = funnel.computeSegmented(rows, 'source');
  assert.equal(bySource.length, 2);
  assert.equal(bySource[0].key, 'qr_card', 'ordered by volume');
  assert.equal(bySource[0].counters.pageViews, 700);
  assert.equal(bySource[0].steps.view_to_start.value, 0.6429);

  const byDevice = funnel.computeSegmented(rows, 'deviceClass');
  const phone = byDevice.find(r => r.key === 'phone');
  assert.equal(phone.counters.pageViews, 800);
  assert.equal(phone.steps.start_to_stage1.value, 0.52);

  funnel.SEGMENTS.forEach(segment =>
    assert.doesNotThrow(() => funnel.computeSegmented(rows, segment)));
  assert.throws(() => funnel.computeSegmented(rows, 'ipAddress'), /unknown segment/);
});

test('a small segment keeps its counters and loses only its rates', () => {
  const [row] = funnel.computeSegmented(
    [{ source: 'rare_flyer', pageViews: 4, starts: 3 }], 'source');
  assert.equal(row.counters.pageViews, 4);
  assert.equal(row.steps.view_to_start.value, null);
  assert.equal(row.steps.view_to_start.reason, 'below_minimum_sample');
});

test('an absent segment value is named rather than dropped', () => {
  const rows = funnel.computeSegmented(
    [{ source: null, pageViews: 50, starts: 20 }, { source: '', pageViews: 10, starts: 5 }], 'source');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, '(none)');
  assert.equal(rows[0].counters.pageViews, 60);
});

/* ---------- drop-off ---------- */

const STEPS = [
  { stepId: '1', stage: 1, visibleSessions: 600, enteredSessions: 600, completedSessions: 540,
    exits: 60, resumes: 30, validationFailures: 45, medianActiveMs: 32000, nextStepEntered: 540 },
  { stepId: '2', stage: 1, visibleSessions: 540, enteredSessions: 540, completedSessions: 500,
    exits: 40, resumes: 10, validationFailures: 12, medianActiveMs: 28000, nextStepEntered: 495 },
  { stepId: '7', stage: 1, visibleSessions: 400, enteredSessions: 400, completedSessions: 310,
    exits: 90, resumes: 22, validationFailures: 70, medianActiveMs: 51000, nextStepEntered: 305 },
  { stepId: '13', stage: 2, visibleSessions: 12, enteredSessions: 12, completedSessions: 9,
    exits: 3, resumes: 0, validationFailures: 1, medianActiveMs: 15000, nextStepEntered: 9 }
];

test('a drop-off row carries every field the canonical report defines', () => {
  const [row] = funnel.buildDropOffReport(STEPS).steps;
  ['stepId', 'stage', 'visibleSessions', 'enteredSessions', 'completedSessions',
   'exits', 'resumes', 'validationFailures', 'medianActiveMs',
   'completionRate', 'abandonmentRate', 'validationFailureRate', 'resumeRate',
   'nextStepConversion', 'sourceBreakdown', 'deviceBreakdown',
   'sample', 'minSample', 'reportable']
    .forEach(field => assert.ok(field in row, `missing ${field}`));
});

test('drop-off rates are computed against sessions that entered the step', () => {
  const report = funnel.buildDropOffReport(STEPS);
  const step7 = report.steps.find(s => s.stepId === '7');
  assert.equal(step7.completionRate.value, 0.775);
  assert.equal(step7.abandonmentRate.value, 0.225);
  assert.equal(step7.validationFailureRate.value, 0.175);
  assert.equal(step7.nextStepConversion.value, funnel.rate(305, 310).value);
});

test('the worst step is named but nothing is recommended', () => {
  const report = funnel.buildDropOffReport(STEPS);
  assert.equal(report.highestAbandonmentStepId, '7');
  assert.match(report.note, /No recommendation/);
  assert.equal('recommendation' in report, false);
  assert.equal('suggestedFix' in report, false);
});

test('an under-sampled step is withheld from the ranking but kept in the report', () => {
  const report = funnel.buildDropOffReport(STEPS);
  const step13 = report.steps.find(s => s.stepId === '13');

  assert.equal(step13.reportable, false);
  assert.equal(step13.enteredSessions, 12, 'the counters are still there');
  assert.equal(step13.abandonmentRate.value, null);
  assert.notEqual(report.highestAbandonmentStepId, '13',
    '25% of 12 sessions must not outrank 22.5% of 400');
  assert.equal(report.stepsReportable, 3);
  assert.equal(report.stepsWithheld, 1);
});

test('a report with nothing reportable names no worst step', () => {
  const report = funnel.buildDropOffReport([
    { stepId: '1', enteredSessions: 3, completedSessions: 1, exits: 2 }
  ]);
  assert.equal(report.highestAbandonmentStepId, null);
  assert.equal(report.stepsReportable, 0);
});

test('an empty report is a valid report', () => {
  const report = funnel.buildDropOffReport([]);
  assert.deepEqual(report.steps, []);
  assert.equal(report.highestAbandonmentStepId, null);
});

/* ---------- nothing here touches the assessment ---------- */

test('the funnel module exposes no way to write anything', () => {
  const writers = Object.keys(funnel).filter(key =>
    /^(set|write|update|save|persist|apply|ingest)/i.test(key));
  assert.deepEqual(writers, [],
    'analytics reporting is read-only by construction');
});
