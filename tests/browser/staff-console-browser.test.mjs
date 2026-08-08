/* ============================================================
   The staff console, in a real browser
   ------------------------------------------------------------
   The queue is a working surface for a decision that cannot be
   undone: `timeline_events` and `audit_events` refuse UPDATE and
   refuse DELETE, so an attachment made here is permanent. That is
   why the accessibility of the thing matters as much as the SQL
   underneath it — a mislabelled radio button and a missing
   confirmation are how the wrong record gets chosen.

   The page is driven against a STUB API. Nothing here reaches
   Supabase, a database, or the network: the fetch the page makes
   is answered in the page. What is under test is the interface.

   WHAT THIS FILE THEREFORE CANNOT SEE, stated because it once
   mattered a great deal. `window.fetch` is REPLACED below, so no
   request here ever reaches a socket and none of them acquires
   the headers a browser generates — `Origin`, `Sec-Fetch-Site`,
   `Sec-Fetch-Mode`. For a while the route required an `Origin` on
   every request including GET, which no browser sends on a
   same-origin read, and the console could not list or open a
   single case. Every test in this file passed throughout.

   tests/browser/staff-origin-headers.test.mjs exists for exactly
   that gap: it drives this same page over a real socket against
   the real entrypoint and OBSERVES the headers. Assertions about
   request provenance belong there, not here.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { startServer } from './serve.mjs';

const PAGE = '/staff/identity-resolution/index.html';

const CANDIDATES = [
  `${process.env.ProgramFiles || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)'] || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

const executablePath = CANDIDATES.find(p => p && existsSync(p));
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { puppeteer = null; }

const SKIP = !executablePath
  ? 'no Chromium-based browser found on this machine'
  : !puppeteer ? 'puppeteer-core is not installed' : false;

if (SKIP) console.error(`\n  ✖ Staff console verification skipped: ${SKIP}\n`);

let server = null;
let browser = null;
if (!SKIP) {
  server = await startServer();
  browser = await puppeteer.launch({
    executablePath, headless: true,
    defaultViewport: { width: 390, height: 800 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
}

test.after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

const it = (name, fn) => test(name, { skip: SKIP || false }, fn);

const CASE_ID = '22222222-2222-4222-8222-222222222222';
const AGREEING = '33333333-3333-4333-8333-333333333333';
const MERGED = '55555555-5555-4555-8555-555555555555';

/* The case the stub serves. Note what is NOT in it: no raw email, no place
   id, no continuation token, no business id the operator did not need. The
   email arrives already masked, because SQL masked it. */
const CASE_DETAIL = {
  caseId: CASE_ID,
  submissionId: '44444444-4444-4444-8444-444444444444',
  reviewType: 'service_mix',
  confidence: 0.4,
  resolvable: true,
  submitted: {
    label: 'Riverside Barber Co',
    email: 'o***@r***.test',
    mobile: '+********4',
    submittedAt: '2026-08-01T10:00:00.000Z',
    vertical: 'nails'
  },
  conflicts: [{
    kind: 'session_contradicted',
    agreedTypes: [],
    contradictedTypes: ['business_name', 'email_exact'],
    reason: 'The submitted business name and contact evidence match nothing this record holds.'
  }],
  candidates: [
    { businessId: AGREEING, label: 'Polished Nail Studio', mergedAway: false,
      matchedTypes: [], verifiedStrongTypes: [], claimedStrongTypes: [],
      priorReviews: [{ reviewType: 'growth_review', completedCount: 2 }] },
    { businessId: MERGED, label: 'Polished Nail Studio (old site)', mergedAway: true,
      matchedTypes: ['email_domain'], verifiedStrongTypes: [], claimedStrongTypes: [],
      priorReviews: [] }
  ]
};

const QUEUE = {
  ok: true, total: 1, limit: 25, offset: 0,
  cases: [{
    caseId: CASE_ID, createdAt: '2026-08-01T10:00:00.000Z', ageSeconds: 7200,
    resolutionStatus: 'manual_review_required', recommendedAction: 'queue_for_review',
    reviewType: 'service_mix', confidence: 0.4, candidateCount: 2,
    proposalKinds: ['session_contradicted'], agreedTypes: [],
    contradictedTypes: ['business_name', 'email_exact'],
    escalationReason: 'A saved identity proposal was contradicted by submitted identity evidence.',
    submittedLabel: 'Riverside Barber Co', resolvable: true
  }]
};

const OPERATOR = '11111111-1111-4111-8111-111111111111';

/* An access token shaped like the one Supabase issues, so nothing in the page
   has to special-case it. It never leaves the browser in these tests. */
const ACCESS_TOKEN = 'header.eyJhYWwiOiJhYWwyIn0.signature';

/* Installs the stub fetch. `session` scripts what the /session endpoints
   answer, so a test can drive a wrong password or a missing second factor
   through the REAL adapter rather than around it. */
const installStubs = async (page, { queue, detail, postResponses, session } = {}) => {
  await page.evaluateOnNewDocument((q, d, scripted, sessionScript) => {
    /* The page exposes window.CEDStaffConsole only when this is set before
       its script runs. A deployed page never sets it. It carries navigation
       helpers only — there is no test-only sign-in path. */
    window.CED_STAFF_TEST_HARNESS = true;
    window.__posts = [];
    window.__sessionPosts = [];
    window.__scripted = scripted ? scripted.slice() : null;
    window.__sessionScript = sessionScript ? sessionScript.slice() : null;

    const reply = (status, body) => new Response(JSON.stringify(body),
      { status, headers: { 'Content-Type': 'application/json' } });

    window.fetch = async (url, options = {}) => {
      const path = String(url);

      /* The session endpoints. Recorded separately, so the assertions about
         what the console POSTs still count only resolutions. */
      if (/\/session(\/(refresh|signout))?$/.test(path)) {
        const body = JSON.parse(options.body || '{}');
        window.__sessionPosts.push({ path, body });
        if (window.__sessionScript && window.__sessionScript.length) {
          const next = window.__sessionScript.shift();
          return reply(next.status, next.body);
        }
        if (/\/signout$/.test(path)) return reply(200, { ok: true });
        if (/\/refresh$/.test(path)) {
          return reply(200, { ok: true, session: {
            accessToken: 'header.eyJhYWwiOiJhYWwyIn0.refreshed',
            refreshToken: 'refresh-2', expiresAt: 4102444800, userId: '11111111-1111-4111-8111-111111111111'
          } });
        }
        /* The real two-step flow: a password alone asks for a code. */
        if (!body.totp) return reply(200, { ok: true, needsSecondFactor: true });
        return reply(200, { ok: true, session: {
          accessToken: 'header.eyJhYWwiOiJhYWwyIn0.signature',
          refreshToken: 'refresh-1', expiresAt: 4102444800,
          userId: '11111111-1111-4111-8111-111111111111'
        } });
      }

      if (options.method === 'POST') {
        window.__posts.push({ path, body: JSON.parse(options.body || '{}'),
                              auth: (options.headers || {}).Authorization });
        const next = (window.__scripted && window.__scripted.length)
          ? window.__scripted.shift()
          : { status: 201,
              body: { ok: true, resolution: { ok: true, replayed: false, businessId: 'x' } } };
        /* `{ fail: true }` is a request that left the browser and produced no
           answer — a timeout or a dropped connection. It is the ONLY case the
           idempotency key exists for: the operator cannot know whether it
           committed, so the retry has to be able to replay rather than
           arriving as a second, unrelated request. */
        if (next.fail) throw new TypeError('Failed to fetch');
        return reply(next.status, next.body);
      }
      const body = /\/cases\/[0-9a-f-]{36}$/i.test(path) ? { ok: true, case: d } : q;
      return reply(200, body);
    };
  }, queue, detail, postResponses, session);
};

