/* ============================================================
   Password recovery — the invitation failure window
   ------------------------------------------------------------
   THE DEFECT THIS FILE EXISTS FOR.

   Accepting an invitation is two calls against Supabase Auth:

     verifyOtp({ type: 'invite' })   consumes the one-time token
     updateUser({ password })        creates the password

   Between them the account EXISTS and has NO USABLE PASSWORD.
   Two things can leave somebody there, and they are
   indistinguishable from the browser:

     A. updateUser FAILED — refused, or the tab closed, or the
        connection dropped before it was sent.
     B. updateUser SUCCEEDED but its RESPONSE WAS LOST — the
        password is set and the page never found out.

   In both, the invitation is spent and cannot be reissued
   (Supabase will not invite a user that already exists), and the
   password-based resume flow needs a password. Before this, that
   person was stranded.

   Password recovery closes it, because it depends on the ACCOUNT
   rather than on the invitation. This suite drives both windows
   end to end in a real browser: strand the user, recover, and
   prove they reach the MFA-resume flow.

   Two servers, as in the invite suite: CED (real static files,
   real handleRequest) and a GoTrue-shaped Auth server on a
   different origin. window.fetch is not replaced. The onboarding
   and recovery pages are served AS BUILT, under the real header
   CSP and their generated meta CSP.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, normalize, sep, join } from 'node:path';

import { handleRequest } from '../../server/staff-identity-resolution.mjs';
import { __testing as buildTesting } from '../../tools/build-static.mjs';
import { PUBLISHABLE_FIXTURE, SECRET_FIXTURE } from '../helpers/supabase-keys.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INVITE_PAGE = '/staff/identity-resolution/accept-invite.html';
const RESET_PAGE = '/staff/identity-resolution/reset-password.html';

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
    `\n  ✖ REAL-BROWSER RECOVERY VERIFICATION SKIPPED: ${SKIP}.`
    + '\n    The invitation failure window was NOT observed on this run.\n');
}

const USER = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'invited@example.test';
const UNKNOWN_EMAIL = 'nobody@example.test';
const INVITE_TOKEN = 'pkce_9d3f2a1b8c7e6d5f4a3b2c1d0e9f8a7b6c5d4e3f';
const RECOVERY_TOKEN = 'pkce_ffffeeeeddddccccbbbbaaaa99998888777766665';
const OLD_PASSWORD = 'a-long-enough-passphrase';
const NEW_PASSWORD = 'a-different-long-passphrase';
const SECRET = 'JBSWY3DPEHPK3PXP';
const PUBLISHABLE = PUBLISHABLE_FIXTURE;

const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = c => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(c)}.sig`;
const AAL1 = jwt({ sub: USER, aal: 'aal1', exp: 1893456000 });
const AAL2 = jwt({ sub: USER, aal: 'aal2', exp: 1893456000 });

const CREDENTIALS = [
  [OLD_PASSWORD, 'the invitation password'],
  [NEW_PASSWORD, 'the recovered password'],
  [INVITE_TOKEN, 'the invitation token'],
  [RECOVERY_TOKEN, 'the recovery token'],
  [AAL1, 'the aal1 token'],
  [AAL2, 'the aal2 token'],
  ['refresh-1', 'the refresh token'],
  [SECRET, 'the TOTP secret'],
  ['123456', 'the TOTP code'],
  [EMAIL, 'the email address']
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8'
};

const staffHeaderCsp = () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const rule = config.headers.find(h => h.source === '/staff/(.*)');
  return rule.headers.find(h => h.key === 'Content-Security-Policy').value;
};

/* The pages AS BUILT, through the build's own substitution. */
const generatedPage = (relPath, authOrigin) => {
  const source = readFileSync(join(ROOT, relPath), 'utf8');
  if (source.split(buildTesting.CSP_SOURCE_LINE).length - 1 !== 1) {
    throw new Error(`${relPath}: the base CSP line is not present exactly once`);
  }
  return source.replace(buildTesting.CSP_SOURCE_LINE, buildTesting.cspLineFor(authOrigin));
};

