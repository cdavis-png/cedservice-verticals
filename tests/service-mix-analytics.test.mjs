/* ============================================================
   SM-1 — analytics, separated by review type
   ------------------------------------------------------------
   Two properties:

     · the two funnels are separable, and a service_mix.* event
       can never be filed under the Growth funnel
     · no offering name, id, price, cost, revenue, volume, or
       duration can reach an analytics row, from either side of
       the wire

   docs/ANALYTICS_PRIVACY.md.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import events from '../shared/analytics/events.js';
import registry from '../shared/business-intelligence/review-registry.js';
import funnel from '../shared/analytics/funnel.js';

const validEvent = (overrides = {}) => ({
  eventId: randomUUID(),
  eventName: 'assessment.step_viewed',
  eventVersion: 1,
  schemaVersion: 2,
  occurredAt: '2026-08-05T09:00:00.000Z',
  assessmentSessionId: '22222222-2222-4222-8222-222222222222',
  submissionId: null,
  businessId: null,
  verticalId: 'nails',
  reviewType: 'service_mix',
  assessmentStage: 1,
  stepId: 'figures',
  questionId: null,
  attribution: { firstTouch: null, latestTouch: null },
  device: { deviceClass: 'phone', viewportWidth: 400, viewportHeight: 840 },
  activeElapsedMs: 1200,
  totalElapsedMs: 4000,
  stepElapsedMs: 300,
  visibleQuestionCount: 12,
  completedQuestionCount: 4,
  consentStatus: 'product_allowed',
  metadata: {},
  ...overrides
});

/* ---------- the catalog ---------- */

test('every measurement the milestone names has an event', () => {
  [
    'service_mix.review_viewed',            /* review viewed */
    'service_mix.review_started',           /* review started */
    'service_mix.offering_added',           /* offering added */
    'service_mix.offering_removed',         /* removed before submission */
    'service_mix.stage1_completed',         /* stage 1 completed */
    'service_mix.results_viewed',           /* results viewed */
    'service_mix.pricing_detail_requested', /* pricing detail requested */
    'service_mix.bundle_recommendation_viewed',
    'service_mix.growth_review_clicked',
    'service_mix.ai_analysis_clicked'
  ].forEach(name => assert.ok(events.EVENTS[name], `missing ${name}`));

  /* Drop-off by step reuses the shared mechanism rather than a second set of
     names. Separating the funnels is a GROUP BY, not a parallel catalog. */
  ['assessment.step_viewed', 'assessment.step_completed', 'assessment.validation_failed']
    .forEach(name => assert.ok(events.EVENTS[name]));
});

test('the analytics review-type list mirrors the registry', () => {
  assert.deepEqual(events.REVIEW_TYPES, registry.REVIEW_TYPES,
    'restated for a page that loads analytics and nothing else — they must not drift');
  assert.equal(events.DEFAULT_REVIEW_TYPE, registry.DEFAULT_REVIEW_TYPE);
});

/* ---------- review-type separation ---------- */

test('an event with no declared review type is a Growth Review event', () => {
  assert.equal(events.normalizeReviewType(undefined), 'growth_review');
  assert.equal(events.normalizeReviewType(null), 'growth_review');
  assert.equal(events.normalizeReviewType('vibes'), 'growth_review',
    'relabelling a row later is not something an append-only table can do');
  assert.equal(events.normalizeReviewType('service_mix'), 'service_mix');
});

test('the event name wins whenever it settles the review type', () => {
  assert.equal(events.reviewTypeOfEvent('service_mix.results_viewed'), 'service_mix');
  assert.equal(events.reviewTypeOfEvent('assessment.step_viewed'), null,
    'a shared event takes its review type from the emitting page');
});

test('a service_mix event claiming to be a Growth Review is refused', () => {
  const confused = validEvent({
    eventName: 'service_mix.results_viewed', reviewType: 'growth_review'
  });
  const result = events.validateEvent(confused);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'review_type_mismatch'),
    'one funnel split across two review types answers nothing');
});

test('an invented review type is refused', () => {
  const result = events.validateEvent(validEvent({ reviewType: 'vibes_review' }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'invalid_review_type'));
});

