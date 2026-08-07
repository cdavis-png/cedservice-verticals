/* ============================================================
   SM-1 — a connected review that could not be sent
   ------------------------------------------------------------
   The case the v2 audit found unhandled: a visitor arrives from
   a Growth Review, finishes the Service Mix review, and the
   request fails. The review is queued on the device. What
   happens next?

   Before this, nothing happened next. Nothing on the Service
   Mix page swept the queue, so a visitor who only ever opened
   that page had a completed review sit in localStorage until it
   expired thirty days later, unsent — and if something had
   retried it, the continuation context captured when it failed
   would have expired long before.

   Four properties, and they are in tension, which is why they
   are stated together:

     · the context is resolved AT RETRY TIME, not at queue time
     · it travels as a header, so it is never in the queued
       payload and never beside it in the queue entry
     · the submission id does NOT change across retries, so the
       server collapses a retry into a replay
     · an expired or missing context is not an error: the review
       is still delivered, unlinked

   Defect 3 from the v2 audit.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);

/* ---------- a browser, roughly ---------- */

const makeStorage = () => {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _map: map
  };
};

let storage;
let requests;      /* every fetch the transport made, with its headers */
let respond;       /* the current fetch behaviour */

const jsonResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  json: async () => body
});

const OFFLINE = () => { throw new TypeError('Failed to fetch'); };

const installBrowser = ({ keepStorage = false } = {}) => {
  if (!keepStorage) storage = makeStorage();
  requests = [];

  globalThis.fetch = async (url, init) => {
    const headers = init && init.headers ? { ...init.headers } : {};
    requests.push({
      url,
      headers,
      continuation: headers['X-CED-Continuation'] ?? null,
      idempotencyKey: headers['Idempotency-Key'] ?? null,
      body: init && init.body ? JSON.parse(init.body) : null
    });
    return respond();
  };

  const win = {
    location: { href: 'https://nails.test/service-mix', search: '', protocol: 'https:' },
    crypto: webcrypto,
    innerWidth: 360, innerHeight: 740,
    fetch: globalThis.fetch,
    CEDServiceMixValue: require('../shared/service-mix-engine/value.schema.js'),
    CEDServiceMixOffering: require('../shared/service-mix-engine/offering.schema.js'),
    CEDServiceMixCalculate: require('../shared/service-mix-engine/calculate.js'),
    CEDServiceMixClassify: require('../shared/service-mix-engine/classify.js'),
    CEDServiceMixGuidance: require('../shared/service-mix-engine/guidance.js'),
    CEDAnalyticsEvents: require('../shared/analytics/events.js'),
    CEDContinuation: require('../shared/security/continuation.js'),
    /* The REAL transport. A stub could not tell us what header went out. */
    CEDSubmission: require('../shared/assessment-engine/submission.js')
  };

  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: { referrer: '' }, configurable: true, writable: true });

  delete require.cache[require.resolve('../shared/service-mix-engine/controller.js')];
  return require('../shared/service-mix-engine/controller.js');
};

const teardown = () => {
  ['window', 'localStorage', 'document'].forEach(name => {
    Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
  });
  delete globalThis.fetch;
};

/* The adapter reports to the console by design; behaviour is under test. */
const silence = () => {
  const original = { warn: console.warn, info: console.info, error: console.error };
  console.warn = () => {}; console.info = () => {}; console.error = () => {};
  return () => Object.assign(console, original);
};

const QUEUE_KEY = 'test:serviceMixQueue';
const CONFIG = {
  storageKey: 'test:serviceMixRetry',
  meta: { verticalId: 'nails', verticalName: 'Nail Salons', assessmentVersion: '1.0.0' },
  submission: {
    endpoint: 'https://nails.test/api/assessments',
    queueKey: QUEUE_KEY,
    /* Zero backoff so a due retry is due immediately; the schedule itself is
       covered by tests/retry-policy.test.mjs. */
    baseRetryMs: 0,
    timeoutMs: 1000
  },
  disclaimer: () => 'This is a preliminary estimate based on your answers.',
  honeypotValue: () => ''
};

const addComplete = (controller, { name, price, duration, volume }) => {
  const offering = controller.addOffering({ name, category: 'core_service', source: 'starter' });
  controller.setMeasure(offering.offeringId, 'sellingPrice', 'exact', { value: price });
  controller.setMeasure(offering.offeringId, 'durationMinutes', 'exact', { value: duration });
  controller.setMeasure(offering.offeringId, 'monthlyVolume', 'exact', { value: volume });
  return offering;
};

