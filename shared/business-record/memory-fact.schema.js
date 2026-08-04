/* ============================================================
   CED Intelligence Platform — AI Memory Facts
   Canonical schema, v1
   ------------------------------------------------------------
   Structured, attributable, supersedable statements about a
   business. This is what CIP "remembers" — NOT chat transcripts.

   A transcript is evidence, not memory. It is unstructured,
   unqueryable, impossible to supersede cleanly, and it drags
   every incidental remark along with the useful ones. Memory is
   a set of subject-predicate-object facts, each pointing back at
   the transcript span that produced it.

   Material facts — anything touching pricing, eligibility, legal
   terms, or automated close — may be PROPOSED by a model but
   never ACTED ON until deterministically confirmed or verified
   by a human.

   SPECIFICATION ONLY. No extraction, no store, no model calls.
   ============================================================ */

(() => {
  'use strict';

  const MEMORY_FACT_SCHEMA_VERSION = 1;

  const f = (type, meta = {}) => Object.assign({ type }, meta);

  const CATEGORIES = {
    technology:   { note: 'Systems in use. e.g. uses_booking_platform.' },
    intent:       { note: 'Stated plans. e.g. plans_to_hire.' },
    constraint:   { note: 'Things blocking progress. e.g. implementation_concern.' },
    preference:   { note: 'How they want to be treated. e.g. prefers_contact_channel.' },
    capacity:     { note: 'Ability to absorb growth. e.g. expansion_readiness.' },
    authority:    { note: 'Who decides. e.g. decision_authority.' },
    budget:       { note: 'Money and timing. e.g. budget_timing.' },
    relationship: { note: 'People and roles.' },
    operations:   { note: 'How the business runs day to day.' },
    risk:         { note: 'Objections, concerns, churn signals.' },
    compliance:   { note: 'Regulatory or contractual constraints.' }
  };

  const STATUSES = [
    'proposed',    /* a model suggested it; not yet usable for decisions */
    'active',      /* confirmed and current */
    'disputed',    /* conflicts with another active fact; both are retained */
    'superseded',  /* replaced by a newer fact; kept for audit */
    'retracted',   /* withdrawn as incorrect; kept for audit */
    'expired'      /* validTo has passed */
  ];

  const SOURCES = [
    'assessment_answer',   /* deterministic — strongest */
    'external_system',     /* deterministic if the system is trusted */
    'human_entry',
    'ai_conversation',     /* proposal only until confirmed */
    'ai_inference',        /* proposal only until confirmed */
    'observed_behavior'
  ];

  /* Sources that can stand on their own for a material fact. */
  const DETERMINISTIC_SOURCES = ['assessment_answer', 'external_system', 'human_entry'];

  const SENSITIVITY = ['public', 'internal', 'confidential', 'restricted'];

  /* Predicates whose value changes pricing, eligibility, legal terms, or
     whether an automated close may proceed. These require a deterministic
     source or explicit human verification before any engine may rely on them. */
  const MATERIAL_PREDICATES = [
    'decision_authority',
    'budget_amount',
    'budget_timing',
    'location_count',
    'uses_booking_platform',
    'integration_supported',
    'contract_terms_requested',
    'pricing_exception_requested',
    'compliance_constraint',
    'ownership_structure',
    'expansion_readiness'
  ];

  /* Never stored as a fact, in any category, at any sensitivity.
     Mirrors report.schema.js PROHIBITED_DATA_CATEGORIES, which remains the
     platform authority; these are the fact-level patterns. */
  const PROHIBITED_PREDICATE_PATTERN =
    /(password|passphrase|secret|api_?key|token|credential|card_?number|cvv|cvc|bank_?account|routing|ssn|social_?security|diagnosis|medication|prescription|treatment|patient|health_?condition)/i;

  const MEMORY_FACT_SCHEMA = {
    schemaVersion: f('integer', { required: true }),
    factId: f('uuid', { required: true, immutable: true }),
    businessId: f('uuid', { required: true }),

    /* Triple form keeps facts queryable and comparable. Free text belongs in
       `statement`, not in the structure. */
    subject: f('string', { required: true, note: 'Usually the businessId, or a personId for people facts.' }),
    predicate: f('string', { required: true, note: 'snake_case verb phrase, e.g. uses_booking_platform.' }),
    object: f('any', { required: true, note: 'Value: string, number, boolean, or small object. e.g. "Boulevard".' }),
    statement: f('string', { required: true, note: 'The fact in plain language, for humans reading the record.' }),

    category: f('enum', { required: true, values: Object.keys(CATEGORIES) }),
    confidence: f('number', { required: true, note: '0..1. AI-proposed facts rarely exceed 0.7 before confirmation.' }),

    source: f('enum', { required: true, values: SOURCES }),
    evidence: f('array<object>', {
      required: true,
      note: '{ kind, ref, excerpt, locator }. locator points at the exact span, e.g. a transcript offset or an answer field. At least one entry always.'
    }),

    observedAt: f('iso8601', { required: true, note: 'When the evidence was produced.' }),
    validFrom: f('iso8601', { required: true, note: 'When the fact became true in the world. Often differs from observedAt.' }),
    validTo: f('iso8601', { nullable: true, note: 'Null while current.' }),

    status: f('enum', { required: true, values: STATUSES }),
    supersededByFactId: f('uuid', { nullable: true, note: 'Set when a newer fact replaces this one. The old fact is retained.' }),
    conflictsWithFactIds: f('array<uuid>', { note: 'Conflicting facts coexist as "disputed" until a human or deterministic source resolves them.' }),

    sensitivity: f('enum', { required: true, values: SENSITIVITY, default: 'confidential' }),
    isMaterial: f('boolean', { required: true, note: 'True when predicate is in MATERIAL_PREDICATES.' }),
    humanVerified: f('boolean', { required: true, default: false }),
    verifiedBy: f('object', { nullable: true, note: '{ kind: "human", id, displayName }.' }),
    verifiedAt: f('iso8601', { nullable: true }),

    createdAt: f('iso8601', { required: true, immutable: true }),
    createdBy: f('object', { required: true, note: '{ kind (human|engine|ai_agent), id }.' })
  };

  const RULES = [
    'Raw chat transcripts are never canonical memory. Facts are extracted from them and cite them.',
    'Every fact must be attributable to at least one piece of evidence.',
    'AI may propose facts. A proposed fact is not usable for any decision.',
    'A material fact requires a deterministic source or explicit human verification before any engine relies on it.',
    'Conflicting facts coexist as "disputed" until resolved. The system never silently picks a winner.',
    'Superseded and retracted facts are retained and remain auditable.',
    'Never store passwords, payment details, protected health information, or secrets as facts.',
    'A fact whose validTo has passed is "expired" and must not be presented as current.'
  ];

  /* ---------------------------------------------------------
     Validation
     --------------------------------------------------------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);
  const isIso8601 = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

  const isMaterialPredicate = predicate => MATERIAL_PREDICATES.includes(predicate);

  /* May an engine act on this fact? Deterministic and conservative. */
  const isActionable = fact => {
    if (!fact || fact.status !== 'active') return false;
    if (fact.validTo && Date.parse(fact.validTo) < Date.now()) return false;
    if (!isMaterialPredicate(fact.predicate)) return true;
    return fact.humanVerified === true || DETERMINISTIC_SOURCES.includes(fact.source);
  };

  const validateMemoryFact = fact => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!fact || typeof fact !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'Fact must be an object.' }] };
    }

    if (fact.schemaVersion !== MEMORY_FACT_SCHEMA_VERSION) push('schema_version_mismatch', 'Unexpected schemaVersion.');
    if (!isUuid(fact.factId)) push('invalid_fact_id', 'factId must be a UUID.');
    if (!isUuid(fact.businessId)) push('invalid_business_id', 'businessId must be a UUID.');
    if (!fact.subject) push('missing_subject', 'subject is required.');
    if (!fact.predicate) push('missing_predicate', 'predicate is required.');
    if (fact.object === undefined || fact.object === null) push('missing_object', 'object is required.');
    if (!fact.statement) push('missing_statement', 'statement is required — a fact must be readable by a human.');

    if (!CATEGORIES[fact.category]) push('invalid_category', `Unknown category: ${fact.category}`);
    if (!STATUSES.includes(fact.status)) push('invalid_status', `Unknown status: ${fact.status}`);
    if (!SOURCES.includes(fact.source)) push('invalid_source', `Unknown source: ${fact.source}`);
    if (fact.sensitivity && !SENSITIVITY.includes(fact.sensitivity)) push('invalid_sensitivity', `Unknown sensitivity: ${fact.sensitivity}`);

    if (typeof fact.confidence !== 'number' || fact.confidence < 0 || fact.confidence > 1) {
      push('invalid_confidence', 'confidence must be a number in 0..1.');
    }

    /* Provenance is not optional. */
    if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) {
      push('missing_evidence', 'Every fact must cite at least one piece of evidence.');
    } else if (fact.evidence.some(e => !e || !e.ref)) {
      push('evidence_without_ref', 'Each evidence entry needs a ref pointing at its source.');
    }

    if (!fact.createdBy || !fact.createdBy.kind) push('missing_created_by', 'createdBy is required.');

    /* Prohibited content. */
    if (fact.predicate && PROHIBITED_PREDICATE_PATTERN.test(fact.predicate)) {
      push('prohibited_predicate', `Predicate "${fact.predicate}" names a prohibited data category.`);
    }
    if (typeof fact.object === 'string' && PROHIBITED_PREDICATE_PATTERN.test(fact.object)) {
      push('prohibited_object', 'object appears to contain prohibited data.');
    }

    /* Materiality. */
    const material = isMaterialPredicate(fact.predicate);
    if (fact.isMaterial !== undefined && fact.isMaterial !== material) {
      push('materiality_mismatch', `isMaterial should be ${material} for predicate "${fact.predicate}".`);
    }
    if (material && fact.status === 'active' &&
        !DETERMINISTIC_SOURCES.includes(fact.source) && fact.humanVerified !== true) {
      push('unverified_material_fact', `Material fact "${fact.predicate}" cannot be active from source "${fact.source}" without human verification.`);
    }
    if (fact.status === 'proposed' && fact.humanVerified === true) {
      push('verified_but_proposed', 'A human-verified fact should not remain "proposed".');
    }
    if (fact.humanVerified === true && !fact.verifiedBy) {
      push('missing_verifier', 'humanVerified requires verifiedBy.');
    }

    /* Temporal consistency. */
    if (!isIso8601(fact.observedAt)) push('invalid_observed_at', 'observedAt must be ISO 8601.');
    if (!isIso8601(fact.validFrom)) push('invalid_valid_from', 'validFrom must be ISO 8601.');
    if (fact.validTo) {
      if (!isIso8601(fact.validTo)) push('invalid_valid_to', 'validTo must be ISO 8601 or null.');
      else if (isIso8601(fact.validFrom) && Date.parse(fact.validTo) < Date.parse(fact.validFrom)) {
        push('inverted_validity', 'validTo cannot precede validFrom.');
      }
    }

    /* Supersession discipline. */
    if (fact.status === 'superseded' && !fact.supersededByFactId) {
      push('superseded_without_target', 'status "superseded" requires supersededByFactId.');
    }
    if (fact.supersededByFactId) {
      if (!isUuid(fact.supersededByFactId)) push('invalid_supersede_target', 'supersededByFactId must be a UUID.');
      if (fact.supersededByFactId === fact.factId) push('self_supersede', 'A fact cannot supersede itself.');
    }
    if (fact.status === 'disputed' && (!Array.isArray(fact.conflictsWithFactIds) || fact.conflictsWithFactIds.length === 0)) {
      push('disputed_without_conflict', 'status "disputed" requires conflictsWithFactIds.');
    }

    return { valid: errors.length === 0, errors };
  };

  const API = {
    MEMORY_FACT_SCHEMA_VERSION,
    MEMORY_FACT_SCHEMA,
    CATEGORIES,
    STATUSES,
    SOURCES,
    DETERMINISTIC_SOURCES,
    SENSITIVITY,
    MATERIAL_PREDICATES,
    PROHIBITED_PREDICATE_PATTERN,
    RULES,
    isMaterialPredicate,
    isActionable,
    validateMemoryFact,
    isUuid,
    isIso8601
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDMemoryFactSchema = API;
})();
