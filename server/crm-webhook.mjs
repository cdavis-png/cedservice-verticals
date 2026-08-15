/* ============================================================
   CED Intelligence Platform — GHL → Supabase milestone receiver
   ------------------------------------------------------------
   POST /api/webhooks/ghl

   THE ONLY INBOUND SURFACE FROM THE CRM, and the one place the
   authority boundary is most likely to erode. So, stated first:

   SUPABASE IS NOT AUTHORITATIVE FOR THE LIVE PIPELINE STAGE.
   This receiver writes HISTORY — a milestone happened, at a time,
   for a linked record. It does not maintain a mirror of the
   current opportunity state, it stores no `current_stage` column,
   and nothing downstream may read Supabase to find out where an
   opportunity is now. Ask GHL. A second copy of live state is a
   second source of truth, and the two will disagree the first
   time a delivery is dropped.

   ------------------------------------------------------------
   A DIFFERENT TRUST MODEL FROM EVERY OTHER ROUTE HERE.

   The staff console and the promotion boundary prove provenance
   with an Origin header and an operator session. HighLevel is not
   a browser and holds no session, so neither applies:

     · There is NO origin check. Requiring one would refuse every
       real delivery, and an allowlist of CRM egress addresses is
       not something this project controls.
     · The Ed25519 SIGNATURE IS THE AUTHENTICATION. It is verified
       before the body is parsed, before the database is touched,
       and before anything is spent. An unsigned or wrongly signed
       delivery is refused having cost one signature check.

   Because the signature is the only credential, the rules around
   it are absolute: verification is over the UNMODIFIED RAW BYTES,
   the legacy RSA header is not accepted, and there is no
   configuration flag that turns verification off. A "skip in
   development" switch is exactly the switch that reaches
   production.
   ============================================================ */

import { randomUUID, createHash, createHmac } from 'node:crypto';
import rateLimit from '../shared/security/rate-limit.js';
import {
  getServiceClient, jsonResponse, makeLogger, classifySalesDbError, OperatorError, operatorFail,
  insecureAllowed
} from './operator-session.mjs';
import { verifyGhlSignature, GHL_ED25519_PUBLIC_KEY_PEM } from './ghl-client.mjs';

const { buildRateLimitKeys, staffRateLimitPolicy, NAMESPACES, readAddress, isUsableAddress } = rateLimit;

const hmac = (secret, input) => createHmac('sha256', secret).update(input).digest('hex');
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

/* A webhook body is small. A cap that is generous for real deliveries and
   still refuses an attempt to make this endpoint read megabytes before it
   can check a signature. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

/* ------------------------------------------------------------
   Event mapping
   ------------------------------------------------------------
   Only events that correspond to an APPROVED timeline event name are
   given one. The names are a shared contract pinned by the comment on
   `timeline_events`; inventing a new one here would orphan history
   rather than extend it.

   `abandoned` deliberately maps to NO timeline event. It deactivates the
   link — the opportunity is no longer open, which is what the link
   tracks — but no approved name describes abandonment. `sales.lost`
   would assert a loss that did not happen, and `sales.disqualified`
   asserts a judgement CED never made. Recording the receipt and
   deactivating the link keeps the fact without fabricating a milestone. */
const OPPORTUNITY_STATUS_EVENTS = Object.freeze({
  won: { event: 'sales.won', deactivate: true, summary: 'The CRM reported this opportunity Won.' },
  lost: { event: 'sales.lost', deactivate: true, summary: 'The CRM reported this opportunity Lost.' },
  abandoned: { event: null, deactivate: true, summary: null },
  open: { event: null, deactivate: false, summary: null }
});

/* The event types this receiver acts on. Anything else is recorded as
   `ignored` — acknowledged so HighLevel stops retrying, acted on by
   nothing. Silently 200-ing an unknown type without a receipt would make
   a missed integration indistinguishable from a working one. */
const HANDLED_TYPES = new Set([
  'OpportunityStatusUpdate', 'OpportunityUpdate', 'OpportunityDelete',
  'ContactDelete'
]);

const parseTimestamp = value => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms) : null;
};

/* ============================================================
   The handler
   ============================================================ */