test('an absent review type is legal, so a page cached before the deploy still works', () => {
  const legacy = validEvent({ eventName: 'assessment.step_viewed', schemaVersion: 1 });
  delete legacy.reviewType;
  assert.equal(events.validateEvent(legacy).valid, true);
  assert.deepEqual(events.SUPPORTED_SCHEMA_VERSIONS, [1, 2]);
});

/* ---------- the privacy boundary ---------- */

test('nothing about an offering can reach an analytics row', () => {
  const refused = [
    /* identity */
    'offeringId', 'offeringSnapshotId', 'replacesOfferingId', 'offeringName', 'offerings',
    /* what it costs and earns */
    'sellingPrice', 'price', 'unitPrice', 'pricePoint',
    'directCost', 'cost', 'totalCost',
    'monthlyRevenue', 'revenue', 'revenuePerCapacityHour',
    'monthlyVolume', 'volume',
    'durationMinutes', 'duration', 'capacityHours', 'appointmentMinutes',
    'margin', 'contribution', 'averageTicket', 'earnings',
    /* shares are derived from all of the above */
    'shareOfEnteredRevenue', 'shareOfEnteredCapacity'
  ];

  refused.forEach(field => {
    assert.equal(events.isProhibitedFieldName(field), true, `${field} must be refused`);
    const { metadata } = events.scrubMetadata({ [field]: 'x' });
    assert.ok(!(field in metadata), `${field} must be stripped from metadata`);
  });
});

test('a stable offering id is refused even though it is opaque', () => {
  assert.equal(events.isProhibitedFieldName('offeringId'), true,
    'it is stable across submissions by design, which makes it a join key ' +
    'between a funnel and a Business Record — and the absence of any such key ' +
    'is what keeps the two apart');
});

test('the metadata a Service Mix event IS allowed to carry survives scrubbing', () => {
  const allowed = {
    reviewType: 'service_mix',
    stage: 1,
    stepId: 'figures',
    trigger: 'after_growth_review',
    offeringSource: 'starter',
    offeringCountBand: 'two_to_three',
    resultKind: 'preliminary'
  };
  const { metadata, droppedFields } = events.scrubMetadata(allowed);
  assert.deepEqual(droppedFields, []);
  assert.deepEqual(metadata, allowed);
  events.SERVICE_MIX_METADATA_KEYS.forEach(key =>
    assert.equal(events.isProhibitedFieldName(key), false, `${key} must survive`));
});

/* ---------- the allowlist is enforcement, not documentation ----------

   The name-based rule catches an honest leak: someone adds `ownerEmail` and
   it is refused. It cannot catch a dishonest one, because the key names
   itself — `stepId: "owner@example.com"` satisfies every name rule ever
   written. These tests are about the second case. */

test('a Service Mix event may carry the approved keys and no others', () => {
  assert.deepEqual(events.SERVICE_MIX_METADATA_KEYS,
    ['reviewType', 'stage', 'stepId', 'trigger',
     'offeringSource', 'offeringCountBand', 'resultKind'],
    'the approved list, in the approved order');

  const approved = {
    reviewType: 'service_mix', stage: 1, stepId: 'figures',
    trigger: 'after_growth_review', offeringSource: 'starter',
    offeringCountBand: 'two_to_three', resultKind: 'preliminary'
  };
  const kept = events.sanitizeServiceMixMetadata(approved);
  assert.deepEqual(kept.metadata, approved);
  assert.deepEqual(kept.droppedFields, []);

  /* A key nobody prohibited, and nobody approved either. */
  const extra = events.sanitizeServiceMixMetadata({ ...approved, prefilled: true, note: 'x' });
  assert.deepEqual(extra.droppedFields, ['prefilled', 'note']);
  assert.deepEqual(extra.metadata, approved);
});

test('an approved key with an unapproved value is removed, never truncated', () => {
  const smuggled = {
    stepId: 'owner@example.com',
    trigger: 'Gel manicure',
    offeringSource: 'She said she will buy in September if the price drops.',
    offeringCountBand: 4,
    resultKind: '4f9f0e0a-2a9c-4d3a-9d2b-8a1b7c6d5e4f',
    stage: 'one'
  };
  const { metadata, droppedFields } = events.sanitizeServiceMixMetadata(smuggled);
  assert.deepEqual(metadata, {}, 'not one of them survives in any form');
  assert.deepEqual(droppedFields.sort(), Object.keys(smuggled).sort());

  /* Truncation would have been the wrong repair. A shortened value is a
     different value, and "owner@exam" is not safer than the address — it is
     the same leak, harder to notice. */
  assert.equal(JSON.stringify(metadata).includes('owner'), false);
});

