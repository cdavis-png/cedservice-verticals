/* The two-stage progressive assessment, driven end to end against the real
   nails markup and the real nails config through the real engine.

   What these tests are protecting:

     · Stage 1 is complete on its own. A visitor who stops there gets results,
       one submission, and nothing that pretends to be more than it is.
     · Stage 2 is optional and additive. Opening it never costs an answer,
       never resends Stage 1, and never rewrites what was already delivered.
     · The figure on screen is the figure the report considers capturable.

   Counts are ASSERTED, not merely printed. A refactor that quietly adds three
   questions to the Growth Review should fail here, because friction is the
   thing this milestone exists to control. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resetGlobals } from './helpers/dom-harness.mjs';
import {
  mountNails, parseNailsMarkup, isQuestion, isRequired,
  STAGE1_ANSWERS, STAGE2_ANSWERS, answer, grantResultsConsent, walkToResults
} from './helpers/nails-markup.mjs';

const { byName } = parseNailsMarkup();
const requiredIn = names => names.filter(n => isRequired(byName, n));

test.afterEach(() => resetGlobals());

/* ---------- Stage 1 shape ---------- */

test('Stage 1 asks a fixed 23 questions: its shortest and longest paths are the same path', () => {
  /* Every branch in this vertical keys off an answer Stage 2 collects, so
     Stage 1 has nothing to branch on. That is the design, not an accident —
     a visitor cannot be given a shorter or longer Growth Review than anyone
     else, and the estimate of how long it takes is therefore exact. */
  const shortest = { ...STAGE1_ANSWERS, locationCount: '1', capacity90Day: 'over_20' };
  const longest = { ...STAGE1_ANSWERS, locationCount: '5', capacity90Day: 'none' };

  [shortest, longest].forEach(answers => {
    const { dom, engine } = mountNails();
    engine.open();
    answer(engine, dom, answers);

    const state = engine.api().inspect();
    const asked = state.visibleFields.filter(isQuestion);
    assert.equal(requiredIn(asked).length, 23, 'required Stage 1 questions');
    assert.equal(asked.length, 24, 'Stage 1 questions including the optional mobile number');
    assert.equal(state.visibleSteps.length, 9, 'Stage 1 steps including its results screen');
    assert.equal(state.currentStage, 1);
    resetGlobals();
  });
});

const STAGE2_ONLY = ['canApprove', 'budgetSignal', 'bookingPlatform', 'primaryConcern',
  'urgency', 'phoneSetup', 'yearsInBusiness', 'preferredContact'];

test('Stage 1 never shows a Stage 2 question, and never carries one in its payload', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  const [payload] = engine.submissions;
  STAGE2_ONLY.forEach(field => {
    assert.ok(!(field in payload.answers),
      `${field} must be absent, not empty: an unasked question is not a blank answer`);
    assert.ok(!payload.branching.visibleFields.includes(field));
  });
});

test('a queued Growth retry stores its continuation with the queued review contact', async () => {
  let retryOptions = null;
  const { engine } = mountNails({
    retryPendingSubmissions: async options => { retryOptions = options; }
  });
  await Promise.resolve();

  assert.equal(typeof retryOptions?.onContinuation, 'function',
    'the Growth retry sweep must retain the token returned by the server');

  retryOptions.onContinuation(
    'growth.retry.issued.context',
    { reviewType: 'growth_review' },
    {
      contact: {
        salonName: 'Queued Nail Studio',
        ownerName: 'Queued Owner',
        email: 'queued-owner@example.test'
      }
    }
  );

  const stored = JSON.parse(engine.storage.getItem('ced:continuation'));
  assert.equal(stored.token, 'growth.retry.issued.context');
  assert.deepEqual(stored.prefill, {
    salonName: 'Queued Nail Studio',
    ownerName: 'Queued Owner',
    email: 'queued-owner@example.test'
  }, 'a later page load must not pair the token with its live form');
});

