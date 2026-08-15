/* ============================================================
   The BI → Sales schema, in a real PostgreSQL
   ------------------------------------------------------------
   Migrations 0009, 0010 and 0011 in the full chain.

   WHAT THIS FILE IS FOR. 0009 and 0010 were applied to the hosted
   development project BEFORE they existed as repository files
   (CLAUDE.md §14). Their SQL was reconciled out of
   `schema_migrations.statements` and verified by hash, so what is
   committed is provably what ran — but "what ran" and "what it
   does" are different claims, and only the second one protects
   anything. Nothing had ever exercised these constraints.

   Everything below is asserted BEHAVIOURALLY: a write that must
   be refused is attempted and its refusal observed. A catalog
   read would only prove a constraint exists, not that it fires.

   Run with: npm run test:migration
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startLocalPg, disposableDataDir } from '../helpers/local-pg.mjs';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const OPERATOR_TWO = '11111111-1111-4111-8111-111111111112';
const LOCATION = 'qy50mN2frSwxhSAEcqxF';

/* Refusals are identified by the error TEXT rather than only by SQLSTATE,
   because several distinct rules here share 23514. */
const refuses = async (pg, sql, fragment) => {
  await assert.rejects(
    () => pg.query(sql),
    error => {
      const message = String(error?.message || '');
      assert.ok(message.toLowerCase().includes(fragment.toLowerCase()),
        `expected a refusal mentioning "${fragment}", got: ${message}`);
      return true;
    },
    `the database must refuse: ${fragment}`);
};

const setup = async pg => {
  /* `auth.users` is absent from PGlite, so 0007's foreign key and the
     bootstrap's confirmed-email check are SKIPPED here rather than passed —
     CLAUDE.md §12 says so and this file does not pretend otherwise. The
     operator rows are inserted directly, which is exactly what makes the
     handoff foreign keys testable at all. */
  await pg.exec(`
    insert into public.staff_operators (user_id, role, active)
    values ('${OPERATOR}', 'owner', true), ('${OPERATOR_TWO}', 'identity_resolver', true);

    insert into public.business_records (business_id, display_name, vertical_id)
    values ('22222222-2222-4222-8222-222222222222', 'Test Salon One', 'nails'),
           ('33333333-3333-4333-8333-333333333333', 'Test Salon Two', 'nails');
  `);
};

const BUSINESS_A = '22222222-2222-4222-8222-222222222222';
const BUSINESS_B = '33333333-3333-4333-8333-333333333333';

const insertHandoff = (overrides = {}) => {
  const o = {
    handoffId: '44444444-4444-4444-8444-444444444444',
    businessId: BUSINESS_A,
    needKey: 'missed_calls',
    needSummary: 'Missed calls are going unanswered.',
    offerKey: 'voice_ai',
    status: 'qualified',
    evidence: `'["bir:1"]'::jsonb`,
    confidence: '0.80',
    reason: 'Research shows repeated unanswered inbound calls.',
    qualifiedBy: OPERATOR,
    disqualification: 'null',
    pursuitBy: 'null',
    pursuitAt: 'null',
    ...overrides
  };
  return `
    insert into public.sales_handoffs (
      handoff_id, business_id, need_key, need_summary, offer_key,
      qualification_status, evidence_references, confidence, decision_reason,
      qualified_by, qualified_at, disqualification_reason,
      pursuit_approved_by, pursuit_approved_at
    ) values (
      '${o.handoffId}', '${o.businessId}', '${o.needKey}',
      '${o.needSummary}', ${o.offerKey === null ? 'null' : `'${o.offerKey}'`},
      '${o.status}', ${o.evidence}, ${o.confidence}, '${o.reason}',
      '${o.qualifiedBy}', now(), ${o.disqualification},
      ${o.pursuitBy}, ${o.pursuitAt}
    );`;
};

/* ============================================================
   Lifecycle semantics
   ============================================================ */

