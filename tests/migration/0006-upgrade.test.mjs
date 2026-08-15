/* ============================================================
   Migration 0006 — upgrade from a populated pre-0006 database
   ------------------------------------------------------------
   ONE PostgreSQL cluster, in this file's own process.

   PGlite does not return its WebAssembly heap to the operating
   system when a cluster is closed, so two clusters in one
   process cost twice the memory even when only one is open.
   The clean-install and upgrade phases are therefore separate
   FILES: node:test runs each test file in its own child
   process, and `--test-concurrency=1` keeps them from
   overlapping.

   Real PostgreSQL, compiled to WebAssembly, with no host, no
   port and no credential. See tests/helpers/local-pg.mjs for
   what that does and does not prove. Nothing here can reach a
   hosted database; there is nothing to reach it with.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import {
  startLocalPg, disposableDataDir, migrationFiles,
  assertNoPgcryptoDependency
} from '../helpers/local-pg.mjs';

const id = () => randomUUID();
const hash = s => createHash('sha256').update(s).digest('hex');

const allRows = async (pg, table) => (await pg.query(`select * from public.${table}`)).rows;

/* Everything 0006 could accidentally duplicate on a rerun. */
const snapshotSchema = async pg => {
  const q = async sql => (await pg.query(sql)).rows;
  return {
    columns: await q(`select table_name, column_name, data_type, column_default, is_nullable
                        from information_schema.columns where table_schema = 'public'
                       order by 1, 2`),
    constraints: await q(`select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def
                            from pg_constraint
                           where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes
                       where schemaname = 'public' order by 1, 2`),
    triggers: await q(`select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def
                         from pg_trigger t join pg_class c on c.oid = t.tgrelid
                         join pg_namespace n on n.oid = c.relnamespace
                        where n.nspname = 'public' and not t.tgisinternal order by 1, 2`),
    functions: await q(`select proname, pg_get_function_identity_arguments(oid) as args
                          from pg_proc where pronamespace = 'public'::regnamespace order by 1, 2`)
  };
};

/* ---------- fixtures ----------

   A Growth submission shaped the way the endpoint sends one. Deliberately
   schema 3 and BIR v2 — the shapes that existed BEFORE 0004 — because the
   upgrade has to be safe for the oldest rows a real database holds, not just
   for the newest. Invented salons and .test domains only. */

const growthPayload = ({ submissionId, sessionId, name, email, schemaVersion = 3 }) => ({
  schemaVersion,
  assessmentVersion: '1.1.0',
  submissionId,
  assessmentSessionId: sessionId,
  vertical: { id: 'nails', name: 'Nail Salons' },
  submittedAt: new Date().toISOString(),
  contact: { salonName: name, ownerName: 'Legacy Owner', email },
  consent: { resultsDeliveryConsent: { granted: true, statement: 'Send my assessment results…' } },
  attribution: { firstTouch: { url: 'https://nails.cedservice.test/' } },
  answers: { technicians: '3', averageTicket: '50' },
  results: { score: 26, opportunity: 1679.7 }
});

const growthBir = displayName => ({
  schemaVersion: 2,
  identity: { businessId: null, identityStatus: 'resolution_pending', birId: null, legacyBusinessKey: null },
  provenance: { generatedBy: 'bie-v1.0.0', supersedes: null, isCurrent: true },
  businessProfile: { displayName },
  estimateConfidence: { score: 0.79, band: 'medium' },
  qualificationProfile: { outcome: 'insufficient_data', missingCriticalFields: ['a'] },
  closeReadinessProfile: { score: 18, band: 'educate' },
  packageRecommendation: { packageId: 'salon-growth', priceMonthly: 597 }
});

const ingestGrowth = async (env, { name, email, sessionId = id(), schemaVersion = 3 }) => {
  const submissionId = id();
  const birId = id();
  const { data, error } = await env.db.rpc('ingest_assessment', {
    p_idempotency_key: submissionId,
    p_request_hash: hash(submissionId),
    p_payload: growthPayload({ submissionId, sessionId, name, email, schemaVersion }),
    p_signals: [],
    p_bir: growthBir(name),
    p_bir_id: birId,
    p_retention_days: 30,
    p_meta: { correlationId: submissionId }
  });
  assert.equal(error, null, error && error.message);
  return { ...data, submissionId, birId, sessionId };
};

/* Three Growth Reviews written by the real pre-0006 ingestion path: one
   standalone, one reassessment in the same session so the supersession chain
   has something in it, and one on the oldest payload version still accepted.
   Plus an analytics session, so the analytics side of the upgrade is
   exercised too. */
