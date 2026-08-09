/* ============================================================
   CED Intelligence Platform — assessment capture endpoint
   Vercel Function, Web Standard Request/Response.

   Validates, then hands one submission to a single atomic RPC.
   This file performs no partial writes of its own: every durable
   effect happens inside ingest_assessment().

   SUPABASE_SERVICE_ROLE_KEY is read here and never leaves the
   server. Nothing in this file is reachable from browser code.

   ------------------------------------------------------------
   Threat position (Milestone 1.1)

   This endpoint is PUBLIC and UNAUTHENTICATED by necessity — it
   accepts submissions from a marketing page filled in by people
   who have no account. It is therefore defended in layers, each
   of which is cheap and none of which is sufficient alone:

     1. Origin allowlist        — required, exact match
     2. Bounded body reading    — bytes counted as they arrive
     3. Field and shape limits  — before any database work
     4. Server-side honeypot    — the browser is not trusted
     5. Rate limiting           — pseudonymous, database-backed
     6. Challenge verification  — provider-neutral, fails closed
     7. Idempotency             — replay is free, duplication is not

   Server-to-server ingestion is NOT supported here and must get
   its own authenticated route. A missing Origin is refused.

   Ordering matters and is deliberate: everything that can reject
   a request cheaply runs before anything that costs a network
   call or a transaction.
   ============================================================ */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import bie from '../shared/business-intelligence/generate-bir.js';
import registry from '../shared/business-intelligence/review-registry.js';
import offeringSchema from '../shared/service-mix-engine/offering.schema.js';
import identity from '../shared/business-record/resolve-identity.js';
import memoryFact from '../shared/business-record/memory-fact.schema.js';
import limitsModule from '../shared/security/limits.js';
import bodyReader from '../shared/security/read-body.js';
import challenge from '../shared/security/verify-challenge.js';
import continuation from '../shared/security/continuation.js';
import rateLimit from '../shared/security/rate-limit.js';

const { stableStringify } = bie;
const { REVIEW_TYPES, DEFAULT_REVIEW_TYPE, readReviewType, entryFor } = registry;
const { validateServiceMix } = offeringSchema;
const { extractIdentitySignals, persistableSignals } = identity;
const { PROHIBITED_PREDICATE_PATTERN } = memoryFact;
const { checkPayloadLimits } = limitsModule;
const { readBoundedBody, parseJsonSafely, OUTCOME: BODY } = bodyReader;
const { verifyChallenge, OUTCOME: CHALLENGE } = challenge;
const {
  issueContinuationContext, verifyContinuationContext, stripContinuationToken,
  OUTCOME: CONTINUATION
} = continuation;
const { buildRateLimitKeys, rateLimitPolicy } = rateLimit;

/* ---------- version compatibility ----------
   A range, not a point. When the current version moves forward, the previous
   one stays accepted for a migration window so that assessments already
   sitting in a browser retry queue — built by a page loaded before the
   deploy — are still delivered instead of being rejected as "unsupported".
   Policy and window: docs/PRODUCTION_HARDENING.md. */
/* The GROWTH current. SM-1 did not change the Growth payload, so this stayed
   at 5 — the page still builds 5 and the two must agree on what "current"
   means. Version 6 is a different review's shape, not a newer Growth one,
   which is why it is declared per review type below rather than here. */
const CURRENT_PAYLOAD_SCHEMA = 5;
const SUPPORTED_PAYLOAD_SCHEMAS = Object.freeze([2, 3, 4, 5, 6]);
/* Versions below this were never persisted by a released page. */
const MIN_KNOWN_PAYLOAD_SCHEMA = 2;

/* Which payload versions each review type may declare. 6 is the Quick
   Service Mix Review's shape and carries no Growth results block at all; a
   Growth payload claiming 6, or a Service Mix payload claiming 5, is a
   confused client rather than a version to accommodate. */
const PAYLOAD_SCHEMAS_BY_REVIEW = Object.freeze({
  growth_review: Object.freeze([2, 3, 4, 5]),
  service_mix: Object.freeze([6])
});

const CURRENT_PAYLOAD_SCHEMA_BY_REVIEW = Object.freeze({
  growth_review: 5,
  service_mix: 6
});

/* Sections each review type must carry. A Service Mix submission has no
   Growth Score, no opportunity figure, and no package — asking it for a
   `results` block would mean inventing one. */
const REQUIRED_SECTIONS_BY_REVIEW = Object.freeze({
  growth_review: Object.freeze(['vertical', 'contact', 'consent', 'answers', 'results', 'attribution']),
  service_mix: Object.freeze(['vertical', 'contact', 'consent', 'serviceMix', 'attribution'])
});

const SUPPORTED_VERTICALS = new Set(['nails']);
const DEFAULT_MAX_BYTES = 65536;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const MAX_OPPORTUNITY = 10_000_000;

/* Future skew we tolerate from a device clock before refusing outright.
   Inside this window the submission is accepted and the timeline timestamp
   is clamped; outside it, the timestamp is not credible. */
const CLOCK_SKEW_FUTURE_MS = 5 * 60 * 1000;
/* Any future offset beyond this is recorded as skew, for observability. */
const CLOCK_SKEW_DETECT_MS = 1000;
/* Matches the browser queue's retention. Freshness is NOT an abuse control
   here — idempotency, rate limiting, and the challenge are. Rejecting a
   two-day-old queued submission only loses a real assessment. */
const DEFAULT_MAX_AGE_DAYS = 30;

/* Timeout budget, innermost first. Ordering is asserted at startup:
     challenge  <  database  <  function budget  <  client
   See docs/PRODUCTION_HARDENING.md. */
