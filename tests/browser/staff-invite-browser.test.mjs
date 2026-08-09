/* ============================================================
   Invitation onboarding, in a real browser, against a real
   Supabase Auth wire protocol
   ------------------------------------------------------------
   THE DEFECT THIS FILE EXISTS FOR. An earlier version of this
   page posted the invited user's password, the Supabase session,
   the TOTP secret, the otpauth URI and the TOTP code to CED
   endpoints. CLAUDE.md §9 forbids this platform from transmitting
   or storing credentials, and that broke it in the most direct
   way available.

   The page now speaks to Supabase Auth directly, with the
   vendored supported client and the PUBLISHABLE key. This suite
   proves it, and proves the CED side stays clean:

     · window.fetch is NOT replaced. Every request is made by the
       browser over a real TCP socket.
     · TWO servers run. One is CED — the real static files and the
       real handleRequest. The other is a GoTrue-shaped Auth
       server on a DIFFERENT origin, which the CED server names in
       its /auth-config answer.
     · every request to BOTH is recorded, with its raw body, so
       "no credential reached CED" is an observation of the wire
       rather than a reading of the source.
     · the CED server sets the REAL staff CSP, with the fake Auth
       origin substituted for the placeholder — so the whole flow
       runs under the policy shape that ships, and a directive the
       page actually needs but the policy forbids fails here.

   WHAT IS STILL NOT REAL. The Auth server is a fixture: it speaks
   the right protocol on the right paths, but it is not Supabase.
   No real invitation, no real TOTP. See
   docs/REAL_POSTGRES_VALIDATION.md.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, normalize, sep, join } from 'node:path';

import { handleRequest } from '../../server/staff-identity-resolution.mjs';
import { __testing as buildTesting } from '../../tools/build-static.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PAGE = '/staff/identity-resolution/accept-invite.html';

const CANDIDATES = [
  `${process.env.ProgramFiles || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)'] || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
];

const executablePath = CANDIDATES.find(p => p && existsSync(p));
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { puppeteer = null; }

const SKIP = !executablePath
  ? 'no Chromium-based browser found on this machine'
  : !puppeteer ? 'puppeteer-core is not installed' : false;

if (SKIP) {
  console.error(
    `\n  ✖ REAL-BROWSER ONBOARDING VERIFICATION SKIPPED: ${SKIP}.`
    + '\n    Direct-to-Supabase onboarding was NOT observed on this run.\n');
}

const USER = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'invited@example.test';
const TOKEN_HASH = 'pkce_9d3f2a1b8c7e6d5f4a3b2c1d0e9f8a7b6c5d4e3f';
const PASSWORD = 'a-long-enough-passphrase';
const SECRET = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/CED:${EMAIL}?secret=${SECRET}&issuer=CED`;
const PUBLISHABLE = 'sb_publishable_browser-fixture-not-real';
const SECRET_KEY = 'sb_secret_must-never-reach-a-browser';

const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = c => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(c)}.sig`;
const AAL1 = jwt({ sub: USER, aal: 'aal1', exp: 1893456000 });
const AAL2 = jwt({ sub: USER, aal: 'aal2', exp: 1893456000 });

/* Every value that must never reach CED, named once. */
const CREDENTIALS = [
  [PASSWORD, 'the password'],
  [TOKEN_HASH, 'the invitation token'],
  [AAL1, 'the aal1 access token'],
  [AAL2, 'the aal2 access token'],
  ['refresh-1', 'the refresh token'],
  [SECRET, 'the TOTP secret'],
  [URI, 'the otpauth URI'],
  ['123456', 'the TOTP code']
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8'
};

/* The real RESPONSE-HEADER policy, read from vercel.json rather than
   restated. It deliberately carries no default-src and no connect-src — those
   live in each page's meta, because a header policy would intersect with the
   generated one and block the very origin the page needs. */
const staffHeaderCsp = () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const rule = config.headers.find(h => h.source === '/staff/(.*)');
  return rule.headers.find(h => h.key === 'Content-Security-Policy').value;
};