test('a Stage 1 submission stays Stage 1 even after Stage 2 has been answered', async () => {
  /* Scoping by stage is by construction, not by the accident of a field
     happening to be disabled. Once Stage 2 is open its fields are enabled, and
     without the rule they would leak backwards into a re-finished Stage 1 —
     changing what that stage claimed. */
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  engine.act('improve_recommendation');
  answer(engine, dom, STAGE2_ANSWERS);

  /* Back through Stage 2 into Stage 1, change an answer, and finish again. */
  for (let i = 0; i < 12 && engine.api().inspect().currentStage === 2; i++) engine.prev();
  engine.prev();
  engine.set('missedCallsDay', '7');
  walkToResults(engine);
  await Promise.resolve();

  const latest = engine.submissions[engine.submissions.length - 1];
  assert.equal(latest.assessmentStage.stage, 1);
  STAGE2_ONLY.forEach(field => assert.ok(!(field in latest.answers), field));
  assert.equal(latest.contact.preferredContact, '');
  assert.equal(latest.answers.missedCallsDay, '7');
});

/* ---------- Stage 2 is optional ---------- */

test('completing Stage 1 and stopping produces one submission and a preliminary result', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  assert.equal(engine.submissions.length, 1);
  const [payload] = engine.submissions;
  assert.equal(payload.assessmentStage.stage, 1);
  assert.equal(payload.assessmentStage.stageId, 'stage1');
  assert.equal(payload.assessmentStage.supersedesSubmissionId, null,
    'a Stage 1 submission has nothing before it');
  assert.ok(payload.assessmentStage.stage1CompletedAt);
  assert.equal(payload.assessmentStage.stage2CompletedAt, null);

  /* Results are complete, not partial. */
  assert.equal(typeof payload.results.score, 'number');
  assert.ok(payload.results.priorities.length >= 3);
  assert.ok(payload.results.recommendedPackage.id);
  assert.ok(payload.results.disclaimer.includes('not a guarantee'));
  assert.equal(engine.result(1, 'evidence-note').includes('preliminary review'), true);
});

test('the three paths after Stage 1: two continue the review, one is an ordinary link', () => {
  const { steps } = parseNailsMarkup();
  const resultsStep = steps.find(s => s.results === 1);
  assert.ok(resultsStep, 'Stage 1 has its own results screen');

  const { dom, engine } = mountNails();
  engine.open();
  /* Only the two continuation paths are wired to the engine. "Request a
     Personal Review" deliberately carries no stage action: it is a way OUT of
     the review, not further into it. */
  assert.deepEqual(Object.keys(dom.actions).sort(),
    ['improve_recommendation', 'see_recommended_system']);
  assert.equal(engine.api().inspect().currentStage, 1);
});

test('"See the Recommended System" explains why more questions follow, without calling it another assessment', () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);

  engine.act('see_recommended_system');

  const notes = engine.note();
  assert.equal(notes.length, 1);
  assert.equal(notes[0], 'To confirm the best fit and setup path, answer a few final questions.');
  assert.ok(!/assessment|review again|survey/i.test(notes[0]));
  assert.equal(engine.api().inspect().currentStage, 2);
});

test('a checkout or proposal control anywhere on the page can open the fit review', () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);

  assert.equal(engine.api().requestFitReview('checkout_intent'), true);
  assert.equal(engine.api().inspect().currentStage, 2);
  assert.equal(engine.api().inspect().stageState.trigger, 'checkout_intent');

  /* There is no third stage, so a further request is refused rather than
     silently doing nothing surprising. */
  assert.equal(engine.api().requestFitReview('checkout_intent'), false);
});

/* ---------- Stage 2 ---------- */

