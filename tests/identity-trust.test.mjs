/* Milestone 1.1 — G (identifier trust model) and K (candidate lookup shape).

   Before this milestone a strong identifier was authoritative regardless of
   where it came from. On a public, unauthenticated endpoint that meant anyone
   could type a Google Business Profile id into a form and attach themselves
   to any business — and, because the value was globally unique, squat it so
   the real owner could never claim it.

   Strength and trust are now separate. Automatic linking requires both. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { handleRequest } from '../api/assessments.mjs';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload, makeRequest, deps } from './helpers/fixtures.mjs';

const require = createRequire(import.meta.url);
const identity = require('../shared/business-record/resolve-identity.js');

const send = async (db, payload) => {
  const res = await handleRequest(makeRequest(payload), deps(db));
  return { res, body: await res.json() };
};

const fresh = over => makePayload({
  assessmentSessionId: randomUUID(), submissionId: randomUUID(), ...over
});

const verifiedId = (type, value) => ({
  type, normalizedValue: value, verified: true,
  source: 'trusted_integration', verificationMethod: 'integration_callback'
});
const claimedId = (type, value) => ({
  type, normalizedValue: value, verified: false, source: 'visitor_supplied'
});

/* ---------- provenance on every signal ---------- */

test('every extracted signal carries source, verified, method and evidence', () => {
  const signals = identity.extractIdentitySignals(makePayload({
    contact: { googlePlaceId: 'ChIJ_visitor_claim', website: 'https://polished.test' }
  }));
  assert.ok(signals.length > 0);
  signals.forEach(s => {
    assert.equal(s.source, 'visitor_supplied');
    assert.equal(s.verified, false);
    assert.equal(s.verificationMethod, 'none');
    assert.equal(s.verificationEvidence, null);
    assert.equal(typeof s.autoLinkable, 'boolean');
  });
});

test('nothing a public form supplies is ever auto-linkable', () => {
  const signals = identity.extractIdentitySignals(makePayload({
    contact: { googlePlaceId: 'ChIJ_visitor_claim', externalCustomerId: 'cus_1234' }
  }));
  assert.ok(signals.some(s => s.type === 'gbp_place_id'), 'the claim is still recorded as evidence');
  signals.forEach(s => assert.equal(s.autoLinkable, false));
});

test('auto-linkability requires strong AND verified AND a trusted source', () => {
  const link = (type, source, verified) => identity.canAutoLink({ type, source, verified });
  assert.equal(link('gbp_place_id', 'trusted_integration', true), true);
  assert.equal(link('gbp_place_id', 'visitor_supplied', true), false, 'untrusted source');
  assert.equal(link('gbp_place_id', 'trusted_integration', false), false, 'unverified');
  assert.equal(link('email_exact', 'trusted_integration', true), false, 'not a strong type');
});

/* ---------- identifier validation ---------- */

test('a malformed identifier never becomes a signal', () => {
  const signals = identity.extractIdentitySignals(makePayload({
    contact: { googlePlaceId: 'has spaces and $ymbols!' }
  }));
  assert.equal(signals.some(s => s.type === 'gbp_place_id'), false);
});

test('an over-long identifier never becomes a signal', () => {
  const signals = identity.extractIdentitySignals(makePayload({
    contact: { googlePlaceId: 'C'.repeat(500) }
  }));
  assert.equal(signals.some(s => s.type === 'gbp_place_id'), false);
});

test('identifier formats are enforced per type', () => {
  assert.equal(identity.isAcceptableValue('gbp_place_id', 'ChIJ-abc_123'), true);
  assert.equal(identity.isAcceptableValue('gbp_place_id', 'ab'), false, 'too short for the format');
  assert.equal(identity.isAcceptableValue('external_customer_id', 'cus:abc.123'), true);
  assert.equal(identity.isAcceptableValue('business_name', 'x'.repeat(257)), false);
});

/* ---------- claimed identifiers cannot link ---------- */

