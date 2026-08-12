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
     · no ONBOARDING OR RECOVERY path accepts or returns any of
       the seven values — a scoped claim, see below;
     · `GET …/auth-config` returns the project URL and the
       publishable key and nothing else, and refuses to serve an
       elevated key that was pasted into the wrong variable;
     · the console's own sign-in and authorization are unchanged.

   WHAT THIS FILE DOES NOT CLAIM, because it would be false. The
   console's own sign-in endpoints — /session, /session/refresh,
   /session/signout — are PRE-EXISTING, deliberately
   server-mediated, and still handle the operator's password, TOTP
   code, access token and refresh token. They are unchanged by
   this work and are out of scope here. Every assertion below is
   about the ONBOARDING AND RECOVERY surface: the endpoints that
   were removed, and the one configuration endpoint that replaced
   them. A test that fired credentials at /session and expected a
   refusal would be testing that sign-in is broken.

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
import { PUBLISHABLE_FIXTURE, SECRET_FIXTURE } from './helpers/supabase-keys.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = readFileSync(join(ROOT, 'server/staff-identity-resolution.mjs'), 'utf8');

const USER = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://staff.example.com';
const PREFIX = `${ORIGIN}/api/staff/identity-resolution`;

const ENV = {
  /* A real-shaped project host: the origin is validated as an exact
     <ref>.supabase.co, so a placeholder-looking one is refused. */
  SUPABASE_URL: 'https://qkpptajglstgucadhfwq.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_FIXTURE,
  SUPABASE_SECRET_KEY: SECRET_FIXTURE,
  /* Rate limiting FAILS CLOSED on a missing secret, so every staff fixture
     must configure one or the route answers 503 before the test's own
     subject is reached. Never a real value. */
  CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret',
  CED_LOG_LEVEL: 'debug'
};

const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = c => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(c)}.sig`;
const AAL2 = jwt({ sub: USER, aal: 'aal2', exp: 1893456000 });

/* THE LIMITER IS THE ONLY DATABASE CALL THESE PATHS MAY MAKE.

   Rate limiting fails closed, so every request needs a caller identifier and
   therefore a `check_rate_limit` round trip. That is infrastructure, not a
   privileged read. Anything else — an RPC by another name, any table read —
   throws, which is what keeps "onboarding touches no privileged data" a
   property of the code rather than of the fixture. */
const limiterCalls = [];
const noDatabase = {
  async rpc(name, args) {
    if (name !== 'check_rate_limit') {
      throw new Error(`the database was reached: rpc(${String(name)})`);
    }
    limiterCalls.push(args);
    return { data: { allowed: true }, error: null };
  },
  from(table) { throw new Error(`the database was reached: from(${String(table)})`); }
};

/* Any Supabase Auth client construction is a failure on these paths. */
const noAuthClient = async () => { throw new Error('an Auth client was built'); };

const capture = async fn => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = line => lines.push(String(line));
  try { return { value: await fn(), lines }; }
  finally { console.log = original.log; console.warn = original.warn; console.error = original.error; }
};

/* A caller identifier, on every request, because the staff limiter now FAILS
   CLOSED without one. TEST-NET-3 (RFC 5737) — an address reserved for
   documentation, so it can never be a real client. Tests that are ABOUT a
   missing or malformed identifier override it explicitly. */
const CALLER_IP = '203.0.113.9';

const get = (path, { env = ENV, headers = {}, db = noDatabase } = {}) =>
  handleRequest(new Request(`${PREFIX}${path}`, {
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin', 'x-vercel-forwarded-for': CALLER_IP, ...headers }
  }), { env, db, authClient: noAuthClient, correlationId: 'boundary-test' });

const post = (path, body, { env = ENV, db = noDatabase } = {}) =>
  handleRequest(new Request(`${PREFIX}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json',
               'x-vercel-forwarded-for': CALLER_IP },
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
          ? { origin: ORIGIN, 'content-type': 'application/json',
              'x-vercel-forwarded-for': CALLER_IP }
          : { 'sec-fetch-site': 'same-origin', 'x-vercel-forwarded-for': CALLER_IP },
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

