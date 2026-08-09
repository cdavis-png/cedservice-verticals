/* ============================================================
   The staff route — rate-limit separation, ordering, body
   bounding, path validation, key material, and paging
   ------------------------------------------------------------
   tests/staff-identity-resolution.test.mjs covers the
   authorization chain and the resolution contract. This file
   covers the things that sit AROUND them, each of which was a
   defect before it was a test:

     · the console borrowed the public form's request budget, so
       an operator was locked out after roughly six cases and the
       only way to fix it raised the public form's budget too;
     · token verification — an outbound HTTPS call to Supabase
       Auth — happened before any rate limiting, so an
       unauthenticated caller could make us issue one per request
       for as long as they liked;
     · the body limit was checked after request.text() had
       already buffered the whole body, which limits nothing;
     · a 36-character path segment of dashes reached a uuid
       parameter and came back as a 500;
     · a secret key pasted into the publishable variable would
       have performed token verification with an elevated
       credential, silently;
     · a queue page past the last row reported the queue as empty.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';

import { handleRequest, __testing } from '../server/staff-identity-resolution.mjs';
import rateLimit from '../shared/security/rate-limit.js';
import { PUBLISHABLE_FIXTURE, SECRET_FIXTURE } from './helpers/supabase-keys.mjs';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '22222222-2222-4222-8222-222222222222';
const BUSINESS = '33333333-3333-4333-8333-333333333333';
const SUBMISSION = '44444444-4444-4444-8444-444444444444';
const ADDRESS = '203.0.113.9';

const hmacFn = (secret, input) => createHmac('sha256', secret).update(input).digest('hex');

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-never-real',
  SUPABASE_SERVICE_ROLE_KEY: 'service-never-real',
  CED_LOG_LEVEL: 'error'
};

const LIMITED_ENV = {
  ...ENV,
  CED_RATE_LIMIT_SECRET: 'test-secret',
  CED_RATE_LIMIT_MAX_REQUESTS: 20,             /* the PUBLIC budget */
  CED_STAFF_RATE_LIMIT_MAX_REQUESTS: 240       /* the CONSOLE budget */
};

const AUTHORIZED = { userId: OPERATOR, aal: 'aal2', emailConfirmed: true };
const verifier = answer => async () => answer;

const linkBody = (over = {}) => ({
  targetBusinessId: BUSINESS,
  resolutionRequestId: randomUUID(),
  note: 'Confirmed by phone with the owner.',
  ...over
});

/* A client that records every call in order. Rate-limit verdicts come from a
   script, so a test can refuse the first pass and allow the second. */
const stubDb = (verdicts = []) => {
  const calls = [];
  const queue = verdicts.slice();
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'check_rate_limit') {
        return { data: queue.length ? queue.shift() : { allowed: true }, error: null };
      }
      if (name === 'staff_operator_guard') return { data: 'owner', error: null };
      return { data: [], error: null };
    },
    from(table) {
      return {
        select() { return this; },
        eq() {
          calls.push({ table });
          if (table === 'identity_resolution_cases') {
            return { data: [{ assessment_submission_id: SUBMISSION }] };
          }
          return { data: [{ submission_id: SUBMISSION, payload_hash: 'h', raw_payload: {} }] };
        }
      };
    }
  };
};

const ORIGIN = 'https://staff.example.com';

/* THE DEFAULT HEADERS ARE THE ONES A REAL BROWSER SENDS, NOT THE ONES THAT
   MAKE THE ROUTE HAPPY.

   This helper used to attach `origin: ORIGIN` to EVERY synthetic request,
   GETs included. That is not something a browser does: per the Fetch standard
   a same-origin GET carries no Origin at all, because its response tainting
   stays `basic` and only `cors` tainting or an unsafe method appends the
   header. Adding Authorization does not change it either — that forces a
   preflight only when the request is cross-origin.

   So the helper was manufacturing the one header whose absence broke the
   console, and every test here passed while the queue was unreachable in
   Chrome, Edge, Firefox and Safari alike.

   The default is now what Chrome was OBSERVED to send for the console's queue
   and case reads (see tests/browser/staff-origin-headers.test.mjs, which
   captures them from a real browser over a real socket): no Origin, and
   Sec-Fetch-Site: same-origin. A test that wants an Origin passes one, and a
   test about Fetch Metadata sets `fetchSite` — including to null, for the
   older clients that send neither. */