const DEFAULT_CHALLENGE_TIMEOUT_MS = 3000;
const DEFAULT_DB_TIMEOUT_MS = 6000;

/* A stale challenge token cannot be re-solved by a background retry, so a
   submission older than this is exempted from the challenge and leans on
   rate limiting instead. Documented trade-off — see PRODUCTION_HARDENING.md. */
const CHALLENGE_MAX_SUBMISSION_AGE_MS = 15 * 60 * 1000;

/* Retained for the documentation generator and for anything still reading the
   Growth contract by that name. REQUIRED_SECTIONS_BY_REVIEW is the authority. */
const REQUIRED_SECTIONS = REQUIRED_SECTIONS_BY_REVIEW.growth_review;

/* Advertised to clients on transient refusals so a retry is scheduled
   sensibly rather than immediately. */
const RETRY_AFTER = { rateLimited: 60, challengeUnavailable: 30, database: 15, inFlight: 5 };

/* ---------- small helpers ---------- */

const isUuid = v => typeof v === 'string' && UUID_RE.test(v);
const isIso = v => typeof v === 'string' && !Number.isNaN(Date.parse(v)) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v);
const sha256 = input => createHash('sha256').update(input).digest('hex');
const hmac = (secret, input) => createHmac('sha256', secret).update(input).digest('hex');