/* The onboarding page as the BUILD publishes it: the same one-line
   substitution tools/build-static.mjs performs, through the build's own
   exported function, with this run's fixture origin standing in for the
   Supabase project. Serving the unbuilt source would serve
   `connect-src 'self'` and the browser would block every Auth call — which
   is the fail-closed behaviour, and exactly why the built page has to be the
   one under test. */
const generatedOnboardingPage = authOrigin => {
  const source = readFileSync(
    join(ROOT, 'staff/identity-resolution/accept-invite.html'), 'utf8');
  if (source.split(buildTesting.CSP_SOURCE_LINE).length - 1 !== 1) {
    throw new Error('the base CSP line is not in the page exactly once');
  }
  return source.replace(buildTesting.CSP_SOURCE_LINE, buildTesting.cspLineFor(authOrigin));
};

/* ---------- the fake Supabase Auth server ----------
   GoTrue's shape on the paths the onboarding page drives, taken from the
   installed @supabase/auth-js 2.112.0: the client's base URL is
   `${supabaseUrl}/auth/v1`, and it calls /verify, /user, /factors,
   /factors/:id/challenge, /factors/:id/verify, /token?grant_type=password
   and /logout. */
const startAuthServer = ({ invitation = 'valid', factors = [] } = {}) =>
  new Promise(res => {
    const requests = [];
    let state = { factors: [...factors], enrolled: null };

    const server = createServer(async (req, resp) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');

      const cors = {
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Headers':
          'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600'
      };
      if (req.method === 'OPTIONS') { resp.writeHead(204, cors); return resp.end(); }

      requests.push({
        method: req.method, path: url.pathname, raw,
        apikey: req.headers.apikey || null,
        authorization: req.headers.authorization || null
      });

      const send = (status, body) => {
        resp.writeHead(status, { 'Content-Type': 'application/json', ...cors });
        resp.end(JSON.stringify(body));
      };

      const user = { id: USER, email: EMAIL, email_confirmed_at: '2026-01-01T00:00:00Z',
                     factors: state.factors, app_metadata: {}, user_metadata: {},
                     aud: 'authenticated', created_at: '2026-01-01T00:00:00Z' };
      const session = (token) => ({
        access_token: token, token_type: 'bearer', expires_in: 3600,
        expires_at: 1893456000, refresh_token: 'refresh-1', user
      });

      const p = url.pathname;

      if (p === '/auth/v1/verify' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        /* The type is what the PAGE sent. A page that forwarded the URL's
           type would show up here. */
        if (invitation !== 'valid' || body.type !== 'invite' || body.token_hash !== TOKEN_HASH) {
          return send(403, { error: 'invalid_grant', error_description: 'Token has expired or is invalid' });
        }
        return send(200, session(AAL1));
      }

      if (p === '/auth/v1/token' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        if (url.searchParams.get('grant_type') !== 'password'
            || body.email !== EMAIL || body.password !== PASSWORD) {
          return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        }
        return send(200, session(AAL1));
      }

      if (p === '/auth/v1/user' && req.method === 'PUT') {
        const body = JSON.parse(raw || '{}');
        if (!body.password || body.password.length < 6) {
          return send(422, { error: 'weak_password', error_description: 'Password is too short' });
        }
        return send(200, user);
      }

      if (p === '/auth/v1/user' && req.method === 'GET') return send(200, user);

      if (p === '/auth/v1/factors' && req.method === 'POST') {
        state.enrolled = { id: 'f0000000-0000-4000-8000-000000000001' };
        state.factors = [...state.factors,
          { id: state.enrolled.id, factor_type: 'totp', status: 'unverified',
            friendly_name: JSON.parse(raw || '{}').friendly_name }];
        return send(200, {
          id: state.enrolled.id, type: 'totp',
          totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: SECRET, uri: URI }
        });
      }

      const unenroll = p.match(/^\/auth\/v1\/factors\/([^/]+)$/);
      if (unenroll && req.method === 'DELETE') {
        state.factors = state.factors.filter(f => f.id !== unenroll[1]);
        return send(200, { id: unenroll[1] });
      }

      const challenge = p.match(/^\/auth\/v1\/factors\/([^/]+)\/challenge$/);
      if (challenge && req.method === 'POST') {
        return send(200, { id: 'c0000000-0000-4000-8000-000000000001', type: 'totp',
                           expires_at: 1893456000 });
      }

      const verify = p.match(/^\/auth\/v1\/factors\/([^/]+)\/verify$/);
      if (verify && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        if (body.code !== '123456') {
          return send(422, { error: 'invalid_code', error_description: 'Invalid TOTP code entered' });
        }
        state.factors = state.factors.map(f =>
          f.id === verify[1] ? { ...f, status: 'verified' } : f);
        return send(200, session(AAL2));
      }

      if (p === '/auth/v1/logout' && req.method === 'POST') { resp.writeHead(204, cors); return resp.end(); }

      send(404, { error: 'not_found', error_description: p });
    });

    server.listen(0, '127.0.0.1', () => {
      res({
        server, requests,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(done => server.close(done))
      });
    });
  });

