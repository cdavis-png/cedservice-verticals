/* Milestone 1.1 — J (schema-version compatibility) and L (BIR history chain).

   J: the endpoint accepted exactly one payload version. The day a new version
   shipped, every browser holding a cached page would have had its queued
   assessments rejected with a permanent 400 — losing completed work for a
   reason that has nothing to do with the visitor.

   L: supersedes_bir_id existed as a column and was never populated, so
   successive reports for one business were not linked to each other even
   though current_bir_id was being overwritten. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handleRequest, VERSIONS } from '../api/assessments.mjs';
import { createFakeDb } from './helpers/fake-db.mjs';
import { makePayload, makeRequest, deps } from './helpers/fixtures.mjs';

const send = async (db, payload) => {
  const res = await handleRequest(makeRequest(payload), deps(db));
  return { res, body: await res.json() };
};

const fresh = over => makePayload({
  assessmentSessionId: randomUUID(), submissionId: randomUUID(), ...over
});

/* A payload as the previous supported client built it. */
const previousVersion = over => {
  const payload = fresh({ schemaVersion: VERSIONS.SUPPORTED_PAYLOAD_SCHEMAS[0], ...over });
  delete payload.integrity;
  return payload;
};

/* ---------- J. version compatibility ---------- */

test('the current version is accepted', async () => {
  const { res, body } = await send(createFakeDb(), fresh({ schemaVersion: VERSIONS.CURRENT_PAYLOAD_SCHEMA }));
  assert.equal(res.status, 201);
  assert.equal(body.payloadSchemaVersion, VERSIONS.CURRENT_PAYLOAD_SCHEMA);
});

test('the previous supported version is still accepted', async () => {
  const db = createFakeDb();
  const { res, body } = await send(db, previousVersion());
  assert.equal(res.status, 201, 'a page cached before the deploy is not punished for it');
  assert.equal(body.payloadSchemaVersion, VERSIONS.SUPPORTED_PAYLOAD_SCHEMAS[0]);
  assert.equal(db.state.assessment_submissions[0].payload_schema_version,
    VERSIONS.SUPPORTED_PAYLOAD_SCHEMAS[0], 'recorded per submission');
});

test('a future unsupported version is refused clearly', async () => {
  const { res, body } = await send(createFakeDb(), fresh({ schemaVersion: 99 }));
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'unsupported_version');
  assert.equal(body.error.details.received, 99);
  assert.equal(body.error.details.reason, 'unrecognised');
  assert.deepEqual(body.error.details.supported, VERSIONS.SUPPORTED_PAYLOAD_SCHEMAS);
  assert.equal(body.error.details.current, VERSIONS.CURRENT_PAYLOAD_SCHEMA);
});

test('a retired version is refused and says so', async () => {
  const { body } = await send(createFakeDb(), fresh({ schemaVersion: 1 }));
  assert.equal(body.error.code, 'unsupported_version');
  assert.equal(body.error.details.reason, 'retired');
});

test('a non-integer version is refused', async () => {
  for (const version of ['3', 3.5, null, undefined]) {
    const { res, body } = await send(createFakeDb(), fresh({ schemaVersion: version }));
    assert.equal(res.status, 400, `${version} must be refused`);
    assert.equal(body.error.code, 'unsupported_version');
  }
});

test('a queued older submission survives a version bump', async () => {
  /* The scenario the range exists for: the page deployed today builds v3,
     but a visitor's browser queued a v2 payload last week and only retries
     now. It must still be delivered. */
  const db = createFakeDb();
  const { res } = await send(db, previousVersion());
  assert.equal(res.status, 201);
  assert.equal(db.state.assessment_submissions.length, 1, 'not lost to a version bump');
});

test('the supported set is a contiguous range ending at the current version', () => {
  const supported = [...VERSIONS.SUPPORTED_PAYLOAD_SCHEMAS].sort((a, b) => a - b);
  assert.equal(supported[supported.length - 1], VERSIONS.CURRENT_PAYLOAD_SCHEMA);
  assert.equal(supported[0], VERSIONS.MIN_KNOWN_PAYLOAD_SCHEMA);
  supported.forEach((v, i) => { if (i) assert.equal(v, supported[i - 1] + 1, 'no gaps'); });
});

test('the database records only versions the endpoint accepts', async () => {
  const db = createFakeDb();
  await send(db, fresh());
  await send(db, previousVersion());
  db.state.assessment_submissions.forEach(s => {
    assert.ok(VERSIONS.SUPPORTED_PAYLOAD_SCHEMAS.includes(s.payload_schema_version));
  });
});

test('the engine builds the current version', async () => {
  const { readFileSync } = await import('node:fs');
  const engine = readFileSync(new URL('../shared/assessment-engine/engine.js', import.meta.url), 'utf8');
  const built = Number(engine.match(/const PAYLOAD_SCHEMA_VERSION = (\d+)/)[1]);
  assert.equal(built, VERSIONS.CURRENT_PAYLOAD_SCHEMA,
    'the page and the endpoint must agree on what "current" means');
});

/* ---------- L. BIR supersession chain ---------- */

/* Successive assessments in one browser session all resolve to one business. */
const reassess = async (db, sessionId) =>
  (await send(db, makePayload({
    assessmentSessionId: sessionId,
    submissionId: randomUUID(),
    answers: { technicians: String(1 + Math.floor(Math.random() * 5)) }
  }))).body;