class ValidationError extends Error {
  constructor(status, code, message, details, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
const fail = (status, code, message, details, retryAfterSeconds) => {
  throw new ValidationError(status, code, message, details, retryAfterSeconds);
};

/* Structured, identifiers-only. Never contact details, answers, bodies,
   tokens, or secrets. Every line carries the correlation id so a visitor's
   report of "it failed" can be traced without asking them for anything. */
const makeLogger = (env, correlationId) => (level, event, fields = {}) => {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const configured = levels[(env.CED_LOG_LEVEL || 'info').toLowerCase()] ?? 2;
  if ((levels[level] ?? 2) > configured) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, correlationId, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/* ---------- CORS and origin ---------- */

const allowedOrigins = env =>
  String(env.CED_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

/* Exact match only. No wildcards, no suffix matching, no "null". */
const isAllowedOrigin = (origin, env) => {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  if (origin === 'null' || origin === '*') return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  /* An Origin is scheme + host + port and nothing else. Anything carrying a
     path, query, or credentials is malformed and refused. */
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
    headers['Access-Control-Allow-Headers'] =
      'Content-Type, Idempotency-Key, Accept, X-CED-Challenge, X-CED-Continuation';
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

const errorBody = (code, message, details, correlationId, retryAfterSeconds) => {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  if (correlationId) error.correlationId = correlationId;
  if (retryAfterSeconds) error.retryAfterSeconds = retryAfterSeconds;
  return { ok: false, error };
};

/* This endpoint serves browsers only. A request without an Origin is either
   not a browser or is deliberately hiding, and either way it belongs on the
   authenticated server-to-server route that does not exist yet. */
const assertOrigin = (request, env) => {
  const origin = request.headers.get('origin');
  if (!origin) {
    fail(403, 'origin_required',
      'This endpoint accepts browser submissions only and requires an Origin header.');
  }
  if (!isAllowedOrigin(origin, env)) {
    fail(403, 'origin_not_allowed', 'Origin is not permitted to call this endpoint.');
  }
  return origin;
};

/* ---------- validation ---------- */

const scanProhibited = (value, path = '', found = [], depth = 0) => {
  if (found.length >= 5 || depth > 12) return found;
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (found.length >= 5) break;
      if (PROHIBITED_PREDICATE_PATTERN.test(key)) found.push(path ? `${path}.${key}` : key);
      scanProhibited(child, path ? `${path}.${key}` : key, found, depth + 1);
    }
  }
  return found;
};

const maxAgeMs = env => {
  const days = Number(env.CED_SUBMISSION_MAX_AGE_DAYS) > 0
    ? Number(env.CED_SUBMISSION_MAX_AGE_DAYS) : DEFAULT_MAX_AGE_DAYS;
  return days * 24 * 60 * 60 * 1000;
};

/* Returns timing facts the caller needs; never mutates the payload, which
   must reach the database exactly as the visitor's browser sent it. */
const validateTiming = (payload, now, env) => {
  if (!isIso(payload.submittedAt)) {
    fail(400, 'invalid_submitted_at', 'submittedAt must be an ISO 8601 timestamp.');
  }
  const submittedAtMs = Date.parse(payload.submittedAt);

  if (submittedAtMs > now + CLOCK_SKEW_FUTURE_MS) {
    fail(400, 'submitted_at_in_future', 'submittedAt is too far in the future to be credible.');
  }
  if (submittedAtMs < now - maxAgeMs(env)) {
    fail(400, 'submitted_at_too_old', 'submittedAt is outside the accepted submission window.');
  }

  /* The timeline requires recorded_at >= occurred_at. A device clock running
     fast must never abort ingestion, so the timeline timestamp is clamped to
     server receive time while the visitor-supplied value is preserved
     untouched inside the stored payload. */
  const skewMs = submittedAtMs - now;
  const clamped = Math.min(submittedAtMs, now);

  return {
    submittedAt: payload.submittedAt,
    submittedAtMs,
    clockSkewMs: skewMs,
    clockSkewDetected: skewMs > CLOCK_SKEW_DETECT_MS,
    timelineOccurredAt: new Date(clamped).toISOString(),
    clamped: clamped !== submittedAtMs
  };
};

const validateVersion = (payload, reviewType) => {
  const version = payload.schemaVersion;
  if (!Number.isInteger(version)) {
    fail(400, 'unsupported_version', 'schemaVersion must be an integer.', {
      supported: SUPPORTED_PAYLOAD_SCHEMAS, current: CURRENT_PAYLOAD_SCHEMA
    });
  }
  if (!SUPPORTED_PAYLOAD_SCHEMAS.includes(version)) {
    fail(400, 'unsupported_version',
      `Payload schemaVersion ${version} is not supported.`,
      {
        received: version,
        supported: SUPPORTED_PAYLOAD_SCHEMAS,
        current: CURRENT_PAYLOAD_SCHEMA,
        reason: version < MIN_KNOWN_PAYLOAD_SCHEMA ? 'retired' : 'unrecognised'
      });
  }
  const permitted = PAYLOAD_SCHEMAS_BY_REVIEW[reviewType];
  if (permitted && !permitted.includes(version)) {
    fail(400, 'version_review_type_mismatch',
      `Payload schemaVersion ${version} is not valid for a ${reviewType} submission.`,
      { received: version, reviewType, supported: permitted });
  }
  return version;
};

/* The Quick Service Mix Review's own block. Validated with the SAME module
   the browser uses, because a browser and a server that disagree about what a
   valid offering is will disagree in the direction that stores the invalid
   one. Offering-count limits are enforced here and not only in the page. */
const validateServiceMixPayload = payload => {
  const result = validateServiceMix(payload.serviceMix);
  if (!result.valid) {
    fail(422, 'invalid_service_mix',
      'The service mix could not be accepted.',
      { violations: result.errors.slice(0, 10) });
  }

  /* Results still reach the visitor by email, so the disclaimer still travels
     with them. A figure whose disclaimer was left behind is the one thing
     CLAUDE.md section 4 refuses outright. */
  const results = payload.results;
  if (results !== undefined) {
    if (!results || typeof results !== 'object' || Array.isArray(results)) {
      fail(400, 'invalid_results', 'results must be an object when present.');
    }
    if (typeof results.disclaimer !== 'string' || results.disclaimer.trim().length < 10) {
      fail(400, 'missing_disclaimer', 'results.disclaimer must carry the wording shown to the visitor.');
    }
  }

  /* SM-1 collects no direct costs. A payload carrying one is a client from a
     milestone that does not exist yet, or a tampered one; either way the
     engine must not analyse a cost as though it were evidence. */
  const offerings = payload.serviceMix.offerings || [];
  if (offerings.some(o => o && o.directCost !== undefined)) {
    fail(422, 'direct_cost_not_collected',
      'Direct costs are not collected in the Quick Service Mix Review.');
  }
};

const validatePayload = (payload, idempotencyKey, now, env) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail(400, 'invalid_body', 'Request body must be a JSON object.');
  }

  /* Which review this is. A payload that declares nothing is a Growth
     Review, which is what every payload written before review types existed
     was. An unrecognised declaration is refused rather than defaulted: a
     client naming a review type we do not have is confused about something,
     and guessing on its behalf would file its submission under the wrong
     engine. */
  if (payload.reviewType !== undefined && payload.reviewType !== null &&
      !REVIEW_TYPES.includes(payload.reviewType)) {
    fail(400, 'unsupported_review_type', 'reviewType is not a supported review.',
      { supported: REVIEW_TYPES });
  }
  const reviewType = readReviewType(payload);

  const schemaVersion = validateVersion(payload, reviewType);

  if (typeof payload.assessmentVersion !== 'string' || !SEMVER_RE.test(payload.assessmentVersion)) {
    fail(400, 'invalid_assessment_version', 'assessmentVersion must be a semantic version string.');
  }

  if (!isUuid(payload.submissionId)) fail(400, 'invalid_submission_id', 'submissionId must be a UUID.');
  if (!isUuid(payload.assessmentSessionId)) fail(400, 'invalid_session_id', 'assessmentSessionId must be a UUID.');

  /* The header is the idempotency key of record; the body must agree with it.
     Neither is ever derived from a contact field. */
  if (payload.submissionId !== idempotencyKey) {
    fail(409, 'idempotency_key_mismatch', 'Idempotency-Key must equal payload.submissionId.');
  }

  (REQUIRED_SECTIONS_BY_REVIEW[reviewType] || REQUIRED_SECTIONS).forEach(section => {
    if (!payload[section] || typeof payload[section] !== 'object') {
      fail(400, 'missing_section', `Required payload section missing or invalid: ${section}`);
    }
  });

  const verticalId = payload.vertical.id;
  if (typeof verticalId !== 'string' || !SUPPORTED_VERTICALS.has(verticalId)) {
    fail(400, 'unsupported_vertical', 'vertical.id is not a supported vertical.');
  }

  const timing = validateTiming(payload, now, env);

  /* Consent: results delivery is the only one that gates ingestion, and it
     must be an explicit true. Marketing consents are recorded, never
     required. */
  const consent = payload.consent.resultsDeliveryConsent;
  if (!consent || consent.granted !== true) {
    fail(422, 'results_consent_required', 'resultsDeliveryConsent.granted must be true.');
  }
  if (typeof consent.statement !== 'string' || consent.statement.trim().length < 10) {
    fail(422, 'consent_statement_missing', 'The exact consent statement shown must be recorded.');
  }

  const contact = payload.contact;
  if (typeof contact.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
    fail(400, 'invalid_contact_email', 'contact.email must be a valid email address.');
  }

  /* Everything below this point is review-specific. The Growth checks are
     byte-for-byte what they were; they are now reached through a branch
     rather than unconditionally, because a Service Mix submission has no
     Growth Score, no opportunity figure, and no package to check. */
  if (reviewType !== DEFAULT_REVIEW_TYPE) {
    validateServiceMixPayload(payload);
  } else {
    const results = payload.results;
    const score = results.score;
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      fail(400, 'invalid_score', 'results.score must be an integer between 0 and 100.');
    }
    const opportunity = results.opportunity;
    if (typeof opportunity !== 'number' || !Number.isFinite(opportunity) ||
        opportunity < 0 || opportunity > MAX_OPPORTUNITY) {
      fail(400, 'invalid_opportunity', 'results.opportunity must be a finite, non-negative number.');
    }
    if (!results.dimensions || typeof results.dimensions !== 'object') {
      fail(400, 'invalid_dimensions', 'results.dimensions must be an object.');
    }
    for (const [key, value] of Object.entries(results.dimensions)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        fail(400, 'invalid_dimension_value', `results.dimensions.${key} must be a number between 0 and 100.`);
      }
    }
    if (!Array.isArray(results.priorities) || results.priorities.length === 0 ||
        results.priorities.some(p => typeof p !== 'string')) {
      fail(400, 'invalid_priorities', 'results.priorities must be a non-empty array of strings.');
    }
    if (typeof results.disclaimer !== 'string' || results.disclaimer.trim().length < 10) {
      fail(400, 'missing_disclaimer', 'results.disclaimer must carry the wording shown to the visitor.');
    }
    const pkg = results.recommendedPackage;
    if (!pkg || typeof pkg.id !== 'string' || typeof pkg.label !== 'string') {
      fail(400, 'invalid_package', 'results.recommendedPackage must include id and label.');
    }
    if (pkg.price !== null && pkg.price !== undefined &&
        (typeof pkg.price !== 'number' || !Number.isFinite(pkg.price) || pkg.price < 0)) {
      fail(400, 'invalid_package_price', 'results.recommendedPackage.price must be a non-negative number.');
    }
  }

  /* Schema 4 carries the intelligence dimensions and the branching record.
     Both are optional in shape terms — the report recomputes the dimensions
     from the answers regardless — but a malformed block is a broken client,
     not something to store and puzzle over later. */
  if (schemaVersion >= 4) {
    if (payload.branching !== undefined &&
        (payload.branching === null || typeof payload.branching !== 'object' ||
         Array.isArray(payload.branching))) {
      fail(400, 'invalid_branching', 'branching must be an object when present.');
    }
    if (payload.intelligence !== undefined && payload.intelligence !== null &&
        (typeof payload.intelligence !== 'object' || Array.isArray(payload.intelligence))) {
      fail(400, 'invalid_intelligence', 'intelligence must be an object or null when present.');
    }
    const b = payload.branching;
    if (b) {
      ['visibleSteps', 'visibleFields', 'skippedFields', 'staleClearedFields'].forEach(key => {
        if (b[key] !== undefined && !Array.isArray(b[key])) {
          fail(400, 'invalid_branching', `branching.${key} must be an array when present.`);
        }
      });
    }
  }

  /* Schema 5 declares which stage of the progressive review this submission
     completed. It is validated rather than trusted loosely, because the stage
     decides what the report is permitted to conclude — a Stage 1 report may
     never ask for the sale, and a forged stage would lift that ceiling.

     A schema-4 payload has no block and is treated as a full review, which is
     what it was. */
  if (schemaVersion >= 5) {
    const stageBlock = payload.assessmentStage;
    if (stageBlock !== undefined && stageBlock !== null) {
      if (typeof stageBlock !== 'object' || Array.isArray(stageBlock)) {
        fail(400, 'invalid_assessment_stage', 'assessmentStage must be an object when present.');
      }
      if (![1, 2].includes(stageBlock.stage)) {
        fail(400, 'invalid_assessment_stage', 'assessmentStage.stage must be 1 or 2.');
      }
      /* A Stage 1 submission has nothing before it, and a Stage 2 submission
         that names a predecessor must name a real submission id. Never the
         same id: two stages are two submissions, two idempotency keys, and
         two reports. */
      const supersedes = stageBlock.supersedesSubmissionId;
      if (supersedes !== undefined && supersedes !== null) {
        if (stageBlock.stage === 1) {
          fail(400, 'invalid_assessment_stage',
            'A Stage 1 submission must not supersede another submission.');
        }
        if (!isUuid(supersedes)) {
          fail(400, 'invalid_assessment_stage',
            'assessmentStage.supersedesSubmissionId must be a UUID.');
        }
        if (supersedes === payload.submissionId) {
          fail(400, 'invalid_assessment_stage',
            'A submission cannot supersede itself.');
        }
      }
      ['stage1CompletedAt', 'stage2StartedAt', 'stage2CompletedAt'].forEach(key => {
        const value = stageBlock[key];
        if (value !== undefined && value !== null && !isIso(value)) {
          fail(400, 'invalid_assessment_stage', `assessmentStage.${key} must be an ISO 8601 timestamp.`);
        }
      });
    }
  }

  /* Field sizes and structural bounds, before any database work. Identity
     values are rejected rather than truncated: a shortened identifier is a
     different identifier, and a different identifier links the wrong record. */
  const violations = checkPayloadLimits(payload);
  if (violations.length) {
    fail(422, 'payload_limit_exceeded',
      'One or more fields exceed the permitted size or shape.',
      { violations: violations.slice(0, 10) });
  }

  const prohibited = scanProhibited(payload);
  if (prohibited.length) {
    fail(422, 'prohibited_data', 'Payload contains prohibited data categories.', { fields: prohibited });
  }

  return { schemaVersion, timing, reviewType };
};

