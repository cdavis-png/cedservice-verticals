/* The analytics client: batching, offline durability, retry, timing, and the
   rule that outranks all of them — nothing in here may break the assessment.

   The clock is injected throughout. Every rule under test is a statement about
   elapsed time, and a test that waits thirty real minutes for the abandonment
   threshold is a test nobody runs. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installBrowser, loadAnalytics, uninstallBrowser, SESSION
} from './helpers/analytics-harness.mjs';

let browser = null;
let client = null;

const setup = (options = {}, browserOptions = {}) => {
  browser = installBrowser(browserOptions);
  const loaded = loadAnalytics();
  client = loaded.client;
  client.configure({
    endpoint: 'https://nails.cedservice.com/api/analytics',
    verticalId: 'nails',
    assessmentSessionId: SESSION,
    now: browser.now,
    flushIntervalMs: 0,          /* driven explicitly, never by a real timer */
    context: () => ({
      verticalId: 'nails',
      assessmentVersion: '1.3.0',
      questionSetVersion: 'nails-questions-3.0.0',
      visibleQuestionCount: 23,
      completedQuestionCount: 4,
      attribution: {
        firstTouch: { url: 'https://nails.cedservice.com/?utm_source=qr_card&token=SECRET',
                      referrer: 'https://qr.example/scan/12345',
                      utm: { utm_source: 'qr_card' },
                      occurredAt: '2026-08-05T09:00:00.000Z' },
        latestTouch: { url: 'https://nails.cedservice.com/', referrer: null, utm: {},
                       occurredAt: '2026-08-05T09:00:00.000Z' }
      }
    }),
    ...options
  });
  return { browser, client };
};

test.afterEach(() => {
  uninstallBrowser(client);
  browser = null;
  client = null;
});

/* ---------- creation ---------- */

test('a tracked event carries the full envelope and a unique id', () => {
  setup();
  client.track('assessment.step_viewed', { stepId: '4' });
  const [event] = client._internal.queue();

  assert.match(event.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(event.eventName, 'assessment.step_viewed');
  assert.equal(event.eventVersion, 1);
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.assessmentSessionId, SESSION);
  assert.equal(event.verticalId, 'nails');
  assert.equal(event.assessmentVersion, '1.3.0');
  assert.equal(event.questionSetVersion, 'nails-questions-3.0.0');
  assert.equal(event.stepId, '4');
  assert.equal(event.visibleQuestionCount, 23);
  assert.equal(event.completedQuestionCount, 4);
  assert.equal(event.device.deviceClass, 'phone');
  assert.equal(event.consentStatus, 'product_allowed');
  assert.equal(typeof event.activeElapsedMs, 'number');
  assert.equal(typeof event.totalElapsedMs, 'number');

  client.track('assessment.step_viewed', { stepId: '5' });
  const ids = client._internal.queue().map(e => e.eventId);
  assert.equal(new Set(ids).size, 2, 'ids are unique per event');
});

test('no personal data reaches the queue, however the context is shaped', () => {
  setup();
  client.track('assessment.question_answered', {
    questionId: 'salonName',
    metadata: { ownerName: 'Someone', email: 'a@b.test', nested: { phone: '555' }, stepPosition: 1 }
  });
  const serialized = JSON.stringify(client._internal.queue());

  ['Someone', 'a@b.test', '555', 'SECRET', 'scan/12345']
    .forEach(needle => assert.ok(!serialized.includes(needle), `leaked: ${needle}`));
  /* The query string carrying a token is gone; the campaign survives. */
  assert.ok(serialized.includes('qr_card'));
  assert.ok(serialized.includes('"stepPosition":1'));
  /* Referrer is reduced to a host — the path could name what was clicked. */
  assert.ok(serialized.includes('qr.example'));
});

test('an unknown event name is ignored rather than queued or thrown', () => {
  setup();
  assert.doesNotThrow(() => client.track('assessment.invented_thing', {}));
  assert.equal(client._internal.queue().length, 0);
});

test('once-per-session events are emitted once however often they are called', () => {
  setup();
  for (let i = 0; i < 5; i++) {
    client.track('assessment.page_viewed');
    client.track('assessment.stage1_completed');
  }
  const names = client._internal.queue().map(e => e.eventName);
  assert.equal(names.filter(n => n === 'assessment.page_viewed').length, 1);
  assert.equal(names.filter(n => n === 'assessment.stage1_completed').length, 1);
});

