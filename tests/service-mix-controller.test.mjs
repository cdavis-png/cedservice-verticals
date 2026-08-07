/* ============================================================
   SM-1 — the browser controller, end to end
   ------------------------------------------------------------
   Proves a visitor can actually complete the review: add
   offerings, enter figures, declare coverage, save, resume, and
   submit — with the payload the endpoint expects.

   Runs against a minimal browser stub rather than a DOM: the
   controller owns state and transport, and the page owns
   rendering. What renders is checked statically in
   service-mix-page.test.mjs and by hand.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import offerings from '../shared/service-mix-engine/offering.schema.js';
import values from '../shared/service-mix-engine/value.schema.js';
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
let tracked;

const installBrowser = ({ keepStorage = false } = {}) => {
  if (!keepStorage) storage = makeStorage();
  submitted = [];
  tracked = [];

  const win = {
    location: { href: 'https://nails.test/service-mix?utm_source=qr', search: '?utm_source=qr',
                protocol: 'https:' },
    CEDServiceMixValue: require('../shared/service-mix-engine/value.schema.js'),
    CEDServiceMixOffering: require('../shared/service-mix-engine/offering.schema.js'),
    CEDServiceMixCalculate: require('../shared/service-mix-engine/calculate.js'),
    CEDServiceMixClassify: require('../shared/service-mix-engine/classify.js'),
    CEDServiceMixGuidance: require('../shared/service-mix-engine/guidance.js'),
    CEDAnalyticsEvents: require('../shared/analytics/events.js'),
    /* The shared continuation store. The page loads it; so must the harness,
       or the controller has nowhere to read or leave a context. */
    CEDContinuation: require('../shared/security/continuation.js'),
    /* A client that records rather than sends. */
    CEDAnalytics: {
      configure: () => {}, setSession: () => {}, identify: () => {},
      setStep: () => {}, markStarted: () => {}, markResumed: () => {}, flush: () => {},
      track: (name, fields) => tracked.push({ name, fields })
    },
    CEDSubmission: {
      submitAssessment: async (payload, options) => {
        /* The resolver is recorded as RESOLVED here, at the moment of the
           send, because that is the only moment its answer is meaningful:
           the controller stores a refreshed context immediately afterwards. */
        submitted.push({ payload, options,
          sentContinuation: typeof options.continuationToken === 'function'
            ? options.continuationToken() : (options.continuationToken || null) });
        /* Exactly what api/assessments.mjs returns for a Service Mix
           review: no businessId, no birId — an opaque context and the
           client's own submission id. A stub that handed back a businessId
           could not catch a controller that read one. */
        return { status: 'sent', ok: true, replayed: false,
                 submissionId: payload.submissionId,
                 assessmentSessionId: payload.assessmentSessionId,
                 reviewType: 'service_mix', identityResolved: true,
                 continuationToken: 'server.issued.token' };
      },
      clearQueue: () => true
    }
  };

  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: { referrer: '' }, configurable: true, writable: true });

  /* The controller is a classic script with the repository's dual export. In
     Node it hands back module.exports; in a browser it assigns to window.
     Re-required each time so it re-reads the stubbed globals. */
  delete require.cache[require.resolve('../shared/service-mix-engine/controller.js')];
  return require('../shared/service-mix-engine/controller.js');
};

const teardown = () => {
  ['window', 'localStorage', 'document'].forEach(name => {
    Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
  });
};

const CONFIG = {
  storageKey: 'test:serviceMix',
  meta: { verticalId: 'nails', verticalName: 'Nail Salons', assessmentVersion: '1.0.0' },
  submission: { endpoint: '/api/assessments' },
  disclaimer: () => bir.SERVICE_MIX_DISCLAIMER,
  honeypotValue: () => ''
};

/* Adds a complete offering and returns it. */
const addComplete = (controller, { name, price, duration, volume, demand = 'steady' }) => {
  const offering = controller.addOffering({ name, category: 'core_service', source: 'starter' });
  controller.setMeasure(offering.offeringId, 'sellingPrice', 'exact', { value: price });
  controller.setMeasure(offering.offeringId, 'durationMinutes', 'exact', { value: duration });
  controller.setMeasure(offering.offeringId, 'monthlyVolume', 'exact', { value: volume });
  controller.setField(offering.offeringId, 'demand', demand);
  return offering;
};

