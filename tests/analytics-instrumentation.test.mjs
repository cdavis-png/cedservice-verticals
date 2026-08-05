/* Engine instrumentation, driven end to end against the real nails markup.

   The point of these tests is not that the engine calls a tracking function —
   it is that the events a funnel needs actually appear, in the right order,
   with the right stage and step, and that turning analytics off changes
   nothing whatsoever about the assessment. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resetGlobals } from './helpers/dom-harness.mjs';
import {
  mountNails, STAGE1_ANSWERS, STAGE2_ANSWERS, answer, grantResultsConsent, walkToResults
} from './helpers/nails-markup.mjs';

const require = createRequire(import.meta.url);

/* A recording stand-in for the client. Deliberately NOT the real client:
   these tests are about what the engine emits, and the real client's batching
   and timing are covered in analytics-client.test.mjs. */
const installRecorder = (options = {}) => {
  const tracked = [];
  const calls = [];
  const record = name => (...args) => { calls.push({ name, args }); };
  let stage = null;
  let step = null;
  const recorder = {
    tracked,
    calls,
    track(eventName, fields = {}) {
      if (options.throwOnTrack) throw new Error('analytics exploded');
      /* Mirrors the real client: stage and step come from the client's own
         state when the caller does not name them. */
      tracked.push({
        eventName,
        assessmentStage: fields.assessmentStage ?? stage,
        stepId: fields.stepId ?? step,
        ...fields,
        metadata: fields.metadata || {}
      });
    },
    configure: record('configure'),
    setSession: record('setSession'),
    identify: (...args) => { calls.push({ name: 'identify', args }); },
    setStage: value => { stage = value; calls.push({ name: 'setStage', args: [value] }); },
    setStep: value => { step = value === null || value === undefined ? null : String(value);
                        calls.push({ name: 'setStep', args: [value] }); },
    markStarted: record('markStarted'),
    markResumed: record('markResumed'),
    markFirstAnswer: () => { calls.push({ name: 'markFirstAnswer', args: [] }); return 1000; },
    markStage1Complete: record('markStage1Complete'),
    markResultsViewed: record('markResultsViewed'),
    sinceMark: () => 4321,
    flush: reason => { calls.push({ name: 'flush', args: [reason] }); },
    reset: record('reset')
  };
  globalThis.window.CEDAnalytics = recorder;
  globalThis.window.CEDAnalyticsEvents = require('../shared/analytics/events.js');
  return recorder;
};

/* The engine reads window.CEDAnalytics at call time, so the recorder can be
   installed after mounting and still capture everything from openReview on. */
const mountWithAnalytics = (options = {}) => {
  const mounted = mountNails();
  const recorder = installRecorder(options);
  return { ...mounted, recorder };
};

const names = recorder => recorder.tracked.map(e => e.eventName);
const firstOf = (recorder, name) => recorder.tracked.find(e => e.eventName === name);
const countOf = (recorder, name) => recorder.tracked.filter(e => e.eventName === name).length;

test.afterEach(() => resetGlobals());

/* ---------- Stage 1 ---------- */

test('opening the review for the first time emits started, not resumed', () => {
  const { engine, recorder } = mountWithAnalytics();
  engine.open();

  assert.ok(names(recorder).includes('assessment.started'));
  assert.ok(!names(recorder).includes('assessment.resumed'));
  assert.equal(firstOf(recorder, 'assessment.started').assessmentStage, 1);
  assert.ok(recorder.calls.some(c => c.name === 'markStarted'));
});

test('each visible step is viewed once, and going back does not view it again', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);

  engine.next();
  engine.next();
  engine.prev();
  engine.next();

  const viewed = recorder.tracked.filter(e => e.eventName === 'assessment.step_viewed');
  const steps = viewed.map(e => e.stepId);
  assert.deepEqual(steps, ['1', '2', '3'], 'one view per step per stage pass');
  assert.equal(new Set(steps).size, steps.length);
});

test('completing a step names the step and the one it leads to', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  engine.next();

  const completed = firstOf(recorder, 'assessment.step_completed');
  assert.equal(completed.stepId, '1');
  assert.equal(completed.metadata.nextStepId, '2');
});