const seedPre0006 = async env => {
  const seeded = {};
  seeded.first = await ingestGrowth(env, { name: 'Legacy Salon One', email: 'one@polished.test' });
  seeded.second = await ingestGrowth(env, {
    name: 'Legacy Salon One', email: 'one@polished.test',
    sessionId: seeded.first.assessmentSessionId });
  seeded.other = await ingestGrowth(env, {
    name: 'Legacy Salon Two', email: 'two@polished.test', schemaVersion: 2 });

  seeded.analyticsSession = id();
  const { error } = await env.db.rpc('ingest_analytics_events', {
    p_events: [{
      eventId: id(), eventName: 'assessment.page_viewed', eventVersion: 1, schemaVersion: 1,
      assessmentSessionId: seeded.analyticsSession, verticalId: 'nails',
      occurredAt: new Date().toISOString(), activeElapsedMs: 0, totalElapsedMs: 0,
      attribution: { firstTouch: { utm: { utm_source: 'legacy' } } },
      device: { deviceClass: 'phone' }, metadata: {}
    }],
    p_meta: {}, p_retention_days: 400
  });
  if (error) throw new Error(`seed analytics failed: ${error.message}`);
  return seeded;
};

/* Everything that must survive the upgrade byte for byte. */
const captureHistory = async pg => ({
  records: await allRows(pg, 'business_records'),
  submissions: await allRows(pg, 'assessment_submissions'),
  reports: await allRows(pg, 'business_intelligence_reports'),
  timeline: await allRows(pg, 'timeline_events'),
  audit: await allRows(pg, 'audit_events')
});

/* ============================================================
   Setup — ONE cluster at a time
   ------------------------------------------------------------
   Each PGlite cluster costs around half a gigabyte of resident
   memory, and two live at once exhausted this machine. The two
   phases are therefore separate top-level tests: the first
   creates its database, asserts, and closes it before the
   second creates its own. Subtests keep the reporting granular.
   ============================================================ */