/* Signs in the way an operator does: the real form, the real adapter, the
   real two-step second factor. There is no other way in — the harness has no
   sign-in hook and the production page has no harness at all. */
const signIn = async (page, { email = 'owner@example.test', password = 'correct-horse',
                              totp = '123456', expectSecondFactor = true } = {}) => {
  await page.type('#email', email);
  await page.type('#password', password);
  await page.click('#signin-submit');
  await new Promise(r => setTimeout(r, 120));
  if (!expectSecondFactor) return;
  await page.type('#totp', totp);
  await page.click('#signin-submit');
  await new Promise(r => setTimeout(r, 150));
};

/* Opens the console with a stub fetch installed before any script runs.
   `postResponses` is a queue of {status, body} answered in order, so a test
   can make the server disagree with the page and then agree with it. */
const openConsole = async ({ queue = QUEUE, detail = CASE_DETAIL,
                             postResponses = null, onPost } = {}) => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  /* Chrome asks for /favicon.ico whether or not a page names one, and this
     server has none. It is the browser's request, not the page's — the same
     exclusion the service-mix browser suite makes, for the same reason. */
  const isFaviconNoise = text => /favicon\.ico/.test(text)
    || (/404/.test(text) && /Failed to load resource/.test(text) && !/\.css|\.js/.test(text));
  page.on('console', m => {
    if (m.type() === 'error' && !isFaviconNoise(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('requestfailed', r => {
    if (!/favicon\.ico/.test(r.url())) pageErrors.push(`request failed: ${r.url()}`);
  });
  page.on('response', r => {
    if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) {
      pageErrors.push(`${r.status()} ${r.url()}`);
    }
  });

  await installStubs(page, { queue, detail, postResponses });

  await page.goto(`${server.origin}${PAGE}`, { waitUntil: 'domcontentloaded' });
  await signIn(page);
  void onPost;
  return { page, context, consoleErrors, pageErrors };
};

/* The same page, with no sign-in performed, for the tests that are about
   sign-in itself. */
const openSignIn = async ({ session = null, queue = QUEUE, detail = CASE_DETAIL } = {}) => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await installStubs(page, { queue, detail, session });
  await page.goto(`${server.origin}${PAGE}`, { waitUntil: 'domcontentloaded' });
  return { page, context, pageErrors };
};

it('the console loads the queue without a console error', async () => {
  const { page, context, consoleErrors, pageErrors } = await openConsole();
  const rows = await page.$$eval('#queue-body tr', els => els.length);
  assert.equal(rows, 1);
  const summary = await page.$eval('#queue-summary', el => el.textContent);
  assert.match(summary, /1 open case\./);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  await context.close();
});

it('the empty state says so in words rather than showing an empty table', async () => {
  const { page, context } = await openConsole({
    queue: { ok: true, total: 0, limit: 25, offset: 0, cases: [] } });
  assert.equal(await page.$eval('#queue-table', el => el.hidden), true);
  assert.equal(await page.$eval('#queue-empty', el => el.hidden), false);
  assert.match(await page.$eval('#queue-empty', el => el.textContent), /No open cases/);
  await context.close();
});

it('every control has a label, and the table has a caption and header cells', async () => {
  const { page, context } = await openConsole();
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  const unlabelled = await page.evaluate(() =>
    [...document.querySelectorAll('input, select, textarea')]
      .filter(el => el.type !== 'hidden')
      .filter(el => !(el.id && document.querySelector(`label[for="${el.id}"]`))
                 && !el.getAttribute('aria-label')
                 && !el.closest('label'))
      .map(el => el.id || el.name || el.type));
  assert.deepEqual(unlabelled, [], 'every control needs a label');

  const buttonsWithoutName = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter(b => !b.textContent.trim() && !b.getAttribute('aria-label'))
      .map(b => b.id || b.className));
  assert.deepEqual(buttonsWithoutName, []);

  assert.ok(await page.$('table caption'), 'the queue table has a caption');
  const headers = await page.$$eval('#queue-table thead th',
    els => els.map(e => e.getAttribute('scope')));
  assert.ok(headers.every(s => s === 'col'), 'every header cell declares its scope');
  await context.close();
});

it('the queue is reachable and operable from the keyboard alone', async () => {
  const { page, context } = await openConsole();

  /* Tab until the Open button has focus, then activate it with the keyboard. */
  let reached = false;
  for (let i = 0; i < 25 && !reached; i += 1) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() =>
      document.activeElement && document.activeElement.textContent === 'Open');
  }
  assert.ok(reached, 'the Open control is reachable by tabbing');

  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(await page.$eval('#detail', el => el.hidden), false,
    'Enter opened the case');

  /* Focus moves into the panel that just appeared rather than staying behind. */
  const focused = await page.evaluate(() => document.activeElement.id);
  assert.equal(focused, 'back', 'focus moved into the case');

  /* And going back returns focus to the control that opened it. */
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 150));
  const returned = await page.evaluate(() =>
    document.activeElement && document.activeElement.textContent === 'Open');
  assert.ok(returned, 'focus was restored to the trigger');
  await context.close();
});

it('a merged-away candidate is warned about and cannot be chosen', async () => {
  const { page, context } = await openConsole();
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  assert.equal(await page.$eval('#detail-warn', el => el.hidden), false);
  assert.match(await page.$eval('#detail-warn', el => el.textContent), /merged away/);

  const radios = await page.$$eval('input[name="target"]',
    els => els.map(e => ({ value: e.value, disabled: e.disabled })));
  const merged = radios.find(r => r.value === '55555555-5555-4555-8555-555555555555');
  assert.equal(merged.disabled, true, 'a merged record cannot be selected at all');
  const live = radios.find(r => r.value === '33333333-3333-4333-8333-333333333333');
  assert.equal(live.disabled, false);
  await context.close();
});

