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

/* ---------- local mode ----------

   A disposable PostgreSQL created inside this process, with no host, no port,
   no socket, and no credential. See tests/helpers/local-pg.mjs.

   It is a SEPARATE mode, not a relaxation: when it is on, the hosted path is
   not taken at all, and every guard below still applies to the hosted path
   when it is off. A shell that sets both is refused, because a run that could
   go either way is a run nobody can reason about afterwards.

   What local mode does NOT prove is PostgREST: it speaks SQL directly. The
   hosted guards exist to protect a real project and are untouched. */
const LOCAL = env.CED_LOCAL_PG === 'true';

if (LOCAL && (env.SUPABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY)) {
  failures.push(
    'CED_LOCAL_PG is "true" but hosted credentials are also present — refusing to run ' +
    'a suite that could reach either. Unset SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
}

/* 1. Explicit, unambiguous opt-in. Not a truthy string; the exact word. */
if (env.CED_ALLOW_INTEGRATION_TESTS !== 'true') {
  failures.push('CED_ALLOW_INTEGRATION_TESTS must be exactly "true" to run against a real database');
}

/* 2. Never in production, by any signal. Applies to both modes. */
if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
  failures.push('NODE_ENV is "production" — this suite never runs against production');
}

/* Guards 3 to 5 protect a HOSTED project. In local mode there is no project,
   no URL and no credential, so they have nothing to protect and are not run —
   which is why local mode refuses to start when credentials are present. */
const url = LOCAL ? null : need('SUPABASE_URL', 'the target database URL is required');
const key = LOCAL ? null : need('SUPABASE_SERVICE_ROLE_KEY', 'server-only credentials are required');

/* 3. The caller must name the project ref they intend, and it must match the
      URL. This is the guard that stops a stale SUPABASE_URL in a shell from
      quietly pointing the suite somewhere unintended. */
const declaredRef = LOCAL
  ? null
  : need('CED_TEST_PROJECT_REF', 'name the development project you intend to write to');

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
if (!LOCAL && declaredRef &&
    !/dev|test|staging|scratch|sandbox/i.test(`${declaredRef} ${env.CED_TEST_PROJECT_LABEL || ''}`)) {
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
let localEnv = null;
if (!BLOCKED && LOCAL) {
  const { startLocalPg, disposableDataDir } = await import('../helpers/local-pg.mjs');
  localEnv = await startLocalPg({ dataDir: disposableDataDir('suite') });
  db = localEnv.db;
  console.log(`\n    Local PostgreSQL: ${localEnv.version.split(' on ')[0]}`);
  console.log(`    Migrations applied: ${localEnv.applied.map(a => a.file.slice(0, 4)).join(' → ')}\n`);
} else if (!BLOCKED) {
  const { createClient } = await import('@supabase/supabase-js');
  db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/* Local mode holds the whole database in this process. Node keeps the worker
   alive while it exists, so it is closed when the file's tests are done. */
if (localEnv) {
  test.after(async () => { await localEnv.close(); });
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

  /* FOUND BY THE FIRST RUN OF THIS SUITE, 2026-08-05. This test and section
     E's clock-skew test both used `it-<RUN>-skew` with DIFFERENT request
     hashes, so whichever ran second was correctly refused with
     idempotency_key_conflict. The key is the bug, not the behaviour: two
     different bodies under one key is exactly what that error is for. */
  const { data, error } = await stagedIngest({
    key: `it-${RUN}-stage2-skew`, hash: `h-${RUN}-stage2-skew`, payload: p,
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

  /* FOUND BY THE FIRST RUN OF THIS SUITE, 2026-08-05. Every other test in
     section N emits under the shared campaign source `qr-<RUN>`, so they all
     aggregate onto ONE row — and "one session is one page view" was then
     counting the whole section rather than this test. The assertion is right;
     it needed a group of its own to be about. */
  const source = `qr-${RUN}-n10`;
  const touch = {
    firstTouch: { path: '/', referrerHost: 'qr.example', utm: { utm_source: source } },
    latestTouch: { path: '/', utm: {} }
  };

  await ingestAnalytics([
    analyticsEvent({ assessmentSessionId: sessionId, occurredAt: t(300000), attribution: touch }),
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.recommended_system_clicked',
                     assessmentStage: 1, occurredAt: t(200000), attribution: touch }),
    analyticsEvent({ assessmentSessionId: sessionId, eventName: 'assessment.recommended_system_clicked',
                     assessmentStage: 1, occurredAt: t(100000), attribution: touch })
  ]);

  await rpc('refresh_assessment_funnel_daily', {});
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

/* ============================================================
   O. Migration 0006 — review types and the Service Mix review
   ------------------------------------------------------------
   EXECUTION STATUS, stated here because this comment is what a
   reader of these tests will believe:

     · EXECUTED against a disposable local PostgreSQL 18.3
       through PGlite 0.5.4, by `CED_LOCAL_PG=true`. Every test
       in this section passes there.
     · NOT executed against PostgreSQL 17. The hosted
       development project is 17.6.1.155, and a behaviour that
       differs between the two majors would not be caught here.
     · NOT executed against hosted Supabase.
     · NOT executed through PostgREST, so signature resolution
       by argument name over HTTP remains unproven.

   An earlier revision of this comment said the SQL had never
   run against any Postgres. That stopped being true when the
   local harness was added, and a stale claim in a test file is
   worse than none: it is read as current.

   The compensating control for the ingest_assessment ->
   ingest_review transcription is exactly this section. It must
   pass before 0006 is applied anywhere.
   ============================================================ */

/* A Service Mix report, structurally faithful to what the engine produces —
   only the fields ingest_review and the 0006 triggers actually read. */
const serviceMixBir = (health = 'generally_healthy') => ({
  schemaVersion: 5,
  reportType: 'service_mix',
  reportVersion: 1,
  identity: { businessId: null, identityStatus: 'resolution_pending', birId: null,
              legacyBusinessKey: null, reviewType: 'service_mix' },
  provenance: { generatedBy: 'service-mix-engine-v1.0.0', supersedes: null, isCurrent: true },
  businessProfile: { displayName: 'Polished Nail Studio' },
  dataConfidence: { confidence: 0.93, completeness: 1 },
  serviceMixHealth: { classification: health, classifierVersion: 'service-mix-health-v1' },
  portfolioCoverage: { declared: 'all_offerings', offeringsEntered: 3, offeringsAnalysed: 3 },
  measurementGaps: [],
  relatedGrowthReview: null
});

const serviceMixPayload = ({ submissionId, sessionId, offerings = 3,
                             coverage = 'all_offerings',
                             submittedAt = new Date().toISOString() }) => ({
  schemaVersion: 6,
  reviewType: 'service_mix',
  assessmentVersion: '1.0.0',
  submissionId,
  assessmentSessionId: sessionId,
  vertical: { id: 'nails', name: 'Nail Salons' },
  submittedAt,
  contact: { salonName: 'Polished Nail Studio', ownerName: 'Test Owner', email: email('mix') },
  consent: { resultsDeliveryConsent: { granted: true, statement: 'Send me my Service Mix results...' } },
  attribution: { firstTouch: { url: 'https://nails.cedservice.com/service-mix' } },
  serviceMix: {
    coverage,
    offerings: Array.from({ length: offerings }, (_, i) => ({
      offeringId: id(), offeringSnapshotId: id(), replacesOfferingId: null,
      name: `Offering ${i}`, category: 'core_service', source: 'starter',
      sellingPrice: { kind: 'exact', value: 60 + i, low: null, high: null },
      durationMinutes: { kind: 'exact', value: 60, low: null, high: null },
      monthlyVolume: { kind: 'exact', value: 40, low: null, high: null },
      demand: 'steady', role: 'primary_revenue'
    }))
  },
  results: { disclaimer: 'This is a diagnostic analysis based on the information provided...' }
});

const ingestMix = async ({ submissionId, sessionId, birId, continuationBusinessId = null,
                           payloadOverrides = {} }) => {
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);
  return rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: { ...serviceMixPayload({ submissionId, sessionId }), ...payloadOverrides },
    p_signals: [],
    p_bir: serviceMixBir(),
    p_bir_id: birId,
    p_retention_days: 30,
    p_meta: { correlationId: `mix-${RUN}`, reviewType: 'service_mix' },
    p_review_type: 'service_mix',
    p_continuation_business_id: continuationBusinessId
  });
};

it('O1 — ingest_review resolves under its 10-argument signature', async () => {
  const { data, error } = await rpc('ingest_review', {
    p_idempotency_key: '', p_request_hash: 'x', p_payload: {}, p_signals: [],
    p_bir: {}, p_bir_id: id(), p_retention_days: 30, p_meta: {},
    p_review_type: 'service_mix', p_continuation_business_id: null
  });
  assert.equal(data, null);
  assert.ok(error, 'an empty idempotency key must raise');
  assert.match(error.message, /missing_idempotency_key/);
});

it('O2 — ingest_assessment is still resolvable and still means growth_review', async () => {
  const submissionId = id();
  const sessionId = id();
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);

  const { data, error } = await rpc('ingest_assessment', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: payload({ submissionId, sessionId }),
    p_signals: [], p_bir: bir(), p_bir_id: id(), p_retention_days: 30,
    p_meta: { correlationId: `wrap-${RUN}` }
  });
  assert.equal(error, null);
  assert.equal(data.reviewType, 'growth_review',
    'the wrapper must not change what an existing caller gets');

  const [row] = await rows('assessment_submissions', 'submission_id', submissionId);
  assert.equal(row.review_type, 'growth_review');
});

it('O3 — an invented review type is refused by the function', async () => {
  const submissionId = id();
  const { error } = await rpc('ingest_review', {
    p_idempotency_key: submissionId, p_request_hash: 'x',
    p_payload: serviceMixPayload({ submissionId, sessionId: id() }),
    p_signals: [], p_bir: serviceMixBir(), p_bir_id: id(), p_retention_days: 30,
    p_meta: {}, p_review_type: 'vibes_review', p_continuation_business_id: null
  });
  assert.ok(error);
  assert.match(error.message, /unsupported_review_type/);
});

it('O4 — a Service Mix submission stores a v5 report and its own timeline events', async () => {
  const submissionId = id();
  const birId = id();
  const { data, error } = await ingestMix({ submissionId, sessionId: id(), birId });
  assert.equal(error, null);
  assert.equal(data.reviewType, 'service_mix');
  created.businessIds.push(data.businessId);

  const [report] = await rows('business_intelligence_reports', 'bir_id', birId);
  assert.equal(report.schema_version, 5);
  assert.equal(report.review_type, 'service_mix');
  assert.equal(report.confidence_band, 'high', 'a 0.93 confidence bands as high');

  const events = await rows('timeline_events', 'correlation_id', submissionId);
  const names = events.map(e => e.event_name);
  assert.ok(names.includes('service_mix.completed'));
  assert.ok(names.includes('service_mix_bir.generated'));
  /* The generic events are ADDITIONAL facts, never replaced. */
  assert.ok(names.includes('assessment.completed'));
  assert.ok(names.includes('bir.generated'));

  const completed = events.find(e => e.event_name === 'service_mix.completed');
  assert.equal(completed.payload.offeringCount, 3);
  assert.equal(completed.payload.coverage, 'all_offerings');
  /* No offering name, no price, no revenue reaches an append-only table. */
  const text = JSON.stringify(completed.payload);
  assert.equal(/Offering \d/.test(text), false);
  assert.equal(/sellingPrice|monthlyRevenue/.test(text), false);
});

it('O5 — a v5 report may not claim to be a Growth Review, and vice versa', async () => {
  const submissionId = id();
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);

  const { error } = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: payload({ submissionId, sessionId: id() }),
    p_signals: [], p_bir: serviceMixBir(), p_bir_id: id(), p_retention_days: 30,
    p_meta: {}, p_review_type: 'growth_review', p_continuation_business_id: null
  });
  assert.ok(error, 'bir_service_mix_version_check must refuse a v5 growth report');
  assert.match(error.message, /bir_service_mix_version_check|violates check constraint/);
});

it('O6 — Growth and Service Mix stay independently current for one business', async () => {
  /* Connected by the SERVER-ISSUED continuation businessId, not by a shared
     session: reusing one session under a second review type is refused
     outright, because it would attribute a Service Mix submission to a
     Growth session's funnel and to its first-touch attribution. */
  const growthSubmission = id();
  const growthBir = id();
  created.submissionIds.push(growthSubmission);
  created.idempotencyKeys.push(growthSubmission);

  const growth = await rpc('ingest_assessment', {
    p_idempotency_key: growthSubmission,
    p_request_hash: createHash('sha256').update(growthSubmission).digest('hex'),
    p_payload: payload({ submissionId: growthSubmission, sessionId: id() }),
    p_signals: [], p_bir: bir(), p_bir_id: growthBir, p_retention_days: 30, p_meta: {}
  });
  assert.equal(growth.error, null);
  const businessId = growth.data.businessId;
  created.businessIds.push(businessId);

  const mixSubmission = id();
  const mixBir = id();
  const mix = await ingestMix({
    submissionId: mixSubmission, sessionId: id(), birId: mixBir,
    continuationBusinessId: businessId
  });
  assert.equal(mix.error, null);
  assert.equal(mix.data.businessId, businessId, 'one business, two reviews');
  assert.equal(mix.data.linkMethod, 'continuation_context');

  const states = await rows('business_review_states', 'business_id', businessId);
  assert.equal(states.length, 2);
  const growthState = states.find(s => s.review_type === 'growth_review');
  const mixState = states.find(s => s.review_type === 'service_mix');
  assert.equal(growthState.current_bir_id, growthBir);
  assert.equal(mixState.current_bir_id, mixBir);

  /* The approved fields, present and meaningful. */
  assert.equal(mixState.original_submission_id, mixSubmission);
  assert.equal(mixState.latest_submission_id, mixSubmission);
  assert.equal(mixState.next_reassessment_kind, 'quick_recheck');
  assert.ok(mixState.next_reassessment_due_at);

  const [record] = await rows('business_records', 'business_id', businessId);
  assert.equal(record.current_bir_id, growthBir,
    'the legacy pointer keeps meaning "the current GROWTH report"');

  /* And the stored Service Mix report names the Growth report it continues
     from — a reference, never a copy. */
  const [mixReport] = await rows('business_intelligence_reports', 'bir_id', mixBir);
  const related = mixReport.report.relatedGrowthReview;
  assert.ok(related, 'a connected review must name the Growth report');
  assert.equal(related.birId, growthBir);
  assert.equal(related.freshness, 'fresh');
  assert.equal(related.usedInCalculations, false);
  /* Exactly the five approved fields. */
  assert.deepEqual(Object.keys(related).sort(),
    ['birId', 'freshness', 'generatedAt', 'prefilledFields', 'usedInCalculations']);
  assert.equal(/growthScore|closeReadiness|financialOpportunity/.test(JSON.stringify(mixReport.report)),
    false, 'no Growth analysis crosses over');
});

it('O6b — real Postgres filters prefilledFields against the approved enum', async () => {
  /* prefilledFields names FIELDS, never values. The endpoint refuses an
     unapproved entry, and ingest_review — which a future server-to-server
     caller can reach without passing through the endpoint — filters again.
     Called directly here, exactly as such a caller would. */
  const growthSubmission = id();
  const growthBir = id();
  created.submissionIds.push(growthSubmission);
  created.idempotencyKeys.push(growthSubmission);

  const growth = await rpc('ingest_assessment', {
    p_idempotency_key: growthSubmission,
    p_request_hash: createHash('sha256').update(growthSubmission).digest('hex'),
    p_payload: payload({ submissionId: growthSubmission, sessionId: id() }),
    p_signals: [], p_bir: bir(), p_bir_id: growthBir, p_retention_days: 30, p_meta: {}
  });
  assert.equal(growth.error, null);
  created.businessIds.push(growth.data.businessId);

  const mixSubmission = id();
  const mixBir = id();
  const base = serviceMixPayload({ submissionId: mixSubmission, sessionId: id() });
  const mix = await ingestMix({
    submissionId: mixSubmission, sessionId: id(), birId: mixBir,
    continuationBusinessId: growth.data.businessId,
    payloadOverrides: {
      serviceMix: {
        ...base.serviceMix,
        prefilledFields: [
          'owner@example.com', 'Gel manicure', 'email', 'email',
          'She will buy in September.', 'salonName'
        ]
      }
    }
  });
  assert.equal(mix.error, null, 'the review still completes; the list is filtered, not fatal');

  const [mixReport] = await rows('business_intelligence_reports', 'bir_id', mixBir);
  const related = mixReport.report.relatedGrowthReview;
  assert.deepEqual(related.prefilledFields, ['salonName', 'email'],
    'kept in enum order, de-duplicated, with every unapproved entry gone');

  const text = JSON.stringify(mixReport.report);
  ['owner@example.com', 'Gel manicure', 'September'].forEach(value =>
    assert.equal(text.includes(value), false,
      'nothing unapproved reaches the append-only report'));
});

it('O7 — a Service Mix report never enters the Growth supersession chain', async () => {
  const growthSubmission = id();
  const growthBir = id();
  created.submissionIds.push(growthSubmission);
  created.idempotencyKeys.push(growthSubmission);

  const growth = await rpc('ingest_assessment', {
    p_idempotency_key: growthSubmission,
    p_request_hash: createHash('sha256').update(growthSubmission).digest('hex'),
    p_payload: payload({ submissionId: growthSubmission, sessionId: id() }),
    p_signals: [], p_bir: bir(), p_bir_id: growthBir, p_retention_days: 30, p_meta: {}
  });
  const businessId = growth.data.businessId;
  created.businessIds.push(businessId);

  const mixBir = id();
  await ingestMix({ submissionId: id(), sessionId: id(), birId: mixBir,
                    continuationBusinessId: businessId });
  const [mixReport] = await rows('business_intelligence_reports', 'bir_id', mixBir);
  assert.equal(mixReport.supersedes_bir_id, null,
    'the first report of a review type supersedes nothing');

  /* And a second Service Mix review chains to the first, not to Growth. */
  const secondMixBir = id();
  await ingestMix({ submissionId: id(), sessionId: id(), birId: secondMixBir,
                    continuationBusinessId: businessId });
  const [second] = await rows('business_intelligence_reports', 'bir_id', secondMixBir);
  assert.equal(second.supersedes_bir_id, mixBir);

  /* Exactly one root per review type — the property the advisory lock in
     ingest_review exists to guarantee. */
  const mixReports = (await rows('business_intelligence_reports', 'business_id', businessId))
    .filter(r => r.review_type === 'service_mix');
  assert.equal(mixReports.filter(r => r.supersedes_bir_id === null).length, 1);
});

it('O7b — a session may not be reused under a second review type', async () => {
  const sessionId = id();
  const growthSubmission = id();
  created.submissionIds.push(growthSubmission);
  created.idempotencyKeys.push(growthSubmission);

  const growth = await rpc('ingest_assessment', {
    p_idempotency_key: growthSubmission,
    p_request_hash: createHash('sha256').update(growthSubmission).digest('hex'),
    p_payload: payload({ submissionId: growthSubmission, sessionId }),
    p_signals: [], p_bir: bir(), p_bir_id: id(), p_retention_days: 30, p_meta: {}
  });
  created.businessIds.push(growth.data.businessId);

  const conflicting = id();
  created.idempotencyKeys.push(conflicting);
  const { error } = await ingestMix({ submissionId: conflicting, sessionId, birId: id() });

  assert.ok(error, 'a Growth session may not carry a Service Mix submission');
  assert.match(error.message, /session_review_type_conflict/);

  const stored = await rows('assessment_submissions', 'submission_id', conflicting);
  assert.deepEqual(stored, [], 'and nothing is stored');
});

it('O8 — the supersession guard refuses a cross-review-type chain outright', async () => {
  /* Written directly, not through ingestion: the point is that the DATABASE
     refuses it even when a caller tries. */
  const sessionId = id();
  const growthSubmission = id();
  const growthBir = id();
  created.submissionIds.push(growthSubmission);
  created.idempotencyKeys.push(growthSubmission);

  const growth = await rpc('ingest_assessment', {
    p_idempotency_key: growthSubmission,
    p_request_hash: createHash('sha256').update(growthSubmission).digest('hex'),
    p_payload: payload({ submissionId: growthSubmission, sessionId }),
    p_signals: [], p_bir: bir(), p_bir_id: growthBir, p_retention_days: 30, p_meta: {}
  });
  const businessId = growth.data.businessId;
  created.businessIds.push(businessId);

  const { error } = await db.from('business_intelligence_reports').insert({
    bir_id: id(), business_id: businessId,
    assessment_submission_id: growthSubmission,
    schema_version: 5, review_type: 'service_mix',
    report: serviceMixBir(), confidence_band: 'high',
    supersedes_bir_id: growthBir
  });
  assert.ok(error, 'a Service Mix report may never supersede a Growth report');
  assert.match(error.message, /supersedes_review_type_mismatch|bir_one_per_submission/);
});

it('O9 — the legacy current_bir_id refuses a non-Growth report', async () => {
  const mixBir = id();
  const mix = await ingestMix({ submissionId: id(), sessionId: id(), birId: mixBir });
  const businessId = mix.data.businessId;
  created.businessIds.push(businessId);

  const { error } = await db.from('business_records')
    .update({ current_bir_id: mixBir }).eq('business_id', businessId);
  assert.ok(error, 'business_records.current_bir_id is the Growth pointer');
  assert.match(error.message, /current_bir_must_be_growth/);
});