/* ============================================================
   2a. Key classification is POSITIVE, and fails closed
   ------------------------------------------------------------
   THE DEFECT THIS PINS. `lowPrivilegeKey` used to return anything
   that did not LOOK elevated. An unrecognisable value — a
   truncated key, a typo, a whole `.env` line, a password pasted
   into the wrong box — was therefore served to a browser by
   /auth-config as though it were a publishable key. "Not
   obviously wrong" was being read as "right".

   Supabase issues exactly four key shapes. Anything else is now
   refused, in both directions.
   ============================================================ */

const ANON_JWT = jwt({ role: 'anon', iss: 'supabase' });
const SERVICE_JWT = jwt({ role: 'service_role', iss: 'supabase' });
const PUBLISHABLE = PUBLISHABLE_FIXTURE;
const SECRET = SECRET_FIXTURE;

/* Everything that is NOT one of the four supported types. */
const UNCLASSIFIABLE = [
  ['', 'empty'],
  ['   ', 'whitespace only'],
  ['hunter2', 'an arbitrary string'],
  ['SUPABASE_PUBLISHABLE_KEY=sb_publishable_x', 'a whole .env line'],
  ['sb_publishable_', 'an empty suffix'],
  ['sb_secret_', 'an empty secret suffix'],
  ['sb_publishable', 'a truncated prefix'],
  ['sb_publishable_ abc', 'a suffix with a space'],
  ['sb_publishable_abc def', 'a suffix with an inner space'],
  ['sb_publishable_abc\n', 'a trailing newline'],
  [' sb_publishable_abc', 'a leading space'],
  ['sb_publishable_abc"', 'a suffix with a quote'],
  ['sb_publishable_abc;drop', 'a suffix with a semicolon'],
  ['sb_publishable_abc.def', 'a suffix with a dot'],
  ['eyJhbGciOiJIUzI1NiJ9', 'a one-part JWT'],
  ['eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9', 'a two-part JWT'],
  ['a..c', 'a three-part JWT with an empty payload'],
  ['aaa.!!!not-base64!!!.ccc', 'an undecodable payload'],
  [`${jwt({ iss: 'supabase' })}`, 'a JWT with no role'],
  [`${jwt({ role: 'authenticated' })}`, 'a JWT with an unsupported role'],
  [`${jwt({ role: 'ANON' })}`, 'a JWT whose role is the wrong case'],
  [`${jwt({ role: ['anon'] })}`, 'a JWT whose role is not a string'],
  ['sb_service_role_abc', 'an invented prefix'],
  ['pk_live_abcdef', 'another vendor\'s key shape']
];

/* The documented platform format: prefix, 22-character random section, an
   underscore, an 8-character checksum. Built from parts so every rejection
   below differs from a valid key in exactly one stated way. */
const R22 = 'AbCdEfGhIjKlMnOpQrStUv';        /* 22 */
const C8 = 'Wx01Yz23';                       /* 8  */

test('the opaque key format is the documented one, exactly', () => {
  assert.equal(R22.length, 22, 'the fixture random section is the documented length');
  assert.equal(C8.length, 8, 'and so is the checksum');
  assert.equal(__testing.classifyKey(`sb_publishable_${R22}_${C8}`), 'browser');
  assert.equal(__testing.classifyKey(`sb_secret_${R22}_${C8}`), 'elevated');

  /* The regexes are anchored, whole-string, and shared with the tests. */
  assert.match(`sb_publishable_${R22}_${C8}`, __testing.PUBLISHABLE_KEY_FORMAT);
  assert.match(`sb_secret_${R22}_${C8}`, __testing.SECRET_KEY_FORMAT);
});

