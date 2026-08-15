/* ============================================================
   Migration 0008 — the three schema repairs, as catalog facts
   ------------------------------------------------------------
   ONE PostgreSQL cluster, in this file's own process, upgraded
   ACROSS the boundary 0008 exists to move: the chain is applied
   up to 0007, the three defects are OBSERVED to be present, and
   only then is 0008 applied and the same three questions asked
   again.

   That shape is deliberate. A test that applies the whole chain
   and finds the repaired state proves that 0008 is present; it
   does not prove that 0008 is what repaired anything. Every
   assertion below has a before and an after.

   F6 needs one extra thing to be honest about itself. On a real
   Supabase project, `alter default privileges in schema public
   grant all on functions to … service_role` gives service_role a
   DIRECT execute grant on every function as it is created, and
   0006's `revoke … from public, anon, authenticated` does not
   remove it. tests/helpers/local-pg.mjs creates the roles without
   those default privileges, so on PGlite service_role never held
   the grant, and
   tests/migration/0006-rpc-roles.test.mjs :: "trigger and helper
   functions are callable by nobody" passes against an absence.
   This file grants it explicitly first — the catalog cannot tell
   an explicit grant from one a default privilege produced — so
   the revoke has something real to remove.

   Real PostgreSQL, compiled to WebAssembly, with no host, no port
   and no credential. Nothing here can reach a hosted database;
   there is nothing to reach it with.

   Run with: npm run test:migration
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { startLocalPg, disposableDataDir } from '../helpers/local-pg.mjs';

const id = () => randomUUID();
const hash = s => createHash('sha256').update(s).digest('hex');

/* Every function in the chain that is called only from inside a trigger, or
   from inside a SECURITY DEFINER function that runs it as the owner. This is
   the list 0008 revokes, restated here rather than parsed out of the SQL: a
   test that reads its expectations from the file under test agrees with
   itself. */
const INTERNAL = [
  'reject_mutation()',
  'touch_updated_at()',
  'append_stage_timeline_events()',
  'append_bir_stage_event()',
  'append_service_mix_timeline_event()',
  'append_service_mix_bir_event()',
  'enforce_bir_supersession_scope()',
  'enforce_growth_only_current_bir()',
  'analytics_review_type(text, text)',
  'identity_proposal_conflict(jsonb, uuid)',
  /* The two 0006-rpc-roles.test.mjs never named at all. */
  'identity_value_acceptable(text, text)',
  'identity_evidence_fault(jsonb)',
  /* 0007's, already correct before 0008 and expected to stay that way. */
  'identity_case_eligible_targets(uuid)',
  'mask_contact_value(text)',
  'identity_resolution_replay(identity_resolution_requests, text, uuid)',
  'reject_case_evidence_change()'
];

/* What the server actually calls. 0008 must not have taken any of it away —
   a hardening migration that breaks ingestion is not hardening. */
const SERVER_RPCS = [
  'ingest_review(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb, text, uuid)',
  'ingest_assessment(text, text, jsonb, jsonb, jsonb, uuid, integer, jsonb)',
  'ingest_analytics_events(jsonb, jsonb, integer)',
  'check_rate_limit(jsonb, integer, integer)',
  'redact_business_pii(uuid, text, text, text)',
  'staff_operator_guard(uuid, text)',
  'staff_identity_queue(uuid, text, integer, integer)',
  'staff_identity_case(uuid, text, uuid)',
  'resolve_identity_case_link_existing(uuid, text, uuid, uuid, uuid, text, text, jsonb, text, boolean, text)',
  'bootstrap_staff_owner(uuid)'
];

const growthPayload = ({ submissionId, sessionId, name, email }) => ({
  schemaVersion: 3,
  assessmentVersion: '1.1.0',
  submissionId,
  assessmentSessionId: sessionId,
  vertical: { id: 'nails', name: 'Nail Salons' },
  submittedAt: new Date().toISOString(),
  contact: { salonName: name, ownerName: 'Owner', email },
  consent: { resultsDeliveryConsent: { granted: true, statement: 'Send my results…' } },
  attribution: { firstTouch: { url: 'https://nails.cedservice.test/' } },
  answers: { technicians: '3' },
  results: { score: 26, opportunity: 1679.7 }
});