const complete = controller => {
  addComplete(controller, { name: 'Gel manicure', price: 65, duration: 60, volume: 80, demand: 'strong' });
  addComplete(controller, { name: 'Acrylic full set', price: 90, duration: 150, volume: 30 });
  addComplete(controller, { name: 'Nail art', price: 25, duration: 45, volume: 40, demand: 'weak' });
  controller.setCoverage('all_offerings');
  controller.setContact({ salonName: 'Polished Test Salon', ownerName: 'Owner', email: 'owner@polished.test' });
  controller.setConsent({
    resultsDeliveryConsent: { granted: true, statement: 'Send my review to CED Solutions so my results can be shown to me.',
                              recordedAt: '2026-08-05T12:00:00.000Z' }
  });
};

/* ---------- a whole review ---------- */

test('a visitor can complete the review and the payload is valid', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  assert.ok(controller, 'the controller initialises with the engine loaded');
  controller.start();
  complete(controller);

  const check = controller.validate();
  assert.deepEqual(check.errors, []);
  assert.equal(check.valid, true);

  const outcome = await controller.submit();
  assert.equal(outcome.status, 'sent');
  assert.equal(submitted.length, 1);

  const payload = submitted[0].payload;
  assert.equal(payload.schemaVersion, 6);
  assert.equal(payload.reviewType, 'service_mix');
  assert.equal(payload.serviceMix.offerings.length, 3);
  assert.equal(payload.serviceMix.coverage, 'all_offerings');
  assert.ok(offerings.isUuid(payload.submissionId));
  assert.ok(offerings.isUuid(payload.assessmentSessionId));
  assert.equal(payload.results.disclaimer, bir.SERVICE_MIX_DISCLAIMER,
    'the figure never travels without its context');

  /* And the server can generate a valid report from exactly that payload. */
  const report = bir.generateServiceMixBir({
    submission: payload, birId: randomUUID(), generatedAt: '2026-08-05T12:00:01.000Z'
  });
  assert.equal(bir.validateServiceMixBir(report).valid, true);
  assert.equal(report.serviceMixHealth.classification, 'generally_healthy_with_opportunities');
});

test('the review refuses to submit with fewer than two offerings', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  addComplete(controller, { name: 'Only one', price: 40, duration: 30, volume: 10 });
  controller.setCoverage('all_offerings');

  const outcome = await controller.submit();
  assert.equal(outcome.status, 'invalid');
  assert.ok(outcome.errors.some(e => e.code === 'too_few_offerings'));
  assert.equal(submitted.length, 0, 'nothing is sent');
});

test('a sixth offering cannot be added at all', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  for (let i = 0; i < 5; i++) addComplete(controller, { name: `S${i}`, price: 40, duration: 30, volume: 10 });
  assert.equal(controller.canAdd(), false);
  assert.equal(controller.addOffering({ name: 'One too many' }), null);
  assert.equal(controller.offerings().length, 5);
});

test('the last two offerings cannot be removed', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  const a = addComplete(controller, { name: 'A', price: 40, duration: 30, volume: 10 });
  addComplete(controller, { name: 'B', price: 40, duration: 30, volume: 10 });
  assert.equal(controller.canRemove(), false);
  /* removeOffering still works when the page asks — canRemove is what the UI
     disables on. The floor is enforced at validation and at the endpoint. */
  assert.equal(controller.removeOffering(a.offeringId), true);
  assert.equal(controller.validate().valid, false);
});

/* ---------- identity across the review ---------- */

test('renaming keeps the offeringId; replacing mints a new one', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  const original = addComplete(controller, { name: 'Acrylic fill', price: 55, duration: 60, volume: 25 });
  addComplete(controller, { name: 'Pedicure', price: 45, duration: 45, volume: 30 });

  controller.renameOffering(original.offeringId, 'Structured fill');
  assert.equal(controller.offerings()[0].offeringId, original.offeringId);
  assert.equal(controller.offerings()[0].name, 'Structured fill');

  const replacement = controller.replaceOffering(original.offeringId, { name: 'Structured gel' });
  assert.notEqual(replacement.offeringId, original.offeringId);
  assert.equal(replacement.replacesOfferingId, original.offeringId);
});