it('O10 — a server-issued continuation businessId links across device sessions', async () => {
  const growthSubmission = id();
  created.submissionIds.push(growthSubmission);
  created.idempotencyKeys.push(growthSubmission);
  const growth = await rpc('ingest_assessment', {
    p_idempotency_key: growthSubmission,
    p_request_hash: createHash('sha256').update(growthSubmission).digest('hex'),
    p_payload: payload({ submissionId: growthSubmission, sessionId: id() }),
    p_signals: [], p_bir: bir(), p_bir_id: id(), p_retention_days: 30, p_meta: {}
  });
  const businessId = growth.data.businessId;
  created.businessIds.push(businessId);

  /* A different session id — nothing but the continuation connects them. */
  const { data, error } = await ingestMix({
    submissionId: id(), sessionId: id(), birId: id(),
    continuationBusinessId: businessId
  });
  assert.equal(error, null);
  assert.equal(data.businessId, businessId);
  assert.equal(data.linkMethod, 'continuation_context');
});

it('O11 — a continuation pointing at a merged-away record does not link', async () => {
  const survivorSubmission = id();
  created.submissionIds.push(survivorSubmission);
  created.idempotencyKeys.push(survivorSubmission);
  const survivor = await rpc('ingest_assessment', {
    p_idempotency_key: survivorSubmission,
    p_request_hash: createHash('sha256').update(survivorSubmission).digest('hex'),
    p_payload: payload({ submissionId: survivorSubmission, sessionId: id() }),
    p_signals: [], p_bir: bir(), p_bir_id: id(), p_retention_days: 30, p_meta: {}
  });
  const survivorId = survivor.data.businessId;
  created.businessIds.push(survivorId);

  const goneSubmission = id();
  created.submissionIds.push(goneSubmission);
  created.idempotencyKeys.push(goneSubmission);
  const gone = await rpc('ingest_assessment', {
    p_idempotency_key: goneSubmission,
    p_request_hash: createHash('sha256').update(goneSubmission).digest('hex'),
    p_payload: payload({ submissionId: goneSubmission, sessionId: id(),
                         contactEmail: email('gone') }),
    p_signals: [], p_bir: bir(), p_bir_id: id(), p_retention_days: 30, p_meta: {}
  });
  const goneId = gone.data.businessId;
  created.businessIds.push(goneId);

  await db.from('business_records')
    .update({ merged_into_business_id: survivorId }).eq('business_id', goneId);

  const { data } = await ingestMix({
    submissionId: id(), sessionId: id(), birId: id(),
    continuationBusinessId: goneId
  });
  assert.notEqual(data.businessId, goneId,
    'a record merged away since the token was issued must not be linked to');
});

it('O12 — replaying a Service Mix submission creates nothing', async () => {
  const submissionId = id();
  const birId = id();
  const first = await ingestMix({ submissionId, sessionId: id(), birId });
  assert.equal(first.error, null);
  assert.equal(first.data.replayed, false);
  created.businessIds.push(first.data.businessId);

  const second = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: serviceMixPayload({ submissionId, sessionId: first.data.assessmentSessionId }),
    p_signals: [], p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
    p_meta: {}, p_review_type: 'service_mix', p_continuation_business_id: null
  });
  assert.equal(second.error, null);
  assert.equal(second.data.replayed, true);

  const states = await rows('business_review_states', 'business_id', first.data.businessId);
  assert.equal(states.find(s => s.review_type === 'service_mix').completed_count, 1,
    'a replay must not increment the completion count');
});

it('O13 — analytics rows and aggregates carry review_type', async () => {
  const sessionId = id();
  const eventId = id();
  created.analyticsEventIds.push(eventId);
  created.analyticsSessionIds.push(sessionId);

  const { error } = await rpc('ingest_analytics_events', {
    p_events: [{
      eventId, eventName: 'service_mix.review_viewed', eventVersion: 1, schemaVersion: 2,
      assessmentSessionId: sessionId, verticalId: 'nails',
      /* Deliberately mislabelled: the event NAME must win. */
      reviewType: 'growth_review',
      occurredAt: new Date().toISOString(),
      activeElapsedMs: 0, totalElapsedMs: 0,
      attribution: { firstTouch: { utm: { utm_source: `qr-${RUN}` } } },
      device: { deviceClass: 'phone' }, metadata: {}
    }],
    p_meta: { correlationId: `mixa-${RUN}` }, p_retention_days: 400
  });
  assert.equal(error, null);

  const [row] = await rows('assessment_analytics_events', 'event_id', eventId);
  assert.equal(row.review_type, 'service_mix',
    'a service_mix.* event can never be filed under the Growth funnel');

  const [session] = await rows('assessment_analytics_sessions', 'assessment_session_id', sessionId);
  assert.equal(session.review_type, 'service_mix');
});

it('O14 — the daily funnel separates the two review types', async () => {
  const { error } = await rpc('refresh_assessment_funnel_daily', {
    p_from: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    p_to: new Date().toISOString().slice(0, 10)
  });
  assert.equal(error, null);

  const { data } = await db.from('assessment_funnel_daily')
    .select('*').eq('source', `qr-${RUN}`);
  const mixRows = (data || []).filter(r => r.review_type === 'service_mix');
  assert.ok(mixRows.length >= 1, 'the Service Mix events must land on their own aggregate row');
  mixRows.forEach(r => assert.ok(r.page_views >= 1,
    'service_mix.review_viewed counts as a page view for its own funnel'));
});

/* ============================================================
   P. Rule B0 — a proposal is not a decision
   ------------------------------------------------------------
   The same case table tests/continuation-conflict.test.mjs runs
   through the shared rule and the fake database, run here through
   the real ingest_review in real PostgreSQL. The SQL is a genuine
   second implementation of that rule, and this is what stops the
   two drifting.

   The defect: a valid Salon A context plus a Salon B identity
   stored Salon B's submission, report, email, domain and business
   name under Salon A — permanently, in tables that refuse UPDATE
   and refuse DELETE.
   ============================================================ */

/* Two salons with nothing whatsoever in common — and a FRESH pair per test.
   Reusing one pair across tests would make the second test's Growth Review
   match the first's identifiers, resolve as ambiguous, and return a null
   business id; every assertion after that would then pass by comparing null
   with null. Uniqueness per test is what keeps these tests from passing
   vacuously. */
const salonNames = tag => ({
  a: `polished nail studio ${tag} ${RUN}`,
  b: `riverside barber co ${tag} ${RUN}`,
  aEmail: email(`salon-a-${tag}`),
  bEmail: email(`salon-b-${tag}`)
});

/* A Growth Review that establishes a business, with the identifiers a real
   one would leave: a business name and an email. */
const establishBusiness = async (name, contactEmail) => {
  const submissionId = id();
  const birId = id();
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);

  const { data, error } = await rpc('ingest_assessment', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: payload({ submissionId, sessionId: id(), name, contactEmail }),
    p_signals: [signal('business_name', name), signal('email_exact', contactEmail),
                signal('vertical', 'nails')],
    p_bir: bir(name), p_bir_id: birId, p_retention_days: 30, p_meta: {}
  });
  assert.equal(error, null);
  assert.ok(data.businessId,
    'the Growth Review must actually create a record, or everything below ' +
    'compares null with null and proves nothing');
  created.businessIds.push(data.businessId);
  return { businessId: data.businessId, birId, submissionId };
};

const mixAs = async ({ name, contactEmail, continuationBusinessId }) => {
  const submissionId = id();
  const birId = id();
  const base = serviceMixPayload({ submissionId, sessionId: id() });
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);

  const { data, error } = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: { ...base, contact: { ...base.contact, salonName: name, email: contactEmail } },
    p_signals: [signal('business_name', name), signal('email_exact', contactEmail),
                signal('vertical', 'nails')],
    p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
    p_meta: { correlationId: `b1a-${RUN}` },
    p_review_type: 'service_mix',
    p_continuation_business_id: continuationBusinessId
  });
  return { data, error, submissionId, birId };
};

it("P1 — a consistent continuation still links, in real PostgreSQL", async () => {
  const s = salonNames("p1");
  const salonA = await establishBusiness(s.a, s.aEmail);
  const { data, error } = await mixAs({
    name: s.a, contactEmail: s.aEmail, continuationBusinessId: salonA.businessId
  });

  assert.equal(error, null);
  assert.equal(data.businessId, salonA.businessId, 'the feature must still work');
  assert.equal(data.linkMethod, 'continuation_context');
  assert.equal(data.continuationContradicted, false);
  assert.equal(data.identityStatus, 'linked');
});

it('P2 — a rebrand is not another business', async () => {
  const s = salonNames('p2');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const { data, error } = await mixAs({
    /* New name, same email. A name change alone is a rebrand. */
    name: `${s.a} and spa`, contactEmail: s.aEmail,
    continuationBusinessId: salonA.businessId
  });

  assert.equal(error, null);
  assert.equal(data.continuationContradicted, false);
  assert.equal(data.businessId, salonA.businessId);
});

it('P3 — a new email address alone is not another business', async () => {
  const s = salonNames('p3');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const { data, error } = await mixAs({
    name: s.a, contactEmail: email('salon-a-new-p3'),
    continuationBusinessId: salonA.businessId
  });

  assert.equal(error, null);
  assert.equal(data.continuationContradicted, false);
  assert.equal(data.businessId, salonA.businessId);
});

it('P4 — Salon A token plus Salon B identity does not link to Salon A', async () => {
  const s = salonNames('p4');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const { data, error, submissionId, birId } = await mixAs({
    name: s.b, contactEmail: s.bEmail,
    continuationBusinessId: salonA.businessId
  });

  assert.equal(error, null, 'the visitor still gets a result');
  assert.equal(data.continuationContradicted, true);
  assert.equal(data.businessId, null, 'not filed under Salon A');
  assert.equal(data.identityStatus, 'resolution_pending');
  assert.equal(data.linkMethod, null);
  assert.equal(data.nextAction, 'identity_review_pending');

  /* The submission and report exist, attached to nobody. */
  const [submission] = await rows('assessment_submissions', 'submission_id', submissionId);
  assert.equal(submission.business_id, null);
  assert.equal(submission.identity_status, 'resolution_pending');
  assert.equal(submission.ingest_meta.continuationApplied, false);
  assert.equal(submission.ingest_meta.continuationContradicted, true);

  const [report] = await rows('business_intelligence_reports', 'bir_id', birId);
  assert.equal(report.business_id, null);
  assert.equal(report.supersedes_bir_id, null);
  assert.equal(report.report.relatedGrowthReview, null,
    'a report that continues from nothing names nothing');
});

it('P5 — Salon B identifiers never reach Salon A', async () => {
  const s = salonNames('p5');
  const salonA = await establishBusiness(s.a, s.aEmail);
  await mixAs({
    name: s.b, contactEmail: s.bEmail,
    continuationBusinessId: salonA.businessId
  });

  const held = await rows('business_identifiers', 'business_id', salonA.businessId);
  const values = held.filter(i => i.valid_to === null).map(i => i.normalized_value);

  assert.equal(values.includes(s.b), false, 'business name');
  assert.equal(values.includes(s.bEmail), false, 'email');
  assert.ok(values.includes(s.a), 'and Salon A keeps what it had');
  assert.ok(values.includes(s.aEmail));

  /* Nowhere else either: no record anywhere holds Salon B's identifiers,
     because the veto refuses to create one on contradicted evidence. */
  const { data: anywhere } = await db.from('business_identifiers')
    .select('business_id, identifier_type, normalized_value')
    .eq('normalized_value', s.bEmail);
  assert.deepEqual(anywhere || [], []);
});

it('P6 — no Salon B report enters Salon A supersession chain', async () => {
  const s = salonNames('p6');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const { birId } = await mixAs({
    name: s.b, contactEmail: s.bEmail,
    continuationBusinessId: salonA.businessId
  });

  const aReports = await rows('business_intelligence_reports', 'business_id', salonA.businessId);
  assert.deepEqual(aReports.map(r => r.bir_id).sort(), [salonA.birId].sort(),
    "Salon A's chain holds exactly its own Growth report");
  assert.equal(aReports.some(r => r.bir_id === birId), false);

  const states = await rows('business_review_states', 'business_id', salonA.businessId);
  assert.deepEqual(states.map(s => s.review_type).sort(), ['growth_review'],
    'and Salon A gained no Service Mix review state');

  const [record] = await rows('business_records', 'business_id', salonA.businessId);
  assert.equal(record.current_bir_id, salonA.birId);
});

it('P7 — the mismatch opens a case that names types, never values', async () => {
  const s = salonNames('p7');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const { submissionId } = await mixAs({
    name: s.b, contactEmail: s.bEmail,
    continuationBusinessId: salonA.businessId
  });

  const cases = await rows('identity_resolution_cases', 'assessment_submission_id', submissionId);
  assert.equal(cases.length, 1);
  const [openCase] = cases;
  assert.equal(openCase.resolution_status, 'manual_review_required');
  assert.equal(openCase.recommended_action, 'queue_for_review');
  assert.equal(openCase.resolved_at, null);

  const contradiction = (openCase.conflicting_signals || [])
    .find(c => c.kind === 'continuation_context_contradicted');
  assert.ok(contradiction, 'the case must record that a signed context was set aside');
  assert.equal(contradiction.proposedBusinessId, salonA.businessId);
  assert.ok(contradiction.contradictedTypes.includes('business_name'));
  assert.ok(contradiction.contradictedTypes.includes('email_exact'));
  assert.deepEqual(contradiction.agreedTypes, []);

  const text = JSON.stringify(openCase);
  assert.equal(text.includes(s.bEmail), false, 'no identifier value in a review queue');
  assert.equal(text.includes(s.b), false);

  /* And a timeline event a human can find it by. */
  const { data: events } = await db.from('timeline_events')
    .select('event_name, payload, summary')
    .eq('correlation_id', submissionId);
  const review = (events || []).find(e => e.event_name === 'identity.review_required');
  assert.ok(review);
  assert.equal(review.payload.continuationContradicted, true);
  assert.equal(review.payload.sessionContradicted, false);
  assert.match(review.summary, /saved identity proposal was set aside/i);
});

it('P8 — a queued review sent with another business current context contaminates neither', async () => {
  /* Salon A's review was queued offline. Salon B then completed a review on
     the same device, so Salon B's token is what the browser now holds. The
     browser declines to send it; this proves what happens if it does. */
  const s = salonNames('p8');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const salonB = await establishBusiness(s.b, s.bEmail);

  const { data, error } = await mixAs({
    name: s.a, contactEmail: s.aEmail,
    continuationBusinessId: salonB.businessId
  });

  assert.equal(error, null);
  assert.equal(data.continuationContradicted, true);
  assert.notEqual(data.businessId, salonB.businessId, 'not filed under Salon B');
  assert.equal(data.businessId, null,
    'and not auto-filed under Salon A either — weak evidence never links by itself');

  /* Both records hold exactly what they held. */
  const bHeld = (await rows('business_identifiers', 'business_id', salonB.businessId))
    .filter(i => i.valid_to === null).map(i => i.normalized_value);
  assert.equal(bHeld.includes(s.aEmail), false);
  assert.equal(bHeld.includes(s.a), false);

  const aReports = await rows('business_intelligence_reports', 'business_id', salonA.businessId);
  assert.deepEqual(aReports.map(r => r.bir_id), [salonA.birId]);
  const bReports = await rows('business_intelligence_reports', 'business_id', salonB.businessId);
  assert.deepEqual(bReports.map(r => r.bir_id), [salonB.birId]);
});

it('P9 — a context naming a record that holds nothing comparable still links', async () => {
  /* A record with no identifiers cannot contradict anything, and a rule that
     vetoed on absent evidence would refuse every legitimate continuation from
     a record whose identifiers were redacted. */
  const businessId = id();
  created.businessIds.push(businessId);
  /* `business_record`, not the legacy `lead_assessed` this fixture used to
     carry. 0009 blocks NEW assignment of `lead_assessed` — it is ambiguous
     legacy data, kept valid only for the rows that already hold it. The
     lifecycle value was never this test's subject; a bare record with no
     identifiers is. */
  const { error: seedError } = await db.from('business_records').insert({
    business_id: businessId, schema_version: 1, identity_status: 'linked',
    display_name: `bare record ${RUN}`, vertical_id: 'nails', lifecycle_state: 'business_record'
  });
  assert.equal(seedError, null);

  const s = salonNames('p9');
  const { data, error } = await mixAs({
    name: s.b, contactEmail: s.bEmail, continuationBusinessId: businessId
  });

  assert.equal(error, null);
  assert.equal(data.continuationContradicted, false);
  assert.equal(data.businessId, businessId);
});


/* ---------- P10-P16. The same rule, through the SESSION ----------

   No continuation argument anywhere below: p_continuation_business_id is
   null. The session id alone used to be enough to attach one business's
   review to another's record. */

const mixInSession = async ({ name, contactEmail, sessionId, submissionId, birId }) => {
  const sid = submissionId || id();
  const bid = birId || id();
  const base = serviceMixPayload({ submissionId: sid, sessionId });
  created.submissionIds.push(sid);
  created.idempotencyKeys.push(sid);

  const { data, error } = await rpc('ingest_review', {
    p_idempotency_key: sid,
    p_request_hash: createHash('sha256').update(sid).digest('hex'),
    p_payload: { ...base, contact: { ...base.contact, salonName: name, email: contactEmail } },
    p_signals: [signal('business_name', name), signal('email_exact', contactEmail),
                signal('vertical', 'nails')],
    p_bir: serviceMixBir(), p_bir_id: bid, p_retention_days: 30,
    p_meta: { correlationId: `b0-${RUN}` },
    p_review_type: 'service_mix',
    p_continuation_business_id: null
  });
  return { data, error, submissionId: sid, birId: bid };
};

it('P10 — a second submission for the same business in one session still links and chains', async () => {
  const s = salonNames('p10');
  const sessionId = id();

  const first = await mixInSession({ name: s.a, contactEmail: s.aEmail, sessionId });
  assert.equal(first.error, null);
  assert.ok(first.data.businessId);
  created.businessIds.push(first.data.businessId);

  const second = await mixInSession({ name: s.a, contactEmail: s.aEmail, sessionId });
  assert.equal(second.error, null);
  assert.equal(second.data.businessId, first.data.businessId,
    'a saved journey is still deterministic for itself');
  assert.equal(second.data.linkMethod, 'session');
  assert.equal(second.data.sessionContradicted, false);
  assert.equal(second.data.supersedesBirId, first.birId, 'and it chains');

  const states = await rows('business_review_states', 'business_id', first.data.businessId);
  const mixState = states.find(st => st.review_type === 'service_mix');
  assert.equal(mixState.current_bir_id, second.birId);
  assert.equal(mixState.completed_count, 2);
});

it('P11 — a rebrand or a new email in one session still links', async () => {
  const s = salonNames('p11');
  const sessionA = id();
  const first = await mixInSession({ name: s.a, contactEmail: s.aEmail, sessionId: sessionA });
  created.businessIds.push(first.data.businessId);

  const renamed = await mixInSession({
    name: `${s.a} and spa`, contactEmail: s.aEmail, sessionId: sessionA });
  assert.equal(renamed.data.businessId, first.data.businessId, 'a rebrand');
  assert.equal(renamed.data.sessionContradicted, false);

  const sessionB = id();
  const other = await mixInSession({ name: s.b, contactEmail: s.bEmail, sessionId: sessionB });
  created.businessIds.push(other.data.businessId);
  const moved = await mixInSession({
    name: s.b, contactEmail: email('p11-new'), sessionId: sessionB });
  assert.equal(moved.data.businessId, other.data.businessId, 'a new email address');
  assert.equal(moved.data.sessionContradicted, false);
});

it('P12 — Business B in Business A session does not link to A', async () => {
  const s = salonNames('p12');
  const sessionId = id();

  const a = await mixInSession({ name: s.a, contactEmail: s.aEmail, sessionId });
  created.businessIds.push(a.data.businessId);

  const b = await mixInSession({ name: s.b, contactEmail: s.bEmail, sessionId });

  assert.equal(b.error, null, 'the visitor still gets a result');
  assert.equal(b.data.sessionContradicted, true);
  assert.equal(b.data.continuationContradicted, false);
  assert.equal(b.data.businessId, null, 'not filed under Business A');
  assert.equal(b.data.identityStatus, 'resolution_pending');
  assert.equal(b.data.linkMethod, null);
  assert.equal(b.data.nextAction, 'identity_review_pending');

  const [submission] = await rows('assessment_submissions', 'submission_id', b.submissionId);
  assert.equal(submission.business_id, null);
  assert.equal(submission.identity_status, 'resolution_pending');
  assert.equal(submission.ingest_meta.sessionContradicted, true);
  assert.equal(submission.ingest_meta.continuationApplied, false);
});

