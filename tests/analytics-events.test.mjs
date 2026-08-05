/* The analytics privacy boundary.

   Most of this file is about what analytics must NOT be able to carry. That
   is the right emphasis: a funnel that loses a field is a mild inconvenience,
   and a funnel that quietly becomes a contact list is a breach. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const events = require('../shared/analytics/events.js');
const limits = require('../shared/security/limits.js');
const intelligence = require('../shared/assessment-engine/intelligence.js');

const validEvent = (overrides = {}) => ({
  eventId: '11111111-1111-4111-8111-111111111111',
  eventName: 'assessment.step_viewed',
  eventVersion: 1,
  schemaVersion: 1,
  occurredAt: '2026-08-05T09:00:00.000Z',
  assessmentSessionId: '22222222-2222-4222-8222-222222222222',
  submissionId: null,
  businessId: null,
  verticalId: 'nails',
  assessmentVersion: '1.3.0',
  questionSetVersion: 'nails-questions-3.0.0',
  assessmentStage: 1,
  stepId: '4',
  questionId: null,
  attribution: { firstTouch: null, latestTouch: null },
  device: { deviceClass: 'phone', viewportWidth: 400, viewportHeight: 840 },
  activeElapsedMs: 1200,
  totalElapsedMs: 4000,
  stepElapsedMs: 300,
  visibleQuestionCount: 23,
  completedQuestionCount: 9,
  consentStatus: 'product_allowed',
  metadata: {},
  ...overrides
});

/* ---------- the catalog ---------- */

test('every event named by the milestone exists in the catalog', () => {
  const required = [
    'assessment.page_viewed', 'assessment.started', 'assessment.resumed',
    'assessment.step_viewed', 'assessment.question_answered',
    'assessment.validation_failed', 'assessment.step_completed',
    'assessment.stage1_completed', 'assessment.preliminary_results_viewed',
    'assessment.stage2_started', 'assessment.stage2_completed',
    'assessment.full_results_viewed', 'assessment.abandoned',
    'assessment.personal_review_clicked', 'assessment.recommended_system_clicked',
    'assessment.improve_recommendation_clicked', 'assessment.checkout_intent',
    'assessment.report_requested', 'assessment.clear_saved_data'
  ];
  required.forEach(name => assert.ok(events.EVENTS[name], `missing ${name}`));
  assert.equal(events.EVENT_NAMES.length, required.length,
    'the catalog and the milestone list must not drift apart');
});

test('every event declares a category, and only one is functional', () => {
  events.EVENT_NAMES.forEach(name => {
    const category = events.EVENTS[name].category;
    assert.ok(Object.values(events.CATEGORY).includes(category), `${name}: ${category}`);
  });
  const functional = events.EVENT_NAMES.filter(n => events.EVENTS[n].category === 'functional');
  /* Erasing your own data is the only thing here the platform owes you a
     record of. Everything else is us learning about our product. */
  assert.deepEqual(functional, ['assessment.clear_saved_data']);
});

test('consent categories are ordered, and product does not imply marketing', () => {
  assert.equal(events.categoryPermitted('product', 'product_allowed'), true);
  assert.equal(events.categoryPermitted('product', 'functional_only'), false);
  assert.equal(events.categoryPermitted('functional', 'product_allowed'), true);
  assert.equal(events.categoryPermitted('marketing', 'product_allowed'), false,
    'allowing product analytics must never allow marketing analytics');
  assert.equal(events.categoryPermitted('functional', 'denied'), false);
});

test('once-per-session events are the ones a funnel would double-count', () => {
  assert.deepEqual(events.ONCE_PER_SESSION.sort(), [
    'assessment.page_viewed',
    'assessment.stage1_completed',
    'assessment.stage2_completed',
    'assessment.stage2_started',
    'assessment.started'
  ].sort());
});

/* ---------- the prohibition ---------- */

