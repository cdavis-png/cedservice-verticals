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
    /* 1.3.0 splits the review into two stages. No question was removed and no
       formula moved: the Growth Score, the opportunity estimate, and the
       package thresholds are byte-for-byte what they were in 1.1.0. */
    assessmentVersion: '1.3.0',
    /* Identifies the question inventory independently of the scoring version,
       so a report can be read against the exact set of questions asked. */
    questionSetVersion: 'nails-questions-3.0.0',

    /* Must match the packages section of index.html and the labels returned by
       recommendPackage below. Prices are in whole dollars per month. */
    packages: [
      { id: 'starter', name: 'Starter', price: 297, currency: 'USD', interval: 'month' },
      { id: 'salon-growth', name: 'Salon Growth', price: 597, currency: 'USD', interval: 'month' },
      { id: 'scale', name: 'Scale', price: 997, currency: 'USD', interval: 'month' }
    ],

    contactFields: ['salonName', 'ownerName', 'email', 'mobile', 'preferredContact'],

    /* Optional identity evidence, copied into `contact` only when given.
       Always unverified: it improves candidate ranking and can never link a
       Business Record on its own. Legal name and full address are deliberately
       NOT here — they belong at checkout, not in a diagnostic. */
    identityFields: ['businessPhone', 'website', 'googleProfile', 'locationCount'],

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

     Served over http(s), completed assessments POST to the capture endpoint.
     Opened straight off disk (file://) there is no server to talk to, so the
     endpoint stays null and the adapter logs the payload locally instead —
     the documented preview mode keeps working unchanged.

     No credentials appear here. The endpoint is same-origin and the Supabase
     service role key exists only inside the Vercel Function. */
  submission: {
    endpoint: (typeof window !== 'undefined' &&
               window.location &&
               (window.location.protocol === 'http:' || window.location.protocol === 'https:'))
      ? '/api/assessments'
      : null,
    /* Longer than the server's whole operation budget on purpose. The order
       that must hold is challenge < database < function < client; a client
       that gives up first abandons requests that were about to succeed and
       turns them into avoidable retries. See docs/PRODUCTION_HARDENING.md. */
    timeoutMs: 20000
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
    /* ============================================================
       STAGE 1 — Growth Review
       ------------------------------------------------------------
       The minimum needed to diagnose the operational problem, produce the
       Growth Score, bound the estimate by capacity, and deliver results.

       Every field here is load-bearing. Fourteen of them feed the Growth
       Score or the opportunity formula, two feed the package threshold, three
       are needed to deliver the results, and two are required by the platform
       (scope and capacity). That arithmetic is why Stage 1 cannot be shorter
       without moving a figure the visitor has already been shown — see
       docs/ASSESSMENT_INTELLIGENCE_EXPANSION.md.
       ============================================================ */
    'salonName',
    'ownerName',          /* context only */
    'email',              /* context only, required */
    'mobile',             /* context only, optional — gates SMS marketing consent */
    'technicians',        /* package threshold */
    'appointmentsDay',    /* context only; throughput and a consistency check */
    'averageTicket',
    'daysOpen',
    'callsDay',           /* package threshold */
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

    /* Platform-required in Stage 1. locationCount decides whether the standard
       offer can be sized at all; capacity90Day is the ceiling, and without it
       the visible estimate cannot honestly be bounded. */
    'locationCount',            /* structure; also identity ranking evidence */
    'capacity90Day',            /* the approved growth-capacity question */

    'consentResults',     /* required; recorded separately in the payload */
    'consentEmailMarketing',
    'consentSmsMarketing',

    /* ============================================================
       STAGE 2 — Fit and Activation Review
       ------------------------------------------------------------
       Everything that only matters once someone is deciding whether to buy.
       Optional in the sense that matters: a visitor who never opens it still
       receives a complete, useful Stage 1 result.

       These names are a SHARED CONTRACT, not vertical vocabulary: the engine
       and generate-bir.js both read them through
       shared/assessment-engine/intelligence.js. The question wording is ours
       to choose; the field names are not. None of these feed the Growth
       Score.
       ============================================================ */
    'preferredContact',   /* context only; results are delivered by email regardless */
    'challenge',          /* context only */
    'yearsInBusiness',

    'bookingPlatform',
    'bookingPlatformStaying',
    'willingToChangeSoftware',
    'migrationConcern',

    'staffingExpandable',
    'hoursExpandable',
    'spaceConstraint',
    'willingnessToExpand',
    'capacityLeadTime',

    'respondentRole',
    'canApprove',
    'otherApprovers',           /* branch: only when not the sole decision-maker */
    'decisionTiming',
    'startTiming',
    'urgency',
    'changeReason',

    'budgetSignal',

    'phoneSetup',
    'keepNumber',
    'multiLocationSystems',     /* branch: only when locationCount > 1 */
    'customIntegrationNeeded',

    'primaryConcern',
    'concernDetail',            /* branch: only when a concern is selected */
    'priorBadExperience',       /* branch: only when a concern is selected */
    'openQuestions',

    'businessPhone',            /* optional identity evidence */
    'website',                  /* optional identity evidence */
    'googleProfile'             /* optional identity evidence */
  ],

  /* ---------- Conditional questions ----------
     Predicates receive the same `read` accessor the scoring functions use.
     The engine hides, disables, and clears anything whose predicate is false;
     it has no idea what a "location" is. Keep every rule here.

     Design intent: a single-location owner who is the decision-maker, has no
     concerns, and uses a supported platform answers the shortest path. Every
     branch below earns its place by only appearing when its answer would
     actually change the recommendation.

     All of it is Stage 2. Stage 1 has no branching at all — the shortest and
     the longest Stage 1 paths are the same path — because the questions that
     would drive a branch are exactly the ones Stage 1 no longer asks.

     Nothing here may hide a question whose answer could raise a hard blocker.
     customIntegrationNeeded looks like an obvious candidate for a branch off
     "you use a paper book"; it is deliberately unconditional, because a `yes`
     routes the prospect to a human and suppressing it would quietly close a
     path that exists to catch what we cannot serve. */
  branching: {
    steps: {
      /* Step 13 exists only for businesses with more than one site. The
         answer that decides it is given in Stage 1, so by the time this step
         could appear the evidence for it is already in hand. */
      13: read => Number(read.val('locationCount')) > 1
    },

    questions: {
      /* Approval chain — pointless when the respondent can approve alone, and
         premature before they have said. An unanswered question is not a "no". */
      otherApprovers: read => read.val('canApprove') !== '' && read.val('canApprove') !== 'yes',

      /* Expansion detail — only worth asking when there is a constraint to
         work around, or an appetite to grow into. Someone with ample headroom
         who is unwilling to expand is not going to be moved by these. */
      staffingExpandable: read => ['none', '1_5', '6_10', 'unsure'].includes(read.val('capacity90Day')),
      hoursExpandable: read => ['none', '1_5', '6_10', 'unsure'].includes(read.val('capacity90Day')),
      spaceConstraint: read => ['none', '1_5', '6_10', 'unsure'].includes(read.val('capacity90Day')),
      capacityLeadTime: read => ['yes', 'if_proven'].includes(read.val('willingnessToExpand')),

      /* Compatibility follow-ups, gated on what they actually run today. */
      bookingPlatformStaying: read => read.val('bookingPlatform') !== '' &&
        !['none_paper', 'phone_only'].includes(read.val('bookingPlatform')),
      willingToChangeSoftware: read => read.val('bookingPlatformStaying') === 'keep' ||
        read.val('bookingPlatformStaying') === 'unsure',
      /* Nothing to keep if the number lives on a service we would replace
         wholesale, and nothing to ask before they have told us what they use. */
      keepNumber: read => ['landline', 'voip', 'answering_service'].includes(read.val('phoneSetup')),
      /* Only meaningful to someone who might actually move. Asking a business
         that just said it is keeping its system what would worry it about
         switching is a question with no consequence. */
      migrationConcern: read => ['open_to_change', 'must_change', 'unsure']
        .includes(read.val('bookingPlatformStaying')),

      /* Objection follow-ups — only when something was actually raised. */
      concernDetail: read => read.val('primaryConcern') !== '' && read.val('primaryConcern') !== 'none',
      priorBadExperience: read => read.val('primaryConcern') !== '' && read.val('primaryConcern') !== 'none'
    }
  },

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
