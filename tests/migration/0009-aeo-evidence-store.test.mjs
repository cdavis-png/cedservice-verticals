/* ============================================================
   0009 — the AEO evidence store, in real PostgreSQL
   ------------------------------------------------------------
   Every claim the review will later make about consumer visibility
   rests on these being true in the DATABASE rather than in the
   harness, because a harness can be bypassed and a constraint
   cannot.

     1. SYNTHETIC EVIDENCE IS NEVER ADMISSIBLE. Fixture and replay
        rows can never be admissible, can never count toward
        consumer reach, and can never be relabelled live after
        insertion. Capture status and admissibility stay separate:
        a fixture run can succeed completely as a capture and be
        worth nothing as evidence.

     2. AN OWNER APPROVES AN EXACT WORKLOAD. Attempts are
        materialized, hashed, counted and priced BEFORE approval;
        the owner approves that hash, count and ceiling; the set is
        frozen afterwards; and configuration changed later cannot
        reach a batch already materialized.

     3. RAW PAYLOADS EXPIRE, EVIDENCE DOES NOT. Disposal removes
        the text and keeps the provenance, the byte count and the
        SHA-256, and writes an append-only audit row.

   Run with: npm run test:migration
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startLocalPg, disposableDataDir } from '../helpers/local-pg.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESOLVER = '22222222-2222-4222-8222-222222222222';

const refused = async fn => {
  try { await fn(); return { refused: false, error: null }; }
  catch (err) { return { refused: true, error: err.message }; }
};

/* An authorized market, a frozen two-question panel, and two
   configurations for the SAME engine — one consumer surface, one proxy.
   Two configurations for one engine is exactly the shape section 4.4
   warns about, so it is what the guards are tested against. */
const seed = async (pg, { executionMode = 'live_capture' } = {}) => {
  const one = async (sql, params) => (await pg.query(sql, params)).rows[0];

  await pg.query(`insert into public.staff_operators (user_id, role, active)
                  values ($1,'owner',true) on conflict do nothing`, [OWNER]);
  await pg.query(`insert into public.staff_operators (user_id, role, active)
                  values ($1,'identity_resolver',true) on conflict do nothing`, [RESOLVER]);

  /* A distinct market per seed: aeo_markets_place_key is unique on
     (city, state, country), which is the point of that index. */
  const market = await one(
    `insert into public.aeo_markets (city,state,status,authorized_at)
     values ('Easley-' || substr(gen_random_uuid()::text,1,8),'SC','authorized',now()) returning *`);
  const panel = await one(
    `insert into public.aeo_panel_versions (category,version,frozen_at)
     values ('nail_salon', 'v' || gen_random_uuid()::text, now()) returning *`);
  await pg.query(
    `insert into public.aeo_panel_questions (panel_version_id,question_key,intent,template,position)
     values ($1,'Q1','general','What are the best nail salons in {city}, {state}?',1),
            ($1,'Q2','reputation','Which nail salon in {city}, {state} has the best reputation?',2)`,
    [panel.panel_version_id]);

  const engine = await one(
    `insert into public.aeo_engines (engine_key,display_name)
     values ('chatgpt-' || gen_random_uuid()::text,'ChatGPT') returning *`);
  const consumer = await one(
    `insert into public.aeo_engine_configurations
       (engine_id,surface_type,product_name,capture_method,collector_version,estimated_unit_cost_usd)
     values ($1,'consumer_surface','ChatGPT (consumer web)','vendor_scraper','none',0.50) returning *`,
    [engine.engine_id]);
  const proxy = await one(
    `insert into public.aeo_engine_configurations
       (engine_id,surface_type,product_name,model_identifier,capture_method,collector_version,estimated_unit_cost_usd)
     values ($1,'proxy','ChatGPT API','gpt-x','vendor_api','none',0.10) returning *`,
    [engine.engine_id]);

  await pg.query(
    `insert into public.aeo_panel_engine_configurations
       (panel_version_id,engine_configuration_id,tier,scheduled_runs_per_question)
     values ($1,$2,'consumer',2), ($1,$3,'diagnostic',1)`,
    [panel.panel_version_id, consumer.engine_configuration_id, proxy.engine_configuration_id]);

  const batch = await one(
    `insert into public.aeo_scan_batches (market_id,panel_version_id,requested_by,execution_mode)
     values ($1,$2,$3,$4) returning *`,
    [market.market_id, panel.panel_version_id, OWNER, executionMode]);

  return { market, panel, engine, consumer, proxy, batch, one };
};

const materialize = (pg, batchId) =>
  pg.query(`select * from public.aeo_materialize_scan_batch($1)`, [batchId]);

const approve = async (pg, f, over = {}) => {
  const b = (await pg.query(
    `select plan_hash, attempt_count, max_estimated_cost_usd
       from public.aeo_scan_batches where scan_batch_id=$1`, [f.batch.scan_batch_id])).rows[0];
  return pg.query(
    `select public.aeo_approve_scan_batch($1,$2,$3,$4,$5)`,
    [f.batch.scan_batch_id, over.approver ?? OWNER,
     over.hash ?? b.plan_hash, over.count ?? b.attempt_count,
     over.ceiling ?? Number(b.max_estimated_cost_usd)]);
};

const attemptsOf = async (pg, batchId) => (await pg.query(
  `select * from public.aeo_scan_attempts where scan_batch_id=$1
    order by engine_configuration_id, panel_question_id, run_index`, [batchId])).rows;

/* Capture times are relative to REAL database time, because retention is
   now enforced against database time with no caller-supplied cutoff.
   `agedDays` moves the capture into the past so its 180-day expiry has
   or has not already passed. */
