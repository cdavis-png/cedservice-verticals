/* Conditional questions — section F.

   Driven against the REAL engine.js through a minimal DOM, because the whole
   value of a branching mechanism is in the edge cases: a required field on a
   branch nobody sees, an answer that stops applying after it was given, a
   resume that lands on a step that no longer exists. A model of branching
   would pass all of those by construction. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDom, loadEngine, resetGlobals } from './helpers/dom-harness.mjs';

/* A deliberately small vertical: enough shape to exercise every rule, small
   enough that a failure points at one thing. */
const STEPS = [
  { fields: [{ name: 'locationCount', required: true }] },
  { fields: [
      { name: 'canApprove', required: true },
      { name: 'otherApprovers', conditional: true, required: true }
    ] },
  { fields: [{ name: 'multiLocationSystems', required: true }] },   // whole step branches
  { fields: [
      { name: 'primaryConcern', required: true },
      { name: 'concernDetail', conditional: true }
    ] },
  { fields: [] }                                                     // results
];

const CONFIG = () => ({
  storageKey: 'test:branching',
  meta: { verticalId: 'nails', verticalName: 'Nails', assessmentVersion: '1.2.0',
          questionSetVersion: 'test-1', consents: [], contactFields: [], packages: [] },
  submission: { endpoint: null },
  subjectField: 'locationCount',
  subjectFallback: 'Your salon',
  fields: ['locationCount', 'canApprove', 'otherApprovers', 'multiLocationSystems',
           'primaryConcern', 'concernDetail'],
  branching: {
    steps: { 3: read => Number(read.val('locationCount')) > 1 },
    questions: {
      otherApprovers: read => read.val('canApprove') !== '' && read.val('canApprove') !== 'yes',
      concernDetail: read => read.val('primaryConcern') !== '' && read.val('primaryConcern') !== 'none'
    }
  },
  opportunity: () => 100,
  dimensions: () => ({}),
  overallScore: () => 10,
  priorities: [],
  priorityFallback: 'x',
  recommendPackage: () => ({ id: 'p', label: 'P', reason: 'r' })
});

const start = () => {
  const dom = buildDom({ steps: STEPS });
  const engine = loadEngine(dom, CONFIG());
  engine.open();
  return { dom, engine };
};

test.afterEach(() => resetGlobals());

/* ---------- visibility recalculates as answers change ---------- */

test('a whole step appears only when its predicate passes', () => {
  const { engine } = start();
  assert.deepEqual(engine.api().inspect().visibleSteps, [1, 2, 4, 5],
    'step 3 is hidden while location count is unset');

  engine.set('locationCount', '3');
  assert.deepEqual(engine.api().inspect().visibleSteps, [1, 2, 3, 4, 5],
    'and appears once there is more than one location');

  engine.set('locationCount', '1');
  assert.deepEqual(engine.api().inspect().visibleSteps, [1, 2, 4, 5],
    'and disappears again');
});

test('a question appears only when its predicate passes', () => {
  const { engine } = start();
  assert.ok(engine.api().inspect().skippedFields.includes('otherApprovers'));

  engine.set('canApprove', 'no');
  assert.ok(!engine.api().inspect().skippedFields.includes('otherApprovers'),
    'not the sole decision-maker, so the approval chain is asked');

  engine.set('canApprove', 'yes');
  assert.ok(engine.api().inspect().skippedFields.includes('otherApprovers'));
});

test('the visible-field list tracks the answers', () => {
  const { engine } = start();
  assert.ok(!engine.api().inspect().visibleFields.includes('concernDetail'));
  engine.set('primaryConcern', 'price');
  assert.ok(engine.api().inspect().visibleFields.includes('concernDetail'));
  engine.set('primaryConcern', 'none');
  assert.ok(!engine.api().inspect().visibleFields.includes('concernDetail'));
});

/* ---------- hidden fields are excluded from validation and scoring ---------- */

test('a required field on a hidden branch does not block navigation', () => {
  const { dom, engine } = start();
  /* otherApprovers is required, and hidden while canApprove is yes. */
  assert.equal(dom.elements.otherApprovers.required, true);

  engine.set('locationCount', '1');
  engine.next();
  engine.set('canApprove', 'yes');
  engine.next();

  assert.ok(engine.api().inspect().currentStep > 2,
    'a required question nobody can see is not a real blocker');
});

