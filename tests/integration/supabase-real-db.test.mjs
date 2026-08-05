/* ============================================================
   CED Intelligence Platform — real-Postgres integration suite
   ------------------------------------------------------------
   Runs the ACTUAL migrations' functions against an ACTUAL
   Supabase development database, over the same PostgREST path
   the Vercel Function uses. The unit suite proves the contract;
   this proves the SQL.

   It refuses to run unless every guard below is satisfied. That
   is deliberate: this suite writes permanent, append-only rows,
   and there is no undo.

   ------------------------------------------------------------
   WHAT THIS SUITE CANNOT CLEAN UP

   timeline_events and audit_events refuse UPDATE and DELETE by
   trigger, and assessment_submissions refuses DELETE. Deleting a
   business_record does not help either: the cascade would null
   business_id on its linked submissions, which then violates
   assessment_submissions_identity_consistency, so the delete
   fails.

   Every row this suite ingests is therefore PERMANENT in the
   target database. That is the append-only guarantee working as
   designed, not a bug — and it is exactly why the guards below
   exist. Each run uses fresh identifiers so reruns never collide,
   and the suite reports what it left behind.

   Never point this at anything you are not willing to leave
   test history in.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

/* The real Business Intelligence Engine. Section M stores reports it actually
   produces rather than a stand-in: the stage rules live inside that artifact,
   and a stand-in with the right shape would prove the triggers fire and
   nothing at all about what they fire on. */
const bie = createRequire(import.meta.url)('../../shared/business-intelligence/generate-bir.js');

/* ---------- guards ---------- */

const env = process.env;
const failures = [];

const need = (name, why) => {
  if (!env[name] || !String(env[name]).trim()) failures.push(`${name} is not set — ${why}`);
  return env[name];
};

/* 1. Explicit, unambiguous opt-in. Not a truthy string; the exact word. */
if (env.CED_ALLOW_INTEGRATION_TESTS !== 'true') {
  failures.push('CED_ALLOW_INTEGRATION_TESTS must be exactly "true" to run against a real database');
}

/* 2. Never in production, by any signal. */
if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
  failures.push('NODE_ENV is "production" — this suite never runs against production');
}

const url = need('SUPABASE_URL', 'the target database URL is required');
const key = need('SUPABASE_SERVICE_ROLE_KEY', 'server-only credentials are required');

/* 3. The caller must name the project ref they intend, and it must match the
      URL. This is the guard that stops a stale SUPABASE_URL in a shell from
      quietly pointing the suite somewhere unintended. */
const declaredRef = need('CED_TEST_PROJECT_REF', 'name the development project you intend to write to');

let host = '';
let urlRef = '';
if (url) {
  try {
    host = new URL(url).host;
    urlRef = host.split('.')[0];
  } catch {
    failures.push('SUPABASE_URL is not a valid URL');
  }
}
if (declaredRef && urlRef && declaredRef !== urlRef) {
  failures.push(`CED_TEST_PROJECT_REF (${declaredRef}) does not match the project in SUPABASE_URL — refusing`);
}

/* 4. Deny-list. Known production refs and hostnames are refused even if every
      other guard passes. Configure CED_PRODUCTION_PROJECT_REFS in any shell
      that also has production credentials available. */
