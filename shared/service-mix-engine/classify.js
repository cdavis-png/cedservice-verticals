/* ============================================================
   CED Intelligence Platform — Service Mix classification
   ------------------------------------------------------------
   Turns a calculated portfolio into concerns, opportunities, and
   one deterministic health classification.

   A CLASSIFICATION, NOT A SCORE. A number invites comparison
   between businesses that this evidence cannot support; a
   classification says what it knows and stops there.

   The rule that stops SM-1 manufacturing findings: a concern or
   an opportunity is raised only when its INTERVAL clears the
   threshold, never its midpoint. A threshold the interval
   straddles is not cleared, however favourable the middle looks.

   Everything here is a pricing or capacity observation. Nothing
   here claims profit, contribution, or margin, because SM-1
   collects no direct costs — see CONTRIBUTION_LANGUAGE below,
   which the templates read so the wording cannot drift into a
   claim the evidence does not support.

   Full rationale: docs/SERVICE_MIX_REVIEW.md section 7.

   Classic script on purpose.
   ============================================================ */

(() => {
  'use strict';

  const req = name => (typeof module !== 'undefined' && module.exports) ? require(name) : null;

  const values = req('./value.schema.js') ||
    (typeof window !== 'undefined' ? window.CEDServiceMixValue : null);
  const offerings = req('./offering.schema.js') ||
    (typeof window !== 'undefined' ? window.CEDServiceMixOffering : null);

  const CLASSIFIER_VERSION = 'service-mix-health-v1';

  /* ---------- language ----------

     "Estimated contribution leader", never "profit leader". The phrase
     "profit" is reserved for a figure that has seen costs, and SM-1 has seen
     none. Exported so the templates and the report read one definition. */
  const CONTRIBUTION_LANGUAGE = {
    leader: 'Estimated contribution leader',
    /* Even the estimated form is unavailable in SM-1, and saying so is
       better than omitting the section and letting silence read as "none". */
    unavailable: 'Estimated contribution cannot be calculated without direct costs, which the Quick Review does not collect.',
    prohibited: ['profit leader', 'profit', 'margin', 'net income']
  };

  /* ---------- thresholds ----------
     Versioned with the classifier. Changing one changes what an owner is
     told, so they are named and gathered rather than inlined. */
  const THRESHOLDS = {
    /* insufficient_evidence */
    minUsableOfferings: offerings.OFFERING_LIMITS.min,
    minConfidence: 0.45,
    /* undermeasured */
    minCompleteness: 0.65,

    /* capacity_heavy_low_return */
    capacityHeavyShare: 0.40,
    returnShortfallRatio: 0.60,

    /* revenue_per_hour_far_below_portfolio */
    lowReturnMultiple: 0.60,
    /* strong_demand_high_return */
    highReturnMultiple: 1.25,
    /* weak_demand_high_capacity */
    weakDemandCapacityShare: 0.30
  };

  const HEALTH_CLASSIFICATIONS = [
    'insufficient_evidence',
    'undermeasured',
    'attention_needed',
    'generally_healthy_with_opportunities',
    'generally_healthy'
  ];

  const CONCERN_IDS = ['capacity_heavy_low_return', 'revenue_per_hour_far_below_portfolio'];
  const OPPORTUNITY_IDS = ['strong_demand_high_return', 'weak_demand_high_capacity'];

  /* Analyses that SM-1 structurally cannot perform. Present-and-unavailable
     rather than absent, so no consumer can read an empty array as "we looked
     and found none". */
  const UNAVAILABLE_ANALYSES = [
    'contributionLeaders',
    'underpricingCandidates',
    'addOnOpportunities',
    'bundleOpportunities'
  ];

  const REQUIRES_DETAILED_REVIEW = 'requires_detailed_review';

  const unavailableAnalyses = () => {
    const out = {};
    UNAVAILABLE_ANALYSES.forEach(key => {
      out[key] = {
        available: false,
        reason: REQUIRES_DETAILED_REVIEW,
        explanation: CONTRIBUTION_LANGUAGE.unavailable
      };
    });
    return out;
  };

  /* ---------- concerns ---------- */

  const capacityHeavyLowReturn = (analysis, portfolio) => {
    const capacityShare = analysis.shareOfEnteredCapacity;
    const revenueShare = analysis.shareOfEnteredRevenue;
    if (!capacityShare.known || !revenueShare.known) return null;

    /* The ENTIRE capacity-share interval must be at or above the threshold,
       and the ENTIRE revenue-share interval must be below the proportion of
       it the offering ought to be returning. Either interval straddling its
       threshold means the evidence does not support the claim. */
    if (!(capacityShare.low >= THRESHOLDS.capacityHeavyShare)) return null;
    const expected = capacityShare.low * THRESHOLDS.returnShortfallRatio;
    if (!(revenueShare.high < expected)) return null;

    return {
      id: 'capacity_heavy_low_return',
      kind: 'concern',
      offeringId: analysis.offeringId,
      offeringSnapshotId: analysis.offeringSnapshotId,
      offeringName: analysis.name,
      evidence: {
        shareOfEnteredCapacity: capacityShare,
        shareOfEnteredRevenue: revenueShare,
        evidenceKinds: analysis.evidence
      },
      portfolioContext: { revenuePerCapacityHour: portfolio.totals.revenuePerCapacityHour }
    };
  };

  const revenuePerHourFarBelow = (analysis, portfolio) => {
    const own = analysis.revenuePerCapacityHour;
    const portfolioMid = values.midpoint(portfolio.totals.revenuePerCapacityHour);
    if (!own.known || portfolioMid === null || portfolioMid <= 0) return null;

    const threshold = portfolioMid * THRESHOLDS.lowReturnMultiple;
    if (!values.entirelyBelow(own, threshold)) return null;

    return {
      id: 'revenue_per_hour_far_below_portfolio',
      kind: 'concern',
      offeringId: analysis.offeringId,
      offeringSnapshotId: analysis.offeringSnapshotId,
      offeringName: analysis.name,
      evidence: {
        revenuePerCapacityHour: own,
        portfolioRevenuePerCapacityHour: portfolio.totals.revenuePerCapacityHour,
        threshold: values.round2(threshold),
        evidenceKinds: analysis.evidence
      },
      portfolioContext: { multiple: THRESHOLDS.lowReturnMultiple }
    };
  };

  /* ---------- opportunities ---------- */

  const strongDemandHighReturn = (analysis, portfolio) => {
    if (analysis.demand !== 'strong') return null;
    const own = analysis.revenuePerCapacityHour;
    const portfolioMid = values.midpoint(portfolio.totals.revenuePerCapacityHour);
    if (!own.known || portfolioMid === null || portfolioMid <= 0) return null;

    const threshold = portfolioMid * THRESHOLDS.highReturnMultiple;
    if (!values.entirelyAbove(own, threshold)) return null;

    return {
      id: 'strong_demand_high_return',
      kind: 'opportunity',
      offeringId: analysis.offeringId,
      offeringSnapshotId: analysis.offeringSnapshotId,
      offeringName: analysis.name,
      evidence: {
        demand: analysis.demand,
        revenuePerCapacityHour: own,
        portfolioRevenuePerCapacityHour: portfolio.totals.revenuePerCapacityHour,
        threshold: values.round2(threshold),
        evidenceKinds: analysis.evidence
      },
      portfolioContext: { multiple: THRESHOLDS.highReturnMultiple }
    };
  };

  const weakDemandHighCapacity = (analysis) => {
    if (analysis.demand !== 'weak') return null;
    const capacityShare = analysis.shareOfEnteredCapacity;
    if (!capacityShare.known) return null;
    if (!(capacityShare.low >= THRESHOLDS.weakDemandCapacityShare)) return null;

    return {
      id: 'weak_demand_high_capacity',
      kind: 'opportunity',
      offeringId: analysis.offeringId,
      offeringSnapshotId: analysis.offeringSnapshotId,
      offeringName: analysis.name,
      evidence: {
        demand: analysis.demand,
        shareOfEnteredCapacity: capacityShare,
        evidenceKinds: analysis.evidence
      },
      portfolioContext: { threshold: THRESHOLDS.weakDemandCapacityShare }
    };
  };

  const CONCERN_RULES = [capacityHeavyLowReturn, revenuePerHourFarBelow];
  const OPPORTUNITY_RULES = [strongDemandHighReturn, weakDemandHighCapacity];

  /* ---------- health ---------- */

  /* Evaluated in order; the first match wins. Order matters: a portfolio with
     a real concern AND thin measurement is reported as `undermeasured`, not
     `attention_needed`, because the concern rests on figures that are not
     solid enough to act on. Telling an owner to change a price on the
     strength of a guess is the failure this ordering prevents. */
  const classifyHealth = ({ portfolio, concerns, opportunities }) => {
    const { usableOfferingCount, dataConfidence } = portfolio;
    const { confidence, completeness } = dataConfidence;

    /* Nothing to be healthy ABOUT.

       An offering counts as "usable" if it carries any one figure, so two
       offerings with only a price each clear the count and the confidence
       bar — and produce no revenue total, no hours total, and no revenue per
       hour. Every downstream rule then finds nothing, no concern is raised,
       and the ladder below would call that `generally_healthy`.

       "We measured nothing and found nothing wrong" is not a clean bill of
       health. It is the absence of a measurement, and it is reported as
       insufficient evidence before anything else is considered. */
    const revenueKnown = portfolio.totals.monthlyRevenue.known;
    const capacityKnown = portfolio.totals.capacityHours.known;
    if (!revenueKnown && !capacityKnown) {
      return {
        classification: 'insufficient_evidence',
        because: 'Neither monthly revenue nor staffed hours could be calculated for any offering, so there is nothing to compare. Nothing here is a finding about the business.',
        deciding: {
          monthlyRevenueKnown: false,
          capacityHoursKnown: false,
          usableOfferingCount
        }
      };
    }

    if (usableOfferingCount < THRESHOLDS.minUsableOfferings) {
      return {
        classification: 'insufficient_evidence',
        because: `Only ${usableOfferingCount} offering(s) carried enough information to analyse; at least ${THRESHOLDS.minUsableOfferings} are needed to compare anything.`,
        deciding: { usableOfferingCount, threshold: THRESHOLDS.minUsableOfferings }
      };
    }
    if (confidence < THRESHOLDS.minConfidence) {
      return {
        classification: 'insufficient_evidence',
        because: `Confidence in the figures entered is ${confidence.toFixed(2)}, below the ${THRESHOLDS.minConfidence} needed to draw any conclusion from them.`,
        deciding: { confidence, threshold: THRESHOLDS.minConfidence }
      };
    }
    if (completeness < THRESHOLDS.minCompleteness) {
      return {
        classification: 'undermeasured',
        because: `Enough offerings were entered, but the figures behind them are ${completeness.toFixed(2)} complete against a ${THRESHOLDS.minCompleteness} threshold. Anything read from them would rest on estimates rather than measurements.`,
        deciding: { completeness, threshold: THRESHOLDS.minCompleteness }
      };
    }
    if (concerns.length) {
      return {
        classification: 'attention_needed',
        because: `${concerns.length} pricing or capacity concern(s) are supported by the evidence entered.`,
        deciding: { concernIds: concerns.map(c => c.id) }
      };
    }
    if (opportunities.length) {
      return {
        classification: 'generally_healthy_with_opportunities',
        because: `No supported concern was found, and ${opportunities.length} evidence-supported opportunity was identified.`,
        deciding: { opportunityIds: opportunities.map(o => o.id) }
      };
    }
    return {
      classification: 'generally_healthy',
      because: 'The figures entered support no pricing or capacity concern and no material opportunity.',
      deciding: { confidence, completeness }
    };
  };

  /* ---------- entry point ---------- */

  const classifyPortfolio = portfolio => {
    const concerns = [];
    const opportunities = [];

    /* Deterministic order: rules in declaration order, offerings in the order
       the owner entered them. Two runs of one input must produce one report. */
    CONCERN_RULES.forEach(rule => {
      portfolio.offeringAnalyses.forEach(analysis => {
        const hit = rule(analysis, portfolio);
        if (hit) concerns.push(hit);
      });
    });
    OPPORTUNITY_RULES.forEach(rule => {
      portfolio.offeringAnalyses.forEach(analysis => {
        const hit = rule(analysis, portfolio);
        if (hit) opportunities.push(hit);
      });
    });

    const health = classifyHealth({ portfolio, concerns, opportunities });

    /* Below the evidence bar, findings are withheld rather than shown with a
       caveat. A caveat under a headline is read as a headline. */
    const withheld = health.classification === 'insufficient_evidence' ||
                     health.classification === 'undermeasured';

    return {
      classifierVersion: CLASSIFIER_VERSION,
      thresholds: THRESHOLDS,
      health,
      concerns: withheld ? [] : concerns,
      opportunities: withheld ? [] : opportunities,
      findingsWithheld: withheld,
      withheldCount: withheld ? concerns.length + opportunities.length : 0,
      withheldReason: withheld
        ? 'Findings were withheld because the evidence entered does not support them yet. They are not a finding of none.'
        : null,
      unavailableAnalyses: unavailableAnalyses()
    };
  };

  const API = {
    CLASSIFIER_VERSION,
    CONTRIBUTION_LANGUAGE,
    THRESHOLDS,
    HEALTH_CLASSIFICATIONS,
    CONCERN_IDS,
    OPPORTUNITY_IDS,
    UNAVAILABLE_ANALYSES,
    REQUIRES_DETAILED_REVIEW,
    unavailableAnalyses,
    classifyHealth,
    classifyPortfolio
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.CEDServiceMixClassify = API;
})();