test('a claimed GBP id does not auto-link', async () => {
  const db = createFakeDb();
  const existing = db.seedBusiness({ identifiers: [claimedId('gbp_place_id', 'ChIJ_target')] });

  const { body } = await send(db, fresh({ contact: { googlePlaceId: 'ChIJ_target' } }));

  assert.equal(body.identityStatus, 'resolution_pending');
  assert.equal(body.businessId, null, 'never links on an unverified claim');
  assert.equal(db.state.business_records.length, 1, 'and never creates a duplicate either');
  const opened = db.state.identity_resolution_cases[0];
  assert.equal(opened.resolution_status, 'manual_review_required');
  assert.ok(opened.assessment_submission_id);
  assert.ok(existing);
});

test('a verified GBP id may auto-link', async () => {
  const db = createFakeDb();
  const existing = db.seedBusiness({ identifiers: [verifiedId('gbp_place_id', 'ChIJ_target')] });

  const { body } = await send(db, fresh({ contact: { googlePlaceId: 'ChIJ_target' } }));

  assert.equal(body.identityStatus, 'linked');
  assert.equal(body.businessId, existing);
  assert.equal(db.state.business_records.length, 1);
  assert.equal(db.state.identity_resolution_cases.length, 0);
});

test('a claimed external customer id does not auto-link', async () => {
  const db = createFakeDb();
  db.seedBusiness({ identifiers: [claimedId('external_customer_id', 'cus_abc123')] });
  const { body } = await send(db, fresh({ contact: { externalCustomerId: 'cus_abc123' } }));
  assert.equal(body.identityStatus, 'resolution_pending');
  assert.equal(body.businessId, null);
});

test('a trusted external customer id may auto-link', async () => {
  const db = createFakeDb();
  const existing = db.seedBusiness({ identifiers: [verifiedId('external_customer_id', 'cus_abc123')] });
  const { body } = await send(db, fresh({ contact: { externalCustomerId: 'cus_abc123' } }));
  assert.equal(body.identityStatus, 'linked');
  assert.equal(body.businessId, existing);
});

test('conflicting verified identifiers produce resolution_pending', async () => {
  const db = createFakeDb();
  db.seedBusiness({ identifiers: [verifiedId('gbp_place_id', 'ChIJ_a')] });
  db.seedBusiness({ identifiers: [verifiedId('external_customer_id', 'cus_b')] });

  const { body } = await send(db, fresh({
    contact: { googlePlaceId: 'ChIJ_a', externalCustomerId: 'cus_b' }
  }));

  assert.equal(body.identityStatus, 'resolution_pending');
  assert.equal(body.businessId, null);
  assert.equal(db.state.business_records.length, 2, 'no third record');
  assert.equal(db.state.identity_resolution_cases[0].resolution_status, 'possible_duplicate');
});

test('no auto-merge exists under any condition', async () => {
  assert.equal(typeof identity.merge, 'undefined');
  assert.equal(typeof identity.autoMerge, 'undefined');
  assert.equal(typeof identity.mayAutoMerge, 'undefined');
  assert.ok(!identity.RESOLUTION_ACTIONS.includes('merge'));
  assert.ok(!identity.RESOLUTION_ACTIONS.includes('propose_merge'));

  const db = createFakeDb();
  db.seedBusiness({ identifiers: [verifiedId('gbp_place_id', 'ChIJ_a')] });
  db.seedBusiness({ identifiers: [verifiedId('external_customer_id', 'cus_b')] });
  await send(db, fresh({ contact: { googlePlaceId: 'ChIJ_a', externalCustomerId: 'cus_b' } }));

  assert.equal(db.state.timeline_events.filter(e => e.event_name === 'business.merged').length, 0);
  db.state.business_records.forEach(r => assert.equal(r.merged_into_business_id, null));
});

/* ---------- squatting cannot reserve an identifier ---------- */

test('a squatted identifier does not block the real owner', async () => {
  const db = createFakeDb();

  /* A bot claims a place id it does not own. */
  const squatter = await send(db, fresh({ contact: { googlePlaceId: 'ChIJ_contested' } }));
  assert.equal(squatter.body.identityStatus, 'linked', 'a new record is created for it');
  const claimed = db.state.business_identifiers.find(i => i.identifier_type === 'gbp_place_id');
  assert.equal(claimed.verified, false, 'stored as an unverified claim');

  /* The real owner is later verified against the same value. The uniqueness
     backstop covers verified rows only, so nothing blocks this. */
  assert.doesNotThrow(() => db.seedBusiness({
    identifiers: [verifiedId('gbp_place_id', 'ChIJ_contested')]
  }), 'an unverified claim must not reserve the value');
});