test('the first BIR for a business supersedes nothing', async () => {
  const db = createFakeDb();
  const { body } = await send(db, fresh());
  assert.equal(body.supersedesBirId, null);
  assert.equal(db.state.business_intelligence_reports[0].supersedes_bir_id, null);
});

test('a later BIR supersedes the previous current one', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const first = await reassess(db, sessionId);
  const second = await reassess(db, sessionId);

  assert.equal(first.businessId, second.businessId, 'same business');
  assert.equal(second.supersedesBirId, first.birId, 'the chain links backwards');

  const record = db.state.business_records.find(b => b.business_id === second.businessId);
  assert.equal(record.current_bir_id, second.birId, 'current points at the newest');
});

test('every prior BIR is preserved', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await reassess(db, sessionId)).birId);

  assert.equal(db.state.business_intelligence_reports.length, 4, 'nothing is deleted');
  ids.forEach(id => assert.ok(db.state.business_intelligence_reports.some(r => r.bir_id === id)));
});

test('the chain is walkable from current back to first', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await reassess(db, sessionId)).birId);

  const byId = new Map(db.state.business_intelligence_reports.map(r => [r.bir_id, r]));
  const record = db.state.business_records[0];

  const walked = [];
  let cursor = record.current_bir_id;
  while (cursor) {
    walked.push(cursor);
    cursor = byId.get(cursor).supersedes_bir_id;
  }

  assert.deepEqual(walked, [...ids].reverse(), 'a complete, ordered history');
});

test('current_bir_id changes only after the new BIR exists', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const first = await reassess(db, sessionId);

  /* Fail after the BIR insert step; the whole transaction rolls back. */
  const failing = createFakeDb({ failAt: 'timeline' });
  failing.state.business_records = db.state.business_records;
  failing.state.business_intelligence_reports = db.state.business_intelligence_reports;
  failing.state.assessment_sessions = db.state.assessment_sessions;

  const before = failing.state.business_records[0].current_bir_id;
  const res = await handleRequest(
    makeRequest(makePayload({ assessmentSessionId: sessionId, submissionId: randomUUID() })),
    deps(failing));

  assert.equal(res.status, 502);
  assert.equal(failing.state.business_records[0].current_bir_id, before,
    'a failed ingestion never advances the pointer');
  assert.equal(before, first.birId);
});

test('a replay does not create a second chain link', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  await reassess(db, sessionId);

  const payload = makePayload({ assessmentSessionId: sessionId, submissionId: randomUUID() });
  const first = await send(db, payload);
  const replay = await send(db, payload);

  assert.equal(replay.res.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.birId, first.body.birId, 'the same BIR is reported');
  assert.equal(replay.body.supersedesBirId, first.body.supersedesBirId);
  assert.equal(db.state.business_intelligence_reports.length, 2, 'no third report');

  const links = db.state.business_intelligence_reports
    .filter(r => r.supersedes_bir_id === first.body.supersedesBirId);
  assert.equal(links.length, 1, 'exactly one report supersedes any given predecessor');
});

test('an unresolved identity leaves an unattached BIR with no chain link', async () => {
  const db = createFakeDb();
  db.seedBusiness({
    identifiers: [{ type: 'email_exact', normalizedValue: 'owner@polished.test' }]
  });

  const { body } = await send(db, fresh());
  assert.equal(body.identityStatus, 'resolution_pending');
  assert.equal(body.businessId, null);
  assert.equal(body.supersedesBirId, null);

  const bir = db.state.business_intelligence_reports.at(-1);
  assert.equal(bir.business_id, null, 'stored, but not yet attached to a business');
  assert.equal(bir.supersedes_bir_id, null);
  assert.ok(bir.report, 'the intelligence is valid regardless of whose it is');
});

test('the BIR provenance records its predecessor', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const first = await reassess(db, sessionId);
  const second = await reassess(db, sessionId);

  const report = db.state.business_intelligence_reports.find(r => r.bir_id === second.birId).report;
  assert.equal(report.provenance.supersedes, first.birId);
});

test('the timeline records the supersession', async () => {
  const db = createFakeDb();
  const sessionId = randomUUID();
  const first = await reassess(db, sessionId);
  const second = await reassess(db, sessionId);

  const events = db.state.timeline_events.filter(e => e.event_name === 'bir.generated');
  assert.equal(events.length, 2);
  assert.equal(events[0].payload.supersedesBirId, null);
  assert.equal(events[1].payload.supersedesBirId, first.birId);
  assert.equal(events[1].payload.birId, second.birId);
});

/* ---------- scoring and pricing are unchanged by any of this ---------- */

test('scoring and pricing are carried through verbatim', async () => {
  const db = createFakeDb();
  const payload = makePayload();
  await send(db, payload);

  const stored = db.state.assessment_submissions[0].raw_payload.results;
  assert.equal(stored.score, payload.results.score);
  assert.equal(stored.opportunity, payload.results.opportunity);
  assert.deepEqual(stored.dimensions, payload.results.dimensions);
  assert.equal(stored.recommendedPackage.price, 597, 'pricing is unchanged');
  assert.equal(stored.recommendedPackage.id, 'salon-growth');
  assert.equal(stored.disclaimer, payload.results.disclaimer, 'the disclaimer travels with the figure');

  const bir = db.state.business_intelligence_reports[0].report;
  assert.equal(bir.packageRecommendation.priceMonthly, 597);
  assert.equal(bir.financialOpportunityProfile.isDiagnosticEstimate, true);
  assert.ok(bir.financialOpportunityProfile.disclaimer.length > 10);
});
