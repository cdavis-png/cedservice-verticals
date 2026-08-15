/* ============================================================
   The Promote to Sales boundary
   ------------------------------------------------------------
   The route's job is to be BORING under repetition: the same
   request twice must produce one contact, one opportunity and one
   of each timeline event, whatever the network did in between.

   Every test here drives the real `handleRequest` against a fake
   database that enforces the real unique indexes and a fake CRM
   that records what it was asked to do. Nothing is stubbed at the
   level of the decision being tested.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRequest } from '../server/sales-promotion.mjs';
import { createFakeSalesDb } from './helpers/fake-sales-db.mjs';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const BUSINESS = '22222222-2222-4222-8222-222222222222';
const HANDOFF = '44444444-4444-4444-8444-444444444444';
const LOCATION = 'qy50mN2frSwxhSAEcqxF';
const ORIGIN = 'https://staff.example.com';

/* SYNTHETIC IDS ON PURPOSE. The route addresses every CRM object by an id it
   reads from configuration, so a suite pinned to the live location's real ids
   would prove nothing extra and would break the day one of them changed. The
   real ids live in docs/BI_TO_SALES_OPERATIONS.md §2 and in the deployment
   environment, which is the only place they belong. `Lead Focus` is the one
   real value below, kept because it predates this work and reads as an anchor
   for anyone comparing the two. */
const ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  CED_RATE_LIMIT_SECRET: 'x'.repeat(64),
  CED_STAFF_ALLOWED_ORIGINS: ORIGIN,
  CED_ALLOWED_ORIGINS: ORIGIN,
  GHL_API_TOKEN: 'test-token',
  GHL_LOCATION_ID: LOCATION,
  GHL_PIPELINE_ID: 'CJsWJoJy9PmiEe5BJYfy',
  GHL_STAGE_QUALIFIED_NOT_CONTACTED: 'stage-qualified-not-contacted',
  GHL_FIELD_CED_BUSINESS_ID: 'field-business-id',
  GHL_FIELD_LEAD_FOCUS: 'imH7mOH9zhfrnz56gNsC',
  CED_LOG_LEVEL: 'error'
};

const handoffRow = (overrides = {}) => ({
  handoff_id: HANDOFF,
  business_id: BUSINESS,
  need_key: 'missed_calls',
  need_summary: 'Missed calls',
  offer_key: 'voice_ai',
  qualification_status: 'qualified',
  pursuit_approved_at: null,
  ...overrides
});

const businessRow = () => ({
  business_id: BUSINESS,
  display_name: 'Test Salon',
  lifecycle_state: 'researched'
});

/* A CRM that records every call and can be told to fail at a chosen point,
   which is how the partial-failure recovery tests create a half-done world. */
const createFakeGhl = (options = {}) => {
  const calls = [];
  const contacts = options.contacts || [];
  const opportunities = options.opportunities || [];
  let created = 0;
  return {
    calls,
    async findContactByBusinessId(businessId) {
      calls.push({ op: 'findContact', businessId });
      return contacts.find(c => c.businessId === businessId) || null;
    },
    async createContact(fields) {
      calls.push({ op: 'createContact', fields });
      if (options.failCreateContact) throw options.failCreateContact;
      created += 1;
      return { id: `contact_new_${created}` };
    },
    async updateContact(contactId, fields) {
      calls.push({ op: 'updateContact', contactId, fields });
      return { id: contactId };
    },
    async findOpportunitiesByContact(contactId) {
      calls.push({ op: 'findOpportunities', contactId });
      return opportunities;
    },
    async createOpportunity(spec) {
      calls.push({ op: 'createOpportunity', spec });
      if (options.failCreateOpportunity) throw options.failCreateOpportunity;
      return { id: 'opp_new_1' };
    }
  };
};

const promote = async ({
  db, ghl, body = {}, idempotencyKey = 'key-1', env = ENV,
  verify = async () => ({ userId: OPERATOR, aal: 'aal2', emailConfirmed: true })
} = {}) => {
  const request = new Request('https://staff.example.com/api/sales/promote', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Authorization: 'Bearer test-access-token',
      'Idempotency-Key': idempotencyKey,
      'x-forwarded-proto': 'https',
      'x-vercel-forwarded-for': '203.0.113.10'
    },
    body: JSON.stringify({ handoffId: HANDOFF, ...body })
  });
  const response = await handleRequest(request, {
    env, db, ghl, verifyAccessToken: verify, correlationId: 'test-correlation'
  });
  return { response, json: await response.json() };
};

const seedDb = (overrides = {}) => createFakeSalesDb({
  business_records: [businessRow()],
  sales_handoffs: [handoffRow(overrides.handoff)],
  external_record_links: overrides.links || [],
  sales_promotion_requests: overrides.requests || [],
  timeline_events: overrides.events || []
});