const call = async ({ method = 'GET', path = '/cases', token = 'good', body, rawBody,
                      headers = {}, db, env = ENV, verify, authClient,
                      origin, fetchSite = 'same-origin' } = {}) => {
  /* `undefined` means "whatever a browser would send for this method"; `null`
     means "explicitly none", which is what the absent-Origin tests need. An
     unsafe method really does carry an Origin, so its default is the console's
     — otherwise every POST test would silently be testing the refusal. */
  const effectiveOrigin = origin === undefined
    ? (['GET', 'HEAD'].includes(method) ? null : ORIGIN)
    : origin;
  const request = new Request(`https://staff.example.com/api/staff/identity-resolution${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-proto': 'https',
      ...(effectiveOrigin ? { origin: effectiveOrigin } : {}),
      ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}),
      ...((body || rawBody) ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(rawBody ? { body: rawBody } : body ? { body: JSON.stringify(body) } : {})
  });
  const res = await handleRequest(request, {
    env,
    verifyAccessToken: verify || verifier(AUTHORIZED),
    db: db || stubDb(),
    ...(authClient ? { authClient } : {}),
    correlationId: 'test-correlation'
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
};

/* ============================================================
   Rate limiting is separate from the public form
   ============================================================ */

test('staff traffic and public traffic cannot consume each other\'s buckets', async () => {
  const headers = new Headers({ 'x-real-ip': ADDRESS });
  const publicKeys = rateLimit.buildRateLimitKeys({
    headers, sessionId: OPERATOR, env: LIMITED_ENV, hmacFn
  });
  assert.equal(publicKeys.length, 2, 'the public endpoint derives an address and a session key');

  const db = stubDb();
  await call({ db, env: LIMITED_ENV, headers: { 'x-real-ip': ADDRESS } });

  const staffKeys = db.calls.filter(c => c.name === 'check_rate_limit')
    .flatMap(c => c.args.p_keys.map(k => k.key));
  assert.ok(staffKeys.length >= 2, 'the staff route derived keys of its own');

  const publicSet = new Set(publicKeys.map(k => k.key));
  for (const key of staffKeys) {
    assert.equal(publicSet.has(key), false, 'no staff bucket is a public bucket');
  }

  /* The scope column keeps its original vocabulary: migration 0003 constrains
     it to exactly these two and 0003 is committed and not edited. The
     namespace lives in the keyed HMAC instead, which is where the scope
     string already went. */
  const scopes = new Set(db.calls.filter(c => c.name === 'check_rate_limit')
    .flatMap(c => c.args.p_keys.map(k => k.scope)));
  [...scopes].forEach(s =>
    assert.ok(rateLimit.SCOPES.includes(s), `scope ${s} is one migration 0003 permits`));
});

test('the pre-authentication and authenticated passes use different buckets', async () => {
  const db = stubDb();
  await call({ db, env: LIMITED_ENV, headers: { 'x-real-ip': ADDRESS } });

  const passes = db.calls.filter(c => c.name === 'check_rate_limit');
  assert.equal(passes.length, 2, 'a pre-authentication pass and an authenticated one');

  const preAuth = passes[0].args.p_keys.find(k => k.scope === 'address').key;
  const authed = passes[1].args.p_keys.find(k => k.scope === 'address').key;
  assert.notEqual(preAuth, authed,
    'one legitimate request must not be charged twice to one bucket');

  assert.deepEqual(passes[0].args.p_keys.map(k => k.scope), ['address'],
    'there is no operator to count against before a token is verified');
  assert.deepEqual(passes[1].args.p_keys.map(k => k.scope).sort(), ['address', 'session']);

  /* Nothing identifiable is stored: not the address, not the operator id. */
  const serialised = JSON.stringify(passes.map(p => p.args.p_keys));
  assert.equal(serialised.includes(ADDRESS), false, 'no raw address');
  assert.equal(serialised.includes(OPERATOR), false, 'no operator id');
});

test('staff limits move without moving the public limits, and the reverse', () => {
  const { rateLimitPolicy, staffRateLimitPolicy, staffSignInRateLimitPolicy } = rateLimit;

  const staffRaised = { CED_STAFF_RATE_LIMIT_MAX_REQUESTS: 500,
                        CED_STAFF_RATE_LIMIT_WINDOW_SECONDS: 60 };
  assert.deepEqual(staffRateLimitPolicy(staffRaised), { windowSeconds: 60, maxRequests: 500 });
  assert.deepEqual(rateLimitPolicy(staffRaised), rateLimit.DEFAULTS,
    'the public form kept its own budget');

  const publicRaised = { CED_RATE_LIMIT_MAX_REQUESTS: 9, CED_RATE_LIMIT_WINDOW_SECONDS: 30 };
  assert.deepEqual(rateLimitPolicy(publicRaised), { windowSeconds: 30, maxRequests: 9 });
  assert.deepEqual(staffRateLimitPolicy(publicRaised), rateLimit.STAFF_DEFAULTS,
    'and the console kept its own');
  assert.deepEqual(staffSignInRateLimitPolicy(publicRaised), rateLimit.STAFF_SIGNIN_DEFAULTS);

  /* The default has to carry ordinary work. One case costs three requests —
     detail, resolution, and the queue refetch behind the panel — so six cases
     is 18 plus the first list, which a budget of 20 could not carry. */
  assert.ok(rateLimit.STAFF_DEFAULTS.maxRequests >= 3 * 20,
    'the console default carries far more than six cases');
  assert.ok(rateLimit.STAFF_SIGNIN_DEFAULTS.maxRequests < rateLimit.STAFF_DEFAULTS.maxRequests,
    'sign-in is tighter than ordinary work');
});

test('separate operators and separate addresses are separate buckets', async () => {
  const other = '99999999-9999-4999-8999-999999999999';
  const keysFor = async (address, operator) => {
    const db = stubDb();
    await call({ db, env: LIMITED_ENV, headers: { 'x-real-ip': address },
      verify: verifier({ userId: operator, aal: 'aal2', emailConfirmed: true }) });
    const authed = db.calls.filter(c => c.name === 'check_rate_limit')[1].args.p_keys;
    return {
      address: authed.find(k => k.scope === 'address').key,
      session: authed.find(k => k.scope === 'session').key
    };
  };

  const a = await keysFor(ADDRESS, OPERATOR);
  const b = await keysFor(ADDRESS, other);
  const c = await keysFor('198.51.100.4', OPERATOR);

  assert.equal(a.address, b.address, 'one address is one address bucket');
  assert.notEqual(a.session, b.session, 'two operators are two operator buckets');
  assert.notEqual(a.address, c.address, 'two addresses are two address buckets');
  assert.equal(a.session, c.session, 'one operator is one operator bucket');
});

/* ============================================================
   Ordering: the limiter runs before Supabase Auth is called
   ============================================================ */

test('a pre-authentication refusal verifies no token and reads nothing', async () => {
  let verified = 0;
  const db = stubDb([{ allowed: false, retryAfterSeconds: 77 }]);
  const request = new Request(
    `https://staff.example.com/api/staff/identity-resolution/cases/${CASE_ID}/link`, {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'x-forwarded-proto': 'https', origin: ORIGIN,
                 'x-real-ip': ADDRESS, 'content-type': 'application/json' },
      body: JSON.stringify(linkBody())
    });

  const res = await handleRequest(request, {
    env: LIMITED_ENV, db,
    verifyAccessToken: async () => { verified += 1; return AUTHORIZED; },
    authClient: async () => { throw new Error('the auth client must not be built'); }
  });

  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '77');
  assert.equal((await res.json()).code, 'rate_limited');

  assert.equal(verified, 0, 'Supabase Auth was never asked');
  assert.deepEqual(db.calls.map(c => c.name || c.table), ['check_rate_limit'],
    'one rate-limit call and nothing else: no guard, no reads, no mutation');
});

