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
  /* 2 adds `reviewType` to the envelope. 1 stays accepted: a page cached
     before the Service Mix deploy still emits valid events, and an event with
     no declared review type is a Growth Review event, which is what it is. */
  const ANALYTICS_SCHEMA_VERSION = 2;
  const SUPPORTED_SCHEMA_VERSIONS = [1, 2];

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
    'assessment.clear_saved_data':          { category: CATEGORY.functional, version: 1 },

    /* ---------- Quick Service Mix Review (SM-1) ----------

       New names, never repurposed ones. The raw event table is append-only,
       so renaming an existing event orphans its history rather than
       migrating it — a second review type therefore gets its own names.

       Movement through the questions is NOT duplicated here:
       assessment.step_viewed and friends carry `reviewType` and are the
       shared mechanism. Separating the funnels is a GROUP BY, not a second
       set of names to keep in step. */
    'service_mix.review_viewed':            { category: CATEGORY.product, version: 1, once: 'session' },
    'service_mix.review_started':           { category: CATEGORY.product, version: 1, once: 'session' },
    'service_mix.offering_added':           { category: CATEGORY.product, version: 1 },
    /* Removed BEFORE submission. An offering added and deleted in one sitting
       never happened, and this is the only trace it leaves anywhere. */
    'service_mix.offering_removed':         { category: CATEGORY.product, version: 1 },
    'service_mix.stage1_completed':         { category: CATEGORY.product, version: 1, once: 'session' },
    'service_mix.results_viewed':           { category: CATEGORY.product, version: 1 },
    'service_mix.pricing_detail_requested': { category: CATEGORY.product, version: 1 },
    'service_mix.bundle_recommendation_viewed': { category: CATEGORY.product, version: 1 },
    'service_mix.growth_review_clicked':    { category: CATEGORY.product, version: 1 },
    'service_mix.ai_analysis_clicked':      { category: CATEGORY.product, version: 1 },
    /* The visitor said the review they are continuing from is not theirs, or
       typed over an identity-bearing prefilled field, and the borrowed
       context was dropped. Worth counting: how often one device carries two
       businesses is the whole reason rule B0 exists. */
    'service_mix.continuation_rejected':    { category: CATEGORY.product, version: 1 }
  };

  const EVENT_NAMES = Object.keys(EVENTS);

  /* ---------- review types ----------

     Mirrors shared/business-intelligence/review-registry.js :: REVIEW_TYPES.
     Restated rather than imported because this file must keep working on a
     page that loads analytics and nothing else; a test asserts the two lists
     stay identical.

     An event with no declared review type is a Growth Review event. Any other
     default would retroactively relabel every row already written. */
  const REVIEW_TYPES = ['growth_review', 'service_mix'];
  const DEFAULT_REVIEW_TYPE = 'growth_review';

  /* Which review type an event name belongs to, when the name settles it.
     Everything else takes the review type from the emitting page. */
  const reviewTypeOfEvent = eventName =>
    (typeof eventName === 'string' && eventName.startsWith('service_mix.'))
      ? 'service_mix' : null;

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
    'diagnosis', 'medication', 'prescription', 'patient', 'health', 'symptom',
    /* Commercial figures from the Quick Service Mix Review. What a business
       charges, how long it takes, how many it sells, and what that earns are
       the substance of the review — they belong in the Business Record under
       its consent and retention rules, and nowhere near a funnel.

       `hours` and `minutes` are here because capacityHours and
       durationMinutes are the same fact wearing a unit. */
    'price', 'pricing', 'cost', 'revenue', 'volume', 'duration',
    'margin', 'contribution', 'ticket', 'hours', 'minutes', 'earnings'
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
    ...closeRelatedFieldNames(),

    /* ---- Quick Service Mix Review ----

       Offering identity is named outright because no token rule can catch it
       without breaking the metadata that IS allowed. `offering` cannot be a
       prohibited token: offeringCountBand and offeringSource are exactly what
       analytics is permitted to know about an offering, and prohibiting the
       word would refuse them along with the identifiers.

       A stable offeringId is excluded even though it is opaque. It is stable
       across submissions by design, which makes it a join key between a
       funnel and a Business Record — and the absence of any such key is what
       keeps the two apart. */
    'offeringId', 'offeringSnapshotId', 'replacesOfferingId',
    'offeringName', 'offeringLabel', 'offerings',
    /* Named as well as tokenised, so they survive an edit to the token set. */
    'sellingPrice', 'directCost', 'monthlyVolume', 'durationMinutes',
    'monthlyRevenue', 'capacityHours', 'revenuePerCapacityHour',
    'shareOfEnteredRevenue', 'shareOfEnteredCapacity'
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

  const normalizeReviewType = value =>
    REVIEW_TYPES.includes(value) ? value : DEFAULT_REVIEW_TYPE;

  /* Bands, not counts. Two to five is a small range and an exact count plus a
     vertical plus a timestamp starts to identify a session; a band answers
     "do people who enter more offerings finish more often?" just as well. */
  const OFFERING_COUNT_BANDS = ['none', 'one', 'two_to_three', 'four_to_five', 'over_five'];

  const offeringCountBand = count => {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return 'none';
    if (n === 1) return 'one';
    if (n <= 3) return 'two_to_three';
    if (n <= 5) return 'four_to_five';
    return 'over_five';
  };

  /* ---------- Service Mix metadata ----------

     A CLOSED ALLOWLIST, enforced, and the reason it is closed rather than a
     prohibition list is worth stating.

     The prohibited-name rule asks "does this key look like personal data?".
     That works when the leak is honest — someone adds `ownerEmail` and it is
     refused. It does nothing about the dishonest case, because the key names
     itself: `stepId: "owner@example.com"` passes every name-based check ever
     written, and so does `trigger: "She said she will buy in September"`.
     Guessing at the CONTENT is no better: a content pattern that catches an
     email address does not catch an offering name, and one that catches
     "Gel manicure" catches half the legitimate vocabulary of the product.

     So a Service Mix event may carry these keys and no others, and each value
     must be one of a small number of things it is allowed to be. A key that
     is not here is removed; a value that does not match is removed. Nothing
     is truncated into a shorter version of itself, and nothing is guessed at.

     Applied in the browser client before an event is queued, and AGAIN in
     api/analytics.mjs, which additionally refuses the event outright. Twice
     on purpose: the browser copy can be tampered with. */

  const oneOf = values => {
    const set = new Set(values);
    return value => set.has(value);
  };

  /* A step id is authored, short, and slug-shaped. The UUID exclusion is
     deliberate and is not redundant with the slug rule: a UUID is made
     entirely of hex and hyphens, so it satisfies any reasonable slug pattern
     — and a UUID is exactly the shape an offering identifier has. A step
     called by a UUID does not exist; a UUID arriving in stepId is an
     identifier wearing a neutral key. */
  const STEP_ID_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i;
  const isStepId = value =>
    typeof value === 'string' &&
    value.length > 0 && value.length <= 64 &&
    STEP_ID_RE.test(value) &&
    !UUID_RE.test(value);

  /* How a review was ENTERED, which is what a Service Mix page reports, and
     what suggested one was abandoned, which only the client's own inference
     reports. Two closed vocabularies under one key, kept apart because they
     belong to different events — see the note on ABANDONMENT_METADATA. */
  const ENTRY_TRIGGERS = ['standalone', 'after_growth_review', 'resumed'];
  const ABANDON_TRIGGERS = ['idle', 'page_hidden', 'page_exit'];

  /* ---------- what a PAGE may say ----------

     The seven approved keys. This is the public surface: anything reaching
     `track()` from ordinary page instrumentation is held to exactly this, on
     every Service Mix event without exception.

     `reviewType` is pinned to 'service_mix' rather than "either review type".
     On an event already resolved as Service Mix, a metadata field claiming
     `growth_review` is either a bug or an attempt to file the row in the
     other funnel; both are worth refusing, and neither is worth storing. */
  const SERVICE_MIX_METADATA = {
    /* the review this event belongs to — and it is THIS one */
    reviewType:        value => value === 'service_mix',
    /* always 1 in SM-1; the field is shared vocabulary with the Growth review */
    stage:             value => value === 1 || value === 2,
    /* which step, for drop-off */
    stepId:            value => isStepId(value),
    /* how the review was entered */
    trigger:           oneOf(ENTRY_TRIGGERS),
    /* starter or custom — never WHICH starter */
    offeringSource:    oneOf(['starter', 'custom']),
    /* how many offerings, as a band */
    offeringCountBand: oneOf(OFFERING_COUNT_BANDS),
    /* which kind of result was shown */
    resultKind:        oneOf(['preliminary', 'detailed'])
  };

  const SERVICE_MIX_METADATA_KEYS = Object.keys(SERVICE_MIX_METADATA);

  /* ---------- what the PLATFORM may say, and on which event ----------

     A different thing from the seven, and — this is the correction the v3
     audit demanded — attached to ONE event rather than available on all of
     them.

     The v3 implementation kept a `PLATFORM_METADATA` object and claimed a
     page could not reach it. That claim was false: the same public `track()`
     path fed the same sanitizer, so any page could attach `provisional: true`
     to any Service Mix event and have it stored. A funnel row saying
     "provisional" on a results view is not a privacy leak, but it is a lie
     about how the number was obtained, and the honesty rules in CLAUDE.md
     section 11 are the reason the field exists at all.

     So the annotations are keyed by EVENT NAME. `assessment.abandoned` is the
     only event that carries them, because it is the only event nobody
     observed — the client infers it from silence, and every one of these
     fields exists to say how weak that inference is.

     `clockSkewClamped` and `claimedOccurredAt` are NOT here. They are written
     by api/analytics.mjs when it actually clamps a timestamp, and a request
     may never supply them: a client that could assert "my clock was clamped"
     could annotate a row with something that never happened. The endpoint
     strips them from the request and derives them itself. */
  const isBool = value => value === true || value === false;
  const isCount = value =>
    Number.isInteger(value) && value >= 0 && value <= 30 * 24 * 60 * 60 * 1000;

  const ABANDONMENT_METADATA = {
    /* Exactly true. An abandonment event is ALWAYS a guess; `provisional:
       false` would be a claim this platform is not in a position to make. */
    provisional:   value => value === true,
    /* What suggested it — its own vocabulary, not the entry one. */
    trigger:       oneOf(ABANDON_TRIGGERS),
    quietForMs:    isCount,   /* how long the visitor had been quiet */
    resumedCount:  isCount,   /* how many times the review was resumed */
    reachedStage1: isBool,
    reachedStage2: isBool
  };

  /* Written by the endpoint, never accepted from a request. Listed so a
     stored row can be checked against a complete set of permitted keys. */
  const ENDPOINT_DERIVED_METADATA = {
    clockSkewClamped:  isBool,
    claimedOccurredAt: value => typeof value === 'string' && ISO_RE.test(value)
  };

  const ENDPOINT_DERIVED_METADATA_KEYS = Object.keys(ENDPOINT_DERIVED_METADATA);

  /* Which platform annotations an event may carry. One entry, deliberately:
     a second would need the same argument made again. */
  const PLATFORM_METADATA_BY_EVENT = {
    'assessment.abandoned': ABANDONMENT_METADATA
  };

  const PLATFORM_METADATA_KEYS = [
    ...new Set(Object.values(PLATFORM_METADATA_BY_EVENT).flatMap(Object.keys))
  ];

  /* Keeps the approved keys whose values are approved, and reports everything
     else it removed. Never edits a value into an acceptable one: a shortened
     or coerced value is a different value, and a different value is a wrong
     measurement rather than a safe one.

     `eventName` decides which platform annotations apply. Omitting it means
     "no event in particular", and no annotation is permitted — the safe
     default, because the caller that forgot to say which event this is, is
     exactly the caller that should not be attaching internal fields. */
  const sanitizeServiceMixMetadata = (metadata, eventName) => {
    const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata : {};
    const platform = PLATFORM_METADATA_BY_EVENT[eventName] || null;
    const out = {};
    const droppedFields = [];
    Object.keys(source).forEach(key => {
      /* The event's own platform annotations win where the names collide:
         `trigger` means something different on an abandonment than on a page
         view, and each has its own closed vocabulary. */
      const accepts =
        (platform && Object.prototype.hasOwnProperty.call(platform, key))
          ? platform[key]
          : (Object.prototype.hasOwnProperty.call(SERVICE_MIX_METADATA, key)
              ? SERVICE_MIX_METADATA[key] : null);
      const value = source[key];
      if (!accepts) { droppedFields.push(key); return; }
      /* An absent optional value is absent, not a violation. */
      if (value === null || value === undefined) return;
      if (!accepts(value)) { droppedFields.push(key); return; }
      out[key] = value;
    });
    return { metadata: out, droppedFields };
  };

  /* The same rule as a list, for the endpoint, which refuses rather than
     removes so a broken client is visible instead of silently thinned.

     Endpoint-derived keys are reported as violations wherever they arrive,
     including on the abandonment event: they are the endpoint's to write, and
     a request carrying one is asserting something about the endpoint's own
     clock. */
  const serviceMixMetadataViolations = (metadata, eventName) => {
    const dropped = sanitizeServiceMixMetadata(metadata, eventName).droppedFields;
    return [...new Set(dropped)];
  };

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

    /* Review type. Absent is legal and means growth_review — a schema-1 page
       cached before the Service Mix deploy has no field to send. A PRESENT
       value must be one we recognise, and it must agree with the event name
       when the name settles it: a `service_mix.*` event claiming to be a
       Growth Review would split one funnel across two review types. */
    if (event.reviewType !== null && event.reviewType !== undefined) {
      if (!REVIEW_TYPES.includes(event.reviewType)) {
        fail('invalid_review_type', `Unknown reviewType: ${String(event.reviewType).slice(0, 32)}`);
      } else {
        const implied = reviewTypeOfEvent(event.eventName);
        if (implied && implied !== event.reviewType) {
          fail('review_type_mismatch',
            `${event.eventName} is a ${implied} event and cannot carry reviewType ${event.reviewType}.`);
        }
      }
    }

    /* A Service Mix event may NEVER carry a Business Record identifier.
       Growth may: its page is given one by the capture endpoint, and a funnel
       row joined to a record is an approved part of that contract. The Service
       Mix page is never given one — the endpoint returns an opaque
       continuation context instead — so a businessId appearing on one of its
       events means something upstream leaked an identifier, and the event is
       refused rather than stored. Checked on the RESOLVED review type, so an
       event that merely forgot to declare one is still caught by its name. */
    const resolvedReviewType = reviewTypeOfEvent(event.eventName) ||
      normalizeReviewType(event.reviewType);
    if (resolvedReviewType === 'service_mix' &&
        event.businessId !== null && event.businessId !== undefined) {
      fail('business_id_in_service_mix',
        'A Service Mix analytics event may not carry a Business Record identifier.');
    }

    /* And its metadata is a closed allowlist, by key AND by value. Refused
       rather than thinned, so a client sending something unapproved finds
       out; the endpoint removes it as well, so a refusal that is somehow
       bypassed still stores nothing. The offending VALUE is never echoed —
       an error message is a place it would then appear. */
    if (resolvedReviewType === 'service_mix') {
      const unapproved = serviceMixMetadataViolations(event.metadata, event.eventName);
      if (unapproved.length) {
        fail('unapproved_service_mix_metadata',
          'A Service Mix analytics event may only carry ' +
          `${SERVICE_MIX_METADATA_KEYS.join(', ')}, each with an approved value, ` +
          'plus the platform annotations belonging to that particular event. ' +
          `Refused: ${unapproved.slice(0, 8).join(', ')}.`);
      }
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
    REVIEW_TYPES,
    DEFAULT_REVIEW_TYPE,
    reviewTypeOfEvent,
    normalizeReviewType,
    SERVICE_MIX_METADATA,
    SERVICE_MIX_METADATA_KEYS,
    ABANDONMENT_METADATA,
    PLATFORM_METADATA_BY_EVENT,
    PLATFORM_METADATA_KEYS,
    ENDPOINT_DERIVED_METADATA,
    ENDPOINT_DERIVED_METADATA_KEYS,
    ENTRY_TRIGGERS,
    ABANDON_TRIGGERS,
    sanitizeServiceMixMetadata,
    serviceMixMetadataViolations,
    OFFERING_COUNT_BANDS,
    offeringCountBand,
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
