/* Milestone 1.1 — A (timestamp/constraint conflict), C (freshness window),
   I (timeout behaviour).

   The bug these exist for: the endpoint accepted submittedAt up to five
   minutes in the future, while timeline_events enforces
   recorded_at >= occurred_at. A device clock one second fast therefore
   aborted the whole ingestion transaction. The previous test double did not
   model CHECK constraints, so nothing caught it. fake-db.mjs now enforces
   that constraint, which is what makes these assertions mean anything. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handleRequest } from '../api/assessments.mjs';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload, makeRequest, deps, NOW_MS } from './helpers/fixtures.mjs';

const DAY = 86400000;

const at = offsetMs => new Date(NOW_MS + offsetMs).toISOString();

const sendAt = async (offsetMs, extra = {}) => {
  const db = createFakeDb();
  const payload = makePayload({
    submittedAt: at(offsetMs),
    assessmentSessionId: randomUUID(),
    submissionId: randomUUID(),
    ...extra
  });
  const res = await handleRequest(makeRequest(payload), deps(db));
  return { db, res, body: await res.json(), payload };
};

/* ---------- A. clock skew ---------- */

test('exact server time ingests and records no skew', async () => {
  const { res, body, db } = await sendAt(0);
  assert.equal(res.status, 201);
  assert.equal(body.clockSkewDetected, false);

  const completed = db.state.timeline_events.find(e => e.event_name === 'assessment.completed');
  assert.equal(Date.parse(completed.occurred_at), NOW_MS);
  assert.ok(Date.parse(completed.recorded_at) >= Date.parse(completed.occurred_at));
});

test('a device clock one second fast ingests instead of aborting', async () => {
  const { res, body, db, payload } = await sendAt(1000);
  assert.equal(res.status, 201, 'one second of skew must not abort ingestion');
  assert.equal(body.clockSkewDetected, false, 'one second is inside the detection grace');

  /* The timeline is clamped to server time; the visitor's own value survives. */
  const completed = db.state.timeline_events.find(e => e.event_name === 'assessment.completed');
  assert.equal(Date.parse(completed.occurred_at), NOW_MS, 'clamped, not the future value');
  const stored = db.state.assessment_submissions[0];
  assert.equal(stored.submitted_at, payload.submittedAt, 'submittedAt preserved verbatim');
  assert.equal(stored.raw_payload.submittedAt, payload.submittedAt);
});

test('a device clock four minutes fast ingests, is clamped, and is flagged', async () => {
  const { res, body, db } = await sendAt(4 * 60 * 1000);
  assert.equal(res.status, 201);
  assert.equal(body.clockSkewDetected, true);

  db.state.timeline_events.forEach(e => {
    assert.ok(Date.parse(e.recorded_at) >= Date.parse(e.occurred_at),
      `${e.event_name} must satisfy recorded_at >= occurred_at`);
    assert.ok(Date.parse(e.occurred_at) <= NOW_MS, `${e.event_name} is not in the future`);
  });

  const meta = db.state.assessment_submissions[0].ingest_meta;
  assert.equal(meta.clockSkewDetected, true);
  assert.equal(meta.timelineTimestampClamped, true);
  assert.equal(Date.parse(meta.originalSubmittedAt), NOW_MS + 4 * 60 * 1000);
  assert.equal(Date.parse(meta.timelineOccurredAt), NOW_MS);
  assert.ok(meta.correlationId, 'the clamp is traceable');
});

test('beyond the permitted future-skew window the timestamp is refused', async () => {
  const { res, body } = await sendAt(5 * 60 * 1000 + 1000);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'submitted_at_in_future');
});

test('every timeline row satisfies the constraint under maximum tolerated skew', async () => {
  const { db, res } = await sendAt(5 * 60 * 1000 - 1);
  assert.equal(res.status, 201);
  assert.ok(db.state.timeline_events.length >= 5);
  db.state.timeline_events.forEach(e => {
    assert.ok(Date.parse(e.recorded_at) >= Date.parse(e.occurred_at), e.event_name);
  });
});

/* ---------- C. freshness aligned with the 30-day browser queue ---------- */

test('a 29-day-old queued submission is still accepted', async () => {
  const { res, body } = await sendAt(-29 * DAY);
  assert.equal(res.status, 201, 'the browser queue keeps entries for 30 days');
  assert.equal(body.ok, true);
});

test('a submission at just under 30 days is accepted', async () => {
  const { res } = await sendAt(-(30 * DAY) + 60000);
  assert.equal(res.status, 201);
});

test('a submission older than the configured window is refused', async () => {
  const { res, body } = await sendAt(-(30 * DAY) - 60000);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'submitted_at_too_old');
});

test('the freshness window is configurable', async () => {
  const db = createFakeDb();
  const payload = makePayload({ submittedAt: at(-40 * DAY) });
  const res = await handleRequest(makeRequest(payload), deps(db, {
    env: { ...deps(db).env, CED_SUBMISSION_MAX_AGE_DAYS: '60' }
  }));
  assert.equal(res.status, 201, 'a longer window accepts an older submission');
});

test('an old queued submission keeps submittedAt as the completion time', async () => {
  const { db, payload } = await sendAt(-20 * DAY);
  const stored = db.state.assessment_submissions[0];
  assert.equal(stored.submitted_at, payload.submittedAt, 'completion time, unchanged');
  assert.notEqual(stored.received_at, stored.submitted_at, 'receivedAt is a separate fact');
  assert.equal(Date.parse(stored.received_at), NOW_MS);
});

/* ---------- I. timeout behaviour ---------- */

test('a database that never answers produces a timeout, not a hang', async () => {
  const db = createFakeDb();
  const stalling = {
    ...db,
    rpc: async (name, args) => {
      if (name === 'ingest_assessment') return new Promise(() => {});  /* never settles */
      return db.rpc(name, args);
    }
  };

  const res = await handleRequest(makeRequest(makePayload()), deps(stalling, {
    env: { ...deps(db).env, CED_DB_TIMEOUT_MS: '40' }
  }));
  const body = await res.json();

  assert.equal(res.status, 504);
  assert.equal(body.error.code, 'ingestion_timeout');
  assert.equal(res.headers.get('retry-after'), '15');
  assert.ok(body.error.correlationId, 'a timeout is traceable');
});

test('the documented timeout ordering holds: challenge < database < client', async () => {
  const { TIMEOUTS } = await import('../api/assessments.mjs');
  const submission = await import('../shared/assessment-engine/submission.js');

  assert.ok(TIMEOUTS.DEFAULT_CHALLENGE_TIMEOUT_MS < TIMEOUTS.DEFAULT_DB_TIMEOUT_MS,
    'challenge must give up before the database does');
  assert.ok(TIMEOUTS.DEFAULT_DB_TIMEOUT_MS < submission.default.DEFAULTS.timeoutMs,
    'the client must outwait the whole server budget');
});

test('a correlation id is returned on failure and on success', async () => {
  const db = createFakeDb();
  const ok = await handleRequest(makeRequest(makePayload()), deps(db));
  const okBody = await ok.json();
  assert.ok(okBody.correlationId);
  assert.equal(ok.headers.get('x-correlation-id'), okBody.correlationId);

  const bad = await handleRequest(makeRequest(makePayload({ results: { score: 900 } })), deps(db));
  const badBody = await bad.json();
  assert.ok(badBody.error.correlationId);
  assert.equal(bad.headers.get('x-correlation-id'), badBody.error.correlationId);
});