test('the sign-in endpoint is refused before a password is checked', async () => {
  const db = stubDb([{ allowed: false, retryAfterSeconds: 60 }]);
  const res = await call({
    method: 'POST', path: '/session', token: '', db, env: LIMITED_ENV,
    headers: { 'x-real-ip': ADDRESS },
    body: { email: 'owner@example.test', password: 'whatever' },
    authClient: async () => { throw new Error('no auth client on a refused sign-in'); }
  });
  assert.equal(res.status, 429);
  assert.deepEqual(db.calls.map(c => c.name), ['check_rate_limit'],
    'the pre-authentication pass refused it before the sign-in pass or the client');
});

test('sign-in has its own tighter bucket, separate from ordinary staff work', async () => {
  const db = stubDb();
  await call({
    method: 'POST', path: '/session', token: '', db, env: LIMITED_ENV,
    headers: { 'x-real-ip': ADDRESS },
    body: { email: 'owner@example.test', password: 'x' },
    authClient: async () => ({
      auth: {
        signInWithPassword: async () => ({ data: null, error: { message: 'bad' } }),
        signOut: async () => ({ error: null })
      }
    })
  });

  const passes = db.calls.filter(c => c.name === 'check_rate_limit');
  assert.equal(passes.length, 2, 'the pre-authentication pass, then the sign-in pass');
  assert.equal(passes[0].args.p_max_requests, rateLimit.STAFF_DEFAULTS.maxRequests);
  assert.equal(passes[1].args.p_max_requests, rateLimit.STAFF_SIGNIN_DEFAULTS.maxRequests,
    'password guessing is budgeted separately from working the queue');
  assert.notEqual(passes[0].args.p_keys[0].key, passes[1].args.p_keys[0].key,
    'and in a different bucket');
});

/* ============================================================
   Credential guessing and session maintenance are different things
   ------------------------------------------------------------
   Refresh and sign-out used to share the sign-in bucket. Both present a token
   this server issued and neither can be used to guess one, so counting them as
   guesses meant a working console spent the budget its own operator needed to
   sign in again — and because a refused refresh ends the session, the tight
   bucket was ejecting exactly the people it was there to protect.
   ============================================================ */

const sessionAuthClient = () => async () => ({
  auth: {
    signInWithPassword: async () => ({ data: null, error: { message: 'bad' } }),
    refreshSession: async () => ({ data: null, error: { message: 'bad' } }),
    setSession: async () => ({ error: null }),
    signOut: async () => ({ error: null }),
    mfa: { listFactors: async () => ({ data: { all: [] }, error: null }) }
  }
});

const sessionCall = (path, body, db) => call({
  method: 'POST', path, token: '', db, env: LIMITED_ENV,
  headers: { 'x-real-ip': ADDRESS }, body,
  authClient: sessionAuthClient()
});

test('refresh and sign-out are budgeted apart from password guessing', async () => {
  const buckets = {};
  for (const [name, path, body] of [
    ['signin', '/session', { email: 'a@b.test', password: 'x' }],
    ['refresh', '/session/refresh', { refreshToken: 'r' }],
    ['signout', '/session/signout', { refreshToken: 'r', accessToken: 'a' }]
  ]) {
    const db = stubDb();
    await sessionCall(path, body, db);
    const passes = db.calls.filter(c => c.name === 'check_rate_limit');
    assert.equal(passes.length, 2, `${name}: the pre-authentication pass, then its own`);
    buckets[name] = {
      key: passes[1].args.p_keys.find(k => k.scope === 'address').key,
      max: passes[1].args.p_max_requests,
      window: passes[1].args.p_window_seconds
    };
  }

  assert.notEqual(buckets.signin.key, buckets.refresh.key,
    'a refresh cannot spend the sign-in budget');
  assert.notEqual(buckets.signin.key, buckets.signout.key,
    'nor can a sign-out');
  assert.equal(buckets.refresh.key, buckets.signout.key,
    'refresh and sign-out share one maintenance bucket, which is what they are');

  assert.equal(buckets.signin.max, rateLimit.STAFF_SIGNIN_DEFAULTS.maxRequests);
  assert.equal(buckets.refresh.max, rateLimit.STAFF_SESSION_DEFAULTS.maxRequests);
  assert.notEqual(buckets.signin.max, buckets.refresh.max,
    'and the two budgets are genuinely different numbers');
});

