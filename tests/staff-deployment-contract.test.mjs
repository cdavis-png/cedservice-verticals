/* ============================================================
   The staff route's deployment contract
   ------------------------------------------------------------
   WHAT THIS IS, STATED HONESTLY.

   It is a check on the CONFIGURATION, not on the platform. It
   models Vercel's documented filesystem routing and header
   matching and asserts that the console's paths resolve, that
   the function they resolve to is shaped the way the runtime
   expects, and that the page carries its headers.

   IT IS NOT A `vercel build`. The Vercel CLI is not a dependency
   of this repository and installing one to run a test was out of
   bounds, so nothing here executes the real router. A behaviour
   that differs between the model and the platform would not be
   caught, and that is recorded in
   docs/REAL_POSTGRES_VALIDATION.md rather than implied away.

   WHY IT EXISTS ANYWAY. Two defects, neither subtle, both
   invisible to every other suite.

   The first: a plain `api/<name>.mjs` serves exactly `/api/<name>`
   and nothing below it, while every path the console calls
   carries a sub-path. All of them would have been platform 404s
   that never reached a handler and produced no server log.

   The second: Vercel deploys EVERY file under api/ as its own
   function, so keeping the implementation there deployed the
   privileged route twice — once through the catch-all the console
   calls, and once at its own bare path, absent from vercel.json's
   `functions` block and therefore on platform defaults. The
   implementation now lives in server/.

   TWO COUNTS THAT ARE NOT THE SAME COUNT, because conflating them
   has already caused one contradictory report:

     · THREE deployable filesystem functions — api/analytics.mjs,
       api/assessments.mjs, and the staff catch-all. Vercel derives
       these from the api/ tree, not from vercel.json.
     · TWO entries in vercel.json's `functions` block —
       api/assessments.mjs and the staff catch-all. api/analytics.mjs
       is deliberately left on platform defaults.

   Exactly ONE of the three is the staff route. That is the number
   that matters, and it is asserted on its own below.

   Nothing in the unit suite could see either, because it calls
   handleRequest directly; nothing in the browser suite could see
   them either, because it stubs fetch. The gap was between the
   two, which is exactly where a deployment defect lives.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));

/* THE ENTRYPOINT TESTS INVOKE THE REAL EXPORTS WITH NO INJECTED DEPENDENCIES,
   which is the point — the platform injects nothing either. So they read
   `process.env`, and rate limiting now FAILS CLOSED without a secret: every
   one of them would answer 503 before reaching its own subject.

   A secret is set for the file and restored afterwards. No address header is
   sent by any of these requests, so no bucket key is derived and no database
   is required — the limiter passes through and the test reaches what it came
   for. Never a real value. */
const PREVIOUS_RATE_LIMIT_SECRET = process.env.CED_RATE_LIMIT_SECRET;
process.env.CED_RATE_LIMIT_SECRET = 'test-rate-limit-secret';
test.after(() => {
  if (PREVIOUS_RATE_LIMIT_SECRET === undefined) delete process.env.CED_RATE_LIMIT_SECRET;
  else process.env.CED_RATE_LIMIT_SECRET = PREVIOUS_RATE_LIMIT_SECRET;
});

/* Every path the console actually calls. Read from the two scripts rather
   than restated, so a change to either has to be a change to both. */
const PAGE_JS = readFileSync(join(ROOT, 'staff/identity-resolution/page.js'), 'utf8');
const AUTH_JS = readFileSync(join(ROOT, 'staff/identity-resolution/auth.js'), 'utf8');

/* The queue paths, which carry a bearer token. */
const CONSOLE_PATHS = [
  '/api/staff/identity-resolution/cases',
  '/api/staff/identity-resolution/cases/22222222-2222-4222-8222-222222222222',
  '/api/staff/identity-resolution/cases/22222222-2222-4222-8222-222222222222/link'
];

/* The session paths, which do not. They are on the same catch-all and must
   route just as reliably: an unroutable sign-in is an unusable console. */
const SESSION_PATHS = [
  '/api/staff/identity-resolution/session',
  '/api/staff/identity-resolution/session/refresh',
  '/api/staff/identity-resolution/session/signout'
];

/* The onboarding paths, which accept-invite.js calls before the operator has
   a session of any kind. They sit two segments below the prefix, so they are
   the deepest thing the catch-all has to carry — an `api/<name>.mjs` would
   have served none of them. */
const ONBOARDING_PATHS = [
  '/api/staff/identity-resolution/onboarding/invite',
  '/api/staff/identity-resolution/onboarding/verify'
];

const ALL_PATHS = [...CONSOLE_PATHS, ...SESSION_PATHS, ...ONBOARDING_PATHS];

/* ---------- a model of Vercel filesystem routing for api/ ----------
   Documented behaviour, in three rules:
     api/foo.mjs            -> /api/foo, and nothing beneath it
     api/a/[id].mjs         -> /api/a/<exactly one segment>
     api/a/[...rest].mjs    -> /api/a/<one or more segments>
   The middle rule is the one the original file relied on without having. */