test('a UUID under a neutral key is refused, because that is the shape an offering id has', () => {
  const uuid = '4f9f0e0a-2a9c-4d3a-9d2b-8a1b7c6d5e4f';
  /* It passes every name rule and every slug rule: it is hex and hyphens. */
  assert.equal(events.isProhibitedFieldName('stepId'), false);
  const { metadata, droppedFields } = events.sanitizeServiceMixMetadata({ stepId: uuid });
  assert.deepEqual(metadata, {});
  assert.deepEqual(droppedFields, ['stepId']);
});

test('the validator refuses a Service Mix event whose metadata is unapproved', () => {
  const leaky = events.validateEvent(validEvent({
    eventName: 'service_mix.results_viewed',
    metadata: { resultKind: 'preliminary', stepId: 'owner@example.com' }
  }));
  assert.equal(leaky.valid, false);
  assert.ok(leaky.errors.some(e => e.code === 'unapproved_service_mix_metadata'));

  /* And the refusal does not become the leak. */
  assert.equal(JSON.stringify(leaky.errors).includes('owner@example.com'), false);
});

test('the rule follows the review type, not the event name prefix', () => {
  /* A shared assessment.* event emitted by the Service Mix page is a Service
     Mix event, and is held to the Service Mix rule. */
  const shared = events.validateEvent(validEvent({
    eventName: 'assessment.step_viewed', reviewType: 'service_mix',
    metadata: { blockingFields: ['name'] }
  }));
  assert.equal(shared.valid, false);
  assert.ok(shared.errors.some(e => e.code === 'unapproved_service_mix_metadata'));

  /* The same metadata on the Growth funnel is untouched: this allowlist is
     an SM-1 rule and does not narrow an existing contract. */
  const growth = events.validateEvent(validEvent({
    eventName: 'assessment.step_viewed', reviewType: 'growth_review',
    metadata: { blockingFields: ['name'] }
  }));
  assert.equal(growth.valid, true);
});

/* ---------- platform annotations belong to ONE event ----------

   The v3 implementation kept a PLATFORM_METADATA object and a comment saying
   pages could not reach it. The comment was wrong: the same public track()
   path fed the same sanitizer, so any page could attach `provisional: true`
   to any Service Mix event. A funnel row saying "provisional" on a results
   view is not a privacy leak, but it is a lie about how the number was
   obtained. So the annotations are keyed by event name. */

test('abandonment annotations are permitted on the abandonment event', () => {
  /* provisional is what marks an abandonment count as a floor rather than a
     total. Dropping it would have made the Service Mix funnel report
     inferred abandonments as observed ones. */
  const kept = events.sanitizeServiceMixMetadata({
    trigger: 'idle', provisional: true, quietForMs: 1860000,
    resumedCount: 1, reachedStage1: false, reachedStage2: false
  }, 'assessment.abandoned');

  assert.deepEqual(kept.droppedFields, []);
  assert.equal(kept.metadata.provisional, true);
  assert.equal(kept.metadata.trigger, 'idle',
    'the abandonment vocabulary, not the entry one');
});

test('the same annotations are refused on every other event', () => {
  ['service_mix.review_viewed', 'service_mix.results_viewed',
   'assessment.step_viewed', undefined].forEach(eventName => {
    const result = events.sanitizeServiceMixMetadata({
      resultKind: 'preliminary', provisional: true, quietForMs: 1860000,
      resumedCount: 1, reachedStage1: true, reachedStage2: false
    }, eventName);

    assert.deepEqual(result.metadata, { resultKind: 'preliminary' },
      `${eventName}: only the approved page keys survive`);
    assert.deepEqual(result.droppedFields.sort(),
      ['provisional', 'quietForMs', 'reachedStage1', 'reachedStage2', 'resumedCount']);
  });
});