it('a contradicting choice demands a reason and an explicit confirmation', async () => {
  const { page, context } = await openConsole();
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  /* Before anything is chosen the override block is not shown. */
  assert.equal(await page.$eval('#override', el => el.hidden), true);

  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await page.$eval('#override', el => el.hidden), false,
    'choosing a contradicting record reveals the override');

  await page.type('#note', 'Checked the address and phone with the owner.');
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 100));
  assert.match(await page.$eval('#detail-error', el => el.textContent), /why this link is correct/);
  assert.equal(await page.evaluate(() => window.__posts.length), 0,
    'nothing was sent without a reason');

  await page.select('#override-reason', 'business_rebrand');
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 100));
  assert.match(await page.$eval('#detail-error', el => el.textContent), /Confirm the override/);
  assert.equal(await page.evaluate(() => window.__posts.length), 0,
    'nothing was sent without the confirmation');

  await page.click('#override-confirm');
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 150));

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.overrideConflict, true);
  assert.equal(posts[0].body.overrideReason, 'business_rebrand');
  assert.match(posts[0].body.resolutionRequestId, /^[0-9a-f-]{36}$/);
  assert.match(posts[0].auth, /^Bearer /);
  assert.match(await page.$eval('#detail-ok', el => el.textContent), /Linked/);
  await context.close();
});

it('other verified evidence demands a fuller explanation', async () => {
  const { page, context } = await openConsole();
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);
  await page.click('#cand-0');
  await page.type('#note', 'Short note here.');
  await page.select('#override-reason', 'other_verified_evidence');
  await page.click('#override-confirm');
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 100));

  assert.match(await page.$eval('#detail-error', el => el.textContent), /at least 40 characters/);
  assert.equal(await page.evaluate(() => window.__posts.length), 0);
  await context.close();
});

it('a case with no candidate says why instead of offering a control that fails', async () => {
  const { page, context } = await openConsole({
    detail: { ...CASE_DETAIL, resolvable: false, candidates: [],
              unsupportedReason: 'This case names no candidate Business Record, so link-to-existing cannot resolve it.' } });
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  assert.equal(await page.$eval('#no-candidates', el => el.hidden), false);
  assert.match(await page.$eval('#no-candidates', el => el.textContent), /names no candidate/);
  assert.equal(await page.$eval('#resolve', el => el.hidden), true,
    'no link button on a case this milestone cannot resolve');
  await context.close();
});

it('no unmasked identifier value is ever present in the page', async () => {
  const { page, context } = await openConsole();
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  const html = await page.content();
  /* The masked forms are expected; the real ones must not appear. */
  assert.ok(html.includes('o***@r***.test'), 'the masked email is what is shown');
  assert.equal(/owner@riverside\.test|someone@riverside\.test/.test(html), false);
  assert.equal(/\+1\d{10}/.test(html), false, 'no full phone number');
  assert.equal(/ChIJ[A-Za-z0-9_-]{10,}/.test(html), false, 'no place id');
  await context.close();
});

it('the page declares itself unindexable and loads its own stylesheet', async () => {
  const { page, context } = await openConsole();
  const robots = await page.$eval('meta[name="robots"]', el => el.content);
  assert.match(robots, /noindex/);
  assert.ok(await page.$('a.skip-link'), 'there is a skip link');
  const styled = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.panel')).borderRadius !== '');
  assert.ok(styled);
  await context.close();
});

it('nothing overflows horizontally at 360px', async () => {
  const { page, context } = await openConsole();
  await page.setViewport({ width: 360, height: 740 });
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `the page scrolls sideways by ${overflow}px`);
  await context.close();
});

it('a proposal-vetoed target is offered, explained, and demands the override', async () => {
  /* The case shape that used to be unresolvable: no candidate at all, one
     record named by a proposal that was set aside. */
  const { page, context } = await openConsole({
    detail: {
      ...CASE_DETAIL,
      resolvable: true,
      candidates: [{
        businessId: AGREEING, label: 'Polished Nail Studio', mergedAway: false,
        provenance: 'proposal_vetoed',
        matchedTypes: [], verifiedStrongTypes: [], claimedStrongTypes: [],
        priorReviews: []
      }]
    }
  });
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  const label = await page.$eval('#candidates label', el => el.textContent);
  assert.match(label, /a saved pointer named it/,
    'the operator is told why this record is on the list');

  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await page.$eval('#override', el => el.hidden), false,
    'a vetoed target is contradicted by definition, so the override is asked for');

  await page.type('#note', 'Confirmed with the owner that the pointer was right.');
  await page.select('#override-reason', 'verified_same_business');
  await page.click('#override-confirm');
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 150));

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.targetBusinessId, AGREEING);
  assert.equal(posts[0].body.overrideConflict, true);
  assert.equal(posts[0].body.overrideReason, 'verified_same_business');
  await context.close();
});

/* ---------- when the page's guess and the server's verdict disagree ----------

   The page guesses whether an override is needed from evidence captured when
   the case was QUEUED. The server decides by re-running the conflict rule
   against the record as it stands NOW. Those two can differ in both
   directions, and before this the operator had no control that could correct
   either one — the case became permanently unresolvable through the only
   surface that can resolve it. */

it('a server material_conflict reveals the override and needs a deliberate resend', async () => {
  /* Two disagreeing proposals: nothing in the case evidence contradicts, so
     the page shows no override — and the server refuses without one. */
  const SECOND = '66666666-6666-4666-8666-666666666666';
  const { page, context } = await openConsole({
    detail: {
      ...CASE_DETAIL,
      conflicts: [{ kind: 'proposals_disagree', agreedTypes: [], contradictedTypes: [],
                    reason: 'The session and the continuation context name different records.' }],
      candidates: [
        { businessId: AGREEING, label: 'Polished Nail Studio', mergedAway: false,
          provenance: 'proposals_disagreed', matchedTypes: [], verifiedStrongTypes: [],
          claimedStrongTypes: [], priorReviews: [] },
        { businessId: SECOND, label: 'Polished Nail Studio North', mergedAway: false,
          provenance: 'proposals_disagreed', matchedTypes: [], verifiedStrongTypes: [],
          claimedStrongTypes: [], priorReviews: [] }
      ]
    },
    postResponses: [
      { status: 409, body: { ok: false, code: 'material_conflict',
                             message: 'the submitted identity contradicts this record' } },
      { status: 201, body: { ok: true, resolution: { ok: true, replayed: false } } }
    ]
  });
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  await page.click('#cand-0');
  await page.type('#note', 'Confirmed with the owner this is the right record.');
  assert.equal(await page.$eval('#override', el => el.hidden), true,
    'the page sees nothing contradicting, so it asks for no override');

  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 150));

  /* One request only. Nothing was resent on the operator's behalf. */
  assert.equal(await page.evaluate(() => window.__posts.length), 1);
  assert.equal(await page.evaluate(() => window.__posts[0].body.overrideConflict), false);

  /* The override is now offered, unanswered, and says why it appeared. */
  assert.equal(await page.$eval('#override', el => el.hidden), false,
    'the server verdict reveals the override the page could not predict');
  assert.equal(await page.$eval('#override-required', el => el.hidden), false);
  assert.match(await page.$eval('#override-required', el => el.textContent), /Nothing has been changed/);
  assert.equal(await page.$eval('#override-reason', el => el.value), '');
  assert.equal(await page.$eval('#override-confirm', el => el.checked), false);
  assert.match(await page.$eval('#detail-error', el => el.textContent), /documented override/);

  /* The note the operator already wrote is still there. */
  assert.match(await page.$eval('#note', el => el.value), /Confirmed with the owner/);

  /* An incomplete resend is still refused locally. */
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await page.evaluate(() => window.__posts.length), 1,
    'still nothing sent without a reason');

  await page.select('#override-reason', 'verified_same_business');
  await page.click('#override-confirm');
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 150));

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 2, 'the operator resent it deliberately');
  assert.equal(posts[1].body.overrideConflict, true);
  assert.equal(posts[1].body.overrideReason, 'verified_same_business');
  assert.match(await page.$eval('#detail-ok', el => el.textContent), /Linked/);
  await context.close();
});

