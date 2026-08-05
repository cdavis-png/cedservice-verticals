/* The analytics endpoint and its storage contract.

   Two properties matter more than the rest and most of this file defends
   them: one bad event must not cost a good one, and nothing this endpoint
   accepts may ever reach the Business Record. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handleRequest, ANALYTICS } from '../api/analytics.mjs';
import { createFakeAnalyticsDb } from './helpers/fake-analytics-db.mjs';

const ORIGIN = 'https://nails.cedservice.com';
const SESSION = '44444444-4444-4444-8444-444444444444';
const NOW = Date.parse('2026-08-05T12:00:00.000Z');

const ENV = {
  CED_ALLOWED_ORIGINS: `${ORIGIN},https://www.cedservice.com`,
  CED_ANALYTICS_MAX_REQUEST_BYTES: '32768',
  CED_LOG_LEVEL: 'error',
  CED_RATE_LIMIT_SECRET: 'test-analytics-secret-never-real',
  CED_ANALYTICS_RATE_MAX: '120',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key-never-real'
};

const event = (overrides = {}) => ({
  eventId: randomUUID(),
  eventName: 'assessment.step_viewed',
  eventVersion: 1,
  schemaVersion: 1,
  occurredAt: new Date(NOW - 1000).toISOString(),
  assessmentSessionId: SESSION,
  submissionId: null,
  businessId: null,
  verticalId: 'nails',
  assessmentVersion: '1.3.0',
  questionSetVersion: 'nails-questions-3.0.0',
  assessmentStage: 1,
  stepId: '4',
  questionId: null,
  attribution: {
    firstTouch: { path: '/', referrerHost: 'qr.example', utm: { utm_source: 'qr_card' },
                  occurredAt: new Date(NOW - 5000).toISOString() },
    latestTouch: { path: '/', referrerHost: null, utm: {}, occurredAt: new Date(NOW - 1000).toISOString() }
  },
  device: { deviceClass: 'phone', viewportWidth: 400, viewportHeight: 840 },
  activeElapsedMs: 1000,
  totalElapsedMs: 2000,
  stepElapsedMs: 400,
  visibleQuestionCount: 23,
  completedQuestionCount: 4,
  consentStatus: 'product_allowed',
  metadata: {},
  ...overrides
});

const request = (body, opts = {}) => {
  const headers = new Headers(opts.extraHeaders || {});
  if (opts.origin !== null) headers.set('origin', opts.origin || ORIGIN);
  if (opts.contentType !== null) headers.set('content-type', opts.contentType || 'application/json');
  return new Request(`${ORIGIN}/api/analytics`, {
    method: opts.method || 'POST',
    headers,
    body: opts.method === 'OPTIONS' || body === undefined ? undefined : JSON.stringify(body)
  });
};

const post = async (events, dbOrOpts = {}, opts = {}) => {
  const db = dbOrOpts.rpc ? dbOrOpts : createFakeAnalyticsDb();
  const body = Array.isArray(events)
    ? { schemaVersion: 1, sentAt: new Date(NOW).toISOString(), events }
    : events;
  const res = await handleRequest(request(body, opts), { env: ENV, db, now: () => NOW });
  return { res, body: res.status === 204 ? null : await res.json(), db };
};

/* ---------- transport ---------- */