test('a maintenance refusal does not consume the sign-in bucket, or the reverse', async () => {
  /* Refuse the SECOND pass — the maintenance one — and check the sign-in
     bucket was never even derived on that request. */
  const db = stubDb([{ allowed: true }, { allowed: false, retryAfterSeconds: 42 }]);
  const res = await sessionCall('/session/refresh', { refreshToken: 'r' }, db);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '42');

  const passes = db.calls.filter(c => c.name === 'check_rate_limit');
  assert.equal(passes.length, 2, 'exactly two passes; the sign-in bucket was never touched');
  assert.equal(passes[1].args.p_max_requests, rateLimit.STAFF_SESSION_DEFAULTS.maxRequests);

  /* And nothing beyond the limiter ran. */
  assert.deepEqual(db.calls.map(c => c.name || c.table),
    ['check_rate_limit', 'check_rate_limit']);

  /* The mirror image: a sign-in refusal derives no maintenance bucket. */
  const db2 = stubDb([{ allowed: true }, { allowed: false, retryAfterSeconds: 9 }]);
  const refusedSignIn = await sessionCall('/session', { email: 'a@b.test', password: 'x' }, db2);
  assert.equal(refusedSignIn.status, 429);
  const signInPasses = db2.calls.filter(c => c.name === 'check_rate_limit');
  assert.equal(signInPasses[1].args.p_max_requests,
    rateLimit.STAFF_SIGNIN_DEFAULTS.maxRequests);
});

test('the sign-in budget fits ten COMPLETE two-step sign-ins from one office address', async () => {
  /* The form is two posts: email and password, then the code. A budget of ten
     therefore bought five sign-ins, and operators share an address whenever
     they share an office. This is the arithmetic, pinned. */
  const POSTS_PER_SIGN_IN = 2;
  const { maxRequests } = rateLimit.STAFF_SIGNIN_DEFAULTS;
  assert.ok(maxRequests >= 10 * POSTS_PER_SIGN_IN,
    `${maxRequests} must cover at least ten complete two-step sign-ins `
    + `(${10 * POSTS_PER_SIGN_IN} posts), not ten HTTP posts`);

  /* Still a credential budget, not an open door. */
  assert.ok(maxRequests <= 60, 'and it stays small enough to make guessing pointless');

  /* Maintenance is bounded too. */
  assert.ok(rateLimit.STAFF_SESSION_DEFAULTS.maxRequests <= 240,
    'session maintenance is generous, not unlimited');
});

test('every staff namespace derives a different bucket, and none is the public one', () => {
  const headers = new Headers({ 'x-real-ip': ADDRESS });
  const keys = Object.entries(rateLimit.NAMESPACES).map(([name, namespace]) => [
    name,
    rateLimit.buildRateLimitKeys({
      headers, sessionId: OPERATOR, env: LIMITED_ENV, hmacFn, namespace, includeSession: false
    })[0].key
  ]);
  assert.equal(new Set(keys.map(([, k]) => k)).size, keys.length,
    `namespaces must not collide: ${JSON.stringify(keys.map(([n]) => n))}`);

  /* And the separation is inside the HMAC input, so the database's scope
     vocabulary is untouched — migration 0003 constrains it and is committed. */
  const built = rateLimit.buildRateLimitKeys({
    headers, sessionId: OPERATOR, env: LIMITED_ENV, hmacFn,
    namespace: rateLimit.NAMESPACES.staffSession, includeSession: false
  });
  built.forEach(k => assert.ok(rateLimit.SCOPES.includes(k.scope),
    `scope ${k.scope} is one migration 0003 permits`));
  const serialised = JSON.stringify(built);
  assert.equal(serialised.includes(ADDRESS), false, 'no raw address');
  assert.equal(serialised.includes(OPERATOR), false, 'no operator id');
  assert.equal(serialised.includes('staff_session:'), false, 'not even the namespace travels');
});

test('an authenticated rate-limit refusal still happens before any privileged read', async () => {
  const db = stubDb([{ allowed: true }, { allowed: false, retryAfterSeconds: 31 }]);
  const res = await call({
    method: 'POST', path: `/cases/${CASE_ID}/link`, body: linkBody(),
    db, env: LIMITED_ENV, headers: { 'x-real-ip': ADDRESS }
  });

  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '31');
  assert.deepEqual(db.calls.map(c => c.name || c.table),
    ['check_rate_limit', 'check_rate_limit'],
    'the guard was never asked and no case row was read');
});

test('a rate-limit refusal says how long to wait and nothing else', async () => {
  const db = stubDb([{ allowed: false, retryAfterSeconds: 12 }]);
  const res = await call({ db, env: LIMITED_ENV, headers: { 'x-real-ip': ADDRESS } });
  const serialised = JSON.stringify(res.body);
  assert.equal(serialised.includes(ADDRESS), false, 'no address');
  assert.equal(serialised.includes(OPERATOR), false, 'no operator id');
  assert.equal(/bucket|hmac|p_keys/i.test(serialised), false, 'nothing about the mechanism');
});

/* ============================================================
   The body limit is enforced while reading
   ============================================================ */

test('an oversized body is refused without being buffered', async () => {
  const chunk = new TextEncoder().encode('x'.repeat(4096));
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 200) return controller.close();
      controller.enqueue(chunk);
    }
  });

  const request = new Request(
    `https://staff.example.com/api/staff/identity-resolution/cases/${CASE_ID}/link`,
    { method: 'POST', body, duplex: 'half',
      headers: { authorization: 'Bearer good', 'x-forwarded-proto': 'https', origin: ORIGIN,
                 'content-type': 'application/json' } });

  const res = await handleRequest(request, {
    env: ENV, verifyAccessToken: verifier(AUTHORIZED), db: stubDb()
  });

  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 'body_too_large');
  /* 8192 bytes at 4096 per chunk is three reads at the very most. Two hundred
     chunks were on offer; buffering would have taken all of them. */
  assert.ok(pulled <= 4, `the stream was cancelled after ${pulled} chunks, not drained`);
});

