/* ============================================================
   Onboarding: the credential boundary
   ------------------------------------------------------------
   THE DEFECT THIS FILE EXISTS FOR. An earlier version of this
   subsystem carried two CED endpoints — `POST …/onboarding/invite`
   and `POST …/onboarding/verify` — which accepted the invited
   user's password and the invitation token, and returned the
   Supabase session, the TOTP secret and the otpauth URI.

   That broke CLAUDE.md §9: this platform never stores or
   transmits passwords, tokens or other credentials. The reasoning
   behind it confused the SECRET key, which must never reach a
   browser, with the PUBLISHABLE key, which is designed for one.
   Avoiding a public key by routing private credentials through a
   CED function traded a non-problem for a real one.

   Onboarding now happens between the browser and Supabase Auth
   directly. This file holds the line from the server side:

     · the credential endpoints are GONE, and cannot come back
       without failing a test that names them;
     · no CED endpoint accepts or returns any of the seven values;
     · `GET …/auth-config` returns the project URL and the
       publishable key and nothing else, and refuses to serve an
       elevated key that was pasted into the wrong variable;
     · the console's own sign-in and authorization are unchanged.

   The browser half is tests/browser/staff-invite-browser.test.mjs.
   The grant half — that the publishable key can reach nothing —
   is tests/migration/0007-anon-grants.test.mjs.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { handleRequest, __testing } from '../server/staff-identity-resolution.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = readFileSync(join(ROOT, 'server/staff-identity-resolution.mjs'), 'utf8');

const USER = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://staff.example.com';
const PREFIX = `${ORIGIN}/api/staff/identity-resolution`;

const ENV = {
  /* A real-shaped project host: the origin is validated as an exact
     <ref>.supabase.co, so a placeholder-looking one is refused. */
  SUPABASE_URL: 'https://qkpptajglstgucadhfwq.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_demo-not-real',
  SUPABASE_SECRET_KEY: 'sb_secret_demo-not-real',
  CED_LOG_LEVEL: 'debug'
};

const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = c => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(c)}.sig`;
const AAL2 = jwt({ sub: USER, aal: 'aal2', exp: 1893456000 });

/* Any database access at all is a failure on these paths. */
const noDatabase = new Proxy({}, {
  get(_t, prop) { throw new Error(`the database was reached: ${String(prop)}`); }
});

/* Any Supabase Auth client construction is a failure on these paths. */
const noAuthClient = async () => { throw new Error('an Auth client was built'); };

const capture = async fn => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = line => lines.push(String(line));
  try { return { value: await fn(), lines }; }
  finally { console.log = original.log; console.warn = original.warn; console.error = original.error; }
};

const get = (path, { env = ENV, headers = {}, db = noDatabase } = {}) =>
  handleRequest(new Request(`${PREFIX}${path}`, {
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin', ...headers }
  }), { env, db, authClient: noAuthClient, correlationId: 'boundary-test' });

const post = (path, body, { env = ENV, db = noDatabase } = {}) =>
  handleRequest(new Request(`${PREFIX}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }), { env, db, authClient: noAuthClient, correlationId: 'boundary-test' });

/* ============================================================
   1. The credential endpoints are gone
   ============================================================ */

test('the onboarding credential endpoints no longer exist', async () => {
  /* Named individually, because these are the two that were wrong. Every
     method, so a reintroduction cannot slip in under a different verb. */
  for (const path of ['/onboarding/invite', '/onboarding/verify', '/onboarding']) {
    for (const method of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE']) {
      const response = await handleRequest(new Request(`${PREFIX}${path}`, {
        method,
        headers: method === 'POST'
          ? { origin: ORIGIN, 'content-type': 'application/json' }
          : { 'sec-fetch-site': 'same-origin' },
        ...(method === 'POST' ? { body: '{}' } : {})
      }), { env: ENV, db: noDatabase, authClient: noAuthClient, correlationId: 'boundary-test' });

      /* 403 for an unsafe method with no Origin, 401 for the authenticated
         fall-through, 404 for the unmatched route — never 200, and never a
         handler that ran. */
      assert.ok([401, 403, 404, 405].includes(response.status),
        `${method} ${path} answered ${response.status}`);
      const body = await response.json();
      assert.notEqual(body.ok, true, `${method} ${path} succeeded`);
    }
  }
});

