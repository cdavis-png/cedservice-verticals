/* ============================================================
   SM-1 — the instrumentation is real, and the envelopes are clean
   ------------------------------------------------------------
   Not "the page marks a control" but "the transport built this
   event, and here is the complete envelope it built".

   These drive the REAL analytics client rather than a recorder,
   because `buildEvent` is what decides whether an envelope
   carries a Business Record identifier — a stub that just
   collects calls could never catch one.

   Defects 2, 7 and 8 from the independent audit.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import events from '../shared/analytics/events.js';
import bir from '../shared/service-mix-engine/generate-service-mix-bir.js';

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
let submitted;

const installBrowser = ({ keepStorage = false } = {}) => {
  if (!keepStorage) storage = makeStorage();
  submitted = [];

  const win = {
    location: { href: 'https://nails.test/service-mix', search: '', protocol: 'https:' },
    /* The analytics client mints its own event ids from window.crypto. Without
       it every event is dropped for having no id, which is the correct
       behaviour and a silent one — so the stub must provide it. */
    crypto: webcrypto,
    innerWidth: 360, innerHeight: 740,
    CEDServiceMixValue: require('../shared/service-mix-engine/value.schema.js'),
    CEDServiceMixOffering: require('../shared/service-mix-engine/offering.schema.js'),
    CEDServiceMixCalculate: require('../shared/service-mix-engine/calculate.js'),
    CEDServiceMixClassify: require('../shared/service-mix-engine/classify.js'),
    CEDServiceMixGuidance: require('../shared/service-mix-engine/guidance.js'),
    CEDAnalyticsEvents: require('../shared/analytics/events.js'),
    CEDContinuation: require('../shared/security/continuation.js'),
    CEDSubmission: {
      submitAssessment: async (payload, options) => {
        /* The resolver is recorded as RESOLVED here, at the moment of the
           send, because that is the only moment its answer is meaningful:
           the controller stores a refreshed context immediately afterwards. */
        submitted.push({ payload, options,
          sentContinuation: typeof options.continuationToken === 'function'
            ? options.continuationToken() : (options.continuationToken || null) });
        /* Exactly what api/assessments.mjs returns for a Service Mix review:
           no businessId, no birId. */
        return { status: 'sent', ok: true, replayed: false,
                 submissionId: payload.submissionId,
                 reviewType: 'service_mix', identityResolved: true,
                 continuationToken: 'server.issued.token' };
      },
      clearQueue: () => true
    }
  };

  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: { referrer: '' }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: { sendBeacon: () => true }, configurable: true, writable: true });

  delete require.cache[require.resolve('../shared/service-mix-engine/controller.js')];
  return require('../shared/service-mix-engine/controller.js');
};

const teardown = () => {
  ['window', 'localStorage', 'document', 'navigator'].forEach(name => {
    Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
  });
};

const CONFIG = {
  storageKey: 'test:serviceMixInstrumentation',
  meta: { verticalId: 'nails', verticalName: 'Nail Salons', assessmentVersion: '1.0.0' },
  submission: { endpoint: '/api/assessments' },
  disclaimer: () => bir.SERVICE_MIX_DISCLAIMER,
  honeypotValue: () => ''
};

const addComplete = (controller, { name, price, duration, volume }) => {
  const offering = controller.addOffering({ name, category: 'core_service', source: 'starter' });
  controller.setMeasure(offering.offeringId, 'sellingPrice', 'exact', { value: price });
  controller.setMeasure(offering.offeringId, 'durationMinutes', 'exact', { value: duration });
  controller.setMeasure(offering.offeringId, 'monthlyVolume', 'exact', { value: volume });
  return offering;
};

/* Drives a whole review through the controller's own instrumentation, the
   way the page does, and returns every envelope the real client built. */
