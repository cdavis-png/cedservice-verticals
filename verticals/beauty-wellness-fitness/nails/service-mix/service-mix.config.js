/* ============================================================
   CED Service — Nail Salon Quick Service Mix Review config
   ------------------------------------------------------------
   Everything industry-specific about the nail-salon service-mix
   review: the starter offerings, the wording of every question,
   and the copy on the results screen.

   Generic behavior lives in shared/service-mix-engine/. Load
   this file BEFORE the controller.

   The starters are OPTIONAL. A salon that does not do acrylics
   should not have to delete a row it never asked for, so nothing
   is pre-selected and the list is a menu rather than a default.

   COMPLIANCE: every figure this review produces is a diagnostic
   estimate. Direct costs are not collected, so no contribution,
   margin, or profit figure is produced or implied anywhere.
   The disclaimer in index.html must accompany any figure.
   See CLAUDE.md section 4 and docs/SERVICE_MIX_REVIEW.md.
   ============================================================ */

window.CED_SERVICE_MIX_CONFIG = {
  storageKey: 'cedNailServiceMixReview',

  meta: {
    verticalId: 'nails',
    verticalName: 'Nail Salons',
    /* Bump when the questions, the starters, or the copy change. Independent
       of the Growth Review's assessmentVersion: the two reviews version
       separately because they change for separate reasons. */
    assessmentVersion: '1.0.0',
    questionSetVersion: 'nails-service-mix-1.0.0',
    reviewType: 'service_mix',

    /* TWO independent permissions, recorded separately and never bundled.

       Two, not three: SMS consent is only ever offered where a mobile number
       is collected, and this review collects none.

       `resultsDeliveryConsent` keeps its name — it is the shared field the
       endpoint and the Business Record read — but what it permits here is
       what actually happens: the review is sent to CED Solutions and the
       results are shown on the page. No email is sent. There is no tested
       delivery path in this repository, and a permission describing a
       behaviour we do not have is not consent to anything. The wording
       changes when the behaviour does, not before.

       Marketing consent is never a condition of seeing results.

       LEGAL REVIEW PENDING — the wording in index.html has not been reviewed
       by counsel. Do not launch until it has. */
    consents: [
      { key: 'resultsDeliveryConsent', field: 'consentResults', required: true },
      { key: 'emailMarketingConsent', field: 'consentEmailMarketing', required: false }
    ],

    contactFields: ['salonName', 'ownerName', 'email']
  },

  /* Same transport as the Growth Review. Served over http(s) the review POSTs
     to the capture endpoint; opened from file:// there is no server, the
     endpoint stays null, and the adapter logs the payload locally.

     No credentials appear here. The endpoint is same-origin and every secret
     lives only inside the Vercel Function. */
  submission: {
    endpoint: (typeof window !== 'undefined' &&
               window.location &&
               (window.location.protocol === 'http:' || window.location.protocol === 'https:'))
      ? '/api/assessments'
      : null,
    timeoutMs: 20000
  },

  analyticsEndpoint: (typeof window !== 'undefined' &&
                      window.location &&
                      (window.location.protocol === 'http:' || window.location.protocol === 'https:'))
    ? '/api/analytics'
    : null,

  /* ---------- starter offerings ----------

     Offered, never assumed. Categories map onto the shared vocabulary in
     offering.schema.js; a vertical picks from that list rather than inventing
     one, because the report and any future cross-vertical comparison read it.

     `defaultDuration` is a hint for the form's placeholder only. It is NEVER
     used as an answer: an unanswered duration is a measurement gap, and
     filling it with a plausible number would turn a gap into a fabricated
     measurement. */
  starters: [
    { name: 'Basic manicure',   category: 'core_service',        defaultDuration: 30 },
    { name: 'Gel manicure',     category: 'premium_service',     defaultDuration: 60 },
    { name: 'Acrylic full set', category: 'premium_service',     defaultDuration: 120 },
    { name: 'Acrylic fill',     category: 'maintenance_service', defaultDuration: 60 },
    { name: 'Pedicure',         category: 'core_service',        defaultDuration: 45 },
    { name: 'Gel pedicure',     category: 'premium_service',     defaultDuration: 60 },
    { name: 'Nail art',         category: 'add_on',              defaultDuration: 20 },
    { name: 'Repair',           category: 'maintenance_service', defaultDuration: 15 },
    { name: 'Removal',          category: 'maintenance_service', defaultDuration: 20 },
    { name: 'Add-ons',          category: 'add_on',              defaultDuration: 10 },
    { name: 'Memberships',      category: 'membership',          defaultDuration: null },
    { name: 'Retail products',  category: 'retail_product',      defaultDuration: null }
  ],

  /* ---------- question wording ----------

     The FIELD NAMES are a shared contract and are not ours to change. The
     wording is. Written the way a salon owner talks: appointment time, not
     "service duration"; how many a month, not "monthly transaction volume". */
  labels: {
    coverage: 'Do these cover everything you offer?',
    coverageOptions: {
      all_offerings:   'Yes — that is everything',
      most_revenue:    'Most of what brings money in',
      selected_sample: 'Just a few I picked',
      unknown:         'Not sure'
    },

    name: 'What do you call it?',
    category: 'What kind of thing is it?',
    categoryOptions: {
      core_service:        'A regular service',
      premium_service:     'A higher-priced service',
      maintenance_service: 'A fill, repair, or removal',
      add_on:              'An add-on',
      membership:          'A membership or package',
      retail_product:      'A product you sell',
      other:               'Something else'
    },

    sellingPrice: 'What do you charge?',
    durationMinutes: 'How long is the appointment?',
    monthlyVolume: 'Roughly how many a month?',

    /* The evidence question, asked once per figure. This is the question that
       makes the whole review honest, so it is worded to make "I don't know" a
       normal answer rather than a failure. */
    evidence: 'How well do you know that number?',
    evidenceOptions: {
      exact:          'That is exact',
      range:          'It varies — between…',
      estimate:       'That is about right',
      unknown:        'I do not know',
      not_applicable: 'Does not apply'
    },

    demand: 'How is demand for it?',
    demandOptions: {
      strong:  'Strong — people ask for it',
      steady:  'Steady',
      weak:    'Weak',
      unknown: 'Not sure'
    },

    role: 'What does it do for the salon?',
    roleOptions: {
      primary_revenue:     'It is where the money comes from',
      volume_driver:       'It keeps the chairs full',
      margin_builder:      'I believe it earns well',
      client_acquisition:  'It brings new clients in',
      retention:           'It brings people back',
      convenience:         'It is there because clients expect it',
      unclear:             'I am not sure'
    }
  },

  /* ---------- results copy ----------

     Every phrase here is customer-facing and bound by CLAUDE.md sections 4
     and 5. No guarantees, no hype, no exclamation points. Health wording is
     keyed to the classifier's own vocabulary so the two cannot drift. */
  health: {
    insufficient_evidence: {
      eyebrow: 'NOT ENOUGH TO GO ON YET',
      heading: 'There is not enough here to compare anything.',
      body: 'Add at least two offerings with a price and a rough monthly count, and this review will have something to work with.'
    },
    undermeasured: {
      eyebrow: 'WORTH MEASURING FIRST',
      heading: 'The picture is thin.',
      body: 'Enough offerings are here, but too many of the figures behind them are estimates. Anything read from them would rest on guesses rather than measurements.'
    },
    attention_needed: {
      eyebrow: 'WORTH A LOOK',
      heading: 'One or more offerings are worth a second look.',
      body: 'What follows is based on the price, the appointment time, and the monthly count you entered. It is not a judgement about whether an offering is worth doing.'
    },
    generally_healthy_with_opportunities: {
      eyebrow: 'SOMETHING TO TRY',
      heading: 'Nothing looks wrong, and something looks worth testing.',
      body: 'No pricing or capacity concern showed up in what you entered. One or more offerings look worth an experiment.'
    },
    generally_healthy: {
      eyebrow: 'NOTHING STANDS OUT',
      heading: 'Nothing in what you entered needs attention.',
      body: 'The figures support no pricing or capacity concern and no material opportunity. That is a real result, not an empty one.'
    }
  },

  /* Shown wherever a figure appears, and carried into the submission so the
     estimate can never reach a CRM stripped of its context. Must stay
     substantively identical to SERVICE_MIX_DISCLAIMER in
     shared/service-mix-engine/generate-service-mix-bir.js — a test asserts
     they match. */
  disclaimer:
    'This is a diagnostic analysis based on the information provided. ' +
    'Estimated contribution excludes labor expense, overhead, occupancy, taxes, ' +
    'financing, and other costs unless explicitly stated. It is not a calculation ' +
    'of profit or accounting, tax, legal, or regulatory advice.',

  /* What the Detailed Review would add. Named so a visitor can see what was
     not asked, rather than wondering why a section is empty. */
  detailedReviewAdds: [
    'What each offering costs you in product and materials',
    'How often clients come back, and for what',
    'Which offerings are usually bought together',
    'How much the year moves with the seasons',
    'What cancellations and no-shows cost by offering'
  ]
};
