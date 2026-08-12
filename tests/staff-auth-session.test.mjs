/* ============================================================
   The staff session endpoints — the server half of sign-in
   ------------------------------------------------------------
   The console could not sign anybody in. page.js read
   window.CED_STAFF_AUTH, nothing in the repository ever set it,
   and the runbook told the operator to sign in and confirm the
   queue loaded. Neither suite could see it: the unit tests
   injected a verifier, and the browser tests installed a session
   through a harness hook.

   This file covers the server half of the fix — /session,
   /session/refresh and /session/signout — and
   tests/browser/staff-console-browser.test.mjs covers the
   browser half by driving the real form through the real
   adapter.

   The Supabase client is stubbed. The route's use of it is not:
   every call here is the one the supported client exposes, made
   in the order the real flow makes them.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRequest, __testing } from '../server/staff-identity-resolution.mjs';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const FACTOR = 'f0000000-0000-4000-8000-000000000001';

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  /* Real-SHAPED, never real. Key classification is POSITIVE now: a bare
     placeholder is refused, so a fixture must be one of the four types
     Supabase issues or the route answers 503 before the test starts. Written
     as literals rather than built with the b64 helper below, which is
     declared after this object. The payloads decode to {"role":"anon"} and
     {"role":"service_role"}; the signature segment is nonsense on purpose and
     is never verified — only the role is read, to classify privilege. */
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.anon-never-real',
  SUPABASE_SERVICE_ROLE_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.service-never-real',
  /* Rate limiting FAILS CLOSED on a missing secret, so every staff fixture
     must configure one or the route answers 503 before the test's own
     subject is reached. Never a real value. */
  CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret',
  CED_LOG_LEVEL: 'error'
};

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = claims =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.signature`;

const accessToken = (aal, extra = {}) =>
  jwt({ sub: OPERATOR, aal, exp: 1893456000, ...extra });

const AAL2_TOKEN = accessToken('aal2');
const AAL1_TOKEN = accessToken('aal1');

/* A stub shaped like the client the route actually uses. Every method records
   its call AND its arguments — including signOut, whose argument is the whole
   difference between revoking one session and revoking every session the
   operator has on every device. A stub that swallowed it made the library's
   dangerous default invisible to every assertion in this file.

   THE RESPONSE SHAPES ARE THE INSTALLED CLIENT'S, not convenient ones.
   `challengeAndVerify` in particular returns the raw token response —
   access_token, token_type, expires_in, refresh_token, user — and NOT
   expires_at, which auth-js adds only to the copy it saves internally
   (GoTrueClient _verify). Handing one to the stub would have exercised a
   branch production never takes and left the claims.exp fallback it does take
   completely uncovered. The contract is pinned against the real client by
   'the stub matches the installed client's surface' below. */
const authStub = ({
  password = { data: { session: { access_token: AAL1_TOKEN }, user: { id: OPERATOR } }, error: null },
  factors = { data: { all: [{ id: FACTOR, factor_type: 'totp', status: 'verified' }] }, error: null },
  verify = {
    data: {
      access_token: AAL2_TOKEN, token_type: 'bearer', expires_in: 3600,
      refresh_token: 'refresh-1', user: { id: OPERATOR }
    },
    error: null
  },
  refreshed = {
    data: {
      session: { access_token: AAL2_TOKEN, refresh_token: 'refresh-2', expires_at: 1893456600 },
      user: { id: OPERATOR }
    },
    error: null
  }
} = {}) => {
  const calls = [];
  const client = {
    auth: {
      async signInWithPassword(args) { calls.push({ name: 'signInWithPassword', args }); return password; },
      async refreshSession(args) { calls.push({ name: 'refreshSession', args }); return refreshed; },
      async setSession(args) { calls.push({ name: 'setSession', args }); return { error: null }; },
      async signOut(args) { calls.push({ name: 'signOut', args }); return { error: null }; },
      mfa: {
        async listFactors() { calls.push({ name: 'listFactors' }); return factors; },
        async challengeAndVerify(args) { calls.push({ name: 'challengeAndVerify', args }); return verify; }
      }
    }
  };
  return { calls, client, factory: async () => client };
};

/* Every signOut this route makes, and the scope it asked for. */
const signOutScopes = calls =>
  calls.filter(c => c.name === 'signOut').map(c => c.args && c.args.scope);

const ORIGIN = 'https://staff.example.com';

/* A caller identifier, on every request, because the staff limiter now FAILS
   CLOSED without one. TEST-NET-3 (RFC 5737) — reserved for documentation, so
   it can never be a real client. */
const CALLER_IP = '203.0.113.9';

/* The limiter now runs on every request and needs a database. This answers
   that one call and nothing else, for tests whose subject is elsewhere. */
const limiterDb = () => ({
  async rpc(name) {
    if (name === 'check_rate_limit') return { data: { allowed: true }, error: null };
    return { data: null, error: null };
  },
  from() { return { select() { return this; }, eq() { return { data: [] }; } }; }
});

const post = async (path, body, {
  env = ENV, authClient, db, origin = ORIGIN, contentType = 'application/json',
  callerIp = CALLER_IP
} = {}) => {
  const request = new Request(
    `https://staff.example.com/api/staff/identity-resolution${path}`, {
      method: 'POST',
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        'x-forwarded-proto': 'https', 'x-vercel-forwarded-for': '203.0.113.9',
        /* The staff limiter fails closed without a caller identifier.
           TEST-NET-3 (RFC 5737), reserved for documentation. */
        ...(callerIp ? { 'x-vercel-forwarded-for': callerIp } : {}),
        ...(origin ? { origin } : {})
      },
      body: JSON.stringify(body)
    });
  const res = await handleRequest(request, {
    env,
    authClient,
    db: db || { async rpc() { return { data: null, error: null }; } },
    correlationId: 'test-correlation'
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
};

/* ---------- missing configuration ---------- */

test('a deployment with no rate-limit secret fails closed before sign-in is attempted', async () => {
  /* The limiter is the first thing that can refuse after provenance and the
     method, so a WHOLLY unconfigured deployment reports the limiter rather
     than Auth. Both are 503; this pins which, so the ordering is a decision
     rather than an accident — and it proves a missing secret cannot become a
     free sign-in attempt. */
  const res = await post('/session', { email: 'owner@example.test', password: 'x' },
    { env: { CED_LOG_LEVEL: 'error' } });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'rate_limit_unavailable');
  assert.equal(res.headers.get('Retry-After'), '5');
  assert.equal(/secret|key|url|supabase.co/i.test(res.body.message), false,
    'the message names no variable and no project');
});

