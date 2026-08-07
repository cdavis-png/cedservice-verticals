/* ============================================================
   CED Intelligence Platform — review-type registry
   ------------------------------------------------------------
   One place that answers: for THIS review type, which engine
   generates the report, which validator checks it, and which BIR
   schema version does it produce?

   It exists because "assessment" stopped meaning one thing. The
   Growth Review produces a BIR v4; the Quick Service Mix Review
   produces a BIR v5 with reportType 'service_mix'. Neither is a
   version of the other, and a single global BIR_SCHEMA_VERSION
   can only describe one of them.

   Two rules this file enforces by construction:

     · Growth reports stay at v4 and stay immutable. Nothing here
       bumps BIR_SCHEMA_VERSION; it is the Growth generator's
       version and is left alone.
     · Supersession is closed within a review type. A Service Mix
       report may reference a Growth report and may never
       supersede one. The database enforces the same rule in
       migration 0006, because a constraint in one layer is a
       convention and a constraint in two is a rule.

   Classic script on purpose.
   ============================================================ */

(() => {
  'use strict';

  const req = name => (typeof module !== 'undefined' && module.exports) ? require(name) : null;

  const schema = req('./report.schema.js') ||
    (typeof window !== 'undefined' ? window.CEDBusinessIntelligenceSchema : null);
  const growth = req('./generate-bir.js') ||
    (typeof window !== 'undefined' ? window.CEDGenerateBir : null);
  const serviceMix = req('../service-mix-engine/generate-service-mix-bir.js') ||
    (typeof window !== 'undefined' ? window.CEDServiceMixBir : null);

  /* The vocabulary. Mirrored by the review_type CHECK constraint in
     migration 0006; the two must not drift. */
  const REVIEW_TYPES = ['growth_review', 'service_mix'];

  /* Every row that predates review types is a Growth Review, which is why
     this is both the column default and the backfill value. */
  const DEFAULT_REVIEW_TYPE = 'growth_review';

  const isReviewType = value => REVIEW_TYPES.includes(value);

  const REGISTRY = {
    growth_review: {
      id: 'growth_review',
      label: 'Growth Review',
      /* Read from the Growth schema rather than restated, so a future Growth
         version bump reaches this registry without an edit here. */
      get birSchemaVersion() { return schema ? schema.BIR_SCHEMA_VERSION : null; },
      reportType: 'growth',
      /* Payload versions the endpoint accepts for this review type. */
      payloadSchemaVersions: [2, 3, 4, 5],
      /* Growth owns the legacy business_records.current_bir_id pointer. It
         predates review types and is not repurposed — see
         docs/SERVICE_MIX_REVIEW.md section 8. */
      maintainsLegacyCurrentBir: true,
      timelineEvents: { completed: 'assessment.completed', reportGenerated: 'bir.generated' },
      generate: input => growth.generateBir(input),
      validate: report => growth.validateGeneratedBir(report)
    },

    service_mix: {
      id: 'service_mix',
      label: 'Quick Service Mix Review',
      get birSchemaVersion() {
        return serviceMix ? serviceMix.SERVICE_MIX_BIR_SCHEMA_VERSION : null;
      },
      reportType: 'service_mix',
      payloadSchemaVersions: [6],
      maintainsLegacyCurrentBir: false,
      timelineEvents: {
        completed: 'service_mix.completed',
        reportGenerated: 'service_mix_bir.generated'
      },
      generate: input => serviceMix.generateServiceMixBir(input),
      validate: report => serviceMix.validateServiceMixBir(report)
    }
  };

  const entryFor = reviewType => {
    const entry = REGISTRY[reviewType];
    if (!entry) throw new Error(`review-registry: unknown reviewType "${reviewType}".`);
    return entry;
  };

  /* The routing function. A caller names the review type and gets back a
     report, without knowing which engine produced it. */
  const generateReport = ({ reviewType = DEFAULT_REVIEW_TYPE, ...input } = {}) =>
    entryFor(reviewType).generate(input);

  const validateReport = (reviewType, report) => entryFor(reviewType).validate(report);

  const birSchemaVersionFor = reviewType => entryFor(reviewType).birSchemaVersion;

  /* Every BIR schema version any review type can currently produce, plus the
     versions already written and still readable. Migration 0006's CHECK
     constraint permits exactly this range. */
  const SUPPORTED_BIR_SCHEMA_VERSIONS = [2, 3, 4, 5];

  /* A submission's review type, read defensively. A payload with no
     declaration predates review types and is a Growth Review, which is what
     it was — any other default would retroactively relabel history. */
  const readReviewType = submission => {
    const declared = submission && submission.reviewType;
    return isReviewType(declared) ? declared : DEFAULT_REVIEW_TYPE;
  };

  /* Supersession is closed within a review type AND within a business.
     Returns a reason rather than a boolean, because "why not" is what a
     caller has to log. */
  const maySupersede = (candidate, existing) => {
    if (!existing) return { allowed: true, reason: null };
    if (!candidate || !existing) return { allowed: false, reason: 'missing_report' };
    if (candidate.reviewType !== existing.reviewType) {
      return { allowed: false, reason: 'review_type_mismatch' };
    }
    if (!candidate.businessId || candidate.businessId !== existing.businessId) {
      return { allowed: false, reason: 'business_mismatch' };
    }
    return { allowed: true, reason: null };
  };

  const API = {
    REVIEW_TYPES,
    DEFAULT_REVIEW_TYPE,
    SUPPORTED_BIR_SCHEMA_VERSIONS,
    REGISTRY,
    isReviewType,
    entryFor,
    generateReport,
    validateReport,
    birSchemaVersionFor,
    readReviewType,
    maySupersede
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDReviewRegistry = API;
})();