/* ---------- the fake Supabase Auth server ----------
   Models the ACCOUNT, not just the calls, so a recovery genuinely depends on
   the state the invitation left behind.

   `passwordSet` is the fact the whole suite turns on: false while the account
   exists with no usable password. `updateUserMode` reproduces the two
   indistinguishable failures — a refusal, and a success whose response the
   browser never receives. */
const startAuthServer = ({ updateUserMode = 'ok', factors = [] } = {}) =>
  new Promise(res => {
    const requests = [];
    const state = {
      exists: false, passwordSet: false, password: null,
      factors: [...factors], recoveryIssued: 0, recoveryEverIssued: false,
      mode: updateUserMode
    };

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
        method: req.method, path: url.pathname, query: url.search, raw,
        apikey: req.headers.apikey || null
      });

      const send = (status, body) => {
        resp.writeHead(status, { 'Content-Type': 'application/json', ...cors });
        resp.end(JSON.stringify(body));
      };
      const user = () => ({
        id: USER, email: EMAIL, email_confirmed_at: '2026-01-01T00:00:00Z',
        factors: state.factors, app_metadata: {}, user_metadata: {},
        aud: 'authenticated', created_at: '2026-01-01T00:00:00Z'
      });
      const session = token => ({
        access_token: token, token_type: 'bearer', expires_in: 3600,
        expires_at: 1893456000, refresh_token: 'refresh-1', user: user()
      });

      const p = url.pathname;

      /* The invitation. Consuming it CREATES the account — which is exactly
         why a later re-invite is impossible and recovery is the only way. */
      if (p === '/auth/v1/verify' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        if (body.type === 'invite') {
          if (state.exists || body.token_hash !== INVITE_TOKEN) {
            return send(403, { error: 'invalid_grant',
                               error_description: 'Token has expired or is invalid' });
          }
          state.exists = true;
          return send(200, session(AAL1));
        }
        if (body.type === 'recovery') {
          /* A recovery token is only valid if one was actually issued, is the
             right token, and has not already been spent. */
          if (state.recoveryIssued < 1 || body.token_hash !== RECOVERY_TOKEN) {
            return send(403, { error: 'invalid_grant',
                               error_description: 'Token has expired or is invalid' });
          }
          state.recoveryIssued -= 1;
          return send(200, session(AAL1));
        }
        return send(403, { error: 'invalid_grant', error_description: 'wrong type' });
      }

      /* The reset request. Answers 200 whether or not the account exists —
         GoTrue's own behaviour, and what stops it being an oracle. */
      if (p === '/auth/v1/recover' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        if (state.exists && body.email === EMAIL) {
          state.recoveryIssued += 1;
          /* Sticky, unlike the spendable count: it is what tells the failure
             modes below that the INVITATION attempt is over. Using the
             spendable counter would re-arm them, because verifying a recovery
             token decrements it back to zero before updateUser runs. */
          state.recoveryEverIssued = true;
        }
        return send(200, {});
      }

      if (p === '/auth/v1/user' && req.method === 'PUT') {
        const body = JSON.parse(raw || '{}');
        if (!body.password || body.password.length < 6) {
          return send(422, { error: 'weak_password', error_description: 'Password is too short' });
        }
        /* WINDOW A — the call is refused, so no password is ever set. ONE
           SHOT: it models the invitation's updateUser failing, not every
           updateUser forever — the recovery page's own updateUser must be
           able to succeed afterwards, which is the whole point. */
        if (state.mode === 'fail' && !state.recoveryEverIssued && !state.passwordSet) {
          return send(500, { error: 'server_error', error_description: 'temporary failure' });
        }
        /* WINDOW B — the password IS set and the answer never arrives. The
           account is changed; the browser is not told. */
        state.password = body.password;
        state.passwordSet = true;
        /* The password IS set and the answer never arrives — including on
           auth-js's automatic retries, which is what actually strands
           somebody: the library retries a dropped connection, so a single
           lost response usually self-heals. Only a persistently lost answer
           leaves an account with a password its owner never learned. Gated
           on "before any recovery", so the recovery page's own updateUser
           still works. */
        if (state.mode === 'lose-response' && !state.recoveryEverIssued) {
          return req.socket.destroy();
        }
        return send(200, user());
      }

      if (p === '/auth/v1/user' && req.method === 'GET') return send(200, user());

      if (p === '/auth/v1/token' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        if (url.searchParams.get('grant_type') !== 'password'
            || body.email !== EMAIL
            || !state.passwordSet || body.password !== state.password) {
          return send(400, { error: 'invalid_grant',
                             error_description: 'Invalid login credentials' });
        }
        return send(200, session(AAL1));
      }

      if (p === '/auth/v1/factors' && req.method === 'POST') {
        const id = 'f0000000-0000-4000-8000-000000000001';
        state.factors = [...state.factors,
          { id, factor_type: 'totp', status: 'unverified',
            friendly_name: JSON.parse(raw || '{}').friendly_name }];
        return send(200, {
          id, type: 'totp',
          totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: SECRET,
                  uri: `otpauth://totp/CED:${EMAIL}?secret=${SECRET}` }
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
        if (JSON.parse(raw || '{}').code !== '123456') {
          return send(422, { error: 'invalid_code',
                             error_description: 'Invalid TOTP code entered' });
        }
        state.factors = state.factors.map(f =>
          f.id === verify[1] ? { ...f, status: 'verified' } : f);
        return send(200, session(AAL2));
      }

      if (p === '/auth/v1/logout' && req.method === 'POST') {
        resp.writeHead(204, cors); return resp.end();
      }

      send(404, { error: 'not_found', error_description: p });
    });

    server.listen(0, '127.0.0.1', () => {
      res({
        server, requests, state,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(done => server.close(done))
      });
    });
  });