test('an unconfigured deployment says sign-in is unavailable, and says nothing else', async () => {
  const res = await post('/session', { email: 'owner@example.test', password: 'x' },
    { env: { CED_LOG_LEVEL: 'error', CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret' } });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'auth_unavailable');
  assert.equal(/key|url|supabase\.co/i.test(res.body.message), false,
    'the message names no variable and no project');
});

test('a request with no email or password never reaches Supabase', async () => {
  const stub = authStub();
  const res = await post('/session', { email: '', password: '' }, { authClient: stub.factory });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'credentials_required');
  assert.deepEqual(stub.calls, [], 'nothing was asked of the auth service');
});

/* ---------- password failure ---------- */

test('a wrong password is refused without saying which half was wrong', async () => {
  const stub = authStub({ password: { data: null, error: { message: 'Invalid login credentials' } } });
  const res = await post('/session', { email: 'owner@example.test', password: 'wrong' },
    { authClient: stub.factory });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'invalid_credentials');
  assert.match(res.body.message, /Check your details/);
  assert.deepEqual(stub.calls.map(c => c.name), ['signInWithPassword'],
    'no factor lookup on an account that did not authenticate');
  /* The password is not repeated to the caller, and it is not in the body. */
  assert.equal(JSON.stringify(res.body).includes('wrong'), false);
});

/* ---------- no verified second factor ---------- */

test('an account with no verified authenticator is refused and told who can fix it', async () => {
  const stub = authStub({ factors: { data: { all: [] }, error: null } });
  const res = await post('/session', { email: 'owner@example.test', password: 'right', totp: '123456' },
    { authClient: stub.factory });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'mfa_enrollment_required');
  assert.match(res.body.message, /owner/i, 'it points at the person who can complete enrollment');
  assert.equal(/register|sign up|create an account/i.test(res.body.message), false,
    'and offers no self-service path');

  assert.deepEqual(stub.calls.map(c => c.name),
    ['signInWithPassword', 'listFactors', 'signOut'],
    'the aal1 session is discarded rather than left alive');
  assert.deepEqual(signOutScopes(stub.calls), ['local'],
    'LOCAL scope: this revokes the temporary session and no other device');
});

test('an enrolled but UNVERIFIED factor is not a second factor', async () => {
  const stub = authStub({
    factors: { data: { all: [{ id: FACTOR, factor_type: 'totp', status: 'unverified' }] }, error: null }
  });
  const res = await post('/session', { email: 'owner@example.test', password: 'right', totp: '123456' },
    { authClient: stub.factory });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'mfa_enrollment_required');
  assert.equal(stub.calls.some(c => c.name === 'challengeAndVerify'), false,
    'an unverified factor is never challenged');
});

