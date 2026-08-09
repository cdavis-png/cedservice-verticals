/* ============================================================
   CED Intelligence Platform — analytics ingestion endpoint
   Vercel Function, Web Standard Request/Response.

   Accepts batches of assessment analytics events, validates each
   one independently, and hands the survivors to a single atomic
   RPC that inserts them and rolls the session summary forward.

   ------------------------------------------------------------
   THREE RULES THAT SHAPE THIS FILE

   1. THIS ENDPOINT MUST NEVER BLOCK AN ASSESSMENT. It shares no
      code path, no transaction, and no failure mode with
      api/assessments.mjs. If analytics is down, the assessment
      is unaffected — and the browser client already treats every
      refusal here as "lose the measurement, keep going".

   2. A BAD EVENT MUST NOT COST A GOOD ONE. Events are validated
      individually and the response names which were accepted and
      which were rejected, so one instrumentation bug does not
      discard a whole batch. The batch is refused as a whole only
      when its ENVELOPE is wrong or when it looks like an attempt
      to push personal data through an analytics door.

   3. THE BROWSER IS NOT TRUSTED. The same prohibited-field rules
      the client applies are applied again here. The client copy
      is a courtesy to the network; this copy is the boundary.

   ------------------------------------------------------------
   AUTHENTICATION

   There is none, and that is a known gap rather than an
   oversight. Analytics events are produced by anonymous visitors
   with no account, exactly like assessment submissions, but
   unlike submissions they cannot justify a challenge: a
   challenge on every step view would cost more than the data is
   worth and would still be solvable once and replayed.

   Until a signed, integrity-bound session token exists, the
   defence is strict per-session and per-address rate limiting
   plus the fact that the worst outcome of forged analytics is a
   wrong funnel — never a wrong Business Record, a wrong report,
   or a wrong price. Nothing this endpoint writes is ever read
   back into the assessment. See docs/ASSESSMENT_ANALYTICS.md,
   "Trust position".
   ============================================================ */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import analyticsEvents from '../shared/analytics/events.js';
import bodyReader from '../shared/security/read-body.js';
import rateLimit from '../shared/security/rate-limit.js';
import supabaseKeys from '../shared/security/supabase-keys.js';

const {
  ANALYTICS_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, LIMITS,
  validateEvent, isProhibitedFieldName, scrubMetadata, sanitizeAttribution,
  isUuid, isIso, EVENTS, DEVICE_CLASSES, bucketViewport, normalizeReviewType,
  reviewTypeOfEvent, sanitizeServiceMixMetadata, ENDPOINT_DERIVED_METADATA_KEYS
} = analyticsEvents;
const { readBoundedBody, parseJsonSafely, OUTCOME: BODY } = bodyReader;
const { buildRateLimitKeys } = rateLimit;

/* Smaller than the assessment endpoint's: an analytics batch is bounded by
   maxEventsPerBatch and each event is small, so anything larger is not a
   browser of ours. */
const DEFAULT_MAX_BYTES = 32768;
const DEFAULT_DB_TIMEOUT_MS = 4000;

/* Analytics is chattier than submission by design, so its window is its own.
   A 15-step assessment produces roughly 40 events; a visitor who restarts
   several times might reach 200. Anything past 600 in fifteen minutes from
   one session is not a person filling in a form. */
const ANALYTICS_RATE_LIMIT = {
  windowSeconds: 900,
  maxRequests: 120          /* requests, not events — batching does the rest */
};

/* An event whose occurredAt is further in the future than this is not
   credible; one older than this describes a session nobody is analysing. */
const CLOCK_SKEW_FUTURE_MS = 5 * 60 * 1000;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const RETRY_AFTER = { rateLimited: 120, database: 30 };

/* ---------- small helpers ---------- */

const hmac = (secret, input) => createHmac('sha256', secret).update(input).digest('hex');
const sha256 = input => createHash('sha256').update(input).digest('hex');

/* Identifiers and counts only. Never an event payload, never metadata, never
   a session's attribution — a log line is a place personal data leaks into a
   system that was carefully designed not to hold any. */
