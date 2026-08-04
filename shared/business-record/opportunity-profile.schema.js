/* ============================================================
   CED Intelligence Platform — Opportunity Profile
   Canonical schema, v1
   ------------------------------------------------------------
   Everything CIP believes a business could gain, and what it
   would take. Attached to the Business Record, append-only in
   history: an opportunity that closes is marked closed, never
   deleted, because "what did we offer and what happened" is the
   only way the Learning Engine can calibrate anything.

   Two rules carry the design:
     1. A value is ALWAYS a range with stated assumptions and a
        confidence. Never a single number, never a promise.
     2. Capacity constrains value. An opportunity a business
        cannot physically serve is capped and flagged, not sold.

   SPECIFICATION ONLY. No calculation, no store.
   ============================================================ */

(() => {
  'use strict';

  const OPPORTUNITY_SCHEMA_VERSION = 1;

  const f = (type, meta = {}) => Object.assign({ type }, meta);

  /* The fourteen categories. horizon is indicative, not a promise. */
  const OPPORTUNITY_TYPES = {
    current:        { note: 'Value being realized right now under existing services.' },
    recovered:      { note: 'Value already recaptured because of work delivered. Evidence-backed, not projected.' },
    remaining:      { note: 'Identified but not yet addressed within the current engagement.' },
    emerging:       { note: 'Newly visible from a recent reassessment or business change.' },
    seasonal:       { note: 'Recurs on a calendar cycle; timing matters more than size.' },
    expansion:      { note: 'More capacity, more locations, more staff.' },
    upsell:         { note: 'A higher package tier.' },
    cross_sell:     { note: 'A different service alongside the current one.' },
    referral:       { note: 'Value from introductions this business could make.' },
    renewal:        { note: 'Continuation of an existing subscription.' },
    retention:      { note: 'Value preserved by preventing a churn that is otherwise likely.' },
    risk_reduction: { note: 'Value from removing a downside, not adding an upside.' },
    automation:     { note: 'Manual work that could be automated within the current package.' },
    operational:    { note: 'Process improvement with no new purchase attached.' }
  };

  const STATUSES = [
    'identified', 'qualified', 'presented', 'accepted',
    'declined', 'expired', 'withdrawn', 'superseded', 'realized'
  ];

  const OUTCOMES = ['won', 'lost', 'partial', 'no_action', 'invalidated', 'pending'];

  const QUALIFICATION_STATUSES = ['unqualified', 'qualifying', 'qualified', 'disqualified', 'insufficient_data'];

  const TIMING_HORIZONS = ['immediate', 'within_30_days', 'within_90_days', 'within_year', 'seasonal', 'unknown'];

  /* How hard capacity bites on THIS opportunity.
     POLARITY: higher severity is WORSE. unconstrained is the best case.

     Renamed in this revision: the first value was "none", which collided
     dangerously with CAPACITY_HEADROOM_BANDS "none" in report.schema.js —
     there, "none" means NO HEADROOM, the worst case. Same word, opposite
     polarity, one field apart. See docs/decisions/ADR-001. */
  const CAPACITY_CONSTRAINT_LEVELS = ['unconstrained', 'soft', 'hard', 'blocking', 'unknown'];

  const POLARITY = {
    'capacityConstraint.level': {
      higherIs: 'worse',
      order: 'unconstrained < soft < hard < blocking',
      orthogonal: ['unknown'],
      warning: 'Do NOT confuse with report.schema.js CAPACITY_HEADROOM_BANDS, where "none" is the WORST case (no headroom). Here "unconstrained" is the BEST case (no constraint).'
    },
    'confidence':            { higherIs: 'better', range: '0..1' },
    'estimatedValueRange':   { higherIs: 'larger opportunity', note: 'Size is not desirability — a large opportunity behind a blocking capacity constraint must not be presented.' },
    'qualificationStatus':   { higherIs: 'n/a', note: 'Not a scale. insufficient_data is orthogonal to disqualified.' },
    'status':                { higherIs: 'n/a', note: 'A workflow state machine, not a ranking.' }
  };

  const VALUE_RANGE_SCHEMA = {
    currency: f('string', { required: true, note: 'USD.' }),
    period: f('string', { required: true, note: 'month | quarter | year | one_time.' }),
    low: f('number', { required: true }),
    expected: f('number', { required: true, note: 'Deterministic point figure. Never presented alone.' }),
    high: f('number', { required: true }),
    assumptions: f('array<string>', { required: true, note: 'What must be true for this range to hold. An empty list is invalid — there are always assumptions.' }),
    method: f('string', { required: true, note: 'Identifier of the deterministic formula set used.' }),
    capacityAdjusted: f('boolean', { required: true, note: 'True when the range was clamped to servable volume.' }),
    isDiagnosticEstimate: f('boolean', { required: true, note: 'Always true. Never a projection or guarantee.' })
  };

  const OPPORTUNITY_SCHEMA = {
    schemaVersion: f('integer', { required: true }),
    opportunityId: f('uuid', { required: true, immutable: true }),
    businessId: f('uuid', { required: true }),

    type: f('enum', { required: true, values: Object.keys(OPPORTUNITY_TYPES) }),
    title: f('string', { required: true, note: 'Short, human. Shown in the timeline and to owners.' }),
    description: f('string', { required: true }),

    estimatedValueRange: f('object', { required: true, shape: 'VALUE_RANGE_SCHEMA' }),
    confidence: f('number', { required: true, note: '0..1. Inherits from the source BIR unless further evidence narrows it.' }),
    evidence: f('array<object>', { required: true, note: '{ kind, ref, statement }. At least one entry; an unevidenced opportunity is a guess.' }),

    qualificationStatus: f('enum', { required: true, values: QUALIFICATION_STATUSES }),

    capacityConstraint: f('object', {
      required: true,
      note: '{ level (CAPACITY_CONSTRAINT_LEVELS), headroomBand, servableCeiling, note }. "blocking" means do not present.'
    }),

    timing: f('object', { required: true, note: '{ horizon (TIMING_HORIZONS), earliestAt, latestAt, seasonalWindow }.' }),
    recommendedNextAction: f('object', { required: true, note: '{ action, rationale, automationClass, requiredConsents[] }.' }),

    relatedOffers: f('array<object>', { note: '{ offerId, packageId, fitScore }.' }),
    matchReasons: f('array<string>', { note: 'Why this opportunity matched this business — used by offer matching against historical BIRs.' }),
    exclusions: f('array<string>', { note: 'Why it may NOT apply: unsupported integration, multi-location, compliance, custom scope.' }),

    sourceBirId: f('uuid', { nullable: true, note: 'The BIR this was derived from. Null for manually entered opportunities.' }),
    supersedesOpportunityId: f('uuid', { nullable: true }),

    status: f('enum', { required: true, values: STATUSES }),
    outcome: f('enum', { required: true, values: OUTCOMES, default: 'pending' }),
    outcomeNote: f('string', { nullable: true }),

    createdAt: f('iso8601', { required: true, immutable: true }),
    updatedAt: f('iso8601', { required: true }),
    expiresAt: f('iso8601', { nullable: true, note: 'After this, status must move to expired. Stale opportunities must not be presented.' }),
    closedAt: f('iso8601', { nullable: true })
  };

  const OPPORTUNITY_PROFILE_SCHEMA = {
    schemaVersion: f('integer', { required: true }),
    businessId: f('uuid', { required: true }),
    generatedAt: f('iso8601', { required: true }),
    sourceBirId: f('uuid', { nullable: true }),
    opportunities: f('array<object>', { required: true, shape: 'OPPORTUNITY_SCHEMA' }),
    totals: f('object', {
      note: '{ byType: { [type]: { low, expected, high } }, overall: { low, expected, high } }. Ranges only; totals are never summed into a single headline number.'
    }),
    capacityCeiling: f('object', { note: '{ headroomBand, servableCeiling, source }. Applies across all opportunities.' })
  };

  /* ---------------------------------------------------------
     Validation
     --------------------------------------------------------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);
  const isIso8601 = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

  const validateValueRange = range => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!range || typeof range !== 'object') {
      return [{ code: 'missing_value_range', message: 'estimatedValueRange is required.' }];
    }
    ['low', 'expected', 'high'].forEach(k => {
      if (typeof range[k] !== 'number' || Number.isNaN(range[k])) push('invalid_range_bound', `${k} must be a number.`);
    });
    if (typeof range.low === 'number' && typeof range.expected === 'number' && typeof range.high === 'number') {
      if (!(range.low <= range.expected && range.expected <= range.high)) {
        push('range_out_of_order', `Require low <= expected <= high (got ${range.low}, ${range.expected}, ${range.high}).`);
      }
      if (range.low < 0) push('negative_range', 'low cannot be negative.');
      if (range.low === range.high) {
        push('degenerate_range', 'low and high must differ — a single number is not an honest estimate.');
      }
    }
    if (!Array.isArray(range.assumptions) || range.assumptions.length === 0) {
      push('missing_assumptions', 'A value range must state its assumptions.');
    }
    if (!range.method) push('missing_method', 'method is required — every figure traces to a named formula.');
    if (range.isDiagnosticEstimate !== true) {
      push('missing_diagnostic_flag', 'isDiagnosticEstimate must be true. CIP does not produce projections or guarantees.');
    }
    return errors;
  };

  const validateOpportunity = opp => {
    let errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!opp || typeof opp !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'Opportunity must be an object.' }] };
    }

    if (opp.schemaVersion !== OPPORTUNITY_SCHEMA_VERSION) push('schema_version_mismatch', 'Unexpected schemaVersion.');
    if (!isUuid(opp.opportunityId)) push('invalid_opportunity_id', 'opportunityId must be a UUID.');
    if (!isUuid(opp.businessId)) push('invalid_business_id', 'businessId must be a UUID.');
    if (!OPPORTUNITY_TYPES[opp.type]) push('invalid_type', `Unknown opportunity type: ${opp.type}`);
    if (!STATUSES.includes(opp.status)) push('invalid_status', `Unknown status: ${opp.status}`);
    if (!OUTCOMES.includes(opp.outcome)) push('invalid_outcome', `Unknown outcome: ${opp.outcome}`);
    if (!QUALIFICATION_STATUSES.includes(opp.qualificationStatus)) push('invalid_qualification_status', `Unknown qualificationStatus: ${opp.qualificationStatus}`);
    if (!opp.title) push('missing_title', 'title is required.');

    errors = errors.concat(validateValueRange(opp.estimatedValueRange));

    if (typeof opp.confidence !== 'number' || opp.confidence < 0 || opp.confidence > 1) {
      push('invalid_confidence', 'confidence must be a number in 0..1.');
    }
    if (!Array.isArray(opp.evidence) || opp.evidence.length === 0) {
      push('missing_evidence', 'An opportunity requires at least one evidence entry.');
    }

    const cap = opp.capacityConstraint;
    if (!cap || !CAPACITY_CONSTRAINT_LEVELS.includes(cap.level)) {
      push('invalid_capacity_constraint', `capacityConstraint.level must be one of: ${CAPACITY_CONSTRAINT_LEVELS.join(', ')}`);
    } else if (cap.level === 'blocking' && ['presented', 'accepted'].includes(opp.status)) {
      push('presented_despite_blocking_capacity', 'An opportunity with blocking capacity constraint must not be presented.');
    }

    if (opp.timing && !TIMING_HORIZONS.includes(opp.timing.horizon)) {
      push('invalid_timing_horizon', `Unknown timing horizon: ${opp.timing.horizon}`);
    }

    if (opp.createdAt && !isIso8601(opp.createdAt)) push('invalid_created_at', 'createdAt must be ISO 8601.');
    if (opp.expiresAt && !isIso8601(opp.expiresAt)) push('invalid_expires_at', 'expiresAt must be ISO 8601.');
    if (opp.closedAt && !isIso8601(opp.closedAt)) push('invalid_closed_at', 'closedAt must be ISO 8601.');
    if (opp.expiresAt && opp.createdAt && isIso8601(opp.expiresAt) && isIso8601(opp.createdAt) &&
        Date.parse(opp.expiresAt) < Date.parse(opp.createdAt)) {
      push('expires_before_created', 'expiresAt cannot precede createdAt.');
    }

    const terminal = ['accepted', 'declined', 'expired', 'withdrawn', 'superseded', 'realized'];
    if (terminal.includes(opp.status) && !opp.closedAt) {
      push('terminal_without_closed_at', `status "${opp.status}" requires closedAt.`);
    }
    if (!terminal.includes(opp.status) && opp.outcome !== 'pending') {
      push('outcome_before_close', 'A non-terminal opportunity must have outcome "pending".');
    }

    return { valid: errors.length === 0, errors };
  };

  const API = {
    OPPORTUNITY_SCHEMA_VERSION,
    OPPORTUNITY_SCHEMA,
    OPPORTUNITY_PROFILE_SCHEMA,
    VALUE_RANGE_SCHEMA,
    OPPORTUNITY_TYPES,
    STATUSES,
    OUTCOMES,
    QUALIFICATION_STATUSES,
    TIMING_HORIZONS,
    CAPACITY_CONSTRAINT_LEVELS,
    POLARITY,
    validateValueRange,
    validateOpportunity,
    isUuid,
    isIso8601
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDOpportunitySchema = API;
})();