/* ============================================================
   Authorization and validation
   ============================================================ */

test('the promotion boundary refuses before it spends anything', async t => {
  await t.test('a missing Origin is refused', async () => {
    const request = new Request('https://staff.example.com/api/sales/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-proto': 'https' },
      body: '{}'
    });
    const response = await handleRequest(request, { env: ENV, db: seedDb() });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'origin_required');
  });

  await t.test('a caller who is not an active operator is refused', async () => {
    const db = seedDb();
    db.rpc = async name => (name === 'staff_operator_guard'
      ? { data: null, error: { code: '42501', message: 'staff_not_an_operator' } }
      : { data: [{ allowed: true }], error: null });

    const { response, json } = await promote({ db, ghl: createFakeGhl() });
    assert.equal(response.status, 403);
    assert.equal(json.code, 'not_an_operator');
  });

  await t.test('a request with no Idempotency-Key is refused', async () => {
    const { response, json } = await promote({
      db: seedDb(), ghl: createFakeGhl(), idempotencyKey: ''
    });
    assert.equal(response.status, 400);
    assert.equal(json.code, 'idempotency_key_required');
  });

  await t.test('an unqualified handoff cannot be promoted at all', async () => {
    const db = seedDb({ handoff: { qualification_status: 'deferred' } });
    const ghl = createFakeGhl();
    const { response, json } = await promote({ db, ghl });
    assert.equal(response.status, 422);
    assert.equal(json.code, 'handoff_not_qualified');
    assert.equal(ghl.calls.length, 0, 'the CRM was never contacted');
  });
});

/* ============================================================
   Contact resolution
   ============================================================ */

test('contact resolution', async t => {
  await t.test('a first promotion creates exactly one contact and links it', async () => {
    const db = seedDb();
    const ghl = createFakeGhl();
    const { response, json } = await promote({ db, ghl });

    assert.equal(response.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.contact.created, true);
    assert.equal(db.tables.external_record_links.length, 1);

    const created = ghl.calls.filter(c => c.op === 'createContact');
    assert.equal(created.length, 1, 'one contact, not two');

    /* The three things every BI-sourced contact must carry. */
    const fields = created[0].fields;
    const ids = fields.customFields.map(f => f.id);
    assert.ok(ids.includes('field-business-id'), 'CED Business ID is populated');
    assert.ok(ids.includes('imH7mOH9zhfrnz56gNsC'), 'Lead Focus is populated');
    assert.deepEqual(fields.tags.sort(), ['ced_lead', 'ced_source_bi_research']);

    const businessIdField = fields.customFields.find(f => f.id === 'field-business-id');
    assert.equal(businessIdField.value, BUSINESS, 'the canonical Supabase UUID');
  });

  await t.test('no name, email or phone is invented', async () => {
    const ghl = createFakeGhl();
    await promote({ db: seedDb(), ghl });
    const fields = ghl.calls.find(c => c.op === 'createContact').fields;
    assert.equal(fields.email, undefined, 'no fabricated email');
    assert.equal(fields.phone, undefined, 'no fabricated phone');
    assert.equal(fields.name, 'Test Salon', 'the Business Record display name, nothing else');
  });

  await t.test('an existing LINK is used and the CRM is not searched', async () => {
    const db = seedDb({
      links: [{
        link_id: 'link-1', business_id: BUSINESS, external_system: 'ghl',
        external_account_key: LOCATION, record_type: 'contact',
        external_record_id: 'contact_existing', is_active: true
      }]
    });
    const ghl = createFakeGhl();
    const { json } = await promote({ db, ghl });

    assert.equal(json.contact.externalRecordId, 'contact_existing');
    assert.equal(json.contact.created, false);
    assert.equal(ghl.calls.filter(c => c.op === 'findContact').length, 0,
      'a known link makes a CRM search unnecessary');
    assert.equal(db.tables.external_record_links.length, 1, 'no second link');
  });

  await t.test('EXISTING-CONTACT RECOVERY: a lost link is recovered by search, not duplicated', async () => {
    /* The partial-failure world: the CRM holds a contact carrying this
       Business ID, and Supabase holds no link — the exact state a crash
       between the two writes leaves behind. */
    const db = seedDb();
    const ghl = createFakeGhl({ contacts: [{ id: 'contact_orphan', businessId: BUSINESS }] });
    const { json } = await promote({ db, ghl });

    assert.equal(json.contact.externalRecordId, 'contact_orphan');
    assert.equal(json.contact.adopted, true);
    assert.equal(json.contact.created, false);
    assert.equal(ghl.calls.filter(c => c.op === 'createContact').length, 0,
      'search before create is what prevents the duplicate');
    assert.equal(db.tables.external_record_links.length, 1, 'the orphan is adopted and linked');
  });

  await t.test('a CRM failure marks the claim failed so the business is released', async () => {
    const db = seedDb();
    const ghl = createFakeGhl({
      failCreateContact: Object.assign(new Error('CRM down'), { name: 'GhlApiError', status: 502, code: 'crm_unreachable' })
    });
    const { response } = await promote({ db, ghl });

    assert.ok(response.status >= 500, 'the caller is told it failed');
    const claim = db.tables.sales_promotion_requests[0];
    assert.equal(claim.status, 'failed',
      'a claim left processing would wedge every later promotion for this business');
    assert.ok(claim.completed_at, 'a settled claim carries when it settled');
  });
});

