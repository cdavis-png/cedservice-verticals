/* ============================================================
   Platform annotations belong to ONE event, and to the platform
   ------------------------------------------------------------
   What the v3 audit found: `PLATFORM_METADATA` was a separate
   object with a comment claiming pages could not reach it. The
   comment was wrong. The public `track()` and the internal
   abandonment builder fed the same sanitizer, so any page could
   attach `provisional: true`, `quietForMs`, `clockSkewClamped`
   and the rest to any Service Mix event, and the endpoint stored
   them.

   None of that is a privacy leak. All of it is a funnel row
   saying something untrue about how it was recorded —
   `provisional` on an observed page view, a clock-skew
   annotation on an event nobody clamped — and CLAUDE.md section
   11 exists because a wrong number is worse than a missing one.

   So there are two paths now, and the boundary is a parameter
   only the client itself supplies rather than a comment:

     track()          public. Seven approved keys. No annotations,
                      whatever event it names.
     trackInternal()  private to analytics-client.js. Used for
                      assessment.abandoned, which nobody observed.

   These drive the REAL client and the REAL endpoint. A stub of
   either would prove nothing about the boundary between them.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';

import { handleRequest } from '../api/analytics.mjs';
import { createFakeAnalyticsDb } from './helpers/fake-analytics-db.mjs';

const require = createRequire(import.meta.url);
const events = require('../shared/analytics/events.js');

const ORIGIN = 'https://nails.cedservice.com';
const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const SESSION = '44444444-4444-4444-8444-444444444444';

const ENV = {
  CED_ALLOWED_ORIGINS: ORIGIN,
  CED_ANALYTICS_MAX_REQUEST_BYTES: '32768',
  CED_LOG_LEVEL: 'error',
  CED_RATE_LIMIT_SECRET: 'test-analytics-secret-never-real',
  CED_ANALYTICS_RATE_MAX: '500',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key-never-real'
};

/* ---------- a browser, roughly ---------- */

const makeStorage = () => {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k)
  };
};

let client;

const installClient = () => {
  const storage = makeStorage();
  Object.defineProperty(globalThis, 'window', {
    value: { crypto: webcrypto, innerWidth: 360, innerHeight: 740, localStorage: storage },
    configurable: true, writable: true
  });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: { referrer: '' }, configurable: true, writable: true });

  delete require.cache[require.resolve('../shared/analytics/analytics-client.js')];
  client = require('../shared/analytics/analytics-client.js');
  client.configure({
    endpoint: null, verticalId: 'nails', reviewType: 'service_mix',
    assessmentSessionId: SESSION,
    /* Large enough that nothing auto-flushes mid-test; the queue is what is
       being inspected. Batching itself is covered elsewhere. */
    batchSize: 500, flushIntervalMs: 3600000
  });
  return client;
};

const teardown = () => {
  if (client && client._internal) client._internal.teardown();
  ['window', 'localStorage', 'document'].forEach(name =>
    Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true }));
  client = null;
};

const queued = name => client._internal.queue().filter(e => e.eventName === name);

/* ---------- the endpoint, for the complete stored row ---------- */