const record = (pg, attemptId, over = {}) => {
  const at = over.agedDays === undefined
    ? { requested: over.requestedAt ?? '2026-08-10T12:00:00Z',
        received: 'receivedAt' in over ? over.receivedAt : '2026-08-10T12:00:02Z' }
    : { requested: `now() - interval '${over.agedDays} days'`,
        received: `now() - interval '${over.agedDays} days'` };

  if (over.agedDays === undefined) {
    return pg.query(
      `select * from public.aeo_record_observation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [attemptId, over.origin ?? 'live_capture', over.status ?? 'response_observed',
       over.personalization ?? 'clean', at.requested, at.received,
       'rawResponse' in over ? over.rawResponse : 'A list of salons.',
       over.contentType ?? 'text/plain', JSON.stringify(over.citations ?? []),
       over.failureReason ?? null]);
  }
  /* Interval arithmetic must happen in SQL so it is measured against the
     database clock the retention rule uses. */
  return pg.query(
    `select * from public.aeo_record_observation($1,$2,$3,$4,${at.requested},${at.received},$5,$6,$7,$8)`,
    [attemptId, over.origin ?? 'live_capture', over.status ?? 'response_observed',
     over.personalization ?? 'clean',
     'rawResponse' in over ? over.rawResponse : 'A list of salons.',
     over.contentType ?? 'text/plain', JSON.stringify(over.citations ?? []),
     over.failureReason ?? null]);
};

test('0009 evidence store', async t => {
  const env = await startLocalPg({ dataDir: disposableDataDir('0009-aeo-evidence-store') });
  t.after(async () => { await env.close(); });
  const pg = env.pg;

  await t.test('0009 really is in the chain', async () => {
    const { rows } = await pg.query(
      `select tablename from pg_tables where schemaname='public' and tablename like 'aeo_%'`);
    assert.equal(rows.length, 11, 'all eleven aeo_ tables must exist');
  });

  /* ================= 1. APPROVAL LIFECYCLE ================= */

  await t.test('a batch cannot be approved before it is materialized', async () => {
    const f = await seed(pg);
    const r = await refused(() => pg.query(
      `select public.aeo_approve_scan_batch($1,$2,'deadbeef',1,10.00)`,
      [f.batch.scan_batch_id, OWNER]));
    assert.equal(r.refused, true);
    assert.match(r.error, /no materialized plan to approve/i);
  });

  await t.test('materialization produces the exact attempts, count, cost and hash', async () => {
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);
    const b = (await pg.query(`select * from public.aeo_scan_batches where scan_batch_id=$1`,
      [f.batch.scan_batch_id])).rows[0];

    /* 2 questions x (2 consumer + 1 proxy) = 6 */
    assert.equal(b.attempt_count, 6);
    assert.equal(b.status, 'materialized');
    /* 4 consumer @ 0.50 + 2 proxy @ 0.10 = 2.20 */
    assert.equal(Number(b.max_estimated_cost_usd), 2.2);
    assert.match(b.plan_hash, /^[0-9a-f]{64}$/);
    assert.equal((await attemptsOf(pg, f.batch.scan_batch_id)).length, 6);
  });

  await t.test('the plan hash is deterministic for an identical plan', async () => {
    const a = await seed(pg); const b = await seed(pg);
    await materialize(pg, a.batch.scan_batch_id);
    await materialize(pg, b.batch.scan_batch_id);
    const hashes = (await pg.query(
      `select plan_hash from public.aeo_scan_batches where scan_batch_id in ($1,$2)`,
      [a.batch.scan_batch_id, b.batch.scan_batch_id])).rows.map(r => r.plan_hash);
    /* Different markets and panels, so the hashes MUST differ — the hash
       covers the workload, not just its shape. */
    assert.notEqual(hashes[0], hashes[1]);

    /* Re-materializing the same batch reproduces its own hash. */
    const before = (await pg.query(`select plan_hash from public.aeo_scan_batches where scan_batch_id=$1`,
      [a.batch.scan_batch_id])).rows[0].plan_hash;
    await materialize(pg, a.batch.scan_batch_id);
    const after = (await pg.query(`select plan_hash from public.aeo_scan_batches where scan_batch_id=$1`,
      [a.batch.scan_batch_id])).rows[0].plan_hash;
    assert.equal(after, before);
  });

  await t.test('questions are fully rendered; a placeholder cannot survive', async () => {
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);
    const rows = await attemptsOf(pg, f.batch.scan_batch_id);
    rows.forEach(r => {
      assert.match(r.question_text, new RegExp(f.market.city + ', SC'));
      assert.ok(!/\{[a-z]+\}/i.test(r.question_text), r.question_text);
    });

    const bad = await refused(() => pg.query(
      `insert into public.aeo_scan_attempts
         (scan_batch_id,engine_configuration_id,panel_question_id,market_id,run_index,tier,surface_type,question_text)
       select scan_batch_id,engine_configuration_id,panel_question_id,market_id,99,tier,surface_type,
              'Best salons in {city}?' from public.aeo_scan_attempts where scan_batch_id=$1 limit 1`,
      [f.batch.scan_batch_id]));
    assert.equal(bad.refused, true, 'an unrendered question was accepted');
  });

  await t.test('STALE PLAN: approval fails if the plan changed since review', async () => {
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);
    const reviewed = (await pg.query(
      `select plan_hash, attempt_count, max_estimated_cost_usd
         from public.aeo_scan_batches where scan_batch_id=$1`, [f.batch.scan_batch_id])).rows[0];

    /* CONFIGURATION DRIFT: another engine is pinned after the review. */
    const e2 = (await pg.query(
      `insert into public.aeo_engines (engine_key,display_name)
       values ('gemini-' || gen_random_uuid()::text,'Gemini') returning *`)).rows[0];
    const c2 = (await pg.query(
      `insert into public.aeo_engine_configurations
         (engine_id,surface_type,product_name,capture_method,collector_version,estimated_unit_cost_usd)
       values ($1,'consumer_surface','Gemini app','vendor_scraper','none',0.25) returning *`,
      [e2.engine_id])).rows[0];
    await pg.query(
      `insert into public.aeo_panel_engine_configurations
         (panel_version_id,engine_configuration_id,tier,scheduled_runs_per_question)
       values ($1,$2,'consumer',5)`, [f.panel.panel_version_id, c2.engine_configuration_id]);

    await materialize(pg, f.batch.scan_batch_id);

    const stale = await refused(() => pg.query(
      `select public.aeo_approve_scan_batch($1,$2,$3,$4,$5)`,
      [f.batch.scan_batch_id, OWNER, reviewed.plan_hash, reviewed.attempt_count,
       Number(reviewed.max_estimated_cost_usd)]));
    assert.equal(stale.refused, true, 'a stale plan was approved');
    assert.match(stale.error, /plan changed since it was reviewed/i);
  });

  await t.test('COST: approval fails if the estimate exceeds the ceiling', async () => {
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);
    const r = await refused(() => approve(pg, f, { ceiling: 0.01 }));
    assert.equal(r.refused, true);
    assert.match(r.error, /exceeds the approved ceiling/i);
  });

  await t.test('COUNT: approval fails if the attempt count moved', async () => {
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);
    const r = await refused(() => approve(pg, f, { count: 99 }));
    assert.equal(r.refused, true);
    assert.match(r.error, /attempt count changed/i);
  });

  await t.test('APPROVAL RECOMPUTES: every pre-approval mutation is caught', async () => {
    /* The invariant this proves. Approval must recalculate the hash,
       count and cost from the CURRENT aeo_scan_attempts rows inside the
       approval transaction. Comparing the caller's values against the
       batch's own stored fields would pass every case below, because
       nothing updates those fields when an attempt row changes — the
       reviewer and the batch would agree with each other while the
       workload underneath them had moved.

       Each case mutates the materialized workload directly, then
       attempts approval with the values a reviewer saw a moment
       earlier. Every one must be refused. */
    const mutations = [
      ['insert an attempt', async (f, a) => pg.query(
        `insert into public.aeo_scan_attempts
           (scan_batch_id,engine_configuration_id,panel_question_id,market_id,run_index,
            tier,surface_type,question_text,unit_cost_usd)
         values ($1,$2,$3,$4,777,'consumer','consumer_surface','Injected question',0.50)`,
        [f.batch.scan_batch_id, a.engine_configuration_id, a.panel_question_id, a.market_id])],

      ['delete an attempt', async (f, a) => pg.query(
        `delete from public.aeo_scan_attempts where scan_attempt_id=$1`, [a.scan_attempt_id])],

      ['change question text', async (f, a) => pg.query(
        `update public.aeo_scan_attempts set question_text='Something else entirely'
          where scan_attempt_id=$1`, [a.scan_attempt_id])],

      ['change run index', async (f, a) => pg.query(
        `update public.aeo_scan_attempts set run_index=42 where scan_attempt_id=$1`,
        [a.scan_attempt_id])],

      ['change surface type', async (f, a) => pg.query(
        `update public.aeo_scan_attempts set surface_type='proxy' where scan_attempt_id=$1`,
        [a.scan_attempt_id])],

      ['increase unit cost', async (f, a) => pg.query(
        `update public.aeo_scan_attempts set unit_cost_usd=99.99 where scan_attempt_id=$1`,
        [a.scan_attempt_id])],

      ['replace the engine configuration reference', async (f, a) => pg.query(
        `update public.aeo_scan_attempts set engine_configuration_id=$2 where scan_attempt_id=$1`,
        [a.scan_attempt_id, f.proxy.engine_configuration_id])]
    ];

    for (const [label, mutate] of mutations) {
      const f = await seed(pg);
      await materialize(pg, f.batch.scan_batch_id);

      /* What a reviewer read, before the mutation. */
      const reviewed = (await pg.query(
        `select plan_hash, attempt_count, max_estimated_cost_usd
           from public.aeo_scan_batches where scan_batch_id=$1`, [f.batch.scan_batch_id])).rows[0];

      const [target] = await attemptsOf(pg, f.batch.scan_batch_id);
      const applied = await refused(() => mutate(f, target));

      /* Either the mutation is refused outright, or approval catches
         it. Both are acceptable outcomes; silently approving is not. */
      if (applied.refused) continue;

      const approval = await refused(() => pg.query(
        `select public.aeo_approve_scan_batch($1,$2,$3,$4,$5)`,
        [f.batch.scan_batch_id, OWNER, reviewed.plan_hash, reviewed.attempt_count,
         Number(reviewed.max_estimated_cost_usd)]));

      assert.equal(approval.refused, true,
        `approval accepted a plan after "${label}" — it is comparing stored fields, not recomputing`);
      assert.match(approval.error, /changed|exceeds/i, label);

      /* And the batch really did not get approved. */
      const b = (await pg.query(
        `select status, approved_at from public.aeo_scan_batches where scan_batch_id=$1`,
        [f.batch.scan_batch_id])).rows[0];
      assert.equal(b.approved_at, null, `${label}: the batch was approved anyway`);
      assert.equal(b.status, 'materialized');
    }
  });

  /* ---------- cost must be established, never assumed ---------- */

  /* A panel whose single configuration carries the given cost. `null`
     means the cost was never established — which is not the same as
     an explicit zero, and must not be treated as one. */
  const pricedBatch = async cost => {
    const one = async (sql, p) => (await pg.query(sql, p)).rows[0];
    const market = await one(
      `insert into public.aeo_markets (city,state,status,authorized_at)
       values ('Priced-' || substr(gen_random_uuid()::text,1,8),'SC','authorized',now()) returning *`);
    const panel = await one(
      `insert into public.aeo_panel_versions (category,version,frozen_at)
       values ('nail_salon','v'||gen_random_uuid()::text,now()) returning *`);
    await pg.query(
      `insert into public.aeo_panel_questions (panel_version_id,question_key,intent,template,position)
       values ($1,'Q1','general','Best nail salons in {city}, {state}?',1)`, [panel.panel_version_id]);
    const engine = await one(
      `insert into public.aeo_engines (engine_key,display_name)
       values ('e-'||gen_random_uuid()::text,'E') returning *`);
    /* Omitted vs explicit: two different INSERTs, not one with a null. */
    const config = cost === null
      ? await one(
          `insert into public.aeo_engine_configurations
             (engine_id,surface_type,product_name,capture_method,collector_version)
           values ($1,'consumer_surface','Unpriced engine','m','v') returning *`, [engine.engine_id])
      : await one(
          `insert into public.aeo_engine_configurations
             (engine_id,surface_type,product_name,capture_method,collector_version,estimated_unit_cost_usd)
           values ($1,'consumer_surface','Priced engine','m','v',$2) returning *`,
          [engine.engine_id, cost]);
    await pg.query(
      `insert into public.aeo_panel_engine_configurations
         (panel_version_id,engine_configuration_id,tier,scheduled_runs_per_question)
       values ($1,$2,'consumer',2)`, [panel.panel_version_id, config.engine_configuration_id]);
    const batch = await one(
      `insert into public.aeo_scan_batches (market_id,panel_version_id,execution_mode)
       values ($1,$2,'fixture') returning *`, [market.market_id, panel.panel_version_id]);
    return { market, panel, engine, config, batch };
  };

  await t.test('COST: an omitted unit cost stays unknown and blocks the plan', async () => {
    const p = await pricedBatch(null);
    assert.equal(p.config.estimated_unit_cost_usd, null,
      'an omitted cost must be NULL, not silently 0');

    const m = await refused(() => materialize(pg, p.batch.scan_batch_id));
    assert.equal(m.refused, true, 'an unpriced plan was materialized');
    assert.match(m.error, /no established unit cost/i);
    assert.match(m.error, /Unpriced engine/, 'the error must name what needs pricing');

    /* And it never became executable. */
    const b = (await pg.query(
      `select status, materialized_at, max_estimated_cost_usd, approved_at
         from public.aeo_scan_batches where scan_batch_id=$1`, [p.batch.scan_batch_id])).rows[0];
    assert.equal(b.status, 'draft');
    assert.equal(b.materialized_at, null);
    assert.equal(b.max_estimated_cost_usd, null);
    assert.equal(b.approved_at, null);
  });

  await t.test('COST: an explicit zero is accepted and priced at zero', async () => {
    const p = await pricedBatch(0);
    await materialize(pg, p.batch.scan_batch_id);
    const b = (await pg.query(
      `select attempt_count, max_estimated_cost_usd, plan_hash
         from public.aeo_scan_batches where scan_batch_id=$1`, [p.batch.scan_batch_id])).rows[0];
    assert.equal(b.attempt_count, 2);
    assert.equal(Number(b.max_estimated_cost_usd), 0,
      'a genuinely free capture is priced at an explicit 0');

    await pg.query(`select public.aeo_approve_scan_batch($1,$2,$3,$4,$5)`,
      [p.batch.scan_batch_id, OWNER, b.plan_hash, b.attempt_count, 0]);
    const after = (await pg.query(
      `select status, approved_cost_ceiling from public.aeo_scan_batches where scan_batch_id=$1`,
      [p.batch.scan_batch_id])).rows[0];
    assert.equal(after.status, 'approved');
    assert.equal(Number(after.approved_cost_ceiling), 0);
  });

  await t.test('COST: explicit zero and omitted cost hash differently', async () => {
    /* The failure this prevents: interpolating a NULL makes the whole
       row's text NULL, string_agg DROPS it, and an unpriced attempt
       disappears from the fingerprint of the plan it belongs to. */
    const { rows } = await pg.query(
      `select encode(sha256(convert_to(coalesce((0)::numeric(10,4)::text,'UNPRICED'),'UTF8')),'hex') as zero,
              encode(sha256(convert_to(coalesce((null)::numeric(10,4)::text,'UNPRICED'),'UTF8')),'hex') as unpriced`);
    assert.notEqual(rows[0].zero, rows[0].unpriced);
  });

  await t.test('COST: a positive cost is summed exactly', async () => {
    const p = await pricedBatch(0.25);
    await materialize(pg, p.batch.scan_batch_id);
    const b = (await pg.query(
      `select max_estimated_cost_usd from public.aeo_scan_batches where scan_batch_id=$1`,
      [p.batch.scan_batch_id])).rows[0];
    assert.equal(Number(b.max_estimated_cost_usd), 0.5, '2 runs x 0.25');
  });

  await t.test('COST: a mixed priced/unpriced plan is refused entirely', async () => {
    const p = await pricedBatch(0.25);
    const e2 = (await pg.query(
      `insert into public.aeo_engines (engine_key,display_name)
       values ('e2-'||gen_random_uuid()::text,'E2') returning *`)).rows[0];
    const unpriced = (await pg.query(
      `insert into public.aeo_engine_configurations
         (engine_id,surface_type,product_name,capture_method,collector_version)
       values ($1,'consumer_surface','Second unpriced engine','m','v') returning *`,
      [e2.engine_id])).rows[0];
    await pg.query(
      `insert into public.aeo_panel_engine_configurations
         (panel_version_id,engine_configuration_id,tier,scheduled_runs_per_question)
       values ($1,$2,'secondary',1)`, [p.panel.panel_version_id, unpriced.engine_configuration_id]);

    const m = await refused(() => materialize(pg, p.batch.scan_batch_id));
    assert.equal(m.refused, true, 'a partly priced plan was materialized');
    assert.match(m.error, /1 of 3 attempts/, 'the error must count what is unpriced');
    assert.match(m.error, /Second unpriced engine/);
  });

  await t.test('COST: an approved batch can never carry an unknown maximum', async () => {
    /* The invariant as a constraint, not only as function logic. */
    const p = await pricedBatch(0.25);
    await materialize(pg, p.batch.scan_batch_id);
    const r = await refused(() => pg.query(
      `update public.aeo_scan_batches
          set status='approved', approved_at=now(), approved_by=$2,
              approved_plan_hash='x', approved_attempt_count=2, approved_cost_ceiling=1,
              max_estimated_cost_usd=null
        where scan_batch_id=$1`, [p.batch.scan_batch_id, OWNER]));
    assert.equal(r.refused, true, 'a batch was approved with an unknown maximum cost');
  });

  await t.test('COST: an immutable priced configuration cannot be replaced by an unpriced one', async () => {
    const p = await pricedBatch(0.25);
    await materialize(pg, p.batch.scan_batch_id);

    /* The configuration itself cannot lose its price. */
    const unprice = await refused(() => pg.query(
      `update public.aeo_engine_configurations set estimated_unit_cost_usd=null
        where engine_configuration_id=$1`, [p.config.engine_configuration_id]));
    assert.equal(unprice.refused, true, 'a priced configuration was un-priced');

    /* And an attempt cannot be repointed at an unpriced configuration. */
    const e2 = (await pg.query(
      `insert into public.aeo_engines (engine_key,display_name)
       values ('e3-'||gen_random_uuid()::text,'E3') returning *`)).rows[0];
    const unpriced = (await pg.query(
      `insert into public.aeo_engine_configurations
         (engine_id,surface_type,product_name,capture_method,collector_version)
       values ($1,'consumer_surface','Cheap-looking engine','m','v') returning *`,
      [e2.engine_id])).rows[0];
    const [attempt] = await attemptsOf(pg, p.batch.scan_batch_id);
    const repoint = await refused(() => pg.query(
      `update public.aeo_scan_attempts set engine_configuration_id=$2 where scan_attempt_id=$1`,
      [attempt.scan_attempt_id, unpriced.engine_configuration_id]));
    assert.equal(repoint.refused, true, 'an attempt was repointed at an unpriced configuration');
  });

  await t.test('APPROVAL RECOMPUTES: re-materializing after a mutation restores approvability', async () => {
    /* The recovery path. A changed plan is not a dead end — it is a
       plan that must be reviewed again. */
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);
    const [target] = await attemptsOf(pg, f.batch.scan_batch_id);
    /* A DELETE, because an update to a materialized attempt is refused
       outright — the stronger of the two outcomes the rule permits. */
    await pg.query(`delete from public.aeo_scan_attempts where scan_attempt_id=$1`,
      [target.scan_attempt_id]);

    await materialize(pg, f.batch.scan_batch_id);        /* re-review */
    await approve(pg, f);                                /* approve the CURRENT plan */

    const b = (await pg.query(
      `select status, approved_attempt_count from public.aeo_scan_batches where scan_batch_id=$1`,
      [f.batch.scan_batch_id])).rows[0];
    assert.equal(b.status, 'approved');
    assert.equal(b.approved_attempt_count, 6);
  });

  await t.test('an active owner approves the exact plan, and only once', async () => {
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);

    const b = (await pg.query(
      `select status,approved_by,approved_plan_hash,approved_attempt_count,approved_cost_ceiling,plan_hash
         from public.aeo_scan_batches where scan_batch_id=$1`, [f.batch.scan_batch_id])).rows[0];
    assert.equal(b.status, 'approved');
    assert.equal(b.approved_by, OWNER);
    assert.equal(b.approved_plan_hash, b.plan_hash, 'the approved hash is the materialized hash');
    assert.equal(b.approved_attempt_count, 6);

    const again = await refused(() => approve(pg, f));
    assert.equal(again.refused, true, 'a batch was approved twice');
  });

  await t.test('a non-owner and a revoked owner may not approve', async () => {
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);

    const nonOwner = await refused(() => approve(pg, f, { approver: RESOLVER }));
    assert.equal(nonOwner.refused, true);
    assert.match(nonOwner.error, /may not approve scan spend/i);

    await pg.query(`update public.staff_operators set active=false, disabled_at=now() where user_id=$1`, [OWNER]);
    const revoked = await refused(() => approve(pg, f));
    assert.equal(revoked.refused, true);
    assert.match(revoked.error, /not active/i);
    await pg.query(`update public.staff_operators set active=true, disabled_at=null where user_id=$1`, [OWNER]);
  });

  await t.test('POST-APPROVAL: attempts cannot be inserted, changed or removed', async () => {
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const [one] = await attemptsOf(pg, f.batch.scan_batch_id);

    const inserted = await refused(() => pg.query(
      `insert into public.aeo_scan_attempts
         (scan_batch_id,engine_configuration_id,panel_question_id,market_id,run_index,tier,surface_type,question_text)
       values ($1,$2,$3,$4,999,'consumer','consumer_surface','Injected question')`,
      [f.batch.scan_batch_id, one.engine_configuration_id, one.panel_question_id, one.market_id]));
    assert.equal(inserted.refused, true, 'an attempt was added after approval');
    assert.match(inserted.error, /workload is frozen/i);

    const mutated = await refused(() => pg.query(
      `update public.aeo_scan_attempts set question_text='Changed' where scan_attempt_id=$1`,
      [one.scan_attempt_id]));
    assert.equal(mutated.refused, true, 'an approved attempt was edited');

    const removed = await refused(() => pg.query(
      `delete from public.aeo_scan_attempts where scan_attempt_id=$1`, [one.scan_attempt_id]));
    assert.equal(removed.refused, true, 'an approved attempt was deleted');

    const rematerialized = await refused(() => materialize(pg, f.batch.scan_batch_id));
    assert.equal(rematerialized.refused, true, 'an approved batch was re-materialized');
  });

  await t.test('CONFIGURATION DRIFT cannot reach a materialized batch', async () => {
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const before = await attemptsOf(pg, f.batch.scan_batch_id);

    /* The configuration itself is immutable, and pinning another one
       cannot retroactively enlarge an approved workload. */
    const immutable = await refused(() => pg.query(
      `update public.aeo_engine_configurations set estimated_unit_cost_usd=99
        where engine_configuration_id=$1`, [f.consumer.engine_configuration_id]));
    assert.equal(immutable.refused, true);

    const after = await attemptsOf(pg, f.batch.scan_batch_id);
    assert.deepEqual(after.map(a => a.scan_attempt_id), before.map(a => a.scan_attempt_id));
  });

  await t.test('an observation cannot be recorded against an unapproved batch', async () => {
    const f = await seed(pg);
    await materialize(pg, f.batch.scan_batch_id);
    const [one] = await attemptsOf(pg, f.batch.scan_batch_id);
    const r = await refused(() => record(pg, one.scan_attempt_id));
    assert.equal(r.refused, true, 'evidence was recorded for a batch nobody approved');
    assert.match(r.error, /not approved/i);
  });

  /* ================= 2. PROVENANCE AND ADMISSIBILITY ================= */

  await t.test('SYNTHETIC: a fixture batch can never produce admissible evidence', async () => {
    const f = await seed(pg, { executionMode: 'fixture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);

    /* A completely successful capture — and still worth nothing. */
    await record(pg, attempts[0].scan_attempt_id, { origin: 'fixture' });

    const v = (await pg.query(
      `select observation_status, currently_admissible, counts_as_consumer
         from public.aeo_admissible_observations where scan_batch_id=$1`,
      [f.batch.scan_batch_id])).rows[0];

    assert.equal(v.observation_status, 'response_observed',
      'capture status and admissibility are separate concepts');
    assert.equal(v.currently_admissible, false, 'fixture evidence must never be admissible');
    assert.equal(v.counts_as_consumer, false, 'fixture evidence must never count as consumer reach');
  });

  await t.test('SYNTHETIC: a replay batch is equally inadmissible', async () => {
    const f = await seed(pg, { executionMode: 'replay' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    await record(pg, attempts[0].scan_attempt_id, { origin: 'replay' });

    const v = (await pg.query(
      `select currently_admissible, counts_as_consumer from public.aeo_admissible_observations
        where scan_batch_id=$1`, [f.batch.scan_batch_id])).rows[0];
    assert.equal(v.currently_admissible, false);
    assert.equal(v.counts_as_consumer, false);
  });

  await t.test('SYNTHETIC: a fixture row cannot be labelled live at insert', async () => {
    const f = await seed(pg, { executionMode: 'fixture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);

    const r = await refused(() => record(pg, attempts[0].scan_attempt_id, { origin: 'live_capture' }));
    assert.equal(r.refused, true, 'fixture evidence was recorded as a live capture');
    assert.match(r.error, /may never be recorded as a live capture/i);
  });

  await t.test('SYNTHETIC: a fixture row cannot be relabelled live afterwards', async () => {
    const f = await seed(pg, { executionMode: 'fixture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    const o = (await record(pg, attempts[0].scan_attempt_id, { origin: 'fixture' })).rows[0];
    const id = o.aeo_record_observation ?? o.observation_id;

    const relabel = await refused(() => pg.query(
      `update public.aeo_observations set evidence_origin='live_capture' where scan_batch_id=$1`,
      [f.batch.scan_batch_id]));
    assert.equal(relabel.refused, true, 'synthetic evidence was relabelled live');
    void id;
  });

  await t.test('LIVE-DECLARED, UNVERIFIED: neither surface is admissible without verification', async () => {
    /* This test previously asserted the opposite, and that was the
       defect: a clean, observed, live-DECLARED capture was admissible
       purely because the caller chose the word. Both surfaces are
       recorded honestly and neither counts, because no capture path in
       step 2 has been verified. The surface distinction still has to
       hold for when one is — proxy may never be consumer reach. */
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    const consumerAttempt = attempts.find(a => a.surface_type === 'consumer_surface');
    const proxyAttempt = attempts.find(a => a.surface_type === 'proxy');

    await record(pg, consumerAttempt.scan_attempt_id);
    await record(pg, proxyAttempt.scan_attempt_id);

    const rows = (await pg.query(
      `select surface_type, observation_status, payload_available,
              capture_verified, currently_admissible, counts_as_consumer
         from public.aeo_admissible_observations where scan_batch_id=$1 order by surface_type`,
      [f.batch.scan_batch_id])).rows;

    const consumer = rows.find(r => r.surface_type === 'consumer_surface');
    const proxy = rows.find(r => r.surface_type === 'proxy');

    /* Both were captured and stored perfectly well. */
    [consumer, proxy].forEach(r => {
      assert.equal(r.observation_status, 'response_observed');
      assert.equal(r.payload_available, true);
      assert.equal(r.capture_verified, false, 'step 2 verifies no capture path');
      assert.equal(r.currently_admissible, false,
        'declaring live_capture must not be enough to make evidence admissible');
      assert.equal(r.counts_as_consumer, false);
    });
    /* And the surface rule is independent of verification. */
    assert.equal(proxy.surface_type, 'proxy');
    assert.equal(proxy.counts_as_consumer, false, 'a proxy is never consumer reach (section 4.4)');
  });

  await t.test('LIVE-DECLARED, UNVERIFIED: a personalized capture is never admissible', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    await record(pg, attempts[0].scan_attempt_id, { personalization: 'personalized' });

    const v = (await pg.query(
      `select currently_admissible, counts_as_consumer from public.aeo_admissible_observations
        where scan_batch_id=$1`, [f.batch.scan_batch_id])).rows[0];
    assert.equal(v.currently_admissible, false);
    assert.equal(v.counts_as_consumer, false);
  });

  await t.test('admissibility is derived, never stored', async () => {
    const stored = await pg.query(
      `select column_name from information_schema.columns
        where table_name='aeo_observations'
          and column_name in ('currently_admissible','admissible','counts_as_consumer')`);
    assert.equal(stored.rows.length, 0, 'admissibility must not be a stored column');
  });

  /* ================= 3. FAILURES ARE EVIDENCE ================= */

  await t.test('failures, blocks and non-triggered surfaces are all stored', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);

    await record(pg, attempts[0].scan_attempt_id, {
      status: 'collection_failed', failureReason: 'unsupported_capture_method: vendor_scraper',
      personalization: 'unknown', receivedAt: null, rawResponse: null });
    await record(pg, attempts[1].scan_attempt_id, {
      status: 'surface_not_triggered', receivedAt: null, rawResponse: null });

    const rows = (await pg.query(
      `select observation_status, failure_reason, currently_admissible
         from public.aeo_admissible_observations where scan_batch_id=$1
        order by observation_status`, [f.batch.scan_batch_id])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].observation_status, 'collection_failed');
    assert.match(rows[0].failure_reason, /unsupported_capture_method/);
    assert.equal(rows[1].observation_status, 'surface_not_triggered');
    rows.forEach(r => assert.equal(r.currently_admissible, false));
  });

  await t.test('a claimed response with nothing behind it becomes a recorded failure', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    const o = (await record(pg, attempts[0].scan_attempt_id,
      { receivedAt: null, rawResponse: null })).rows[0];
    const row = (await pg.query(
      `select observation_status, failure_reason from public.aeo_observations where scan_batch_id=$1`,
      [f.batch.scan_batch_id])).rows[0];
    assert.equal(row.observation_status, 'collection_failed');
    assert.match(row.failure_reason, /claimed_response_observed_without_a_response/);
    void o;
  });

  await t.test('one attempt cannot be recorded twice', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    await record(pg, attempts[0].scan_attempt_id);
    const dup = await refused(() => record(pg, attempts[0].scan_attempt_id));
    assert.equal(dup.refused, true, 'a duplicate observation would inflate a denominator');
  });

  /* ================= 4. CAPTURE VERIFICATION ================= */

  await t.test('DECLARING live_capture does not make evidence admissible', async () => {
    /* The defect this section exists for. Origin classification stopped
       fixture leakage but left `live_capture` self-declared, so any
       caller could manufacture admissible evidence by choosing a word.
       Admissibility now also requires an independent verification of
       the capture PATH, and step 2 verifies nothing. */
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    const consumerAttempt = attempts.find(a => a.surface_type === 'consumer_surface');

    await record(pg, consumerAttempt.scan_attempt_id);   /* clean, observed, live-declared */

    const v = (await pg.query(
      `select evidence_origin, observation_status, personalization_state,
              capture_verified, was_verified_live_capture,
              payload_available, currently_admissible, counts_as_consumer
         from public.aeo_admissible_observations where scan_batch_id=$1`,
      [f.batch.scan_batch_id])).rows[0];

    assert.equal(v.evidence_origin, 'live_capture');
    assert.equal(v.observation_status, 'response_observed');
    assert.equal(v.payload_available, true, 'the payload is there; that is not the problem');
    assert.equal(v.capture_verified, false, 'no capture path is verified in step 2');
    assert.equal(v.was_verified_live_capture, false);
    assert.equal(v.currently_admissible, false,
      'a caller made admissible evidence by declaring live_capture');
    assert.equal(v.counts_as_consumer, false);
  });

  await t.test('step 2 verifies no capture configuration at all', async () => {
    const { rows } = await pg.query(`select count(*)::int as n from public.aeo_capture_verifications`);
    assert.equal(rows[0].n, 0,
      'a verification row exists; step 2 must not fabricate a verified collector');
  });

  await t.test('CATALOG: no application role may write a verification', async () => {
    /* This has to be a CATALOG assertion, not only a behavioural one.
       PGlite has no Supabase ALTER DEFAULT PRIVILEGES, so locally
       service_role starts with nothing on every table and a behavioural
       test would pass whether or not the migration revoked anything.
       On a hosted project service_role is granted ALL on new public
       tables by default — which is exactly how an ordinary caller could
       have inserted a verification and activated admissibility. */
    const acl = (await pg.query(
      `select coalesce(array_to_string(c.relacl, ' '), '') as acl
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname='aeo_capture_verifications'`)).rows[0].acl;

    assert.match(acl, /service_role=r\//,
      'service_role must hold SELECT so operators and tests can see the table is empty');
    assert.ok(!/service_role=[a-zA-Z]*[awd]/.test(acl),
      `service_role holds a write privilege on the verification table: ${acl}`);

    for (const role of ['anon', 'authenticated']) {
      assert.ok(!new RegExp(`${role}=`).test(acl),
        `${role} appears in the verification table ACL: ${acl}`);
    }
  });

  await t.test('BEHAVIOUR: service_role cannot insert or revoke a verification', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });

    await pg.exec('set role service_role');
    const insert = await refused(() => pg.query(
      `insert into public.aeo_capture_verifications
         (engine_configuration_id, method, evidence_ref)
       values ($1,'looks_fine','trust me') returning verification_id`,
      [f.consumer.engine_configuration_id]));
    const revoke = await refused(() => pg.query(
      `update public.aeo_capture_verifications set revoked_at=now(), revoked_reason='x'`));
    const read = await refused(() => pg.query(
      `select count(*) from public.aeo_capture_verifications`));
    await pg.exec('reset role');

    assert.equal(insert.refused, true, 'service_role inserted a verification');
    assert.equal(revoke.refused, true, 'service_role revoked a verification');
    assert.equal(read.refused, false, 'service_role must still be able to read the table');
  });

  await t.test('no RPC exposes verification or revocation', async () => {
    const { rows } = await pg.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public'
          and (p.proname ilike '%verif%' or p.proname ilike '%revoke%')
          and p.proname like 'aeo_%'`);
    /* Only the row-guard trigger function may mention verification. */
    const callable = rows.map(r => r.proname).filter(n => n !== 'aeo_verifications_guard_mutation');
    assert.deepEqual(callable, [],
      `step 2 exposes a verification RPC: ${callable.join(', ')}`);
  });

  await t.test('a verification cannot be deleted, and revocation is the only edit', async () => {
    /* Written as the table OWNER — the only role that can, and the role
       step 3's activation procedure will run as — then immediately
       revoked so the rules are proved without leaving a verified
       configuration behind. */
    const f = await seed(pg, { executionMode: 'live_capture' });
    const ver = (await pg.query(
      `insert into public.aeo_capture_verifications
         (engine_configuration_id, verified_by, method, evidence_ref)
       values ($1,$2,'manual_probe','test://evidence') returning *`,
      [f.consumer.engine_configuration_id, OWNER])).rows[0];

    const del = await refused(() => pg.query(
      `delete from public.aeo_capture_verifications where verification_id=$1`, [ver.verification_id]));
    assert.equal(del.refused, true, 'a verification was deleted');

    const edit = await refused(() => pg.query(
      `update public.aeo_capture_verifications set method='forged' where verification_id=$1`,
      [ver.verification_id]));
    assert.equal(edit.refused, true, 'a verification was edited');

    await pg.query(
      `update public.aeo_capture_verifications set revoked_at=now(), revoked_reason='test cleanup'
        where verification_id=$1`, [ver.verification_id]);

    const again = await refused(() => pg.query(
      `update public.aeo_capture_verifications set revoked_at=now(), revoked_reason='twice'
        where verification_id=$1`, [ver.verification_id]));
    assert.equal(again.refused, true, 'a verification was revoked twice');

    const left = (await pg.query(
      `select count(*)::int n from public.aeo_capture_verifications where revoked_at is null`)).rows[0];
    assert.equal(left.n, 0, 'no live verification may survive this test');
  });

  /* ================= 5. RETENTION AND DISPOSAL ================= */

  await t.test('a stored payload is hashed, sized and expires 180 days after capture', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    await record(pg, attempts[0].scan_attempt_id, { rawResponse: 'A list of salons.' });

    const o = (await pg.query(
      `select o.content_hash, o.byte_count, o.content_type, o.received_at,
              extract(day from (o.payload_expires_at - o.received_at))::int as retention_days,
              p.raw_response, p.expires_at
         from public.aeo_observations o
         left join public.aeo_observation_payloads p using (observation_id)
        where o.scan_batch_id=$1`, [f.batch.scan_batch_id])).rows[0];

    assert.match(o.content_hash, /^[0-9a-f]{64}$/, 'a SHA-256 must be stored');
    assert.equal(o.byte_count, 17);
    assert.equal(o.raw_response, 'A list of salons.');
    assert.equal(o.retention_days, 180);
    assert.equal(new Date(o.expires_at).getTime(), new Date(o.payload_expires_at ?? o.expires_at).getTime());
  });

  await t.test('OVERSIZED: metadata is preserved and the content is not stored', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    await record(pg, attempts[0].scan_attempt_id,
      { rawResponse: 'x'.repeat(262145), contentType: 'application/json' });

    const o = (await pg.query(
      `select o.observation_status, o.failure_reason, o.byte_count, o.content_hash, o.content_type,
              o.requested_at, o.evidence_origin,
              (select count(*)::int from public.aeo_observation_payloads p
                where p.observation_id = o.observation_id) as payloads
         from public.aeo_observations o where o.scan_batch_id=$1`,
      [f.batch.scan_batch_id])).rows[0];

    assert.equal(o.observation_status, 'collection_failed');
    assert.match(o.failure_reason, /^payload_too_large/);
    assert.equal(o.payloads, 0, 'the oversized content must not be stored');
    assert.equal(o.byte_count, 262145, 'the actual byte count is preserved');
    assert.match(o.content_hash, /^[0-9a-f]{64}$/, 'the content hash is preserved');
    assert.equal(o.content_type, 'application/json', 'the content type is preserved');
    assert.ok(o.requested_at, 'capture metadata is preserved');
  });

  await t.test('PARITY: the harness and the direct path record identical oversized metadata', async () => {
    /* The harness no longer drops oversized content: it passes the
       response to aeo_record_observation, which is the single canonical
       recorder. Both routes must therefore store the same thing. */
    const { executeBatch, createProviderRegistry, OBSERVATION_STATUS } =
      await import('../../server/aeo-scan-harness.mjs');

    const oversized = 'z'.repeat(262145);

    /* Route A — straight to the canonical function. */
    const a = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, a.batch.scan_batch_id);
    await approve(pg, a);
    /* BOTH routes must use the SAME configuration, or the comparison is
       between two different captures. Attempts sort by configuration
       UUID, so index 0 is whichever engine happened to sort first. */
    const aAttempts = await attemptsOf(pg, a.batch.scan_batch_id);
    const aTarget = aAttempts.find(x => x.engine_configuration_id === a.consumer.engine_configuration_id);
    await record(pg, aTarget.scan_attempt_id, { rawResponse: oversized });

    /* Route B — through the harness. */
    const b = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, b.batch.scan_batch_id);
    await approve(pg, b);
    const bAttempts = await attemptsOf(pg, b.batch.scan_batch_id);

    const configs = new Map((await pg.query(
      `select ec.* from public.aeo_panel_engine_configurations pec
         join public.aeo_engine_configurations ec using (engine_configuration_id)
        where pec.panel_version_id=$1`, [b.panel.panel_version_id])).rows
      .map(c => [c.engine_configuration_id, c]));

    const bTarget = bAttempts.find(x => x.engine_configuration_id === b.consumer.engine_configuration_id);

    await executeBatch({
      attempts: [bTarget],
      configurationsById: configs,
      registry: createProviderRegistry().register('vendor_scraper', async () => ({
        observationStatus: OBSERVATION_STATUS.RESPONSE_OBSERVED,
        personalizationState: 'clean',
        receivedAt: new Date().toISOString(),
        rawResponse: oversized
      })),
      evidenceOrigin: 'live_capture',
      recordObservation: async row => (await pg.query(
        `select * from public.aeo_record_observation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.scan_attempt_id, row.evidence_origin, row.observation_status,
         row.personalization_state, row.requested_at, row.received_at, row.raw_response,
         row.content_type, JSON.stringify(row.citations), row.failure_reason])).rows[0],
      now: () => new Date().toISOString()
    });

    const shape = async batchId => (await pg.query(
      `select o.observation_status, o.byte_count, o.content_hash, o.content_type,
              split_part(o.failure_reason, ':', 1) as failure_kind,
              (select count(*)::int from public.aeo_observation_payloads p
                where p.observation_id=o.observation_id) as payloads
         from public.aeo_observations o where o.scan_batch_id=$1`, [batchId])).rows[0];

    const direct = await shape(a.batch.scan_batch_id);
    const viaHarness = await shape(b.batch.scan_batch_id);

    assert.deepEqual(viaHarness, direct,
      'the two entrypoints stored different evidence for the same response');
    assert.equal(direct.byte_count, 262145);
    assert.match(direct.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(direct.failure_kind, 'payload_too_large');
    assert.equal(direct.payloads, 0);
  });

  await t.test('UNEXPIRED payloads are not disposable, even by a caller passing a date', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    /* Captured 10 days ago: 170 days of retention left. */
    await record(pg, attempts[0].scan_attempt_id, { agedDays: 10 });

    /* The unsafe signature must not exist at all. */
    const withCutoff = await refused(() => pg.query(
      `select public.aeo_dispose_expired_payloads($1,'forced')`, ['2099-01-01T00:00:00Z']));
    assert.equal(withCutoff.refused, true,
      'a caller-supplied cutoff still reaches disposal; retention is not enforced');

    const n = (await pg.query(`select public.aeo_dispose_expired_payloads() as n`)).rows[0].n;
    const left = (await pg.query(
      `select count(*)::int as n from public.aeo_observation_payloads p
         join public.aeo_observations o using (observation_id) where o.scan_batch_id=$1`,
      [f.batch.scan_batch_id])).rows[0].n;
    assert.equal(left, 1, `an unexpired payload was disposed (function removed ${n})`);
  });

  await t.test('EXPIRED payloads are disposed, and the evidence survives', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    /* Captured 200 days ago: 20 days past its 180-day expiry. */
    await record(pg, attempts[0].scan_attempt_id, { agedDays: 200, rawResponse: 'An old answer.' });

    const before = (await pg.query(
      `select observation_id, content_hash, byte_count, content_type, observation_status,
              evidence_origin, requested_at, received_at, payload_expires_at
         from public.aeo_observations where scan_batch_id=$1`, [f.batch.scan_batch_id])).rows[0];

    const disposed = (await pg.query(`select public.aeo_dispose_expired_payloads() as n`)).rows[0].n;
    assert.ok(disposed >= 1, 'an expired payload was not disposed');

    const after = (await pg.query(
      `select o.content_hash, o.byte_count, o.content_type, o.observation_status, o.evidence_origin,
              o.requested_at, o.received_at, o.payload_expires_at, o.payload_disposed_at,
              v.payload_available, v.currently_admissible, v.was_verified_live_capture
         from public.aeo_observations o
         join public.aeo_admissible_observations v using (observation_id)
        where o.observation_id=$1`, [before.observation_id])).rows[0];

    assert.ok(after.payload_disposed_at, 'disposal must be marked');
    assert.equal(after.payload_available, false);
    assert.equal(after.currently_admissible, false,
      'a disposed payload cannot support new normalization, findings or reporting');
    assert.equal(after.content_hash, before.content_hash, 'the hash must survive');
    assert.equal(after.byte_count, before.byte_count, 'metadata must survive');
    assert.equal(after.content_type, before.content_type);
    assert.equal(after.observation_status, before.observation_status);
    assert.equal(after.evidence_origin, before.evidence_origin);
    assert.equal(new Date(after.requested_at).getTime(), new Date(before.requested_at).getTime());

    const audit = (await pg.query(
      `select action, actor_type, reason, previous_value, new_value from public.audit_events
        where action='aeo_payload_disposed' and previous_value->>'observationId'=$1`,
      [before.observation_id])).rows[0];
    assert.ok(audit, 'disposal must be audited');
    assert.equal(audit.actor_type, 'system');
    assert.equal(audit.previous_value.contentHash, before.content_hash);
    assert.equal(audit.new_value.payloadPresent, false);
  });

  await t.test('ATOMICITY: disposal, the marker and the audit row commit or roll back together', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    await record(pg, attempts[0].scan_attempt_id, { agedDays: 400, rawResponse: 'Very old answer.' });

    const id = (await pg.query(
      `select observation_id from public.aeo_observations where scan_batch_id=$1`,
      [f.batch.scan_batch_id])).rows[0].observation_id;

    const auditCount = async () => (await pg.query(
      `select count(*)::int n from public.audit_events
        where action='aeo_payload_disposed' and previous_value->>'observationId'=$1`, [id])).rows[0].n;
    const payloadCount = async () => (await pg.query(
      `select count(*)::int n from public.aeo_observation_payloads where observation_id=$1`,
      [id])).rows[0].n;

    assert.equal(await payloadCount(), 1);
    assert.equal(await auditCount(), 0);

    await pg.exec('begin');
    await pg.query(`select public.aeo_dispose_expired_payloads()`);
    /* Inside the transaction all three effects are visible together. */
    assert.equal(await payloadCount(), 0);
    assert.equal(await auditCount(), 1);
    await pg.exec('rollback');

    /* And after a rollback, none of them are. */
    assert.equal(await payloadCount(), 1, 'the payload did not come back on rollback');
    assert.equal(await auditCount(), 0, 'an audit row survived a rolled-back disposal');
    const marked = (await pg.query(
      `select payload_disposed_at from public.aeo_observations where observation_id=$1`, [id])).rows[0];
    assert.equal(marked.payload_disposed_at, null, 'the disposal marker survived a rollback');
  });

  await t.test('a stored payload is immutable but disposable', async () => {
    const edit = await refused(() => pg.query(
      `update public.aeo_observation_payloads set raw_response='tampered'`));
    assert.equal(edit.refused, true, 'a stored payload was edited');
    assert.match(edit.error, /immutable/i);
  });

  await t.test('the payload table itself refuses an oversized row', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    await record(pg, attempts[0].scan_attempt_id, { rawResponse: 'ok' });
    const id = (await pg.query(`select observation_id from public.aeo_observations where scan_batch_id=$1`,
      [f.batch.scan_batch_id])).rows[0].observation_id;

    const r = await refused(() => pg.query(
      `insert into public.aeo_observation_payloads (observation_id,raw_response,byte_count,expires_at)
       values ($1,'y',262145,now())`, [id]));
    assert.equal(r.refused, true);
  });

  /* ================= 6. IMMUTABILITY AND ACCESS ================= */

  await t.test('evidence is append-only apart from the disposal marker', async () => {
    const f = await seed(pg, { executionMode: 'live_capture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    await record(pg, attempts[0].scan_attempt_id);

    for (const [what, sql] of [
      ['status', `update public.aeo_observations set observation_status='response_observed' where scan_batch_id=$1`],
      ['hash', `update public.aeo_observations set content_hash=repeat('a',64) where scan_batch_id=$1`],
      ['origin', `update public.aeo_observations set evidence_origin='live_capture' where scan_batch_id=$1`],
      ['delete', `delete from public.aeo_observations where scan_batch_id=$1`]
    ]) {
      const r = await refused(() => pg.query(sql, [f.batch.scan_batch_id]));
      assert.equal(r.refused, true, `an observation's ${what} was mutable`);
    }
  });

  await t.test('no browser role can reach the evidence store or its functions', async () => {
    const tables = ['aeo_markets', 'aeo_panel_versions', 'aeo_panel_questions', 'aeo_engines',
      'aeo_engine_configurations', 'aeo_panel_engine_configurations', 'aeo_scan_batches',
      'aeo_scan_attempts', 'aeo_observations', 'aeo_observation_payloads'];

    for (const role of ['anon', 'authenticated']) {
      for (const table of tables) {
        await pg.exec(`set role ${role}`);
        const r = await refused(() => pg.query(`select * from public.${table} limit 1`));
        await pg.exec('reset role');
        assert.equal(r.refused, true, `${role} could read ${table}`);
        assert.match(r.error, /permission denied/i);
      }
      for (const call of [
        `select public.aeo_materialize_scan_batch('11111111-1111-4111-8111-111111111111')`,
        `select public.aeo_approve_scan_batch('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','h',1,1.0)`,
        `select public.aeo_dispose_expired_payloads(now())`
      ]) {
        await pg.exec(`set role ${role}`);
        const r = await refused(() => pg.query(call));
        await pg.exec('reset role');
        assert.equal(r.refused, true, `${role} could execute ${call.slice(0, 45)}`);
      }
    }
  });

  await t.test('the evidence store references no business record', async () => {
    /* Observations are market-scoped. A foreign key to business_records
       would mean something had decided which salon an unparsed market
       answer belongs to — the fabrication step 2 must not make. */
    const { rows } = await pg.query(
      `select c.conname from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_class r on r.oid = c.confrelid
        where c.contype='f' and t.relname like 'aeo_%' and r.relname='business_records'`);
    assert.equal(rows.length, 0, 'mentions is step 3 work');
  });

  /* ================= 7. BOTH DENOMINATORS ================= */

  await t.test('the summary separates scheduled, recorded and admissible', async () => {
    const f = await seed(pg, { executionMode: 'fixture' });
    await materialize(pg, f.batch.scan_batch_id);
    await approve(pg, f);
    const attempts = await attemptsOf(pg, f.batch.scan_batch_id);
    await record(pg, attempts[0].scan_attempt_id, { origin: 'fixture' });

    const rows = (await pg.query(`select * from public.aeo_scan_batch_summary($1)`,
      [f.batch.scan_batch_id])).rows;

    const consumer = rows.find(r => r.tier === 'consumer');
    assert.equal(Number(consumer.scheduled_attempts), 4);
    assert.ok(Number(consumer.recorded_attempts) < Number(consumer.scheduled_attempts),
      'both denominators must stay visible');
    assert.equal(Number(consumer.currently_admissible), 0, 'a fixture batch admits nothing');
    assert.equal(Number(consumer.counts_as_consumer), 0);
    assert.equal(Number(consumer.capture_verified), 0, 'no capture path is verified in step 2');
    assert.equal(consumer.evidence_origin, 'fixture');

    const diagnostic = rows.find(r => r.tier === 'diagnostic');
    assert.equal(diagnostic.surface_type, 'proxy', 'tiers are reported separately, never blended');
  });
});
