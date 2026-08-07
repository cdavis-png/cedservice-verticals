/* ============================================================
   Migration 0006 — server RPC permissions, as the roles
   ------------------------------------------------------------
   Every previous migration REVOKED execute from public, anon and
   authenticated and then relied on `service_role` happening to
   have it through a Supabase project's default privileges. That
   is a property of how the project was created, not something
   the schema states — and every test so far ran as the database
   OWNER, which can execute everything regardless and therefore
   proves nothing about either role.

   These run `SET ROLE` first. What they assert is not "the
   function works" but "this role, and only this role, can call
   it".

   ONE PostgreSQL cluster, in this file's own process. See
   tests/helpers/local-pg.mjs. No host, no port, no credential.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { startLocalPg, disposableDataDir } from '../helpers/local-pg.mjs';

const id = () => randomUUID();
const hash = s => createHash('sha256').update(s).digest('hex');

/* Every function the SERVER calls, with the exact signature PostgREST
   resolves. A grant on the wrong overload grants nothing the endpoint can
   use, which is why the arguments are written out. */
const SERVER_RPCS = [
  'ingest_review(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb, text, uuid)',
  'ingest_assessment(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb)',
  'ingest_analytics_events(jsonb, jsonb, integer)',
  'refresh_assessment_funnel_daily(date, date)',
  'assessment_step_dropoff(text, date, date)',
  'check_rate_limit(jsonb, integer, integer)',
  'purge_expired_idempotency_records(timestamp with time zone, integer)',
  'purge_expired_rate_limit_buckets(timestamp with time zone)',
  'purge_expired_analytics_events(timestamp with time zone, integer)',
  'purge_expired_analytics_sessions(timestamp with time zone, integer)',
  'redact_business_pii(uuid, text, text, text)'
];

/* Trigger and helper functions. Nobody executes these directly: they run as
   part of a statement the caller already had the right to make, and granting
   execute would let one be invoked outside a trigger context. */
const NOT_CALLABLE = [
  'reject_mutation()',
  'touch_updated_at()',
  'append_stage_timeline_events()',
  'append_bir_stage_event()',
  'append_service_mix_timeline_event()',
  'append_service_mix_bir_event()',
  'enforce_bir_supersession_scope()',
  'enforce_growth_only_current_bir()',
  'analytics_review_type(text, text)',
  /* Rule B0's comparison. Called only from inside ingest_review, which is
     SECURITY DEFINER and therefore runs it as the owner. Granting execute
     would let anyone ask "does this evidence contradict that record?" — a
     read of what a Business Record holds, one question at a time. */
  'identity_proposal_conflict(jsonb, uuid)'
];

const growthPayload = ({ submissionId, sessionId }) => ({
  schemaVersion: 3,
  assessmentVersion: '1.1.0',
  submissionId,
  assessmentSessionId: sessionId,
  vertical: { id: 'nails', name: 'Nail Salons' },
  submittedAt: new Date().toISOString(),
  contact: { salonName: 'Role Test Salon', ownerName: 'Owner', email: 'roles@polished.test' },
  consent: { resultsDeliveryConsent: { granted: true, statement: 'Send my results…' } },
  attribution: { firstTouch: { url: 'https://nails.cedservice.test/' } },
  answers: { technicians: '3' },
  results: { score: 26, opportunity: 1679.7 }
});

const growthBir = () => ({
  schemaVersion: 2,
  identity: { businessId: null, identityStatus: 'resolution_pending', birId: null, legacyBusinessKey: null },
  provenance: { generatedBy: 'bie-v1.0.0', supersedes: null, isCurrent: true },
  businessProfile: { displayName: 'Role Test Salon' },
  estimateConfidence: { score: 0.79, band: 'medium' },
  qualificationProfile: { outcome: 'insufficient_data', missingCriticalFields: [] },
  closeReadinessProfile: { score: 18, band: 'educate' },
  packageRecommendation: { packageId: 'salon-growth', priceMonthly: 597 }
});