test('a declared Content-Length over the limit is refused before the stream opens', async () => {
  let pulled = 0;
  /* highWaterMark 0 so the stream does no speculative fill of its own: every
     pull counted here is one somebody asked for. */
  const body = new ReadableStream({
    pull(controller) { pulled += 1; controller.enqueue(new TextEncoder().encode('x')); }
  }, new CountQueuingStrategy({ highWaterMark: 0 }));
  const request = new Request(
    `https://staff.example.com/api/staff/identity-resolution/cases/${CASE_ID}/link`,
    { method: 'POST', body, duplex: 'half',
      headers: { authorization: 'Bearer good', 'x-forwarded-proto': 'https', origin: ORIGIN,
                 'content-type': 'application/json', 'content-length': '900000' } });

  const res = await handleRequest(request, {
    env: ENV, verifyAccessToken: verifier(AUTHORIZED), db: stubDb() });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 'body_too_large');
  assert.equal(pulled, 0, 'the stream was never read at all');
  assert.equal(request.bodyUsed, false, 'and the body was never consumed');
});

test('a multibyte body is measured in bytes while streaming, not in code units', async () => {
  /* Each character is one UTF-16 code unit and three UTF-8 bytes. */
  const text = JSON.stringify({ note: 'あ'.repeat(4000) });
  assert.ok(text.length < __testing.MAX_BODY_BYTES, 'it would pass a length check');
  assert.ok(Buffer.byteLength(text, 'utf8') > __testing.MAX_BODY_BYTES, 'and fails a byte check');

  const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`, rawBody: text });
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'body_too_large');
});

test('malformed JSON is refused without any of it being echoed', async () => {
  const res = await call({ method: 'POST', path: `/cases/${CASE_ID}/link`,
    rawBody: '{"note":"hunter2blue","password":' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_json');
  assert.equal(JSON.stringify(res.body).includes('hunter2blue'), false,
    'a malformed body may still hold a credential; none of it is repeated');
});

/* ============================================================
   Path ids, transport, key material
   ============================================================ */

test('a case id that is not a UUID is a controlled 400, not a database error', async () => {
  const db = stubDb();
  const bad = '------------------------------------';   /* 36 characters, no uuid */

  const read = await call({ path: `/cases/${bad}`, db });
  assert.equal(read.status, 400);
  assert.equal(read.body.code, 'invalid_case_id');

  const write = await call({ method: 'POST', path: `/cases/${bad}/link`, body: linkBody(), db });
  assert.equal(write.status, 400);
  assert.equal(write.body.code, 'invalid_case_id');

  assert.equal(db.calls.some(c => c.name === 'staff_identity_case'), false,
    'no malformed id reached a uuid parameter');
  assert.equal(db.calls.some(c => c.name === 'resolve_identity_case_link_existing'), false);
  assert.equal(db.calls.some(c => c.table), false, 'and nothing was read');
});

test('a malformed percent-escape is a controlled 400, not a URIError turned 500', async () => {
  /* decodeURIComponent throws on these, and an uncaught throw landed in the
     generic handler as a 500 — the same defect the strict UUID rule above was
     added to fix one layer up. */
  const malformed = ['%', '%zz', '%E0%A4%A', '%%', 'a%2', '%C0%80%'];

  for (const segment of malformed) {
    const db = stubDb();
    const read = await call({ path: `/cases/${segment}`, db });
    assert.equal(read.status, 400, segment);
    assert.equal(read.body.code, 'invalid_case_id', segment);
    assert.equal(read.body.message, 'A case id must be a UUID.',
      `${segment}: the raw URI error never reaches the caller`);
    assert.equal(/URI|malform|decodeURI/i.test(JSON.stringify(read.body)), false,
      `${segment}: and is not described either`);

    const write = await call({
      method: 'POST', path: `/cases/${segment}/link`, body: linkBody(), db });
    assert.equal(write.status, 400, segment);
    assert.equal(write.body.code, 'invalid_case_id', segment);

    assert.equal(db.calls.some(c => c.name === 'staff_identity_case'), false, segment);
    assert.equal(db.calls.some(c => c.name === 'resolve_identity_case_link_existing'), false, segment);
    assert.equal(db.calls.some(c => c.table), false, `${segment}: nothing was read`);
  }
});

test('a validly encoded but invalid id is refused after decoding, not before', async () => {
  /* %31%32%33 decodes to "123", which is well-formed percent-encoding and a
     hopeless case id. The UUID rule has to run on the DECODED value. */
  const db = stubDb();
  const res = await call({ path: '/cases/%31%32%33', db });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_case_id');

  /* And a correctly encoded REAL id still works, so the guard is not simply
     refusing everything with a percent in it. */
  const encoded = CASE_ID.replace(/-/g, m => encodeURIComponent(m));
  assert.equal(__testing.decodeSegment(encoded), CASE_ID, 'the fixture really is encoded');
  const ok = await call({ path: `/cases/${encoded}`, db: stubDb() });
  assert.equal(ok.status, 200);
});

test('the decoder answers null instead of throwing', () => {
  assert.equal(__testing.decodeSegment('%'), null);
  assert.equal(__testing.decodeSegment('%zz'), null);
  assert.equal(__testing.decodeSegment('plain'), 'plain');
  assert.equal(__testing.decodeSegment('%41'), 'A');
});

/* ============================================================
   Provenance, ahead of everything it protects

   THE RULE IS METHOD-SENSITIVE BECAUSE BROWSERS ARE.

   Per the Fetch standard an Origin header is appended when a request's
   response tainting is `cors` OR its method is neither GET nor HEAD. A
   same-origin fetch keeps tainting `basic`, so a same-origin GET carries NO
   Origin — and an Authorization header does not change that, because it forces
   a preflight only on a cross-origin request.

   The route used to require Origin on every method. The console signed in
   (POSTs do carry it) and then every queue listing and every case read was
   refused 403 origin_required — unreachable in every standards-compliant
   browser. It went unnoticed because the helper above attached an Origin by
   hand and the browser suite replaced window.fetch, so no real request was
   ever made.

   These tests now use the headers Chrome was OBSERVED to send. The
   observation itself lives in tests/browser/staff-origin-headers.test.mjs,
   which captures them over a real socket rather than asserting them.
   ============================================================ */

/* ---------- safe methods: no Origin, judged on Fetch Metadata ---------- */

test('a same-origin GET carries no Origin and is accepted on Fetch Metadata', async () => {
  /* THE REGRESSION. Exactly the header set real Chrome sends for the queue. */
  const db = stubDb();
  const res = await call({ db, origin: null, fetchSite: 'same-origin' });
  assert.equal(res.status, 200, 'the queue is reachable without an Origin header');
  assert.ok(db.calls.some(c => c.name === 'staff_identity_queue'),
    'and it really reached the queue, not merely past the gate');
});

test('a same-origin case read carries no Origin and is accepted', async () => {
  const db = stubDb();
  const res = await call({ path: `/cases/${CASE_ID}`, db, origin: null,
                           fetchSite: 'same-origin' });
  assert.equal(res.status, 200);
  assert.ok(db.calls.some(c => c.name === 'staff_identity_case'));
});

test('a same-origin HEAD passes the provenance gate', async () => {
  /* HEAD is safe, so a browser omits Origin for it too. The route serves no
     HEAD branch and falls through to 404 — which is the point: whatever it
     answers, it must not be a 403 about provenance. */
  const res = await call({ method: 'HEAD', db: stubDb(), origin: null,
                           fetchSite: 'same-origin' });
  assert.notEqual(res.status, 403, 'HEAD was not refused as cross-site');
  assert.notEqual(res.body.code, 'origin_required');
  assert.notEqual(res.body.code, 'origin_not_allowed');
});

test('Sec-Fetch-Site: none — a typed URL or a bookmark — is accepted for a safe read', async () => {
  const db = stubDb();
  const res = await call({ db, origin: null, fetchSite: 'none' });
  assert.equal(res.status, 200, 'a user-initiated load has no initiator to be cross-site');
});

test('same-site is NOT same-origin: a sibling subdomain gets nothing', async () => {
  /* The whole reason same-site is absent from the allowlist. It means any host
     under the same registrable domain, so accepting it would hand the queue to
     whatever else somebody stands up next to the console. */
  const db = stubDb();
  const res = await call({ db, env: LIMITED_ENV, origin: null, fetchSite: 'same-site',
                           headers: { 'x-real-ip': ADDRESS } });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'origin_not_allowed');
  assert.deepEqual(db.calls, [], 'and it spent nothing on the way to being refused');
});

test('a request with neither an Origin nor Fetch Metadata is refused', async () => {
  /* No current browser sends neither. Something that does is not the console,
     and is not given the benefit of the doubt. */
  const db = stubDb();
  const res = await call({ db, env: LIMITED_ENV, origin: null, fetchSite: null,
                           headers: { 'x-real-ip': ADDRESS } });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'origin_required');
  assert.deepEqual(db.calls, []);
});

test('an unrecognised or malformed Sec-Fetch-Site is refused, never guessed at', async () => {
  /* Values with leading or trailing whitespace are absent here because the
     Request constructor refuses to build them at all — HTTP strips that OWS
     before a handler ever sees it. The route trims anyway; this list is the
     part that can actually arrive. */
  for (const site of ['', 'SAME-ORIGIN', 'Same-Origin', 'same origin',
                      'same-origin, cross-site', 'cross-site, same-origin',
                      'invented', 'null', '*', 'sameorigin', 'same-origin;q=1']) {
    const db = stubDb();
    const res = await call({ db, env: LIMITED_ENV, origin: null, fetchSite: site,
                             headers: { 'x-real-ip': ADDRESS } });
    assert.equal(res.status, 403, JSON.stringify(site));
    assert.ok(['origin_required', 'origin_not_allowed'].includes(res.body.code),
      JSON.stringify(site));
    assert.deepEqual(db.calls, [], `${JSON.stringify(site)}: spent nothing`);
  }
});

test('the two accepted Fetch Metadata values are exactly these, and same-site is not one', () => {
  assert.deepEqual([...__testing.SAFE_FETCH_SITES].sort(), ['none', 'same-origin']);
  assert.equal(__testing.SAFE_FETCH_SITES.has('same-site'), false,
    'a sibling registrable domain is not this origin');
  assert.equal(__testing.SAFE_FETCH_SITES.has('cross-site'), false);
  assert.deepEqual([...__testing.SAFE_METHODS].sort(), ['GET', 'HEAD']);
});

/* ---------- an Origin, when stated, is still exact-matched ---------- */

test('a cross-site read spends nothing: no bucket, no token check, no read', async () => {
  /* Every shape a caller can present, safe method included. `fetchSite` is set
     to what a browser would actually pair with each: a cross-site fetch sends
     BOTH an Origin and Sec-Fetch-Site: cross-site. */
  const cases = [
    ['https://evil.example', 'cross-site', 'origin_not_allowed'],
    ['null', 'cross-site', 'origin_not_allowed'],
    ['*', 'cross-site', 'origin_not_allowed'],
    ['http://staff.example.com', 'cross-site', 'origin_not_allowed'],
    ['https://staff.example.com.evil.example', 'cross-site', 'origin_not_allowed'],
    /* No Origin, but the browser says it came from elsewhere. */
    [null, 'cross-site', 'origin_not_allowed'],
    [null, 'same-site', 'origin_not_allowed'],
    [null, null, 'origin_required'],
    /* A hostile Origin that CLAIMS to be same-origin metadata is still refused
       on the Origin, which is checked first and exactly. */
    ['https://evil.example', 'same-origin', 'origin_not_allowed']
  ];

  for (const [origin, fetchSite, code] of cases) {
    const db = stubDb();
    let verified = 0;
    const res = await call({
      origin, fetchSite, db, env: LIMITED_ENV, headers: { 'x-real-ip': ADDRESS },
      verify: async () => { verified += 1; return AUTHORIZED; },
      authClient: async () => { throw new Error('the auth client must not be built'); }
    });

    const label = `${String(origin)} / ${String(fetchSite)}`;
    assert.equal(res.status, 403, label);
    assert.equal(res.body.code, code, label);
    assert.deepEqual(db.calls, [], `${label}: not one rate-limit bucket was consumed`);
    assert.equal(verified, 0, `${label}: no token was verified`);
  }
});

test('an exact approved Origin is still accepted, on a safe method too', async () => {
  /* An approved non-browser client states an Origin deliberately and is held
     to it. Nothing about the Fetch Metadata relaxation changes that path. */
  const db = stubDb();
  const res = await call({ origin: ORIGIN, fetchSite: null, db });
  assert.equal(res.status, 200);
  assert.ok(db.calls.some(c => c.name === 'staff_identity_queue'));
});

test('a POST without an Origin is still refused outright', async () => {
  /* Unsafe methods always carry one. An absent Origin here is the shape a
     forged write takes, and Fetch Metadata does not rescue it. */
  for (const fetchSite of ['same-origin', 'none', null]) {
    const db = stubDb();
    const res = await call({
      method: 'POST', path: `/cases/${CASE_ID}/link`, body: linkBody(),
      origin: null, fetchSite, db, env: LIMITED_ENV, headers: { 'x-real-ip': ADDRESS },
      authClient: async () => { throw new Error('the auth client must not be built'); }
    });
    assert.equal(res.status, 403, String(fetchSite));
    assert.equal(res.body.code, 'origin_required', String(fetchSite));
    assert.deepEqual(db.calls, [], `${fetchSite}: no bucket, no read, no mutation`);
  }
});

test('the session endpoints refuse a POST with no Origin as well', async () => {
  for (const path of ['/session', '/session/refresh', '/session/signout']) {
    const db = stubDb();
    const res = await call({
      method: 'POST', path, body: { email: 'a@b.test', password: 'x' },
      origin: null, fetchSite: 'same-origin', token: null, db, env: LIMITED_ENV,
      authClient: async () => { throw new Error('Supabase must not be reached'); }
    });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, 'origin_required', path);
    assert.deepEqual(db.calls, [], `${path}: no bucket was spent`);
  }
});

test('provenance is checked before the rate limiter, so a flood cannot be laundered through it', async () => {
  /* If the order were reversed, a cross-site flood would still spend the
     operator's pre-authentication budget on its way to being refused — which
     is the whole attack. Both refusal shapes are checked: a rejected Origin
     and a rejected Fetch Metadata read. */
  for (const [origin, fetchSite] of [['https://evil.example', 'cross-site'],
                                     [null, 'cross-site'],
                                     [null, null]]) {
    const db = stubDb([{ allowed: false, retryAfterSeconds: 60 }]);
    const res = await call({
      origin, fetchSite, db, env: LIMITED_ENV, headers: { 'x-real-ip': ADDRESS } });
    assert.equal(res.status, 403, 'refused as cross-site, not as rate-limited');
    assert.notEqual(res.body.code, 'rate_limited');
    assert.deepEqual(db.calls, [], 'the scripted refusal was never even reached');
  }
});

test('HTTPS is still checked before the origin, so an http request says so', async () => {
  const request = new Request('http://staff.example.com/api/staff/identity-resolution/cases', {
    headers: { 'x-forwarded-proto': 'http', origin: 'https://evil.example' }
  });
  const res = await handleRequest(request, { env: ENV, db: stubDb() });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'https_required',
    'the transport problem is named before the origin one');
});

test('the same-origin default follows the forwarded protocol, not the raw URL', () => {
  const request = new Request('https://staff.example.com/x', {
    headers: { 'x-forwarded-proto': 'https' } });
  assert.deepEqual(
    __testing.staffOrigins({}, new URL('https://staff.example.com/x'), request),
    ['https://staff.example.com']);

  /* Configured wins outright — it is a statement about where the console
     lives, not an addition to a default. */
  assert.deepEqual(
    __testing.staffOrigins(
      { CED_STAFF_ALLOWED_ORIGINS: 'https://a.test, https://b.test' },
      new URL('https://staff.example.com/x'), request),
    ['https://a.test', 'https://b.test']);
});

test('a body without a JSON content type is refused before it is read', async () => {
  const db = stubDb();
  const res = await call({
    method: 'POST', path: `/cases/${CASE_ID}/link`, db, env: LIMITED_ENV,
    rawBody: JSON.stringify(linkBody()),
    headers: { 'content-type': 'text/plain' }
  });
  assert.equal(res.status, 415);
  assert.equal(res.body.code, 'unsupported_media_type');
  assert.deepEqual(db.calls, [], 'nothing was spent on it');
});

test('the loopback allowlist is loopback addresses only', () => {
  assert.deepEqual([...__testing.LOCAL_HOSTS].sort(),
    ['127.0.0.1', '::1', '[::1]', 'localhost'].sort());
  assert.equal(__testing.LOCAL_HOSTS.has('0.0.0.0'), false,
    '0.0.0.0 is the unspecified address, not a loopback one');

  const on = { CED_ALLOW_INSECURE_STAFF: 'true' };
  assert.equal(__testing.insecureAllowed(on, new URL('http://0.0.0.0:3000/x')), false);
  assert.equal(__testing.insecureAllowed(on, new URL('http://127.0.0.1:3000/x')), true);
  assert.equal(__testing.insecureAllowed(on, new URL('http://localhost:3000/x')), true);
});

test('an elevated key in a browser-key variable is refused, not used', () => {
  const { lowPrivilegeKey, elevatedKey, looksElevated, looksBrowserSafe } = __testing;

  const jwt = claims => {
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
  };
  const serviceJwt = jwt({ role: 'service_role', iss: 'supabase' });
  const anonJwt = jwt({ role: 'anon', iss: 'supabase' });

  assert.equal(looksElevated(SECRET_FIXTURE), true);
  assert.equal(looksElevated(serviceJwt), true);
  assert.equal(looksElevated(PUBLISHABLE_FIXTURE), false);
  assert.equal(looksBrowserSafe(PUBLISHABLE_FIXTURE), true);
  assert.equal(looksBrowserSafe(anonJwt), true);

  /* THE MISTAKE THIS CATCHES: a secret key pasted into the publishable
     variable. Token verification would otherwise have run with an elevated
     credential and nothing would have said so. */
  assert.equal(lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: SECRET_FIXTURE }), '');
  assert.equal(lowPrivilegeKey({ SUPABASE_ANON_KEY: serviceJwt }), '');
  assert.equal(elevatedKey({ SUPABASE_SECRET_KEY: PUBLISHABLE_FIXTURE }), '');
  assert.equal(elevatedKey({ SUPABASE_SERVICE_ROLE_KEY: anonJwt }), '');

  /* The right keys in the right places still work. */
  assert.equal(lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_FIXTURE }),
    PUBLISHABLE_FIXTURE);
  assert.equal(elevatedKey({ SUPABASE_SECRET_KEY: SECRET_FIXTURE }), SECRET_FIXTURE);

  /* AND AN UNRECOGNISED STRING IS REFUSED, NOT "LEFT ALONE".

     This assertion used to read
       lowPrivilegeKey({ SUPABASE_ANON_KEY: 'opaque-local-value' })
         === 'opaque-local-value'
     and it was the defect written down as a guarantee. Classification was
     residual — "return it unless it looks elevated" — so a truncated key, a
     typo, a whole .env line or a password pasted into the wrong box was
     handed to a browser by /auth-config as a publishable key.

     A key we cannot classify is not evidence of anything, which is exactly
     why it must fail closed. `looksBrowserSafe` and `looksElevated` are now
     positive tests for the four types Supabase actually issues. */
  assert.equal(lowPrivilegeKey({ SUPABASE_ANON_KEY: 'opaque-local-value' }), '',
    'an unclassifiable value must never be served as a publishable key');
  assert.equal(looksBrowserSafe('opaque-local-value'), false);
  assert.equal(looksElevated('opaque-local-value'), false);
  assert.equal(looksBrowserSafe('sb_publishable_'), false, 'an empty suffix is not a key');
  assert.equal(looksElevated('sb_secret_'), false);
});

test('a misconfigured browser key makes sign-in unavailable rather than elevated', async () => {
  /* No authClient injected, so the route builds the real one and finds it has
     no usable low-privilege key. */
  const env = {
    CED_LOG_LEVEL: 'error',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_secret_pasted_in_the_wrong_box',
    SUPABASE_SECRET_KEY: 'sb_secret_pasted_in_the_wrong_box'
  };
  const res = await call({ method: 'POST', path: '/session', token: '',
    body: { email: 'a@b.test', password: 'x' }, env, db: stubDb() });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'auth_unavailable');
});

/* ============================================================
   The queue total survives a page past the end
   ============================================================ */

test('paging past the last row reports the real total, not zero', async () => {
  const asked = [];
  const db = {
    calls: [],
    async rpc(name, args) {
      if (name === 'staff_operator_guard') return { data: 'owner', error: null };
      asked.push({ limit: args.p_limit, offset: args.p_offset });
      if (args.p_offset > 0) return { data: [], error: null };
      return { data: [{
        identity_resolution_id: CASE_ID, created_at: '2026-08-01T00:00:00.000Z',
        age_seconds: 10, resolution_status: 'manual_review_required',
        recommended_action: 'queue_for_review', review_type: 'growth_review',
        confidence: 0.4, candidate_count: 1, proposal_kinds: [], agreed_types: [],
        contradicted_types: [], escalation_reason: 'x', submitted_label: 'y',
        resolvable: true, total_count: 7
      }], error: null };
    },
    from() { return { select() { return this; }, eq() { return { data: [] }; } }; }
  };

  const res = await call({ path: '/cases?limit=25&offset=100', db });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.cases, [], 'the page really is empty');
  assert.equal(res.body.total, 7, 'and the queue is not reported as empty');
  assert.deepEqual(asked, [{ limit: 25, offset: 100 }, { limit: 1, offset: 0 }],
    'the count is asked for exactly once more, and only because the page was empty');
});

test('a first page that is empty asks for nothing extra', async () => {
  const asked = [];
  const db = {
    async rpc(name, args) {
      if (name === 'staff_operator_guard') return { data: 'owner', error: null };
      asked.push(args.p_offset);
      return { data: [], error: null };
    },
    from() { return { select() { return this; }, eq() { return { data: [] }; } }; }
  };
  const res = await call({ path: '/cases', db });
  assert.equal(res.body.total, 0);
  assert.deepEqual(asked, [0], 'an empty queue is genuinely empty; no second round trip');
});