it('a server override_not_applicable withdraws the override and permits a plain retry', async () => {
  /* A vetoed target: the page is certain an override is needed. The record
     has since gained the submitted identifier, so the server says otherwise. */
  const { page, context } = await openConsole({
    detail: {
      ...CASE_DETAIL,
      candidates: [{
        businessId: AGREEING, label: 'Polished Nail Studio', mergedAway: false,
        provenance: 'proposal_vetoed', matchedTypes: [], verifiedStrongTypes: [],
        claimedStrongTypes: [], priorReviews: []
      }]
    },
    postResponses: [
      { status: 422, body: { ok: false, code: 'override_not_applicable',
                             message: 'this link does not contradict the record' } },
      { status: 201, body: { ok: true, resolution: { ok: true, replayed: false } } }
    ]
  });
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await page.$eval('#override', el => el.hidden), false,
    'a vetoed target makes the page ask for an override');

  await page.type('#note', 'Checked the record; it already holds this address.');
  await page.select('#override-reason', 'business_rebrand');
  await page.click('#override-confirm');
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 150));

  assert.equal(await page.evaluate(() => window.__posts.length), 1);
  assert.equal(await page.evaluate(() => window.__posts[0].body.overrideConflict), true);

  /* Withdrawn and cleared, so the next attempt cannot carry it back. */
  assert.equal(await page.$eval('#override', el => el.hidden), true,
    'the override is taken away rather than left to be refused again');
  assert.equal(await page.$eval('#override-reason', el => el.value), '');
  assert.equal(await page.$eval('#override-confirm', el => el.checked), false);
  assert.match(await page.$eval('#detail-error', el => el.textContent), /no override is needed/);

  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 150));

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 2, 'the operator resent it deliberately');
  assert.equal(posts[1].body.overrideConflict, false, 'and without the override this time');
  assert.equal(posts[1].body.overrideReason, null);
  await context.close();
});

it('choosing a different target discards a server verdict about the previous one', async () => {
  const SECOND = '66666666-6666-4666-8666-666666666666';
  const { page, context } = await openConsole({
    detail: {
      ...CASE_DETAIL,
      conflicts: [{ kind: 'proposals_disagree', agreedTypes: [], contradictedTypes: [], reason: 'x' }],
      candidates: [
        { businessId: AGREEING, label: 'Polished Nail Studio', mergedAway: false,
          provenance: 'proposals_disagreed', matchedTypes: [], verifiedStrongTypes: [],
          claimedStrongTypes: [], priorReviews: [] },
        { businessId: SECOND, label: 'Polished Nail Studio North', mergedAway: false,
          provenance: 'proposals_disagreed', matchedTypes: [], verifiedStrongTypes: [],
          claimedStrongTypes: [], priorReviews: [] }
      ]
    },
    postResponses: [
      { status: 409, body: { ok: false, code: 'material_conflict', message: 'contradicts' } }
    ]
  });
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  await page.click('#cand-0');
  await page.type('#note', 'Trying the first record here.');
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(await page.$eval('#override', el => el.hidden), false);

  /* The verdict was about the FIRST record. Choosing the second must not
     inherit it. */
  await page.click('#cand-1');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await page.$eval('#override', el => el.hidden), true,
    'a verdict about one record does not follow the operator to another');
  assert.equal(await page.$eval('#override-required', el => el.hidden), true);
  await context.close();
});

it('an expired session returns the operator to sign-in rather than a dead queue', async () => {
  const { page, context } = await openConsole();
  await page.evaluate(() => {
    window.fetch = async () => new Response(
      JSON.stringify({ ok: false, code: 'unauthenticated', message: 'The access token is not valid.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } });
  });
  await page.evaluate(() => window.CEDStaffConsole.reload());
  await new Promise(r => setTimeout(r, 150));

  assert.equal(await page.$eval('#signin', el => el.hidden), false, 'back at sign-in');
  assert.equal(await page.$eval('#queue', el => el.hidden), true);
  assert.equal(await page.$eval('#who', el => el.hidden), true, 'and no longer named as signed in');
  assert.match(await page.$eval('#signin-error', el => el.textContent), /session has expired/);
  await context.close();
});

it('the test harness seam is absent unless the harness flag was set first', async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  /* No CED_STAFF_TEST_HARNESS, which is what a deployed page looks like. */
  await page.goto(`${server.origin}${PAGE}`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => typeof window.CEDStaffConsole), 'undefined',
    'a deployed page exposes no way to install a session without signing in');
  await context.close();
});

it('two disagreeing proposals are both offered and exactly one is chosen', async () => {
  const SECOND = '66666666-6666-4666-8666-666666666666';
  const { page, context } = await openConsole({
    detail: {
      ...CASE_DETAIL,
      resolvable: true,
      conflicts: [{ kind: 'proposals_disagree', agreedTypes: [], contradictedTypes: [],
                    reason: 'The session and the continuation context name different records.' }],
      candidates: [
        { businessId: AGREEING, label: 'Polished Nail Studio', mergedAway: false,
          provenance: 'proposals_disagreed', matchedTypes: [], verifiedStrongTypes: [],
          claimedStrongTypes: [], priorReviews: [] },
        { businessId: SECOND, label: 'Polished Nail Studio North', mergedAway: false,
          provenance: 'proposals_disagreed', matchedTypes: [], verifiedStrongTypes: [],
          claimedStrongTypes: [], priorReviews: [] }
      ]
    }
  });
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  const labels = await page.$$eval('#candidates label', els => els.map(e => e.textContent));
  assert.equal(labels.length, 2);
  labels.forEach(l => assert.match(l, /one of two saved pointers that disagreed/));

  /* Radio buttons, so choosing the second unchooses the first — exactly one. */
  await page.click('#cand-1');
  await new Promise(r => setTimeout(r, 50));
  const checked = await page.$$eval('input[name="target"]',
    els => els.filter(e => e.checked).map(e => e.value));
  assert.deepEqual(checked, [SECOND], 'exactly one target may be selected');

  /* Nothing contradicts, so no override is demanded. */
  assert.equal(await page.$eval('#override', el => el.hidden), true);

  await page.type('#note', 'Confirmed this is the northern location.');
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 150));

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.targetBusinessId, SECOND);
  assert.equal(posts[0].body.overrideConflict, false);
  await context.close();
});