it('P13 — B identifiers never reach A, and no record is created for B', async () => {
  const s = salonNames('p13');
  const sessionId = id();
  const a = await mixInSession({ name: s.a, contactEmail: s.aEmail, sessionId });
  created.businessIds.push(a.data.businessId);

  await mixInSession({ name: s.b, contactEmail: s.bEmail, sessionId });

  const held = (await rows('business_identifiers', 'business_id', a.data.businessId))
    .filter(i => i.valid_to === null).map(i => i.normalized_value);
  assert.equal(held.includes(s.b), false, 'business name');
  assert.equal(held.includes(s.bEmail), false, 'exact email');
  assert.ok(held.includes(s.a));
  assert.ok(held.includes(s.aEmail));

  const { data: anywhere } = await db.from('business_identifiers')
    .select('business_id').eq('normalized_value', s.bEmail);
  assert.deepEqual(anywhere || [], [],
    'a vetoed proposal may not create a record either');
});

it('P14 — B report never enters A chain, and A pointers do not move', async () => {
  const s = salonNames('p14');
  const sessionId = id();
  const a = await mixInSession({ name: s.a, contactEmail: s.aEmail, sessionId });
  created.businessIds.push(a.data.businessId);

  const b = await mixInSession({ name: s.b, contactEmail: s.bEmail, sessionId });

  const [bReport] = await rows('business_intelligence_reports', 'bir_id', b.birId);
  assert.equal(bReport.business_id, null, 'stored, attached to nobody');
  assert.equal(bReport.supersedes_bir_id, null);

  const aReports = await rows('business_intelligence_reports', 'business_id', a.data.businessId);
  assert.deepEqual(aReports.map(r => r.bir_id), [a.birId]);

  const states = await rows('business_review_states', 'business_id', a.data.businessId);
  const mixState = states.find(st => st.review_type === 'service_mix');
  assert.equal(mixState.current_bir_id, a.birId, 'the current pointer did not move');
  assert.equal(mixState.latest_submission_id, a.submissionId);
  assert.equal(mixState.completed_count, 1);

  /* And the session row still points where it always did — which is exactly
     why the submission must not be attached elsewhere. */
  const [session] = await rows('assessment_sessions', 'assessment_session_id', sessionId);
  assert.equal(session.business_id, a.data.businessId);
  assert.equal(session.review_type, 'service_mix');
});

it('P15 — the case names types and never values, and the audit agrees', async () => {
  const s = salonNames('p15');
  const sessionId = id();
  const a = await mixInSession({ name: s.a, contactEmail: s.aEmail, sessionId });
  created.businessIds.push(a.data.businessId);

  const b = await mixInSession({ name: s.b, contactEmail: s.bEmail, sessionId });

  const cases = await rows('identity_resolution_cases', 'assessment_submission_id', b.submissionId);
  assert.equal(cases.length, 1);
  const [openCase] = cases;
  assert.equal(openCase.resolution_status, 'manual_review_required');
  assert.equal(openCase.recommended_action, 'queue_for_review');
  assert.equal(openCase.resolved_at, null);

  const contradiction = (openCase.conflicting_signals || [])
    .find(c => c.kind === 'session_contradicted');
  assert.ok(contradiction, 'the case must record that the session was set aside');
  assert.equal(contradiction.proposedBusinessId, a.data.businessId);
  assert.ok(contradiction.contradictedTypes.includes('business_name'));
  assert.ok(contradiction.contradictedTypes.includes('email_exact'));
  assert.deepEqual(contradiction.agreedTypes, []);

  const text = JSON.stringify(openCase);
  assert.equal(text.includes(s.bEmail), false, 'no identifier value in a review queue');
  assert.equal(text.includes(s.b), false);

  const { data: events } = await db.from('timeline_events')
    .select('event_name, payload, summary, business_id')
    .eq('correlation_id', b.submissionId);
  const review = (events || []).find(e => e.event_name === 'identity.review_required');
  assert.ok(review);
  assert.equal(review.payload.sessionContradicted, true);
  assert.match(review.summary, /saved identity proposal was set aside/i);
  assert.equal(review.business_id, null, 'the event is not filed under A either');

  /* The audit row is correlated by the caller's correlationId, not by the
     submission id, so it is found by what it recorded. */
  const { data: audits } = await db.from('audit_events')
    .select('business_id, new_value').eq('action', 'assessment.ingested');
  const ingested = (audits || [])
    .find(e => e.new_value && e.new_value.submissionId === b.submissionId);
  assert.ok(ingested);
  assert.equal(ingested.business_id, null);
  assert.equal(ingested.new_value.sessionContradicted, true);
  assert.equal(ingested.new_value.identityStatus, 'resolution_pending');
});

it('P16 — a stale-session queued retry contaminates neither record', async () => {
  /* Business B's review was queued on a device whose session had already
     resolved to Business A. The retry carries the same payload and the same
     session id, and no continuation context at all. */
  const s = salonNames('p16');
  const sessionId = id();
  const a = await mixInSession({ name: s.a, contactEmail: s.aEmail, sessionId });
  created.businessIds.push(a.data.businessId);

  const queuedSubmission = id();
  const queuedBir = id();
  const first = await mixInSession({
    name: s.b, contactEmail: s.bEmail, sessionId,
    submissionId: queuedSubmission, birId: queuedBir });
  assert.equal(first.error, null);
  assert.equal(first.data.businessId, null);

  /* The retry: same idempotency key, same content. */
  const retry = await mixInSession({
    name: s.b, contactEmail: s.bEmail, sessionId,
    submissionId: queuedSubmission, birId: queuedBir });
  assert.equal(retry.error, null);
  assert.equal(retry.data.replayed, true, 'a retry of one result is a replay');
  assert.equal(retry.data.businessId, null);

  /* One submission, one report, one case. */
  const submissions = await rows('assessment_submissions', 'submission_id', queuedSubmission);
  assert.equal(submissions.length, 1);
  const cases = await rows('identity_resolution_cases', 'assessment_submission_id', queuedSubmission);
  assert.equal(cases.length, 1);

  /* A is exactly as it was. */
  const aReports = await rows('business_intelligence_reports', 'business_id', a.data.businessId);
  assert.deepEqual(aReports.map(r => r.bir_id), [a.birId]);
  const held = (await rows('business_identifiers', 'business_id', a.data.businessId))
    .filter(i => i.valid_to === null).map(i => i.normalized_value);
  assert.equal(held.includes(s.bEmail), false);
});

it('P17 — a consistent continuation cannot rescue a contradicted session', async () => {
  /* Linking by context would attach the submission to B while the session row
     still says A — permanently, because that column is written once. */
  const s = salonNames('p17');
  const sessionId = id();

  const a = await mixInSession({ name: s.a, contactEmail: s.aEmail, sessionId });
  created.businessIds.push(a.data.businessId);
  const businessB = await establishBusiness(s.b, s.bEmail);

  const submissionId = id();
  const birId = id();
  const base = serviceMixPayload({ submissionId, sessionId });
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);

  const { data, error } = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: { ...base, contact: { ...base.contact, salonName: s.b, email: s.bEmail } },
    p_signals: [signal('business_name', s.b), signal('email_exact', s.bEmail),
                signal('vertical', 'nails')],
    p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
    p_meta: { correlationId: `b0b-${RUN}` },
    p_review_type: 'service_mix',
    p_continuation_business_id: businessB.businessId
  });

  assert.equal(error, null);
  assert.equal(data.sessionContradicted, true);
  assert.equal(data.continuationContradicted, false);
  assert.equal(data.businessId, null, 'neither record is chosen');
  assert.equal(data.identityStatus, 'resolution_pending');

  /* Neither gained anything. */
  const aHeld = (await rows('business_identifiers', 'business_id', a.data.businessId))
    .filter(i => i.valid_to === null).map(i => i.normalized_value);
  assert.equal(aHeld.includes(s.bEmail), false);
  const bReports = await rows('business_intelligence_reports', 'business_id', businessB.businessId);
  assert.deepEqual(bReports.map(r => r.bir_id), [businessB.birId]);
});

it('P18 — two consistent proposals naming different records go to review', async () => {
  /* Business A's name with Business B's email: A agrees on the name, B agrees
     on the email, so neither is contradicted and neither can be chosen. */
  const s = salonNames('p18');
  const sessionId = id();

  const a = await mixInSession({ name: s.a, contactEmail: s.aEmail, sessionId });
  created.businessIds.push(a.data.businessId);
  const businessB = await establishBusiness(s.b, s.bEmail);

  const submissionId = id();
  const birId = id();
  const base = serviceMixPayload({ submissionId, sessionId });
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);

  const { data, error } = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: { ...base, contact: { ...base.contact, salonName: s.a, email: s.bEmail } },
    p_signals: [signal('business_name', s.a), signal('email_exact', s.bEmail),
                signal('vertical', 'nails')],
    p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
    p_meta: { correlationId: `b0c-${RUN}` },
    p_review_type: 'service_mix',
    p_continuation_business_id: businessB.businessId
  });

  assert.equal(error, null);
  assert.equal(data.sessionContradicted, false);
  assert.equal(data.continuationContradicted, false);
  assert.equal(data.proposalsDisagreed, true);
  assert.equal(data.businessId, null);
  assert.equal(data.identityStatus, 'resolution_pending');

  const cases = await rows('identity_resolution_cases', 'assessment_submission_id', submissionId);
  const disagreement = (cases[0].conflicting_signals || [])
    .find(c => c.kind === 'proposals_disagree');
  assert.ok(disagreement, 'the case must say the two proposals disagreed');
  assert.deepEqual(
    [...disagreement.proposedBusinessIds].sort(),
    [businessB.businessId, a.data.businessId].sort());
});


/* ============================================================
   Q. Analytics date ranges are UTC, on both sides
   ------------------------------------------------------------
   Events are bucketed by `(occurred_at at time zone 'utc')::date`. The
   default bounds inherited from 0005 were `current_date`, which is the
   DATABASE SESSION's calendar. The two agree for most of the day and disagree
   exactly at the edge — the worst possible failure shape, because a nightly
   refresh silently writes nothing rather than failing.

   Reproduced at 00:05 UTC from an America/New_York session: now() said
   August 6, current_date said August 5, both events bucketed to August 6, and
   the aggregate table stayed empty.

   These tests do not wait for midnight. They set the session time zone to one
   deliberately behind UTC and one deliberately ahead, so that on most of the
   day at least one of them disagrees with UTC — and they assert the catalog's
   default expressions directly, which cannot pass by coincidence at all.
   ============================================================ */

/* Far enough either side that the local date differs from the UTC date for
   most of the day, and the two never agree with each other. */

/* Local mode only: these need control of the DATABASE SESSION's time zone,
   which means a raw connection. Skipped rather than silently weakened when
   the suite runs against a hosted project through PostgREST. */
const utcIt = (name, fn) => test(name, {
  skip: BLOCKED ? 'guards not satisfied'
    : (!localEnv ? 'needs the local PostgreSQL harness for session time-zone control' : false)
}, fn);

const BEHIND_UTC = 'Pacific/Niue';        /* UTC-11 */
const AHEAD_OF_UTC = 'Pacific/Kiritimati'; /* UTC+14 */

const inSession = async (timeZone, sql, params = []) => {
  await localEnv.pg.query(`set time zone '${timeZone}'`);
  try {
    return await localEnv.pg.query(sql, params);
  } finally {
    await localEnv.pg.query("set time zone 'UTC'");
  }
};

utcIt('Q1 — the declared defaults are UTC expressions, not session-local ones', async () => {
  /* The strongest form of this assertion: read the catalog. It cannot pass
     because a local date happened to equal the UTC one when the suite ran. */
  const { rows } = await localEnv.pg.query(`
    select p.proname,
           pg_get_expr(p.proargdefaults, 0) as defaults
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('refresh_assessment_funnel_daily', 'assessment_step_dropoff')
     order by p.proname`);

  assert.equal(rows.length, 2, 'both date-ranged analytics functions');
  rows.forEach(row => {
    assert.match(row.defaults, /utc/i,
      `${row.proname} must default from the UTC calendar`);
    assert.equal(/current_date/i.test(row.defaults), false,
      `${row.proname} must not default from the session calendar`);
  });
});

utcIt('Q2 — the two session zones really do disagree, so the rest is a real test', async () => {
  const behind = await inSession(BEHIND_UTC,
    "select current_date as local, (now() at time zone 'utc')::date as utc");
  const ahead = await inSession(AHEAD_OF_UTC,
    "select current_date as local, (now() at time zone 'utc')::date as utc");

  const asDate = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

  /* Both sessions agree about UTC, and at least one differs from it locally —
     Niue is 25 hours behind Kiritimati, so their local dates can never both
     equal the UTC date. */
  assert.equal(asDate(behind.rows[0].utc), asDate(ahead.rows[0].utc));
  const localsDiffer = asDate(behind.rows[0].local) !== asDate(ahead.rows[0].local);
  assert.ok(localsDiffer,
    'the two session calendars must differ, or this section proves nothing');

  console.log(`\n    UTC date ${asDate(behind.rows[0].utc)} | ` +
    `${BEHIND_UTC} ${asDate(behind.rows[0].local)} | ` +
    `${AHEAD_OF_UTC} ${asDate(ahead.rows[0].local)}\n`);
});

/* One analytics event, stamped NOW, so it lands in today's UTC bucket
   whatever the wall clock says. */
const seedAnalyticsEvent = async ({ eventName, sessionId, reviewType, source }) => {
  const eventId = id();
  created.analyticsEventIds.push(eventId);
  created.analyticsSessionIds.push(sessionId);
  const { error } = await rpc('ingest_analytics_events', {
    p_events: [{
      eventId, eventName, eventVersion: 1, schemaVersion: 2,
      assessmentSessionId: sessionId, verticalId: 'nails',
      reviewType,
      occurredAt: new Date().toISOString(),
      activeElapsedMs: 1000, totalElapsedMs: 2000,
      assessmentStage: 1, stepId: 'figures',
      attribution: { firstTouch: { utm: { utm_source: source } } },
      device: { deviceClass: 'phone' }, metadata: {}
    }],
    p_meta: { correlationId: `utc-${RUN}` }, p_retention_days: 400
  });
  assert.equal(error, null);
  return eventId;
};

const funnelRows = async source => {
  const { data } = await db.from('assessment_funnel_daily').select('*').eq('source', source);
  return data || [];
};

utcIt('Q3 — zero-argument aggregation includes today from a session BEHIND UTC', async () => {
  const source = `utcb-${RUN}`;
  await seedAnalyticsEvent({
    eventName: 'assessment.page_viewed', sessionId: id(),
    reviewType: 'growth_review', source });
  await seedAnalyticsEvent({
    eventName: 'assessment.started', sessionId: id(),
    reviewType: 'growth_review', source });

  /* Zero arguments, from a session eleven hours behind UTC. Before the fix
     this wrote nothing whenever the local date had not yet caught up. */
  const { rows } = await inSession(BEHIND_UTC,
    'select public.refresh_assessment_funnel_daily() as n');
  assert.ok(Number(rows[0].n) >= 1, 'rows must be written');

  const aggregated = await funnelRows(source);
  assert.ok(aggregated.length >= 1, 'the aggregate table must not stay empty');

  /* The complete row, not merely its existence. */
  const [row] = aggregated;
  const utcToday = (await localEnv.pg.query(
    "select (now() at time zone 'utc')::date as d")).rows[0].d;
  const asDate = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

  assert.equal(asDate(row.aggregate_date), asDate(utcToday),
    'bucketed on the UTC calendar');
  assert.equal(row.vertical_id, 'nails');
  assert.equal(row.review_type, 'growth_review');
  assert.equal(row.device_class, 'phone');
  assert.equal(row.source, source);
  assert.equal(Number(row.page_views), 1);
  assert.equal(Number(row.starts), 1);
});

utcIt('Q4 — and from a session AHEAD of UTC', async () => {
  const source = `utca-${RUN}`;
  await seedAnalyticsEvent({
    eventName: 'assessment.page_viewed', sessionId: id(),
    reviewType: 'growth_review', source });

  const { rows } = await inSession(AHEAD_OF_UTC,
    'select public.refresh_assessment_funnel_daily() as n');
  assert.ok(Number(rows[0].n) >= 1);

  const aggregated = await funnelRows(source);
  assert.equal(aggregated.length, 1);
  assert.equal(Number(aggregated[0].page_views), 1);
});

utcIt('Q5 — the two review types stay separated across the UTC boundary', async () => {
  const source = `utcm-${RUN}`;
  await seedAnalyticsEvent({
    eventName: 'assessment.page_viewed', sessionId: id(),
    reviewType: 'growth_review', source });
  await seedAnalyticsEvent({
    eventName: 'service_mix.review_viewed', sessionId: id(),
    reviewType: 'service_mix', source });

  await inSession(BEHIND_UTC, 'select public.refresh_assessment_funnel_daily()');

  const aggregated = await funnelRows(source);
  const byType = Object.fromEntries(aggregated.map(r => [r.review_type, r]));
  assert.ok(byType.growth_review, 'a Growth row');
  assert.ok(byType.service_mix, 'and a separate Service Mix row');
  assert.equal(Number(byType.growth_review.page_views), 1);
  assert.equal(Number(byType.service_mix.page_views), 1,
    'service_mix.review_viewed counts as a page view for its own funnel');
});

utcIt('Q6 — repeated zero-argument aggregation is idempotent', async () => {
  const source = `utci-${RUN}`;
  await seedAnalyticsEvent({
    eventName: 'assessment.page_viewed', sessionId: id(),
    reviewType: 'growth_review', source });

  await inSession(BEHIND_UTC, 'select public.refresh_assessment_funnel_daily()');
  const first = await funnelRows(source);
  await inSession(AHEAD_OF_UTC, 'select public.refresh_assessment_funnel_daily()');
  await localEnv.pg.query('select public.refresh_assessment_funnel_daily()');
  const third = await funnelRows(source);

  assert.equal(third.length, first.length, 'no duplicate rows');
  assert.equal(Number(third[0].page_views), Number(first[0].page_views),
    'and no double counting, whatever the session calendar');
});

utcIt('Q7 — explicit bounds still mean exactly what they say', async () => {
  const source = `utce-${RUN}`;
  await seedAnalyticsEvent({
    eventName: 'assessment.page_viewed', sessionId: id(),
    reviewType: 'growth_review', source });

  const utcToday = (await localEnv.pg.query(
    "select (now() at time zone 'utc')::date as d")).rows[0].d;
  const asDate = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const today = asDate(utcToday);
  const longAgo = '2020-01-01';

  /* A window that excludes today writes nothing for this source. */
  await localEnv.pg.query(
    'select public.refresh_assessment_funnel_daily($1::date, $2::date)',
    [longAgo, '2020-01-08']);
  assert.deepEqual(await funnelRows(source), [],
    'an explicit past window must not sweep in today');

  /* A window that includes it does. */
  await localEnv.pg.query(
    'select public.refresh_assessment_funnel_daily($1::date, $2::date)',
    [today, today]);
  const included = await funnelRows(source);
  assert.equal(included.length, 1);
  assert.equal(Number(included[0].page_views), 1);
});

utcIt('Q8 — assessment_step_dropoff uses the same UTC convention', async () => {
  const sessionId = id();
  await seedAnalyticsEvent({
    eventName: 'assessment.step_viewed', sessionId,
    reviewType: 'growth_review', source: `utcd-${RUN}` });
  await seedAnalyticsEvent({
    eventName: 'assessment.step_completed', sessionId,
    reviewType: 'growth_review', source: `utcd-${RUN}` });

  /* Zero range arguments, from both opposing session calendars. */
  for (const zone of [BEHIND_UTC, AHEAD_OF_UTC]) {
    const { rows } = await inSession(zone,
      "select * from public.assessment_step_dropoff('nails')");
    const step = rows.find(r => r.step_id === 'figures');
    assert.ok(step, `${zone}: today's steps must be inside the default window`);
    assert.ok(Number(step.entered_sessions) >= 1);
    assert.ok(Number(step.completed_sessions) >= 1);
  }
});


/* ---------- R. The value contract, in PostgreSQL ----------

   `identity_proposal_conflict` mirrored the JavaScript rule but not the
   JavaScript VALUE contract. `gbp_place_id: 'x'` — which `isAcceptableValue`
   has always refused — was compared, counted as agreement on both sides, and
   neutralised a real name-and-email contradiction. JavaScript now throws;
   without the same refusal here, PostgreSQL would still have linked, and the
   two implementations would disagree about the same input.

   Canonicality (normalizeEmail, normalizePhone, normalizeDomain,
   normalizeName) is deliberately NOT reimplemented in SQL — a second
   normalizer that drifts is worse than one. R5 proves instead that no
   non-canonical value can reach the database through the endpoint, which is
   the only writer of either side. */

const acceptable = async (type, value) => {
  const { rows } = await localEnv.pg.query(
    'select public.identity_value_acceptable($1, $2) as ok', [type, value]);
  return rows[0].ok;
};

