/* ============================================================
   CED Service — Nail Salon assessment configuration
   ------------------------------------------------------------
   Everything industry-specific about the nail-salon review:
   the question inventory, scoring weights, opportunity
   formulas, priority copy, and package thresholds.

   Generic behavior lives in shared/assessment-engine/engine.js.
   Load this file BEFORE the engine.

   COMPLIANCE: every figure produced here is a diagnostic
   estimate, never a projection or a guarantee. The disclaimers
   in index.html must accompany any figure this file produces.
   See CLAUDE.md section 4.
   ============================================================ */

window.CED_ASSESSMENT_CONFIG = {
  storageKey: 'cedSalonGrowthReview',

  /* Identity and shape of this vertical, carried on every submission so a
     downstream system can tell verticals and assessment revisions apart.
     Bump assessmentVersion whenever questions, weights, or formulas change. */
  meta: {
    verticalId: 'nails',
    verticalName: 'Nail Salons',
    assessmentVersion: '1.1.0',

    /* Must match the packages section of index.html and the labels returned by
       recommendPackage below. Prices are in whole dollars per month. */
    packages: [
      { id: 'starter', name: 'Starter', price: 297, currency: 'USD', interval: 'month' },
      { id: 'salon-growth', name: 'Salon Growth', price: 597, currency: 'USD', interval: 'month' },
      { id: 'scale', name: 'Scale', price: 997, currency: 'USD', interval: 'month' }
    ],

    contactFields: ['salonName', 'ownerName', 'email', 'mobile', 'preferredContact'],

    /* Separate, independently recorded permissions. Results delivery is the only
       required one and is satisfied by email alone, so declining marketing never
       blocks a visitor from receiving their assessment.

       requiresField gates a consent on another answer: SMS marketing is not
       offered at all unless a mobile number was given.

       LEGAL REVIEW PENDING — the wording in index.html has not been reviewed by
       counsel. Do not launch a vertical until it has. */
    consents: [
      { key: 'resultsDeliveryConsent', field: 'consentResults', required: true },
      { key: 'emailMarketingConsent', field: 'consentEmailMarketing', required: false },
      { key: 'smsMarketingConsent', field: 'consentSmsMarketing', required: false, requiresField: 'mobile' }
    ]
  },

  /* Transport settings for shared/assessment-engine/submission.js.
     endpoint is null until a capture endpoint exists — with no endpoint the
     adapter logs the payload instead of sending it. */
  submission: {
    endpoint: null,
    timeoutMs: 10000
  },

  /* Which answer names the business on the results screen. */
  subjectField: 'salonName',
  subjectFallback: 'Your salon',

  priorityCount: 3,

  /* The review's question inventory — every input name in index.html.
     The engine checks these against the markup and warns on a mismatch,
     which is the usual way a cloned vertical silently breaks scoring.
     Fields marked "context only" are captured for the lead record and do
     not affect the score or the opportunity estimate. */
  fields: [
    'salonName',
    'ownerName',          /* context only */
    'email',              /* context only, required */
    'mobile',             /* context only, optional — gates SMS marketing consent */
    'preferredContact',   /* context only */
    'technicians',
    'appointmentsDay',    /* context only */
    'averageTicket',
    'daysOpen',
    'callsDay',
    'missedCallsDay',
    'missedCallProcess',
    'noShowsWeek',
    'cancelsWeek',
    'reminders',
    'waitlist',
    'rebooking',
    'reactivation',
    'inactiveClients',
    'reviewCount',        /* context only */
    'rating',
    'reviewRequests',
    'promotions',
    'challenge',          /* context only */
    'consentResults',     /* required; recorded separately in the payload */
    'consentEmailMarketing',
    'consentSmsMarketing'
  ],

  /* Estimated monthly opportunity, in dollars.
     Diagnostic only — see the compliance note above. */
  opportunity: ({ num }) => {
    const ticket = num('averageTicket');

    const missedCalls = num('missedCallsDay') * .35 * ticket * num('daysOpen');
    const noShows = num('noShowsWeek') * ticket * 4.33 * Math.max(.2, (3 - num('reminders')) * .18);
    const cancellations = num('cancelsWeek') * ticket * 4.33 * Math.max(.15, (2 - num('waitlist')) * .18);
    const reactivation = num('inactiveClients') * .06 * ticket * Math.max(.25, (3 - num('reactivation')) / 3);

    return missedCalls + noShows + cancellations + reactivation;
  },

  /* Per-area sub-scores, each 0-100. Priorities are driven off these. */
  dimensions: ({ num }) => ({
    missedOpportunity: Math.min(100, num('missedCallProcess') * 28 + (num('missedCallsDay') === 0 ? 16 : 0)),
    appointmentProtection: Math.min(100, num('reminders') * 24 + num('waitlist') * 12),
    retention: Math.min(100, num('rebooking') * 22 + num('reactivation') * 20),
    reputation: Math.min(100, num('reviewRequests') * 30 + (num('rating') >= 4.6 ? 10 : 0)),
    marketing: Math.min(100, num('promotions') * 30)
  }),

  /* Weighted Growth Score, 0-100. Weights must total 1. */
  overallScore: d => Math.round(
    d.missedOpportunity * .25 +
    d.appointmentProtection * .25 +
    d.retention * .20 +
    d.reputation * .15 +
    d.marketing * .15
  ),

  /* Evaluated in order; the first `priorityCount` matches are shown. */
  priorities: [
    {
      when: d => d.missedOpportunity < 65,
      message: 'Recover missed calls and inquiries automatically.'
    },
    {
      when: d => d.appointmentProtection < 65,
      message: 'Automate reminders and fill last-minute cancellations.'
    },
    {
      when: d => d.retention < 65,
      message: 'Create consistent rebooking and client-reactivation follow-up.'
    },
    {
      when: d => d.reputation < 65,
      message: 'Request and respond to Google reviews consistently.'
    },
    {
      when: d => d.marketing < 65,
      message: 'Run trackable promotions to past clients.'
    }
  ],

  /* Used when fewer than priorityCount rules match. */
  priorityFallback: 'Track appointment sources and conversion more consistently.',

  /* Salon Growth is the default recommendation; Starter and Scale are the
     exceptions. Prices must match the packages section of index.html. */
  recommendPackage: ({ num }, { opportunity }) => {
    const technicians = num('technicians');

    if (technicians <= 1 && opportunity < 1000) {
      return {
        id: 'starter',
        label: 'Starter — $297/month',
        reason: 'Recommended for a solo provider that needs basic missed-call, review, and reactivation automation.'
      };
    }

    if (technicians >= 5 && (num('callsDay') >= 12 || num('missedCallsDay') >= 4)) {
      return {
        id: 'scale',
        label: 'Scale — $997/month',
        reason: 'Recommended for a multi-technician salon with enough call volume to justify AI phone coverage and active growth support.'
      };
    }

    return {
      id: 'salon-growth',
      label: 'Salon Growth — $597/month',
      reason: 'Recommended for established salons with appointment, retention, and follow-up opportunities.'
    };
  }
};