test('the Business Record lifecycle', async t => {
  const env = await startLocalPg({ dataDir: disposableDataDir('0009-lifecycle') });
  t.after(async () => { await env.close(); });
  const pg = env.pg;

  await t.test('a new Business Record defaults to business_record', async () => {
    await pg.exec(`insert into public.business_records (business_id, display_name, vertical_id)
                   values ('55555555-5555-4555-8555-555555555555', 'Defaulted', 'nails')`);
    const { rows } = await pg.query(
      `select lifecycle_state from public.business_records where business_id = '55555555-5555-4555-8555-555555555555'`);
    assert.equal(rows[0].lifecycle_state, 'business_record',
      'the default is the BI/entity term, not the sales-like one');
  });

  await t.test('lead_assessed cannot be assigned to a NEW Business Record', async () => {
    await refuses(pg,
      `insert into public.business_records (business_id, display_name, vertical_id, lifecycle_state)
       values ('66666666-6666-4666-8666-666666666666', 'Legacy attempt', 'nails', 'lead_assessed')`,
      'legacy ambiguous value');
  });

  await t.test('lead_assessed cannot be assigned by UPDATE either', async () => {
    await refuses(pg,
      `update public.business_records set lifecycle_state = 'lead_assessed'
        where business_id = '55555555-5555-4555-8555-555555555555'`,
      'legacy ambiguous value');
  });

  await t.test('an EXISTING lead_assessed row stays valid and stays put', async () => {
    /* The check constraint still ADMITS the value — that is what keeps the 14
       legacy rows on the hosted project legal. Only the trigger blocks new
       assignment, and only when the value actually changes. Proven by writing
       the row the way history did, with the trigger disabled, and then
       showing an unrelated update to it still succeeds. */
    /* `session_replication_role = replica` suppresses user triggers for this
       session. Preferred over `alter table … disable trigger`, which cannot
       run in the same batch as the insert — PostgreSQL refuses to ALTER a
       table with pending trigger events, which is exactly the state an insert
       in the same statement group leaves behind. */
    await pg.exec(`set session_replication_role = replica`);
    await pg.exec(`insert into public.business_records
                     (business_id, display_name, vertical_id, lifecycle_state)
                   values ('77777777-7777-4777-8777-777777777777', 'Legacy row', 'nails', 'lead_assessed')`);
    await pg.exec(`set session_replication_role = origin`);

    await pg.exec(`update public.business_records set display_name = 'Legacy row renamed'
                    where business_id = '77777777-7777-4777-8777-777777777777'`);

    const { rows } = await pg.query(
      `select lifecycle_state, display_name from public.business_records
        where business_id = '77777777-7777-4777-8777-777777777777'`);
    assert.equal(rows[0].lifecycle_state, 'lead_assessed', 'the legacy value survives');
    assert.equal(rows[0].display_name, 'Legacy row renamed',
      'an update that does not touch the lifecycle is not blocked by the trigger');
  });

  await t.test('a legacy row may be moved FORWARD to a new value', async () => {
    /* Nothing mass-converts these; a human reviews each one. But when that
       review happens the schema must permit the outcome. */
    await pg.exec(`update public.business_records set lifecycle_state = 'researched'
                    where business_id = '77777777-7777-4777-8777-777777777777'`);
    const { rows } = await pg.query(
      `select lifecycle_state from public.business_records
        where business_id = '77777777-7777-4777-8777-777777777777'`);
    assert.equal(rows[0].lifecycle_state, 'researched');
  });

  await t.test('the ingester now assigns researched, not lead_assessed', async () => {
    const { rows } = await pg.query(
      `select pg_get_functiondef(p.oid) as def from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'ingest_review' and p.prokind = 'f'`);
    const def = rows[0].def;
    assert.ok(def.includes(`'researched'`), 'ingest_review assigns the BI term');
    assert.ok(!def.includes(`'lead_assessed'`),
      'no lead_assessed literal survives in the ingester');
  });
});

/* ============================================================
   Handoff rules
   ============================================================ */