utcIt('R1 — identity_value_acceptable mirrors isAcceptableValue, value for value', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const js = req('../../shared/business-record/resolve-identity.js');

  /* One table, both implementations. A disagreement here is the defect. */
  const cases = [
    ['gbp_place_id', 'x'], ['gbp_place_id', 'ab'], ['gbp_place_id', 'abcdef'],
    ['gbp_place_id', 'ChIJrTLr-GyuEmsRBfy61i59si0'], ['gbp_place_id', 'has spaces'],
    ['gbp_place_id', 'a'.repeat(128)], ['gbp_place_id', 'a'.repeat(129)],
    ['external_customer_id', 'ab'], ['external_customer_id', 'ab-c'],
    ['external_customer_id', 'a b c'], ['external_customer_id', 'cus:1.2-3'],
    ['payment_customer_id', 'abc'], ['payment_customer_id', 'cus_1234'],
    ['payment_customer_id', 'has spaces'],
    ['business_name', 'polished nail studio'], ['business_name', 'a'.repeat(256)],
    ['business_name', 'a'.repeat(257)], ['business_name', ''],
    ['email_exact', 'owner@polished.test'], ['email_domain', 'polished.test'],
    ['website_domain', 'polished.test'], ['business_phone', '+18645550134'],
    ['mobile_phone', '+18645550134'], ['vertical', 'nails'], ['locality', 'greenville sc']
  ];

  for (const [type, value] of cases) {
    const sql = await acceptable(type, value);
    assert.equal(sql, js.isAcceptableValue(type, value),
      `${type} ${JSON.stringify(value.length > 40 ? `${value.slice(0, 12)}…(${value.length})` : value)}`);
  }

  /* Nulls refused on both sides. */
  assert.equal(await acceptable(null, 'x'), false);
  assert.equal(await acceptable('gbp_place_id', null), false);
});

utcIt('R2 — an impossible submitted value is refused, not compared', async () => {
  const s = salonNames('r2');
  const salonA = await establishBusiness(s.a, s.aEmail);

  const { data, error } = await rpc('identity_proposal_conflict', {
    p_signals: [
      signal('business_name', s.b), signal('email_exact', s.bEmail),
      signal('gbp_place_id', 'x')
    ],
    p_business_id: salonA.businessId
  });

  assert.equal(data, null);
  assert.ok(error, 'an impossible value must stop the comparison');
  assert.match(error.message, /identity_value_unacceptable/);
  assert.match(error.message, /submitted gbp_place_id/);
  /* The value itself never appears in the message. */
  assert.equal(/'x'/.test(error.message), false);
});

utcIt('R3 — matching impossible values on BOTH sides are refused, not agreement', async () => {
  /* The audit's reproduction. Before the fix this returned material: false —
     the junk agreed with itself and cancelled a real contradiction. */
  const s = salonNames('r3');
  const salonA = await establishBusiness(s.a, s.aEmail);

  /* Plant the same impossible value on the record. */
  const { error: seedError } = await db.from('business_identifiers').insert({
    business_id: salonA.businessId, identifier_type: 'gbp_place_id',
    normalized_value: 'x', raw_value: 'x', source: 'seed',
    confidence: 0.95, verified: false, verification_method: 'none'
  });
  assert.equal(seedError, null);

  const { data, error } = await rpc('identity_proposal_conflict', {
    p_signals: [
      signal('business_name', s.b), signal('email_exact', s.bEmail),
      signal('gbp_place_id', 'x')
    ],
    p_business_id: salonA.businessId
  });

  assert.equal(data, null);
  assert.ok(error);
  assert.match(error.message, /identity_value_unacceptable/);

  /* And a HELD impossible value is refused even when the submission is clean. */
  const clean = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', s.a), signal('email_exact', s.aEmail)],
    p_business_id: salonA.businessId
  });
  assert.equal(clean.data, null);
  assert.match(clean.error.message, /held gbp_place_id/);
});

utcIt('R4 — the refusal reaches ingest_review, so nothing is stored on junk', async () => {
  const s = salonNames('r4');
  const salonA = await establishBusiness(s.a, s.aEmail);

  const submissionId = id();
  const birId = id();
  const base = serviceMixPayload({ submissionId, sessionId: id() });
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);

  const { data, error } = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: { ...base, contact: { ...base.contact, salonName: s.b, email: s.bEmail } },
    p_signals: [
      signal('business_name', s.b), signal('email_exact', s.bEmail),
      signal('gbp_place_id', 'x')
    ],
    p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
    p_meta: { correlationId: `r4-${RUN}` },
    p_review_type: 'service_mix',
    p_continuation_business_id: salonA.businessId
  });

  assert.equal(data, null);
  assert.ok(error, 'ingestion fails closed rather than linking on junk');
  assert.match(error.message, /identity_value_unacceptable/);

  /* Nothing was written: one atomic function, one transaction. */
  assert.deepEqual(await rows('assessment_submissions', 'submission_id', submissionId), []);
  assert.deepEqual(await rows('business_intelligence_reports', 'bir_id', birId), []);
  const held = (await rows('business_identifiers', 'business_id', salonA.businessId))
    .map(i => i.normalized_value);
  assert.equal(held.includes(s.b), false, 'and Salon A gained nothing');
});

utcIt('R5 — every signal the endpoint sends is acceptable AND canonical', async () => {
  /* Canonicality is not reimplemented in SQL, so this is the property that
     keeps a non-canonical value out of the database: the endpoint is the only
     writer of either side, and what it sends is canonical by construction.
     business_identifiers rows are written from these same signals. */
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const js = req('../../shared/business-record/resolve-identity.js');

  const payloads = [
    payload({ submissionId: id(), sessionId: id(), name: 'Polished Nail Studio, LLC',
              contactEmail: 'Owner+Tag@Polished.TEST',
              extraContact: { mobile: '(864) 555-0134', website: 'https://www.polished.test/x',
                              businessPhone: '864-555-0135',
                              googlePlaceId: 'ChIJrTLr-GyuEmsRBfy61i59si0' } }),
    payload({ submissionId: id(), sessionId: id() }),
    serviceMixPayload({ submissionId: id(), sessionId: id() })
  ];

  for (const p of payloads) {
    const signals = js.persistableSignals(js.extractIdentitySignals(p));
    assert.ok(signals.length, 'a payload with contact details produces signals');

    for (const s of signals) {
      assert.equal(js.isAcceptableValue(s.type, s.normalizedValue), true,
        `${s.type} not acceptable in JavaScript`);
      assert.equal(await acceptable(s.type, s.normalizedValue), true,
        `${s.type} not acceptable in PostgreSQL`);
    }

    /* And the comparison accepts them, in both implementations. */
    assert.doesNotThrow(() => js.proposalConflict({
      signals,
      heldIdentifiers: signals.map(s => ({ type: s.type, normalizedValue: s.normalizedValue }))
    }));
  }
});

utcIt('R6 — the dense case table is unchanged by the value contract', async () => {
  /* P1-P18 already cover it end to end; this re-runs the comparison
     primitive directly on the same shapes, to show the hardening changed
     nothing about valid evidence. */
  const s = salonNames('r6');
  const salonA = await establishBusiness(s.a, s.aEmail);

  const same = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', s.a), signal('email_exact', s.aEmail)],
    p_business_id: salonA.businessId
  });
  assert.equal(same.error, null);
  assert.equal(same.data[0].material, false, 'same business');

  const different = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', s.b), signal('email_exact', s.bEmail)],
    p_business_id: salonA.businessId
  });
  assert.equal(different.error, null);
  assert.equal(different.data[0].material, true, 'different business');

  const rebrand = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', `${s.a} and spa`), signal('email_exact', s.aEmail)],
    p_business_id: salonA.businessId
  });
  assert.equal(rebrand.error, null);
  assert.equal(rebrand.data[0].material, false, 'rebrand');

  /* A REAL shared strong identifier is still continuity — the contract
     refuses impossible values, not valid ones. */
  const place = 'ChIJrTLr-GyuEmsRBfy61i59si0';
  await db.from('business_identifiers').insert({
    business_id: salonA.businessId, identifier_type: 'gbp_place_id',
    normalized_value: place, raw_value: place, source: 'seed',
    confidence: 0.95, verified: false, verification_method: 'none'
  });
  const shared = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', s.b), signal('email_exact', s.bEmail),
                signal('gbp_place_id', place)],
    p_business_id: salonA.businessId
  });
  assert.equal(shared.error, null);
  assert.equal(shared.data[0].material, false,
    'a real shared place id outranks a name and email change');
  assert.ok(shared.data[0].agreed_types.includes('gbp_place_id'));
});


/* ---------- S. case-preserving strong identifiers, and the SQL boundary ----------

   `identity_proposal_conflict` applied `lower()` to both sides. For the three
   opaque strong identifiers that is a collision, not a normalization:
   `gbp_place_id` `Abcdef` and `abcdef` are two different places, and
   business_identifiers_strong_unique — a plain btree index — already stores
   them as two rows. Folded together they were reported as AGREEMENT, which
   outranks every contradiction, and a submission carrying a contradictory
   business name AND a contradictory email linked to the wrong record.

   Section S also closes the two remaining JavaScript/PostgreSQL disagreements:
   the length definition above U+FFFF, and malformed evidence, which this
   function used to filter while the JavaScript threw. */

const CASE_DISTINCT = [
  ['gbp_place_id',         'Abcdef',    'abcdef'],
  ['external_customer_id', 'Cust:Abcd', 'cust:abcd'],
  ['payment_customer_id',  'Cus_Abcd',  'cus_abcd']
];

const holdIdentifier = async (businessId, type, value) => {
  const { error } = await db.from('business_identifiers').insert({
    business_id: businessId, identifier_type: type,
    normalized_value: value, raw_value: value, source: 'seed',
    confidence: 0.95, verified: false, verification_method: 'none'
  });
  assert.equal(error, null, `seeding ${type}`);
};

utcIt('S1 — case-distinct strong values are a contradiction, not agreement', async () => {
  for (const [type, heldValue, submittedValue] of CASE_DISTINCT) {
    const s = salonNames(`s1-${type}`);
    const salonA = await establishBusiness(s.a, s.aEmail);
    await holdIdentifier(salonA.businessId, type, heldValue);

    /* Both spellings are acceptable values on both sides of the wire. */
    const { rows: ok } = await localEnv.pg.query(
      'select public.identity_value_acceptable($1,$2) as held, ' +
      '       public.identity_value_acceptable($1,$3) as submitted',
      [type, heldValue, submittedValue]);
    assert.equal(ok[0].held, true);
    assert.equal(ok[0].submitted, true);

    const { data, error } = await rpc('identity_proposal_conflict', {
      p_signals: [signal('business_name', s.b), signal('email_exact', s.bEmail),
                  signal(type, submittedValue)],
      p_business_id: salonA.businessId
    });

    assert.equal(error, null);
    assert.equal(data[0].agreed_types.includes(type), false,
      `${type}: case-distinct values reported as agreement`);
    assert.ok(data[0].contradicted_types.includes(type), `${type}: contradicted`);
    assert.equal(data[0].material, true,
      `${type}: the real name and email contradiction must survive`);
  }
});

utcIt('S2 — an exact strong value is still continuity, all three types', async () => {
  /* The approved rule is unchanged. Only case folding was removed. */
  for (const [type, heldValue] of CASE_DISTINCT) {
    const s = salonNames(`s2-${type}`);
    const salonA = await establishBusiness(s.a, s.aEmail);
    await holdIdentifier(salonA.businessId, type, heldValue);

    const { data, error } = await rpc('identity_proposal_conflict', {
      p_signals: [signal('business_name', s.b), signal('email_exact', s.bEmail),
                  signal(type, heldValue)],
      p_business_id: salonA.businessId
    });

    assert.equal(error, null);
    assert.ok(data[0].agreed_types.includes(type), `${type}: exact match is agreement`);
    assert.equal(data[0].material, false,
      `${type}: an exact shared strong identifier outranks a name and email change`);
  }
});

utcIt('S3 — end to end: a case-distinct place id does not link, and contaminates nothing', async () => {
  /* The reported reproduction. Before this change Salon B was filed under
     Salon A, and Salon A ended up holding both names, both emails and both
     spellings of the place id. */
  const s = salonNames('s3');
  const salonA = await establishBusiness(s.a, s.aEmail);
  await holdIdentifier(salonA.businessId, 'gbp_place_id', 'Abcdef');

  const submissionId = id();
  const birId = id();
  const base = serviceMixPayload({ submissionId, sessionId: id() });
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);

  const { data, error } = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: { ...base, contact: { ...base.contact, salonName: s.b, email: s.bEmail } },
    p_signals: [signal('business_name', s.b), signal('email_exact', s.bEmail),
                signal('gbp_place_id', 'abcdef')],
    p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
    p_meta: { correlationId: `s3-${RUN}` },
    p_review_type: 'service_mix',
    p_continuation_business_id: salonA.businessId
  });

  assert.equal(error, null, 'the visitor still gets a result');
  assert.equal(data.continuationContradicted, true);
  assert.equal(data.businessId, null, 'not filed under Salon A');
  assert.equal(data.identityStatus, 'resolution_pending');
  assert.equal(data.linkMethod, null);

  /* No contamination: Salon A gained nothing at all. */
  const held = (await rows('business_identifiers', 'business_id', salonA.businessId))
    .filter(i => i.valid_to === null);
  const values = held.map(i => i.normalized_value);
  assert.equal(values.includes(s.b), false, 'business name');
  assert.equal(values.includes(s.bEmail), false, 'email');
  assert.equal(values.includes('abcdef'), false, 'the lower-case place id');
  assert.ok(values.includes(s.a) && values.includes(s.aEmail) && values.includes('Abcdef'),
    'and Salon A still holds exactly what it held');

  /* Nor did a record get created for Salon B off the back of a vetoed proposal. */
  const { data: anywhere } = await db.from('business_identifiers')
    .select('business_id').eq('normalized_value', s.bEmail);
  assert.deepEqual(anywhere || [], []);

  const [submission] = await rows('assessment_submissions', 'submission_id', submissionId);
  assert.equal(submission.business_id, null);
  assert.equal(submission.identity_status, 'resolution_pending');

  /* And the same submission WOULD have linked with the exact value — so the
     only thing standing between it and a link is the case. */
  const exact = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', s.b), signal('email_exact', s.bEmail),
                signal('gbp_place_id', 'Abcdef')],
    p_business_id: salonA.businessId
  });
  assert.equal(exact.data[0].material, false);
});

utcIt('S4 — JavaScript and PostgreSQL agree on length at ASCII, BMP and astral boundaries', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const js = req('../../shared/business-record/resolve-identity.js');

  const chars = [
    ['ascii', 'a'],
    ['bmp-latin', 'é'],
    ['bmp-cjk', '中'],
    ['astral-emoji', '\u{1f600}'],
    ['astral-plane2', '\u{2000b}']
  ];

  for (const [label, ch] of chars) {
    for (const count of [1, 255, 256, 257]) {
      const value = ch.repeat(count);
      const { rows: r } = await localEnv.pg.query(
        'select public.identity_value_acceptable($1,$2) as ok, length($2) as len',
        ['locality', value]);
      assert.equal(r[0].ok, js.isAcceptableValue('locality', value),
        `${label} x${count}: JavaScript and PostgreSQL disagree`);
      assert.equal(Number(r[0].len), count,
        `${label} x${count}: PostgreSQL counts code points`);
      assert.equal(r[0].ok, count <= 256, `${label} x${count}`);
    }
  }

  /* The specific value from the audit: 129 emoji, 258 UTF-16 code units. */
  const emoji129 = '\u{1f600}'.repeat(129);
  assert.equal(emoji129.length, 258, 'still 258 code units in JavaScript');
  const { rows: r } = await localEnv.pg.query(
    'select public.identity_value_acceptable($1,$2) as ok', ['locality', emoji129]);
  assert.equal(r[0].ok, true);
  assert.equal(js.isAcceptableValue('locality', emoji129), true,
    'JavaScript refused this before; both now count code points');

  /* Straddling the boundary with mixed widths. */
  for (const [value, expected] of [[`${'a'.repeat(255)}\u{1f600}`, true],
                                   [`${'a'.repeat(256)}\u{1f600}`, false]]) {
    const { rows: m } = await localEnv.pg.query(
      'select public.identity_value_acceptable($1,$2) as ok', ['locality', value]);
    assert.equal(m[0].ok, expected);
    assert.equal(js.isAcceptableValue('locality', value), expected);
  }
});

utcIt('S5 — malformed evidence fails the whole comparison, it is not filtered', async () => {
  const s = salonNames('s5');
  const salonA = await establishBusiness(s.a, s.aEmail);

  const valid = [signal('business_name', s.b), signal('email_exact', s.bEmail)];
  const malformed = [
    ['a null entry',        null,                                    'not an object'],
    ['a string entry',      'business_name',                         'not an object'],
    ['a number entry',      42,                                      'not an object'],
    ['an array entry',      [],                                      'not an object'],
    ['a missing type',      { normalizedValue: 'x' },                'type is missing'],
    ['a null type',         { type: null, normalizedValue: 'x' },    'type is missing'],
    ['a non-string type',   { type: 7, normalizedValue: 'x' },       'type is missing'],
    ['an unknown type',     { type: 'not_a_type', normalizedValue: 'x' },
                                                                     'not a recognized identifier type'],
    ['a missing value',     { type: 'business_name' },               'normalizedValue is missing'],
    ['a null value',        { type: 'business_name', normalizedValue: null },
                                                                     'normalizedValue is missing'],
    ['a numeric value',     { type: 'business_name', normalizedValue: 42 },
                                                                     'normalizedValue is missing'],
    ['a boolean value',     { type: 'business_name', normalizedValue: true },
                                                                     'normalizedValue is missing'],
    ['an object value',     { type: 'business_name', normalizedValue: { v: 'x' } },
                                                                     'normalizedValue is missing']
  ];

  for (const [label, entry, fragment] of malformed) {
    /* Alone, and mixed in among valid evidence — the whole comparison fails
       either way, rather than the readable part being compared. */
    for (const [where, signals] of [['alone', [entry]],
                                    ['after valid evidence', valid.concat([entry])],
                                    ['before valid evidence', [entry].concat(valid)]]) {
      const { data, error } = await rpc('identity_proposal_conflict', {
        p_signals: signals, p_business_id: salonA.businessId
      });
      assert.equal(data, null, `${label}, ${where}`);
      assert.ok(error, `${label}, ${where}: must refuse`);
      assert.match(error.message, /identity_evidence_invalid/, `${label}, ${where}`);
      assert.match(error.message, new RegExp(fragment), `${label}, ${where}`);
      /* Never the value. */
      assert.equal(/riverside|salon-b/i.test(error.message), false,
        `${label}, ${where}: a value reached the message`);
    }
  }

  /* The audit's [null] reproduction specifically: it used to be ignored and
     answer material: false. */
  const nullEntry = await rpc('identity_proposal_conflict', {
    p_signals: [null], p_business_id: salonA.businessId });
  assert.equal(nullEntry.data, null);
  assert.match(nullEntry.error.message, /position 0 is invalid/);

  /* Position is reported, 0-based, matching the JavaScript message. */
  const second = await rpc('identity_proposal_conflict', {
    p_signals: valid.concat([null]), p_business_id: salonA.businessId });
  assert.match(second.error.message, /position 2 is invalid/);

  /* And a non-array operand is refused as such, not as a jsonb error.

     `'"business_name"'` rather than `'business_name'`: the driver hands a
     JavaScript string to a jsonb parameter verbatim, so the bare word is
     rejected by the JSON parser before the function is entered. That is the
     driver's boundary, not this function's, and the JSON-encoded form is what
     actually reaches it as a jsonb string. */
  for (const notAnArray of [{ type: 'business_name' }, '"business_name"', 42, true]) {
    const { data, error } = await rpc('identity_proposal_conflict', {
      p_signals: notAnArray, p_business_id: salonA.businessId });
    assert.equal(data, null, JSON.stringify(notAnArray));
    assert.match(error.message, /submitted evidence must be an array/);
  }

  /* An explicitly empty list is still valid and still means "nothing here". */
  const empty = await rpc('identity_proposal_conflict', {
    p_signals: [], p_business_id: salonA.businessId });
  assert.equal(empty.error, null);
  assert.equal(empty.data[0].material, false);
});

utcIt('S6 — malformed evidence reaching ingest_review stores nothing', async () => {
  const s = salonNames('s6');
  const salonA = await establishBusiness(s.a, s.aEmail);

  const submissionId = id();
  const birId = id();
  const base = serviceMixPayload({ submissionId, sessionId: id() });
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);

  const { data, error } = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: { ...base, contact: { ...base.contact, salonName: s.b, email: s.bEmail } },
    p_signals: [signal('business_name', s.b), signal('email_exact', s.bEmail), null],
    p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
    p_meta: { correlationId: `s6-${RUN}` },
    p_review_type: 'service_mix',
    p_continuation_business_id: salonA.businessId
  });

  assert.equal(data, null);
  assert.ok(error);
  assert.match(error.message, /identity_evidence_invalid/);
  assert.deepEqual(await rows('assessment_submissions', 'submission_id', submissionId), []);
  assert.deepEqual(await rows('business_intelligence_reports', 'bir_id', birId), []);
});

