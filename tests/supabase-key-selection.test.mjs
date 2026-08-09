/* ============================================================
   One elevated key, selected the same way by every server surface
   ------------------------------------------------------------
   THE DEFECT THIS FILE EXISTS TO PIN.

   `server/staff-identity-resolution.mjs` preferred
   `SUPABASE_SECRET_KEY` and accepted `SUPABASE_SERVICE_ROLE_KEY` as
   a legacy fallback. `api/assessments.mjs` and `api/analytics.mjs`
   read `SUPABASE_SERVICE_ROLE_KEY` and nothing else.

   So a deployment configured the way Supabase currently documents —
   set the secret key, ignore the retired name — brought up the
   AUTHENTICATED staff console and left assessment capture answering
   `503 not_configured` and analytics silently degraded. The
   privileged surface works, the public capture path the product
   exists to feed does not, and no log line anywhere states a cause,
   because from each route's own point of view nothing is wrong.

   Every test below fails against the pre-fix source in at least one
   of its cases.

   NO REAL KEY APPEARS HERE. The modern values are syntactically
   valid and cryptographically meaningless; the legacy ones are
   unsigned JWTs whose payload this code reads and never verifies.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import supabaseKeys from '../shared/security/supabase-keys.js';
import { __testing as assessmentsTesting } from '../api/assessments.mjs';
import { __testing as analyticsTesting } from '../api/analytics.mjs';
import { __testing as staffTesting } from '../server/staff-identity-resolution.mjs';

const { classifyKey, selectKey, elevatedKey, lowPrivilegeKey } = supabaseKeys;

/* ---------- fixtures ----------
   sb_secret_<22>_<8> and sb_publishable_<22>_<8>, the documented shape. */
const MODERN_SECRET      = `sb_secret_${'a'.repeat(22)}_${'b'.repeat(8)}`;
const MODERN_SECRET_TWO  = `sb_secret_${'c'.repeat(22)}_${'d'.repeat(8)}`;
const MODERN_PUBLISHABLE = `sb_publishable_${'e'.repeat(22)}_${'f'.repeat(8)}`;