test('each trigger vocabulary belongs to its own event', () => {
  /* One key, two closed sets. An entry trigger on an abandonment event and an
     abandonment trigger on a page view are each nonsense, and nonsense in a
     funnel is worse than a gap because it looks like data. */
  assert.deepEqual(
    events.sanitizeServiceMixMetadata({ trigger: 'idle' }, 'service_mix.review_viewed').droppedFields,
    ['trigger']);
  assert.deepEqual(
    events.sanitizeServiceMixMetadata({ trigger: 'standalone' }, 'assessment.abandoned').droppedFields,
    ['trigger']);
  assert.equal(
    events.sanitizeServiceMixMetadata({ trigger: 'standalone' }, 'service_mix.review_viewed')
      .metadata.trigger, 'standalone');
});

test('an annotation cannot be forged into a string, a fraction, or a negative', () => {
  const forged = events.sanitizeServiceMixMetadata({
    provisional: 'owner@example.com', quietForMs: 'Gel manicure',
    resumedCount: -1, reachedStage1: 'yes'
  }, 'assessment.abandoned');

  assert.deepEqual(forged.metadata, {});
  assert.deepEqual(forged.droppedFields.sort(),
    ['provisional', 'quietForMs', 'reachedStage1', 'resumedCount']);

  /* provisional is exactly true. An abandonment is always a guess, and
     `provisional: false` is a claim this platform cannot make. */
  assert.deepEqual(
    events.sanitizeServiceMixMetadata({ provisional: false }, 'assessment.abandoned').droppedFields,
    ['provisional']);

  /* Counts are whole milliseconds within a bounded range. */
  assert.deepEqual(
    events.sanitizeServiceMixMetadata({ quietForMs: 1.5 }, 'assessment.abandoned').droppedFields,
    ['quietForMs']);
  assert.deepEqual(
    events.sanitizeServiceMixMetadata({ quietForMs: 99 * 24 * 3600 * 1000 }, 'assessment.abandoned')
      .droppedFields, ['quietForMs']);
});

test('the endpoint-derived annotations are refused from any request, on any event', () => {
  /* A client that could assert "my timestamp was clamped" could annotate a
     row with an event that never happened. */
  events.EVENT_NAMES.concat([undefined]).forEach(eventName => {
    const result = events.sanitizeServiceMixMetadata(
      { clockSkewClamped: true, claimedOccurredAt: '2026-08-05T12:00:00.000Z' }, eventName);
    assert.deepEqual(result.metadata, {}, `${eventName}`);
    assert.deepEqual(result.droppedFields.sort(), ['claimedOccurredAt', 'clockSkewClamped']);
  });

  assert.deepEqual(events.ENDPOINT_DERIVED_METADATA_KEYS.sort(),
    ['claimedOccurredAt', 'clockSkewClamped']);
});

test('metadata.reviewType on a Service Mix event must be service_mix', () => {
  assert.equal(
    events.sanitizeServiceMixMetadata({ reviewType: 'service_mix' }).metadata.reviewType,
    'service_mix');
  assert.deepEqual(
    events.sanitizeServiceMixMetadata({ reviewType: 'growth_review' }).droppedFields,
    ['reviewType'],
    'an event already resolved as Service Mix cannot also say it is a Growth Review');

  const leaky = events.validateEvent(validEvent({
    eventName: 'service_mix.results_viewed',
    metadata: { reviewType: 'growth_review', resultKind: 'preliminary' }
  }));
  assert.equal(leaky.valid, false);
  assert.ok(leaky.errors.some(e => e.code === 'unapproved_service_mix_metadata'));
});

test('an offering count travels as a band, never as a count with a timestamp', () => {
  assert.equal(events.offeringCountBand(0), 'none');
  assert.equal(events.offeringCountBand(1), 'one');
  assert.equal(events.offeringCountBand(2), 'two_to_three');
  assert.equal(events.offeringCountBand(3), 'two_to_three');
  assert.equal(events.offeringCountBand(5), 'four_to_five');
  assert.equal(events.offeringCountBand(9), 'over_five');
  assert.equal(events.offeringCountBand('nonsense'), 'none');
});