test('field names that look personal are refused at any depth', () => {
  const cases = [
    { metadata: { email: 'a@b.test' } },
    { metadata: { nested: { ownerName: 'Someone' } } },
    { metadata: { deep: { deeper: { phone: '555' } } } },
    { salonName: 'Polished' },
    { metadata: { website: 'example.test' } },
    { metadata: { consentStatement: 'I agree to...' } },
    { metadata: { challengeToken: 'abc' } },
    { metadata: { concernDetail: 'we were burned before' } },
    { metadata: { mobile: '555' } },
    { metadata: { streetAddress: '1 High St' } }
  ];
  cases.forEach(overrides => {
    const result = events.validateEvent(validEvent(overrides));
    assert.equal(result.valid, false, JSON.stringify(overrides));
    assert.ok(result.errors.some(e => e.code === 'prohibited_field'), JSON.stringify(overrides));
  });
});

test('the structural exceptions are deliberate and short', () => {
  /* Each of these tokenizes to a prohibited word and is allowed anyway. If
     this list grows, the token set is wrong or someone is bending it. */
  assert.deepEqual([...events.PROHIBITED_PATTERN_EXCEPTIONS].sort(),
    ['eventName', 'stepName', 'verticalName']);
  assert.equal(events.validateEvent(validEvent()).valid, true,
    'a normal event carries eventName and must pass');
});

test('field names are matched on whole words, not substrings', () => {
  /* The bug this test exists for: `capacity90Day` contains "city", and a
     substring check refused a field that is not remotely personal. */
  assert.deepEqual(events.tokenize('capacity90Day'), ['capacity', '90', 'day']);
  assert.deepEqual(events.tokenize('ownerName'), ['owner', 'name']);
  assert.deepEqual(events.tokenize('utm_source'), ['utm', 'source']);
  assert.deepEqual(events.tokenize('SSN'), ['ssn']);

  ['capacity90Day', 'locationCount', 'questionSetVersion', 'context',
   'deviceClass', 'consentStatus', 'stepElapsedMs', 'referrerHost',
   'assessmentStage', 'visibleQuestionCount']
    .forEach(field => assert.equal(events.isProhibitedFieldName(field), false, field));

  ['ownerName', 'emailAddress', 'businessPhone', 'streetAddress', 'concernDetail',
   'consentStatement', 'challengeToken', 'cardNumber', 'patientId', 'openQuestions',
   'notes', 'freeTextAnswer', 'websiteUrl']
    .forEach(field => assert.equal(events.isProhibitedFieldName(field), true, field));
});

test('scrubbing drops prohibited keys rather than the whole object', () => {
  const { metadata, droppedFields } = events.scrubMetadata({
    stepPosition: 4,
    email: 'a@b.test',
    nested: { ok: true, ownerName: 'Someone' }
  });
  assert.equal(metadata.stepPosition, 4);
  assert.equal(metadata.nested.ok, true);
  assert.ok(!('email' in metadata));
  assert.ok(!('ownerName' in metadata.nested));
  assert.deepEqual(droppedFields.sort(), ['email', 'ownerName']);
});

test('every free-text answer the assessment collects is refused by analytics', () => {
  /* limits.js is the authority for which assessment fields are free text.
     If a vertical adds one, this fails until analytics is told about it —
     which is the point: a new "in your own words" box must not become a new
     way for a sentence a visitor typed to reach the funnel. */
  limits.FREE_TEXT_ANSWERS.forEach(field => {
    assert.equal(events.isProhibitedFieldName(field), true,
      `${field} is a free-text answer and must never appear in an analytics event`);
  });
});

/* REGRESSION — real-Postgres validation, 2026-08-05.
   Six field names the token rule let through that ANALYTICS_PRIVACY.md's own
   exclusion list says must never travel. The documentation was stronger than
   the enforcement; these pin the enforcement. */
test('every exclusion the privacy policy claims is actually enforced', () => {
  const claimed = {
    'a referrer path': 'referrerPath',
    'a referrer URL': 'referrerUrl',
    'a user agent string': 'userAgent',
    'a budget signal': 'budgetSignal',
    'decision authority': 'canApprove',
    'an objection': 'primaryConcern',
    'urgency': 'urgency',
    'timing': 'decisionTiming',
    'the approval chain': 'otherApprovers',
    'a prior bad experience': 'priorBadExperience'
  };
  Object.entries(claimed).forEach(([label, field]) => {
    assert.equal(events.isProhibitedFieldName(field), true, `${label} (${field}) must be refused`);
    const { metadata } = events.scrubMetadata({ [field]: 'x' });
    assert.ok(!(field in metadata), `${label} must be stripped`);
  });
});