/* ---------- honeypot ----------
   The browser marks whether the trap was touched; the server decides what
   that means. The value itself is never transmitted and never stored — only
   the boolean — so the trap cannot become a data-exfiltration channel.

   Schema 2 predates the envelope and simply has no indicator. */
const honeypotTripped = payload => {
  const integrity = payload && payload.integrity;
  if (!integrity || typeof integrity !== 'object') return false;
  return integrity.honeypotFilled === true;
};

/* A challenge token is a short-lived credential. It is needed to verify the
   request and must never reach storage — the prohibited-data policy rejects
   it by name, and that is correct rather than inconvenient.

   It is therefore lifted out of the payload before validation, hashing, or
   any database call, and replaced with a boolean recording only that one was
   presented. Stripping is deterministic, so a replay of the identical body
   still hashes identically and is still recognised as a replay. */
const stripChallengeToken = payload => {
  const integrity = payload && payload.integrity;
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) return null;
  const token = typeof integrity.challengeToken === 'string' ? integrity.challengeToken : null;
  delete integrity.challengeToken;
  integrity.challengePresented = Boolean(token);
  return token;
};

/* ---------- timing helper ---------- */

/* An abort signal only helps if the transport honours it. A driver that
   ignores it — or a test double that never settles — would otherwise hang the
   function until the platform kills it, losing the chance to answer at all.
   So the signal is sent AND the promise is raced, and both timers are always
   cleared so a completed request never leaves the event loop pinned. */
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

