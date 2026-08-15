/* ============================================================
   The GHL → Supabase milestone receiver
   ------------------------------------------------------------
   The signature is the ONLY credential this endpoint has, so the
   tests that matter most are the ones that prove it is actually
   checked — against the raw bytes, before anything is spent, with
   no way to turn it off.

   Deliveries are signed here with a REAL Ed25519 keypair
   generated per run, and the receiver is pointed at its public
   half through GHL_WEBHOOK_PUBLIC_KEY. Nothing about verification
   is stubbed: a test that forged a "valid" signature by mocking
   the verifier would prove only that the mock works.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';

import { handleRequest } from '../server/crm-webhook.mjs';
import { verifyGhlSignature } from '../server/ghl-client.mjs';
import { createFakeSalesDb } from './helpers/fake-sales-db.mjs';

const BUSINESS = '22222222-2222-4222-8222-222222222222';
const HANDOFF = '44444444-4444-4444-8444-444444444444';
const LOCATION = 'qy50mN2frSwxhSAEcqxF';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  GHL_LOCATION_ID: LOCATION,
  GHL_FIELD_CED_BUSINESS_ID: 'field-business-id',
  GHL_WEBHOOK_PUBLIC_KEY: PUBLIC_PEM,
  CED_LOG_LEVEL: 'error'
};

const signBody = raw => cryptoSign(null, Buffer.from(raw, 'utf8'), privateKey).toString('base64');

const deliver = async ({
  db, payload, signature = null, omitSignature = false, env = ENV, headers = {}
} = {}) => {
  const raw = JSON.stringify(payload);
  const built = {
    'Content-Type': 'application/json',
    'x-forwarded-proto': 'https',
    'x-vercel-forwarded-for': '203.0.113.20',
    ...headers
  };
  /* Omission has to be explicit. Setting the header to `undefined` gives it
     the literal string "undefined", which is a DIFFERENT test — a malformed
     signature rather than an absent one. */
  if (!omitSignature) built['X-GHL-Signature'] = signature === null ? signBody(raw) : signature;

  const request = new Request('https://api.example.com/api/webhooks/ghl', {
    method: 'POST',
    headers: built,
    body: raw
  });
  const response = await handleRequest(request, { env, db, correlationId: 'test-correlation' });
  return { response, json: await response.json() };
};

const opportunityPayload = (overrides = {}) => ({
  type: 'OpportunityStatusUpdate',
  webhookId: 'delivery-1',
  timestamp: '2026-08-14T12:00:00.000Z',
  data: {
    id: 'opp_linked',
    locationId: LOCATION,
    status: 'won',
    ...overrides.data
  },
  ...overrides.top
});

const seedDb = (overrides = {}) => createFakeSalesDb({
  business_records: [{ business_id: BUSINESS, display_name: 'Test Salon' }],
  sales_handoffs: [{ handoff_id: HANDOFF, business_id: BUSINESS }],
  external_record_links: overrides.links === undefined ? [{
    link_id: 'link-opp',
    business_id: BUSINESS,
    external_system: 'ghl',
    external_account_key: LOCATION,
    record_type: 'opportunity',
    external_record_id: 'opp_linked',
    handoff_id: HANDOFF,
    is_active: true
  }] : overrides.links,
  crm_webhook_receipts: overrides.receipts || [],
  timeline_events: []
});

/* ============================================================
   The signature
   ============================================================ */