test('a blocked Continue records which question stopped them, never what they typed', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  /* salonName, ownerName and email are required and empty. */
  engine.next();

  const failed = firstOf(recorder, 'assessment.validation_failed');
  assert.ok(failed, 'a refused Continue is a measurement, not a silence');
  assert.equal(failed.stepId, '1');
  assert.ok(failed.metadata.blockingFields.includes('salonName'));
  assert.ok(failed.metadata.blockingCount >= 1);
  assert.equal(countOf(recorder, 'assessment.step_completed'), 0);

  const serialized = JSON.stringify(recorder.tracked);
  assert.ok(!serialized.includes('Polished'), 'no answer values in a validation event');
});

test('answering a question is counted once per question, through one delegated listener', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  engine.set('salonName', 'Polished Nail Studio');
  engine.set('salonName', 'Polished Nail Studio Two');
  engine.set('email', 'owner@polished.test');

  const answered = recorder.tracked.filter(e => e.eventName === 'assessment.question_answered');
  assert.deepEqual(answered.map(e => e.questionId), ['salonName', 'email']);
  assert.equal(answered[0].metadata.isFirstAnswer, true);
});

test('an answer value travels only when the shared allowlist names the question', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);

  const byId = Object.fromEntries(recorder.tracked
    .filter(e => e.eventName === 'assessment.question_answered')
    .map(e => [e.questionId, e.metadata.value]));

  assert.equal(byId.locationCount, '1', 'allowlisted: explains the branch');
  assert.equal(byId.capacity90Day, '11_20', 'allowlisted: explains the clamp path');
  assert.equal(byId.salonName, null, 'a business name is never a metric');
  assert.equal(byId.email, null);
  assert.equal(byId.averageTicket, null, 'not allowlisted, so not recorded');

  const serialized = JSON.stringify(recorder.tracked);
  ['Polished Nail Studio', 'owner@polished.test', 'Test Owner']
    .forEach(needle => assert.ok(!serialized.includes(needle), `leaked: ${needle}`));
});

test('consent checkboxes and the bot trap are never counted as questions', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);

  const questionIds = recorder.tracked
    .filter(e => e.eventName === 'assessment.question_answered')
    .map(e => e.questionId);
  ['consentResults', 'consentEmailMarketing', 'consentSmsMarketing', 'contactFax']
    .forEach(field => assert.ok(!questionIds.includes(field), field));
});

test('finishing Stage 1 emits the completion and the preliminary result view', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);

  assert.equal(countOf(recorder, 'assessment.stage1_completed'), 1);
  assert.equal(countOf(recorder, 'assessment.preliminary_results_viewed'), 1);
  assert.equal(countOf(recorder, 'assessment.full_results_viewed'), 0);

  const viewed = firstOf(recorder, 'assessment.preliminary_results_viewed');
  assert.equal(typeof viewed.metadata.growthScore, 'number');
  assert.equal(viewed.metadata.recommendedPackageId, 'salon-growth');
  assert.equal(viewed.metadata.capacityKnown, true);
  assert.ok(recorder.calls.some(c => c.name === 'markStage1Complete'));

  /* The completion must come before the view: the result exists, then it is
     looked at. */
  const order = names(recorder);
  assert.ok(order.indexOf('assessment.stage1_completed') < order.indexOf('assessment.preliminary_results_viewed'));
});

/* ---------- Stage 2 ---------- */