test('the factor picker accepts only a verified TOTP factor', () => {
  const { verifiedTotpFactor } = __testing;
  assert.equal(verifiedTotpFactor(null), null);
  assert.equal(verifiedTotpFactor({ all: [] }), null);
  assert.equal(verifiedTotpFactor({ all: [{ id: 'a', factor_type: 'phone', status: 'verified' }] }), null);
  assert.equal(verifiedTotpFactor({ all: [{ id: 'a', factor_type: 'totp', status: 'unverified' }] }), null);
  assert.equal(verifiedTotpFactor({ all: [{ id: 'a', factor_type: 'totp', status: 'verified' }] }).id, 'a');
  /* The client also exposes a pre-filtered `totp` list; both shapes are read. */
  assert.equal(verifiedTotpFactor({ totp: [{ id: 'b', factorType: 'totp', status: 'verified' }] }).id, 'b');
});

/* ---------- the two-step form ---------- */

test('a correct password with no code asks for one, and hands back no session', async () => {
  const stub = authStub();
  const res = await post('/session', { email: 'owner@example.test', password: 'right' },
    { authClient: stub.factory });

  assert.equal(res.status, 200);
  assert.equal(res.body.needsSecondFactor, true);
  assert.equal(res.body.session, undefined, 'no token is issued at aal1');
  assert.equal(JSON.stringify(res.body).includes(AAL1_TOKEN), false,
    'and the aal1 access token never leaves the server');

  assert.deepEqual(stub.calls.map(c => c.name),
    ['signInWithPassword', 'listFactors', 'signOut'],
    'the aal1 session is discarded rather than parked between requests');
  assert.deepEqual(signOutScopes(stub.calls), ['local'],
    'and LOCAL scope, so asking for a code cannot log the operator out elsewhere');
});

test('a wrong code is refused, and the aal1 session is not left behind', async () => {
  const stub = authStub({ verify: { data: null, error: { message: 'Invalid TOTP code' } } });
  const res = await post('/session',
    { email: 'owner@example.test', password: 'right', totp: '000000' },
    { authClient: stub.factory });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'invalid_second_factor');
  assert.deepEqual(stub.calls.map(c => c.name),
    ['signInWithPassword', 'listFactors', 'challengeAndVerify', 'signOut']);
  assert.deepEqual(signOutScopes(stub.calls), ['local'],
    'a mistyped code revokes the attempt, never the operator\'s other sessions');
  assert.equal(stub.calls.find(c => c.name === 'challengeAndVerify').args.factorId, FACTOR,
    'the verified factor is the one challenged');
});

/* ---------- a successful AAL2 session ---------- */

test('a correct password and code produce an AAL2 session and nothing more', async () => {
  const stub = authStub();
  const res = await post('/session',
    { email: 'owner@example.test', password: 'right', totp: '123456' },
    { authClient: stub.factory });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.session.accessToken, AAL2_TOKEN);
  assert.equal(res.body.session.refreshToken, 'refresh-1');
  /* challengeAndVerify returns NO expires_at — the installed client adds it
     only to the copy it saves internally — so this came from the token's own
     exp claim. That fallback is the branch production actually takes. */
  assert.equal(res.body.session.expiresAt, 1893456000);
  assert.equal(res.body.session.userId, OPERATOR);

  assert.deepEqual(stub.calls.map(c => c.name),
    ['signInWithPassword', 'listFactors', 'challengeAndVerify'],
    'a successful sign-in keeps the session it just created');

  /* Nothing else travels: no key of any privilege, no email, no factor id. */
  const serialised = JSON.stringify(res.body);
  assert.equal(serialised.includes('anon-never-real'), false, 'no publishable key');
  assert.equal(serialised.includes('service-never-real'), false, 'no secret key');
  assert.equal(serialised.includes('owner@example.test'), false, 'no email address');
  assert.equal(serialised.includes('right'), false, 'no password');
  assert.equal(serialised.includes(FACTOR), false, 'no factor id');

  /* The AAL2 claim on the token is what the route later hands the database. */
  assert.equal(__testing.decodeClaims(res.body.session.accessToken).aal, 'aal2');
});

test('a second factor that did not raise the session to aal2 is refused', async () => {
  /* A verified factor is not the same fact as an aal2 session. The route
     confirms the claim on the token it is about to hand out rather than
     assuming the challenge implied it. */
  const stub = authStub({
    verify: { data: { access_token: AAL1_TOKEN, refresh_token: 'r', expires_at: 1 }, error: null }
  });
  const res = await post('/session',
    { email: 'owner@example.test', password: 'right', totp: '123456' },
    { authClient: stub.factory });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'aal2_required');
  assert.equal(JSON.stringify(res.body).includes(AAL1_TOKEN), false,
    'and the aal1 token is not handed out anyway');
});

/* ---------- refresh ---------- */

