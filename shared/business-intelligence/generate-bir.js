/* ============================================================
   CED Intelligence Platform — Business Intelligence Engine v1
   ------------------------------------------------------------
   Transforms one assessment submission into one Business
   Intelligence Report. Deterministic and total: same input, same
   output.

   A submission carries which STAGE of the review it completed.
   Stage 1 produces a preliminary report — a complete answer to a
   smaller question, not a degraded answer to the whole one. Stage 2
   produces the full report, which supersedes the preliminary one
   through provenance.supersedes while both remain readable.
   A payload with no stage declared predates progressive profiling
   and is treated as a full review.

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

  /* The nine deterministic dimensions. The SAME module the browser uses to
     build the payload, so the report cannot disagree with what was submitted
     about evidence it already has. */
  const intel = (typeof module !== 'undefined' && module.exports)
    ? require('../assessment-engine/intelligence.js')
    : window.CEDIntelligence;

  /* Additional appointments per WEEK implied by each capacity answer. The low
     end of each band is used deliberately: an estimate that overstates what a
     business can absorb is the one that does harm. */
  const CAPACITY_PER_WEEK = {
    none: 0, '1_5': 1, '6_10': 6, '11_20': 11, over_20: 21
  };
  const WEEKS_PER_MONTH = 4.33;

  /* Which opportunity drivers need capacity that does not exist yet, and which
     merely refill a slot the business already had. Recovering a no-show puts
     someone into an appointment that was already on the book; recovering a
     missed call adds one. Only the second is bounded by headroom. */
  const NEW_DEMAND_DRIVERS = ['missed_calls', 'reactivation'];
  const BACKFILL_DRIVERS = ['no_shows', 'cancellations'];

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

  /* ---------- stage ----------

     A payload with no assessmentStage block predates progressive profiling and
     carried the whole question set in one pass, so it is a FULL review. Any
     other default would retroactively relabel every report already generated
     as preliminary. */
  const readStage = submission => {
    const raw = submission && submission.assessmentStage;
    if (!raw || typeof raw !== 'object') {
      return { stage: 2, stage1CompletedAt: null, stage2CompletedAt: null,
               supersedesSubmissionId: null, trigger: null, declared: false };
    }
    return {
      stage: Number(raw.stage) === 1 ? 1 : 2,
      stage1CompletedAt: raw.stage1CompletedAt || null,
      stage2CompletedAt: raw.stage2CompletedAt || null,
      supersedesSubmissionId: raw.supersedesSubmissionId || null,
      trigger: raw.trigger || null,
      declared: true
    };
  };

  /* The four result states, resolved deterministically. Stage 1 lands on
     preliminary_results only when nothing is outstanding — which cannot happen
     in a vertical whose Stage 2 asks anything at all, and is kept because the
     rule is about the evidence, not about this vertical's question list. */
  const resolveResultState = ({ stage, missingStage2, band }) => {
    if (stage === 1) {
      return missingStage2.length ? 'fit_review_available' : 'preliminary_results';
    }
    return (band === 'present_offer' || band === 'ask_for_sale')
      ? 'activation_ready'
      : 'fit_review_complete';
  };

  /* ---------- capacity ---------- */

  /* What the business says it could absorb, in appointments and in dollars.
     Returns nulls rather than guesses when the evidence is absent. */
  const computeCapacity = answers => {
    const band = present(answers, 'capacity90Day') ? String(answers.capacity90Day) : null;
    const known = band !== null && band !== 'unsure' &&
      Object.prototype.hasOwnProperty.call(CAPACITY_PER_WEEK, band);

    const perWeek = known ? CAPACITY_PER_WEEK[band] : null;
    const perMonth = perWeek === null ? null : round2(perWeek * WEEKS_PER_MONTH);
    const ticket = num(answers, 'averageTicket');
    const ceiling = perMonth === null || ticket <= 0 ? null : round2(perMonth * ticket);

    const throughput = present(answers, 'appointmentsDay') && present(answers, 'daysOpen')
      ? round2(num(answers, 'appointmentsDay') * num(answers, 'daysOpen'))
      : null;

    let headroomBand = 'unknown';
    if (known) {
      if (perWeek === 0) headroomBand = 'none';
      else if (perWeek <= 5) headroomBand = 'limited';
      else if (perWeek <= 10) headroomBand = 'moderate';
      else headroomBand = 'ample';
    }

    /* Higher headroom means LOWER oversell risk. Stated because the two run
       in opposite directions and one has already been confused for the other. */
    let oversellRisk = 'unknown';
    if (known) {
      oversellRisk = perWeek === 0 ? 'high' : perWeek <= 5 ? 'moderate' : 'low';
    }

    return {
      band, known, perWeek, perMonth, ceiling, throughput, headroomBand, oversellRisk,
      ticketKnown: ticket > 0
    };
  };

  /* Shares of the estimate by driver, recomputed from the answers using the
     same shape as the vertical's formula. Only the PROPORTIONS are used: they
     are applied to the point figure the visitor was actually shown, so the
     total can never drift from what they saw even if a coefficient changes. */
  const opportunityShares = answers => {
    const ticket = num(answers, 'averageTicket');
    const days = num(answers, 'daysOpen');
    const parts = {
      missed_calls: num(answers, 'missedCallsDay') * 0.35 * ticket * days,
      no_shows: num(answers, 'noShowsWeek') * ticket * 4.33,
      cancellations: num(answers, 'cancelsWeek') * ticket * 4.33,
      reactivation: num(answers, 'inactiveClients') * 0.06 * ticket
    };
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    const shares = {};
    Object.keys(parts).forEach(k => { shares[k] = parts[k] / total; });
    return shares;
  };

  /* Applies the capacity ceiling to the portion of the estimate that actually
     needs new capacity. Backfill is left alone: filling a slot the business
     already had does not require headroom it does not have. */
  const applyCapacityClamp = ({ point, answers, capacity }) => {
    if (!capacity.known || capacity.ceiling === null) {
      return {
        point: round2(point),
        clampApplied: false,
        clampReason: capacity.band === 'unsure'
          ? 'The business reported it does not know its 90-day headroom, so no ceiling can be applied. The estimate remains uncapped and its ceiling is unknown.'
          : 'Capacity evidence is missing, so no ceiling can be applied. The estimate remains uncapped and its ceiling is unknown.',
        ceiling: null,
        newDemandPortion: null,
        backfillPortion: null
      };
    }

    const shares = opportunityShares(answers);
    /* With no usable shares, treat the whole estimate as new demand. That is
       the conservative direction: it clamps harder, never softer. */
    const newDemandShare = shares
      ? NEW_DEMAND_DRIVERS.reduce((sum, k) => sum + (shares[k] || 0), 0)
      : 1;
    const backfillShare = shares
      ? BACKFILL_DRIVERS.reduce((sum, k) => sum + (shares[k] || 0), 0)
      : 0;

    const newDemand = point * newDemandShare;
    const backfill = point * backfillShare;
    const cappedNewDemand = Math.min(newDemand, capacity.ceiling);
    const adjusted = backfill + cappedNewDemand;
    const clamped = cappedNewDemand < newDemand - 0.005;

    return {
      point: round2(adjusted),
      clampApplied: clamped,
      clampReason: clamped
        ? `Capacity-limited: the business reported it could absorb about ${capacity.perMonth} additional appointments per month, a ceiling of ${round2(capacity.ceiling)} USD on newly created demand. Recovery of existing booked slots is not capped.`
        : `Reported capacity of about ${capacity.perMonth} additional appointments per month exceeds the newly created demand in this estimate, so no clamp was required.`,
      ceiling: round2(capacity.ceiling),
      newDemandPortion: round2(newDemand),
      backfillPortion: round2(backfill)
    };
  };

  /* One bound of the capacity-adjusted range.

     The confidence spread must be applied to the COMPONENTS and the ceiling
     re-applied afterwards, never to the already-clamped point. Widening the
     clamped point re-inflates newly created demand back above the ceiling the
     same report states a line earlier: a business with headroom for 4.33
     appointments a month at a 50 USD ticket was told its ceiling was 216.50
     and shown a range topping at 281.45. That is the report contradicting
     itself, and it reads as the capacity answer having raised the estimate —
     which CLAUDE.md section 4 forbids in either direction.

     Backfill keeps its full spread: recovering a booked slot needs no
     headroom, so no ceiling bounds it. */
  const capacityAdjustedBound = (clamp, factor) => {
    if (clamp.ceiling === null) return round2(clamp.point * factor);
    const newDemand = Math.min((clamp.newDemandPortion || 0) * factor, clamp.ceiling);
    const backfill = (clamp.backfillPortion || 0) * factor;
    return round2(newDemand + backfill);
  };

  /* ---------- confidence ---------- */

  const computeConfidence = (answers, capacity, stage = 2) => {
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
    const capacityKnown = Boolean(capacity && capacity.known);
    if (!capacityKnown && score >= HIGH_BAND_MIN) {
      score = HIGH_BAND_MIN - 0.01;
      reasons.push(capacity && capacity.band === 'unsure'
        ? 'Capped below high confidence: the business does not know its 90-day headroom, so the estimate has no known ceiling.'
        : 'Capped below high confidence: capacity was not answered, so the estimate has no known ceiling.');
    }
    if (capacityKnown) {
      reasons.push(`Capacity is known: about ${capacity.perMonth} additional appointments per month.`);
      if (!capacity.ticketKnown) {
        reasons.push('Average ticket is missing, so the capacity ceiling cannot be expressed in currency.');
      }
    }

    score = round2(Math.max(0, Math.min(1, score)));

    /* Every field this measure reads is asked in Stage 1, so a preliminary
       score is directly comparable to a full one. `kind` says which claim it
       is confidence IN, and is not a second quality grade. */
    const policy = schema.STAGE_POLICY[stage] || schema.STAGE_POLICY[2];

    return {
      score,
      band: bandFor(score),
      kind: policy.confidenceKind,
      completeness: round2(completeness),
      consistency: round2(consistency),
      freshness,
      reasons
    };
  };

  /* ---------- the figure the visitor is shown ----------

     Returns EXACTLY financialOpportunityProfile.capacityAdjusted, computed by
     the same functions, so the page and the report can never disagree about
     what is realistically capturable. The page must never show a larger point
     figure than this — see CLAUDE.md section 4. */
  const visibleOpportunityRange = ({ point, answers }) => {
    const capacity = computeCapacity(answers);
    const confidence = computeConfidence(answers, capacity);
    const spread = schema.RANGE_SPREAD_BY_CONFIDENCE[confidence.band];
    const clamp = applyCapacityClamp({ point, answers, capacity });

    return {
      low: capacityAdjustedBound(clamp, spread.low),
      point: clamp.point,
      high: capacityAdjustedBound(clamp, spread.high),
      unconstrainedPoint: round2(point),
      capacityKnown: capacity.known && clamp.ceiling !== null,
      capacityBand: capacity.band,
      capacityPerMonth: capacity.perMonth,
      clampApplied: clamp.clampApplied,
      confidenceBand: confidence.band
    };
  };

  /* ---------- close readiness ---------- */

  const computeCloseReadiness = ({ answers, confidence, packageRecommendation, dimensions, capacity, stage = 2 }) => {
    const policy = schema.STAGE_POLICY[stage] || schema.STAGE_POLICY[2];
    /* A signal with no evidence scores 0 AND is listed as unknown. Scoring it
       zero keeps readiness honestly low; listing it stops the zero from being
       mistaken for a measurement. Unknown is never favourable. */
    const known = {};
    const unknown = [];
    const basis = {};

    const fromDimension = (signalKey, dimension, sourceField) => {
      if (dimension && dimension.score !== null) {
        known[signalKey] = dimension.score;
        basis[signalKey] = ['assessment_submission', dimension.id];
      } else {
        known[signalKey] = 0;
        unknown.push(signalKey);
        basis[signalKey] = [sourceField ? `${sourceField}_not_answered` : 'not_collected_by_assessment'];
      }
    };

    known.packageFit = packageRecommendation && packageRecommendation.id ? 60 : 0;
    basis.packageFit = ['assessment_submission'];
    known.estimateConfidence = Math.round(confidence.score * 100);
    basis.estimateConfidence = ['derived'];
    known.engagementBehavior = 70;  /* completed the full assessment unprompted */
    basis.engagementBehavior = ['assessment_submission'];

    fromDimension('decisionAuthority', dimensions.decisionReadiness, 'canApprove');
    fromDimension('budgetSignals', dimensions.budgetReadiness, 'budgetSignal');
    fromDimension('capacity', dimensions.capacityReadiness, 'capacity90Day');
    fromDimension('implementationCompatibility', dimensions.implementationCompatibility, 'bookingPlatform');

    /* Urgency is its own signal, read directly rather than through the blended
       decisionReadiness score. */
    const urgencyScore = intel.SCALES.urgency[String(answers.urgency || '')];
    if (urgencyScore === undefined || urgencyScore === null) {
      known.urgency = 0;
      unknown.push('urgency');
      basis.urgency = ['urgency_not_answered'];
    } else {
      known.urgency = urgencyScore;
      basis.urgency = ['assessment_submission'];
    }

    /* objectionSeverity runs the OTHER WAY: high severity means low
       resolution. Inverted here once, deliberately and visibly. */
    const objections = dimensions.objectionSeverity;
    if (objections.score === null) {
      known.objectionsResolved = 0;
      unknown.push('objectionsResolved');
      basis.objectionsResolved = ['primaryConcern_not_answered'];
    } else {
      known.objectionsResolved = 100 - objections.score;
      basis.objectionsResolved = ['assessment_submission', 'objectionSeverity_inverted'];
    }

    /* Scope standardization: a single site fits the standard offer. More than
       one does not, until a standardized multi-site scope exists. */
    const complexity = dimensions.multiLocationComplexity;
    if (complexity.score === null) {
      known.scopeStandardization = 0;
      unknown.push('scopeStandardization');
      basis.scopeStandardization = ['locationCount_not_answered'];
    } else {
      known.scopeStandardization = complexity.requiresCustomScope ? 0 : 100;
      basis.scopeStandardization = ['assessment_submission'];
    }

    /* Which signals this stage is entitled to score. At Stage 2 that is all of
       them and the weights already total 1, so the arithmetic below is
       identical to what it has always been. At Stage 1 it is the subset Stage 1
       actually asked about, renormalised — scoring the unasked ones as zero
       would report "not asked" as "answered badly" and cap every preliminary
       result near 35 regardless of the business. */
    const inScope = new Set(stage === 1
      ? schema.STAGE1_READINESS_SIGNALS
      : schema.CLOSE_READINESS_SIGNALS.map(s => s.key));

    const signals = {};
    schema.CLOSE_READINESS_SIGNALS.forEach(({ key }) => {
      signals[key] = {
        score: known[key] === undefined ? 0 : known[key],
        known: !unknown.includes(key),
        /* False means "this stage did not ask, and did not score it" — not
           "it scored zero". Downstream must not average across the two. */
        inScope: inScope.has(key),
        basis: basis[key] || ['not_collected_by_assessment']
      };
    });

    const scoped = schema.CLOSE_READINESS_SIGNALS.filter(s => inScope.has(s.key));
    const scopedWeight = scoped.reduce((sum, s) => sum + s.weight, 0);
    const score = scopedWeight === 0 ? 0 : Math.round(
      scoped.reduce((sum, s) => sum + signals[s.key].score * s.weight, 0) / scopedWeight);

    const bandHit = schema.READINESS_BANDS.find(b => score >= b.min && score <= b.max);
    const bandBeforeBlockers = bandHit ? bandHit.id : 'educate';

    /* ---- hard blockers: these force escalate regardless of score ---- */
    const hardBlockers = [];
    const compat = dimensions.implementationCompatibility;
    if (compat.integrationStatus === 'unsupported' || compat.customIntegrationNeeded === 'yes') {
      hardBlockers.push('unsupported_integration');
    }
    /* Multi-location is not a judgement about the prospect. There is simply no
       standardized multi-site scope to sell them yet, so it cannot close
       itself. Revisit when that scope exists — see the note in the schema. */
    if (complexity.requiresCustomScope) hardBlockers.push('multiple_locations');
    /* States outright that they cannot decide, and cannot name who can. */
    if (String(answers.canApprove || '') === 'no' && !dimensions.decisionReadiness.approvalPathKnown) {
      hardBlockers.push('authority_absent');
    }

    /* ---- soft blockers: these cap the band ---- */
    const candidateSoftBlockers = [];
    if (unknown.includes('decisionAuthority')) candidateSoftBlockers.push('unknown_decision_authority');
    if (confidence.band === 'low') candidateSoftBlockers.push('low_estimate_confidence');
    if (objections.unresolved) candidateSoftBlockers.push('unresolved_objection');
    if (objections.severe) candidateSoftBlockers.push('severe_objection');
    if (capacity.known && capacity.oversellRisk === 'high') candidateSoftBlockers.push('capacity_oversell_risk');
    /* Cannot approve alone but a path exists: not a hard stop, but not
       something to ask for the sale on either. */
    if (String(answers.canApprove || '') !== 'yes' &&
        dimensions.decisionReadiness.approvalPathKnown &&
        !hardBlockers.includes('authority_absent')) {
      candidateSoftBlockers.push('no_defined_approval_path');
    }

    /* At Stage 1 the blockers that exist only because we chose not to ask are
       set aside and reported as deferred. Capping a preliminary result for a
       question we deliberately withheld would recreate the friction this split
       removes, and would say something about the prospect that the evidence
       does not support. They apply in full at Stage 2. */
    const deferredBlockers = stage === 1
      ? candidateSoftBlockers.filter(b => schema.STAGE2_EVIDENCE_BLOCKERS.includes(b))
      : [];
    const softBlockers = candidateSoftBlockers.filter(b => !deferredBlockers.includes(b));

    const order = schema.READINESS_BANDS.map(b => b.id);
    let band = bandBeforeBlockers;

    /* The stage ceiling is applied BEFORE the blockers so that a hard blocker
       can still route to escalate. Stage 1 may never ask for the sale, however
       good the operational picture looks. */
    let stageCapApplied = false;
    if (policy.maxBand && order.indexOf(band) > order.indexOf(policy.maxBand)) {
      band = policy.maxBand;
      stageCapApplied = true;
    }

    softBlockers.forEach(blocker => {
      const cap = schema.SOFT_BLOCKERS[blocker];
      if (cap && order.indexOf(band) > order.indexOf(cap)) band = cap;
    });

    /* Escalate is orthogonal to the ladder, not the top of it: it means a
       human must look, not that the prospect is closest to buying. A hard
       blocker overrides any score, however high. */
    if (hardBlockers.length) band = 'escalate';

    const unresolvedObjections = [];
    if (objections.unresolved) {
      unresolvedObjections.push({
        concern: objections.primaryConcern,
        severe: objections.severe,
        hasDetail: objections.hasDetail,
        source: 'assessment_submission'
      });
    }

    return {
      score,
      band,
      bandBeforeBlockers,
      stage,
      /* True whenever readiness was computed without the Stage 2 evidence.
         A provisional band is a statement about what we asked, and must never
         be read as a settled judgement about the prospect. */
      provisional: policy.closeReadinessProvisional,
      stageCapApplied,
      scoredSignalWeight: round2(scopedWeight),
      deferredBlockers,
      signals,
      unknownSignals: unknown,
      hardBlockers,
      softBlockers,
      /* Set only at ask_for_sale, and only from a stage entitled to say it.
         The wording itself lives in schema.APPROVED_CLOSE_LANGUAGE and is not
         displayed by the results UI — it is carried for the Closing Engine. */
      approvedLanguageKey: band === 'ask_for_sale' && policy.mayUseApprovedCloseLanguage
        ? 'ask_for_sale' : null,
      unresolvedObjections,
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

    /* Identity evidence is a form field AND a contact field, so it arrives in
       both places. Reading either keeps the report correct whichever shape a
       caller sends, without letting contact override a real answer. */
    const evidenceAnswers = { ...answers };
    ['businessPhone', 'website', 'googleProfile', 'locationCount'].forEach(key => {
      if (!present(evidenceAnswers, key) && present(contact, key)) {
        evidenceAnswers[key] = contact[key];
      }
    });

    /* Recomputed here rather than trusted from the payload: the browser sends
       its own copy, but the report is the authority and must be derivable from
       the answers alone. Both use the same module, so they agree. */
    const intelligence = intel.computeDimensions(evidenceAnswers);
    const capacity = computeCapacity(answers);
    const stageMeta = readStage(submission);
    const stage = stageMeta.stage;

    const confidence = computeConfidence(answers, capacity, stage);
    const spread = schema.RANGE_SPREAD_BY_CONFIDENCE[confidence.band];

    /* Carried through, never recomputed. The Growth Score and the opportunity
       point figure are exactly what the visitor was shown. */
    const point = Number.isFinite(Number(results.opportunity)) ? Number(results.opportunity) : 0;
    const low = round2(point * spread.low);
    const high = round2(point * spread.high);

    const clamp = applyCapacityClamp({ point, answers, capacity });
    const adjustedLow = capacityAdjustedBound(clamp, spread.low);
    const adjustedHigh = capacityAdjustedBound(clamp, spread.high);

    const closeReadiness = computeCloseReadiness({
      answers, confidence, packageRecommendation: pkg, dimensions: intelligence, capacity, stage
    });

    const missingStage2 = intel.missingStage2Evidence(evidenceAnswers);
    const resultState = resolveResultState({
      stage, missingStage2, band: closeReadiness.band
    });

    const branching = submission.branching || null;

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
      { id: 'ev-drivers', kind: 'derived', field: 'financialOpportunityProfile.drivers',
        statement: 'Driver shares recomputed from the answers and applied to the point figure the visitor was shown.',
        sourceRef: submission.submissionId, weight: 0.5 },
      { id: 'ev-capacity', kind: capacity.known ? 'answer' : 'policy', field: 'capacityProfile',
        statement: clamp.clampReason,
        sourceRef: capacity.known ? submission.submissionId : 'assessment-config',
        weight: capacity.known ? 1 : 0 },
      { id: 'ev-readiness', kind: 'derived', field: 'closeReadinessProfile',
        statement: `${closeReadiness.unknownSignals.length} of ${schema.CLOSE_READINESS_SIGNALS.length} readiness signals have no evidence and score zero.`,
        sourceRef: submission.submissionId, weight: 0.5 },
      { id: 'ev-stage', kind: 'policy', field: 'assessmentProgress',
        statement: stage === 1
          ? `Preliminary report from the Growth Review. ${missingStage2.length} item(s) of fit and activation evidence were deliberately not requested, close readiness is provisional, and the band is capped at ${schema.STAGE_POLICY[1].maxBand}.`
          : 'Full report from the completed Fit and Activation Review. All readiness signals were in scope.',
        sourceRef: submission.submissionId, weight: stage === 1 ? 0 : 1 }
    ];

    /* Only what is genuinely still missing. A field the visitor was never
       shown because the branch did not apply is reported separately, because
       "not applicable" and "unanswered" are not the same gap. */
    const missingCriticalFields = intel
      .missingEvidence(answers, branching ? branching.visibleFields : null)
      .filter(m => m.reason === 'unanswered')
      /* On a preliminary report, Stage 2 evidence is not missing — it has not
         been requested. It is reported under assessmentProgress instead, so
         that "we have not asked yet" is never mistaken for "they would not
         say". */
      .filter(m => !(stage === 1 && missingStage2.includes(m.field)))
      .map(m => `answers.${m.field}`);
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

      /* Where the visitor had got to when this report was generated. A
         preliminary report is never rewritten: the full report supersedes it
         through provenance.supersedes and both stay readable. */
      assessmentProgress: {
        assessmentStageCompleted: stage,
        stage1CompletedAt: stageMeta.stage1CompletedAt,
        stage2CompletedAt: stage === 2 ? stageMeta.stage2CompletedAt : null,
        resultState,
        confidenceKind: confidence.kind,
        closeReadinessProvisional: closeReadiness.provisional,
        missingStage2Evidence: missingStage2,
        stage1SubmissionId: stage === 2 ? stageMeta.supersedesSubmissionId : null,
        supersedesPreliminaryBir: stage === 2 && Boolean(stageMeta.supersedesSubmissionId),
        continuedBy: stageMeta.trigger,
        stageDeclared: stageMeta.declared
      },

      businessProfile: {
        displayName: contact.salonName || null,
        industry: null,
        subIndustry: vertical.id || null,
        locationCount: present(answers, 'locationCount') ? num(answers, 'locationCount') : null,
        yearsInBusiness: present(answers, 'yearsInBusiness') ? String(answers.yearsInBusiness) : null,
        staffCount: present(answers, 'technicians') ? num(answers, 'technicians') : null,
        serviceArea: null
      },

      /* POLARITY WARNING: headroomBand "none" is the WORST case (no room at
         all), not the best. See schema.POLARITY.capacityHeadroom. */
      capacityProfile: {
        currentThroughputPerMonth: capacity.throughput,
        unusedCapacityPerMonth: capacity.perMonth,
        maxPracticalCapacityPerMonth: capacity.throughput !== null && capacity.perMonth !== null
          ? round2(capacity.throughput + capacity.perMonth)
          : null,
        additionalCapacity90Day: capacity.perMonth,
        additionalCapacity90DayBand: capacity.band,
        headroomRatio: capacity.throughput > 0 && capacity.perMonth !== null
          ? round2(capacity.perMonth / capacity.throughput)
          : null,
        headroomBand: capacity.headroomBand,
        staffingExpandable: String(answers.staffingExpandable || 'unknown'),
        hoursExpandable: String(answers.hoursExpandable || 'unknown'),
        spaceOrEquipmentConstrained: String(answers.spaceConstraint || 'unknown'),
        willingnessToExpand: String(answers.willingnessToExpand || 'unknown'),
        capacityLeadTime: String(answers.capacityLeadTime || 'unknown'),
        operationalReadiness: intelligence.expansionReadiness.score,
        oversellRisk: capacity.oversellRisk,
        capacityCeilingPerMonth: clamp.ceiling,
        /* Explicit so a consumer can tell "no ceiling exists" from
           "a ceiling exists and we did not apply it". */
        ceilingKnown: capacity.known && clamp.ceiling !== null
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
        bookingSystem: intelligence.implementationCompatibility.bookingPlatform,
        bookingSystemRetention: String(answers.bookingPlatformStaying || 'unknown'),
        phoneSetup: intelligence.implementationCompatibility.phoneSetup,
        mustKeepNumber: String(answers.keepNumber || 'unknown'),
        willingToChangeSoftware: String(answers.willingToChangeSoftware || 'unknown'),
        customIntegrationNeeded: String(answers.customIntegrationNeeded || 'unknown'),
        migrationConcern: String(answers.migrationConcern || 'unknown'),
        multiLocationSystems: String(answers.multiLocationSystems || 'unknown'),
        integrationCompatibility: intelligence.implementationCompatibility.integrationStatus,
        compatibilityScore: intelligence.implementationCompatibility.score,
        knownBlockers: closeReadiness.hardBlockers
          .filter(b => b === 'unsupported_integration' || b === 'multiple_locations')
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
          point: clamp.point,
          low: adjustedLow,
          high: adjustedHigh,
          clampApplied: clamp.clampApplied,
          clampReason: clamp.clampReason,
          ceiling: clamp.ceiling,
          newDemandPortion: clamp.newDemandPortion,
          backfillPortion: clamp.backfillPortion
        },
        drivers: (() => {
          const shares = opportunityShares(answers);
          if (!shares) return [];
          return Object.keys(shares).map(key => ({
            driver: key,
            share: round2(shares[key]),
            amount: round2(point * shares[key]),
            needsNewCapacity: NEW_DEMAND_DRIVERS.includes(key)
          }));
        })(),
        isDiagnosticEstimate: true,
        disclaimer: results.disclaimer || null
      },

      riskProfile: {
        oversellRisk: capacity.oversellRisk,
        dataQualityRisk: confidence.band === 'high' ? 'low' : confidence.band === 'medium' ? 'moderate' : 'high',
        implementationRisk: intelligence.implementationCompatibility.score === null ? 'unknown'
          : intelligence.implementationCompatibility.score >= 70 ? 'low'
          : intelligence.implementationCompatibility.score >= 40 ? 'moderate' : 'high',
        churnRisk: 'unknown',
        complianceFlags: [],
        notes: capacity.known
          ? [`Capacity reported as "${capacity.band}"; the estimate is bounded accordingly.`]
          : ['Capacity evidence absent; growth recommendations must not be made from this report alone.']
      },

      /* The nine deterministic dimensions, each carrying its own range,
         polarity, confidence and supporting evidence. TWO OF THEM RUN THE
         OTHER WAY — multiLocationComplexity and objectionSeverity are
         higher-is-worse. Read `polarity` before comparing anything. */
      intelligenceDimensions: intelligence,

      /* Which questions this visitor actually saw, so a gap can be read as
         "did not apply" rather than "declined to answer". */
      evidencePath: branching ? {
        questionSetVersion: branching.questionSetVersion || null,
        visibleSteps: branching.visibleSteps || [],
        totalSteps: branching.totalSteps || null,
        visibleFields: branching.visibleFields || [],
        skippedFields: branching.skippedFields || [],
        staleClearedFields: branching.staleClearedFields || [],
        notApplicable: intel.missingEvidence(answers, branching.visibleFields || null)
          .filter(m => m.reason === 'not_applicable_to_this_path')
          .map(m => m.field)
      } : {
        questionSetVersion: null, visibleSteps: [], totalSteps: null,
        visibleFields: [], skippedFields: [], staleClearedFields: [], notApplicable: [],
        note: 'Payload predates branching metadata; every gap reads as unanswered.'
      },

      /* Visitor-supplied identity evidence. Unverified by definition — it
         improves candidate ranking and can never link a record on its own. */
      identityEvidence: {
        businessPhone: contact.businessPhone || null,
        website: contact.website || null,
        googleProfile: contact.googleProfile || null,
        locationCount: present(answers, 'locationCount') ? num(answers, 'locationCount') : null,
        quality: intelligence.identityConfidenceInput.score,
        verified: false,
        autoLinkEligible: false,
        source: 'visitor_supplied'
      },

      estimateConfidence: confidence,

      qualificationProfile: {
        /* Qualified only when the evidence close readiness needs is actually
           present. Coverage, not favourability — an unqualified-looking
           prospect who answered everything is still "qualified" as a record. */
        outcome: intelligence.closeReadinessEvidence.score >= 75
          ? 'qualified'
          : 'insufficient_data',
        score: intelligence.closeReadinessEvidence.score,
        icpFit: null,
        disqualifiers: [],
        missingCriticalFields,
        evidenceCoverage: intelligence.closeReadinessEvidence.score,
        segment: vertical.id || null
      },

      /* Decision, budget and objection evidence, surfaced where a future
         Closing Engine will look for it rather than buried in the dimensions. */
      decisionProfile: {
        respondentRole: intelligence.decisionReadiness.respondentRole,
        canApprove: intelligence.decisionReadiness.canApprove,
        otherApprovers: intelligence.decisionReadiness.otherApprovers,
        approvalPathKnown: intelligence.decisionReadiness.approvalPathKnown,
        decisionTiming: String(answers.decisionTiming || 'unknown'),
        startTiming: String(answers.startTiming || 'unknown'),
        urgency: String(answers.urgency || 'unknown'),
        changeReason: answers.changeReason || null,
        readinessScore: intelligence.decisionReadiness.score
      },

      budgetProfile: {
        signal: String(answers.budgetSignal || 'unknown'),
        readinessScore: intelligence.budgetReadiness.score,
        declined: intelligence.budgetReadiness.declined,
        /* Affordability signal only. This platform never collects revenue,
           balances, or credit information — see CLAUDE.md section 9. */
        note: 'Self-reported affordability signal. No financial data is collected.'
      },

      objectionProfile: {
        primaryConcern: intelligence.objectionSeverity.primaryConcern,
        severity: intelligence.objectionSeverity.score,
        severe: intelligence.objectionSeverity.severe,
        unresolved: intelligence.objectionSeverity.unresolved,
        priorBadExperience: String(answers.priorBadExperience || 'unknown'),
        hasDetail: intelligence.objectionSeverity.hasDetail,
        hasOpenQuestions: intelligence.objectionSeverity.hasOpenQuestions,
        /* Free text is evidence for a human. It is never parsed for meaning
           and never drives a band on its own. */
        detail: answers.concernDetail || null,
        openQuestions: answers.openQuestions || null
      },

      closeReadinessProfile: closeReadiness,

      recommendedNextAction: {
        action: identityStatus === 'resolution_pending' ? 'await_identity_review'
          : stage === 1 ? 'offer_fit_review'
          : 'deliver_results',
        rationale: identityStatus === 'resolution_pending'
          ? 'Identity could not be resolved automatically; a person must confirm which business this is.'
          : stage === 1
            ? 'Preliminary results were delivered. The Fit and Activation Review is offered to the visitor and remains optional.'
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
        /* Standard scope requires a known single location. Unknown must never
           read as confirmed, so it stays false until location count is given. */
        scopeStandard: intelligence.multiLocationComplexity.score !== null &&
          !intelligence.multiLocationComplexity.requiresCustomScope
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

    const progress = bir.assessmentProgress;
    if (!progress || typeof progress !== 'object') {
      push('missing_progress', 'assessmentProgress is required.');
    } else {
      if (![1, 2].includes(progress.assessmentStageCompleted)) {
        push('invalid_stage', 'assessmentProgress.assessmentStageCompleted must be 1 or 2.');
      }
      if (!schema.VOCAB.resultState.includes(progress.resultState)) {
        push('invalid_result_state', `Unknown resultState: ${progress.resultState}`);
      }
      if (!schema.VOCAB.confidenceKind.includes(progress.confidenceKind)) {
        push('invalid_confidence_kind', `Unknown confidenceKind: ${progress.confidenceKind}`);
      }
      /* The two rules that protect a preliminary report from being read, or
         acted on, as a finished one. */
      if (progress.assessmentStageCompleted === 1) {
        if (readiness && readiness.band === 'ask_for_sale') {
          push('stage1_asked_for_sale', 'A Stage 1 report may never reach the ask_for_sale band.');
        }
        if (readiness && readiness.approvedLanguageKey) {
          push('stage1_close_language', 'A Stage 1 report may never carry approved close language.');
        }
        if (progress.closeReadinessProvisional !== true) {
          push('stage1_not_provisional', 'Stage 1 close readiness must be marked provisional.');
        }
        if (progress.stage2CompletedAt) {
          push('stage1_with_stage2_timestamp', 'A Stage 1 report must not carry stage2CompletedAt.');
        }
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
    CAPACITY_PER_WEEK,
    NEW_DEMAND_DRIVERS,
    BACKFILL_DRIVERS,
    computeCapacity,
    applyCapacityClamp,
    visibleOpportunityRange,
    readStage,
    resolveResultState,
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