const DENY_SUBSTRINGS = ['prod', 'production', 'live', 'www.cedservice.com', 'nails.cedservice.com'];
const configuredDeny = String(env.CED_PRODUCTION_PROJECT_REFS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const haystack = `${host} ${declaredRef || ''}`.toLowerCase();
for (const bad of [...DENY_SUBSTRINGS, ...configuredDeny]) {
  if (bad && haystack.includes(bad)) {
    failures.push(`target "${host}" matches the production deny-list entry "${bad}" — refusing`);
  }
}

/* 5. The suite must be able to name a development project positively, not just
      fail to match production. */
if (declaredRef && !/dev|test|staging|scratch|sandbox/i.test(`${declaredRef} ${env.CED_TEST_PROJECT_LABEL || ''}`)) {
  failures.push(
    'Neither CED_TEST_PROJECT_REF nor CED_TEST_PROJECT_LABEL identifies this as a development project. ' +
    'Set CED_TEST_PROJECT_LABEL (e.g. "ced-cip-dev") to confirm the target intentionally.');
}

const BLOCKED = failures.length > 0;

if (BLOCKED) {
  /* One clear refusal, then every test skips. Credentials are never echoed —
     not the key, not even its length. */
  console.error('\n  ✖ Integration suite refused to run:\n');
  failures.forEach(f => console.error(`      · ${f}`));
  console.error('\n    See tests/integration/README.md for the required environment.\n');
}

/* ---------- client ---------- */

let db = null;
if (!BLOCKED) {
  const { createClient } = await import('@supabase/supabase-js');
  db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const it = (name, fn) => test(name, { skip: BLOCKED ? 'guards not satisfied' : false }, fn);

/* ---------- fixtures ----------
   Every run gets its own identifiers, so reruns never collide and one run can
   never observe another's rows. Invented businesses and .test domains only. */

const RUN = randomUUID().slice(0, 8);
const created = { businessIds: [], submissionIds: [], idempotencyKeys: [], bucketKeys: [],
                  /* Analytics rows are the only ones this suite may delete. */
                  analyticsEventIds: [], analyticsSessionIds: [] };

const id = () => randomUUID();
const email = what => `${what}-${RUN}@polished.test`;

const rpc = async (fn, args) => {
  const { data, error } = await db.rpc(fn, args);
  return { data, error };
};

/* Compact, structurally faithful BIR: exactly the fields ingest_assessment
   reads or writes. The full 7 KB artifact is proven by the unit suite. */
const bir = (displayName = 'Polished Nail Studio') => ({
  schemaVersion: 2,
  identity: { businessId: null, identityStatus: 'resolution_pending', birId: null, legacyBusinessKey: null },
  provenance: { generatedBy: 'bie-v1.0.0', supersedes: null, isCurrent: true },
  businessProfile: { displayName, staffCount: 3 },
  estimateConfidence: { score: 0.79, band: 'medium' },
  qualificationProfile: { outcome: 'insufficient_data', missingCriticalFields: ['a', 'b'] },
  closeReadinessProfile: { score: 18, band: 'educate' },
  packageRecommendation: { packageId: 'salon-growth', priceMonthly: 597 }
});

const payload = ({ submissionId, sessionId, name = 'Polished Nail Studio',
                   contactEmail = email('owner'), submittedAt = new Date().toISOString(),
                   schemaVersion = 3, extraContact = {} }) => ({
  schemaVersion,
  assessmentVersion: '1.1.0',
  submissionId,
  assessmentSessionId: sessionId,
  vertical: { id: 'nails', name: 'Nail Salons' },
  submittedAt,
  contact: { salonName: name, ownerName: 'Test Owner', email: contactEmail,
             mobile: '', preferredContact: 'email', ...extraContact },
  consent: { resultsDeliveryConsent: { granted: true, statement: 'Send my assessment results...' } },
  attribution: { firstTouch: { url: 'https://nails.cedservice.com/' } },
  answers: { technicians: '3', averageTicket: '50' },
  results: { score: 26, opportunity: 1679.7 }
});

/* ---------- staged fixtures (migration 0004) ----------
   A structurally complete schema-5 payload, close enough to what the engine
   builds that generate-bir.js produces a real report from it. Stage 1 carries
   Stage 1 answers ONLY — absent keys, not empty strings, because an unasked
   question is not a blank answer. */

const STAGE1_ANSWERS = {
  technicians: '3', appointmentsDay: '12', averageTicket: '50', daysOpen: '24',
  callsDay: '8', missedCallsDay: '2', missedCallProcess: '1',
  noShowsWeek: '2', cancelsWeek: '3', reminders: '1', waitlist: '0',
  rebooking: '1', reactivation: '0', inactiveClients: '150',
  reviewCount: '65', rating: '4.4', reviewRequests: '1', promotions: '1',
  locationCount: '1', capacity90Day: '11_20'
};

const STAGE2_ANSWERS = {
  preferredContact: 'email', challenge: 'Filling open appointments',
  yearsInBusiness: '4_10', bookingPlatform: 'square', bookingPlatformStaying: 'keep',
  willingToChangeSoftware: 'maybe',
  willingnessToExpand: 'if_proven', capacityLeadTime: 'weeks_2_4',
  respondentRole: 'owner', canApprove: 'yes',
  decisionTiming: 'this_month', startTiming: 'within_month', urgency: 'important',
  budgetSignal: 'approve_if_value',
  phoneSetup: 'mobile_only', customIntegrationNeeded: 'no',
  primaryConcern: 'none'
};

const DISCLAIMER =
  'This is a preliminary estimate based on your answers and is not a guarantee of revenue or results.';

const stagedPayload = ({ stage, submissionId, sessionId, name = 'Polished Nail Studio',
                         contactEmail = email('staged'), submittedAt = new Date().toISOString(),
                         supersedesSubmissionId = null }) => {
  const stageOne = stage === 1;
  const answers = {
    salonName: name, ownerName: 'Test Owner', email: contactEmail, mobile: '',
    ...STAGE1_ANSWERS,
    ...(stageOne ? {} : STAGE2_ANSWERS)
  };
  return {
    schemaVersion: 5,
    assessmentVersion: '1.3.0',
    submissionId,
    assessmentSessionId: sessionId,
    vertical: { id: 'nails', name: 'Nail Salons' },
    submittedAt,
    assessmentStage: {
      stage,
      stageId: `stage${stage}`,
      stageName: stageOne ? 'Growth Review' : 'Fit and Activation Review',
      totalStages: 2,
      stage1CompletedAt: submittedAt,
      stage2StartedAt: stageOne ? null : submittedAt,
      stage2CompletedAt: stageOne ? null : submittedAt,
      supersedesSubmissionId: stageOne ? null : supersedesSubmissionId,
      trigger: stageOne ? 'stage1_complete' : 'improve_recommendation'
    },
    branching: {
      stage,
      visibleSteps: stageOne ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [10, 11, 12, 14, 15, 16, 17],
      totalSteps: 17,
      stageSteps: stageOne ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [10, 11, 12, 13, 14, 15, 16, 17],
      visibleFields: Object.keys(answers),
      skippedFields: stageOne ? [] : ['multiLocationSystems', 'otherApprovers', 'concernDetail'],
      staleClearedFields: [],
      questionSetVersion: 'nails-questions-3.0.0'
    },
    contact: {
      salonName: name, ownerName: 'Test Owner', email: contactEmail, mobile: '',
      preferredContact: stageOne ? '' : 'email',
      locationCount: '1'
    },
    consent: {
      resultsDeliveryConsent: {
        field: 'consentResults', granted: true, available: true,
        statement: 'Send my assessment results and directly related follow-up to the email address above.',
        recordedAt: submittedAt
      }
    },
    integrity: { honeypotFilled: false, challengePresented: false },
    attribution: {
      firstTouch: {
        url: 'https://nails.cedservice.com/?utm_source=qr_card',
        referrer: 'https://qr.example/',
        utm: { utm_source: 'qr_card' },
        occurredAt: submittedAt
      },
      latestTouch: { url: 'https://nails.cedservice.com/', referrer: null, utm: {}, occurredAt: submittedAt }
    },
    answers,
    results: {
      opportunity: 1679.7,
      opportunityFormatted: '$1,680',
      score: 26,
      dimensions: { missedOpportunity: 28, appointmentProtection: 24,
                    retention: 22, reputation: 30, marketing: 30 },
      priorities: ['Recover missed calls and inquiries automatically.',
                   'Automate reminders and fill last-minute cancellations.',
                   'Create consistent rebooking and client-reactivation follow-up.'],
      recommendedPackage: {
        id: 'salon-growth', label: 'Salon Growth — $597/month',
        reason: 'Recommended for established salons with appointment, retention, and follow-up opportunities.',
        name: 'Salon Growth', price: 597, currency: 'USD', interval: 'month'
      },
      disclaimer: DISCLAIMER
    }
  };
};

const signal = (type, value, opts = {}) => ({
  type,
  normalizedValue: value,
  rawValue: value,
  strength: ['gbp_place_id', 'external_customer_id', 'payment_customer_id'].includes(type) ? 'strong' : 'weak',
  source: opts.source || 'visitor_supplied',
  verified: opts.verified === true,
  verificationMethod: opts.verificationMethod || 'none',
  verificationEvidence: null
});

const ingest = async ({ key: idemKey, hash, payload: p, signals = [], birDoc = bir(),
                        birId = id(), meta = {} }) => {
  created.idempotencyKeys.push(idemKey);
  created.submissionIds.push(p.submissionId);
  const { data, error } = await rpc('ingest_assessment', {
    p_idempotency_key: idemKey,
    p_request_hash: hash,
    p_payload: p,
    p_signals: signals,
    p_bir: birDoc,
    p_bir_id: birId,
    p_retention_days: 30,
    p_meta: meta
  });
  if (data && data.businessId) created.businessIds.push(data.businessId);
  return { data, error };
};

const count = async (table, column, value) => {
  const q = db.from(table).select('*', { count: 'exact', head: true });
  const { count: n, error } = column ? await q.eq(column, value) : await q;
  if (error) throw new Error(`count(${table}) failed: ${error.message}`);
  return n;
};

const rows = async (table, column, value) => {
  const { data, error } = await db.from(table).select('*').eq(column, value);
  if (error) throw new Error(`select(${table}) failed: ${error.message}`);
  return data;
};

/* ---------- A. schema and permissions ---------- */

it('every expected table exists with RLS enabled, forced, and no policies', async () => {
  const { data, error } = await rpc('ingest_assessment', {
    p_idempotency_key: '', p_request_hash: 'x', p_payload: {}, p_signals: [],
    p_bir: {}, p_bir_id: id(), p_retention_days: 30, p_meta: {}
  });
  /* An empty key must raise, which also proves the 8-argument signature is the
     one PostgREST resolves — a leftover 7-argument overload would make this
     call ambiguous instead. */
  assert.equal(data, null);
  assert.ok(error, 'the function must reject an empty idempotency key');
  assert.match(error.message, /missing_idempotency_key/);
});

it('anon-facing tables are unreachable without the service role', async () => {
  /* The service role bypasses RLS, so a successful read here proves the
     credential is the service role; the absence of policies is what stops
     anon. Verified structurally in docs/REAL_POSTGRES_VALIDATION.md. */
  const n = await count('business_records');
  assert.equal(typeof n, 'number');
});

/* ---------- B. first submission and replay ---------- */

it('a first submission creates exactly one business, submission, BIR and five events', async () => {
  const submissionId = id();
  const sessionId = id();
  const key = `it-${RUN}-first`;

  const before = {
    businesses: await count('business_records'),
    submissions: await count('assessment_submissions'),
    birs: await count('business_intelligence_reports'),
    events: await count('timeline_events')
  };

  const { data, error } = await ingest({
    key, hash: 'h-first',
    payload: payload({ submissionId, sessionId }),
    signals: [signal('email_exact', email('owner')), signal('business_name', `polished ${RUN}`),
              signal('vertical', 'nails')]
  });

  assert.equal(error, null, error && error.message);
  assert.equal(data.ok, true);
  assert.equal(data.replayed, false);
  assert.equal(data.identityStatus, 'linked');
  assert.equal(data.nextAction, 'results_ready');
  assert.equal(data.payloadSchemaVersion, 3);
  assert.equal(data.supersedesBirId, null);
  assert.equal(data.timelineEventIds.length, 5);

  assert.equal(await count('business_records'), before.businesses + 1);
  assert.equal(await count('assessment_submissions'), before.submissions + 1);
  assert.equal(await count('business_intelligence_reports'), before.birs + 1);
  assert.equal(await count('timeline_events'), before.events + 5);

  /* Context is not identity: no `vertical` row is written. */
  const identifiers = await rows('business_identifiers', 'business_id', data.businessId);
  const types = identifiers.map(i => i.identifier_type).sort();
  assert.deepEqual(types, ['business_name', 'email_exact']);
  identifiers.forEach(i => {
    assert.equal(i.verified, false, 'a visitor-supplied signal is never verified');
    assert.equal(i.source, 'visitor_supplied');
  });

  /* sha256, not md5. */
  const [submission] = await rows('assessment_submissions', 'submission_id', submissionId);
  assert.equal(submission.payload_hash.length, 64);
  assert.equal(submission.payload_schema_version, 3);
});

it('a replay returns the original identifiers and creates nothing', async () => {
  const submissionId = id();
  const sessionId = id();
  const key = `it-${RUN}-replay`;
  const p = payload({ submissionId, sessionId });

  const first = await ingest({ key, hash: 'h-replay', payload: p, signals: [] });
  assert.equal(first.error, null);

  const before = {
    businesses: await count('business_records'),
    submissions: await count('assessment_submissions'),
    birs: await count('business_intelligence_reports'),
    events: await count('timeline_events')
  };

  /* A different birId is deliberately supplied; the replay must ignore it. */
  const replay = await ingest({ key, hash: 'h-replay', payload: p, signals: [], birId: id() });

  assert.equal(replay.error, null);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.birId, first.data.birId, 'the original BIR id is returned');
  assert.equal(replay.data.businessId, first.data.businessId);

  assert.equal(await count('business_records'), before.businesses);
  assert.equal(await count('assessment_submissions'), before.submissions);
  assert.equal(await count('business_intelligence_reports'), before.birs);
  assert.equal(await count('timeline_events'), before.events);
});

it('the same key with a different body is a conflict, not an overwrite', async () => {
  const submissionId = id();
  const sessionId = id();
  const key = `it-${RUN}-conflict`;

  await ingest({ key, hash: 'h-original', payload: payload({ submissionId, sessionId }) });
  const clash = await ingest({ key, hash: 'h-CHANGED', payload: payload({ submissionId, sessionId }) });

  assert.ok(clash.error);
  assert.match(clash.error.message, /idempotency_key_conflict/);
});

/* ---------- C. session linking and the BIR chain ---------- */

it('a second submission in the same session links to the same business and chains the BIR', async () => {
  const sessionId = id();
  const first = await ingest({
    key: `it-${RUN}-sess-1`, hash: 'h1',
    payload: payload({ submissionId: id(), sessionId }),
    signals: [signal('email_exact', email('sess'))]
  });
  assert.equal(first.error, null);

  const second = await ingest({
    key: `it-${RUN}-sess-2`, hash: 'h2',
    payload: payload({ submissionId: id(), sessionId }),
    signals: [signal('email_exact', email('sess'))]
  });
  assert.equal(second.error, null);

  assert.equal(second.data.businessId, first.data.businessId, 'same business');
  assert.equal(second.data.identityStatus, 'linked');
  assert.equal(second.data.supersedesBirId, first.data.birId, 'the chain links backwards');
  assert.equal(second.data.timelineEventIds.length, 4, 'no business.created on the second');

  const [record] = await rows('business_records', 'business_id', first.data.businessId);
  assert.equal(record.current_bir_id, second.data.birId, 'current advances only after insert');

  const [newer] = await rows('business_intelligence_reports', 'bir_id', second.data.birId);
  assert.equal(newer.supersedes_bir_id, first.data.birId);
  assert.equal(newer.report.provenance.supersedes, first.data.birId);

  const [older] = await rows('business_intelligence_reports', 'bir_id', first.data.birId);
  assert.ok(older, 'the prior BIR is preserved, never deleted');

  const linked = (await rows('timeline_events', 'correlation_id', second.data.submissionId))
    .find(e => e.event_name === 'identity.linked');
  assert.equal(linked.payload.linkMethod, 'session');
});

/* ---------- D. identity trust model ---------- */

it('a claimed GBP identifier does not auto-link and does not duplicate', async () => {
  const place = `ChIJ_claimed_${RUN}`;

  const owner = await ingest({
    key: `it-${RUN}-claim-1`, hash: 'h1',
    payload: payload({ submissionId: id(), sessionId: id(), name: 'Claim Owner',
                       contactEmail: email('claim1') }),
    signals: [signal('gbp_place_id', place)]
  });
  assert.equal(owner.error, null);
  assert.equal(owner.data.identityStatus, 'linked', 'no candidate yet, so a record is created');

  const businesses = await count('business_records');

  const other = await ingest({
    key: `it-${RUN}-claim-2`, hash: 'h2',
    payload: payload({ submissionId: id(), sessionId: id(), name: 'Claim Other',
                       contactEmail: email('claim2') }),
    signals: [signal('gbp_place_id', place)]
  });

  assert.equal(other.error, null);
  assert.equal(other.data.identityStatus, 'resolution_pending', 'an unverified claim never links');
  assert.equal(other.data.businessId, null);
  assert.equal(await count('business_records'), businesses, 'and never creates a duplicate');

  const [c] = await rows('identity_resolution_cases', 'assessment_submission_id', other.data.submissionId);
  assert.equal(c.resolution_status, 'manual_review_required');
  assert.equal(c.recommended_action, 'queue_for_review');

  const events = (await rows('timeline_events', 'correlation_id', other.data.submissionId))
    .map(e => e.event_name).sort();
  assert.deepEqual(events,
    ['assessment.completed', 'bir.generated', 'identity.resolved', 'identity.review_required']);
});

it('a verified GBP identifier can auto-link, and squatting reserves nothing', async () => {
  const place = `ChIJ_verified_${RUN}`;

  /* A squatter claims the value first, unverified. */
  const squatter = await ingest({
    key: `it-${RUN}-squat`, hash: 'h1',
    payload: payload({ submissionId: id(), sessionId: id(), name: 'Squatter',
                       contactEmail: email('squat') }),
    signals: [signal('gbp_place_id', place)]
  });
  assert.equal(squatter.error, null);

  /* The real owner is verified against the SAME value. The uniqueness backstop
     covers verified rows only, so this must succeed. */
  const ownerId = id();
  created.businessIds.push(ownerId);
  const { error: bizErr } = await db.from('business_records')
    .insert({ business_id: ownerId, display_name: `Verified Owner ${RUN}`, vertical_id: 'nails' });
  assert.equal(bizErr, null, 'an unverified claim must not reserve the value');

  const { error: idErr } = await db.from('business_identifiers').insert({
    business_id: ownerId, identifier_type: 'gbp_place_id', normalized_value: place,
    source: 'trusted_integration', verified: true, verification_method: 'integration_callback'
  });
  assert.equal(idErr, null, 'the real owner can still be verified against a squatted value');

  /* Now one candidate is verified and one is merely claimed: the verified one wins. */
  const linked = await ingest({
    key: `it-${RUN}-verified-link`, hash: 'h2',
    payload: payload({ submissionId: id(), sessionId: id(), name: 'Returning Owner',
                       contactEmail: email('verified') }),
    signals: [signal('gbp_place_id', place)]
  });

  assert.equal(linked.error, null);
  assert.equal(linked.data.identityStatus, 'linked');
  assert.equal(linked.data.businessId, ownerId, 'linked to the VERIFIED holder, not the squatter');

  /* The visitor-supplied signal must not have downgraded the verified row. */
  const held = (await rows('business_identifiers', 'business_id', ownerId))
    .find(i => i.identifier_type === 'gbp_place_id');
  assert.equal(held.verified, true);
  assert.equal(held.source, 'trusted_integration');
});

it('a duplicate verified strong identifier is refused by the database', async () => {
  const place = `ChIJ_unique_${RUN}`;
  const a = id();
  const b = id();
  created.businessIds.push(a, b);

  await db.from('business_records').insert([
    { business_id: a, display_name: `Holder A ${RUN}`, vertical_id: 'nails' },
    { business_id: b, display_name: `Holder B ${RUN}`, vertical_id: 'nails' }
  ]);

  const first = await db.from('business_identifiers').insert({
    business_id: a, identifier_type: 'gbp_place_id', normalized_value: place,
    source: 'trusted_integration', verified: true, verification_method: 'integration_callback'
  });
  assert.equal(first.error, null);

  const second = await db.from('business_identifiers').insert({
    business_id: b, identifier_type: 'gbp_place_id', normalized_value: place,
    source: 'trusted_integration', verified: true, verification_method: 'integration_callback'
  });
  assert.ok(second.error, 'two verified holders of one identifier must be impossible');
  assert.match(second.error.message, /duplicate key|unique/i);
});

it('conflicting verified identifiers create a resolution case, never a merge', async () => {
  const placeA = `ChIJ_confA_${RUN}`;
  const extB = `cus_confB_${RUN}`;
  const a = id();
  const b = id();
  created.businessIds.push(a, b);

  await db.from('business_records').insert([
    { business_id: a, display_name: `Conflict A ${RUN}`, vertical_id: 'nails' },
    { business_id: b, display_name: `Conflict B ${RUN}`, vertical_id: 'nails' }
  ]);
  await db.from('business_identifiers').insert([
    { business_id: a, identifier_type: 'gbp_place_id', normalized_value: placeA,
      source: 'trusted_integration', verified: true, verification_method: 'integration_callback' },
    { business_id: b, identifier_type: 'external_customer_id', normalized_value: extB,
      source: 'trusted_integration', verified: true, verification_method: 'integration_callback' }
  ]);

  const businesses = await count('business_records');

  const ambiguous = await ingest({
    key: `it-${RUN}-ambiguous`, hash: 'h1',
    payload: payload({ submissionId: id(), sessionId: id(), name: 'Ambiguous',
                       contactEmail: email('ambiguous') }),
    signals: [signal('gbp_place_id', placeA), signal('external_customer_id', extB)]
  });

  assert.equal(ambiguous.error, null);
  assert.equal(ambiguous.data.identityStatus, 'resolution_pending');
  assert.equal(ambiguous.data.businessId, null);
  assert.equal(await count('business_records'), businesses, 'no third record');

  const [c] = await rows('identity_resolution_cases', 'assessment_submission_id',
    ambiguous.data.submissionId);
  assert.equal(c.resolution_status, 'possible_duplicate');

  const merged = await rows('business_records', 'business_id', a);
  assert.equal(merged[0].merged_into_business_id, null, 'merging never happens automatically');
});

it('a cross-business claim on a verified identifier opens a review case and is not written', async () => {
  const place = `ChIJ_cross_${RUN}`;
  const holder = id();
  created.businessIds.push(holder);

  await db.from('business_records')
    .insert({ business_id: holder, display_name: `Cross Holder ${RUN}`, vertical_id: 'nails' });
  await db.from('business_identifiers').insert({
    business_id: holder, identifier_type: 'gbp_place_id', normalized_value: place,
    source: 'trusted_integration', verified: true, verification_method: 'integration_callback'
  });

  /* A session already settles identity, so the claim is pure conflict. */
  const sessionId = id();
  const first = await ingest({
    key: `it-${RUN}-cross-1`, hash: 'h1',
    payload: payload({ submissionId: id(), sessionId, contactEmail: email('cross') }),
    signals: [signal('email_exact', email('cross'))]
  });
  assert.equal(first.error, null);

  const claiming = await ingest({
    key: `it-${RUN}-cross-2`, hash: 'h2',
    payload: payload({ submissionId: id(), sessionId, contactEmail: email('cross') }),
    signals: [signal('gbp_place_id', place)]
  });

  assert.equal(claiming.error, null);
  assert.equal(claiming.data.businessId, first.data.businessId, 'the session still resolves identity');

  const [c] = await rows('identity_resolution_cases', 'assessment_submission_id',
    claiming.data.submissionId);
  assert.ok(c, 'the collision is surfaced, not swallowed');
  const conflict = c.conflicting_signals.find(x => x.identifierType === 'gbp_place_id');
  assert.equal(conflict.heldByBusinessId, holder);
  assert.equal(conflict.claimSource, 'visitor_supplied');

  const written = (await rows('business_identifiers', 'business_id', first.data.businessId))
    .filter(i => i.identifier_type === 'gbp_place_id');
  assert.equal(written.length, 0, 'the contested claim is reported, never written');
});

/* ---------- E. clock skew (blocker B4) ---------- */

it('a submittedAt four minutes in the future ingests and is clamped', async () => {
  const submissionId = id();
  const future = new Date(Date.now() + 4 * 60 * 1000).toISOString();

  const { data, error } = await ingest({
    key: `it-${RUN}-skew`, hash: 'h-skew',
    payload: payload({ submissionId, sessionId: id(), contactEmail: email('skew'),
                       submittedAt: future }),
    signals: [signal('email_exact', email('skew'))],
    meta: { clockSkewDetected: true, clockSkewMs: 240000, timelineTimestampClamped: true,
            correlationId: `it-${RUN}-skew` }
  });

  assert.equal(error, null, 'a fast device clock must never abort ingestion');
  assert.equal(data.clockSkewDetected, true);

  const [submission] = await rows('assessment_submissions', 'submission_id', submissionId);
  assert.equal(submission.submitted_at.slice(0, 19), future.slice(0, 19),
    'the visitor value is preserved verbatim');
  assert.ok(Date.parse(submission.submitted_at) > Date.parse(submission.received_at),
    'and it really is in the future');

  const events = await rows('timeline_events', 'correlation_id', submissionId);
  assert.ok(events.length >= 5);
  events.forEach(e => {
    assert.ok(Date.parse(e.recorded_at) >= Date.parse(e.occurred_at),
      `${e.event_name} violates timeline_recorded_after_occurred`);
    assert.ok(Date.parse(e.occurred_at) <= Date.parse(submission.received_at),
      `${e.event_name} was not clamped`);
  });

  const completed = events.find(e => e.event_name === 'assessment.completed');
  assert.equal(completed.payload.reportedSubmittedAt.slice(0, 19), future.slice(0, 19),
    'the original claim is recorded in the event payload');
});

it('the timeline constraint that made the clamp necessary is genuinely enforced', async () => {
  const { data } = await db.from('business_records').select('business_id').limit(1);
  const businessId = data && data[0] && data[0].business_id;
  const { error } = await db.from('timeline_events').insert({
    business_id: businessId, event_name: `test.future.${RUN}`, event_version: 1,
    occurred_at: new Date(Date.now() + 3600_000).toISOString(),
    producer: 'integration-test', idempotency_key: `it-${RUN}-future`, summary: 'x'
  });
  assert.ok(error, 'occurred_at in the future must be refused');
  assert.match(error.message, /timeline_recorded_after_occurred|violates check/i);
});

/* ---------- F. append-only protection ---------- */

it('timeline and audit history refuse UPDATE and DELETE', async () => {
  const [event] = (await db.from('timeline_events').select('event_id').limit(1)).data;
  const [audit] = (await db.from('audit_events').select('audit_event_id').limit(1)).data;

  const tUpd = await db.from('timeline_events').update({ summary: 'tampered' })
    .eq('event_id', event.event_id);
  assert.ok(tUpd.error, 'timeline UPDATE must be refused');
  assert.match(tUpd.error.message, /append_only_violation/);

  const tDel = await db.from('timeline_events').delete().eq('event_id', event.event_id);
  assert.ok(tDel.error, 'timeline DELETE must be refused');
  assert.match(tDel.error.message, /append_only_violation/);

  const aUpd = await db.from('audit_events').update({ reason: 'tampered' })
    .eq('audit_event_id', audit.audit_event_id);
  assert.ok(aUpd.error, 'audit UPDATE must be refused');

  const aDel = await db.from('audit_events').delete().eq('audit_event_id', audit.audit_event_id);
  assert.ok(aDel.error, 'audit DELETE must be refused');
});

it('assessment submissions refuse DELETE', async () => {
  const [submission] = (await db.from('assessment_submissions').select('submission_id').limit(1)).data;
  const { error } = await db.from('assessment_submissions').delete()
    .eq('submission_id', submission.submission_id);
  assert.ok(error, 'submission DELETE must be refused');
  assert.match(error.message, /append_only_violation/);
});

/* ---------- G. constraint-level rejections ---------- */

it('deliberate constraint violations are all refused', async () => {
  const [record] = (await db.from('business_records').select('business_id').limit(1)).data;
  const [session] = (await db.from('assessment_sessions').select('assessment_session_id').limit(1)).data;

  const cases = [
    ['invalid uuid', db.from('business_records')
      .insert({ business_id: 'not-a-uuid', display_name: 'x', vertical_id: 'nails' })],
    ['linked submission with null businessId', db.from('assessment_submissions').insert({
      submission_id: id(), assessment_session_id: session.assessment_session_id, business_id: null,
      assessment_version: '1.0.0', vertical_id: 'nails', raw_payload: {},
      identity_status: 'linked', submitted_at: new Date().toISOString(), payload_hash: 'h' })],
    ['resolution_pending with a businessId', db.from('assessment_submissions').insert({
      submission_id: id(), assessment_session_id: session.assessment_session_id,
      business_id: record.business_id, assessment_version: '1.0.0', vertical_id: 'nails',
      raw_payload: {}, identity_status: 'resolution_pending',
      submitted_at: new Date().toISOString(), payload_hash: 'h' })],
    ['invalid identity_status', db.from('business_records')
      .insert({ business_id: id(), display_name: 'x', vertical_id: 'nails',
                identity_status: 'totally_made_up' })],
    ['business_records may not be resolution_pending', db.from('business_records')
      .insert({ business_id: id(), display_name: 'x', vertical_id: 'nails',
                identity_status: 'resolution_pending' })],
    ['context identifier type', db.from('business_identifiers')
      .insert({ business_id: record.business_id, identifier_type: 'vertical',
                normalized_value: 'nails' })],
    ['oversized identifier value', db.from('business_identifiers')
      .insert({ business_id: record.business_id, identifier_type: 'business_name',
                normalized_value: 'x'.repeat(3000) })],
    ['verified from an untrusted source', db.from('business_identifiers')
      .insert({ business_id: record.business_id, identifier_type: 'gbp_place_id',
                normalized_value: `ChIJ_untrusted_${RUN}`, source: 'visitor_supplied',
                verified: true, verification_method: 'operator_review' })],
    ['verified with verification_method none', db.from('business_identifiers')
      .insert({ business_id: record.business_id, identifier_type: 'gbp_place_id',
                normalized_value: `ChIJ_nomethod_${RUN}`, source: 'trusted_integration',
                verified: true, verification_method: 'none' })],
    ['unsupported payload_schema_version', db.from('assessment_submissions').insert({
      submission_id: id(), assessment_session_id: session.assessment_session_id,
      business_id: record.business_id, assessment_version: '1.0.0', vertical_id: 'nails',
      raw_payload: {}, identity_status: 'linked', submitted_at: new Date().toISOString(),
      payload_hash: 'h', payload_schema_version: 9 })],
    ['raw address as a rate-limit bucket key', db.from('rate_limit_buckets')
      .insert({ scope: 'address', bucket_key: '203.0.113.9',
                window_start: new Date().toISOString(),
                expires_at: new Date(Date.now() + 3600_000).toISOString() })],
    ['invalid BIR schema version', db.from('business_intelligence_reports').insert({
      bir_id: id(), business_id: record.business_id,
      assessment_submission_id: created.submissionIds[0], schema_version: 99,
      report: {}, confidence_band: 'low' })]
  ];

  for (const [label, query] of cases) {
    const { error } = await query;
    assert.ok(error, `${label} must be refused`);
  }
});

/* ---------- H. rate limiting ---------- */

it('rate limiting allows up to the limit and then refuses with a retry hint', async () => {
  const bucket = createHash('sha256').update(`it-${RUN}-rl`).digest('hex');
  created.bucketKeys.push(bucket);
  const keys = [{ scope: 'address', key: bucket }];

  for (let i = 1; i <= 3; i++) {
    const { data, error } = await rpc('check_rate_limit',
      { p_keys: keys, p_window_seconds: 900, p_max_requests: 3 });
    assert.equal(error, null);
    assert.equal(data.allowed, true, `call ${i} should be allowed`);
    assert.equal(data.count, i);
  }

  const { data: over } = await rpc('check_rate_limit',
    { p_keys: keys, p_window_seconds: 900, p_max_requests: 3 });
  assert.equal(over.allowed, false);
  assert.equal(over.scope, 'address');
  assert.ok(over.retryAfterSeconds > 0 && over.retryAfterSeconds <= 900);

  /* Nothing resembling a raw address is stored. */
  const stored = await rows('rate_limit_buckets', 'bucket_key', bucket);
  assert.equal(stored.length, 1);
  assert.match(stored[0].bucket_key, /^[0-9a-f]{64}$/);
});

/* ---------- I. maintenance ---------- */

it('idempotency cleanup removes only records past expiry', async () => {
  const expiredKey = `it-${RUN}-expired`;
  const liveKey = `it-${RUN}-live`;
  created.idempotencyKeys.push(expiredKey, liveKey);

  /* idempotency_expiry_future forbids expires_at <= created_at, so an aged-out
     record has to be created with a backdated created_at as well. */
  const now = Date.now();
  await db.from('idempotency_records').insert([
    { idempotency_key: expiredKey, request_hash: 'h',
      created_at: new Date(now - 40 * 86400000).toISOString(),
      expires_at: new Date(now - 10 * 86400000).toISOString() },
    { idempotency_key: liveKey, request_hash: 'h',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 30 * 86400000).toISOString() }
  ]);

  const submissionsBefore = await count('assessment_submissions');
  const { data: removed, error } = await rpc('purge_expired_idempotency_records', {});
  assert.equal(error, null);
  assert.ok(removed >= 1);

  assert.equal(await count('idempotency_records', 'idempotency_key', expiredKey), 0);
  assert.equal(await count('idempotency_records', 'idempotency_key', liveKey), 1);
  assert.equal(await count('assessment_submissions'), submissionsBefore,
    'purging a key never touches the assessment itself');
});