test('Stage 2 adds 15 to 25 questions depending on the branch, and never repeats Stage 1', () => {
  const cases = [
    { name: 'shortest (paper book, decides alone, no concern)',
      stage2: { ...STAGE2_ANSWERS, bookingPlatform: 'none_paper' }, expected: 15 },
    { name: 'typical (supported platform, keeping it)', stage2: STAGE2_ANSWERS, expected: 17 },
    { name: 'longest (every branch open)',
      stage1: { locationCount: '5', capacity90Day: 'none' },
      stage2: {
        ...STAGE2_ANSWERS,
        bookingPlatform: 'vagaro', bookingPlatformStaying: 'unsure',
        willingToChangeSoftware: 'maybe', migrationConcern: 'several',
        staffingExpandable: 'yes', hoursExpandable: 'yes', spaceConstraint: 'some',
        canApprove: 'no', otherApprovers: 'corporate', multiLocationSystems: 'mixed',
        phoneSetup: 'answering_service', keepNumber: 'yes',
        primaryConcern: 'contract', priorBadExperience: 'yes'
      },
      expected: 25 }
  ];

  cases.forEach(({ name, stage1 = {}, stage2, expected }) => {
    const { dom, engine } = mountNails();
    engine.open();
    answer(engine, dom, { ...STAGE1_ANSWERS, ...stage1 });
    const beforeFields = engine.api().inspect().visibleFields.filter(isQuestion);

    engine.api().requestFitReview('improve_recommendation');
    answer(engine, dom, stage2);
    const afterFields = engine.api().inspect().visibleFields.filter(isQuestion);

    const added = afterFields.filter(f => !beforeFields.includes(f));
    assert.equal(requiredIn(added).length, expected, `${name}: required Stage 2 questions`);
    /* Stage 1 is never asked twice. */
    beforeFields.forEach(f => assert.ok(afterFields.includes(f),
      `${name}: ${f} disappeared when Stage 2 opened`));
    resetGlobals();
  });
});

test('a Stage 2 submission is a second submission that names the first, never a replacement', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  engine.act('improve_recommendation');
  answer(engine, dom, STAGE2_ANSWERS);
  walkToResults(engine);
  await Promise.resolve();

  assert.equal(engine.submissions.length, 2);
  const [first, second] = engine.submissions;

  assert.equal(first.assessmentStage.stage, 1);
  assert.equal(second.assessmentStage.stage, 2);
  assert.notEqual(first.submissionId, second.submissionId,
    'two stages are two idempotency keys');
  assert.equal(second.assessmentStage.supersedesSubmissionId, first.submissionId);
  assert.equal(second.assessmentSessionId, first.assessmentSessionId,
    'the same person working through the same review');
  assert.ok(second.assessmentStage.stage2StartedAt);
  assert.ok(second.assessmentStage.stage2CompletedAt);
  assert.equal(second.assessmentStage.trigger, 'improve_recommendation');

  /* First-touch attribution is captured once and never rewritten. */
  assert.deepEqual(second.attribution.firstTouch, first.attribution.firstTouch);
});

test('Stage 1 answers and results are identical in both submissions', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  engine.act('improve_recommendation');
  answer(engine, dom, STAGE2_ANSWERS);
  walkToResults(engine);
  await Promise.resolve();

  const [first, second] = engine.submissions;

  /* Nothing Stage 2 collects may move the Growth Score or the estimate. */
  assert.equal(second.results.score, first.results.score);
  assert.equal(second.results.opportunity, first.results.opportunity);
  assert.deepEqual(second.results.dimensions, first.results.dimensions);
  assert.equal(second.results.recommendedPackage.id, first.results.recommendedPackage.id);
  assert.equal(second.results.recommendedPackage.price, first.results.recommendedPackage.price);
  assert.equal(second.results.opportunityRange.formatted, first.results.opportunityRange.formatted);

  /* Every Stage 1 answer survives verbatim. */
  Object.entries(first.answers).forEach(([key, value]) => {
    assert.equal(second.answers[key], value, `${key} changed between stages`);
  });
});

/* ---------- navigation and persistence ---------- */

test('stepping back from Stage 2 returns to the Stage 1 results without resubmitting', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();
  assert.equal(engine.submissions.length, 1);

  engine.act('improve_recommendation');
  answer(engine, dom, STAGE2_ANSWERS);
  /* Back from the first Stage 2 step. */
  const first = engine.api().inspect().visibleSteps[0];
  assert.equal(engine.api().inspect().currentStep, first);
  engine.prev();
  await Promise.resolve();

  const state = engine.api().inspect();
  assert.equal(state.currentStage, 1);
  assert.equal(state.currentStep, 9, 'the Stage 1 results screen');
  assert.equal(engine.submissions.length, 1, 'the preliminary result is not produced twice');

  /* And nothing given in Stage 2 was lost by going back. */
  assert.equal(dom.elements.budgetSignal.value, 'budgeted');
  assert.equal(dom.elements.canApprove.value, 'yes');
});