utcIt('S7 — the evidence-shape predicate agrees with the JavaScript, entry for entry', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const js = req('../../shared/business-record/resolve-identity.js');

  /* One table, both implementations: does this entry pass the shape contract?
     PostgreSQL returns a reason or null; the JavaScript throws or does not. */
  const entries = [
    [null, false], ['business_name', false], [42, false], [[], false], [true, false],
    [{}, false], [{ type: 'business_name' }, false],
    [{ type: null, normalizedValue: 'polished nail studio' }, false],
    [{ type: 'not_a_type', normalizedValue: 'x' }, false],
    [{ type: 'business_name', normalizedValue: null }, false],
    [{ type: 'business_name', normalizedValue: 42 }, false],
    [{ type: 'business_name', normalizedValue: 'polished nail studio' }, true],
    [{ type: 'gbp_place_id', normalizedValue: 'Abcdef' }, true],
    [{ type: 'email_exact', normalizedValue: 'owner@polished.test' }, true],
    [{ type: 'vertical', normalizedValue: 'nails' }, true]
  ];

  for (const [entry, wellFormed] of entries) {
    const { rows: r } = await localEnv.pg.query(
      'select public.identity_evidence_fault($1::jsonb) as fault',
      [JSON.stringify(entry)]);
    assert.equal(r[0].fault === null, wellFormed, `SQL: ${JSON.stringify(entry)}`);

    /* The JavaScript reaches the same verdict through the surface production
       uses. A well-formed entry may still be refused by the VALUE contract,
       which SQL enforces separately — so only the shape is compared here. */
    let threw = false;
    try {
      js.proposalConflict({ signals: [entry], heldIdentifiers: [] });
    } catch { threw = true; }
    assert.equal(threw, !wellFormed, `JavaScript: ${JSON.stringify(entry)}`);
  }
});

utcIt('S8 — P1-P18 and R1-R6 shapes still behave, after the fold was removed', async () => {
  /* A direct re-run of the comparison primitive on the dense shapes, to show
     that removing lower() changed nothing about values that were never
     case-distinct — every one of them is already lower case by construction. */
  const s = salonNames('s8');
  const salonA = await establishBusiness(s.a, s.aEmail);

  const same = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', s.a), signal('email_exact', s.aEmail)],
    p_business_id: salonA.businessId });
  assert.equal(same.error, null);
  assert.equal(same.data[0].material, false, 'same business');

  const different = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', s.b), signal('email_exact', s.bEmail)],
    p_business_id: salonA.businessId });
  assert.equal(different.data[0].material, true, 'different business');

  const rebrand = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', `${s.a} and spa`), signal('email_exact', s.aEmail)],
    p_business_id: salonA.businessId });
  assert.equal(rebrand.data[0].material, false, 'rebrand');

  /* Context types are still excluded on both sides. */
  const context = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', s.a), signal('email_exact', s.aEmail),
                signal('vertical', 'nails'), signal('locality', 'greenville sc')],
    p_business_id: salonA.businessId });
  assert.equal(context.data[0].agreed_types.includes('vertical'), false);
  assert.equal(context.data[0].contradicted_types.includes('locality'), false);

  /* And the v12 value contract is untouched. */
  const junk = await rpc('identity_proposal_conflict', {
    p_signals: [signal('business_name', s.b), signal('email_exact', s.bEmail),
                signal('gbp_place_id', 'x')],
    p_business_id: salonA.businessId });
  assert.equal(junk.data, null);
  assert.match(junk.error.message, /identity_value_unacceptable/);
});


/* ---------- T. null is not an empty list, in PostgreSQL ----------

   `identity_proposal_conflict` rejected a non-array only when `p_signals is
   not null`, and then wrote `coalesce(p_signals, '[]'::jsonb)` into every
   scan. So a null operand became a comparison with nothing on one side, and a
   comparison with nothing on one side always answers "no contradiction" —
   the answer that links.

   Salon A holds its name and email. A payload describing Salon B — different
   name, different email — arrives with `p_signals = null`, and linked to
   Salon A at confidence 1 through the session proposal and through the
   continuation proposal alike. Neither was reported as contradicted, no
   identity-resolution case was opened, and the submission and BIR were stored
   under Salon A permanently.

   The JavaScript has drawn the null/empty distinction since v11. This section
   asks PostgreSQL the same four questions the fake database and the shared
   rule are asked in tests/identity-proposals.test.mjs, and compares the
   answers rather than only the successful paths. */

const conflictWith = (signals, businessId) =>
  rpc('identity_proposal_conflict', { p_signals: signals, p_business_id: businessId });

utcIt('T1 — the primitive refuses null signals and keeps explicit empty legal', async () => {
  const s = salonNames('t1');
  const salonA = await establishBusiness(s.a, s.aEmail);

  /* Null: refused, with the 22023 invalid-input contract. */
  const nulled = await conflictWith(null, salonA.businessId);
  assert.equal(nulled.data, null, 'null must not be compared');
  assert.ok(nulled.error);
  assert.match(nulled.error.message, /identity_evidence_invalid/);
  assert.match(nulled.error.message, /submitted evidence is required/);

  /* A jsonb null scalar arrives by a different route and is refused too. */
  const jsonNull = await localEnv.pg.query(
    "select * from public.identity_proposal_conflict('null'::jsonb, $1)", [salonA.businessId])
    .then(() => null, err => err);
  assert.ok(jsonNull, 'a jsonb null scalar must be refused as well');
  assert.match(jsonNull.message, /must be an array/);

  /* Explicit empty: legal, and means what it says. */
  const empty = await conflictWith([], salonA.businessId);
  assert.equal(empty.error, null);
  assert.deepEqual(empty.data[0].agreed_types, []);
  assert.deepEqual(empty.data[0].contradicted_types, []);
  assert.equal(empty.data[0].material, false);

  /* Dense evidence for another business is still a material contradiction. */
  const dense = await conflictWith(
    [signal('business_name', s.b), signal('email_exact', s.bEmail)], salonA.businessId);
  assert.equal(dense.error, null);
  assert.equal(dense.data[0].material, true);

  /* No identifier value reaches any message. */
  [s.a, s.b, s.aEmail, s.bEmail].forEach(v =>
    assert.equal(nulled.error.message.includes(v), false, `the message carried ${v}`));
});

/* One proposal at a time, so each kind is proven on its own. */
const mixWithSignals = async ({ signals, sessionId, continuationBusinessId = null }) => {
  const s = salonNames('t-b');
  const submissionId = id();
  const birId = id();
  const base = serviceMixPayload({ submissionId, sessionId });
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);

  const { data, error } = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: { ...base, contact: { ...base.contact, salonName: s.b, email: s.bEmail } },
    p_signals: signals,
    p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
    p_meta: { correlationId: `t-${RUN}` },
    p_review_type: 'service_mix',
    p_continuation_business_id: continuationBusinessId
  });
  return { data, error, submissionId, birId, names: s };
};

/* A session that already points at Salon A — the session proposal. The
   seeding review must describe Salon A itself, or its own continuation
   proposal is contradicted and no session link is established to test. */
const sessionOn = async (businessId, s) => {
  const sessionId = id();
  const submissionId = id();
  const birId = id();
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);
  const base = serviceMixPayload({ submissionId, sessionId });
  const { data, error } = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: { ...base, contact: { ...base.contact, salonName: s.a, email: s.aEmail } },
    p_signals: [signal('business_name', s.a), signal('email_exact', s.aEmail)],
    p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
    p_meta: { correlationId: `t-seed-${RUN}` },
    p_review_type: 'service_mix',
    p_continuation_business_id: businessId
  });
  assert.equal(error, null, 'the seeding review must link, or the rest proves nothing');
  assert.equal(data.businessId, businessId);
  return sessionId;
};

utcIt('T2 — null signals cannot link through a session proposal, and store nothing', async () => {
  const s = salonNames('t2');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const sessionId = await sessionOn(salonA.businessId, s);

  const before = {
    submissions: (await rows('assessment_submissions', 'business_id', salonA.businessId)).length,
    reports: (await rows('business_intelligence_reports', 'business_id', salonA.businessId)).length,
    identifiers: (await rows('business_identifiers', 'business_id', salonA.businessId)).length,
    timeline: (await rows('timeline_events', 'business_id', salonA.businessId)).length,
    audit: (await rows('audit_events', 'business_id', salonA.businessId)).length,
    states: await rows('business_review_states', 'business_id', salonA.businessId),
    record: (await rows('business_records', 'business_id', salonA.businessId))[0],
    session: (await rows('assessment_sessions', 'assessment_session_id', sessionId))[0]
  };

  const attempt = await mixWithSignals({ signals: null, sessionId });

  assert.equal(attempt.data, null, 'null signals must not produce a decision');
  assert.ok(attempt.error);
  assert.match(attempt.error.message, /identity_evidence_invalid/);

  /* THE WHOLE TRANSACTION IS GONE. One atomic function, one transaction. */
  assert.deepEqual(await rows('assessment_submissions', 'submission_id', attempt.submissionId), []);
  assert.deepEqual(await rows('business_intelligence_reports', 'bir_id', attempt.birId), []);
  assert.deepEqual(await rows('idempotency_records', 'idempotency_key', attempt.submissionId), []);

  const after = {
    submissions: (await rows('assessment_submissions', 'business_id', salonA.businessId)).length,
    reports: (await rows('business_intelligence_reports', 'business_id', salonA.businessId)).length,
    identifiers: (await rows('business_identifiers', 'business_id', salonA.businessId)).length,
    timeline: (await rows('timeline_events', 'business_id', salonA.businessId)).length,
    audit: (await rows('audit_events', 'business_id', salonA.businessId)).length,
    states: await rows('business_review_states', 'business_id', salonA.businessId),
    record: (await rows('business_records', 'business_id', salonA.businessId))[0],
    session: (await rows('assessment_sessions', 'assessment_session_id', sessionId))[0]
  };

  assert.equal(after.submissions, before.submissions, 'submission count under Salon A');
  assert.equal(after.reports, before.reports, 'report count under Salon A');
  assert.equal(after.identifiers, before.identifiers, 'identifier count under Salon A');
  assert.equal(after.timeline, before.timeline, 'timeline events');
  assert.equal(after.audit, before.audit, 'audit events');
  assert.deepEqual(after.states, before.states, 'review-state pointers');
  assert.equal(after.record.current_bir_id, before.record.current_bir_id, 'current BIR pointer');
  assert.equal(after.session.business_id, before.session.business_id, 'session row');

  /* And Salon B reached nothing, anywhere. */
  const { data: anywhere } = await db.from('business_identifiers')
    .select('business_id').eq('normalized_value', attempt.names.bEmail);
  assert.deepEqual(anywhere || [], []);
});

utcIt('T3 — null signals cannot link through a continuation proposal either', async () => {
  const s = salonNames('t3');
  const salonA = await establishBusiness(s.a, s.aEmail);

  const attempt = await mixWithSignals({
    signals: null, sessionId: id(), continuationBusinessId: salonA.businessId });

  assert.equal(attempt.data, null);
  assert.ok(attempt.error);
  assert.match(attempt.error.message, /identity_evidence_invalid/);

  assert.deepEqual(await rows('assessment_submissions', 'submission_id', attempt.submissionId), []);
  assert.deepEqual(await rows('business_intelligence_reports', 'bir_id', attempt.birId), []);
  assert.deepEqual(await rows('idempotency_records', 'idempotency_key', attempt.submissionId), []);

  const held = (await rows('business_identifiers', 'business_id', salonA.businessId))
    .filter(i => i.valid_to === null).map(i => i.normalized_value);
  assert.equal(held.includes(attempt.names.b), false);
  assert.equal(held.includes(attempt.names.bEmail), false);
  assert.ok(held.includes(s.a) && held.includes(s.aEmail), 'Salon A is untouched');

  /* No case was opened either — the submission never happened. */
  const cases = await rows('identity_resolution_cases',
    'assessment_submission_id', attempt.submissionId);
  assert.deepEqual(cases, []);
});

utcIt('T4 — explicit empty signals stay legal for both proposal kinds', async () => {
  /* "There is genuinely nothing to compare" is not a contradiction, and the
     approved rule is that it links. Unchanged. */
  const sa = salonNames('t4a');
  const salonA = await establishBusiness(sa.a, sa.aEmail);
  const sessionId = await sessionOn(salonA.businessId, sa);

  const viaSession = await mixWithSignals({ signals: [], sessionId });
  assert.equal(viaSession.error, null);
  assert.equal(viaSession.data.businessId, salonA.businessId);
  assert.equal(viaSession.data.linkMethod, 'session');

  const sb = salonNames('t4b');
  const salonB = await establishBusiness(sb.a, sb.aEmail);
  const viaContinuation = await mixWithSignals({
    signals: [], sessionId: id(), continuationBusinessId: salonB.businessId });
  assert.equal(viaContinuation.error, null);
  assert.equal(viaContinuation.data.businessId, salonB.businessId);
  assert.equal(viaContinuation.data.linkMethod, 'continuation_context');
});

utcIt('T5 — dense contradicting signals still go to review, for both kinds', async () => {
  const sa = salonNames('t5a');
  const salonA = await establishBusiness(sa.a, sa.aEmail);
  const sessionId = await sessionOn(salonA.businessId, sa);

  const dense = names => [signal('business_name', names.b), signal('email_exact', names.bEmail)];

  /* The session path. The names the payload carries are the ones the signals
     describe, so the comparison is against a genuinely different business. */
  const submissionId = id();
  const birId = id();
  const names = salonNames('t5-b');
  created.submissionIds.push(submissionId);
  created.idempotencyKeys.push(submissionId);
  const base = serviceMixPayload({ submissionId, sessionId });
  const viaSession = await rpc('ingest_review', {
    p_idempotency_key: submissionId,
    p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
    p_payload: { ...base, contact: { ...base.contact, salonName: names.b, email: names.bEmail } },
    p_signals: dense(names),
    p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
    p_meta: { correlationId: `t5-${RUN}` },
    p_review_type: 'service_mix', p_continuation_business_id: null
  });
  assert.equal(viaSession.error, null, 'the visitor still gets a result');
  assert.equal(viaSession.data.sessionContradicted, true);
  assert.equal(viaSession.data.businessId, null);
  assert.equal(viaSession.data.identityStatus, 'resolution_pending');

  /* The continuation path. */
  const sb = salonNames('t5b');
  const salonB = await establishBusiness(sb.a, sb.aEmail);
  const submissionId2 = id();
  const birId2 = id();
  const names2 = salonNames('t5-c');
  created.submissionIds.push(submissionId2);
  created.idempotencyKeys.push(submissionId2);
  const base2 = serviceMixPayload({ submissionId: submissionId2, sessionId: id() });
  const viaContinuation = await rpc('ingest_review', {
    p_idempotency_key: submissionId2,
    p_request_hash: createHash('sha256').update(submissionId2).digest('hex'),
    p_payload: { ...base2,
      contact: { ...base2.contact, salonName: names2.b, email: names2.bEmail } },
    p_signals: dense(names2),
    p_bir: serviceMixBir(), p_bir_id: birId2, p_retention_days: 30,
    p_meta: { correlationId: `t5c-${RUN}` },
    p_review_type: 'service_mix', p_continuation_business_id: salonB.businessId
  });
  assert.equal(viaContinuation.error, null);
  assert.equal(viaContinuation.data.continuationContradicted, true);
  assert.equal(viaContinuation.data.businessId, null);
});

utcIt('T6 — candidate-only ingestion with no proposal is unchanged', async () => {
  /* ingest_review calls the primitive only when a proposal exists, so this
     path never reaches it. All three signal shapes behave identically, and
     identically to before the repair. */
  const outcomes = [];
  for (const signals of [null, []]) {
    const submissionId = id();
    const birId = id();
    const names = salonNames(`t6-${signals === null ? 'null' : 'empty'}`);
    created.submissionIds.push(submissionId);
    created.idempotencyKeys.push(submissionId);
    const base = serviceMixPayload({ submissionId, sessionId: id() });

    const { data, error } = await rpc('ingest_review', {
      p_idempotency_key: submissionId,
      p_request_hash: createHash('sha256').update(submissionId).digest('hex'),
      p_payload: { ...base,
        contact: { ...base.contact, salonName: names.b, email: names.bEmail } },
      p_signals: signals,
      p_bir: serviceMixBir(), p_bir_id: birId, p_retention_days: 30,
      p_meta: { correlationId: `t6-${RUN}` },
      p_review_type: 'service_mix', p_continuation_business_id: null
    });

    assert.equal(error, null, `signals=${signals === null ? 'null' : '[]'}`);
    if (data.businessId) created.businessIds.push(data.businessId);
    outcomes.push({ linked: data.businessId !== null, status: data.identityStatus,
                    linkMethod: data.linkMethod });
  }
  assert.deepEqual(outcomes[1], outcomes[0],
    'null and explicit empty must answer identically where no proposal exists');
});

utcIt('T7 — PostgreSQL answers the four signal shapes exactly as the shared rule does', async () => {
  /* The property, asked of both implementations rather than only of their
     successful paths. The JavaScript and fake-database halves are in
     tests/identity-proposals.test.mjs; the expectations are the same table. */
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const js = req('../../shared/business-record/resolve-identity.js');

  /* Names built THROUGH the shared normalizers, so both sides are canonical.
     `salonNames` produces "riverside barber co …", and normalizeName strips
     "co" as a legal suffix — that would make the submitted value non-canonical
     and the JavaScript would refuse it for a reason this test is not about.
     The canonicality gap between the two implementations is a separate,
     documented one that R5 covers. */
  const aName = js.normalizeName(`polished nail studio t7 ${RUN}`);
  const bName = js.normalizeName(`riverside barbershop t7 ${RUN}`);
  const aEmail = js.normalizeEmail(email('t7-a'));
  const bEmail = js.normalizeEmail(email('t7-b'));
  assert.ok(aName && bName && aEmail && bEmail && aName !== bName);

  const salonA = await establishBusiness(aName, aEmail);
  const held = [{ type: 'business_name', normalizedValue: aName },
                { type: 'email_exact', normalizedValue: aEmail }];

  const shapes = [
    ['omitted', undefined],
    ['null', null],
    ['explicitly empty', []],
    ['dense', [signal('business_name', bName), signal('email_exact', bEmail)]]
  ];

  for (const [name, signals] of shapes) {
    /* The shared rule. */
    let ruleRefused = false;
    let ruleMaterial = null;
    try {
      ruleMaterial = js.proposalConflict({
        signals: signals === undefined ? undefined
          : signals.map(x => ({ type: x.type, normalizedValue: x.normalizedValue })),
        heldIdentifiers: held
      }).material;
    } catch { ruleRefused = true; }

    /* PostgreSQL. An omitted jsonb argument arrives as null, which is the
       point: the two are indistinguishable on the wire, so both are refused. */
    const { data, error } = await rpc('identity_proposal_conflict', {
      p_signals: signals === undefined ? null : signals,
      p_business_id: salonA.businessId
    });
    const pgRefused = error !== null;

    assert.equal(pgRefused, ruleRefused,
      `${name}: PostgreSQL and the shared rule disagree about refusal`);
    if (!ruleRefused) {
      assert.equal(data[0].material, ruleMaterial,
        `${name}: PostgreSQL and the shared rule disagree about the verdict`);
    }
  }
});

utcIt('T8 — P, R and S regressions are unaffected by the null refusal', async () => {
  const s = salonNames('t8');
  const salonA = await establishBusiness(s.a, s.aEmail);

  const same = await conflictWith(
    [signal('business_name', s.a), signal('email_exact', s.aEmail)], salonA.businessId);
  assert.equal(same.data[0].material, false, 'same business');

  const rebrand = await conflictWith(
    [signal('business_name', `${s.a} and spa`), signal('email_exact', s.aEmail)],
    salonA.businessId);
  assert.equal(rebrand.data[0].material, false, 'rebrand only');

  const contactOnly = await conflictWith(
    [signal('business_name', s.a), signal('email_exact', s.bEmail)], salonA.businessId);
  assert.equal(contactOnly.data[0].material, false, 'contact change only');

  const different = await conflictWith(
    [signal('business_name', s.b), signal('email_exact', s.bEmail)], salonA.businessId);
  assert.equal(different.data[0].material, true, 'different business');

  /* An exact strong identifier is still continuity; a case-distinct one is
     still a contradiction; junk is still refused by the value contract. */
  const place = 'ChIJrTLr-GyuEmsRBfy61i59si0';
  await db.from('business_identifiers').insert({
    business_id: salonA.businessId, identifier_type: 'gbp_place_id',
    normalized_value: place, raw_value: place, source: 'seed',
    confidence: 0.95, verified: false, verification_method: 'none'
  });
  const exact = await conflictWith(
    [signal('business_name', s.b), signal('email_exact', s.bEmail), signal('gbp_place_id', place)],
    salonA.businessId);
  assert.equal(exact.data[0].material, false, 'exact strong identifier is continuity');

  const cased = await conflictWith(
    [signal('business_name', s.b), signal('email_exact', s.bEmail),
     signal('gbp_place_id', place.toLowerCase())],
    salonA.businessId);
  assert.equal(cased.data[0].material, true, 'case-distinct strong identifier is a contradiction');

  const junk = await conflictWith(
    [signal('business_name', s.b), signal('gbp_place_id', 'x')], salonA.businessId);
  assert.equal(junk.data, null);
  assert.match(junk.error.message, /identity_value_unacceptable/);

  const malformed = await conflictWith([null], salonA.businessId);
  assert.equal(malformed.data, null);
  assert.match(malformed.error.message, /position 0 is invalid/);
});


/* ---------- U. staff identity resolution, in real PostgreSQL ----------

   The route's own tests prove what it refuses before it reaches the
   database. This section proves the half a fake cannot: `for update` on five
   rows, a unique index deciding between two browser tabs, and a raise leaving
   nothing behind.

   Every case here is built directly rather than through ingestion, because
   what is under test is the RESOLUTION, and the case-creation paths already
   have P1-P18 to themselves. */

const AAL2 = 'aal2';