test('the close-related exclusion tracks the intelligence contract, not a copy', () => {
  /* Every intelligence field is prohibited as an analytics field NAME except
     the two the value allowlist names. A vertical adding a close-related
     question gets it excluded from analytics automatically. */
  intelligence.ALL_FIELDS.forEach(field => {
    const expected = !events.SAFE_VALUE_ALLOWLIST.has(field);
    assert.equal(events.isProhibitedFieldName(field), expected,
      `${field}: expected prohibited=${expected}`);
  });
  /* The offline fallback must not have drifted from the contract. */
  const missing = intelligence.ALL_FIELDS
    .filter(f => !events.SAFE_VALUE_ALLOWLIST.has(f))
    .filter(f => !events.PROHIBITED_FIELD_NAMES.has(f) && !events.isProhibitedFieldName(f));
  assert.deepEqual(missing, []);
});

test('naming a question is legal; carrying its answer is not', () => {
  /* questionId: "budgetSignal" is how a funnel knows which question was
     answered, and must keep working. metadata: { budgetSignal: … } is the
     answer itself, and must not. */
  const event = validEvent({
    eventName: 'assessment.question_answered',
    questionId: 'budgetSignal',
    metadata: { answeredCount: 4 }
  });
  assert.equal(events.validateEvent(event).valid, true);

  const leaky = validEvent({
    eventName: 'assessment.question_answered',
    questionId: 'budgetSignal',
    metadata: { budgetSignal: 'budgeted' }
  });
  assert.equal(events.validateEvent(leaky).valid, false);
});

test('legitimate analytics fields are not caught by any of the above', () => {
  ['deviceClass', 'viewportWidth', 'viewportHeight', 'stepId', 'questionId',
   'assessmentVersion', 'questionSetVersion', 'assessmentStage', 'activeElapsedMs',
   'totalElapsedMs', 'stepElapsedMs', 'path', 'utm_source', 'referrerHost',
   'eventName', 'visibleQuestionCount', 'completedQuestionCount', 'consentStatus',
   'trigger', 'provisional', 'growthScore', 'recommendedPackageId', 'capacityKnown',
   'blockingFields', 'stepName', 'resumedCount', 'locationCount', 'capacity90Day']
    .forEach(field => assert.equal(events.isProhibitedFieldName(field), false, field));
});

test('answer values travel only for allowlisted questions', () => {
  assert.equal(events.mayRecordValue('locationCount'), true);
  assert.equal(events.mayRecordValue('capacity90Day'), true);
  /* The close-related answers live in the Business Record, under its consent
     and retention rules. A second, weaker copy here would be a liability
     with no owner. */
  ['budgetSignal', 'primaryConcern', 'canApprove', 'urgency', 'respondentRole',
   'concernDetail', 'openQuestions', 'changeReason', 'salonName', 'email']
    .forEach(field => assert.equal(events.mayRecordValue(field), false, field));
});

test('the allowlist cannot override the prohibition', () => {
  /* Simulates a future contributor adding a personal field to the allowlist:
     mayRecordValue must still refuse it. */
  events.SAFE_VALUE_ALLOWLIST.add('ownerName');
  try {
    assert.equal(events.mayRecordValue('ownerName'), false,
      'allowlisting a personal field must not make it recordable');
  } finally {
    events.SAFE_VALUE_ALLOWLIST.delete('ownerName');
  }
});

/* ---------- attribution ---------- */

