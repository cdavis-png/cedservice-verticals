/* ============================================================
   GET /auth-config is public configuration, not a staff operation
   ------------------------------------------------------------
   THE DEFECT THIS FILE EXISTS FOR. When the staff rate limiter was
   made to fail closed, every staff request — including this one —
   had to reach `check_rate_limit`, which needs the ELEVATED
   Supabase client. So a deployment that had a project URL and a
   publishable key, and nothing else, answered

       503 database_unavailable

   to the one request whose entire job is to tell the browser which
   Supabase project to talk to. The console could not load its own
   configuration, and a database wobble would have stopped the
   sign-in page rendering rather than stopped an attack. That was
   observed on a real Preview deployment, not reasoned about.

   The endpoint returns two values that are public by construction:
   the project origin, and the publishable key Supabase publishes
   for browser clients — which grants nothing, because every table
   has RLS enabled and forced with no policies and no execute grant
   (tests/migration/0007-anon-grants.test.mjs proves that in real
   PostgreSQL). It authenticates nothing, reads no body, consults no
   token and touches no table.

   It is therefore exempt from the database-backed pre-authentication
   limiter. THE EXEMPTION IS ONE METHOD ON ONE PATH and is not
   conditional on any variable, any environment or any host — the
   tests below pin that from both directions: this endpoint works
   with nothing configured but its own two values, and every other
   staff route still fails closed on each of the five conditions.

   Everything AHEAD of the limiter still applies to it: HTTPS, the
   origin and Fetch Metadata gate, the no-body rule, and the method
   table.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRequest } from '../server/staff-identity-resolution.mjs';
import { PUBLISHABLE_FIXTURE, SECRET_FIXTURE } from './helpers/supabase-keys.mjs';

const ORIGIN = 'https://staff.example.com';
const PREFIX = `${ORIGIN}/api/staff/identity-resolution`;
const PROJECT = 'https://qkpptajglstgucadhfwq.supabase.co';

/* TEST-NET-3 (RFC 5737): reserved for documentation, so it can never be a
   real client. Present on every request here so that a refusal is never
   ambiguous between "no caller identifier" and the subject of the test. */
const CALLER_IP = '203.0.113.9';

/* THE POINT OF THIS FIXTURE IS WHAT IT LEAVES OUT.

   No SUPABASE_SECRET_KEY, no SUPABASE_SERVICE_ROLE_KEY, no
   CED_RATE_LIMIT_SECRET. This is exactly the shape of the Preview deployment
   that failed: a project URL and a publishable key, and nothing else. */
const PUBLIC_ONLY = Object.freeze({
  SUPABASE_URL: PROJECT,
  SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_FIXTURE,
  CED_LOG_LEVEL: 'silent'
});

/* A database that refuses to be used AT ALL — including for the limiter.
   Passing this as `deps.db` is what proves no `check_rate_limit` is
   attempted; omitting `db` entirely is what proves no service client is
   built, because `getServiceClient` would then be the thing that answers. */
const forbiddenDatabase = {
  async rpc(name) { throw new Error(`the database was reached: rpc(${String(name)})`); },
  from(table) { throw new Error(`the database was reached: from(${String(table)})`); }
};

const noAuthClient = async () => { throw new Error('an Auth client was built'); };

/* `db` is deliberately optional and defaults to ABSENT. With no elevated key
   in the environment, any call to the service client fails the request with
   503 database_unavailable — so a 200 from this helper is a positive proof
   that no service client was constructed. */
const request = (method, path, { env = PUBLIC_ONLY, headers = {}, db, body } = {}) => {
  const deps = { env, authClient: noAuthClient, correlationId: 'auth-config-test' };
  if (db !== undefined) deps.db = db;
  return handleRequest(new Request(`${PREFIX}${path}`, {
    method,
    headers: { 'x-vercel-forwarded-for': CALLER_IP, ...headers },
    ...(body === undefined ? {} : { body })
  }), deps);
};

/* The shape a real browser sends for a same-origin read: no Origin header at
   all, judged on Fetch Metadata. */
const read = opts => request('GET', '/auth-config',
  { ...opts, headers: { 'sec-fetch-site': 'same-origin', ...(opts?.headers || {}) } });

/* ============================================================
   1. The 200 path, with the database absent in every sense
   ============================================================ */

test('auth-config answers 200 with no elevated Supabase credential configured', async () => {
  /* No db dependency and no SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY,
     so getServiceClient is the only thing that could answer if it were
     reached, and it would refuse. */
  assert.equal('SUPABASE_SECRET_KEY' in PUBLIC_ONLY, false);
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in PUBLIC_ONLY, false);

  const response = await read();
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.supabaseUrl, PROJECT);
  /* Compared against the fixture, never printed. */
  assert.equal(body.publishableKey, PUBLISHABLE_FIXTURE);
  /* Two public values and the ok flag. Nothing else may travel. */
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'publishableKey', 'supabaseUrl']);
});

