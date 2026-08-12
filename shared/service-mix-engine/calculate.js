/* ============================================================
   CED Intelligence Platform — Service Mix Stage 1 calculations
   ------------------------------------------------------------
   Deterministic and total: the same offerings always produce the
   same portfolio. No clock, no network, no AI, no enrichment.

   Computes ONLY what Stage 1 evidence supports:

     · monthly revenue range
     · staff / capacity hours consumed
     · revenue per capacity hour
     · share of entered revenue and of entered capacity
     · portfolio completeness and confidence
     · revenue leaders and capacity-heavy offerings
     · measurement gaps

   Everything is an interval. Any unknown operand produces an
   unknown result — there is no imputed median anywhere in this
   file, and adding one would turn a diagnostic into a guess.

   Direct costs are not collected in SM-1, so no contribution,
   margin, or profit figure is produced here at all. That is not
   an omission to be filled in later by a default; it is the
   restraint the whole review is built around.

   Full rationale: docs/SERVICE_MIX_REVIEW.md section 6.

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

  const values = (isCjs ? require('./value.schema.js') : null) ||
    (typeof window !== 'undefined' ? window.CEDServiceMixValue : null);
  const offerings = (isCjs ? require('./offering.schema.js') : null) ||
    (typeof window !== 'undefined' ? window.CEDServiceMixOffering : null);

  const CALCULATION_VERSION = 'service-mix-calc-v1';

  const MINUTES_PER_HOUR = 60;

  /* Confidence weights. Completeness dominates because it is the only one of
     the three that measures the evidence itself; coverage and offering count
     describe how much of the business the evidence is about. */
  const CONFIDENCE_WEIGHTS = { completeness: 0.70, coverage: 0.20, offeringCount: 0.10 };

  const clamp01 = n => Math.max(0, Math.min(1, n));

  /* ---------- one offering ---------- */

  const analyseOffering = offering => {
    const price = offerings.measureValue(offering, 'sellingPrice');
    const duration = offerings.measureValue(offering, 'durationMinutes');
    const volume = offerings.measureValue(offering, 'monthlyVolume');

    const priceInterval = values.toInterval(price, 'sellingPrice');
    const durationInterval = values.toInterval(duration, 'durationMinutes');
    const volumeInterval = values.toInterval(volume, 'monthlyVolume');

    const monthlyRevenue = values.multiply(priceInterval, volumeInterval);

    /* Minutes into hours before anything is divided by it, so the unit of
       revenue-per-capacity-hour is unambiguous wherever it is read. */
    const capacityMinutes = values.multiply(durationInterval, volumeInterval);
    const capacityHours = values.scale(capacityMinutes, 1 / MINUTES_PER_HOUR);

    const revenuePerCapacityHour = values.divide(monthlyRevenue, capacityHours);

    return {
      offeringId: offering.offeringId,
      offeringSnapshotId: offering.offeringSnapshotId || null,
      replacesOfferingId: offering.replacesOfferingId || null,
      name: offering.name,
      category: offering.category,
      source: offering.source,
      demand: offering.demand,
      role: offering.role,

      /* The declared evidence quality travels with the analysis. A consumer
         must be able to see that a figure rests on an estimate without
         going back to the payload. */
      evidence: {
        sellingPrice: price.kind,
        durationMinutes: duration.kind,
        monthlyVolume: volume.kind
      },

      inputs: {
        sellingPrice: priceInterval,
        durationMinutes: durationInterval,
        monthlyVolume: volumeInterval
      },

      monthlyRevenue,
      capacityHours,
      revenuePerCapacityHour,

      /* Filled in once the portfolio totals exist — a share needs a
         denominator, and the denominator is every other offering. */
      shareOfEnteredRevenue: values.NO_INTERVAL,
      shareOfEnteredCapacity: values.NO_INTERVAL,

      usable: offerings.isUsableOffering(offering)
    };
  };

  /* ---------- measurement gaps ----------

     Named individually rather than counted, because "three gaps" tells an
     owner nothing and "we do not know how long an acrylic fill takes, so we
     cannot say what an hour of it earns" tells them what to do. */

  const GAP_CONSEQUENCE = {
    sellingPrice: 'monthly revenue and revenue per hour cannot be calculated for this offering',
    durationMinutes: 'the hours this offering consumes, and its revenue per hour, cannot be calculated',
    monthlyVolume: 'monthly revenue and the hours this offering consumes cannot be calculated'
  };

  const measurementGapsFor = offering => {
    const gaps = [];
    offerings.STAGE1_MEASURES.forEach(measure => {
      const value = offerings.measureValue(offering, measure);
      if (!values.isUnknown(value)) return;
      gaps.push({
        offeringId: offering.offeringId,
        offeringSnapshotId: offering.offeringSnapshotId || null,
        measure,
        prevents: GAP_CONSEQUENCE[measure] || 'part of this offering’s analysis cannot be calculated'
      });
    });
    return gaps;
  };

  /* ---------- ordering ----------

     Ranked by interval midpoint, with a deterministic tie-break. Two
     offerings with identical figures must always come back in the same
     order or two runs of the same input produce two different reports. */
  const byMidpointDesc = key => (a, b) => {
    const am = values.midpoint(a[key]);
    const bm = values.midpoint(b[key]);
    if (am === null && bm === null) return a.offeringId < b.offeringId ? -1 : 1;
    if (am === null) return 1;
    if (bm === null) return -1;
    if (bm !== am) return bm - am;
    return a.offeringId < b.offeringId ? -1 : 1;
  };

  /* ---------- labelling a total ----------

     A total that silently leaves offerings out is the most dangerous thing
     this engine can produce: it looks exactly like a complete one. Every
     total therefore carries a BASIS saying what it is a total OF, and a
     sentence a human can read without knowing the data model.

     `scope` is always `entered_offerings` and never `business`. Even with
     coverage declared `all_offerings`, this is a total of what was typed in;
     the coverage declaration is the owner's claim about how much of the
     business that is, and a claim is not a measurement. */
  const basisFor = ({ measure, counted, skipped, coverage }) => {
    const complete = skipped === 0;
    const wholeBusiness = complete && coverage === 'all_offerings';
    const noun = measure === 'monthlyRevenue' ? 'revenue' : 'hours';
    return {
      scope: 'entered_offerings',
      complete,
      counted,
      skipped,
      coverage,
      /* True only when every entered offering contributed AND the owner said
         the entered offerings are the whole business. Anything downstream
         that wants to say "your busiest service" must check this first. */
      supportsBusinessWideClaim: wholeBusiness,
      label: !complete
        ? `Partial ${noun} total: ${counted} of ${counted + skipped} offerings entered. ` +
          `${skipped} could not be included because a figure was not known, and ${skipped === 1 ? 'it is' : 'they are'} not counted as zero.`
        : wholeBusiness
          ? `Total ${noun} across all ${counted} offerings entered, which the owner described as the whole business.`
          : `Total ${noun} across all ${counted} offerings entered, which is only part of the business.`
    };
  };

  /* ---------- the portfolio ---------- */

  const calculatePortfolio = ({ offerings: list = [], coverage = 'unknown' } = {}) => {
    const analyses = (list || []).map(analyseOffering);
    const usable = analyses.filter(a => a.usable);

    const revenueTotals = values.sumKnown(analyses.map(a => a.monthlyRevenue));
    const capacityTotals = values.sumKnown(analyses.map(a => a.capacityHours));

    analyses.forEach(a => {
      a.shareOfEnteredRevenue = values.share(a.monthlyRevenue, revenueTotals.total);
      a.shareOfEnteredCapacity = values.share(a.capacityHours, capacityTotals.total);
    });

    /* The portfolio's own revenue per hour, from the totals rather than from
       an average of the per-offering figures. Averaging ratios weights a
       tiny offering the same as the one that fills the diary. */
    const portfolioRevenuePerHour = values.divide(revenueTotals.total, capacityTotals.total);

    /* ---- evidence quality ---- */

    const allMeasuredValues = [];
    (list || []).forEach(offering => {
      offerings.STAGE1_MEASURES.forEach(measure => {
        allMeasuredValues.push(offerings.measureValue(offering, measure));
      });
    });
    const completenessResult = values.completenessOf(allMeasuredValues);

    const coverageFactor = offerings.COVERAGE_FACTOR[coverage] ??
      offerings.COVERAGE_FACTOR.unknown;

    /* Two offerings is the floor and supports the least comparison; five is
       the ceiling. Linear between them, clamped at both ends. */
    const countFactor = clamp01(
      (usable.length - offerings.OFFERING_LIMITS.min) /
      (offerings.OFFERING_LIMITS.max - offerings.OFFERING_LIMITS.min));

    const confidenceRaw =
      completenessResult.completeness * CONFIDENCE_WEIGHTS.completeness +
      coverageFactor * CONFIDENCE_WEIGHTS.coverage +
      countFactor * CONFIDENCE_WEIGHTS.offeringCount;

    /* Floored, never rounded up. A confidence that rounds 0.448 to 0.45 would
       cross the insufficient_evidence threshold on a rounding rule. */
    const confidence = Math.floor(clamp01(confidenceRaw) * 100) / 100;

    const reasons = [];
    if (completenessResult.unknown > 0) {
      reasons.push(`${completenessResult.unknown} figure(s) were not known.`);
    }
    if (completenessResult.notApplicable > 0) {
      reasons.push(`${completenessResult.notApplicable} figure(s) do not apply to the offerings entered and were excluded rather than counted as gaps.`);
    }
    if (coverage !== 'all_offerings') {
      reasons.push(coverage === 'unknown'
        ? 'It is not known what proportion of the business these offerings represent, so every share below is a share of what was entered.'
        : `The entered offerings were described as "${coverage.replace(/_/g, ' ')}", so every share below is a share of what was entered.`);
    }
    if (usable.length < offerings.OFFERING_LIMITS.recommended) {
      reasons.push(`${usable.length} offering(s) carried enough evidence to analyse; ${offerings.OFFERING_LIMITS.recommended} is the recommendation.`);
    }
    if (revenueTotals.skipped > 0) {
      reasons.push(`${revenueTotals.skipped} offering(s) were left out of the revenue total because a figure was missing. They are not counted as zero.`);
    }
    if (capacityTotals.skipped > 0) {
      reasons.push(`${capacityTotals.skipped} offering(s) were left out of the hours total because a figure was missing. They are not counted as zero.`);
    }

    const gaps = (list || []).flatMap(measurementGapsFor);

    return {
      calculationVersion: CALCULATION_VERSION,
      uncertaintyVersion: values.UNCERTAINTY.version,

      coverage,
      coverageFactor,
      offeringCount: analyses.length,
      usableOfferingCount: usable.length,

      offeringAnalyses: analyses,

      totals: {
        monthlyRevenue: revenueTotals.total,
        monthlyRevenueOfferingsCounted: revenueTotals.counted,
        monthlyRevenueOfferingsSkipped: revenueTotals.skipped,
        monthlyRevenueBasis: basisFor({
          measure: 'monthlyRevenue', counted: revenueTotals.counted,
          skipped: revenueTotals.skipped, coverage
        }),
        capacityHours: capacityTotals.total,
        capacityHoursOfferingsCounted: capacityTotals.counted,
        capacityHoursOfferingsSkipped: capacityTotals.skipped,
        capacityHoursBasis: basisFor({
          measure: 'capacityHours', counted: capacityTotals.counted,
          skipped: capacityTotals.skipped, coverage
        }),
        revenuePerCapacityHour: portfolioRevenuePerHour,
        /* A ratio of two partial totals is partial twice over. */
        revenuePerCapacityHourBasis: {
          scope: 'entered_offerings',
          complete: revenueTotals.skipped === 0 && capacityTotals.skipped === 0,
          supportsBusinessWideClaim: revenueTotals.skipped === 0 &&
            capacityTotals.skipped === 0 && coverage === 'all_offerings',
          label: revenueTotals.skipped === 0 && capacityTotals.skipped === 0
            ? 'Revenue per hour across the offerings entered.'
            : 'Revenue per hour across only the offerings whose price, time and volume were all known.'
        }
      },

      dataConfidence: {
        completeness: completenessResult.completeness,
        confidence,
        applicableMeasures: completenessResult.applicable,
        unknownMeasures: completenessResult.unknown,
        notApplicableMeasures: completenessResult.notApplicable,
        coverageFactor,
        offeringCountFactor: Math.round(countFactor * 100) / 100,
        weights: CONFIDENCE_WEIGHTS,
        reasons
      },

      /* Only offerings whose figure is actually known can be ranked. An
         unknown is reported as a gap, never as a last place. */
      revenueLeaders: analyses
        .filter(a => a.monthlyRevenue.known)
        .slice()
        .sort(byMidpointDesc('monthlyRevenue'))
        .map(a => ({
          offeringId: a.offeringId,
          offeringSnapshotId: a.offeringSnapshotId,
          name: a.name,
          monthlyRevenue: a.monthlyRevenue,
          shareOfEnteredRevenue: a.shareOfEnteredRevenue
        })),

      /* "Highest of what was entered" and "your biggest earner" are different
         claims, and only the first is ever supported by this evidence. The
         basis says which one this list can carry — anything rendering a
         headline must read `supportsBusinessWideClaim` before writing one. */
      revenueLeadersBasis: (() => {
        const ranked = analyses.filter(a => a.monthlyRevenue.known).length;
        const unranked = analyses.length - ranked;
        const wholeBusiness = unranked === 0 && coverage === 'all_offerings';
        return {
          scope: 'entered_offerings',
          ranked,
          unranked,
          coverage,
          supportsBusinessWideClaim: wholeBusiness,
          label: unranked > 0
            ? `Highest revenue among the ${ranked} offerings that could be ranked. ` +
              `${unranked} could not be ranked because revenue was not known for ${unranked === 1 ? 'it' : 'them'}, so this is not necessarily the highest overall.`
            : wholeBusiness
              ? `Highest revenue across all ${ranked} offerings entered, which the owner described as the whole business.`
              : `Highest revenue among the ${ranked} offerings entered. Other offerings were not included in this review, so this is not necessarily the highest overall.`
        };
      })(),

      capacityHeavyOfferings: analyses
        .filter(a => a.shareOfEnteredCapacity.known)
        .slice()
        .sort(byMidpointDesc('shareOfEnteredCapacity'))
        .map(a => ({
          offeringId: a.offeringId,
          offeringSnapshotId: a.offeringSnapshotId,
          name: a.name,
          capacityHours: a.capacityHours,
          shareOfEnteredCapacity: a.shareOfEnteredCapacity,
          shareOfEnteredRevenue: a.shareOfEnteredRevenue
        })),

      /* This list is a DESCRIPTION of where the hours go, not a finding.
         Consuming many hours is what a long, well-priced service is supposed
         to do; it becomes a concern only when the return does not follow, and
         that judgement belongs to classify.js and to nothing else. */
      capacityHeavyBasis: {
        scope: 'entered_offerings',
        isFinding: false,
        ranked: analyses.filter(a => a.shareOfEnteredCapacity.known).length,
        unranked: analyses.filter(a => !a.shareOfEnteredCapacity.known).length,
        label: 'Where the hours entered are spent. Taking up time is not a ' +
               'problem in itself — a long service that earns well is doing ' +
               'exactly what it should.'
      },

      measurementGaps: gaps
    };
  };

  const API = {
    CALCULATION_VERSION,
    CONFIDENCE_WEIGHTS,
    MINUTES_PER_HOUR,
    GAP_CONSEQUENCE,
    basisFor,
    analyseOffering,
    measurementGapsFor,
    calculatePortfolio
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDServiceMixCalculate = API;
})();