const instrumentedRun = async ({ withContext = false } = {}) => {
  const api = installBrowser();
  const continuation = require('../shared/security/continuation.js');
  if (withContext) continuation.storeContinuation({ token: '1.from.growth' });

  delete require.cache[require.resolve('../shared/analytics/analytics-client.js')];
  const client = require('../shared/analytics/analytics-client.js');
  window.CEDAnalytics = client;

  const controller = api.init(CONFIG);
  client.configure({
    endpoint: null, verticalId: 'nails', reviewType: 'service_mix',
    assessmentSessionId: controller.state().assessmentSessionId,
    /* The client auto-flushes once the queue reaches batchSize (12 by
       default), and a review emits more than that. Flushing empties the
       queue, so a test that inspects it afterwards would see only the tail.
       Raised here so the whole run is inspectable; the batching itself is
       covered by tests/analytics-client.test.mjs. */
    batchSize: 500, flushIntervalMs: 3600000
  });

  /* The controller emitted review_viewed during init, before the client was
     configured, so the sequence is replayed here the way the page runs it. */
  controller.track('service_mix.review_viewed', {
    metadata: { trigger: controller.entryTrigger() }
  });
  controller.start();
  controller.viewStep('offerings');

  const doomed = addComplete(controller, { name: 'Gel manicure', price: 65, duration: 60, volume: 80 });
  addComplete(controller, { name: 'Pedicure', price: 45, duration: 45, volume: 30 });
  controller.removeOffering(doomed.offeringId);
  addComplete(controller, { name: 'Nail art', price: 25, duration: 45, volume: 40 });

  controller.completeStep('offerings');
  controller.failValidation('figures');
  controller.setCoverage('all_offerings');
  controller.completeStep('figures');
  controller.setContact({
    salonName: 'Polished Test Salon', ownerName: 'Owner', email: 'owner@polished.test' });
  controller.setConsent({
    resultsDeliveryConsent: { granted: true, statement: 'x', recordedAt: 'now' } });

  await controller.submit();
  controller.viewResults();
  controller.trackIntent('service_mix.pricing_detail_requested');
  controller.trackIntent('service_mix.growth_review_clicked');
  controller.trackIntent('service_mix.ai_analysis_clicked');
  /* service_mix.bundle_recommendation_viewed is deliberately NOT emitted —
     see the test below. The Quick Review recommends no bundles. */

  const envelopes = client._internal.queue();
  client._internal.teardown();
  return { envelopes, controller };
};

/* ============================================================
   D7 — every named measurement is actually emitted
   ============================================================ */

test('every measurement the milestone names reaches the transport', async t => {
  t.after(teardown);
  const { envelopes } = await instrumentedRun();
  const names = envelopes.map(e => e.eventName);

  [
    'service_mix.review_viewed',
    'service_mix.review_started',
    'assessment.step_viewed',
    'assessment.step_completed',
    'assessment.validation_failed',
    'service_mix.offering_added',
    'service_mix.offering_removed',
    'service_mix.stage1_completed',
    'service_mix.results_viewed',
    'service_mix.pricing_detail_requested',
    'service_mix.growth_review_clicked',
    'service_mix.ai_analysis_clicked'
  ].forEach(name => assert.ok(names.includes(name), `${name} was never emitted`));
});

/* A catalog is a list of events that MAY be emitted, not a checklist a
   session has to complete. The earlier version of the test above required
   every Service Mix event to appear in one run, which is why the page ended
   up firing bundle_recommendation_viewed from a button that recommends
   nothing: the honest behaviour would have failed the test.

   So the rule is stated the other way round. */
test('the Quick Review never reports a bundle recommendation it did not make', async t => {
  t.after(teardown);
  const { envelopes } = await instrumentedRun();

  assert.equal(envelopes.some(e => e.eventName === 'service_mix.bundle_recommendation_viewed'),
    false,
    'SM-1 recommends no bundles, so no session may report one as viewed');

  /* The event is not deleted. It describes something the Detailed Review
     will genuinely do, and an analytics event name is a shared contract:
     renaming or reusing one orphans history rather than migrating it. */
  assert.ok(events.EVENTS['service_mix.bundle_recommendation_viewed'],
    'kept in the catalog for the feature that will actually emit it');
});

test('drop-off is measurable: an abandonment event is emitted and marked a guess', async t => {
  t.after(teardown);
  const api = installBrowser();

  delete require.cache[require.resolve('../shared/analytics/analytics-client.js')];
  const client = require('../shared/analytics/analytics-client.js');
  window.CEDAnalytics = client;

  const controller = api.init(CONFIG);
  client.configure({
    endpoint: null, verticalId: 'nails', reviewType: 'service_mix',
    abandonThresholdMs: 0, batchSize: 500, flushIntervalMs: 3600000,
    assessmentSessionId: controller.state().assessmentSessionId
  });
  controller.start();
  addComplete(controller, { name: 'Gel manicure', price: 65, duration: 60, volume: 80 });
  client._internal.inferAbandonment();

  const abandoned = client._internal.queue().find(e => e.eventName === 'assessment.abandoned');
  client._internal.teardown();

  assert.ok(abandoned, 'drop-off must be measurable, not merely declared');
  assert.equal(abandoned.reviewType, 'service_mix');
  assert.equal(abandoned.businessId, null);
  assert.equal(abandoned.metadata.provisional, true, 'it is a guess, recorded as one');
});