const makeOperator = async ({ role = 'identity_resolver', active = true } = {}) => {
  const userId = id();
  const { error } = await db.from('staff_operators').insert({
    user_id: userId, role,
    active, disabled_at: active ? null : new Date().toISOString()
  });
  assert.equal(error, null, 'operator seed');
  return userId;
};

/* A queued submission, its report, and an open case naming one candidate. */
const makeQueuedCase = async ({ candidates, reviewType = 'service_mix',
                                submittedAt = null, names = null,
                                conflictingSignals = [] } = {}) => {
  const s = names || salonNames(`u-${id().slice(0, 6)}`);
  const sessionId = id();
  const submissionId = id();
  const birId = id();
  const caseId = id();
  created.submissionIds.push(submissionId);

  await db.from('assessment_sessions').insert({
    assessment_session_id: sessionId, business_id: null, first_touch: {},
    review_type: reviewType
  });

  const payloadDoc = reviewType === 'service_mix'
    ? serviceMixPayload({ submissionId, sessionId })
    : payload({ submissionId, sessionId });
  const contactful = {
    ...payloadDoc,
    contact: { ...payloadDoc.contact, salonName: s.b, email: s.bEmail }
  };
  const when = submittedAt || new Date().toISOString();
  const payloadHash = createHash('sha256').update(JSON.stringify(contactful)).digest('hex');

  const { error: subError } = await db.from('assessment_submissions').insert({
    submission_id: submissionId, assessment_session_id: sessionId, business_id: null,
    assessment_version: '1.0.0', vertical_id: 'nails', raw_payload: contactful,
    identity_status: 'resolution_pending', submitted_at: when, received_at: when,
    payload_hash: payloadHash, review_type: reviewType
  });
  assert.equal(subError, null, 'submission seed');

  const { error: birError } = await db.from('business_intelligence_reports').insert({
    bir_id: birId, business_id: null, assessment_submission_id: submissionId,
    schema_version: reviewType === 'service_mix' ? 5 : 4,
    report: reviewType === 'service_mix' ? serviceMixBir() : bir(s.b),
    confidence_band: 'medium', review_type: reviewType
  });
  assert.equal(birError, null, 'bir seed');

  const { error: caseError } = await db.from('identity_resolution_cases').insert({
    identity_resolution_id: caseId, assessment_submission_id: submissionId,
    candidate_business_ids: (candidates || []).map(b => ({
      businessId: b, matchedTypes: ['email_domain'],
      verifiedStrongTypes: [], claimedStrongTypes: [] })),
    contributing_signals: [], conflicting_signals: conflictingSignals,
    confidence: 0.4, resolution_status: 'possible_duplicate',
    recommended_action: 'queue_for_review'
  });
  assert.equal(caseError, null, 'case seed');

  return { caseId, submissionId, birId, sessionId, payloadHash, names: s, submittedAt: when };
};

const signalsFor = names => [
  { type: 'business_name', normalizedValue: names.b },
  { type: 'email_exact', normalizedValue: names.bEmail }
];

const resolve = async ({ operator, caseId, target, requestId, hash, note, signals,
                         payloadHash, aal = AAL2, override = false, reason = null }) =>
  rpc('resolve_identity_case_link_existing', {
    p_operator_user_id: operator, p_aal: aal, p_case_id: caseId,
    p_target_business_id: target,
    p_resolution_request_id: requestId || id(),
    p_request_hash: hash || createHash('sha256').update(caseId + target).digest('hex'),
    p_note: note || 'Confirmed by phone with the owner.',
    p_signals: signals, p_payload_hash: payloadHash,
    p_override_conflict: override, p_override_reason: reason
  });

utcIt('U1 — the operator guard refuses everything except an active, AAL2 operator', async () => {
  const stranger = id();
  const disabled = await makeOperator({ active: false });
  const good = await makeOperator();

  const notAnOperator = await rpc('staff_identity_queue',
    { p_operator_user_id: stranger, p_aal: AAL2, p_limit: 10, p_offset: 0 });
  assert.equal(notAnOperator.data, null);
  assert.match(notAnOperator.error.message, /staff_not_an_operator/);

  const revoked = await rpc('staff_identity_queue',
    { p_operator_user_id: disabled, p_aal: AAL2, p_limit: 10, p_offset: 0 });
  assert.equal(revoked.data, null);
  assert.match(revoked.error.message, /staff_operator_disabled/);

  for (const aal of [null, 'aal1', 'AAL2', '']) {
    const weak = await rpc('staff_identity_queue',
      { p_operator_user_id: good, p_aal: aal, p_limit: 10, p_offset: 0 });
    assert.equal(weak.data, null, `aal=${aal}`);
    assert.match(weak.error.message, /staff_aal2_required/, `aal=${aal}`);
  }

  const ok = await rpc('staff_identity_queue',
    { p_operator_user_id: good, p_aal: AAL2, p_limit: 10, p_offset: 0 });
  assert.equal(ok.error, null);
  assert.ok(Array.isArray(ok.data));
});

utcIt('U2 — revocation blocks the very next call, with no token involved', async () => {
  const operator = await makeOperator();
  const before = await rpc('staff_identity_queue',
    { p_operator_user_id: operator, p_aal: AAL2, p_limit: 5, p_offset: 0 });
  assert.equal(before.error, null, 'authorized to begin with');

  await db.from('staff_operators')
    .update({ active: false, disabled_at: new Date().toISOString() })
    .eq('user_id', operator);

  const after = await rpc('staff_identity_queue',
    { p_operator_user_id: operator, p_aal: AAL2, p_limit: 5, p_offset: 0 });
  assert.equal(after.data, null);
  assert.match(after.error.message, /staff_operator_disabled/,
    'a live lookup, so nothing has to expire first');
});

utcIt('U3 — the queue lists open cases only, oldest first, with no values in it', async () => {
  const operator = await makeOperator();
  const s = salonNames('u3');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const one = await makeQueuedCase({ candidates: [salonA.businessId] });
  const two = await makeQueuedCase({ candidates: [salonA.businessId] });

  const { data, error } = await rpc('staff_identity_queue',
    { p_operator_user_id: operator, p_aal: AAL2, p_limit: 100, p_offset: 0 });
  assert.equal(error, null);

  const ids = data.map(r => r.identity_resolution_id);
  assert.ok(ids.includes(one.caseId) && ids.includes(two.caseId));
  assert.ok(ids.indexOf(one.caseId) < ids.indexOf(two.caseId), 'oldest first');
  data.forEach(r => assert.ok(r.candidate_count >= 0));

  /* No identifier value anywhere in the list — only the business LABEL the
     visitor typed, which is what the operator has to read to decide. */
  const text = JSON.stringify(data);
  assert.equal(text.includes(s.aEmail), false, 'no candidate email');
  assert.equal(text.includes(one.names.bEmail), false, 'no submitted email');

  /* Resolving one removes it from the list. */
  await resolve({ operator, caseId: one.caseId, target: salonA.businessId,
    signals: signalsFor(one.names), payloadHash: one.payloadHash,
    override: true, reason: 'verified_same_business',
    note: 'Verified with the owner that this is the same salon under a new name.' });

  const after = await rpc('staff_identity_queue',
    { p_operator_user_id: operator, p_aal: AAL2, p_limit: 100, p_offset: 0 });
  assert.equal(after.data.map(r => r.identity_resolution_id).includes(one.caseId), false);
});

utcIt('U4 — a target outside the candidate set is refused', async () => {
  const operator = await makeOperator();
  const s = salonNames('u4');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const other = await establishBusiness(`${s.a} downtown`, email('u4-other'));
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });

  const { data, error } = await resolve({ operator, caseId: c.caseId,
    target: other.businessId, signals: signalsFor(c.names), payloadHash: c.payloadHash });

  assert.equal(data, null);
  assert.match(error.message, /target_not_a_candidate/);

  const [submission] = await rows('assessment_submissions', 'submission_id', c.submissionId);
  assert.equal(submission.business_id, null, 'and nothing was attached');
});

utcIt('U5 — a merged-away target is refused, never silently followed', async () => {
  const operator = await makeOperator();
  const s = salonNames('u5');
  const survivor = await establishBusiness(s.a, s.aEmail);
  const mergedAway = await establishBusiness(`${s.a} old`, email('u5-old'));
  await db.from('business_records')
    .update({ merged_into_business_id: survivor.businessId })
    .eq('business_id', mergedAway.businessId);

  const c = await makeQueuedCase({ candidates: [mergedAway.businessId] });
  const { data, error } = await resolve({ operator, caseId: c.caseId,
    target: mergedAway.businessId, signals: signalsFor(c.names), payloadHash: c.payloadHash,
    override: true, reason: 'verified_same_business',
    note: 'Trying to resolve against a record that has since been merged away.' });

  assert.equal(data, null);
  assert.match(error.message, /target_merged_away/);

  /* And it did NOT quietly resolve against the survivor instead. */
  const survivorSubs = await rows('assessment_submissions', 'business_id', survivor.businessId);
  assert.equal(survivorSubs.some(r => r.submission_id === c.submissionId), false);
});

utcIt('U6 — a material contradiction is refused without an override and accepted with one', async () => {
  const operator = await makeOperator();
  const s = salonNames('u6');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });

  const refused = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: signalsFor(c.names), payloadHash: c.payloadHash });
  assert.equal(refused.data, null);
  assert.match(refused.error.message, /material_conflict/);

  const noReason = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: signalsFor(c.names), payloadHash: c.payloadHash, override: true });
  assert.equal(noReason.data, null);
  assert.match(noReason.error.message, /override_reason_required/);

  const thin = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: signalsFor(c.names), payloadHash: c.payloadHash,
    override: true, reason: 'other_verified_evidence', note: 'Checked it.' });
  assert.equal(thin.data, null);
  assert.match(thin.error.message, /override_note_required/);

  const done = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: signalsFor(c.names), payloadHash: c.payloadHash,
    override: true, reason: 'business_rebrand',
    note: 'Owner confirmed the rebrand and the new address by phone.' });
  assert.equal(done.error, null);
  assert.equal(done.data.ok, true);
  assert.equal(done.data.conflictOverridden, true);
  assert.equal(done.data.overrideReason, 'business_rebrand');

  /* Nothing that was refused left a trace. */
  const requests = await rows('identity_resolution_requests', 'identity_resolution_id', c.caseId);
  assert.equal(requests.length, 1, 'one ledger row, from the attempt that succeeded');
});

utcIt('U7 — an override may not be claimed when there is nothing to override', async () => {
  const operator = await makeOperator();
  const s = salonNames('u7');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });

  /* Signals that AGREE with the target: no contradiction to override. */
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];
  const { data, error } = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash,
    override: true, reason: 'verified_same_business',
    note: 'Marking an override that is not needed.' });

  assert.equal(data, null);
  assert.match(error.message, /override_not_applicable/);
});

utcIt('U8 — a clean link attaches submission and report and touches nothing else', async () => {
  const operator = await makeOperator();
  const s = salonNames('u8');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });

  const identifiersBefore = (await rows('business_identifiers', 'business_id', salonA.businessId)).length;
  const [sessionBefore] = await rows('assessment_sessions', 'assessment_session_id', c.sessionId);

  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];
  const { data, error } = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash,
    note: 'Same business; the visitor used a different address.' });

  assert.equal(error, null);
  assert.equal(data.ok, true);
  assert.equal(data.businessId, salonA.businessId);
  assert.equal(data.identityStatus, 'manually_verified');
  assert.equal(data.conflictOverridden, false);

  const [submission] = await rows('assessment_submissions', 'submission_id', c.submissionId);
  assert.equal(submission.business_id, salonA.businessId);
  assert.equal(submission.identity_status, 'manually_verified');
  assert.ok(submission.raw_payload, 'the original payload is preserved');

  const [report] = await rows('business_intelligence_reports', 'bir_id', c.birId);
  assert.equal(report.business_id, salonA.businessId);
  assert.equal(report.supersedes_bir_id, null, 'a late attachment joins no chain');

  /* NO identifier promotion. A human decision about where a review belongs is
     not a decision that every value in it is trustworthy identity evidence. */
  const identifiersAfter = await rows('business_identifiers', 'business_id', salonA.businessId);
  assert.equal(identifiersAfter.length, identifiersBefore, 'no identifier was written');
  assert.equal(identifiersAfter.some(i => i.normalized_value === c.names.bEmail), false);

  /* The session is not repointed. */
  const [sessionAfter] = await rows('assessment_sessions', 'assessment_session_id', c.sessionId);
  assert.equal(sessionAfter.business_id, sessionBefore.business_id);

  const [closed] = await rows('identity_resolution_cases', 'identity_resolution_id', c.caseId);
  assert.ok(closed.resolved_at);
  assert.equal(closed.resolved_by, operator, 'the immutable operator UUID, not an email');
  assert.equal(closed.recommended_action, 'queue_for_review', 'the engine advice is preserved');
  assert.ok(closed.resolution_notes.length > 0);
});

utcIt('U9 — events and audit carry ids and type names, never values', async () => {
  const operator = await makeOperator();
  const s = salonNames('u9');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });
  const requestId = id();

  await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    requestId, signals: signalsFor(c.names), payloadHash: c.payloadHash,
    override: true, reason: 'contact_information_changed',
    note: 'New owner, same salon; confirmed the change of contact details.' });

  const events = (await rows('timeline_events', 'business_id', salonA.businessId))
    .filter(e => e.event_name === 'identity.review_resolved');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.conflictOverridden, true);
  assert.equal(events[0].payload.overrideReason, 'contact_information_changed');
  assert.equal(events[0].payload.operatorUserId, operator);

  const audits = (await rows('audit_events', 'business_id', salonA.businessId))
    .filter(a => a.action === 'identity_resolution.link_existing');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_type, 'human');
  assert.equal(audits[0].actor_id, operator);
  assert.equal(audits[0].new_value.identityStatus, 'manually_verified');

  const text = JSON.stringify({ events, audits });
  [s.aEmail, c.names.bEmail, s.a, c.names.b].forEach(v =>
    assert.equal(text.includes(v), false, `an identifier value reached the trail: ${v}`));
});

utcIt('U10 — an older review is attached and counted but moves no pointer', async () => {
  const operator = await makeOperator();
  const s = salonNames('u10');
  const salonA = await establishBusiness(s.a, s.aEmail);

  /* Give the record a current Service Mix review. */
  const recent = await makeQueuedCase({ candidates: [salonA.businessId] });
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];
  await resolve({ operator, caseId: recent.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: recent.payloadHash, note: 'The newer review, resolved first.' });

  const [stateAfterFirst] = (await rows('business_review_states', 'business_id', salonA.businessId))
    .filter(r => r.review_type === 'service_mix');
  assert.equal(stateAfterFirst.completed_count, 1);

  /* Now an OLDER one. */
  const older = await makeQueuedCase({
    candidates: [salonA.businessId],
    submittedAt: new Date(Date.parse(recent.submittedAt) - 86400000).toISOString() });
  const second = await resolve({ operator, caseId: older.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: older.payloadHash, note: 'An older review, resolved later.' });

  assert.equal(second.error, null);
  assert.equal(second.data.becameCurrent, false);

  const [state] = (await rows('business_review_states', 'business_id', salonA.businessId))
    .filter(r => r.review_type === 'service_mix');
  assert.equal(state.completed_count, 2, 'counted exactly once each');
  assert.equal(state.current_bir_id, recent.birId, 'the pointer did not move backwards');
  assert.equal(state.latest_submission_id, recent.submissionId);

  /* And the older report IS attached, just not current. */
  const [olderReport] = await rows('business_intelligence_reports', 'bir_id', older.birId);
  assert.equal(olderReport.business_id, salonA.businessId);
});

utcIt('U11 — a newer Growth review moves the Growth pointer; Service Mix never can', async () => {
  const operator = await makeOperator();
  const s = salonNames('u11');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  const [recordBefore] = await rows('business_records', 'business_id', salonA.businessId);

  /* A Service Mix resolution must not touch business_records.current_bir_id,
     which 0006 constrains to Growth reports. */
  const mix = await makeQueuedCase({ candidates: [salonA.businessId], reviewType: 'service_mix' });
  await resolve({ operator, caseId: mix.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: mix.payloadHash, note: 'A Service Mix review, resolved.' });

  const [afterMix] = await rows('business_records', 'business_id', salonA.businessId);
  assert.equal(afterMix.current_bir_id, recordBefore.current_bir_id,
    'the Growth-only pointer was not taken by a Service Mix report');

  /* A newer GROWTH review may move it. */
  const growth = await makeQueuedCase({
    candidates: [salonA.businessId], reviewType: 'growth_review',
    submittedAt: new Date(Date.now() + 60000).toISOString() });
  const done = await resolve({ operator, caseId: growth.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: growth.payloadHash, note: 'A newer Growth review, resolved.' });

  assert.equal(done.error, null);
  assert.equal(done.data.becameCurrent, true);
  const [afterGrowth] = await rows('business_records', 'business_id', salonA.businessId);
  assert.equal(afterGrowth.current_bir_id, growth.birId);
});

utcIt('U12 — the identical request replays; the same id with a new target is refused', async () => {
  const operator = await makeOperator();
  const s = salonNames('u12');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const other = await establishBusiness(`${s.a} north`, email('u12-other'));
  const c = await makeQueuedCase({ candidates: [salonA.businessId, other.businessId] });
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  const requestId = id();
  const hash = createHash('sha256').update(`${c.caseId}|${salonA.businessId}`).digest('hex');

  const first = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    requestId, hash, signals: agreeing, payloadHash: c.payloadHash, note: 'The first attempt.' });
  assert.equal(first.error, null);
  assert.equal(first.data.replayed, false);

  const again = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    requestId, hash, signals: agreeing, payloadHash: c.payloadHash, note: 'The same attempt again.' });
  assert.equal(again.error, null);
  assert.equal(again.data.replayed, true, 'the stored outcome, not a second resolution');
  assert.equal(again.data.businessId, salonA.businessId);

  const changed = await resolve({ operator, caseId: c.caseId, target: other.businessId,
    requestId, hash: createHash('sha256').update('different').digest('hex'),
    signals: agreeing, payloadHash: c.payloadHash, note: 'The same id, a different record.' });
  assert.equal(changed.data, null);
  assert.match(changed.error.message, /resolution_request_conflict/);

  /* One resolution, one ledger row, one submission attachment. */
  assert.equal((await rows('identity_resolution_requests', 'identity_resolution_id', c.caseId)).length, 1);
  const [submission] = await rows('assessment_submissions', 'submission_id', c.submissionId);
  assert.equal(submission.business_id, salonA.businessId);
});

utcIt('U13 — an already-resolved case cannot be redirected to another record', async () => {
  const operator = await makeOperator();
  const s = salonNames('u13');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const other = await establishBusiness(`${s.a} east`, email('u13-other'));
  const c = await makeQueuedCase({ candidates: [salonA.businessId, other.businessId] });
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'Resolved to the first record.' });

  /* A different request id, a different target, the same case. */
  const second = await resolve({ operator, caseId: c.caseId, target: other.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'Trying to move it afterwards.' });
  assert.equal(second.data, null);
  assert.ok(/case_already_resolved|duplicate key/.test(second.error.message),
    `unexpected: ${second.error.message}`);

  const [submission] = await rows('assessment_submissions', 'submission_id', c.submissionId);
  assert.equal(submission.business_id, salonA.businessId, 'still where it was put');
});

utcIt('U14 — evidence that does not belong to the submission is refused', async () => {
  const operator = await makeOperator();
  const s = salonNames('u14');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });

  const { data, error } = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: [{ type: 'business_name', normalizedValue: s.a }],
    payloadHash: 'not-the-hash-of-this-submission', note: 'Evidence from somewhere else.' });

  assert.equal(data, null);
  assert.match(error.message, /signals_payload_mismatch/);
});

utcIt('U15 — every refusal rolls the whole transaction back', async () => {
  const operator = await makeOperator();
  const s = salonNames('u15');
  const salonA = await establishBusiness(s.a, s.aEmail);

  const snapshot = async () => ({
    submissions: (await rows('assessment_submissions', 'business_id', salonA.businessId)).length,
    reports: (await rows('business_intelligence_reports', 'business_id', salonA.businessId)).length,
    identifiers: (await rows('business_identifiers', 'business_id', salonA.businessId)).length,
    timeline: (await rows('timeline_events', 'business_id', salonA.businessId)).length,
    audit: (await rows('audit_events', 'business_id', salonA.businessId)).length,
    states: (await rows('business_review_states', 'business_id', salonA.businessId)).length,
    record: (await rows('business_records', 'business_id', salonA.businessId))[0].current_bir_id
  });

  const before = await snapshot();

  /* One refusal from each stage of the function, in order. */
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });
  const attempts = [
    ['not an operator', { operator: id() }],
    ['aal1', { aal: 'aal1' }],
    ['note too short', { note: 'no' }],
    ['target not a candidate', { target: id() }],
    ['bad payload hash', { payloadHash: 'wrong' }],
    ['material conflict, no override', {}]
  ];

  for (const [label, over] of attempts) {
    const { data, error } = await resolve({
      operator, caseId: c.caseId, target: salonA.businessId,
      signals: signalsFor(c.names), payloadHash: c.payloadHash, ...over });
    assert.equal(data, null, label);
    assert.ok(error, label);

    const after = await snapshot();
    assert.deepEqual(after, before, `${label} left something behind`);

    const [stillOpen] = await rows('identity_resolution_cases', 'identity_resolution_id', c.caseId);
    assert.equal(stillOpen.resolved_at, null, `${label} closed the case`);
    assert.deepEqual(
      await rows('identity_resolution_requests', 'identity_resolution_id', c.caseId), [],
      `${label} wrote a ledger row`);
  }
});