test('a refresh returns a new access token and keeps the session at aal2', async () => {
  const stub = authStub();
  const res = await post('/session/refresh', { refreshToken: 'refresh-1' },
    { authClient: stub.factory });

  assert.equal(res.status, 200);
  assert.equal(res.body.session.accessToken, AAL2_TOKEN);
  assert.equal(res.body.session.refreshToken, 'refresh-2');
  assert.equal(res.body.session.expiresAt, 1893456600, 'the new expiry, so the next refresh is timed');
  assert.deepEqual(stub.calls.map(c => c.name), ['refreshSession']);
  assert.equal(stub.calls[0].args.refresh_token, 'refresh-1');
});

test('a refresh that silently came back at aal1 is refused, not carried', async () => {
  const stub = authStub({
    refreshed: {
      data: { session: { access_token: AAL1_TOKEN, refresh_token: 'r', expires_at: 1 },
              user: { id: OPERATOR } },
      error: null
    }
  });
  const res = await post('/session/refresh', { refreshToken: 'refresh-1' },
    { authClient: stub.factory });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'aal2_required');
  assert.equal(JSON.stringify(res.body).includes(AAL1_TOKEN), false);
});

test('a refresh the service refuses ends the session rather than retrying', async () => {
  const stub = authStub({ refreshed: { data: null, error: { message: 'invalid refresh token' } } });
  const res = await post('/session/refresh', { refreshToken: 'stale' }, { authClient: stub.factory });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'unauthenticated');
  assert.match(res.body.message, /Sign in again/);
});

test('a refresh with no token is refused before the service is asked', async () => {
  const stub = authStub();
  const res = await post('/session/refresh', {}, { authClient: stub.factory });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'refresh_token_required');
  assert.deepEqual(stub.calls, []);
});

/* ---------- sign out ---------- */

test('sign-out revokes the refresh token', async () => {
  const stub = authStub();
  const res = await post('/session/signout',
    { refreshToken: 'refresh-1', accessToken: AAL2_TOKEN }, { authClient: stub.factory });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(stub.calls.map(c => c.name), ['setSession', 'signOut']);
  assert.deepEqual(stub.calls[0].args,
    { access_token: AAL2_TOKEN, refresh_token: 'refresh-1' },
    'the fresh per-request client is GIVEN the session before it revokes it — '
    + 'without setSession it would have nothing to act on and would succeed at nothing');
  assert.deepEqual(signOutScopes(stub.calls), ['local'],
    'signing out of this browser is not signing out of every browser');
});

test('sign-out still answers when the service cannot be reached', async () => {
  /* The browser has already forgotten the session by the time this is sent.
     A failure here must not leave the page believing it is still signed in. */
  const factory = async () => ({
    auth: {
      async setSession() { throw new Error('network'); },
      async signOut() { throw new Error('network'); }
    }
  });
  const res = await post('/session/signout',
    { refreshToken: 'refresh-1', accessToken: AAL2_TOKEN }, { authClient: factory });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

/* ---------- the shape of the surface ---------- */

test('the session endpoints refuse anything but POST', async () => {
  for (const path of ['/session', '/session/refresh', '/session/signout']) {
    const request = new Request(
      `https://staff.example.com/api/staff/identity-resolution${path}`,
      { method: 'GET', headers: { 'x-forwarded-proto': 'https', 'x-vercel-forwarded-for': '203.0.113.9', origin: ORIGIN } });
    const res = await handleRequest(request, { env: ENV, db: limiterDb() });
    assert.equal(res.status, 405, path);
    assert.equal(res.headers.get('allow'), 'POST', path);
  }
});

test('the session endpoints require HTTPS like everything else on this route', async () => {
  const request = new Request('http://staff.example.com/api/staff/identity-resolution/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'http', 'x-vercel-forwarded-for': '203.0.113.9',
               origin: 'http://staff.example.com' },
    body: JSON.stringify({ email: 'a@b.test', password: 'x' })
  });
  const res = await handleRequest(request, { env: ENV, db: limiterDb() });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'https_required');
});

test('signing in reads no case, no submission and no operator row', async () => {
  const reads = [];
  const db = {
    async rpc(name) { reads.push(name); return { data: null, error: null }; },
    from(table) { reads.push(table); return { select() { return this; }, eq() { return { data: [] }; } }; }
  };
  const stub = authStub();
  const res = await post('/session',
    { email: 'owner@example.test', password: 'right', totp: '123456' },
    { authClient: stub.factory, db });

  assert.equal(res.status, 200);
  /* The two limiter passes — pre-authentication and sign-in — are
     infrastructure. Nothing PRIVILEGED is touched until a token arrives. */
  assert.deepEqual(reads, ['check_rate_limit', 'check_rate_limit'],
    'sign-in is not authorization: nothing privileged is touched until a token arrives');
  assert.equal(reads.some(r => r !== 'check_rate_limit'), false,
    'no case row, no submission, no operator row');
});