test('a connected entry is recorded as connected, not as standalone', async t => {
  t.after(teardown);
  const { envelopes } = await instrumentedRun({ withContext: true });

  const viewed = envelopes.find(e => e.eventName === 'service_mix.review_viewed');
  assert.equal(viewed.metadata.trigger, 'after_growth_review',
    'the context is resolved BEFORE the first event; reading it afterwards ' +
    'would file every connected visit as standalone');

  const started = envelopes.find(e => e.eventName === 'service_mix.review_started');
  assert.equal(started.metadata.trigger, 'after_growth_review');
});

test('a cold entry is recorded as standalone', async t => {
  t.after(teardown);
  const { envelopes } = await instrumentedRun({ withContext: false });
  assert.equal(
    envelopes.find(e => e.eventName === 'service_mix.review_viewed').metadata.trigger,
    'standalone');
});

/* ============================================================
   D2 — the complete envelope carries nothing it may not
   ============================================================ */

test('the complete envelope of every event is clean, not merely its metadata', async t => {
  t.after(teardown);
  const { envelopes } = await instrumentedRun({ withContext: true });
  assert.ok(envelopes.length >= 12, 'there must be envelopes to inspect');

  envelopes.forEach(envelope => {
    assert.equal(envelope.reviewType, 'service_mix');
    assert.equal(envelope.businessId, null,
      `${envelope.eventName} carried a Business Record identifier`);

    /* Every key, at every depth, against the shared prohibition. */
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;
      Object.keys(node).forEach(key => {
        assert.equal(events.isProhibitedFieldName(key), false,
          `${envelope.eventName} carried a prohibited field at ${path}${key}`);
        walk(node[key], `${path}${key}.`);
      });
    };
    walk(envelope.metadata, `${envelope.eventName}.metadata.`);
    walk(envelope.attribution, `${envelope.eventName}.attribution.`);
    walk(envelope.device, `${envelope.eventName}.device.`);

    /* And nothing recognisable by VALUE, anywhere in the envelope. */
    const text = JSON.stringify(envelope);
    [
      '1.from.growth',                    /* the continuation context */
      'server.issued.token',
      'Gel manicure', 'Pedicure', 'Nail art',
      'Polished Test Salon', 'owner@polished.test',
      'sellingPrice', 'monthlyVolume', 'durationMinutes'
    ].forEach(needle => assert.equal(text.includes(needle), false,
      `${envelope.eventName} carried "${needle}"`));

    /* A stable offering id would be a join key between a funnel and a
       Business Record. Metadata carries a band and a source instead. */
    assert.equal(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}/.test(JSON.stringify(envelope.metadata || {})),
      false, `${envelope.eventName} metadata carried something shaped like an id`);
  });
});

test('every emitted envelope passes the validator the endpoint applies', async t => {
  t.after(teardown);
  const { envelopes } = await instrumentedRun({ withContext: true });
  envelopes.forEach(envelope => {
    const result = events.validateEvent(envelope);
    assert.deepEqual(result.errors, [],
      `${envelope.eventName}: ${JSON.stringify(result.errors)}`);
  });
});

test('an offering event carries a band and a source, never a count, id, or name', async t => {
  t.after(teardown);
  const { envelopes } = await instrumentedRun();

  const added = envelopes.filter(e => e.eventName === 'service_mix.offering_added');
  const removed = envelopes.find(e => e.eventName === 'service_mix.offering_removed');

  assert.ok(added.length >= 2);
  [...added, removed].forEach(e => {
    assert.ok(['starter', 'custom'].includes(e.metadata.offeringSource));
    assert.ok(events.OFFERING_COUNT_BANDS.includes(e.metadata.offeringCountBand));
    assert.equal('offeringId' in e.metadata, false);
    assert.equal('offeringName' in e.metadata, false);
    assert.equal('offeringCount' in e.metadata, false);
  });
});

test('the submission id is the only identifier later events carry', async t => {
  t.after(teardown);
  const { envelopes } = await instrumentedRun();

  const afterSubmit = envelopes.filter(e => e.eventName === 'service_mix.results_viewed');
  assert.ok(afterSubmit.length >= 1);
  afterSubmit.forEach(e => {
    assert.equal(e.businessId, null);
    assert.ok(e.submissionId, 'the visitor’s own idempotency key is fine; a record id is not');
  });
});

/* ============================================================
   D8 — submission behaviour
   ============================================================ */

const complete = controller => {
  addComplete(controller, { name: 'Gel manicure', price: 65, duration: 60, volume: 80 });
  addComplete(controller, { name: 'Acrylic full set', price: 90, duration: 150, volume: 30 });
  addComplete(controller, { name: 'Nail art', price: 25, duration: 45, volume: 40 });
  controller.setCoverage('all_offerings');
  controller.setContact({
    salonName: 'Polished Test Salon', ownerName: 'Owner', email: 'owner@polished.test' });
  controller.setConsent({
    resultsDeliveryConsent: { granted: true, statement: 'x', recordedAt: 'now' } });
};