test('a required field on a VISIBLE branch does block navigation', () => {
  const { engine } = start();
  engine.set('locationCount', '1');
  engine.next();
  engine.set('canApprove', 'no');          /* reveals otherApprovers, which is required */
  engine.next();
  assert.equal(engine.api().inspect().currentStep, 2, 'still held on the step');

  engine.set('otherApprovers', 'one_partner');
  engine.next();
  assert.ok(engine.api().inspect().currentStep > 2, 'and released once answered');
});

test('hidden fields are excluded from the form data that feeds scoring', () => {
  const { dom, engine } = start();
  engine.set('canApprove', 'yes');
  assert.equal(dom.elements.otherApprovers.disabled, true,
    'disabled is what actually removes it from FormData');

  engine.set('canApprove', 'no');
  assert.equal(dom.elements.otherApprovers.disabled, false);
});

/* ---------- stale answers ---------- */

test('an answer to a question that stops applying is cleared and recorded', () => {
  const { dom, engine } = start();
  engine.set('canApprove', 'no');
  engine.set('otherApprovers', 'corporate');
  assert.equal(dom.elements.otherApprovers.value, 'corporate');

  engine.set('canApprove', 'yes');           /* the question no longer applies */

  assert.equal(dom.elements.otherApprovers.value, '', 'the answer is cleared');
  const stale = engine.api().inspect().staleCleared;
  assert.equal(stale.length, 1);
  assert.equal(stale[0].field, 'otherApprovers');
  assert.equal(stale[0].reason, 'question_no_longer_applies');
  assert.ok(stale[0].clearedAt, 'and when');
});

test('a question that comes back is no longer stale', () => {
  const { engine } = start();
  engine.set('canApprove', 'no');
  engine.set('otherApprovers', 'corporate');
  engine.set('canApprove', 'yes');
  assert.equal(engine.api().inspect().staleCleared.length, 1);

  engine.set('canApprove', 'no');
  assert.equal(engine.api().inspect().staleCleared.length, 0,
    'it is being asked again, so nothing is stale');
});

test('a cleared answer cannot come back on its own', () => {
  const { dom, engine } = start();
  engine.set('canApprove', 'no');
  engine.set('otherApprovers', 'corporate');
  engine.set('canApprove', 'yes');
  engine.set('canApprove', 'no');
  assert.equal(dom.elements.otherApprovers.value, '',
    'the visitor answers again; the old answer is not resurrected');
});

/* ---------- progress ---------- */

test('progress counts visible steps, not raw step numbers', () => {
  const { engine } = start();
  engine.set('locationCount', '1');
  assert.equal(engine.progress(), 'Step 1 of 4');

  engine.set('locationCount', '3');
  assert.equal(engine.progress(), 'Step 1 of 5', 'the multi-location step joined');
});

test('progress advances through the visible set', () => {
  const { engine } = start();
  engine.set('locationCount', '1');
  engine.next();
  assert.equal(engine.progress(), 'Step 2 of 4');
  engine.set('canApprove', 'yes');
  engine.next();
  assert.equal(engine.progress(), 'Step 3 of 4', 'step 3 was skipped, position 3 is step 4');
});

test('a change in question count is announced', () => {
  const { engine } = start();
  engine.set('locationCount', '1');
  const before = engine.announcement();
  engine.set('locationCount', '3');
  const after = engine.announcement();
  assert.notEqual(after, before);
  assert.match(after, /remaining questions changed/i);
  assert.match(after, /5 steps/);
});

test('an ordinary step advance is not announced', () => {
  const { engine } = start();
  engine.set('locationCount', '1');
  engine.next();
  const quiet = engine.announcement();
  engine.next();
  assert.equal(engine.announcement(), quiet, 'no noise for a normal advance');
});

/* ---------- navigation ---------- */

test('next skips a branched-away step', () => {
  const { engine } = start();
  engine.set('locationCount', '1');
  engine.next();
  engine.set('canApprove', 'yes');
  engine.next();
  assert.equal(engine.api().inspect().currentStep, 4, 'step 3 was skipped entirely');
});

test('next enters a step that a later answer revealed', () => {
  const { engine } = start();
  engine.set('locationCount', '3');
  engine.next();
  engine.set('canApprove', 'yes');
  engine.next();
  assert.equal(engine.api().inspect().currentStep, 3, 'the multi-location step is entered');
});

