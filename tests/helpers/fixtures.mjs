/* Test fixtures. Invented businesses and .test / .example domains only —
   no real people, addresses, or contact details. */

const BASE_SESSION = '11111111-1111-4111-8111-111111111111';
const BASE_SUBMISSION = '22222222-2222-4222-8222-222222222222';

export const DISCLAIMER =
  'This is a preliminary estimate based on your answers and is not a guarantee of revenue or results.';

export const CONSENT_STATEMENT =
  'Send my assessment results and directly related follow-up to the email address above. This is required to deliver your results.';

export const SUBMITTED_AT = '2026-08-04T12:00:00.000Z';
export const NOW_MS = Date.parse('2026-08-04T12:00:05.000Z');

export const ALLOWED_ORIGIN = 'https://nails.cedservice.com';

export const ENV = {
  CED_ALLOWED_ORIGINS: `${ALLOWED_ORIGIN},https://www.cedservice.com`,
  CED_MAX_REQUEST_BYTES: '65536',
  CED_IDEMPOTENCY_RETENTION_DAYS: '30',
  CED_SUBMISSION_MAX_AGE_DAYS: '30',
  CED_LOG_LEVEL: 'error',
  /* No verify URL and NODE_ENV is not production, so the challenge adapter
     takes its documented development bypass. Tests that exercise a real
     verdict inject CED_CHALLENGE_VERIFY_URL and a fetch double. */
  CED_CHALLENGE_REQUIRED: 'true',
  CED_CHALLENGE_EXPECTED_ACTION: 'assessment_submit',
  CED_CHALLENGE_TIMEOUT_MS: '3000',
  CED_DB_TIMEOUT_MS: '6000',
  CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret-never-real',
  CED_RATE_LIMIT_WINDOW_SECONDS: '900',
  CED_RATE_LIMIT_MAX_REQUESTS: '20',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key-never-real'
};

/* A complete, valid current-schema submission. */
export function makePayload(overrides = {}) {
  const payload = {
    schemaVersion: 3,
    assessmentVersion: '1.1.0',
    assessmentSessionId: BASE_SESSION,
    submissionId: BASE_SUBMISSION,
    vertical: { id: 'nails', name: 'Nail Salons' },
    submittedAt: SUBMITTED_AT,
    attribution: {
      firstTouch: {
        url: 'https://nails.cedservice.com/?utm_source=qr_card',
        referrer: 'https://qr.example/',
        utm: { utm_source: 'qr_card' },
        occurredAt: '2026-07-28T14:02:11.004Z'
      },
      latestTouch: {
        url: 'https://nails.cedservice.com/',
        referrer: null,
        utm: {},
        occurredAt: SUBMITTED_AT
      }
    },
    contact: {
      salonName: 'Polished Nail Studio',
      ownerName: 'Test Owner',
      email: 'owner@polished.test',
      mobile: '',
      preferredContact: 'email'
    },
    consent: {
      resultsDeliveryConsent: {
        field: 'consentResults', granted: true, available: true,
        statement: CONSENT_STATEMENT, recordedAt: SUBMITTED_AT
      },
      emailMarketingConsent: {
        field: 'consentEmailMarketing', granted: false, available: true,
        statement: 'Optional: send me occasional CED Service tips, offers, and updates by email.',
        recordedAt: SUBMITTED_AT
      },
      smsMarketingConsent: {
        field: 'consentSmsMarketing', granted: false, available: false,
        statement: 'Optional: send me occasional offers and updates by text at the mobile number above.',
        recordedAt: SUBMITTED_AT
      }
    },
    integrity: {
      honeypotFilled: false,
      challengeToken: null
    },
    answers: {
      salonName: 'Polished Nail Studio', ownerName: 'Test Owner', email: 'owner@polished.test',
      mobile: '', preferredContact: 'email',
      technicians: '3', appointmentsDay: '12', averageTicket: '50', daysOpen: '24',
      callsDay: '8', missedCallsDay: '2', missedCallProcess: '1',
      noShowsWeek: '2', cancelsWeek: '3', reminders: '1', waitlist: '0',
      rebooking: '1', reactivation: '0', inactiveClients: '150',
      reviewCount: '65', rating: '4.4', reviewRequests: '1',
      promotions: '1', challenge: 'Filling open appointments'
    },
    results: {
      opportunity: 1679.7,
      opportunityFormatted: '$1,680',
      score: 26,
      dimensions: {
        missedOpportunity: 28, appointmentProtection: 24,
        retention: 22, reputation: 30, marketing: 30
      },
      priorities: [
        'Recover missed calls and inquiries automatically.',
        'Automate reminders and fill last-minute cancellations.',
        'Create consistent rebooking and client-reactivation follow-up.'
      ],
      recommendedPackage: {
        id: 'salon-growth', label: 'Salon Growth — $597/month',
        reason: 'Recommended for established salons with appointment, retention, and follow-up opportunities.',
        name: 'Salon Growth', price: 597, currency: 'USD', interval: 'month'
      },
      disclaimer: DISCLAIMER
    }
  };
  return deepMerge(payload, overrides);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function makeRequest(payload, opts = {}) {
  const {
    method = 'POST',
    origin = ALLOWED_ORIGIN,
    contentType = 'application/json',
    idempotencyKey = payload && payload.submissionId,
    body = payload === undefined ? undefined : JSON.stringify(payload),
    extraHeaders = {}
  } = opts;

  const headers = new Headers(extraHeaders);
  if (origin !== null) headers.set('origin', origin);
  if (contentType !== null) headers.set('content-type', contentType);
  if (idempotencyKey !== null && idempotencyKey !== undefined) headers.set('idempotency-key', idempotencyKey);

  return new Request('https://nails.cedservice.com/api/assessments', {
    method,
    headers,
    body: method === 'GET' || method === 'OPTIONS' ? undefined : body
  });
}

export const deps = (db, extra = {}) => ({
  env: ENV,
  db,
  now: () => NOW_MS,
  ...extra
});

/* A minimal Request-shaped object whose body arrives in pieces, for proving
   that the reader meters bytes as they land rather than after the fact.
   Deliberately not a real Request: undici buffers stream bodies in ways that
   would hide exactly the behaviour under test. */
export function makeChunkedRequest(chunks, opts = {}) {
  const {
    method = 'POST',
    origin = ALLOWED_ORIGIN,
    contentType = 'application/json',
    idempotencyKey = null,
    declaredLength = null,
    extraHeaders = {}
  } = opts;

  const headers = new Headers(extraHeaders);
  if (origin !== null) headers.set('origin', origin);
  if (contentType !== null) headers.set('content-type', contentType);
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  if (declaredLength !== null) headers.set('content-length', String(declaredLength));

  const encoder = new TextEncoder();
  const encoded = chunks.map(c => (typeof c === 'string' ? encoder.encode(c) : c));

  /* highWaterMark 0 so the stream produces nothing until the reader asks.
     With the default strategy the stream pre-pulls a chunk on construction,
     which would hide exactly the "stopped early" behaviour under test. */
  let delivered = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (delivered >= encoded.length) { controller.close(); return; }
      controller.enqueue(encoded[delivered++]);
    }
  }, { highWaterMark: 0 });

  return { method, headers, body, bytesDelivered: () => delivered };
}

/* Bytes actually pulled from the stream, so a test can assert that an
   oversized body was abandoned rather than fully consumed. */
export function chunksOf(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