test('returning to the Stage 1 results and going forward again sends nothing new', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  engine.act('improve_recommendation');
  answer(engine, dom, STAGE2_ANSWERS);
  walkToResults(engine);
  await Promise.resolve();
  assert.equal(engine.submissions.length, 2);

  /* Back through Stage 2 to the preliminary results, then back into the
     questions, then forward again — with nothing changed. The duplicate guard
     is kept per stage precisely so the Stage 2 record cannot displace the
     Stage 1 one and make an unchanged result look new. */
  for (let i = 0; i < 12 && engine.api().inspect().currentStage === 2; i++) engine.prev();
  await Promise.resolve();
  assert.equal(engine.api().inspect().currentStage, 1);
  assert.equal(engine.api().inspect().currentStep, 9);

  engine.next();                       /* refused: nothing follows a results screen */
  await Promise.resolve();
  assert.equal(engine.submissions.length, 2);

  engine.prev();                       /* into the consent step */
  walkToResults(engine);               /* and forward into the results again */
  await Promise.resolve();
  assert.equal(engine.submissions.length, 2, 'an unchanged result is not sent twice');
});

test('changing a Stage 1 answer after the fact is a genuinely new result', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  engine.prev();
  engine.set('missedCallsDay', '9');
  walkToResults(engine);
  await Promise.resolve();

  assert.equal(engine.submissions.length, 2);
  const [before, after] = engine.submissions;
  assert.notEqual(after.submissionId, before.submissionId, 'a new result, a new key');
  assert.equal(after.assessmentStage.stage, 1);
  assert.ok(after.results.opportunity > before.results.opportunity);
});

test('save and resume carry the stage, the answers, and the link between submissions', async () => {
  const first = mountNails();
  first.engine.open();
  answer(first.engine, first.dom, STAGE1_ANSWERS);
  grantResultsConsent(first.dom);
  walkToResults(first.engine);
  await Promise.resolve();

  first.engine.act('improve_recommendation');
  answer(first.engine, first.dom, { canApprove: 'partly', budgetSignal: 'compare_options' });
  const saved = first.engine.storage.getItem('cedSalonGrowthReview');
  const stage1SubmissionId = first.engine.submissions[0].submissionId;
  resetGlobals();

  /* A new page load, same device. */
  const second = mountNails();
  second.engine.storage.setItem('cedSalonGrowthReview', saved);
  second.engine.open();

  const state = second.engine.api().inspect();
  assert.equal(state.currentStage, 2, 'resumes inside the fit review, not back at the start');
  assert.equal(state.maxStageReached, 2);
  assert.equal(state.stageState.stage1SubmissionId, stage1SubmissionId);
  assert.ok(state.stageState.stage1CompletedAt);
  assert.equal(second.dom.elements.canApprove.value, 'partly');
  assert.equal(second.dom.elements.budgetSignal.value, 'compare_options');
  assert.equal(second.dom.elements.averageTicket.value, '50', 'Stage 1 answers survive too');
});

test('resuming on a finished Stage 1 repaints the results without sending them again', async () => {
  const first = mountNails();
  first.engine.open();
  answer(first.engine, first.dom, STAGE1_ANSWERS);
  grantResultsConsent(first.dom);
  walkToResults(first.engine);
  await Promise.resolve();
  const saved = first.engine.storage.getItem('cedSalonGrowthReview');
  resetGlobals();

  const second = mountNails();
  second.engine.storage.setItem('cedSalonGrowthReview', saved);
  second.engine.open();
  await Promise.resolve();

  assert.equal(second.engine.api().inspect().currentStep, 9);
  assert.equal(second.engine.submissions.length, 0, 'repainted, not resent');
  assert.ok(second.engine.result(1, 'score'));
});

/* ---------- the visible figure ---------- */