test('the two continuation CTAs each emit their own click and then the stage start', async () => {
  const cases = [
    ['improve_recommendation', 'assessment.improve_recommendation_clicked'],
    ['see_recommended_system', 'assessment.recommended_system_clicked']
  ];
  /* Sequential with an await before each teardown: the Stage 1 submission is
     still in flight when the walk returns, and tearing the globals down under
     it would fail the NEXT test with a confusing error. */
  for (const [trigger, expected] of cases) {
    const { dom, engine, recorder } = mountWithAnalytics();
    engine.open();
    answer(engine, dom, STAGE1_ANSWERS);
    grantResultsConsent(dom);
    walkToResults(engine);
    await Promise.resolve();
    engine.act(trigger);

    const order = names(recorder);
    assert.ok(order.includes(expected), `${trigger} → ${expected}`);
    assert.ok(order.includes('assessment.stage2_started'));
    assert.ok(order.indexOf(expected) < order.indexOf('assessment.stage2_started'),
      'the click is recorded before the stage it opens');

    const start = firstOf(recorder, 'assessment.stage2_started');
    assert.equal(start.metadata.trigger, trigger);
    assert.equal(start.metadata.activeMsSinceResultsViewed, 4321);
    await Promise.resolve();
    resetGlobals();
  }
});

test('a programmatic checkout intent is recorded like any other entry', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  engine.api().requestFitReview('checkout_intent');

  const start = firstOf(recorder, 'assessment.stage2_started');
  assert.equal(start.metadata.trigger, 'checkout_intent');
  assert.equal(start.assessmentStage, 2);
});

test('Stage 2 steps are viewed under stage 2, and Stage 1 steps are not re-viewed', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  const stage1Views = recorder.tracked.filter(e => e.eventName === 'assessment.step_viewed').length;

  engine.act('improve_recommendation');
  answer(engine, dom, STAGE2_ANSWERS);
  walkToResults(engine);

  const views = recorder.tracked.filter(e => e.eventName === 'assessment.step_viewed');
  const stage2Views = views.slice(stage1Views);
  assert.ok(stage2Views.length > 0);
  stage2Views.forEach(e => assert.equal(e.assessmentStage, 2));
  /* Step numbering continues, so a Stage 2 view is never a Stage 1 step. */
  stage2Views.forEach(e => assert.ok(Number(e.stepId) >= 10, e.stepId));
});

test('finishing Stage 2 emits completion, full result view, and no preliminary duplicate', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  engine.act('improve_recommendation');
  answer(engine, dom, STAGE2_ANSWERS);
  walkToResults(engine);

  assert.equal(countOf(recorder, 'assessment.stage2_completed'), 1);
  assert.equal(countOf(recorder, 'assessment.full_results_viewed'), 1);
  assert.equal(countOf(recorder, 'assessment.stage1_completed'), 1, 'not completed twice');

  const complete = firstOf(recorder, 'assessment.stage2_completed');
  assert.equal(complete.assessmentStage, 2);
  assert.equal(complete.metadata.activeMsSinceStage1, 4321);
});

/* ---------- CTAs by delegation ---------- */

test('marked-up controls are counted by one delegated listener, with nothing prevented', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();

  /* The real markup carries these attributes on ordinary links. */
  const link = { dataset: { analyticsEvent: 'assessment.personal_review_clicked',
                            analyticsLabel: 'stage1_results' },
                 closest(sel) { return sel === '[data-analytics-event]' ? this : null; } };
  dom.modal.fire('click', { target: link });

  const clicked = firstOf(recorder, 'assessment.personal_review_clicked');
  assert.ok(clicked, 'the click was counted');
  assert.equal(clicked.metadata.control, 'stage1_results');
  assert.ok(recorder.calls.some(c => c.name === 'flush' && c.args[0] === 'cta_click'));
});

test('a click on anything unmarked is ignored', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  const before = recorder.tracked.length;
  dom.modal.fire('click', { target: { closest: () => null } });
  assert.equal(recorder.tracked.length, before);
});