const complete = controller => {
  addComplete(controller, { name: 'Gel manicure', price: 65, duration: 60, volume: 80 });
  addComplete(controller, { name: 'Acrylic full set', price: 90, duration: 150, volume: 30 });
  addComplete(controller, { name: 'Nail art', price: 25, duration: 45, volume: 40 });
  controller.setCoverage('all_offerings');
  controller.setContact({
    salonName: 'Polished Test Salon', ownerName: 'Owner', email: 'owner@polished.test' });
  controller.setConsent({
    resultsDeliveryConsent: { granted: true, statement: 'Show me my results.',
                              recordedAt: '2026-08-05T12:00:00.000Z' }
  });
};

/* A connected review that fails to send, leaving one queued entry. */
const queueAConnectedReview = async (token = '1.from.growth') => {
  const api = installBrowser();
  const continuation = require('../shared/security/continuation.js');
  continuation.storeContinuation({ token, prefill: { email: 'owner@polished.test' } });

  respond = OFFLINE;
  const controller = api.init(CONFIG);
  await controller.queueSweep();
  complete(controller);
  const outcome = await controller.submit();
  return { api, controller, outcome, continuation };
};

const queuedEntries = () =>
  require('../shared/assessment-engine/submission.js')
    .pendingSubmissions({ queueKey: QUEUE_KEY });

/* ---------- it is queued at all ---------- */

test('a connected review that cannot be sent is queued rather than lost', async t => {
  const restore = silence();
  t.after(() => { restore(); teardown(); });

  const { outcome } = await queueAConnectedReview();

  assert.equal(outcome.status, 'queued');
  assert.equal(outcome.result.permanent, false, 'a network failure clears; retrying is correct');

  const queue = queuedEntries();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].submissionId, outcome.payload.submissionId);

  /* The attempt really did carry the context, even though it failed. */
  assert.equal(requests.length, 1);
  assert.equal(requests[0].continuation, '1.from.growth');
});

/* ---------- what is NOT in the queue ---------- */

test('the continuation context is never written to the queue', async t => {
  const restore = silence();
  t.after(() => { restore(); teardown(); });

  await queueAConnectedReview('1.a.secret.bearer.value');

  const [entry] = queuedEntries();
  const text = JSON.stringify(entry);

  assert.equal(text.includes('1.a.secret.bearer.value'), false,
    'a queue entry lives in localStorage for up to thirty days; a signed ' +
    'bearer value written there is a credential at rest long after it stopped ' +
    'being useful for anything but replay');
  assert.equal(text.includes('continuationToken'), false);
  assert.equal(text.includes('X-CED-Continuation'), false);
  assert.equal(entry.payload.continuation, undefined);

  /* Nor in this review's own saved state. */
  const saved = JSON.parse(storage.getItem(CONFIG.storageKey));
  assert.equal(JSON.stringify(saved).includes('1.a.secret.bearer.value'), false);
});

/* ---------- the sweep on the next load ---------- */

test('opening the page again sweeps the queue and sends it', async t => {
  const restore = silence();
  t.after(() => { restore(); teardown(); });

  const { outcome } = await queueAConnectedReview();
  const queuedId = outcome.payload.submissionId;
  assert.equal(queuedEntries().length, 1);

  /* A second visit: same device, same storage, the server is back. */
  const api = installBrowser({ keepStorage: true });
  respond = () => jsonResponse(201, {
    ok: true, submissionId: queuedId, reviewType: 'service_mix',
    continuationToken: '2.refreshed.by.server'
  });

  const controller = api.init(CONFIG);
  const swept = await controller.queueSweep();

  assert.ok(swept, 'the Service Mix page sweeps its own queue');
  assert.equal(swept.attempted, 1);
  assert.equal(swept.sent, 1);
  assert.equal(queuedEntries().length, 0, 'delivered entries are deleted immediately');
});

test('a retry carries the context that is current when it runs, not the one it was queued with', async t => {
  const restore = silence();
  t.after(() => { restore(); teardown(); });

  await queueAConnectedReview('1.the.original.token');

  /* Between the failure and the retry, the visitor completed a Growth Review
     in another tab and the shared store now holds a newer context. */
  const api = installBrowser({ keepStorage: true });
  require('../shared/security/continuation.js')
    .storeContinuation({ token: '1.a.newer.token', prefill: { email: 'owner@polished.test' } });

  respond = () => jsonResponse(201, { ok: true, reviewType: 'service_mix' });
  const controller = api.init(CONFIG);
  await controller.queueSweep();

  const retry = requests[requests.length - 1];
  assert.equal(retry.continuation, '1.a.newer.token',
    'resolved at retry time; the token that was current at queue time is long expired');
});

