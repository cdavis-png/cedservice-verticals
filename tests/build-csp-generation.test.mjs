/* ============================================================
   The generated Content-Security-Policy
   ------------------------------------------------------------
   THE DEFECT THIS FILE EXISTS FOR. The onboarding page has to
   name the exact Supabase project origin in its `connect-src`,
   because it talks to Supabase Auth directly. That origin differs
   between Preview and Production, and `vercel.json` is static
   JSON with no substitution — so it carried
   `https://REPLACE-WITH-PROJECT-REF.supabase.co`, to be replaced
   by hand after review.

   A deployable file with a placeholder in it is a deployment
   waiting to ship the placeholder. Hardcoding the development
   origin instead would have been worse: the production
   deployment would then have been permitted to reach the
   development project's Auth server, which is a production page
   pointed at development data.

   The origin is now generated per build from SUPABASE_URL — the
   SAME variable `GET /auth-config` reads, through the SAME
   validator, so the origin the page is told to call and the
   origin it is permitted to reach cannot diverge.

   This file owns the VALIDATOR, the route half, and the source
   contract the build depends on. It deliberately calls no build:
   `buildStatic` writes the repository's real `dist/`, and node's
   test runner runs files concurrently, so exactly one file may
   invoke it — tests/static-output-contract.test.mjs, which owns
   that directory and holds the per-environment generation tests.
   The header/meta split is owned by
   tests/staff-deployment-contract.test.mjs.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

import { __testing as buildTesting } from '../tools/build-static.mjs';
import supabaseOrigin from '../shared/security/supabase-origin.js';
import { handleRequest } from '../server/staff-identity-resolution.mjs';
import { PUBLISHABLE_FIXTURE, SECRET_FIXTURE } from './helpers/supabase-keys.mjs';

const { validateSupabaseOrigin, validateLocalSupabaseOrigin, describeOriginFailure } =
  supabaseOrigin;
const { GENERATED_FILES, CSP_SOURCE_LINE, cspLineFor, resolveSupabaseOrigin } = buildTesting;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Two real project origins, deliberately different, standing in for Preview
   and Production. The first is this project's actual development project —
   used as an EXAMPLE of the shape, never as a default anything falls back
   to. */
const DEVELOPMENT = 'https://qkpptajglstgucadhfwq.supabase.co';
const PRODUCTION = 'https://abcdefghijklmnopqrst.supabase.co';

/* ============================================================
   1. Everything invalid is refused, closed
   ============================================================ */

test('a missing, malformed, secret-bearing or non-Supabase value is refused', () => {
  const cases = [
    [undefined, /is not set/, 'absent'],
    ['', /is not set/, 'empty'],
    ['   ', /is not set/, 'whitespace'],
    ['sb_secret_abcdefghijklmnop', /shaped like a Supabase key/, 'a secret key'],
    ['sb_publishable_abcdefghij', /shaped like a Supabase key/, 'a publishable key'],
    ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x',
      /shaped like a Supabase key/, 'a legacy service-role JWT'],
    ['http://qkpptajglstgucadhfwq.supabase.co', /must use https/, 'http'],
    ['ftp://qkpptajglstgucadhfwq.supabase.co', /must use https/, 'ftp'],
    ['qkpptajglstgucadhfwq.supabase.co', /not a valid absolute URL/, 'no scheme'],
    ['https://user:pass@qkpptajglstgucadhfwq.supabase.co', /username or password/, 'credentials'],
    [`${DEVELOPMENT}/auth/v1`, /origin only, with no path/, 'a path'],
    [`${DEVELOPMENT}/?x=1`, /must not contain a query/, 'a query'],
    [`${DEVELOPMENT}/#f`, /must not contain a fragment/, 'a fragment'],
    [`${DEVELOPMENT}:8443`, /must not specify a port/, 'a non-default port'],
    ['https://evil.test', /exact Supabase project host/, 'a foreign host'],
    ['https://supabase.co', /exact Supabase project host/, 'the bare registrable domain'],
    ['https://a.b.supabase.co', /exact Supabase project host/, 'a nested subdomain'],
    ['https://*.supabase.co', /exact Supabase project host/, 'a wildcard'],
    ['https://qkpptajglstgucadhfwq.supabase.co.evil.test', /exact Supabase project host/, 'a suffix trick'],
    ['https://short.supabase.co', /exact Supabase project host/, 'too short to be a ref'],
    [`${DEVELOPMENT} https://evil.test`, /one origin with no whitespace/, 'two sources'],
    [`${DEVELOPMENT};script-src *`, /one origin with no whitespace/, 'a directive injection'],
    [`${DEVELOPMENT}'`, /one origin with no whitespace/, 'a quote'],
    [42, /is not set/, 'not a string']
  ];

  for (const [value, pattern, label] of cases) {
    assert.equal(validateSupabaseOrigin(value).ok, false, label);
    /* The build's own resolver throws with the human-readable reason. */
    assert.throws(() => resolveSupabaseOrigin({ SUPABASE_URL: value }), pattern, label);
  }
});