/* ---------- the CED server ---------- */
const startCedServer = auth => new Promise(res => {
  const observed = [];
  const csp = staffHeaderCsp();
  const onboardingHtml = generatedOnboardingPage(auth.origin);

  const env = {
    CED_ALLOW_INSECURE_STAFF: 'true',
    CED_LOG_LEVEL: 'debug',
    SUPABASE_URL: auth.origin,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    SUPABASE_SECRET_KEY: SECRET_KEY
  };

  /* Throws on any access: onboarding must not reach a database. */
  const db = new Proxy({}, {
    get(_t, prop) { throw new Error(`the database was reached: ${String(prop)}`); }
  });

  const logs = [];
  const server = createServer(async (req, resp) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/staff/identity-resolution')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const record = {
        method: req.method, path: url.pathname,
        rawBody: body.toString('utf8'),
        query: url.search,
        referer: req.headers.referer ?? null,
        status: null, rawResponse: ''
      };
      observed.push(record);

      const original = { log: console.log, warn: console.warn, error: console.error };
      console.log = console.warn = console.error = line => logs.push(String(line));
      let answer;
      try {
        answer = await handleRequest(new Request(url.href, {
          method: req.method, headers: req.headers, ...(body.length ? { body } : {})
        }), { env, db, correlationId: 'browser-invite-test' });
      } finally {
        console.log = original.log; console.warn = original.warn; console.error = original.error;
      }

      record.status = answer.status;
      const text = await answer.text();
      record.rawResponse = text;
      const headers = {};
      answer.headers.forEach((v, k) => { headers[k] = v; });
      resp.writeHead(answer.status, headers);
      return resp.end(text);
    }

    const requested = decodeURIComponent(url.pathname);
    const target = resolve(ROOT, `.${normalize(requested)}`);
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      resp.writeHead(403); return resp.end('forbidden');
    }
    let stats;
    try { stats = statSync(target); } catch {
      resp.writeHead(404, { 'Content-Type': 'text/plain' }); return resp.end('not found');
    }
    if (stats.isDirectory()) { resp.writeHead(403); return resp.end('no listing'); }

    /* THE REAL STAFF HEADERS, including the header CSP the deployment ships. */
    const headers = {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    };
    if (requested.startsWith('/staff/')) {
      headers['Content-Security-Policy'] = csp;
      headers['Referrer-Policy'] = 'no-referrer';
      headers['X-Frame-Options'] = 'DENY';
    }

    /* The onboarding page is served AS BUILT — see generatedOnboardingPage. */
    if (requested === PAGE) {
      resp.writeHead(200, headers);
      return resp.end(onboardingHtml);
    }

    resp.writeHead(200, headers);
    createReadStream(target).pipe(resp);
  });

  server.listen(0, '127.0.0.1', () => {
    res({
      server, observed, logs, csp,
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(done => server.close(done))
    });
  });
});

/* Every fixture server this file starts, so a test that fails an assertion
   before its own close() cannot leave a listening socket holding the event
   loop open — which is a hang, not a failure, and hides the real error. */
const openServers = new Set();

const startBoth = async options => {
  const auth = await startAuthServer(options);
  const ced = await startCedServer(auth);
  openServers.add(auth).add(ced);
  return {
    auth, ced,
    close: async () => {
      openServers.delete(ced); openServers.delete(auth);
      await ced.close(); await auth.close();
    }
  };
};