/* ============================================================
   Idempotency
   ============================================================ */

test('idempotency', async t => {
  await t.test('REPLAY: the same key and the same request returns the first outcome', async () => {
    const db = seedDb();
    const ghl = createFakeGhl();

    const first = await promote({ db, ghl, idempotencyKey: 'replay-key' });
    assert.equal(first.json.replayed, false);

    const second = await promote({ db, ghl, idempotencyKey: 'replay-key' });
    assert.equal(second.response.status, 200);
    assert.equal(second.json.replayed, true, 'the second call is marked a replay');
    assert.equal(second.json.contact.externalRecordId, first.json.contact.externalRecordId);

    assert.equal(ghl.calls.filter(c => c.op === 'createContact').length, 1,
      'a replay creates nothing in the CRM');
    assert.equal(db.tables.external_record_links.length, 1, 'and links nothing new');
  });

  await t.test('CONFLICTING HASH: the same key with a different request is refused', async () => {
    const db = seedDb({ handoff: { pursuit_approved_at: '2026-08-14T00:00:00.000Z' } });
    const ghl = createFakeGhl();

    await promote({ db, ghl, idempotencyKey: 'shared-key', body: { createOpportunity: false } });
    const second = await promote({
      db, ghl, idempotencyKey: 'shared-key', body: { createOpportunity: true }
    });

    assert.equal(second.response.status, 409);
    assert.equal(second.json.code, 'idempotency_conflict',
      'never answered with the first call\'s outcome');
    assert.equal(ghl.calls.filter(c => c.op === 'createOpportunity').length, 0,
      'and nothing was created for the second request');
  });

  await t.test('a different operator reusing a key is a different request', async () => {
    const db = seedDb();
    const ghl = createFakeGhl();
    await promote({ db, ghl, idempotencyKey: 'operator-key' });

    const second = await promote({
      db, ghl, idempotencyKey: 'operator-key',
      verify: async () => ({ userId: '11111111-1111-4111-8111-111111111199', aal: 'aal2' })
    });
    assert.equal(second.json.code, 'idempotency_conflict',
      'a promotion is attributed to a person; a second operator is not handed the first one\'s outcome');
  });

  await t.test('CONCURRENCY: a second in-flight promotion for one business is refused, retryably', async () => {
    /* Two DIFFERENT handoffs, one business — the shape 0011 exists for. */
    const db = createFakeSalesDb({
      business_records: [businessRow()],
      sales_handoffs: [
        handoffRow(),
        handoffRow({ handoff_id: '44444444-4444-4444-8444-444444444445', need_key: 'second_need' })
      ],
      sales_promotion_requests: [{
        promotion_request_id: 'in-flight',
        idempotency_key: 'other-key',
        handoff_id: '44444444-4444-4444-8444-444444444445',
        business_id: BUSINESS,
        request_hash: 'a'.repeat(64),
        status: 'processing'
      }]
    });
    const ghl = createFakeGhl();
    const { response, json } = await promote({ db, ghl, idempotencyKey: 'racing-key' });

    assert.equal(response.status, 409);
    assert.equal(json.code, 'promotion_in_progress');
    assert.ok(response.headers.get('Retry-After'),
      'retryable: by the time the caller retries, the contact link will exist');
    assert.equal(ghl.calls.length, 0, 'the CRM was never reached, so no duplicate contact');
  });
});

/* ============================================================
   The opportunity gate
   ============================================================ */