test('a session response never carries a key of any privilege level', async () => {
  /* The whole reason the browser holds no Supabase credential is that the
     route never sends one. */
  const stub = authStub();
  for (const [path, body] of [
    ['/session', { email: 'owner@example.test', password: 'right', totp: '123456' }],
    ['/session/refresh', { refreshToken: 'refresh-1' }],
    ['/session/signout', { refreshToken: 'refresh-1', accessToken: AAL2_TOKEN }]
  ]) {
    const res = await post(path, body, { authClient: stub.factory });
    const serialised = JSON.stringify(res.body);
    for (const forbidden of ['anon-never-real', 'service-never-real',
                             'sb_secret_', 'sb_publishable_', 'service_role']) {
      assert.equal(serialised.includes(forbidden), false, `${path} leaked ${forbidden}`);
    }
    assert.equal(serialised.includes('example.supabase.co'), false,
      `${path} named the project`);
  }
});

test('every session response is no-store and unframable', async () => {
  const stub = authStub();
  for (const [path, body] of [
    ['/session', { email: 'owner@example.test', password: 'right', totp: '123456' }],
    ['/session/refresh', { refreshToken: 'refresh-1' }],
    ['/session/signout', { refreshToken: 'refresh-1', accessToken: AAL2_TOKEN }]
  ]) {
    const res = await post(path, body, { authClient: stub.factory });
    assert.equal(res.headers.get('cache-control'), 'no-store', path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
  }

  /* A refusal carries a token-bearing body too, so it is no-store as well. */
  const refused = await post('/session', { email: '', password: '' }, { authClient: stub.factory });
  assert.equal(refused.status, 422);
  assert.equal(refused.headers.get('cache-control'), 'no-store');
});

/* ============================================================
   THE GLOBAL SIGN-OUT REGRESSION

   @supabase/supabase-js signs out GLOBALLY unless told otherwise:
   `async signOut(options = { scope: 'global' })`. Three of the four
   calls this route makes sit on the ORDINARY sign-in path, so the
   default meant a correct password with no code revoked every
   session the operator held on every device — which somebody
   holding only the password could do, repeatedly, to evict the real
   operator from a live aal2 session. The second factor exists to
   make a stolen password insufficient; the default made it enough.

   These fail if the explicit scope is ever dropped again.
   ============================================================ */

test('NO sign-out this route makes is global — every one is explicitly local', async () => {
  const journeys = [
    ['no verified factor',
      authStub({ factors: { data: { all: [] }, error: null } }),
      '/session', { email: 'owner@example.test', password: 'right', totp: '123456' }],
    ['password accepted, code not yet supplied',
      authStub(),
      '/session', { email: 'owner@example.test', password: 'right' }],
    ['wrong code',
      authStub({ verify: { data: null, error: { message: 'Invalid TOTP code' } } }),
      '/session', { email: 'owner@example.test', password: 'right', totp: '000000' }],
    ['verified but still aal1',
      authStub({ verify: { data: { access_token: AAL1_TOKEN, refresh_token: 'r' }, error: null } }),
      '/session', { email: 'owner@example.test', password: 'right', totp: '123456' }],
    ['an incomplete post-password result',
      authStub({ verify: { data: { refresh_token: 'r' }, error: null } }),
      '/session', { email: 'owner@example.test', password: 'right', totp: '123456' }],
    ['a refresh that came back below aal2',
      authStub({ refreshed: { data: { session: { access_token: AAL1_TOKEN, refresh_token: 'r' },
                                      user: { id: OPERATOR } }, error: null } }),
      '/session/refresh', { refreshToken: 'refresh-1' }],
    ['the operator signing out of this browser',
      authStub(),
      '/session/signout', { refreshToken: 'refresh-1', accessToken: AAL2_TOKEN }]
  ];

  for (const [name, stub, path, body] of journeys) {
    await post(path, body, { authClient: stub.factory });
    const scopes = signOutScopes(stub.calls);
    assert.ok(scopes.length >= 1, `${name}: the temporary session must be revoked`);
    for (const scope of scopes) {
      assert.equal(scope, 'local',
        `${name}: signOut was called with scope ${JSON.stringify(scope)} — `
        + 'undefined means the library default, which is GLOBAL and revokes every device');
    }
  }
});

test('a completed aal2 sign-in signs nothing out', async () => {
  const stub = authStub();
  const res = await post('/session',
    { email: 'owner@example.test', password: 'right', totp: '123456' },
    { authClient: stub.factory });
  assert.equal(res.status, 200);
  assert.deepEqual(signOutScopes(stub.calls), [],
    'the session it just issued is the one thing it must not revoke');
});

test('an unexpected post-password shape still revokes the temporary session', async () => {
  /* The `finally` covers exits nobody enumerated, which is the point of it:
     this one returns a body that satisfies no branch the route wrote out. */
  const stub = authStub({ verify: { data: { unexpected: true }, error: null } });
  const res = await post('/session',
    { email: 'owner@example.test', password: 'right', totp: '123456' },
    { authClient: stub.factory });
  assert.equal(res.status, 401);
  assert.deepEqual(signOutScopes(stub.calls), ['local']);
});

test('a sign-out that throws does not stop the route answering, and asks for local scope', async () => {
  const calls = [];
  const factory = async () => ({
    auth: {
      async signInWithPassword() { return { data: { session: { access_token: AAL1_TOKEN }, user: { id: OPERATOR } }, error: null }; },
      mfa: {
        async listFactors() { return { data: { all: [] }, error: null }; },
        async challengeAndVerify() { return { data: null, error: { message: 'x' } }; }
      },
      async signOut(args) { calls.push(args); throw new Error('network'); }
    }
  });
  const res = await post('/session', { email: 'a@b.test', password: 'x' },
    { authClient: factory });
  assert.equal(res.status, 403, 'the refusal is still the refusal');
  assert.deepEqual(calls, [{ scope: 'local' }]);
});

/* ============================================================
   Origin and content type, before anything is spent
   ============================================================ */

const SPENDING_DB = () => {
  const calls = [];
  return {
    calls,
    async rpc(name, args) { calls.push({ name, args }); return { data: { allowed: true }, error: null }; },
    from(table) { calls.push({ table }); return { select() { return this; }, eq() { return { data: [] }; } }; }
  };
};

const LIMITED = {
  ...ENV,
  CED_RATE_LIMIT_SECRET: 'test-secret'
};

test('a cross-site request is refused before a bucket, a body or Supabase is touched', async () => {
  for (const origin of ['https://evil.example', 'http://staff.example.com', 'null',
                        'https://staff.example.com.evil.example',
                        'https://staff.example.com/', 'https://staff.example.com:443']) {
    const db = SPENDING_DB();
    let authBuilt = 0;
    const res = await post('/session',
      { email: 'owner@example.test', password: 'right', totp: '123456' },
      { env: LIMITED, db, origin, authClient: async () => { authBuilt += 1; return {}; } });

    assert.equal(res.status, 403, origin);
    assert.equal(res.body.code, 'origin_not_allowed', origin);
    assert.deepEqual(db.calls, [], `${origin}: no rate-limit bucket was consumed`);
    assert.equal(authBuilt, 0, `${origin}: no Supabase client was even built`);
  }
});

test('a missing Origin is refused rather than treated as same-origin', async () => {
  const db = SPENDING_DB();
  let authBuilt = 0;
  const res = await post('/session', { email: 'a@b.test', password: 'x' },
    { env: LIMITED, db, origin: null, authClient: async () => { authBuilt += 1; return {}; } });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'origin_required');
  assert.deepEqual(db.calls, []);
  assert.equal(authBuilt, 0);
});