test('server RPC permissions are explicit, and only service_role has them', async t => {
  const env = await startLocalPg({ dataDir: disposableDataDir('roles') });
  t.after(async () => env.close());

  const q = async (sql, params = []) => (await env.pg.query(sql, params)).rows;

  /* Runs a statement AS a role and reports whether it was permitted, without
     letting a failure leave the session stuck in that role. */
  const asRole = async (role, sql, params = []) => {
    await env.pg.exec(`set role ${role}`);
    try {
      const rows = (await env.pg.query(sql, params)).rows;
      return { permitted: true, rows, error: null };
    } catch (err) {
      return { permitted: false, rows: null, error: err.message };
    } finally {
      await env.pg.exec('reset role');
    }
  };

  await t.test('the grants exist as catalog facts, not as project defaults', async () => {
    for (const signature of SERVER_RPCS) {
      const [row] = await q(
        `select has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as auth`,
        [`public.${signature}`]);

      assert.equal(row.svc, true, `service_role must be able to execute ${signature}`);
      assert.equal(row.anon, false, `anon must NOT be able to execute ${signature}`);
      assert.equal(row.auth, false, `authenticated must NOT be able to execute ${signature}`);
    }
  });

  await t.test('PUBLIC holds no execute grant on any server RPC', async () => {
    /* PostgreSQL grants EXECUTE to PUBLIC on every new function by default.
       A revoke that ran BEFORE the grant would have taken it from nobody
       useful, so this checks the ACL directly rather than trusting order. */
    const leaked = await q(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proacl is not null
          and exists (
                select 1 from aclexplode(p.proacl) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE')`);
    assert.deepEqual(leaked.map(r => `${r.proname}(${r.args})`), [],
      'PUBLIC must hold no execute grant on anything in this schema');
  });

  await t.test('trigger and helper functions are callable by nobody', async () => {
    for (const signature of NOT_CALLABLE) {
      const [row] = await q(
        `select has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as auth`,
        [`public.${signature}`]);
      assert.equal(row.svc, false, `${signature} runs inside a trigger and needs no grant`);
      assert.equal(row.anon, false);
      assert.equal(row.auth, false);
    }
  });

  /* ---------- executed, not merely granted ---------- */

  await t.test('service_role can actually ingest a Growth Review', async () => {
    const submissionId = id();
    const result = await asRole('service_role',
      `select public.ingest_assessment($1, $2, $3::jsonb, '[]'::jsonb, $4::jsonb, $5::uuid, 30, '{}'::jsonb) as r`,
      [submissionId, hash(submissionId),
       JSON.stringify(growthPayload({ submissionId, sessionId: id() })),
       JSON.stringify(growthBir()), id()]);

    assert.equal(result.permitted, true, result.error);
    assert.equal(result.rows[0].r.ok, true);
    assert.equal(result.rows[0].r.reviewType, 'growth_review');
  });

  await t.test('service_role can actually ingest a Service Mix review', async () => {
    const submissionId = id();
    const payload = {
      schemaVersion: 6, reviewType: 'service_mix', assessmentVersion: '1.0.0',
      submissionId, assessmentSessionId: id(),
      vertical: { id: 'nails' }, submittedAt: new Date().toISOString(),
      contact: { salonName: 'Role Test Mix', email: 'mix@polished.test' },
      consent: { resultsDeliveryConsent: { granted: true, statement: 'Send my results…' } },
      attribution: { firstTouch: {} },
      serviceMix: { coverage: 'all_offerings', offerings: [{}, {}] }
    };
    const report = {
      schemaVersion: 5, reportType: 'service_mix', reportVersion: 1,
      identity: { businessId: null, identityStatus: 'resolution_pending', birId: null,
                  legacyBusinessKey: null, reviewType: 'service_mix' },
      provenance: { generatedBy: 'service-mix-engine-v1.0.0', supersedes: null, isCurrent: true },
      dataConfidence: { confidence: 0.9 },
      serviceMixHealth: { classification: 'generally_healthy' },
      portfolioCoverage: { offeringsAnalysed: 2 },
      measurementGaps: []
    };

    const result = await asRole('service_role',
      `select public.ingest_review($1, $2, $3::jsonb, '[]'::jsonb, $4::jsonb, $5::uuid,
                                   30, '{}'::jsonb, 'service_mix', null) as r`,
      [submissionId, hash(submissionId), JSON.stringify(payload), JSON.stringify(report), id()]);

    assert.equal(result.permitted, true, result.error);
    assert.equal(result.rows[0].r.reviewType, 'service_mix');
  });

  await t.test('service_role can actually ingest analytics', async () => {
    const result = await asRole('service_role',
      `select public.ingest_analytics_events($1::jsonb, '{}'::jsonb, 400) as r`,
      [JSON.stringify([{
        eventId: id(), eventName: 'service_mix.review_viewed', eventVersion: 1,
        schemaVersion: 2, assessmentSessionId: id(), verticalId: 'nails',
        reviewType: 'service_mix', occurredAt: new Date().toISOString(),
        activeElapsedMs: 0, totalElapsedMs: 0,
        attribution: {}, device: { deviceClass: 'phone' }, metadata: {}
      }])]);

    assert.equal(result.permitted, true, result.error);
    assert.equal(result.rows[0].r.ok, true);
  });

  await t.test('anon and authenticated are refused on every server RPC', async () => {
    /* Called with deliberately empty arguments: the point is that permission
       is refused BEFORE the function's own validation ever runs, so the error
       must be about permission and never about the arguments. */
    const attempts = {
      'ingest_review': `select public.ingest_review('', '', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, gen_random_uuid(), 30, '{}'::jsonb, 'service_mix', null)`,
      'ingest_assessment': `select public.ingest_assessment('', '', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, gen_random_uuid(), 30, '{}'::jsonb)`,
      'ingest_analytics_events': `select public.ingest_analytics_events('[]'::jsonb, '{}'::jsonb, 400)`,
      'refresh_assessment_funnel_daily': `select public.refresh_assessment_funnel_daily(current_date, current_date)`,
      'assessment_step_dropoff': `select * from public.assessment_step_dropoff('nails', current_date, current_date)`,
      'check_rate_limit': `select public.check_rate_limit('[]'::jsonb, 900, 20)`,
      'purge_expired_idempotency_records': `select public.purge_expired_idempotency_records(now(), 100)`,
      'redact_business_pii': `select public.redact_business_pii(gen_random_uuid(), 'human', 'x', 'y')`
    };

    for (const role of ['anon', 'authenticated']) {
      for (const [name, sql] of Object.entries(attempts)) {
        const result = await asRole(role, sql);
        assert.equal(result.permitted, false, `${role} must not be able to call ${name}`);
        assert.match(result.error, /permission denied/i,
          `${role} calling ${name} must be refused for PERMISSION, not for arguments: ${result.error}`);
      }
    }
  });

  /* ---------- forced RLS still does its job ---------- */

  await t.test('forced RLS keeps anon and authenticated out of every table', async () => {
    const tables = (await q(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and c.relrowsecurity and c.relforcerowsecurity
        order by 1`)).map(r => r.relname);
    assert.equal(tables.length, 14, 'RLS must be enabled AND forced on every table');

    for (const table of tables) {
      const read = await asRole('anon', `select * from public.${table} limit 1`);
      /* Refused outright is stronger than empty, and either is "cannot see
         it". Both are accepted; a row coming back is not. */
      if (read.permitted) {
        assert.deepEqual(read.rows, [], `anon must see no rows in ${table}`);
      } else {
        assert.match(read.error, /permission denied/i);
      }

      const write = await asRole('authenticated',
        `insert into public.${table} default values`);
      assert.equal(write.permitted, false, `authenticated must not write to ${table}`);
    }
  });

  await t.test('service_role bypasses RLS, which is what makes the endpoint work', async () => {
    /* The Growth ingestion above wrote rows. With RLS forced and no policy,
       the ONLY reason this returns them is BYPASSRLS on the role. */
    const read = await asRole('service_role',
      `select count(*)::int as n from public.business_records`);
    assert.equal(read.permitted, true, read.error);
    assert.ok(read.rows[0].n >= 1,
      'service_role must see rows that anon cannot, through BYPASSRLS rather than a policy');

    const [policies] = await q(
      `select count(*)::int as n from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname = 'public'`);
    assert.equal(policies.n, 0, 'and there must still be no policies anywhere');
  });

  await t.test('the signatures PostgREST resolves are the ones that carry the grants', async () => {
    /* An overload left behind by an earlier migration would make the
       PostgREST call ambiguous AND could carry different privileges. */
    for (const name of ['ingest_review', 'ingest_assessment', 'ingest_analytics_events']) {
      const overloads = await q(
        `select pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`, [name]);
      assert.equal(overloads.length, 1,
        `${name} must have exactly one signature; ${overloads.length} would be ambiguous`);
    }
  });
});
