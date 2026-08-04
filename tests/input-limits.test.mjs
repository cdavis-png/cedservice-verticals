/* Milestone 1.1 — D (field and shape limits) and E (bounded body reading).

   The concrete failure being prevented: values reaching business_identifiers
   land in btree indexes, which reject an entry over roughly 2704 bytes with
   error 54000. That is NOT a unique_violation, so the ingestion function's
   handler could not catch it and the whole transaction aborted — turning one
   oversized name into a permanent 502 loop for that submission.

   Identity values are rejected, never truncated. A shortened identifier is a
   different identifier, and a different identifier links the wrong business. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { handleRequest } from '../api/assessments.mjs';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload, makeRequest, deps, makeChunkedRequest, chunksOf, ALLOWED_ORIGIN }
  from './helpers/fixtures.mjs';

const require = createRequire(import.meta.url);
const limits = require('../shared/security/limits.js');
const reader = require('../shared/security/read-body.js');

const { LIMITS, CATEGORY } = limits;

const post = async payload => {
  const db = createFakeDb();
  const res = await handleRequest(makeRequest(payload), deps(db));
  return { db, res, body: await res.json() };
};

const rejectsWith = async (payload, category) => {
  const { res, body } = await post(payload);
  assert.equal(res.status, 422, `expected 422 for ${category}`);
  assert.equal(body.error.code, 'payload_limit_exceeded');
  const found = body.error.details.violations.map(v => v.category);
  assert.ok(found.includes(category), `expected ${category}, got ${found.join(', ')}`);
};

const long = n => 'x'.repeat(n);

/* ---------- D. every limit category ---------- */

test('business name over the limit is rejected, not truncated', async () => {
  await rejectsWith(makePayload({ contact: { salonName: long(LIMITS.businessName + 1) } }),
    CATEGORY.businessName);
});

test('owner name over the limit is rejected', async () => {
  await rejectsWith(makePayload({ contact: { ownerName: long(LIMITS.ownerName + 1) } }),
    CATEGORY.ownerName);
});

test('email over the limit is rejected', async () => {
  const local = long(LIMITS.email);
  await rejectsWith(makePayload({ contact: { email: `${local}@polished.test` } }), CATEGORY.email);
});

test('mobile over the limit is rejected', async () => {
  await rejectsWith(makePayload({ contact: { mobile: long(LIMITS.mobile + 1) } }), CATEGORY.mobile);
});

test('website over the limit is rejected', async () => {
  await rejectsWith(makePayload({ contact: { website: long(LIMITS.website + 1) } }), CATEGORY.website);
});

test('Google Business Profile identifier over the limit is rejected', async () => {
  await rejectsWith(makePayload({ contact: { googlePlaceId: long(LIMITS.gbpPlaceId + 1) } }),
    CATEGORY.gbpPlaceId);
});

test('an attribution URL over the limit is rejected', async () => {
  await rejectsWith(makePayload({ attribution: { firstTouch: { url: long(LIMITS.url + 1) } } }),
    CATEGORY.url);
});

test('a referrer over the limit is rejected', async () => {
  await rejectsWith(makePayload({ attribution: { latestTouch: { referrer: long(LIMITS.referrer + 1) } } }),
    CATEGORY.referrer);
});

test('a UTM name over the limit is rejected', async () => {
  const utm = { [long(LIMITS.utmName + 1)]: 'qr' };
  await rejectsWith(makePayload({ attribution: { firstTouch: { utm } } }), CATEGORY.utmName);
});

test('a UTM value over the limit is rejected', async () => {
  await rejectsWith(makePayload({ attribution: { firstTouch: { utm: { utm_source: long(LIMITS.utmValue + 1) } } } }),
    CATEGORY.utmValue);
});

test('too many UTM parameters are rejected', async () => {
  const utm = {};
  for (let i = 0; i <= LIMITS.utmCount; i++) utm[`utm_${i}`] = 'v';
  await rejectsWith(makePayload({ attribution: { firstTouch: { utm } } }), CATEGORY.utmCount);
});

test('an answer key over the limit is rejected', async () => {
  await rejectsWith(makePayload({ answers: { [long(LIMITS.answerKey + 1)]: 'v' } }), CATEGORY.answerKey);
});

test('an answer value over the limit is rejected', async () => {
  await rejectsWith(makePayload({ answers: { challenge: long(LIMITS.answerValue + 1) } }),
    CATEGORY.answerValue);
});