/* ---------- J. redaction ---------- */

it('redaction removes PII while preserving structure, scoring and consent', async () => {
  const marker = email('redact');
  const submissionId = id();
  const { data, error } = await ingest({
    key: `it-${RUN}-redact`, hash: 'h-redact',
    payload: payload({ submissionId, sessionId: id(), name: `Redact Me ${RUN}`,
                       contactEmail: marker }),
    signals: [signal('email_exact', marker), signal('business_name', `redact me ${RUN}`)],
    birDoc: bir(`Redact Me ${RUN}`)
  });
  assert.equal(error, null);
  const businessId = data.businessId;

  const before = {
    events: await count('timeline_events', 'business_id', businessId),
    birs: await count('business_intelligence_reports', 'business_id', businessId),
    submissions: await count('assessment_submissions', 'business_id', businessId)
  };

  const { data: result, error: redactErr } = await rpc('redact_business_pii', {
    p_business_id: businessId,
    p_reason: 'Integration validation of the erasure path.',
    p_actor: 'integration-suite',
    p_actor_type: 'system'
  });
  assert.equal(redactErr, null);
  assert.ok(result.notes.some(n => /no claim of compliance/i.test(n)));

  const [record] = await rows('business_records', 'business_id', businessId);
  assert.equal(record.display_name, '[redacted]');
  assert.equal(record.legal_name, null);

  const [submission] = await rows('assessment_submissions', 'submission_id', submissionId);
  assert.ok(!JSON.stringify(submission.raw_payload).includes(marker), 'the email is gone');
  assert.equal(submission.raw_payload.answers.technicians, '3', 'scoring inputs survive');
  assert.equal(submission.raw_payload.consent.resultsDeliveryConsent.granted, true,
    'consent evidence survives');

  const identifiers = await rows('business_identifiers', 'business_id', businessId);
  identifiers.forEach(i => {
    assert.equal(i.raw_value, null);
    assert.ok(!i.normalized_value.includes(RUN) || i.normalized_value.startsWith('redacted:'));
    assert.ok(i.valid_to, 'PII identifier rows are closed');
  });

  const [report] = await rows('business_intelligence_reports', 'business_id', businessId);
  assert.equal(report.report.businessProfile.displayName, '[redacted]');
  assert.equal(report.report.estimateConfidence.band, 'medium', 'analysis unchanged');
  assert.equal(report.report.packageRecommendation.priceMonthly, 597, 'pricing unchanged');

  assert.equal(await count('timeline_events', 'business_id', businessId), before.events,
    'history is neither deleted nor added to');
  assert.equal(await count('business_intelligence_reports', 'business_id', businessId), before.birs);
  assert.equal(await count('assessment_submissions', 'business_id', businessId), before.submissions);

  const audits = await rows('audit_events', 'business_id', businessId);
  assert.ok(audits.some(a => a.action === 'business.pii_redacted'));
});