const growthBir = displayName => ({
  schemaVersion: 2,
  identity: { businessId: null, identityStatus: 'resolution_pending', birId: null, legacyBusinessKey: null },
  provenance: { generatedBy: 'bie-v1.0.0', supersedes: null, isCurrent: true },
  businessProfile: { displayName },
  estimateConfidence: { score: 0.79, band: 'medium' },
  qualificationProfile: { outcome: 'insufficient_data', missingCriticalFields: [] },
  closeReadinessProfile: { score: 18, band: 'educate' },
  packageRecommendation: { packageId: 'salon-growth', priceMonthly: 597 }
});

const ingestGrowth = async (env, { name, email, sessionId = id() }) => {
  const submissionId = id();
  const birId = id();
  const { data, error } = await env.db.rpc('ingest_assessment', {
    p_idempotency_key: submissionId,
    p_request_hash: hash(submissionId),
    p_payload: growthPayload({ submissionId, sessionId, name, email }),
    p_signals: [],
    p_bir: growthBir(name),
    p_bir_id: birId,
    p_retention_days: 30,
    p_meta: { correlationId: submissionId }
  });
  assert.equal(error, null, error && error.message);
  return { ...data, submissionId, birId, sessionId };
};

test('0008 repairs three defects that are observed to exist first', async t => {
  const env = await startLocalPg({ upTo: '0007', dataDir: disposableDataDir('0008-hardening') });
  t.after(async () => { await env.close(); });

  const q = async (sql, params = []) => (await env.pg.query(sql, params)).rows;

  /* Fails rather than throws, so a refusal can be asserted on. */
  const attempt = async (sql, params = []) => {
    try {
      await env.pg.query(sql, params);
      return { permitted: true, error: null };
    } catch (err) {
      return { permitted: false, error: err.message };
    }
  };

  const canExecute = async signature => {
    const [row] = await q(
      `select has_function_privilege('service_role', $1, 'EXECUTE') as svc`,
      [`public.${signature}`]);
    return row.svc;
  };

  /* A real supersession chain, written by the real ingestion path: two Growth
     Reviews in one session, so the second links by session and chains onto the
     first. Plus a second, unrelated business to move a report to. */
  const first = await ingestGrowth(env, { name: 'Chain Salon', email: 'chain@polished.test' });
  const second = await ingestGrowth(env, {
    name: 'Chain Salon', email: 'chain@polished.test', sessionId: first.assessmentSessionId });
  const other = await ingestGrowth(env, { name: 'Other Salon', email: 'other@polished.test' });

  const businessA = first.businessId;
  const businessB = other.businessId;

  /* ============================================================
     BEFORE 0008 — the three defects, observed
     ============================================================ */

  await t.test('the fixture is a real chain within one business', async () => {
    assert.ok(businessA && businessB, 'both submissions resolved to a Business Record');
    assert.notEqual(businessA, businessB, 'and they are different businesses');
    assert.equal(second.businessId, businessA, 'the session linked the second review to the first record');

    const [row] = await q(
      `select supersedes_bir_id, business_id, review_type
         from public.business_intelligence_reports where bir_id = $1`, [second.birId]);
    assert.equal(row.supersedes_bir_id, first.birId,
      'the second report supersedes the first — there is a chain to break');
    assert.equal(row.business_id, businessA);
    assert.equal(row.review_type, 'growth_review');
  });

  await t.test('F3 — before 0008 the scope rule watches INSERT only', async () => {
    /* tgtype is a bitmask: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE. */
    const [trigger] = await q(
      `select tgtype from pg_trigger
        where tgrelid = 'public.business_intelligence_reports'::regclass
          and tgname = 'bir_supersession_scope'`);
    assert.equal(trigger.tgtype & 4, 4, 'it fires on INSERT');
    assert.equal(trigger.tgtype & 16, 0, 'and NOT on UPDATE — which is the defect');
  });

  await t.test('F3 — before 0008 an UPDATE can move a chained report to another business', async () => {
    /* The shape of 0007's resolve_identity_case_link_existing:
         update business_intelligence_reports set business_id = <target>
       That call cannot currently produce a violation, because a queued report
       has a null chain. Nothing enforces that; this is the same statement
       against a report that DOES have a chain. */
    const escape = await attempt(
      `update public.business_intelligence_reports set business_id = $1 where bir_id = $2`,
      [businessB, second.birId]);
    assert.equal(escape.permitted, true,
      'before 0008 the database permits it, and the invariant 0006 states is not enforced');

    const [row] = await q(
      `select b.business_id as moved, p.business_id as predecessor
         from public.business_intelligence_reports b
         join public.business_intelligence_reports p on p.bir_id = b.supersedes_bir_id
        where b.bir_id = $1`, [second.birId]);
    assert.equal(row.moved, businessB);
    assert.equal(row.predecessor, businessA);
    assert.notEqual(row.moved, row.predecessor,
      'a supersession chain now spans two Business Records, which 0006 says can never happen');

    /* Put it back, so everything after this measures 0008 and not the wreckage. */
    await env.pg.query(
      `update public.business_intelligence_reports set business_id = $1 where bir_id = $2`,
      [businessA, second.birId]);
  });

  await t.test('F6 — before 0008 a Supabase-style default privilege survives 0006\'s revoke', async () => {
    /* What `alter default privileges … grant all on functions to service_role`
       leaves in the catalog. Indistinguishable, once granted, from this. */
    for (const signature of INTERNAL) {
      await env.pg.exec(`grant execute on function public.${signature} to service_role`);
    }
    for (const signature of INTERNAL) {
      assert.equal(await canExecute(signature), true,
        `the fixture must really hold the grant for ${signature}, or the revoke below proves nothing`);
    }
  });

  await t.test('F7 — before 0008 the two helpers have no pinned search_path', async () => {
    const rows = await q(
      `select proname, proconfig from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in ('identity_value_acceptable', 'identity_evidence_fault')
        order by proname`);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.proconfig, null, `${row.proname} carries no setting of its own`);
    }
  });

  /* ============================================================
     Apply 0008
     ============================================================ */

  await t.test('0008 applies as an upgrade over a populated database', async () => {
    const applied = await env.upgrade('0007');
    /* 0008 is no longer the tail of the chain. The BI-to-Sales migrations sit
       behind it and come along on the same upgrade; this file's subject is
       still 0008, and every assertion below is about what 0008 did. */
    assert.deepEqual(applied.map(a => a.file), [
      '0008_staff_migration_hardening.sql',
      '0009_bi_sales_handoff_foundation.sql',
      '0010_sales_handoff_fk_indexes.sql',
      '0011_promotion_business_serialization.sql'
    ], 'the migrations that remained to apply, 0008 first');
    assert.ok(applied[0].statements > 0);
  });

  /* ============================================================
     AFTER 0008
     ============================================================ */

  await t.test('F3 — the scope rule now watches INSERT and UPDATE', async () => {
    const [trigger] = await q(
      `select tgtype from pg_trigger
        where tgrelid = 'public.business_intelligence_reports'::regclass
          and tgname = 'bir_supersession_scope'`);
    assert.equal(trigger.tgtype & 4, 4, 'still on INSERT');
    assert.equal(trigger.tgtype & 16, 16, 'and now on UPDATE');
    assert.equal(trigger.tgtype & 8, 0, 'and not on DELETE, which the rule says nothing about');
  });

  await t.test('F3 — moving a chained report to another business is now refused', async () => {
    const refused = await attempt(
      `update public.business_intelligence_reports set business_id = $1 where bir_id = $2`,
      [businessB, second.birId]);
    assert.equal(refused.permitted, false, 'the same UPDATE that succeeded above');
    assert.match(refused.error, /supersedes_business_mismatch/);

    const [row] = await q(
      `select business_id from public.business_intelligence_reports where bir_id = $1`,
      [second.birId]);
    assert.equal(row.business_id, businessA, 'and the row did not move');
  });

  await t.test('F3 — changing the review type out from under a chain is refused', async () => {
    const refused = await attempt(
      `update public.business_intelligence_reports set review_type = 'service_mix' where bir_id = $1`,
      [second.birId]);
    assert.equal(refused.permitted, false);
    assert.match(refused.error, /supersedes_review_type_mismatch/);
  });

  await t.test('F3 — the INSERT rule is unchanged', async () => {
    const refused = await attempt(
      `insert into public.business_intelligence_reports
         (bir_id, business_id, assessment_submission_id, schema_version, report,
          confidence_band, supersedes_bir_id, review_type)
       values ($1, $2, $3, 2, '{}'::jsonb, 'low', $4, 'growth_review')`,
      [id(), businessB, other.submissionId, first.birId]);
    assert.equal(refused.permitted, false, 'a new report for B may not chain onto A');
    assert.match(refused.error, /supersedes_business_mismatch/);
  });

  await t.test('F3 — a report-body rewrite is not made to re-prove the chain', async () => {
    /* The redaction shape. It touches `report` and nothing the rule reads, so
       the guard must return early rather than re-validate. */
    const permitted = await attempt(
      `update public.business_intelligence_reports
          set report = jsonb_set(report, '{businessProfile,displayName}', '"redacted"'::jsonb)
        where bir_id = $1`, [second.birId]);
    assert.equal(permitted.permitted, true, permitted.error);
  });

  await t.test('F3 — erasure still runs end to end over a chained business', async () => {
    /* The property that matters more than the shape above: a business whose
       reports form a chain must still be erasable after 0008. */
    const { data, error } = await env.db.rpc('redact_business_pii', {
      p_business_id: businessA,
      p_reason: 'verification that 0008 did not break erasure',
      p_actor: 'migration-test',
      p_actor_type: 'human'
    });
    assert.equal(error, null, error && error.message);
    assert.equal(data.businessId, businessA);
    assert.ok(data.redacted.birDisplayName >= 2,
      'both reports in the chain were redacted, so the UPDATE reached a chained row');
  });

  await t.test('F6 — every internal function is now refused to service_role', async () => {
    for (const signature of INTERNAL) {
      assert.equal(await canExecute(signature), false,
        `${signature} must not be executable by the server credential`);
    }
  });

  await t.test('F6 — and PUBLIC, anon and authenticated hold nothing either', async () => {
    for (const signature of INTERNAL) {
      const [row] = await q(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as auth`,
        [`public.${signature}`]);
      assert.equal(row.anon, false, `anon must not execute ${signature}`);
      assert.equal(row.auth, false, `authenticated must not execute ${signature}`);
    }

    const leaked = await q(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proacl is not null
          and exists (select 1 from aclexplode(p.proacl) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE')`);
    assert.deepEqual(leaked.map(r => `${r.proname}(${r.args})`), [],
      'PUBLIC must hold no execute grant anywhere in this schema');
  });

  await t.test('F6 — everything the server calls is still callable by the server', async () => {
    for (const signature of SERVER_RPCS) {
      assert.equal(await canExecute(signature), true,
        `0008 must not have taken ${signature} away from service_role`);
    }
  });

  await t.test('F7 — both helpers now pin the chain-wide search_path', async () => {
    const rows = await q(
      `select proname, proconfig from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in ('identity_value_acceptable', 'identity_evidence_fault')
        order by proname`);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(row.proconfig, ['search_path=pg_catalog, public, pg_temp'],
        `${row.proname} must carry the same setting as every other function`);
    }
  });

  await t.test('F7 — and no function in the chain is left unpinned', async () => {
    const unpinned = await q(
      `select proname from pg_proc
        where pronamespace = 'public'::regnamespace
          and prokind = 'f'
          and proconfig is null
        order by proname`);
    assert.deepEqual(unpinned.map(r => r.proname), [],
      'the convention is now exceptionless, so a future exception is visible');
  });

  /* ---------- 0008 changed permissions and a rule, not behaviour ---------- */

  await t.test('ingestion still works, through the functions 0008 revoked', async () => {
    /* identity_proposal_conflict, identity_value_acceptable and
       identity_evidence_fault are all reached by this call, and all three were
       just revoked from every role. They run as the owner inside a SECURITY
       DEFINER function, which is the whole basis for revoking them. */
    const resumed = await ingestGrowth(env, {
      name: 'Other Salon', email: 'other@polished.test', sessionId: other.assessmentSessionId });

    assert.equal(resumed.ok, true);
    assert.equal(resumed.businessId, businessB, 'the session still resolves identity');
    assert.equal(resumed.supersedesBirId, other.birId, 'and the chain still forms');
  });

  await t.test('a Service Mix review still refuses to supersede a Growth report', async () => {
    /* 0008 rewrote this trigger function. The rule it already enforced has to
       survive the rewrite, not just the new half. */
    const submissionId = id();
    const { data, error } = await env.db.rpc('ingest_review', {
      p_idempotency_key: submissionId,
      p_request_hash: hash(submissionId),
      p_payload: {
        schemaVersion: 6, reviewType: 'service_mix', assessmentVersion: '1.0.0',
        submissionId, assessmentSessionId: id(),
        vertical: { id: 'nails' }, submittedAt: new Date().toISOString(),
        contact: { salonName: 'Other Salon', email: 'other@polished.test' },
        consent: { resultsDeliveryConsent: { granted: true, statement: 'Send my results…' } },
        attribution: { firstTouch: {} },
        serviceMix: { coverage: 'all_offerings', offerings: [{}, {}] }
      },
      p_signals: [],
      p_bir: {
        schemaVersion: 5, reportType: 'service_mix', reportVersion: 1,
        identity: { businessId: null, identityStatus: 'resolution_pending', birId: null,
                    legacyBusinessKey: null, reviewType: 'service_mix' },
        provenance: { generatedBy: 'service-mix-engine-v1.0.0', supersedes: null, isCurrent: true },
        dataConfidence: { confidence: 0.9 },
        serviceMixHealth: { classification: 'generally_healthy' },
        portfolioCoverage: { offeringsAnalysed: 2 },
        measurementGaps: []
      },
      p_bir_id: id(),
      p_retention_days: 30,
      p_meta: {},
      p_review_type: 'service_mix',
      p_continuation_business_id: null
    });

    assert.equal(error, null, error && error.message);
    assert.equal(data.reviewType, 'service_mix');
    assert.equal(data.supersedesBirId, null,
      'a first Service Mix review chains onto nothing, and never onto the Growth chain');
  });

  await t.test('0008 is re-runnable', async () => {
    const before = await q(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args,
              p.proconfig, p.proacl::text as acl
         from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1, 2`);
    const triggersBefore = await q(
      `select tgname, pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.business_intelligence_reports'::regclass
          and not tgisinternal order by 1`);

    /* Bounded at 0008: this assertion is about 0008's own re-runnability, and
       0009/0010 are reconciled records that are deliberately not re-runnable.
       See CLAUDE.md §14. */
    await env.upgrade('0007', '0008');

    const after = await q(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args,
              p.proconfig, p.proacl::text as acl
         from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1, 2`);
    const triggersAfter = await q(
      `select tgname, pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.business_intelligence_reports'::regclass
          and not tgisinternal order by 1`);

    assert.deepEqual(after, before, 'a second application changes no function and no privilege');
    assert.deepEqual(triggersAfter, triggersBefore, 'and no trigger');
  });
});