/* ============================================================
   Sign-in, through the real adapter
   ------------------------------------------------------------
   The console could not sign anybody in: page.js read
   window.CED_STAFF_AUTH and nothing set it, so every attempt
   reached "Staff authentication is not configured in this
   environment." while the runbook said to sign in and confirm
   the queue loaded.

   These drive the real form and the real auth.js against a
   stubbed network. There is no test-only sign-in path to drive
   instead — the harness hook was removed with the defect.
   ============================================================ */

it('the production adapter is present and is what the page uses', async () => {
  const { page, context } = await openSignIn();
  assert.equal(await page.evaluate(() => typeof window.CED_STAFF_AUTH), 'object',
    'auth.js set the global before page.js ran');
  for (const method of ['signIn', 'signOut', 'clear', 'refresh', 'getAccessToken']) {
    assert.equal(await page.evaluate(m => typeof window.CED_STAFF_AUTH[m], method), 'function',
      `the adapter exposes ${method}`);
  }
  /* No Supabase client in the page, and no key of any kind. */
  assert.equal(await page.evaluate(() => typeof window.supabase), 'undefined');
  await context.close();
});

it('a correct password asks for the second factor and issues no token yet', async () => {
  const { page, context } = await openSignIn();
  await page.type('#email', 'owner@example.test');
  await page.type('#password', 'correct-horse');
  assert.equal(await page.$eval('#totp-field', el => el.hidden), true, 'hidden until asked for');

  await page.click('#signin-submit');
  await new Promise(r => setTimeout(r, 150));

  assert.equal(await page.$eval('#totp-field', el => el.hidden), false, 'now shown');
  assert.match(await page.$eval('#signin-error', el => el.textContent), /six-digit code/);
  assert.equal(await page.$eval('#queue', el => el.hidden), true, 'the queue stays closed');
  assert.equal(await page.$eval('#who', el => el.hidden), true, 'and nobody is named as signed in');
  assert.equal(await page.evaluate(() => window.CED_STAFF_AUTH.currentUserId()), null,
    'no session exists at aal1');
  await context.close();
});

it('a correct code opens the queue, and the token goes on the request', async () => {
  const { page, context, pageErrors } = await openSignIn();
  await signIn(page);

  assert.equal(await page.$eval('#signin', el => el.hidden), true, 'the form is gone');
  assert.equal(await page.$eval('#queue', el => el.hidden), false, 'the queue is open');
  assert.equal(await page.$eval('#who-id', el => el.textContent), OPERATOR);
  assert.equal(await page.$$eval('#queue-body tr', els => els.length), 1);

  /* Two session posts: the password step, then the code step. */
  const sessionPosts = await page.evaluate(() => window.__sessionPosts);
  assert.equal(sessionPosts.length, 2);
  assert.equal(sessionPosts[0].body.totp, '');
  assert.equal(sessionPosts[1].body.totp, '123456');
  sessionPosts.forEach(p => assert.match(p.path, /\/api\/staff\/identity-resolution\/session$/));

  /* The password is not left in the DOM once it has been used. */
  assert.equal(await page.$eval('#password', el => el.value), '');
  assert.equal(await page.$eval('#totp', el => el.value), '');

  assert.deepEqual(pageErrors, []);
  await context.close();
});

it('the access token the adapter holds is the one sent to the queue', async () => {
  /* An uncontested case, so the resolution goes through without an override
     and the assertion is about the TOKEN rather than the conflict rules. */
  const { page, context } = await openSignIn({
    detail: {
      ...CASE_DETAIL, conflicts: [],
      candidates: [{ businessId: AGREEING, label: 'Polished Nail Studio', mergedAway: false,
        matchedTypes: ['email_exact'], verifiedStrongTypes: ['email_exact'],
        claimedStrongTypes: [], priorReviews: [] }]
    }
  });
  await signIn(page);
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed by phone with the owner.');
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 200));

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 1, 'exactly one resolution; the session posts are not counted');
  assert.equal(posts[0].auth, `Bearer ${ACCESS_TOKEN}`,
    'the adapter supplied the token, and the page did not invent one');
  await context.close();
});

it('a wrong password says so and keeps the queue shut', async () => {
  const { page, context } = await openSignIn({
    session: [{ status: 401, body: { ok: false, code: 'invalid_credentials',
      message: 'Sign-in failed. Check your details and try again.' } }]
  });
  await page.type('#email', 'owner@example.test');
  await page.type('#password', 'wrong');
  await page.click('#signin-submit');
  await new Promise(r => setTimeout(r, 150));

  assert.match(await page.$eval('#signin-error', el => el.textContent), /Check your details/);
  assert.equal(await page.$eval('#queue', el => el.hidden), true);
  assert.equal(await page.$eval('#signin', el => el.hidden), false);
  assert.equal(await page.$eval('#signin-submit', el => el.disabled), false,
    'the button is usable again, so a typo is not a dead end');
  await context.close();
});

it('an account with no verified authenticator is told who can fix it', async () => {
  const message = 'This account has no verified authenticator app. Ask an owner to complete '
    + 'second-factor enrollment before signing in; identity resolution cannot be used without one.';
  const { page, context } = await openSignIn({
    session: [{ status: 403, body: { ok: false, code: 'mfa_enrollment_required', message } }]
  });
  await page.type('#email', 'newstarter@example.test');
  await page.type('#password', 'correct-horse');
  await page.click('#signin-submit');
  await new Promise(r => setTimeout(r, 150));

  /* Stated separately from "check your details", which would send somebody
     round a loop they cannot get out of. */
  assert.equal(await page.$eval('#signin-enrollment', el => el.hidden), false);
  assert.match(await page.$eval('#signin-enrollment', el => el.textContent), /Ask an owner/);
  assert.equal(await page.$eval('#signin-error', el => el.hidden), true,
    'and not reported as a wrong password');
  assert.equal(await page.$eval('#queue', el => el.hidden), true, 'the queue stays shut');

  /* No enrollment or registration control appears anywhere on the page. */
  const controls = await page.$$eval('button, a', els => els.map(e => e.textContent.trim()));
  assert.equal(controls.some(t => /register|sign up|enroll/i.test(t)), false);
  await context.close();
});

it('a wrong authentication code is refused and can be retyped', async () => {
  const { page, context } = await openSignIn({
    session: [
      { status: 200, body: { ok: true, needsSecondFactor: true } },
      { status: 401, body: { ok: false, code: 'invalid_second_factor',
        message: 'That authentication code was not accepted.' } }
    ]
  });
  await signIn(page, { totp: '000000' });

  assert.equal(await page.$eval('#queue', el => el.hidden), true);
  assert.equal(await page.$eval('#totp-field', el => el.hidden), false,
    'the code field stays open so it can be retyped');
  assert.equal(await page.evaluate(() => window.CED_STAFF_AUTH.currentUserId()), null);
  await context.close();
});

it('an unconfigured deployment says so instead of failing silently', async () => {
  const { page, context } = await openSignIn({
    session: [{ status: 503, body: { ok: false, code: 'auth_unavailable',
      message: 'Staff authentication is not configured.' } }]
  });
  await page.type('#email', 'owner@example.test');
  await page.type('#password', 'correct-horse');
  await page.click('#signin-submit');
  await new Promise(r => setTimeout(r, 150));

  assert.match(await page.$eval('#signin-error', el => el.textContent), /not configured/);
  assert.equal(await page.$eval('#queue', el => el.hidden), true);
  await context.close();
});