test.after(async () => {
  for (const s of openServers) { try { await s.close(); } catch { /* already gone */ } }
  openServers.clear();
});

let browser = null;
if (!SKIP) {
  browser = await puppeteer.launch({
    executablePath, headless: true,
    defaultViewport: { width: 1100, height: 800 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
}
test.after(async () => { if (browser) await browser.close(); });

const it = (name, fn) => test(name, { skip: SKIP || false }, fn);

const visible = (page, id) => page.$eval(`#${id}`, el => el.hidden === false);
const textOf = (page, id) => page.$eval(`#${id}`, el => el.textContent.trim());
const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));

/* THE INVITATION ARRIVES IN THE FRAGMENT. A fragment is never transmitted:
   it is absent from the request line of the page load, from every subresource
   request, and from any Referer — so the token cannot reach CED even in
   principle, which is a stronger guarantee than stripping it afterwards. */
const inviteFragment = `#token_hash=${encodeURIComponent(TOKEN_HASH)}&type=invite`;

const open = async (env, query = inviteFragment) => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  const violations = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await page.goto(`${env.ced.origin}${PAGE}${query}`, { waitUntil: 'domcontentloaded' });
  await settle(500);
  return { context, page, errors, violations };
};

const setPassword = async page => {
  await page.type('#password', PASSWORD);
  await page.type('#password-confirm', PASSWORD);
  await page.click('#password-submit');
  await settle(500);
};

/* ============================================================
   1. The whole flow, and where the credentials went
   ============================================================ */

it('an invited operator onboards, talking only to Supabase for every credential', async () => {
  const env = await startBoth();
  const { context, page, errors, violations } = await open(env);

  /* The token is out of the address bar before any network call — fragment
     and query alike. */
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(new URL(page.url()).search, '');
  assert.equal(await visible(page, 'step-password'), true);

  await setPassword(page);
  assert.equal(await visible(page, 'step-factor'), true);
  assert.equal(await textOf(page, 'factor-secret'), SECRET);
  assert.equal(await textOf(page, 'factor-uri'), URI);

  await page.type('#code', '123456');
  await page.click('#factor-submit');
  await settle(500);

  assert.equal(await visible(page, 'step-done'), true);
  const done = await page.$eval('#step-done', el => el.textContent);
  assert.match(done, /must add you as an operator/);

  /* THE CREDENTIALS WENT TO SUPABASE. Every step, on the Auth origin. */
  const authPaths = env.auth.requests.map(r => `${r.method} ${r.path}`);
  assert.ok(authPaths.includes('POST /auth/v1/verify'), 'the invitation was verified there');
  assert.ok(authPaths.includes('PUT /auth/v1/user'), 'the password was set there');
  assert.ok(authPaths.includes('POST /auth/v1/factors'), 'the factor was enrolled there');
  assert.ok(authPaths.some(p => /\/factors\/.+\/verify$/.test(p)), 'and verified there');
  assert.ok(authPaths.includes('POST /auth/v1/logout'), 'and the session was signed out');

  /* Every Auth request carried the PUBLISHABLE key and never the secret. */
  for (const r of env.auth.requests) {
    assert.equal(r.apikey, PUBLISHABLE, `${r.path} used the publishable key`);
    assert.equal(r.raw.includes(SECRET_KEY), false);
  }

  /* AND CED SAW NONE OF IT. One request, a GET, no body. */
  assert.deepEqual(env.ced.observed.map(o => `${o.method} ${o.path}`),
    ['GET /api/staff/identity-resolution/auth-config'],
    'the only CED call is the configuration read');
  assert.equal(env.ced.observed[0].rawBody, '', 'and it carried no body at all');

  assert.deepEqual(errors, []);
  assert.deepEqual(violations, [], 'the shipped CSP permits the whole flow');
  await context.close();
  await env.close();
});