const listFunctions = () => {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(mjs|js|ts)$/.test(entry)) continue;
      out.push(relative(ROOT, full).split('\\').join('/'));
    }
  };
  walk(join(ROOT, 'api'));
  return out;
};

const routePattern = file => {
  const segments = file.replace(/\.(mjs|js|ts)$/, '').split('/');
  const parts = segments.map(segment => {
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) return '(?:/[^/]+)*';   /* optional catch-all */
    if (/^\[\.\.\..+\]$/.test(segment))     return '(?:/[^/]+)+';   /* catch-all */
    if (/^\[.+\]$/.test(segment))           return '/[^/]+';        /* one segment */
    return `/${segment}`;
  });
  return new RegExp(`^${parts.join('')}$`);
};

const resolveRoute = path => listFunctions().filter(f => routePattern(f).test(path));

/* Vercel `source` patterns are path-to-regexp. Only the two shapes this file
   uses are modelled: a literal prefix and a `(.*)` tail. */
const headerMatches = (source, path) =>
  new RegExp(`^${source.replace(/\(\.\*\)/g, '.*')}$`).test(path);

const headersFor = path => {
  const found = {};
  for (const rule of config.headers || []) {
    if (!headerMatches(rule.source, path)) continue;
    for (const h of rule.headers) found[h.key.toLowerCase()] = h.value;
  }
  return found;
};

/* ============================================================
   Routing
   ============================================================ */