test('a key of the wrong shape is refused, one deviation at a time', () => {
  /* THE DEFECT THIS PINS. The rule used to be "any non-empty URL-safe
     suffix", which accepted `sb_publishable_x` and `sb_secret_abc` — values
     Supabase does not issue. Each case below is a valid key with exactly one
     thing wrong with it. */
  const cases = [
    [`sb_publishable_${R22.slice(0, 21)}_${C8}`, 'a 21-character random section'],
    [`sb_publishable_${R22}x_${C8}`, 'a 23-character random section'],
    [`sb_publishable_${R22}_${C8.slice(0, 7)}`, 'a 7-character checksum'],
    [`sb_publishable_${R22}_${C8}x`, 'a 9-character checksum'],
    [`sb_publishable_${'A'.repeat(31)}`, 'no separator at all, correct total length'],
    [`sb_publishable_${R22}__${C8}`, 'an extra separator'],
    [`sb_publishable__${C8}`, 'an empty random section'],
    [`sb_publishable_${R22}_`, 'an empty checksum'],
    [`sb_publishable_${R22}`, 'no checksum section'],
    [`sb_publishable_${R22.slice(0, 21)}.${'_'}${C8}`, 'a dot in the random section'],
    [`sb_publishable_${R22}_${C8.slice(0, 7)}!`, 'a bang in the checksum'],
    [`sb_publishable_${R22.slice(0, 21)} _${C8}`, 'a space in the random section'],
    [`sb_publishable_${R22}_${C8}\n`, 'a trailing newline'],
    [` sb_publishable_${R22}_${C8}`, 'a leading space'],
    [`sb_publishable_${R22}_${C8} `, 'a trailing space'],
    /* Correct length and correct shape, wrong prefix. */
    [`sb_publishble_${R22}_${C8}`, 'a misspelled prefix'],
    [`sb_public_${R22}_${C8}`, 'a truncated prefix word'],
    [`sb_publishablex_${R22}_${C8}`, 'a prefix with no separator'],
    [`sbpublishable_${R22}_${C8}`, 'a prefix missing its underscore'],
    [`SB_PUBLISHABLE_${R22}_${C8}`, 'an upper-case prefix'],
    [`pk_live_${R22}_${C8}`, 'another vendour\'s prefix']
  ];

  for (const [value, label] of cases) {
    assert.equal(__testing.classifyKey(value), null, `${label} must not classify`);
    assert.equal(__testing.lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: value }), '', label);
    /* And the same deviations on the secret side. */
    const asSecret = value.replace('sb_publishable_', 'sb_secret_');
    assert.equal(__testing.elevatedKey({ SUPABASE_SECRET_KEY: asSecret }), '',
      `${label} (secret)`);
  }
});

test('the one ambiguity the documented format carries is stated, not hidden', () => {
  /* `_` is inside the character class, so an "extra separator" that keeps the
     total length correct is indistinguishable from a checksum containing an
     underscore. This is a property of the format Supabase documents, not a
     gap invented here — recorded so the rejection list above is not read as
     stronger than it is. A separator that CHANGES the length is refused, and
     that case is covered above. */
  const sneaky = `sb_publishable_${R22.slice(0, 10)}_${R22.slice(11)}_${C8}`;
  assert.equal(sneaky.length, `sb_publishable_${R22}_${C8}`.length,
    'same total length as a valid key');
  assert.equal(__testing.classifyKey(sneaky), 'browser',
    'accepted, because the documented format cannot tell it apart — and it is '
    + 'still the right prefix, the right length and the right alphabet');
});

test('classifyKey recognises exactly the four supported types', () => {
  assert.equal(__testing.classifyKey(PUBLISHABLE), 'browser');
  assert.equal(__testing.classifyKey(ANON_JWT), 'browser');
  assert.equal(__testing.classifyKey(SECRET), 'elevated');
  assert.equal(__testing.classifyKey(SERVICE_JWT), 'elevated');

  for (const [value, label] of UNCLASSIFIABLE) {
    assert.equal(__testing.classifyKey(value), null, `${label} must not classify`);
  }
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(__testing.classifyKey(bad), null, String(bad));
  }
});

