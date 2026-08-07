/* ============================================================
   Rule B0 — a PROPOSAL is not a decision
   ------------------------------------------------------------
   TWO things can name a Business Record before any identifier
   is looked at, and this file exists because each of them, in
   turn, was trusted to do it:

     · a continuation context — a bearer credential this server
       signed
     · an assessment session id — a client-supplied journey
       identifier

   The defect, found twice by independent audit. First through
   the token:

     1. Complete a review for Salon A; receive its context.
     2. Submit Salon B — different name, owner, email — sending
        Salon A's context.
     3. 201, and Salon B is filed under Salon A.

   Then, after the token was fixed, through the session, with no
   token at all:

     1. Submit Salon A's review using session S.
     2. Submit Salon B, different name and email, reusing S.
     3. 201, `linkMethod: "session"`, and Salon B's name, email
        and report are filed under Salon A. No case opened.

   Permanently, both times. `timeline_events` and `audit_events`
   refuse UPDATE and refuse DELETE, and erasure means redaction,
   not removal. There is no undo for this.

   Neither pointer is evidence about a business. Both are
   statements about a BROWSER: this browser recently finished a
   review that resolved to this record. A friend borrows the
   laptop, an owner reviews a second location, a consultant
   works through two clients — and the statement stays true
   while the business changes underneath it.

   So every proposal is compared against what the record holds,
   and a MATERIAL contradiction sets it aside:

     · the business name contradicts, AND
     · at least one piece of contact evidence contradicts, AND
     · nothing agrees

   All three. A name change alone is a rebrand; an email change
   alone is a new address; one agreement anywhere is continuity.
   Only the combination says "this is somebody else".

   Three implementations must agree: the shared rule, the fake
   database, and ingest_review in migration 0006. The first two
   are exercised here; the third by section P of
   tests/integration/supabase-real-db.test.mjs, against real
   PostgreSQL, over the same case table.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';

import { handleRequest } from '../api/assessments.mjs';
import continuation from '../shared/security/continuation.js';
import resolveIdentity from '../shared/business-record/resolve-identity.js';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload } from './helpers/fixtures.mjs';
import {
  makeServiceMixPayload, makeServiceMixRequest, makePortfolio,
  smDeps, SM_ENV, NOW_MS
} from './helpers/service-mix-fixtures.mjs';

const hmac = (secret, input) => createHmac('sha256', secret).update(input).digest('hex');

/* Two entirely separate salons. Nothing in common: not the name, not the
   owner, not the email local part, not the email domain. */
const SALON_A = {
  salonName: 'Polished Nail Studio',
  ownerName: 'Test Owner',
  email: 'owner@polished.test'
};
const SALON_B = {
  salonName: 'Riverside Barber Co',
  ownerName: 'Someone Else',
  email: 'someone@riverside.test'
};

/* ============================================================
   1. The rule itself
   ============================================================ */

const identifiers = contact =>
  resolveIdentity.persistableSignals(
    resolveIdentity.extractIdentitySignals({ contact })
  ).map(s => ({ type: s.type, normalizedValue: s.normalizedValue }));

const verdictFor = (submittedContact, heldContact) =>
  resolveIdentity.proposalConflict({
    signals: resolveIdentity.extractIdentitySignals({ contact: submittedContact }),
    heldIdentifiers: identifiers(heldContact)
  });

/* The case table. Every row is also run against real PostgreSQL in section P
   of the integration suite, which is what keeps the SQL mirror honest. */
const CASES = [
  {
    name: 'the same business continues',
    submitted: SALON_A, held: SALON_A, material: false
  },
  {
    name: 'a different business entirely',
    submitted: SALON_B, held: SALON_A, material: true
  },
  {
    name: 'a rebrand — new name, same email',
    submitted: { ...SALON_A, salonName: 'Polished Nails and Spa' }, held: SALON_A,
    material: false
  },
  {
    name: 'a new email address — same name',
    submitted: { ...SALON_A, email: 'newowner@polished.test' }, held: SALON_A,
    material: false
  },
  {
    name: 'a rebrand AND a new provider, but the domain survives',
    submitted: { salonName: 'Polished Nails and Spa', ownerName: 'Test Owner',
                 email: 'hello@polished.test' },
    held: SALON_A,
    /* email_exact contradicts, business_name contradicts — but email_domain
       agrees, and one agreement anywhere is continuity. */
    material: false
  },
  {
    name: 'a rebrand and a free-mail address, with nothing left in common',
    submitted: { salonName: 'Riverside Barber Co', ownerName: 'Someone Else',
                 email: 'someone@gmail.com' },
    held: SALON_A,
    /* email_domain scores nothing for free mail, so the comparable types are
       business_name and email_exact — both contradicting, none agreeing. */
    material: true
  },
  {
    name: 'a record holding nothing comparable',
    submitted: SALON_B, held: {}, material: false
  }
];

test('the conflict rule is exactly: name contradicts, contact contradicts, nothing agrees', () => {
  CASES.forEach(c => {
    const verdict = verdictFor(c.submitted, c.held);
    assert.equal(verdict.material, c.material, c.name);
  });
});

test('a contradiction in the name alone is a rebrand, not another business', () => {
  const verdict = verdictFor({ ...SALON_A, salonName: 'Polished Nails and Spa' }, SALON_A);
  assert.equal(verdict.material, false);
  assert.ok(verdict.contradictedTypes.includes('business_name'));
  assert.ok(verdict.agreedTypes.includes('email_exact'),
    'the email is what says this is still the same business');
});

test('the verdict names types, never values', () => {
  const verdict = verdictFor(SALON_B, SALON_A);
  assert.equal(verdict.material, true);
  const text = JSON.stringify(verdict);
  [SALON_A.email, SALON_B.email, SALON_A.salonName, SALON_B.salonName]
    .forEach(value => assert.equal(text.includes(value), false,
      'a verdict travels into a review queue and must carry no identifier value'));
});

/* ============================================================
   2. Through the endpoint, against the fake database
   ============================================================ */

const send = async (db, payload, opts = {}) => {
  const res = await handleRequest(makeServiceMixRequest(payload, opts), smDeps(db));
  const body = await res.json().catch(() => null);
  return { res, body };
};

const growthReview = async (db, contact, overrides = {}) => {
  const res = await handleRequest(
    makeServiceMixRequest(makePayload({
      submissionId: randomUUID(), assessmentSessionId: randomUUID(),
      contact: { ...contact, mobile: '', preferredContact: 'email' },
      ...overrides
    })),
    smDeps(db));
  const body = await res.json();
  assert.equal(res.status, 201, 'the Growth Review must succeed for the rest to mean anything');
  return body;
};

const serviceMixFor = (contact, overrides = {}) => makeServiceMixPayload({
  submissionId: randomUUID(),
  assessmentSessionId: randomUUID(),
  serviceMix: { offerings: makePortfolio() },
  contact,
  ...overrides
});

const reportFor = (db, submissionId) =>
  db.state.business_intelligence_reports.find(r => r.assessment_submission_id === submissionId);