it('no credential appears in any CED request, response, query, referer or log', async () => {
  const env = await startBoth();
  const { context, page } = await open(env);
  await setPassword(page);
  await page.type('#code', '123456');
  await page.click('#factor-submit');
  await settle(500);

  const cedSurface = JSON.stringify(env.ced.observed) + '\n' + env.ced.logs.join('\n');
  for (const [value, label] of CREDENTIALS) {
    assert.equal(cedSurface.includes(value), false, `${label} reached CED`);
  }

  /* Named individually as well, because a JSON.stringify sweep is easy to
     make vacuous. */
  for (const o of env.ced.observed) {
    assert.equal(o.rawBody, '');
    assert.equal(o.query, '', 'nothing was smuggled through a query string');
    assert.equal(o.referer === null || !o.referer.includes(TOKEN_HASH), true,
      'no Referer carried the invitation token');
  }

  /* The secret key never left the function environment either. */
  assert.equal(cedSurface.includes(SECRET_KEY), false);
  const config = JSON.parse(env.ced.observed[0].rawResponse);
  assert.deepEqual(Object.keys(config).sort(), ['ok', 'publishableKey', 'supabaseUrl']);
  assert.equal(config.publishableKey, PUBLISHABLE);

  await context.close();
  await env.close();
});

it('the browser reaches only the two configured origins', async () => {
  const env = await startBoth();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const origins = new Set();
  page.on('request', r => { try { origins.add(new URL(r.url()).origin); } catch { /* noop */ } });

  await page.goto(`${env.ced.origin}${PAGE}${inviteFragment}`,
    { waitUntil: 'domcontentloaded' });
  await settle(500);
  await setPassword(page);
  await page.type('#code', '123456');
  await page.click('#factor-submit');
  await settle(500);

  assert.deepEqual([...origins].sort(), [env.auth.origin, env.ced.origin].sort(),
    'no third origin — no CDN, no analytics, no font host');

  await context.close();
  await env.close();
});

/* ============================================================
   2. Invitation types, malformed, expired, replayed
   ============================================================ */

it('the invite type is the page\'s, so a recovery link never enters the flow', async () => {
  const env = await startBoth();
  const { context, page } = await open(env,
    `#token_hash=${TOKEN_HASH}&type=recovery`);

  /* No password form at all, and nothing was sent to Supabase. */
  assert.equal(await visible(page, 'no-invite'), true);
  assert.equal(await visible(page, 'step-password'), false);
  assert.deepEqual(env.auth.requests, []);

  /* And the token was still stripped from the URL — a refused token is still
     a token. */
  assert.equal(new URL(page.url()).hash, '');

  await context.close();
  await env.close();
});

it('every other OTP type is refused the same way', async () => {
  for (const type of ['signup', 'magiclink', 'email_change', 'email', 'sms', '']) {
    const env = await startBoth();
    const { context, page } = await open(env,
      `#token_hash=${TOKEN_HASH}&type=${encodeURIComponent(type)}`);
    assert.equal(await visible(page, 'step-password'), false, type);
    assert.deepEqual(env.auth.requests, [], type);
    await context.close();
    await env.close();
  }
});

it('an expired or already-used invitation fails safely and offers recovery', async () => {
  const env = await startBoth({ invitation: 'expired' });
  const { context, page } = await open(env);
  await setPassword(page);

  assert.equal(await visible(page, 'step-factor'), false);
  const error = await textOf(page, 'password-error');
  assert.match(error, /not valid/);
  assert.match(error, /Finish an interrupted set-up/);
  assert.equal(error.includes(TOKEN_HASH), false);

  /* Only the verify call happened — no password was sent after the refusal. */
  assert.deepEqual(env.auth.requests.map(r => `${r.method} ${r.path}`),
    ['POST /auth/v1/verify']);

  await context.close();
  await env.close();
});

it('a replayed invitation cannot be resubmitted from the page', async () => {
  /* The page clears the token the moment verifyOtp succeeds, so a second
     submit cannot spend it again even if the operator double-clicks. */
  const env = await startBoth();
  const { context, page } = await open(env);
  await setPassword(page);
  assert.equal(await page.evaluate(() => window.CED_STAFF_ONBOARDING.holdsInvitation()), false);

  const verifyCalls = env.auth.requests.filter(r => r.path === '/auth/v1/verify').length;
  assert.equal(verifyCalls, 1, 'exactly one verification attempt');

  await context.close();
  await env.close();
});