test('auth-config returns 503 for every value that is not a publishable key', async () => {
  /* THE POINT: a browser must never be handed something that merely was not
     recognised as a secret. */
  const rejected = [
    ...UNCLASSIFIABLE.map(([v, l]) => [v, l]),
    [SECRET, 'a secret key'],
    [SERVICE_JWT, 'a service_role JWT']
  ];

  for (const [value, label] of rejected) {
    const { value: response, lines } = await capture(() => get('/auth-config', {
      env: { ...ENV, SUPABASE_PUBLISHABLE_KEY: value, SUPABASE_ANON_KEY: '' }
    }));
    assert.equal(response.status, 503, label);
    const text = await response.text();
    assert.equal(JSON.parse(text).code, 'auth_unavailable', label);
    /* And the rejected value is never echoed or logged. */
    if (value.trim().length > 3) {
      assert.equal(text.includes(value), false, `${label} was echoed`);
      assert.equal(lines.join('\n').includes(value), false, `${label} was logged`);
    }
  }
});

test('auth-config serves a positively classified publishable key, either spelling', async () => {
  for (const [preferred, legacy, expected] of [
    [PUBLISHABLE, '', PUBLISHABLE],
    ['', ANON_JWT, ANON_JWT]
  ]) {
    const response = await get('/auth-config', {
      env: { ...ENV, SUPABASE_PUBLISHABLE_KEY: preferred, SUPABASE_ANON_KEY: legacy }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).publishableKey, expected);
  }
});

test('an invalid preferred variable does NOT fall back to the legacy one', async () => {
  /* `A || B` would have done exactly that: a typo in the preferred variable
     would silently run the deployment on the legacy key, so the typo stays
     invisible until the legacy variable is removed. */
  const response = await get('/auth-config', {
    env: { ...ENV, SUPABASE_PUBLISHABLE_KEY: 'typo-not-a-key', SUPABASE_ANON_KEY: ANON_JWT }
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'auth_unavailable');

  /* Same rule on the elevated pair. */
  assert.equal(__testing.selectKey('typo', SERVICE_JWT, 'elevated'), '');
  /* An ABSENT preferred variable still uses the legacy one — the rule is
     about invalid, not about missing. */
  assert.equal(__testing.selectKey(undefined, SERVICE_JWT, 'elevated'), SERVICE_JWT);
  assert.equal(__testing.selectKey('', ANON_JWT, 'browser'), ANON_JWT);
});

test('the elevated key fails closed on exactly the same terms', async () => {
  /* The reverse boundary. An unclassifiable value in the secret variable must
     not be used for the privileged RPC either. */
  assert.equal(__testing.elevatedKey({ SUPABASE_SECRET_KEY: SECRET }), SECRET);
  assert.equal(__testing.elevatedKey({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT }), SERVICE_JWT);

  for (const [value, label] of [...UNCLASSIFIABLE, [PUBLISHABLE, 'a publishable key'],
                                [ANON_JWT, 'an anon JWT']]) {
    assert.equal(__testing.elevatedKey({ SUPABASE_SECRET_KEY: value }), '',
      `${label} must not be usable as the elevated key`);
  }

  /* And with no usable elevated key the privileged path is unavailable
     rather than attempted. */
  const request = new Request(`${PREFIX}/cases`, {
    method: 'GET',
    headers: { authorization: `Bearer ${AAL2}`, 'sec-fetch-site': 'same-origin',
               'x-vercel-forwarded-for': CALLER_IP }
  });
  const response = await handleRequest(request, {
    env: { ...ENV, SUPABASE_SECRET_KEY: 'not-a-key', SUPABASE_SERVICE_ROLE_KEY: '' },
    verifyAccessToken: async () => ({ userId: USER, aal: 'aal2', emailConfirmed: true }),
    correlationId: 'boundary-test'
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'database_unavailable');
});

/* ============================================================
   2b. GET /auth-config accepts no body — actually
   ------------------------------------------------------------
   THE DEFECT THIS PINS. The old test only sent bodies with
   POST/PUT/PATCH/DELETE, which are refused for their METHOD long
   before a body is considered. A GET carrying a body was never
   exercised at all.

   The standard Request constructor forbids a GET body, so the
   boundary is driven with a Request-like fixture that reports
   exactly what a runtime would: the headers, and a body stream.
   ============================================================ */

/* Minimal and honest: only the surface handleRequest actually touches. The
   body stream is deliberately readable, so a handler that DID read it would
   succeed — the test would then fail on the 200, not on a throw. */
const getWithBody = ({ headers = {}, body = null } = {}) => ({
  method: 'GET',
  url: `${PREFIX}/auth-config`,
  headers: new Headers({ 'sec-fetch-site': 'same-origin',
                         'x-vercel-forwarded-for': CALLER_IP, ...headers }),
  body
});

const streamOf = text => new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }
});