const submissionFor = (db, submissionId) =>
  db.state.assessment_submissions.find(s => s.submission_id === submissionId);
const identifiersOf = (db, businessId) =>
  db.state.business_identifiers.filter(i => i.business_id === businessId && i.valid_to === null);

test('the same business still continues through its context', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db, SALON_A);

  const { res, body } = await send(db, serviceMixFor(SALON_A),
    { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });

  assert.equal(res.status, 201);
  assert.equal(submissionFor(db, body.submissionId).business_id, growth.businessId,
    'a consistent continuation must still link — the repair may not break the feature');
  assert.equal(db.state.business_records.length, 1);
  assert.equal(db.state.identity_resolution_cases.length, 0, 'and needs no human');
});

test('Salon A token plus Salon B identity does not link to Salon A', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db, SALON_A);

  const { res, body } = await send(db, serviceMixFor(SALON_B),
    { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });

  /* The visitor still gets a result. Refusing the submission would punish
     somebody for something they cannot see. */
  assert.equal(res.status, 201);

  const submission = submissionFor(db, body.submissionId);
  assert.notEqual(submission.business_id, growth.businessId,
    'Salon B may not be filed under Salon A');
  assert.equal(submission.business_id, null, 'and is not filed anywhere else automatically');
  assert.equal(submission.identity_status, 'resolution_pending');
});

test('Salon B identifiers are never stored against Salon A', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db, SALON_A);
  await send(db, serviceMixFor(SALON_B),
    { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });

  const held = identifiersOf(db, growth.businessId);
  const values = held.map(i => i.normalized_value);

  assert.equal(values.includes('riverside barber co'), false, 'business name');
  assert.equal(values.includes('someone@riverside.test'), false, 'email');
  assert.equal(values.includes('riverside.test'), false, 'email domain');

  /* Salon A keeps exactly what it had. */
  assert.ok(values.includes('polished nail studio'));
  assert.ok(values.includes('owner@polished.test'));

  /* And nothing of Salon B's reached the record by any other route. */
  const recordText = JSON.stringify(
    db.state.business_records.find(b => b.business_id === growth.businessId));
  assert.equal(/riverside|Someone Else/i.test(recordText), false);
});

test('no Salon B report enters Salon A chain', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db, SALON_A);
  const { body } = await send(db, serviceMixFor(SALON_B),
    { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });

  const mixReport = reportFor(db, body.submissionId);
  assert.equal(mixReport.business_id, null, 'the report is stored, attached to nobody');
  assert.equal(mixReport.supersedes_bir_id, null);
  assert.equal(mixReport.report.relatedGrowthReview, null,
    'and it names no Growth report, because it continues from none');

  /* Salon A's review states are untouched: still one, still Growth. */
  const states = db.state.business_review_states.filter(s => s.business_id === growth.businessId);
  assert.deepEqual(states.map(s => s.review_type), ['growth_review']);

  /* No report anywhere claims to belong to Salon A except Salon A's own. */
  const aReports = db.state.business_intelligence_reports
    .filter(r => r.business_id === growth.businessId);
  assert.deepEqual(aReports.map(r => r.bir_id), [growth.birId]);
});

test('the mismatch creates a resolution case that says what happened', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db, SALON_A);
  const { body } = await send(db, serviceMixFor(SALON_B),
    { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });

  assert.equal(db.state.identity_resolution_cases.length, 1);
  const [openCase] = db.state.identity_resolution_cases;
  assert.equal(openCase.assessment_submission_id, body.submissionId);
  assert.equal(openCase.resolution_status, 'manual_review_required');
  assert.equal(openCase.recommended_action, 'queue_for_review');
  assert.equal(openCase.resolved_at, null);

  const contradiction = openCase.conflicting_signals
    .find(c => c.kind === 'continuation_context_contradicted');
  assert.ok(contradiction, 'the case must say the context was set aside');
  assert.equal(contradiction.proposedBusinessId, growth.businessId);
  assert.ok(contradiction.contradictedTypes.includes('business_name'));
  assert.ok(contradiction.contradictedTypes.includes('email_exact'));
  assert.deepEqual(contradiction.agreedTypes, []);

  /* The case is a queue entry, not a second copy of the contact record. */
  assert.equal(JSON.stringify(openCase).includes('someone@riverside.test'), false);
  assert.equal(JSON.stringify(openCase).includes('Riverside Barber Co'), false);

  /* The response says identity is unsettled and names no business — not the
     one that was proposed, not the one that was refused, none. */
  assert.equal(body.businessId, undefined, 'Service Mix never returns a Business Record id');
  assert.equal(body.identityResolved, false);
  assert.equal(body.nextAction, 'identity_review_pending');
  assert.equal(JSON.stringify(body).includes(growth.businessId), false,
    'a borrowed token must not reveal whose record it named');
});

test('a contradicted context is never reported to the client as applied', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db, SALON_A);
  const { body } = await send(db, serviceMixFor(SALON_B),
    { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });

  /* No refreshed context either: there is no resolved record to issue one
     for, and a token pointing at nothing is a capability to link nothing. */
  assert.equal(body.continuationToken, undefined);

  const submission = submissionFor(db, body.submissionId);
  assert.equal(submission.ingest_meta.continuationApplied, false,
    'the endpoint offered a context; the database decided it did not apply');
  assert.equal(submission.ingest_meta.continuationContradicted, true);
});

test('a contradicted context cannot create a record either', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db, SALON_A);
  const before = db.state.business_records.length;

  await send(db, serviceMixFor(SALON_B),
    { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });

  assert.equal(db.state.business_records.length, before,
    'the only evidence that this is a new business is the evidence that just ' +
    'contradicted a signed context, and these tables refuse DELETE');
});

test('the same submission with no context at all resolves normally', async () => {
  /* The control. Salon B on its own is an ordinary new business, and the
     veto path must not be reachable without a context. */
  const db = createFakeDb();
  await growthReview(db, SALON_A);
  const { res, body } = await send(db, serviceMixFor(SALON_B));

  assert.equal(res.status, 201);
  const submission = submissionFor(db, body.submissionId);
  assert.equal(submission.identity_status, 'linked');
  assert.equal(db.state.business_records.length, 2, 'two salons, two records');
  assert.equal(db.state.identity_resolution_cases.length, 0);
});

test('a forged context cannot reach the conflict rule at all', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db, SALON_A);

  const forged = continuation.issueContinuationContext({
    businessId: growth.businessId, verticalId: 'nails', reviewType: 'growth_review',
    issuedAtMs: NOW_MS, secret: 'not-the-real-secret', hmacFn: hmac
  });

  const { res, body } = await send(db, serviceMixFor(SALON_B),
    { extraHeaders: { 'X-CED-Continuation': forged } });

  assert.equal(res.status, 201);
  /* Rejected before ingestion, so ordinary resolution runs and Salon B gets
     its own record — the same outcome as sending no token. */
  assert.equal(submissionFor(db, body.submissionId).identity_status, 'linked');
  assert.equal(db.state.business_records.length, 2);
});

