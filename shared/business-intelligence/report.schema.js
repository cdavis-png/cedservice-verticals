/* ============================================================
   CED Intelligence Platform — Business Intelligence Report
   Canonical schema, v1
   ------------------------------------------------------------
   The BIR is the single record every downstream engine reads.
   Engines must read the BIR, not raw form answers, wherever the
   information they need is represented here.

   This file is a SPECIFICATION. It declares shape, units,
   vocabularies, and the deterministic constants that govern
   close readiness, capacity, confidence, and reassessment. It
   deliberately contains no transformation logic, no validator,
   and no I/O — those belong to the Business Intelligence Engine,
   which does not exist yet.

   Companion documents:
     docs/BUSINESS_INTELLIGENCE_REPORT.md  — field semantics
     docs/CIP_ARCHITECTURE.md              — who reads what
     docs/AUTOMATION_POLICY.md             — what may act on it

   Guardrails this schema exists to enforce:
     - deterministic math, never model-generated numbers
     - opportunity expressed as a RANGE, never a single promise
     - every derived figure carries confidence and evidence
     - capacity caps opportunity; growth is never guaranteed
     - consent recorded per purpose, never bundled
     - history is append-only; BIRs supersede, never overwrite
     - prohibited data never enters this record
   ============================================================ */

(() => {
  'use strict';

  /* v2 (current) — identity contract changed: businessId (UUID) is canonical,
                    businessKey is deprecated and retained only as provenance.
     v1 (legacy)  — identity.businessKey, a string with no defined resolution
                    rule. A v1 businessKey must NEVER be reinterpreted as a
                    businessId. See docs/decisions/ADR-001. */
  const BIR_SCHEMA_VERSION = 4;
  const BIR_SCHEMA_VERSION_HISTORY = [
    { version: 1, status: 'legacy', note: 'identity.businessKey; no identity resolution.' },
    { version: 2, status: 'superseded', note: 'identity.businessId (UUID) canonical; businessKey deprecated.' },
    { version: 3, status: 'superseded', note: 'Assessment Intelligence Expansion: intelligenceDimensions, populated capacity/decision/budget/implementation/objection evidence, capacity-aware opportunity clamp.' },
    { version: 4, status: 'current', note: 'Two-stage progressive assessment: assessmentProgress, result states, preliminary versus full confidence, stage-scoped close readiness.' }
  ];

  /* Field descriptor helper. Keeps one field per line and readable. */
  const f = (type, meta = {}) => Object.assign({ type }, meta);

  /* ---------------------------------------------------------
     Controlled vocabularies
     --------------------------------------------------------- */

  const VOCAB = {
    confidenceBand: ['low', 'medium', 'high'],
    readinessBand: ['educate', 'clarify', 'present_offer', 'ask_for_sale', 'escalate'],

    /* Where the visitor has got to, and what may therefore be said to them.
       An ordered ladder: a later state never reverts to an earlier one for the
       same journey, because a Stage 2 report supersedes a Stage 1 report
       rather than replacing it. */
    resultState: [
      'preliminary_results',   /* Stage 1 complete and nothing further is outstanding */
      'fit_review_available',  /* Stage 1 complete; Stage 2 evidence would improve accuracy */
      'fit_review_complete',   /* Stage 2 complete; full close-readiness evidence present */
      'activation_ready'       /* Stage 2 complete AND the deterministic rules support an offer */
    ],

    /* Preliminary confidence is not "low confidence". It is confidence in a
       smaller claim: everything Stage 1 asked about is measured, and the
       report says plainly what it did not ask. */
    confidenceKind: ['preliminary', 'full'],
    capacityHeadroom: ['none', 'limited', 'moderate', 'ample', 'unknown'],
    oversellRisk: ['low', 'moderate', 'high', 'unknown'],
    qualificationOutcome: ['qualified', 'nurture', 'disqualified', 'insufficient_data'],
    lifecycleStage: [
      'lead_new', 'lead_assessed', 'lead_nurture', 'lead_dormant',
      'customer_onboarding', 'customer_active', 'customer_at_risk',
      'customer_churned', 'excluded'
    ],
    decisionAuthority: ['sole_owner', 'shared', 'not_authorized', 'unknown'],
    urgency: ['immediate', 'this_quarter', 'exploring', 'none', 'unknown'],
    packageId: ['starter', 'salon-growth', 'scale', 'custom', 'none'],
    evidenceKind: ['answer', 'derived', 'policy', 'observed_behavior', 'external'],
    dataFreshness: ['fresh', 'aging', 'stale', 'expired'],
    /* Consent purposes are recorded separately and never bundled.
       transactional_* are service messages, not marketing. */
    /* Communication purposes. results_delivery and transactional_service rest on
       a service relationship rather than marketing consent — see
       docs/AUTOMATION_POLICY.md section 10. Legal basis is pending professional
       review; nothing here is a compliance claim. */
    consentPurpose: [
      'results_delivery',        /* requested by the recipient: deliver the assessment */
      'transactional_service',   /* service relationship: agreement, receipt, onboarding, alerts */
      'email_marketing',         /* opt-in consent */
      'sms_marketing'            /* opt-in consent */
    ],

    /* How a BIR is attached to a Business Record. MIRRORS
       business-record/identity-resolution.schema.js :: IDENTITY_LINK_STATUSES,
       which is the authority. The cross-file consistency check asserts these
       two lists stay identical. */
    identityStatus: [
      'legacy_unresolved',   /* pre-businessId record; never auto-reinterpreted */
      'resolution_pending',  /* resolution running or queued */
      'linked',              /* attached automatically at high confidence */
      'manually_verified',   /* attached by a person */
      'merge_required',      /* duplicate suspected; blocked pending owner approval */
      'rejected_match'       /* a proposed link was reviewed and refused */
    ]
  };

  /* ---------------------------------------------------------
     Enum polarity
     Which direction is "good". Stated explicitly because several
     vocabularies here and in the Business Record use the same
     words with opposite meaning.
     --------------------------------------------------------- */

  const POLARITY = {
    'estimateConfidence.score':        { higherIs: 'better', range: '0..1' },
    'confidenceBand':                  { higherIs: 'better', order: 'low < medium < high' },
    'closeReadinessProfile.score':     { higherIs: 'closer to a sale', range: '0..100' },
    'readinessBand':                   { higherIs: 'closer to a sale', order: 'educate < clarify < present_offer < ask_for_sale', orthogonal: ['escalate'] },
    'capacityHeadroom':                { higherIs: 'better', order: 'none < limited < moderate < ample', orthogonal: ['unknown'], warning: '"none" means NO HEADROOM, the worst case. Do not confuse with capacityConstraintLevel "unconstrained", which is the best case.' },
    'oversellRisk':                    { higherIs: 'worse', order: 'low < moderate < high', orthogonal: ['unknown'] },
    'riskProfile.*':                   { higherIs: 'worse', order: 'low < moderate < high', orthogonal: ['unknown'] },
    'qualificationOutcome':            { higherIs: 'n/a', note: 'Not a scale. insufficient_data is orthogonal to disqualified, never a worse version of it.' },
    'dataFreshness':                   { higherIs: 'worse', order: 'fresh < aging < stale < expired' }
  };

  /* ---------------------------------------------------------
     Deterministic constants
     These are the authority. Documentation quotes them; it does
     not restate them. Changing a number here changes behavior.
     --------------------------------------------------------- */

  /* Point estimate -> range. The assessment produces a deterministic
     point figure; confidence decides how wide the honest range is.
     A narrower band is never permitted than the tier allows. */
  const RANGE_SPREAD_BY_CONFIDENCE = {
    high:   { low: 0.85, high: 1.15 },
    medium: { low: 0.70, high: 1.30 },
    low:    { low: 0.50, high: 1.50 }
  };

  const CONFIDENCE_BANDS = [
    { id: 'low',    min: 0.00, max: 0.49 },
    { id: 'medium', min: 0.50, max: 0.79 },
    { id: 'high',   min: 0.80, max: 1.00 }
  ];

  /* Weighted close-readiness signals. Weights must total 1. */
  const CLOSE_READINESS_SIGNALS = [
    { key: 'packageFit',                  weight: 0.15 },
    { key: 'decisionAuthority',           weight: 0.15 },
    { key: 'urgency',                     weight: 0.12 },
    { key: 'capacity',                    weight: 0.12 },
    { key: 'budgetSignals',               weight: 0.12 },
    { key: 'implementationCompatibility', weight: 0.10 },
    { key: 'objectionsResolved',          weight: 0.08 },
    { key: 'estimateConfidence',          weight: 0.06 },
    { key: 'engagementBehavior',          weight: 0.06 },
    { key: 'scopeStandardization',        weight: 0.04 }
  ];

  /* Score -> band. Escalate is NOT on this ladder; see blockers. */
  const READINESS_BANDS = [
    { id: 'educate',       min: 0,  max: 39 },
    { id: 'clarify',       min: 40, max: 59 },
    { id: 'present_offer', min: 60, max: 79 },
    { id: 'ask_for_sale',  min: 80, max: 100 }
  ];

  /* Any hard blocker routes to a human regardless of score. */
  const HARD_BLOCKERS = [
    'custom_pricing_requested',
    'custom_terms_requested',
    'unsupported_integration',
    'multiple_locations',
    'compliance_concern',
    'authority_absent',            /* respondent states they cannot decide */
    'prohibited_data_detected',
    'consent_missing_for_purpose'
  ];

  /* Soft blockers cap the band without forcing escalation. */
  const SOFT_BLOCKERS = {
    unknown_decision_authority: 'clarify',
    low_estimate_confidence:    'present_offer',
    unresolved_objection:       'present_offer',
    /* A concern the prospect has already been burned by, or does not believe
       the product works, is not answered by presenting an offer harder. */
    severe_objection:           'clarify',
    capacity_oversell_risk:     'clarify',
    /* Cannot decide alone AND cannot name who can. An approval path turns this
       from a blocker into a next step, which is why its absence is the test. */
    no_defined_approval_path:   'clarify',
    stale_assessment_data:      'clarify'
  };

  /* ---------------------------------------------------------
     Two-stage progressive assessment
     --------------------------------------------------------- */

  /* What each stage is permitted to conclude.

     The rule that matters: Stage 1 MAY NEVER ask for the sale. It has not
     asked about authority, budget, timing, integration, or objections, so a
     high score there measures a promising operational picture and nothing
     about whether this business should be sold to today. Capping the band is
     how that stays true no matter how the weights move later. */
  const STAGE_POLICY = {
    1: {
      id: 'stage1',
      name: 'Growth Review',
      maxBand: 'present_offer',
      confidenceKind: 'preliminary',
      closeReadinessProvisional: true,
      mayUseApprovedCloseLanguage: false
    },
    2: {
      id: 'stage2',
      name: 'Fit and Activation Review',
      maxBand: null,
      confidenceKind: 'full',
      closeReadinessProvisional: false,
      mayUseApprovedCloseLanguage: true
    }
  };

  /* The close-readiness signals Stage 1 can actually evidence.

     Stage 1 scores ONLY these, with the weights renormalised across them.
     Scoring the rest as zero would be arithmetically tidy and substantively
     wrong: it would report "not asked" as "answered badly", and no Stage 1
     result could ever exceed roughly 35 however good the business looked.
     The excluded signals are still listed, still zero, and still flagged so
     nothing downstream mistakes a renormalised score for a complete one. */
  const STAGE1_READINESS_SIGNALS = [
    'packageFit',
    'capacity',
    'estimateConfidence',
    'engagementBehavior',
    'scopeStandardization'
  ];

  /* Soft blockers that exist only because Stage 2 has not been asked yet.
     Applying them at Stage 1 would cap every preliminary result at `clarify`
     for the sole reason that we chose not to ask — which is the friction this
     whole split exists to remove. They apply in full at Stage 2. */
  const STAGE2_EVIDENCE_BLOCKERS = [
    'unknown_decision_authority',
    'no_defined_approval_path',
    'unresolved_objection',
    'severe_objection'
  ];

  /* The only approved high-readiness close sentence. Never paraphrased,
     never generated, never combined with an invented incentive. */
  const APPROVED_CLOSE_LANGUAGE = {
    ask_for_sale:
      'Based on your assessment results, the next logical step is to activate the system and begin onboarding.'
  };

  /* Capacity governs how much recovered demand can be credibly served.
     headroomRatio = additionalCapacity90Day / currentThroughput90Day */
  const CAPACITY_HEADROOM_BANDS = [
    { id: 'none',     minRatio: 0.00, maxRatio: 0.02, oversellRisk: 'high' },
    { id: 'limited',  minRatio: 0.02, maxRatio: 0.10, oversellRisk: 'moderate' },
    { id: 'moderate', minRatio: 0.10, maxRatio: 0.25, oversellRisk: 'low' },
    { id: 'ample',    minRatio: 0.25, maxRatio: Infinity, oversellRisk: 'low' }
  ];

  /* Reassessment and contact cadence, in days. */
  const LIFECYCLE_POLICY = {
    customerQuarterlyReviewDays: 90,
    customerAnnualFullReassessDays: 365,
    unconvertedLeadReassessDays: 90,
    nonresponseBackoffDays: [90, 180, 365],   /* then lead_dormant */
    nonresponseDormantAfterCycles: 3,
    freshnessDays: { fresh: 90, aging: 180, stale: 365 },  /* beyond stale = expired */
    quickRecheckRequiredAfterDays: 180,
    maxOutboundContactsPer30Days: 4,
    quietPeriodAfterPurchaseDays: 14,
    quietPeriodAfterDeclineDays: 30
  };

  /* Categories that must never appear in a BIR, in any section. */
  const PROHIBITED_DATA_CATEGORIES = [
    'payment_instrument',      /* card numbers, bank/routing, tokens are held by the processor only */
    'credential',              /* passwords, API keys, access tokens */
    'government_identifier',   /* SSN and equivalents */
    'sensitive_health'         /* diagnosis, medication, treatment, patient identifiers */
  ];

  /* ---------------------------------------------------------
     Report shape
     --------------------------------------------------------- */

  const BUSINESS_INTELLIGENCE_REPORT_SCHEMA = {
    schemaVersion: f('integer', { required: true, note: 'Equals BIR_SCHEMA_VERSION at generation time.' }),

    /* ---- identity and provenance ---- */
    identity: {
      birId: f('uuid', { required: true, note: 'Immutable id for this BIR revision.' }),

      /* Canonical permanent identifier, owned by the Business Record.
         Null only while identityStatus is resolution_pending or legacy_unresolved. */
      businessId: f('uuid', { required: true, nullable: true, note: 'Canonical. Assigned by the Business Record; a BIR never mints one.' }),
      identityStatus: f('enum', { required: true, values: 'VOCAB.identityStatus', note: 'How this BIR is attached to a Business Record.' }),
      identityResolutionId: f('uuid', { nullable: true, note: 'The resolution that produced the link, when there was one.' }),

      /* DEPRECATED in v2. Present only on migrated v1 reports, as provenance.
         Never treat this as a businessId, and never derive one from it. */
      legacyBusinessKey: f('string', { deprecated: true, nullable: true, note: 'Provenance only. Read-only. See ADR-001.' }),

      verticalId: f('string', { required: true, note: 'e.g. "nails". Matches assessment config meta.verticalId.' }),
      assessmentSessionId: f('uuid', { note: 'From the assessment payload. One per device session.' }),
      submissionId: f('uuid', { note: 'From the assessment payload. Idempotency key of the source submission.' }),
      customerId: f('string', { note: 'Set once the business becomes a customer.' })
    },

    provenance: {
      generatedAt: f('iso8601', { required: true }),
      generatedBy: f('string', { required: true, note: 'BIE version that produced this report.' }),
      assessmentVersion: f('string', { required: true, note: 'Vertical assessment content version.' }),
      payloadSchemaVersion: f('integer', { required: true, note: 'Submission payload schemaVersion consumed.' }),
      inputHash: f('string', { required: true, note: 'Hash of the normalized source answers. Two identical inputs must yield the same hash.' }),
      supersedes: f('uuid', { note: 'Previous birId for this businessKey. Append-only: never overwrite.' }),
      supersededBy: f('uuid', { note: 'Set when a newer BIR replaces this one as current.' }),
      isCurrent: f('boolean', { required: true }),
      sourceEvents: f('array<string>', { note: 'Event ids that contributed, for audit.' })
    },

    /* ---- how far through the review this report was generated ---- */
    assessmentProgress: {
      assessmentStageCompleted: f('integer', { required: true, values: [1, 2], note: 'Highest stage completed when this report was generated.' }),
      stage1CompletedAt: f('iso8601', { nullable: true }),
      stage2CompletedAt: f('iso8601', { nullable: true, note: 'Null on every preliminary report.' }),
      resultState: f('enum', { required: true, values: 'VOCAB.resultState' }),
      confidenceKind: f('enum', { required: true, values: 'VOCAB.confidenceKind', note: 'preliminary reports measure a smaller claim, not a worse one.' }),
      closeReadinessProvisional: f('boolean', { required: true, note: 'True whenever close readiness was computed without the Stage 2 evidence.' }),
      missingStage2Evidence: f('array<string>', { note: 'Stage 2 field names not yet answered. Empty on a complete fit review.' }),
      stage1SubmissionId: f('uuid', { nullable: true, note: 'The preliminary submission this one continues. Null on a Stage 1 report.' }),
      supersedesPreliminaryBir: f('boolean', { note: 'True when this full report supersedes a preliminary one. Both remain readable.' })
    },

    /* ---- profiles ---- */
    businessProfile: {
      displayName: f('string', { required: true }),
      industry: f('string', { note: 'Vertical family, e.g. beauty-wellness-fitness.' }),
      subIndustry: f('string', { note: 'e.g. nails.' }),
      locationCount: f('integer', { note: 'NOT COLLECTED TODAY. Multi-location is a hard escalation trigger.' }),
      yearsInBusiness: f('integer', { note: 'Not collected today.' }),
      staffCount: f('integer', { note: 'From technicians in the nails assessment.' }),
      serviceArea: f('string', { note: 'Not collected today.' })
    },

    capacityProfile: {
      currentThroughputPerMonth: f('number', { unit: 'appointments', note: 'appointmentsDay x daysOpen.' }),
      unusedCapacityPerMonth: f('number', { unit: 'appointments', note: 'Derived from stated comfortable additional volume.' }),
      maxPracticalCapacityPerMonth: f('number', { unit: 'appointments', note: 'Ceiling under current staffing, hours, and space.' }),
      additionalCapacity90Day: f('number', { unit: 'appointments', note: 'Answer to the 90-day comfort question. Primary input.' }),
      headroomRatio: f('number', { note: 'additionalCapacity90Day / currentThroughput over the same window.' }),
      headroomBand: f('enum', { values: VOCAB.capacityHeadroom }),
      staffingExpandable: f('enum', { values: ['yes', 'limited', 'no', 'unknown'] }),
      hoursExpandable: f('enum', { values: ['yes', 'limited', 'no', 'unknown'] }),
      spaceOrEquipmentConstrained: f('enum', { values: ['yes', 'no', 'unknown'] }),
      willingnessToExpand: f('enum', { values: ['eager', 'open', 'reluctant', 'no', 'unknown'] }),
      operationalReadiness: f('score0to100', { note: 'Can the business absorb new demand without degrading service.' }),
      oversellRisk: f('enum', { values: VOCAB.oversellRisk, note: 'High risk clamps the opportunity range and caps readiness.' })
    },

    operationsProfile: {
      appointmentProtectionScore: f('score0to100', { note: 'From the assessment dimension of the same meaning.' }),
      missedOpportunityScore: f('score0to100'),
      noShowsPerWeek: f('number'),
      cancellationsPerWeek: f('number'),
      reminderMaturity: f('enum', { values: ['none', 'manual_inconsistent', 'manual_consistent', 'automated'] }),
      waitlistUsage: f('enum', { values: ['none', 'occasional', 'consistent'] }),
      averageTicket: f('number', { unit: 'USD' }),
      daysOpenPerMonth: f('number')
    },

    customerProfile: {
      retentionScore: f('score0to100'),
      rebookingMaturity: f('enum', { values: ['rare', 'sometimes', 'usual', 'always'] }),
      reactivationMaturity: f('enum', { values: ['never', 'occasional', 'monthly', 'automated'] }),
      inactiveCustomerCount: f('integer'),
      reviewCount: f('integer'),
      reviewRating: f('number'),
      reputationScore: f('score0to100')
    },

    technologyProfile: {
      bookingSystem: f('string', { note: 'Not collected today. Required before integration compatibility can be scored.' }),
      integrationCompatibility: f('enum', { values: ['supported', 'partial', 'unsupported', 'unknown'] }),
      knownBlockers: f('array<string>')
    },

    marketingProfile: {
      marketingScore: f('score0to100'),
      promotionCadence: f('enum', { values: ['never', 'few_per_year', 'monthly', 'tracked_consistent'] }),
      primaryChallenge: f('string', { note: 'Self-reported. Useful for messaging, not for scoring.' }),
      attribution: {
        firstTouch: f('object', { note: 'url, referrer, utm, occurredAt. Immutable once set.' }),
        latestTouch: f('object', { note: 'url, referrer, utm, occurredAt at completion.' })
      }
    },

    automationProfile: {
      currentAutomationLevel: f('enum', { values: ['none', 'partial', 'substantial'] }),
      missedCallHandling: f('enum', { values: ['none', 'voicemail', 'manual_callback', 'automatic_textback'] }),
      automationGaps: f('array<string>', { note: 'Named gaps that map to package capabilities.' })
    },

    financialOpportunityProfile: {
      currency: f('string', { note: 'USD.' }),
      period: f('string', { note: 'month.' }),
      method: f('string', { required: true, note: 'Identifier of the deterministic formula set used.' }),
      unconstrained: {
        point: f('number', { note: 'Deterministic figure from the assessment formulas, before capacity clamping.' }),
        low: f('number'),
        high: f('number')
      },
      capacityAdjusted: {
        point: f('number', { note: 'Clamped so recovered demand never exceeds servable capacity.' }),
        low: f('number'),
        high: f('number'),
        clampApplied: f('boolean'),
        clampReason: f('string')
      },
      drivers: f('array<object>', { note: '{ id, label, low, point, high, basis[] } per opportunity driver.' }),
      isDiagnosticEstimate: f('boolean', { required: true, note: 'Always true. Never a projection or guarantee.' }),
      disclaimer: f('string', { required: true, note: 'Exact wording shown to the business.' })
    },

    riskProfile: {
      oversellRisk: f('enum', { values: VOCAB.oversellRisk }),
      dataQualityRisk: f('enum', { values: ['low', 'moderate', 'high'] }),
      implementationRisk: f('enum', { values: ['low', 'moderate', 'high', 'unknown'] }),
      churnRisk: f('enum', { values: ['low', 'moderate', 'high', 'unknown'], note: 'Customers only.' }),
      complianceFlags: f('array<string>'),
      notes: f('array<string>')
    },

    estimateConfidence: {
      score: f('number', { required: true, note: '0..1. Deterministic function of completeness, internal consistency, and freshness.' }),
      band: f('enum', { required: true, values: VOCAB.confidenceBand }),
      completeness: f('number', { note: '0..1 answered / scored fields.' }),
      consistency: f('number', { note: '0..1 penalty for contradictory answers.' }),
      freshness: f('enum', { values: VOCAB.dataFreshness }),
      reasons: f('array<string>', { note: 'Human-readable causes of any reduction.' })
    },

    qualificationProfile: {
      outcome: f('enum', { required: true, values: VOCAB.qualificationOutcome }),
      score: f('score0to100'),
      icpFit: f('score0to100'),
      disqualifiers: f('array<string>'),
      missingCriticalFields: f('array<string>', { note: 'Drives insufficient_data rather than a false negative.' }),
      segment: f('string')
    },

    closeReadinessProfile: {
      score: f('score0to100', { required: true, note: 'Weighted sum of signals below. Deterministic.' }),
      band: f('enum', { required: true, values: VOCAB.readinessBand }),
      bandBeforeBlockers: f('enum', { values: VOCAB.readinessBand }),
      signals: f('object', { required: true, note: 'One 0..100 score per CLOSE_READINESS_SIGNALS key, each with its own basis[].' }),
      hardBlockers: f('array<string>', { note: 'Values from HARD_BLOCKERS. Any entry forces band = escalate.' }),
      softBlockers: f('array<string>', { note: 'Keys of SOFT_BLOCKERS. Cap the band.' }),
      approvedLanguageKey: f('string', { note: 'Set only at ask_for_sale; resolves against APPROVED_CLOSE_LANGUAGE.' }),
      unresolvedObjections: f('array<object>', { note: '{ id, raisedAt, summary, status }.' })
    },

    recommendedNextAction: {
      action: f('string', { required: true, note: 'Canonical action id, e.g. present_offer, request_recheck, escalate_to_owner.' }),
      rationale: f('string', { required: true }),
      automationClass: f('enum', { required: true, values: ['autonomous', 'customer_confirmed', 'owner_approved', 'prohibited'] }),
      notBefore: f('iso8601', { note: 'Respects suppression and quiet periods.' }),
      expiresAt: f('iso8601'),
      requiredConsents: f('array<enum>', { values: VOCAB.consentPurpose })
    },

    packageRecommendation: {
      packageId: f('enum', { required: true, values: VOCAB.packageId }),
      label: f('string', { required: true, note: 'Exactly as shown to the business.' }),
      priceMonthly: f('number', { unit: 'USD', note: 'Read from vertical config. Never generated.' }),
      reason: f('string', { required: true }),
      fitScore: f('score0to100'),
      alternatives: f('array<object>', { note: '{ packageId, fitScore, reason }.' }),
      scopeStandard: f('boolean', { note: 'False routes Scale to owner approval.' })
    },

    explanation: {
      evidence: f('array<object>', {
        required: true,
        note: '{ id, kind (VOCAB.evidenceKind), field, statement, sourceRef, weight }. Every scored claim must be traceable to at least one entry.'
      })
    },

    lifecycle: {
      stage: f('enum', { required: true, values: VOCAB.lifecycleStage }),
      stageEnteredAt: f('iso8601'),
      lastMeaningfulInteractionAt: f('iso8601', { note: 'Anchors the 90-day unconverted-lead clock.' }),
      nextReassessmentDueAt: f('iso8601'),
      reassessmentKind: f('enum', { values: ['quick_recheck', 'quarterly_review', 'annual_full', 'change_triggered'] }),
      nonresponseCycles: f('integer'),
      suppressedUntil: f('iso8601'),
      suppressionReason: f('string'),
      consentState: f('object', { note: 'One record per VOCAB.consentPurpose: { granted, statement, recordedAt }.' })
    },

    reassessmentHistory: f('array<object>', {
      required: true,
      note: 'References only, never copies: { birId, generatedAt, trigger, closeReadinessBand, opportunityPoint }. Ordered oldest first.'
    })
  };

  /* ---------------------------------------------------------
     Authority
     The BIR is point-in-time. The Business Record is longitudinal.
     A BIR describes what was true when it was generated; it never
     owns current state and must never overwrite the record.
     --------------------------------------------------------- */

  const BIR_AUTHORITY = {
    authoritativeFor: [
      'point_in_time_intelligence_from_one_evidence_set',
      'point_in_time_capacity',
      'point_in_time_risk',
      'point_in_time_opportunity',
      'point_in_time_confidence',
      'point_in_time_qualification',
      'point_in_time_recommendation',
      'snapshot_of_lifecycle_and_business_state_at_generation'
    ],
    neverAuthoritativeFor: [
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
    rules: [
      'A BIR must never overwrite Business Record state.',
      'Fields describing lifecycle or business state are a SNAPSHOT as of generatedAt, not current truth.',
      'Downstream engines receive both businessId and birId.',
      'A single-assessment recommendation may use one BIR.',
      'A longitudinal decision must use the Business Record plus relevant BIR history.',
      'The Business Record may summarize the latest BIR but retains references to all prior BIRs.'
    ]
  };

  /* ---------------------------------------------------------
     Deterministic validation of the identity contract only.
     The rest of the BIR has no validator; the BIE owns construction.
     --------------------------------------------------------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const isUuid = v => typeof v === 'string' && UUID_RE.test(v);

  /* businessId may be null ONLY while identity is unresolved. */
  const IDENTITY_STATUSES_ALLOWING_NULL_BUSINESS_ID = ['legacy_unresolved', 'resolution_pending'];

  /* The identity contract is shared by every review type; the STRUCTURAL
     version is not. A Growth report is v4 and a Service Mix report is v5, so
     the caller says which versions it is entitled to produce rather than this
     function assuming there is only one. Defaulting to the Growth version
     keeps every existing call site behaving exactly as before. */
  const validateBirIdentity = (identity, schemaVersion, options = {}) => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });
    const supported = Array.isArray(options.supportedVersions) && options.supportedVersions.length
      ? options.supportedVersions
      : [BIR_SCHEMA_VERSION];

    if (!identity || typeof identity !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'identity must be an object.' }] };
    }
    if (!isUuid(identity.birId)) push('invalid_bir_id', 'identity.birId must be a UUID.');

    /* v1 reports are read-only legacy and are not held to the v2 contract. */
    if (schemaVersion === 1) {
      if (identity.businessId) push('legacy_with_business_id', 'A v1 report must not carry a businessId; migrate it to v2 instead.');
      return { valid: errors.length === 0, errors, legacy: true };
    }
    if (!supported.includes(schemaVersion)) {
      push('unsupported_schema_version', `Unsupported BIR schemaVersion: ${schemaVersion}`);
    }

    const status = identity.identityStatus;
    if (!VOCAB.identityStatus.includes(status)) {
      push('invalid_identity_status', `Unknown identityStatus: ${status}`);
    }
    if (identity.businessId === null || identity.businessId === undefined) {
      if (!IDENTITY_STATUSES_ALLOWING_NULL_BUSINESS_ID.includes(status)) {
        push('missing_business_id', `businessId may be null only while identityStatus is ${IDENTITY_STATUSES_ALLOWING_NULL_BUSINESS_ID.join(' or ')}.`);
      }
    } else if (!isUuid(identity.businessId)) {
      push('invalid_business_id', 'businessId must be a UUID.');
    }

    if (identity.businessKey !== undefined) {
      push('deprecated_business_key', 'businessKey was removed in v2. Use legacyBusinessKey for provenance only.');
    }
    if (identity.legacyBusinessKey && isUuid(identity.legacyBusinessKey) && identity.legacyBusinessKey === identity.businessId) {
      push('legacy_key_reinterpreted', 'legacyBusinessKey must never be reused as businessId.');
    }
    if (identity.identityResolutionId && !isUuid(identity.identityResolutionId)) {
      push('invalid_resolution_id', 'identityResolutionId must be a UUID.');
    }
    if (status === 'legacy_unresolved' && !identity.legacyBusinessKey) {
      push('legacy_without_key', 'legacy_unresolved requires the original legacyBusinessKey as provenance.');
    }

    return { valid: errors.length === 0, errors, legacy: false };
  };

  const API = {
    BIR_SCHEMA_VERSION,
    BIR_SCHEMA_VERSION_HISTORY,
    BUSINESS_INTELLIGENCE_REPORT_SCHEMA,
    BIR_AUTHORITY,
    POLARITY,
    IDENTITY_STATUSES_ALLOWING_NULL_BUSINESS_ID,
    validateBirIdentity,
    isUuid,
    VOCAB,
    RANGE_SPREAD_BY_CONFIDENCE,
    CONFIDENCE_BANDS,
    CLOSE_READINESS_SIGNALS,
    READINESS_BANDS,
    HARD_BLOCKERS,
    SOFT_BLOCKERS,
    STAGE_POLICY,
    STAGE1_READINESS_SIGNALS,
    STAGE2_EVIDENCE_BLOCKERS,
    APPROVED_CLOSE_LANGUAGE,
    CAPACITY_HEADROOM_BANDS,
    LIFECYCLE_POLICY,
    PROHIBITED_DATA_CATEGORIES
  };

  /* Usable from a browser page or from a future Node service, with no build
     step and no dependencies. */
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDBusinessIntelligenceSchema = API;
})();