test('text/plain — the shape that dodges a preflight — is refused with 415', async () => {
  /* A cross-origin fetch with Content-Type: text/plain is a CORS *simple*
     request: no preflight, so nothing fails before it arrives. The attacker
     cannot read the answer, but the request is still counted, and a few dozen
     lock the operator out of their own console. Refusing the content type
     removes the shape of the attack rather than only its consequence. */
  for (const contentType of ['text/plain', 'text/plain;charset=UTF-8',
                             'application/x-www-form-urlencoded', 'multipart/form-data',
                             'application/json-patch+json', '']) {
    const db = SPENDING_DB();
    let authBuilt = 0;
    const res = await post('/session',
      { email: 'owner@example.test', password: 'right', totp: '123456' },
      { env: LIMITED, db, contentType, authClient: async () => { authBuilt += 1; return {}; } });

    assert.equal(res.status, 415, JSON.stringify(contentType));
    assert.equal(res.body.code, 'unsupported_media_type', JSON.stringify(contentType));
    assert.deepEqual(db.calls, [], `${contentType}: no bucket consumed`);
    assert.equal(authBuilt, 0, `${contentType}: no Supabase client built`);
  }
});

test('a legitimate charset parameter is accepted', async () => {
  for (const contentType of ['application/json', 'application/json; charset=utf-8',
                             'application/json;charset=UTF-8', 'APPLICATION/JSON']) {
    const stub = authStub();
    const res = await post('/session',
      { email: 'owner@example.test', password: 'right', totp: '123456' },
      { contentType, authClient: stub.factory });
    assert.equal(res.status, 200, contentType);
  }
});