test('upgrade from a populated pre-0006 database', async t => {
  const UPGRADE = await startLocalPg({ upTo: '0005', dataDir: disposableDataDir('upgrade') });
  try {
    const seeded = await seedPre0006(UPGRADE);
    const BEFORE = await captureHistory(UPGRADE.pg);
    const UPGRADE_APPLIED = await UPGRADE.upgrade('0005');
    const AFTER = await captureHistory(UPGRADE.pg);

    await t.test('the seed database really was pre-0006 and really had history', () => {
      assert.equal(UPGRADE.applied.length, 5);
      assert.deepEqual(UPGRADE_APPLIED.map(a => a.file),
        ['0006_service_mix_review.sql', '0007_staff_identity_resolution.sql',
         '0008_staff_migration_hardening.sql', '0009_bi_sales_handoff_foundation.sql',
         '0010_sales_handoff_fk_indexes.sql', '0011_promotion_business_serialization.sql'],
        'the upgrade path carries the staff-resolution migration, the hardening pass, '
        + 'and the whole BI-to-Sales chain');
      assert.equal(BEFORE.submissions.length, 3);
      assert.equal(BEFORE.reports.length, 3);
      assert.ok(BEFORE.timeline.length >= 12);
    });

    await t.test('the upgrade adds no row and removes none', () => {
      assert.equal(AFTER.records.length, BEFORE.records.length);
      assert.equal(AFTER.submissions.length, BEFORE.submissions.length);
      assert.equal(AFTER.reports.length, BEFORE.reports.length);
      assert.equal(AFTER.timeline.length, BEFORE.timeline.length,
        'an append-only history must not gain or lose an event during a migration');
      assert.equal(AFTER.audit.length, BEFORE.audit.length);
    });

    await t.test('every pre-existing value survives the upgrade untouched', () => {
      BEFORE.submissions.forEach(prev => {
        const now = AFTER.submissions.find(s => s.submission_id === prev.submission_id);
        assert.ok(now, `submission ${prev.submission_id} disappeared`);
        ['assessment_session_id', 'business_id', 'assessment_version', 'vertical_id',
         'identity_status', 'payload_hash', 'payload_schema_version']
          .forEach(field => assert.deepEqual(now[field], prev[field], `${field} changed`));
        assert.deepEqual(now.raw_payload, prev.raw_payload, 'the stored payload is evidence');
      });

      BEFORE.reports.forEach(prev => {
        const now = AFTER.reports.find(r => r.bir_id === prev.bir_id);
        assert.deepEqual(now.report, prev.report, 'a stored report is a point-in-time record');
        assert.deepEqual(now.supersedes_bir_id, prev.supersedes_bir_id,
          'the existing supersession chain is preserved exactly');
        assert.equal(now.schema_version, prev.schema_version);
      });

      BEFORE.timeline.forEach(prev => {
        const now = AFTER.timeline.find(e => e.event_id === prev.event_id);
        assert.ok(now, 'an append-only event may never vanish');
        assert.equal(now.event_name, prev.event_name);
        assert.deepEqual(now.payload, prev.payload);
      });
    });

    await t.test('every pre-existing row is backfilled as growth_review', async () => {
      for (const table of ['assessment_submissions', 'assessment_sessions',
                           'business_intelligence_reports', 'assessment_analytics_events',
                           'assessment_analytics_sessions']) {
        const rows = await allRows(UPGRADE.pg, table);
        assert.ok(rows.length >= 1, `${table} should have seeded rows to backfill`);
        rows.forEach(r => assert.equal(r.review_type, 'growth_review',
          `${table}: every row written before SM-1 is a Growth Review`));
      }

      /* And the column defaults to the same thing for anything written later
         without naming it. */
      const def = (await UPGRADE.pg.query(
        `select column_default from information_schema.columns
          where table_name = 'assessment_submissions' and column_name = 'review_type'`)).rows[0];
      assert.match(def.column_default, /growth_review/);
    });

    await t.test('business_review_states is backfilled from the existing Growth pointers', async () => {
      const withCurrent = BEFORE.records.filter(r => r.current_bir_id !== null);
      assert.ok(withCurrent.length >= 2);

      const states = await allRows(UPGRADE.pg, 'business_review_states');
      assert.equal(states.length, withCurrent.length,
        'a business that has completed a Growth Review should not wait for its next one');

      withCurrent.forEach(record => {
        const state = states.find(s => s.business_id === record.business_id);
        assert.ok(state, `no review state backfilled for ${record.business_id}`);
        assert.equal(state.review_type, 'growth_review');
        assert.equal(state.current_bir_id, record.current_bir_id,
          'the backfilled pointer is the pointer that already existed');
        assert.ok(state.completed_count >= 1);
        assert.equal(state.state.backfilledFrom, 'business_records.current_bir_id');
      });
    });

    await t.test('after the upgrade, an existing Growth session still ingests and still chains', async () => {
      /* The same session that submitted twice before the upgrade submits again
         after it. The chain must continue from where it was, not restart. */
      const third = await ingestGrowth(UPGRADE, {
        name: 'Legacy Salon One', email: 'one@polished.test',
        sessionId: seeded.first.assessmentSessionId });

      assert.equal(third.businessId, seeded.first.businessId,
        'an upgraded session still resolves to the business it always did');
      assert.equal(third.reviewType, 'growth_review');
      assert.equal(third.supersedesBirId, seeded.second.birId,
        'the chain continues from the last pre-upgrade report');

      const [record] = (await allRows(UPGRADE.pg, 'business_records'))
        .filter(r => r.business_id === third.businessId);
      assert.equal(record.current_bir_id, third.birId);

      const state = (await allRows(UPGRADE.pg, 'business_review_states'))
        .find(s => s.business_id === third.businessId && s.review_type === 'growth_review');
      assert.equal(state.current_bir_id, third.birId,
        'the backfilled state moves forward with the next submission');

      seeded.third = third;
    });

    await t.test('a Service Mix submission works immediately after the upgrade', async () => {
      const submissionId = id();
      const birId = id();
      const { data, error } = await UPGRADE.db.rpc('ingest_review', {
        p_idempotency_key: submissionId,
        p_request_hash: hash(submissionId),
        p_payload: {
          schemaVersion: 6, reviewType: 'service_mix', assessmentVersion: '1.0.0',
          submissionId, assessmentSessionId: id(),
          vertical: { id: 'nails', name: 'Nail Salons' },
          submittedAt: new Date().toISOString(),
          contact: { salonName: 'Legacy Salon One', email: 'one@polished.test' },
          consent: { resultsDeliveryConsent: { granted: true, statement: 'Send me my Service Mix results…' } },
          attribution: { firstTouch: { url: 'https://nails.cedservice.test/service-mix' } },
          serviceMix: { coverage: 'all_offerings', offerings: [{}, {}, {}] }
        },
        p_signals: [],
        p_bir: {
          schemaVersion: 5, reportType: 'service_mix', reportVersion: 1,
          identity: { businessId: null, identityStatus: 'resolution_pending', birId: null,
                      legacyBusinessKey: null, reviewType: 'service_mix' },
          provenance: { generatedBy: 'service-mix-engine-v1.0.0', supersedes: null, isCurrent: true },
          dataConfidence: { confidence: 0.93 },
          serviceMixHealth: { classification: 'generally_healthy' },
          portfolioCoverage: { offeringsAnalysed: 3 },
          measurementGaps: []
        },
        p_bir_id: birId, p_retention_days: 30, p_meta: {},
        p_review_type: 'service_mix',
        /* The server-issued path: attach to the business the Growth Review made. */
        p_continuation_business_id: seeded.first.businessId
      });

      assert.equal(error, null, error && error.message);
      assert.equal(data.businessId, seeded.first.businessId);
      assert.equal(data.linkMethod, 'continuation_context');
      assert.equal(data.supersedesBirId, null, 'the first Service Mix report supersedes nothing');

      /* Both review types are now current, independently. */
      const states = (await allRows(UPGRADE.pg, 'business_review_states'))
        .filter(s => s.business_id === seeded.first.businessId);
      assert.equal(states.length, 2);
      assert.equal(states.find(s => s.review_type === 'growth_review').current_bir_id, seeded.third.birId);
      assert.equal(states.find(s => s.review_type === 'service_mix').current_bir_id, birId);

      /* And the legacy Growth pointer is untouched by the Service Mix report. */
      const [record] = (await allRows(UPGRADE.pg, 'business_records'))
        .filter(r => r.business_id === seeded.first.businessId);
      assert.equal(record.current_bir_id, seeded.third.birId);

      /* The timeline names the review, and carries no offering name or figure. */
      const events = (await allRows(UPGRADE.pg, 'timeline_events'))
        .filter(e => e.correlation_id === submissionId);
      assert.deepEqual(events.map(e => e.event_name).sort(), [
        'assessment.completed', 'bir.generated', 'identity.linked', 'identity.resolved',
        'service_mix.completed', 'service_mix_bir.generated'
      ]);
      const completed = events.find(e => e.event_name === 'service_mix.completed');
      assert.equal(completed.payload.reviewType, 'service_mix');
      assert.equal(completed.payload.offeringCount, 3);
      /* `continuationApplied` is decided by ingest_review and overwrites
         whatever the caller put in the meta — the endpoint knows only that it
         OFFERED a context. This call linked by continuation_context (asserted
         above), so the answer is true whatever the caller claimed. */
      assert.equal(completed.payload.continuationApplied, true);
    });

    await t.test('a post-upgrade analytics event carrying reviewType is accepted', async () => {
      const sessionId = id();
      const { error } = await UPGRADE.db.rpc('ingest_analytics_events', {
        p_events: [{
          eventId: id(), eventName: 'service_mix.review_viewed', eventVersion: 1,
          /* Envelope version 2 — the one 0005's constraint refused until 0006
             widened it. */
          schemaVersion: 2,
          assessmentSessionId: sessionId, verticalId: 'nails', reviewType: 'service_mix',
          occurredAt: new Date().toISOString(), activeElapsedMs: 0, totalElapsedMs: 0,
          attribution: { firstTouch: { utm: { utm_source: 'qr-upgrade' } } },
          device: { deviceClass: 'phone' }, metadata: {}
        }],
        p_meta: {}, p_retention_days: 400
      });
      assert.equal(error, null, error && error.message);

      const [row] = (await allRows(UPGRADE.pg, 'assessment_analytics_events'))
        .filter(e => e.assessment_session_id === sessionId);
      assert.equal(row.schema_version, 2);
      assert.equal(row.review_type, 'service_mix');

      /* And the pre-upgrade session is still growth_review, unmoved. */
      const [legacy] = (await allRows(UPGRADE.pg, 'assessment_analytics_sessions'))
        .filter(s => s.assessment_session_id === seeded.analyticsSession);
      assert.equal(legacy.review_type, 'growth_review');
    });

    await t.test('the daily funnel separates the two review types after the upgrade', async () => {
      const { error } = await UPGRADE.db.rpc('refresh_assessment_funnel_daily', {});
      assert.equal(error, null, error && error.message);

      const rows = await allRows(UPGRADE.pg, 'assessment_funnel_daily');
      const growth = rows.filter(r => r.review_type === 'growth_review');
      const mix = rows.filter(r => r.review_type === 'service_mix');

      assert.ok(growth.length >= 1, 'the legacy session aggregates as a Growth Review');
      assert.ok(mix.length >= 1, 'the Service Mix event lands on its own row');
      mix.forEach(r => assert.ok(r.page_views >= 1,
        'service_mix.review_viewed counts as a page view for its own funnel'));

      /* One session in each, never blended into one row. */
      assert.equal(rows.filter(r => r.review_type === 'growth_review' && r.page_views > 0).length, 1);
    });

  } finally {
    await UPGRADE.close();
  }
});