const makeLogger = (env, correlationId) => (level, event, fields = {}) => {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const configured = levels[(env.CED_LOG_LEVEL || 'info').toLowerCase()] ?? 2;
  if ((levels[level] ?? 2) > configured) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, correlationId, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

const allowedOrigins = env =>
  String(env.CED_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

/* Exact match only — the same rule as the assessment endpoint, for the same
   reason. No wildcards, no suffix matching, no "null". */
const isAllowedOrigin = (origin, env) => {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  if (origin === 'null' || origin === '*') return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return false;
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return false;
  return allowedOrigins(env).includes(origin);
};

const corsHeaders = (origin, env, correlationId) => {
  const headers = {
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  };
  if (correlationId) headers['X-Correlation-Id'] = correlationId;
  if (isAllowedOrigin(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Accept';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
};

const json = (status, body, headers, retryAfterSeconds) => {
  const merged = retryAfterSeconds
    ? { ...headers, 'Retry-After': String(retryAfterSeconds) }
    : headers;
  return new Response(JSON.stringify(body), { status, headers: merged });
};

const errorBody = (code, message, correlationId, details) => {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  if (correlationId) error.correlationId = correlationId;
  return { ok: false, error };
};

/* ---------- validation ---------- */

/* Rejected for a stated reason, one entry per event, so a client author can
   fix instrumentation without guessing. */
const reject = (eventId, code, message) => ({ eventId: eventId || null, code, message });

const validateEnvelope = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'Request body must be a JSON object.' };
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(body.schemaVersion)) {
    return { ok: false, code: 'unsupported_version',
             message: `Unsupported analytics schemaVersion. Supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.` };
  }
  if (!Array.isArray(body.events)) {
    return { ok: false, code: 'invalid_batch', message: 'events must be an array.' };
  }
  if (body.events.length === 0) {
    return { ok: false, code: 'empty_batch', message: 'events must not be empty.' };
  }
  if (body.events.length > LIMITS.maxEventsPerBatch) {
    return { ok: false, code: 'batch_too_large',
             message: `A batch may carry at most ${LIMITS.maxEventsPerBatch} events.` };
  }
  /* A body shaped like a contact record is a deliberate attempt, not a bug,
     and is refused whole rather than trimmed. */
  const offenders = Object.keys(body).filter(isProhibitedFieldName);
  if (offenders.length) {
    return { ok: false, code: 'prohibited_data',
             message: 'The request envelope contains prohibited field names.' };
  }
  return { ok: true };
};

/* `clockSkewClamped` and `claimedOccurredAt` are the ENDPOINT's to write, and
   never accepted from a request — on any event, for either review type.

   A client that could assert "my timestamp was clamped" could annotate a row
   with something that never happened, and could put an arbitrary string in
   `claimedOccurredAt` under a key the allowlist otherwise permits. Neither is
   a dramatic leak; both are a row saying something untrue about how it was
   recorded, and a funnel nobody can trust is a funnel nobody should use.

   Returns a copy. The batch is parsed JSON the caller may still be holding. */
const stripEndpointDerivedMetadata = event => {
  if (!event || typeof event !== 'object') return event;
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return event;
  if (!ENDPOINT_DERIVED_METADATA_KEYS.some(key =>
    Object.prototype.hasOwnProperty.call(metadata, key))) return event;

  const kept = {};
  Object.keys(metadata).forEach(key => {
    if (ENDPOINT_DERIVED_METADATA_KEYS.includes(key)) return;
    kept[key] = metadata[key];
  });
  return { ...event, metadata: kept };
};

/* Re-derives the stored row from the event, keeping ONLY the fields the
   schema defines. A client that invents an extra field does not get it
   stored; that is the difference between a schema and a suggestion. */
const toRow = (event, now) => {
  const scrubbed = scrubMetadata(event.metadata).metadata;
  const attribution = sanitizeAttribution(event.attribution);
  const device = event.device && typeof event.device === 'object' ? event.device : {};
  const deviceClass = DEVICE_CLASSES.includes(device.deviceClass) ? device.deviceClass : 'unknown';

  /* A device clock running fast must not put an event in the future, and the
     timeline of a session must stay sortable. Clamped exactly as the
     assessment timeline is, and the visitor's claim is preserved in metadata
     so a clamp is explainable rather than invisible. */
  const claimed = Date.parse(event.occurredAt);
  const clamped = Math.min(claimed, now);
  const skewed = clamped !== claimed;

  /* Resolved from the NAME first, so an event that mislabels itself is still
     held to its own funnel's rules. */
  const resolvedReviewType = reviewTypeOfEvent(event.eventName) ||
    normalizeReviewType(event.reviewType);
  const isServiceMix = resolvedReviewType === 'service_mix';

  /* validateEvent has already refused a Service Mix event carrying anything
     outside the allowlist, so nothing reaching here should need removing.
     It is removed anyway. The endpoint's job is that no unapproved value can
     be STORED, not that no unapproved value was sent — and the two are only
     the same statement while every path into this function goes through that
     validation. This one does today; the guarantee should not depend on it
     still doing so tomorrow. */
  const metadata = isServiceMix
    ? sanitizeServiceMixMetadata(scrubbed, event.eventName).metadata
    : scrubbed;

  /* Held to the shape a Service Mix step id has, for the same reason: it is a
     free string in the envelope rather than in metadata, which changes where
     it sits and not what it can carry. Truncating it would be worse than
     dropping it — a shortened identifier is a different identifier. */
  const rawStepId = event.stepId
    ? String(event.stepId).slice(0, LIMITS.maxStepIdLength) : null;
  const stepId = isServiceMix
    ? (sanitizeServiceMixMetadata({ stepId: rawStepId }).metadata.stepId ?? null)
    : rawStepId;

  /* Written here, and ONLY when a clamp actually happened. The claimed
     timestamp is re-derived from the parsed value rather than copied from the
     request, so not one client-supplied character survives into the row — the
     annotation explains a clamp without becoming a way to smuggle a string
     past the rule. The Growth path keeps its existing wording. */
  const skewAnnotation = () => ({
    clockSkewClamped: true,
    claimedOccurredAt: isServiceMix
      ? new Date(claimed).toISOString()
      : event.occurredAt
  });

  return {
    eventId: event.eventId,
    eventName: event.eventName,
    eventVersion: event.eventVersion,
    schemaVersion: event.schemaVersion,
    assessmentSessionId: event.assessmentSessionId,
    submissionId: event.submissionId ?? null,
    businessId: event.businessId ?? null,
    verticalId: event.verticalId,
    assessmentVersion: event.assessmentVersion ?? null,
    questionSetVersion: event.questionSetVersion ?? null,
    /* Normalised server-side, not merely trusted. An event with no declared
       review type is a Growth Review event — a schema-1 page cached before
       the Service Mix deploy has no field to send, and relabelling its rows
       later is not something an append-only table can do. */
    reviewType: normalizeReviewType(event.reviewType),
    assessmentStage: event.assessmentStage ?? null,
    stepId,
    questionId: event.questionId ? String(event.questionId).slice(0, LIMITS.maxQuestionIdLength) : null,
    occurredAt: new Date(clamped).toISOString(),
    activeElapsedMs: Math.round(Number(event.activeElapsedMs) || 0),
    totalElapsedMs: Math.round(Number(event.totalElapsedMs) || 0),
    stepElapsedMs: event.stepElapsedMs === null || event.stepElapsedMs === undefined
      ? null : Math.round(Number(event.stepElapsedMs) || 0),
    visibleQuestionCount: Number.isFinite(Number(event.visibleQuestionCount))
      ? Math.round(Number(event.visibleQuestionCount)) : null,
    completedQuestionCount: Number.isFinite(Number(event.completedQuestionCount))
      ? Math.round(Number(event.completedQuestionCount)) : null,
    attribution,
    device: {
      deviceClass,
      /* Re-bucketed here, not merely trusted from the client. An exact pixel
         pair is a strong fingerprint, and the browser copy of that rule can be
         bypassed — so the server applies it again, the same way it re-applies
         the field-name prohibition. */
      viewportWidth: bucketViewport(device.viewportWidth),
      viewportHeight: bucketViewport(device.viewportHeight)
    },
    metadata: skewed ? { ...metadata, ...skewAnnotation() } : metadata,
    consentStatus: typeof event.consentStatus === 'string' ? event.consentStatus.slice(0, 32) : null
  };
};

/* ---------- database ---------- */

/* Selected by `shared/security/supabase-keys.js` — one definition of "prefer
   SUPABASE_SECRET_KEY, accept the legacy SUPABASE_SERVICE_ROLE_KEY, refuse
   anything that is not positively an elevated key". Reading the legacy
   variable directly here meant a secret-key-only deployment lost analytics
   while the staff console came up.

   Returning null is the configured behaviour for this endpoint and stays
   that way: analytics never affects the assessment, so a missing or
   unusable key costs a measurement rather than a visitor's work.

   The cache is keyed on (url, key), matching the other two server surfaces:
   a bare `if (cachedClient)` outlived a key rotation inside a warm
   instance. */
let cachedClient = null;
const getClient = async env => {
  const url = env.SUPABASE_URL || '';
  const key = supabaseKeys.elevatedKey(env);
  if (!url || !key) return null;
  if (cachedClient && cachedClient.url === url && cachedClient.key === key) {
    return cachedClient.client;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  cachedClient = { url, key, client };
  return client;
};

const callRpc = (db, name, args, signal) => {
  const call = db.rpc(name, args);
  return (call && typeof call.abortSignal === 'function') ? call.abortSignal(signal) : call;
};

const runWithTimeout = async (factory, timeoutMs, label) => {
  const controller = new AbortController();
  let abortTimer = null;
  let raceTimer = null;
  try {
    const work = Promise.resolve(factory(controller.signal));
    const expiry = new Promise(resolve => {
      raceTimer = setTimeout(() => resolve({ __timedOut: label }), timeoutMs);
    });
    abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    return await Promise.race([work, expiry]);
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    if (raceTimer) clearTimeout(raceTimer);
  }
};

/* ---------- handler ---------- */

export async function handleRequest(request, deps = {}) {
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const newId = deps.randomUUID || randomUUID;
  const correlationId = deps.correlationId || newId();
  const log = makeLogger(env, correlationId);
  const started = Date.now();
  const origin = request.headers.get('origin');

  try {
    const headers = corsHeaders(origin, env, correlationId);

    if (!origin || !isAllowedOrigin(origin, env)) {
      log('warn', 'analytics_origin_refused', {});
      return json(403, errorBody('origin_not_allowed',
        'This endpoint accepts browser events from permitted origins only.', correlationId), headers);
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') {
      return json(405, errorBody('method_not_allowed', 'Only POST and OPTIONS are supported.', correlationId),
        { ...headers, Allow: 'POST, OPTIONS' });
    }

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return json(415, errorBody('unsupported_media_type', 'Content-Type must be application/json.',
        correlationId), headers);
    }

    const maxBytes = Number(env.CED_ANALYTICS_MAX_REQUEST_BYTES) > 0
      ? Number(env.CED_ANALYTICS_MAX_REQUEST_BYTES) : DEFAULT_MAX_BYTES;

    const bodyResult = await readBoundedBody(request, maxBytes);
    if (bodyResult.outcome === BODY.tooLarge) {
      log('warn', 'analytics_rejected', { code: 'payload_too_large', bytesRead: bodyResult.bytesRead });
      return json(413, errorBody('payload_too_large', 'Request body exceeds the permitted size.',
        correlationId), headers);
    }
    if (bodyResult.outcome !== BODY.ok) {
      return json(400, errorBody('body_read_failed', 'Request body could not be read.',
        correlationId), headers);
    }

    const parsed = parseJsonSafely(bodyResult.text);
    if (!parsed.ok) {
      return json(400, errorBody('malformed_json', 'Request body is not valid JSON.', correlationId), headers);
    }

    const envelope = validateEnvelope(parsed.value);
    if (!envelope.ok) {
      log('warn', 'analytics_rejected', { code: envelope.code });
      return json(400, errorBody(envelope.code, envelope.message, correlationId), headers);
    }

    const batch = parsed.value.events;

    /* Every event in a batch must belong to ONE session. A batch spanning
       sessions is either a bug or an attempt to write rows under an id the
       sender does not hold, and the per-session rate limit is meaningless
       without it. */
    const sessionIds = [...new Set(batch.map(e => e && e.assessmentSessionId).filter(Boolean))];
    if (sessionIds.length !== 1 || !isUuid(sessionIds[0])) {
      log('warn', 'analytics_rejected', { code: 'mixed_sessions', sessions: sessionIds.length });
      return json(400, errorBody('mixed_sessions',
        'A batch must carry events for exactly one assessmentSessionId.', correlationId), headers);
    }
    const sessionId = sessionIds[0];

    const db = deps.db || await getClient(env);
    if (!db) {
      /* Not configured is not an error the visitor caused, and analytics is
         never worth an alarm on the client. */
      log('warn', 'analytics_not_configured', {});
      return json(202, { ok: true, accepted: [], rejected: [], stored: false, correlationId }, headers);
    }

    /* Rate limiting first: it is the only real defence this endpoint has
       until signed session tokens exist. */
    const keys = buildRateLimitKeys({
      headers: request.headers, sessionId, env, hmacFn: hmac
    });
    if (keys.length) {
      const limitResult = await callRpc(db, 'check_rate_limit', {
        p_keys: keys.map(k => ({ ...k, scope: k.scope })),
        p_window_seconds: Number(env.CED_ANALYTICS_RATE_WINDOW_SECONDS) > 0
          ? Number(env.CED_ANALYTICS_RATE_WINDOW_SECONDS) : ANALYTICS_RATE_LIMIT.windowSeconds,
        p_max_requests: Number(env.CED_ANALYTICS_RATE_MAX) > 0
          ? Number(env.CED_ANALYTICS_RATE_MAX) : ANALYTICS_RATE_LIMIT.maxRequests
      });
      if (limitResult && limitResult.error) {
        log('warn', 'analytics_rate_limit_unavailable', { reason: 'rpc_error' });
      } else if (limitResult && limitResult.data && limitResult.data.allowed === false) {
        const retryAfter = Number(limitResult.data.retryAfterSeconds) > 0
          ? Math.ceil(Number(limitResult.data.retryAfterSeconds)) : RETRY_AFTER.rateLimited;
        log('warn', 'analytics_rate_limited', { scope: limitResult.data.scope || null });
        return json(429, errorBody('rate_limited', 'Too many analytics requests.', correlationId),
          headers, retryAfter);
      }
    } else if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
      log('error', 'analytics_rate_limit_not_configured', {});
    }

    /* Per-event validation. One bad event costs itself and nothing else. */
    const accepted = [];
    const rejected = [];
    const seen = new Set();

    batch.forEach(raw => {
      /* The clock-skew annotations are REMOVED from the request before
         anything looks at it, rather than refused. They are this endpoint's
         to write, and a client sending them is more likely a cached page
         echoing a stored row back than an attack — refusing would cost a
         legitimate measurement to punish a field we were going to overwrite
         anyway. Everything downstream, validation included, sees an event
         that never carried them. */
      const event = stripEndpointDerivedMetadata(raw);
      const check = validateEvent(event);
      if (!check.valid) {
        rejected.push(reject(event && event.eventId, check.errors[0].code, check.errors[0].message));
        return;
      }
      /* Duplicates inside one batch are suppressed here; duplicates across
         batches are suppressed by the primary key. */
      if (seen.has(event.eventId)) {
        rejected.push(reject(event.eventId, 'duplicate_in_batch', 'Repeated eventId within one batch.'));
        return;
      }
      const occurred = Date.parse(event.occurredAt);
      if (occurred > now + CLOCK_SKEW_FUTURE_MS) {
        rejected.push(reject(event.eventId, 'occurred_at_in_future',
          'occurredAt is too far in the future to be credible.'));
        return;
      }
      if (occurred < now - MAX_EVENT_AGE_MS) {
        rejected.push(reject(event.eventId, 'occurred_at_too_old',
          'occurredAt is outside the accepted analytics window.'));
        return;
      }
      seen.add(event.eventId);
      accepted.push(toRow(event, now));
    });

    if (!accepted.length) {
      log('warn', 'analytics_all_rejected', {
        batchSize: batch.length, codes: [...new Set(rejected.map(r => r.code))]
      });
      return json(200, { ok: true, accepted: [], rejected, stored: false, correlationId }, headers);
    }

    const dbTimeout = Number(env.CED_ANALYTICS_DB_TIMEOUT_MS) > 0
      ? Number(env.CED_ANALYTICS_DB_TIMEOUT_MS) : DEFAULT_DB_TIMEOUT_MS;

    const meta = {
      correlationId,
      receivedAt: new Date(now).toISOString(),
      /* Pseudonymous and keyed; there is no address here and never will be. */
      sourceKey: keys.length ? sha256(keys.map(k => k.key).join('|')).slice(0, 32) : null
    };

    const result = await runWithTimeout(signal => callRpc(db, 'ingest_analytics_events', {
      p_events: accepted,
      p_meta: meta,
      p_retention_days: Number(env.CED_ANALYTICS_RETENTION_DAYS) > 0
        ? Number(env.CED_ANALYTICS_RETENTION_DAYS) : 400
    }, signal), dbTimeout, 'analytics_ingest');

    if (result && result.__timedOut) {
      log('error', 'analytics_ingest_timeout', { timeoutMs: dbTimeout, events: accepted.length });
      return json(503, errorBody('ingest_timeout', 'Analytics storage took too long.', correlationId),
        headers, RETRY_AFTER.database);
    }

    const { data, error } = result || {};
    if (error) {
      log('error', 'analytics_ingest_error', {
        events: accepted.length,
        /* Server-side only; the client is told nothing about the database. */
        dbMessage: error.message
      });
      return json(503, errorBody('ingest_failed', 'Analytics events could not be stored.', correlationId),
        headers, RETRY_AFTER.database);
    }

    const storedIds = data && Array.isArray(data.accepted) ? data.accepted : accepted.map(e => e.eventId);
    const duplicates = data && Array.isArray(data.duplicates) ? data.duplicates : [];

    log('info', 'analytics_ingested', {
      events: accepted.length,
      stored: storedIds.length,
      duplicates: duplicates.length,
      rejected: rejected.length,
      verticalId: accepted[0].verticalId,
      durationMs: Date.now() - started
    });

    return json(200, {
      ok: true,
      accepted: storedIds,
      /* A duplicate is a success, not a failure: the client retried and the
         database already had it. Reported separately so a client can stop
         retrying without treating it as an error. */
      duplicates,
      rejected,
      stored: true,
      correlationId
    }, headers);

  } catch (err) {
    const headers = corsHeaders(origin, env, correlationId);
    log('error', 'analytics_unhandled_error', {
      name: err && err.name, message: err && err.message, stack: err && err.stack
    });
    /* Even an unhandled failure answers cleanly. Analytics is never worth a
       retry storm from every browser on the site. */
    return json(500, errorBody('internal_error', 'The request could not be completed.', correlationId), headers);
  }
}

