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

const ALL_PATHS = [...CONSOLE_PATHS, ...SESSION_PATHS];

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
    env: { CED_LOG_LEVEL: 'error' },
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

test('the entrypoint declares the same runtime contract as the other two routes', async () => {
  const entry = await import('../api/staff/identity-resolution/[...path].mjs');
  const assessments = await import('../api/assessments.mjs');
  const analytics = await import('../api/analytics.mjs');

  for (const [name, mod] of [['staff', entry], ['assessments', assessments], ['analytics', analytics]]) {
    assert.equal(typeof mod.default, 'function', `${name}: a default handler`);
    assert.equal(mod.default.length, 1, `${name}: one declared parameter`);
    assert.deepEqual(mod.config, { runtime: 'nodejs' }, `${name}: an explicit runtime`);
  }
});

test('the entrypoint answers a real Request with a real Response', async () => {
  const entry = await import('../api/staff/identity-resolution/[...path].mjs');
  const url = CONSOLE_PATHS[0].replace('/api', 'https://staff.example.com/api');

  /* The headers a real browser sends for this GET: Sec-Fetch-Site, no Origin.
     Reaching 401 rather than 403 is the whole point — the provenance gate let
     a genuine same-origin read through and the authorization chain then asked
     for a token. Before the method-sensitive fix this was a 403 and the
     console's queue was unreachable in every standards-compliant browser. */
  const res = await entry.default(new Request(url, {
    headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' } }));
  assert.ok(res instanceof Response, 'a Web standard Response');
  assert.equal(res.status, 401, 'and it ran the real authorization chain');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  /* And the gate is on the deployed path, not only on handleRequest — in both
     of its shapes: a stated Origin that is not ours, and a browser telling us
     the read came from somewhere else. */
  const crossSite = await entry.default(new Request(url, {
    headers: { 'x-forwarded-proto': 'https', origin: 'https://evil.example',
               'sec-fetch-site': 'cross-site' } }));
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).code, 'origin_not_allowed');

  const crossSiteRead = await entry.default(new Request(url, {
    headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'cross-site' } }));
  assert.equal(crossSiteRead.status, 403);
  assert.equal((await crossSiteRead.json()).code, 'origin_not_allowed');

  const noMetadata = await entry.default(new Request(url, {
    headers: { 'x-forwarded-proto': 'https' } }));
  assert.equal(noMetadata.status, 403);
  assert.equal((await noMetadata.json()).code, 'origin_required');
});

test('the entrypoint ignores a hostile second argument, whatever the platform passes', async () => {
  /* handleRequest's second parameter is a test seam. If the platform ever
     passes a second argument — a context object, a response writer, anything —
     it must not arrive where injected dependencies are read. The wrapper takes
     one argument and forwards one. */
  const entry = await import('../api/staff/identity-resolution/[...path].mjs');
  const url = CONSOLE_PATHS[0].replace('/api', 'https://staff.example.com/api');

  let verified = 0;
  let queried = 0;
  const hostile = {
    env: { CED_ALLOW_INSECURE_STAFF: 'true', CED_STAFF_ALLOWED_ORIGINS: 'https://evil.example' },
    verifyAccessToken: async () => { verified += 1; return { userId: 'x', aal: 'aal2' }; },
    authClient: async () => { throw new Error('must not be reached'); },
    db: { async rpc() { queried += 1; return { data: [], error: null }; },
          from() { queried += 1; return { select() { return this; }, eq() { return { data: [] }; } }; } }
  };

  const res = await entry.default(new Request(url, {
    headers: { 'x-forwarded-proto': 'https', origin: 'https://staff.example.com',
               authorization: 'Bearer anything' } }), hostile);

  assert.equal(verified, 0, 'the injected verifier was never consulted');
  assert.equal(queried, 0, 'nor the injected database');
  assert.notEqual(res.status, 200, 'and it certainly did not succeed');

  /* The hostile allowlist did not take effect either: a same-origin request is
     still accepted, which it would not be if that env had been honoured. */
  assert.equal(res.headers.get('x-correlation-id') === null, false,
    'the real handler answered');
});

test('the deployed function is the module the tests exercise, not a copy', async () => {
  const entry = await import('../api/staff/identity-resolution/[...path].mjs');
  const impl = await import('../server/staff-identity-resolution.mjs');
  const source = readFileSync(join(ROOT, 'api/staff/identity-resolution/[...path].mjs'), 'utf8');
  assert.match(source, /from '\.\.\/\.\.\/\.\.\/server\/staff-identity-resolution\.mjs'/,
    'the entrypoint imports the implementation rather than restating it');
  /* Both wrappers must be one-argument, and neither may be handleRequest. */
  assert.notEqual(entry.default, impl.handleRequest,
    'the injection seam is not the platform entrypoint');
  assert.equal(entry.default.length, 1);
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
const STAFF_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; "
  + "connect-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'; "
  + "frame-ancestors 'none'";

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

  /* A password, a TOTP code and bearer tokens pass through this page. */
  assert.equal(directives['default-src'], "'none'", 'everything is denied by default');
  assert.equal(directives['script-src'], "'self'", 'auth.js and page.js, and nothing else');
  assert.equal(directives['style-src'], "'self'", 'styles.css, and nothing else');
  assert.equal(directives['connect-src'], "'self'", 'the same-origin staff API only');
  assert.equal(directives['form-action'], "'none'",
    'both forms are handled in JavaScript; a default submit would put a password in a navigation');
  assert.equal(directives['base-uri'], "'none'",
    'both scripts fetch path-absolute URLs, which an injected <base> would re-point');
  assert.equal(directives['object-src'], "'none'");
  assert.equal(directives['frame-ancestors'], "'none'");

  for (const weakness of ["'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:', '*',
                          'http:', 'https:', "'unsafe-hashes'"]) {
    assert.equal(csp.includes(weakness), false, `the policy must not contain ${weakness}`);
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
