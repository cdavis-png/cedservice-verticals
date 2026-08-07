/* Service Mix test fixtures. Invented salons and .test domains only — no
   real people, businesses, or contact details.

   Every offering here is made up. The prices and durations are plausible
   rather than real, because the point is to exercise the arithmetic, not to
   publish anyone's price list. */

import { randomUUID } from 'node:crypto';
import values from '../../shared/service-mix-engine/value.schema.js';
import offeringSchema from '../../shared/service-mix-engine/offering.schema.js';
import { ENV, ALLOWED_ORIGIN, SUBMITTED_AT, NOW_MS } from './fixtures.mjs';

export { ENV, ALLOWED_ORIGIN, SUBMITTED_AT, NOW_MS };

export const SM_SESSION = '44444444-4444-4444-8444-444444444444';
export const SM_SUBMISSION = '55555555-5555-4555-8555-555555555555';

/* The wording actually shown in index.html. It describes what happens — the
   review is sent, the results appear on the page — and promises no email,
   because nothing in this repository sends one. */
export const SM_CONSENT_STATEMENT =
  'Send my review to CED Solutions so my results can be worked out and shown to me on this page.';

/* The exact wording the engine requires. Imported rather than retyped so a
   change to the disclaimer breaks the fixture too, which is the point. */
export { default as serviceMixBir } from '../../shared/service-mix-engine/generate-service-mix-bir.js';

/* Build one offering. `kinds` says how well each figure is known, which is
   the axis most of these tests turn on. */
export function makeOffering({
  name = 'Gel manicure',
  category = 'core_service',
  source = 'starter',
  price = 60,
  duration = 60,
  volume = 50,
  demand = 'steady',
  role = 'primary_revenue',
  kinds = {},
  offeringId = null,
  snapshot = true,
  replacesOfferingId = null
} = {}) {
  const kindOf = measure => kinds[measure] || 'exact';

  const build = (measure, single) => {
    const kind = kindOf(measure);
    if (kind === 'range') {
      const value = Number(single);
      return values.measured('range', { low: value * 0.8, high: value * 1.2 });
    }
    if (kind === 'unknown' || kind === 'not_applicable') return values.measured(kind);
    return values.measured(kind, { value: Number(single) });
  };

  const offering = {
    offeringId: offeringId || randomUUID(),
    offeringSnapshotId: snapshot ? randomUUID() : null,
    replacesOfferingId,
    name,
    category,
    source,
    sellingPrice: build('sellingPrice', price),
    durationMinutes: build('durationMinutes', duration),
    monthlyVolume: build('monthlyVolume', volume),
    demand,
    role
  };
  return offering;
}

/* Three offerings, every figure exact — the reference portfolio. Gel manicure
   earns $65/hour, acrylics $36/hour, nail art $33/hour, so the portfolio
   midpoint sits between them and the thresholds are exercised from both
   sides. */
export function makePortfolio(overrides = []) {
  if (overrides.length) return overrides;
  return [
    makeOffering({ name: 'Gel manicure', price: 65, duration: 60, volume: 80,
                   demand: 'strong', role: 'primary_revenue' }),
    makeOffering({ name: 'Acrylic full set', price: 90, duration: 150, volume: 30,
                   demand: 'steady', role: 'margin_builder',
                   category: 'premium_service' }),
    makeOffering({ name: 'Nail art', price: 25, duration: 45, volume: 40,
                   demand: 'weak', role: 'convenience', category: 'add_on' })
  ];
}

/* A complete, valid Service Mix submission payload. */
export function makeServiceMixPayload(overrides = {}) {
  const payload = {
    schemaVersion: 6,
    reviewType: 'service_mix',
    assessmentVersion: '1.0.0',
    assessmentSessionId: SM_SESSION,
    submissionId: SM_SUBMISSION,
    vertical: { id: 'nails', name: 'Nail Salons' },
    submittedAt: SUBMITTED_AT,
    attribution: {
      firstTouch: { url: 'https://nails.cedservice.test/service-mix', referrer: null, utm: {}, occurredAt: SUBMITTED_AT },
      latestTouch: { url: 'https://nails.cedservice.test/service-mix', referrer: null, utm: {}, occurredAt: SUBMITTED_AT }
    },
    contact: {
      salonName: 'Polished Test Salon',
      ownerName: 'Test Owner',
      email: 'owner@polished.test'
    },
    consent: {
      resultsDeliveryConsent: {
        granted: true, statement: SM_CONSENT_STATEMENT, recordedAt: SUBMITTED_AT
      },
      emailMarketingConsent: {
        granted: false, statement: 'You may also email me occasional tips and offers. This is optional.',
        recordedAt: SUBMITTED_AT
      }
    },
    continuation: { continuationToken: null },
    integrity: { honeypotFilled: false, challengeToken: null },
    serviceMix: {
      coverage: 'all_offerings',
      offerings: makePortfolio(),
      offeringCount: 3,
      minimum: offeringSchema.OFFERING_LIMITS.min,
      maximum: offeringSchema.OFFERING_LIMITS.max,
      recommended: offeringSchema.OFFERING_LIMITS.recommended
    },
    results: {
      disclaimer:
        'This is a diagnostic analysis based on the information provided. ' +
        'Estimated contribution excludes labor expense, overhead, occupancy, taxes, ' +
        'financing, and other costs unless explicitly stated. It is not a calculation ' +
        'of profit or accounting, tax, legal, or regulatory advice.'
    }
  };

  return deepMerge(payload, overrides);
}

function deepMerge(base, overrides) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined) { delete out[key]; continue; }
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function makeServiceMixRequest(payload, opts = {}) {
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
  if (idempotencyKey !== null && idempotencyKey !== undefined) {
    headers.set('idempotency-key', idempotencyKey);
  }

  return new Request('https://nails.cedservice.com/api/assessments', {
    method, headers,
    body: method === 'GET' || method === 'OPTIONS' ? undefined : body
  });
}

/* A continuation secret exists only in the function environment. This one is
   obviously fake and is never a real secret. */
export const SM_ENV = { ...ENV, CED_CONTINUATION_SECRET: 'test-continuation-secret-never-real' };

export const smDeps = (db, extra = {}) => ({
  env: SM_ENV,
  db,
  now: () => NOW_MS,
  ...extra
});