export async function handleRequest(request, deps = {}) {
  const env = deps.env || process.env;
  const correlationId = deps.correlationId || (deps.randomUUID || randomUUID)();
  const log = makeLogger(env, correlationId);

  try {
    const url = new URL(request.url);

    const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
    if (proto !== 'https' && !insecureAllowed(env, url, 'CED_ALLOW_INSECURE_SALES')) {
      operatorFail(403, 'https_required', 'This endpoint requires HTTPS.');
    }

    if (String(request.method || '').toUpperCase() !== 'POST') {
      return jsonResponse(405, { ok: false, code: 'method_not_allowed', message: 'This endpoint accepts POST.' },
        correlationId, { Allow: 'POST' });
    }

    /* ---------- 1. the raw body, read ONCE ----------
       Kept as a Buffer and never re-serialised. The signature is over
       these exact bytes; parsing to JSON and stringifying again changes
       key order, whitespace and number formatting, so a re-serialised
       body would fail verification for a genuine delivery — and could
       verify a body that is not the one that was signed. The same Buffer
       feeds both the signature check and the payload hash. */
    const rawBody = Buffer.from(await request.arrayBuffer());
    if (rawBody.length === 0) {
      operatorFail(400, 'empty_body', 'The request body is empty.');
    }
    if (rawBody.length > MAX_WEBHOOK_BYTES) {
      operatorFail(413, 'body_too_large', 'The request body is too large.');
    }

    /* ---------- 2. the signature, before anything else ---------- */
    const signature = request.headers.get('x-ghl-signature');
    if (!signature) {
      /* A delivery carrying only the deprecated RSA header lands here, and
         that is intended. `X-WH-Signature` is deprecated as of 2026-09-01
         and is not accepted: honouring both would let whoever chooses the
         header choose the weaker scheme. */
      log('warn', 'webhook_signature_missing', {});
      operatorFail(401, 'signature_missing', 'A webhook signature is required.');
    }
    const publicKey = env.GHL_WEBHOOK_PUBLIC_KEY?.trim() || GHL_ED25519_PUBLIC_KEY_PEM;
    if (!verifyGhlSignature(rawBody, signature, publicKey)) {
      log('warn', 'webhook_signature_invalid', {});
      operatorFail(401, 'signature_invalid', 'The webhook signature is not valid.');
    }

    /* ---------- 3. parse, now that the bytes are trusted ---------- */
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      operatorFail(400, 'invalid_json', 'The request body is not valid JSON.');
    }
    if (!payload || typeof payload !== 'object') {
      operatorFail(400, 'invalid_json', 'The request body must be a JSON object.');
    }

    const deliveryKey = String(payload.webhookId ?? '').trim();
    if (!deliveryKey || deliveryKey.length > 200) {
      operatorFail(400, 'delivery_key_missing', 'The delivery carries no usable webhookId.');
    }
    const eventType = String(payload.type ?? '').trim();
    if (!eventType || eventType.length > 160) {
      operatorFail(400, 'event_type_missing', 'The delivery carries no usable type.');
    }

    const occurredAt = parseTimestamp(payload.timestamp);
    if (!occurredAt) {
      operatorFail(400, 'timestamp_missing', 'The delivery carries no usable timestamp.');
    }

    const data = (payload.data && typeof payload.data === 'object') ? payload.data : payload;
    const externalRecordId = String(data.id ?? payload.id ?? '').trim() || null;
    const payloadLocationId = String(data.locationId ?? payload.locationId ?? '').trim();

    /* ---------- 4. rate limit, after the signature ----------
       Deliberately AFTER verification: a forged delivery must not be able
       to consume the budget that real deliveries depend on. A verified
       delivery is from HighLevel, so the bucket meters a partner rather
       than an attacker, and it exists to bound a retry storm. */
    const db = deps.db || await getServiceClient(env);

    const secret = env.CED_RATE_LIMIT_SECRET || '';
    const address = readAddress(request.headers);
    if (secret.trim() && isUsableAddress(address)) {
      const keys = buildRateLimitKeys({
        headers: request.headers, env, hmacFn: hmac,
        namespace: NAMESPACES.crmWebhook, includeSession: false
      });
      const policy = staffRateLimitPolicy(env);
      for (const { scope, key } of keys) {
        const { data: limitData, error } = await db.rpc('check_rate_limit', {
          p_scope: scope, p_key: key,
          p_window_seconds: policy.window, p_max_requests: policy.max
        });
        const row = Array.isArray(limitData) ? limitData[0] : limitData;
        if (!error && row && row.allowed === false) {
          log('warn', 'webhook_rate_limited', { scope });
          return jsonResponse(429, { ok: false, code: 'rate_limited', message: 'Too many requests.' },
            correlationId, { 'Retry-After': String(row.retry_after_seconds || 60) });
        }
      }
    }

    /* ---------- 5. claim the delivery ----------
       The unique index on (external_system, delivery_key) is what makes a
       replay safe. A duplicate is ACKNOWLEDGED with 200: HighLevel retries
       on a non-2xx, so answering 409 to a delivery already processed would
       produce an endless retry of something that already succeeded. */
    const payloadHash = sha256(rawBody);

    const { data: receipt, error: receiptError } = await db
      .from('crm_webhook_receipts')
      .insert({
        external_system: 'ghl',
        delivery_key: deliveryKey,
        payload_hash: payloadHash,
        event_type: eventType,
        external_record_id: externalRecordId,
        event_occurred_at: occurredAt.toISOString(),
        processing_status: 'received'
      })
      .select('receipt_id')
      .maybeSingle();

    if (receiptError) {
      if (String(receiptError.code) === '23505') {
        log('info', 'webhook_duplicate_delivery', { deliveryKey, eventType });
        return jsonResponse(200, { ok: true, status: 'duplicate', deliveryKey }, correlationId);
      }
      const [status, code, message] = classifySalesDbError(receiptError);
      return jsonResponse(status, { ok: false, code, message }, correlationId);
    }

    const receiptId = receipt?.receipt_id || null;

    /* Every path from here marks the receipt exactly once. */
    const settle = async (status, reason, extra = {}) => {
      const update = { processing_status: status, processed_at: new Date().toISOString() };
      if (status === 'rejected') update.rejection_reason = String(reason).slice(0, 300);
      await db.from('crm_webhook_receipts').update(update).eq('receipt_id', receiptId);
      const httpStatus = status === 'rejected' ? 422 : 200;
      /* A rejection is reported honestly but is NOT retryable — the
         delivery will never become valid, and 4xx stops HighLevel retrying
         a body that cannot be accepted. */
      return jsonResponse(httpStatus, {
        ok: status !== 'rejected', status, reason: reason || null, deliveryKey, ...extra
      }, correlationId);
    };

    /* ---------- 6. validate the location ---------- */
    const expectedLocation = String(env.GHL_LOCATION_ID ?? '').trim();
    if (!expectedLocation) {
      log('error', 'webhook_location_unconfigured', {});
      return await settle('rejected', 'location_unconfigured');
    }
    if (payloadLocationId && payloadLocationId !== expectedLocation) {
      log('warn', 'webhook_location_mismatch', { eventType });
      return await settle('rejected', 'location_mismatch');
    }

    /* ---------- 7. only act on what is understood ---------- */
    if (!HANDLED_TYPES.has(eventType)) {
      return await settle('ignored', 'unhandled_event_type');
    }
    if (!externalRecordId) {
      return await settle('rejected', 'external_record_id_missing');
    }

    /* ---------- 8. resolve the link BEFORE writing a milestone ----------
       An event about a record this platform never linked is not history it
       may write. Resolving first is what stops a forged-but-signed or
       misrouted delivery attaching a milestone to an unrelated business. */
    const recordType = eventType.startsWith('Contact') ? 'contact' : 'opportunity';
    const { data: link, error: linkError } = await db
      .from('external_record_links')
      .select('link_id, business_id, handoff_id, record_type, is_active')
      .eq('external_system', 'ghl')
      .eq('external_account_key', expectedLocation)
      .eq('record_type', recordType)
      .eq('external_record_id', externalRecordId)
      .maybeSingle();

    if (linkError) {
      const [, code] = classifySalesDbError(linkError);
      return await settle('rejected', `link_lookup_failed:${code}`);
    }
    if (!link) {
      /* Unknown record. Acknowledged so HighLevel stops retrying, acted on
         by nothing. This is the ordinary case for every opportunity in the
         pipeline that CED did not create — the inbound ones. */
      return await settle('ignored', 'unknown_record');
    }

    /* A Business ID carried in the payload must AGREE with the link. If it
       does not, one of the two is wrong and neither may be trusted to write
       history. */
    const claimedBusinessId = String(
      data.customFields?.[env.GHL_FIELD_CED_BUSINESS_ID] ??
      data.cedBusinessId ?? ''
    ).trim();
    if (claimedBusinessId && claimedBusinessId !== link.business_id) {
      log('warn', 'webhook_business_mismatch', { eventType });
      return await settle('rejected', 'business_id_mismatch');
    }

    /* ---------- 9. staleness, by the EXTERNAL clock ----------
       Deliveries arrive out of order. A `won` followed by a late-delivered
       earlier `open` must not reopen the link, and a stale milestone must
       not overwrite a later one.

       Compared against the newest delivery ALREADY PROCESSED for this same
       external record — the external timestamp throughout, never local
       arrival time, because arrival order is precisely what is unreliable. */
    const { data: newer } = await db
      .from('crm_webhook_receipts')
      .select('event_occurred_at')
      .eq('external_system', 'ghl')
      .eq('external_record_id', externalRecordId)
      .eq('processing_status', 'processed')
      .gte('event_occurred_at', occurredAt.toISOString())
      .limit(1)
      .maybeSingle();

    if (newer) {
      log('info', 'webhook_stale_event', { eventType, externalRecordId });
      return await settle('ignored', 'stale_event');
    }

    /* ---------- 10. apply ---------- */
    let milestone = null;
    let deactivate = false;

    if (eventType === 'OpportunityDelete' || eventType === 'ContactDelete') {
      /* A deleted CRM record cannot be the active link any more. The link
         row itself is never deleted — `external_record_links` refuses it —
         so the history of having been linked survives the deletion. */
      deactivate = true;
    } else {
      const status = String(data.status ?? '').trim().toLowerCase();
      const mapped = OPPORTUNITY_STATUS_EVENTS[status];
      if (!mapped) {
        return await settle('ignored', status ? `unhandled_status:${status}` : 'no_status');
      }
      milestone = mapped.event ? { event: mapped.event, summary: mapped.summary } : null;
      deactivate = mapped.deactivate;
    }

    if (milestone) {
      /* Append-only, and idempotent through the (event_name,
         idempotency_key) unique index. Keyed on the DELIVERY, so a
         redelivery of the same event cannot produce a second milestone.

         The payload carries identifiers only — §9 forbids contact data in
         a timeline payload, and this one is built from a CRM body that is
         full of it. Nothing is copied across except ids and keys. */
      const { error: eventError } = await db
        .from('timeline_events')
        .upsert({
          business_id: link.business_id,
          event_name: milestone.event,
          event_version: 1,
          occurred_at: occurredAt.toISOString(),
          recorded_at: new Date(Math.max(Date.now(), occurredAt.getTime())).toISOString(),
          producer: 'crm-webhook',
          source_system: 'ghl',
          source_record_id: externalRecordId,
          correlation_id: correlationId,
          idempotency_key: `ghl:${deliveryKey}`,
          summary: milestone.summary,
          payload: {
            externalSystem: 'ghl',
            externalAccountKey: expectedLocation,
            externalRecordId,
            handoffId: link.handoff_id,
            eventType
          }
        }, { onConflict: 'event_name,idempotency_key', ignoreDuplicates: true });

      if (eventError) {
        const [, code] = classifySalesDbError(eventError);
        return await settle('rejected', `timeline_append_failed:${code}`);
      }
    }

    if (deactivate && link.is_active) {
      /* Deactivation, not deletion. `external_record_links_deactivation`
         requires `deactivated_at` to be set exactly when `is_active` is
         false, so both move together. The historical link is preserved:
         which CRM record this business was attached to, and when it
         stopped being open, is history worth keeping. */
      const { error: deactivateError } = await db
        .from('external_record_links')
        .update({ is_active: false, deactivated_at: occurredAt.toISOString() })
        .eq('link_id', link.link_id)
        .eq('is_active', true);
      if (deactivateError) {
        const [, code] = classifySalesDbError(deactivateError);
        return await settle('rejected', `link_deactivation_failed:${code}`);
      }
    }

    log('info', 'webhook_processed', {
      eventType, externalRecordId, milestone: milestone?.event || null, deactivated: deactivate
    });
    return await settle('processed', null, {
      milestone: milestone?.event || null,
      deactivated: deactivate
    });

  } catch (error) {
    if (error instanceof OperatorError) {
      return jsonResponse(error.status, { ok: false, code: error.code, message: error.message }, correlationId);
    }
    log('error', 'webhook_unhandled', { message: String(error?.message || error).slice(0, 300) });
    /* 500 so HighLevel retries: an unhandled fault here is transient by
       assumption, and the receipt ledger makes the retry safe. */
    return jsonResponse(500, { ok: false, code: 'internal_error', message: 'The delivery could not be processed.' }, correlationId);
  }
}

export const __testing = { OPPORTUNITY_STATUS_EVENTS, HANDLED_TYPES, parseTimestamp };
