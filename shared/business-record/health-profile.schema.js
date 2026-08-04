/* ============================================================
   CED Intelligence Platform — Business Health Profile
   Canonical schema, v1
   ------------------------------------------------------------
   A versioned snapshot of how a relationship is going, across
   eleven dimensions. Append-only: each calculation period
   produces a new profile, and old profiles are never edited.

   The governing rule: NEVER fabricate a dimension. A dimension
   with no inputs is band "unknown" with a null score and a
   reason. An invented 50 is worse than an honest gap, because
   the 50 will be averaged into a decision.

   SPECIFICATION ONLY. No calculation engine, no store.
   ============================================================ */

(() => {
  'use strict';

  const HEALTH_PROFILE_SCHEMA_VERSION = 1;

  const f = (type, meta = {}) => Object.assign({ type }, meta);

  /* Bands. "unknown" is a first-class outcome, not a failure state. */
  const HEALTH_BANDS = [
    { id: 'unknown',  min: null, max: null, note: 'Insufficient input. Never inferred, never defaulted.' },
    { id: 'critical', min: 0,  max: 24 },
    { id: 'at_risk',  min: 25, max: 49 },
    { id: 'stable',   min: 50, max: 69 },
    { id: 'healthy',  min: 70, max: 89 },
    { id: 'thriving', min: 90, max: 100 }
  ];

  const DIRECTIONS = ['improving', 'stable', 'declining', 'unknown'];

  /* POLARITY — higher is better here, unlike risk and capacity-constraint
     scales elsewhere in CIP. "unknown" is orthogonal: it is not a low score,
     and it must never be averaged as one. */
  const POLARITY = {
    'dimension.score':  { higherIs: 'better', range: '0..100', orthogonal: ['band unknown -> score is null'] },
    'band':             { higherIs: 'better', order: 'critical < at_risk < stable < healthy < thriving', orthogonal: ['unknown'] },
    'confidence':       { higherIs: 'better', range: '0..1' },
    'changeFromPrevious': { higherIs: 'better', note: 'Signed delta. Positive means improvement.' },
    'direction':        { higherIs: 'n/a', note: 'Categorical: improving is good, declining is bad, unknown is neither.' }
  };

  /* The eleven dimensions. weight is used only for the overall roll-up and is
     redistributed across known dimensions when some are unknown. */
  const HEALTH_DIMENSIONS = {
    growth:          { weight: 0.14, note: 'Are they growing, and can they absorb more?' },
    operations:      { weight: 0.12, note: 'Appointment protection, no-shows, cancellations.' },
    automation:      { weight: 0.10, note: 'How much of the promised automation is actually live.' },
    technology:      { weight: 0.08, note: 'Integration health and compatibility drift.' },
    marketing:       { weight: 0.08, note: 'Campaign cadence and reputation trajectory.' },
    lifecycle:       { weight: 0.08, note: 'Stage progression versus expected pace.' },
    relationship:    { weight: 0.12, note: 'Responsiveness, sentiment, engagement with reviews.' },
    payment:         { weight: 0.12, note: 'Payment success, dunning, involuntary churn risk.' },
    onboarding:      { weight: 0.08, note: 'Time to value and blocker frequency.' },
    serviceDelivery: { weight: 0.08, note: 'Are we delivering what the package promises.' }
  };

  /* Overall is a roll-up, not a twelfth dimension. It requires enough coverage
     to be meaningful; below that it is "unknown" rather than a partial average
     dressed up as a score. */
  const OVERALL_RULES = {
    minimumKnownDimensions: 5,
    minimumKnownWeight: 0.50,
    note: 'Below either threshold, overall.band = unknown and overall.score = null.'
  };

  const DIMENSION_SCHEMA = {
    score: f('number', { nullable: true, note: '0..100, or null when band is unknown. Never a placeholder.' }),
    band: f('enum', { required: true, values: HEALTH_BANDS.map(b => b.id) }),
    evidence: f('array<object>', { required: true, note: '{ kind, ref, statement, weight }. Empty only when band is unknown.' }),
    confidence: f('number', { required: true, note: '0..1 in how well the inputs support the score. Unknown dimensions score 0.' }),
    changeFromPrevious: f('number', { nullable: true, note: 'Signed point delta versus the previous profile. Null when there is no comparable prior.' }),
    direction: f('enum', { required: true, values: DIRECTIONS }),
    calculatedAt: f('iso8601', { required: true }),
    formulaVersion: f('string', { required: true, note: 'Which deterministic formula produced this. Changing it makes periods non-comparable.' }),
    unknownReason: f('string', { nullable: true, note: 'Required when band is unknown. e.g. "no payment history", "integration never connected".' })
  };

  const HEALTH_PROFILE_SCHEMA = {
    schemaVersion: f('integer', { required: true }),
    healthProfileId: f('uuid', { required: true, immutable: true }),
    businessId: f('uuid', { required: true }),

    periodStart: f('iso8601', { required: true }),
    periodEnd: f('iso8601', { required: true }),
    calculatedAt: f('iso8601', { required: true }),
    previousHealthProfileId: f('uuid', { nullable: true, note: 'Enables changeFromPrevious. Null for the first profile.' }),

    overall: f('object', { required: true, shape: 'DIMENSION_SCHEMA', note: 'Roll-up governed by OVERALL_RULES.' }),
    dimensions: f('object', { required: true, note: 'One DIMENSION_SCHEMA per key of HEALTH_DIMENSIONS. All eleven keys always present, even when unknown.' }),

    coverage: f('object', { required: true, note: '{ knownDimensions, totalDimensions, knownWeight }. Makes the honesty of the roll-up inspectable.' }),
    basisRefs: f('array<string>', { note: 'BIR ids, subscription ids, and timeline event ids the calculation drew on.' }),
    formulaVersion: f('string', { required: true })
  };

  /* ---------------------------------------------------------
     Validation
     --------------------------------------------------------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);
  const isIso8601 = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
  const BAND_IDS = HEALTH_BANDS.map(b => b.id);

  const bandForScore = score => {
    if (score === null || score === undefined) return 'unknown';
    if (typeof score !== 'number' || Number.isNaN(score)) return 'unknown';
    const hit = HEALTH_BANDS.find(b => b.min !== null && score >= b.min && score <= b.max);
    return hit ? hit.id : 'unknown';
  };

  const validateDimension = (dim, name) => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message, dimension: name });

    if (!dim || typeof dim !== 'object') {
      return [{ code: 'missing_dimension', message: `Dimension ${name} is missing.`, dimension: name }];
    }
    if (!BAND_IDS.includes(dim.band)) push('invalid_band', `Unknown band: ${dim.band}`);

    if (dim.band === 'unknown') {
      if (dim.score !== null && dim.score !== undefined) push('unknown_with_score', 'An unknown dimension must have a null score — do not fabricate one.');
      if (!dim.unknownReason) push('missing_unknown_reason', 'An unknown dimension must state why.');
    } else {
      if (typeof dim.score !== 'number' || dim.score < 0 || dim.score > 100) {
        push('score_out_of_bounds', 'score must be a number in 0..100.');
      } else if (bandForScore(dim.score) !== dim.band) {
        push('band_score_mismatch', `score ${dim.score} does not fall in band ${dim.band}.`);
      }
      if (!Array.isArray(dim.evidence) || dim.evidence.length === 0) {
        push('missing_evidence', 'A scored dimension requires at least one evidence entry.');
      }
    }

    if (typeof dim.confidence !== 'number' || dim.confidence < 0 || dim.confidence > 1) {
      push('invalid_confidence', 'confidence must be a number in 0..1.');
    }
    if (!DIRECTIONS.includes(dim.direction)) push('invalid_direction', `Unknown direction: ${dim.direction}`);
    if (!dim.formulaVersion) push('missing_formula_version', 'formulaVersion is required.');
    if (dim.calculatedAt && !isIso8601(dim.calculatedAt)) push('invalid_calculated_at', 'calculatedAt must be ISO 8601.');

    return errors;
  };

  const validateHealthProfile = profile => {
    let errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!profile || typeof profile !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'Profile must be an object.' }] };
    }

    if (profile.schemaVersion !== HEALTH_PROFILE_SCHEMA_VERSION) push('schema_version_mismatch', 'Unexpected schemaVersion.');
    if (!isUuid(profile.healthProfileId)) push('invalid_profile_id', 'healthProfileId must be a UUID.');
    if (!isUuid(profile.businessId)) push('invalid_business_id', 'businessId must be a UUID.');
    if (!isIso8601(profile.periodStart)) push('invalid_period_start', 'periodStart must be ISO 8601.');
    if (!isIso8601(profile.periodEnd)) push('invalid_period_end', 'periodEnd must be ISO 8601.');
    if (isIso8601(profile.periodStart) && isIso8601(profile.periodEnd) &&
        Date.parse(profile.periodEnd) < Date.parse(profile.periodStart)) {
      push('inverted_period', 'periodEnd cannot precede periodStart.');
    }

    const dims = profile.dimensions || {};
    Object.keys(HEALTH_DIMENSIONS).forEach(name => {
      if (dims[name] === undefined) {
        push('missing_dimension', `Dimension ${name} must be present, even if unknown.`);
      } else {
        errors = errors.concat(validateDimension(dims[name], name));
      }
    });
    Object.keys(dims).forEach(name => {
      if (!HEALTH_DIMENSIONS[name]) push('unknown_dimension', `Unrecognized dimension: ${name}`);
    });

    if (profile.overall) errors = errors.concat(validateDimension(profile.overall, 'overall'));
    else push('missing_overall', 'overall is required.');

    /* Coverage honesty: the roll-up must be unknown when coverage is thin. */
    const known = Object.keys(HEALTH_DIMENSIONS).filter(n => dims[n] && dims[n].band !== 'unknown');
    const knownWeight = known.reduce((s, n) => s + HEALTH_DIMENSIONS[n].weight, 0);
    const coverageOk = known.length >= OVERALL_RULES.minimumKnownDimensions &&
                       knownWeight >= OVERALL_RULES.minimumKnownWeight;
    if (!coverageOk && profile.overall && profile.overall.band !== 'unknown') {
      push('overall_overstated', `Only ${known.length} known dimensions (weight ${knownWeight.toFixed(2)}); overall must be "unknown".`);
    }

    if (profile.coverage) {
      if (profile.coverage.knownDimensions !== known.length) {
        push('coverage_mismatch', `coverage.knownDimensions says ${profile.coverage.knownDimensions}, actual ${known.length}.`);
      }
    } else {
      push('missing_coverage', 'coverage is required.');
    }

    return { valid: errors.length === 0, errors };
  };

  const API = {
    HEALTH_PROFILE_SCHEMA_VERSION,
    HEALTH_PROFILE_SCHEMA,
    DIMENSION_SCHEMA,
    HEALTH_DIMENSIONS,
    HEALTH_BANDS,
    DIRECTIONS,
    OVERALL_RULES,
    POLARITY,
    bandForScore,
    validateDimension,
    validateHealthProfile,
    isUuid,
    isIso8601
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDHealthProfileSchema = API;
})();