test('an offering removed before submission leaves no permanent history', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  const doomed = addComplete(controller, { name: 'Never submitted', price: 30, duration: 30, volume: 5 });
  complete(controller);
  controller.removeOffering(doomed.offeringId);

  await controller.submit();
  const payload = submitted[0].payload;
  assert.equal(payload.serviceMix.offerings.some(o => o.offeringId === doomed.offeringId), false,
    'an offering added and deleted in one sitting never happened');

  /* Analytics saw a removal happened — a fact about the form, not the business. */
  const removal = tracked.find(t => t.name === 'service_mix.offering_removed');
  assert.ok(removal);
  assert.equal(removal.fields.metadata.offeringSource, 'starter');
  assert.equal('offeringId' in removal.fields.metadata, false);
});

test('every submission mints a new snapshot id for the same offering', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  complete(controller);

  const first = controller.buildPayload().serviceMix.offerings;
  const second = controller.buildPayload().serviceMix.offerings;
  first.forEach((offering, i) => {
    assert.equal(offering.offeringId, second[i].offeringId);
    assert.notEqual(offering.offeringSnapshotId, second[i].offeringSnapshotId);
  });
});

test('prior offerings are presented for confirmation, never silently matched', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  const prior = [
    { offeringId: randomUUID(), offeringSnapshotId: randomUUID(), replacesOfferingId: null,
      name: 'Gel manicure', category: 'core_service', source: 'starter',
      sellingPrice: values.measured('exact', { value: 60 }),
      durationMinutes: values.measured('exact', { value: 60 }),
      monthlyVolume: values.measured('exact', { value: 70 }),
      demand: 'strong', role: 'primary_revenue' }
  ];

  const offered = controller.offerPriorOfferings(prior);
  assert.equal(offered.length, 1);
  assert.equal(controller.offerings().length, 0,
    'nothing is applied until the owner acts on it');

  const confirmed = offered[0].confirm();
  assert.equal(confirmed.offeringId, prior[0].offeringId, 'confirming keeps the identity');
  assert.equal(confirmed.offeringSnapshotId, null, 'a new snapshot is minted at submission');
});

/* ---------- save and resume ---------- */

test('a review survives a page reload and is reported as resumed', async t => {
  const api = installBrowser();
  t.after(teardown);

  const first = api.init(CONFIG);
  assert.equal(first.resumed(), false);
  first.start();
  complete(first);
  const sessionId = first.state().assessmentSessionId;
  const names = first.offerings().map(o => o.name);

  /* Same storage, fresh controller — a reload. */
  const api2 = installBrowser({ keepStorage: true });
  const second = api2.init(CONFIG);
  assert.equal(second.resumed(), true);
  assert.equal(second.state().assessmentSessionId, sessionId,
    'the session id survives, so first-touch attribution is not rewritten');
  assert.deepEqual(second.offerings().map(o => o.name), names);
  assert.equal(second.state().coverage, 'all_offerings');
});

test('first-touch attribution is captured once and never rewritten', async t => {
  const api = installBrowser();
  t.after(teardown);

  const first = api.init(CONFIG);
  const firstTouch = first.state().firstTouch;
  assert.equal(firstTouch.utm.utm_source, 'qr');

  const api2 = installBrowser({ keepStorage: true });
  api2.init({ ...CONFIG });
  const resumed = api2.init(CONFIG);
  assert.deepEqual(resumed.state().firstTouch, firstTouch,
    'a QR card must still get credit weeks later');
});

test('clearing removes everything the review stored on the device', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  complete(controller);
  assert.ok(storage.getItem(CONFIG.storageKey));

  controller.clearSavedData();
  assert.equal(storage.getItem(CONFIG.storageKey), null);
  assert.ok(tracked.some(t => t.name === 'assessment.clear_saved_data'));
});

/* ---------- the continuation context ---------- */