test('the page calls the paths this test claims it calls', () => {
  assert.match(PAGE_JS, /['"]\/api\/staff\/identity-resolution['"]/,
    'the default API base is what the routing below is asserted against');
  assert.match(PAGE_JS, /\/cases\?limit=/, 'the queue path');
  assert.match(PAGE_JS, /\/cases\/\$\{caseId\}/, 'the case detail path');
  assert.match(PAGE_JS, /\/cases\/\$\{currentCase\.caseId\}\/link/, 'the link path');
});

test('the auth adapter calls the session paths this test claims it calls', () => {
  assert.match(AUTH_JS, /['"]\/api\/staff\/identity-resolution['"]/,
    'the adapter shares the page\'s API base');
  assert.match(AUTH_JS, /post\('\/session'/, 'the sign-in path');
  assert.match(AUTH_JS, /post\('\/session\/refresh'/, 'the refresh path');
  assert.match(AUTH_JS, /post\('\/session\/signout'/, 'the sign-out path');
});

test('every path the console calls resolves to exactly one function', () => {
  for (const path of ALL_PATHS) {
    const matched = resolveRoute(path);
    assert.equal(matched.length, 1,
      `${path} resolved to ${matched.length} functions: ${JSON.stringify(matched)}`);
    assert.equal(matched[0], 'api/staff/identity-resolution/[...path].mjs');
  }
});

test('a plain function file would NOT have served those paths — the defect, pinned', () => {
  /* The regression this whole file exists for, kept as a property of the
     ROUTING MODEL rather than of a file that still exists. A plain
     api/<name>.mjs serves its own path and nothing beneath it, so relying on
     one again would 404 every console path. */
  const plain = 'api/staff-identity-resolution.mjs';
  assert.ok(routePattern(plain).test('/api/staff-identity-resolution'),
    'a plain function file serves its own path');
  for (const path of ALL_PATHS) {
    assert.equal(routePattern(plain).test(path), false,
      `a plain function file does not serve ${path}`);
  }
});

test('the implementation is NOT under api/, so it is not deployed a second time', () => {
  /* Vercel deploys every file under api/ as its own function. While the
     implementation lived at api/staff-identity-resolution.mjs the platform
     deployed the same privileged route twice: once through the catch-all the
     console calls, and once at its own bare path, absent from vercel.json's
     `functions` block and therefore on platform defaults. */
  assert.equal(existsSync(join(ROOT, 'api/staff-identity-resolution.mjs')), false,
    'the implementation must not sit in the routing surface');
  assert.ok(existsSync(join(ROOT, 'server/staff-identity-resolution.mjs')),
    'it lives outside api/ instead');

  /* THREE deployable filesystem functions, derived from the api/ tree. */
  const deployable = listFunctions();
  assert.deepEqual(deployable.sort(), [
    'api/analytics.mjs',
    'api/assessments.mjs',
    'api/staff/identity-resolution/[...path].mjs'
  ], 'exactly three functions deploy');

  const staff = deployable.filter(f => /staff/i.test(f));
  assert.equal(staff.length, 1, 'one staff function, not two');
  assert.deepEqual(staff, ['api/staff/identity-resolution/[...path].mjs']);
});

test('three deployable functions, two configured — the counts are different on purpose', () => {
  /* Pinned because an earlier report described "three functions" and a later
     one "two", and both were right about different things. The staff route
     performs a permanent attachment and shares the public route's database
     timeout, so its budget is stated rather than inherited; api/analytics.mjs
     is deliberately left on platform defaults. */
  const deployable = listFunctions();
  const configured = Object.keys(config.functions || {}).sort();

  assert.equal(deployable.length, 3, 'three deployable filesystem functions');
  assert.deepEqual(configured, [
    'api/assessments.mjs',
    'api/staff/identity-resolution/[...path].mjs'
  ], 'two entries in the vercel.json functions block');

  for (const file of configured) {
    assert.ok(deployable.includes(file),
      `${file} is configured but is not a deployable function`);
  }
  assert.deepEqual(deployable.filter(f => !configured.includes(f)), ['api/analytics.mjs'],
    'exactly one function is deliberately on platform defaults');
});

test('the privileged route uses the repository\'s traceable import convention', () => {
  /* api/assessments.mjs and api/analytics.mjs both reach shared/ through
     static ESM imports, which a bundler resolves by reading the source. The
     staff route briefly used createRequire instead — a dynamic form whose
     tracing cannot be verified without a build, and whose failure mode is a
     MODULE_NOT_FOUND on the deployed function that no local test can see. */
  const files = [
    'server/staff-identity-resolution.mjs',
    'api/staff/identity-resolution/[...path].mjs',
    'api/assessments.mjs',
    'api/analytics.mjs'
  ];
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.equal(/createRequire/.test(source), false,
      `${file}: shared modules are imported statically, not through createRequire`);
  }

  const impl = readFileSync(join(ROOT, 'server/staff-identity-resolution.mjs'), 'utf8');
  for (const specifier of [
    '../shared/business-record/resolve-identity.js',
    '../shared/security/staff-note.js',
    '../shared/security/rate-limit.js',
    '../shared/security/read-body.js'
  ]) {
    assert.ok(impl.includes(`from '${specifier}'`),
      `${specifier} is a static import`);
  }
});

test('the catch-all sees the original request path, which is what the handler routes on', async () => {
  /* Filesystem routing does not rewrite, so the suffix the handler matches on
     is the one the browser asked for. Proven by driving the real handler with
     each full console path and checking it reaches the right branch. */
  const { handleRequest } = await import('../server/staff-identity-resolution.mjs');

  const seen = [];
  const db = {
    async rpc(name) {
      seen.push(name);
      if (name === 'check_rate_limit') return { data: { allowed: true }, error: null };
      if (name === 'staff_operator_guard') return { data: 'owner', error: null };
      return { data: name === 'staff_identity_queue' ? [] : {}, error: null };
    },
    from(table) {
      return { select() { return this; }, eq() {
        seen.push(table);
        return { data: [table === 'identity_resolution_cases'
          ? { assessment_submission_id: '44444444-4444-4444-8444-444444444444' }
          : { submission_id: '44444444-4444-4444-8444-444444444444',
              payload_hash: 'h', raw_payload: {} }] };
      } };
    }
  };
  const deps = {
    /* Rate limiting fails closed without a secret, and this test injects its
       own env rather than using process.env. */
    env: { CED_LOG_LEVEL: 'error', CED_RATE_LIMIT_SECRET: 'test-rate-limit-secret' },
    verifyAccessToken: async () => ({
      userId: '11111111-1111-4111-8111-111111111111', aal: 'aal2', emailConfirmed: true }),
    db
  };
  /* Browser-realistic headers: a safe method carries Sec-Fetch-Site and no
     Origin; an unsafe one carries the Origin. Attaching an Origin to the GETs
     here would exercise a combination no browser sends. */
  const hit = async (method, path, body) => {
    seen.length = 0;
    const safe = method === 'GET' || method === 'HEAD';
    const res = await handleRequest(new Request(`https://staff.example.com${path}`, {
      method,
      headers: { authorization: 'Bearer t', 'x-forwarded-proto': 'https',
                 /* The limiter fails closed without a caller identifier. */
                 'x-vercel-forwarded-for': '203.0.113.9',
                 ...(safe ? { 'sec-fetch-site': 'same-origin' }
                          : { origin: 'https://staff.example.com' }),
                 ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    }), deps);
    return { status: res.status, seen: [...seen] };
  };

  const queue = await hit('GET', CONSOLE_PATHS[0]);
  assert.equal(queue.status, 200);
  assert.ok(queue.seen.includes('staff_identity_queue'), 'the queue branch');

  const detail = await hit('GET', CONSOLE_PATHS[1]);
  assert.equal(detail.status, 200);
  assert.ok(detail.seen.includes('staff_identity_case'), 'the detail branch');

  const link = await hit('POST', CONSOLE_PATHS[2], {
    targetBusinessId: '33333333-3333-4333-8333-333333333333',
    resolutionRequestId: '55555555-5555-4555-8555-555555555555',
    note: 'Confirmed by phone with the owner.'
  });
  assert.equal(link.status, 201);
  assert.ok(link.seen.includes('resolve_identity_case_link_existing'), 'the link branch');
});

/* ============================================================
   The function's own shape
   ============================================================ */

/* ============================================================
   The Vercel Node-runtime invocation contract
   ------------------------------------------------------------
   THE 504 THIS EXISTS FOR. All three functions exported a DEFAULT
   handler written for the Web signature: it took a `Request` and
   returned a `Response`.

   Vercel's Node.js runtime picks its contract from the EXPORT
   SHAPE. A default export is the NODE signature `(req, res)`; the
   Web signature is selected by NAMED HTTP-METHOD exports. So the
   platform called the handler with `(req, res)`, the returned
   `Response` was discarded because a Node-signature handler
   answers through `res`, nothing ever wrote to `res`, and every
   invocation ran to the 15-second limit:
   504 FUNCTION_INVOCATION_TIMEOUT, no exception, no stack.

   WHY NO TEST CAUGHT IT. The tests below used to call
   `entry.default(new Request(...))` — constructing the argument
   the platform never passes, and asserting on a return value the
   platform never reads. One of them went further and asserted
   that a hostile SECOND argument was ignored, which pinned the
   defect in place: under the real contract that argument is
   `res`, the only means of answering.

   Everything here now exercises the contract the platform
   actually uses.
   ============================================================ */

const ENTRYPOINTS = [
  ['staff', '../api/staff/identity-resolution/[...path].mjs',
    'api/staff/identity-resolution/[...path].mjs',
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']],
  ['assessments', '../api/assessments.mjs', 'api/assessments.mjs',
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']],
  ['analytics', '../api/analytics.mjs', 'api/analytics.mjs',
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']]
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

test('no entrypoint exports a default handler', async () => {
  /* A default export selects the Node `(req, res)` contract, under which a
     returned Response is discarded and the invocation hangs. Asserted on the
     MODULE and on the SOURCE, so neither a re-export nor a differently
     spelled default can reintroduce it. */
  for (const [name, spec, file] of ENTRYPOINTS) {
    const mod = await import(spec);
    assert.equal('default' in mod, false, `${name}: exports a default handler`);
    assert.equal(mod.default, undefined, name);

    const source = readFileSync(join(ROOT, file), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');   /* comments explain it; they are not it */
    assert.equal(/export\s+default/.test(code), false,
      `${name}: \`export default\` appears outside a comment`);
  }
});

test('every entrypoint exports the named HTTP-method handlers', async () => {
  for (const [name, spec, , expected] of ENTRYPOINTS) {
    const mod = await import(spec);
    for (const method of expected) {
      assert.equal(typeof mod[method], 'function', `${name}: no ${method} export`);
      assert.equal(mod[method].length, 1, `${name}: ${method} takes one argument`);
    }
    assert.deepEqual(mod.config, { runtime: 'nodejs' }, `${name}: an explicit runtime`);
  }
});

test('the named exports forward exactly one argument, so the seam stays closed', async () => {
  /* handleRequest's second parameter is a test-only injection seam. This is a
     real property worth keeping — it is simply not the reason the wrapper
     exists, and it is worth nothing if the function cannot answer at all. */
  for (const [name, spec] of ENTRYPOINTS) {
    const mod = await import(spec);
    for (const method of HTTP_METHODS) {
      if (typeof mod[method] === 'function') {
        assert.equal(mod[method].length, 1, `${name}: ${method} declares one parameter`);
      }
    }
  }
});

test('each named export accepts a real Request and returns a real Response', async () => {
  /* The contract, end to end, per method, on all three functions. */
  const urls = {
    staff: 'https://staff.example.com/api/staff/identity-resolution/cases',
    assessments: 'https://staff.example.com/api/assessments',
    analytics: 'https://staff.example.com/api/analytics'
  };

  for (const [name, spec, , expected] of ENTRYPOINTS) {
    const mod = await import(spec);
    for (const method of expected) {
      const init = { method, headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' } };
      const res = await mod[method](new Request(urls[name], init));
      assert.ok(res instanceof Response, `${name} ${method}: not a Response`);
      assert.equal(typeof res.status, 'number');
    }
  }
});

test('the staff GET auth-config settles, and does not hang', async () => {
  /* THE EXACT REQUEST THAT 504'd IN PREVIEW. It must produce a Response, and
     it must do so quickly — a hang is the failure being guarded against, so
     the deadline is part of the assertion rather than the runner's timeout. */
  const entry = await import('../api/staff/identity-resolution/[...path].mjs');
  const url = 'https://staff.example.com/api/staff/identity-resolution/auth-config';

  const started = Date.now();
  const res = await Promise.race([
    entry.GET(new Request(url, {
      headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' } })),
    new Promise((_, reject) => setTimeout(() => reject(new Error('did not settle')), 5000))
  ]);
  const elapsed = Date.now() - started;

  assert.ok(res instanceof Response, 'a Web standard Response');
  assert.ok(elapsed < 5000, `settled in ${elapsed}ms, far inside the 15s platform budget`);

  /* NOTHING IS INJECTED HERE, deliberately — the platform injects nothing
     either — and this test process has no SUPABASE_URL, so the endpoint
     refuses on its own configuration check. That is the correct answer on the
     deployed path, and it is an ANSWER, which is the whole point: this exact
     request used to hang to the 15-second limit and return 504
     FUNCTION_INVOCATION_TIMEOUT.

     THIS ASSERTED rate_limit_unavailable UNTIL THE ENDPOINT WAS DECOUPLED
     from the database-backed limiter. It reaches its own validation now, and
     no `Retry-After` accompanies a configuration refusal — there is nothing
     to wait for. The deeper chain is covered by the suites that can inject a
     database; the exemption itself by
     tests/staff-auth-config-public.test.mjs. */
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'auth_unavailable');
  assert.equal(res.headers.get('Retry-After'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the staff authorization chain still runs through the named export', async () => {
  const entry = await import('../api/staff/identity-resolution/[...path].mjs');
  const url = CONSOLE_PATHS[0].replace('/api', 'https://staff.example.com/api');

  /* The headers a real browser sends for this GET: Sec-Fetch-Site, no Origin.
     Reaching 401 rather than 403 is the whole point — the provenance gate let
     a genuine same-origin read through and the authorization chain then asked
     for a token. */
  /* Same-origin and well formed, so it passes the provenance gate and the
     method gate and reaches the limiter — which, with nothing injected and no
     caller identifier, fails closed. The chain RAN; it simply stopped at the
     first layer that could refuse. */
  const res = await entry.GET(new Request(url, {
    headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' } }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'rate_limit_unavailable');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  /* And the gate is on the deployed path, in both of its shapes. */
  const crossSite = await entry.GET(new Request(url, {
    headers: { 'x-forwarded-proto': 'https', origin: 'https://evil.example',
               'sec-fetch-site': 'cross-site' } }));
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).code, 'origin_not_allowed');

  const noMetadata = await entry.GET(new Request(url, {
    headers: { 'x-forwarded-proto': 'https' } }));
  assert.equal(noMetadata.status, 403);
  assert.equal((await noMetadata.json()).code, 'origin_required');
});

test('supported POST routes still reach their handlers through the named export', async () => {
  const entry = await import('../api/staff/identity-resolution/[...path].mjs');
  const res = await entry.POST(new Request(
    'https://staff.example.com/api/staff/identity-resolution/session', {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'https', origin: 'https://staff.example.com',
                 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@y.test', password: 'irrelevant' })
    }));
  /* It got past routing, provenance, the method gate and the content-type
     gate. With nothing injected it then meets the limiter and fails closed,
     which is the correct deployed-path answer — and, again, an ANSWER. */
  assert.ok(res instanceof Response);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'rate_limit_unavailable');
});

test('the application answers 405 itself, with its JSON body and Allow header', async () => {
  /* WHY EVERY METHOD IS EXPORTED. A method with no named export is refused by
     VERCEL with a generic 405 — no JSON envelope, no error code, no Allow
     header. Forwarding it so the application can refuse it is what keeps this
     contract, and this is the test that would fail if someone trimmed the
     exports back to the two that are "actually used". */
  const entry = await import('../api/staff/identity-resolution/[...path].mjs');

  /* /session serves POST only. */
  const onSession = await entry.PUT(new Request(
    'https://staff.example.com/api/staff/identity-resolution/session', {
      method: 'PUT',
      headers: { 'x-forwarded-proto': 'https', origin: 'https://staff.example.com' } }));
  assert.equal(onSession.status, 405);
  assert.equal(onSession.headers.get('Allow'), 'POST');
  assert.equal((await onSession.json()).code, 'method_not_allowed');

  /* /auth-config serves GET only. */
  const onConfig = await entry.POST(new Request(
    'https://staff.example.com/api/staff/identity-resolution/auth-config', {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'https', origin: 'https://staff.example.com' } }));
  assert.equal(onConfig.status, 405);
  assert.equal(onConfig.headers.get('Allow'), 'GET');
  assert.equal((await onConfig.json()).code, 'method_not_allowed');
});

test('assessments and analytics answer 405 themselves too', async () => {
  const cases = [
    ['assessments', '../api/assessments.mjs', 'https://staff.example.com/api/assessments'],
    ['analytics', '../api/analytics.mjs', 'https://staff.example.com/api/analytics']
  ];

  for (const [name, spec, url] of cases) {
    const mod = await import(spec);
    const env = { CED_ALLOWED_ORIGINS: 'https://staff.example.com' };
    /* Both read their allowlist from process.env; set it for the call. */
    const previous = process.env.CED_ALLOWED_ORIGINS;
    process.env.CED_ALLOWED_ORIGINS = env.CED_ALLOWED_ORIGINS;
    try {
      const res = await mod.PUT(new Request(url, {
        method: 'PUT',
        headers: { origin: 'https://staff.example.com', 'x-forwarded-proto': 'https' } }));
      assert.equal(res.status, 405, name);
      assert.equal(res.headers.get('Allow'), 'POST, OPTIONS', name);
      const body = await res.json();
      assert.equal((body.error && body.error.code) || body.code, 'method_not_allowed', name);
    } finally {
      if (previous === undefined) delete process.env.CED_ALLOWED_ORIGINS;
      else process.env.CED_ALLOWED_ORIGINS = previous;
    }
  }
});

test('the deployed function is the module the tests exercise, not a copy', async () => {
  const entry = await import('../api/staff/identity-resolution/[...path].mjs');
  const impl = await import('../server/staff-identity-resolution.mjs');
  const source = readFileSync(join(ROOT, 'api/staff/identity-resolution/[...path].mjs'), 'utf8');
  assert.match(source, /from '\.\.\/\.\.\/\.\.\/server\/staff-identity-resolution\.mjs'/,
    'the entrypoint imports the implementation rather than restating it');
  /* No named export may BE handleRequest: the injection seam must not be the
     platform entrypoint, or the platform's second argument would land where
     injected dependencies are read. */
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    assert.equal(typeof entry[method], 'function', `missing ${method}`);
    assert.notEqual(entry[method], impl.handleRequest,
      `${method}: the injection seam is not the platform entrypoint`);
    assert.equal(entry[method].length, 1, `${method}: one declared parameter`);
  }
});

test('the function budget is configured for the staff route as well', () => {
  const fn = config.functions['api/staff/identity-resolution/[...path].mjs'];
  assert.ok(fn, 'the staff function is configured, not left to the platform default');
  assert.ok(fn.maxDuration >= 6,
    'the budget must exceed CED_DB_TIMEOUT_MS (6s) or the platform kills the request first');
  assert.equal(fn.maxDuration, config.functions['api/assessments.mjs'].maxDuration,
    'and match the public route, which shares the same database timeout');
});

/* ============================================================
   The page's headers
   ============================================================ */

/* The exact policy, written out. Pinning the string rather than probing for
   directives means a widening — an added 'unsafe-inline', a host, a data: —
   fails here rather than passing a loose contains() check. */
const STAFF_CSP = "frame-ancestors 'none'; script-src 'self'; style-src 'self'; "
  + "form-action 'none'; base-uri 'none'; object-src 'none'";

test('the staff page is not framable, not cached and not indexed', () => {
  /* The JSON responses set these themselves and a test already pins that.
     The PAGE is a static asset: it matches no /api/ rule, and it is the thing
     that performs the permanent attachment. */
  const headers = headersFor('/staff/identity-resolution/index.html');

  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['content-security-policy'], STAFF_CSP);
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['referrer-policy'], 'no-referrer');
});

test('the staff CSP is the minimum the page actually needs, and nothing is relaxed', () => {
  const csp = headersFor('/staff/identity-resolution/index.html')['content-security-policy'];
  const directives = Object.fromEntries(csp.split(';').map(d => {
    const [name, ...values] = d.trim().split(/\s+/);
    return [name, values.join(' ')];
  }));

  /* A password, a TOTP code and bearer tokens pass through these pages. */
  assert.equal(directives['frame-ancestors'], "'none'",
    'the one directive a meta policy cannot express, which is why the header exists');
  assert.equal(directives['script-src'], "'self'",
    'auth.js, page.js and the VENDORED Supabase client — all same-origin. Vendoring '
    + 'rather than using a CDN is what keeps this directive at \'self\'');
  assert.equal(directives['style-src'], "'self'", 'styles.css, and nothing else');
  assert.equal(directives['form-action'], "'none'",
    'both forms are handled in JavaScript; a default submit would put a password in a navigation');
  assert.equal(directives['base-uri'], "'none'",
    'both scripts fetch path-absolute URLs, which an injected <base> would re-point');
  assert.equal(directives['object-src'], "'none'");

  /* THE TWO DIRECTIVES THAT MUST NOT BE HERE, and this is the defect that
     put them in a test rather than a comment.

     A header CSP and a meta CSP are both enforced and the browser applies
     their INTERSECTION. The onboarding page's meta policy permits one extra
     origin in `connect-src`; a header that also named `connect-src` — or
     `default-src`, which is connect-src's fallback — would intersect with it
     and block the very request the page exists to make. Per-page directives
     belong in the per-page policy. */
  assert.equal('default-src' in directives, false,
    'default-src in the header would intersect with the generated connect-src and block it');
  assert.equal('connect-src' in directives, false,
    'connect-src in the header would intersect with the generated one');

  assert.equal(csp.includes('wss'), false, 'no WebSocket source');
  for (const weakness of ["'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:', '*',
                          'http:', "'unsafe-hashes'"]) {
    assert.equal(csp.includes(weakness), false, `the policy must not contain ${weakness}`);
  }
  assert.equal(/(^|[\s;])https:([\s;]|$)/.test(csp), false,
    'https: as a scheme-wide source would allow any host');
});

test('no deployable configuration carries a placeholder or a Supabase host', () => {
  /* THE DEFECT THIS PINS. The staff CSP once carried
     `https://REPLACE-WITH-PROJECT-REF.supabase.co`, to be replaced by hand
     after review. A deployable file with a placeholder in it is a deployment
     waiting to ship the placeholder; hardcoding the development origin
     instead would have been worse, because the production deployment would
     then have been permitted to reach the development project's Auth server.

     The origin is generated per environment by tools/build-static.mjs from
     SUPABASE_URL, so vercel.json names no Supabase host at all. */
  const raw = readFileSync(join(ROOT, 'vercel.json'), 'utf8');
  assert.equal(raw.includes('REPLACE-WITH-PROJECT-REF'), false, 'no placeholder');
  assert.equal(raw.includes('supabase'), false, 'and no Supabase host, of any kind');
  assert.equal(/PROJECT-REF|YOUR-PROJECT|TODO|FIXME|<your-/i.test(raw), false,
    'nothing that reads as "fill this in later"');
});

test('the per-page meta policies carry what the header deliberately does not', () => {
  /* The header is only safe to narrow because each page states the rest. A
     page that lost its meta would be governed by a header that permits any
     connection, which is the failure mode this pair of tests exists for. */
  for (const page of ['index.html', 'accept-invite.html']) {
    const html = readFileSync(join(ROOT, 'staff/identity-resolution', page), 'utf8');
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    assert.ok(meta, `${page} declares no meta CSP`);
    const policy = meta[1];

    assert.ok(policy.startsWith("default-src 'none'"), `${page}: ${policy}`);
    assert.ok(policy.includes("connect-src 'self'"), page);
    assert.equal(policy.includes('frame-ancestors'), false,
      `${page}: frame-ancestors is ignored in a meta policy and stays in the header`);

    /* The SOURCE carries the fail-closed baseline. Only the built copy of the
       onboarding page gets an origin appended, and only from a validated
       SUPABASE_URL — so an unbuilt or misbuilt copy reaches no Supabase at
       all rather than the wrong one. */
    assert.equal(policy.includes('supabase'), false,
      `${page}: the source policy names no host; the build generates it`);
  }
});

test('nothing on the staff page needs the policy relaxed', () => {
  /* The assertion above is only honest if the page really does load this way.
     If someone adds an inline handler, an inline style or a remote asset, this
     fails and names what has to change — rather than the CSP being loosened
     quietly to accommodate it. */
  const html = readFileSync(join(ROOT, 'staff/identity-resolution/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'staff/identity-resolution/styles.css'), 'utf8');

  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, 'no inline <script>');
  assert.equal(/<style[\s>]/i.test(html), false, 'no inline <style>');
  assert.equal(/\sstyle\s*=\s*["']/i.test(html), false, 'no style attribute');
  assert.equal(/\son(?:click|submit|change|load|error|input|focus|blur)\s*=/i.test(html), false,
    'no inline event handler');
  assert.equal(/javascript:/i.test(html), false, 'no javascript: URL');
  assert.equal(/<base[\s>]/i.test(html), false, 'no <base> element');
  assert.equal(/<form[^>]*\saction\s*=/i.test(html), false,
    'no form action, which is why form-action can be none');
  assert.equal(/url\(|@import/i.test(css), false, 'the stylesheet fetches nothing');

  for (const [name, source] of [['page.js', PAGE_JS], ['auth.js', AUTH_JS]]) {
    assert.equal(/\.style\.|setAttribute\(\s*['"]style['"]/.test(source), false,
      `${name}: no inline style is written at runtime`);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source), false,
      `${name}: no HTML is injected, so there is nothing for a <base> or an inline script to ride in on`);
    assert.equal(/\beval\s*\(|new Function\s*\(/.test(source), false,
      `${name}: nothing needs 'unsafe-eval'`);
  }
});

test('the strict policy is confined to staff pages', () => {
  /* A marketing vertical loads fonts, images and inline SVG. Applying this
     policy to one would break it, and the header rules must not leak. */
  for (const path of [
    '/verticals/beauty-wellness-fitness/nails/site/index.html',
    '/design-system/standards/tokens.css',
    '/index.html'
  ]) {
    const headers = headersFor(path);
    assert.equal(headers['content-security-policy'], undefined, path);
    assert.equal(headers['cache-control'], undefined, path);
  }

  /* And the /api/ rule, which does cover the staff JSON, carries no CSP of
     its own beyond what the route sets on each response. */
  const api = headersFor('/api/staff/identity-resolution/session');
  assert.equal(api['content-security-policy'], undefined,
    'the API rule sets caching and sniffing policy, not a page policy');
});

test('the page rule covers every asset the console loads, not just the document', () => {
  for (const path of [
    '/staff/identity-resolution/',
    '/staff/identity-resolution/index.html',
    '/staff/identity-resolution/page.js',
    '/staff/identity-resolution/styles.css'
  ]) {
    const headers = headersFor(path);
    assert.equal(headers['x-frame-options'], 'DENY', path);
    assert.equal(headers['cache-control'], 'no-store', path);
  }
});

test('the page rule does not leak onto the public verticals', () => {
  const headers = headersFor('/verticals/beauty-wellness-fitness/nails/site/index.html');
  assert.deepEqual(headers, {},
    'a marketing page must stay cacheable and framable-by-policy, not inherit the staff rules');
});

test('the api rule still covers the staff route JSON', () => {
  const headers = headersFor(CONSOLE_PATHS[2]);
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
});

/* ============================================================
   Nothing secret is reachable from the browser
   ============================================================ */

test('no key, secret or service credential appears in anything the page loads', () => {
  const served = [
    'staff/identity-resolution/index.html',
    'staff/identity-resolution/auth.js',
    'staff/identity-resolution/page.js',
    'staff/identity-resolution/styles.css'
  ];
  const forbidden = [
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY',
    'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY',
    'CED_RATE_LIMIT_SECRET', 'CED_CONTINUATION_SECRET', 'CED_CHALLENGE_SECRET',
    'service_role', 'eyJ'
  ];
  for (const file of served) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const needle of forbidden) {
      assert.equal(text.includes(needle), false, `${file} mentions ${needle}`);
    }
  }
});

test('the console reaches Supabase through the route and never directly', () => {
  /* Prose about Supabase Auth is expected — the console signs in through it.
     What must be absent from BOTH served scripts is a CLIENT: a constructor,
     a project URL, or the library itself. The browser talks to
     /api/staff/…; the route holds the keys, including the publishable one. */
  for (const [name, source] of [['page.js', PAGE_JS], ['auth.js', AUTH_JS]]) {
    assert.equal(/createClient/.test(source), false, `${name}: no Supabase client is constructed`);
    /* Prose naming the library is expected — auth.js explains at length why it
       is NOT here. What must be absent is a load of it. */
    assert.equal(/(?:^|[^\w])(?:import|require)\s*\(?\s*['"]@supabase\//.test(source), false,
      `${name}: the library is not imported`);
    assert.equal(/from\s+['"]@supabase\//.test(source), false,
      `${name}: the library is not imported`);
    assert.equal(/\.supabase\.(co|in)\b/.test(source), false, `${name}: no project URL`);
    assert.equal(/\.rpc\(|\.from\(/.test(source), false,
      `${name}: no privileged function or table is called`);
    /* A runtime CDN would put a third party in the sign-in path of a console
       that performs permanent attachments. */
    assert.equal(/https?:\/\/(?!127\.0\.0\.1)/.test(source), false,
      `${name}: nothing is loaded from another origin`);
  }

  /* Every network call either script makes goes to the configured staff base. */
  const fetches = [...(PAGE_JS.match(/fetch\(([^)]*)/g) || []),
                   ...(AUTH_JS.match(/fetch\(([^)]*)/g) || [])];
  assert.equal(fetches.length, 2, 'one in the page, one in the adapter');
  fetches.forEach(f => assert.match(f, /\$\{API\}/, 'to the configured staff API base'));
});

test('the page loads the real adapter before the script that depends on it', () => {
  const html = readFileSync(join(ROOT, 'staff/identity-resolution/index.html'), 'utf8');
  const authAt = html.indexOf('src="auth.js"');
  const pageAt = html.indexOf('src="page.js"');
  assert.ok(authAt > -1, 'the production adapter is loaded');
  assert.ok(pageAt > -1, 'the page script is loaded');
  assert.ok(authAt < pageAt, 'and the adapter comes first, so window.CED_STAFF_AUTH is set');
  /* Both deferred, so document order is execution order. */
  assert.match(html, /<script src="auth\.js" defer><\/script>/);
  assert.match(html, /<script src="page\.js" defer><\/script>/);

  /* The adapter is the only thing that sets it, and it always does. */
  assert.match(AUTH_JS, /window\.CED_STAFF_AUTH\s*=/,
    'the adapter assigns the global unconditionally');
});

test('the styles claim no token the design system does not have', () => {
  /* The stylesheet used to name nine tokens that exist in no file in this
     repository, so every var() fell through to a literal and the shared
     import contributed nothing while the header said otherwise. */
  const css = readFileSync(join(ROOT, 'staff/identity-resolution/styles.css'), 'utf8');
  const tokens = readFileSync(join(ROOT, 'design-system/standards/tokens.css'), 'utf8');

  const referenced = [...new Set((css.match(/var\(\s*(--[a-z0-9-]+)/gi) || [])
    .map(m => m.replace(/var\(\s*/i, '')))];
  assert.ok(referenced.length > 0, 'the stylesheet does use custom properties');

  for (const name of referenced) {
    const declaredLocally = new RegExp(`^\\s*${name}\\s*:`, 'm').test(css);
    const declaredShared = new RegExp(`^\\s*${name}\\s*:`, 'm').test(tokens);
    assert.ok(declaredLocally || declaredShared,
      `${name} is referenced but declared nowhere`);
  }

  /* Its own namespaced layer, so it can never be mistaken for the shared one
     and no vertical can come to depend on it. */
  assert.ok(referenced.every(n => n.startsWith('--staff-')),
    `the staff layer is namespaced: ${referenced.join(', ')}`);
});