/* ---------- database ---------- */

let cachedClient = null;
const getClient = async env => {
  if (cachedClient) return cachedClient;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    fail(503, 'not_configured', 'Assessment capture is not configured.', undefined, RETRY_AFTER.database);
  }
  const { createClient } = await import('@supabase/supabase-js');
  cachedClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return cachedClient;
};

/* supabase-js returns a thenable builder that accepts an abort signal;
   the in-memory test double returns a plain promise. Support both. */
const callRpc = (db, name, args, signal) => {
  const call = db.rpc(name, args);
  return (call && typeof call.abortSignal === 'function') ? call.abortSignal(signal) : call;
};

/* Maps a database error onto a client-safe status. Details never escape. */
const mapDbError = message => {
  const text = String(message || '');
  if (text.includes('idempotency_key_conflict')) {
    return [409, 'idempotency_key_conflict',
      'This Idempotency-Key was used with a different request body.', null];
  }
  if (text.includes('request_in_flight')) {
    return [409, 'request_in_flight',
      'A request with this Idempotency-Key is still being processed.', RETRY_AFTER.inFlight];
  }
  if (text.includes('missing_idempotency_key')) {
    return [400, 'missing_idempotency_key', 'Idempotency-Key is required.', null];
  }
  return [502, 'ingestion_failed', 'The assessment could not be stored. Please retry.', RETRY_AFTER.database];
};

/* ---------- handler ---------- */