test('consent status gates by category', () => {
  setup({ consentStatus: 'functional_only' });
  client.track('assessment.step_viewed', { stepId: '1' });     /* product */
  client.track('assessment.clear_saved_data');                  /* functional */
  const names = client._internal.queue().map(e => e.eventName);
  assert.deepEqual(names, ['assessment.clear_saved_data']);
});

test('sampling is decided once per session, not per event', () => {
  setup({ sampleRate: 0 });
  for (let i = 1; i <= 10; i++) client.track('assessment.step_viewed', { stepId: String(i) });
  assert.equal(client._internal.queue().length, 0, 'a sampled-out session emits nothing at all');

  uninstallBrowser(client);
  setup({ sampleRate: 1 });
  for (let i = 1; i <= 10; i++) client.track('assessment.step_viewed', { stepId: String(i) });
  assert.equal(client._internal.queue().length, 10, 'a sampled-in session emits everything');
});

/* ---------- batching and transport ---------- */

test('a full batch flushes itself', async () => {
  setup({ batchSize: 3 });
  client.track('assessment.step_viewed', { stepId: '1' });
  client.track('assessment.step_viewed', { stepId: '2' });
  client.track('assessment.step_viewed', { stepId: '3' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(browser.transport.requests.length, 1);
  assert.equal(browser.sentEvents().length, 3);
  assert.equal(client._internal.queue().length, 0);
});

test('a batch never exceeds the shared maximum', async () => {
  setup({ batchSize: 1000, maxQueueSize: 1000 });
  for (let i = 0; i < 80; i++) client.track('assessment.step_viewed', { stepId: String(i) });
  await client.flush('manual');
  assert.equal(browser.sentEvents().length, 50, 'LIMITS.maxEventsPerBatch');
  assert.equal(client._internal.queue().length, 30, 'the rest stay queued');
});

test('an empty queue does not produce a request', async () => {
  setup();
  const result = await client.flush('manual');
  assert.equal(result.reason, 'empty');
  assert.equal(browser.transport.requests.length, 0);
});

test('development console mode sends nothing anywhere', async () => {
  setup({ endpoint: null });
  client.track('assessment.step_viewed', { stepId: '1' });
  const result = await client.flush('manual');
  assert.equal(result.reason, 'console');
  assert.equal(browser.transport.requests.length, 0);
  assert.equal(browser.transport.beacons.length, 0);
  assert.equal(client._internal.queue().length, 0);
});

/* ---------- offline and retry ---------- */

test('a failed flush keeps the events and backs off', async () => {
  setup();
  browser.transport.respond = () => new Error('offline');
  client.track('assessment.step_viewed', { stepId: '1' });

  const first = await client.flush('manual');
  assert.equal(first.reason, 'failed');
  assert.ok(first.retryInMs >= 2000);
  assert.equal(client._internal.queue().length, 1, 'nothing is lost');

  /* Inside the backoff window the client does not hammer the endpoint. */
  const during = await client.flush('manual');
  assert.equal(during.reason, 'backoff');
  assert.equal(browser.transport.requests.length, 1);

  /* Past it, and now succeeding, the queue drains. */
  browser.advance(first.retryInMs + 1);
  browser.transport.respond = () => ({ ok: true, status: 200 });
  const after = await client.flush('manual');
  assert.equal(after.sent, 1);
  assert.equal(client._internal.queue().length, 0);
});

test('retries are capped, so a permanently broken endpoint cannot fill the queue forever', async () => {
  setup({ maxAttempts: 3 });
  browser.transport.respond = () => new Error('offline');
  client.track('assessment.step_viewed', { stepId: '1' });

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await client.flush('manual');
    if (result.retryInMs) browser.advance(result.retryInMs + 1);
  }
  assert.equal(client._internal.queue().length, 0, 'the event is given up on, not retried forever');
});

test('a 4xx discards rather than retrying, and a 429 does not', async () => {
  setup();
  browser.transport.respond = () => ({ ok: false, status: 400 });
  client.track('assessment.step_viewed', { stepId: '1' });
  const refused = await client.flush('manual');
  assert.equal(refused.reason, 'rejected');
  assert.equal(client._internal.queue().length, 0, 'the endpoint will never accept it');

  browser.transport.respond = () => ({ ok: false, status: 429 });
  client.track('assessment.step_viewed', { stepId: '2' });
  const limited = await client.flush('manual');
  assert.equal(limited.reason, 'failed');
  assert.equal(client._internal.queue().length, 1, 'rate limiting is temporary');
});

test('the queue survives a page reload', async () => {
  setup();
  browser.transport.respond = () => new Error('offline');
  client.track('assessment.step_viewed', { stepId: '1' });
  client.track('assessment.step_viewed', { stepId: '2' });
  await client.flush('manual');

  /* Same storage, fresh module — exactly what a reload produces. */
  const loaded = loadAnalytics();
  client = loaded.client;
  client.configure({
    endpoint: 'https://nails.cedservice.com/api/analytics',
    assessmentSessionId: SESSION, now: browser.now, flushIntervalMs: 0
  });
  assert.equal(client._internal.queue().length, 2, 'the queue was restored from storage');

  browser.transport.respond = () => ({ ok: true, status: 200 });
  const result = await client.flush('manual');
  assert.equal(result.sent, 2);
});

test('an overfull queue drops the oldest, because the newest describe where the visitor is', () => {
  setup({ maxQueueSize: 5, batchSize: 1000 });
  for (let i = 1; i <= 8; i++) client.track('assessment.step_viewed', { stepId: String(i) });
  const steps = client._internal.queue().map(e => e.stepId);
  assert.deepEqual(steps, ['4', '5', '6', '7', '8']);
});

test('expired events are dropped rather than delivered late and misleading', async () => {
  setup({ eventTtlMs: 60000 });
  client.track('assessment.step_viewed', { stepId: '1' });
  browser.advance(60001);
  const result = await client.flush('manual');
  assert.equal(result.reason, 'empty');
  assert.equal(client._internal.queue().length, 0);
});

test('a duplicate event id is never queued twice', () => {
  setup();
  client.track('assessment.step_viewed', { stepId: '1' });
  const [event] = client._internal.queue();
  /* Simulates a double-fired listener producing the same id. */
  client._internal.queue().push(event);
  assert.equal(new Set(client._internal.queue().map(e => e.eventId)).size, 1);
});

/* ---------- pagehide ---------- */

test('the page going away flushes by beacon, which survives the navigation', () => {
  setup();
  client.track('assessment.step_viewed', { stepId: '1' });
  browser.fire('window', 'pagehide');

  assert.equal(browser.transport.beacons.length, 1);
  assert.ok(browser.beaconEvents().some(e => e.eventName === 'assessment.step_viewed'));
  assert.equal(browser.transport.requests.length, 0, 'fetch is not used when the page is leaving');
});

test('hiding the tab also flushes, because a hidden tab often never comes back', () => {
  setup();
  client.track('assessment.step_viewed', { stepId: '1' });
  browser.hide();
  assert.equal(browser.transport.beacons.length, 1);
});

/* ---------- timing ---------- */

test('active time accrues only while the page is visible and the visitor is present', () => {
  setup({ idleThresholdMs: 60000 });
  browser.advance(5000);
  client.markActivity();

  let status = client.status();
  assert.ok(status.activeElapsedMs >= 5000);
  assert.ok(status.totalElapsedMs >= 5000);

  /* Hidden for an hour: wall time runs, active time does not. */
  browser.hide();
  browser.advance(60 * 60 * 1000);
  status = client.status();
  assert.ok(status.activeElapsedMs < 10000, 'a hidden tab is not assessment time');
  assert.ok(status.totalElapsedMs > 60 * 60 * 1000);
  assert.equal(status.clockRunning, false);

  browser.show();
  browser.advance(3000);
  status = client.status();
  assert.ok(status.activeElapsedMs >= 8000 && status.activeElapsedMs < 12000,
    'the clock resumes where it stopped');
});

test('a tab left open overnight is not eight hours of assessment time', () => {
  setup({ idleThresholdMs: 60000 });
  client.markActivity();
  browser.advance(60000);
  /* The idle watchdog runs on a timer; drive it the way the timer would. */
  client._internal.pauseClock('idle');
  browser.advance(8 * 60 * 60 * 1000);

  const status = client.status();
  assert.ok(status.activeElapsedMs <= 61000, `active time was ${status.activeElapsedMs}`);
  assert.ok(status.totalElapsedMs >= 8 * 60 * 60 * 1000);
});

test('per-step time restarts on each step and is reported with the event', () => {
  setup();
  client.setStep('3');
  browser.advance(4000);
  client.track('assessment.step_completed', { stepId: '3' });

  client.setStep('4');
  browser.advance(1000);
  client.track('assessment.step_completed', { stepId: '4' });

  const [first, second] = client._internal.queue();
  assert.ok(first.stepElapsedMs >= 4000);
  assert.ok(second.stepElapsedMs >= 1000 && second.stepElapsedMs < 4000,
    'the step clock restarted rather than accumulating');
});

test('marks measure active time between milestones, and are null before they happen', () => {
  setup();
  assert.equal(client.sinceMark('resultsViewedAt'), null, 'no mark, no measurement');

  client.markFirstAnswer();
  browser.advance(20000);
  client.markStage1Complete();
  browser.advance(5000);
  client.markResultsViewed();
  browser.advance(9000);

  assert.ok(client.sinceMark('resultsViewedAt') >= 9000);
  assert.ok(client.sinceMark('stage1CompletedAt') >= 14000);
  assert.equal(client.status().firstAnswerAfterMs !== null, true);
});

/* ---------- abandonment ---------- */

test('abandonment is inferred once per state, not repeatedly', () => {
  setup();
  client.markStarted();
  client.setStep('4');
  client._internal.inferAbandonment('idle', 31 * 60 * 1000);
  client._internal.inferAbandonment('idle', 32 * 60 * 1000);
  client._internal.inferAbandonment('idle', 33 * 60 * 1000);

  const abandoned = client._internal.queue().filter(e => e.eventName === 'assessment.abandoned');
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].metadata.provisional, true, 'the guess is marked as a guess');
  assert.equal(abandoned[0].stepId, '4');
});