test('the sales handoff', async t => {
  const env = await startLocalPg({ dataDir: disposableDataDir('0009-handoff') });
  t.after(async () => { await env.close(); });
  const pg = env.pg;
  await setup(pg);

  await t.test('one handoff per business + need + offer', async () => {
    await pg.exec(insertHandoff());
    await refuses(pg,
      insertHandoff({ handoffId: '44444444-4444-4444-8444-444444444445' }),
      'sales_handoffs_business_need_offer_uidx');
  });

  await t.test('a null offer_key is one slot, not many', async () => {
    /* The index keys on coalesce(offer_key, ''), so two null-offer handoffs
       for the same need collide. Without the coalesce they would not, because
       nulls are distinct in a unique index — which would let the same need be
       handed off repeatedly. */
    await pg.exec(insertHandoff({
      handoffId: '44444444-4444-4444-8444-444444444446', offerKey: null
    }));
    await refuses(pg,
      insertHandoff({ handoffId: '44444444-4444-4444-8444-444444444447', offerKey: null }),
      'sales_handoffs_business_need_offer_uidx');
  });

  await t.test('a qualified handoff REQUIRES evidence', async () => {
    await refuses(pg,
      insertHandoff({
        handoffId: '44444444-4444-4444-8444-444444444448',
        needKey: 'no_evidence', evidence: `'[]'::jsonb`
      }),
      'sales_handoffs_qualified_evidence');
  });

  await t.test('an unqualified handoff may carry no evidence', async () => {
    await pg.exec(insertHandoff({
      handoffId: '44444444-4444-4444-8444-444444444449',
      needKey: 'deferred_need', status: 'deferred', evidence: `'[]'::jsonb`
    }));
  });

  await t.test('not_qualified requires a disqualification reason', async () => {
    await refuses(pg,
      insertHandoff({
        handoffId: '4444444a-4444-4444-8444-444444444444',
        needKey: 'rejected_need', status: 'not_qualified', evidence: `'[]'::jsonb`
      }),
      'sales_handoffs_disqualification_reason');
  });

  await t.test('pursuit approval cannot precede qualification', async () => {
    await refuses(pg,
      insertHandoff({
        handoffId: '4444444b-4444-4444-8444-444444444444',
        needKey: 'premature', status: 'deferred', evidence: `'[]'::jsonb`,
        pursuitBy: `'${OPERATOR}'`, pursuitAt: 'now()'
      }),
      'sales_handoffs_pursuit_requires_qualified');
  });

  await t.test('pursuit approver and timestamp move together', async () => {
    await refuses(pg,
      insertHandoff({
        handoffId: '4444444c-4444-4444-8444-444444444444',
        needKey: 'half_approved', pursuitBy: `'${OPERATOR}'`
      }),
      'sales_handoffs_pursuit_approval_pair');
  });

  await t.test('business, need and offer are immutable once decided', async () => {
    await refuses(pg,
      `update public.sales_handoffs set need_key = 'something_else'
        where handoff_id = '44444444-4444-4444-8444-444444444444'`,
      'immutable');
    await refuses(pg,
      `update public.sales_handoffs set business_id = '${BUSINESS_B}'
        where handoff_id = '44444444-4444-4444-8444-444444444444'`,
      'immutable');
  });

  await t.test('a handoff cannot be deleted', async () => {
    await refuses(pg,
      `delete from public.sales_handoffs where handoff_id = '44444444-4444-4444-8444-444444444444'`,
      'append-only');
  });

  await t.test('qualified_by must be a real operator', async () => {
    await refuses(pg,
      insertHandoff({
        handoffId: '4444444d-4444-4444-8444-444444444444',
        needKey: 'ghost_operator',
        qualifiedBy: '99999999-9999-4999-8999-999999999999'
      }),
      'foreign key');
  });
});

/* ============================================================
   Cross-system links
   ============================================================ */