test('an explicit allowlist replaces the same-origin default and is exact', async () => {
  const env = { ...ENV, CED_STAFF_ALLOWED_ORIGINS: 'https://console.ced.test, https://ops.ced.test' };
  const stub = authStub();

  const ok = await post('/session', { email: 'a@b.test', password: 'x', totp: '123456' },
    { env, origin: 'https://console.ced.test', authClient: stub.factory });
  assert.equal(ok.status, 200, 'a configured origin is accepted');

  /* And the request's own origin is NOT, once a list exists: configuring one
     is stating where the console lives, not adding to a default. */
  const own = await post('/session', { email: 'a@b.test', password: 'x' },
    { env, origin: 'https://staff.example.com', authClient: authStub().factory });
  assert.equal(own.status, 403);
  assert.equal(own.body.code, 'origin_not_allowed');
});

/* ============================================================
   Bounded bodies apply to the session endpoints too
   ============================================================ */

test('an oversized sign-in body is cancelled mid-stream, not buffered', async () => {
  const chunk = new TextEncoder().encode('x'.repeat(4096));
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 200) return controller.close();
      controller.enqueue(chunk);
    }
  });
  const stub = authStub();
  const request = new Request('https://staff.example.com/api/staff/identity-resolution/session', {
    method: 'POST', body, duplex: 'half',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-vercel-forwarded-for': '203.0.113.9', origin: ORIGIN }
  });
  const res = await handleRequest(request, { env: ENV, authClient: stub.factory, db: limiterDb() });

  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 'body_too_large');
  assert.ok(pulled <= 4, `the stream was cancelled after ${pulled} chunks, not drained`);
  assert.deepEqual(stub.calls, [], 'and Supabase was never asked anything');
});

test('a declared Content-Length over the limit never opens the sign-in stream', async () => {
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) { pulled += 1; controller.enqueue(new TextEncoder().encode('x')); }
  }, new CountQueuingStrategy({ highWaterMark: 0 }));
  const request = new Request('https://staff.example.com/api/staff/identity-resolution/session', {
    method: 'POST', body, duplex: 'half',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-vercel-forwarded-for': '203.0.113.9', origin: ORIGIN,
               'content-length': '900000' }
  });
  const res = await handleRequest(request, { env: ENV, db: limiterDb() });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 'body_too_large');
  assert.equal(pulled, 0, 'the stream was never read at all');
});

test('a multibyte sign-in body is measured in bytes, and a refusal echoes none of it', async () => {
  /* Eight thousand three-byte characters is 24000 bytes and 8000 code units:
     a limit counted in code units would have let it through. */
  const stub = authStub();
  const res = await post('/session', { email: 'あ'.repeat(8000), password: 'x' },
    { authClient: stub.factory });
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'body_too_large');
  assert.equal(JSON.stringify(res.body).includes('あ'), false,
    'a refusal never repeats the body — it may be a password');
  assert.deepEqual(stub.calls, []);
});

test('a multibyte sign-in body UNDER the limit still parses correctly', async () => {
  const stub = authStub();
  const res = await post('/session',
    { email: 'owner@example.test', password: 'あいう correct horse', totp: '123456' },
    { authClient: stub.factory });
  assert.equal(res.status, 200);
  assert.equal(stub.calls[0].args.password, 'あいう correct horse',
    'the bytes were decoded back to the characters that were sent');
});

/* ============================================================
   The production Auth client, exercised as itself
   ------------------------------------------------------------
   Every test above injects a stub. These do not: they call the
   factory handleRequest uses when nothing is injected, which is
   always the case in a deployment — nothing reads an environment
   variable to decide, so there is no production-controllable path
   into the injection seam.
   ============================================================ */

test('the production factory builds a REAL client with server-appropriate options', async () => {
  const client = await __testing.defaultAuthClient(ENV);
  assert.equal(client.auth.persistSession, false,
    'a server has no browser storage and two requests must not share one session');
  assert.equal(client.auth.autoRefreshToken, false,
    'nothing may rotate a token in the background of a request that has ended');
  assert.equal(client.auth.detectSessionInUrl, false,
    'there is no URL fragment to recover a session from on a server');
});

test('the production factory builds a FRESH client every time — no module-level Auth state', async () => {
  /* A cached client would carry one operator's in-memory session into the next
     request. This is the assertion a singleton would fail. */
  const a = await __testing.defaultAuthClient(ENV);
  const b = await __testing.defaultAuthClient(ENV);
  assert.notEqual(a, b, 'a second request must not be handed the first request\'s client');
  assert.notEqual(a.auth, b.auth, 'nor the first request\'s GoTrueClient');

  /* And handleRequest really does call it per request, not once. */
  let built = 0;
  const factory = async () => { built += 1; return authStub().client; };
  await post('/session', { email: 'a@b.test', password: 'x', totp: '1' }, { authClient: factory });
  await post('/session', { email: 'c@d.test', password: 'y', totp: '2' }, { authClient: factory });
  assert.equal(built, 2, 'one client per request, never a reused one');
});