test('a context is read from the shared store and sent as a header, never in the payload', async t => {
  const api = installBrowser();
  t.after(teardown);

  const continuation = require('../shared/security/continuation.js');
  continuation.storeContinuation({ token: '1.opaque.growth.token' });

  const controller = api.init(CONFIG);
  complete(controller);
  await controller.submit();

  /* Transmitted — as a transport option, which submission.js turns into the
     X-CED-Continuation header. */
  assert.equal(typeof submitted[0].options.continuationToken, 'function',
    'a resolver, so a retry reads the context that is current at retry time');
  assert.equal(submitted[0].sentContinuation, '1.opaque.growth.token');

  /* And nowhere in the payload. Not as a block, not at any depth: the body
     becomes the request hash, the stored submission and the report, and a
     bearer credential must reach none of them. */
  const text = JSON.stringify(submitted[0].payload);
  assert.equal(text.includes('1.opaque.growth.token'), false);
  assert.equal(text.includes('continuationToken'), false);
  assert.equal(submitted[0].payload.continuation, undefined);

  /* Nor in this review's own saved state, where a later save() could
     serialise it back into something. */
  const saved = JSON.parse(storage.getItem(CONFIG.storageKey));
  assert.equal(JSON.stringify(saved).includes('1.opaque.growth.token'), false);
});

test('anything shaped like a businessId is refused as a context', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  assert.equal(controller.acceptContinuationToken(randomUUID()), false,
    'the browser must never hold a Business Record id');
  assert.equal(controller.acceptContinuationToken('x'.repeat(600)), false);
  assert.equal(controller.acceptContinuationToken(''), false);
  assert.equal(controller.hasContinuationContext(), false);
});

test('the refreshed context is stored under the shared key, with a prefill', async t => {
  const api = installBrowser();
  t.after(teardown);

  const continuation = require('../shared/security/continuation.js');
  const controller = api.init(CONFIG);
  complete(controller);
  await controller.submit();

  const stored = continuation.readContinuation();
  assert.equal(stored.token, 'server.issued.token');
  /* The contact this visitor just typed, so a later Growth Review does not
     ask for it again. Names and an email only. */
  assert.deepEqual(stored.prefill, {
    salonName: 'Polished Test Salon',
    ownerName: 'Owner',
    email: 'owner@polished.test'
  });

  /* Either review may precede the other, so the key is shared and not
     namespaced by review or vertical. */
  assert.equal(continuation.STORAGE_KEY, 'ced:continuation');
});

test('a connected review prefills contact and declares which fields it took', async t => {
  const api = installBrowser();
  t.after(teardown);

  const continuation = require('../shared/security/continuation.js');
  continuation.storeContinuation({
    token: '1.from.growth',
    prefill: { salonName: 'Polished Test Salon', ownerName: 'Owner', email: 'owner@polished.test' }
  });

  const controller = api.init(CONFIG);
  assert.equal(controller.hasContinuationContext(), true);
  assert.deepEqual(controller.prefilledFields().sort(), ['email', 'ownerName', 'salonName']);
  assert.equal(controller.state().contact.email, 'owner@polished.test');

  /* Field NAMES travel to the report; the values are in `contact`, where
     they belong. */
  addComplete(controller, { name: 'Gel manicure', price: 65, duration: 60, volume: 80 });
  addComplete(controller, { name: 'Pedicure', price: 45, duration: 45, volume: 30 });
  controller.setCoverage('all_offerings');
  const payload = controller.buildPayload();
  assert.deepEqual(payload.serviceMix.prefilledFields.sort(),
    ['email', 'ownerName', 'salonName']);
});

test('a prefill with no context is never used', async t => {
  const api = installBrowser();
  t.after(teardown);

  /* Contact data in storage with no context to bind it is contact data
     sitting there for no reason, and it is not read. */
  storage.setItem('ced:continuation', JSON.stringify({ v: 1, prefill: { email: 'a@b.test' } }));
  const controller = api.init(CONFIG);
  assert.equal(controller.hasContinuationContext(), false);
  assert.deepEqual(controller.prefilledFields(), []);
  assert.deepEqual(controller.state().contact, {});
});