test('external record links', async t => {
  const env = await startLocalPg({ dataDir: disposableDataDir('0009-links') });
  t.after(async () => { await env.close(); });
  const pg = env.pg;
  await setup(pg);

  /* One qualified-and-approved handoff, and one qualified-only. */
  await pg.exec(insertHandoff({
    pursuitBy: `'${OPERATOR}'`, pursuitAt: 'now()'
  }));
  await pg.exec(insertHandoff({
    handoffId: '55555555-5555-4555-8555-555555555551',
    needKey: 'no_pursuit_yet'
  }));

  const contactLink = (id, business, recordId) => `
    insert into public.external_record_links
      (link_id, business_id, external_system, external_account_key, record_type, external_record_id)
    values ('${id}', '${business}', 'ghl', '${LOCATION}', 'contact', '${recordId}');`;

  await t.test('one ACTIVE contact link per business and location', async () => {
    await pg.exec(contactLink('66666666-6666-4666-8666-666666666661', BUSINESS_A, 'contact_one'));
    await refuses(pg,
      contactLink('66666666-6666-4666-8666-666666666662', BUSINESS_A, 'contact_two'),
      'external_record_links_active_contact_uidx');
  });

  await t.test('deactivating the first frees the slot, and history survives', async () => {
    await pg.exec(`update public.external_record_links
                      set is_active = false, deactivated_at = now()
                    where link_id = '66666666-6666-4666-8666-666666666661'`);
    await pg.exec(contactLink('66666666-6666-4666-8666-666666666663', BUSINESS_A, 'contact_three'));

    const { rows } = await pg.query(
      `select count(*)::int as n from public.external_record_links
        where business_id = '${BUSINESS_A}' and record_type = 'contact'`);
    assert.equal(rows[0].n, 2, 'the deactivated link is still there — it is history');
  });

  await t.test('is_active and deactivated_at must agree', async () => {
    await refuses(pg,
      `update public.external_record_links set is_active = false
        where link_id = '66666666-6666-4666-8666-666666666663'`,
      'external_record_links_deactivation');
  });

  await t.test('an opportunity link REQUIRES a handoff', async () => {
    await refuses(pg,
      `insert into public.external_record_links
         (business_id, external_system, external_account_key, record_type, external_record_id)
       values ('${BUSINESS_A}', 'ghl', '${LOCATION}', 'opportunity', 'opp_no_handoff')`,
      'external_record_links_opportunity_handoff');
  });

  await t.test('an opportunity requires qualification AND separate pursuit approval', async () => {
    await refuses(pg,
      `insert into public.external_record_links
         (business_id, external_system, external_account_key, record_type, external_record_id, handoff_id)
       values ('${BUSINESS_A}', 'ghl', '${LOCATION}', 'opportunity', 'opp_unapproved',
               '55555555-5555-4555-8555-555555555551')`,
      'pursuit approval');
  });

  await t.test('an approved handoff may carry exactly one open opportunity', async () => {
    await pg.exec(`
      insert into public.external_record_links
        (business_id, external_system, external_account_key, record_type, external_record_id, handoff_id)
      values ('${BUSINESS_A}', 'ghl', '${LOCATION}', 'opportunity', 'opp_one',
              '44444444-4444-4444-8444-444444444444')`);

    await refuses(pg,
      `insert into public.external_record_links
         (business_id, external_system, external_account_key, record_type, external_record_id, handoff_id)
       values ('${BUSINESS_A}', 'ghl', '${LOCATION}', 'opportunity', 'opp_two',
               '44444444-4444-4444-8444-444444444444')`,
      'external_record_links_active_opportunity_uidx');
  });

  await t.test('a link whose business disagrees with its handoff is refused', async () => {
    await refuses(pg,
      `insert into public.external_record_links
         (business_id, external_system, external_account_key, record_type, external_record_id, handoff_id)
       values ('${BUSINESS_B}', 'ghl', '${LOCATION}', 'opportunity', 'opp_mismatch',
               '44444444-4444-4444-8444-444444444444')`,
      'does not match its sales handoff');
  });

  await t.test('a link cannot be deleted', async () => {
    await refuses(pg,
      `delete from public.external_record_links where external_record_id = 'opp_one'`,
      'append-only');
  });
});

/* ============================================================
   Promotion serialization (0011)
   ============================================================ */

test('promotion request serialization', async t => {
  const env = await startLocalPg({ dataDir: disposableDataDir('0011-serialization') });
  t.after(async () => { await env.close(); });
  const pg = env.pg;
  await setup(pg);

  /* TWO handoffs for the SAME business — the exact shape that produced the
     duplicate-contact race the per-handoff index could not see. */
  await pg.exec(insertHandoff());
  await pg.exec(insertHandoff({
    handoffId: '88888888-8888-4888-8888-888888888881',
    needKey: 'second_need'
  }));

  const claim = (key, handoff, business = BUSINESS_A) => `
    insert into public.sales_promotion_requests
      (idempotency_key, handoff_id, business_id, request_hash, status)
    values ('${key}', '${handoff}', '${business}',
            '${'a'.repeat(64)}', 'processing');`;

  await t.test('two handoffs of ONE business cannot be in flight together', async () => {
    await pg.exec(claim('key-one', '44444444-4444-4444-8444-444444444444'));
    await refuses(pg,
      claim('key-two', '88888888-8888-4888-8888-888888888881'),
      'sales_promotion_requests_one_business_processing_uidx');
  });

  await t.test('completing the first releases the business', async () => {
    /* Serialized, NOT excluded. The second handoff is promotable the moment
       the first stops being in flight — which is the whole distinction
       between this and simply forbidding concurrent handoffs. */
    await pg.exec(`update public.sales_promotion_requests
                      set status = 'completed', completed_at = now()
                    where idempotency_key = 'key-one'`);
    await pg.exec(claim('key-two', '88888888-8888-4888-8888-888888888881'));
  });

  await t.test('a FAILED promotion also releases the business', async () => {
    /* Otherwise a partial failure wedges every later promotion for that
       business behind a row nothing will ever complete. */
    await pg.exec(`update public.sales_promotion_requests
                      set status = 'failed', error_code = 'crm_unreachable', completed_at = now()
                    where idempotency_key = 'key-two'`);
    await pg.exec(claim('key-three', '88888888-8888-4888-8888-888888888881'));
  });

  await t.test('an idempotency key cannot be reused', async () => {
    await refuses(pg,
      claim('key-three', '44444444-4444-4444-8444-444444444444'),
      'sales_promotion_requests_idempotency_uidx');
  });

  await t.test('the denormalised business must match the handoff', async () => {
    await refuses(pg,
      claim('key-four', '44444444-4444-4444-8444-444444444444', BUSINESS_B),
      'does not match its sales handoff');
  });

  await t.test('a promotion request cannot be deleted', async () => {
    await refuses(pg,
      `delete from public.sales_promotion_requests where idempotency_key = 'key-three'`,
      'append-only');
  });
});

