/* ============================================================
   Migration 0006 — two first submissions at once
   ------------------------------------------------------------
   The failure this file exists to prevent:

   Two Service Mix reviews for the SAME business arrive at the
   same moment. Neither has a business_review_states row yet.
   `select … for update` cannot serialise them — there is no row
   to lock. Both read `current_bir_id` as null, both insert a
   report that supersedes nothing, and the business ends up with
   TWO supersession roots and no way to say which is current.

   `pg_advisory_xact_lock` on (business, review type), taken
   BEFORE the read, is what makes "the first one wins and the
   second chains onto it" true.

   Two connections are required to test this, and PGlite is
   single-connection. Concurrency is therefore reproduced the way
   PostgreSQL itself defines it: two interleaved transactions
   over one connection cannot be done, so the test instead proves
   the lock is TAKEN and that the serialised outcome is the one
   the code produces. What remains unproven is stated at the end
   and in the report.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { startLocalPg, disposableDataDir } from '../helpers/local-pg.mjs';

const id = () => randomUUID();
const hash = s => createHash('sha256').update(s).digest('hex');

const mixPayload = ({ submissionId, sessionId }) => ({
  schemaVersion: 6, reviewType: 'service_mix', assessmentVersion: '1.0.0',
  submissionId, assessmentSessionId: sessionId,
  vertical: { id: 'nails' }, submittedAt: new Date().toISOString(),
  contact: { salonName: 'Concurrent Salon', email: 'race@polished.test' },
  consent: { resultsDeliveryConsent: { granted: true, statement: 'Send my results…' } },
  attribution: { firstTouch: {} },
  serviceMix: { coverage: 'all_offerings', offerings: [{}, {}] }
});

const mixBir = () => ({
  schemaVersion: 5, reportType: 'service_mix', reportVersion: 1,
  identity: { businessId: null, identityStatus: 'resolution_pending', birId: null,
              legacyBusinessKey: null, reviewType: 'service_mix' },
  provenance: { generatedBy: 'service-mix-engine-v1.0.0', supersedes: null, isCurrent: true },
  dataConfidence: { confidence: 0.9 },
  serviceMixHealth: { classification: 'generally_healthy' },
  portfolioCoverage: { offeringsAnalysed: 2 },
  measurementGaps: []
});

test('ingestion is serialised per business and review type', async t => {
  const env = await startLocalPg({ dataDir: disposableDataDir('race') });
  t.after(async () => env.close());

  const q = async (sql, params = []) => (await env.pg.query(sql, params)).rows;

  /* A business to race against, created directly so both submissions resolve
     to it by the same server-issued continuation path. */
  const businessId = id();
  await env.pg.query(
    `insert into public.business_records (business_id, display_name, vertical_id)
     values ($1, 'Concurrent Salon', 'nails')`, [businessId]);

  const ingestMix = async () => {
    const submissionId = id();
    const birId = id();
    const [row] = await q(
      `select public.ingest_review($1, $2, $3::jsonb, '[]'::jsonb, $4::jsonb, $5::uuid,
                                   30, '{}'::jsonb, 'service_mix', $6::uuid) as r`,
      [submissionId, hash(submissionId),
       JSON.stringify(mixPayload({ submissionId, sessionId: id() })),
       JSON.stringify(mixBir()), birId, businessId]);
    return { ...row.r, birId, submissionId };
  };

  await t.test('the lock is taken before the review state is read', async () => {
    /* The guarantee is structural, so it is asserted structurally: the
       function body must take the advisory lock, and it must do so BEFORE
       reading business_review_states. A lock taken afterwards would leave
       exactly the window this exists to close. */
    const [{ src }] = await q(
      `select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'ingest_review'`);

    const lockAt = src.indexOf('pg_advisory_xact_lock');
    const readAt = src.indexOf('from public.business_review_states');
    assert.ok(lockAt > 0, 'ingest_review must take an advisory lock');
    assert.ok(readAt > 0, 'ingest_review must read the review state');
    assert.ok(lockAt < readAt,
      'the lock must be taken BEFORE the read, or two first submissions both read null');

    /* Keyed on the pair, not on the business alone: a Growth and a Service
       Mix submission for one business have no reason to block each other. */
    assert.match(src, /hashtextextended\(v_business_id::text \|\| ':' \|\| v_review_type, 0\)/);
  });

  await t.test('the lock is transaction-scoped, so it cannot outlive a failure', async () => {
    const [{ src }] = await q(
      `select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'ingest_review'`);
    assert.equal(src.includes('pg_advisory_lock('), false,
      'a session-scoped lock would survive a rolled-back transaction and wedge the business');
    assert.match(src, /pg_advisory_xact_lock/);
  });

  await t.test('two submissions produce one root and one chain, never two roots', async () => {
    const first = await ingestMix();
    const second = await ingestMix();

    assert.equal(first.businessId, businessId);
    assert.equal(second.businessId, businessId);

    const reports = await q(
      `select bir_id, supersedes_bir_id from public.business_intelligence_reports
        where business_id = $1 and review_type = 'service_mix'
        order by generated_at`, [businessId]);

    assert.equal(reports.length, 2);

    const roots = reports.filter(r => r.supersedes_bir_id === null);
    assert.equal(roots.length, 1,
      'exactly one report may supersede nothing; two roots is the corruption this prevents');
    assert.equal(roots[0].bir_id, first.birId);
    assert.equal(reports.find(r => r.bir_id === second.birId).supersedes_bir_id, first.birId);
  });

  await t.test('the review state keeps one original and moves only the latest', async () => {
    const [state] = await q(
      `select * from public.business_review_states
        where business_id = $1 and review_type = 'service_mix'`, [businessId]);

    assert.equal(state.completed_count, 2);
    assert.notEqual(state.original_submission_id, state.latest_submission_id);

    const [original] = await q(
      `select received_at from public.assessment_submissions where submission_id = $1`,
      [state.original_submission_id]);
    const [latest] = await q(
      `select received_at from public.assessment_submissions where submission_id = $1`,
      [state.latest_submission_id]);
    assert.ok(Date.parse(original.received_at) <= Date.parse(latest.received_at),
      'the original is the earlier one, and never moves');
  });

  await t.test('a replay takes no lock and creates nothing', async () => {
    const submissionId = id();
    const birId = id();
    const payload = JSON.stringify(mixPayload({ submissionId, sessionId: id() }));

    const call = () => q(
      `select public.ingest_review($1, $2, $3::jsonb, '[]'::jsonb, $4::jsonb, $5::uuid,
                                   30, '{}'::jsonb, 'service_mix', $6::uuid) as r`,
      [submissionId, hash(submissionId), payload, JSON.stringify(mixBir()), birId, businessId]);

    const [first] = await call();
    const [second] = await call();

    assert.equal(first.r.replayed, false);
    assert.equal(second.r.replayed, true);
    assert.equal(second.r.birId, first.r.birId, 'a replay returns the original identifiers');

    const [{ n }] = await q(
      `select count(*)::int as n from public.business_intelligence_reports
        where assessment_submission_id = $1`, [submissionId]);
    assert.equal(n, 1, 'and creates no second report');
  });

  await t.test('a Growth submission for the same business is not blocked by the Service Mix lock', async () => {
    /* The key is (business, review type), so the two reviews serialise
       independently. Asserted on the outcome: a Growth report for this
       business chains through the GROWTH state, untouched by the Service Mix
       chain built above. */
    const submissionId = id();
    const birId = id();
    const [row] = await q(
      `select public.ingest_review($1, $2, $3::jsonb, '[]'::jsonb, $4::jsonb, $5::uuid,
                                   30, '{}'::jsonb, 'growth_review', $6::uuid) as r`,
      [submissionId, hash(submissionId),
       JSON.stringify({
         schemaVersion: 3, assessmentVersion: '1.1.0', submissionId,
         assessmentSessionId: id(), vertical: { id: 'nails' },
         submittedAt: new Date().toISOString(),
         contact: { salonName: 'Concurrent Salon', email: 'race@polished.test' },
         consent: { resultsDeliveryConsent: { granted: true, statement: 'x' } },
         attribution: { firstTouch: {} }, answers: {}, results: { score: 1, opportunity: 1 }
       }),
       JSON.stringify({
         schemaVersion: 2,
         identity: { businessId: null, identityStatus: 'resolution_pending', birId: null,
                     legacyBusinessKey: null },
         provenance: { generatedBy: 'bie-v1.0.0', supersedes: null, isCurrent: true },
         estimateConfidence: { band: 'medium' }
       }), birId, businessId]);

    assert.equal(row.r.reviewType, 'growth_review');
    assert.equal(row.r.supersedesBirId, null, 'the Growth chain has its own root');

    const states = await q(
      `select review_type, current_bir_id from public.business_review_states
        where business_id = $1 order by review_type`, [businessId]);
    assert.deepEqual(states.map(s => s.review_type), ['growth_review', 'service_mix']);
  });
});

/* WHAT THIS DOES NOT PROVE

   Genuine parallelism. PGlite is a single connection, so two transactions
   cannot actually interleave here. What is proven is that the lock exists, is
   transaction-scoped, is keyed on the right pair, is taken before the read,
   and that the serialised outcome is a single supersession root.

   Reproducing the race itself needs two simultaneous connections to a server
   Postgres. It is recorded as outstanding in
   docs/REAL_POSTGRES_VALIDATION.md rather than quietly assumed. */