test('too many answers are rejected', async () => {
  const answers = {};
  for (let i = 0; i <= LIMITS.answerCount; i++) answers[`a${i}`] = 'v';
  await rejectsWith(makePayload({ answers }), CATEGORY.answerCount);
});

test('a consent statement over the limit is rejected', async () => {
  await rejectsWith(
    makePayload({ consent: { resultsDeliveryConsent: { statement: long(LIMITS.consentStatement + 1) } } }),
    CATEGORY.consentStatement);
});

test('recommendation copy over the limit is rejected', async () => {
  await rejectsWith(makePayload({ results: { recommendedPackage: { reason: long(LIMITS.recommendationCopy + 1) } } }),
    CATEGORY.recommendationCopy);
});

test('a priority over the length limit is rejected', async () => {
  await rejectsWith(makePayload({ results: { priorities: [long(LIMITS.priorityText + 1)] } }),
    CATEGORY.priorityText);
});

test('too many priorities are rejected', async () => {
  await rejectsWith(makePayload({ results: { priorities: Array(LIMITS.priorityCount + 1).fill('p') } }),
    CATEGORY.priorityCount);
});

test('a disclaimer over the limit is rejected', async () => {
  await rejectsWith(makePayload({ results: { disclaimer: long(LIMITS.disclaimer + 1) } }),
    CATEGORY.disclaimer);
});

/* ---------- structural bounds ---------- */

test('excessive nesting depth is rejected without exhausting the stack', async () => {
  let nested = { end: true };
  for (let i = 0; i < LIMITS.maxDepth + 5; i++) nested = { next: nested };
  await rejectsWith(makePayload({ answers: { deep: 'x' }, results: { extra: nested } }), CATEGORY.depth);
});

test('an over-long array is rejected', async () => {
  await rejectsWith(makePayload({ results: { extras: Array(LIMITS.maxArrayLength + 1).fill(1) } }),
    CATEGORY.arrayLength);
});

test('too many total nodes are rejected', async () => {
  const wide = {};
  for (let i = 0; i < LIMITS.maxNodes + 50; i++) wide[`k${i}`] = i;
  await rejectsWith(makePayload({ results: { extras: wide } }), CATEGORY.nodes);
});

test('an over-long object key is rejected', async () => {
  await rejectsWith(makePayload({ results: { [long(LIMITS.maxKeyLength + 1)]: 'v' } }), CATEGORY.keyLength);
});

test('a very deep body does not throw a RangeError', () => {
  let nested = {};
  let cursor = nested;
  for (let i = 0; i < 50000; i++) { cursor.next = {}; cursor = cursor.next; }
  const violations = limits.checkPayloadLimits({ contact: {}, deep: nested });
  assert.ok(violations.length > 0, 'rejected rather than crashed');
  assert.equal(violations[0].category, CATEGORY.depth);
});

test('a valid payload produces no violations', () => {
  assert.deepEqual(limits.checkPayloadLimits(makePayload()), []);
});

test('identifier format and length are both enforced', () => {
  assert.equal(limits.isAcceptableIdentifier('gbp_place_id', 'ChIJ_valid_id'), true);
  assert.equal(limits.isAcceptableIdentifier('gbp_place_id', 'has spaces'), false);
  assert.equal(limits.isAcceptableIdentifier('gbp_place_id', long(200)), false, 'over the format bound');
  assert.equal(limits.isAcceptableIdentifier('business_name', long(LIMITS.identifierValue + 1)), false);
  assert.equal(limits.isAcceptableIdentifier('business_name', 'polished nail studio'), true);
});

test('the two identifier-format tables agree', () => {
  /* resolve-identity.js keeps its own copy so it stays loadable as a classic
     script without depending on load order in the browser. Duplication is
     acceptable; silent divergence is not. */
  const resolver = require('../shared/business-record/resolve-identity.js');

  assert.equal(resolver.MAX_IDENTIFIER_LENGTH, LIMITS.identifierValue);
  assert.deepEqual(
    Object.keys(resolver.IDENTIFIER_FORMATS).sort(),
    Object.keys(limits.FORMATS).sort());
  Object.keys(limits.FORMATS).forEach(type => {
    assert.equal(String(resolver.IDENTIFIER_FORMATS[type]), String(limits.FORMATS[type]),
      `${type} format differs between limits.js and resolve-identity.js`);
  });
});

test('a name at the btree danger size never reaches an identifier', async () => {
  /* 3000 characters would exceed the btree index entry limit in Postgres. */
  const { res, db } = await post(makePayload({ contact: { salonName: long(3000) } }));
  assert.equal(res.status, 422);
  assert.equal(db.state.business_identifiers.length, 0, 'nothing was written');
  assert.equal(db.state.business_records.length, 0);
});

