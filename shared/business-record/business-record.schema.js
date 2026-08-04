/* ============================================================
   CED Intelligence Platform — Business Record
   Canonical schema, v1
   ------------------------------------------------------------
   The Business Record is the permanent source of truth for the
   relationship with a business. Assessments, BIRs, purchases,
   communications, conversations, health, opportunities, and
   reassessments ATTACH to it. Nothing replaces it.

   Everything else in CIP is a document about a moment. This is
   the thing that persists between those moments.

   SPECIFICATION ONLY. Shape, vocabulary, and deterministic
   validation helpers. No persistence, no I/O, no side effects.

   Authority boundaries — this file does NOT redefine:
     lifecycle cadence      -> report.schema.js :: LIFECYCLE_POLICY
     lifecycle stages       -> report.schema.js :: VOCAB.lifecycleStage
     consent purposes       -> report.schema.js :: VOCAB.consentPurpose
     readiness bands/blockers -> report.schema.js :: READINESS_BANDS,
                                 HARD_BLOCKERS, SOFT_BLOCKERS
     approved close wording -> report.schema.js :: APPROVED_CLOSE_LANGUAGE
     prohibited data        -> report.schema.js :: PROHIBITED_DATA_CATEGORIES
     inter-engine events    -> events/event-catalog.js
   Those files stay the single source of truth. This one points
   at them so the two can never drift.

   Companions in this folder:
     identity-resolution.schema.js
     timeline-event.schema.js
     relationship.schema.js
     health-profile.schema.js
     opportunity-profile.schema.js
     memory-fact.schema.js
   Specification: docs/BUSINESS_RECORD_SPEC.md
   ============================================================ */