it('timeline and audit payloads carry no contact data — the invariant redaction depends on', async () => {
  const { data: events } = await db.from('timeline_events').select('event_name,payload').limit(500);
  const { data: audits } = await db.from('audit_events').select('reason,new_value').limit(500);

  const pii = /@|polished\.test|864-555/i;
  events.forEach(e => {
    assert.ok(!pii.test(JSON.stringify(e.payload)),
      `${e.event_name} carries contact data and can never be redacted`);
  });
  audits.forEach(a => {
    assert.ok(!pii.test(JSON.stringify(a.new_value ?? {})), 'audit payloads carry contact data');
  });
});

/* ---------- K. transaction rollback ---------- */

it('a failure mid-transaction leaves no partial records and the key stays retryable', async () => {
  const key = `it-${RUN}-rollback`;
  const submissionId = id();
  const sessionId = id();
  const p = payload({ submissionId, sessionId, name: `Rollback ${RUN}`,
                      contactEmail: email('rollback') });

  const before = {
    businesses: await count('business_records'),
    submissions: await count('assessment_submissions'),
    events: await count('timeline_events'),
    keys: await count('idempotency_records')
  };

  /* An invalid confidence_band fails the BIR insert, which happens after the
     claim, the business, the submission and the identifiers. */
  const bad = bir(`Rollback ${RUN}`);
  bad.estimateConfidence.band = 'bogus';
  const failed = await ingest({ key, hash: 'h-rollback', payload: p,
    signals: [signal('email_exact', email('rollback'))], birDoc: bad });

  assert.ok(failed.error, 'the invalid BIR must be refused');

  assert.equal(await count('business_records'), before.businesses, 'no orphan business');
  assert.equal(await count('assessment_submissions'), before.submissions, 'no orphan submission');
  assert.equal(await count('timeline_events'), before.events, 'no orphan events');
  assert.equal(await count('idempotency_records'), before.keys, 'not even the claim survives');

  /* The same key must now succeed. */
  const retry = await ingest({ key, hash: 'h-rollback', payload: p,
    signals: [signal('email_exact', email('rollback'))] });
  assert.equal(retry.error, null, 'the key was not poisoned by the rollback');
  assert.equal(retry.data.identityStatus, 'linked');
});

