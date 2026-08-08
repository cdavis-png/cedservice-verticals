/* ============================================================
   What a REAL browser actually sends to the staff route
   ------------------------------------------------------------
   THE DEFECT THIS FILE EXISTS FOR.

   The route once required an `Origin` header on every request,
   GET included, and every suite agreed that was correct. It was
   not. Per the Fetch standard an Origin header is appended when a
   request's response tainting is `cors` OR its method is neither
   GET nor HEAD. A SAME-ORIGIN fetch keeps tainting `basic`, so a
   same-origin GET carries no Origin at all — and an Authorization
   header does not change it, because that forces a preflight only
   when the request is cross-origin. Same-origin requests never
   preflight.

   So the console signed in (POSTs do carry Origin) and then every
   queue listing and every case read came back 403 origin_required.
   The queue was unreachable in Chrome, Edge, Firefox and Safari
   alike, and the whole subsystem was unusable.

   NOTHING CAUGHT IT, because nothing here made a real request:

     · the synthetic suites attached an Origin by hand, so they
       exercised a header combination no browser produces;
     · tests/browser/staff-console-browser.test.mjs replaces
       window.fetch outright, so its requests never reach a socket
       and never acquire browser-generated headers at all.

   WHAT THIS FILE DOES DIFFERENTLY, and why it is worth the cost:

     · window.fetch is NOT replaced. Every request below is made
       by the browser, over a real TCP socket, to a real server.
     · that server hands each request to handleRequest from
       server/staff-identity-resolution.mjs — the production
       module that holds the Origin gate, and the same one the
       deployed entrypoint imports and immediately delegates to.
     · the page that makes the requests is the REAL console:
       index.html, auth.js and page.js, signed in through the real
       form and the real adapter.
     · the headers are OBSERVED and asserted, never assumed.

   WHAT THIS FILE DOES NOT COVER, stated precisely rather than
   implied away. It does not call the deployed entrypoint
   api/staff/identity-resolution/[...path].mjs. It cannot: that
   wrapper takes exactly one argument and deliberately forwards
   only one, which is what stops whatever the platform passes
   second from landing where injected dependencies are read — so
   there is nowhere to hand it the stubbed Auth client and
   database this suite needs. The wrapper itself, and the same
   Origin gate reached THROUGH it, are covered in
   tests/staff-deployment-contract.test.mjs ("the entrypoint
   answers a real Request with a real Response"), which drives it
   with no injection at all. Between them the gate is exercised
   both from a real browser and from the deployed path; neither
   test does both, and this one should not be read as if it did.

   Only the Supabase Auth client and the database are stubbed,
   through handleRequest's existing dependency seam. Everything
   between the browser and that seam is production code.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, normalize, sep } from 'node:path';

import { handleRequest } from '../../server/staff-identity-resolution.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PAGE = '/staff/identity-resolution/index.html';

/* ---------- browser discovery ----------
   The same convention tests/browser/staff-console-browser.test.mjs uses, so a
   machine that can run one suite can run the other. Deliberately not
   Windows-specific: the Windows entries are simply first because that is where
   this repository is developed, and the POSIX paths below are checked on the
   same terms. */