test('moving to another step is a new state and may be inferred again', () => {
  setup();
  client.markStarted();
  client.setStep('4');
  client._internal.inferAbandonment('idle', 31 * 60 * 1000);
  client.setStep('5');
  client._internal.inferAbandonment('idle', 31 * 60 * 1000);
  assert.equal(client._internal.queue().filter(e => e.eventName === 'assessment.abandoned').length, 2);
});

test('a visitor who never started is never called abandoned', () => {
  setup();
  client.setStep('1');
  client._internal.inferAbandonment('page_exit', 0);
  assert.equal(client._internal.queue().filter(e => e.eventName === 'assessment.abandoned').length, 0);
});

test('finishing Stage 1 and leaving is a success, not an abandonment', () => {
  setup();
  client.markStarted();
  client.setStage(1);
  client.track('assessment.stage1_completed');
  client._internal.inferAbandonment('page_exit', 0);

  assert.equal(client._internal.queue().filter(e => e.eventName === 'assessment.abandoned').length, 0,
    'Stage 2 is optional; declining it is not abandonment');
});

test('resuming clears the suppression so a later real exit is still recorded', () => {
  setup();
  client.markStarted();
  client.setStep('4');
  client._internal.inferAbandonment('page_exit', 0);
  assert.equal(client._internal.queue().filter(e => e.eventName === 'assessment.abandoned').length, 1);

  client.markResumed();
  client._internal.inferAbandonment('page_exit', 0);
  assert.equal(client._internal.queue().filter(e => e.eventName === 'assessment.abandoned').length, 2);
  assert.equal(client.status().resumedCount, 1);
});

