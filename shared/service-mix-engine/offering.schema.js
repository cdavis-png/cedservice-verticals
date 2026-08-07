/* ============================================================
   CED Intelligence Platform — Service Mix offering contract
   ------------------------------------------------------------
   What an offering IS, how it is identified across time, and
   what a Quick Review payload must look like before anything is
   calculated from it.

   The identity rules are the load-bearing part:

     · offeringId is minted once, when an offering is first
       added, and survives renaming. "Gel manicure" becoming
       "Gel set" is the same offering with a new label.
     · offeringSnapshotId is minted per submission. Two
       submissions six months apart are two snapshots of one
       offeringId, and the price change between them is legible.
     · Replacing mints a NEW offeringId and records
       replacesOfferingId. A discontinued service and its
       successor are not one thing averaged together.
     · Offerings are NEVER merged on name similarity. "Gel mani"
       and "Gel manicure" may be one service or two price points,
       and only the owner knows which.

   Vertical vocabulary — the starter list, the wording of every
   question — belongs to the vertical config. The field names,
   the enums, and the limits below are a SHARED CONTRACT and are
   read by the browser, the endpoint, and the report generator.

   Full rationale: docs/SERVICE_MIX_REVIEW.md section 5.

   Classic script on purpose.
   ============================================================ */

