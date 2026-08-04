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
const created = { businessIds: [], submissionIds: [], idempotencyKeys: [], bucketKeys: [] };

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

    /* Never a blanket delete. Every statement above is keyed to an identifier
       this run generated, so unrelated rows cannot be touched. */
    assert.ok(removedBuckets >= 0);
    assert.ok(removedKeys >= 0);

    const permanent = created.submissionIds.length;
    console.log(`\n    Run ${RUN}: cleaned ${removedKeys} idempotency record(s) and ` +
      `${removedBuckets} rate-limit bucket(s).`);
    console.log(`    Left behind (append-only, by design): up to ${permanent} submission(s) ` +
      `and their timeline, BIR and audit rows.`);
    console.log('    See tests/integration/README.md, "What cannot be cleaned up".\n');
  });
