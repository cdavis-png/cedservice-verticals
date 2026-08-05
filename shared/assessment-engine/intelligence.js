/* ============================================================
   CED Service — Assessment Intelligence
   ------------------------------------------------------------
   Nine deterministic dimensions derived from the evidence the
   assessment now collects. Separate from the Growth Score on
   purpose: the Growth Score measures the operational problem,
   these measure whether we can responsibly sell into it, and
   mixing the two would corrupt a figure shown to the visitor.

   THE GROWTH SCORE IS NOT TOUCHED BY ANYTHING IN THIS FILE.

   ------------------------------------------------------------
   Field names are a SHARED CONTRACT

   The questions, copy, and answer wording stay in each
   vertical's config. The field NAMES below do not: this module
   is loaded by the browser to build the payload and by
   generate-bir.js to build the report, and if the two disagreed
   about what a field is called the report would silently score
   evidence it already had as unknown.

   A vertical renames one of these at its peril. See
   docs/ASSESSMENT_INTELLIGENCE_EXPANSION.md.

   ------------------------------------------------------------
   POLARITY IS NOT UNIFORM. READ THIS BEFORE USING A SCORE.

   Seven dimensions are "higher is better". TWO ARE NOT:

     · multiLocationComplexity — higher means MORE complex
     · objectionSeverity       — higher means MORE resistance

   A previous milestone shipped an enum whose meaning inverted
   between two profiles and it took a review to catch. Every
   dimension therefore declares its polarity as data, and
   nothing here is comparable to anything else without reading
   it first.

   ------------------------------------------------------------
   Unknown is never favourable

   A missing answer scores null and is listed, never defaulted
   to a midpoint. Confidence reports how much of the dimension's
   evidence was actually present. Callers that treat null as
   zero are wrong; callers that treat null as "fine" are worse.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  /* ---------- the shared field-name contract ---------- */

  const FIELDS = {
    structure: ['locationCount', 'yearsInBusiness', 'businessPhone', 'website',
                'googleProfile', 'bookingPlatform', 'bookingPlatformStaying'],
    capacity: ['capacity90Day', 'staffingExpandable', 'hoursExpandable',
               'spaceConstraint', 'willingnessToExpand', 'capacityLeadTime'],
    decision: ['respondentRole', 'canApprove', 'otherApprovers', 'decisionTiming',
               'startTiming', 'urgency', 'changeReason'],
    budget: ['budgetSignal'],
    implementation: ['phoneSetup', 'keepNumber', 'willingToChangeSoftware',
                     'multiLocationSystems', 'customIntegrationNeeded', 'migrationConcern'],
    objections: ['primaryConcern', 'concernDetail', 'priorBadExperience', 'openQuestions'],
    identity: ['businessPhone', 'website', 'googleProfile', 'locationCount']
  };

  const ALL_FIELDS = [...new Set(Object.values(FIELDS).flat())];

  /* Answers that are never required and must never gate completion. */
  const OPTIONAL_FIELDS = ['businessPhone', 'website', 'googleProfile',
                           'concernDetail', 'openQuestions', 'changeReason'];

  /* ---------- which stage owns which evidence ----------

     Progressive profiling splits the review in two. Stage 1 is the Growth
     Review: enough to diagnose the operational problem, produce the Growth
     Score, and bound the estimate by capacity. Stage 2 is the Fit and
     Activation Review: everything that only matters once someone is deciding
     whether to buy.

     Only two of the intelligence fields belong to Stage 1, and both earn it:

       · locationCount  — scope. A multi-site business cannot be sized against
                          the standard offer, and that is true of the DIAGNOSIS,
                          not just of the sale.
       · capacity90Day  — the ceiling. Without it the visible estimate cannot
                          honestly be bounded, and CLAUDE.md section 4 forbids
                          pairing a figure with anything that implies we will
                          deliver the demand to fill it.

     Everything else is Stage 2. A Stage 1 report is not a degraded Stage 2
     report: it is a complete answer to a smaller question, and it says so.

     This split is a SHARED CONTRACT for the same reason the field names are —
     the browser decides what to ask from it and generate-bir.js decides what
     to call "missing" from it. Two disagreeing copies would report evidence
     as withheld when it was simply not yet requested. */
  const STAGE1_FIELDS = ['locationCount', 'capacity90Day'];
  const STAGE2_FIELDS = ALL_FIELDS.filter(f => !STAGE1_FIELDS.includes(f));

  const STAGE_FIELDS = { 1: STAGE1_FIELDS, 2: STAGE2_FIELDS };

  /* ---------- ordinal scales ----------
     Each maps an answer token to a 0..100 contribution. `unsure` and absent
     answers are deliberately NOT in these maps: they resolve to null. */

  const SCALES = {
    capacity90Day: { none: 0, '1_5': 30, '6_10': 55, '11_20': 80, over_20: 100 },
    staffingExpandable: { no: 0, maybe: 55, yes: 100 },
    hoursExpandable: { no: 0, maybe: 55, yes: 100 },
    spaceConstraint: { significant: 0, some: 50, none: 100 },
    willingnessToExpand: { no: 0, if_proven: 60, yes: 100 },
    capacityLeadTime: { over_3_months: 10, months_1_3: 40, weeks_2_4: 75, immediate: 100 },

    canApprove: { no: 0, partly: 50, yes: 100 },
    decisionTiming: { over_3_months: 10, '1_3_months': 40, this_month: 75, this_week: 100 },
    startTiming: { later: 10, '1_3_months': 40, within_month: 75, immediately: 100 },
    urgency: { curious: 15, exploring: 40, important: 75, critical: 100 },

    budgetSignal: { not_budgeted: 0, need_financing: 30, compare_options: 55,
                    approve_if_value: 80, budgeted: 100 },

    bookingPlatformStaying: { must_change: 25, unsure: null, open_to_change: 80, keep: 100 },
    keepNumber: { no: 100, yes: 60 },
    willingToChangeSoftware: { no: 20, maybe: 65, yes: 100 },
    customIntegrationNeeded: { yes: 0, no: 100 },
    migrationConcern: { several: 15, downtime: 45, data: 50, staff_training: 60, none: 100 },
    multiLocationSystems: { mixed: 20, separate: 45, shared: 90 },

    /* Higher = MORE severe. Inverted on purpose; see the header. */
    primaryConcern: {
      none: 0, technology: 35, setup: 40, staff_adoption: 45, price: 55,
      contract: 65, results_skepticism: 70, other: 50, prior_bad_experience: 85
    }
  };

  /* Concerns that cap the readiness band at `clarify` no matter the score. */
  const SEVERE_CONCERNS = ['prior_bad_experience', 'results_skepticism', 'contract'];

  /* Booking platforms we know we integrate with. `unsupported` is not a
     judgement about the product — it means WE have not built it yet. */
  const INTEGRATION_SUPPORT = {
    none_paper: 'supported', phone_only: 'supported', square: 'supported',
    vagaro: 'supported', boulevard: 'supported', glossgenius: 'supported',
    fresha: 'supported', other: 'unknown', unsure: 'unknown'
  };

  /* ---------- helpers ---------- */

  const val = (answers, key) => {
    const raw = answers ? answers[key] : undefined;
    if (raw === undefined || raw === null) return null;
    const text = String(raw).trim();
    return text === '' ? null : text;
  };

  const numOrNull = (answers, key) => {
    const raw = val(answers, key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  /* An explicit "unsure" is evidence that the visitor does not know — which is
     not the same as never being asked, but scores the same: unknown. Both are
     recorded so the difference survives into the report. */
  const scored = (answers, key) => {
    const raw = val(answers, key);
    if (raw === null) return { value: null, score: null, state: 'not_answered' };
    if (raw === 'unsure' || raw === 'prefer_not_say') {
      return { value: raw, score: null, state: 'answered_unknown' };
    }
    const scale = SCALES[key];
    const score = scale && Object.prototype.hasOwnProperty.call(scale, raw) ? scale[raw] : null;
    return { value: raw, score: score === undefined ? null : score,
             state: score === null || score === undefined ? 'unscored' : 'scored' };
  };

  const round2 = n => Math.round(n * 100) / 100;

  /* Weighted mean over the components that actually have a score. Returns null
     when nothing does — never a default, never a midpoint. */
  const combine = components => {
    const evidence = [];
    let total = 0;
    let weightUsed = 0;
    let weightPossible = 0;

    components.forEach(({ key, weight, result }) => {
      weightPossible += weight;
      evidence.push({ field: key, value: result.value, state: result.state,
                      contribution: result.score });
      if (result.score === null) return;
      total += result.score * weight;
      weightUsed += weight;
    });

    const score = weightUsed === 0 ? null : Math.round(total / weightUsed);
    return {
      score,
      confidence: weightPossible === 0 ? 0 : round2(weightUsed / weightPossible),
      evidence,
      unknownFields: evidence.filter(e => e.contribution === null).map(e => e.field)
    };
  };

  const dimension = (id, polarity, note, combined, extra = {}) => ({
    id,
    score: combined.score,
    known: combined.score !== null,
    range: '0..100',
    polarity,
    note,
    confidence: combined.confidence,
    evidence: combined.evidence,
    unknownFields: combined.unknownFields,
    ...extra
  });

  const HIGHER_BETTER = 'higher_is_better';
  const HIGHER_WORSE = 'higher_is_worse';

  /* ---------- the nine dimensions ---------- */

  const computeDimensions = (answers = {}) => {
    const s = key => scored(answers, key);
    const locations = numOrNull(answers, 'locationCount');

    /* 1. capacityReadiness — can the business absorb more work at all?
          Deliberately dominated by the 90-day headroom question, because the
          rest describe how capacity could be created, not whether it exists. */
    const capacityReadiness = dimension('capacityReadiness', HIGHER_BETTER,
      'Room to absorb additional demand over the next 90 days.',
      combine([
        { key: 'capacity90Day', weight: 0.55, result: s('capacity90Day') },
        { key: 'staffingExpandable', weight: 0.15, result: s('staffingExpandable') },
        { key: 'hoursExpandable', weight: 0.15, result: s('hoursExpandable') },
        { key: 'spaceConstraint', weight: 0.15, result: s('spaceConstraint') }
      ]));

    /* 2. expansionReadiness — willingness and speed, distinct from headroom.
          A business with no room today but willing to expand quickly is a very
          different prospect from one that is full and intends to stay that way. */
    const expansionReadiness = dimension('expansionReadiness', HIGHER_BETTER,
      'Willingness and practical ability to create capacity if demand grows.',
      combine([
        { key: 'willingnessToExpand', weight: 0.45, result: s('willingnessToExpand') },
        { key: 'capacityLeadTime', weight: 0.30, result: s('capacityLeadTime') },
        { key: 'staffingExpandable', weight: 0.25, result: s('staffingExpandable') }
      ]));

    /* 3. decisionReadiness — authority plus timing. Authority is weighted
          hardest because no amount of urgency substitutes for it. */
    const decisionReadiness = dimension('decisionReadiness', HIGHER_BETTER,
      'Ability and intent to make a decision.',
      combine([
        { key: 'canApprove', weight: 0.40, result: s('canApprove') },
        { key: 'decisionTiming', weight: 0.25, result: s('decisionTiming') },
        { key: 'urgency', weight: 0.20, result: s('urgency') },
        { key: 'startTiming', weight: 0.15, result: s('startTiming') }
      ]),
      {
        respondentRole: val(answers, 'respondentRole'),
        canApprove: val(answers, 'canApprove'),
        otherApprovers: val(answers, 'otherApprovers'),
        /* A named approval path is what turns "cannot decide" from a blocker
           into a next step. Absence of one is the thing that matters. */
        approvalPathKnown: val(answers, 'canApprove') === 'yes' ||
          (val(answers, 'otherApprovers') !== null && val(answers, 'otherApprovers') !== 'unsure')
      });

    /* 4. budgetReadiness — affordability signal only. Nothing here asks about
          revenue, balances, or credit, and nothing here may be added that does. */
    const budgetReadiness = dimension('budgetReadiness', HIGHER_BETTER,
      'Stated ability to fund a decision. Never a financial position.',
      combine([{ key: 'budgetSignal', weight: 1, result: s('budgetSignal') }]),
      { declined: val(answers, 'budgetSignal') === 'prefer_not_say' });

    /* 5. implementationCompatibility — how much friction stands between a yes
          and a working system. */
    const bookingPlatform = val(answers, 'bookingPlatform');
    const integrationStatus = bookingPlatform
      ? (INTEGRATION_SUPPORT[bookingPlatform] || 'unknown')
      : 'unknown';

    const compatibilityComponents = [
      { key: 'bookingPlatformStaying', weight: 0.25, result: s('bookingPlatformStaying') },
      { key: 'willingToChangeSoftware', weight: 0.20, result: s('willingToChangeSoftware') },
      { key: 'customIntegrationNeeded', weight: 0.20, result: s('customIntegrationNeeded') },
      { key: 'migrationConcern', weight: 0.20, result: s('migrationConcern') },
      { key: 'keepNumber', weight: 0.15, result: s('keepNumber') }
    ];
    if (locations !== null && locations > 1) {
      compatibilityComponents.push(
        { key: 'multiLocationSystems', weight: 0.20, result: s('multiLocationSystems') });
    }

    const implementationCompatibility = dimension('implementationCompatibility', HIGHER_BETTER,
      'How readily the platform can be put in place over what already exists.',
      combine(compatibilityComponents),
      {
        bookingPlatform,
        integrationStatus,
        phoneSetup: val(answers, 'phoneSetup'),
        keepNumber: val(answers, 'keepNumber'),
        customIntegrationNeeded: val(answers, 'customIntegrationNeeded')
      });

    /* 6. multiLocationComplexity — HIGHER IS WORSE. Scope, not quality. */
    let complexityScore = null;
    const complexityEvidence = [];
    if (locations !== null) {
      complexityEvidence.push({ field: 'locationCount', value: locations, state: 'scored' });
      if (locations <= 1) complexityScore = 0;
      else if (locations === 2) complexityScore = 45;
      else if (locations <= 4) complexityScore = 70;
      else complexityScore = 90;

      const systems = s('multiLocationSystems');
      complexityEvidence.push({ field: 'multiLocationSystems', value: systems.value,
                                state: systems.state, contribution: systems.score });
      if (locations > 1 && systems.score !== null) {
        /* Separate or mixed systems per site add real integration work. */
        complexityScore = Math.min(100, Math.round(complexityScore + (100 - systems.score) * 0.2));
      }
    }
    const multiLocationComplexity = {
      id: 'multiLocationComplexity',
      score: complexityScore,
      known: complexityScore !== null,
      range: '0..100',
      polarity: HIGHER_WORSE,
      note: 'Scope and integration burden. HIGHER MEANS MORE COMPLEX, not better.',
      confidence: locations === null ? 0 : 1,
      evidence: complexityEvidence,
      unknownFields: locations === null ? ['locationCount'] : [],
      locationCount: locations,
      /* Multi-location alone is not a reason to escalate a good fit, but until
         a standardized multi-site scope exists there is nothing to sell them,
         so it stays a blocker. Reviewed when that scope ships. */
      requiresCustomScope: locations !== null && locations > 1
    };

    /* 7. objectionSeverity — HIGHER IS WORSE. */
    const concern = s('primaryConcern');
    const priorBad = val(answers, 'priorBadExperience');
    let severity = concern.score;
    if (severity !== null && priorBad === 'yes' && concern.value !== 'prior_bad_experience') {
      severity = Math.min(100, severity + 20);
    }
    const objectionSeverity = {
      id: 'objectionSeverity',
      score: severity,
      known: severity !== null,
      range: '0..100',
      polarity: HIGHER_WORSE,
      note: 'Strength of stated resistance. HIGHER MEANS MORE RESISTANCE.',
      confidence: concern.value === null ? 0 : 1,
      evidence: [
        { field: 'primaryConcern', value: concern.value, state: concern.state, contribution: concern.score },
        { field: 'priorBadExperience', value: priorBad, state: priorBad === null ? 'not_answered' : 'scored' }
      ],
      unknownFields: concern.value === null ? ['primaryConcern'] : [],
      primaryConcern: concern.value,
      /* Free text is evidence for a human, never parsed for meaning here. */
      hasDetail: val(answers, 'concernDetail') !== null,
      hasOpenQuestions: val(answers, 'openQuestions') !== null,
      severe: concern.value !== null &&
        (SEVERE_CONCERNS.includes(concern.value) || priorBad === 'yes'),
      unresolved: concern.value !== null && concern.value !== 'none'
    };

    /* 8. identityConfidenceInput — quality of the identity evidence offered.
          Improves candidate RANKING only. It can never link a record on its
          own: everything here is visitor-supplied and therefore unverified. */
    const identityBits = [
      { field: 'googleProfile', weight: 45, present: val(answers, 'googleProfile') !== null },
      { field: 'website', weight: 25, present: val(answers, 'website') !== null },
      { field: 'businessPhone', weight: 20, present: val(answers, 'businessPhone') !== null },
      { field: 'locationCount', weight: 10, present: locations !== null }
    ];
    const identityScore = identityBits.reduce((sum, b) => sum + (b.present ? b.weight : 0), 0);
    const identityConfidenceInput = {
      id: 'identityConfidenceInput',
      score: identityScore,
      known: true,
      range: '0..100',
      polarity: HIGHER_BETTER,
      note: 'Quality of visitor-supplied identity evidence. Ranking input only.',
      confidence: 1,
      evidence: identityBits.map(b => ({ field: b.field, value: b.present, state: 'scored',
                                         contribution: b.present ? b.weight : 0 })),
      unknownFields: identityBits.filter(b => !b.present).map(b => b.field),
      verified: false,
      autoLinkEligible: false,
      note2: 'Unverified by definition. See shared/business-record/resolve-identity.js.'
    };

    /* 9. closeReadinessEvidence — COVERAGE, not favourability. How much of the
          evidence close readiness needs is actually present. A prospect who
          answered everything unfavourably scores high here and low there. */
    const REQUIRED_EVIDENCE = ['capacity90Day', 'canApprove', 'decisionTiming', 'urgency',
                               'budgetSignal', 'bookingPlatform', 'primaryConcern', 'locationCount'];
    const presentEvidence = REQUIRED_EVIDENCE.filter(f => val(answers, f) !== null);
    const closeReadinessEvidence = {
      id: 'closeReadinessEvidence',
      score: Math.round((presentEvidence.length / REQUIRED_EVIDENCE.length) * 100),
      known: true,
      range: '0..100',
      polarity: HIGHER_BETTER,
      note: 'Evidence COVERAGE for close readiness. Not a measure of how ready they are.',
      confidence: 1,
      evidence: REQUIRED_EVIDENCE.map(f => ({ field: f, value: val(answers, f) !== null,
                                              state: 'scored' })),
      unknownFields: REQUIRED_EVIDENCE.filter(f => val(answers, f) === null)
    };

    return {
      version: 'intelligence-v1',
      capacityReadiness,
      expansionReadiness,
      decisionReadiness,
      budgetReadiness,
      implementationCompatibility,
      multiLocationComplexity,
      objectionSeverity,
      identityConfidenceInput,
      closeReadinessEvidence
    };
  };

  /* Which evidence the assessment asked for but did not receive. Distinguishes
     "never shown" from "shown and skipped", because the first is a design
     choice and the second is a signal. */
  const missingEvidence = (answers = {}, visibleFields = null) => {
    const missing = [];
    ALL_FIELDS.forEach(field => {
      if (OPTIONAL_FIELDS.includes(field)) return;
      if (val(answers, field) !== null) return;
      const wasShown = visibleFields === null ? null : visibleFields.includes(field);
      missing.push({ field, shown: wasShown,
                     reason: wasShown === false ? 'not_applicable_to_this_path' : 'unanswered' });
    });
    return missing;
  };

  /* Stage 2 evidence that has not been collected. Distinct from
     missingEvidence(): this answers "is the fit review still outstanding?",
     which is a question about the JOURNEY, not about a gap in the answers.

     Optional fields are excluded — a review the visitor completed in full is
     not outstanding merely because they declined to give a website. */
  const missingStage2Evidence = (answers = {}) =>
    STAGE2_FIELDS.filter(field =>
      !OPTIONAL_FIELDS.includes(field) && val(answers, field) === null);

  const API = {
    FIELDS, ALL_FIELDS, OPTIONAL_FIELDS, SCALES, SEVERE_CONCERNS, INTEGRATION_SUPPORT,
    STAGE1_FIELDS, STAGE2_FIELDS, STAGE_FIELDS,
    HIGHER_BETTER, HIGHER_WORSE,
    computeDimensions, missingEvidence, missingStage2Evidence
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.CEDIntelligence = API;
})();
