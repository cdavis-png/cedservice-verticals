/* ============================================================
   CED Intelligence Platform — funnel and drop-off calculations
   ------------------------------------------------------------
   The deterministic definition of every rate this platform
   reports, and of the canonical drop-off report.

   ------------------------------------------------------------
   WHY THE MATH IS HERE AND NOT IN SQL

   Postgres COUNTS; this file DIVIDES. The migration aggregates
   raw events into per-day counters, which is work that must
   happen next to the data. Turning counters into rates is
   arithmetic, and putting it here means there is exactly one
   definition of "Stage 2 start rate" rather than one in SQL, one
   in a dashboard, and a third in a spreadsheet that disagrees
   with both.

   ------------------------------------------------------------
   TWO RULES THAT KEEP THESE NUMBERS HONEST

   1. A rate with too small a denominator is not reported. It is
      returned as null with the sample size attached, because
      "60% of 5 people" reads as a finding and is noise. The
      threshold is explicit and travels with the result.

   2. A ratio whose denominator is zero is null, never zero and
      never 100%. Nobody reached that step; that is not the same
      as everybody failing it.

   Nothing in this file may read or write the Business Record,
   the BIR, the package recommendation, or close readiness.

   Classic script on purpose — see the note in engine.js.
   ============================================================ */