const CANDIDATES = [
  `${process.env.ProgramFiles || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)'] || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
];

const executablePath = CANDIDATES.find(p => p && existsSync(p));
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { puppeteer = null; }

/* Stated plainly rather than passing quietly. A skipped run proves nothing
   about header behaviour, and this file is the only place that behaviour is
   observed rather than assumed. */
const SKIP = !executablePath
  ? 'no Chromium-based browser found on this machine'
  : !puppeteer ? 'puppeteer-core is not installed' : false;

if (SKIP) {
  console.error(
    `\n  ✖ REAL-BROWSER ORIGIN VERIFICATION SKIPPED: ${SKIP}.`
    + '\n    Same-origin GET header behaviour was NOT observed on this run.\n');
}

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '22222222-2222-4222-8222-222222222222';
/* base64url of {"aal":"aal2","sub":"1111…","exp":1893456000} */
const AAL2_TOKEN = 'header.' + Buffer.from(JSON.stringify(
  { sub: OPERATOR, aal: 'aal2', exp: 1893456000 })).toString('base64url') + '.sig';

const QUEUE_ROW = {
  identity_resolution_id: CASE_ID,
  created_at: '2026-08-01T10:00:00.000Z',
  age_seconds: 7200,
  resolution_status: 'manual_review_required',
  recommended_action: 'queue_for_review',
  review_type: 'growth_review',
  confidence: 0.4,
  candidate_count: 1,
  proposal_kinds: [],
  agreed_types: [],
  contradicted_types: ['business_name'],
  escalation_reason: 'A saved identity proposal was contradicted.',
  submitted_label: 'Riverside Barber Co',
  resolvable: true,
  total_count: 1
};

const CASE_DETAIL = {
  caseId: CASE_ID, reviewType: 'growth_review', confidence: 0.4, resolvable: true,
  submitted: { label: 'Riverside Barber Co', email: 'o***@r***.test',
               mobile: '+********4', submittedAt: '2026-08-01T10:00:00.000Z' },
  conflicts: [], candidates: []
};

const authClientFactory = async () => ({
  auth: {
    async signInWithPassword() {
      return { data: { session: { access_token: 'a1' }, user: { id: OPERATOR } }, error: null };
    },
    async signOut() { return { error: null }; },
    async setSession() { return { error: null }; },
    async refreshSession() {
      return { data: { session: { access_token: AAL2_TOKEN, refresh_token: 'refresh-2',
                                  expires_at: 1893456600 }, user: { id: OPERATOR } }, error: null };
    },
    mfa: {
      async listFactors() {
        return { data: { all: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] }, error: null };
      },
      async challengeAndVerify() {
        return { data: { access_token: AAL2_TOKEN, token_type: 'bearer', expires_in: 3600,
                         refresh_token: 'refresh-1', user: { id: OPERATOR } }, error: null };
      }
    }
  }
});

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8'
};

/* ---------- the server under the browser ----------
   Static files for the console, and every /api/staff/… request handed to the
   production handleRequest — the module the deployed entrypoint delegates to,
   not the one-argument wrapper itself (see the header). `observed` records the
   raw headers of each API request exactly as the browser sent them, plus every
   privileged thing the route did or did not do on its behalf. */
const startStaffServer = () => new Promise(res => {
  const observed = [];

  const db = {
    async rpc(name, args) {
      observed[observed.length - 1]?.dbCalls.push(name);
      if (name === 'check_rate_limit') return { data: { allowed: true }, error: null };
      if (name === 'staff_operator_guard') return { data: 'owner', error: null };
      if (name === 'staff_identity_queue') return { data: [QUEUE_ROW], error: null };
      if (name === 'staff_identity_case') return { data: CASE_DETAIL, error: null };
      return { data: null, error: null };
    },
    from(table) {
      return { select() { return this; }, eq() {
        observed[observed.length - 1]?.dbCalls.push(`table:${table}`);
        return { data: [] };
      } };
    }
  };

  const server = createServer(async (req, resp) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/staff/identity-resolution')) {
      const record = {
        method: req.method,
        path: url.pathname,
        /* Exactly what arrived. No normalisation: the point is the raw truth. */
        origin: req.headers.origin === undefined ? null : req.headers.origin,
        secFetchSite: req.headers['sec-fetch-site'] ?? null,
        secFetchMode: req.headers['sec-fetch-mode'] ?? null,
        hasAuthorization: Boolean(req.headers.authorization),
        contentType: req.headers['content-type'] ?? null,
        dbCalls: [],
        authCalls: 0,
        tokensVerified: 0,
        status: null
      };
      observed.push(record);

      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);

      const request = new Request(url.href, {
        method: req.method,
        headers: req.headers,
        ...(body.length ? { body } : {})
      });

      const answer = await handleRequest(request, {
        env: {
          /* The switch that exists precisely so the console can be driven over
             plain http by a browser suite. Loopback-only and refused under
             NODE_ENV=production, both enforced by the route itself. */
          CED_ALLOW_INSECURE_STAFF: 'true',
          CED_LOG_LEVEL: 'error'
        },
        db,
        authClient: async env => { record.authCalls += 1; return (await authClientFactory(env)); },
        verifyAccessToken: async () => {
          record.tokensVerified += 1;
          return { userId: OPERATOR, aal: 'aal2', emailConfirmed: true };
        },
        correlationId: 'browser-origin-test'
      });

      record.status = answer.status;
      const text = await answer.text();
      const headers = {};
      answer.headers.forEach((v, k) => { headers[k] = v; });
      /* So a cross-origin page can at least receive the refusal rather than a
         network error — which keeps the browser-side assertions honest about
         WHY it failed. The route's own refusal is what is under test. */
      headers['access-control-allow-origin'] = '*';
      resp.writeHead(answer.status, headers);
      return resp.end(text);
    }

    /* Static: the real console files. */
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
    resp.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    createReadStream(target).pipe(resp);
  });

  server.listen(0, '127.0.0.1', () => {
    res({
      server,
      observed,
      port: server.address().port,
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(done => server.close(done))
    });
  });
});

/* A second origin, for the cross-site half. Same host family, different host,
   so the browser calls it cross-site and sends the metadata that says so. */
const startAttackerPage = () => new Promise(res => {
  const server = createServer((req, resp) => {
    resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    resp.end('<!doctype html><meta charset="utf-8"><title>other site</title>');
  });
  server.listen(0, '127.0.0.1', () => {
    res({
      server,
      /* `localhost` and `127.0.0.1` are different origins to a browser even
         when they resolve to the same interface. */
      origin: `http://localhost:${server.address().port}`,
      close: () => new Promise(done => server.close(done))
    });
  });
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