test('preflight returns 204 with an exact origin', async () => {
  const { res } = await post(undefined, {}, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});

test('an origin outside the allowlist is refused, and a missing one too', async () => {
  const refused = await post([event()], {}, { origin: 'https://evil.example' });
  assert.equal(refused.res.status, 403);
  assert.equal(refused.body.error.code, 'origin_not_allowed');

  const missing = await post([event()], {}, { origin: null });
  assert.equal(missing.res.status, 403);
});

test('only POST and OPTIONS are accepted', async () => {
  const { res } = await post(undefined, {}, { method: 'GET' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST, OPTIONS');
});

test('a non-JSON content type is refused before the body is read', async () => {
  const { res, body } = await post([event()], {}, { contentType: 'text/plain' });
  assert.equal(res.status, 415);
  assert.equal(body.error.code, 'unsupported_media_type');
});

test('an oversized body is refused without being parsed', async () => {
  const huge = { schemaVersion: 1, events: [event({ metadata: { pad: 'x'.repeat(40000) } })] };
  const { res, body } = await post(huge);
  assert.equal(res.status, 413);
  assert.equal(body.error.code, 'payload_too_large');
});

/* ---------- the envelope ---------- */

test('the batch envelope is validated before any event is looked at', async () => {
  const cases = [
    [{ schemaVersion: 99, events: [event()] }, 'unsupported_version'],
    [{ schemaVersion: 1, events: 'nope' }, 'invalid_batch'],
    [{ schemaVersion: 1, events: [] }, 'empty_batch'],
    /* Deliberately tiny objects. With realistic events the BYTE limit bites
       first and returns 413, which is the correct order — the reader stops
       before anything is parsed. This case proves the count limit itself. */
    [{ schemaVersion: 1, events: new Array(60).fill({}) }, 'batch_too_large']
  ];
  for (const [body, code] of cases) {
    const { res, result } = await post(body).then(r => ({ res: r.res, result: r.body }));
    assert.equal(res.status, 400, code);
    assert.equal(result.error.code, code);
  }
});

test('an envelope shaped like a contact record is refused whole, not trimmed', async () => {
  const { res, body } = await post({
    schemaVersion: 1, events: [event()], ownerEmail: 'someone@example.test'
  });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'prohibited_data');
});

test('a batch spanning sessions is refused', async () => {
  const { res, body } = await post([event(), event({ assessmentSessionId: randomUUID() })]);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'mixed_sessions');
});

/* ---------- per-event validation ---------- */

test('one bad event does not cost the good ones', async () => {
  const good = event();
  const bad = event({ eventName: 'assessment.invented' });
  const { res, body, db } = await post([good, bad]);

  assert.equal(res.status, 200);
  assert.deepEqual(body.accepted, [good.eventId]);
  assert.equal(body.rejected.length, 1);
  assert.equal(body.rejected[0].eventId, bad.eventId);
  assert.equal(body.rejected[0].code, 'unknown_event');
  assert.equal(db.state.assessment_analytics_events.length, 1);
});

test('an event carrying personal data is rejected by the server, not just the browser', async () => {
  const bad = event({ metadata: { ownerName: 'Someone', email: 'a@b.test' } });
  const { body, db } = await post([event(), bad]);

  assert.equal(body.rejected.length, 1);
  assert.equal(body.rejected[0].code, 'prohibited_field');
  assert.equal(db.state.assessment_analytics_events.length, 1);
  assert.ok(!JSON.stringify(db.state).includes('a@b.test'));
});

test('a batch of nothing but rejects still answers 200 and stores nothing', async () => {
  const { res, body, db } = await post([event({ eventId: 'not-a-uuid' })]);
  assert.equal(res.status, 200);
  assert.equal(body.stored, false);
  assert.equal(body.accepted.length, 0);
  assert.equal(db.state.assessment_analytics_events.length, 0);
});

test('a future timestamp is refused and a stale one is too', async () => {
  const future = event({ occurredAt: new Date(NOW + 10 * 60 * 1000).toISOString() });
  const stale = event({ occurredAt: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString() });
  const { body } = await post([future, stale]);
  const codes = body.rejected.map(r => r.code).sort();
  assert.deepEqual(codes, ['occurred_at_in_future', 'occurred_at_too_old']);
});

test('a small clock skew is clamped rather than refused, and the claim is preserved', async () => {
  const skewed = event({ occurredAt: new Date(NOW + 60 * 1000).toISOString() });
  const { body, db } = await post([skewed]);
  assert.equal(body.accepted.length, 1);

  const [row] = db.state.assessment_analytics_events;
  assert.ok(Date.parse(row.occurred_at) <= NOW, 'clamped to receive time');
  assert.equal(row.metadata.clockSkewClamped, true);
  assert.equal(row.metadata.claimedOccurredAt, skewed.occurredAt);
});

test('a duplicate inside one batch is reported once and stored once', async () => {
  const one = event();
  const { body, db } = await post([one, { ...one }]);
  assert.equal(body.accepted.length, 1);
  assert.equal(body.rejected[0].code, 'duplicate_in_batch');
  assert.equal(db.state.assessment_analytics_events.length, 1);
});

test('a duplicate across batches is a success, reported separately from a rejection', async () => {
  const db = createFakeAnalyticsDb();
  const one = event();
  await post([one], db);
  const { body } = await post([one], db);

  assert.deepEqual(body.accepted, []);
  assert.deepEqual(body.duplicates, [one.eventId]);
  assert.deepEqual(body.rejected, []);
  assert.equal(db.state.assessment_analytics_events.length, 1);
});

test('a client-invented field is not stored', async () => {
  const { db } = await post([event({ ipAddress: undefined, somethingExtra: 'x' })]);
  const [row] = db.state.assessment_analytics_events;
  assert.equal('somethingExtra' in row, false, 'the schema is a schema, not a suggestion');
});

/* ---------- session roll-up ---------- */

const journey = () => [
  event({ eventName: 'assessment.page_viewed', stepId: null, occurredAt: new Date(NOW - 9000).toISOString() }),
  event({ eventName: 'assessment.started', stepId: null, occurredAt: new Date(NOW - 8000).toISOString() }),
  event({ eventName: 'assessment.step_viewed', stepId: '1', occurredAt: new Date(NOW - 7000).toISOString() }),
  event({ eventName: 'assessment.question_answered', stepId: '1', questionId: 'averageTicket',
          occurredAt: new Date(NOW - 6000).toISOString() }),
  event({ eventName: 'assessment.validation_failed', stepId: '1', occurredAt: new Date(NOW - 5500).toISOString() }),
  event({ eventName: 'assessment.step_viewed', stepId: '7', occurredAt: new Date(NOW - 5000).toISOString() }),
  event({ eventName: 'assessment.stage1_completed', stepId: null, activeElapsedMs: 240000,
          totalElapsedMs: 300000, occurredAt: new Date(NOW - 4000).toISOString() })
];

test('the session summary is rolled up atomically with the events', async () => {
  const { db } = await post(journey());
  const [session] = db.state.assessment_analytics_sessions;

  assert.equal(session.assessment_session_id, SESSION);
  assert.equal(session.vertical_id, 'nails');
  assert.equal(session.event_count, 7);
  assert.equal(session.result_state, 'preliminary_results');
  assert.ok(session.stage1_completed_at);
  assert.equal(session.stage2_started_at, null);
  assert.equal(session.validation_failures, 1);
  assert.equal(session.question_interactions, 1);
  assert.equal(session.max_step_reached, 7);
  assert.equal(session.total_active_ms, 240000);
  assert.equal(session.total_elapsed_ms, 300000);
  assert.equal(session.first_touch.utm.utm_source, 'qr_card');
});

test('a failure rolls back the events and the summary together', async () => {
  const db = createFakeAnalyticsDb({ failAt: 'events' });
  const { res } = await post(journey(), db);
  assert.equal(res.status, 503);
  assert.equal(db.state.assessment_analytics_events.length, 0, 'no partial events');
  assert.equal(db.state.assessment_analytics_sessions.length, 0, 'no partial summary');
});

test('a later batch moves the summary forward without double-counting', async () => {
  const db = createFakeAnalyticsDb();
  await post(journey(), db);
  const before = { ...db.state.assessment_analytics_sessions[0] };

  await post([
    event({ eventName: 'assessment.stage2_started', stepId: null,
            occurredAt: new Date(NOW - 3000).toISOString(), assessmentStage: 2 }),
    event({ eventName: 'assessment.stage2_completed', stepId: null, assessmentStage: 2,
            activeElapsedMs: 420000, totalElapsedMs: 600000,
            occurredAt: new Date(NOW - 2000).toISOString() })
  ], db);

  const after = db.state.assessment_analytics_sessions[0];
  assert.equal(db.state.assessment_analytics_sessions.length, 1, 'one row per session');
  assert.equal(after.result_state, 'fit_review_complete');
  assert.equal(after.stage1_completed_at, before.stage1_completed_at, 'the earlier mark is not rewritten');
  assert.ok(after.stage2_completed_at);
  assert.equal(after.event_count, 9);
  assert.equal(after.max_stage_reached, 2);
  assert.equal(after.total_active_ms, 420000);
});

test('an out-of-order batch cannot rewind a session', async () => {
  const db = createFakeAnalyticsDb();
  await post(journey(), db);
  await post([event({ eventName: 'assessment.stage2_completed', stepId: null, assessmentStage: 2,
                      activeElapsedMs: 420000, totalElapsedMs: 600000,
                      occurredAt: new Date(NOW - 2000).toISOString() })], db);
  const complete = { ...db.state.assessment_analytics_sessions[0] };

  /* A step view from early in the session, arriving last. */
  await post([event({ eventName: 'assessment.step_viewed', stepId: '2',
                      activeElapsedMs: 1000, totalElapsedMs: 2000,
                      occurredAt: new Date(NOW - 7500).toISOString() })], db);

  const after = db.state.assessment_analytics_sessions[0];
  assert.equal(after.result_state, 'fit_review_complete', 'a late event does not undo completion');
  assert.equal(after.total_active_ms, complete.total_active_ms, 'timing moves forward only');
  assert.equal(after.max_step_reached, complete.max_step_reached);
  assert.equal(Date.parse(after.started_at) <= Date.parse(complete.started_at), true,
    'but an earlier start IS honoured, because it is genuinely earlier');
});

test('an abandonment followed by more activity is retracted', async () => {
  const db = createFakeAnalyticsDb();
  await post([
    event({ eventName: 'assessment.started', stepId: null, occurredAt: new Date(NOW - 9000).toISOString() }),
    event({ eventName: 'assessment.abandoned', stepId: '4', occurredAt: new Date(NOW - 8000).toISOString(),
            metadata: { provisional: true, trigger: 'idle' } })
  ], db);
  assert.equal(db.state.assessment_analytics_sessions[0].result_state, 'abandoned');
  assert.ok(db.state.assessment_analytics_sessions[0].abandoned_at);

  await post([event({ eventName: 'assessment.stage1_completed', stepId: null,
                      occurredAt: new Date(NOW - 5000).toISOString() })], db);

  const after = db.state.assessment_analytics_sessions[0];
  assert.equal(after.result_state, 'preliminary_results', 'they came back and finished');
  assert.equal(after.abandoned_at, null, 'the guess is retracted, not left standing');
});

/* REGRESSION — real-Postgres validation, 2026-08-05.

   A session whose events carry NO stage — a lone page_viewed, or a
   clear_saved_data — has null on both sides of the roll-up's forward-only
   merge. The first version coalesced both to 0 before taking the maximum,
   which produced max_stage_reached = 0 and violated
   analytics_sessions_stage_check, aborting the whole batch on the SECOND
   ingest for that session.

   The in-memory double missed it twice over: Math.max(null, null) is 0 rather
   than null, and the double did not model the constraint. Both are fixed. */
test('a second batch for a session that never declared a stage is accepted', async () => {
  const db = createFakeAnalyticsDb();
  const first = await post([event({ eventName: 'assessment.page_viewed',
    assessmentStage: null, stepId: null })], db);
  assert.equal(first.body.accepted.length, 1);

  const second = await post([event({ eventName: 'assessment.clear_saved_data',
    assessmentStage: null, stepId: null,
    occurredAt: new Date(NOW - 500).toISOString() })], db);

  assert.equal(second.res.status, 200);
  assert.equal(second.body.accepted.length, 1, 'the second unstaged batch must not be refused');
  assert.equal(second.body.stored, true);

  const [session] = db.state.assessment_analytics_sessions;
  assert.equal(session.max_stage_reached, null, '"not reached yet" is null, never zero');
  assert.equal(session.max_step_reached, null);
});

test('a stage learned later still moves the summary forward from null', async () => {
  const db = createFakeAnalyticsDb();
  await post([event({ eventName: 'assessment.page_viewed', assessmentStage: null, stepId: null })], db);
  await post([event({ eventName: 'assessment.stage2_started', assessmentStage: 2, stepId: null,
                      occurredAt: new Date(NOW - 400).toISOString() })], db);
  const [session] = db.state.assessment_analytics_sessions;
  assert.equal(session.max_stage_reached, 2);
});

test('the question-interaction denominator counts each question once per session', async () => {
  /* Real-Postgres validation found this counter missing entirely, which left
     questionInteractionRate permanently null. It is a sum over sessions of a
     per-session maximum — summing over events would count every question
     again on every step view. */
  const db = createFakeAnalyticsDb();
  await post([
    event({ eventName: 'assessment.step_viewed', stepId: '1', visibleQuestionCount: 23 }),
    event({ eventName: 'assessment.step_viewed', stepId: '2', visibleQuestionCount: 23,
            occurredAt: new Date(NOW - 900).toISOString() }),
    event({ eventName: 'assessment.question_answered', stepId: '1', questionId: 'averageTicket',
            visibleQuestionCount: 23, occurredAt: new Date(NOW - 800).toISOString() })
  ], db);
  await db.rpc('refresh_assessment_funnel_daily', {});

  const [row] = db.state.assessment_funnel_daily;
  assert.equal(row.visible_question_total, 23, 'once per session, not once per step view');
  assert.equal(row.question_interactions, 1);
});

/* ---------- rate limiting ---------- */

test('a session hammering the endpoint is refused with a Retry-After', async () => {
  const db = createFakeAnalyticsDb();
  const env = { ...ENV, CED_ANALYTICS_RATE_MAX: '3' };
  let last = null;
  for (let i = 0; i < 5; i++) {
    last = await handleRequest(
      request({ schemaVersion: 1, events: [event()] }),
      { env, db, now: () => NOW });
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal((await last.json()).error.code, 'rate_limited');
});

/* ---------- retention ---------- */

test('raw events expire and aggregates outlive them', async () => {
  const db = createFakeAnalyticsDb();
  await post(journey(), db);
  await db.rpc('refresh_assessment_funnel_daily', {});
  assert.equal(db.state.assessment_funnel_daily.length, 1);
  const aggregate = { ...db.state.assessment_funnel_daily[0] };

  const purged = await db.rpc('purge_expired_analytics_events', {
    p_now: new Date(NOW + 401 * 86400000).toISOString()
  });
  assert.equal(purged.data, 7);
  assert.equal(db.state.assessment_analytics_events.length, 0);
  assert.deepEqual(db.state.assessment_funnel_daily[0], aggregate,
    'the aggregate survives the events it was computed from');
});

test('re-running the aggregation replaces rather than accumulates', async () => {
  const db = createFakeAnalyticsDb();
  await post(journey(), db);
  await db.rpc('refresh_assessment_funnel_daily', {});
  const first = { ...db.state.assessment_funnel_daily[0] };
  await db.rpc('refresh_assessment_funnel_daily', {});

  assert.equal(db.state.assessment_funnel_daily.length, 1);
  assert.equal(db.state.assessment_funnel_daily[0].starts, first.starts);
  assert.equal(db.state.assessment_funnel_daily[0].page_views, 1);
});

test('funnel counters count sessions for stages and events for clicks', async () => {
  const db = createFakeAnalyticsDb();
  await post(journey(), db);
  await post([
    event({ eventName: 'assessment.recommended_system_clicked', stepId: null,
            occurredAt: new Date(NOW - 3000).toISOString() }),
    event({ eventName: 'assessment.recommended_system_clicked', stepId: null,
            occurredAt: new Date(NOW - 2500).toISOString() })
  ], db);
  await db.rpc('refresh_assessment_funnel_daily', {});

  const [row] = db.state.assessment_funnel_daily;
  assert.equal(row.page_views, 1, 'one session, however many page_viewed rows');
  assert.equal(row.stage1_completions, 1);
  assert.equal(row.recommended_system_clicks, 2, 'clicking twice is two clicks');
  assert.equal(row.source, 'qr_card');
  assert.equal(row.device_class, 'phone');
  assert.equal(row.median_stage1_active_ms, 240000);
});

/* ---------- isolation ---------- */

test('the analytics store holds nothing that belongs to the Business Record', async () => {
  const { db } = await post(journey());
  const tables = Object.keys(db.state);
  ['business_records', 'assessment_submissions', 'business_intelligence_reports', 'timeline_events']
    .forEach(table => assert.ok(!tables.includes(table),
      `analytics must not be able to reach ${table}`));
});

test('the endpoint answers cleanly when analytics storage is not configured', async () => {
  const res = await handleRequest(request({ schemaVersion: 1, events: [event()] }),
    { env: { ...ENV, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' }, now: () => NOW });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stored, false);
});

test('the declared limits are the shared ones', () => {
  assert.deepEqual(ANALYTICS.SUPPORTED_SCHEMA_VERSIONS, [1]);
  assert.equal(ANALYTICS.EVENT_NAMES.length, 19);
  assert.equal(ANALYTICS.CLOCK_SKEW_FUTURE_MS, 5 * 60 * 1000);
});