/* ============================================================
   Webhook receipts and timeline idempotency
   ============================================================ */

test('webhook receipts and timeline appends', async t => {
  const env = await startLocalPg({ dataDir: disposableDataDir('0009-receipts') });
  t.after(async () => { await env.close(); });
  const pg = env.pg;
  await setup(pg);

  const HASH = 'b'.repeat(64);

  await t.test('a delivery key is unique per external system', async () => {
    await pg.exec(`
      insert into public.crm_webhook_receipts
        (external_system, delivery_key, payload_hash, event_type, event_occurred_at)
      values ('ghl', 'delivery-1', '${HASH}', 'OpportunityStatusUpdate', now())`);

    await refuses(pg, `
      insert into public.crm_webhook_receipts
        (external_system, delivery_key, payload_hash, event_type, event_occurred_at)
      values ('ghl', 'delivery-1', '${HASH}', 'OpportunityStatusUpdate', now())`,
      'crm_webhook_receipts_delivery_uidx');
  });

  await t.test('a payload hash must actually be a sha256', async () => {
    await refuses(pg, `
      insert into public.crm_webhook_receipts
        (external_system, delivery_key, payload_hash, event_type, event_occurred_at)
      values ('ghl', 'delivery-2', 'not-a-hash', 'ContactUpdate', now())`,
      'crm_webhook_receipts_payload_hash');
  });

  await t.test('a settled receipt must carry when it was settled', async () => {
    await refuses(pg,
      `update public.crm_webhook_receipts set processing_status = 'processed'
        where delivery_key = 'delivery-1'`,
      'crm_webhook_receipts_processing');
  });

  await t.test('a rejection must say why', async () => {
    await refuses(pg,
      `update public.crm_webhook_receipts
          set processing_status = 'rejected', processed_at = now()
        where delivery_key = 'delivery-1'`,
      'crm_webhook_receipts_rejection');
  });

  await t.test('a timeline event is idempotent on (event_name, idempotency_key)', async () => {
    const append = () => pg.query(`
      insert into public.timeline_events
        (business_id, event_name, event_version, occurred_at, recorded_at,
         producer, source_system, idempotency_key, summary, payload)
      values ('${BUSINESS_A}', 'crm.contact_linked', 1, now(), now(),
              'test', 'ced', 'contact:${BUSINESS_A}:contact_one',
              'CRM contact linked.', '{"externalRecordId":"contact_one"}'::jsonb)
      on conflict (event_name, idempotency_key) do nothing`);

    await append();
    await append();

    const { rows } = await pg.query(
      `select count(*)::int as n from public.timeline_events
        where event_name = 'crm.contact_linked'
          and idempotency_key = 'contact:${BUSINESS_A}:contact_one'`);
    assert.equal(rows[0].n, 1, 'a repeated append produces one row, not two');
  });

  await t.test('the same key under a DIFFERENT event name is a different event', async () => {
    await pg.exec(`
      insert into public.timeline_events
        (business_id, event_name, event_version, occurred_at, recorded_at,
         producer, source_system, idempotency_key, summary, payload)
      values ('${BUSINESS_A}', 'sales.won', 1, now(), now(),
              'test', 'ghl', 'contact:${BUSINESS_A}:contact_one',
              'Won.', '{}'::jsonb)`);
  });

  await t.test('timeline events cannot be updated or deleted', async () => {
    await refuses(pg,
      `update public.timeline_events set summary = 'rewritten'
        where event_name = 'sales.won'`,
      'append-only');
    await refuses(pg,
      `delete from public.timeline_events where event_name = 'sales.won'`,
      'append-only');
  });
});