test('the refusal never echoes the offending value', () => {
  /* A misconfiguration message in a build log must not become the place a
     pasted key gets written down. */
  const key = 'sb_secret_do-not-log-this-value';
  try {
    resolveSupabaseOrigin({ SUPABASE_URL: key });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.message.includes(key), false, 'the value must not appear in the error');
    assert.match(err.message, /shaped like a Supabase key/);
  }
});

test('the default https port is the same origin, not a second spelling', () => {
  /* `:443` on https normalises away, so it is accepted and produces the
     identical source. Refusing it would fail a deployment over a spelling
     that means exactly the same thing. */
  const ok = validateSupabaseOrigin(`${DEVELOPMENT}:443`);
  assert.equal(ok.ok, true);
  assert.equal(ok.origin, DEVELOPMENT);
});

test('a trailing slash normalises to one spelling of one origin', () => {
  assert.equal(validateSupabaseOrigin(`${DEVELOPMENT}/`).origin, DEVELOPMENT);
  assert.equal(validateSupabaseOrigin(DEVELOPMENT).origin, DEVELOPMENT);
  assert.equal(resolveSupabaseOrigin({ SUPABASE_URL: `${DEVELOPMENT}/` }), DEVELOPMENT);
});

/* ============================================================
   2. The local-development exception is fenced
   ============================================================ */

test('the loopback exception exists for local development and only there', () => {
  /* The browser suite and `npm run serve` point SUPABASE_URL at a loopback
     stub. That must never be something the BUILD accepts, or a published page
     could name an origin no visitor can reach. */
  for (const local of ['http://127.0.0.1:5555', 'http://localhost:3000', 'https://localhost:8443']) {
    assert.equal(validateLocalSupabaseOrigin(local).ok, true, local);
    assert.equal(validateSupabaseOrigin(local).ok, false,
      `${local}: the strict validator must refuse it`);
    assert.throws(() => resolveSupabaseOrigin({ SUPABASE_URL: local }),
      /refusing to build/, `${local}: the build must refuse it`);
  }

  /* And it is still a validator, not a hole: everything else is refused. */
  for (const bad of ['http://evil.test', 'http://127.0.0.1:5555/path',
                     'http://127.0.0.1:5555/?x=1', 'sb_secret_x', 'http://0.0.0.0:5555']) {
    assert.equal(validateLocalSupabaseOrigin(bad).ok, false, bad);
  }
});

test('the loopback exception needs the switch, a loopback host and non-production', async () => {
  const local = 'http://127.0.0.1:5555';
  const key = PUBLISHABLE_FIXTURE;

  const call = (env, host = 'localhost') => handleRequest(
    new Request(`http://${host}/api/staff/identity-resolution/auth-config`, {
      method: 'GET', headers: { 'sec-fetch-site': 'same-origin' }
    }), { env, correlationId: 'csp-test' });

  /* All three present: accepted. */
  const ok = await call({
    SUPABASE_URL: local, SUPABASE_PUBLISHABLE_KEY: key,
    CED_ALLOW_INSECURE_STAFF: 'true', CED_LOG_LEVEL: 'error'
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).supabaseUrl, local);

  /* Switch off: refused, and the request is refused for being http anyway. */
  const noSwitch = await call({
    SUPABASE_URL: local, SUPABASE_PUBLISHABLE_KEY: key, CED_LOG_LEVEL: 'error'
  });
  assert.notEqual(noSwitch.status, 200);

  /* NODE_ENV=production: refused even with the switch and a loopback host. */
  const production = await call({
    SUPABASE_URL: local, SUPABASE_PUBLISHABLE_KEY: key,
    CED_ALLOW_INSECURE_STAFF: 'true', NODE_ENV: 'production', CED_LOG_LEVEL: 'error'
  });
  assert.notEqual(production.status, 200);

  /* A real deployment host: the switch cannot reach the exception. */
  const deployed = await handleRequest(
    new Request('https://staff.example.com/api/staff/identity-resolution/auth-config', {
      method: 'GET', headers: { 'sec-fetch-site': 'same-origin' }
    }), {
      env: {
        SUPABASE_URL: local, SUPABASE_PUBLISHABLE_KEY: key,
        CED_ALLOW_INSECURE_STAFF: 'true', CED_LOG_LEVEL: 'error'
      },
      correlationId: 'csp-test'
    });
  assert.equal(deployed.status, 503);
  assert.equal((await deployed.json()).code, 'auth_unavailable');
});

/* ============================================================
   3. The route half
   ============================================================ */