/* ============================================================
   3. Same device, two businesses, one queue
   ============================================================ */

test('a queued Salon A review is not sent with Salon B current context', async () => {
  /* Salon A's review is queued while offline. Salon B then completes a review
     on the same device, so Salon B's token is what the shared store holds.
     The retry must not offer it. */
  const storage = new Map();
  const store = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  };
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: { localStorage: store }, configurable: true, writable: true });
  const restore = () => {
    ['localStorage', 'window'].forEach(name =>
      Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true }));
  };

  try {
    /* Salon B's context is the current one. */
    continuation.storeContinuation({
      token: '1.salon.b.token',
      prefill: { salonName: SALON_B.salonName, email: SALON_B.email }
    });

    /* The resolver the controller hands the transport: it compares the
       payload's own contact evidence with the prefill stored beside the
       token. Restated here rather than driving a whole browser, because what
       is under test is the decision, and the browser path is covered by
       tests/service-mix-queued-retry.test.mjs. */
    const prefill = () => continuation.readContinuation().prefill;
    const fits = payload => {
      const contact = (payload && payload.contact) || {};
      const comparable = ['salonName', 'businessName', 'email']
        .filter(f => prefill()[f] && contact[f]);
      return !comparable.length ||
        comparable.every(f => prefill()[f].trim().toLowerCase() === contact[f].trim().toLowerCase());
    };

    assert.equal(fits({ contact: SALON_A }), false,
      "Salon A's queued review must not be offered Salon B's token");
    assert.equal(fits({ contact: SALON_B }), true,
      "Salon B's own review still continues");
    assert.equal(fits({ contact: {} }), true,
      'a payload with nothing comparable is left to the server');
  } finally {
    restore();
  }
});

test('and if it is sent anyway, the server refuses to link it', async () => {
  /* The browser check is a courtesy. This is the guarantee: a retry that
     reaches the endpoint carrying the wrong business's context contaminates
     neither record. */
  const db = createFakeDb();
  const salonA = await growthReview(db, SALON_A);
  const salonB = await growthReview(db, SALON_B);

  const queuedForA = serviceMixFor(SALON_A);
  const { res, body } = await send(db, queuedForA,
    { extraHeaders: { 'X-CED-Continuation': salonB.continuationToken } });

  assert.equal(res.status, 201);

  const submission = submissionFor(db, body.submissionId);
  assert.notEqual(submission.business_id, salonB.businessId, 'not filed under Salon B');
  assert.equal(submission.identity_status, 'resolution_pending',
    'and not auto-filed under Salon A either: weak evidence never links by itself');

  /* Neither record gained anything. */
  assert.equal(identifiersOf(db, salonB.businessId)
    .some(i => i.normalized_value === 'owner@polished.test'), false);
  assert.deepEqual(
    db.state.business_intelligence_reports.filter(r => r.business_id === salonB.businessId)
      .map(r => r.bir_id),
    [salonB.birId]);
  assert.deepEqual(
    db.state.business_intelligence_reports.filter(r => r.business_id === salonA.businessId)
      .map(r => r.bir_id),
    [salonA.birId]);

  assert.equal(db.state.identity_resolution_cases.length, 1);
});

/* ============================================================
   4. The same corruption through the session
   ------------------------------------------------------------
   No continuation header anywhere below. The session id alone
   used to be enough.
   ============================================================ */

const reuseSession = async (db, contact, sessionId) =>
  send(db, serviceMixFor(contact, { assessmentSessionId: sessionId }));

test('a second submission for the SAME business in one session still links and chains', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();

  const first = await reuseSession(db, SALON_A, sessionId);
  assert.equal(first.res.status, 201);
  const businessId = submissionFor(db, first.body.submissionId).business_id;
  assert.ok(businessId, 'the first submission creates the record');

  const second = await reuseSession(db, SALON_A, sessionId);
  assert.equal(second.res.status, 201);
  assert.equal(submissionFor(db, second.body.submissionId).business_id, businessId,
    'a saved journey is still deterministic for itself');

  /* And it chains rather than starting a second root. */
  const firstReport = reportFor(db, first.body.submissionId);
  const secondReport = reportFor(db, second.body.submissionId);
  assert.equal(secondReport.supersedes_bir_id, firstReport.bir_id);

  const state = db.state.business_review_states
    .find(s => s.business_id === businessId && s.review_type === 'service_mix');
  assert.equal(state.current_bir_id, secondReport.bir_id);
  assert.equal(state.completed_count, 2);
  assert.equal(db.state.identity_resolution_cases.length, 0, 'and needs no human');
});

test('a rebrand in the same session still links', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const first = await reuseSession(db, SALON_A, sessionId);
  const businessId = submissionFor(db, first.body.submissionId).business_id;

  const renamed = await reuseSession(db,
    { ...SALON_A, salonName: 'Polished Nails and Spa' }, sessionId);
  assert.equal(submissionFor(db, renamed.body.submissionId).business_id, businessId,
    'a name change alone is a rebrand');
});

test('a new email in the same session still links', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const first = await reuseSession(db, SALON_A, sessionId);
  const businessId = submissionFor(db, first.body.submissionId).business_id;

  const moved = await reuseSession(db,
    { ...SALON_A, email: 'newowner@polished.test' }, sessionId);
  assert.equal(submissionFor(db, moved.body.submissionId).business_id, businessId,
    'a contact change alone is an update');
});

test('Business B in Business A session does not link to A', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();

  const a = await reuseSession(db, SALON_A, sessionId);
  const businessA = submissionFor(db, a.body.submissionId).business_id;
  assert.ok(businessA);

  const b = await reuseSession(db, SALON_B, sessionId);

  /* The visitor still gets a result. */
  assert.equal(b.res.status, 201);

  const submission = submissionFor(db, b.body.submissionId);
  assert.notEqual(submission.business_id, businessA,
    'a journey identifier is not proof that every later payload is the same business');
  assert.equal(submission.business_id, null);
  assert.equal(submission.identity_status, 'resolution_pending');
  assert.equal(submission.ingest_meta.sessionContradicted, true);
  assert.equal(submission.ingest_meta.continuationApplied, false);
});

test('B identifiers never reach A through a shared session', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const a = await reuseSession(db, SALON_A, sessionId);
  const businessA = submissionFor(db, a.body.submissionId).business_id;

  await reuseSession(db, SALON_B, sessionId);

  const values = identifiersOf(db, businessA).map(i => i.normalized_value);
  assert.equal(values.includes('riverside barber co'), false, 'business name');
  assert.equal(values.includes('someone@riverside.test'), false, 'exact email');
  assert.equal(values.includes('riverside.test'), false, 'email domain');
  assert.ok(values.includes('polished nail studio'));
  assert.ok(values.includes('owner@polished.test'));

  /* And nowhere else: a vetoed proposal may not create a record either. */
  assert.equal(db.state.business_records.length, 1);
  assert.equal(db.state.business_identifiers
    .some(i => i.normalized_value === 'someone@riverside.test'), false);
});