/* An unsigned JWT. Only the payload's `role` is ever read. */
const jwt = role => {
  const seg = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ role, iss: 'supabase' })}.notasignature`;
};
const LEGACY_SERVICE_ROLE = jwt('service_role');
const LEGACY_ANON = jwt('anon');

/* Values that are not keys at all. `test-key-never-real` is the literal the
   existing endpoint fixtures use, and it is deliberately in this list: it was
   accepted by the old `if (!env.SUPABASE_SERVICE_ROLE_KEY)` check and is
   refused now. */
const NOT_A_KEY = [
  'test-key-never-real',
  'sb_secret_tooshort',
  `sb_secret_${'a'.repeat(22)}_${'b'.repeat(7)}`,
  `  ${MODERN_SECRET}  `,
  `${MODERN_SECRET}\n`,
  jwt('authenticated'),
  'eyJhbGciOiJIUzI1NiJ9..sig',
  'undefined',
  '{}'
];

const URL_OK = 'https://example.supabase.co';

/* ============================================================
   1. The classifier
   ============================================================ */

test('a key is classified only when it is positively one of the four issued types', () => {
  assert.equal(classifyKey(MODERN_SECRET), 'elevated');
  assert.equal(classifyKey(LEGACY_SERVICE_ROLE), 'elevated');
  assert.equal(classifyKey(MODERN_PUBLISHABLE), 'browser');
  assert.equal(classifyKey(LEGACY_ANON), 'browser');

  for (const value of NOT_A_KEY) {
    assert.equal(classifyKey(value), null, `${JSON.stringify(value)} must not classify`);
  }
  for (const value of [undefined, null, '', 0, 1, {}, [], true]) {
    assert.equal(classifyKey(value), null, `${JSON.stringify(value)} must not classify`);
  }
});

test('a browser key is never mistaken for an elevated one, in either direction', () => {
  /* The failure this prevents is a privilege change, not an outage. */
  assert.equal(elevatedKey({ SUPABASE_SECRET_KEY: MODERN_PUBLISHABLE }), '');
  assert.equal(elevatedKey({ SUPABASE_SERVICE_ROLE_KEY: LEGACY_ANON }), '');
  assert.equal(lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: MODERN_SECRET }), '');
  assert.equal(lowPrivilegeKey({ SUPABASE_ANON_KEY: LEGACY_SERVICE_ROLE }), '');
});

/* ============================================================
   2. Preference, fallback, and the rule that there is no fallback
      from a bad preferred value
   ============================================================ */

test('the modern variable is preferred and the legacy one is only a fallback', () => {
  assert.equal(elevatedKey({ SUPABASE_SECRET_KEY: MODERN_SECRET }), MODERN_SECRET,
    'the modern variable alone is enough');
  assert.equal(elevatedKey({ SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE_ROLE }), LEGACY_SERVICE_ROLE,
    'the legacy variable alone still works');
  assert.equal(
    elevatedKey({ SUPABASE_SECRET_KEY: MODERN_SECRET, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE_ROLE }),
    MODERN_SECRET,
    'with both set, the modern one decides');
  assert.equal(elevatedKey({}), '', 'neither set is not configured');
  assert.equal(elevatedKey({ SUPABASE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' }), '',
    'empty is unset, not malformed');
});

test('an empty preferred variable falls back; a MALFORMED one does not', () => {
  /* The distinction is the whole rule. `A || B` cannot express it: a typo in
     the preferred variable would silently run the deployment on the legacy
     key, so the mistake is invisible until the legacy variable is removed —
     which is the worst possible moment to discover it. */
  assert.equal(
    elevatedKey({ SUPABASE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE_ROLE }),
    LEGACY_SERVICE_ROLE,
    'unset preferred falls through');

  for (const bad of NOT_A_KEY.concat([MODERN_PUBLISHABLE])) {
    assert.equal(
      elevatedKey({ SUPABASE_SECRET_KEY: bad, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE_ROLE }),
      '',
      `a set-but-unusable SUPABASE_SECRET_KEY must not fall back: ${JSON.stringify(bad)}`);
  }
});

test('the same rule governs the browser key, so the two cannot drift', () => {
  assert.equal(lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: MODERN_PUBLISHABLE }), MODERN_PUBLISHABLE);
  assert.equal(lowPrivilegeKey({ SUPABASE_ANON_KEY: LEGACY_ANON }), LEGACY_ANON);
  assert.equal(
    lowPrivilegeKey({ SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_typo', SUPABASE_ANON_KEY: LEGACY_ANON }),
    '',
    'a malformed publishable key does not fall back to anon either');
});

test('selectKey answers only for the privilege level it was asked about', () => {
  assert.equal(selectKey(MODERN_SECRET, '', 'elevated'), MODERN_SECRET);
  assert.equal(selectKey(MODERN_SECRET, '', 'browser'), '');
  assert.equal(selectKey(MODERN_PUBLISHABLE, '', 'browser'), MODERN_PUBLISHABLE);
  assert.equal(selectKey(MODERN_PUBLISHABLE, '', 'elevated'), '');
});

/* ============================================================
   3. Every consumer, through its own production client factory
      ------------------------------------------------------------
      Not the shared function called again — the real getClient each
      route uses when no db is injected, which is always in a
      deployment. Building a supabase-js client opens no socket.
   ============================================================ */

/* Each entry names how that route reports "no usable key", because the three
   answers are deliberately different and each is correct for its surface. */
const CONSUMERS = [
  {
    name: 'api/assessments.mjs',
    getClient: assessmentsTesting.getClient,
    /* Capture must stop loudly: a lost assessment is a lost lead. */
    refusal: async env => {
      await assert.rejects(() => assessmentsTesting.getClient(env),
        err => err.status === 503 && err.code === 'not_configured');
    }
  },
  {
    name: 'api/analytics.mjs',
    getClient: analyticsTesting.getClient,
    /* Analytics degrades to a no-op: it may never cost a visitor their work. */
    refusal: async env => {
      assert.equal(await analyticsTesting.getClient(env), null);
    }
  },
  {
    name: 'server/staff-identity-resolution.mjs',
    getClient: staffTesting.getServiceClient,
    refusal: async env => {
      await assert.rejects(() => staffTesting.getServiceClient(env),
        err => err.status === 503 && err.code === 'database_unavailable');
    }
  }
];

for (const consumer of CONSUMERS) {
  test(`${consumer.name} accepts the modern SUPABASE_SECRET_KEY`, async () => {
    /* This is the case that failed before the shared selector for two of the
       three: they never read this variable. */
    const client = await consumer.getClient({
      SUPABASE_URL: URL_OK, SUPABASE_SECRET_KEY: MODERN_SECRET
    });
    assert.ok(client && typeof client.rpc === 'function',
      'a usable Supabase client was built from the modern variable alone');
  });

  test(`${consumer.name} accepts the legacy SUPABASE_SERVICE_ROLE_KEY`, async () => {
    const client = await consumer.getClient({
      SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE_ROLE
    });
    assert.ok(client && typeof client.rpc === 'function',
      'the legacy variable keeps an existing deployment working');
  });

  test(`${consumer.name} prefers the modern variable when both are set`, async () => {
    /* Observable through the cache: the two keys build two different clients,
       and asking again with only the modern one must return the SAME object.
       If the route had preferred the legacy value, the cache key would differ
       and a new client would come back. */
    const both = await consumer.getClient({
      SUPABASE_URL: URL_OK,
      SUPABASE_SECRET_KEY: MODERN_SECRET_TWO,
      SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE_ROLE
    });
    const modernOnly = await consumer.getClient({
      SUPABASE_URL: URL_OK, SUPABASE_SECRET_KEY: MODERN_SECRET_TWO
    });
    assert.equal(both, modernOnly, 'the modern variable is what decided both times');
  });

  test(`${consumer.name} refuses a malformed preferred key without falling back`, async () => {
    /* A valid legacy key IS present. The route must still refuse. */
    for (const bad of ['sb_secret_typo', MODERN_PUBLISHABLE, 'test-key-never-real']) {
      await consumer.refusal({
        SUPABASE_URL: URL_OK,
        SUPABASE_SECRET_KEY: bad,
        SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE_ROLE
      });
    }
  });

  test(`${consumer.name} refuses a publishable key in the elevated variable`, async () => {
    await consumer.refusal({ SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: MODERN_PUBLISHABLE });
    await consumer.refusal({ SUPABASE_URL: URL_OK, SUPABASE_SECRET_KEY: LEGACY_ANON });
  });

  test(`${consumer.name} refuses when no key or no URL is configured`, async () => {
    await consumer.refusal({ SUPABASE_URL: URL_OK });
    await consumer.refusal({ SUPABASE_SECRET_KEY: MODERN_SECRET });
    await consumer.refusal({});
  });
}

/* ============================================================
   4. The rule is stated once
   ============================================================ */

test('no server surface reads an elevated key variable outside the shared selector', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

  for (const rel of ['api/assessments.mjs', 'api/analytics.mjs',
                     'server/staff-identity-resolution.mjs']) {
    const source = readFileSync(join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   /* prose names the variables freely */
      .replace(/^\s*\/\/.*$/gm, '');
    for (const name of ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
      assert.equal(source.includes(name), false,
        `${rel} reads ${name} directly; it must come from shared/security/supabase-keys.js`);
    }
  }

  const selector = readFileSync(join(ROOT, 'shared/security/supabase-keys.js'), 'utf8');
  assert.ok(selector.includes('SUPABASE_SECRET_KEY') &&
            selector.includes('SUPABASE_SERVICE_ROLE_KEY'),
    'and the selector is where both names live');
});