test('a double submission is refused by the in-flight guard', async t => {
  const api = installBrowser();
  t.after(teardown);

  /* A transport that does not settle until told, so both calls are genuinely
     in flight at once — which a sequential await could never reproduce. */
  let release;
  const held = new Promise(resolve => { release = resolve; });
  window.CEDSubmission.submitAssessment = async payload => {
    submitted.push({ payload, options: {} });
    await held;
    return { status: 'sent', submissionId: payload.submissionId };
  };

  const controller = api.init(CONFIG);
  complete(controller);

  const first = controller.submit();
  const second = await controller.submit();
  assert.equal(second.status, 'in_flight', 'the second click is refused, not queued');

  release();
  assert.equal((await first).status, 'sent');
  assert.equal(submitted.length, 1, 'one click, one submission');
});

test('an unchanged resubmission reuses the id and is not counted as a second completion', async t => {
  const api = installBrowser();
  t.after(teardown);

  delete require.cache[require.resolve('../shared/analytics/analytics-client.js')];
  const client = require('../shared/analytics/analytics-client.js');
  window.CEDAnalytics = client;

  const controller = api.init(CONFIG);
  client.configure({ endpoint: null, verticalId: 'nails', reviewType: 'service_mix',
                     batchSize: 500, flushIntervalMs: 3600000,
                     assessmentSessionId: controller.state().assessmentSessionId });
  complete(controller);

  await controller.submit();
  const second = await controller.submit();

  assert.equal(second.submissionReused, true);
  assert.equal(submitted[1].payload.submissionId, submitted[0].payload.submissionId,
    'one completed result keeps one idempotency key, which is what makes retry safe');

  const completions = client._internal.queue()
    .filter(e => e.eventName === 'service_mix.stage1_completed');
  client._internal.teardown();
  assert.equal(completions.length, 1,
    'measuring an unchanged resubmission twice would inflate the completion rate');
});

test('a materially changed resubmission mints a new submission id', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  complete(controller);
  await controller.submit();

  controller.setCoverage('most_revenue');
  const changed = await controller.submit();

  assert.equal(changed.submissionReused, false);
  assert.notEqual(submitted[1].payload.submissionId, submitted[0].payload.submissionId,
    'changing an answer and re-finishing is a new result');
});

test('a reload does not change the id of an unchanged result', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  complete(controller);
  await controller.submit();
  const original = submitted[0].payload.submissionId;

  /* Same storage, fresh controller — a reload. */
  const api2 = installBrowser({ keepStorage: true });
  const resumed = api2.init(CONFIG);
  const again = await resumed.submit();

  assert.equal(again.submissionReused, true);
  assert.equal(submitted[submitted.length - 1].payload.submissionId, original,
    'a retry after a reload is the same result, not a second one');
});

test('a fresh snapshot id per submission is not by itself a material change', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  complete(controller);
  await controller.submit();
  await controller.submit();

  const a = submitted[0].payload.serviceMix.offerings;
  const b = submitted[1].payload.serviceMix.offerings;
  a.forEach((offering, i) => {
    assert.equal(offering.offeringId, b[i].offeringId);
    assert.notEqual(offering.offeringSnapshotId, b[i].offeringSnapshotId,
      'every submitted version gets its own snapshot');
  });
  assert.equal(submitted[1].payload.submissionId, submitted[0].payload.submissionId,
    'and the snapshot ids changing is not a material change');
});

test('the context is passed to the transport, never placed in the payload', async t => {
  const api = installBrowser();
  t.after(teardown);

  const continuation = require('../shared/security/continuation.js');
  continuation.storeContinuation({ token: '1.opaque.growth.token' });

  const controller = api.init(CONFIG);
  complete(controller);
  await controller.submit();

  /* Passed as a RESOLVER, not a captured value: the transport calls it when
     the request is actually made, so a retry hours later reads the context
     that is current then rather than one that expired while queued. */
  assert.equal(typeof submitted[0].options.continuationToken, 'function');
  assert.equal(submitted[0].sentContinuation, '1.opaque.growth.token',
    'the transport turns this into the X-CED-Continuation header');

  const text = JSON.stringify(submitted[0].payload);
  assert.equal(text.includes('1.opaque.growth.token'), false);
  assert.equal(text.includes('continuationToken'), false);
  assert.equal(submitted[0].payload.continuation, undefined);
});