export async function handleRequest(request, deps = {}) {
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const newId = deps.randomUUID || randomUUID;
  const correlationId = deps.correlationId || newId();
  const log = makeLogger(env, correlationId);
  const started = Date.now();
  let origin = null;

  try {
    origin = assertOrigin(request, env);
    const headers = corsHeaders(origin, env, correlationId);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST') {
      return json(405, errorBody('method_not_allowed', 'Only POST and OPTIONS are supported.',
        undefined, correlationId), { ...headers, Allow: 'POST, OPTIONS' });
    }

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return json(415, errorBody('unsupported_media_type', 'Content-Type must be application/json.',
        undefined, correlationId), headers);
    }

    const maxBytes = Number(env.CED_MAX_REQUEST_BYTES) > 0
      ? Number(env.CED_MAX_REQUEST_BYTES) : DEFAULT_MAX_BYTES;

    /* Bytes are counted as they arrive. Content-Length is a hint, not a
       promise, and an oversized body is never parsed. */
    const bodyResult = await readBoundedBody(request, maxBytes);
    if (bodyResult.outcome === BODY.tooLarge) {
      log('warn', 'request_rejected', { code: 'payload_too_large', bytesRead: bodyResult.bytesRead });
      return json(413, errorBody('payload_too_large', 'Request body exceeds the permitted size.',
        undefined, correlationId), headers);
    }
    if (bodyResult.outcome === BODY.invalidEncoding) {
      return json(400, errorBody('invalid_encoding', 'Request body is not valid UTF-8.',
        undefined, correlationId), headers);
    }
    if (bodyResult.outcome === BODY.readFailed) {
      return json(400, errorBody('body_read_failed', 'Request body could not be read.',
        undefined, correlationId), headers);
    }

    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey) {
      return json(400, errorBody('missing_idempotency_key', 'Idempotency-Key header is required.',
        undefined, correlationId), headers);
    }

    const parsed = parseJsonSafely(bodyResult.text);
    if (!parsed.ok) {
      return json(400, errorBody('malformed_json', 'Request body is not valid JSON.',
        undefined, correlationId), headers);
    }
    const payload = parsed.value;

    /* Before anything else touches the body: the challenge token is a
       credential and leaves the payload here, permanently. */
    const challengeToken = stripChallengeToken(payload) ||
      request.headers.get('x-ced-challenge');

    /* The continuation context is a bearer credential too.
       It arrives as a HEADER, so it never enters the payload — and therefore
       never enters the request hash, the stored submission, or the report.
       The body is still stripped, because a client that puts it there anyway
       must not have it stored; stripping also deletes any businessId a client
       tried to supply, refused rather than ignored so nobody can believe it
       was honoured. */
    const bodyContinuation = stripContinuationToken(payload);
    const continuationToken = request.headers.get('x-ced-continuation') || bodyContinuation;

    const { schemaVersion, timing, reviewType } = validatePayload(payload, idempotencyKey, now, env);

    /* Honeypot. Refused before any database work, and answered generically:
       the response says nothing about why, so a bot learns nothing about the
       trap it walked into. */
    if (honeypotTripped(payload)) {
      log('warn', 'honeypot_rejected', {
        submissionId: payload.submissionId, verticalId: payload.vertical.id
      });
      return json(200, {
        ok: true,
        replayed: false,
        submissionId: payload.submissionId,
        assessmentSessionId: payload.assessmentSessionId,
        receivedAt: new Date(now).toISOString(),
        nextAction: 'results_ready'
      }, headers);
    }

    const db = deps.db || await getClient(env);

    /* Rate limiting, before the challenge (which costs an external call) and
       before ingestion (which costs a transaction). Counted in Postgres under
       a keyed hash; no address is ever stored. */
    const policy = rateLimitPolicy(env);
    const keys = buildRateLimitKeys({
      headers: request.headers,
      sessionId: payload.assessmentSessionId,
      env,
      hmacFn: hmac
    });

    if (keys.length) {
      const limitResult = await callRpc(db, 'check_rate_limit', {
        p_keys: keys,
        p_window_seconds: policy.windowSeconds,
        p_max_requests: policy.maxRequests
      });
      const limitData = limitResult && limitResult.data;
      if (limitResult && limitResult.error) {
        /* A rate limiter that cannot answer must not take the endpoint down
           with it; the remaining layers still apply. */
        log('warn', 'rate_limit_unavailable', { reason: 'rpc_error' });
      } else if (limitData && limitData.allowed === false) {
        const retryAfter = Number(limitData.retryAfterSeconds) > 0
          ? Math.ceil(Number(limitData.retryAfterSeconds)) : RETRY_AFTER.rateLimited;
        log('warn', 'rate_limited', { scope: limitData.scope || null, retryAfter });
        return json(429, errorBody('rate_limited',
          'Too many submissions from this source. Please try again shortly.',
          undefined, correlationId, retryAfter), headers, retryAfter);
      }
    } else if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
      /* No secret configured means no rate limiting at all — visible, not silent. */
      log('error', 'rate_limit_not_configured', {});
    }

    /* Challenge verification. Exempted for submissions old enough to have
       come from the browser retry queue, whose token cannot be refreshed
       without UI work that is out of scope — see PRODUCTION_HARDENING.md. */
    const submissionAgeMs = now - timing.submittedAtMs;
    const challengeApplies = schemaVersion >= 3 && submissionAgeMs <= CHALLENGE_MAX_SUBMISSION_AGE_MS;

    if (challengeApplies) {
      const addressHash = keys.find(k => k.scope === 'address');
      const verdict = await verifyChallenge({
        token: challengeToken,
        remoteAddressHash: addressHash ? addressHash.key : null,
        expectedAction: env.CED_CHALLENGE_EXPECTED_ACTION || 'assessment_submit',
        env,
        fetchImpl: deps.fetchImpl,
        timeoutMs: Number(env.CED_CHALLENGE_TIMEOUT_MS) > 0
          ? Number(env.CED_CHALLENGE_TIMEOUT_MS) : DEFAULT_CHALLENGE_TIMEOUT_MS
      });

      if (verdict.status === CHALLENGE.rejected) {
        log('warn', 'challenge_rejected', { reason: verdict.reason });
        return json(403, errorBody('challenge_rejected',
          'The submission could not be verified as human.', undefined, correlationId), headers);
      }
      if (verdict.status === CHALLENGE.expired || verdict.status === CHALLENGE.malformed) {
        log('warn', 'challenge_invalid', { reason: verdict.reason, status: verdict.status });
        return json(400, errorBody('challenge_invalid',
          'The verification token is missing or no longer valid.',
          { challengeStatus: verdict.status }, correlationId), headers);
      }
      if (verdict.status === CHALLENGE.unavailable) {
        /* Fails closed. A provider outage must not become an open door, and
           the client keeps the assessment queued for a later retry. */
        log('error', 'challenge_unavailable', { reason: verdict.reason });
        return json(503, errorBody('challenge_unavailable',
          'Verification is temporarily unavailable. Please retry.',
          undefined, correlationId, RETRY_AFTER.challengeUnavailable),
        headers, RETRY_AFTER.challengeUnavailable);
      }
    }

    /* Deterministic: identical bodies under one key hash identically, so a
       genuine replay is recognised and a changed body is rejected. */
    const requestHash = sha256(`${idempotencyKey}\n${stableStringify(payload)}`);

    /* Context signals narrow a search but are never persisted as identity. */
    const signals = persistableSignals(extractIdentitySignals(payload));
    const birId = newId();
    const generatedAt = new Date(now).toISOString();

    /* ---------- connected reviews ----------

       The ONLY path by which a second review attaches to an existing
       Business Record without re-resolving identity, and it works because
       the server signed the context itself. A client-supplied businessId was
       already deleted by stripContinuationToken and is never consulted.

       Every failure mode falls through to ordinary identity resolution.
       Refusing the submission instead would punish a visitor whose token
       aged out for something they cannot see or fix. */
    const continuationSecret = env.CED_CONTINUATION_SECRET || null;
    const continuationVerdict = continuationToken
      ? verifyContinuationContext({
          token: continuationToken,
          secret: continuationSecret,
          hmacFn: hmac,
          nowMs: now,
          expectedVerticalId: payload.vertical.id
        })
      : { status: CONTINUATION.absent, businessId: null };

    if (continuationToken && continuationVerdict.status !== CONTINUATION.valid) {
      /* Logged as a fact, never echoed to the caller: telling a client which
         part of a signed token failed is telling it how to forge one. */
      log('warn', 'continuation_rejected', {
        submissionId: payload.submissionId,
        reviewType,
        reason: continuationVerdict.status
      });
    }

    const continuationBusinessId = continuationVerdict.status === CONTINUATION.valid
      ? continuationVerdict.businessId : null;

    const reviewEntry = entryFor(reviewType);

    let bir;
    try {
      bir = reviewEntry.generate({
        submission: payload,
        birId,
        /* Still null here. The database injects the resolved id inside the
           ingestion transaction, because that is the only place identity is
           actually decided. */
        businessId: null,
        identityStatus: 'resolution_pending',
        generatedAt,
        hashFn: sha256
      });
    } catch (err) {
      log('error', 'bir_generation_threw', {
        submissionId: payload.submissionId, reviewType, name: err && err.name
      });
      return json(500, errorBody('bir_generation_failed', 'The review could not be processed.',
        undefined, correlationId), headers);
    }

    const birCheck = reviewEntry.validate(bir);
    if (!birCheck.valid) {
      log('error', 'bir_generation_invalid', {
        submissionId: payload.submissionId,
        reviewType,
        errorCodes: birCheck.errors.map(e => e.code)
      });
      return json(500, errorBody('bir_generation_failed', 'The review could not be processed.',
        undefined, correlationId), headers);
    }

    /* Audit-safe timing metadata. Carries what the visitor's device claimed
       and what the timeline actually recorded, so a clamped timestamp is
       explainable years later. No contact data, no answers. */
    const meta = {
      correlationId,
      receivedAt: generatedAt,
      payloadSchemaVersion: schemaVersion,
      reviewType,
      originalSubmittedAt: timing.submittedAt,
      timelineOccurredAt: timing.timelineOccurredAt,
      clockSkewDetected: timing.clockSkewDetected,
      clockSkewMs: timing.clockSkewMs,
      timelineTimestampClamped: timing.clamped,
      /* The outcome, never the token. Recorded so a link that did not happen
         is explainable years later without holding the credential.

         `continuationOffered` is what this endpoint proposed. Whether it was
         APPLIED is the database's decision — rule B0 may set a valid context
         aside — and is recorded by the ingestion function itself. */
      continuationStatus: continuationVerdict.status,
      continuationOffered: Boolean(continuationBusinessId)
    };

    if (timing.clockSkewDetected) {
      log('info', 'clock_skew_detected', {
        submissionId: payload.submissionId, clockSkewMs: timing.clockSkewMs
      });
    }

    const dbTimeout = Number(env.CED_DB_TIMEOUT_MS) > 0
      ? Number(env.CED_DB_TIMEOUT_MS) : DEFAULT_DB_TIMEOUT_MS;

    /* Growth keeps calling ingest_assessment with its original signature, so
       a queued submission built before this deploy, the existing tests, and
       any external caller are untouched. Migration 0006 makes that function a
       thin wrapper over ingest_review, so both paths run one body. */
    const rpcName = reviewType === DEFAULT_REVIEW_TYPE ? 'ingest_assessment' : 'ingest_review';
    const rpcArgs = {
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash,
      p_payload: payload,
      p_signals: signals,
      p_bir: bir,
      p_bir_id: birId,
      p_retention_days: Number(env.CED_IDEMPOTENCY_RETENTION_DAYS) > 0
        ? Number(env.CED_IDEMPOTENCY_RETENTION_DAYS) : 30,
      p_meta: meta
    };
    if (rpcName === 'ingest_review') {
      rpcArgs.p_review_type = reviewType;
      /* Server-decided, or null. This is the whole of the continuation
         mechanism as the database sees it: an id we signed ourselves. */
      rpcArgs.p_continuation_business_id = continuationBusinessId;
    }

    const ingestion = await runWithTimeout(signal =>
      callRpc(db, rpcName, rpcArgs, signal), dbTimeout, 'ingest');

    if (ingestion && ingestion.__timedOut) {
      /* The transaction may still commit after we stop waiting. That is safe:
         the retry carries the same Idempotency-Key and collapses into a replay. */
      log('error', 'ingestion_timeout', { submissionId: payload.submissionId, timeoutMs: dbTimeout });
      return json(504, errorBody('ingestion_timeout',
        'Storing the assessment took too long. Please retry.',
        undefined, correlationId, RETRY_AFTER.database), headers, RETRY_AFTER.database);
    }

    const { data, error } = ingestion || {};

    if (error) {
      const [status, code, message, retryAfter] = mapDbError(error.message);
      log(status >= 500 ? 'error' : 'warn', 'ingestion_error', {
        submissionId: payload.submissionId, code, status,
        /* Full detail server-side only; never in the response. */
        dbMessage: error.message
      });
      return json(status, errorBody(code, message, undefined, correlationId, retryAfter),
        headers, retryAfter);
    }
    if (!data || typeof data !== 'object') {
      log('error', 'ingestion_empty_result', { submissionId: payload.submissionId });
      return json(502, errorBody('ingestion_failed', 'The assessment could not be stored. Please retry.',
        undefined, correlationId, RETRY_AFTER.database), headers, RETRY_AFTER.database);
    }

    log('info', 'assessment_ingested', {
      submissionId: data.submissionId,
      assessmentSessionId: data.assessmentSessionId,
      businessId: data.businessId,
      birId: data.birId,
      identityStatus: data.identityStatus,
      reviewType,
      replayed: data.replayed === true,
      verticalId: payload.vertical.id,
      payloadSchemaVersion: schemaVersion,
      clockSkewDetected: timing.clockSkewDetected,
      /* What the endpoint OFFERED, and what the database DID with it.

         `continuationApplied` is read from the LINK METHOD the database
         returned, which is the only place the answer exists. It used to be
         derived here as "offered, and that one proposal was not
         contradicted", and that is a different question: under rule B0b an
         uncontradicted context is still set aside when the session
         contradicts, and when two surviving proposals name different
         records. Both cases logged `true` while the stored submission said
         `continuationApplied: false` — the log claimed to report the
         database's decision and reported the endpoint's assumption instead.

         Anything that needs to know whether the context was used reads this
         one fact: `linkMethod === 'continuation_context'`. */
      continuationOffered: Boolean(continuationBusinessId),
      continuationApplied: data.linkMethod === 'continuation_context',
      linkMethod: data.linkMethod ?? null,
      timelineEvents: Array.isArray(data.timelineEventIds) ? data.timelineEventIds.length : 0,
      durationMs: Date.now() - started
    });

    /* A saved proposal — a signed context, or the assessment session — that
       named a record the submitted identity contradicts. Logged as a fact,
       never echoed to the caller, and never with a value or a business id. A
       client that learns WHICH evidence differed learns what the record
       holds, which is precisely what a borrowed pointer must not reveal. */
    if (data.continuationContradicted === true || data.sessionContradicted === true ||
        data.proposalsDisagreed === true) {
      log('warn', 'identity_proposal_set_aside', {
        submissionId: data.submissionId,
        reviewType,
        identityStatus: data.identityStatus,
        continuationContradicted: data.continuationContradicted === true,
        sessionContradicted: data.sessionContradicted === true,
        proposalsDisagreed: data.proposalsDisagreed === true,
        verticalId: payload.vertical.id
      });
    }

    /* A fresh context for whatever the visitor does next. Minted only when
       identity is actually resolved — a token pointing at null would be a
       capability to link nothing — and only from an id the database returned,
       never from anything the client sent. */
    const nextContext = data.businessId
      ? issueContinuationContext({
          businessId: data.businessId,
          verticalId: payload.vertical.id,
          reviewType,
          issuedAtMs: now,
          secret: continuationSecret,
          hmacFn: hmac
        })
      : null;

    /* ---------- what the browser is told ----------

       GROWTH keeps its existing contract, businessId included. The engine
       stores it beside the saved state so a later reassessment from this
       browser is recognised, and analytics joins a funnel row to a record
       with it. That is a published contract with a shipped page and is not
       changed here.

       SERVICE MIX gets an ALLOWLIST, and businessId is not on it. A permanent
       Business Record identifier in a browser is a permanent identifier in
       every analytics event that browser then emits, and the whole point of
       the continuation context is that the client never needs one: it holds
       an opaque, expiring, signed string instead. Nothing else the client
       does requires knowing which record it attached to. */
    const body = reviewType === DEFAULT_REVIEW_TYPE
      ? { ...data, reviewType, correlationId }
      : {
          ok: data.ok === true,
          replayed: data.replayed === true,
          /* The client's own idempotency key, echoed back. */
          submissionId: data.submissionId,
          assessmentSessionId: data.assessmentSessionId,
          reviewType,
          /* Whether identity is settled or a person must look. The client
             shows different words; it never learns WHICH record. */
          identityResolved: data.identityStatus === 'linked' ||
                            data.identityStatus === 'manually_verified',
          nextAction: data.nextAction,
          receivedAt: data.receivedAt,
          correlationId
        };

    if (nextContext) body.continuationToken = nextContext;

    return json(data.replayed === true ? 200 : 201, body, headers);

  } catch (err) {
    const headers = corsHeaders(origin, env, correlationId);
    if (err instanceof ValidationError) {
      log('warn', 'request_rejected', { code: err.code, status: err.status });
      return json(err.status,
        errorBody(err.code, err.message, err.details, correlationId, err.retryAfterSeconds),
        headers, err.retryAfterSeconds);
    }
    /* Nothing internal escapes to the client: no stack, no SQL, no
       credentials. Everything is retained server-side under the correlation
       id, because an error we cannot diagnose is an error we cannot fix. */
    log('error', 'unhandled_error', {
      name: err && err.name,
      message: err && err.message,
      stack: err && err.stack
    });
    return json(500, errorBody('internal_error', 'The request could not be completed.',
      undefined, correlationId), headers);
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

/* Exported for tests and documentation generation. */
export const VERSIONS = {
  CURRENT_PAYLOAD_SCHEMA,
  SUPPORTED_PAYLOAD_SCHEMAS,
  MIN_KNOWN_PAYLOAD_SCHEMA,
  PAYLOAD_SCHEMAS_BY_REVIEW,
  CURRENT_PAYLOAD_SCHEMA_BY_REVIEW,
  REQUIRED_SECTIONS_BY_REVIEW,
  REVIEW_TYPES
};
export const TIMEOUTS = {
  DEFAULT_CHALLENGE_TIMEOUT_MS,
  DEFAULT_DB_TIMEOUT_MS,
  CHALLENGE_MAX_SUBMISSION_AGE_MS
};