test('the opportunity requires BOTH decisions', async t => {
  await t.test('qualification alone does not create an opportunity', async () => {
    const db = seedDb({ handoff: { pursuit_approved_at: null } });
    const ghl = createFakeGhl();
    const { json } = await promote({ db, ghl, body: { createOpportunity: true } });

    assert.equal(json.ok, true, 'the contact still links');
    assert.equal(json.opportunity, null);
    assert.equal(json.opportunitySkippedReason, 'pursuit_not_approved');
    assert.equal(ghl.calls.filter(c => c.op === 'createOpportunity').length, 0,
      'no CRM opportunity is created that the database would then refuse to link');
  });

  await t.test('an approved handoff creates one, in Qualified — Not Contacted', async () => {
    const db = seedDb({ handoff: { pursuit_approved_at: '2026-08-14T00:00:00.000Z' } });
    const ghl = createFakeGhl();
    const { json } = await promote({ db, ghl, body: { createOpportunity: true } });

    assert.equal(json.opportunity.created, true);
    const spec = ghl.calls.find(c => c.op === 'createOpportunity').spec;
    assert.equal(spec.stageId, 'stage-qualified-not-contacted',
      'researched outbound never enters New Inquiry, which is reserved for inbound');
    assert.equal(spec.name, 'Test Salon — Missed calls',
      '[Business Name] — [Need/Offer]');
  });

  await t.test('an opportunity is never created without being asked for', async () => {
    const db = seedDb({ handoff: { pursuit_approved_at: '2026-08-14T00:00:00.000Z' } });
    const ghl = createFakeGhl();
    const { json } = await promote({ db, ghl });
    assert.equal(json.opportunitySkippedReason, 'not_requested');
    assert.equal(ghl.calls.filter(c => c.op === 'createOpportunity').length, 0);
  });

  await t.test('EXISTING-OPPORTUNITY RECOVERY: an open match is adopted, not duplicated', async () => {
    const db = seedDb({
      handoff: { pursuit_approved_at: '2026-08-14T00:00:00.000Z' },
      links: [{
        link_id: 'link-1', business_id: BUSINESS, external_system: 'ghl',
        external_account_key: LOCATION, record_type: 'contact',
        external_record_id: 'contact_existing', is_active: true
      }]
    });
    const ghl = createFakeGhl({
      opportunities: [{ id: 'opp_existing', name: 'Test Salon — Missed calls', status: 'open' }]
    });
    const { json } = await promote({ db, ghl, body: { createOpportunity: true } });

    assert.equal(json.opportunity.externalRecordId, 'opp_existing');
    assert.equal(json.opportunity.created, false);
    assert.equal(ghl.calls.filter(c => c.op === 'createOpportunity').length, 0,
      'no additional open opportunity for the same business + need + offer');
  });

  await t.test('a CLOSED opportunity of the same name does not block a new one', async () => {
    /* The rule is one OPEN opportunity. A won or lost one is history and must
       not stop the business being pursued again. */
    const db = seedDb({ handoff: { pursuit_approved_at: '2026-08-14T00:00:00.000Z' } });
    const ghl = createFakeGhl({
      opportunities: [{ id: 'opp_old', name: 'Test Salon — Missed calls', status: 'lost' }]
    });
    const { json } = await promote({ db, ghl, body: { createOpportunity: true } });
    assert.equal(json.opportunity.created, true);
  });
});

/* ============================================================
   Timeline
   ============================================================ */

test('timeline milestones', async t => {
  await t.test('both milestones are appended, and carry no contact data', async () => {
    const db = seedDb({ handoff: { pursuit_approved_at: '2026-08-14T00:00:00.000Z' } });
    await promote({ db, ghl: createFakeGhl(), body: { createOpportunity: true } });

    const names = db.tables.timeline_events.map(e => e.event_name).sort();
    assert.deepEqual(names, ['crm.contact_linked', 'sales.opportunity_created']);

    /* §9: a timeline payload may never carry contact data, because the table
       refuses UPDATE and nothing personal that reaches it can be redacted. */
    const serialized = JSON.stringify(db.tables.timeline_events);
    assert.ok(!/@/.test(serialized), 'no email address reached the timeline');
    assert.ok(!/"phone"/.test(serialized), 'no phone number reached the timeline');
  });

  await t.test('a replayed promotion appends no second milestone', async () => {
    const db = seedDb();
    const ghl = createFakeGhl();
    await promote({ db, ghl, idempotencyKey: 'tl-key' });
    await promote({ db, ghl, idempotencyKey: 'tl-key' });

    const contactEvents = db.tables.timeline_events
      .filter(e => e.event_name === 'crm.contact_linked');
    assert.equal(contactEvents.length, 1);
  });

  await t.test('a second promotion under a NEW key still appends only one milestone', async () => {
    /* The idempotency key changes, so the ledger does not absorb it — the
       timeline's own (event_name, idempotency_key) index does. */
    const db = seedDb();
    const ghl = createFakeGhl();
    await promote({ db, ghl, idempotencyKey: 'first-key' });
    await promote({ db, ghl, idempotencyKey: 'second-key' });

    const contactEvents = db.tables.timeline_events
      .filter(e => e.event_name === 'crm.contact_linked');
    assert.equal(contactEvents.length, 1,
      'keyed on the business and contact, so the same fact appends once');
  });
});