test('signature verification', async t => {
  await t.test('a correct signature over the raw body verifies', () => {
    const raw = '{"a":1}';
    assert.equal(verifyGhlSignature(Buffer.from(raw), signBody(raw), PUBLIC_PEM), true);
  });

  await t.test('a signature over DIFFERENT bytes does not', () => {
    /* This is why the receiver must never re-serialise. The same object with
       different key order is different bytes and a different signature. */
    const signed = signBody('{"a":1,"b":2}');
    assert.equal(verifyGhlSignature(Buffer.from('{"b":2,"a":1}'), signed, PUBLIC_PEM), false);
  });

  await t.test('garbage is refused rather than thrown at', () => {
    for (const bad of ['', '   ', 'not-base64!!', 'AAAA', 'x'.repeat(600)]) {
      assert.equal(verifyGhlSignature(Buffer.from('{}'), bad, PUBLIC_PEM), false, `refused: ${bad}`);
    }
    assert.equal(verifyGhlSignature(Buffer.alloc(0), signBody(''), PUBLIC_PEM), false,
      'an empty body cannot be verified');
  });

  await t.test('a delivery with NO signature is refused', async () => {
    const db = seedDb();
    const { response, json } = await deliver({
      db, payload: opportunityPayload(), omitSignature: true
    });
    assert.equal(response.status, 401);
    assert.equal(json.code, 'signature_missing');
    assert.equal(db.tables.crm_webhook_receipts.length, 0,
      'nothing was recorded, so nothing was spent');
  });

  await t.test('a MALFORMED signature is refused too, as invalid rather than missing', async () => {
    const db = seedDb();
    const { response, json } = await deliver({
      db, payload: opportunityPayload(), signature: 'not-base64!!'
    });
    assert.equal(response.status, 401);
    assert.equal(json.code, 'signature_invalid');
  });

  await t.test('an INVALID signature is refused and writes nothing', async () => {
    const db = seedDb();
    const other = generateKeyPairSync('ed25519');
    const forged = cryptoSign(null, Buffer.from(JSON.stringify(opportunityPayload())),
      other.privateKey).toString('base64');

    const { response, json } = await deliver({ db, payload: opportunityPayload(), signature: forged });
    assert.equal(response.status, 401);
    assert.equal(json.code, 'signature_invalid');
    assert.equal(db.tables.crm_webhook_receipts.length, 0);
    assert.equal(db.tables.timeline_events.length, 0);
  });

  await t.test('the deprecated RSA header is not an alternative', async () => {
    const db = seedDb();
    const { response, json } = await deliver({
      db, payload: opportunityPayload(), omitSignature: true,
      headers: { 'X-WH-Signature': 'whatever-the-legacy-scheme-would-send' }
    });
    assert.equal(response.status, 401,
      'accepting both would let the sender choose the weaker scheme');
    assert.equal(json.code, 'signature_missing',
      'the legacy header is not even looked at');
  });
});

/* ============================================================
   Delivery handling
   ============================================================ */

test('delivery handling', async t => {
  await t.test('a Won event deactivates the link and appends sales.won', async () => {
    const db = seedDb();
    const { response, json } = await deliver({ db, payload: opportunityPayload() });

    assert.equal(response.status, 200);
    assert.equal(json.status, 'processed');
    assert.equal(json.milestone, 'sales.won');

    const link = db.tables.external_record_links[0];
    assert.equal(link.is_active, false, 'a won opportunity is no longer open');
    assert.ok(link.deactivated_at, 'is_active and deactivated_at move together');

    const events = db.tables.timeline_events;
    assert.equal(events.length, 1);
    assert.equal(events[0].event_name, 'sales.won');
    assert.equal(events[0].business_id, BUSINESS);
  });

  await t.test('a Lost event does the same, with sales.lost', async () => {
    const db = seedDb();
    const { json } = await deliver({
      db, payload: opportunityPayload({ data: { status: 'lost' } })
    });
    assert.equal(json.milestone, 'sales.lost');
    assert.equal(db.tables.external_record_links[0].is_active, false);
  });

  await t.test('an Abandoned event deactivates but invents no milestone', async () => {
    /* No approved timeline name describes abandonment. `sales.lost` would
       assert a loss that did not happen. */
    const db = seedDb();
    const { json } = await deliver({
      db, payload: opportunityPayload({ data: { status: 'abandoned' } })
    });
    assert.equal(json.status, 'processed');
    assert.equal(json.milestone, null);
    assert.equal(json.deactivated, true);
    assert.equal(db.tables.timeline_events.length, 0);
  });

  await t.test('an open status changes nothing', async () => {
    const db = seedDb();
    const { json } = await deliver({
      db, payload: opportunityPayload({ data: { status: 'open' } })
    });
    assert.equal(db.tables.external_record_links[0].is_active, true,
      'Supabase is not authoritative for the live stage and does not mirror it');
    assert.equal(json.milestone, null);
  });

  await t.test('DUPLICATE DELIVERY is acknowledged, not reprocessed', async () => {
    const db = seedDb();
    const first = await deliver({ db, payload: opportunityPayload() });
    assert.equal(first.json.status, 'processed');

    const second = await deliver({ db, payload: opportunityPayload() });
    assert.equal(second.response.status, 200,
      '200 because HighLevel retries a non-2xx — a 409 would retry forever');
    assert.equal(second.json.status, 'duplicate');
    assert.equal(db.tables.timeline_events.length, 1, 'one milestone, not two');
  });

  await t.test('UNKNOWN RECORD is acknowledged and acted on by nothing', async () => {
    /* The ordinary case for every inbound opportunity CED did not create. */
    const db = seedDb({ links: [] });
    const { response, json } = await deliver({ db, payload: opportunityPayload() });

    assert.equal(response.status, 200);
    assert.equal(json.status, 'ignored');
    assert.equal(json.reason, 'unknown_record');
    assert.equal(db.tables.timeline_events.length, 0);
  });

  await t.test('a MISMATCHED location is rejected', async () => {
    const db = seedDb();
    const { response, json } = await deliver({
      db, payload: opportunityPayload({ data: { locationId: 'someone-elses-location' } })
    });
    assert.equal(response.status, 422);
    assert.equal(json.reason, 'location_mismatch');
    assert.equal(db.tables.timeline_events.length, 0);
  });

  await t.test('a MISMATCHED Business ID is rejected', async () => {
    const db = seedDb();
    const { response, json } = await deliver({
      db,
      payload: opportunityPayload({
        data: { customFields: { 'field-business-id': '33333333-3333-4333-8333-333333333333' } }
      })
    });
    assert.equal(response.status, 422);
    assert.equal(json.reason, 'business_id_mismatch');
    assert.equal(db.tables.timeline_events.length, 0,
      'when the payload and the link disagree, neither may write history');
  });

  await t.test('an unhandled event type is recorded as ignored, not silently 200-ed', async () => {
    const db = seedDb();
    const { json } = await deliver({
      db, payload: opportunityPayload({ top: { type: 'NoteCreate' } })
    });
    assert.equal(json.status, 'ignored');
    assert.equal(json.reason, 'unhandled_event_type');
    assert.equal(db.tables.crm_webhook_receipts.length, 1,
      'a receipt exists, so a missed integration is distinguishable from a working one');
  });

  await t.test('a delivery with no webhookId is refused', async () => {
    const db = seedDb();
    const { response, json } = await deliver({
      db, payload: { type: 'OpportunityStatusUpdate', timestamp: '2026-08-14T12:00:00.000Z', data: {} }
    });
    assert.equal(response.status, 400);
    assert.equal(json.code, 'delivery_key_missing');
  });
});