/* Signs in through the REAL form and the REAL adapter, over real sockets. */
const signIn = async page => {
  await page.type('#email', 'owner@example.test');
  await page.type('#password', 'correct-horse');
  await page.click('#signin-submit');
  await new Promise(r => setTimeout(r, 250));
  await page.type('#totp', '123456');
  await page.click('#signin-submit');
  await new Promise(r => setTimeout(r, 400));
};

/* ============================================================
   The regression: a real same-origin read
   ============================================================ */

it('the real console loads its queue over a real socket with NO Origin header', async () => {
  const staff = await startStaffServer();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(`${staff.origin}${PAGE}`, { waitUntil: 'domcontentloaded' });
  await signIn(page);

  /* THE PROOF THAT MATTERS: the queue actually rendered. Before the
     method-sensitive gate this was the empty-state message, because the read
     was refused 403. */
  const rows = await page.$$eval('#queue-body tr', els => els.length);
  assert.equal(rows, 1, 'the queue rendered a row, so the read was not refused');
  const summary = await page.$eval('#queue-summary', el => el.textContent);
  assert.match(summary, /1 open case\./);

  const queueReads = staff.observed.filter(o => o.method === 'GET' && /\/cases$/.test(o.path));
  assert.equal(queueReads.length, 1, 'exactly one queue read reached the server');

  const read = queueReads[0];
  /* OBSERVED, not assumed. */
  assert.equal(read.origin, null,
    'a real same-origin GET carries NO Origin header — this is the whole defect');
  assert.equal(read.secFetchSite, 'same-origin',
    'but it does carry Fetch Metadata, which is what the gate now judges it on');
  assert.equal(read.hasAuthorization, true,
    'and it carried the bearer token, which does NOT cause an Origin to appear');
  assert.equal(read.status, 200, 'the production route accepted it');
  assert.ok(read.dbCalls.includes('staff_identity_queue'), 'and served the queue');

  assert.deepEqual(pageErrors, []);
  await context.close();
  await staff.close();
});

it('the real console opens a case over a real socket with NO Origin header', async () => {
  const staff = await startStaffServer();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(`${staff.origin}${PAGE}`, { waitUntil: 'domcontentloaded' });
  await signIn(page);

  await page.click('#queue-body button');
  await new Promise(r => setTimeout(r, 300));

  const detailReads = staff.observed.filter(
    o => o.method === 'GET' && /\/cases\/[0-9a-f-]{36}$/i.test(o.path));
  assert.equal(detailReads.length, 1, 'the case detail read reached the server');

  const read = detailReads[0];
  assert.equal(read.origin, null, 'no Origin on the case-detail GET either');
  assert.equal(read.secFetchSite, 'same-origin');
  assert.equal(read.status, 200, 'the production route accepted it');
  assert.ok(read.dbCalls.includes('staff_identity_case'));

  /* And the panel really opened, which is the operator-visible consequence. */
  assert.equal(await page.$eval('#detail', el => el.hidden), false);

  await context.close();
  await staff.close();
});