utcIt('U16 — two competing resolutions cannot both succeed', async () => {
  /* PGlite is single-connection, so this cannot be raced. What it CAN prove
     is the mechanism that decides a race: irr_one_per_case is a unique index,
     so the second writer is refused by the database rather than by whichever
     browser happened to ask second. Recorded honestly as structural.
     A hosted, multi-connection run is still owed. */
  const operator = await makeOperator();
  const s = salonNames('u16');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const other = await establishBusiness(`${s.a} west`, email('u16-other'));
  const c = await makeQueuedCase({ candidates: [salonA.businessId, other.businessId] });
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  const first = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'Tab one resolves.' });
  assert.equal(first.error, null);

  const second = await resolve({ operator, caseId: c.caseId, target: other.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'Tab two, a moment later.' });
  assert.equal(second.data, null);
  assert.ok(second.error);

  const { rows: idx } = await localEnv.pg.query(
    "select indexdef from pg_indexes where indexname = 'irr_one_per_case'");
  assert.match(idx[0].indexdef, /unique/i);
  assert.match(idx[0].indexdef, /identity_resolution_id/);

  assert.equal((await rows('identity_resolution_requests', 'identity_resolution_id', c.caseId)).length, 1);
});

utcIt('U17 — the case detail masks contact values and warns about merged candidates', async () => {
  const operator = await makeOperator();
  const s = salonNames('u17');
  const survivor = await establishBusiness(s.a, s.aEmail);
  const gone = await establishBusiness(`${s.a} old site`, email('u17-old'));
  await db.from('business_records')
    .update({ merged_into_business_id: survivor.businessId })
    .eq('business_id', gone.businessId);

  const c = await makeQueuedCase({ candidates: [survivor.businessId, gone.businessId] });

  const { data, error } = await rpc('staff_identity_case',
    { p_operator_user_id: operator, p_aal: AAL2, p_case_id: c.caseId });
  assert.equal(error, null);

  assert.equal(data.caseId, c.caseId);
  assert.equal(data.resolvable, true);
  assert.equal(data.submitted.label, c.names.b, 'the business label is shown');
  assert.notEqual(data.submitted.email, c.names.bEmail, 'the email is not');
  assert.match(data.submitted.email, /^.\*\*\*@.\*\*\*\./, 'it is masked, in SQL');

  const merged = data.candidates.find(x => x.businessId === gone.businessId);
  assert.equal(merged.mergedAway, true, 'the operator is warned before choosing');
  const kept = data.candidates.find(x => x.businessId === survivor.businessId);
  assert.equal(kept.mergedAway, false);

  /* An unresolvable case says so rather than offering a control that fails. */
  const empty = await makeQueuedCase({ candidates: [] });
  const { data: detail } = await rpc('staff_identity_case',
    { p_operator_user_id: operator, p_aal: AAL2, p_case_id: empty.caseId });
  assert.equal(detail.resolvable, false);
  assert.match(detail.unsupportedReason, /names no Business Record at all/);
});

utcIt('U18 — anon and authenticated can reach none of it', async () => {
  const objects = [
    ['staff_operators', 'table'], ['identity_resolution_requests', 'table'],
    ['staff_identity_queue(uuid,text,integer,integer)', 'function'],
    ['staff_identity_case(uuid,text,uuid)', 'function'],
    ['staff_operator_guard(uuid,text)', 'function'],
    ['resolve_identity_case_link_existing(uuid,text,uuid,uuid,uuid,text,text,jsonb,text,boolean,text)', 'function']
  ];

  for (const [name, kind] of objects) {
    for (const role of ['anon', 'authenticated', 'public']) {
      const q = kind === 'table'
        ? `select bool_or(has_table_privilege($1, 'public.${name}', p)) any_priv
             from unnest(array['select','insert','update','delete']) p`
        : `select has_function_privilege($1, 'public.${name}', 'EXECUTE') any_priv`;
      const { rows: r } = await localEnv.pg.query(q, [role]);
      assert.equal(r[0].any_priv, false, `${role} can reach ${name}`);
    }
    if (kind === 'function') {
      const { rows: r } = await localEnv.pg.query(
        `select has_function_privilege('service_role', 'public.${name}', 'EXECUTE') p`);
      assert.equal(r[0].p, true, `service_role cannot execute ${name}`);
    }
  }

  /* The internals hold NO grant, service_role included. Each is called only
     from inside a SECURITY DEFINER function above, which runs it as the
     owner. identity_case_eligible_targets is the one that matters: it answers
     "which Business Records may this case attach to", and a direct grant
     would let the server credential ask that with no operator guard in front
     of it — the objection 0006 raises against granting
     identity_proposal_conflict, which applies here word for word. */
  const internals = [
    'identity_case_eligible_targets(uuid)',
    'mask_contact_value(text)',
    'identity_resolution_replay(identity_resolution_requests, text, uuid)',
    'reject_case_evidence_change()'
  ];
  for (const name of internals) {
    for (const role of ['anon', 'authenticated', 'public', 'service_role']) {
      const { rows: r } = await localEnv.pg.query(
        `select has_function_privilege($1, 'public.${name}', 'EXECUTE') p`, [role]);
      assert.equal(r[0].p, false, `${role} holds a grant on the internal helper ${name}`);
    }
  }

  /* But they still WORK where they are actually called from, which is what
     makes revoking them safe rather than merely tidy. */
  const operator = await makeOperator();
  const c = await makeQueuedCase({ candidates: [] });
  const { error: stillWorks } = await rpc('staff_identity_case',
    { p_operator_user_id: operator, p_aal: AAL2, p_case_id: c.caseId });
  assert.equal(stillWorks, null,
    'staff_identity_case calls both revoked helpers and is unaffected');

  /* RLS is on and FORCED on both new tables, with no policy to soften it. */
  const { rows: rls } = await localEnv.pg.query(
    `select relname, relrowsecurity, relforcerowsecurity,
            (select count(*) from pg_policy p where p.polrelid = c.oid) policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and relname in ('staff_operators','identity_resolution_requests')`);
  assert.equal(rls.length, 2);
  rls.forEach(t => {
    assert.equal(t.relrowsecurity, true, t.relname);
    assert.equal(t.relforcerowsecurity, true, t.relname);
    assert.equal(Number(t.policies), 0, t.relname);
  });
});


/* ---------- V. proposed targets, and the durable operator reference ----------

   A candidate-only eligible set made the two commonest escalations —
   a contradicted proposal, and two proposals naming different records —
   permanently unresolvable, because neither reaches the candidate lookup and
   both leave `candidate_business_ids` empty. The record each of them named is
   persisted in `conflicting_signals`, and section V is where that widening is
   held to the same standard as everything else: derived in SQL, from this
   case's own evidence, with malformed entries ignored and merged-away targets
   still refused. */

/* A case whose ONLY evidence is a vetoed proposal — no candidate at all,
   which is exactly the shape ingest_review produces for a contradicted
   session or continuation context. */
const makeVetoedCase = ({ proposed, kind = 'session_contradicted' } = {}) =>
  makeQueuedCase({ candidates: [], conflictingSignals: [{
    kind,
    proposedBusinessId: proposed,
    agreedTypes: [],
    contradictedTypes: ['business_name', 'email_exact'],
    reason: 'The submitted business name and contact evidence match nothing this record holds.'
  }] });

const makeDisagreedCase = ({ first, second } = {}) =>
  makeQueuedCase({ candidates: [], conflictingSignals: [{
    kind: 'proposals_disagree',
    proposedBusinessIds: [first, second],
    reason: 'The session and the continuation context name different records.'
  }] });

const eligible = async caseId =>
  (await localEnv.pg.query(
    'select business_id, provenance from public.identity_case_eligible_targets($1) order by provenance, business_id',
    [caseId])).rows;

utcIt('V1 — a vetoed proposal makes its record eligible, with its provenance', async () => {
  const s = salonNames('v1');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeVetoedCase({ proposed: salonA.businessId });

  /* The candidate array really is empty: this is the shape that used to be
     permanently unresolvable. */
  const [row] = await rows('identity_resolution_cases', 'identity_resolution_id', c.caseId);
  assert.deepEqual(row.candidate_business_ids, []);

  const targets = await eligible(c.caseId);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].business_id, salonA.businessId);
  assert.equal(targets[0].provenance, 'proposal_vetoed');
});

utcIt('V2 — a vetoed target still needs the documented override to be linked', async () => {
  const operator = await makeOperator();
  const s = salonNames('v2');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeVetoedCase({ proposed: salonA.businessId });

  /* The submission describes a different business, which is why it was
     vetoed in the first place — so the conflict rule still says material. */
  const refused = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: signalsFor(c.names), payloadHash: c.payloadHash });
  assert.equal(refused.data, null);
  assert.match(refused.error.message, /material_conflict/,
    'widening WHICH records are eligible did not widen what may be linked without an override');

  const noReason = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: signalsFor(c.names), payloadHash: c.payloadHash, override: true });
  assert.equal(noReason.data, null);
  assert.match(noReason.error.message, /override_reason_required/);

  const done = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: signalsFor(c.names), payloadHash: c.payloadHash,
    override: true, reason: 'source_information_incorrect',
    note: 'The visitor mistyped the salon name; confirmed by phone it is the same business.' });
  assert.equal(done.error, null);
  assert.equal(done.data.targetProvenance, 'proposal_vetoed');
  assert.equal(done.data.conflictOverridden, true);
});

utcIt('V3 — both disagreeing proposals are eligible, and exactly one may be chosen', async () => {
  const operator = await makeOperator();
  const s = salonNames('v3');
  const one = await establishBusiness(s.a, s.aEmail);
  const two = await establishBusiness(`${s.a} north`, email('v3-two'));
  const c = await makeDisagreedCase({ first: one.businessId, second: two.businessId });

  const targets = await eligible(c.caseId);
  assert.equal(targets.length, 2);
  assert.deepEqual([...new Set(targets.map(t => t.provenance))], ['proposals_disagreed']);
  assert.deepEqual(targets.map(t => t.business_id).sort(),
    [one.businessId, two.businessId].sort());

  /* Choosing the second is as legitimate as choosing the first: neither
     contradicts, which is why nobody could choose automatically. */
  const agreeing = [{ type: 'business_name', normalizedValue: `${s.a} north` },
                    { type: 'email_exact', normalizedValue: email('v3-two') }];
  const done = await resolve({ operator, caseId: c.caseId, target: two.businessId,
    signals: agreeing, payloadHash: c.payloadHash,
    note: 'Confirmed this is the second location, not the first.' });
  assert.equal(done.error, null);
  assert.equal(done.data.businessId, two.businessId);
  assert.equal(done.data.targetProvenance, 'proposals_disagreed');
  assert.equal(done.data.conflictOverridden, false, 'no override needed when nothing contradicts');

  /* And the case is now closed to the other one. */
  const after = await resolve({ operator, caseId: c.caseId, target: one.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'Trying the other record afterwards.' });
  assert.equal(after.data, null);
  assert.ok(after.error);
});

utcIt('V4 — a third record is refused however plausible it looks', async () => {
  const operator = await makeOperator();
  const s = salonNames('v4');
  const one = await establishBusiness(s.a, s.aEmail);
  const two = await establishBusiness(`${s.a} south`, email('v4-two'));
  const stranger = await establishBusiness(`${s.a} west`, email('v4-three'));
  const c = await makeDisagreedCase({ first: one.businessId, second: two.businessId });

  const agreeing = [{ type: 'business_name', normalizedValue: `${s.a} west` },
                    { type: 'email_exact', normalizedValue: email('v4-three') }];
  const { data, error } = await resolve({ operator, caseId: c.caseId,
    target: stranger.businessId, signals: agreeing, payloadHash: c.payloadHash,
    note: 'A record this case never named.' });

  assert.equal(data, null);
  assert.match(error.message, /target_not_a_candidate/);
  assert.equal((await eligible(c.caseId)).some(t => t.business_id === stranger.businessId), false);
});

utcIt('V5 — malformed or unrecognized proposed-target data is ignored, not obeyed', async () => {
  const s = salonNames('v5');
  const salonA = await establishBusiness(s.a, s.aEmail);
  /* Everything a corrupted or hand-edited evidence array could contain,
     alongside one good entry. The good one must survive; none of the rest
     may become a target, and none may abort the derivation. */
  const c = await makeQueuedCase({ candidates: [], conflictingSignals: [
      { kind: 'session_contradicted', proposedBusinessId: 'not-a-uuid' },
      { kind: 'session_contradicted', proposedBusinessId: '' },
      { kind: 'session_contradicted', proposedBusinessId: null },
      { kind: 'session_contradicted', proposedBusinessId: 42 },
      { kind: 'session_contradicted' },
      { kind: 'some_other_kind', proposedBusinessId: id() },
      { kind: 'proposals_disagree', proposedBusinessIds: ['nope', 7, null] },
      { kind: 'proposals_disagree' },
      'a bare string',
      42,
      null,
      { kind: 'continuation_context_contradicted', proposedBusinessId: salonA.businessId }
    ] });

  const targets = await eligible(c.caseId);
  assert.equal(targets.length, 1, 'exactly the one well-formed entry');
  assert.equal(targets[0].business_id, salonA.businessId);
  assert.equal(targets[0].provenance, 'proposal_vetoed');

  /* An unrecognized `kind` is not a target even when its uuid is perfectly
     well formed — the vocabulary is the gate, not the shape. */
  const unknownKind = await makeQueuedCase({ candidates: [],
    conflictingSignals: [{ kind: 'invented_kind', proposedBusinessId: salonA.businessId }] });
  assert.deepEqual(await eligible(unknownKind.caseId), []);
});

utcIt('V6 — a merged-away or missing proposed target is still refused', async () => {
  const operator = await makeOperator();
  const s = salonNames('v6');
  const survivor = await establishBusiness(s.a, s.aEmail);
  const gone = await establishBusiness(`${s.a} old`, email('v6-old'));
  await db.from('business_records')
    .update({ merged_into_business_id: survivor.businessId })
    .eq('business_id', gone.businessId);

  const c = await makeVetoedCase({ proposed: gone.businessId });

  /* Eligible by evidence — and refused by state. The two are different facts
     and the operator is told which one applies. */
  assert.equal((await eligible(c.caseId)).length, 1);

  const { data, error } = await resolve({ operator, caseId: c.caseId, target: gone.businessId,
    signals: signalsFor(c.names), payloadHash: c.payloadHash,
    override: true, reason: 'verified_same_business',
    note: 'Attempting to resolve against a record that has since been merged away.' });
  assert.equal(data, null);
  assert.match(error.message, /target_merged_away/);

  /* And it was not silently redirected to the survivor. */
  const survivorSubs = await rows('assessment_submissions', 'business_id', survivor.businessId);
  assert.equal(survivorSubs.some(r => r.submission_id === c.submissionId), false);
});

utcIt('V7 — a case naming nothing at all stays open and says so', async () => {
  const operator = await makeOperator();
  const c = await makeQueuedCase({ candidates: [] });

  assert.deepEqual(await eligible(c.caseId), []);

  const { data } = await rpc('staff_identity_case',
    { p_operator_user_id: operator, p_aal: AAL2, p_case_id: c.caseId });
  assert.equal(data.resolvable, false);
  assert.deepEqual(data.candidates, []);
  assert.match(data.unsupportedReason, /names no Business Record at all/);

  const { data: queue } = await rpc('staff_identity_queue',
    { p_operator_user_id: operator, p_aal: AAL2, p_limit: 100, p_offset: 0 });
  const row = queue.find(r => r.identity_resolution_id === c.caseId);
  assert.equal(row.resolvable, false);
  assert.equal(Number(row.candidate_count), 0);
});

utcIt('V8 — the detail offers a vetoed target and labels why it is offered', async () => {
  const operator = await makeOperator();
  const s = salonNames('v8');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeVetoedCase({ proposed: salonA.businessId,
    kind: 'continuation_context_contradicted' });

  const { data, error } = await rpc('staff_identity_case',
    { p_operator_user_id: operator, p_aal: AAL2, p_case_id: c.caseId });
  assert.equal(error, null);
  assert.equal(data.resolvable, true);
  assert.equal(data.candidates.length, 1);
  assert.equal(data.candidates[0].businessId, salonA.businessId);
  assert.equal(data.candidates[0].provenance, 'proposal_vetoed');
  assert.deepEqual(data.candidates[0].matchedTypes, [],
    'a proposed target shares no identifier — that is why it was contradicted');

  /* Still no identifier value in the detail. */
  const text = JSON.stringify(data);
  assert.equal(text.includes(s.aEmail), false);
  assert.equal(text.includes(c.names.bEmail), false);
});

utcIt('V9 — provenance reaches the audit trail without any evidence value', async () => {
  const operator = await makeOperator();
  const s = salonNames('v9');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeVetoedCase({ proposed: salonA.businessId });

  await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: signalsFor(c.names), payloadHash: c.payloadHash,
    override: true, reason: 'business_rebrand',
    note: 'Owner confirmed the rebrand; the saved pointer was right after all.' });

  const [audit] = (await rows('audit_events', 'business_id', salonA.businessId))
    .filter(a => a.action === 'identity_resolution.link_existing');
  assert.equal(audit.new_value.targetProvenance, 'proposal_vetoed');
  assert.equal(audit.new_value.conflictOverridden, true);
  assert.equal(audit.new_value.overrideReason, 'business_rebrand');

  const [event] = (await rows('timeline_events', 'business_id', salonA.businessId))
    .filter(e => e.event_name === 'identity.review_resolved');
  assert.equal(event.payload.targetProvenance, 'proposal_vetoed');

  const text = JSON.stringify({ audit, event });
  [s.a, s.aEmail, c.names.b, c.names.bEmail].forEach(v =>
    assert.equal(text.includes(v), false, `an identifier value reached the trail: ${v}`));

  /* The three provenance values are the whole vocabulary. */
  assert.ok(['candidate_set', 'proposal_vetoed', 'proposals_disagreed']
    .includes(audit.new_value.targetProvenance));
});

utcIt('V10 — a candidate-set resolution is unchanged, and still labelled candidate_set', async () => {
  const operator = await makeOperator();
  const s = salonNames('v10');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });

  const targets = await eligible(c.caseId);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].provenance, 'candidate_set');

  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];
  const { data, error } = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'The ordinary candidate path.' });

  assert.equal(error, null);
  assert.equal(data.targetProvenance, 'candidate_set');
  assert.equal(data.identityStatus, 'manually_verified');
});

/* ---------- the durable operator reference ---------- */

utcIt('V11 — a resolution sets both operator columns, and they agree', async () => {
  const operator = await makeOperator();
  const s = salonNames('v11');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'Recording who did this.' });

  const [row] = await rows('identity_resolution_cases', 'identity_resolution_id', c.caseId);
  assert.equal(row.resolved_by_operator_id, operator, 'the real reference');
  assert.equal(row.resolved_by, operator, 'and the legacy text column, identical');
  assert.equal(row.resolved_by, row.resolved_by_operator_id);

  const [audit] = (await rows('audit_events', 'business_id', salonA.businessId))
    .filter(a => a.action === 'identity_resolution.link_existing');
  assert.equal(audit.actor_id, operator, 'and the audit actor agrees with both');
  assert.equal(audit.actor_type, 'human');
});

utcIt('V12 — the two operator columns cannot be written apart', async () => {
  const operator = await makeOperator();
  const other = await makeOperator();
  const c = await makeQueuedCase({ candidates: [] });

  const disagree = await localEnv.pg.query(
    `update public.identity_resolution_cases
        set resolved_at = now(), resolved_by = $1, resolved_by_operator_id = $2
      where identity_resolution_id = $3`, [other, operator, c.caseId])
    .then(() => null, err => err);

  assert.ok(disagree, 'the constraint must refuse a disagreement');
  assert.match(disagree.message, /irc_resolved_by_agreement/);
});

utcIt('V13 — an unknown operator cannot satisfy the reference', async () => {
  const c = await makeQueuedCase({ candidates: [] });
  const stranger = id();

  const orphan = await localEnv.pg.query(
    `update public.identity_resolution_cases
        set resolved_at = now(), resolved_by = $1::text, resolved_by_operator_id = $1::uuid
      where identity_resolution_id = $2`, [stranger, c.caseId])
    .then(() => null, err => err);

  assert.ok(orphan);
  assert.match(orphan.message, /irc_resolved_by_operator_fk|foreign key/i);
});