(() => {
  'use strict';

  const values = (typeof module !== 'undefined' && module.exports)
    ? require('./value.schema.js')
    : (typeof window !== 'undefined' ? window.CEDServiceMixValue : null);

  /* ---------- limits ----------
     Three is the recommendation because it is the smallest number that lets
     an owner compare rather than merely describe. Two is the floor for the
     same reason. Five is the ceiling because the review must stay under
     eight minutes and each offering costs six fields. */
  const OFFERING_LIMITS = {
    min: 2,
    max: 5,
    recommended: 3,
    nameMaxLength: 80,
    maxSellingPrice: 100000,
    maxDurationMinutes: 24 * 60,
    maxMonthlyVolume: 100000
  };

  /* ---------- vocabularies ----------
     Categories are generic across service verticals. A vertical maps its own
     starters onto these; it does not invent new ones, because the report and
     any future cross-vertical comparison read this list. */
  const CATEGORIES = [
    'core_service',
    'premium_service',
    'maintenance_service',
    'add_on',
    'membership',
    'retail_product',
    'other'
  ];

  /* Categories for which an appointment or labour time is genuinely not a
     measurement gap. A retail product has no duration; saying "unknown"
     would penalise completeness for an answer that is simply correct.

     Every other category IS an appointment service, and for those a duration
     of "does not apply" is a false answer rather than an honest one — it
     removes the offering from the hours denominator while leaving it in the
     revenue one, which quietly inflates revenue per hour for everything else.
     `validateOffering` refuses it. */
  const CATEGORIES_WITHOUT_DURATION = ['retail_product', 'membership'];

  const APPOINTMENT_CATEGORIES = CATEGORIES.filter(c => !CATEGORIES_WITHOUT_DURATION.includes(c));

  /* Which measures may ever be declared not-applicable, and for what.

     sellingPrice and monthlyVolume may NEVER be: everything SM-1 reviews is
     something the business sells, so a price and a count always exist even
     when the owner does not know them. "I do not know" is `unknown`, which is
     a gap and is counted as one. `not_applicable` would silently leave the
     offering out of the denominator and make an unmeasured portfolio look
     complete. */
  const NOT_APPLICABLE_ALLOWED = {
    sellingPrice: [],
    monthlyVolume: [],
    durationMinutes: CATEGORIES_WITHOUT_DURATION.slice()
  };

  const mayBeNotApplicable = (measure, category) =>
    (NOT_APPLICABLE_ALLOWED[measure] || []).includes(category);

  const DEMAND_LEVELS = ['strong', 'steady', 'weak', 'unknown'];

  const ROLES = [
    'primary_revenue',
    'volume_driver',
    'margin_builder',      /* the owner's belief. SM-1 never confirms it. */
    'client_acquisition',
    'retention',
    'convenience',
    'unclear'
  ];

  /* What the entered offerings represent. Without this, every share in the
     report is a share of an unknown denominator. */
  const COVERAGE_DECLARATIONS = ['all_offerings', 'most_revenue', 'selected_sample', 'unknown'];

  /* How much a declaration lets shares be trusted. A selected sample
     describes the sample, never the business. */
  const COVERAGE_FACTOR = {
    all_offerings: 1.00,
    most_revenue: 0.80,
    selected_sample: 0.45,
    unknown: 0.30
  };

  const OFFERING_SOURCES = ['starter', 'custom'];

  /* The three numeric measures SM-1 collects. Direct cost is deliberately
     absent — see docs/SERVICE_MIX_REVIEW.md section 6. */
  const STAGE1_MEASURES = ['sellingPrice', 'durationMinutes', 'monthlyVolume'];

  /* ---------- identity ---------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);

  /* Minting happens on the visitor's device, where an offering is first
     added. crypto.randomUUID is present in every browser this platform
     supports; the fallback keeps a file:// preview and a Node test working
     rather than silently producing collisions. */
  const newId = () => {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const rand = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${rand()}${rand()}-${rand()}-4${rand().slice(1)}-a${rand().slice(1)}-${rand()}${rand()}${rand()}`;
  };

  /* A brand-new offering. `source` records whether the owner picked it from
     the vertical's starter list or typed their own, which is the only thing
     analytics is ever told about an offering's identity. */
  const createOffering = ({ name = '', category = 'other', source = 'custom' } = {}) => ({
    offeringId: newId(),
    offeringSnapshotId: null,
    replacesOfferingId: null,
    name: String(name).slice(0, OFFERING_LIMITS.nameMaxLength),
    category: CATEGORIES.includes(category) ? category : 'other',
    source: OFFERING_SOURCES.includes(source) ? source : 'custom',
    sellingPrice: values.UNKNOWN,
    durationMinutes: values.UNKNOWN,
    monthlyVolume: values.UNKNOWN,
    demand: 'unknown',
    role: 'unclear'
  });

  /* Renaming keeps the id. This function exists so the rule is a call site
     rather than a convention someone can forget. */
  const renameOffering = (offering, name) => ({
    ...offering,
    name: String(name == null ? '' : name).slice(0, OFFERING_LIMITS.nameMaxLength)
  });

  /* Replacement is a different offering occupying the old one's place. New
     id, and a permanent pointer back so the succession is legible. */
  const replaceOffering = (previous, { name = '', category = 'other', source = 'custom' } = {}) => {
    const next = createOffering({ name, category, source });
    next.replacesOfferingId = previous && previous.offeringId ? previous.offeringId : null;
    return next;
  };

  /* Stamped at submission time. A new snapshot per submitted version is what
     makes the same offeringId comparable across reassessments. */
  const snapshotOffering = offering => ({ ...offering, offeringSnapshotId: newId() });

  /* Duration is not applicable for categories that have none. Applied at
     read time rather than at entry, so changing a category corrects the
     evidence rather than stranding an old answer. */
  const durationApplies = offering =>
    !CATEGORIES_WITHOUT_DURATION.includes(offering && offering.category);

  const measureValue = (offering, measure) => {
    if (!offering) return values.UNKNOWN;
    if (measure === 'durationMinutes' && !durationApplies(offering)) return values.NOT_APPLICABLE;
    const value = offering[measure];
    return value && values.VALUE_KINDS.includes(value.kind) ? value : values.UNKNOWN;
  };

  /* An offering is usable when it can contribute at least one interval to
     the portfolio. One with no price and no volume names something without
     measuring it, and the report says so rather than counting it. */
  const isUsableOffering = offering => {
    if (!offering || !isUuid(offering.offeringId)) return false;
    if (!String(offering.name || '').trim()) return false;
    return STAGE1_MEASURES.some(m => values.isMeasured(measureValue(offering, m)));
  };

  /* ---------- payload validation ----------

     Returns every problem rather than the first, so a client author sees the
     whole picture in one response. Runs unchanged in the browser and in the
     endpoint: a browser and a server that disagree about what a valid
     offering is will disagree in the direction that stores the invalid one. */

  const validateMeasuredValue = (value, measure, path, errors, category = null) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ code: 'invalid_measure', message: `${path} must be a measured value object.` });
      return;
    }
    if (!values.VALUE_KINDS.includes(value.kind)) {
      errors.push({ code: 'invalid_measure_kind', message: `${path}.kind is not a permitted value kind.` });
      return;
    }

    /* The rule that keeps an unmeasured portfolio from looking measured.
       `not_applicable` leaves the denominator; `unknown` stays in it and
       scores zero. Declaring the wrong one is how a review with no usable
       evidence ends up reporting complete coverage. */
    if (value.kind === 'not_applicable' && !mayBeNotApplicable(measure, category)) {
      errors.push({
        code: 'not_applicable_not_permitted',
        message: measure === 'durationMinutes'
          ? `${path} may only be "does not apply" for ${CATEGORIES_WITHOUT_DURATION.join(' or ')}; ` +
            `an appointment service has a duration even when it is not known. Use "unknown".`
          : `${path} may never be "does not apply" — everything reviewed is sold, ` +
            `so a ${measure === 'sellingPrice' ? 'price' : 'monthly count'} exists even when it is not known. Use "unknown".`
      });
      return;
    }
    const ceiling = measure === 'sellingPrice' ? OFFERING_LIMITS.maxSellingPrice
      : measure === 'durationMinutes' ? OFFERING_LIMITS.maxDurationMinutes
      : OFFERING_LIMITS.maxMonthlyVolume;

    const numbersToCheck = value.kind === 'range' ? [value.low, value.high]
      : (value.kind === 'exact' || value.kind === 'estimate') ? [value.value]
      : [];

    numbersToCheck.forEach(n => {
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        errors.push({ code: 'invalid_measure_number', message: `${path} must carry finite numbers.` });
        return;
      }
      if (n < 0) {
        errors.push({ code: 'negative_measure', message: `${path} must not be negative.` });
        return;
      }
      if (n > ceiling) {
        errors.push({ code: 'measure_out_of_range', message: `${path} exceeds the permitted maximum.` });
      }
    });

    if (value.kind === 'range' &&
        typeof value.low === 'number' && typeof value.high === 'number' &&
        value.low > value.high) {
      errors.push({ code: 'range_out_of_order', message: `${path} must satisfy low <= high.` });
    }
  };

  const validateOffering = (offering, index, errors) => {
    const path = `offerings[${index}]`;
    if (!offering || typeof offering !== 'object' || Array.isArray(offering)) {
      errors.push({ code: 'invalid_offering', message: `${path} must be an object.` });
      return;
    }
    if (!isUuid(offering.offeringId)) {
      errors.push({ code: 'invalid_offering_id', message: `${path}.offeringId must be a UUID.` });
    }
    if (!isUuid(offering.offeringSnapshotId)) {
      errors.push({ code: 'invalid_snapshot_id', message: `${path}.offeringSnapshotId must be a UUID.` });
    }
    if (offering.offeringSnapshotId && offering.offeringSnapshotId === offering.offeringId) {
      errors.push({ code: 'snapshot_equals_offering',
        message: `${path}.offeringSnapshotId must differ from offeringId.` });
    }
    if (offering.replacesOfferingId !== null && offering.replacesOfferingId !== undefined) {
      if (!isUuid(offering.replacesOfferingId)) {
        errors.push({ code: 'invalid_replaces_id', message: `${path}.replacesOfferingId must be a UUID.` });
      } else if (offering.replacesOfferingId === offering.offeringId) {
        errors.push({ code: 'self_replacement', message: `${path} cannot replace itself.` });
      }
    }

    const name = typeof offering.name === 'string' ? offering.name.trim() : '';
    if (!name) {
      errors.push({ code: 'missing_offering_name', message: `${path}.name is required.` });
    } else if (offering.name.length > OFFERING_LIMITS.nameMaxLength) {
      errors.push({ code: 'offering_name_too_long',
        message: `${path}.name exceeds ${OFFERING_LIMITS.nameMaxLength} characters.` });
    }

    if (!CATEGORIES.includes(offering.category)) {
      errors.push({ code: 'invalid_category', message: `${path}.category is not a permitted category.` });
    }
    if (!OFFERING_SOURCES.includes(offering.source)) {
      errors.push({ code: 'invalid_source', message: `${path}.source must be starter or custom.` });
    }
    if (!DEMAND_LEVELS.includes(offering.demand)) {
      errors.push({ code: 'invalid_demand', message: `${path}.demand is not a permitted level.` });
    }
    if (!ROLES.includes(offering.role)) {
      errors.push({ code: 'invalid_role', message: `${path}.role is not a permitted role.` });
    }

    STAGE1_MEASURES.forEach(measure =>
      validateMeasuredValue(offering[measure], measure, `${path}.${measure}`, errors,
        offering.category));

    /* SM-1 does not collect direct costs. A payload carrying one is either a
       client from a future milestone or a client that has been tampered
       with, and either way this engine must not silently analyse it as
       though a cost were evidence. */
    if (offering.directCost !== undefined) {
      errors.push({ code: 'direct_cost_not_collected',
        message: `${path}.directCost is not collected in the Quick Review.` });
    }
  };

  const validateOfferings = offerings => {
    const errors = [];

    if (!Array.isArray(offerings)) {
      return { valid: false, errors: [{ code: 'offerings_not_an_array', message: 'offerings must be an array.' }] };
    }
    if (offerings.length < OFFERING_LIMITS.min) {
      errors.push({ code: 'too_few_offerings',
        message: `At least ${OFFERING_LIMITS.min} offerings are required.` });
    }
    if (offerings.length > OFFERING_LIMITS.max) {
      errors.push({ code: 'too_many_offerings',
        message: `At most ${OFFERING_LIMITS.max} offerings may be reviewed.` });
    }

    offerings.forEach((offering, index) => validateOffering(offering, index, errors));

    /* Two entries under one offeringId would make every share ambiguous and
       every longitudinal comparison wrong. */
    const seenOfferingIds = new Set();
    const seenSnapshotIds = new Set();
    offerings.forEach((offering, index) => {
      const id = offering && offering.offeringId;
      if (id && seenOfferingIds.has(id)) {
        errors.push({ code: 'duplicate_offering_id',
          message: `offerings[${index}] repeats an offeringId already used in this submission.` });
      }
      if (id) seenOfferingIds.add(id);

      const snap = offering && offering.offeringSnapshotId;
      if (snap && seenSnapshotIds.has(snap)) {
        errors.push({ code: 'duplicate_snapshot_id',
          message: `offerings[${index}] repeats an offeringSnapshotId.` });
      }
      if (snap) seenSnapshotIds.add(snap);
    });

    return { valid: errors.length === 0, errors };
  };

  /* Which contact fields a connected review may report as prefilled.
     A CLOSED ENUM of field NAMES. Mirrors
     shared/security/continuation.js :: PREFILL_FIELDS and
     generate-service-mix-bir.js :: PREFILLED_FIELD_NAMES; a test asserts all
     three stay identical.

     It is an enum rather than "any string" because the field travels into the
     stored report, and a list of field names that accepts arbitrary strings
     is a place to put an email address, an offering name, or a sentence
     under a name that promises none of them. */
  const PREFILLED_FIELD_NAMES = ['salonName', 'businessName', 'ownerName', 'email'];
  const MAX_PREFILLED_FIELDS = PREFILLED_FIELD_NAMES.length;

  const validatePrefilledFields = (list, errors) => {
    if (list === undefined || list === null) return;      /* absent is fine */
    if (!Array.isArray(list)) {
      errors.push({ code: 'invalid_prefilled_fields',
        message: 'serviceMix.prefilledFields must be an array of field names.' });
      return;
    }
    if (list.length > MAX_PREFILLED_FIELDS) {
      errors.push({ code: 'too_many_prefilled_fields',
        message: `serviceMix.prefilledFields may name at most ${MAX_PREFILLED_FIELDS} fields.` });
    }
    if (new Set(list).size !== list.length) {
      errors.push({ code: 'duplicate_prefilled_field',
        message: 'serviceMix.prefilledFields must not repeat a field name.' });
    }
    list.forEach((field, index) => {
      if (!PREFILLED_FIELD_NAMES.includes(field)) {
        errors.push({ code: 'unknown_prefilled_field',
          /* The offending value is NOT echoed: it may be exactly the contact
             detail or free text this rule exists to keep out, and an error
             response is somewhere it would then appear. */
          message: `serviceMix.prefilledFields[${index}] is not an approved field name. ` +
                   `Permitted: ${PREFILLED_FIELD_NAMES.join(', ')}.` });
      }
    });
  };

  /* The whole Service Mix answer block: offerings plus the coverage
     declaration that gives every share a denominator. */
  const validateServiceMix = serviceMix => {
    if (!serviceMix || typeof serviceMix !== 'object' || Array.isArray(serviceMix)) {
      return { valid: false, errors: [{ code: 'invalid_service_mix', message: 'serviceMix must be an object.' }] };
    }
    const result = validateOfferings(serviceMix.offerings);
    const errors = result.errors.slice();

    if (!COVERAGE_DECLARATIONS.includes(serviceMix.coverage)) {
      errors.push({ code: 'invalid_coverage',
        message: 'serviceMix.coverage must declare what the entered offerings represent.' });
    }

    validatePrefilledFields(serviceMix.prefilledFields, errors);

    return { valid: errors.length === 0, errors };
  };

  const API = {
    OFFERING_LIMITS,
    CATEGORIES,
    CATEGORIES_WITHOUT_DURATION,
    APPOINTMENT_CATEGORIES,
    NOT_APPLICABLE_ALLOWED,
    mayBeNotApplicable,
    DEMAND_LEVELS,
    ROLES,
    COVERAGE_DECLARATIONS,
    COVERAGE_FACTOR,
    OFFERING_SOURCES,
    STAGE1_MEASURES,
    PREFILLED_FIELD_NAMES,
    MAX_PREFILLED_FIELDS,
    validatePrefilledFields,

    isUuid,
    newId,
    createOffering,
    renameOffering,
    replaceOffering,
    snapshotOffering,
    durationApplies,
    measureValue,
    isUsableOffering,

    validateOfferings,
    validateServiceMix
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDServiceMixOffering = API;
})();
