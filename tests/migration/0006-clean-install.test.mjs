/* ============================================================
   Migration 0006 — clean installation
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

test('clean installation of the whole chain', async t => {
  const CLEAN = await startLocalPg({ dataDir: disposableDataDir('clean') });
  try {

    await t.test('a clean database takes the whole chain through 0006', () => {
      assert.match(CLEAN.version, /PostgreSQL/);
      assert.deepEqual(CLEAN.applied.map(a => a.file), migrationFiles());
      assert.ok(migrationFiles().includes('0006_service_mix_review.sql'));

      /* The only statement the local environment cannot run, and the reason it
         does not matter. */
      const tolerated = CLEAN.applied.flatMap(a => a.tolerated);
      assert.equal(tolerated.length, 1);
      assert.match(tolerated[0].reason, /pgcrypto/);
      assert.deepEqual(assertNoPgcryptoDependency(), [],
        'no migration may depend on a function only pgcrypto provides');
    });

    await t.test('0006 creates the review-state table and every function it declares', async () => {
      const tables = (await CLEAN.pg.query(
        `select tablename from pg_tables where schemaname = 'public' order by 1`)).rows.map(r => r.tablename);
      assert.ok(tables.includes('business_review_states'));
      assert.ok(tables.includes('staff_operators') && tables.includes('identity_resolution_requests'),
        '0007 adds the staff operator record and the resolution idempotency ledger');
      assert.ok(tables.includes('aeo_observations') && tables.includes('aeo_scan_batches'),
        '0009 adds the AEO evidence store');
      assert.equal(tables.length, 27);

      const functions = (await CLEAN.pg.query(
        `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' order by 1`)).rows.map(r => r.proname);
      ['ingest_review', 'ingest_assessment', 'enforce_bir_supersession_scope',
       'enforce_growth_only_current_bir', 'append_service_mix_timeline_event',
       'append_service_mix_bir_event', 'analytics_review_type']
        .forEach(fn => assert.ok(functions.includes(fn), `missing function ${fn}`));
    });

    await t.test('applying 0006 twice changes nothing the second time', async () => {
      const before = await snapshotSchema(CLEAN.pg);
      const again = await CLEAN.upgrade('0005');
      assert.deepEqual(again.map(a => a.file),
        ['0006_service_mix_review.sql', '0007_staff_identity_resolution.sql',
         '0008_staff_migration_hardening.sql', '0009_aeo_evidence_store.sql']);

      const after = await snapshotSchema(CLEAN.pg);
      assert.deepEqual(after, before, 'a rerun must be a no-op, not a second set of objects');
    });

    await t.test('RLS is enabled AND forced with no policies on every table, including the new one', async () => {
      const rows = (await CLEAN.pg.query(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
                (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' order by 1`)).rows;

      assert.equal(rows.length, 27);
      rows.forEach(r => {
        assert.equal(r.relrowsecurity, true, `${r.relname}: RLS must be enabled`);
        assert.equal(r.relforcerowsecurity, true, `${r.relname}: RLS must be FORCED`);
        assert.equal(r.policies, 0, `${r.relname}: there must be no policies`);
      });
    });

    await t.test('anon and authenticated can reach nothing; the service role bypasses RLS', async () => {
      await ingestGrowth(CLEAN, { name: 'Role Check Salon', email: 'roles@polished.test' });

      const asRole = async (role, sql) => {
        await CLEAN.pg.exec(`set role ${role}`);
        try { return { rows: (await CLEAN.pg.query(sql)).rows, error: null }; }
        catch (err) { return { rows: null, error: err.message }; }
        finally { await CLEAN.pg.exec('reset role'); }
      };

      for (const role of ['anon', 'authenticated']) {
        const read = await asRole(role, 'select * from public.business_records');
        /* Either refused outright (no grant) or returned nothing (RLS forced, no
           policy). Both are "cannot see it"; the first is stronger. */
        assert.ok(read.error !== null || read.rows.length === 0,
          `${role} must not be able to read business_records`);

        const write = await asRole(role,
          `insert into public.business_records (display_name, vertical_id) values ('x','nails')`);
        assert.ok(write.error, `${role} must not be able to write business_records`);

        const call = await asRole(role,
          `select public.ingest_review('k','h','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,gen_random_uuid())`);
        assert.ok(call.error, `${role} must not be able to call ingest_review`);

        const analytics = await asRole(role,
          `select public.ingest_analytics_events('[]'::jsonb)`);
        assert.ok(analytics.error, `${role} must not be able to call ingest_analytics_events`);
      }

      /* service_role has BYPASSRLS in Supabase, which is what lets the Vercel
         Function read a table with RLS forced and no policy. Granting select here
         proves the bypass; without BYPASSRLS the grant alone would return zero
         rows. */
      await CLEAN.pg.exec('grant select on public.business_records to service_role');
      const service = await asRole('service_role', 'select count(*)::int as n from public.business_records');
      assert.equal(service.error, null);
      assert.ok(service.rows[0].n >= 1, 'the service role sees rows anon cannot');
    });

    await t.test('the widened constraints accept every version that already exists', async () => {
      const check = async name => (await CLEAN.pg.query(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [name])).rows[0].def;

      /* BIR versions: 2 (Milestone 1), 3 (expansion), 4 (two stages), 5 (SM-1). */
      const bir = await check('bir_schema_version_check');
      assert.match(bir, /2/);
      assert.match(bir, /5/);

      /* Payload versions: 2 to 5 are Growth shapes, 6 is Service Mix. */
      assert.match(await check('assessment_submissions_payload_version_check'), /6/);

      /* The analytics envelope: 1 is the original, 2 adds reviewType. THIS is the
         constraint the first real-Postgres run of 0006 found unwidened — every
         event a post-SM-1 page emitted would have been refused, and the whole
         batch with it. */
      assert.match(await check('analytics_events_schema_version_check'), /2/);

      /* And the pairing that keeps the two review types apart at rest. */
      const pairing = await check('bir_service_mix_version_check');
      assert.match(pairing, /service_mix/);
      assert.match(pairing, /growth_review/);
    });

    /* ============================================================
       2. Upgrade from a populated pre-0006 database
       ============================================================ */
  } finally {
    await CLEAN.close();
  }
});