test('a URL is reduced to a path, and its query string never survives', () => {
  const touch = events.sanitizeTouch({
    url: 'https://nails.cedservice.com/review?token=SECRET&email=a@b.test&utm_source=qr_card',
    referrer: 'https://mail.example.com/inbox/message/123',
    utm: { utm_source: 'qr_card', utm_campaign: 'spring', utm_evil: 'x' },
    occurredAt: '2026-08-05T09:00:00.000Z'
  });

  assert.equal(touch.path, '/review');
  assert.ok(!JSON.stringify(touch).includes('SECRET'));
  assert.ok(!JSON.stringify(touch).includes('a@b.test'));
  /* A referrer path can name the message someone clicked from. Host only. */
  assert.equal(touch.referrerHost, 'mail.example.com');
  assert.equal(touch.utm.utm_source, 'qr_card');
  assert.equal(touch.utm.utm_campaign, 'spring');
  assert.ok(!('utm_evil' in touch.utm), 'only the five known UTM keys travel');
});

test('malformed attribution degrades to null rather than throwing', () => {
  assert.deepEqual(events.sanitizeAttribution(null), { firstTouch: null, latestTouch: null });
  const touch = events.sanitizeTouch({ url: 'not a url', referrer: '::::' });
  assert.equal(touch.path, null);
  assert.equal(touch.referrerHost, null);
});

/* ---------- device ---------- */

test('device class is coarse, and no user agent is involved', () => {
  assert.equal(events.classifyDevice({ width: 390, height: 844, coarsePointer: true }), 'phone');
  assert.equal(events.classifyDevice({ width: 820, height: 1180, coarsePointer: true }), 'tablet');
  assert.equal(events.classifyDevice({ width: 820, height: 1180, coarsePointer: false }), 'desktop');
  assert.equal(events.classifyDevice({ width: 1440, height: 900, coarsePointer: false }), 'desktop');
  assert.equal(events.classifyDevice({}), 'unknown');
  assert.deepEqual(events.DEVICE_CLASSES, ['phone', 'tablet', 'desktop', 'unknown']);
});

test('viewport dimensions are bucketed, because exact pixels fingerprint', () => {
  assert.equal(events.bucketViewport(391), 400);
  assert.equal(events.bucketViewport(1437), 1440);
  assert.equal(events.bucketViewport(0), null);
  assert.equal(events.bucketViewport('x'), null);
});

/* ---------- validation ---------- */

test('a well-formed event passes', () => {
  const result = events.validateEvent(validEvent());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('identifiers, timestamps and versions are all checked', () => {
  const cases = [
    [{ eventId: 'nope' }, 'invalid_event_id'],
    [{ eventName: 'assessment.invented' }, 'unknown_event'],
    [{ eventVersion: 99 }, 'event_version_mismatch'],
    [{ occurredAt: 'lunchtime' }, 'invalid_occurred_at'],
    [{ assessmentSessionId: 'nope' }, 'invalid_session_id'],
    [{ submissionId: 'nope' }, 'invalid_submission_id'],
    [{ businessId: 'nope' }, 'invalid_business_id'],
    [{ verticalId: '' }, 'invalid_vertical'],
    [{ assessmentStage: 3 }, 'invalid_stage'],
    [{ schemaVersion: 99 }, 'unsupported_schema'],
    [{ activeElapsedMs: -1 }, 'invalid_timing'],
    [{ totalElapsedMs: 99 * 60 * 60 * 1000 }, 'invalid_timing']
  ];
  cases.forEach(([overrides, code]) => {
    const result = events.validateEvent(validEvent(overrides));
    assert.equal(result.valid, false, JSON.stringify(overrides));
    assert.ok(result.errors.some(e => e.code === code),
      `${JSON.stringify(overrides)} → expected ${code}, got ${result.errors.map(e => e.code)}`);
  });
});

test('an event that declares a required field must carry it', () => {
  assert.ok(events.validateEvent(validEvent({ stepId: null })).errors
    .some(e => e.code === 'missing_required_field'), 'step_viewed requires stepId');
  assert.ok(events.validateEvent(validEvent({
    eventName: 'assessment.question_answered', questionId: null
  })).errors.some(e => e.code === 'missing_required_field'), 'question_answered requires questionId');
});

test('validation reports every problem at once, not just the first', () => {
  const result = events.validateEvent(validEvent({ eventId: 'x', verticalId: '', occurredAt: 'x' }));
  assert.ok(result.errors.length >= 3);
});