(() => {
  'use strict';

  const BUSINESS_RECORD_SCHEMA_VERSION = 1;

  const f = (type, meta = {}) => Object.assign({ type }, meta);

  /* Every collection declares how it is allowed to change.
     append_only         — entries are added, never edited or removed
     current_plus_history— a pointer to "current" plus an append-only chain
     mutable_current     — a working value with an audit trail of changes */
  const SECTION_MODES = ['append_only', 'current_plus_history', 'mutable_current'];

  const VOCAB = {
    /* The real world: what is happening with the business itself. */
    businessStatus: ['operating', 'temporarily_closed', 'permanently_closed', 'sold', 'unknown'],

    /* The record: what is happening with this row. Distinct from the
       relationship lifecycle, which lives in VOCAB.lifecycleStage in the BIR
       schema and is referenced, not duplicated, here. */
    recordStatus: ['active', 'merged_away', 'archived', 'quarantined'],

    businessType: [
      'sole_proprietor', 'partnership', 'llc', 'corporation',
      'franchise_unit', 'franchisor', 'multi_location_group', 'nonprofit', 'unknown'
    ],

    verificationStatus: [
      'unverified',            /* nothing corroborates this identity */
      'self_reported',         /* the business told us */
      'third_party_verified',  /* GBP, payment processor, or similar */
      'owner_confirmed',       /* a person at CED Service confirmed it */
      'disputed'               /* signals conflict; do not act on it */
    ],

    locationRole: ['primary', 'additional', 'mobile', 'virtual', 'closed'],

    personRole: [
      'owner', 'former_owner', 'manager', 'staff_contact',
      'billing_contact', 'technical_contact', 'decision_maker', 'influencer'
    ],

    contactChannel: ['email', 'phone', 'sms', 'in_person', 'web_form', 'chat', 'mail'],

    /* Privacy controls. See docs/BUSINESS_RECORD_SPEC.md; none of this is a
       claim of legal compliance. */
    dataClassification: ['public', 'internal', 'confidential', 'restricted'],
    retentionCategory: ['transactional', 'relationship', 'analytical', 'legal_hold', 'ephemeral'],
    accessBoundary: ['owner_only', 'staff', 'automation', 'partner', 'customer_self_service'],

    sectionMode: SECTION_MODES
  };

  /* ---------------------------------------------------------
     Authority
     The Business Record is longitudinal. The BIR is point-in-time.
     Mirrored by report.schema.js :: BIR_AUTHORITY; the cross-file
     consistency check asserts the two lists do not overlap.
     --------------------------------------------------------- */

  const RECORD_AUTHORITY = {
    authoritativeFor: [
      'permanent_identity',
      'current_lifecycle_state',
      'reassessment_schedule',
      'longitudinal_opportunity_history',
      'longitudinal_health',
      'relationship_history',
      'consent_history',
      'attribution_history',
      'timeline',
      'merge_and_correction_history'
    ],
    defersToBirFor: [
      'point_in_time_intelligence_from_one_evidence_set',
      'point_in_time_capacity',
      'point_in_time_risk',
      'point_in_time_opportunity',
      'point_in_time_confidence',
      'point_in_time_qualification',
      'point_in_time_recommendation'
    ],
    rules: [
      'A BIR must never overwrite Business Record state.',
      'The record may summarize the latest BIR but must retain references to all prior BIRs.',
      'Downstream engines receive both businessId and birId.',
      'A longitudinal decision uses the record plus relevant BIR history.',
      'A single-assessment recommendation may use one BIR.',
      'Where a BIR and the record disagree about current state, the record wins — the BIR describes the moment it was generated.'
    ]
  };

  /* POLARITY — which direction is "good" for every scale this record touches.
     Stated because several vocabularies across CIP reuse the same words with
     opposite meaning. */
  const POLARITY = {
    'identity.verificationStatus': { higherIs: 'better', order: 'unverified < self_reported < third_party_verified < owner_confirmed', orthogonal: ['disputed'] },
    'identity.recordStatus':       { higherIs: 'n/a', note: 'A state machine, not a ranking.' },
    'identity.businessStatus':     { higherIs: 'n/a', note: 'Describes the real world; "unknown" is orthogonal, not worst.' },
    'privacy.dataClassification':  { higherIs: 'more restrictive', order: 'public < internal < confidential < restricted' },
    'relationship.confidence':     { higherIs: 'better', range: '0..1' },
    'health.score':                { higherIs: 'better', range: '0..100', orthogonal: ['unknown band'] },
    'capacityConstraint.level':    { higherIs: 'worse', order: 'unconstrained < soft < hard < blocking', warning: 'Opposite polarity to report.schema.js CAPACITY_HEADROOM_BANDS, where "none" is the worst case.' }
  };

  /* Shape of a reference entry. The record stores pointers and thin summaries,
     never copies of the referenced document — a copy is a second source of
     truth waiting to disagree with the first. */
  const REFERENCE_SHAPE = {
    ref: f('string', { required: true, note: 'Referenced document kind, e.g. "bir", "assessment", "agreement".' }),
    id: f('string', { required: true, note: 'Id in the owning store.' }),
    at: f('iso8601', { required: true, note: 'When the referenced thing happened.' }),
    summary: f('object', { note: 'Small denormalized snapshot for display and matching. Never authoritative.' }),
    supersedes: f('string', { note: 'Prior reference id in this chain, when applicable.' }),
    sourceSystem: f('string', { note: 'Where it came from, for provenance.' })
  };

  /* ---------------------------------------------------------
     A. Identity
     --------------------------------------------------------- */

  const IDENTITY_SCHEMA = {
    /* Permanent, opaque, meaningless. Never derived from a business
       attribute, because every business attribute changes. */
    businessId: f('uuid', { required: true, immutable: true }),

    legalName: f('string', { nullable: true, note: 'As registered, when known.' }),
    displayName: f('string', { required: true, note: 'What a human would call them.' }),
    aliases: f('array<object>', {
      mode: 'append_only',
      note: '{ value, kind (legal|dba|former|misspelling|merged_from), firstSeenAt, source }. Never pruned — aliases are how future matches succeed.'
    }),

    businessStatus: f('enum', { values: VOCAB.businessStatus, default: 'unknown' }),
    recordStatus: f('enum', { values: VOCAB.recordStatus, required: true, default: 'active' }),
    businessType: f('enum', { values: VOCAB.businessType, default: 'unknown' }),

    vertical: f('string', { nullable: true, note: 'e.g. "nails". Matches assessment config meta.verticalId.' }),
    family: f('string', { nullable: true, note: 'e.g. "beauty-wellness-fitness".' }),

    primaryLocationId: f('uuid', { nullable: true, note: 'Points into locations[].' }),
    additionalLocationIds: f('array<uuid>', { note: 'Multi-location businesses. Presence of more than one is a close-readiness hard blocker.' }),

    websites: f('array<object>', { note: '{ url, domainNormalized, kind (primary|booking|social_landing), verifiedAt }.' }),
    phoneNumbers: f('array<object>', { note: '{ e164, normalized, kind (main|mobile|booking|fax), isPrimary, verifiedAt }.' }),
    emailAddresses: f('array<object>', { note: '{ address, domain, isFreeMailDomain, kind (owner|billing|general), isPrimary, verifiedAt }.' }),

    googleBusinessProfile: f('object', {
      nullable: true,
      note: '{ placeId, cid, locationId, verifiedAt }. A strong identifier — see identity-resolution.schema.js.'
    }),
    socialProfiles: f('array<object>', { note: '{ platform, handle, url, verifiedAt }.' }),

    externalSystemIds: f('array<object>', {
      mode: 'append_only',
      note: '{ system, externalId, trustLevel (trusted|untrusted), linkedAt, linkedBy }. Trusted systems may act as strong identifiers.'
    }),

    currentOwnerPersonIds: f('array<uuid>', { note: 'Supports multi-owner. Roles live in relationship.schema.js.' }),
    formerOwnerPersonIds: f('array<uuid>', { mode: 'append_only', note: 'Ownership change is a meaningful business change and triggers reassessment.' }),
    managerPersonIds: f('array<uuid>'),
    contactPersonIds: f('array<uuid>'),

    verificationStatus: f('enum', { values: VOCAB.verificationStatus, required: true, default: 'unverified' }),
    /* Vocabulary owned by identity-resolution.schema.js :: IDENTITY_LINK_STATUSES. */
    identityStatus: f('enum', { required: true, note: 'How this record was established or attached. A live record is normally linked or manually_verified.' }),
    identityResolutionId: f('uuid', { nullable: true, note: 'The resolution that created or last confirmed this record.' }),
    verificationEvidence: f('array<object>', { note: '{ signal, value, verifiedAt, verifiedBy, sourceSystem }.' }),

    createdAt: f('iso8601', { required: true, immutable: true }),
    updatedAt: f('iso8601', { required: true }),

    /* Merge pointers. Both directions are kept so history stays walkable
       in either direction and an unmerge stays possible. */
    mergedIntoBusinessId: f('uuid', { nullable: true, note: 'Set on the losing record. Implies recordStatus = merged_away.' }),
    mergedFromBusinessIds: f('array<uuid>', { mode: 'append_only', note: 'Set on the surviving record.' })
  };

  /* ---------------------------------------------------------
     C. Record structure
     Each section declares its mode. append_only sections may never
     be edited in place — corrections are new entries.
     --------------------------------------------------------- */

  const BUSINESS_RECORD_SCHEMA = {
    schemaVersion: f('integer', { required: true }),
    businessId: f('uuid', { required: true, immutable: true, note: 'Duplicated at top level for cheap lookup; must equal identity.businessId.' }),

    identity: f('object', { required: true, shape: 'IDENTITY_SCHEMA', mode: 'mutable_current' }),

    locations: f('array<object>', {
      mode: 'current_plus_history',
      note: '{ locationId, role, address, geo, openedAt, closedAt, capacityNotes }. A new location is a meaningful business change.'
    }),
    people: f('array<object>', {
      mode: 'current_plus_history',
      note: '{ personId, displayName, roles[], contactChannels[], authority, activeFrom, activeTo }. Never delete a departed person — history references them.'
    }),

    /* --- intelligence, append-only --- */
    assessments: f('array<reference>', { mode: 'append_only', note: 'Every assessment ever completed. Never overwritten.' }),
    businessIntelligenceReports: f('array<reference>', { mode: 'append_only', note: 'BIR revisions. summary carries band, score, confidence for matching without a fetch.' }),
    recommendations: f('array<reference>', { mode: 'append_only', note: 'What CIP recommended and when — including recommendations that were not taken.' }),
    opportunities: f('array<object>', { mode: 'current_plus_history', note: 'See opportunity-profile.schema.js.' }),

    /* --- commercial --- */
    offers: f('array<reference>', { mode: 'append_only' }),
    proposals: f('array<reference>', { mode: 'append_only' }),
    agreements: f('array<reference>', { mode: 'append_only', note: '{ agreementId, version, acceptedAt, method }. Contract text lives in the Knowledge Engine.' }),
    purchases: f('array<reference>', { mode: 'append_only' }),
    subscriptions: f('array<object>', { mode: 'current_plus_history', note: '{ subscriptionId, packageId, status, startedAt, endedAt, processorReference }.' }),
    payments: f('array<reference>', {
      mode: 'append_only',
      note: 'Processor references and outcomes ONLY. No payment instruments, ever — see PROHIBITED_DATA_CATEGORIES.'
    }),

    /* --- delivery --- */
    projects: f('array<object>', { mode: 'current_plus_history' }),
    onboarding: f('array<object>', { mode: 'current_plus_history', note: '{ onboardingId, packageId, startedAt, completedAt, blockers[], checklistState }.' }),
    integrations: f('array<object>', { mode: 'current_plus_history', note: '{ integrationId, system, status, connectedAt, lastHealthyAt, compatibility }.' }),

    /* --- interaction --- */
    communications: f('array<reference>', { mode: 'append_only', note: 'Metadata and outcome. Message bodies stay in the sending system.' }),
    aiConversations: f('array<reference>', {
      mode: 'append_only',
      note: 'Transcript references only. Transcripts are NOT canonical memory — see memory-fact.schema.js.'
    }),
    memoryFacts: f('array<object>', { mode: 'append_only', note: 'See memory-fact.schema.js. Superseded facts are retained.' }),

    /* --- state --- */
    lifecycle: f('object', { required: true, shape: 'LIFECYCLE_SCHEMA', mode: 'current_plus_history' }),
    healthProfiles: f('array<object>', { mode: 'append_only', note: 'See health-profile.schema.js. One per calculation period.' }),
    customerSuccessMetrics: f('array<object>', { mode: 'append_only', note: '{ periodStart, periodEnd, metrics{}, formulaVersion }.' }),
    supportCases: f('array<object>', { mode: 'current_plus_history' }),
    files: f('array<reference>', { mode: 'append_only', note: 'Pointers to a document store. No file contents in the record.' }),

    /* --- history --- */
    timeline: f('array<object>', { mode: 'append_only', required: true, note: 'See timeline-event.schema.js. The narrative spine of the record.' }),
    auditHistory: f('array<object>', { mode: 'append_only', required: true, shape: 'AUDIT_EVENT_SCHEMA' }),
    consentHistory: f('array<object>', {
      mode: 'append_only',
      required: true,
      note: '{ purpose (BIR VOCAB.consentPurpose), granted, statement, recordedAt, source, evidenceRef }. Never overwritten — a withdrawal is a new entry.'
    }),
    attributionHistory: f('array<object>', {
      mode: 'append_only',
      note: 'firstTouch is written once and never rewritten; every later touch appends.'
    }),
    reassessmentSchedule: f('object', { shape: 'REASSESSMENT_SCHEMA', mode: 'mutable_current' }),
    offerMatchHistory: f('array<object>', { mode: 'append_only', note: '{ offerId, matchedBirId, matchScore, matchReasons[], requiresRecheck, decidedAt, outcome }.' }),
    exceptions: f('array<reference>', { mode: 'append_only', note: 'Open exceptions pause outbound automation for this business.' }),

    relationships: f('array<object>', { mode: 'current_plus_history', note: 'See relationship.schema.js.' }),

    sourceSystemReferences: f('array<object>', {
      mode: 'append_only',
      note: '{ system, externalId, firstSeenAt, lastSyncedAt, trustLevel }. Provenance for everything imported.'
    }),

    privacy: f('object', { required: true, shape: 'PRIVACY_SCHEMA', mode: 'mutable_current' }),

    createdAt: f('iso8601', { required: true, immutable: true }),
    updatedAt: f('iso8601', { required: true })
  };

  /* ---------------------------------------------------------
     I. Lifecycle and reassessment
     Cadence numbers are NOT defined here. LIFECYCLE_POLICY in
     report.schema.js is the authority; this stores the state.
     --------------------------------------------------------- */

  const LIFECYCLE_SCHEMA = {
    stage: f('enum', { required: true, note: 'Values from report.schema.js VOCAB.lifecycleStage.' }),
    stageEnteredAt: f('iso8601', { required: true }),
    transitions: f('array<object>', {
      mode: 'append_only',
      required: true,
      note: '{ from, to, at, reason, triggeredBy, evidenceRef }. The full path, never just the current position.'
    }),
    lastMeaningfulInteractionAt: f('iso8601', { nullable: true, note: 'Anchors the unconverted-lead clock. A delivery is not an interaction; a reply is.' }),
    lastMeaningfulInteractionKind: f('string', { nullable: true }),
    nonresponseCount: f('integer', { default: 0, note: 'Drives the 90/180/365 backoff.' }),
    suppression: f('object', { note: '{ suppressedUntil, reason, setBy, setAt }. A veto over all outbound automation.' }),
    staleDataFlags: f('array<string>', { note: 'e.g. capacity_stale, technology_stale. Each blocks specific automated decisions.' })
  };

  const REASSESSMENT_SCHEMA = {
    originalAssessmentRef: f('reference', { nullable: true, immutable: true, note: 'The first assessment ever. Never changes.' }),
    latestAssessmentRef: f('reference', { nullable: true }),
    quarterlyReassessmentRefs: f('array<reference>', { mode: 'append_only' }),
    annualFullReassessmentRefs: f('array<reference>', { mode: 'append_only' }),
    unconvertedLeadReassessmentRefs: f('array<reference>', { mode: 'append_only' }),
    nextReassessmentDueAt: f('iso8601', { nullable: true }),
    nextReassessmentKind: f('enum', { values: ['quick_recheck', 'quarterly_review', 'annual_full', 'change_triggered'], nullable: true }),
    lastReassessmentCompletedAt: f('iso8601', { nullable: true }),
    dataFreshness: f('enum', { note: 'Values from report.schema.js VOCAB.dataFreshness.' }),
    quickRecheckRequired: f('boolean', { default: false, note: 'True once the latest BIR passes LIFECYCLE_POLICY.quickRecheckRequiredAfterDays.' })
  };

  /* ---------------------------------------------------------
     J. Close-readiness support surface
     The record does not decide anything. It guarantees the
     Closing Engine can find each input in one known place.
     --------------------------------------------------------- */

  const CLOSE_READINESS_INPUT_MAP = {
    packageFit: 'businessIntelligenceReports[current].summary.packageRecommendation',
    closeReadiness: 'businessIntelligenceReports[current].summary.closeReadinessBand',
    decisionAuthority: 'people[].authority + memoryFacts[category=authority]',
    budgetSignal: 'memoryFacts[category=budget] + payments[] history',
    urgency: 'memoryFacts[category=intent] + timeline recency',
    capacity: 'businessIntelligenceReports[current].summary.capacityHeadroomBand + memoryFacts[category=capacity]',
    implementationCompatibility: 'integrations[].compatibility + memoryFacts[category=technology]',
    unresolvedObjections: 'memoryFacts[category=risk, status=open] + supportCases[open]',
    scopeStandardization: 'opportunities[].exclusions + identity.additionalLocationIds',
    customBlockers: 'exceptions[open] + identity.additionalLocationIds + integrations[unsupported]',
    consent: 'consentHistory[] resolved per purpose at send time',
    eligibility: 'lifecycle.stage + suppression + exceptions[open]',
    existingServices: 'subscriptions[status=active]',
    paymentStatus: 'payments[] most recent outcome + subscriptions[].status',
    agreementStatus: 'agreements[] most recent accepted version'
  };

  /* The approved high-readiness sentence is NOT duplicated here.
     report.schema.js :: APPROVED_CLOSE_LANGUAGE.ask_for_sale is the only
     executable copy; duplicating it would create a second source of truth for
     compliance-critical wording. */
  const APPROVED_CLOSE_LANGUAGE_REF = {
    authority: 'shared/business-intelligence/report.schema.js :: APPROVED_CLOSE_LANGUAGE',
    key: 'ask_for_sale',
    usableWhen: 'closeReadinessBand === "ask_for_sale" and no hard blockers'
  };

  /* ---------------------------------------------------------
     L. Audit
     --------------------------------------------------------- */

  const AUDIT_EVENT_SCHEMA = {
    auditId: f('uuid', { required: true }),
    at: f('iso8601', { required: true }),
    actor: f('object', { required: true, note: '{ kind (human|engine|integration|system), id, displayName }.' }),
    action: f('string', { required: true }),
    reason: f('string', { required: true, note: 'Why, in words. A change with no reason is not auditable.' }),
    targetPath: f('string', { required: true, note: 'Dotted path into the record.' }),
    previousValue: f('any', { nullable: true }),
    newValue: f('any', { nullable: true }),
    correlationId: f('string', { nullable: true }),
    approvalRef: f('string', { nullable: true, note: 'Required for owner-approved actions.' }),
    mergeRef: f('string', { nullable: true }),
    correctionRef: f('string', { nullable: true, note: 'Points at the correcting timeline event.' }),
    evidenceRefs: f('array<string>'),
    retentionCategory: f('enum', { values: VOCAB.retentionCategory })
  };

  /* ---------------------------------------------------------
     M. Privacy
     Controls only. Nothing here is a claim of legal compliance;
     all regulatory language requires professional review.
     --------------------------------------------------------- */

  const PRIVACY_SCHEMA = {
    dataClassification: f('enum', { values: VOCAB.dataClassification, required: true, default: 'confidential' }),
    retentionCategory: f('enum', { values: VOCAB.retentionCategory, required: true }),
    accessBoundaries: f('array<enum>', { values: VOCAB.accessBoundary }),
    deletionRequests: f('array<object>', {
      mode: 'append_only',
      note: '{ requestedAt, requestedBy, scope, status, completedAt, retainedForLegalHold[] }. The request itself is retained even after data is removed.'
    }),
    exportRequests: f('array<object>', { mode: 'append_only', note: '{ requestedAt, format, deliveredAt, scope }.' }),
    legalHold: f('object', { nullable: true, note: '{ active, reason, setBy, setAt }. Overrides deletion.' }),
    minimumNecessaryReview: f('object', { note: '{ lastReviewedAt, reviewedBy, fieldsRemoved[] }.' }),
    /* Categories from report.schema.js PROHIBITED_DATA_CATEGORIES may never
       appear anywhere in this record, including audit and timeline payloads. */
    prohibitedDataAuthority: f('string', { note: 'report.schema.js :: PROHIBITED_DATA_CATEGORIES' }),
    verticalRestrictions: f('array<object>', {
      note: 'Per-vertical additional limits. medical/dental expansion must define these BEFORE any such vertical launches; absence of a restriction is not permission.'
    })
  };

  /* ---------------------------------------------------------
     O. Deterministic validation helpers
     Pure functions. No persistence, no network, no mutation.
     --------------------------------------------------------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);
  const isIso8601 = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

  const REQUIRED_SECTIONS = [
    'schemaVersion', 'businessId', 'identity', 'lifecycle',
    'timeline', 'auditHistory', 'consentHistory', 'privacy'
  ];

  /* Structural validation only. It cannot tell you a record is correct —
     only that it is not obviously malformed. */
  const validateBusinessRecord = record => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!record || typeof record !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'Record must be an object.' }] };
    }

    REQUIRED_SECTIONS.forEach(key => {
      if (record[key] === undefined || record[key] === null) push('missing_section', `Required section missing: ${key}`);
    });

    if (record.schemaVersion !== BUSINESS_RECORD_SCHEMA_VERSION) {
      push('schema_version_mismatch', `Expected schemaVersion ${BUSINESS_RECORD_SCHEMA_VERSION}, got ${record.schemaVersion}.`);
    }
    if (!isUuid(record.businessId)) push('invalid_business_id', 'businessId must be a UUID.');

    const id = record.identity;
    if (id) {
      if (!isUuid(id.businessId)) push('invalid_identity_business_id', 'identity.businessId must be a UUID.');
      if (id.businessId !== record.businessId) push('business_id_mismatch', 'identity.businessId must equal record.businessId.');
      if (!id.displayName) push('missing_display_name', 'identity.displayName is required.');
      if (id.recordStatus && !VOCAB.recordStatus.includes(id.recordStatus)) push('invalid_record_status', `recordStatus not in vocabulary: ${id.recordStatus}`);
      if (id.businessStatus && !VOCAB.businessStatus.includes(id.businessStatus)) push('invalid_business_status', `businessStatus not in vocabulary: ${id.businessStatus}`);
      if (id.verificationStatus && !VOCAB.verificationStatus.includes(id.verificationStatus)) push('invalid_verification_status', `verificationStatus not in vocabulary: ${id.verificationStatus}`);
      if (id.createdAt && !isIso8601(id.createdAt)) push('invalid_created_at', 'identity.createdAt must be ISO 8601.');

      /* Merge invariants. */
      if (id.mergedIntoBusinessId) {
        if (!isUuid(id.mergedIntoBusinessId)) push('invalid_merge_target', 'mergedIntoBusinessId must be a UUID.');
        if (id.mergedIntoBusinessId === record.businessId) push('self_merge', 'A record cannot be merged into itself.');
        if (id.recordStatus !== 'merged_away') push('merge_status_inconsistent', 'A record with mergedIntoBusinessId must have recordStatus "merged_away".');
      }
      if (id.recordStatus === 'merged_away' && !id.mergedIntoBusinessId) {
        push('merge_target_missing', 'recordStatus "merged_away" requires mergedIntoBusinessId.');
      }
      if (Array.isArray(id.mergedFromBusinessIds)) {
        if (id.mergedFromBusinessIds.some(x => !isUuid(x))) push('invalid_merge_source', 'mergedFromBusinessIds must all be UUIDs.');
        if (id.mergedFromBusinessIds.includes(record.businessId)) push('self_merge', 'mergedFromBusinessIds must not include this record.');
        if (id.mergedIntoBusinessId && id.mergedFromBusinessIds.length) {
          push('merge_direction_conflict', 'A record cannot be both a merge target and merged away.');
        }
      }
      if (id.primaryLocationId && !isUuid(id.primaryLocationId)) push('invalid_primary_location', 'primaryLocationId must be a UUID.');
    }

    if (record.privacy && record.privacy.dataClassification &&
        !VOCAB.dataClassification.includes(record.privacy.dataClassification)) {
      push('invalid_data_classification', `dataClassification not in vocabulary: ${record.privacy.dataClassification}`);
    }

    ['assessments', 'businessIntelligenceReports', 'timeline', 'auditHistory', 'consentHistory']
      .forEach(key => {
        if (record[key] !== undefined && !Array.isArray(record[key])) {
          push('append_only_not_array', `${key} must be an array (append-only section).`);
        }
      });

    return { valid: errors.length === 0, errors };
  };

  const API = {
    BUSINESS_RECORD_SCHEMA_VERSION,
    BUSINESS_RECORD_SCHEMA,
    IDENTITY_SCHEMA,
    LIFECYCLE_SCHEMA,
    REASSESSMENT_SCHEMA,
    AUDIT_EVENT_SCHEMA,
    PRIVACY_SCHEMA,
    REFERENCE_SHAPE,
    CLOSE_READINESS_INPUT_MAP,
    APPROVED_CLOSE_LANGUAGE_REF,
    REQUIRED_SECTIONS,
    RECORD_AUTHORITY,
    POLARITY,
    VOCAB,
    isUuid,
    isIso8601,
    validateBusinessRecord
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDBusinessRecordSchema = API;
})();