test('the stub matches the installed client\'s surface', async () => {
  /* The stub is only honest if the real client exposes exactly these, with
     `mfa` where the route looks for it. If a Supabase upgrade renames or moves
     one, this fails here rather than in production. */
  const real = await __testing.defaultAuthClient(ENV);
  for (const method of ['signInWithPassword', 'refreshSession', 'setSession', 'signOut', 'getUser']) {
    assert.equal(typeof real.auth[method], 'function', `auth.${method}`);
  }
  for (const method of ['listFactors', 'challengeAndVerify']) {
    assert.equal(typeof real.auth.mfa[method], 'function', `auth.mfa.${method}`);
  }
  const stub = authStub().client;
  for (const method of ['signInWithPassword', 'refreshSession', 'setSession', 'signOut']) {
    assert.equal(typeof stub.auth[method], 'function', `the stub answers auth.${method}`);
  }
});

test('two operators signing in at once cannot see or overwrite each other', async () => {
  /* Interleaved deliberately: the first request is held inside
     signInWithPassword until the second has also entered it, so if any Auth
     state were shared the second would land on top of the first. */
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const otherToken = jwt({ sub: OTHER, aal: 'aal2', exp: 1893456000 });

  let releaseFirst;
  const firstEntered = new Promise(r => { releaseFirst = r; });
  let secondEntered;
  const secondReady = new Promise(r => { secondEntered = r; });

  const clients = [];
  const clientFor = (userId, token, refresh, hold) => {
    const client = {
      id: userId,
      auth: {
        async signInWithPassword() {
          if (hold) { secondEntered(); await firstEntered; }
          else { secondEntered(); }
          return { data: { session: { access_token: AAL1_TOKEN }, user: { id: userId } }, error: null };
        },
        async signOut() { return { error: null }; },
        mfa: {
          async listFactors() { return { data: { all: [{ id: FACTOR, factor_type: 'totp', status: 'verified' }] }, error: null }; },
          async challengeAndVerify() {
            return { data: { access_token: token, refresh_token: refresh, user: { id: userId } }, error: null };
          }
        }
      }
    };
    clients.push(client);
    return client;
  };

  const one = post('/session', { email: 'one@example.test', password: 'a', totp: '111111' },
    { authClient: async () => clientFor(OPERATOR, AAL2_TOKEN, 'refresh-one', true) });
  await secondReady;
  const two = post('/session', { email: 'two@example.test', password: 'b', totp: '222222' },
    { authClient: async () => clientFor(OTHER, otherToken, 'refresh-two', false) });
  releaseFirst();

  const [a, b] = await Promise.all([one, two]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.session.userId, OPERATOR, 'the first operator got their own session');
  assert.equal(b.body.session.userId, OTHER, 'and the second got theirs');
  assert.equal(a.body.session.accessToken, AAL2_TOKEN);
  assert.equal(b.body.session.accessToken, otherToken);
  assert.equal(a.body.session.refreshToken, 'refresh-one');
  assert.equal(b.body.session.refreshToken, 'refresh-two');
  assert.equal(clients.length, 2, 'two requests, two clients');
  assert.notEqual(clients[0], clients[1]);

  /* Neither response mentions the other operator at all. */
  assert.equal(JSON.stringify(a.body).includes(OTHER), false);
  assert.equal(JSON.stringify(b.body).includes(OPERATOR), false);
});

/* ============================================================
   Expiry
   ============================================================ */

test('an access token with no usable exp claim reports a null expiry rather than a wrong one', async () => {
  /* The browser refreshes ahead of expiry. A guessed expiry would either
     refresh constantly or not at all; null makes it refresh on demand. */
  const noExp = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: OPERATOR, aal: 'aal2' })}.sig`;
  const stub = authStub({
    verify: { data: { access_token: noExp, refresh_token: 'r', user: { id: OPERATOR } }, error: null }
  });
  const res = await post('/session',
    { email: 'owner@example.test', password: 'right', totp: '123456' },
    { authClient: stub.factory });
  assert.equal(res.status, 200);
  assert.equal(res.body.session.expiresAt, null);
});

test('an unparseable expiry claim is null, not NaN', async () => {
  const badExp = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: OPERATOR, aal: 'aal2', exp: 'soon' })}.sig`;
  const stub = authStub({
    verify: { data: { access_token: badExp, refresh_token: 'r', user: { id: OPERATOR } }, error: null }
  });
  const res = await post('/session',
    { email: 'owner@example.test', password: 'right', totp: '123456' },
    { authClient: stub.factory });
  assert.equal(res.status, 200);
  assert.equal(res.body.session.expiresAt, null,
    'NaN would serialise as null anyway; this pins that it is deliberate');
});
