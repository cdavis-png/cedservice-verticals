/* ============================================================
   CED Intelligence Platform — Business Intelligence Engine v1
   ------------------------------------------------------------
   Transforms one schema-v2 assessment submission into one BIR-v2
   object. Deterministic and total: same input, same output.

     - no AI, no network, no enrichment, no clock of its own
     - never recomputes scoring; the payload's figures are carried
       through verbatim, so pricing and scoring cannot drift here
     - anything not collected is null or "unknown", never inferred
     - every gap is named in missingCriticalFields
     - close readiness stays low while its evidence is unknown

   Authority for constants: report.schema.js. This file computes;
   it does not redefine thresholds.
   ============================================================ */

(() => {
  'use strict';

  const schema = (typeof module !== 'undefined' && module.exports)
    ? require('./report.schema.js')
    : (typeof window !== 'undefined' ? window.CEDBusinessIntelligenceSchema : null);

  const BIE_VERSION = 'bie-v1.0.0';
  const OPPORTUNITY_METHOD = 'nails-opportunity-v1';
  const READINESS_FORMULA = 'close-readiness-v1';

  /* Evidence the platform needs but the current assessment does not collect.
     Named here so the gap is explicit in every report rather than implied. */
  const UNCOLLECTED_CRITICAL_FIELDS = [
    'businessProfile.locationCount',
    'capacityProfile.additionalCapacity90Day',
    'capacityProfile.staffingExpandable',
    'capacityProfile.hoursExpandable',
    'capacityProfile.spaceOrEquipmentConstrained',
    'capacityProfile.willingnessToExpand',
    'technologyProfile.bookingSystem',
    'closeReadiness.decisionAuthority',
    'closeReadiness.urgency',
    'closeReadiness.budgetSignals',
    'closeReadiness.unresolvedObjections'
  ];

  /* Answers that feed the score. Completeness is measured against these only —
     counting unscored context fields would inflate confidence. */
  const SCORED_ANSWER_FIELDS = [
    'technicians', 'averageTicket', 'daysOpen', 'callsDay', 'missedCallsDay',
    'missedCallProcess', 'noShowsWeek', 'cancelsWeek', 'reminders', 'waitlist',
    'rebooking', 'reactivation', 'inactiveClients', 'rating', 'reviewRequests', 'promotions'
  ];

  const REMINDER_MATURITY = ['none', 'manual_inconsistent', 'manual_consistent', 'automated'];
  const WAITLIST_USAGE = ['none', 'occasional', 'consistent'];
  const REBOOKING_MATURITY = ['rare', 'sometimes', 'usual', 'always'];
  const REACTIVATION_MATURITY = ['never', 'occasional', 'monthly', 'automated'];
  const PROMOTION_CADENCE = ['never', 'few_per_year', 'monthly', 'tracked_consistent'];
  const MISSED_CALL_HANDLING = ['none', 'voicemail', 'manual_callback', 'automatic_textback'];

  const num = (answers, key) => {
    const raw = answers ? answers[key] : undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  };
  const present = (answers, key) => {
    const raw = answers ? answers[key] : undefined;
    return raw !== undefined && raw !== null && String(raw).trim() !== '';
  };
  const enumAt = (list, index) => (index >= 0 && index < list.length ? list[index] : null);
  const round2 = n => Math.round(n * 100) / 100;

  /* Stable key ordering so the same answers always hash the same. */
  const stableStringify = value => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  };

  const fnv1a = input => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };

  const bandFor = score => {
    const hit = schema.CONFIDENCE_BANDS.find(b => score >= b.min && score <= b.max);
    return hit ? hit.id : 'low';
  };

  /* ---------- confidence ---------- */

  const computeConfidence = answers => {
    const reasons = [];

    const answered = SCORED_ANSWER_FIELDS.filter(f => present(answers, f));
    const completeness = answered.length / SCORED_ANSWER_FIELDS.length;
    if (completeness < 1) {
      reasons.push(`${SCORED_ANSWER_FIELDS.length - answered.length} scored field(s) left blank.`);
    }

    /* Internal contradictions reduce trust in the inputs themselves. */
    let consistency = 1;
    const missed = num(answers, 'missedCallsDay');
    const calls = num(answers, 'callsDay');
    if (missed > calls) {
      consistency -= 0.25;
      reasons.push('Missed calls per day exceed total calls per day.');
    }
    const appointments = num(answers, 'appointmentsDay');
    const noShowsPerDay = num(answers, 'noShowsWeek') / 7;
    if (appointments > 0 && noShowsPerDay > appointments) {
      consistency -= 0.25;
      reasons.push('No-shows per day exceed reported appointments per day.');
    }
    if (num(answers, 'rating') > 5 || (present(answers, 'rating') && num(answers, 'rating') < 1)) {
      consistency -= 0.15;
      reasons.push('Google rating is outside the 1-5 range.');
    }
    consistency = Math.max(0, consistency);

    /* A report generated from a submission just received is fresh by
       definition. Ageing is the Lifecycle Engine's job, not this one's. */
    const freshness = 'fresh';
    const freshnessFactor = 1;

    let score = completeness * 0.45 + consistency * 0.4 + freshnessFactor * 0.15;

    /* The opportunity estimate is bounded by how much work the business could
       actually absorb. While capacity is uncollected that ceiling is unknown,
       so the estimate cannot honestly be high-confidence however complete the
       rest of the answers are. Capped rather than penalised, so the reason is
       explicit instead of buried in arithmetic. */
    const HIGH_BAND_MIN = schema.CONFIDENCE_BANDS.find(b => b.id === 'high').min;
    const capacityKnown = false;
    if (!capacityKnown && score >= HIGH_BAND_MIN) {
      score = HIGH_BAND_MIN - 0.01;
      reasons.push('Capped below high confidence: capacity is not collected, so the estimate has no known ceiling.');
    }
    reasons.push('Capacity, decision authority, urgency, budget, and booking platform are not collected by this assessment.');

    score = round2(Math.max(0, Math.min(1, score)));

    return {
      score,
      band: bandFor(score),
      completeness: round2(completeness),
      consistency: round2(consistency),
      freshness,
      reasons
    };
  };

  /* ---------- close readiness ---------- */

  const computeCloseReadiness = ({ answers, confidence, packageRecommendation }) => {
    /* A signal with no evidence scores 0 AND is listed as unknown. Scoring it
       zero keeps readiness honestly low; listing it stops the zero from being
       mistaken for a measurement. */
    const known = {};
    const unknown = [];

    known.packageFit = packageRecommendation && packageRecommendation.id ? 60 : 0;
    known.estimateConfidence = Math.round(confidence.score * 100);
    known.engagementBehavior = 70;  /* completed the full assessment unprompted */

    ['decisionAuthority', 'urgency', 'budgetSignals', 'capacity',
     'implementationCompatibility', 'objectionsResolved', 'scopeStandardization'].forEach(key => {
      known[key] = 0;
      unknown.push(key);
    });

    const signals = {};
    schema.CLOSE_READINESS_SIGNALS.forEach(({ key }) => {
      signals[key] = {
        score: known[key] === undefined ? 0 : known[key],
        known: !unknown.includes(key),
        basis: unknown.includes(key)
          ? ['not_collected_by_assessment']
          : ['assessment_submission']
      };
    });

    const score = Math.round(schema.CLOSE_READINESS_SIGNALS
      .reduce((sum, s) => sum + signals[s.key].score * s.weight, 0));

    const bandHit = schema.READINESS_BANDS.find(b => score >= b.min && score <= b.max);
    const bandBeforeBlockers = bandHit ? bandHit.id : 'educate';

    /* Soft blockers cap the band. Both of these are true of every report this
       version can produce, and will stay true until the evidence is collected. */
    const softBlockers = ['unknown_decision_authority'];
    if (confidence.band === 'low') softBlockers.push('low_estimate_confidence');

    const order = schema.READINESS_BANDS.map(b => b.id);
    let band = bandBeforeBlockers;
    softBlockers.forEach(blocker => {
      const cap = schema.SOFT_BLOCKERS[blocker];
      if (cap && order.indexOf(band) > order.indexOf(cap)) band = cap;
    });

    return {
      score,
      band,
      bandBeforeBlockers,
      signals,
      unknownSignals: unknown,
      hardBlockers: [],
      softBlockers,
      approvedLanguageKey: band === 'ask_for_sale' ? 'ask_for_sale' : null,
      unresolvedObjections: [],
      formulaVersion: READINESS_FORMULA
    };
  };

  /* ---------- main ---------- */

  const generateBir = (input = {}) => {
    const {
      submission,
      birId,
      businessId = null,
      identityStatus = 'resolution_pending',
      identityResolutionId = null,
      generatedAt,
      supersedesBirId = null,
      hashFn = null
    } = input;

    if (!schema) throw new Error('generate-bir: report.schema.js is not available.');
    if (!submission || typeof submission !== 'object') throw new Error('generate-bir: submission is required.');
    if (!birId) throw new Error('generate-bir: birId is required.');
    if (!generatedAt) throw new Error('generate-bir: generatedAt is required.');

    const answers = submission.answers || {};
    const contact = submission.contact || {};
    const results = submission.results || {};
    const dimensions = results.dimensions || {};
    const attribution = submission.attribution || {};
    const consent = submission.consent || {};
    const vertical = submission.vertical || {};
    const pkg = results.recommendedPackage || {};

    const confidence = computeConfidence(answers);
    const spread = schema.RANGE_SPREAD_BY_CONFIDENCE[confidence.band];

    /* Carried through, never recomputed. */
    const point = Number.isFinite(Number(results.opportunity)) ? Number(results.opportunity) : 0;
    const low = round2(point * spread.low);
    const high = round2(point * spread.high);

    const closeReadiness = computeCloseReadiness({
      answers, confidence, packageRecommendation: pkg
    });

    const hash = (hashFn || fnv1a)(stableStringify({
      answers, contact, results, vertical, assessmentVersion: submission.assessmentVersion
    }));

    const evidence = [
      { id: 'ev-score', kind: 'derived', field: 'results.score',
        statement: 'Growth Score carried through from the assessment engine without recomputation.',
        sourceRef: submission.submissionId, weight: 1 },
      { id: 'ev-opportunity', kind: 'derived', field: 'financialOpportunityProfile.unconstrained',
        statement: `Point estimate ${point} widened to a ${confidence.band}-confidence range.`,
        sourceRef: submission.submissionId, weight: 1 },
      { id: 'ev-drivers', kind: 'policy', field: 'financialOpportunityProfile.drivers',
        statement: 'Per-driver breakdown is not carried by payload schema v2; only the total is available.',
        sourceRef: 'payload-schema-v2', weight: 0 },
      { id: 'ev-capacity', kind: 'policy', field: 'capacityProfile',
        statement: 'Capacity is not collected by this assessment, so the opportunity range is not capacity-clamped.',
        sourceRef: 'assessment-config', weight: 0 },
      { id: 'ev-readiness', kind: 'policy', field: 'closeReadinessProfile',
        statement: `${closeReadiness.unknownSignals.length} of ${schema.CLOSE_READINESS_SIGNALS.length} readiness signals have no evidence and score zero.`,
        sourceRef: 'assessment-config', weight: 0 }
    ];

    const missingCriticalFields = UNCOLLECTED_CRITICAL_FIELDS.slice();
    SCORED_ANSWER_FIELDS.filter(f => !present(answers, f))
      .forEach(f => missingCriticalFields.push(`answers.${f}`));

    return {
      schemaVersion: schema.BIR_SCHEMA_VERSION,

      identity: {
        birId,
        businessId,
        identityStatus,
        identityResolutionId,
        legacyBusinessKey: null,
        verticalId: vertical.id || null,
        assessmentSessionId: submission.assessmentSessionId || null,
        submissionId: submission.submissionId || null,
        customerId: null
      },

      provenance: {
        generatedAt,
        generatedBy: BIE_VERSION,
        assessmentVersion: submission.assessmentVersion || null,
        payloadSchemaVersion: submission.schemaVersion || null,
        inputHash: hash,
        supersedes: supersedesBirId,
        supersededBy: null,
        isCurrent: true,
        sourceEvents: []
      },

      businessProfile: {
        displayName: contact.salonName || null,
        industry: null,
        subIndustry: vertical.id || null,
        locationCount: null,
        yearsInBusiness: null,
        staffCount: present(answers, 'technicians') ? num(answers, 'technicians') : null,
        serviceArea: null
      },

      capacityProfile: {
        currentThroughputPerMonth: present(answers, 'appointmentsDay') && present(answers, 'daysOpen')
          ? round2(num(answers, 'appointmentsDay') * num(answers, 'daysOpen'))
          : null,
        unusedCapacityPerMonth: null,
        maxPracticalCapacityPerMonth: null,
        additionalCapacity90Day: null,
        headroomRatio: null,
        headroomBand: 'unknown',
        staffingExpandable: 'unknown',
        hoursExpandable: 'unknown',
        spaceOrEquipmentConstrained: 'unknown',
        willingnessToExpand: 'unknown',
        operationalReadiness: null,
        oversellRisk: 'unknown'
      },

      operationsProfile: {
        appointmentProtectionScore: dimensions.appointmentProtection ?? null,
        missedOpportunityScore: dimensions.missedOpportunity ?? null,
        noShowsPerWeek: present(answers, 'noShowsWeek') ? num(answers, 'noShowsWeek') : null,
        cancellationsPerWeek: present(answers, 'cancelsWeek') ? num(answers, 'cancelsWeek') : null,
        reminderMaturity: enumAt(REMINDER_MATURITY, num(answers, 'reminders')),
        waitlistUsage: enumAt(WAITLIST_USAGE, num(answers, 'waitlist')),
        averageTicket: present(answers, 'averageTicket') ? num(answers, 'averageTicket') : null,
        daysOpenPerMonth: present(answers, 'daysOpen') ? num(answers, 'daysOpen') : null
      },

      customerProfile: {
        retentionScore: dimensions.retention ?? null,
        rebookingMaturity: enumAt(REBOOKING_MATURITY, num(answers, 'rebooking')),
        reactivationMaturity: enumAt(REACTIVATION_MATURITY, num(answers, 'reactivation')),
        inactiveCustomerCount: present(answers, 'inactiveClients') ? num(answers, 'inactiveClients') : null,
        reviewCount: present(answers, 'reviewCount') ? num(answers, 'reviewCount') : null,
        reviewRating: present(answers, 'rating') ? num(answers, 'rating') : null,
        reputationScore: dimensions.reputation ?? null
      },

      technologyProfile: {
        bookingSystem: null,
        integrationCompatibility: 'unknown',
        knownBlockers: []
      },

      marketingProfile: {
        marketingScore: dimensions.marketing ?? null,
        promotionCadence: enumAt(PROMOTION_CADENCE, num(answers, 'promotions')),
        primaryChallenge: answers.challenge || null,
        attribution: {
          firstTouch: attribution.firstTouch || null,
          latestTouch: attribution.latestTouch || null
        }
      },

      automationProfile: {
        currentAutomationLevel: (() => {
          const level = num(answers, 'missedCallProcess') + num(answers, 'reminders');
          if (level >= 5) return 'substantial';
          if (level >= 2) return 'partial';
          return 'none';
        })(),
        missedCallHandling: enumAt(MISSED_CALL_HANDLING, num(answers, 'missedCallProcess')),
        automationGaps: [
          num(answers, 'missedCallProcess') < 3 ? 'missed_call_recovery' : null,
          num(answers, 'reminders') < 3 ? 'appointment_reminders' : null,
          num(answers, 'waitlist') < 2 ? 'waitlist_fill' : null,
          num(answers, 'reactivation') < 3 ? 'client_reactivation' : null,
          num(answers, 'reviewRequests') < 3 ? 'review_requests' : null
        ].filter(Boolean)
      },

      financialOpportunityProfile: {
        currency: 'USD',
        period: 'month',
        method: OPPORTUNITY_METHOD,
        unconstrained: { point: round2(point), low, high },
        capacityAdjusted: {
          point: round2(point), low, high,
          clampApplied: false,
          clampReason: 'Capacity is not collected by this assessment; no clamp can be applied.'
        },
        drivers: [],
        isDiagnosticEstimate: true,
        disclaimer: results.disclaimer || null
      },

      riskProfile: {
        oversellRisk: 'unknown',
        dataQualityRisk: confidence.band === 'high' ? 'low' : confidence.band === 'medium' ? 'moderate' : 'high',
        implementationRisk: 'unknown',
        churnRisk: 'unknown',
        complianceFlags: [],
        notes: ['Capacity evidence absent; growth recommendations must not be made from this report alone.']
      },

      estimateConfidence: confidence,

      qualificationProfile: {
        outcome: 'insufficient_data',
        score: null,
        icpFit: null,
        disqualifiers: [],
        missingCriticalFields,
        segment: vertical.id || null
      },

      closeReadinessProfile: closeReadiness,

      recommendedNextAction: {
        action: identityStatus === 'resolution_pending' ? 'await_identity_review' : 'deliver_results',
        rationale: identityStatus === 'resolution_pending'
          ? 'Identity could not be resolved automatically; a person must confirm which business this is.'
          : 'Results were delivered to the visitor. Readiness evidence is insufficient to present an offer.',
        automationClass: 'autonomous',
        notBefore: null,
        expiresAt: null,
        requiredConsents: ['results_delivery']
      },

      packageRecommendation: {
        packageId: pkg.id || null,
        label: pkg.label || null,
        priceMonthly: Number.isFinite(Number(pkg.price)) ? Number(pkg.price) : null,
        reason: pkg.reason || null,
        fitScore: null,
        alternatives: [],
        /* Conservative: with location count uncollected, standard scope cannot
           be confirmed, and unconfirmed must never read as confirmed. */
        scopeStandard: false
      },

      explanation: { evidence },

      /* SNAPSHOT as of generation. The Business Record owns current lifecycle
         state; this is what the BIR observed, per ADR-001. */
      lifecycle: {
        stage: 'lead_assessed',
        stageEnteredAt: submission.submittedAt || generatedAt,
        lastMeaningfulInteractionAt: submission.submittedAt || generatedAt,
        nextReassessmentDueAt: new Date(
          Date.parse(submission.submittedAt || generatedAt) +
          schema.LIFECYCLE_POLICY.unconvertedLeadReassessDays * 86400000
        ).toISOString(),
        reassessmentKind: 'quick_recheck',
        nonresponseCycles: 0,
        suppressedUntil: null,
        suppressionReason: null,
        consentState: {
          results_delivery: consent.resultsDeliveryConsent || null,
          transactional_service: null,
          email_marketing: consent.emailMarketingConsent || null,
          sms_marketing: consent.smsMarketingConsent || null
        }
      },

      reassessmentHistory: []
    };
  };

  /* Structural validation against the schema contract. Not a substitute for
     review — it proves shape, not correctness. */
  const validateGeneratedBir = bir => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!bir || typeof bir !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'BIR must be an object.' }] };
    }
    if (bir.schemaVersion !== schema.BIR_SCHEMA_VERSION) {
      push('schema_version_mismatch', `Expected schemaVersion ${schema.BIR_SCHEMA_VERSION}.`);
    }

    const identity = schema.validateBirIdentity(bir.identity || {}, bir.schemaVersion);
    identity.errors.forEach(e => errors.push(e));

    Object.keys(schema.BUSINESS_INTELLIGENCE_REPORT_SCHEMA).forEach(section => {
      if (section === 'schemaVersion') return;
      if (bir[section] === undefined) push('missing_section', `Missing BIR section: ${section}`);
    });

    const fin = bir.financialOpportunityProfile;
    if (fin) {
      if (fin.isDiagnosticEstimate !== true) push('missing_diagnostic_flag', 'isDiagnosticEstimate must be true.');
      if (!fin.disclaimer) push('missing_disclaimer', 'The on-page disclaimer must be carried into the report.');
      ['unconstrained', 'capacityAdjusted'].forEach(k => {
        const r = fin[k];
        if (!r) return push('missing_range', `financialOpportunityProfile.${k} is required.`);
        if (!(r.low <= r.point && r.point <= r.high)) {
          push('range_out_of_order', `${k} must satisfy low <= point <= high.`);
        }
      });
    }

    const conf = bir.estimateConfidence;
    if (!conf || typeof conf.score !== 'number' || conf.score < 0 || conf.score > 1) {
      push('invalid_confidence', 'estimateConfidence.score must be a number in 0..1.');
    } else if (!schema.VOCAB.confidenceBand.includes(conf.band)) {
      push('invalid_confidence_band', `Unknown confidence band: ${conf.band}`);
    }

    const readiness = bir.closeReadinessProfile;
    if (readiness) {
      if (!schema.VOCAB.readinessBand.includes(readiness.band)) {
        push('invalid_readiness_band', `Unknown readiness band: ${readiness.band}`);
      }
      const expected = schema.CLOSE_READINESS_SIGNALS.map(s => s.key);
      const got = Object.keys(readiness.signals || {});
      expected.forEach(k => { if (!got.includes(k)) push('missing_readiness_signal', `Missing readiness signal: ${k}`); });
      if (readiness.approvedLanguageKey && readiness.band !== 'ask_for_sale') {
        push('language_before_band', 'Approved close language may only be set at the ask_for_sale band.');
      }
    }

    if (!bir.explanation || !Array.isArray(bir.explanation.evidence) || bir.explanation.evidence.length === 0) {
      push('missing_evidence', 'explanation.evidence must not be empty.');
    }

    return { valid: errors.length === 0, errors };
  };

  const API = {
    BIE_VERSION,
    OPPORTUNITY_METHOD,
    READINESS_FORMULA,
    UNCOLLECTED_CRITICAL_FIELDS,
    SCORED_ANSWER_FIELDS,
    generateBir,
    validateGeneratedBir,
    computeConfidence,
    stableStringify,
    fnv1a
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDGenerateBir = API;
})();