it('a malformed link with no token offers recovery rather than a dead end', async () => {
  const env = await startBoth();
  const { context, page } = await open(env, '#token_hash=&type=invite');
  assert.equal(await visible(page, 'no-invite'), true);
  assert.deepEqual(env.auth.requests, []);

  const text = await page.$eval('#no-invite', el => el.textContent);
  assert.match(text, /already set your password/);
  assert.equal(/create an account|sign up|register/i.test(text), false,
    'there is no registration path anywhere');

  await context.close();
  await env.close();
});

/* ============================================================
   3. Recovery — interrupted after the invitation was consumed
   ============================================================ */

it('a reload after the password step recovers without a second invitation', async () => {
  /* THE SCENARIO: the invitation is spent, the password exists, the factor is
     half-enrolled, and the page was reloaded. Supabase cannot re-invite an
     existing user, so a second invitation is not available — and must not be
     needed. */
  const env = await startBoth({
    factors: [{ id: 'f0000000-0000-4000-8000-0000000000ff', factor_type: 'totp',
                status: 'unverified', friendly_name: 'CED Service staff console' }]
  });

  /* The reload: the plain page URL, no parameters at all. */
  const { context, page } = await open(env, '');
  assert.equal(await visible(page, 'no-invite'), true);

  await page.click('#show-resume');
  await settle(200);
  assert.equal(await visible(page, 'step-resume'), true);

  await page.type('#resume-email', EMAIL);
  await page.type('#resume-password', PASSWORD);
  await page.click('#resume-submit');
  await settle(600);

  /* Straight to enrollment, with a fresh key. */
  assert.equal(await visible(page, 'step-factor'), true);
  assert.equal(await textOf(page, 'factor-secret'), SECRET);

  const paths = env.auth.requests.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('POST /auth/v1/token'), 'signed in with the password they already set');
  assert.ok(paths.some(p => /^DELETE \/auth\/v1\/factors\//.test(p)),
    'the abandoned unverified factor was removed, or the re-enroll would collide');
  assert.ok(paths.includes('POST /auth/v1/factors'), 'and a fresh one enrolled');
  assert.equal(paths.includes('POST /auth/v1/verify'), false,
    'NO invitation was needed — that is the whole point');

  await page.type('#code', '123456');
  await page.click('#factor-submit');
  await settle(500);
  assert.equal(await visible(page, 'step-done'), true);

  /* And CED still saw nothing but the config read. */
  assert.deepEqual(env.ced.observed.map(o => o.method), ['GET']);
  const surface = JSON.stringify(env.ced.observed) + env.ced.logs.join('\n');
  for (const [value, label] of CREDENTIALS) {
    assert.equal(surface.includes(value), false, `${label} reached CED during recovery`);
  }

  await context.close();
  await env.close();
});

it('recovery with a wrong password is refused and enrolls nothing', async () => {
  const env = await startBoth();
  const { context, page } = await open(env, '');
  await page.click('#show-resume');
  await page.type('#resume-email', EMAIL);
  await page.type('#resume-password', 'not-the-right-password');
  await page.click('#resume-submit');
  await settle(500);

  assert.equal(await visible(page, 'step-factor'), false);
  assert.match(await textOf(page, 'resume-error'), /not accepted/);
  assert.equal(env.auth.requests.some(r => r.path === '/auth/v1/factors'), false);

  await context.close();
  await env.close();
});

it('recovery on an already-verified account is not a second way in', async () => {
  const env = await startBoth({
    factors: [{ id: 'f0000000-0000-4000-8000-00000000aaaa', factor_type: 'totp',
                status: 'verified', friendly_name: 'CED Service staff console' }]
  });
  const { context, page } = await open(env, '');
  await page.click('#show-resume');
  await page.type('#resume-email', EMAIL);
  await page.type('#resume-password', PASSWORD);
  await page.click('#resume-submit');
  await settle(600);

  assert.equal(await visible(page, 'step-factor'), false, 'no enrollment is offered');
  assert.match(await textOf(page, 'resume-already'), /already has a verified authenticator/);
  assert.ok(env.auth.requests.some(r => r.path === '/auth/v1/logout'),
    'and the session it created was signed out');
  assert.equal(env.auth.requests.some(r => r.path === '/auth/v1/factors'), false);

  await context.close();
  await env.close();
});