test('a refreshed context from a retry is stored, and keeps the prefill it had', async t => {
  const restore = silence();
  t.after(() => { restore(); teardown(); });

  await queueAConnectedReview('1.from.growth');

  const api = installBrowser({ keepStorage: true });
  respond = () => jsonResponse(201, {
    ok: true, reviewType: 'service_mix', continuationToken: '2.refreshed.by.server'
  });

  const controller = api.init(CONFIG);
  await controller.queueSweep();

  const continuation = require('../shared/security/continuation.js');
  const stored = continuation.readContinuation();
  assert.equal(stored.token, '2.refreshed.by.server',
    'stored through the shared mechanism, so the next review finds it');
  assert.deepEqual(stored.prefill, { email: 'owner@polished.test' },
    'a refreshed token must not silently discard the prefill it replaces');
});

/* ---------- identity across retries ---------- */

test('every retry of one result carries one submission id', async t => {
  const restore = silence();
  t.after(() => { restore(); teardown(); });

  const { outcome } = await queueAConnectedReview();
  const id = outcome.payload.submissionId;

  /* Two failed sweeps, then a successful one. */
  const api = installBrowser({ keepStorage: true });
  respond = OFFLINE;
  const controller = api.init(CONFIG);
  await controller.queueSweep();
  await controller.retryQueuedSubmissions();

  respond = () => jsonResponse(201, { ok: true, reviewType: 'service_mix' });
  await controller.retryQueuedSubmissions();

  const keys = [...new Set(requests.map(r => r.idempotencyKey))];
  assert.deepEqual(keys, [id],
    'one result, one idempotency key — that is what lets the server collapse ' +
    'a retry into a replay rather than storing it twice');
  assert.equal(queuedEntries().length, 0);
});

/* ---------- an absent or expired context ---------- */

test('an expired context does not stop the review being delivered', async t => {
  const restore = silence();
  t.after(() => { restore(); teardown(); });

  await queueAConnectedReview('1.expiring.token');

  /* The context has aged out of the shared store by the time the retry runs. */
  const api = installBrowser({ keepStorage: true });
  require('../shared/security/continuation.js').clearContinuation();

  respond = () => jsonResponse(201, { ok: true, reviewType: 'service_mix' });
  const controller = api.init(CONFIG);
  const swept = await controller.queueSweep();

  assert.equal(swept.sent, 1, 'the review is delivered; it simply does not link');
  assert.equal(requests[requests.length - 1].continuation, null,
    'no header rather than an expired one');
  assert.equal(queuedEntries().length, 0);
});

test('a continuation store that throws costs the link, never the submission', async t => {
  const restore = silence();
  t.after(() => { restore(); teardown(); });

  await queueAConnectedReview();

  const api = installBrowser({ keepStorage: true });
  window.CEDContinuation = {
    readContinuation: () => { throw new Error('storage is on fire'); },
    storeContinuation: () => { throw new Error('storage is still on fire'); },
    clearContinuation: () => {}
  };

  respond = () => jsonResponse(201, {
    ok: true, reviewType: 'service_mix', continuationToken: '2.refreshed'
  });
  const controller = api.init(CONFIG);
  const swept = await controller.queueSweep();

  assert.equal(swept.sent, 1);
  assert.equal(requests[requests.length - 1].continuation, null);
  assert.equal(queuedEntries().length, 0);
});

/* ---------- the context never reaches measurement ---------- */

test('nothing about a retry reaches analytics', async t => {
  const restore = silence();
  t.after(() => { restore(); teardown(); });

  await queueAConnectedReview('1.from.growth');

  const api = installBrowser({ keepStorage: true });
  delete require.cache[require.resolve('../shared/analytics/analytics-client.js')];
  const client = require('../shared/analytics/analytics-client.js');
  window.CEDAnalytics = client;

  respond = () => jsonResponse(201, {
    ok: true, reviewType: 'service_mix', continuationToken: '2.refreshed.by.server'
  });

  const controller = api.init(CONFIG);
  client.configure({
    endpoint: null, verticalId: 'nails', reviewType: 'service_mix',
    assessmentSessionId: controller.state().assessmentSessionId,
    batchSize: 500, flushIntervalMs: 3600000
  });
  controller.track('service_mix.review_viewed', { metadata: { trigger: controller.entryTrigger() } });
  await controller.queueSweep();

  const envelopes = JSON.stringify(client._internal.queue());
  client._internal.teardown();

  ['1.from.growth', '2.refreshed.by.server', 'continuationToken', 'X-CED-Continuation']
    .forEach(needle => assert.equal(envelopes.includes(needle), false,
      `${needle} must never reach a funnel row`));

  /* And no queue identifier either — a retry is not a measurement. */
  assert.equal(envelopes.includes('queueId'), false);
});