test('a GET with a declared Content-Length is refused without being read', async () => {
  /* The probe is in `pull` with highWaterMark 0, and both details matter.
     `start` runs when the stream is CONSTRUCTED, so a flag set there is true
     before handleRequest ever sees the request. And with the DEFAULT queuing
     strategy the stream pulls once immediately to fill its queue, which is
     equally not a read by our code. highWaterMark 0 means `pull` fires only
     when a consumer actually asks for a chunk. */
  let read = false;
  const stream = new ReadableStream({
    pull(controller) {
      read = true;
      controller.enqueue(new TextEncoder().encode('{"password":"leaked"}'));
      controller.close();
    }
  }, { highWaterMark: 0 });

  const { value: response, lines } = await capture(() => handleRequest(
    getWithBody({ headers: { 'content-length': '21' }, body: stream }),
    { env: ENV, db: noDatabase, authClient: noAuthClient, correlationId: 'boundary-test' }));

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'unexpected_body');
  assert.equal(read, false, 'the body stream was never pulled');
  assert.equal(JSON.stringify(body).includes('leaked'), false);
  assert.equal(lines.join('\n').includes('leaked'), false);
});

test('a GET with a chunked body is refused, which length alone would miss', async () => {
  const { value: response } = await capture(() => handleRequest(
    getWithBody({
      headers: { 'transfer-encoding': 'chunked' },
      body: streamOf('{"password":"leaked"}')
    }),
    { env: ENV, db: noDatabase, authClient: noAuthClient, correlationId: 'boundary-test' }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'unexpected_body');
});

test('a GET with a body and no framing headers is refused on the stream alone', async () => {
  const { value: response } = await capture(() => handleRequest(
    getWithBody({ body: streamOf('{"password":"leaked"}') }),
    { env: ENV, db: noDatabase, authClient: noAuthClient, correlationId: 'boundary-test' }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'unexpected_body');
});

test('a body-bearing GET builds no Auth client and reads no privileged data', async () => {
  /* `noDatabase` throws on any property access and `noAuthClient` throws when
     called; a 400 rather than a 500 is the proof neither was touched. */
  const { value: response } = await capture(() => handleRequest(
    getWithBody({ headers: { 'content-length': '21' }, body: streamOf('{"a":1}') }),
    { env: ENV, db: noDatabase, authClient: noAuthClient, correlationId: 'boundary-test' }));
  assert.equal(response.status, 400);
});

test('a Content-Length of zero is not a body, and an ordinary GET still works', async () => {
  for (const headers of [{}, { 'content-length': '0' }]) {
    const response = await handleRequest(
      getWithBody({ headers }),
      { env: ENV, db: noDatabase, authClient: noAuthClient, correlationId: 'boundary-test' });
    assert.equal(response.status, 200, JSON.stringify(headers));
  }

  /* And the real, standard Request the console actually sends is unaffected. */
  const real = await get('/auth-config');
  assert.equal(real.status, 200);
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

test('auth-config reaches no database at all, and builds no Auth client', async () => {
  /* The db throws on every call except `check_rate_limit`, and the Auth
     client factory throws when called at all. A 200 is the proof that neither
     was touched.

     THIS ASSERTED ONE LIMITER PASS UNTIL THE ENDPOINT WAS DECOUPLED. It is
     zero now, and the change is deliberate: this endpoint returns the project
     origin and the publishable key, authenticates nothing and reads no table,
     so metering it only made the console's own configuration depend on the
     elevated client. tests/staff-auth-config-public.test.mjs owns that claim
     in full, including the proof that no other route was widened. */
  limiterCalls.length = 0;
  const response = await get('/auth-config');
  assert.equal(response.status, 200);
  assert.equal(limiterCalls.length, 0, 'no limiter pass, and no other query');
});

/* ============================================================
   3. No ONBOARDING OR RECOVERY path accepts a credential
   ------------------------------------------------------------
   Scoped, and the title says so. The console's /session endpoints
   are excluded BY NAME below rather than by omission, because
   omitting them silently is how the earlier over-broad claim —
   "no CED endpoint accepts a credential" — came to be believed.
   ============================================================ */

test('no onboarding or recovery path accepts a password, token, TOTP code, secret or URI', async () => {
  /* Fired at every removed onboarding path, the configuration endpoint, the
     queue, and some plausible names an onboarding route might be given later.
     Nothing may answer `ok: true`, and nothing may echo a submitted value
     back. */
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

  /* NOT in the list, deliberately: /session, /session/refresh and
     /session/signout. They accept a password and a TOTP code on purpose, and
     asserting they refuse one would assert that sign-in does not work. */
  for (const excluded of ['/session', '/session/refresh', '/session/signout']) {
    assert.equal(paths.includes(excluded), false,
      `${excluded} is server-mediated by design and is out of scope for this test`);
  }

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

test('the console sign-in endpoints DO still handle credentials, and that is intended', () => {
  /* THE HONEST OTHER HALF. `/session` has always exchanged a password and a
     TOTP code for a token, and still does — it is not a defect and it is not
     in scope for this change. Asserting its presence keeps the scoped claims
     above truthful: exactly one password-exchange path exists, it is the
     console sign-in, and it is reachable. */
  const signInCalls = SERVER_SRC.match(/signInWithPassword/g) || [];
  assert.equal(signInCalls.length, 1, 'exactly one password exchange remains');
  assert.ok(SERVER_SRC.includes('const handleSignIn'), 'and it is the console sign-in');
  assert.ok(SERVER_SRC.includes('challengeAndVerify'),
    'the console still verifies a TOTP code server-side');
  /* The routing line itself, as a literal — a regex over the whole source
     would have to anchor, and anchoring against a whole file is how a test
     silently matches nothing. */
  assert.ok(SERVER_SRC.includes("path.match(/\\/session(?:\\/(refresh|signout))?$/)"),
    'and the three session endpoints are still routed');
  for (const handler of ['handleSignIn', 'handleRefresh', 'handleSignOut']) {
    assert.ok(SERVER_SRC.includes(`const ${handler}`), `${handler} is still present`);
  }
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
    method: 'GET', headers: { authorization: `Bearer ${AAL2}`,
      'sec-fetch-site': 'same-origin', 'x-vercel-forwarded-for': CALLER_IP }
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
    method: 'GET', headers: { authorization: 'Bearer x.y.z',
      'sec-fetch-site': 'same-origin', 'x-vercel-forwarded-for': CALLER_IP }
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