test('clearing removes the shared context and the prefill with it', async t => {
  const api = installBrowser();
  t.after(teardown);

  const continuation = require('../shared/security/continuation.js');
  continuation.storeContinuation({ token: '1.a.b', prefill: { email: 'owner@polished.test' } });

  const controller = api.init(CONFIG);
  controller.clearSavedData();

  assert.equal(storage.getItem('ced:continuation'), null,
    'a bearer token and the contact stored with it must both go');
  assert.equal(continuation.readContinuation().token, null);
});

/* ---------- the handoff from the Growth Review ----------

   The Growth engine stores the context under a shared key; the Service Mix
   page reads it from there. Both halves are tested, because a handoff that
   works on one side only is not a handoff. */

test('a completed Growth Review leaves a context under the shared key', async t => {
  teardown();
  const { resetGlobals } = await import('./helpers/dom-harness.mjs');
  const { mountNails, STAGE1_ANSWERS, answer, grantResultsConsent, walkToResults } =
    await import('./helpers/nails-markup.mjs');
  t.after(() => resetGlobals());

  const mounted = mountNails({
    submissionResponse: {
      businessId: '77777777-7777-4777-8777-777777777777',
      continuationToken: 'growth.issued.context',
      reviewType: 'growth_review'
    }
  });
  mounted.engine.open();
  answer(mounted.engine, mounted.dom, STAGE1_ANSWERS);
  grantResultsConsent(mounted.dom);
  walkToResults(mounted.engine);
  await Promise.resolve();
  await Promise.resolve();

  const continuation = require('../shared/security/continuation.js');
  const stored = JSON.parse(mounted.engine.storage.getItem(continuation.STORAGE_KEY));
  assert.equal(stored.token, 'growth.issued.context',
    'the Growth Review saves what the server issued, opaquely');

  /* And the contact the visitor just typed, so the connected review does not
     ask for it again. Names and an email only — never a phone number, never
     a website, never anything the server holds. */
  assert.equal(stored.prefill.salonName, STAGE1_ANSWERS.salonName);
  assert.equal(stored.prefill.email, STAGE1_ANSWERS.email);
  assert.deepEqual(Object.keys(stored.prefill).sort(), ['email', 'ownerName', 'salonName']);

  /* The businessId the endpoint returned to GROWTH is kept by the Growth
     engine, as it always was, and is NOT in the shared store. */
  assert.equal(JSON.stringify(stored).includes('77777777'), false);
});

test('clearing Growth data removes the context rather than leaving a bearer token', async t => {
  teardown();
  const { resetGlobals } = await import('./helpers/dom-harness.mjs');
  const { mountNails } = await import('./helpers/nails-markup.mjs');
  t.after(() => resetGlobals());

  const mounted = mountNails();
  mounted.engine.storage.setItem('ced:continuation', 'growth.issued.context');
  mounted.engine.api().clearSavedAssessmentData();
  assert.equal(mounted.engine.storage.getItem('ced:continuation'), null);
});

/* ---------- transport reuse ---------- */

test('submission goes through the existing transport, with its retry behaviour intact', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  complete(controller);
  await controller.submit();

  assert.equal(submitted[0].options.endpoint, '/api/assessments',
    'one endpoint, one idempotency contract, one retry queue');
});

test('one completed result keeps one submissionId across retries', async t => {
  const api = installBrowser();
  t.after(teardown);

  const controller = api.init(CONFIG);
  complete(controller);
  await controller.submit();
  const first = submitted[0].payload.submissionId;
  assert.equal(controller.state().submissionId, first);

  /* Changing an answer and re-finishing is a NEW result: new submissionId. */
  controller.setCoverage('most_revenue');
  await controller.submit();
  assert.notEqual(submitted[1].payload.submissionId, first);
});

/* ---------- "this is not my business" ----------

   One device can carry two businesses: a friend borrows the laptop, an owner
   reviews a second location, a consultant works through two clients. The
   server refuses to link a contradicted proposal (rule B0), so this is not
   the safety mechanism — it is how a visitor gets a clean result instead of
   a queued review. */