test('two verified holders of one identifier remain impossible', () => {
  const db = createFakeDb();
  db.seedBusiness({ identifiers: [verifiedId('gbp_place_id', 'ChIJ_unique')] });
  assert.throws(() => db.seedBusiness({ identifiers: [verifiedId('gbp_place_id', 'ChIJ_unique')] }),
    /verified_strong_unique/, 'the database backstop still holds for verified identifiers');
});

/* ---------- cross-business conflicts are surfaced, not swallowed ---------- */

test('a claim on another business’s verified identifier opens a review case', async () => {
  const db = createFakeDb();
  const owner = db.seedBusiness({
    displayName: 'Real Owner',
    identifiers: [verifiedId('external_customer_id', 'cus_owned')]
  });
  /* This session already belongs to a different business, so identity is
     settled and the claim is pure conflict. */
  const sessionId = randomUUID();
  const other = db.seedBusiness({ displayName: 'Someone Else' });
  db.seedSession(sessionId, other);

  const { body } = await send(db, makePayload({
    assessmentSessionId: sessionId, submissionId: randomUUID(),
    contact: { externalCustomerId: 'cus_owned' }
  }));

  assert.equal(body.businessId, other, 'the session still resolves identity');
  assert.equal(db.state.identity_resolution_cases.length, 1, 'the collision is not swallowed');

  const conflict = db.state.identity_resolution_cases[0].conflicting_signals
    .find(c => c.identifierType === 'external_customer_id');
  assert.equal(conflict.heldByBusinessId, owner);
  assert.equal(conflict.claimSource, 'visitor_supplied');

  const written = db.state.business_identifiers.filter(i =>
    i.business_id === other && i.identifier_type === 'external_customer_id');
  assert.equal(written.length, 0, 'the contested claim is reported, never written');

  const event = db.state.timeline_events.find(e => e.event_name === 'identity.review_required');
  assert.match(event.summary, /already held, verified, by another business/);
});

/* ---------- K. lookup shape and context signals ---------- */

test('context signals are never persisted as identity', async () => {
  const db = createFakeDb();
  await send(db, fresh());

  const types = db.state.business_identifiers.map(i => i.identifier_type);
  assert.ok(!types.includes('vertical'), 'a row per business saying "nails" is not evidence');
  assert.ok(!types.includes('locality'));
  assert.ok(types.includes('email_exact'), 'real evidence is still recorded');
});

test('the vertical is preserved as context on the business record', async () => {
  const db = createFakeDb();
  const { body } = await send(db, fresh());
  const record = db.state.business_records.find(b => b.business_id === body.businessId);
  assert.equal(record.vertical_id, 'nails', 'context lives where it belongs');
});

test('the endpoint sends only persistable signals to the database', () => {
  const all = identity.extractIdentitySignals(makePayload());
  const persistable = identity.persistableSignals(all);
  assert.ok(all.some(s => s.type === 'vertical'), 'context is extracted for narrowing');
  assert.ok(!persistable.some(s => identity.CONTEXT_TYPES.includes(s.type)),
    'but never handed to the writer');
});

test('candidate matching keys on identifier type and normalized value together', async () => {
  const db = createFakeDb();
  /* Same value, different type: must not match. */
  db.seedBusiness({ identifiers: [verifiedId('external_customer_id', 'owner@polished.test')] });

  const { body } = await send(db, fresh());
  assert.equal(db.state.business_records.length, 2,
    'an email value under a different identifier type is not the same identifier');
  assert.equal(body.identityStatus, 'linked');
});

test('weak signals still never link, alone or combined', async () => {
  const db = createFakeDb();
  db.seedBusiness({
    identifiers: [
      claimedId('email_exact', 'owner@polished.test'),
      claimedId('business_name', 'polished nail studio'),
      claimedId('mobile_phone', '+18645550134')
    ]
  });

  const { body } = await send(db, fresh({ contact: { mobile: '864-555-0134' } }));
  assert.equal(body.identityStatus, 'resolution_pending', 'three weak matches are still weak');
  assert.equal(body.businessId, null);
  assert.equal(db.state.business_records.length, 1, 'and no duplicate is created');
});