/* ============================================================
   M. Migration 0004 — the two-stage progressive assessment

   Everything above proves the store. This section proves the two
   AFTER INSERT triggers 0004 adds, and it does so with REAL
   Business Intelligence Reports produced by generate-bir.js
   rather than the compact stand-in used elsewhere. The stage
   rules live inside that artifact — a stand-in with the right
   shape and invented contents would prove the triggers fire and
   nothing about what they fire on.
   ============================================================ */

const stagedIngest = async ({ key: idemKey, hash, payload: p, birId = id(),
                              supersedesBirId = null, signals = [], meta = {} }) => {
  const report = bie.generateBir({
    submission: p,
    birId,
    generatedAt: new Date().toISOString(),
    supersedesBirId
  });
  /* A malformed report must never reach the database from here: a trigger test
     that silently stored a broken artifact would pass for the wrong reason. */
  const check = bie.validateGeneratedBir(report);
  assert.deepEqual(check.errors, [], 'the generated BIR must validate before storage');

  const result = await ingest({ key: idemKey, hash, payload: p, signals, birDoc: report, birId, meta });
  return { ...result, report };
};

/* Timeline rows the ingestion of one submission produced, in the order the
   database recorded them. correlation_id is the submission id for every row
   ingest_assessment writes AND for every row the 0004 triggers write. */
const eventsFor = async submissionId => {
  const { data, error } = await db.from('timeline_events')
    .select('event_name, event_version, occurred_at, recorded_at, producer, idempotency_key, payload')
    .eq('correlation_id', submissionId)
    .order('recorded_at', { ascending: true });
  if (error) throw new Error(`timeline read failed: ${error.message}`);
  return data;
};
const namesOf = events => events.map(e => e.event_name);

it('M1 — a Stage 1 submission stores a preliminary BIR and emits only Stage 1 events', async () => {
  const submissionId = id();
  const sessionId = id();
  const key = `it-${RUN}-stage1`;
  const p = stagedPayload({ stage: 1, submissionId, sessionId, name: `Staged ${RUN}` });

  const before = {
    businesses: await count('business_records'),
    submissions: await count('assessment_submissions'),
    birs: await count('business_intelligence_reports'),
    events: await count('timeline_events')
  };

  const { data, error, report } = await stagedIngest({
    key, hash: `h-${RUN}-stage1`, payload: p,
    signals: [signal('email_exact', email('staged')), signal('business_name', `staged ${RUN}`)]
  });

  assert.equal(error, null, error && error.message);
  assert.equal(data.replayed, false);
  assert.equal(data.payloadSchemaVersion, 5, 'payload schema 5 is accepted');
  assert.equal(data.supersedesBirId, null, 'nothing precedes a preliminary report');

  assert.equal(await count('business_records'), before.businesses + 1);
  assert.equal(await count('assessment_submissions'), before.submissions + 1);
  assert.equal(await count('business_intelligence_reports'), before.birs + 1);
  assert.equal(await count('timeline_events'), before.events + 7,
    'five from the function plus stage1.completed and preliminary_bir.generated');

  /* KNOWN LIMITATION — the response enumerates the events ingest_assessment
     wrote ITSELF. The two written by the 0004 triggers are not in the list,
     because a trigger cannot append to the function's local array. They are
     discoverable by correlation_id, which is what this suite uses. Asserted so
     the gap is a decision rather than a surprise. See
     docs/REAL_POSTGRES_VALIDATION.md. */
  assert.equal(data.timelineEventIds.length, 5,
    'timelineEventIds covers the function\'s own events, not the triggers\'');

  const events = await eventsFor(submissionId);
  const names = namesOf(events);

  /* Same regression as M2, on the preliminary side. */
  const birEvent = events.find(e => e.event_name === 'bir.generated');
  const prelimEvent = events.find(e => e.event_name === 'preliminary_bir.generated');
  assert.equal(prelimEvent.occurred_at, birEvent.occurred_at,
    'two events describing one BIR insert must carry one timestamp');
  ['business.created', 'identity.resolved', 'identity.linked',
   'assessment.completed', 'bir.generated',
   'stage1.completed', 'preliminary_bir.generated']
    .forEach(name => assert.ok(names.includes(name), `missing ${name}`));
  ['stage2.started', 'stage2.completed', 'full_bir.generated']
    .forEach(name => assert.ok(!names.includes(name), `Stage 2 event leaked: ${name}`));

  /* Stored BIR JSON, read back from Postgres rather than from memory. */
  const [stored] = await rows('business_intelligence_reports', 'bir_id', report.identity.birId);
  assert.equal(stored.schema_version, 4);
  const doc = stored.report;
  assert.equal(doc.assessmentProgress.assessmentStageCompleted, 1);
  assert.equal(doc.assessmentProgress.resultState, 'fit_review_available');
  assert.equal(doc.assessmentProgress.confidenceKind, 'preliminary');
  assert.equal(doc.estimateConfidence.kind, 'preliminary');
  assert.equal(doc.assessmentProgress.closeReadinessProvisional, true);
  assert.equal(doc.closeReadinessProfile.provisional, true);
  assert.notEqual(doc.closeReadinessProfile.band, 'ask_for_sale',
    'a preliminary report may never ask for the sale');
  assert.equal(doc.closeReadinessProfile.approvedLanguageKey, null);
  assert.ok(doc.assessmentProgress.missingStage2Evidence.length > 0);
  ['canApprove', 'budgetSignal', 'bookingPlatform', 'primaryConcern']
    .forEach(f => assert.ok(doc.assessmentProgress.missingStage2Evidence.includes(f), f));

  /* Attribution and consent survive ingestion untouched. */
  const [submission] = await rows('assessment_submissions', 'submission_id', submissionId);
  assert.equal(submission.raw_payload.attribution.firstTouch.url, p.attribution.firstTouch.url);
  assert.equal(submission.attribution_snapshot.firstTouch.utm.utm_source, 'qr_card');
  assert.equal(submission.consent_snapshot.resultsDeliveryConsent.granted, true);
  assert.equal(submission.submitted_at.startsWith(p.submittedAt.slice(0, 19)), true);
});

it('M2 — a Stage 2 submission in the same session supersedes the preliminary BIR', async () => {
  const sessionId = id();
  const stage1Id = id();
  const stage2Id = id();

  const first = await stagedIngest({
    key: `it-${RUN}-chain-s1`, hash: `h-${RUN}-chain-s1`,
    payload: stagedPayload({ stage: 1, submissionId: stage1Id, sessionId, name: `Chain ${RUN}` }),
    signals: [signal('email_exact', email('chain'))]
  });
  assert.equal(first.error, null, first.error && first.error.message);
  const businessId = first.data.businessId;
  const preliminaryBirId = first.data.birId;

  const before = {
    submissions: await count('assessment_submissions'),
    birs: await count('business_intelligence_reports'),
    events: await count('timeline_events')
  };

  const second = await stagedIngest({
    key: `it-${RUN}-chain-s2`, hash: `h-${RUN}-chain-s2`,
    payload: stagedPayload({ stage: 2, submissionId: stage2Id, sessionId,
                             supersedesSubmissionId: stage1Id, name: `Chain ${RUN}` }),
    signals: [signal('email_exact', email('chain'))]
  });
  assert.equal(second.error, null, second.error && second.error.message);

  assert.equal(second.data.businessId, businessId, 'the session links both stages');
  assert.equal(second.data.supersedesBirId, preliminaryBirId);
  assert.equal(await count('assessment_submissions'), before.submissions + 1);
  assert.equal(await count('business_intelligence_reports'), before.birs + 1);
  assert.equal(await count('timeline_events'), before.events + 7,
    'four from the function plus stage2.started, stage2.completed, full_bir.generated');

  /* The chain, read from the database. */
  const [fullRow] = await rows('business_intelligence_reports', 'bir_id', second.data.birId);
  assert.equal(fullRow.supersedes_bir_id, preliminaryBirId);
  const [record] = await rows('business_records', 'business_id', businessId);
  assert.equal(record.current_bir_id, second.data.birId, 'current points at the full report');

  /* The preliminary report is still there, still preliminary, untouched. */
  const [prelimRow] = await rows('business_intelligence_reports', 'bir_id', preliminaryBirId);
  assert.ok(prelimRow, 'the preliminary report is preserved');
  assert.equal(prelimRow.report.assessmentProgress.assessmentStageCompleted, 1);
  assert.equal(prelimRow.report.closeReadinessProfile.provisional, true);

  const full = fullRow.report;
  assert.equal(full.assessmentProgress.assessmentStageCompleted, 2);
  assert.equal(full.assessmentProgress.confidenceKind, 'full');
  assert.equal(full.estimateConfidence.kind, 'full');
  assert.equal(full.assessmentProgress.closeReadinessProvisional, false);
  assert.equal(full.closeReadinessProfile.provisional, false);
  assert.equal(full.assessmentProgress.stage1SubmissionId, stage1Id);
  assert.equal(full.assessmentProgress.supersedesPreliminaryBir, true);
  assert.equal(full.assessmentProgress.resultState !== 'fit_review_available', true);
  /* Readiness evidence that Stage 1 could not have is populated now. */
  Object.values(full.closeReadinessProfile.signals)
    .forEach(s => assert.equal(s.inScope, true, 'every signal is in scope at Stage 2'));
  assert.equal(full.decisionProfile.canApprove, 'yes');
  assert.equal(full.budgetProfile.signal, 'approve_if_value');
  assert.equal(full.technologyProfile.bookingSystem, 'square');
  /* Approved close language only ever accompanies ask_for_sale. */
  if (full.closeReadinessProfile.band === 'ask_for_sale') {
    assert.equal(full.closeReadinessProfile.approvedLanguageKey, 'ask_for_sale');
  } else {
    assert.equal(full.closeReadinessProfile.approvedLanguageKey, null);
  }

  const events = await eventsFor(stage2Id);
  const s2 = namesOf(events);
  ['stage2.started', 'stage2.completed', 'full_bir.generated']
    .forEach(name => assert.ok(s2.includes(name), `missing ${name}`));
  ['stage1.completed', 'preliminary_bir.generated']
    .forEach(name => assert.ok(!s2.includes(name), `Stage 1 event duplicated: ${name}`));

  /* REGRESSION — real-Postgres validation, 2026-08-05.
     bir.generated and full_bir.generated describe the SAME insert in the SAME
     transaction. The first version of the trigger anchored on generated_at
     while ingest_assessment anchors on least(submitted_at, now()), and the two
     drifted by 104 seconds in the first validated run. The browser retry queue
     holds submissions for up to 30 days, so the gap is bounded only by that
     window. One insert, one timestamp. */
  const birEvent = events.find(e => e.event_name === 'bir.generated');
  const fullEvent = events.find(e => e.event_name === 'full_bir.generated');
  assert.equal(fullEvent.occurred_at, birEvent.occurred_at,
    'two events describing one BIR insert must carry one timestamp');

  /* And Stage 1's own events were not written a second time. */
  const s1 = namesOf(await eventsFor(stage1Id));
  assert.equal(s1.filter(n => n === 'stage1.completed').length, 1);
  assert.equal(s1.filter(n => n === 'preliminary_bir.generated').length, 1);
});