test('B report never enters A chain, and A pointers do not move', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const a = await reuseSession(db, SALON_A, sessionId);
  const businessA = submissionFor(db, a.body.submissionId).business_id;
  const aReport = reportFor(db, a.body.submissionId);

  const b = await reuseSession(db, SALON_B, sessionId);
  const bReport = reportFor(db, b.body.submissionId);

  assert.equal(bReport.business_id, null, 'stored, attached to nobody');
  assert.equal(bReport.supersedes_bir_id, null);

  const aReports = db.state.business_intelligence_reports
    .filter(r => r.business_id === businessA);
  assert.deepEqual(aReports.map(r => r.bir_id), [aReport.bir_id]);

  const state = db.state.business_review_states
    .find(s => s.business_id === businessA && s.review_type === 'service_mix');
  assert.equal(state.current_bir_id, aReport.bir_id, 'the current pointer did not move');
  assert.equal(state.latest_submission_id, a.body.submissionId);
  assert.equal(state.completed_count, 1, 'and B was not counted as a completion');
});

test('the session row keeps pointing where it always did', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const a = await reuseSession(db, SALON_A, sessionId);
  const businessA = submissionFor(db, a.body.submissionId).business_id;

  await reuseSession(db, SALON_B, sessionId);

  const session = db.state.assessment_sessions
    .find(s => s.assessment_session_id === sessionId);
  assert.equal(session.business_id, businessA,
    'written once and never rewritten — which is exactly why a submission ' +
    'must not be attached elsewhere while it still says this');
  assert.equal(session.review_type, 'service_mix');
});

test('a contradicted session opens a case that names types, never values', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const a = await reuseSession(db, SALON_A, sessionId);
  const businessA = submissionFor(db, a.body.submissionId).business_id;

  const b = await reuseSession(db, SALON_B, sessionId);

  assert.equal(db.state.identity_resolution_cases.length, 1);
  const [openCase] = db.state.identity_resolution_cases;
  assert.equal(openCase.assessment_submission_id, b.body.submissionId);
  assert.equal(openCase.resolution_status, 'manual_review_required');
  assert.equal(openCase.recommended_action, 'queue_for_review');
  assert.equal(openCase.resolved_at, null);

  const contradiction = openCase.conflicting_signals
    .find(c => c.kind === 'session_contradicted');
  assert.ok(contradiction, 'the case must say the session was set aside');
  assert.equal(contradiction.proposedBusinessId, businessA);
  assert.ok(contradiction.contradictedTypes.includes('business_name'));
  assert.ok(contradiction.contradictedTypes.includes('email_exact'));
  assert.deepEqual(contradiction.agreedTypes, []);

  const text = JSON.stringify(openCase);
  assert.equal(text.includes('someone@riverside.test'), false);
  assert.equal(text.includes('Riverside Barber Co'), false);

  /* The timeline and the audit row say the same thing, also without values. */
  const review = db.state.timeline_events
    .find(e => e.event_name === 'identity.review_required');
  assert.ok(review);
  assert.equal(review.payload.sessionContradicted, true);
  assert.match(review.summary, /saved identity proposal was set aside/i);

  const audit = db.state.audit_events
    .find(e => e.new_value.submissionId === b.body.submissionId);
  assert.equal(audit.new_value.sessionContradicted, true);
  assert.equal(audit.business_id, null);
});

test('the response exposes neither A id nor a context for it', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const a = await reuseSession(db, SALON_A, sessionId);
  const businessA = submissionFor(db, a.body.submissionId).business_id;

  const b = await reuseSession(db, SALON_B, sessionId);

  assert.equal(b.body.businessId, undefined);
  assert.equal(b.body.identityResolved, false);
  assert.equal(b.body.nextAction, 'identity_review_pending');
  assert.equal(b.body.continuationToken, undefined,
    'no token is minted for a record this submission was refused');
  assert.equal(JSON.stringify(b.body).includes(businessA), false);
});

test('cross-review-type session reuse is still refused outright', async () => {
  /* Unchanged by any of this: a session belongs to one review. */
  const db = createFakeDb();
  const sessionId = randomUUID();

  const growth = await handleRequest(
    makeServiceMixRequest(makePayload({
      submissionId: randomUUID(), assessmentSessionId: sessionId,
      contact: { ...SALON_A, mobile: '', preferredContact: 'email' }
    })), smDeps(db));
  assert.equal(growth.status, 201);

  const { res, body } = await reuseSession(db, SALON_A, sessionId);
  assert.equal(res.status, 502);
  assert.equal(body.error.code, 'ingestion_failed');
  assert.equal(db.state.assessment_submissions.filter(s => s.review_type === 'service_mix').length, 0);
});

/* ============================================================
   5. Two proposals, one submission
   ============================================================ */

test('session and continuation agreeing on one record link it', async () => {
  const db = createFakeDb();
  const growth = await growthReview(db, SALON_A);

  /* First Service Mix submission: links by context, and links the session. */
  const sessionId = randomUUID();
  const first = await send(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }),
    { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });
  assert.equal(submissionFor(db, first.body.submissionId).business_id, growth.businessId);

  /* Second: now BOTH propose the same record. */
  const second = await send(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }),
    { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });
  assert.equal(submissionFor(db, second.body.submissionId).business_id, growth.businessId);
  assert.equal(db.state.identity_resolution_cases.length, 0);
});

test('a consistent continuation cannot rescue a contradicted session', async () => {
  /* Salon A's session, Salon B's identity, Salon B's own valid context.
     Linking by context would attach the submission to B while the session row
     still says A — permanently, because that column is written once. */
  const db = createFakeDb();
  const sessionId = randomUUID();

  const a = await reuseSession(db, SALON_A, sessionId);
  const businessA = submissionFor(db, a.body.submissionId).business_id;
  const growthB = await growthReview(db, SALON_B);

  const { res, body } = await send(db,
    serviceMixFor(SALON_B, { assessmentSessionId: sessionId }),
    { extraHeaders: { 'X-CED-Continuation': growthB.continuationToken } });

  assert.equal(res.status, 201);
  const submission = submissionFor(db, body.submissionId);
  assert.equal(submission.business_id, null, 'neither record is chosen');
  assert.equal(submission.identity_status, 'resolution_pending');

  /* Neither record gained anything. */
  assert.equal(identifiersOf(db, businessA)
    .some(i => i.normalized_value === 'someone@riverside.test'), false);
  assert.deepEqual(
    db.state.business_intelligence_reports.filter(r => r.business_id === growthB.businessId)
      .map(r => r.bir_id), [growthB.birId]);
});