test('rejecting the context clears the token and the prefill together', async t => {
  const api = installBrowser();
  t.after(teardown);

  const continuation = require('../shared/security/continuation.js');
  continuation.storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', ownerName: 'Someone Else',
               email: 'someone@elsewhere.test' }
  });

  const controller = api.init(CONFIG);
  assert.deepEqual(controller.prefilledFields().sort(), ['email', 'ownerName', 'salonName']);
  assert.equal(controller.hasContinuationContext(), true);

  assert.equal(controller.startNewBusiness(), true);

  assert.equal(controller.hasContinuationContext(), false, 'the token goes');
  assert.deepEqual(controller.prefilledFields(), [], 'and so does the claim it was prefilled');
  assert.deepEqual(controller.state().contact, {},
    "keeping another business's contact details in this form would be the leak");

  /* And nothing borrowed is left in storage for the next page to pick up. */
  assert.deepEqual(continuation.readContinuation(), { token: null, prefill: {} });
});

test('a submission after rejecting the context carries no context at all', async t => {
  const api = installBrowser();
  t.after(teardown);

  require('../shared/security/continuation.js').storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', email: 'someone@elsewhere.test' }
  });

  const controller = api.init(CONFIG);
  controller.startNewBusiness();
  complete(controller);
  await controller.submit();

  assert.equal(submitted[0].sentContinuation, null);
  assert.equal(JSON.stringify(submitted[0].payload).includes('1.opaque.growth.token'), false);
  assert.deepEqual(submitted[0].payload.serviceMix.prefilledFields, [],
    'nothing was prefilled, and the report must not claim otherwise');
});

test('typing over a prefilled business name drops the context too', async t => {
  const api = installBrowser();
  t.after(teardown);

  require('../shared/security/continuation.js').storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', ownerName: 'Someone Else',
               email: 'someone@elsewhere.test' }
  });

  const controller = api.init(CONFIG);
  controller.setContact({ salonName: 'Polished Test Salon' });

  assert.equal(controller.hasContinuationContext(), false,
    'a visitor who types a different business name has said the same thing more quietly');
  assert.deepEqual(controller.prefilledFields(), []);
});

test('correcting a prefilled owner name is a correction, not a different business', async t => {
  const api = installBrowser();
  t.after(teardown);

  require('../shared/security/continuation.js').storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Polished Test Salon', ownerName: 'Tset Owner',
               email: 'owner@polished.test' }
  });

  const controller = api.init(CONFIG);
  controller.setContact({ ownerName: 'Test Owner' });

  assert.equal(controller.hasContinuationContext(), true,
    'the owner name is not identity-bearing; a typo fix must not break the link');
  assert.deepEqual(controller.prefilledFields().sort(), ['email', 'salonName'],
    'but the corrected field is no longer one they did not have to retype');
});

test('leaving the prefilled values alone keeps the context', async t => {
  const api = installBrowser();
  t.after(teardown);

  require('../shared/security/continuation.js').storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Polished Test Salon', ownerName: 'Test Owner',
               email: 'owner@polished.test' }
  });

  const controller = api.init(CONFIG);
  const contact = controller.state().contact;
  controller.setContact({ ...contact });

  assert.equal(controller.hasContinuationContext(), true);
  assert.deepEqual(controller.prefilledFields().sort(), ['email', 'ownerName', 'salonName']);
});

/* ---------- "start fresh" starts a fresh JOURNEY ----------

   Clearing the token and the prefill was not enough. The assessment session
   id is a client-supplied journey identifier that the server had already
   resolved to the previous business, so a "start fresh" that kept it produced
   a submission proposing the very record the visitor had just said was not
   theirs. The button said one thing and the payload said another. */

const storedContext = () => require('../shared/security/continuation.js');

test('rejecting the context mints a new assessment session', async t => {
  const api = installBrowser();
  t.after(teardown);

  storedContext().storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', ownerName: 'Someone Else',
               email: 'someone@elsewhere.test' }
  });

  const controller = api.init(CONFIG);
  const before = controller.state().assessmentSessionId;
  assert.ok(before);

  controller.startNewBusiness();

  const after = controller.state().assessmentSessionId;
  assert.notEqual(after, before,
    'the server had already resolved the old session to the previous business');
  assert.ok(offerings.isUuid(after));
});