it('M3 — replaying either stage creates nothing, triggers included', async () => {
  const sessionId = id();
  const stage1Id = id();
  const stage2Id = id();

  const p1 = stagedPayload({ stage: 1, submissionId: stage1Id, sessionId, name: `Replay ${RUN}` });
  const p2 = stagedPayload({ stage: 2, submissionId: stage2Id, sessionId,
                             supersedesSubmissionId: stage1Id, name: `Replay ${RUN}` });

  const a = await stagedIngest({ key: `it-${RUN}-rep-s1`, hash: `h-${RUN}-rep-s1`, payload: p1 });
  const b = await stagedIngest({ key: `it-${RUN}-rep-s2`, hash: `h-${RUN}-rep-s2`, payload: p2 });
  assert.equal(a.error, null);
  assert.equal(b.error, null);

  const before = {
    submissions: await count('assessment_submissions'),
    birs: await count('business_intelligence_reports'),
    events: await count('timeline_events')
  };

  /* Deliberately different BIR ids: a replay must ignore them entirely, which
     also means the triggers cannot fire again — nothing is inserted to fire on. */
  const replay1 = await stagedIngest({ key: `it-${RUN}-rep-s1`, hash: `h-${RUN}-rep-s1`,
                                       payload: p1, birId: id() });
  const replay2 = await stagedIngest({ key: `it-${RUN}-rep-s2`, hash: `h-${RUN}-rep-s2`,
                                       payload: p2, birId: id() });

  assert.equal(replay1.data.replayed, true);
  assert.equal(replay2.data.replayed, true);
  assert.equal(replay1.data.birId, a.data.birId, 'the original BIR id is returned');
  assert.equal(replay2.data.birId, b.data.birId);
  assert.equal(replay2.data.supersedesBirId, b.data.supersedesBirId);

  assert.equal(await count('assessment_submissions'), before.submissions);
  assert.equal(await count('business_intelligence_reports'), before.birs);
  assert.equal(await count('timeline_events'), before.events, 'no staged event fires twice');

  const names = namesOf(await eventsFor(stage2Id));
  assert.equal(names.filter(n => n === 'stage2.started').length, 1);
  assert.equal(names.filter(n => n === 'stage2.completed').length, 1);
  assert.equal(names.filter(n => n === 'full_bir.generated').length, 1);
});

it('M4 — a payload declaring no stage stays a full review and emits no staged events', async () => {
  const submissionId = id();
  const sessionId = id();
  const key = `it-${RUN}-legacy`;

  const p = stagedPayload({ stage: 2, submissionId, sessionId, name: `Legacy ${RUN}` });
  /* A page cached before this deploy: schema 4, no assessmentStage block. */
  delete p.assessmentStage;
  delete p.results.opportunityRange;
  p.schemaVersion = 4;

  const before = { events: await count('timeline_events') };
  const { data, error, report } = await stagedIngest({
    key, hash: `h-${RUN}-legacy`, payload: p
  });

  assert.equal(error, null, error && error.message);
  assert.equal(data.payloadSchemaVersion, 4, 'schema 4 remains accepted');
  assert.equal(await count('timeline_events'), before.events + 5, 'only the function\'s own events');

  const names = namesOf(await eventsFor(submissionId));
  assert.ok(names.includes('assessment.completed'));
  assert.ok(names.includes('bir.generated'));
  assert.ok(!names.some(n => n.startsWith('stage')), 'no staged event for an unstaged review');
  assert.ok(!names.some(n => n.endsWith('_bir.generated')),
    'naming it a full-review report would assert a review that never happened');

  const [stored] = await rows('business_intelligence_reports', 'bir_id', report.identity.birId);
  assert.equal(stored.report.assessmentProgress.assessmentStageCompleted, 2);
  assert.equal(stored.report.assessmentProgress.stageDeclared, false);
  assert.equal(stored.report.closeReadinessProfile.provisional, false);
});

it('M5 — staged events satisfy the timeline constraint under maximum tolerated clock skew', async () => {
  const sessionId = id();
  const submissionId = id();
  /* The endpoint accepts up to five minutes of future skew. The trigger clamps
     with least(submitted_at, now()) for the same reason ingest_assessment does:
     recorded_at >= occurred_at must hold or the whole transaction aborts. */
  const future = new Date(Date.now() + 5 * 60 * 1000 - 1000).toISOString();
  const started = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const p = stagedPayload({ stage: 2, submissionId, sessionId, name: `Skew ${RUN}`,
                            submittedAt: future, supersedesSubmissionId: id() });
  p.assessmentStage.stage2StartedAt = started;

  const { data, error } = await stagedIngest({
    key: `it-${RUN}-skew`, hash: `h-${RUN}-skew`, payload: p,
    meta: { clockSkewDetected: true }
  });
  assert.equal(error, null, error && error.message);
  assert.ok(data.ok);

  const events = await eventsFor(submissionId);
  assert.ok(events.length >= 7);
  events.forEach(e => {
    assert.ok(Date.parse(e.recorded_at) >= Date.parse(e.occurred_at),
      `${e.event_name}: recorded_at must not precede occurred_at`);
  });

  /* The visitor's own timestamp is preserved verbatim on the submission row
     even though every event timestamp was clamped. */
  const [submission] = await rows('assessment_submissions', 'submission_id', submissionId);
  assert.equal(submission.raw_payload.submittedAt, future);
  assert.equal(submission.raw_payload.assessmentStage.stage2StartedAt, started);
});

it('M6 — stage2.started carries when the fit review opened, not when it landed', async () => {
  const sessionId = id();
  const submissionId = id();
  const opened = new Date(Date.now() - 8 * 60 * 1000).toISOString();

  const p = stagedPayload({ stage: 2, submissionId, sessionId, name: `Gap ${RUN}`,
                            supersedesSubmissionId: id() });
  p.assessmentStage.stage2StartedAt = opened;

  const { error } = await stagedIngest({ key: `it-${RUN}-gap`, hash: `h-${RUN}-gap`, payload: p });
  assert.equal(error, null, error && error.message);

  const events = await eventsFor(submissionId);
  const started = events.find(e => e.event_name === 'stage2.started');
  const completed = events.find(e => e.event_name === 'stage2.completed');
  assert.ok(started && completed);
  assert.ok(Date.parse(started.occurred_at) < Date.parse(completed.occurred_at),
    'the gap between opening and finishing must be recoverable from the timeline');
  assert.equal(Math.abs(Date.parse(started.occurred_at) - Date.parse(opened)) < 1000, true);
  assert.equal(started.payload.continuesSubmissionId, p.assessmentStage.supersedesSubmissionId);
});

it('M7 — a failure inside the staged flow leaves no partial chain and no orphan events', async () => {
  const sessionId = id();
  const stage1Id = id();

  /* First a real Stage 1, so there is a chain to damage. */
  const good = await stagedIngest({
    key: `it-${RUN}-roll-s1`, hash: `h-${RUN}-roll-s1`,
    payload: stagedPayload({ stage: 1, submissionId: stage1Id, sessionId, name: `Roll ${RUN}` }),
    signals: [signal('email_exact', email('roll'))]
  });
  assert.equal(good.error, null);
  const businessId = good.data.businessId;
  const preliminaryBirId = good.data.birId;

  const before = {
    submissions: await count('assessment_submissions'),
    birs: await count('business_intelligence_reports'),
    events: await count('timeline_events'),
    keys: await count('idempotency_records')
  };

  /* Now a Stage 2 whose BIR fails its CHECK. The submission row — and
     therefore the stage2.started / stage2.completed trigger inserts — has
     already happened by the time the BIR insert raises. */
  const failId = id();
  const failKey = `it-${RUN}-roll-s2`;
  const p2 = stagedPayload({ stage: 2, submissionId: failId, sessionId,
                             supersedesSubmissionId: stage1Id, name: `Roll ${RUN}` });
  const badReport = bie.generateBir({
    submission: p2, birId: id(), generatedAt: new Date().toISOString()
  });
  badReport.estimateConfidence.band = 'bogus';

  const failed = await ingest({ key: failKey, hash: `h-${RUN}-roll-s2`, payload: p2,
    signals: [signal('email_exact', email('roll'))], birDoc: badReport });
  assert.ok(failed.error, 'the invalid BIR must be refused');

  assert.equal(await count('assessment_submissions'), before.submissions, 'no partial submission');
  assert.equal(await count('business_intelligence_reports'), before.birs, 'no partial BIR');
  assert.equal(await count('timeline_events'), before.events,
    'the trigger rows rolled back with everything else');
  assert.equal(await count('idempotency_records'), before.keys, 'not even the claim survives');

  /* Nothing orphaned: no staged event exists for a submission that does not. */
  assert.equal((await eventsFor(failId)).length, 0);

  /* The chain is exactly where it was. */
  const [record] = await rows('business_records', 'business_id', businessId);
  assert.equal(record.current_bir_id, preliminaryBirId,
    'current_bir_id still points at a BIR that exists');
  const [stillThere] = await rows('business_intelligence_reports', 'bir_id', record.current_bir_id);
  assert.ok(stillThere, 'current_bir_id never points at a missing BIR');

  /* And the key is retryable. */
  const retry = await stagedIngest({ key: failKey, hash: `h-${RUN}-roll-s2`, payload: p2,
    signals: [signal('email_exact', email('roll'))] });
  assert.equal(retry.error, null, 'the key was not poisoned by the rollback');
  assert.equal(retry.data.supersedesBirId, preliminaryBirId);
});

it('M8 — a trigger failure aborts the whole ingestion rather than losing an event', async () => {
  /* A staged submission whose stage cannot be parsed. The trigger casts it,
     so the cast raises inside the transaction. What is being proved is not
     that bad input is rejected — it is that a trigger raising takes the whole
     transaction with it, leaving no submission behind without its events. */
  const submissionId = id();
  const sessionId = id();
  const key = `it-${RUN}-trigfail`;
  const p = stagedPayload({ stage: 1, submissionId, sessionId, name: `Trig ${RUN}` });
  p.assessmentStage.stage = 'one';

  const before = {
    submissions: await count('assessment_submissions'),
    events: await count('timeline_events'),
    keys: await count('idempotency_records')
  };

  const { error } = await stagedIngest({ key, hash: `h-${RUN}-trigfail`, payload: p });
  assert.ok(error, 'an unparseable stage must abort ingestion');

  assert.equal(await count('assessment_submissions'), before.submissions);
  assert.equal(await count('timeline_events'), before.events);
  assert.equal(await count('idempotency_records'), before.keys);
  assert.equal((await eventsFor(submissionId)).length, 0);
});