/* ---------- E. bounded body reading ---------- */

const streamOf = (chunks, opts = {}) => makeChunkedRequest(chunks, opts);

test('a chunked body under the limit is read intact', async () => {
  const text = JSON.stringify({ hello: 'world' });
  const result = await reader.readBoundedBody(streamOf(chunksOf(text, 3)), 65536);
  assert.equal(result.ok, true);
  assert.equal(result.text, text);
});

test('a chunked body over the limit is refused mid-stream', async () => {
  const request = streamOf(chunksOf('y'.repeat(4000), 100));
  const result = await reader.readBoundedBody(request, 500);

  assert.equal(result.outcome, reader.OUTCOME.tooLarge);
  assert.equal(result.declared, false, 'no Content-Length was present');
  assert.ok(request.bytesDelivered() < 40,
    `stopped early: pulled ${request.bytesDelivered()} of 40 chunks`);
});

test('a body with no Content-Length is still bounded', async () => {
  const request = streamOf(chunksOf('z'.repeat(2000), 250));
  assert.equal(request.headers.get('content-length'), null);
  const result = await reader.readBoundedBody(request, 300);
  assert.equal(result.outcome, reader.OUTCOME.tooLarge);
});

test('a lying Content-Length does not get past the byte counter', async () => {
  const request = streamOf(chunksOf('q'.repeat(5000), 500), { declaredLength: 10 });
  const result = await reader.readBoundedBody(request, 1000);
  assert.equal(result.outcome, reader.OUTCOME.tooLarge, 'the declared length was a lie');
});

test('an oversized Content-Length is refused before the stream opens', async () => {
  const request = streamOf(['{}'], { declaredLength: 999999 });
  const result = await reader.readBoundedBody(request, 1000);
  assert.equal(result.outcome, reader.OUTCOME.tooLarge);
  assert.equal(result.declared, true);
  assert.equal(request.bytesDelivered(), 0, 'the body was never read');
});

test('malformed UTF-8 is rejected rather than silently replaced', async () => {
  const bad = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
  const result = await reader.readBoundedBody(streamOf([bad]), 1000);
  assert.equal(result.outcome, reader.OUTCOME.invalidEncoding);
});

test('oversized bodies are never parsed as JSON', async () => {
  const huge = JSON.stringify({ a: 'w'.repeat(5000) });
  const result = await reader.readBoundedBody(streamOf(chunksOf(huge, 200)), 500);
  assert.equal(result.outcome, reader.OUTCOME.tooLarge);
  assert.equal(result.text, undefined, 'no text is produced, so nothing can parse it');
});

test('malformed JSON is a safe result, not a throw', () => {
  assert.deepEqual(reader.parseJsonSafely('{not json'), { ok: false, value: null });
  assert.deepEqual(reader.parseJsonSafely('{"a":1}'), { ok: true, value: { a: 1 } });
});

test('the endpoint answers 413 for an oversized chunked body', async () => {
  const db = createFakeDb();
  const payload = makePayload();
  payload.answers.filler = 'p'.repeat(4000);
  const text = JSON.stringify(payload);

  const request = makeChunkedRequest(chunksOf(text, 256), {
    origin: ALLOWED_ORIGIN,
    idempotencyKey: payload.submissionId
  });
  const res = await handleRequest(request, deps(db, {
    env: { ...deps(db).env, CED_MAX_REQUEST_BYTES: '1024' }
  }));
  const body = await res.json();

  assert.equal(res.status, 413);
  assert.equal(body.error.code, 'payload_too_large');
  assert.equal(db.state.assessment_submissions.length, 0);
});

test('request-size and field-size enforcement are independent', async () => {
  /* Comfortably inside the byte budget, but one field is far too long. */
  const payload = makePayload({ contact: { ownerName: long(LIMITS.ownerName + 1) } });
  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  assert.ok(size < 65536, 'the request itself is not oversized');

  const { res, body } = await post(payload);
  assert.equal(res.status, 422, 'rejected on the field limit, not the request limit');
  assert.equal(body.error.code, 'payload_limit_exceeded');
});

test('limit violations report lengths, never values', async () => {
  const secret = 'SENSITIVE-' + long(LIMITS.ownerName);
  const { body } = await post(makePayload({ contact: { ownerName: secret } }));
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes('SENSITIVE'), 'the offending value is never echoed back');
  assert.ok(body.error.details.violations[0].actual > body.error.details.violations[0].limit);
});