test('no dead credential-handling code was left behind', () => {
  /* The endpoints being unroutable is not enough: unreachable code that
     handles passwords is still code that handles passwords, and the next
     person to add a route may find it and wire it up. */
  for (const name of ['handleInviteAccept', 'handleInviteVerify', 'onboardingPayload',
                      'TOKEN_HASH_RE', 'TOTP_CODE_RE', 'TOTP_FRIENDLY_NAME',
                      'MIN_PASSWORD', 'MAX_TOKEN_HASH']) {
    assert.equal(SERVER_SRC.includes(name), false,
      `${name} is still in the route — remove the dead credential path, do not orphan it`);
  }
  /* And the exported testing surface no longer offers them. */
  for (const name of ['onboardingPayload', 'MIN_PASSWORD', 'MAX_PASSWORD',
                      'MAX_TOKEN_HASH', 'TOTP_FRIENDLY_NAME']) {
    assert.equal(name in __testing, false, `__testing still exports ${name}`);
  }
});

test('the route never calls the Auth methods that carry onboarding credentials', () => {
  /* verifyOtp, updateUser, mfa.enroll and mfa.unenroll belong in the browser
     now. signInWithPassword and challengeAndVerify DO remain — they are the
     console's own sign-in, which is a different thing and is unchanged. */
  for (const call of ['verifyOtp', 'updateUser', 'mfa.enroll', 'mfa.unenroll', '.enroll(']) {
    assert.equal(SERVER_SRC.includes(call), false,
      `the route still calls ${call}; onboarding must not run server-side`);
  }
});

/* ============================================================
   2. auth-config returns configuration, never a credential
   ============================================================ */

test('auth-config returns exactly the project URL and the publishable key', async () => {
  const { value: response, lines } = await capture(() => get('/auth-config'));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(Object.keys(body).sort(), ['ok', 'publishableKey', 'supabaseUrl']);
  assert.equal(body.supabaseUrl, ENV.SUPABASE_URL);
  assert.equal(body.publishableKey, ENV.SUPABASE_PUBLISHABLE_KEY);

  /* THE SECRET KEY IS NOWHERE NEAR IT. */
  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes(ENV.SUPABASE_SECRET_KEY), false);
  assert.equal(serialised.includes('sb_secret_'), false);
  assert.equal(lines.join('\n').includes(ENV.SUPABASE_SECRET_KEY), false);

  /* And it is not cached anywhere, like every other staff response. */
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('a secret key pasted into the publishable variable is refused, not served', async () => {
  /* The failure this prevents is the worst one available: handing a browser
     an elevated credential because somebody filled in the wrong box. */
  for (const crossed of ['sb_secret_wrong-box', jwt({ role: 'service_role' })]) {
    const response = await get('/auth-config', {
      env: { ...ENV, SUPABASE_PUBLISHABLE_KEY: crossed, SUPABASE_ANON_KEY: '' }
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'auth_unavailable');
    assert.equal(JSON.stringify(body).includes(crossed), false);
  }
});

test('auth-config is unavailable rather than partial when nothing is configured', async () => {
  for (const env of [{ ...ENV, SUPABASE_URL: '' },
                     { ...ENV, SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_ANON_KEY: '' }]) {
    const response = await get('/auth-config', { env });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'auth_unavailable');
  }
});

test('auth-config accepts no body and only GET', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await handleRequest(new Request(`${PREFIX}/auth-config`, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'should-never-be-read' })
    }), { env: ENV, db: noDatabase, authClient: noAuthClient, correlationId: 'boundary-test' });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('Allow'), 'GET');
  }
});

test('auth-config still proves provenance before it answers', async () => {
  /* It is a safe method, so the Fetch Metadata rule applies rather than the
     Origin one — the same gate as every other read on this route. */
  const crossSite = await get('/auth-config', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).code, 'origin_not_allowed');

  const foreign = await handleRequest(new Request(`${PREFIX}/auth-config`, {
    method: 'GET', headers: { origin: 'https://evil.test' }
  }), { env: ENV, db: noDatabase, authClient: noAuthClient, correlationId: 'boundary-test' });
  assert.equal(foreign.status, 403);

  /* And a same-origin GET with no Origin at all is accepted, which is the
     shape a real browser actually sends. */
  const real = await get('/auth-config', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(real.status, 200);
});

test('auth-config touches no database and builds no Auth client', async () => {
  /* Both injected dependencies throw on any use. A 200 is the proof. */
  const response = await get('/auth-config');
  assert.equal(response.status, 200);
});