test('an offering name is refused at any depth in an event', () => {
  const leaky = validEvent({
    eventName: 'service_mix.offering_added',
    metadata: { nested: { deeper: { offeringName: 'Gel manicure' } } }
  });
  const result = events.validateEvent(leaky);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'prohibited_field'));
});

test('naming a question stays legal; carrying the answer does not', () => {
  const named = validEvent({
    eventName: 'assessment.question_answered', questionId: 'sellingPrice',
    metadata: { reviewType: 'service_mix' }
  });
  assert.equal(events.validateEvent(named).valid, true,
    'a funnel needs to know WHICH question was answered');

  const leaky = validEvent({
    eventName: 'assessment.question_answered', questionId: 'sellingPrice',
    metadata: { sellingPrice: 65 }
  });
  assert.equal(events.validateEvent(leaky).valid, false);
});

test('the value allowlist did not widen for SM-1', () => {
  assert.deepEqual([...events.SAFE_VALUE_ALLOWLIST].sort(), ['capacity90Day', 'locationCount'],
    'no Service Mix answer value travels, and the allowlist can never override the prohibition');
  assert.equal(events.mayRecordValue('sellingPrice'), false);
  assert.equal(events.mayRecordValue('offeringId'), false);
});

test('everything the Growth funnel already carried still passes', () => {
  ['deviceClass', 'viewportWidth', 'viewportHeight', 'stepId', 'questionId',
   'assessmentVersion', 'questionSetVersion', 'assessmentStage', 'activeElapsedMs',
   'totalElapsedMs', 'stepElapsedMs', 'path', 'utm_source', 'referrerHost',
   'eventName', 'visibleQuestionCount', 'completedQuestionCount', 'consentStatus',
   'trigger', 'provisional', 'growthScore', 'recommendedPackageId', 'capacityKnown',
   'blockingFields', 'stepName', 'resumedCount', 'locationCount', 'capacity90Day']
    .forEach(field => assert.equal(events.isProhibitedFieldName(field), false,
      `${field} was legal before SM-1 and must stay legal`));
});

/* ---------- funnels ---------- */

test('reviewType is a segment, so the two funnels are one calculation cut two ways', () => {
  assert.ok(funnel.SEGMENTS.includes('reviewType'),
    'two separate calculations would eventually drift apart');

  const rows = [
    { reviewType: 'growth_review', pageViews: 200, starts: 160, stage1Completions: 120,
      preliminaryResultViews: 110, stage2Starts: 40, stage2Completions: 30 },
    { reviewType: 'service_mix', pageViews: 120, starts: 90, stage1Completions: 70,
      preliminaryResultViews: 66, stage2Starts: 0, stage2Completions: 0 }
  ];

  const segmented = funnel.computeSegmented(rows, 'reviewType');
  const growth = segmented.find(s => s.key === 'growth_review');
  const mix = segmented.find(s => s.key === 'service_mix');

  assert.ok(growth && mix, 'both review types must appear as their own group');
  assert.equal(growth.counters.pageViews, 200);
  assert.equal(mix.counters.pageViews, 120);
  assert.notEqual(growth.steps.view_to_start.value, mix.steps.view_to_start.value);
});

test('a Service Mix funnel reports no Stage 2 rather than a zero one', () => {
  const mix = funnel.computeFunnel({
    pageViews: 120, starts: 90, stage1Completions: 70, preliminaryResultViews: 66,
    stage2Starts: 0, stage2Completions: 0
  }, { minSample: 1 });

  assert.ok(mix.steps.view_to_start.value > 0);
  /* SM-1 has no Stage 2 at all, so its denominator is zero and the rate is
     null. A zero here would read as "nobody continued", which is a finding
     about a stage that does not exist. */
  assert.equal(mix.steps.stage2_start_to_complete.value, null,
    'a ratio with no denominator is null, never zero');
});

/* ---------- the analytics contract does not touch the assessment ---------- */

test('nothing in the analytics contract can write to a report or a record', () => {
  const surface = Object.keys(events);
  ['generateBir', 'generateServiceMixBir', 'ingest', 'save', 'write', 'persist']
    .forEach(name => assert.equal(surface.includes(name), false,
      'analytics observes the review; it never participates in it'));
});