test('a known capacity shows a capacity-adjusted range and says what bounds it', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  /* Limited headroom: the clamp bites, and the ceiling is a real number. */
  answer(engine, dom, { ...STAGE1_ANSWERS, capacity90Day: '1_5', averageTicket: '120' });
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  const shown = engine.result(1, 'opportunity');
  assert.match(shown, /^\$[\d,]+ – \$[\d,]+$/, 'a range, never a bare figure');

  const [payload] = engine.submissions;
  const range = payload.results.opportunityRange;
  assert.equal(range.capacityKnown, true);
  assert.equal(range.clampApplied, true);
  assert.ok(range.point < payload.results.opportunity,
    'the visible figure is the capturable one, not the unconstrained one');
  assert.ok(range.low <= range.point && range.point <= range.high);

  const assumptions = engine.result(1, 'assumptions');
  assert.match(assumptions, /held to about \d+ additional appointments a month/);
  assert.match(assumptions, /you told us you could comfortably take on/);
  /* Capacity may only ever reduce an estimate. Nothing here may read as a
     promise to supply demand. */
  assert.ok(!/we will|guarantee|expect to bring/i.test(assumptions));
});

test('no headroom at all is stated in words, not as "about 0 appointments"', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, { ...STAGE1_ANSWERS, capacity90Day: 'none' });
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  const assumptions = engine.result(1, 'assumptions');
  assert.match(assumptions, /no room for additional appointments right now/);
  assert.match(assumptions, /recovered from appointments you had already booked/);
  assert.ok(!/about 0 /.test(assumptions));

  /* Clamped, but never zeroed: recovering a booked slot needs no new capacity. */
  const range = engine.submissions[0].results.opportunityRange;
  assert.equal(range.clampApplied, true);
  assert.ok(range.point > 0);
});

test('an unknown capacity shows the unconstrained range and says available capacity could change it', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, { ...STAGE1_ANSWERS, capacity90Day: 'unsure' });
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  const [payload] = engine.submissions;
  const range = payload.results.opportunityRange;
  assert.equal(range.capacityKnown, false);
  assert.equal(range.clampApplied, false);
  assert.equal(range.point, payload.results.opportunity);

  const assumptions = engine.result(1, 'assumptions');
  assert.match(assumptions, /not sure how much additional work you could take on/);
  assert.match(assumptions, /not limited by available capacity/);
  assert.match(assumptions, /could change it/);
});

test('the range shown always equals what the report calls capacity-adjusted', async () => {
  const bir = (await import('../shared/business-intelligence/generate-bir.js')).default ||
              (await import('../shared/business-intelligence/generate-bir.js'));

  for (const band of ['none', '1_5', '6_10', '11_20', 'over_20', 'unsure']) {
    const { dom, engine } = mountNails();
    engine.open();
    answer(engine, dom, { ...STAGE1_ANSWERS, capacity90Day: band });
    grantResultsConsent(dom);
    walkToResults(engine);
    await Promise.resolve();

    const [payload] = engine.submissions;
    const report = bir.generateBir({
      submission: payload,
      birId: '44444444-4444-4444-8444-444444444444',
      generatedAt: '2026-08-04T12:00:05.000Z'
    });
    const adjusted = report.financialOpportunityProfile.capacityAdjusted;

    assert.equal(payload.results.opportunityRange.point, adjusted.point, band);
    assert.equal(payload.results.opportunityRange.low, adjusted.low, band);
    assert.equal(payload.results.opportunityRange.high, adjusted.high, band);
    resetGlobals();
  }
});

/* ---------- consent ---------- */

test('results delivery consent is collected in Stage 1, because Stage 1 delivers results', async () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  grantResultsConsent(dom);
  walkToResults(engine);
  await Promise.resolve();

  const [payload] = engine.submissions;
  assert.equal(payload.consent.resultsDeliveryConsent.granted, true);
  assert.ok(payload.consent.resultsDeliveryConsent.statement.length > 20);
  /* Marketing consents are recorded and never required. */
  assert.equal(payload.consent.emailMarketingConsent.granted, false);
  assert.equal(payload.consent.smsMarketingConsent.available, false,
    'no mobile number was given, so SMS consent was never offered');
});

test('SMS consent stays unavailable until a mobile number is given, in either stage', () => {
  const { dom, engine } = mountNails();
  engine.open();
  answer(engine, dom, STAGE1_ANSWERS);
  assert.equal(dom.elements.consentSmsMarketing.disabled, true);

  engine.set('mobile', '864-555-0134');
  assert.equal(dom.elements.consentSmsMarketing.disabled, false);

  engine.api().requestFitReview('improve_recommendation');
  assert.equal(dom.elements.consentSmsMarketing.disabled, false,
    'opening Stage 2 must not re-gate a consent the visitor already qualified for');
});