test('auth-config answers 200 with no rate-limit secret configured', async () => {
  assert.equal('CED_RATE_LIMIT_SECRET' in PUBLIC_ONLY, false);

  const response = await read();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('auth-config constructs no service client', async () => {
  /* THE CONTROL. The same environment, the same missing elevated key, a
     different path: /cases DOES reach the limiter, so it DOES build the
     service client, so it MUST refuse. Without this, the test above would
     also pass if getServiceClient had quietly started succeeding without a
     key. */
  const control = await request('GET', '/cases', {
    /* The limiter's own secret is supplied, so the control gets PAST the
       missing-secret refusal and fails on the thing this test is about: the
       absent elevated credential that getServiceClient needs. */
    env: { ...PUBLIC_ONLY, CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret' },
    headers: { 'sec-fetch-site': 'same-origin' }
  });
  assert.equal(control.status, 503);
  assert.equal((await control.json()).code, 'database_unavailable');

  const response = await read();
  assert.equal(response.status, 200);
});

test('auth-config attempts no rate-limit RPC', async () => {
  /* A database that throws on `check_rate_limit` as loudly as on anything
     else. The limiter turns a throw into 503 rate_limit_unavailable, so a 200
     here means the call was never made. */
  const response = await read({ db: forbiddenDatabase });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);

  /* The control again, with the same fixture: a route that IS limited turns
     the very same throw into a fail-closed refusal. */
  const control = await request('POST', '/session', {
    env: { ...PUBLIC_ONLY, CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret' },
    db: forbiddenDatabase,
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'someone@example.test', password: 'x' })
  });
  assert.equal(control.status, 503);
  assert.equal((await control.json()).code, 'rate_limit_unavailable');
});

test('the 200 carries the established staff response headers', async () => {
  const response = await read();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-correlation-id'), 'auth-config-test');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

/* ============================================================
   2. Configuration validation is unchanged
   ============================================================ */

test('missing or invalid public configuration still gives the sanitized refusal', async () => {
  const cases = [
    ['no project URL', { SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_FIXTURE }],
    ['no publishable key', { SUPABASE_URL: PROJECT }],
    ['a placeholder URL', { SUPABASE_URL: 'https://example.com', SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_FIXTURE }],
    ['a URL carrying a path', { SUPABASE_URL: `${PROJECT}/auth/v1`, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_FIXTURE }],
    ['an elevated key in the publishable variable', { SUPABASE_URL: PROJECT, SUPABASE_PUBLISHABLE_KEY: SECRET_FIXTURE }]
  ];

  for (const [label, env] of cases) {
    const response = await read({ env: { ...env, CED_LOG_LEVEL: 'silent' } });
    assert.equal(response.status, 503, label);

    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.code, 'auth_unavailable', label);
    assert.equal(body.message, 'Staff authentication is not configured.', label);
    /* The reason describes the deployment's configuration and is logged, never
       returned — and no configured value may appear in the response. */
    assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'ok'], label);
    for (const value of Object.values(env)) {
      if (typeof value !== 'string' || value === 'silent') continue;
      assert.equal(text.includes(value), false, `${label}: a configured value was returned`);
    }
  }
});

/* ============================================================
   3. Everything ahead of the limiter still applies
   ============================================================ */

test('a cross-origin GET is still refused 403, before anything else', async () => {
  const crossSite = await request('GET', '/auth-config', {
    headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).code, 'origin_not_allowed');

  const foreign = await request('GET', '/auth-config', {
    headers: { origin: 'https://evil.test' }
  });
  assert.equal(foreign.status, 403);

  /* `same-site` is never enough: it means any host under the same registrable
     domain, and this console must not inherit trust from its neighbours. */
  const sameSite = await request('GET', '/auth-config', {
    headers: { 'sec-fetch-site': 'same-site' }
  });
  assert.equal(sameSite.status, 403);
});

test('every method but GET is an application-controlled 405 with Allow: GET', async () => {
  /* The unsafe methods carry an exact Origin, because the origin gate runs
     first and would otherwise refuse them 403 — which is correct, and is why
     it is supplied here rather than asserted away. */
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await request(method, '/auth-config', { headers: { origin: ORIGIN } });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET', method);
    const body = await response.json();
    assert.equal(body.code, 'method_not_allowed', method);
    assert.equal(body.message, 'GET is required.', method);
  }

  /* HEAD is a safe method, so it needs no Origin — and it is still not GET. */
  const head = await request('HEAD', '/auth-config', {
    headers: { 'sec-fetch-site': 'same-origin' }
  });
  assert.equal(head.status, 405);
  assert.equal(head.headers.get('allow'), 'GET');
});