test('the real markup carries the attributes the delegated listener needs', () => {
  const html = require('node:fs')
    .readFileSync(new URL('../verticals/beauty-wellness-fitness/nails/site/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-analytics-event="assessment\.personal_review_clicked"/);
  assert.match(html, /data-analytics-event="assessment\.report_requested"/);
  /* And they are still ordinary links, not buttons the engine hijacks. */
  const anchors = html.match(/<a\b[^>]*data-analytics-event[^>]*>/gs) || [];
  assert.equal(anchors.length, 2);
  anchors.forEach(tag => assert.match(tag, /href="mailto:/));
});

/* ---------- resume and deletion ---------- */

test('resuming a saved session emits resumed rather than started', () => {
  const first = mountWithAnalytics();
  first.engine.open();
  answer(first.engine, first.dom, STAGE1_ANSWERS);
  const saved = first.engine.storage.getItem('cedSalonGrowthReview');
  resetGlobals();

  const second = mountWithAnalytics();
  second.engine.storage.setItem('cedSalonGrowthReview', saved);
  second.engine.open();

  assert.ok(names(second.recorder).includes('assessment.resumed'));
  assert.ok(!names(second.recorder).includes('assessment.started'));
  assert.ok(second.recorder.calls.some(c => c.name === 'markResumed'));
});

test('clearing saved data is recorded and flushed before the queue is wiped', () => {
  const { engine, recorder } = mountWithAnalytics();
  engine.open();
  engine.api().clearSavedAssessmentData();

  const order = recorder.calls.map(c => c.name);
  assert.ok(names(recorder).includes('assessment.clear_saved_data'));
  assert.ok(order.indexOf('flush') < order.lastIndexOf('reset'),
    'the record leaves before the client that would have sent it is emptied');
});

test('a completed submission attaches its id to later events', () => {
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);

  const identified = recorder.calls.filter(c => c.name === 'identify');
  assert.ok(identified.some(c => c.args[0] && c.args[0].submissionId),
    'analytics learns the submission id rather than minting one');
});

/* ---------- the governing rule ---------- */

test('an analytics client that throws on every call cannot break the assessment', async () => {
  const { dom, engine } = mountWithAnalytics({ throwOnTrack: true });

  assert.doesNotThrow(() => {
    engine.open();
    answer(engine, dom, STAGE1_ANSWERS);
    grantResultsConsent(dom);
    walkToResults(engine);
  });
  /* The in-flight guard clears on a microtask, so the two stages are two
     turns here exactly as they are two moments for a visitor. */
  await Promise.resolve();

  assert.doesNotThrow(() => {
    engine.act('improve_recommendation');
    answer(engine, dom, STAGE2_ANSWERS);
    walkToResults(engine);
  });
  await Promise.resolve();

  /* And the assessment still produced its two submissions, unchanged. */
  assert.equal(engine.submissions.length, 2);
  assert.equal(engine.submissions[0].assessmentStage.stage, 1);
  assert.equal(engine.submissions[1].assessmentStage.stage, 2);
});

test('with no analytics client at all the assessment is byte-for-byte the same', () => {
  const withOut = mountNails();
  withOut.engine.open();
  answer(withOut.engine, withOut.dom, STAGE1_ANSWERS);
  grantResultsConsent(withOut.dom);
  walkToResults(withOut.engine);
  const plain = JSON.parse(JSON.stringify(withOut.engine.submissions[0]));
  resetGlobals();

  const withIt = mountWithAnalytics();
  withIt.engine.open();
  answer(withIt.engine, withIt.dom, STAGE1_ANSWERS);
  grantResultsConsent(withIt.dom);
  walkToResults(withIt.engine);
  const instrumented = JSON.parse(JSON.stringify(withIt.engine.submissions[0]));

  /* Ids and timestamps differ by construction; everything the report is built
     from must not. */
  assert.deepEqual(instrumented.answers, plain.answers);
  assert.deepEqual(instrumented.results, plain.results);
  assert.deepEqual(instrumented.branching, plain.branching);
  assert.equal(instrumented.schemaVersion, plain.schemaVersion);
  assert.equal(instrumented.assessmentStage.stage, plain.assessmentStage.stage);
});

test('no analytics call ever feeds a value back into the assessment', () => {
  /* sinceMark returns a number and markFirstAnswer returns a number; neither
     may influence what the visitor sees or what is submitted. The proof is
     the previous test — identical payloads with and without a client — and
     this asserts the engine treats the results as write-only metadata. */
  const { dom, engine, recorder } = mountWithAnalytics();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);

  const payload = engine.submissions[0];
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('4321'), 'no analytics timing reached the submission');
  assert.ok(recorder.tracked.length > 0, 'and analytics did run');
});