test('back navigation is stable across a branch', () => {
  const { engine } = start();
  engine.set('locationCount', '1');
  engine.next();
  engine.set('canApprove', 'yes');
  engine.next();
  assert.equal(engine.api().inspect().currentStep, 4);

  engine.prev();
  assert.equal(engine.api().inspect().currentStep, 2, 'back lands on the previous VISIBLE step');
  engine.prev();
  assert.equal(engine.api().inspect().currentStep, 1);
  engine.prev();
  assert.equal(engine.api().inspect().currentStep, 1, 'and stops at the first');
});

/* ---------- save and resume ---------- */

test('save and resume preserves the branch that was taken', () => {
  const first = start();
  first.engine.set('locationCount', '3');
  first.engine.next();
  first.engine.set('canApprove', 'no');
  first.engine.set('otherApprovers', 'corporate');
  const saved = first.engine.storage.getItem('test:branching');
  resetGlobals();

  const dom = buildDom({ steps: STEPS });
  const engine = loadEngine(dom, CONFIG());
  engine.storage.setItem('test:branching', saved);
  engine.open();

  assert.equal(dom.elements.locationCount.value, '3');
  assert.equal(dom.elements.otherApprovers.value, 'corporate', 'the answer survived');
  assert.deepEqual(engine.api().inspect().visibleSteps, [1, 2, 3, 4, 5],
    'and so did the branch it opened');
  assert.ok(!engine.api().inspect().skippedFields.includes('otherApprovers'));
});

test('resuming into a step that no longer applies is corrected', () => {
  /* Saved state says step 3 — the multi-location step — but with one location
     that step does not exist. Resume must not strand the visitor there. */
  const dom = buildDom({ steps: STEPS });
  const engine = loadEngine(dom, CONFIG());
  engine.storage.setItem('test:branching', JSON.stringify({
    data: { locationCount: '1' },
    currentStep: 3,
    session: { assessmentSessionId: '11111111-1111-4111-8111-111111111111', firstTouch: {} }
  }));
  engine.open();

  assert.ok(engine.api().inspect().visibleSteps.includes(engine.api().inspect().currentStep),
    'the resumed step is one that actually exists');
  assert.equal(engine.api().inspect().currentStep, 2,
    'snapped backwards to the nearest visible step, never forward past a question');
});

test('resume recomputes branching from the restored answers, not from scratch', () => {
  const dom = buildDom({ steps: STEPS });
  const engine = loadEngine(dom, CONFIG());
  engine.storage.setItem('test:branching', JSON.stringify({
    data: { locationCount: '5', canApprove: 'no', primaryConcern: 'price' },
    currentStep: 1,
    session: { assessmentSessionId: '11111111-1111-4111-8111-111111111111', firstTouch: {} }
  }));
  engine.open();

  const state = engine.api().inspect();
  assert.ok(state.visibleSteps.includes(3), 'multi-location step restored');
  assert.ok(state.visibleFields.includes('otherApprovers'));
  assert.ok(state.visibleFields.includes('concernDetail'));
  assert.equal(state.skippedFields.length, 0, 'every branch this visitor opened is open');
});

/* ---------- resilience ---------- */

test('a predicate that throws shows the question rather than stranding the visitor', () => {
  const dom = buildDom({ steps: STEPS });
  const config = CONFIG();
  config.branching.questions.otherApprovers = () => { throw new Error('boom'); };
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const engine = loadEngine(dom, config);
    engine.open();
    assert.ok(!engine.api().inspect().skippedFields.includes('otherApprovers'),
      'failing open is the safe direction');
    assert.ok(errors.some(e => /branching predicate/.test(e)), 'and it is reported');
  } finally {
    console.error = realError;
  }
});

test('a vertical with no branching config behaves exactly as before', () => {
  const dom = buildDom({ steps: STEPS });
  const config = CONFIG();
  delete config.branching;
  const engine = loadEngine(dom, config);
  engine.open();
  assert.deepEqual(engine.api().inspect().visibleSteps, [1, 2, 3, 4, 5],
    'every step visible, nothing skipped');
  assert.equal(engine.api().inspect().skippedFields.length, 0);
});