/* ============================================================
   Ordering
   ============================================================ */

test('stale events', async t => {
  await t.test('a LATE-arriving earlier event does not undo a later one', async () => {
    const db = seedDb();

    /* Won at 12:00 arrives and is processed. */
    await deliver({ db, payload: opportunityPayload() });
    assert.equal(db.tables.external_record_links[0].is_active, false);

    /* An `open` from 11:00 arrives afterwards — the reordering a retry
       produces. It must not reopen the link. */
    const late = await deliver({
      db,
      payload: opportunityPayload({
        top: { webhookId: 'delivery-earlier', timestamp: '2026-08-14T11:00:00.000Z' },
        data: { status: 'open' }
      })
    });

    assert.equal(late.json.status, 'ignored');
    assert.equal(late.json.reason, 'stale_event');
    assert.equal(db.tables.external_record_links[0].is_active, false,
      'the later milestone stands');
    assert.equal(db.tables.timeline_events.length, 1);
  });

  await t.test('staleness is judged by the EXTERNAL clock, not arrival order', async () => {
    const db = seedDb();
    /* A newer event arriving first, then an older one. Arrival order says the
       second is newest; the external timestamps say otherwise, and they win. */
    await deliver({
      db,
      payload: opportunityPayload({ top: { webhookId: 'd-late', timestamp: '2026-08-14T15:00:00.000Z' } })
    });
    const older = await deliver({
      db,
      payload: opportunityPayload({
        top: { webhookId: 'd-early', timestamp: '2026-08-14T09:00:00.000Z' },
        data: { status: 'lost' }
      })
    });
    assert.equal(older.json.reason, 'stale_event');
    assert.equal(db.tables.timeline_events.filter(e => e.event_name === 'sales.lost').length, 0);
  });

  await t.test('a genuinely newer event is processed', async () => {
    const db = seedDb();
    await deliver({
      db,
      payload: opportunityPayload({
        top: { webhookId: 'd-1', timestamp: '2026-08-14T09:00:00.000Z' },
        data: { status: 'open' }
      })
    });
    const newer = await deliver({
      db,
      payload: opportunityPayload({ top: { webhookId: 'd-2', timestamp: '2026-08-14T15:00:00.000Z' } })
    });
    assert.equal(newer.json.status, 'processed');
    assert.equal(newer.json.milestone, 'sales.won');
  });
});

/* ============================================================
   Retention
   ============================================================ */

test('what is retained', async t => {
  await t.test('the raw payload is not stored — only a hash of it', async () => {
    const db = seedDb();
    const payload = opportunityPayload({
      data: { email: 'owner@example.com', phone: '+18645551234', name: 'A Person' }
    });
    await deliver({ db, payload });

    const receipt = db.tables.crm_webhook_receipts[0];
    const serialized = JSON.stringify(receipt);
    assert.ok(!serialized.includes('owner@example.com'), 'no email retained');
    assert.ok(!serialized.includes('18645551234'), 'no phone retained');
    assert.ok(!serialized.includes('A Person'), 'no name retained');

    assert.equal(receipt.payload_hash,
      createHash('sha256').update(Buffer.from(JSON.stringify(payload), 'utf8')).digest('hex'),
      'the hash is over the exact bytes received');

    const timeline = JSON.stringify(db.tables.timeline_events);
    assert.ok(!/@/.test(timeline), 'and none of it reached the append-only timeline');
  });
});