/* ============================================================
   4. What the page holds, and what it grants
   ============================================================ */

it('the page persists nothing — no storage, no cookie', async () => {
  const env = await startBoth();
  const { context, page } = await open(env);
  await setPassword(page);
  await page.type('#code', '123456');
  await page.click('#factor-submit');
  await settle(500);

  const stored = await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
    cookie: document.cookie
  }));
  assert.deepEqual(stored.local, [], 'persistSession: false means no localStorage');
  assert.deepEqual(stored.session, []);
  assert.equal(stored.cookie, '');

  /* And the enrollment material is cleared from the DOM. */
  assert.equal(await textOf(page, 'factor-secret'), '');
  assert.equal(await page.evaluate(() => window.CED_STAFF_ONBOARDING.holdsFactor()), false);

  await context.close();
  await env.close();
});

it('a completed enrollment is still refused the queue', async () => {
  /* Requirement: enrollment grants nothing. Driven with a real aal2 token
     against the real route, from a real browser. */
  const seen = [];
  const server = createServer(async (req, resp) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
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
    const answer = await handleRequest(new Request(url.href, {
      method: req.method, headers: req.headers
    }), {
      env: { CED_ALLOW_INSECURE_STAFF: 'true', CED_LOG_LEVEL: 'error' },
      db,
      verifyAccessToken: async () => ({ userId: USER, aal: 'aal2', emailConfirmed: true }),
      correlationId: 'browser-invite-test'
    });
    const headers = {};
    answer.headers.forEach((v, k) => { headers[k] = v; });
    headers['access-control-allow-origin'] = '*';
    resp.writeHead(answer.status, headers);
    resp.end(await answer.text());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(`${origin}/api/staff/identity-resolution/auth-config`,
    { waitUntil: 'domcontentloaded' }).catch(() => {});

  const result = await page.evaluate(async (base, token) => {
    const res = await fetch(`${base}/api/staff/identity-resolution/cases`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
    });
    return { status: res.status, body: await res.json() };
  }, origin, AAL2);

  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'not_an_operator');
  assert.equal(seen.includes('staff_identity_queue'), false);

  await context.close();
  await new Promise(done => server.close(done));
});

/* ============================================================
   5. The invitation never reaches the wire, and a query one is refused
   ============================================================ */

it('the invitation fragment is absent from every request CED ever sees', async () => {
  /* THE PROPERTY A FRAGMENT BUYS. It is not merely stripped after the fact —
     the browser never transmits it, so it is absent from the page load
     itself, which is the one request no amount of page JavaScript could have
     cleaned up. Observed on the raw request line. */
  const env = await startBoth();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  const cedRequests = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.origin === env.ced.origin) {
      cedRequests.push({ url: r.url(), referer: r.headers().referer || null });
    }
  });

  await page.goto(`${env.ced.origin}${PAGE}${inviteFragment}`, { waitUntil: 'domcontentloaded' });
  await settle(500);
  await setPassword(page);
  await page.type('#code', '123456');
  await page.click('#factor-submit');
  await settle(500);

  assert.ok(cedRequests.length >= 3, 'the page, its scripts and auth-config were fetched');
  for (const r of cedRequests) {
    /* THE TRANSMITTED PART ONLY. Puppeteer reports the document URL as the
       browser knows it, fragment included — but a fragment is never put on
       the wire, which is the entire property under test. So the assertion is
       on origin + path + query, which is exactly what a request line carries,
       and the server-side check below is the authoritative one. */
    const u = new URL(r.url);
    const onTheWire = `${u.pathname}${u.search}`;
    assert.equal(onTheWire.includes(TOKEN_HASH), false, `the token is in a request line: ${onTheWire}`);
    assert.equal(onTheWire.includes('token_hash'), false,
      `a token_hash parameter reached CED: ${onTheWire}`);
    if (r.referer) {
      assert.equal(r.referer.includes(TOKEN_HASH), false, 'a Referer carried the token');
      assert.equal(r.referer.includes('#'), false, 'a Referer must never carry a fragment');
    }
  }

  /* And the server agrees — this is the one that decides it. Nothing it
     received carried the token in any form. */
  for (const o of env.ced.observed) {
    assert.equal(o.query, '');
    assert.equal(o.rawBody, '');
    assert.equal((o.referer || '').includes(TOKEN_HASH), false);
  }
  assert.equal(env.ced.logs.join('\n').includes(TOKEN_HASH), false);

  await context.close();
  await env.close();
});