const startCedServer = auth => new Promise(res => {
  const observed = [];
  const logs = [];
  const csp = staffHeaderCsp();
  const pages = {
    [INVITE_PAGE]: generatedPage('staff/identity-resolution/accept-invite.html', auth.origin),
    [RESET_PAGE]: generatedPage('staff/identity-resolution/reset-password.html', auth.origin)
  };

  const env = {
    CED_ALLOW_INSECURE_STAFF: 'true', CED_LOG_LEVEL: 'debug',
    SUPABASE_URL: auth.origin, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    SUPABASE_SECRET_KEY: SECRET_FIXTURE
  };
  const db = new Proxy({}, {
    get(_t, prop) { throw new Error(`the database was reached: ${String(prop)}`); }
  });

  const server = createServer(async (req, resp) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/staff/identity-resolution')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const record = {
        method: req.method, path: url.pathname, query: url.search,
        rawBody: body.toString('utf8'), referer: req.headers.referer ?? null,
        status: null, rawResponse: ''
      };
      observed.push(record);

      const original = { log: console.log, warn: console.warn, error: console.error };
      console.log = console.warn = console.error = line => logs.push(String(line));
      let answer;
      try {
        answer = await handleRequest(new Request(url.href, {
          method: req.method, headers: req.headers, ...(body.length ? { body } : {})
        }), { env, db, correlationId: 'browser-recovery-test' });
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
    const headers = {
      'Content-Type': TYPES[extname(requested).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    };
    if (requested.startsWith('/staff/')) {
      headers['Content-Security-Policy'] = csp;
      headers['Referrer-Policy'] = 'no-referrer';
      headers['X-Frame-Options'] = 'DENY';
    }
    if (pages[requested]) {
      resp.writeHead(200, headers);
      return resp.end(pages[requested]);
    }

    const target = resolve(ROOT, `.${normalize(requested)}`);
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      resp.writeHead(403); return resp.end('forbidden');
    }
    let stats;
    try { stats = statSync(target); } catch {
      resp.writeHead(404, { 'Content-Type': 'text/plain' }); return resp.end('not found');
    }
    if (stats.isDirectory()) { resp.writeHead(403); return resp.end('no listing'); }
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

let browser = null;
if (!SKIP) {
  browser = await puppeteer.launch({
    executablePath, headless: true,
    defaultViewport: { width: 1100, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
}
test.after(async () => {
  for (const s of openServers) { try { await s.close(); } catch { /* gone */ } }
  openServers.clear();
  if (browser) await browser.close();
});

const it = (name, fn) => test(name, { skip: SKIP || false }, fn);

const settle = (ms = 500) => new Promise(r => setTimeout(r, ms));
const visible = (page, id) => page.$eval(`#${id}`, el => el.hidden === false);
const textOf = (page, id) => page.$eval(`#${id}`, el => el.textContent.trim());

const openPage = async (env, path, fragment = '') => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${env.ced.origin}${path}${fragment}`, { waitUntil: 'domcontentloaded' });
  await settle();
  return { context, page, errors };
};

/* Strands the user in the invitation window: the account is created, and the
   password either fails or its response is lost. */
const strandTheUser = async env => {
  const { context, page } = await openPage(env, INVITE_PAGE,
    `#token_hash=${INVITE_TOKEN}&type=invite`);
  await page.type('#password', OLD_PASSWORD);
  await page.type('#password-confirm', OLD_PASSWORD);
  await page.click('#password-submit');
  await settle(700);
  return { context, page };
};

const requestReset = async (env, email = EMAIL, wait = 600) => {
  const { context, page } = await openPage(env, INVITE_PAGE);
  await page.click('#show-reset');
  await settle(150);
  await page.type('#reset-email', email);
  await page.click('#reset-submit');
  /* auth-js retries a failed fetch with backoff before returning, so an
     unreachable Supabase takes measurably longer than a reachable one. */
  await settle(wait);
  return { context, page };
};

const completeReset = async env => {
  const { context, page } = await openPage(env, RESET_PAGE,
    `#token_hash=${RECOVERY_TOKEN}&type=recovery`);
  await page.type('#password', NEW_PASSWORD);
  await page.type('#password-confirm', NEW_PASSWORD);
  await page.click('#password-submit');
  await settle(700);
  return { context, page };
};

/* Proves the recovered password actually reaches the MFA-resume flow. */
const resumeWithNewPassword = async env => {
  const { context, page } = await openPage(env, INVITE_PAGE);
  await page.click('#show-resume');
  await settle(150);
  await page.type('#resume-email', EMAIL);
  await page.type('#resume-password', NEW_PASSWORD);
  await page.click('#resume-submit');
  await settle(700);
  return { context, page };
};

/* ============================================================
   1. Window A — updateUser failed
   ============================================================ */

it('WINDOW A: updateUser fails, and password recovery restores the resume flow', async () => {
  const env = await startBoth({ updateUserMode: 'fail' });

  /* Stranded: the account exists, no password was ever set. */
  const stranded = await strandTheUser(env);
  assert.equal(env.auth.state.exists, true, 'the invitation created the account');
  assert.equal(env.auth.state.passwordSet, false, 'and no password was set');
  assert.equal(await visible(stranded.page, 'step-factor'), false, 'the flow did not advance');
  await stranded.context.close();

  /* The invitation cannot be replayed — the account already exists. */
  const replay = await openPage(env, INVITE_PAGE, `#token_hash=${INVITE_TOKEN}&type=invite`);
  await replay.page.type('#password', OLD_PASSWORD);
  await replay.page.type('#password-confirm', OLD_PASSWORD);
  await replay.page.click('#password-submit');
  await settle(600);
  assert.match(await textOf(replay.page, 'password-error'), /not valid/);
  await replay.context.close();

  /* Recovery: request, set a new password, resume. */
  const requested = await requestReset(env);
  assert.equal(env.auth.state.recoveryIssued, 1, 'Supabase was asked to send a reset');
  await requested.context.close();

  const reset = await completeReset(env);
  assert.equal(await visible(reset.page, 'step-done'), true, 'the password was set');
  assert.equal(env.auth.state.passwordSet, true);
  assert.equal(env.auth.state.password, NEW_PASSWORD);
  /* The recovery page signs out and enrolls nothing. */
  assert.ok(env.auth.requests.some(r => r.path === '/auth/v1/logout'));
  assert.equal(env.auth.requests.some(r => r.path === '/auth/v1/factors'), false,
    'the recovery page must not enroll a factor');
  await reset.context.close();

  /* AND THE POINT: the resume flow now works with the new password. */
  const resumed = await resumeWithNewPassword(env);
  assert.equal(await visible(resumed.page, 'step-factor'), true,
    'the MFA-resume flow was reached with the recovered password');
  assert.equal(await textOf(resumed.page, 'factor-secret'), SECRET);

  await resumed.page.type('#code', '123456');
  await resumed.page.click('#factor-submit');
  await settle(600);
  assert.equal(await visible(resumed.page, 'step-done'), true, 'and enrollment completed');

  await resumed.context.close();
  await env.close();
});

/* ============================================================
   2. Window B — updateUser succeeded, response lost
   ============================================================ */

it('WINDOW B: the updateUser response is lost, and recovery still restores access', async () => {
  /* The nastier one: the password IS set and the browser never learns it, so
     the person does not know what their password is. Recovery must work
     without depending on the old one. */
  const env = await startBoth({ updateUserMode: 'lose-response' });

  const stranded = await strandTheUser(env);
  assert.equal(env.auth.state.exists, true);
  assert.equal(env.auth.state.passwordSet, true, 'the password WAS set server-side');
  assert.equal(await visible(stranded.page, 'step-factor'), false,
    'but the page never advanced, so the person does not know that');
  await stranded.context.close();

  /* They do not know the password, so resume cannot help — proven, not
     assumed. */
  const guess = await openPage(env, INVITE_PAGE);
  await guess.page.click('#show-resume');
  await settle(150);
  await guess.page.type('#resume-email', EMAIL);
  await guess.page.type('#resume-password', 'a-guess-that-is-long-enough');
  await guess.page.click('#resume-submit');
  await settle(600);
  assert.match(await textOf(guess.page, 'resume-error'), /not accepted/);
  await guess.context.close();

  const requested = await requestReset(env);
  assert.equal(env.auth.state.recoveryIssued, 1);
  await requested.context.close();

  const reset = await completeReset(env);
  assert.equal(await visible(reset.page, 'step-done'), true);
  assert.equal(env.auth.state.password, NEW_PASSWORD, 'the password was replaced');
  await reset.context.close();

  const resumed = await resumeWithNewPassword(env);
  assert.equal(await visible(resumed.page, 'step-factor'), true,
    'the MFA-resume flow was reached');
  await resumed.context.close();
  await env.close();
});

/* ============================================================
   3. The reset request is not an account oracle
   ============================================================ */

it('an unknown email produces exactly the same visible result', async () => {
  const env = await startBoth({ updateUserMode: 'fail' });
  await (await strandTheUser(env)).context.close();

  const known = await requestReset(env, EMAIL);
  const knownText = await textOf(known.page, 'reset-sent');
  const knownError = await known.page.$eval('#reset-error', el => el.hidden);
  await known.context.close();

  const unknown = await requestReset(env, UNKNOWN_EMAIL);
  const unknownText = await textOf(unknown.page, 'reset-sent');
  const unknownError = await unknown.page.$eval('#reset-error', el => el.hidden);
  await unknown.context.close();

  assert.equal(unknownText, knownText, 'the same words, exactly');
  assert.equal(unknownError, knownError, 'and no error shown in one but not the other');
  assert.match(knownText, /If there is an account/);

  /* Supabase was asked either way — the page does not decide. */
  const recovers = env.auth.requests.filter(r => r.path === '/auth/v1/recover');
  assert.equal(recovers.length, 2);

  await env.close();
});

it('a transport failure answers the same way too', async () => {
  /* "Could not reach Supabase" for one address and "sent" for another is the
     same disclosure by another route. */
  const env = await startBoth({ updateUserMode: 'fail' });
  await (await strandTheUser(env)).context.close();
  await env.auth.close();                      /* Supabase is now unreachable */
  openServers.delete(env.auth);

  const { context, page } = await requestReset(env, EMAIL, 12000);
  assert.equal(await visible(page, 'reset-sent'), true);
  assert.match(await textOf(page, 'reset-sent'), /If there is an account/);
  assert.equal(await page.$eval('#reset-error', el => el.hidden), true);

  await context.close();
  await env.ced.close();
  openServers.delete(env.ced);
});

it('the reset request names the exact same-origin recovery page', async () => {
  const env = await startBoth({ updateUserMode: 'fail' });
  await (await strandTheUser(env)).context.close();
  const requested = await requestReset(env);

  const recover = env.auth.requests.find(r => r.path === '/auth/v1/recover');
  const redirect = new URLSearchParams(recover.query).get('redirect_to');
  assert.equal(redirect, `${env.ced.origin}${RESET_PAGE}`,
    'the redirect is absolute, same-origin, and the exact recovery page');
  assert.equal(recover.apikey, PUBLISHABLE);

  await requested.context.close();
  await env.close();
});

/* ============================================================
   4. Recovery tokens fail safely
   ============================================================ */

it('wrong-type, expired, replayed, malformed and absent recovery tokens fail safely', async () => {
  const env = await startBoth({ updateUserMode: 'fail' });
  await (await strandTheUser(env)).context.close();

  /* Wrong type in the fragment: no form, nothing sent. */
  const wrongType = await openPage(env, RESET_PAGE, `#token_hash=${RECOVERY_TOKEN}&type=invite`);
  assert.equal(await visible(wrongType.page, 'no-token'), true);
  assert.equal(await visible(wrongType.page, 'step-password'), false);
  await wrongType.context.close();

  /* No token: no form. */
  const none = await openPage(env, RESET_PAGE);
  assert.equal(await visible(none.page, 'no-token'), true);
  await none.context.close();

  /* Expired / never issued: the form appears, the attempt is refused. */
  const expired = await openPage(env, RESET_PAGE, `#token_hash=${RECOVERY_TOKEN}&type=recovery`);
  await expired.page.type('#password', NEW_PASSWORD);
  await expired.page.type('#password-confirm', NEW_PASSWORD);
  await expired.page.click('#password-submit');
  await settle(600);
  assert.match(await textOf(expired.page, 'password-error'), /not valid/);
  assert.equal(await visible(expired.page, 'step-done'), false);
  assert.equal(env.auth.state.passwordSet, false, 'no password was set by a bad token');
  await expired.context.close();

  /* Malformed token: refused the same way, with no detail. */
  const malformed = await openPage(env, RESET_PAGE, '#token_hash=not-a-real-token&type=recovery');
  await malformed.page.type('#password', NEW_PASSWORD);
  await malformed.page.type('#password-confirm', NEW_PASSWORD);
  await malformed.page.click('#password-submit');
  await settle(600);
  assert.match(await textOf(malformed.page, 'password-error'), /not valid/);
  await malformed.context.close();

  await env.close();
});

it('a recovery token cannot be replayed once it has been spent', async () => {
  const env = await startBoth({ updateUserMode: 'fail' });
  await (await strandTheUser(env)).context.close();
  await (await requestReset(env)).context.close();

  const first = await completeReset(env);
  assert.equal(await visible(first.page, 'step-done'), true);
  await first.context.close();

  /* The same link again: the token is spent server-side, and the page also
     clears it after use so a second submit cannot resend it. */
  const second = await completeReset(env);
  assert.equal(await visible(second.page, 'step-done'), false);
  assert.match(await textOf(second.page, 'password-error'), /not valid/);
  await second.context.close();

  await env.close();
});

it('a recovery token in the QUERY string is refused, not used', async () => {
  const env = await startBoth({ updateUserMode: 'fail' });
  await (await strandTheUser(env)).context.close();
  await (await requestReset(env)).context.close();

  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(`${env.ced.origin}${RESET_PAGE}?token_hash=${RECOVERY_TOKEN}&type=recovery`,
    { waitUntil: 'domcontentloaded' });
  await settle();

  assert.equal(await visible(page, 'query-token'), true, 'the page says why it refused');
  assert.equal(await visible(page, 'step-password'), false, 'and offers no form');
  assert.equal(new URL(page.url()).search, '', 'it is still stripped from the address bar');

  /* Nothing was attempted against Supabase with it, and the issued recovery
     is still unspent — a refused link must not consume the real one. */
  assert.equal(env.auth.requests.some(
    r => r.path === '/auth/v1/verify' && r.raw.includes('recovery')), false,
    'no recovery verification was attempted with a query token');
  assert.equal(env.auth.state.recoveryIssued, 1, 'the real reset is still available');
  assert.equal(env.auth.state.passwordSet, false, 'nothing was set');

  await context.close();
  await env.close();
});

/* ============================================================
   5. Nothing leaks, and nothing is granted
   ============================================================ */

it('no recovery value reaches CED — request, referrer, storage, cookie or log', async () => {
  const env = await startBoth({ updateUserMode: 'fail' });
  await (await strandTheUser(env)).context.close();
  await (await requestReset(env)).context.close();

  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const cedRequests = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.origin === env.ced.origin) {
      cedRequests.push({ path: `${u.pathname}${u.search}`, referer: r.headers().referer || null });
    }
  });

  await page.goto(`${env.ced.origin}${RESET_PAGE}#token_hash=${RECOVERY_TOKEN}&type=recovery`,
    { waitUntil: 'domcontentloaded' });
  await settle();
  await page.type('#password', NEW_PASSWORD);
  await page.type('#password-confirm', NEW_PASSWORD);
  await page.click('#password-submit');
  await settle(700);
  assert.equal(await visible(page, 'step-done'), true);

  /* On the wire, to CED. */
  assert.ok(cedRequests.length >= 3);
  for (const r of cedRequests) {
    assert.equal(r.path.includes(RECOVERY_TOKEN), false, `token in a request line: ${r.path}`);
    assert.equal(r.path.includes('token_hash'), false, r.path);
    if (r.referer) {
      assert.equal(r.referer.includes(RECOVERY_TOKEN), false);
      assert.equal(r.referer.includes('#'), false);
    }
  }

  /* What CED actually received, and logged. */
  const surface = JSON.stringify(env.ced.observed) + '\n' + env.ced.logs.join('\n');
  for (const [value, label] of CREDENTIALS) {
    assert.equal(surface.includes(value), false, `${label} reached CED`);
  }
  assert.deepEqual([...new Set(env.ced.observed.map(o => o.method))], ['GET']);
  for (const o of env.ced.observed) {
    assert.equal(o.rawBody, '');
    assert.equal(o.query, '');
  }

  /* Storage and cookies: nothing persisted. */
  const stored = await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
    cookie: document.cookie
  }));
  assert.deepEqual(stored.local, []);
  assert.deepEqual(stored.session, []);
  assert.equal(stored.cookie, '');
  assert.equal(await page.evaluate(() => window.CED_STAFF_RECOVERY.holdsToken()), false);

  await context.close();
  await env.close();
});