it('the unsafe requests DO carry an exact Origin, so nothing was given up', async () => {
  const staff = await startStaffServer();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(`${staff.origin}${PAGE}`, { waitUntil: 'domcontentloaded' });
  await signIn(page);

  const posts = staff.observed.filter(o => o.method === 'POST');
  assert.ok(posts.length >= 2, 'the two-step sign-in really posted twice');
  for (const p of posts) {
    assert.equal(p.origin, staff.origin,
      'a same-origin POST carries the Origin, exactly, and is still held to it');
    assert.equal(p.contentType, 'application/json',
      'and declares JSON, so the text/plain preflight dodge is still refused');
    assert.notEqual(p.status, 403, 'none of them was refused on provenance');
  }

  await context.close();
  await staff.close();
});

/* ============================================================
   The other half: a genuine cross-site read is still refused,
   and still costs the operator nothing
   ============================================================ */

it('a real cross-site GET is refused before any bucket, Auth call or privileged read', async () => {
  const staff = await startStaffServer();
  const attacker = await startAttackerPage();

  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(`${attacker.origin}/`, { waitUntil: 'domcontentloaded' });

  /* A page on ANOTHER origin doing exactly what the console does. This is the
     attack the gate exists for: a CORS simple request, no preflight to fail. */
  const status = await page.evaluate(async staffOrigin => {
    const res = await fetch(`${staffOrigin}/api/staff/identity-resolution/cases?limit=25&offset=0`, {
      headers: { Accept: 'application/json' }
    });
    return res.status;
  }, staff.origin);

  assert.equal(status, 403, 'the cross-site read was refused');

  const reads = staff.observed.filter(o => o.method === 'GET');
  assert.equal(reads.length, 1, 'the request did reach the server — it was not merely blocked');

  const read = reads[0];
  /* OBSERVED: a cross-site GET carries BOTH, which is exactly why the gate can
     still tell it apart from a same-origin one without an Origin. */
  assert.equal(read.origin, attacker.origin,
    'a cross-site GET does carry an Origin, and it is the attacker\'s');
  assert.equal(read.secFetchSite, 'cross-site',
    'and the browser labels it cross-site, which script cannot forge');
  assert.equal(read.status, 403);

  /* The property the old always-require-Origin rule was protecting, intact. */
  assert.deepEqual(read.dbCalls, [],
    'not one rate-limit bucket, guard, or privileged read was spent on it');
  assert.equal(read.authCalls, 0, 'no Supabase Auth client was built');
  assert.equal(read.tokensVerified, 0, 'no token was verified');

  await context.close();
  await attacker.close();
  await staff.close();
});

it('a cross-site GET that omits Origin cannot exist, but is refused if forged', async () => {
  /* A browser cannot be made to send a cross-site request without an Origin.
     A non-browser client can, so the gate is checked against that shape too —
     here through the real server, over a real socket, with no browser at all. */
  const staff = await startStaffServer();

  const bare = await fetch(`${staff.origin}/api/staff/identity-resolution/cases`, {
    headers: { Accept: 'application/json' }
  });
  assert.equal(bare.status, 403, 'no Origin and no Fetch Metadata is refused');
  assert.equal((await bare.json()).code, 'origin_required');

  const claimed = await fetch(`${staff.origin}/api/staff/identity-resolution/cases`, {
    headers: { Accept: 'application/json', 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(claimed.status, 403);
  assert.equal((await claimed.json()).code, 'origin_not_allowed');

  const sibling = await fetch(`${staff.origin}/api/staff/identity-resolution/cases`, {
    headers: { Accept: 'application/json', 'sec-fetch-site': 'same-site' }
  });
  assert.equal(sibling.status, 403, 'a sibling subdomain is not this origin');
  assert.equal((await sibling.json()).code, 'origin_not_allowed');

  for (const o of staff.observed) {
    assert.deepEqual(o.dbCalls, [], 'none of them spent a bucket');
    assert.equal(o.tokensVerified, 0);
  }

  await staff.close();
});