(() => {
  'use strict';

  /* Below this many sessions in the denominator, a rate is withheld. Chosen to
     be obviously arbitrary rather than falsely precise: it is a guard against
     reading noise, not a statistical test. Raise it for anything that informs
     a decision with money attached. */
  const MIN_SAMPLE = 30;

  const round4 = n => Math.round(n * 10000) / 10000;

  /* The single definition of a rate in this system. */
  const rate = (numerator, denominator, { minSample = MIN_SAMPLE } = {}) => {
    const num = Number(numerator) || 0;
    const den = Number(denominator) || 0;
    if (den <= 0) {
      return { value: null, numerator: num, denominator: den, sample: den,
               reportable: false, reason: 'no_denominator' };
    }
    if (den < minSample) {
      return { value: null, numerator: num, denominator: den, sample: den,
               reportable: false, reason: 'below_minimum_sample', minSample };
    }
    return { value: round4(num / den), numerator: num, denominator: den, sample: den,
             reportable: true };
  };

  /* ---------- the funnel ----------
     Each step names its own numerator and denominator so the chain is
     readable rather than implied by ordering. */

  const FUNNEL_STEPS = [
    { id: 'view_to_start',            numerator: 'starts',                  denominator: 'pageViews' },
    { id: 'start_to_stage1',          numerator: 'stage1Completions',       denominator: 'starts' },
    { id: 'stage1_to_result_view',    numerator: 'preliminaryResultViews',  denominator: 'stage1Completions' },
    { id: 'result_to_stage2_start',   numerator: 'stage2Starts',            denominator: 'preliminaryResultViews' },
    { id: 'stage2_start_to_complete', numerator: 'stage2Completions',       denominator: 'stage2Starts' },
    { id: 'stage2_to_full_result',    numerator: 'fullResultViews',         denominator: 'stage2Completions' },
    { id: 'result_to_recommended',    numerator: 'recommendedSystemClicks', denominator: 'preliminaryResultViews' },
    { id: 'result_to_personal_review',numerator: 'personalReviewClicks',    denominator: 'preliminaryResultViews' },
    { id: 'result_to_checkout_intent',numerator: 'checkoutIntents',         denominator: 'preliminaryResultViews' },
    /* End to end. The number anyone actually asks for. */
    { id: 'view_to_stage1',           numerator: 'stage1Completions',       denominator: 'pageViews' },
    { id: 'view_to_stage2',           numerator: 'stage2Completions',       denominator: 'pageViews' }
  ];

  const COUNTER_FIELDS = [
    'pageViews', 'starts', 'stage1Completions', 'preliminaryResultViews',
    'stage2Starts', 'stage2Completions', 'fullResultViews',
    'personalReviewClicks', 'recommendedSystemClicks', 'checkoutIntents',
    'reportRequests', 'abandonmentCount', 'resumes', 'validationFailures',
    'questionInteractions', 'visibleQuestionTotal'
  ];

  const emptyCounters = () => {
    const out = {};
    COUNTER_FIELDS.forEach(field => { out[field] = 0; });
    out.medianStage1ActiveMs = null;
    out.medianStage2ActiveMs = null;
    return out;
  };

  const computeFunnel = (counters, options = {}) => {
    const c = { ...emptyCounters(), ...(counters || {}) };
    const steps = {};
    FUNNEL_STEPS.forEach(step => {
      steps[step.id] = {
        ...rate(c[step.numerator], c[step.denominator], options),
        numeratorField: step.numerator,
        denominatorField: step.denominator
      };
    });

    return {
      counters: c,
      steps,
      /* Secondary rates that describe quality of the experience rather than
         progression through it. */
      quality: {
        /* How often a visitor is stopped by their own invalid input. A rising
           number here is usually a question that is unclear, not a visitor
           who is careless. */
        validationFailureRate: rate(c.validationFailures, c.starts, options),
        /* Of the questions put in front of people, how many got an answer.
           Below 1 means questions are being skipped, which the engine allows
           for optional fields and not otherwise. */
        questionInteractionRate: rate(c.questionInteractions, c.visibleQuestionTotal, options),
        /* Sessions that came back at least once. */
        resumeRate: rate(c.resumes, c.starts, options),
        abandonmentRate: rate(c.abandonmentCount, c.starts, options)
      },
      medianStage1ActiveMs: c.medianStage1ActiveMs ?? null,
      medianStage2ActiveMs: c.medianStage2ActiveMs ?? null,
      minSample: options.minSample ?? MIN_SAMPLE
    };
  };

  /* ---------- segmentation ----------
     The same funnel, cut by one dimension. Segments below the sample floor
     keep their counters and lose their rates, so a small segment is visible
     as small rather than absent. */

  const SEGMENTS = ['source', 'deviceClass', 'assessmentVersion', 'questionSetVersion'];

  const computeSegmented = (rows, segment, options = {}) => {
    if (!SEGMENTS.includes(segment)) {
      throw new Error(`funnel: unknown segment "${segment}". Known: ${SEGMENTS.join(', ')}`);
    }
    const grouped = new Map();
    (rows || []).forEach(row => {
      const key = row[segment] === null || row[segment] === undefined || row[segment] === ''
        ? '(none)' : String(row[segment]);
      if (!grouped.has(key)) grouped.set(key, emptyCounters());
      const target = grouped.get(key);
      COUNTER_FIELDS.forEach(field => { target[field] += Number(row[field]) || 0; });
    });

    return [...grouped.entries()]
      .map(([key, counters]) => ({ segment, key, ...computeFunnel(counters, options) }))
      .sort((a, b) => b.counters.pageViews - a.counters.pageViews);
  };

  /* ---------- the drop-off report ----------

     One row per step. This is the canonical shape; a future dashboard renders
     it and adds nothing to it.

     `entered` and `visible` are different questions and are both needed:
     a step can be visible to a session that branches away before reaching it,
     and a step nobody entered has no drop-off to explain. */

  const dropOffRow = (step, options = {}) => {
    const visible = Number(step.visibleSessions) || 0;
    const entered = Number(step.enteredSessions) || 0;
    const completed = Number(step.completedSessions) || 0;
    const exits = Number(step.exits) || 0;
    const resumes = Number(step.resumes) || 0;
    const failures = Number(step.validationFailures) || 0;
    const nextEntered = Number(step.nextStepEntered) || 0;

    return {
      stepId: step.stepId,
      stage: step.stage ?? null,
      visibleSessions: visible,
      enteredSessions: entered,
      completedSessions: completed,
      exits,
      resumes,
      validationFailures: failures,
      medianActiveMs: step.medianActiveMs ?? null,

      completionRate: rate(completed, entered, options),
      abandonmentRate: rate(exits, entered, options),
      validationFailureRate: rate(failures, entered, options),
      resumeRate: rate(resumes, entered, options),
      nextStepConversion: rate(nextEntered, completed, options),

      sourceBreakdown: step.sourceBreakdown || [],
      deviceBreakdown: step.deviceBreakdown || [],

      /* Stated on every row so a reader never has to go looking for whether
         this one is trustworthy. */
      sample: entered,
      minSample: options.minSample ?? MIN_SAMPLE,
      reportable: entered >= (options.minSample ?? MIN_SAMPLE)
    };
  };

  const buildDropOffReport = (steps, options = {}) => {
    const rows = (steps || []).map(step => dropOffRow(step, options));
    const reportable = rows.filter(row => row.reportable);

    /* The worst step by abandonment, among rows with enough sample to say so.
       Deliberately NOT a recommendation: this names where to look, and a
       person decides what it means. */
    let worst = null;
    reportable.forEach(row => {
      if (row.abandonmentRate.value === null) return;
      if (!worst || row.abandonmentRate.value > worst.abandonmentRate.value) worst = row;
    });

    return {
      generatedFrom: 'assessment_analytics_events',
      minSample: options.minSample ?? MIN_SAMPLE,
      steps: rows,
      stepsReportable: reportable.length,
      stepsWithheld: rows.length - reportable.length,
      highestAbandonmentStepId: worst ? worst.stepId : null,
      note: 'Descriptive only. No recommendation is derived from this report.'
    };
  };

  const API = {
    MIN_SAMPLE,
    FUNNEL_STEPS,
    COUNTER_FIELDS,
    SEGMENTS,
    rate,
    emptyCounters,
    computeFunnel,
    computeSegmented,
    dropOffRow,
    buildDropOffReport
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.CEDFunnel = API;
})();