test('a consistent session cannot rescue a contradicted continuation', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();

  const a = await reuseSession(db, SALON_A, sessionId);
  const businessA = submissionFor(db, a.body.submissionId).business_id;
  const growthB = await growthReview(db, SALON_B);

  /* Salon A's session and identity, Salon B's borrowed token. */
  const { body } = await send(db,
    serviceMixFor(SALON_A, { assessmentSessionId: sessionId }),
    { extraHeaders: { 'X-CED-Continuation': growthB.continuationToken } });

  const submission = submissionFor(db, body.submissionId);
  assert.equal(submission.business_id, null,
    'one rule, no exceptions: a contradicted proposal sends the whole ' +
    'submission to review rather than being quietly dropped');
  assert.equal(submission.identity_status, 'resolution_pending');
  assert.equal(submission.ingest_meta.continuationContradicted, true);
  assert.equal(submission.ingest_meta.sessionContradicted, false);

  /* A keeps exactly what it had. */
  const aReports = db.state.business_intelligence_reports
    .filter(r => r.business_id === businessA);
  assert.equal(aReports.length, 1);
});

test('two consistent proposals naming different records go to review', async () => {
  /* A genuinely ambiguous submission: Salon A's name with Salon B's email.
     Neither proposal is contradicted — A agrees on the name, B agrees on the
     email — so neither can be dismissed, and neither can be chosen. */
  const db = createFakeDb();
  const sessionId = randomUUID();

  const a = await reuseSession(db, SALON_A, sessionId);
  const businessA = submissionFor(db, a.body.submissionId).business_id;
  const growthB = await growthReview(db, SALON_B);

  const ambiguous = {
    salonName: SALON_A.salonName, ownerName: 'Someone', email: SALON_B.email
  };
  const { body } = await send(db,
    serviceMixFor(ambiguous, { assessmentSessionId: sessionId }),
    { extraHeaders: { 'X-CED-Continuation': growthB.continuationToken } });

  const submission = submissionFor(db, body.submissionId);
  assert.equal(submission.business_id, null);
  assert.equal(submission.identity_status, 'resolution_pending');
  assert.equal(submission.ingest_meta.continuationContradicted, false);
  assert.equal(submission.ingest_meta.sessionContradicted, false);

  const [openCase] = db.state.identity_resolution_cases;
  const disagreement = openCase.conflicting_signals
    .find(c => c.kind === 'proposals_disagree');
  assert.ok(disagreement, 'the case must say the two proposals disagreed');
  assert.deepEqual(disagreement.proposedBusinessIds.slice().sort(),
    [businessA, growthB.businessId].sort());

  assert.notEqual(submission.business_id, businessA);
  assert.notEqual(submission.business_id, growthB.businessId);
});

/* ============================================================
   6. A queued retry carries its original session
   ============================================================ */

test('a stale-session queued retry cannot contaminate either record', async () => {
  /* Business B's review was queued on a device whose session had already
     resolved to Business A. The retry sends the same payload and the same
     session id, and no continuation header at all — the browser's fit check
     never looks at the session. The server is what has to hold. */
  const db = createFakeDb();
  const sessionId = randomUUID();

  const a = await reuseSession(db, SALON_A, sessionId);
  const businessA = submissionFor(db, a.body.submissionId).business_id;
  const aReport = reportFor(db, a.body.submissionId);

  const queued = serviceMixFor(SALON_B, { assessmentSessionId: sessionId });

  /* The retry: same payload, same submission id, twice — the transport keeps
     one idempotency key for the life of a queued entry. */
  const firstAttempt = await send(db, queued);
  assert.equal(firstAttempt.res.status, 201);
  const replay = await send(db, queued);
  assert.equal(replay.res.status, 200, 'a retry of one result is a replay');
  assert.equal(replay.body.replayed, true);

  const submission = submissionFor(db, queued.submissionId);
  assert.equal(submission.business_id, null);
  assert.equal(submission.identity_status, 'resolution_pending');

  /* A is untouched, and B was never created. */
  assert.equal(identifiersOf(db, businessA)
    .some(i => i.normalized_value === 'someone@riverside.test'), false);
  assert.deepEqual(
    db.state.business_intelligence_reports.filter(r => r.business_id === businessA)
      .map(r => r.bir_id), [aReport.bir_id]);
  assert.equal(db.state.business_records.length, 1);

  /* One submission, one case — the replay created nothing. */
  assert.equal(db.state.assessment_submissions
    .filter(s => s.submission_id === queued.submissionId).length, 1);
  assert.equal(db.state.identity_resolution_cases.length, 1);
});

/* ============================================================
   7. What the endpoint LOGS about a proposal
   ------------------------------------------------------------
   The log line claimed to record what the database did with the
   continuation context. It recorded what the endpoint assumed:

     continuationApplied = a token was offered
                           AND that one proposal was not contradicted

   Which is not rule B0b's decision. An uncontradicted context is
   still set aside when the session contradicts, and when two
   surviving proposals name different records. Both cases logged
   `true` while the stored submission said `false`.

   It is now read from the one place the answer exists: the link
   method the database returned. These tests capture the real
   logger's output — the endpoint writes JSON lines through
   console — rather than a stub, because a stub logger would
   prove nothing about the line that actually gets written.
   ============================================================ */

/* Captures every structured line the endpoint emits, at info level so the
   ingestion line is not filtered out before it is written. */
const withCapturedLogs = async run => {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const capture = text => {
    if (typeof text !== 'string') return;
    try { lines.push(JSON.parse(text)); } catch { /* not one of ours */ }
  };
  console.log = capture; console.warn = capture; console.error = capture;
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines;
};

const LOGGING_ENV = { ...SM_ENV, CED_LOG_LEVEL: 'info' };

const sendLogged = (db, payload, opts = {}) =>
  handleRequest(makeServiceMixRequest(payload, opts),
    { env: LOGGING_ENV, db, now: () => NOW_MS });

/* Matched by submission id, not by position. A scenario makes several
   requests — establishing Salon A, establishing Salon B — and each writes its
   own ingestion line; taking the first would assert against the setup rather
   than against the submission under test. */
const ingestedLine = (lines, submissionId) =>
  lines.find(l => l.event === 'assessment_ingested' && l.submissionId === submissionId);

/* Runs one scenario and returns the ingestion log line beside the row the
   database actually stored, so the two can be compared directly. */
const logAndRow = async build => {
  const db = createFakeDb();
  let submissionId = null;
  const lines = await withCapturedLogs(async () => {
    submissionId = await build(db);
  });
  assert.ok(submissionId, 'the scenario must return the submission under test');
  return {
    db,
    line: ingestedLine(lines, submissionId),
    lines,
    submission: submissionFor(db, submissionId)
  };
};

test('a context actually used to link logs continuationApplied true', async () => {
  const { line, submission } = await logAndRow(async db => {
    const growth = await growthReview(db, SALON_A);
    const res = await sendLogged(db, serviceMixFor(SALON_A),
      { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });
    const body = await res.json();
    return body.submissionId;
  });

  assert.ok(line, 'the ingestion line must be written at info level');
  assert.equal(line.continuationOffered, true);
  assert.equal(line.continuationApplied, true);
  assert.equal(line.linkMethod, 'continuation_context');
  assert.equal(submission.ingest_meta.continuationApplied, true,
    'and the stored row says the same thing');
});