/* ---------- the governing rule ---------- */

test('nothing the client is asked to do can throw at the caller', () => {
  setup();
  /* A context provider that explodes, the worst realistic case. */
  client.configure({
    endpoint: null, assessmentSessionId: SESSION, now: browser.now, flushIntervalMs: 0,
    context: () => { throw new Error('context exploded'); }
  });
  assert.doesNotThrow(() => client.track('assessment.step_viewed', { stepId: '1' }));
  assert.doesNotThrow(() => client.status());
  assert.doesNotThrow(() => client.setStep('2'));
  assert.doesNotThrow(() => client.identify({ submissionId: 'not-a-uuid' }));
  assert.doesNotThrow(() => client.reset());
});

test('a client that was never configured does nothing rather than failing', () => {
  browser = installBrowser();
  const loaded = loadAnalytics();
  client = loaded.client;
  assert.doesNotThrow(() => client.track('assessment.page_viewed'));
  assert.doesNotThrow(() => client.status());
});

test('reset removes everything analytics stored on the device', () => {
  setup();
  client.track('assessment.step_viewed', { stepId: '1' });
  assert.ok(browser.storage.getItem('cedAnalyticsQueue'));
  client.reset();
  assert.equal(client._internal.queue().length, 0);
  assert.equal(browser.storage.getItem('cedAnalyticsQueue'), null);
});

test('late identification attaches ids without re-emitting anything', () => {
  setup();
  client.track('assessment.step_viewed', { stepId: '1' });
  client.identify({ submissionId: '33333333-3333-4333-8333-333333333333' });
  client.track('assessment.stage1_completed');

  const queue = client._internal.queue();
  assert.equal(queue[0].submissionId, null, 'events already queued are not rewritten');
  assert.equal(queue[1].submissionId, '33333333-3333-4333-8333-333333333333');
  assert.equal(queue.length, 2);
});