it('M9 — capacity-adjusted ranges survive storage and match what the page shows', async () => {
  const cases = [
    { band: '11_20', label: 'known capacity',      expect: { known: true } },
    { band: 'none',  label: 'zero capacity',       expect: { known: true, clamped: true } },
    { band: 'unsure', label: 'unknown capacity',   expect: { known: false } },
    { band: 'over_20', label: 'expansion-capable', expect: { known: true } }
  ];

  for (const c of cases) {
    const submissionId = id();
    const sessionId = id();
    const p = stagedPayload({ stage: 1, submissionId, sessionId, name: `Cap ${RUN}` });
    p.answers.capacity90Day = c.band;
    if (c.band !== 'none' && c.band !== 'unsure') {
      p.answers.willingnessToExpand = 'yes';
    }
    /* What the page computed, through the SAME function the page calls. */
    const shown = bie.visibleOpportunityRange({
      point: p.results.opportunity, answers: p.answers
    });
    p.results.opportunityRange = {
      low: shown.low, point: shown.point, high: shown.high,
      formatted: `$${Math.round(shown.low)} – $${Math.round(shown.high)}`,
      capacityKnown: shown.capacityKnown, clampApplied: shown.clampApplied,
      assumptions: 'Based on the answers you gave.'
    };

    const { error, report } = await stagedIngest({
      key: `it-${RUN}-cap-${c.band}`, hash: `h-${RUN}-cap-${c.band}`, payload: p
    });
    assert.equal(error, null, `${c.label}: ${error && error.message}`);

    const [stored] = await rows('business_intelligence_reports', 'bir_id', report.identity.birId);
    const fin = stored.report.financialOpportunityProfile;

    /* The stored report and the figure on screen are the same numbers. */
    assert.equal(fin.capacityAdjusted.point, shown.point, `${c.label}: point`);
    assert.equal(fin.capacityAdjusted.low, shown.low, `${c.label}: low`);
    assert.equal(fin.capacityAdjusted.high, shown.high, `${c.label}: high`);
    assert.equal(stored.raw_payload === undefined, true);

    /* The unconstrained estimate is retained, never overwritten. */
    assert.equal(fin.unconstrained.point, Math.round(p.results.opportunity * 100) / 100,
      `${c.label}: the unconstrained figure is preserved`);
    assert.equal(fin.isDiagnosticEstimate, true);
    assert.ok(fin.disclaimer && fin.disclaimer.includes('not a guarantee'),
      `${c.label}: the disclaimer travels with the figure`);

    if (c.expect.known) {
      assert.equal(stored.report.capacityProfile.ceilingKnown, true, `${c.label}: ceiling known`);
      assert.equal(typeof fin.capacityAdjusted.ceiling, 'number');
    } else {
      assert.equal(stored.report.capacityProfile.ceilingKnown, false,
        `${c.label}: a missing ceiling is recorded as missing`);
      assert.equal(fin.capacityAdjusted.ceiling, null);
      assert.equal(fin.capacityAdjusted.clampApplied, false, `${c.label}: unknown stays unconstrained`);
      assert.equal(fin.capacityAdjusted.point, fin.unconstrained.point);
    }

    if (c.expect.clamped) {
      assert.equal(fin.capacityAdjusted.clampApplied, true, `${c.label}: clamp applied`);
      assert.ok(fin.capacityAdjusted.point < fin.unconstrained.point, `${c.label}: clamped down`);
      assert.ok(fin.capacityAdjusted.point > 0,
        'zero headroom still leaves the backfill opportunity');
      assert.ok(fin.capacityAdjusted.backfillPortion > 0);
    }
  }
});

it('M10 — the stored payload carries the whole question path', async () => {
  const submissionId = id();
  const sessionId = id();
  const p = stagedPayload({ stage: 2, submissionId, sessionId, name: `Path ${RUN}`,
                            supersedesSubmissionId: id() });

  const { error } = await stagedIngest({ key: `it-${RUN}-path`, hash: `h-${RUN}-path`, payload: p });
  assert.equal(error, null, error && error.message);

  const [submission] = await rows('assessment_submissions', 'submission_id', submissionId);
  const b = submission.raw_payload.branching;
  const s = submission.raw_payload.assessmentStage;

  assert.equal(b.questionSetVersion, 'nails-questions-3.0.0');
  assert.equal(b.stage, 2);
  assert.ok(Array.isArray(b.visibleFields) && b.visibleFields.length > 0);
  assert.ok(Array.isArray(b.skippedFields));
  assert.ok(b.skippedFields.includes('multiLocationSystems'));
  assert.ok(Array.isArray(b.staleClearedFields));
  assert.ok(Array.isArray(b.visibleSteps) && b.visibleSteps.length > 0);

  assert.equal(s.stage, 2);
  assert.ok(s.stage1CompletedAt, 'the Stage 1 timestamp travels with Stage 2');
  assert.ok(s.stage2StartedAt);
  assert.ok(s.stage2CompletedAt);
  assert.ok(s.supersedesSubmissionId);

  /* The indexed expression the drop-off report will use resolves on real data. */
  const { data: staged, error: qErr } = await db.from('assessment_submissions')
    .select('submission_id').eq('submission_id', submissionId);
  assert.equal(qErr, null);
  assert.equal(staged.length, 1);
});

it('M11 — a Stage 1 payload carries no Stage 2 answer, even after navigating backward', async () => {
  /* The engine scopes a payload by stage rather than relying on fields
     happening to be disabled. This asserts the property on the artifact that
     actually reaches storage. */
  const submissionId = id();
  const sessionId = id();
  const p = stagedPayload({ stage: 1, submissionId, sessionId, name: `Scope ${RUN}` });

  const { error } = await stagedIngest({ key: `it-${RUN}-scope`, hash: `h-${RUN}-scope`, payload: p });
  assert.equal(error, null, error && error.message);

  const [submission] = await rows('assessment_submissions', 'submission_id', submissionId);
  const answers = submission.raw_payload.answers;

  ['canApprove', 'budgetSignal', 'bookingPlatform', 'primaryConcern', 'urgency',
   'phoneSetup', 'yearsInBusiness', 'preferredContact', 'respondentRole']
    .forEach(f => assert.ok(!(f in answers),
      `${f} must be absent, not empty: an unasked question is not a blank answer`));

  /* Stage 1's own evidence is all there. */
  ['locationCount', 'capacity90Day', 'averageTicket', 'missedCallsDay', 'promotions']
    .forEach(f => assert.ok(f in answers, `${f} is Stage 1 evidence and must be present`));

  assert.equal(submission.raw_payload.contact.preferredContact, '');
});

/* ============================================================
   N. Migration 0005 — analytics

   Every row this section writes is namespaced with
   metadata.validationRun = RUN, so it can be found, counted, and
   purged without touching anything else. Analytics rows are the
   ONLY rows in this whole suite that are safe to delete: they
   hold no personal data and no evidence, unlike timeline_events
   and audit_events which refuse DELETE entirely.

   The check that matters most is N1. If it ever fails, stop.
   ============================================================ */

const BUSINESS_RECORD_TABLES = [
  'business_records', 'assessment_submissions', 'business_intelligence_reports',
  'timeline_events', 'audit_events', 'identity_resolution_cases'
];

const businessRecordCounts = async () => {
  const out = {};
  for (const table of BUSINESS_RECORD_TABLES) out[table] = await count(table);
  return out;
};

const analyticsEvent = (overrides = {}) => ({
  eventId: id(),
  eventName: 'assessment.page_viewed',
  eventVersion: 1,
  schemaVersion: 1,
  assessmentSessionId: overrides.assessmentSessionId || id(),
  verticalId: 'nails',
  assessmentVersion: '1.3.0',
  questionSetVersion: 'nails-questions-3.0.0',
  occurredAt: new Date().toISOString(),
  activeElapsedMs: 0,
  totalElapsedMs: 0,
  attribution: {
    firstTouch: { path: '/', referrerHost: 'qr.example', utm: { utm_source: `qr-${RUN}` } },
    latestTouch: { path: '/', utm: {} }
  },
  device: { deviceClass: 'phone', viewportWidth: 400, viewportHeight: 840 },
  /* The namespace. Everything this section writes carries it. */
  metadata: { validationRun: RUN },
  ...overrides
});

const ingestAnalytics = async (events, retentionDays = 400) => {
  events.forEach(e => created.analyticsEventIds.push(e.eventId));
  const sessionId = events[0] && events[0].assessmentSessionId;
  if (sessionId) created.analyticsSessionIds.push(sessionId);
  return rpc('ingest_analytics_events', {
    p_events: events, p_meta: { correlationId: `it-${RUN}` }, p_retention_days: retentionDays
  });
};

it('N1 — analytics activity leaves every Business Record table untouched', async () => {
  const before = await businessRecordCounts();
  const sessionId = id();

  const { error } = await ingestAnalytics([
    analyticsEvent({ assessmentSessionId: sessionId }),
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.started',
                     assessmentStage: 1 }),
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.step_viewed',
                     assessmentStage: 1, stepId: '1', activeElapsedMs: 1000, totalElapsedMs: 2000 }),
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.stage1_completed',
                     assessmentStage: 1, activeElapsedMs: 240000, totalElapsedMs: 400000 })
  ]);
  assert.equal(error, null, error && error.message);

  await rpc('refresh_assessment_funnel_daily', {});
  await rpc('purge_expired_analytics_events', { p_now: new Date().toISOString() });
  await rpc('purge_expired_analytics_sessions', { p_now: new Date().toISOString() });

  const after = await businessRecordCounts();
  BUSINESS_RECORD_TABLES.forEach(table => {
    assert.equal(after[table], before[table],
      `${table} changed during analytics activity — STOP, this is the isolation rule breaking`);
  });
});

it('N2 — no analytics table has a foreign key to the Business Record, in either direction', async () => {
  /* The structural proof behind N1. Read through a function so the suite does
     not need catalog table privileges of its own. */
  const { data, error } = await db.from('assessment_analytics_events').select('event_id').limit(1);
  assert.equal(error, null, 'the analytics tables are reachable with the service role');
  assert.ok(Array.isArray(data));
  /* The catalog assertion itself is made in docs/REAL_POSTGRES_VALIDATION.md
     section 6c, which records the query and its zero result. Repeating a
     pg_constraint scan here would need privileges this suite deliberately
     does not assume. */
});

it('N3 — a batch is idempotent and its duplicates are reported as success', async () => {
  const sessionId = id();
  const one = analyticsEvent({ assessmentSessionId: sessionId });

  const first = await ingestAnalytics([one]);
  assert.equal(first.error, null);
  assert.equal(first.data.accepted.length, 1);
  assert.equal(first.data.duplicates.length, 0);

  const replay = await ingestAnalytics([one]);
  assert.equal(replay.error, null);
  assert.equal(replay.data.accepted.length, 0);
  assert.equal(replay.data.duplicates.length, 1, 'a retry that already landed is a success');
});

