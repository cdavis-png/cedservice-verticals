/* ============================================================
   CED Intelligence Platform — Service Mix BIR v5
   ------------------------------------------------------------
   Transforms one Quick Service Mix Review submission into one
   point-in-time Service Mix report. Deterministic and total:
   same input, same output, byte for byte.

     - no AI, no network, no enrichment, no clock of its own
     - every figure is an interval, and an unknown stays unknown
     - no contribution, margin, or profit figure is produced,
       because SM-1 collects no direct costs
     - every finding carries what it means, why, on what
       evidence, under what assumptions, what is missing, how
       confident it is, and what would reverse it

   schemaVersion 5 with reportType 'service_mix'. The GROWTH BIR
   stays at 4 and stays immutable: BIR_SCHEMA_VERSION in
   report.schema.js is the Growth generator's version and was
   deliberately not bumped. A consumer branches on reportType,
   never on schemaVersion alone.

   Full contract: docs/SERVICE_MIX_BIR.md.

   Classic script on purpose.
   ============================================================ */

(() => {
  'use strict';

  /* LITERAL require SPECIFIERS, DELIBERATELY. Routing these through a
     helper that took the specifier as a VARIABLE made them invisible to
     Vercel's file tracer: the modules below were never packaged, the require
     threw at module scope, and /api/assessments answered
     FUNCTION_INVOCATION_FAILED. The guard is unchanged — this file is also
     loaded by a browser as a classic script, where `require` does not
     exist — only the specifier moved from a variable to a literal.
     See tests/function-bundle-contract.test.mjs. */
  const isCjs = typeof module !== 'undefined' && !!module.exports;

  const schema = (isCjs ? require('../business-intelligence/report.schema.js') : null) ||
    (typeof window !== 'undefined' ? window.CEDBusinessIntelligenceSchema : null);
  const values = (isCjs ? require('./value.schema.js') : null) ||
    (typeof window !== 'undefined' ? window.CEDServiceMixValue : null);
  const offerings = (isCjs ? require('./offering.schema.js') : null) ||
    (typeof window !== 'undefined' ? window.CEDServiceMixOffering : null);
  const calculate = (isCjs ? require('./calculate.js') : null) ||
    (typeof window !== 'undefined' ? window.CEDServiceMixCalculate : null);
  const classify = (isCjs ? require('./classify.js') : null) ||
    (typeof window !== 'undefined' ? window.CEDServiceMixClassify : null);
  const guidance = (isCjs ? require('./guidance.js') : null) ||
    (typeof window !== 'undefined' ? window.CEDServiceMixGuidance : null);

  const SERVICE_MIX_BIR_SCHEMA_VERSION = 5;
  const SERVICE_MIX_REPORT_TYPE = 'service_mix';
  const SERVICE_MIX_REPORT_VERSION = 1;
  const SERVICE_MIX_ENGINE_VERSION = 'service-mix-engine-v1.0.0';

  /* Verbatim. The validator refuses a report whose disclaimer is missing or
     altered, and the page shows the same words beside any figure. A number
     never travels without it — CLAUDE.md section 4. */
  const SERVICE_MIX_DISCLAIMER =
    'This is a diagnostic analysis based on the information provided. ' +
    'Estimated contribution excludes labor expense, overhead, occupancy, taxes, ' +
    'financing, and other costs unless explicitly stated. It is not a calculation ' +
    'of profit or accounting, tax, legal, or regulatory advice.';

  /* Findings reference a disclaimer by KEY rather than repeating its wording,
     so there is one place to change it and nowhere for a copy to drift. Every
     `disclaimerKey` in the report must resolve here. */
  const DISCLAIMERS = {
    service_mix_diagnostic: SERVICE_MIX_DISCLAIMER
  };

  /* How a related Growth Review may be referenced. EXACTLY these five fields —
     none of them a score, a finding, or an opportunity figure, and no sixth.

     A `reviewType: 'growth_review'` field was present in an earlier revision
     and has been removed: the field is named `relatedGrowthReview`, so what it
     relates to is already said, and an unapproved field in a contract is an
     unapproved contract. The validator refuses extras rather than ignoring
     them, so a future addition is a failing test rather than a quiet drift. */
  const RELATED_GROWTH_FIELDS = [
    'birId', 'generatedAt', 'freshness', 'prefilledFields', 'usedInCalculations'
  ];
  const FRESHNESS_VALUES = ['fresh', 'aging', 'stale', 'expired'];

  /* Which contact fields a connected review may report as prefilled. FIELD
     NAMES from a closed enum — never values, never an offering name, never
     free text. Mirrors shared/security/continuation.js :: PREFILL_FIELDS;
     a test asserts the two lists stay identical. */
  const PREFILLED_FIELD_NAMES = ['salonName', 'businessName', 'ownerName', 'email'];
  const MAX_PREFILLED_FIELDS = PREFILLED_FIELD_NAMES.length;

  /* SM-1 completes in one stage. The field exists because the platform's
     stage vocabulary is shared, not because a Service Mix Stage 2 exists. */
  const SERVICE_MIX_STAGE = 1;

  const RESULT_STATES = ['service_mix_preliminary', 'service_mix_detailed_available'];

  const REQUIRED_SECTIONS = [
    'identity', 'provenance', 'assessmentProgress', 'portfolioCoverage',
    'dataConfidence', 'serviceMixHealth', 'offeringAnalyses', 'portfolioTotals',
    'revenueLeaders', 'revenueLeadersBasis',
    'capacityHeavyOfferings', 'capacityHeavyBasis', 'measurementGaps',
    'findings', 'immediateActions',
    'thirtyDayTests', 'relatedGrowthReview', 'aiOpportunityInputs',
    'assumptions', 'missingInformation', 'disclaimer', 'unavailableAnalyses'
  ];

  /* Keeps only approved field names, once each, in the enum's own order — so
     the same set always serialises the same way and the report stays
     deterministic. */
  const sanitizePrefilledFields = list => {
    if (!Array.isArray(list)) return [];
    const seen = new Set(list.filter(f => typeof f === 'string'));
    return PREFILLED_FIELD_NAMES.filter(name => seen.has(name));
  };

  /* ---------- hashing ----------
     Identical inputs must produce an identical hash, so key order is fixed. */

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

  /* ---------- AI inputs ----------

     Reserved for an analysis that does not exist yet. Deterministic,
     derived, and free of free text and of offering names on purpose: the
     point is that whatever reads this later starts from evidence rather
     than from prose it would have to interpret. */
  const aiOpportunityInputs = (portfolio, classified) => ({
    reserved: true,
    consumedBy: null,
    calculationVersion: portfolio.calculationVersion,
    classifierVersion: classified.classifierVersion,
    portfolio: {
      offeringCount: portfolio.offeringCount,
      usableOfferingCount: portfolio.usableOfferingCount,
      coverage: portfolio.coverage,
      completeness: portfolio.dataConfidence.completeness,
      confidence: portfolio.dataConfidence.confidence,
      revenuePerCapacityHour: portfolio.totals.revenuePerCapacityHour
    },
    /* Structural signals only: what kind of thing was found and where, never
       what it is called or what it costs. */
    signals: [
      ...classified.concerns.map(c => ({
        kind: 'concern', id: c.id, offeringId: c.offeringId
      })),
      ...classified.opportunities.map(o => ({
        kind: 'opportunity', id: o.id, offeringId: o.offeringId
      }))
    ],
    gaps: portfolio.measurementGaps.map(g => ({ offeringId: g.offeringId, measure: g.measure })),
    unavailableAnalyses: Object.keys(classified.unavailableAnalyses)
  });

  /* ---------- main ---------- */

  const generateServiceMixBir = (input = {}) => {
    const {
      submission,
      birId,
      businessId = null,
      identityStatus = 'resolution_pending',
      identityResolutionId = null,
      generatedAt,
      supersedesBirId = null,
      relatedGrowthReview = null,
      hashFn = null
    } = input;

    if (!schema) throw new Error('generate-service-mix-bir: report.schema.js is not available.');
    if (!submission || typeof submission !== 'object') {
      throw new Error('generate-service-mix-bir: submission is required.');
    }
    if (!birId) throw new Error('generate-service-mix-bir: birId is required.');
    if (!generatedAt) throw new Error('generate-service-mix-bir: generatedAt is required.');

    const serviceMix = submission.serviceMix || {};
    const contact = submission.contact || {};
    const vertical = submission.vertical || {};
    const consent = submission.consent || {};
    const attribution = submission.attribution || {};

    const portfolio = calculate.calculatePortfolio({
      offerings: serviceMix.offerings || [],
      coverage: serviceMix.coverage || 'unknown'
    });
    const classified = classify.classifyPortfolio(portfolio);
    const advice = guidance.buildGuidance(portfolio, classified);

    const hash = (hashFn || fnv1a)(stableStringify({
      serviceMix, contact, vertical,
      assessmentVersion: submission.assessmentVersion
    }));

    return {
      schemaVersion: SERVICE_MIX_BIR_SCHEMA_VERSION,
      reportType: SERVICE_MIX_REPORT_TYPE,
      reportVersion: SERVICE_MIX_REPORT_VERSION,

      identity: {
        birId,
        businessId,
        identityStatus,
        identityResolutionId,
        legacyBusinessKey: null,
        reviewType: SERVICE_MIX_REPORT_TYPE,
        verticalId: vertical.id || null,
        assessmentSessionId: submission.assessmentSessionId || null,
        submissionId: submission.submissionId || null,
        customerId: null
      },

      provenance: {
        generatedAt,
        generatedBy: SERVICE_MIX_ENGINE_VERSION,
        assessmentVersion: submission.assessmentVersion || null,
        payloadSchemaVersion: submission.schemaVersion || null,
        calculationVersion: portfolio.calculationVersion,
        uncertaintyVersion: portfolio.uncertaintyVersion,
        classifierVersion: classified.classifierVersion,
        guidanceVersion: advice.guidanceVersion,
        inputHash: hash,
        /* Supersession is closed within a review type. A Service Mix report
           may only ever supersede another Service Mix report — the database
           enforces the same rule in migration 0006. */
        supersedes: supersedesBirId,
        supersededBy: null,
        isCurrent: true,
        sourceEvents: []
      },

      assessmentProgress: {
        reviewType: SERVICE_MIX_REPORT_TYPE,
        assessmentStageCompleted: SERVICE_MIX_STAGE,
        stage1CompletedAt: submission.submittedAt || null,
        stage2CompletedAt: null,
        resultState: 'service_mix_detailed_available',
        confidenceKind: 'preliminary',
        /* What the Detailed Review would add, named so "we did not ask" is
           never read as "they would not say". */
        deferredToDetailedReview: [
          'directCost', 'repeatBehaviour', 'bundling', 'seasonality',
          'cancellationExposure', 'pricingSensitivity'
        ]
      },

      portfolioCoverage: {
        declared: portfolio.coverage,
        coverageFactor: portfolio.coverageFactor,
        offeringsEntered: portfolio.offeringCount,
        offeringsAnalysed: portfolio.usableOfferingCount,
        minimum: offerings.OFFERING_LIMITS.min,
        maximum: offerings.OFFERING_LIMITS.max,
        recommended: offerings.OFFERING_LIMITS.recommended,
        note: portfolio.coverage === 'all_offerings'
          ? 'Every share in this report is a share of the whole business, as declared.'
          : 'Every share in this report is a share of the offerings entered, not of the whole business.'
      },

      dataConfidence: portfolio.dataConfidence,

      serviceMixHealth: {
        classification: classified.health.classification,
        because: classified.health.because,
        deciding: classified.health.deciding,
        classifierVersion: classified.classifierVersion,
        thresholds: classified.thresholds,
        findingsWithheld: classified.findingsWithheld,
        withheldCount: classified.withheldCount,
        withheldReason: classified.withheldReason
      },

      offeringAnalyses: portfolio.offeringAnalyses,

      /* Totals travel WITH the statement of what they are totals of. A total
         that silently leaves offerings out looks exactly like a complete one,
         which is the single most misleading thing this report could carry. */
      portfolioTotals: portfolio.totals,

      revenueLeaders: portfolio.revenueLeaders,
      revenueLeadersBasis: portfolio.revenueLeadersBasis,
      capacityHeavyOfferings: portfolio.capacityHeavyOfferings,
      capacityHeavyBasis: portfolio.capacityHeavyBasis,
      measurementGaps: portfolio.measurementGaps,

      findings: advice.findings,
      immediateActions: advice.immediateActions,
      thirtyDayTests: advice.thirtyDayTests,

      /* A REFERENCE, never a copy. Nothing here recomputes, mutates, or
         supersedes the Growth report, and no Growth score, finding, or
         opportunity figure crosses into this one.

         Normally written by the DATABASE, inside `ingest_review`, after
         identity is resolved — the endpoint generates this report before
         ingestion, when businessId is still null, so it cannot look the
         Growth report up. The parameter exists so the shape can be exercised
         and so a future caller that already knows can supply it.

         `usedInCalculations` is false and the validator refuses anything
         else: nothing from the Growth Review enters a Service Mix
         calculation, and that is a guarantee rather than a habit. */
      relatedGrowthReview: relatedGrowthReview
        ? {
            birId: relatedGrowthReview.birId || null,
            generatedAt: relatedGrowthReview.generatedAt || null,
            freshness: FRESHNESS_VALUES.includes(relatedGrowthReview.freshness)
              ? relatedGrowthReview.freshness : 'expired',
            /* Field NAMES the visitor did not have to retype, filtered to the
               closed enum and de-duplicated. Anything else — a value, an
               offering name, a sentence — is dropped here as well as being
               refused at the endpoint, because a list of field names that can
               hold arbitrary strings is not a list of field names. */
            prefilledFields: sanitizePrefilledFields(relatedGrowthReview.prefilledFields),
            usedInCalculations: false
          }
        : null,

      aiOpportunityInputs: aiOpportunityInputs(portfolio, classified),

      assumptions: advice.assumptions,
      missingInformation: advice.missingInformation,
      disclaimer: SERVICE_MIX_DISCLAIMER,
      unavailableAnalyses: classified.unavailableAnalyses,

      businessProfile: {
        displayName: contact.salonName || contact.businessName || null,
        subIndustry: vertical.id || null
      },

      marketingProfile: {
        attribution: {
          firstTouch: attribution.firstTouch || null,
          latestTouch: attribution.latestTouch || null
        }
      },

      lifecycle: {
        consentState: {
          results_delivery: consent.resultsDeliveryConsent || null,
          transactional_service: null,
          email_marketing: consent.emailMarketingConsent || null,
          sms_marketing: consent.smsMarketingConsent || null
        }
      }
    };
  };

  /* ---------- validation ----------
     Proves shape, not correctness — the same limitation validateGeneratedBir
     carries for the Growth report, stated here for the same reason. */

  const validateServiceMixBir = bir => {
    const errors = [];
    const push = (code, message) => errors.push({ code, message });

    if (!bir || typeof bir !== 'object') {
      return { valid: false, errors: [{ code: 'not_an_object', message: 'BIR must be an object.' }] };
    }

    if (bir.schemaVersion !== SERVICE_MIX_BIR_SCHEMA_VERSION) {
      push('schema_version_mismatch', `Expected schemaVersion ${SERVICE_MIX_BIR_SCHEMA_VERSION}.`);
    }
    if (bir.reportType !== SERVICE_MIX_REPORT_TYPE) {
      push('invalid_report_type', `Expected reportType "${SERVICE_MIX_REPORT_TYPE}".`);
    }
    if (bir.reportVersion !== SERVICE_MIX_REPORT_VERSION) {
      push('invalid_report_version', `Expected reportVersion ${SERVICE_MIX_REPORT_VERSION}.`);
    }

    const identity = schema.validateBirIdentity(bir.identity || {}, bir.schemaVersion,
      { supportedVersions: [SERVICE_MIX_BIR_SCHEMA_VERSION] });
    identity.errors.forEach(e => errors.push(e));

    if (bir.identity && bir.identity.reviewType !== SERVICE_MIX_REPORT_TYPE) {
      push('invalid_identity_review_type', 'identity.reviewType must be service_mix.');
    }

    REQUIRED_SECTIONS.forEach(section => {
      if (bir[section] === undefined) push('missing_section', `Missing section: ${section}`);
    });

    /* ---- offerings ---- */
    const analyses = bir.offeringAnalyses;
    if (!Array.isArray(analyses)) {
      push('invalid_offering_analyses', 'offeringAnalyses must be an array.');
    } else {
      if (analyses.length < offerings.OFFERING_LIMITS.min) {
        push('too_few_offerings',
          `A Service Mix report requires at least ${offerings.OFFERING_LIMITS.min} offerings.`);
      }
      if (analyses.length > offerings.OFFERING_LIMITS.max) {
        push('too_many_offerings',
          `A Service Mix report permits at most ${offerings.OFFERING_LIMITS.max} offerings.`);
      }
      const seen = new Set();
      analyses.forEach((a, i) => {
        if (!a || !offerings.isUuid(a.offeringId)) {
          push('missing_offering_id', `offeringAnalyses[${i}].offeringId must be a UUID.`);
        } else if (seen.has(a.offeringId)) {
          push('duplicate_offering_id', `offeringAnalyses[${i}] repeats an offeringId.`);
        } else {
          seen.add(a.offeringId);
        }
        if (!a || !offerings.isUuid(a.offeringSnapshotId)) {
          push('missing_snapshot_id', `offeringAnalyses[${i}].offeringSnapshotId must be a UUID.`);
        }
      });
    }

    /* ---- intervals ---- */
    const checkInterval = (i, path) => {
      if (!i || typeof i !== 'object') return;
      if (i.known !== true) return;
      if (!(typeof i.low === 'number' && typeof i.high === 'number')) {
        push('invalid_interval', `${path} is marked known but carries no numbers.`);
        return;
      }
      if (i.low > i.high) push('interval_out_of_order', `${path} must satisfy low <= high.`);
    };
    const walkIntervals = (node, path, depth = 0) => {
      if (depth > 8 || !node || typeof node !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(node, 'known') &&
          Object.prototype.hasOwnProperty.call(node, 'low') &&
          Object.prototype.hasOwnProperty.call(node, 'high')) {
        checkInterval(node, path);
        return;
      }
      Object.keys(node).forEach(key => walkIntervals(node[key], `${path}.${key}`, depth + 1));
    };
    walkIntervals(bir.offeringAnalyses, 'offeringAnalyses');
    walkIntervals(bir.dataConfidence, 'dataConfidence');

    /* ---- health ---- */
    const health = bir.serviceMixHealth;
    if (!health || !classify.HEALTH_CLASSIFICATIONS.includes(health.classification)) {
      push('invalid_health_classification',
        `Unknown Service Mix health classification: ${health && health.classification}`);
    }

    /* ---- findings ---- */
    if (!Array.isArray(bir.findings)) {
      push('invalid_findings', 'findings must be an array.');
    } else {
      const seenFindingIds = new Set();
      const seenTestIds = new Set();

      bir.findings.forEach((finding, i) => {
        guidance.REQUIRED_FINDING_FIELDS.forEach(field => {
          const value = finding ? finding[field] : undefined;
          const empty = value === undefined || value === null || value === '' ||
            (Array.isArray(value) && field !== 'offeringIds' && value.length === 0);
          if (empty) push('incomplete_finding', `findings[${i}] is missing ${field}.`);
        });
        if (!finding) return;

        /* EXACTLY the approved eleven, and no twelfth. Requiring the approved
           fields without refusing extras is how a contract becomes a
           suggestion: anything could ride alongside, and a reader could not
           tell what is part of the contract and what someone added. */
        Object.keys(finding).forEach(key => {
          if (!guidance.REQUIRED_FINDING_FIELDS.includes(key)) {
            push('finding_extra_field',
              `findings[${i}] carries ${key}, which is not part of the approved finding contract.`);
          }
        });

        /* Ids must be well formed AND unique within one report. A duplicate
           id makes two findings indistinguishable to anything that stores or
           acts on them. */
        if (!guidance.FINDING_ID_PATTERN.test(String(finding.findingId || ''))) {
          push('invalid_finding_id',
            `findings[${i}].findingId is not a valid identifier: ${finding.findingId}`);
        } else if (seenFindingIds.has(finding.findingId)) {
          push('duplicate_finding_id', `findings[${i}] repeats findingId ${finding.findingId}.`);
        } else {
          seenFindingIds.add(finding.findingId);
        }

        /* Read defensively: a finding with no `test` at all has already been
           reported as incomplete above, and must not also crash the
           validator on the way past. */
        const testId = (finding.test && typeof finding.test === 'object')
          ? finding.test.testId : null;
        if (!guidance.FINDING_ID_PATTERN.test(String(testId || ''))) {
          push('invalid_test_id', `findings[${i}].test.testId is not a valid identifier: ${testId}`);
        } else if (seenTestIds.has(testId)) {
          push('duplicate_test_id', `findings[${i}] repeats testId ${testId}.`);
        } else {
          seenTestIds.add(testId);
        }

        /* A finding must name a rule that exists and offerings that do. */
        const knownType = classify.CONCERN_IDS.includes(finding.findingType) ||
          classify.OPPORTUNITY_IDS.includes(finding.findingType);
        if (!knownType) {
          push('unknown_finding_type',
            `findings[${i}].findingType is not a rule this classifier can produce: ${finding.findingType}`);
        }
        if (!Array.isArray(finding.offeringIds)) {
          push('invalid_finding_offerings', `findings[${i}].offeringIds must be an array.`);
        } else {
          const known = new Set((bir.offeringAnalyses || []).map(a => a && a.offeringId));
          finding.offeringIds.forEach(id => {
            if (!known.has(id)) {
              push('finding_offering_unknown',
                `findings[${i}] names an offering that is not in this report: ${id}`);
            }
          });
        }

        /* Every finding points at a disclaimer that resolves. */
        if (!Object.prototype.hasOwnProperty.call(DISCLAIMERS, finding.disclaimerKey)) {
          push('unknown_disclaimer_key',
            `findings[${i}].disclaimerKey does not resolve: ${finding.disclaimerKey}`);
        }

        /* The test carries its decision rule, agreed before the data. */
        ['what', 'durationDays', 'keepIf', 'changeIf', 'reverseIf'].forEach(field => {
          if (!finding.test || finding.test[field] === undefined ||
              finding.test[field] === null || finding.test[field] === '') {
            push('incomplete_test', `findings[${i}].test is missing ${field}.`);
          }
        });
      });

      /* The 30-day tests are a VIEW of the findings' own tests. Two lists
         that could disagree would eventually disagree. */
      if (Array.isArray(bir.thirtyDayTests)) {
        if (bir.thirtyDayTests.length !== bir.findings.length) {
          push('test_count_mismatch',
            'thirtyDayTests must have exactly one entry per finding.');
        }
        bir.thirtyDayTests.forEach((t, i) => {
          const finding = bir.findings.find(f => f && f.findingId === (t && t.findingId));
          if (!finding) {
            push('orphan_test', `thirtyDayTests[${i}] names no finding in this report.`);
          } else if (!finding.test || finding.test.testId !== t.testId) {
            push('test_id_mismatch', `thirtyDayTests[${i}] disagrees with its finding's testId.`);
          }
        });
      }
    }

    /* ---- the rule that protects "no claim of profit" ----
       An analysis that needs direct costs may not be marked available while
       no direct-cost evidence exists, and SM-1 never collects any. */
    const unavailable = bir.unavailableAnalyses || {};
    const hasCostEvidence = Boolean(bir.directCostEvidence);
    classify.UNAVAILABLE_ANALYSES.forEach(key => {
      const entry = unavailable[key];
      if (!entry) {
        push('missing_unavailable_analysis',
          `unavailableAnalyses.${key} must be declared, even when it is unavailable.`);
        return;
      }
      if (entry.available === true && !hasCostEvidence) {
        push('analysis_without_cost_evidence',
          `${key} may not be marked available without direct-cost evidence.`);
      }
    });

    /* ---- disclaimer ---- */
    if (bir.disclaimer !== SERVICE_MIX_DISCLAIMER) {
      push('missing_disclaimer',
        'The Service Mix disclaimer must be carried verbatim into the report.');
    }

    /* ---- a partial total may never claim to be a whole one ----
       The check that stops a figure computed from two of three offerings
       being read as the business's revenue. */
    const totals = bir.portfolioTotals;
    if (totals) {
      [['monthlyRevenueBasis', 'monthlyRevenueOfferingsSkipped'],
       ['capacityHoursBasis', 'capacityHoursOfferingsSkipped']]
        .forEach(([basisKey, skippedKey]) => {
          const basis = totals[basisKey];
          if (!basis) {
            push('missing_total_basis', `portfolioTotals.${basisKey} is required.`);
            return;
          }
          if (basis.scope !== 'entered_offerings') {
            push('invalid_total_scope',
              `portfolioTotals.${basisKey}.scope must be entered_offerings.`);
          }
          if (totals[skippedKey] > 0 && basis.complete === true) {
            push('partial_total_marked_complete',
              `portfolioTotals.${basisKey} excludes ${totals[skippedKey]} offering(s) and may not be marked complete.`);
          }
          if (totals[skippedKey] > 0 && basis.supportsBusinessWideClaim === true) {
            push('partial_total_claims_business',
              `portfolioTotals.${basisKey} excludes offerings and cannot support a claim about the business.`);
          }
        });
    }

    const leaders = bir.revenueLeadersBasis;
    if (leaders) {
      if (leaders.unranked > 0 && leaders.supportsBusinessWideClaim === true) {
        push('leader_claims_business',
          'A revenue leader cannot be the leader of the business while some revenue is unknown.');
      }
      if (leaders.coverage !== 'all_offerings' && leaders.supportsBusinessWideClaim === true) {
        push('leader_claims_business',
          'A revenue leader cannot be the leader of the business when the entered offerings are not the business.');
      }
    }

    /* Consuming hours is a description, never a finding on its own. */
    if (bir.capacityHeavyBasis && bir.capacityHeavyBasis.isFinding !== false) {
      push('capacity_list_as_finding',
        'capacityHeavyOfferings describes where hours go; it is not a finding.');
    }

    /* ---- related growth review ----
       A reference, and only a reference. The checks below are what stop a
       Growth score, band, or opportunity figure being smuggled in beside the
       id — which is the one way this report could start restating a
       conclusion it did not compute. */
    const related = bir.relatedGrowthReview;
    if (related !== null && related !== undefined) {
      if (typeof related !== 'object' || Array.isArray(related)) {
        push('invalid_related_review', 'relatedGrowthReview must be an object or null.');
      } else {
        RELATED_GROWTH_FIELDS.forEach(field => {
          if (related[field] === undefined) {
            push('incomplete_related_review', `relatedGrowthReview is missing ${field}.`);
          }
        });
        if (!offerings.isUuid(related.birId || '')) {
          push('invalid_related_bir_id', 'relatedGrowthReview.birId must be a UUID.');
        }
        if (!FRESHNESS_VALUES.includes(related.freshness)) {
          push('invalid_related_freshness',
            `relatedGrowthReview.freshness must be one of ${FRESHNESS_VALUES.join(', ')}.`);
        }
        /* A closed enum of FIELD NAMES, unique, and no longer than the enum
           itself. Accepting arbitrary strings here would let a value, an
           offering name, or a sentence be persisted into the report under a
           field whose name promises none of those. */
        if (!Array.isArray(related.prefilledFields)) {
          push('invalid_prefilled_fields',
            'relatedGrowthReview.prefilledFields must be an array of field names.');
        } else {
          if (related.prefilledFields.length > MAX_PREFILLED_FIELDS) {
            push('too_many_prefilled_fields',
              `relatedGrowthReview.prefilledFields may name at most ${MAX_PREFILLED_FIELDS} fields.`);
          }
          if (new Set(related.prefilledFields).size !== related.prefilledFields.length) {
            push('duplicate_prefilled_field',
              'relatedGrowthReview.prefilledFields must not repeat a field name.');
          }
          related.prefilledFields.forEach(field => {
            if (!PREFILLED_FIELD_NAMES.includes(field)) {
              push('unknown_prefilled_field',
                `relatedGrowthReview.prefilledFields may only name ${PREFILLED_FIELD_NAMES.join(', ')}.`);
            }
          });
        }
        if (related.usedInCalculations !== false) {
          push('growth_used_in_calculations',
            'No Growth Review figure enters a Service Mix calculation; usedInCalculations must be false.');
        }
        /* EXACTLY the five approved fields. Anything beyond them is refused by
           name, so a future "just the score, for context" is a failing test
           rather than a conversation. */
        Object.keys(related).forEach(key => {
          if (!RELATED_GROWTH_FIELDS.includes(key)) {
            push('related_review_extra_field',
              `relatedGrowthReview may not carry ${key}: it is a reference, not a copy.`);
          }
        });
      }
    }

    return { valid: errors.length === 0, errors };
  };

  const API = {
    SERVICE_MIX_BIR_SCHEMA_VERSION,
    SERVICE_MIX_REPORT_TYPE,
    SERVICE_MIX_REPORT_VERSION,
    SERVICE_MIX_ENGINE_VERSION,
    SERVICE_MIX_DISCLAIMER,
    DISCLAIMERS,
    RELATED_GROWTH_FIELDS,
    FRESHNESS_VALUES,
    PREFILLED_FIELD_NAMES,
    MAX_PREFILLED_FIELDS,
    sanitizePrefilledFields,
    SERVICE_MIX_STAGE,
    RESULT_STATES,
    REQUIRED_SECTIONS,
    generateServiceMixBir,
    validateServiceMixBir,
    aiOpportunityInputs,
    stableStringify,
    fnv1a
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDServiceMixBir = API;
})();