it('the recovery page grants no operator or queue access', async () => {
  const env = await startBoth({ updateUserMode: 'fail' });
  await (await strandTheUser(env)).context.close();
  await (await requestReset(env)).context.close();
  const reset = await completeReset(env);
  assert.equal(await visible(reset.page, 'step-done'), true);

  /* It touched no CED endpoint but /auth-config, and no database — the db
     proxy throws on any access, so a 200 for every CED call is the proof. */
  assert.deepEqual([...new Set(env.ced.observed.map(o => o.path))],
    ['/api/staff/identity-resolution/auth-config']);
  for (const o of env.ced.observed) assert.equal(o.status, 200);

  /* No factor was enrolled and no aal2 session was produced. */
  assert.equal(env.auth.requests.some(r => r.path === '/auth/v1/factors'), false);
  assert.equal(env.auth.requests.some(r => /\/factors\/.+\/verify$/.test(r.path)), false);
  await reset.context.close();

  /* And the queue is still closed to this account, with a real aal2 token. */
  const seen = [];
  const server = createServer(async (req, resp) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const answer = await handleRequest(new Request(url.href, {
      method: req.method, headers: req.headers
    }), {
      env: { CED_ALLOW_INSECURE_STAFF: 'true', CED_LOG_LEVEL: 'error' },
      db: {
        async rpc(name) {
          seen.push(name);
          if (name === 'check_rate_limit') return { data: { allowed: true }, error: null };
          if (name === 'staff_operator_guard') {
            return { data: null, error: { message: 'staff_not_an_operator: not a staff operator' } };
          }
          throw new Error(`the guard must refuse before ${name}`);
        },
        from() { throw new Error('no table read'); }
      },
      verifyAccessToken: async () => ({ userId: USER, aal: 'aal2', emailConfirmed: true }),
      correlationId: 'browser-recovery-test'
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
  await env.close();
});

it('the recovery page loads no third-party resource and enforces the generated CSP', async () => {
  const env = await startBoth({ updateUserMode: 'fail' });
  const origins = new Set();
  const violations = [];
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('request', r => { try { origins.add(new URL(r.url()).origin); } catch { /* noop */ } });
  page.on('console', m => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });

  await page.goto(`${env.ced.origin}${RESET_PAGE}#token_hash=${RECOVERY_TOKEN}&type=recovery`,
    { waitUntil: 'domcontentloaded' });
  await settle();

  const allowed = new Set([env.ced.origin, env.auth.origin]);
  for (const origin of origins) {
    assert.ok(allowed.has(origin), `a third-party origin was contacted: ${origin}`);
  }
  assert.ok(origins.has(env.ced.origin), 'the page and its scripts came from CED');

  const policy = await page.$eval(
    'meta[http-equiv="Content-Security-Policy"]', el => el.getAttribute('content'));
  const connect = policy.match(/connect-src ([^;]+);/)[1].trim().split(/\s+/);
  assert.deepEqual(connect, ["'self'", env.auth.origin]);
  assert.equal(policy.includes('*'), false);
  assert.equal(policy.includes('wss'), false);
  assert.deepEqual(violations, []);

  const scripts = await page.$$eval('script', els => els.map(e => e.src.split('/').pop()));
  assert.deepEqual(scripts, ['supabase-js-2.112.0.umd.js', 'reset-password.js']);

  await context.close();
  await env.close();
});

it('the recovery client is configured with no persistence and a hard-coded type', () => {
  const source = readFileSync(join(ROOT, 'staff/identity-resolution/reset-password.js'), 'utf8');
  assert.match(source, /persistSession:\s*false/);
  assert.match(source, /autoRefreshToken:\s*false/);
  assert.match(source, /detectSessionInUrl:\s*false/);
  assert.match(source, /const OTP_TYPE = 'recovery'/);
  assert.equal(/type:\s*(params|type|query|hash)/.test(source), false,
    'the OTP type must never come from the URL');
  /* It must not enroll and must call exactly one CED path. Asserted on what
     the code DOES — a bare substring check trips over the file's own prose,
     which legitimately explains that it writes no staff_operators row. */
  assert.equal(/auth\.mfa\b/.test(source), false, 'the recovery page must not touch MFA');
  const fetched = [...source.matchAll(/fetch\(`\$\{API\}([^`]*)`/g)].map(m => m[1]);
  assert.deepEqual(fetched, ['/auth-config'], 'exactly one CED path is ever called');
});