test('a contradicted context logs continuationApplied false', async () => {
  const { line, submission } = await logAndRow(async db => {
    const growth = await growthReview(db, SALON_A);
    const res = await sendLogged(db, serviceMixFor(SALON_B),
      { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });
    const body = await res.json();
    return body.submissionId;
  });

  assert.equal(line.continuationOffered, true, 'the endpoint did offer one');
  assert.equal(line.continuationApplied, false);
  assert.equal(line.linkMethod, null);
  assert.equal(line.identityStatus, 'resolution_pending');
  assert.equal(submission.ingest_meta.continuationApplied, false);
});

test('a consistent context beside a contradicted session logs false', async () => {
  /* The case the old derivation got wrong. The context itself is NOT
     contradicted, so `continuationContradicted` is false — and the old rule
     concluded from that alone that the context had been applied. Rule B0b
     had set it aside because the session contradicted. */
  const { line, submission } = await logAndRow(async db => {
    const sessionId = randomUUID();
    await sendLogged(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }));
    const growthB = await growthReview(db, SALON_B);

    const res = await sendLogged(db,
      serviceMixFor(SALON_B, { assessmentSessionId: sessionId }),
      { extraHeaders: { 'X-CED-Continuation': growthB.continuationToken } });
    const body = await res.json();
    return body.submissionId;
  });

  assert.equal(line.continuationOffered, true);
  assert.equal(line.continuationApplied, false,
    'an uncontradicted context that was never used must not be logged as used');
  assert.equal(line.linkMethod, null);
  assert.equal(submission.ingest_meta.continuationApplied, false);
  assert.equal(submission.ingest_meta.continuationContradicted, false,
    'and the context genuinely was not the thing that contradicted');
  assert.equal(submission.ingest_meta.sessionContradicted, true);
});

test('two surviving proposals naming different records log false', async () => {
  /* The other case the old derivation got wrong: nothing was contradicted at
     all, and the context was still not applied. */
  const { line, submission } = await logAndRow(async db => {
    const sessionId = randomUUID();
    await sendLogged(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }));
    const growthB = await growthReview(db, SALON_B);

    const ambiguous = {
      salonName: SALON_A.salonName, ownerName: 'Someone', email: SALON_B.email
    };
    const res = await sendLogged(db,
      serviceMixFor(ambiguous, { assessmentSessionId: sessionId }),
      { extraHeaders: { 'X-CED-Continuation': growthB.continuationToken } });
    const body = await res.json();
    return body.submissionId;
  });

  assert.equal(line.continuationOffered, true);
  assert.equal(line.continuationApplied, false);
  assert.equal(line.linkMethod, null);
  assert.equal(submission.ingest_meta.continuationApplied, false);
  assert.equal(submission.ingest_meta.continuationContradicted, false);
  assert.equal(submission.ingest_meta.sessionContradicted, false);
});

test('a session-only link logs continuationApplied false', async () => {
  const { line, submission } = await logAndRow(async db => {
    const sessionId = randomUUID();
    await sendLogged(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }));
    const res = await sendLogged(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }));
    const body = await res.json();
    return body.submissionId;
  });

  assert.equal(line.continuationOffered, false, 'no token was sent');
  assert.equal(line.continuationApplied, false);
  assert.equal(line.linkMethod, 'session');
  assert.equal(line.identityStatus, 'linked', 'it did link — just not by a context');
  assert.equal(submission.ingest_meta.continuationApplied, false);
});

test('the logged outcome equals the stored outcome in every case', async () => {
  /* One assertion over every scenario above, stated as the property rather
     than case by case: the log is not allowed to disagree with the row. */
  const scenarios = [
    ['context links', async db => {
      const growth = await growthReview(db, SALON_A);
      const res = await sendLogged(db, serviceMixFor(SALON_A),
        { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });
      return (await res.json()).submissionId;
    }],
    ['context contradicted', async db => {
      const growth = await growthReview(db, SALON_A);
      const res = await sendLogged(db, serviceMixFor(SALON_B),
        { extraHeaders: { 'X-CED-Continuation': growth.continuationToken } });
      return (await res.json()).submissionId;
    }],
    ['session contradicted, context consistent', async db => {
      const sessionId = randomUUID();
      await sendLogged(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }));
      const growthB = await growthReview(db, SALON_B);
      const res = await sendLogged(db,
        serviceMixFor(SALON_B, { assessmentSessionId: sessionId }),
        { extraHeaders: { 'X-CED-Continuation': growthB.continuationToken } });
      return (await res.json()).submissionId;
    }],
    ['proposals disagree', async db => {
      const sessionId = randomUUID();
      await sendLogged(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }));
      const growthB = await growthReview(db, SALON_B);
      const res = await sendLogged(db, serviceMixFor(
        { salonName: SALON_A.salonName, ownerName: 'Someone', email: SALON_B.email },
        { assessmentSessionId: sessionId }),
        { extraHeaders: { 'X-CED-Continuation': growthB.continuationToken } });
      return (await res.json()).submissionId;
    }],
    ['session links', async db => {
      const sessionId = randomUUID();
      await sendLogged(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }));
      const res = await sendLogged(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }));
      return (await res.json()).submissionId;
    }],
    ['standalone create', async db => {
      const res = await sendLogged(db, serviceMixFor(SALON_A));
      return (await res.json()).submissionId;
    }]
  ];

  for (const [name, build] of scenarios) {
    const { line, submission } = await logAndRow(build);
    assert.ok(line, `${name}: an ingestion line`);
    assert.equal(line.continuationApplied, submission.ingest_meta.continuationApplied,
      `${name}: the log and the stored row must agree`);
    assert.equal(line.continuationApplied, line.linkMethod === 'continuation_context',
      `${name}: and both must equal the database's link method`);
    assert.equal(line.linkMethod, submission.business_id === null ? null : line.linkMethod);
  }
});

test('a set-aside proposal is reported once, without values or business ids', async () => {
  const { lines } = await logAndRow(async db => {
    const sessionId = randomUUID();
    await sendLogged(db, serviceMixFor(SALON_A, { assessmentSessionId: sessionId }));
    const res = await sendLogged(db, serviceMixFor(SALON_B, { assessmentSessionId: sessionId }));
    return (await res.json()).submissionId;
  });

  const setAside = lines.filter(l => l.event === 'identity_proposal_set_aside');
  assert.equal(setAside.length, 1);
  assert.equal(setAside[0].sessionContradicted, true);
  assert.equal(setAside[0].continuationContradicted, false);
  assert.equal(setAside[0].proposalsDisagreed, false);
  assert.equal(setAside[0].identityStatus, 'resolution_pending');

  /* Nothing identifying anywhere in the captured output. */
  const text = JSON.stringify(lines);
  [SALON_A.email, SALON_B.email, SALON_A.salonName, SALON_B.salonName]
    .forEach(value => assert.equal(text.includes(value), false, `logs carried ${value}`));
});