test('rejecting the context clears every trace of the completed journey', async t => {
  const api = installBrowser();
  t.after(teardown);

  storedContext().storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', email: 'someone@elsewhere.test' }
  });

  const controller = api.init(CONFIG);
  complete(controller);
  await controller.submit();
  assert.ok(controller.state().submissionId, 'a completed submission to clear');

  const sessionBefore = controller.state().assessmentSessionId;
  controller.startNewBusiness();

  const state = controller.state();
  assert.notEqual(state.assessmentSessionId, sessionBefore);
  assert.equal(state.submissionId, null,
    'keeping it would let the new business replay under the old key');
  assert.equal(state.submissionFingerprint, null);
  assert.equal(state.completedAt, null);
  assert.deepEqual(state.contact, {});
  assert.deepEqual(state.prefilledFields, []);
  assert.equal(controller.hasContinuationContext(), false);
});

test('the rotated journey is saved before anything can submit', async t => {
  const api = installBrowser();
  t.after(teardown);

  storedContext().storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', email: 'someone@elsewhere.test' }
  });

  const controller = api.init(CONFIG);
  controller.startNewBusiness();
  const rotated = controller.state().assessmentSessionId;

  /* Read back from storage, not from memory: a crash between the click and
     the next page load must not resume the old journey. */
  const saved = JSON.parse(storage.getItem(CONFIG.storageKey));
  assert.equal(saved.assessmentSessionId, rotated);
  assert.equal(saved.submissionId, null);
  assert.deepEqual(saved.contact, {});
});

test('the work the visitor has done survives the reset', async t => {
  const api = installBrowser();
  t.after(teardown);

  storedContext().storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', email: 'someone@elsewhere.test' }
  });

  const controller = api.init(CONFIG);
  addComplete(controller, { name: 'Gel manicure', price: 65, duration: 60, volume: 80 });
  addComplete(controller, { name: 'Acrylic full set', price: 90, duration: 150, volume: 30 });

  controller.startNewBusiness();

  assert.equal(controller.offerings().length, 2,
    'offerings carry no identity, and throwing them away would punish ' +
    'somebody for correcting us');
});

test('a submission after starting fresh proposes nothing borrowed', async t => {
  const api = installBrowser();
  t.after(teardown);

  storedContext().storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', email: 'someone@elsewhere.test' }
  });

  const controller = api.init(CONFIG);
  const originalSession = controller.state().assessmentSessionId;
  controller.startNewBusiness();
  complete(controller);
  await controller.submit();

  const sent = submitted[0];
  assert.equal(sent.sentContinuation, null);
  assert.notEqual(sent.payload.assessmentSessionId, originalSession,
    'the payload must not name the journey the visitor just disowned');
  assert.equal(sent.payload.assessmentSessionId, controller.state().assessmentSessionId);
  assert.deepEqual(sent.payload.serviceMix.prefilledFields, []);
});

test('typing over an identity-bearing prefill rotates the session too', async t => {
  const api = installBrowser();
  t.after(teardown);

  storedContext().storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', ownerName: 'Someone Else',
               email: 'someone@elsewhere.test' }
  });

  const controller = api.init(CONFIG);
  const before = controller.state().assessmentSessionId;

  controller.setContact({ salonName: 'Polished Test Salon' });

  assert.notEqual(controller.state().assessmentSessionId, before,
    'the silent path must protect exactly as much as the button');
  assert.equal(controller.hasContinuationContext(), false);
  assert.deepEqual(controller.prefilledFields(), []);
  /* And what they typed is still there — the reset is of the journey, not of
     their work. */
  assert.equal(controller.state().contact.salonName, 'Polished Test Salon');
});

test('correcting a non-identity field rotates nothing', async t => {
  const api = installBrowser();
  t.after(teardown);

  storedContext().storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Polished Test Salon', ownerName: 'Tset Owner',
               email: 'owner@polished.test' }
  });

  const controller = api.init(CONFIG);
  const before = controller.state().assessmentSessionId;

  controller.setContact({ ownerName: 'Test Owner' });

  assert.equal(controller.state().assessmentSessionId, before,
    'a typo fix is not a different business');
  assert.equal(controller.hasContinuationContext(), true);
});