it('an invitation offered in the QUERY string is refused, not used', async () => {
  /* A query token has already been sent to a server and written to an access
     log by the time this page runs. Using it would be treating a leaked
     credential as a usable one, so it is refused and said out loud. */
  const env = await startBoth();
  const { context, page } = await open(env, `?token_hash=${encodeURIComponent(TOKEN_HASH)}&type=invite`);

  assert.equal(await visible(page, 'query-token'), true, 'the page says why it refused');
  assert.equal(await visible(page, 'step-password'), false, 'and offers no invitation form');
  assert.match(await page.$eval('#query-token', el => el.textContent), /already used/);

  assert.deepEqual(env.auth.requests, [], 'nothing was sent to Supabase with it');
  assert.equal(await page.evaluate(() => window.CED_STAFF_ONBOARDING.holdsInvitation()), false);

  /* It is still cleared from the address bar, even though it is refused. */
  assert.equal(new URL(page.url()).search, '');

  /* Recovery is still offered — a refused link must not be a dead end. */
  assert.equal(await visible(page, 'no-invite'), true);

  await context.close();
  await env.close();
});

it('a query token is refused even when a valid fragment token is also present', async () => {
  /* The query one has leaked regardless, so its mere presence is the
     refusal — the page must not quietly prefer the safe one and carry on. */
  const env = await startBoth();
  const { context, page } = await open(env, `?token_hash=${TOKEN_HASH}${inviteFragment}`);

  assert.equal(await visible(page, 'query-token'), true);
  assert.equal(await visible(page, 'step-password'), false);
  assert.deepEqual(env.auth.requests, []);

  await context.close();
  await env.close();
});

it('the generated CSP is what the browser enforced, and it named one origin', async () => {
  const env = await startBoth();
  const { context, page, violations } = await open(env);

  const policy = await page.$eval(
    'meta[http-equiv="Content-Security-Policy"]', el => el.getAttribute('content'));
  const connect = policy.match(/connect-src ([^;]+);/)[1].trim().split(/\s+/);
  assert.deepEqual(connect, ["'self'", env.auth.origin],
    'exactly two sources, generated for this environment');
  assert.equal(policy.includes('*'), false);
  assert.equal(policy.includes('wss'), false);
  assert.equal(policy.includes('REPLACE-WITH-PROJECT-REF'), false);

  /* The header policy carries neither of the two per-page directives, so it
     cannot intersect with the one above and block it. */
  const header = env.ced.csp;
  assert.equal(/(^|;)\s*connect-src/.test(header), false);
  assert.equal(/(^|;)\s*default-src/.test(header), false);
  assert.match(header, /frame-ancestors 'none'/);

  await setPassword(page);
  assert.equal(await visible(page, 'step-factor'), true,
    'and the Auth call the policy permits actually succeeded');
  assert.deepEqual(violations, []);

  await context.close();
  await env.close();
});

it('the client is configured with no persistence, no auto-refresh, no URL detection', async () => {
  /* Read from the page's own source rather than inferred from behaviour, so
     the requirement is pinned even if a future refactor moves the call. */
  const source = readFileSync(join(ROOT, 'staff/identity-resolution/accept-invite.js'), 'utf8');
  assert.match(source, /persistSession:\s*false/);
  assert.match(source, /autoRefreshToken:\s*false/);
  assert.match(source, /detectSessionInUrl:\s*false/);
  /* And the type is a constant, never read from the query string. */
  assert.match(source, /const OTP_TYPE = 'invite'/);
  assert.equal(/type:\s*(params|type|query)/.test(source), false,
    'the OTP type must never come from the URL');
});