/* ============================================================
   3. No CED endpoint accepts a credential
   ============================================================ */

test('no CED endpoint accepts a password, token, TOTP code, secret or URI', async () => {
  /* Fired at every path this route serves. Nothing may answer `ok: true`, and
     nothing may echo a submitted value back. */
  const CREDENTIALS = {
    password: 'a-long-enough-passphrase',
    tokenHash: 'pkce_deadbeefdeadbeefdeadbeefdeadbeef',
    accessToken: jwt({ sub: USER, aal: 'aal1', exp: 1893456000 }),
    refreshToken: 'refresh-never-real',
    code: '123456',
    secret: 'JBSWY3DPEHPK3PXP',
    uri: 'otpauth://totp/CED:x@y.test?secret=JBSWY3DPEHPK3PXP'
  };

  const paths = ['/auth-config', '/onboarding/invite', '/onboarding/verify',
                 '/cases', '/enroll', '/register', '/signup'];

  for (const path of paths) {
    const { value: response, lines } = await capture(() => post(path, CREDENTIALS));
    const text = await response.text();
    assert.notEqual(response.status, 200, `${path} answered 200 to a credential payload`);

    for (const [field, value] of Object.entries(CREDENTIALS)) {
      assert.equal(text.includes(value), false, `${path} echoed ${field}`);
      assert.equal(lines.join('\n').includes(value), false, `${path} logged ${field}`);
    }
  }
});

test('the console sign-in endpoints are the only ones that see a password, unchanged', () => {
  /* This is not a regression in disguise: `/session` has always exchanged a
     password for a token and still does. What changed is that onboarding no
     longer does, and the file must still contain exactly one such path. */
  const signInCalls = SERVER_SRC.match(/signInWithPassword/g) || [];
  assert.equal(signInCalls.length, 1, 'exactly one password exchange remains');
  assert.ok(SERVER_SRC.includes('const handleSignIn'), 'and it is the console sign-in');
});

/* ============================================================
   4. Authorization is unchanged and still authoritative
   ============================================================ */

test('a verified aal2 account is still refused the queue without an operator row', async () => {
  const seen = [];
  const db = {
    async rpc(name) {
      seen.push(name);
      if (name === 'check_rate_limit') return { data: { allowed: true }, error: null };
      if (name === 'staff_operator_guard') {
        return { data: null, error: { message: 'staff_not_an_operator: not a staff operator' } };
      }
      throw new Error(`the guard must refuse before ${name}`);
    },
    from() { throw new Error('no table read before the guard passes'); }
  };

  const response = await handleRequest(new Request(`${PREFIX}/cases`, {
    method: 'GET', headers: { authorization: `Bearer ${AAL2}`, 'sec-fetch-site': 'same-origin' }
  }), {
    env: ENV, db,
    verifyAccessToken: async () => ({ userId: USER, aal: 'aal2', emailConfirmed: true }),
    correlationId: 'boundary-test'
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'not_an_operator');
  assert.equal(seen.includes('staff_identity_queue'), false);
});

test('an aal1 account — enrollment incomplete — is refused too', async () => {
  const db = {
    async rpc(name) {
      if (name === 'check_rate_limit') return { data: { allowed: true }, error: null };
      if (name === 'staff_operator_guard') {
        return { data: null, error: { message: 'staff_aal2_required: a second factor is required' } };
      }
      throw new Error(`the guard must refuse before ${name}`);
    },
    from() { throw new Error('no table read'); }
  };

  const response = await handleRequest(new Request(`${PREFIX}/cases`, {
    method: 'GET', headers: { authorization: 'Bearer x.y.z', 'sec-fetch-site': 'same-origin' }
  }), {
    env: ENV, db,
    verifyAccessToken: async () => ({ userId: USER, aal: 'aal1', emailConfirmed: true }),
    correlationId: 'boundary-test'
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'aal2_required');
});

test('the guard is still called before any read, and authorization is still a row lookup', () => {
  const guardAt = SERVER_SRC.indexOf("db.rpc('staff_operator_guard'");
  const queueAt = SERVER_SRC.indexOf("db.rpc('staff_identity_queue'");
  const caseAt = SERVER_SRC.indexOf("db.rpc('staff_identity_case'");
  assert.ok(guardAt > 0 && queueAt > guardAt && caseAt > guardAt,
    'the guard call must precede every privileged read in the route');
});
