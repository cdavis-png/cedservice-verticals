/* ============================================================
   What the PUBLISHABLE key can reach — nothing
   ------------------------------------------------------------
   THE CLAIM THIS FILE EXISTS TO PROVE.

   `staff/identity-resolution/accept-invite.html` holds a Supabase
   PUBLISHABLE key, because it must: it sets a password and enrolls
   a TOTP factor, and none of those values may pass through a CED
   endpoint. Everything written about that decision rests on one
   sentence — "the publishable key grants nothing, because RLS is
   enabled and FORCED with no policies and no function is
   executable by anon".

   That sentence was previously an assertion in prose. This file
   makes it a catalog fact, in a real PostgreSQL, against the real
   migration chain including 0007.

   A publishable key authenticates to PostgREST as the `anon`
   role, and a signed-in one as `authenticated`. Both are checked
   here, on every table and every function 0007 added, plus the
   staff surface 0001–0006 created.

   Run with: npm run test:migration
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startLocalPg, disposableDataDir } from '../helpers/local-pg.mjs';

/* The two roles a browser key can ever become. */
const BROWSER_ROLES = ['anon', 'authenticated'];

/* Everything the staff subsystem owns. A browser must not read, write, or
   execute any of it. */
const STAFF_TABLES = [
  'staff_operators',
  'identity_resolution_requests',
  'identity_resolution_cases',
  'business_records',
  'assessment_submissions',
  'business_intelligence_reports'
];

const STAFF_FUNCTIONS = [
  ['staff_operator_guard', "('11111111-1111-4111-8111-111111111111'::uuid, 'aal2')"],
  ['staff_identity_queue', "('11111111-1111-4111-8111-111111111111'::uuid, 'aal2', 25, 0)"],
  ['staff_identity_case', "('11111111-1111-4111-8111-111111111111'::uuid, 'aal2', '22222222-2222-4222-8222-222222222222'::uuid)"],
  ['bootstrap_staff_owner', "('11111111-1111-4111-8111-111111111111'::uuid)"],
  ['identity_case_eligible_targets', "('22222222-2222-4222-8222-222222222222'::uuid)"]
];

test('a browser key can reach nothing in the staff surface', async t => {
  const env = await startLocalPg({ dataDir: disposableDataDir('0007-anon-grants') });
  t.after(async () => { await env.close(); });

  const asRole = async (role, sql) => {
    await env.pg.exec(`set role ${role}`);
    try {
      const rows = (await env.pg.query(sql)).rows;
      return { permitted: true, rows, error: null };
    } catch (err) {
      return { permitted: false, rows: null, error: err.message };
    } finally {
      await env.pg.exec('reset role');
    }
  };

  await t.test('the roles a browser key becomes really exist', async () => {
    /* Otherwise every refusal below would be "no such role" and would prove
       nothing at all. */
    for (const role of BROWSER_ROLES) {
      const { rows } = await env.pg.query(
        'select 1 from pg_roles where rolname = $1', [role]);
      assert.equal(rows.length, 1, `${role} must exist for this test to mean anything`);
    }
  });

  await t.test('0007 really was applied, so this is testing the right schema', async () => {
    const { rows } = await env.pg.query(
      `select tablename from pg_tables
        where schemaname = 'public'
          and tablename in ('staff_operators','identity_resolution_requests')`);
    assert.equal(rows.length, 2, '0007 must be in the chain');
  });

  await t.test('no browser role may SELECT any staff table', async () => {
    for (const role of BROWSER_ROLES) {
      for (const table of STAFF_TABLES) {
        const result = await asRole(role, `select * from public.${table} limit 1`);
        assert.equal(result.permitted, false,
          `${role} could SELECT ${table} — the publishable key would read it`);
        assert.match(result.error, /permission denied/i, `${role} / ${table}`);
      }
    }
  });

  await t.test('no browser role may INSERT, UPDATE or DELETE a staff table', async () => {
    /* The one that matters most: `staff_operators`. A browser that could
       write it would authorize itself, and every other guarantee in the
       subsystem would be decoration. */
    for (const role of BROWSER_ROLES) {
      const writes = [
        `insert into public.staff_operators (user_id, role, active)
           values ('11111111-1111-4111-8111-111111111111', 'owner', true)`,
        `update public.staff_operators set active = true`,
        `delete from public.staff_operators`
      ];
      for (const sql of writes) {
        const result = await asRole(role, sql);
        assert.equal(result.permitted, false,
          `${role} could write staff_operators: ${sql.split('\n')[0]}`);
        assert.match(result.error, /permission denied/i);
      }
    }
  });

  await t.test('no browser role may EXECUTE any staff function', async () => {
    for (const role of BROWSER_ROLES) {
      for (const [fn, args] of STAFF_FUNCTIONS) {
        const result = await asRole(role, `select public.${fn}${args}`);
        assert.equal(result.permitted, false,
          `${role} could execute ${fn} — the publishable key would call it`);
        assert.match(result.error, /permission denied/i, `${role} / ${fn}`);
      }
    }
  });

  await t.test('the mutation that attaches a record is unreachable too', async () => {
    for (const role of BROWSER_ROLES) {
      const result = await asRole(role,
        `select public.resolve_identity_case_link_existing(
           '11111111-1111-4111-8111-111111111111'::uuid, 'aal2',
           '22222222-2222-4222-8222-222222222222'::uuid,
           '33333333-3333-4333-8333-333333333333'::uuid,
           '44444444-4444-4444-8444-444444444444'::uuid,
           'note', 'verified_same_business', '[]'::jsonb, 'hash', false, null)`);
      assert.equal(result.permitted, false, `${role} could execute the mutation`);
      assert.match(result.error, /permission denied/i);
    }
  });

  await t.test('RLS is enabled AND forced on the tables 0007 added', async () => {
    /* Grants are the first fence; forced RLS with no policies is the second.
       Both, because a future GRANT would silently undo the first. */
    const { rows } = await env.pg.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('staff_operators','identity_resolution_requests')`);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname}: RLS enabled`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname}: RLS FORCED`);
    }

    const policies = await env.pg.query(
      `select tablename, policyname from pg_policies
        where schemaname = 'public'
          and tablename in ('staff_operators','identity_resolution_requests')`);
    assert.deepEqual(policies.rows, [],
      'no policies — forced RLS with none means nothing passes, whatever is granted');
  });

  await t.test('service_role CAN reach them, so the refusals above are about the ROLE', async () => {
    /* Without this, a broken fixture that refused everybody would pass every
       assertion in this file. */
    const allowed = await asRole('service_role',
      "select public.staff_operator_guard('11111111-1111-4111-8111-111111111111'::uuid, 'aal2')");
    /* It raises `staff_not_an_operator` — a BUSINESS refusal, reached only
       because the EXECUTE grant let the call happen at all. */
    assert.equal(allowed.permitted, false);
    assert.match(allowed.error, /staff_not_an_operator/,
      'service_role reached the function body; anon never did');
    assert.equal(/permission denied/i.test(allowed.error), false);
  });
});