test('a GET carrying a body is still refused before the configuration is read', async () => {
  const response = await handleRequest(new Request(`${PREFIX}/auth-config`, {
    method: 'GET',
    headers: {
      'sec-fetch-site': 'same-origin',
      'x-vercel-forwarded-for': CALLER_IP,
      'content-length': '9'
    }
  }), { env: PUBLIC_ONLY, authClient: noAuthClient, correlationId: 'auth-config-test' });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'unexpected_body');
});

/* ============================================================
   4. The exemption is narrow — proved on the other routes
   ------------------------------------------------------------
   One method on one path. Every other staff route must still fail
   closed on all five conditions, so a future edit that widens the
   exemption fails here rather than in production.
   ============================================================ */

test('no other staff route is exempt: all five fail-closed conditions still hold', async () => {
  const ENV_WITH_SECRET = {
    ...PUBLIC_ONLY,
    SUPABASE_SECRET_KEY: SECRET_FIXTURE,
    CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret'
  };

  /* Every limited path this route serves, at its real method. */
  const limited = [
    ['GET', '/cases', {}],
    ['GET', '/cases/11111111-1111-4111-8111-111111111111', {}],
    ['POST', '/cases/11111111-1111-4111-8111-111111111111/link',
      { origin: ORIGIN, 'content-type': 'application/json' }],
    ['POST', '/session', { origin: ORIGIN, 'content-type': 'application/json' }],
    ['POST', '/session/refresh', { origin: ORIGIN, 'content-type': 'application/json' }],
    ['POST', '/session/signout', { origin: ORIGIN, 'content-type': 'application/json' }]
  ];

  const conditions = [
    ['missing rate-limit secret',
      { env: { ...ENV_WITH_SECRET, CED_RATE_LIMIT_SECRET: '  ' }, db: forbiddenDatabase },
      503, 'rate_limit_unavailable'],
    ['missing caller identifier',
      { env: ENV_WITH_SECRET, db: forbiddenDatabase, noAddress: true },
      503, 'rate_limit_unavailable'],
    ['invalid caller identifier',
      { env: ENV_WITH_SECRET, db: forbiddenDatabase, address: 'not an address' },
      503, 'rate_limit_unavailable'],
    ['rate-limit RPC failure',
      { env: ENV_WITH_SECRET, db: { async rpc() { return { data: null, error: { message: 'down' } }; }, from() { throw new Error('table'); } } },
      503, 'rate_limit_unavailable'],
    ['rate-limit timeout',
      { env: { ...ENV_WITH_SECRET, CED_RATE_LIMIT_TIMEOUT_MS: '250' },
        db: { async rpc() { return new Promise(() => {}); }, from() { throw new Error('table'); } } },
      503, 'rate_limit_unavailable'],
    ['missing elevated Supabase credential',
      { env: { ...PUBLIC_ONLY, CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret' } },
      503, 'database_unavailable']
  ];

  for (const [method, path, extraHeaders] of limited) {
    for (const [label, setup, status, code] of conditions) {
      const headers = { ...extraHeaders };
      if (!setup.noAddress) headers['x-vercel-forwarded-for'] = setup.address || CALLER_IP;
      if (!headers.origin) headers['sec-fetch-site'] = 'same-origin';

      const deps = { env: setup.env, authClient: noAuthClient, correlationId: 'auth-config-test' };
      if (setup.db !== undefined) deps.db = setup.db;

      const response = await handleRequest(new Request(`${PREFIX}${path}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify({ probe: true }) } : {})
      }), deps);

      const where = `${method} ${path} — ${label}`;
      assert.equal(response.status, status, where);
      assert.equal((await response.json()).code, code, where);
    }
  }
});

test('the exemption is one method on one path, with no environment switch', async () => {
  /* A path that merely CONTAINS the segment is not the endpoint, and must
     still be limited. `/auth-config` is matched by suffix. */
  const notTheEndpoint = await request('GET', '/auth-config/extra', {
    env: { ...PUBLIC_ONLY, CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret' },
    headers: { 'sec-fetch-site': 'same-origin' }
  });
  /* No elevated key, so the limiter it is subject to refuses it. */
  assert.equal(notTheEndpoint.status, 503);
  assert.equal((await notTheEndpoint.json()).code, 'database_unavailable');

  /* And the real endpoint answers 200 under every one of these, none of which
     it consults. */
  for (const env of [
    { ...PUBLIC_ONLY, NODE_ENV: 'production' },
    { ...PUBLIC_ONLY, NODE_ENV: 'development' },
    { ...PUBLIC_ONLY, VERCEL_ENV: 'preview' },
    { ...PUBLIC_ONLY, VERCEL_ENV: 'production' },
    { ...PUBLIC_ONLY, CED_ALLOW_INSECURE_STAFF: '' }
  ]) {
    const response = await read({ env, db: forbiddenDatabase });
    assert.equal(response.status, 200, JSON.stringify(Object.keys(env)));
  }
});
