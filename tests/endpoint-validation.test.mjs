import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../api/assessments.mjs';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload, makeRequest, deps, ALLOWED_ORIGIN, ENV } from './helpers/fixtures.mjs';

const post = async (payload, reqOpts = {}, dbOpts = {}) => {
  const db = createFakeDb(dbOpts);
  const res = await handleRequest(makeRequest(payload, reqOpts), deps(db));
  const body = res.status === 204 ? null : await res.json();
  return { res, body, db };
};

test('CORS preflight returns 204 with exact headers for an allowed origin', async () => {
  const db = createFakeDb();
  const res = await handleRequest(makeRequest(undefined, { method: 'OPTIONS' }), deps(db));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.match(res.headers.get('access-control-allow-headers'), /Idempotency-Key/);
  assert.equal(res.headers.get('vary'), 'Origin');
});

test('disallowed Origin is rejected and receives no CORS grant', async () => {
  const { res, body } = await post(makePayload(), { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(body.error.code, 'origin_not_allowed');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('unsupported methods are rejected with Allow', async () => {
  const db = createFakeDb();
  const res = await handleRequest(makeRequest(undefined, { method: 'GET' }), deps(db));
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST, OPTIONS');
});

test('non-JSON Content-Type is rejected', async () => {
  const { res, body } = await post(makePayload(), { contentType: 'text/plain' });
  assert.equal(res.status, 415);
  assert.equal(body.error.code, 'unsupported_media_type');
});

test('oversized bodies are rejected before parsing', async () => {
  const db = createFakeDb();
  const payload = makePayload();
  const req = makeRequest(payload, { extraHeaders: { 'content-length': '999999' } });
  const res = await handleRequest(req, deps(db, { env: { ...ENV, CED_MAX_REQUEST_BYTES: '1024' } }));
  assert.equal(res.status, 413);
  assert.equal(db.state.assessment_submissions.length, 0);
});

test('missing Idempotency-Key is rejected', async () => {
  const { res, body } = await post(makePayload(), { idempotencyKey: null });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'missing_idempotency_key');
});

test('Idempotency-Key that does not equal submissionId is rejected', async () => {
  const { res, body, db } = await post(makePayload(), {
    idempotencyKey: '99999999-9999-4999-8999-999999999999'
  });
  assert.equal(res.status, 409);
  assert.equal(body.error.code, 'idempotency_key_mismatch');
  assert.equal(db.state.assessment_submissions.length, 0);
});

test('malformed JSON is rejected', async () => {
  const db = createFakeDb();
  const req = makeRequest(undefined, {
    body: '{not json', idempotencyKey: '22222222-2222-4222-8222-222222222222'
  });
  const res = await handleRequest(req, deps(db));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'malformed_json');
});

test('malformed UUIDs are rejected', async () => {
  for (const [field, value, code] of [
    ['submissionId', 'not-a-uuid', 'invalid_submission_id'],
    ['assessmentSessionId', '123', 'invalid_session_id']
  ]) {
    const payload = makePayload({ [field]: value });
    const { res, body } = await post(payload, { idempotencyKey: payload.submissionId });
    assert.equal(res.status, 400, field);
    assert.equal(body.error.code, code);
  }
});

test('a retired payload schemaVersion is rejected', async () => {
  const { res, body } = await post(makePayload({ schemaVersion: 1 }));
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'unsupported_version');
  assert.equal(body.error.details.reason, 'retired');
});

test('invalid assessmentVersion is rejected', async () => {
  const { res, body } = await post(makePayload({ assessmentVersion: 'latest' }));
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'invalid_assessment_version');
});

test('unsupported vertical is rejected', async () => {
  const { res, body } = await post(makePayload({ vertical: { id: 'submarines' } }));
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'unsupported_vertical');
});

test('missing results-delivery consent is rejected and stores nothing', async () => {
  const { res, body, db } = await post(makePayload({
    consent: { resultsDeliveryConsent: { granted: false, statement: 'x'.repeat(20) } }
  }));
  assert.equal(res.status, 422);
  assert.equal(body.error.code, 'results_consent_required');
  assert.equal(db.state.assessment_submissions.length, 0);
  assert.equal(db.state.business_records.length, 0);
});

test('consent without the exact statement shown is rejected', async () => {
  const { res, body } = await post(makePayload({
    consent: { resultsDeliveryConsent: { granted: true, statement: '' } }
  }));
  assert.equal(res.status, 422);
  assert.equal(body.error.code, 'consent_statement_missing');
});

test('prohibited data anywhere in the payload is rejected', async () => {
  for (const answers of [
    { cardNumber: '4111111111111111' },
    { patient_diagnosis: 'x' },
    { stripe_api_key: 'sk_test' }
  ]) {
    const { res, body, db } = await post(makePayload({ answers }));
    assert.equal(res.status, 422, JSON.stringify(answers));
    assert.equal(body.error.code, 'prohibited_data');
    assert.ok(body.error.details.fields.length > 0);
    assert.equal(db.state.assessment_submissions.length, 0);
  }
});

test('invalid scores and opportunity values are rejected', async () => {
  const cases = [
    [{ results: { score: 140 } }, 'invalid_score'],
    [{ results: { score: 26.5 } }, 'invalid_score'],
    [{ results: { opportunity: -10 } }, 'invalid_opportunity'],
    [{ results: { opportunity: Number.MAX_SAFE_INTEGER } }, 'invalid_opportunity'],
    [{ results: { dimensions: { retention: 900 } } }, 'invalid_dimension_value'],
    [{ results: { priorities: [] } }, 'invalid_priorities'],
    [{ results: { disclaimer: '' } }, 'missing_disclaimer'],
    [{ results: { recommendedPackage: { id: 'x', label: 'y', price: -1 } } }, 'invalid_package_price']
  ];
  for (const [patch, code] of cases) {
    const { res, body } = await post(makePayload(patch));
    assert.equal(res.status, 400, code);
    assert.equal(body.error.code, code);
  }
});

test('invalid timestamps are rejected', async () => {
  for (const [submittedAt, code] of [
    ['not-a-date', 'invalid_submitted_at'],
    ['2027-01-01T00:00:00.000Z', 'submitted_at_in_future'],
    ['2020-01-01T00:00:00.000Z', 'submitted_at_too_old']
  ]) {
    const { res, body } = await post(makePayload({ submittedAt }));
    assert.equal(res.status, 400, code);
    assert.equal(body.error.code, code);
  }
});

test('missing required sections are rejected', async () => {
  for (const section of ['contact', 'consent', 'answers', 'results', 'attribution']) {
    const payload = makePayload();
    delete payload[section];
    const { res, body } = await post(payload);
    assert.equal(res.status, 400, section);
    assert.equal(body.error.code, 'missing_section');
  }
});

test('error responses never leak internals', async () => {
  const db = createFakeDb({ failAt: 'timeline' });
  const res = await handleRequest(makeRequest(makePayload()), deps(db));
  const text = JSON.stringify(await res.json());
  assert.equal(res.status, 502);
  assert.doesNotMatch(text, /injected_failure|at .*\.mjs|insert into|SUPABASE|service_role|stack/i);
});