it('an expiring token is refreshed before the next request, not after a failure', async () => {
  const { page, context } = await openSignIn({
    session: [
      { status: 200, body: { ok: true, needsSecondFactor: true } },
      /* An access token that expires in ten seconds — inside the refresh skew. */
      { status: 200, body: { ok: true, session: {
        accessToken: ACCESS_TOKEN, refreshToken: 'refresh-1',
        expiresAt: Math.floor(Date.now() / 1000) + 10, userId: OPERATOR } } }
    ]
  });
  await signIn(page);

  /* The first queue load already used the fresh token. Ask again: the adapter
     must refresh first, because the token is inside the skew window. */
  await page.evaluate(() => window.CEDStaffConsole.reload());
  await new Promise(r => setTimeout(r, 200));

  const sessionPosts = await page.evaluate(() => window.__sessionPosts);
  const refreshes = sessionPosts.filter(p => /\/refresh$/.test(p.path));
  assert.equal(refreshes.length, 1, 'exactly one refresh, not one per request');
  assert.equal(refreshes[0].body.refreshToken, 'refresh-1');

  assert.equal(await page.$eval('#queue', el => el.hidden), false, 'and the queue still works');
  const token = await page.evaluate(() => window.CED_STAFF_AUTH.getAccessToken());
  assert.match(token, /refreshed$/, 'the refreshed token replaced the old one');
  await context.close();
});

it('a refused refresh returns the operator to sign-in rather than looping', async () => {
  const { page, context } = await openSignIn({
    session: [
      { status: 200, body: { ok: true, needsSecondFactor: true } },
      { status: 200, body: { ok: true, session: {
        accessToken: ACCESS_TOKEN, refreshToken: 'refresh-1',
        expiresAt: Math.floor(Date.now() / 1000) + 10, userId: OPERATOR } } },
      { status: 401, body: { ok: false, code: 'unauthenticated',
        message: 'This session can no longer be refreshed. Sign in again.' } }
    ]
  });
  /* The token issued is already inside the refresh skew, so the first request
     the console makes has to refresh before sending — and that refresh is the
     one the server refuses. */
  await signIn(page);
  await new Promise(r => setTimeout(r, 250));

  assert.equal(await page.$eval('#signin', el => el.hidden), false, 'back at sign-in');
  assert.equal(await page.$eval('#who', el => el.hidden), true);
  assert.match(await page.$eval('#signin-error', el => el.textContent), /session has expired/);

  const refreshes = await page.evaluate(() =>
    window.__sessionPosts.filter(p => /\/refresh$/.test(p.path)).length);
  assert.equal(refreshes, 1, 'one attempt, then it stops');
  await context.close();
});

it('signing out revokes the refresh token and forgets it locally', async () => {
  const { page, context } = await openSignIn();
  await signIn(page);
  assert.equal(await page.evaluate(() => window.CED_STAFF_AUTH.currentUserId()), OPERATOR);

  await page.click('#sign-out');
  await new Promise(r => setTimeout(r, 200));

  assert.equal(await page.$eval('#signin', el => el.hidden), false);
  assert.equal(await page.$eval('#who', el => el.hidden), true);
  assert.equal(await page.$eval('#queue', el => el.hidden), true);
  assert.equal(await page.evaluate(() => window.CED_STAFF_AUTH.currentUserId()), null,
    'the adapter forgot the session');
  assert.equal(await page.evaluate(() => window.CED_STAFF_AUTH.getAccessToken()), null);

  const signouts = await page.evaluate(() =>
    window.__sessionPosts.filter(p => /\/signout$/.test(p.path)));
  assert.equal(signouts.length, 1, 'the refresh token was revoked server-side too');
  assert.equal(signouts[0].body.refreshToken, 'refresh-1');
  await context.close();
});