/* ============================================================
   Rule B0c — null is not an empty list
   ------------------------------------------------------------
   The shared rule has distinguished these since v11:

     · `signals` absent or null — the caller did not supply the
       comparison evidence. With a proposal in play, that is a
       bug in the caller and it throws.
     · `signals: []` — the caller states that there is genuinely
       nothing to compare. Legal, and it means what it says.

   The distinction only protects anything if every implementation
   draws it. PostgreSQL wrote `coalesce(p_signals, '[]')` into
   every scan and the fake database wrote `signals || []` at the
   call, so in both of them a null operand quietly became an
   explicit empty one — and a comparison with nothing on one side
   always answers "no contradiction", which is the answer that
   links.

   Reproduced end to end: Salon A holds its name and email; a
   payload describing Salon B arrives with a different name, a
   different email and no signals at all, and links to Salon A at
   confidence 1 — through the session proposal and through the
   continuation proposal alike, with neither reported as
   contradicted and no identity-resolution case opened.

   Same defect, same shape, three revisions in a row: the default
   moved from the resolver to the caller to the other language.
   ============================================================ */

const SIGNAL_SHAPES = () => [
  { name: 'omitted', build: () => ({}), throws: true },
  { name: 'null', build: () => ({ signals: null }), throws: true },
  { name: 'explicitly empty', build: () => ({ signals: [] }), throws: false },
  { name: 'dense', build: () => ({ signals: resolveIdentity.extractIdentitySignals({ contact: SALON_B }) }),
    throws: false }
];

const heldForA = () => identifiers(SALON_A);
const PROPOSAL_KINDS = ['session', 'continuation_context'];
const BUSINESS_A_ID = '11111111-1111-4111-8111-111111111111';

test('the primitive answers null, empty and dense differently, and says so', () => {
  const heldIdentifiers = heldForA();

  /* Omitted and null are refused. The message says what to do instead, because
     the fix for a caller that meant "nothing to compare" is one character. */
  assert.throws(() => resolveIdentity.proposalConflict({ heldIdentifiers }),
    /requires signals/);
  assert.throws(() => resolveIdentity.proposalConflict({ signals: null, heldIdentifiers }),
    /requires signals/);

  /* Explicit empty is legal and means what it says. */
  const empty = resolveIdentity.proposalConflict({ signals: [], heldIdentifiers });
  assert.equal(empty.material, false);
  assert.deepEqual(empty.agreedTypes, []);
  assert.deepEqual(empty.contradictedTypes, []);

  /* Dense evidence for a different business is a material contradiction. */
  const dense = resolveIdentity.proposalConflict({
    signals: resolveIdentity.extractIdentitySignals({ contact: SALON_B }), heldIdentifiers });
  assert.equal(dense.material, true);
});

test('the resolver refuses null signals for either proposal kind, and only when a proposal exists', () => {
  for (const kind of PROPOSAL_KINDS) {
    const proposals = [{ kind, businessId: BUSINESS_A_ID, heldIdentifiers: heldForA() }];

    for (const shape of SIGNAL_SHAPES()) {
      const call = () => resolveIdentity.resolveIdentityProposals({ ...shape.build(), proposals });
      if (shape.throws) {
        let outcome = null;
        assert.throws(() => { outcome = call(); }, /requires signals/, `${kind} ${shape.name}`);
        assert.equal(outcome, null,
          `${kind} ${shape.name}: produced a verdict from evidence nobody supplied`);
      } else {
        assert.doesNotThrow(call, `${kind} ${shape.name}`);
      }
    }

    /* Empty links, because "nothing to compare" is not a contradiction — that
       is the approved rule and it is unchanged. */
    assert.equal(resolveIdentity.resolveIdentityProposals({ signals: [], proposals }).outcome,
      'link', `${kind}: explicit empty still links`);
    /* Dense contradicting evidence does not. */
    assert.equal(resolveIdentity.resolveIdentityProposals({
      signals: resolveIdentity.extractIdentitySignals({ contact: SALON_B }), proposals
    }).outcome, 'review', `${kind}: a contradicted proposal goes to review`);
  }

  /* With NO proposal there is nothing to compare against, and absent signals
     are not an error. Candidate-only resolution is untouched. */
  assert.doesNotThrow(() => resolveIdentity.resolveIdentityProposals({ proposals: [] }));
  assert.equal(resolveIdentity.resolveIdentityProposals({ proposals: [] }).outcome, 'no_proposal');
  assert.equal(resolveIdentity.decideIdentity({ candidates: [] }).action, 'create_new_record');
});

test('null signals cannot produce any decision through a proposal path', () => {
  for (const kind of PROPOSAL_KINDS) {
    const proposals = [{ kind, businessId: BUSINESS_A_ID, heldIdentifiers: heldForA() }];
    for (const build of [() => ({}), () => ({ signals: null })]) {
      let result = null;
      assert.throws(() => {
        result = resolveIdentity.decideIdentity({ ...build(), proposals, candidates: [] });
      }, TypeError, kind);
      assert.equal(result, null,
        `${kind}: decideIdentity returned a decision without evidence`);
    }
  }
});

/* ---------- the same four shapes, through the fake database ---------- */

const A_IDENTIFIERS = [
  { type: 'business_name', normalizedValue: 'salon a' },
  { type: 'email_exact', normalizedValue: 'a@salon.test' }
];

/* Salon B, described the way the audit described it: a different name and a
   different email, with the signals argument varied. */
const B_CONTACT = { salonName: 'Riverside Barber Co', ownerName: 'Someone Else',
                    email: 'someone@riverside.test' };

const ingestB = (db, { signals, sessionId, continuationBusinessId = null }) => {
  const submissionId = randomUUID();
  const birId = randomUUID();
  return {
    submissionId, birId,
    result: db.rpc('ingest_review', {
      p_idempotency_key: submissionId,
      p_request_hash: `hash-${submissionId}`,
      p_payload: makeServiceMixPayload({
        submissionId, assessmentSessionId: sessionId,
        serviceMix: { offerings: makePortfolio() }, contact: B_CONTACT
      }),
      p_signals: signals,
      p_bir: { schemaVersion: 5, reportType: 'service_mix',
        identity: { businessId: null, identityStatus: 'resolution_pending', birId: null,
                    legacyBusinessKey: null },
        provenance: { generatedBy: 'sm-1', supersedes: null, isCurrent: true } },
      p_bir_id: birId, p_retention_days: 30, p_meta: {},
      p_review_type: 'service_mix',
      p_continuation_business_id: continuationBusinessId
    })
  };
};

const seedSalonA = db => {
  const businessId = randomUUID();
  db.seedBusiness({ businessId, displayName: 'Salon A', identifiers: A_IDENTIFIERS });
  return businessId;
};

/* One proposal at a time, so each kind is proven on its own. */
const withProposal = (db, kind, businessId) => {
  const sessionId = randomUUID();
  if (kind === 'session') {
    db.seedSession(sessionId, businessId, 'service_mix');
    return { sessionId, continuationBusinessId: null };
  }
  return { sessionId, continuationBusinessId: businessId };
};