test('auth-config refuses exactly what the build refuses', async () => {
  for (const value of ['', 'https://evil.test', `${DEVELOPMENT}/auth/v1`,
                       'sb_secret_abcdefghijk', 'http://qkpptajglstgucadhfwq.supabase.co']) {
    const response = await handleRequest(
      new Request('https://staff.example.com/api/staff/identity-resolution/auth-config', {
        method: 'GET', headers: { 'sec-fetch-site': 'same-origin' }
      }), {
        env: { SUPABASE_URL: value, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_FIXTURE,
               CED_LOG_LEVEL: 'error' },
        correlationId: 'csp-test'
      });
    assert.equal(response.status, 503, value);
    const body = await response.json();
    assert.equal(body.code, 'auth_unavailable');
    assert.equal(JSON.stringify(body).includes(value) && value !== '', false,
      'the refusal never echoes the configured value');
  }
});

test('auth-config returns only the origin and a publishable key, and is never cached', async () => {
  const response = await handleRequest(
    new Request('https://staff.example.com/api/staff/identity-resolution/auth-config', {
      method: 'GET', headers: { 'sec-fetch-site': 'same-origin' }
    }), {
      env: {
        SUPABASE_URL: `${DEVELOPMENT}/`,
        SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_FIXTURE,
        SUPABASE_SECRET_KEY: SECRET_FIXTURE,
        CED_RATE_LIMIT_SECRET: 'never-this-either',
        CED_CONTINUATION_SECRET: 'nor-this',
        CED_LOG_LEVEL: 'error'
      },
      correlationId: 'csp-test'
    });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');

  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'publishableKey', 'supabaseUrl'],
    'no unrelated configuration travels with it');
  assert.equal(body.supabaseUrl, DEVELOPMENT, 'normalised, so it matches the CSP exactly');
  assert.equal(body.publishableKey, PUBLISHABLE_FIXTURE);

  const text = JSON.stringify(body);
  for (const secret of [SECRET_FIXTURE, 'never-this-either', 'nor-this']) {
    assert.equal(text.includes(secret), false);
  }
});

/* ============================================================
   4. The validator itself
   ============================================================ */

test('the validator accepts an exact origin and nothing else', () => {
  const ok = validateSupabaseOrigin(DEVELOPMENT);
  assert.equal(ok.ok, true);
  assert.equal(ok.origin, DEVELOPMENT);

  /* Every reason has a message; an unmapped one would surface as a useless
     "not usable" in a build log. */
  for (const reason of Object.keys(supabaseOrigin.ORIGIN_FAILURE)) {
    assert.ok(describeOriginFailure(reason).length > 10, reason);
  }
});

test('the validator is server-only and is not published', async () => {
  const { STATIC_MANIFEST, SERVER_ONLY_SECURITY_MODULES } =
    await import('../tools/static-manifest.mjs');
  assert.equal(STATIC_MANIFEST.includes('shared/security/supabase-origin.js'), false,
    'the browser is TOLD the origin by /auth-config and has no use for the validator');
  assert.ok(SERVER_ONLY_SECURITY_MODULES.includes('shared/security/supabase-origin.js'),
    'and its absence is asserted by name');
});

test('the CSP source line is the fail-closed baseline', () => {
  /* The committed page reaches no Supabase at all. Only a build with a valid
     SUPABASE_URL adds an origin, so an unbuilt copy — or one served from the
     repository by mistake — cannot talk to the wrong project. */
  assert.ok(CSP_SOURCE_LINE.includes("connect-src 'self';"));
  assert.equal(CSP_SOURCE_LINE.includes('supabase'), false);

  for (const rel of GENERATED_FILES) {
    const source = readFileSync(join(ROOT, rel.split('/').join(sep)), 'utf8');
    assert.equal(source.split(CSP_SOURCE_LINE).length - 1, 1,
      `${rel}: the source carries the base line exactly once`);
  }

  const generated = cspLineFor(DEVELOPMENT);
  assert.ok(generated.includes(`connect-src 'self' ${DEVELOPMENT};`));
  assert.equal(generated.replace(` ${DEVELOPMENT}`, ''), CSP_SOURCE_LINE,
    'generation appends one source and changes nothing else');
});

test('the base CSP line precedes every resource each generated page loads', () => {
  /* A meta policy governs only what is parsed after it. One placed below a
     <script> or a <link> would not have covered it, and the build substitutes
     in place — so the position is the source's responsibility. */
  assert.ok(GENERATED_FILES.length >= 2, 'the invitation page and the recovery page');
  for (const rel of GENERATED_FILES) {
    const source = readFileSync(join(ROOT, rel.split('/').join(sep)), 'utf8');
    const at = source.indexOf(CSP_SOURCE_LINE);
    assert.ok(at > 0, `${rel} does not carry the base CSP line`);
    for (const marker of ['<script', '<link', '<img', '<style']) {
      const first = source.indexOf(marker);
      if (first !== -1) assert.ok(at < first, `${rel}: the policy must precede the first ${marker}`);
    }
  }
});

test('PRODUCTION and DEVELOPMENT are genuinely different origins', () => {
  /* The per-environment build test in static-output-contract depends on it. */
  assert.notEqual(DEVELOPMENT, PRODUCTION);
  assert.equal(validateSupabaseOrigin(PRODUCTION).ok, true);
  assert.notEqual(cspLineFor(DEVELOPMENT), cspLineFor(PRODUCTION));
});