const post = async (envelopes, { keepOccurredAt = false } = {}) => {
  const db = createFakeAnalyticsDb();
  const body = {
    schemaVersion: 1, sentAt: new Date(NOW).toISOString(),
    /* The client's own clock is not this test's subject, so it is pinned
       inside the endpoint's freshness window — except where the clamp itself
       is what is under test. */
    events: envelopes.map(e => (keepOccurredAt
      ? e
      : { ...e, occurredAt: new Date(NOW - 1000).toISOString() }))
  };
  const res = await handleRequest(
    new Request(`${ORIGIN}/api/analytics`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    { env: ENV, db, now: () => NOW });
  return { res, body: await res.json(), db };
};

/* ============================================================
   A page cannot reach an annotation
   ============================================================ */

test('a page cannot attach abandonment annotations to service_mix.review_viewed', async t => {
  t.after(teardown);
  installClient();

  client.track('service_mix.review_viewed', {
    metadata: {
      trigger: 'standalone',
      /* Everything the internal builder is allowed to write. */
      provisional: true, quietForMs: 1860000, resumedCount: 2,
      reachedStage1: true, reachedStage2: false
    }
  });

  const [envelope] = queued('service_mix.review_viewed');
  assert.ok(envelope, 'the event itself is still emitted — the annotations are what go');
  assert.deepEqual(envelope.metadata, { trigger: 'standalone' });

  /* And through the endpoint, into the complete stored row. */
  const { body, db } = await post([envelope]);
  assert.equal(body.rejected.length, 0);
  const [row] = db.state.assessment_analytics_events;
  assert.deepEqual(row.metadata, { trigger: 'standalone' });
  assert.equal(row.review_type, 'service_mix');
});

test('naming the event that owns them does not help', async t => {
  t.after(teardown);
  installClient();

  /* The public path passes no event name to the sanitizer at all, so a page
     that calls track('assessment.abandoned') gets the page rule, not the
     abandonment rule. The client's own inference is the only thing that can
     produce a truthful abandonment event. */
  client.track('assessment.abandoned', {
    metadata: { provisional: true, trigger: 'page_exit', quietForMs: 60000 }
  });

  const [envelope] = queued('assessment.abandoned');
  assert.ok(envelope);
  assert.deepEqual(envelope.metadata, {},
    'a page-declared abandonment carries no evidence about how it was inferred');
});

test('a page cannot attach clock-skew annotations, and the endpoint removes them', async t => {
  t.after(teardown);
  installClient();

  client.track('service_mix.results_viewed', {
    metadata: {
      resultKind: 'preliminary',
      clockSkewClamped: true,
      claimedOccurredAt: 'owner@example.com'
    }
  });

  const [envelope] = queued('service_mix.results_viewed');
  assert.deepEqual(envelope.metadata, { resultKind: 'preliminary' },
    'removed in the browser');

  /* And removed again server-side, from an envelope the browser never built:
     the browser copy can be tampered with. */
  const forged = {
    ...envelope,
    metadata: { resultKind: 'preliminary', clockSkewClamped: true,
                claimedOccurredAt: 'owner@example.com' }
  };
  const { body, db } = await post([forged]);
  assert.equal(body.accepted.length, 1, 'removed, not refused: it was going to be overwritten');
  const [row] = db.state.assessment_analytics_events;
  assert.deepEqual(row.metadata, { resultKind: 'preliminary' });
  assert.equal(JSON.stringify(db.state).includes('owner@example.com'), false);
});

test('only an actual clamp adds clock-skew metadata to a stored row', async t => {
  t.after(teardown);
  installClient();

  client.track('service_mix.results_viewed', { metadata: { resultKind: 'preliminary' } });
  const [envelope] = queued('service_mix.results_viewed');

  /* Unclamped: the row carries nothing about skew. */
  const ordinary = await post([envelope]);
  assert.deepEqual(ordinary.db.state.assessment_analytics_events[0].metadata,
    { resultKind: 'preliminary' });

  /* Clamped: the endpoint derives both keys itself, from the parsed
     timestamp rather than from the request. */
  const ahead = new Date(NOW + 60 * 1000).toISOString();
  const skewed = await post([{ ...envelope, eventId: randomUUID(), occurredAt: ahead }],
    { keepOccurredAt: true });
  const [row] = skewed.db.state.assessment_analytics_events;
  assert.equal(row.metadata.clockSkewClamped, true);
  assert.equal(row.metadata.claimedOccurredAt, new Date(Date.parse(ahead)).toISOString());
  assert.ok(Date.parse(row.occurred_at) <= NOW);
});

/* ============================================================
   The internal path still tells the truth
   ============================================================ */

test('a real abandonment keeps every provisional field, end to end', async t => {
  t.after(teardown);
  installClient();

  client.markStarted();
  client.setStep('figures');
  client.track('service_mix.review_started', { metadata: { trigger: 'standalone' } });

  /* The client's own inference — the only path that may write these. */
  client._internal.inferAbandonment('page_exit', 1860000);

  const [envelope] = queued('assessment.abandoned');
  assert.ok(envelope, 'drop-off must stay measurable');
  assert.equal(envelope.metadata.provisional, true,
    'this is what stops an abandonment count being read as a total');
  assert.equal(envelope.metadata.trigger, 'page_exit');
  assert.equal(envelope.metadata.quietForMs, 1860000);
  assert.equal(typeof envelope.metadata.resumedCount, 'number');
  assert.equal(envelope.metadata.reachedStage1, false);
  assert.equal(envelope.metadata.reachedStage2, false);
  assert.equal(envelope.reviewType, 'service_mix');
  assert.equal(envelope.businessId, null);

  /* The complete stored row, through the real endpoint. */
  const { body, db } = await post([envelope]);
  assert.deepEqual(body.rejected, []);
  const [row] = db.state.assessment_analytics_events;
  assert.deepEqual(row.metadata, {
    provisional: true, trigger: 'page_exit', quietForMs: 1860000,
    resumedCount: 0, reachedStage1: false, reachedStage2: false
  });
  assert.equal(row.review_type, 'service_mix');
  assert.equal(row.business_id, null);
  assert.equal(row.step_id, 'figures');

  /* Every key in the stored row is one of the three permitted sets, and
     nothing else got in along the way. */
  const permitted = new Set([
    ...events.SERVICE_MIX_METADATA_KEYS,
    ...events.PLATFORM_METADATA_KEYS,
    ...events.ENDPOINT_DERIVED_METADATA_KEYS
  ]);
  Object.keys(row.metadata).forEach(key =>
    assert.ok(permitted.has(key), `${key} is not an approved metadata key`));
});

test('an abandonment on the Growth funnel is untouched by any of this', async t => {
  t.after(teardown);
  const storage = makeStorage();
  Object.defineProperty(globalThis, 'window', {
    value: { crypto: webcrypto, innerWidth: 1280, innerHeight: 900, localStorage: storage },
    configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: { referrer: '' }, configurable: true, writable: true });

  delete require.cache[require.resolve('../shared/analytics/analytics-client.js')];
  client = require('../shared/analytics/analytics-client.js');
  client.configure({
    endpoint: null, verticalId: 'nails', reviewType: 'growth_review',
    assessmentSessionId: SESSION, batchSize: 500, flushIntervalMs: 3600000
  });

  client.markStarted();
  client._internal.inferAbandonment('idle', 1860000);

  const [envelope] = queued('assessment.abandoned');
  assert.equal(envelope.reviewType, 'growth_review');
  assert.equal(envelope.metadata.provisional, true);

  /* The Growth funnel's metadata contract is not narrowed by an SM-1 rule. */
  const { body, db } = await post([envelope]);
  assert.deepEqual(body.rejected, []);
  const [row] = db.state.assessment_analytics_events;
  assert.equal(row.metadata.provisional, true);
  assert.equal(row.metadata.quietForMs, 1860000);
});

/* ============================================================
   metadata.reviewType
   ============================================================ */

test('a Service Mix event cannot carry metadata.reviewType growth_review', async t => {
  t.after(teardown);
  installClient();

  client.track('service_mix.results_viewed', {
    metadata: { reviewType: 'growth_review', resultKind: 'preliminary' }
  });

  const [envelope] = queued('service_mix.results_viewed');
  assert.deepEqual(envelope.metadata, { resultKind: 'preliminary' },
    'dropped in the browser rather than filed under the wrong funnel');

  /* And refused server-side if a tampered client sends it anyway. */
  const { body, db } = await post([{
    ...envelope,
    metadata: { reviewType: 'growth_review', resultKind: 'preliminary' }
  }]);
  assert.equal(body.rejected.length, 1);
  assert.equal(body.rejected[0].code, 'unapproved_service_mix_metadata');
  assert.equal(db.state.assessment_analytics_events.length, 0);

  /* Its own review type is fine, and is what the page actually sends. */
  const honest = await post([{ ...envelope, eventId: randomUUID(),
    metadata: { reviewType: 'service_mix', resultKind: 'preliminary' } }]);
  assert.deepEqual(honest.body.rejected, []);
  assert.deepEqual(honest.db.state.assessment_analytics_events[0].metadata,
    { reviewType: 'service_mix', resultKind: 'preliminary' });
});

test('the public API exposes no internal tracking path', async t => {
  t.after(teardown);
  installClient();

  assert.equal(typeof client.track, 'function');
  assert.equal(client.trackInternal, undefined,
    'the boundary is a parameter this file alone supplies, not a comment');
  assert.equal(client._internal.trackInternal, undefined);
});