it('a 401 clears the session the adapter is holding, not just the screen', async () => {
  const { page, context } = await openSignIn();
  await signIn(page);
  assert.equal(await page.evaluate(() => window.CED_STAFF_AUTH.currentUserId()), OPERATOR);

  await page.evaluate(() => {
    window.fetch = async () => new Response(
      JSON.stringify({ ok: false, code: 'unauthenticated', message: 'The access token is not valid.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } });
  });
  await page.evaluate(() => window.CEDStaffConsole.reload());
  await new Promise(r => setTimeout(r, 200));

  assert.equal(await page.$eval('#signin', el => el.hidden), false, 'back at sign-in');
  assert.equal(await page.evaluate(() => window.CED_STAFF_AUTH.currentUserId()), null,
    'a token the server refused is not kept for a second try');
  await context.close();
});

it('nothing the browser holds is a Supabase credential', async () => {
  const { page, context } = await openSignIn();
  await signIn(page);

  /* Nothing is persisted at all: a reload signs the operator out. */
  const stored = await page.evaluate(() => ({
    local: Object.keys(window.localStorage), session: Object.keys(window.sessionStorage),
    cookie: document.cookie
  }));
  assert.deepEqual(stored.local, [], 'no localStorage');
  assert.deepEqual(stored.session, [], 'no sessionStorage');
  assert.equal(stored.cookie, '', 'no cookie');

  /* And no key of any privilege is reachable from the page's globals. */
  const globals = await page.evaluate(() => JSON.stringify({
    auth: Object.keys(window.CED_STAFF_AUTH),
    api: window.CED_STAFF_API || null
  }));
  for (const forbidden of ['sb_secret_', 'service_role', 'SUPABASE_SECRET', 'SUPABASE_SERVICE']) {
    assert.equal(globals.includes(forbidden), false, `the page exposes ${forbidden}`);
  }
  await context.close();
});

it('the production page has no harness and still signs in', async () => {
  /* No CED_STAFF_TEST_HARNESS and no evaluateOnNewDocument hook of any kind
     beyond the network stub — which is what a deployment looks like from the
     page's point of view. */
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.evaluateOnNewDocument(q => {
    window.fetch = async (url, options = {}) => {
      const path = String(url);
      const reply = (status, body) => new Response(JSON.stringify(body),
        { status, headers: { 'Content-Type': 'application/json' } });
      if (/\/session$/.test(path)) {
        const body = JSON.parse(options.body || '{}');
        if (!body.totp) return reply(200, { ok: true, needsSecondFactor: true });
        return reply(200, { ok: true, session: {
          accessToken: 'header.eyJhYWwiOiJhYWwyIn0.signature', refreshToken: 'r',
          expiresAt: 4102444800, userId: '11111111-1111-4111-8111-111111111111' } });
      }
      return reply(200, q);
    };
  }, QUEUE);

  await page.goto(`${server.origin}${PAGE}`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => typeof window.CEDStaffConsole), 'undefined',
    'a deployed page exposes no console hook at all');
  assert.equal(await page.evaluate(() => typeof window.CED_STAFF_AUTH), 'object',
    'but the real adapter is there');

  await signIn(page);
  assert.equal(await page.$eval('#queue', el => el.hidden), false,
    'and it signs in through the form alone');
  assert.equal(await page.$$eval('#queue-body tr', els => els.length), 1);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

/* ============================================================
   The idempotency key, across a retry the operator chooses to make
   ------------------------------------------------------------
   The page used to mint a UUID inside the submit handler and call it "reused
   verbatim on retry" in a comment. It was not: every press produced a new one,
   so the one case the ledger exists for — a request that timed out, may or may
   not have committed, and is sent again — arrived as a second, unrelated
   request and came back `case_already_resolved` instead of replaying the
   outcome that was actually recorded.
   ============================================================ */

/* Opens a case with one uncontested candidate, so these tests are about the
   request id rather than about the override rules. */
const openSimpleCase = async ({ postResponses = null } = {}) => {
  const { page, context, pageErrors } = await openConsole({
    postResponses,
    detail: {
      ...CASE_DETAIL, conflicts: [],
      candidates: [
        { businessId: AGREEING, label: 'Polished Nail Studio', mergedAway: false,
          matchedTypes: ['email_exact'], verifiedStrongTypes: ['email_exact'],
          claimedStrongTypes: [], priorReviews: [] },
        { businessId: '66666666-6666-4666-8666-666666666666', label: 'Second Studio',
          mergedAway: false, matchedTypes: ['email_exact'], verifiedStrongTypes: ['email_exact'],
          claimedStrongTypes: [], priorReviews: [] }
      ]
    }
  });
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);
  return { page, context, pageErrors };
};

const submitResolution = async page => {
  await page.click('#resolve');
  await new Promise(r => setTimeout(r, 200));
};

const postedIds = page => page.evaluate(() =>
  window.__posts.map(p => p.body.resolutionRequestId));

it('a timeout followed by a manual retry reuses one request id and one payload', async () => {
  const { page, context } = await openSimpleCase({
    postResponses: [
      { fail: true },
      { status: 200, body: { ok: true, resolution: { ok: true, replayed: true, businessId: 'x' } } }
    ]
  });
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed by phone with the owner.');

  await submitResolution(page);
  assert.match(await page.$eval('#detail-error', el => el.textContent), /could not be sent/,
    'the operator is told it failed, and nothing was resent for them');
  assert.equal((await postedIds(page)).length, 1);

  /* The operator presses the button again. Nothing else changed. */
  await submitResolution(page);

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 2, 'two attempts, because the operator made two');
  assert.equal(posts[0].body.resolutionRequestId, posts[1].body.resolutionRequestId,
    'ONE id, so the second arrives as a retry the ledger can replay');
  assert.deepEqual(posts[0].body, posts[1].body, 'and an identical payload');

  assert.match(await page.$eval('#detail-ok', el => el.textContent), /Already resolved/,
    'the replay is reported as the outcome that was recorded');
  await context.close();
});

it('nothing is resent automatically after a failure', async () => {
  const { page, context } = await openSimpleCase({ postResponses: [{ fail: true }] });
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed by phone with the owner.');
  await submitResolution(page);

  /* Wait well past any plausible retry timer. This attaches a review
     permanently; a resend the operator did not ask for is a decision they did
     not take. */
  await new Promise(r => setTimeout(r, 600));
  assert.equal((await postedIds(page)).length, 1, 'exactly one request, ever');
  assert.equal(await page.$eval('#resolve', el => el.disabled), false,
    'and the button is usable again, so the operator can decide');
  await context.close();
});

it('a changed target gets a new request id', async () => {
  const { page, context } = await openSimpleCase({
    postResponses: [{ fail: true }, { fail: true }] });
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed by phone with the owner.');
  await submitResolution(page);

  await page.click('#cand-1');
  await new Promise(r => setTimeout(r, 50));
  await submitResolution(page);

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].body.targetBusinessId, posts[1].body.targetBusinessId);
  assert.notEqual(posts[0].body.resolutionRequestId, posts[1].body.resolutionRequestId,
    'a different record is a different decision and may not inherit the id');
  await context.close();
});

it('a changed note gets a new request id', async () => {
  /* The SERVER's request hash does not cover the note, so reusing the id with
     an edited note would be a legitimate replay by its rule and the new note
     would be silently discarded. The page has to force a new id. */
  const { page, context } = await openSimpleCase({
    postResponses: [{ fail: true }, { fail: true }] });
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed by phone with the owner.');
  await submitResolution(page);

  await page.type('#note', ' Second call confirmed the address too.');
  await submitResolution(page);

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].body.note, posts[1].body.note);
  assert.notEqual(posts[0].body.resolutionRequestId, posts[1].body.resolutionRequestId,
    'an edited note must reach the record, not be replayed away');
  await context.close();
});

it('a changed override decision gets a new request id', async () => {
  /* The case carries no conflict, so the first attempt is an ordinary link and
     the override block is hidden. The SERVER then says the record contradicts
     the submission as it stands now, which is the only thing that can reveal
     the override — and supplying one is a different decision. */
  const { page, context } = await openSimpleCase({
    postResponses: [
      { status: 409, body: { ok: false, code: 'material_conflict',
        message: 'This record contradicts the submission.' } },
      { status: 201, body: { ok: true, resolution: { ok: true, replayed: false, businessId: 'x' } } }
    ]
  });
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed this is the same business after a rebrand.');
  await submitResolution(page);

  /* The server demanded an override. Supplying one changes the decision. */
  assert.equal(await page.$eval('#override', el => el.hidden), false);
  await page.select('#override-reason', 'business_rebrand');
  await page.click('#override-confirm');
  await submitResolution(page);

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.overrideConflict, false);
  assert.equal(posts[1].body.overrideConflict, true);
  assert.notEqual(posts[0].body.resolutionRequestId, posts[1].body.resolutionRequestId,
    'overriding an identity protection is a different decision, and a different id');
  await context.close();
});

it('a success clears the held attempt, so a later decision cannot inherit its id', async () => {
  const { page, context } = await openSimpleCase({
    postResponses: [
      { status: 201, body: { ok: true, resolution: { ok: true, replayed: false, businessId: 'x' } } },
      { status: 201, body: { ok: true, resolution: { ok: true, replayed: false, businessId: 'y' } } }
    ]
  });
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed by phone with the owner.');
  await submitResolution(page);
  assert.match(await page.$eval('#detail-ok', el => el.textContent), /Linked/);

  /* Re-open the same case and make the identical decision again. Because the
     first attempt completed, this is a NEW attempt and gets a new id. */
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);
  await new Promise(r => setTimeout(r, 100));
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed by phone with the owner.');
  await submitResolution(page);

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body.note, posts[1].body.note, 'the same decision');
  assert.notEqual(posts[0].body.resolutionRequestId, posts[1].body.resolutionRequestId,
    'but a finished attempt does not lend its key to the next one');
  await context.close();
});

