/* ============================================================
   CED Intelligence Platform — analytics event contract
   ------------------------------------------------------------
   The single definition of what an analytics event IS: its name,
   its category, its shape, and — more importantly — what it may
   never carry.

   Read by the browser client that emits events and by
   api/analytics.mjs that accepts them. One definition, because a
   browser and a server that disagree about what counts as
   personal data will disagree in the direction that stores it.

   ------------------------------------------------------------
   THIS FILE IS A PRIVACY BOUNDARY, NOT A SCHEMA

   Analytics answers "where do people stop?". It does not answer
   "who are they?" and must never be able to. Every rule below
   exists so that a future contributor adding a field cannot
   quietly turn a funnel into a contact list:

     · Field names are matched against PROHIBITED_FIELD_PATTERN
       and dropped, on both sides of the wire.
     · Answer VALUES are dropped unless the question id appears
       in SAFE_VALUE_ALLOWLIST, which is deliberately tiny.
     · A value may not be recorded even when allowlisted if its
       field name looks personal. The allowlist can widen what is
       kept; it can never override the prohibition.
     · URLs are reduced to path plus allowlisted UTM keys.
       Referrers are reduced to a host.
     · No user agent string is stored. Device class is derived
       from viewport and input capability, which is coarse enough
       to be useful and too coarse to fingerprint.

   NOTHING HERE MAY WRITE TO THE BUSINESS RECORD, THE BIR, THE
   PACKAGE RECOMMENDATION, OR CLOSE READINESS. Analytics observes
   the assessment; it never participates in it.

   ------------------------------------------------------------
   LEGAL REVIEW PENDING

   The consent model below is an engineering mechanism, not a
   legal position. No claim of compliance with any law or
   regulation is made anywhere in this repository. See
   docs/ANALYTICS_PRIVACY.md, which marks the open questions for
   professional review.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  /* Structural version of the event envelope. Bump when a field is added or
     its meaning changes; the endpoint accepts a range so a page cached before
     a deploy is not punished for it. */
  const ANALYTICS_SCHEMA_VERSION = 1;
  const SUPPORTED_SCHEMA_VERSIONS = [1];

  /* ---------- consent categories ----------

     The distinction that matters, stated plainly:

     · functional — the platform cannot do what the visitor asked without it.
       Saving their progress is functional. NOTHING in this file is functional;
       an assessment works perfectly with analytics switched off entirely.

     · product    — first-party, pseudonymous observation of our own product,
       used to find where people get stuck. Never shared, never sold, never
       joined to an advertising identifier. Almost everything here is product.

     · marketing  — attributing a visitor to a campaign in order to target
       them, or sending anything to an advertising platform. NOT BUILT, and
       the campaign fields carried here are for OUR reporting only.

     Each event declares its category; the client drops any event whose
     category exceeds the current permission. */
  const CATEGORY = {
    functional: 'functional',
    product: 'product',
    marketing: 'marketing'
  };

  /* Ordered from least to most permissive. */
  const CONSENT_STATUS = ['denied', 'functional_only', 'product_allowed', 'marketing_allowed'];

  const CATEGORY_REQUIRES = {
    functional: 'functional_only',
    product: 'product_allowed',
    marketing: 'marketing_allowed'
  };

  const categoryPermitted = (category, status) => {
    const have = CONSENT_STATUS.indexOf(status);
    const need = CONSENT_STATUS.indexOf(CATEGORY_REQUIRES[category] || 'marketing_allowed');
    if (have < 0 || need < 0) return false;
    return have >= need;
  };

  /* ---------- the catalog ----------
     Names are a wire contract. Renaming one orphans every historical row,
     because the raw event table is append-only and cannot be rewritten. */

  const EVENTS = {
    /* Reaching the page at all. The denominator of everything. */
    'assessment.page_viewed':               { category: CATEGORY.product, version: 1, once: 'session' },
    'assessment.started':                   { category: CATEGORY.product, version: 1, once: 'session' },
    'assessment.resumed':                   { category: CATEGORY.product, version: 1 },

    /* Movement through the questions. */
    'assessment.step_viewed':               { category: CATEGORY.product, version: 1, requires: ['stepId'] },
    'assessment.question_answered':         { category: CATEGORY.product, version: 1, requires: ['questionId'] },
    'assessment.validation_failed':         { category: CATEGORY.product, version: 1, requires: ['stepId'] },
    'assessment.step_completed':            { category: CATEGORY.product, version: 1, requires: ['stepId'] },

    /* Stage boundaries — the measurements this milestone exists for. */
    'assessment.stage1_completed':          { category: CATEGORY.product, version: 1, once: 'session' },
    'assessment.preliminary_results_viewed':{ category: CATEGORY.product, version: 1 },
    'assessment.stage2_started':            { category: CATEGORY.product, version: 1, once: 'session' },
    'assessment.stage2_completed':          { category: CATEGORY.product, version: 1, once: 'session' },
    'assessment.full_results_viewed':       { category: CATEGORY.product, version: 1 },

    /* Inferred, never observed. See docs/ASSESSMENT_ANALYTICS.md. */
    'assessment.abandoned':                 { category: CATEGORY.product, version: 1 },

    /* Intent. What the visitor chose to do with their results. */
    'assessment.personal_review_clicked':   { category: CATEGORY.product, version: 1 },
    'assessment.recommended_system_clicked':{ category: CATEGORY.product, version: 1 },
    'assessment.improve_recommendation_clicked': { category: CATEGORY.product, version: 1 },
    'assessment.checkout_intent':           { category: CATEGORY.product, version: 1 },
    'assessment.report_requested':          { category: CATEGORY.product, version: 1 },

    /* The visitor erasing what we stored on their device. Recorded because a
       deletion nobody can see is a deletion nobody can audit. */
    'assessment.clear_saved_data':          { category: CATEGORY.functional, version: 1 }
  };

  const EVENT_NAMES = Object.keys(EVENTS);

  /* Events that must never be emitted twice for the same session, whatever the
     client does. Enforced client-side by suppression and server-side by the
     event_id primary key plus a session-scoped uniqueness rule. */
  const ONCE_PER_SESSION = EVENT_NAMES.filter(name => EVENTS[name].once === 'session');

  /* ---------- what may never travel ----------

     Matched against FIELD NAMES anywhere in an event, at any depth, on both
     sides of the wire. A match is dropped rather than rejected, because losing
     one analytics field must never cost the whole batch — but the endpoint
     also refuses a batch whose top level is shaped like a contact record, so
     a deliberate attempt is visible rather than silently trimmed.

     Matched on TOKENS, not on substrings. A substring test looks simpler and
     is wrong in both directions: `capacity90Day` contains "city" and would be
     refused, while a field could be named to slip past a naive pattern. Field
     names here are camelCase or snake_case, so splitting them into words and
     comparing whole words is both stricter and more accurate. */
  const PROHIBITED_TOKENS = new Set([
    /* who someone is */
    'name', 'owner', 'salon', 'contact', 'person', 'customer', 'client',
    /* how to reach them */
    'email', 'mail', 'phone', 'mobile', 'tel', 'fax',
    'address', 'street', 'city', 'zip', 'postcode', 'postal', 'region',
    'website', 'url', 'href', 'link', 'profile', 'handle',
    /* what they wrote */
    'statement', 'detail', 'comment', 'note', 'text', 'freetext', 'message', 'reason',
    /* credentials and secrets */
    'token', 'secret', 'password', 'passwd', 'pwd', 'credential', 'apikey', 'auth',
    /* the browser itself. High entropy, fingerprints, answers nothing we ask. */
    'useragent', 'agent', 'ua',
    /* regulated categories */
    'ssn', 'dob', 'birth', 'nin', 'passport',
    'payment', 'card', 'cardholder', 'iban', 'routing', 'account', 'cvv', 'cvc',
    'diagnosis', 'medication', 'prescription', 'patient', 'health', 'symptom'
  ]);

  /* Splits an identifier into lowercase words. Handles camelCase, snake_case,
     kebab-case, embedded digits, and acronym runs:
       ownerName    → owner, name
       capacity90Day→ capacity, 90, day
       utm_source   → utm, source
       SSN          → ssn                                                    */
  const tokenize = key =>
    String(key || '').match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?
      String(key).match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g).map(t => t.toLowerCase()) : [];

  /* Deliberate exceptions: field names whose tokens are prohibited but which
     are structural rather than personal. Each is here because it was checked,
     not because it was convenient. A growing list is a sign the token set is
     wrong, not that the exception is justified. */
  const PROHIBITED_PATTERN_EXCEPTIONS = new Set([
    'eventName',        /* the event's own name */
    'stepName',         /* a step's static heading id, never visitor content */
    'verticalName'      /* "Nail Salons" — a constant of the product */
  ]);

  /* ---------- answer values ----------

     Default: an answer's VALUE never travels. `question_answered` records that
     a question was answered, which question, and how long it took — never what
     was said.

     The allowlist exists because drop-off analysis is much weaker without
     knowing which BRANCH a visitor was on: "40% abandon at step 11" means one
     thing for single-site salons and another for multi-site ones. Both entries
     below are coarse buckets that determine a branch and carry no commercial
     sensitivity.

     Everything else in the intelligence contract is prohibited outright as a
     field NAME, a few lines down — `questionId: "budgetSignal"` stays legal
     because it names a question, while `metadata: { budgetSignal: ... }` does
     not, because that is the answer. */
  const SAFE_VALUE_ALLOWLIST = new Set([
    'locationCount',   /* 1 / 2 / 3 / 5 — decides the multi-location branch */
    'capacity90Day'    /* five bands plus unsure — decides the clamp path */
  ]);

  /* Every intelligence field EXCEPT the two the value allowlist names. Read
     from the shared contract when it is available so a new close-related
     question is excluded from analytics the moment it is added, with a
     fallback list for a page that does not load intelligence.js. A test
     asserts the fallback and the contract agree. */
  const CLOSE_RELATED_FALLBACK = [
    'yearsInBusiness', 'businessPhone', 'website', 'googleProfile',
    'bookingPlatform', 'bookingPlatformStaying', 'staffingExpandable',
    'hoursExpandable', 'spaceConstraint', 'willingnessToExpand', 'capacityLeadTime',
    'respondentRole', 'canApprove', 'otherApprovers', 'decisionTiming',
    'startTiming', 'urgency', 'changeReason', 'budgetSignal', 'phoneSetup',
    'keepNumber', 'willingToChangeSoftware', 'multiLocationSystems',
    'customIntegrationNeeded', 'migrationConcern', 'primaryConcern',
    'concernDetail', 'priorBadExperience', 'openQuestions'
  ];

  const closeRelatedFieldNames = () => {
    let contract = null;
    try {
      contract = (typeof module !== 'undefined' && module.exports)
        ? require('../assessment-engine/intelligence.js')
        : (typeof window !== 'undefined' ? window.CEDIntelligence : null);
    } catch {
      contract = null;
    }
    const all = contract && Array.isArray(contract.ALL_FIELDS)
      ? contract.ALL_FIELDS : CLOSE_RELATED_FALLBACK;
    return all.filter(field => !SAFE_VALUE_ALLOWLIST.has(field));
  };

  /* Fields no token rule can recognise, named outright.

     `openQuestions` is the assessment's "Any questions you want answered?"
     box. It tokenizes to open + questions, and "question" cannot be a
     prohibited token because questionId, questionSetVersion and
     visibleQuestionCount are all legitimate. A free-text field whose name
     happens to read as structural is exactly the case a pattern misses, so
     it is listed instead.

     The authority for which assessment fields are free text is
     shared/security/limits.js :: FREE_TEXT_ANSWERS. A test asserts the two
     do not drift.

     Real-Postgres validation on 2026-08-05 found six more names the token rule
     let through that ANALYTICS_PRIVACY.md's own policy says are excluded. They
     are listed rather than solved by widening a token, because widening
     `referrer` would refuse the legitimate `referrerHost` and widening `path`
     would refuse the legitimate attribution `path`. */
  const PROHIBITED_FIELD_NAMES = new Set([
    'openQuestions',
    'changeReason',    /* also caught by "reason"; listed so it survives a token edit */
    'concernDetail',   /* also caught by "detail" */

    /* A referrer HOST is allowed and a referrer PATH is not: the path names
       the message or page someone clicked from. `referrerHost` must keep
       working, so the prohibition is on the specific name. */
    'referrerPath', 'referrer_path', 'referrerUrl', 'referrerFull',

    /* Close-related evidence. ANALYTICS_PRIVACY.md says these live in the
       Business Record under its consent and retention rules and never in a
       funnel; before this fix nothing enforced it. Derived from the shared
       intelligence contract below so the two cannot drift. */
    ...closeRelatedFieldNames()
  ]);

  const isProhibitedFieldName = key => {
    if (PROHIBITED_PATTERN_EXCEPTIONS.has(key)) return false;
    if (PROHIBITED_FIELD_NAMES.has(key)) return true;
    return tokenize(key).some(token =>
      PROHIBITED_TOKENS.has(token) ||
      /* Simple plural: "notes", "details", "emails". */
      (token.length > 3 && token.endsWith('s') && PROHIBITED_TOKENS.has(token.slice(0, -1))));
  };

  /* Retained for documentation and for anything that wants a quick regex view
     of the same rule. isProhibitedFieldName is the authority. */
  const PROHIBITED_FIELD_PATTERN =
    new RegExp(`\\b(${[...PROHIBITED_TOKENS].join('|')})s?\\b`, 'i');

  /* A value may be recorded only when the allowlist names it AND the field
     name is not itself prohibited. The allowlist widens what is kept; it can
     never override the prohibition. */
  const mayRecordValue = questionId =>
    SAFE_VALUE_ALLOWLIST.has(questionId) && !isProhibitedFieldName(questionId);

  /* ---------- device class ----------
     Derived from viewport and input capability. The user agent string is NOT
     stored: it is high-entropy, it fingerprints, and it answers no question
     this platform is asking. */

  const DEVICE_CLASSES = ['phone', 'tablet', 'desktop', 'unknown'];

  const classifyDevice = ({ width, height, coarsePointer } = {}) => {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || w <= 0) return 'unknown';
    if (w < 600) return 'phone';
    if (w < 1024) return coarsePointer === false ? 'desktop' : 'tablet';
    /* A large viewport with a coarse pointer is a tablet in landscape far more
       often than it is a touchscreen desktop. */
    return coarsePointer === true && Number.isFinite(h) && h < 900 ? 'tablet' : 'desktop';
  };

  /* Viewport is rounded into buckets. An exact pixel pair is a surprisingly
     strong fingerprint; a 40px bucket answers "did the layout break on small
     screens?" just as well. */
  const bucketViewport = value => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n / 40) * 40;
  };

  /* ---------- attribution ----------
     Campaign reporting needs the campaign, not the URL. A full URL can carry
     a session token, an email address, or a one-time link in its query string,
     and none of that belongs in an analytics row. */

  const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  const MAX_UTM_LENGTH = 120;

  const trimTo = (value, max) =>
    typeof value === 'string' ? value.slice(0, max) : null;

  const hostOf = value => {
    if (typeof value !== 'string' || !value) return null;
    try {
      return new URL(value).host || null;
    } catch {
      return null;
    }
  };

  const pathOf = value => {
    if (typeof value !== 'string' || !value) return null;
    try {
      return new URL(value).pathname || '/';
    } catch {
      return null;
    }
  };

  /* Reduces one attribution touch to what reporting actually needs. Everything
     else — the query string, the fragment, any credentials in the URL — is
     discarded here and never reaches the client's queue, let alone the wire. */
  const sanitizeTouch = touch => {
    if (!touch || typeof touch !== 'object') return null;
    const utm = {};
    const source = touch.utm && typeof touch.utm === 'object' ? touch.utm : {};
    UTM_KEYS.forEach(key => {
      const value = source[key];
      if (typeof value === 'string' && value) utm[key] = trimTo(value, MAX_UTM_LENGTH);
    });
    return {
      path: pathOf(touch.url),
      referrerHost: hostOf(touch.referrer),
      utm,
      occurredAt: typeof touch.occurredAt === 'string' ? touch.occurredAt : null
    };
  };

  const sanitizeAttribution = attribution => {
    if (!attribution || typeof attribution !== 'object') return { firstTouch: null, latestTouch: null };
    return {
      firstTouch: sanitizeTouch(attribution.firstTouch),
      latestTouch: sanitizeTouch(attribution.latestTouch)
    };
  };

  /* ---------- scrubbing ----------
     Applied to metadata and to any nested object before an event is queued,
     and applied AGAIN by the endpoint. Twice on purpose: the browser copy can
     be tampered with, and the server must not trust it. */

  const MAX_DEPTH = 6;
  const MAX_KEYS = 40;
  const MAX_STRING = 200;

  const scrub = (value, depth = 0, dropped = []) => {
    if (depth > MAX_DEPTH) return { value: null, dropped };
    if (value === null || value === undefined) return { value: null, dropped };
    if (typeof value === 'number') return { value: Number.isFinite(value) ? value : null, dropped };
    if (typeof value === 'boolean') return { value, dropped };
    if (typeof value === 'string') return { value: value.slice(0, MAX_STRING), dropped };
    if (Array.isArray(value)) {
      return { value: value.slice(0, MAX_KEYS).map(v => scrub(v, depth + 1, dropped).value), dropped };
    }
    if (typeof value !== 'object') return { value: null, dropped };

    const out = {};
    Object.keys(value).slice(0, MAX_KEYS).forEach(key => {
      if (isProhibitedFieldName(key)) {
        dropped.push(key);
        return;
      }
      out[key] = scrub(value[key], depth + 1, dropped).value;
    });
    return { value: out, dropped };
  };

  const scrubMetadata = metadata => {
    const result = scrub(metadata && typeof metadata === 'object' ? metadata : {}, 0, []);
    return { metadata: result.value || {}, droppedFields: result.dropped };
  };

  /* ---------- validation ---------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);
  const isIso = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

  const LIMITS = {
    maxEventsPerBatch: 50,
    maxIdLength: 64,
    maxStepIdLength: 64,
    maxQuestionIdLength: 64,
    /* Twelve hours of active time is already implausible; this is a sanity
       rail, not a measurement. */
    maxElapsedMs: 12 * 60 * 60 * 1000
  };

  const nonNegative = value =>
    value === null || value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= LIMITS.maxElapsedMs);

  /* Returns every problem rather than the first, so a client author sees the
     whole picture in one response. */
  const validateEvent = event => {
    const errors = [];
    const fail = (code, message) => errors.push({ code, message });

    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'An event must be an object.' }] };
    }

    if (!isUuid(event.eventId)) fail('invalid_event_id', 'eventId must be a UUID.');

    const definition = EVENTS[event.eventName];
    if (!definition) {
      fail('unknown_event', `Unknown event name: ${String(event.eventName).slice(0, 64)}`);
    } else if (event.eventVersion !== definition.version) {
      fail('event_version_mismatch',
        `${event.eventName} is version ${definition.version}.`);
    }

    if (!isIso(event.occurredAt)) fail('invalid_occurred_at', 'occurredAt must be ISO 8601.');
    if (!isUuid(event.assessmentSessionId)) {
      fail('invalid_session_id', 'assessmentSessionId must be a UUID.');
    }
    if (event.submissionId !== null && event.submissionId !== undefined && !isUuid(event.submissionId)) {
      fail('invalid_submission_id', 'submissionId must be a UUID when present.');
    }
    if (event.businessId !== null && event.businessId !== undefined && !isUuid(event.businessId)) {
      fail('invalid_business_id', 'businessId must be a UUID when present.');
    }
    if (typeof event.verticalId !== 'string' || !event.verticalId) {
      fail('invalid_vertical', 'verticalId is required.');
    }
    if (event.assessmentStage !== null && event.assessmentStage !== undefined &&
        ![1, 2].includes(event.assessmentStage)) {
      fail('invalid_stage', 'assessmentStage must be 1, 2, or null.');
    }
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(event.schemaVersion)) {
      fail('unsupported_schema', `Unsupported analytics schemaVersion: ${event.schemaVersion}`);
    }

    (definition ? definition.requires || [] : []).forEach(field => {
      if (event[field] === null || event[field] === undefined || event[field] === '') {
        fail('missing_required_field', `${event.eventName} requires ${field}.`);
      }
    });

    ['activeElapsedMs', 'totalElapsedMs', 'stepElapsedMs'].forEach(field => {
      if (!nonNegative(event[field])) {
        fail('invalid_timing', `${field} must be a non-negative number within the permitted range.`);
      }
    });

    /* The check that matters most: nothing shaped like personal data, at any
       depth, anywhere in the event. */
    const offenders = [];
    const walk = (value, depth) => {
      if (depth > MAX_DEPTH || !value || typeof value !== 'object') return;
      Object.keys(value).forEach(key => {
        if (isProhibitedFieldName(key)) offenders.push(key);
        walk(value[key], depth + 1);
      });
    };
    walk(event, 0);
    if (offenders.length) {
      fail('prohibited_field',
        `Prohibited field name(s) in analytics event: ${[...new Set(offenders)].slice(0, 5).join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
  };

  const API = {
    ANALYTICS_SCHEMA_VERSION,
    SUPPORTED_SCHEMA_VERSIONS,
    CATEGORY,
    CONSENT_STATUS,
    CATEGORY_REQUIRES,
    categoryPermitted,
    EVENTS,
    EVENT_NAMES,
    ONCE_PER_SESSION,
    PROHIBITED_FIELD_PATTERN,
    PROHIBITED_TOKENS,
    PROHIBITED_FIELD_NAMES,
    PROHIBITED_PATTERN_EXCEPTIONS,
    tokenize,
    isProhibitedFieldName,
    SAFE_VALUE_ALLOWLIST,
    mayRecordValue,
    DEVICE_CLASSES,
    classifyDevice,
    bucketViewport,
    UTM_KEYS,
    sanitizeTouch,
    sanitizeAttribution,
    scrubMetadata,
    LIMITS,
    isUuid,
    isIso,
    validateEvent
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.CEDAnalyticsEvents = API;
})();