test('the fake database refuses null signals for both proposal kinds', async () => {
  for (const kind of PROPOSAL_KINDS) {
    for (const signals of [null, undefined]) {
      const db = createFakeDb();
      const businessId = seedSalonA(db);
      const where = withProposal(db, kind, businessId);

      const { result } = ingestB(db, { signals, ...where });
      const { data, error } = await result;

      assert.equal(data, null, `${kind} ${signals === null ? 'null' : 'undefined'}`);
      assert.ok(error, `${kind}: must refuse rather than link`);
      assert.match(error.message, /requires signals/, kind);

      /* And it did not link, create, or weaken anything: the transaction is
         gone. One call is one transaction in the fake as in PostgreSQL. */
      assert.deepEqual(db.state.assessment_submissions, [], `${kind}: submission`);
      assert.deepEqual(db.state.business_intelligence_reports, [], `${kind}: BIR`);
      assert.deepEqual(db.state.timeline_events, [], `${kind}: timeline`);
      assert.deepEqual(db.state.audit_events, [], `${kind}: audit`);
      assert.deepEqual(db.state.business_review_states, [], `${kind}: review state`);
      assert.deepEqual(db.state.identity_resolution_cases, [], `${kind}: case`);
      assert.deepEqual(db.state.idempotency_records, [], `${kind}: idempotency record`);

      /* Salon A is exactly as it was. */
      const held = db.state.business_identifiers
        .filter(i => i.business_id === businessId && i.valid_to === null)
        .map(i => i.normalized_value).sort();
      assert.deepEqual(held, ['a@salon.test', 'salon a'], `${kind}: A identifiers`);
      assert.equal(db.state.business_records.length, 1, `${kind}: no record created for B`);
      assert.equal(db.state.business_records[0].current_bir_id, null, `${kind}: A pointer`);

      /* The session row still points where it always did. */
      if (kind === 'session') {
        const [session] = db.state.assessment_sessions;
        assert.equal(session.business_id, businessId, 'session row');
      }

      /* No identifier value reached the message. */
      [B_CONTACT.email, B_CONTACT.salonName, 'a@salon.test', 'salon a']
        .forEach(v => assert.equal(error.message.includes(v), false,
          `${kind}: the message carried ${v}`));
    }
  }
});

test('the fake database keeps explicit empty signals legal, for both kinds', async () => {
  for (const kind of PROPOSAL_KINDS) {
    const db = createFakeDb();
    const businessId = seedSalonA(db);
    const where = withProposal(db, kind, businessId);

    const { data, error } = await ingestB(db, { signals: [], ...where }).result;
    assert.equal(error, null, kind);
    assert.equal(data.businessId, businessId,
      `${kind}: "nothing to compare" is not a contradiction, and still links`);
    assert.equal(data.linkMethod, kind === 'session' ? 'session' : 'continuation_context', kind);
  }
});

test('the fake database still contradicts on dense evidence, for both kinds', async () => {
  for (const kind of PROPOSAL_KINDS) {
    const db = createFakeDb();
    const businessId = seedSalonA(db);
    const where = withProposal(db, kind, businessId);
    const signals = resolveIdentity.persistableSignals(
      resolveIdentity.extractIdentitySignals({ contact: B_CONTACT }));

    const { data, error } = await ingestB(db, { signals, ...where }).result;
    assert.equal(error, null, `${kind}: the visitor still gets a result`);
    assert.equal(data.businessId, null, `${kind}: not filed under Salon A`);
    assert.equal(data.identityStatus, 'resolution_pending', kind);
    assert.equal(data.linkMethod, null, kind);

    const held = db.state.business_identifiers
      .filter(i => i.business_id === businessId && i.valid_to === null)
      .map(i => i.normalized_value);
    assert.equal(held.includes('someone@riverside.test'), false, `${kind}: no contamination`);
  }
});

test('candidate-only ingestion with no proposal is unchanged by any of this', async () => {
  /* No session row and no continuation context: nothing proposes a record, so
     there is nothing to compare against and absent signals are not an error.
     This is the behaviour the repair had to leave alone. */
  const outcomes = [];
  for (const signals of [null, undefined, []]) {
    const db = createFakeDb();
    const { data, error } = await ingestB(db, { signals, sessionId: randomUUID() }).result;
    const label = signals === undefined ? 'undefined' : JSON.stringify(signals);

    assert.equal(error, null, label);
    assert.ok(data.submissionId, label);
    /* No proposal and no candidate match: this is a business nobody has seen
       before, and it gets a record. That is the documented behaviour and the
       repair deliberately did not touch it. */
    assert.ok(data.businessId, label);
    assert.equal(data.identityStatus, 'linked', label);
    assert.equal(data.linkMethod, 'auto', label);
    assert.equal(db.state.business_records.length, 1, label);

    outcomes.push({ status: data.identityStatus, linkMethod: data.linkMethod,
                    linked: data.businessId !== null,
                    records: db.state.business_records.length });
  }

  /* All three shapes answer identically here — the distinction the repair
     introduced exists only where a proposal is being compared against. */
  assert.deepEqual(outcomes[1], outcomes[0], 'undefined differs from null');
  assert.deepEqual(outcomes[2], outcomes[0], 'explicit empty differs from null');
});

test('every signal shape is answered identically by the rule and by the fake database', async () => {
  /* The property, stated once: for each of the four shapes, does the operation
     succeed, and if so does it link? Section T asks real PostgreSQL the same
     four questions and compares the answers to these. */
  const expectations = [
    ['omitted', undefined, { refused: true }],
    ['null', null, { refused: true }],
    ['explicitly empty', [], { refused: false, links: true }],
    ['dense', 'dense', { refused: false, links: false }]
  ];

  for (const kind of PROPOSAL_KINDS) {
    for (const [name, raw, expected] of expectations) {
      const signals = raw === 'dense'
        ? resolveIdentity.persistableSignals(
            resolveIdentity.extractIdentitySignals({ contact: B_CONTACT }))
        : raw;

      /* The shared rule. */
      const proposals = [{ kind, businessId: BUSINESS_A_ID, heldIdentifiers: heldForA() }];
      let ruleRefused = false;
      let ruleOutcome = null;
      try {
        ruleOutcome = resolveIdentity.resolveIdentityProposals({ signals, proposals }).outcome;
      } catch { ruleRefused = true; }

      /* The fake database. */
      const db = createFakeDb();
      const businessId = seedSalonA(db);
      const where = withProposal(db, kind, businessId);
      const { data, error } = await ingestB(db, { signals, ...where }).result;

      assert.equal(ruleRefused, expected.refused, `rule ${kind} ${name}`);
      assert.equal(error !== null, expected.refused, `fake db ${kind} ${name}`);
      assert.equal(ruleRefused, error !== null,
        `${kind} ${name}: the rule and the fake database disagree about refusal`);

      if (!expected.refused) {
        assert.equal(ruleOutcome === 'link', expected.links, `rule ${kind} ${name} link`);
        assert.equal(data.businessId !== null, expected.links, `fake db ${kind} ${name} link`);
        assert.equal(ruleOutcome === 'link', data.businessId !== null,
          `${kind} ${name}: the rule and the fake database disagree about linking`);
      }
    }
  }
});