it('switching cases clears the held attempt', async () => {
  const OTHER_CASE = '77777777-7777-4777-8777-777777777777';
  const { page, context } = await openSimpleCase({
    postResponses: [{ fail: true }, { fail: true }] });
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed by phone with the owner.');
  await submitResolution(page);

  /* The stub answers every case detail with the same body, so the only thing
     that differs is which case was opened. */
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), OTHER_CASE);
  await new Promise(r => setTimeout(r, 100));
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed by phone with the owner.');
  await submitResolution(page);

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].body.resolutionRequestId, posts[1].body.resolutionRequestId,
    'an id belongs to one decision about one case');
  await context.close();
});

it('rapid double-clicking produces one mutation, not two', async () => {
  const { page, context } = await openSimpleCase();
  await page.click('#cand-0');
  await new Promise(r => setTimeout(r, 50));
  await page.type('#note', 'Confirmed by phone with the owner.');

  /* Four clicks as fast as the browser will dispatch them. */
  await page.evaluate(() => {
    const btn = document.getElementById('resolve');
    btn.click(); btn.click(); btn.click(); btn.click();
  });
  await new Promise(r => setTimeout(r, 300));

  const posts = await page.evaluate(() => window.__posts);
  assert.equal(posts.length, 1, 'the control is disabled for the whole flight');
  await context.close();
});

/* ============================================================
   Overlapping refresh
   ------------------------------------------------------------
   Supabase rotates refresh tokens and the old one is consumed by the first
   use, so two concurrent refreshes would mean the second presenting a token
   the first had already spent.
   ============================================================ */

it('concurrent callers produce ONE network refresh and share its result', async () => {
  const soon = Math.floor(Date.now() / 1000) + 10;
  const { page, context } = await openSignIn({
    session: [
      { status: 200, body: { ok: true, needsSecondFactor: true } },
      { status: 200, body: { ok: true, session: {
        accessToken: ACCESS_TOKEN, refreshToken: 'refresh-1',
        expiresAt: soon, userId: OPERATOR } } },
      /* The queue load that follows sign-in refreshes once, because the token
         it was issued is already inside the skew window. This answer keeps it
         inside the window, so the callers below genuinely all need one. */
      { status: 200, body: { ok: true, session: {
        accessToken: 'header.eyJhYWwiOiJhYWwyIn0.first',
        refreshToken: 'refresh-2', expiresAt: soon, userId: OPERATOR } } }
    ]
  });
  await signIn(page);
  await new Promise(r => setTimeout(r, 150));

  /* Everything up to here is setup. Count only what the concurrent block does.
     The probe is deliberately the SYNCHRONOUS accessor: getAccessToken would
     itself start a refresh and land in the window being counted. */
  const before = await page.evaluate(() => {
    window.__sessionPosts.length = 0;
    return window.CED_STAFF_AUTH.currentUserId();
  });
  assert.equal(before, OPERATOR, 'the console is still signed in before the race');

  /* Four callers enter at once: three that want a token and one explicit
     refresh. If the single-flight guard were removed, four requests would go
     out and three would present a refresh token the first had already spent. */
  const outcome = await page.evaluate(async () => {
    const auth = window.CED_STAFF_AUTH;
    const results = await Promise.all([
      auth.getAccessToken(), auth.getAccessToken(),
      auth.refresh(), auth.getAccessToken()
    ]);
    return { tokens: [results[0], results[1], results[3]], refreshed: results[2],
             userId: auth.currentUserId() };
  });

  const refreshes = await page.evaluate(() =>
    window.__sessionPosts.filter(p => /\/refresh$/.test(p.path)));
  assert.equal(refreshes.length, 1,
    'one network refresh, however many callers wanted a token');
  assert.equal(refreshes[0].body.refreshToken, 'refresh-2',
    'and the token in hand was presented exactly once');

  assert.equal(outcome.refreshed, true);
  assert.equal(new Set(outcome.tokens).size, 1, 'every caller got the same token');
  assert.match(outcome.tokens[0], /refreshed$/, 'and it is the rotated one');
  assert.equal(outcome.userId, OPERATOR, 'still the same operator');
  await context.close();
});

it('a refresh that omits a rotated token fails closed rather than reusing the old one', async () => {
  const { page, context } = await openSignIn({
    session: [
      { status: 200, body: { ok: true, needsSecondFactor: true } },
      { status: 200, body: { ok: true, session: {
        accessToken: ACCESS_TOKEN, refreshToken: 'refresh-1',
        expiresAt: Math.floor(Date.now() / 1000) + 10, userId: OPERATOR } } },
      /* A 200 with no refresh_token. The old one has been consumed by the
         server regardless, so keeping it would keep a dead token. */
      { status: 200, body: { ok: true, session: {
        accessToken: 'header.eyJhYWwiOiJhYWwyIn0.new', refreshToken: null,
        expiresAt: 4102444800, userId: OPERATOR } } }
    ]
  });
  await signIn(page);
  await new Promise(r => setTimeout(r, 250));

  assert.equal(await page.evaluate(() => window.CED_STAFF_AUTH.currentUserId()), null,
    'the session was dropped, not half-updated');
  assert.equal(await page.evaluate(() => window.CED_STAFF_AUTH.getAccessToken()), null);
  assert.equal(await page.$eval('#signin', el => el.hidden), false, 'back at sign-in');

  const refreshes = await page.evaluate(() =>
    window.__sessionPosts.filter(p => /\/refresh$/.test(p.path)).length);
  assert.equal(refreshes, 1, 'and it did not try again with the consumed token');
  await context.close();
});

it('a refresh that returns a different user is refused', async () => {
  const { page, context } = await openSignIn({
    session: [
      { status: 200, body: { ok: true, needsSecondFactor: true } },
      { status: 200, body: { ok: true, session: {
        accessToken: ACCESS_TOKEN, refreshToken: 'refresh-1',
        expiresAt: Math.floor(Date.now() / 1000) + 10, userId: OPERATOR } } },
      { status: 200, body: { ok: true, session: {
        accessToken: 'header.eyJhYWwiOiJhYWwyIn0.other', refreshToken: 'refresh-9',
        expiresAt: 4102444800, userId: '99999999-9999-4999-8999-999999999999' } } }
    ]
  });
  await signIn(page);
  await new Promise(r => setTimeout(r, 250));

  assert.equal(await page.evaluate(() => window.CED_STAFF_AUTH.currentUserId()), null,
    'a different subject is not this operator\'s session, however valid it is');
  assert.equal(await page.$eval('#signin', el => el.hidden), false);
  await context.close();
});

it('a case that cannot be resolved offers no note field to fill in', async () => {
  const { page, context } = await openConsole({
    detail: { ...CASE_DETAIL, resolvable: false, candidates: [],
      unsupportedReason: 'This case names no Business Record at all.' } });
  await page.evaluate(id => window.CEDStaffConsole.openCase(id), CASE_ID);

  assert.equal(await page.$eval('#no-candidates', el => el.hidden), false);
  assert.equal(await page.$eval('#resolve', el => el.hidden), true, 'no submit control');
  assert.equal(await page.$eval('#note-field', el => el.hidden), true,
    'and no note field to type an explanation nobody will read');
  assert.equal(await page.$eval('#note', el => el.disabled), true);
  await context.close();
});