/* ============================================================
   NAMED METHOD EXPORTS — the Vercel Node runtime contract.

   Vercel's Node.js runtime selects its invocation contract from
   the EXPORT SHAPE:

     export default handler        -> Node signature (req, res)
     export function POST(request) -> Web signature (Request)

   This file is written for the Web signature, so it must use
   named method exports. As a DEFAULT export it was called with
   (req, res): `req.url` is a path rather than an absolute URL,
   `req.headers` has no `.get()`, and — decisively — the returned
   `Response` was DISCARDED because a Node-signature handler
   answers through `res`. Nothing ever wrote to `res`, so every
   invocation ran to the platform's 15-second limit and answered
   504 FUNCTION_INVOCATION_TIMEOUT with no exception to show.

   EVERY STANDARD METHOD IS EXPORTED, and that does NOT widen what
   this endpoint accepts. POST is the endpoint; OPTIONS is its CORS preflight, answered 204. handleRequest
   already answers a deterministic `405 method_not_allowed` with
   `Allow: POST, OPTIONS` for anything else. A method with no
   named export is refused by VERCEL with a generic 405 instead,
   losing the JSON envelope, the error code, the correlation id
   and the CORS headers. Forwarding the method so the application
   can refuse it is what preserves that contract.
   ============================================================ */

/* One argument in, one argument forwarded: handleRequest's second parameter
   is a test-only injection seam and nothing the platform passes may reach
   it. */
const respond = request => handleRequest(request);

export const POST = respond;
export const OPTIONS = respond;

/* Forwarded ONLY so the application's own 405 answers them, never to accept
   them. */
export const GET = respond;
export const PUT = respond;
export const PATCH = respond;
export const DELETE = respond;
export const HEAD = respond;

export const config = { runtime: 'nodejs' };

export const ANALYTICS = {
  ANALYTICS_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  DEFAULT_MAX_BYTES,
  ANALYTICS_RATE_LIMIT,
  CLOCK_SKEW_FUTURE_MS,
  MAX_EVENT_AGE_MS,
  EVENT_NAMES: Object.keys(EVENTS)
};

/* Exported so the suite can exercise the PRODUCTION client factory, for the
   reason api/assessments.mjs gives: it is what proves this endpoint prefers
   SUPABASE_SECRET_KEY and treats SUPABASE_SERVICE_ROLE_KEY as legacy. */
export const __testing = { getClient };