utcIt('V14 — a referenced operator cannot be deleted, but may be disabled', async () => {
  const operator = await makeOperator();
  const s = salonNames('v14');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'A resolution to be protected.' });

  const deletion = await localEnv.pg.query(
    'delete from public.staff_operators where user_id = $1', [operator])
    .then(() => null, err => err);
  assert.ok(deletion, 'an operator in the audit trail may not be deleted');
  assert.match(deletion.message, /irc_resolved_by_operator_fk|foreign key|violates/i);

  /* Renumbering is refused too — ON UPDATE RESTRICT. */
  const renumber = await localEnv.pg.query(
    'update public.staff_operators set user_id = $1 where user_id = $2', [id(), operator])
    .then(() => null, err => err);
  assert.ok(renumber, 'nor renumbered out from under the record');

  /* Disabling is how an operator leaves, and history survives it. */
  const { error } = await db.from('staff_operators')
    .update({ active: false, disabled_at: new Date().toISOString() })
    .eq('user_id', operator);
  assert.equal(error, null, 'deactivation must work');

  const [row] = await rows('identity_resolution_cases', 'identity_resolution_id', c.caseId);
  assert.equal(row.resolved_by_operator_id, operator, 'the history is preserved');

  /* And that operator can do nothing further. */
  const next = await makeQueuedCase({ candidates: [salonA.businessId] });
  const after = await resolve({ operator, caseId: next.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: next.payloadHash, note: 'A revoked operator trying again.' });
  assert.equal(after.data, null);
  assert.match(after.error.message, /staff_operator_disabled/);
});

utcIt('V15 — an EARLY refusal rolls back the operator reference with everything else', async () => {
  const operator = await makeOperator();
  const s = salonNames('v15');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeVetoedCase({ proposed: salonA.businessId });

  /* Refused at the conflict check, which is step 7 — BEFORE the submission,
     report and review-state writes at steps 8 to 10. So this proves that an
     early refusal leaves nothing behind, and nothing more than that. The
     harder case, a failure AFTER those writes, is V17. */
  const { data, error } = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: signalsFor(c.names), payloadHash: c.payloadHash });
  assert.equal(data, null);
  assert.match(error.message, /material_conflict/);

  const [row] = await rows('identity_resolution_cases', 'identity_resolution_id', c.caseId);
  assert.equal(row.resolved_at, null);
  assert.equal(row.resolved_by, null);
  assert.equal(row.resolved_by_operator_id, null, 'the reference rolled back too');

  const [submission] = await rows('assessment_submissions', 'submission_id', c.submissionId);
  assert.equal(submission.business_id, null);
  assert.equal(submission.identity_status, 'resolution_pending');
  const [report] = await rows('business_intelligence_reports', 'bir_id', c.birId);
  assert.equal(report.business_id, null);
  assert.deepEqual(await rows('identity_resolution_requests', 'identity_resolution_id', c.caseId), []);
});

utcIt('V16 — case evidence is immutable once written', async () => {
  const s = salonNames('v16');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });

  /* The eligible set is derived from these two columns, so a write to either
     is a write to "what may this resolve against". Refused at the database. */
  for (const [column, value] of [
    ['candidate_business_ids', JSON.stringify([{ businessId: id() }])],
    ['conflicting_signals', JSON.stringify([{ kind: 'session_contradicted', proposedBusinessId: id() }])],
    ['recommended_action', 'link_to_existing'],
    ['resolution_status', 'unique_match']
  ]) {
    const attempt = await localEnv.pg.query(
      `update public.identity_resolution_cases set ${column} = $1
        where identity_resolution_id = $2`, [value, c.caseId])
      .then(() => null, err => err);
    assert.ok(attempt, `${column} must be immutable`);
    assert.match(attempt.message, /case_evidence_immutable/, column);
  }

  /* Resolving the case still works — only the evidence is frozen. */
  const operator = await makeOperator();
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];
  const { error } = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'Closing a case whose evidence is frozen.' });
  assert.equal(error, null);
});

utcIt('V17 — a failure AFTER the writes rolls every one of them back', async () => {
  /* THE TEST V15 WAS DESCRIBED AS AND WAS NOT.
     V15 refuses at step 7, before anything is written, so it proves only that
     a validation failure writes nothing — which is not in doubt. The claim
     that matters is the other one: that a failure occurring once the
     submission, the report, the review state, both pointers, the case
     resolution and the events are ALL already written still leaves the
     database exactly as it was.

     The only production path that fails that late is the ledger insert at
     step 14 losing a race on irr_one_per_case, and PGlite has one connection
     so that race cannot be run. A trigger on the ledger table reproduces the
     failure at precisely the same point, deterministically. It is installed
     for this test and dropped in the same test, so nothing else can see it. */
  const operator = await makeOperator();
  const s = salonNames('v17');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  /* Give the record a review state and a current pointer first, so the test
     can prove the pointers do not MOVE rather than merely do not appear. */
  const first = await makeQueuedCase({ candidates: [salonA.businessId], reviewType: 'growth_review' });
  const seeded = await resolve({ operator, caseId: first.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: first.payloadHash, note: 'Seeding a current pointer.' });
  assert.equal(seeded.error, null);

  const c = await makeQueuedCase({
    candidates: [salonA.businessId], reviewType: 'growth_review',
    submittedAt: new Date(Date.now() + 120000).toISOString() });

  const snapshot = async () => ({
    submission: (await rows('assessment_submissions', 'submission_id', c.submissionId))[0],
    report: (await rows('business_intelligence_reports', 'bir_id', c.birId))[0],
    case: (await rows('identity_resolution_cases', 'identity_resolution_id', c.caseId))[0],
    states: await rows('business_review_states', 'business_id', salonA.businessId),
    record: (await rows('business_records', 'business_id', salonA.businessId))[0],
    timeline: (await rows('timeline_events', 'business_id', salonA.businessId)).length,
    audit: (await rows('audit_events', 'business_id', salonA.businessId)).length,
    ledger: await rows('identity_resolution_requests', 'identity_resolution_id', c.caseId),
    identifiers: (await rows('business_identifiers', 'business_id', salonA.businessId)).length
  });

  const before = await snapshot();
  /* Preconditions, so a vacuous pass is impossible: this resolution WOULD
     move the pointer if it were allowed to commit. */
  assert.ok(before.record.current_bir_id, 'the record already has a current Growth report');
  assert.notEqual(before.record.current_bir_id, c.birId);
  assert.equal(before.submission.business_id, null);
  assert.deepEqual(before.ledger, []);

  await localEnv.pg.exec(`
    create or replace function pg_temp_v17_fail() returns trigger
    language plpgsql as $fn$
    begin
      raise exception 'v17_injected_late_failure' using errcode = 'raise_exception';
    end;
    $fn$;
    create trigger v17_late_failure
      before insert on public.identity_resolution_requests
      for each row execute function pg_temp_v17_fail();`);

  let failed;
  try {
    failed = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
      signals: agreeing, payloadHash: c.payloadHash,
      note: 'This one dies at the very last statement.' });
  } finally {
    await localEnv.pg.exec(`
      drop trigger if exists v17_late_failure on public.identity_resolution_requests;
      drop function if exists pg_temp_v17_fail();`);
  }

  assert.equal(failed.data, null);
  assert.match(failed.error.message, /v17_injected_late_failure/,
    'the injected failure is the one that fired, at step 14');

  const after = await snapshot();

  /* Every write the function had already made, undone. */
  assert.equal(after.submission.business_id, null, 'the submission was not attached');
  assert.equal(after.submission.identity_status, 'resolution_pending');
  assert.equal(after.report.business_id, null, 'the report was not attached');
  assert.equal(after.case.resolved_at, null, 'the case was not closed');
  assert.equal(after.case.resolved_by, null);
  assert.equal(after.case.resolved_by_operator_id, null, 'nor the operator reference written');
  assert.deepEqual(after.ledger, [], 'and no ledger row survived');

  /* The pointers did not move, and the counts did not creep. */
  assert.equal(after.record.current_bir_id, before.record.current_bir_id,
    'the Growth pointer stayed where it was');
  assert.deepEqual(
    after.states.map(r => [r.review_type, r.completed_count, r.current_bir_id,
                           r.latest_submission_id, r.last_completed_at]).sort(),
    before.states.map(r => [r.review_type, r.completed_count, r.current_bir_id,
                            r.latest_submission_id, r.last_completed_at]).sort(),
    'review state — count, pointer, latest submission and completion time — is unchanged');

  /* Append-only history gained nothing. It cannot be cleaned up afterwards,
     so a rollback that missed it would be permanent. */
  assert.equal(after.timeline, before.timeline, 'no timeline event survived');
  assert.equal(after.audit, before.audit, 'no audit event survived');
  assert.equal(after.identifiers, before.identifiers, 'and still no identifier promotion');

  /* And the case is genuinely still workable afterwards. */
  const retry = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'And now it succeeds normally.' });
  assert.equal(retry.error, null);
  assert.equal(retry.data.ok, true);
});

utcIt('V18 — a concurrent identical retry replays instead of colliding', async () => {
  /* The ledger is read at step 1 and written at step 14. Two simultaneous
     sends of ONE retry both find no ledger row at step 1; the loser then
     waits on the case lock and arrives after the winner has committed.
     Without the recheck it raised `case_already_resolved` — turning the
     idempotent replay the contract promises into a conflict, purely because
     the two overlapped.

     PGlite cannot run them simultaneously. What it CAN run is the loser's
     exact position: same request id, same inputs, arriving at a case that is
     already resolved. That is the state the recheck exists for. */
  const operator = await makeOperator();
  const s = salonNames('v18');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  const requestId = id();
  const hash = createHash('sha256').update(`${c.caseId}|${salonA.businessId}|${operator}`).digest('hex');
  const send = () => resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    requestId, hash, signals: agreeing, payloadHash: c.payloadHash, note: 'One retry, sent twice.' });

  const first = await send();
  assert.equal(first.error, null);
  assert.equal(first.data.replayed, false);

  const second = await send();
  assert.equal(second.error, null, `the overlapping half must replay: ${second.error?.message}`);
  assert.equal(second.data.replayed, true);
  assert.equal(second.data.businessId, salonA.businessId);
  assert.equal(second.data.caseId, first.data.caseId);

  /* One resolution, whatever the caller did. */
  assert.equal((await rows('identity_resolution_requests', 'identity_resolution_id', c.caseId)).length, 1);
  const events = (await rows('timeline_events', 'business_id', salonA.businessId))
    .filter(e => e.event_name === 'identity.review_resolved');
  assert.equal(events.length, 1, 'and exactly one event, not one per send');
});

utcIt('V19 — a second operator cannot inherit another operator\'s replay', async () => {
  const operator = await makeOperator();
  const other = await makeOperator();
  const s = salonNames('v19');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  const requestId = id();
  const hash = createHash('sha256').update('identical-inputs').digest('hex');

  const first = await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    requestId, hash, signals: agreeing, payloadHash: c.payloadHash, note: 'The first operator resolves.' });
  assert.equal(first.error, null);

  /* Same request id, same hash, DIFFERENT operator. The route folds the
     operator into the hash so this shape should be unreachable through it;
     the database refuses it independently, which is the point. */
  const stolen = await resolve({ operator: other, caseId: c.caseId, target: salonA.businessId,
    requestId, hash, signals: agreeing, payloadHash: c.payloadHash, note: 'A second operator, same id.' });

  assert.equal(stolen.data, null);
  assert.match(stolen.error.message, /resolution_request_conflict/,
    'a resolution is attributed to a person; it is not inheritable');

  /* And the attribution on record is still the first operator's. */
  const [row] = await rows('identity_resolution_cases', 'identity_resolution_id', c.caseId);
  assert.equal(row.resolved_by_operator_id, operator);
  const [ledger] = await rows('identity_resolution_requests', 'identity_resolution_id', c.caseId);
  assert.equal(ledger.operator_user_id, operator);
});

utcIt('V20 — a resolved case reports itself unresolvable rather than offering a dead control', async () => {
  const operator = await makeOperator();
  const s = salonNames('v20');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  const open = await rpc('staff_identity_case',
    { p_operator_user_id: operator, p_aal: AAL2, p_case_id: c.caseId });
  assert.equal(open.data.resolvable, true, 'resolvable while it is open');
  assert.equal(open.data.unsupportedReason, null);

  await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note: 'Closing this one.' });

  const closed = await rpc('staff_identity_case',
    { p_operator_user_id: operator, p_aal: AAL2, p_case_id: c.caseId });
  assert.equal(closed.error, null, 'a resolved case can still be READ');
  assert.equal(closed.data.resolvable, false,
    'but it is not resolvable, whatever its evidence still names');
  assert.match(closed.data.unsupportedReason, /already resolved/);
  assert.ok(closed.data.resolvedAt, 'and it says when');
  /* The evidence is still there; only the verdict changed. */
  assert.equal(closed.data.candidates.length, 1);
});

/* ---------- W. provisioning the first operator ---------- */

utcIt('W1 — the bootstrap creates exactly one owner and refuses to do it twice', async () => {
  /* Runs against a database where earlier sections have already created
     operators, so it exercises the "already done" path first — which is the
     path that matters, because it is the one that stops a second person
     making themselves an owner. */
  const existing = (await localEnv.pg.query('select count(*)::int n from public.staff_operators')).rows[0].n;
  assert.ok(existing > 0, 'precondition: operators exist by now');

  const stranger = id();
  const refused = await rpc('bootstrap_staff_owner', { p_user_id: stranger });
  assert.equal(refused.data, null);
  assert.match(refused.error.message, /staff_bootstrap_already_done/,
    'a bootstrap is not a provisioning API');

  assert.deepEqual(await rows('staff_operators', 'user_id', stranger), [],
    'and nothing was written');

  const nulled = await rpc('bootstrap_staff_owner', { p_user_id: null });
  assert.equal(nulled.data, null);
  assert.match(nulled.error.message, /staff_bootstrap_user_required/);
});

utcIt('W2 — on an empty table the bootstrap creates one owner, idempotently', async () => {
  /* A separate, disposable cluster, because "the table is empty" is the
     precondition and the shared one is not. Same migration chain. */
  const { startLocalPg, disposableDataDir } = await import('../helpers/local-pg.mjs');
  const env = await startLocalPg({ dataDir: disposableDataDir('bootstrap') });
  try {
    const q = async (sql, params = []) => (await env.pg.query(sql, params)).rows;
    const owner = randomUUID();

    assert.deepEqual(await q('select 1 from public.staff_operators'), [],
      'precondition: no operator exists');

    const [first] = await q('select public.bootstrap_staff_owner($1) as r', [owner]);
    assert.equal(first.r.ok, true);
    assert.equal(first.r.bootstrapped, true);
    assert.equal(first.r.role, 'owner');

    const [row] = await q('select * from public.staff_operators');
    assert.equal(row.user_id, owner);
    assert.equal(row.role, 'owner');
    assert.equal(row.active, true);
    assert.equal(row.created_by, null,
      'the only row that legitimately has no creator, because there was nobody to be it');
    assert.equal(row.disabled_at, null);

    /* Idempotent for the IDENTICAL user: same answer, still one row. */
    const [again] = await q('select public.bootstrap_staff_owner($1) as r', [owner]);
    assert.equal(again.r.ok, true);
    assert.equal(again.r.bootstrapped, false, 'it did not create a second one');
    assert.equal((await q('select count(*)::int n from public.staff_operators'))[0].n, 1);

    /* And refuses anybody else — the competing-bootstrap case. */
    const competing = await env.pg.query(
      'select public.bootstrap_staff_owner($1)', [randomUUID()]).then(() => null, e => e);
    assert.ok(competing, 'a second, different bootstrap must be refused');
    assert.match(competing.message, /staff_bootstrap_already_done/);
    assert.equal((await q('select count(*)::int n from public.staff_operators'))[0].n, 1);

    /* The bootstrapped owner can actually work the queue — the whole point. */
    const [guard] = await q('select public.staff_operator_guard($1, $2) as role', [owner, 'aal2']);
    assert.equal(guard.role, 'owner');

    /* And the runbook's step 3 works: the owner creates the next operator,
       with created_by recorded. */
    const second = randomUUID();
    await env.pg.query(
      `insert into public.staff_operators (user_id, role, active, created_by)
       values ($1, 'identity_resolver', true, $2)`, [second, owner]);
    const [guard2] = await q('select public.staff_operator_guard($1, $2) as role', [second, 'aal2']);
    assert.equal(guard2.role, 'identity_resolver');

    /* A row that claims to have created itself is refused by the table. */
    const selfMade = await env.pg.query(
      `insert into public.staff_operators (user_id, role, active, created_by)
       values ($1, 'owner', true, $1)`, [randomUUID()]).then(() => null, e => e);
    assert.ok(selfMade);
    assert.match(selfMade.message, /staff_operators_no_self_creation/);

    /* Once a second operator exists, even the identical-user call is no
       longer a bootstrap and must not answer as though it were. */
    const stale = await env.pg.query(
      'select public.bootstrap_staff_owner($1)', [owner]).then(() => null, e => e);
    assert.ok(stale, 'this is no longer a bootstrap');
    assert.match(stale.message, /staff_bootstrap_already_done/);
  } finally {
    await env.close();
  }
});

utcIt('W3 — the bootstrap is reachable by the server role and by nobody else', async () => {
  for (const role of ['anon', 'authenticated', 'public']) {
    const { rows: r } = await localEnv.pg.query(
      `select has_function_privilege($1, 'public.bootstrap_staff_owner(uuid)', 'EXECUTE') p`, [role]);
    assert.equal(r[0].p, false, `${role} can call the bootstrap`);
  }
  const { rows: svc } = await localEnv.pg.query(
    `select has_function_privilege('service_role', 'public.bootstrap_staff_owner(uuid)', 'EXECUTE') p`);
  assert.equal(svc[0].p, true);
});

/* ---------- X. the resolution note ---------- */

utcIt('X1 — redaction clears the resolution note it used to leave behind', async () => {
  const operator = await makeOperator();
  const s = salonNames('x1');
  const salonA = await establishBusiness(s.a, s.aEmail);
  const c = await makeQueuedCase({ candidates: [salonA.businessId] });
  const agreeing = [{ type: 'business_name', normalizedValue: s.a },
                    { type: 'email_exact', normalizedValue: s.aEmail }];

  const note = 'Spoke to the owner and confirmed this is the same salon.';
  await resolve({ operator, caseId: c.caseId, target: salonA.businessId,
    signals: agreeing, payloadHash: c.payloadHash, note });

  const [before] = await rows('identity_resolution_cases', 'identity_resolution_id', c.caseId);
  assert.equal(before.resolution_notes, note, 'stored as typed, until an erasure runs');

  const { data, error } = await rpc('redact_business_pii', {
    p_business_id: salonA.businessId,
    p_reason: 'Erasure requested by the business owner.',
    p_actor: 'integration-suite', p_actor_type: 'human'
  });
  assert.equal(error, null);
  assert.equal(data.redacted.identityResolutionNotes, 1,
    'the note is counted as redacted, declared rather than silent');

  const [after] = await rows('identity_resolution_cases', 'identity_resolution_id', c.caseId);
  assert.equal(after.resolution_notes, '[redacted]');
  assert.equal(after.resolution_notes.includes('owner'), false);

  /* The structural record survives. An erasure removes what a person wrote,
     not the fact that a person decided. */
  assert.ok(after.resolved_at, 'the case is still resolved');
  assert.equal(after.resolved_by_operator_id, operator, 'and still attributable');
  assert.deepEqual(after.candidate_business_ids, before.candidate_business_ids,
    'and its evidence is untouched');

  /* The audit event states what happened and carries no note text. */
  const [audit] = (await rows('audit_events', 'business_id', salonA.businessId))
    .filter(a => a.action === 'business.pii_redacted');
  assert.equal(audit.new_value.resolutionNotesRedacted, 1);
  assert.equal(JSON.stringify(audit).includes('Spoke to the owner'), false);
});

utcIt('X2 — redaction touches only the note, and only for the business being erased', async () => {
  const operator = await makeOperator();
  const s = salonNames('x2');
  const target = await establishBusiness(s.a, s.aEmail);
  const bystander = await establishBusiness(`${s.a} elsewhere`, email('x2-other'));

  const mine = await makeQueuedCase({ candidates: [target.businessId] });
  const theirs = await makeQueuedCase({ candidates: [bystander.businessId] });

  await resolve({ operator, caseId: mine.caseId, target: target.businessId,
    signals: [{ type: 'business_name', normalizedValue: s.a },
              { type: 'email_exact', normalizedValue: s.aEmail }],
    payloadHash: mine.payloadHash, note: 'The note that should be erased.' });
  await resolve({ operator, caseId: theirs.caseId, target: bystander.businessId,
    signals: [{ type: 'business_name', normalizedValue: `${s.a} elsewhere` },
              { type: 'email_exact', normalizedValue: email('x2-other') }],
    payloadHash: theirs.payloadHash, note: 'The note that must survive untouched.' });

  await rpc('redact_business_pii', {
    p_business_id: target.businessId,
    p_reason: 'Erasure requested by the business owner.',
    p_actor: 'integration-suite', p_actor_type: 'human'
  });

  const [erased] = await rows('identity_resolution_cases', 'identity_resolution_id', mine.caseId);
  const [kept] = await rows('identity_resolution_cases', 'identity_resolution_id', theirs.caseId);
  assert.equal(erased.resolution_notes, '[redacted]');
  assert.equal(kept.resolution_notes, 'The note that must survive untouched.',
    'another business\'s note is not collateral damage');

  /* Re-running the erasure reports zero, not one: it is already gone. */
  const { data: second } = await rpc('redact_business_pii', {
    p_business_id: target.businessId,
    p_reason: 'Erasure requested by the business owner, again.',
    p_actor: 'integration-suite', p_actor_type: 'human'
  });
  assert.equal(second.redacted.identityResolutionNotes, 0);
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