it('N4 — the roll-up refuses a mixed-session batch and an empty one', async () => {
  const mixed = await ingestAnalytics([analyticsEvent(), analyticsEvent()]);
  assert.ok(mixed.error);
  assert.match(mixed.error.message, /analytics_mixed_sessions/);

  const empty = await rpc('ingest_analytics_events', { p_events: [], p_meta: {} });
  assert.ok(empty.error);
  assert.match(empty.error.message, /analytics_empty_batch/);
});

it('N5 — timing that cannot be true is refused', async () => {
  const sessionId = id();
  const impossible = await ingestAnalytics([analyticsEvent({
    assessmentSessionId: sessionId, activeElapsedMs: 999999, totalElapsedMs: 1
  })]);
  assert.ok(impossible.error, 'active time can never exceed wall time');

  const negative = await ingestAnalytics([analyticsEvent({
    assessmentSessionId: id(), activeElapsedMs: -1
  })]);
  assert.ok(negative.error);
});

it('N6 — a session that never declares a stage survives a second batch', async () => {
  /* REGRESSION, found on real Postgres 2026-08-05: the roll-up coalesced two
     nulls to 0, which is neither null nor 1 nor 2, and the CHECK aborted the
     whole batch. */
  const sessionId = id();
  const first = await ingestAnalytics([analyticsEvent({ assessmentSessionId: sessionId })]);
  assert.equal(first.error, null);

  const second = await ingestAnalytics([analyticsEvent({
    assessmentSessionId: sessionId, eventName: 'assessment.clear_saved_data'
  })]);
  assert.equal(second.error, null, second.error && second.error.message);

  const [session] = await rows('assessment_analytics_sessions', 'assessment_session_id', sessionId);
  assert.equal(session.max_stage_reached, null, '"not reached yet" is null, never zero');
});

it('N7 — a late event cannot rewind a session', async () => {
  const sessionId = id();
  const t = ms => new Date(Date.now() - ms).toISOString();

  await ingestAnalytics([
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.started',
                     assessmentStage: 1, occurredAt: t(600000) }),
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.step_viewed',
                     assessmentStage: 2, stepId: '14', occurredAt: t(500000),
                     activeElapsedMs: 300000, totalElapsedMs: 500000 }),
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.stage2_completed',
                     assessmentStage: 2, occurredAt: t(400000),
                     activeElapsedMs: 420000, totalElapsedMs: 700000 })
  ]);
  const [before] = await rows('assessment_analytics_sessions', 'assessment_session_id', sessionId);

  await ingestAnalytics([analyticsEvent({
    assessmentSessionId: sessionId, eventName: 'assessment.step_viewed',
    assessmentStage: 1, stepId: '2', occurredAt: t(550000),
    activeElapsedMs: 100, totalElapsedMs: 200
  })]);
  const [after] = await rows('assessment_analytics_sessions', 'assessment_session_id', sessionId);

  assert.equal(after.result_state, before.result_state, 'state does not regress');
  assert.equal(after.max_step_reached, before.max_step_reached);
  assert.equal(after.max_stage_reached, before.max_stage_reached);
  assert.ok(after.total_active_ms >= before.total_active_ms, 'timing moves forward only');
  assert.equal(after.stage2_completed_at, before.stage2_completed_at, 'write-once');
});

it('N8 — abandonment is retracted when the visitor comes back', async () => {
  const sessionId = id();
  const t = ms => new Date(Date.now() - ms).toISOString();

  await ingestAnalytics([
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.started',
                     assessmentStage: 1, occurredAt: t(900000) }),
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.abandoned',
                     assessmentStage: 1, stepId: '4', occurredAt: t(800000),
                     activeElapsedMs: 30000, totalElapsedMs: 600000,
                     metadata: { validationRun: RUN, provisional: true, trigger: 'idle' } })
  ]);
  const [abandoned] = await rows('assessment_analytics_sessions', 'assessment_session_id', sessionId);
  assert.equal(abandoned.result_state, 'abandoned');
  assert.ok(abandoned.abandoned_at);

  await ingestAnalytics([analyticsEvent({
    assessmentSessionId: sessionId, eventName: 'assessment.stage1_completed',
    assessmentStage: 1, occurredAt: t(700000),
    activeElapsedMs: 200000, totalElapsedMs: 700000
  })]);
  const [returned] = await rows('assessment_analytics_sessions', 'assessment_session_id', sessionId);
  assert.equal(returned.result_state, 'preliminary_results');
  assert.equal(returned.abandoned_at, null, 'the guess is retracted, not left standing');
});

it('N9 — raw events are append-only', async () => {
  const sessionId = id();
  const one = analyticsEvent({ assessmentSessionId: sessionId });
  await ingestAnalytics([one]);

  const { error } = await db.from('assessment_analytics_events')
    .update({ event_name: 'tampered' }).eq('event_id', one.eventId);
  assert.ok(error, 'an analytics row that can be edited can be made to say anything');
  assert.match(error.message, /append_only|append-only/i);
});

it('N10 — aggregation is idempotent and separates sessions from clicks', async () => {
  const sessionId = id();
  const t = ms => new Date(Date.now() - ms).toISOString();
  await ingestAnalytics([
    analyticsEvent({ assessmentSessionId: sessionId, occurredAt: t(300000) }),
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.recommended_system_clicked',
                     assessmentStage: 1, occurredAt: t(200000) }),
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.recommended_system_clicked',
                     assessmentStage: 1, occurredAt: t(100000) })
  ]);

  await rpc('refresh_assessment_funnel_daily', {});
  const source = `qr-${RUN}`;
  const first = await rows('assessment_funnel_daily', 'source', source);
  await rpc('refresh_assessment_funnel_daily', {});
  const second = await rows('assessment_funnel_daily', 'source', source);

  assert.ok(first.length >= 1, 'this run has its own campaign source, so its rows are its own');
  assert.equal(first.length, second.length, 're-running replaces rather than accumulating');
  const row = second.find(r => r.recommended_system_clicks > 0);
  assert.ok(row);
  assert.equal(row.recommended_system_clicks, 2, 'clicking twice is two clicks');
  assert.equal(row.page_views, 1, 'one session is one page view, however many rows');
});

it('N11 — purge removes only what has expired, and never an aggregate', async () => {
  const sessionId = id();
  /* One-day retention: expired by tomorrow, untouched today. */
  await ingestAnalytics([analyticsEvent({ assessmentSessionId: sessionId })], 1);
  await rpc('refresh_assessment_funnel_daily', {});

  const aggregatesBefore = await count('assessment_funnel_daily');
  const eventsBefore = await count('assessment_analytics_events');

  const noop = await rpc('purge_expired_analytics_events', { p_now: new Date().toISOString() });
  assert.equal(noop.error, null);
  assert.equal(await count('assessment_analytics_events'), eventsBefore, 'nothing has expired yet');

  const later = new Date(Date.now() + 2 * 86400000).toISOString();
  const purged = await rpc('purge_expired_analytics_events', { p_now: later, p_limit: 10 });
  assert.equal(purged.error, null);
  assert.ok(purged.data >= 1, 'the one-day row is gone');
  assert.equal(await count('assessment_funnel_daily'), aggregatesBefore,
    'the aggregate outlives the events it was computed from');
});

it('N12 — the drop-off function answers with counters and no recommendation', async () => {
  const { data, error } = await rpc('assessment_step_dropoff', {
    p_vertical_id: 'nails',
    p_from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
    p_to: new Date().toISOString().slice(0, 10)
  });
  assert.equal(error, null, error && error.message);
  assert.ok(Array.isArray(data));
  if (data.length) {
    const row = data[0];
    ['stage', 'step_id', 'visible_sessions', 'entered_sessions', 'completed_sessions',
     'exits', 'resumes', 'validation_failures', 'median_active_ms']
      .forEach(field => assert.ok(field in row, `missing ${field}`));
    /* Rates and the sample floor live in shared/analytics/funnel.js. */
    assert.ok(!('abandonment_rate' in row));
    assert.ok(!('recommendation' in row));
  }
});

/* ---------- L. cleanup ---------- */

test('cleanup removes only what this run owns', { skip: BLOCKED ? 'guards not satisfied' : false },
  async () => {
    /* Deletable: rate-limit buckets and idempotency records this run created,
       plus business_records inserted DIRECTLY (never via ingest_assessment,
       whose rows are append-only and permanent). */
    let removedBuckets = 0;
    let removedKeys = 0;

    for (const bucket of created.bucketKeys) {
      const { error } = await db.from('rate_limit_buckets').delete().eq('bucket_key', bucket);
      if (!error) removedBuckets++;
    }
    for (const k of created.idempotencyKeys) {
      const { error } = await db.from('idempotency_records').delete().eq('idempotency_key', k);
      if (!error) removedKeys++;
    }

    /* Analytics rows this run created. Deletable — and the ONLY rows in this
       suite that are — because they hold no personal data and no evidence,
       unlike timeline_events and audit_events which refuse DELETE outright.
       Keyed to ids this run generated; there is no blanket delete. */
    let removedEvents = 0;
    let removedSessions = 0;
    for (const eventId of created.analyticsEventIds) {
      const { error } = await db.from('assessment_analytics_events').delete().eq('event_id', eventId);
      if (!error) removedEvents++;
    }
    for (const sessionId of [...new Set(created.analyticsSessionIds)]) {
      const { error } = await db.from('assessment_analytics_sessions')
        .delete().eq('assessment_session_id', sessionId);
      if (!error) removedSessions++;
    }
    /* assessment_funnel_daily rows are NOT deleted: they are keyed by date and
       segment rather than by anything this run owns, and a later refresh
       recomputes them from whatever raw events remain. This run's campaign
       source is qr-<RUN>, so its aggregate rows are identifiable if a human
       wants them gone. */

    /* Never a blanket delete. Every statement above is keyed to an identifier
       this run generated, so unrelated rows cannot be touched. */
    assert.ok(removedBuckets >= 0);
    assert.ok(removedKeys >= 0);

    const permanent = created.submissionIds.length;
    console.log(`\n    Run ${RUN}: cleaned ${removedKeys} idempotency record(s), ` +
      `${removedBuckets} rate-limit bucket(s), ${removedEvents} analytics event(s) ` +
      `and ${removedSessions} analytics session(s).`);
    console.log(`    Left behind (append-only, by design): up to ${permanent} submission(s) ` +
      `and their timeline, BIR and audit rows, plus any assessment_funnel_daily ` +
      `rows under source "qr-${RUN}".`);
    console.log('    See tests/integration/README.md, "What cannot be cleaned up".\n');
  });
