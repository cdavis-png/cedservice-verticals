/* ============================================================
   SM-1 — the page, in a real browser, over http://
   ------------------------------------------------------------
   Drives the actual Quick Service Mix Review in headless
   Chrome, served over HTTP by tests/browser/serve.mjs. Not
   file://: the protocol decides whether the config configures a
   submission endpoint at all, so checking the page off disk
   checks a different page.

   WHAT THIS DOES NOT COVER

   No endpoint is running. The page therefore submits to
   /api/assessments and gets a 404, which exercises the
   transport's failure path — offline queueing — rather than a
   successful submission. Everything about identity resolution,
   the Business Record and the stored report is covered by the
   integration and migration suites against real PostgreSQL, not
   here.

   Requires a Chromium-based browser already installed on the
   machine. It downloads nothing. When none is found every test
   skips with the reason, and says so rather than passing
   quietly.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { startServer } from './serve.mjs';

const PAGE = '/verticals/beauty-wellness-fitness/nails/service-mix/site/index.html';
const GROWTH_PAGE = '/verticals/beauty-wellness-fitness/nails/site/index.html';

/* Chromium-based browsers this machine might already have. Nothing is
   downloaded and nothing is installed. */
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
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  puppeteer = null;
}

const SKIP = !executablePath
  ? 'no Chromium-based browser found on this machine'
  : !puppeteer
    ? 'puppeteer-core is not installed'
    : false;

if (SKIP) {
  console.error(`\n  ✖ Browser verification skipped: ${SKIP}\n`);
}

let server = null;
let browser = null;

if (!SKIP) {
  server = await startServer();
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    /* A phone-sized window by default: this page is met on a phone far more
       often than on a desktop, so that is the default under test. */
    defaultViewport: { width: 360, height: 740, isMobile: true, hasTouch: true },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
}

test.after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

const it = (name, fn) => test(name, { skip: SKIP || false }, fn);

/* Opens the page and collects everything the console said. A page that logs
   an error is a page that is broken in a way nobody noticed.

   Each call gets its OWN browser context, so localStorage is empty. Without
   that, every test after the first resumes the previous test's draft — which
   is the save-and-resume feature working correctly and making the tests
   meaningless. The resume test opts back in by reusing one page. */
const openPage = async ({ path = PAGE, viewport = null } = {}) => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  if (viewport) await page.setViewport(viewport);

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const httpErrors = [];

  /* Chrome asks for /favicon.ico whether or not a page names one, and this
     server has none. It is the browser's request, not the page's, and
     counting it would make every page in the repository "broken". */
  const isFavicon = url => url.endsWith('/favicon.ico');

  /* Captured raw. The console message for a failed subresource carries no
     URL, and it can arrive before the response event that would identify it,
     so the correlation happens at assertion time in realConsoleErrors()
     rather than here. */
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => pageErrors.push(String(err)));
  page.on('requestfailed', req => {
    if (!isFavicon(req.url())) failedRequests.push(`${req.method()} ${req.url()}`);
  });
  page.on('response', res => {
    if (res.status() >= 400 && !isFavicon(res.url())) {
      httpErrors.push(`${res.status()} ${res.url()}`);
    } else if (res.status() >= 400) {
      httpErrors.push(res.url());
    }
  });

  await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle0' });

  /* A bare "Failed to load resource" is dropped only when the ONLY thing that
     actually 404'd was the favicon. Any real missing file leaves a non-favicon
     entry in httpErrors and the message stands. */
  const realHttpErrors = () => httpErrors.filter(e => !isFavicon(e));
  const realConsoleErrors = () => consoleErrors.filter(text =>
    !(/Failed to load resource/.test(text) && realHttpErrors().length === 0));

  return {
    page, pageErrors, failedRequests,
    consoleErrors: realConsoleErrors(),
    realConsoleErrors,
    httpErrors: realHttpErrors,
    close: () => context.close()
  };
};

/* Adds an offering by clicking its starter chip. */
const addStarter = (page, name) =>
  page.evaluate(label => {
    const button = [...document.querySelectorAll('.starter')]
      .find(b => b.dataset.starterName === label);
    if (!button) throw new Error(`no starter named ${label}`);
    button.click();
  }, name);

const offeringCount = page =>
  page.$eval('[data-offering-count]', el => Number(el.textContent));

/* Fills every figure for every offering currently listed. */
const fillFigures = (page, { kind = 'exact', price = 60, duration = 60, volume = 40 } = {}) =>
  page.evaluate(({ kind, price, duration, volume }) => {
    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    document.querySelectorAll('.offering-card').forEach(card => {
      card.querySelectorAll('select[id$="-kind"]').forEach(select => {
        select.value = kind;
        fire(select, 'change');
      });
      const set = (suffix, value) => {
        const input = card.querySelector(`input[id$="${suffix}"]`);
        if (input && !input.hidden) { input.value = String(value); fire(input, 'change'); }
      };
      card.querySelectorAll('.measure').forEach(measure => {
        const label = measure.querySelector('.measure-label').textContent;
        const value = /charge/i.test(label) ? price
          : /how long/i.test(label) ? duration
          : volume;
        const single = measure.querySelector('input[id$="-value"]');
        if (single && !single.hidden) { single.value = String(value); fire(single, 'change'); }
        const low = measure.querySelector('input[id$="-low"]');
        const high = measure.querySelector('input[id$="-high"]');
        if (low && !low.hidden) { low.value = String(value * 0.8); fire(low, 'change'); }
        if (high && !high.hidden) { high.value = String(value * 1.2); fire(high, 'change'); }
      });
    });
  }, { kind, price, duration, volume });

const clickAction = (page, action) =>
  page.evaluate(a => document.querySelector(`[data-action="${a}"]`).click(), action);

const visibleStep = page =>
  page.evaluate(() => {
    const step = [...document.querySelectorAll('[data-step]')].find(s => !s.hidden);
    return step ? step.dataset.stepId : null;
  });

/* ---------- 1. it loads ---------- */

it('the page loads over http with no console error and no failed request', async () => {
  const { page, realConsoleErrors, pageErrors, failedRequests, httpErrors, close } = await openPage();

  assert.deepEqual(pageErrors, [], 'an uncaught exception is a broken page');
  assert.deepEqual(realConsoleErrors(), [],
    'a logged error is a page broken in a way nobody noticed');
  assert.deepEqual(failedRequests, [],
    'every script and stylesheet the page names must actually be there');
  assert.deepEqual(httpErrors(), [],
    'and every one of them must actually resolve');

  /* And the engine really is present, not merely requested. */
  const loaded = await page.evaluate(() => ({
    value: Boolean(window.CEDServiceMixValue),
    offering: Boolean(window.CEDServiceMixOffering),
    calculate: Boolean(window.CEDServiceMixCalculate),
    classify: Boolean(window.CEDServiceMixClassify),
    guidance: Boolean(window.CEDServiceMixGuidance),
    controller: Boolean(window.CEDServiceMixController),
    submission: Boolean(window.CEDSubmission),
    analytics: Boolean(window.CEDAnalytics)
  }));
  Object.entries(loaded).forEach(([name, present]) =>
    assert.equal(present, true, `${name} did not load`));
  await close();
});

it('served over http the page configures a submission endpoint; over file:// it does not', async () => {
  const { page, close } = await openPage();
  const endpoint = await page.evaluate(() => window.CED_SERVICE_MIX_CONFIG.submission.endpoint);
  assert.equal(endpoint, '/api/assessments',
    'this is the difference double-clicking the file would have hidden');
  await close();
});

/* ---------- 2. offering limits ---------- */

it('two offerings are accepted and one is refused', async () => {
  const { page, close } = await openPage();
  await clickAction(page, 'start');

  await addStarter(page, 'Gel manicure');
  assert.equal(await offeringCount(page), 1);
  await clickAction(page, 'to-details');
  assert.equal(await visibleStep(page), 'offerings', 'one offering may not proceed');
  const error = await page.$eval('[data-offering-error]', el => el.textContent);
  assert.match(error, /at least 2/i);

  await addStarter(page, 'Pedicure');
  assert.equal(await offeringCount(page), 2);
  await clickAction(page, 'to-details');
  assert.equal(await visibleStep(page), 'figures', 'two offerings may proceed');
  await close();
});

it('five offerings are accepted and a sixth cannot be added at all', async () => {
  const { page, close } = await openPage();
  await clickAction(page, 'start');

  for (const name of ['Basic manicure', 'Gel manicure', 'Acrylic full set', 'Pedicure', 'Nail art']) {
    await addStarter(page, name);
  }
  assert.equal(await offeringCount(page), 5);

  /* Every remaining starter is disabled rather than silently ignored. */
  const remainingEnabled = await page.evaluate(() =>
    [...document.querySelectorAll('.starter')].filter(b => !b.disabled &&
      b.getAttribute('aria-pressed') === 'false').length);
  assert.equal(remainingEnabled, 0, 'the ceiling is visible before it is hit');

  await page.type('#custom-offering-name', 'One too many');
  await clickAction(page, 'add-custom');
  assert.equal(await offeringCount(page), 5, 'a sixth is refused');
  const error = await page.$eval('[data-offering-error]', el => el.textContent);
  assert.match(error, /up to 5/i);

  await clickAction(page, 'to-details');
  assert.equal(await visibleStep(page), 'figures', 'five offerings may proceed');
  await close();
});

/* ---------- 3. starters and custom offerings ---------- */

it('a starter can be added, renamed, and removed', async () => {
  const { page, close } = await openPage();
  await clickAction(page, 'start');
  await addStarter(page, 'Gel manicure');
  await addStarter(page, 'Pedicure');
  await addStarter(page, 'Nail art');

  /* Renaming keeps the offering: the count does not change and the id is the
     same one the engine minted. */
  const before = await page.evaluate(() =>
    window.__controllerIds = null);
  await page.evaluate(() => {
    const input = document.querySelector('.offering-list input');
    input.value = 'Gel set';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const names = await page.$$eval('.offering-list input', els => els.map(e => e.value));
  assert.ok(names.includes('Gel set'), 'the rename is reflected');
  assert.equal(await offeringCount(page), 3, 'renaming is not adding');

  /* And the starter chip for the renamed offering is no longer marked added,
     because the owner has made it something of their own. */
  await page.evaluate(() => {
    const remove = [...document.querySelectorAll('.offering-list button')][0];
    remove.click();
  });
  assert.equal(await offeringCount(page), 2, 'removal takes it out');
  await close();
});

it('a custom offering can be typed in and is kept', async () => {
  const { page, close } = await openPage();
  await clickAction(page, 'start');
  await addStarter(page, 'Gel manicure');

  await page.type('#custom-offering-name', 'Bridal party set');
  await clickAction(page, 'add-custom');

  assert.equal(await offeringCount(page), 2);
  const names = await page.$$eval('.offering-list input', els => els.map(e => e.value));
  assert.ok(names.includes('Bridal party set'));

  const cleared = await page.$eval('#custom-offering-name', el => el.value);
  assert.equal(cleared, '', 'the box is emptied ready for the next one');

  /* An empty name is refused rather than added as a blank row. */
  await clickAction(page, 'add-custom');
  assert.equal(await offeringCount(page), 2);
  const error = await page.$eval('[data-offering-error]', el => el.textContent);
  assert.match(error, /name/i);
  await close();
});

/* ---------- 4. the evidence controls ---------- */

it('each value kind shows the inputs it needs and hides the ones it does not', async () => {
  const { page, close } = await openPage();
  await clickAction(page, 'start');
  await addStarter(page, 'Gel manicure');
  await addStarter(page, 'Pedicure');
  await clickAction(page, 'to-details');

  const shapeFor = kind => page.evaluate(k => {
    const measure = document.querySelector('.offering-card .measure');
    const select = measure.querySelector('select');
    select.value = k;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      single: !measure.querySelector('input[id$="-value"]').hidden,
      low: !measure.querySelector('input[id$="-low"]').hidden,
      high: !measure.querySelector('input[id$="-high"]').hidden
    };
  }, kind);

  assert.deepEqual(await shapeFor('exact'), { single: true, low: false, high: false });
  assert.deepEqual(await shapeFor('estimate'), { single: true, low: false, high: false });
  assert.deepEqual(await shapeFor('range'), { single: false, low: true, high: true });
  assert.deepEqual(await shapeFor('unknown'), { single: false, low: false, high: false },
    '"I do not know" asks for no number, which is the point');
  await close();
});

it('memberships and retail products are not asked for an appointment time at all', async () => {
  const { page, close } = await openPage();
  await clickAction(page, 'start');
  await addStarter(page, 'Memberships');
  await addStarter(page, 'Retail products');
  await addStarter(page, 'Gel manicure');
  await clickAction(page, 'to-details');

  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.offering-card')].map(card => ({
      name: card.querySelector('h3').textContent,
      category: card.querySelector('select[id$="-category"]').value,
      /* The measure headings actually rendered for this offering. */
      measures: [...card.querySelectorAll('.measure-label')].map(l => l.textContent),
      /* And every value-kind option offered, per measure. */
      kinds: [...card.querySelectorAll('select[id$="-kind"]')].map(sel =>
        ({ id: sel.id, options: [...sel.options].map(o => o.value) }))
    })));

  const membership = cards.find(o => o.name === 'Memberships');
  const retail = cards.find(o => o.name === 'Retail products');
  const service = cards.find(o => o.name === 'Gel manicure');

  assert.equal(membership.category, 'membership');
  assert.equal(retail.category, 'retail_product');

  /* OMITTED, not offered with a "does not apply" option. Showing the question
     asks a membership how long it takes, and invites the same answer for a
     manicure where it would be false — and a false not-applicable removes an
     offering from the hours denominator while leaving it in the revenue one. */
  [membership, retail].forEach(offering => {
    assert.equal(offering.measures.some(m => /how long/i.test(m)), false,
      `${offering.name} must not be asked for an appointment time`);
    assert.equal(offering.kinds.some(k => k.id.includes('durationMinutes')), false,
      `${offering.name} must have no duration control at all`);
  });

  /* A real service is asked, and is NOT offered "does not apply" — a manicure
     takes time even when the owner does not know how long. */
  assert.ok(service.measures.some(m => /how long/i.test(m)));
  const serviceDuration = service.kinds.find(k => k.id.includes('durationMinutes'));
  assert.ok(serviceDuration);
  assert.equal(serviceDuration.options.includes('not_applicable'), false);
  assert.ok(serviceDuration.options.includes('unknown'),
    '"I do not know" is the honest answer, and it is offered');

  /* Price and monthly count are asked of everything, and never offered
     "does not apply": a business sells all of it. */
  cards.forEach(offering => {
    ['sellingPrice', 'monthlyVolume'].forEach(measure => {
      const control = offering.kinds.find(k => k.id.includes(measure));
      assert.ok(control, `${offering.name} must be asked for ${measure}`);
      assert.equal(control.options.includes('not_applicable'), false,
        `${offering.name}: ${measure} may never be "does not apply"`);
    });
  });
  await close();
});

/* ---------- 5. a whole review ---------- */

/* `keepPrefilledContact` models the connected visitor who sees their details
   already filled in and submits without retyping them. Typing over a
   prefilled business name or email is how a visitor says "this is not my
   business", so a helper that always types would silently exercise the
   rejection path in every connected test. */
const completeReview = async (page, { keepPrefilledContact = false,
                                      clearContactFirst = false,
                                      stopAtContact = false } = {}) => {
  await clickAction(page, 'start');
  await addStarter(page, 'Gel manicure');
  await addStarter(page, 'Acrylic full set');
  await addStarter(page, 'Nail art');
  await clickAction(page, 'to-details');
  await fillFigures(page);

  await page.evaluate(() => {
    const radio = document.querySelector('#coverage-all_offerings');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clickAction(page, 'to-contact');
  if (stopAtContact) return;

  if (!keepPrefilledContact) {
    if (clearContactFirst) {
      /* What a visitor actually does to a prefilled field that is not theirs:
         select it and type over it. */
      await page.evaluate(() => {
        ['salonName', 'ownerName', 'email'].forEach(id => {
          const input = document.getElementById(id);
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
    }
    await page.type('#salonName', 'Polished Test Salon');
    await page.type('#ownerName', 'Test Owner');
    await page.type('#email', 'owner@polished.test');
  }
  await page.evaluate(() => {
    const box = document.querySelector('#consentResults');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => document.querySelector('[data-contact-form]')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForFunction(
    () => !document.querySelector('[data-step-id="results"]').hidden, { timeout: 15000 });
};

it('a completed review produces a Service Mix result on screen', async () => {
  const { page, pageErrors, close } = await openPage();
  await completeReview(page);

  const results = await page.evaluate(() => ({
    step: [...document.querySelectorAll('[data-step]')].find(s => !s.hidden).dataset.stepId,
    eyebrow: document.querySelector('[data-health-eyebrow]').textContent,
    heading: document.querySelector('[data-health-heading]').textContent,
    confidence: document.querySelector('[data-confidence]').textContent,
    leaders: [...document.querySelectorAll('[data-revenue-leaders] li')].map(li => li.textContent),
    leadersBasis: document.querySelector('[data-revenue-leaders-basis]').textContent,
    capacityBasis: document.querySelector('[data-capacity-basis]').textContent,
    disclaimer: document.querySelector('[data-disclaimer]').textContent,
    delivery: document.querySelector('[data-delivery-note]').textContent
  }));

  assert.equal(results.step, 'results');
  assert.ok(results.heading.length > 10, 'a result, not an empty template');
  assert.match(results.confidence, /Based on 3 of 3 offerings/);
  assert.equal(results.leaders.length, 3);
  assert.match(results.leaders[0], /Gel manicure|Acrylic full set|Nail art/);
  assert.match(results.leadersBasis, /whole business/,
    'coverage was declared all_offerings and every revenue is known');
  assert.match(results.capacityBasis, /not a problem in itself/);

  /* COMPLIANCE: the disclaimer is on screen with the figures. */
  assert.match(results.disclaimer, /diagnostic analysis based on the information provided/);
  assert.match(results.disclaimer, /not a calculation of profit/);

  /* No endpoint is running, so the transport queued it. That is the correct
     behaviour, and the visitor is told plainly. */
  assert.match(results.delivery, /saved on this device|Preview mode|has been received/);
  assert.equal(/on their way|by email|inbox/i.test(results.delivery), false,
    'nothing in this repository sends a message, so nothing may say one is coming');
  assert.deepEqual(pageErrors, []);
  await close();
});

it('the disclaimer stays with the figures rather than scrolling away alone', async () => {
  const { page, close } = await openPage();
  await completeReview(page);

  const geometry = await page.evaluate(() => {
    const results = document.querySelector('[data-step-id="results"]');
    const disclaimer = document.querySelector('[data-disclaimer]');
    const leaders = document.querySelector('[data-revenue-leaders]');
    return {
      insideResults: results.contains(disclaimer),
      visible: disclaimer.offsetParent !== null,
      belowLeaders: disclaimer.getBoundingClientRect().top > leaders.getBoundingClientRect().top,
      text: disclaimer.textContent.trim().length
    };
  });

  assert.equal(geometry.insideResults, true, 'the disclaimer is part of the results, not a footer');
  assert.equal(geometry.visible, true);
  assert.equal(geometry.belowLeaders, true);
  assert.ok(geometry.text > 100);
  await close();
});

/* ---------- 6. save, resume, erase ---------- */

it('a draft survives a reload and is reported as resumed', async () => {
  const { page, close } = await openPage();
  await clickAction(page, 'start');
  await addStarter(page, 'Gel manicure');
  await addStarter(page, 'Pedicure');
  await clickAction(page, 'to-details');
  await fillFigures(page);

  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('cedNailServiceMixReview')));
  assert.equal(before.offerings.length, 2);

  await page.reload({ waitUntil: 'networkidle0' });

  const resumed = await page.evaluate(() => ({
    noteVisible: !document.querySelector('[data-resume-note]').hidden,
    saved: JSON.parse(localStorage.getItem('cedNailServiceMixReview'))
  }));
  assert.equal(resumed.noteVisible, true, 'the visitor is told their work is still there');
  assert.equal(resumed.saved.assessmentSessionId, before.assessmentSessionId,
    'the session id survives, so first-touch attribution is not rewritten');
  assert.deepEqual(resumed.saved.offerings.map(o => o.offeringId),
    before.offerings.map(o => o.offeringId), 'the same offerings, with the same ids');

  /* And the list is rendered from the saved state, not merely held in it. */
  assert.equal(await offeringCount(page), 2);
  await close();
});

it('the delete control removes what the review stored on the device', async () => {
  const { page, close } = await openPage();
  await clickAction(page, 'start');
  await addStarter(page, 'Gel manicure');
  await addStarter(page, 'Pedicure');
  await clickAction(page, 'to-details');
  await fillFigures(page);
  await page.evaluate(() => {
    const radio = document.querySelector('#coverage-all_offerings');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  });

  /* A continuation context from a previous Growth Review, and the review's
     own saved state. Both must go. */
  await page.evaluate(() => localStorage.setItem('ced:continuation', '1.opaque.token'));

  const stored = await page.evaluate(() => ({
    review: localStorage.getItem('cedNailServiceMixReview') !== null,
    continuation: localStorage.getItem('ced:continuation') !== null
  }));
  assert.deepEqual(stored, { review: true, continuation: true });

  await page.evaluate(() => {
    /* The control reloads the page, so the click is made without waiting. */
    window.__reloaded = false;
    document.querySelector('[data-action="clear-data"]').click();
  });
  await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {});

  const after = await page.evaluate(() => ({
    review: localStorage.getItem('cedNailServiceMixReview'),
    continuation: localStorage.getItem('ced:continuation')
  }));
  assert.equal(after.continuation, null, 'a bearer token must not be left behind');
  /* The page mints a fresh session on load, so the key exists again — but it
     holds no offerings. */
  const offerings = after.review ? JSON.parse(after.review).offerings : [];
  assert.deepEqual(offerings, [], 'the entered offerings are gone');
  await close();
});

/* ---------- 7. keyboard and focus ---------- */

it('every control is reachable by keyboard and shows a visible focus ring', async () => {
  const { page, close } = await openPage();

  const reached = await page.evaluate(async () => {
    const seen = [];
    for (let i = 0; i < 12; i++) {
      const active = document.activeElement;
      if (active && active !== document.body) {
        seen.push({ tag: active.tagName, action: active.dataset ? active.dataset.action : null });
      }
      /* Tab is driven by the harness below; this only records. */
      break;
    }
    return seen;
  });

  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    outline: getComputedStyle(document.activeElement, ':focus-visible').outlineWidth
  }));
  assert.notEqual(first.tag, 'BODY', 'Tab must reach something');

  /* Walk the whole start screen and confirm nothing traps focus. */
  const order = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement.tagName));
  }
  assert.ok(order.some(t => t === 'BUTTON'), 'the start button is reachable');
  assert.equal(order.every(t => t === order[0]), false, 'focus moves rather than sticking');

  /* The stylesheet declares a visible ring; assert it is actually applied. */
  const ring = await page.evaluate(() => {
    const button = document.querySelector('[data-action="start"]');
    button.focus();
    const style = getComputedStyle(button);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  assert.notEqual(ring.outlineStyle, 'none', 'focus must be visible, not implied');
  await close();
});

it('focus moves to the step the visitor was sent to', async () => {
  const { page, close } = await openPage();
  await clickAction(page, 'start');

  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    const step = active.closest ? active.closest('[data-step]') : null;
    return {
      isStep: Boolean(active.dataset && active.dataset.stepId),
      stepId: active.dataset ? active.dataset.stepId : (step ? step.dataset.stepId : null)
    };
  });
  assert.equal(focused.stepId, 'offerings',
    'a screen reader must be told the page changed, not left at the top');
  await close();
});

/* ---------- 8. 360px ---------- */

it('nothing overflows horizontally at 360px, on any step', async () => {
  const { page, close } = await openPage({ viewport: { width: 360, height: 740, isMobile: true } });

  const overflow = async label => {
    const result = await page.evaluate(() => {
      const doc = document.documentElement;
      const offenders = [...document.querySelectorAll('body *')]
        .filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          /* The honeypot is deliberately parked far off to the left — that is
             the standard visually-hidden technique and it causes no sideways
             scrolling. Only the RIGHT edge can push the page wider. */
          if (el.closest('.trap')) return false;
          return r.right > doc.clientWidth + 1;
        })
        .slice(0, 5)
        .map(el => `${el.tagName}.${el.className || '(no class)'}`);
      return {
        bodyScrolls: doc.scrollWidth > doc.clientWidth + 1,
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        offenders
      };
    });
    assert.equal(result.bodyScrolls, false,
      `${label}: the page scrolls sideways (${result.scrollWidth} > ${result.clientWidth}); ` +
      `first offenders: ${result.offenders.join(', ')}`);
    assert.deepEqual(result.offenders, [], `${label}: elements escape the viewport`);
  };

  await overflow('intro');
  await clickAction(page, 'start');
  await overflow('offerings');

  await addStarter(page, 'Gel manicure');
  await addStarter(page, 'Acrylic full set');
  await addStarter(page, 'Nail art');
  await overflow('offerings with a list');

  await clickAction(page, 'to-details');
  await overflow('figures');

  await fillFigures(page);
  await page.evaluate(() => {
    const radio = document.querySelector('#coverage-all_offerings');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clickAction(page, 'to-contact');
  await overflow('contact');
  await close();
});

it('tap targets on a phone are at least 44px', async () => {
  const { page, close } = await openPage({ viewport: { width: 360, height: 740, isMobile: true } });
  await clickAction(page, 'start');
  await addStarter(page, 'Gel manicure');

  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button, a.btn, input[type="checkbox"], input[type="radio"]')]
      .filter(el => el.offsetParent !== null)
      .map(el => ({ el: `${el.tagName}.${el.className}`, ...el.getBoundingClientRect().toJSON() }))
      .filter(r => r.height < 22 || r.width < 22)
      .map(r => `${r.el} ${Math.round(r.width)}x${Math.round(r.height)}`));

  assert.deepEqual(small, [], 'a control smaller than this cannot be hit reliably with a thumb');
  await close();
});

/* ---------- 9. the connected review ---------- */

it('the Growth Review results link reaches the Service Mix page', async () => {
  const { page, failedRequests, close } = await openPage({ path: GROWTH_PAGE });

  const href = await page.evaluate(() => {
    const link = [...document.querySelectorAll('a')]
      .find(a => /Where Your Hours Go/i.test(a.textContent));
    return link ? link.getAttribute('href') : null;
  });
  assert.equal(href, '../service-mix/site/index.html');

  const resolved = await page.evaluate(() => {
    const link = [...document.querySelectorAll('a')]
      .find(a => /Where Your Hours Go/i.test(a.textContent));
    return link.href;
  });
  const response = await page.goto(resolved, { waitUntil: 'networkidle0' });
  assert.equal(response.status(), 200, 'the link must reach a real page');

  const heading = await page.$eval('#intro-heading', el => el.textContent);
  assert.match(heading, /See what each service actually earns you/);
  assert.deepEqual(failedRequests.filter(r => !r.includes('/api/')), []);
  await close();
});

it('a stored context is sent as a header, never in the payload, never to analytics', async () => {
  const { page, close } = await openPage();

  /* Whatever another review left in the shared store. The page reads it as an
     opaque string and must never look inside. */
  await page.evaluate(() => window.CEDContinuation.storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Prefilled Salon', ownerName: 'Prefilled Owner', email: 'prefill@polished.test' }
  }));
  await page.reload({ waitUntil: 'networkidle0' });

  /* Capture what the transport is handed, and every analytics envelope. */
  await page.evaluate(() => {
    window.__sent = [];
    window.CEDSubmission.submitAssessment = async (payload, options) => {
      window.__sent.push({
        payload: JSON.parse(JSON.stringify(payload)),
        /* The context is passed as a RESOLVER, read when the request is made,
           so a queued retry hours later gets the context that is current then
           rather than one that expired while it waited. Resolved here, inside
           the page, because a function does not survive serialisation. */
        sentContinuation: typeof options.continuationToken === 'function'
          ? options.continuationToken() : (options.continuationToken || null),
        optionKeys: Object.keys(options)
      });
      return { status: 'sent', ok: true, submissionId: payload.submissionId,
               reviewType: 'service_mix', identityResolved: true,
               continuationToken: 'server.refreshed.token' };
    };
    window.__tracked = [];
    const track = window.CEDAnalytics.track;
    window.CEDAnalytics.track = (name, fields) => {
      window.__tracked.push({ name, fields: JSON.parse(JSON.stringify(fields || {})) });
      return track.call(window.CEDAnalytics, name, fields);
    };
  });

  await completeReview(page, { keepPrefilledContact: true });

  const evidence = await page.evaluate(() => ({
    sent: window.__sent,
    tracked: window.__tracked,
    saved: JSON.parse(localStorage.getItem('cedNailServiceMixReview')),
    stored: JSON.parse(localStorage.getItem('ced:continuation'))
  }));

  assert.equal(evidence.sent.length, 1);
  const { payload, sentContinuation, optionKeys } = evidence.sent[0];

  /* Transmitted as a transport option, which submission.js turns into the
     X-CED-Continuation header. */
  assert.ok(optionKeys.includes('continuationToken'));
  assert.equal(sentContinuation, '1.opaque.growth.token');

  /* And NOWHERE in the payload — the payload becomes the request hash, the
     stored submission and the report. */
  const payloadText = JSON.stringify(payload);
  assert.equal(payloadText.includes('1.opaque.growth.token'), false);
  assert.equal(payloadText.includes('continuationToken'), false);
  assert.equal(payload.continuation, undefined);

  /* Nor in this review's own saved state. */
  assert.equal(JSON.stringify(evidence.saved).includes('1.opaque.growth.token'), false);

  /* Never to analytics, in any event, at any depth. */
  const analyticsText = JSON.stringify(evidence.tracked);
  assert.equal(analyticsText.includes('1.opaque.growth.token'), false,
    'a bearer token must never reach a funnel');
  assert.equal(analyticsText.includes('server.refreshed.token'), false);
  assert.equal(/continuationToken/.test(analyticsText), false);

  /* No offering name, no contact, no Business Record identifier. */
  ['Gel manicure', 'Acrylic full set', 'Nail art', 'Polished Test Salon', 'owner@polished.test']
    .forEach(needle => assert.equal(analyticsText.includes(needle), false,
      `analytics carried ${needle}`));

  const events = await import('../../shared/analytics/events.js');
  const walk = (node, path = '') => {
    if (!node || typeof node !== 'object') return;
    Object.keys(node).forEach(key => {
      assert.equal(events.default.isProhibitedFieldName(key), false,
        `analytics carried a prohibited field at ${path}${key}`);
      walk(node[key], `${path}${key}.`);
    });
  };
  evidence.tracked.forEach(t => walk(t.fields.metadata || {}, `${t.name}.metadata.`));

  /* The refreshed context replaced the old one in the shared store. */
  assert.equal(evidence.stored.token, 'server.refreshed.token');
  await close();
});

it('a connected review does not ask again for contact it already has', async () => {
  const { page, close } = await openPage();

  await page.evaluate(() => window.CEDContinuation.storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Prefilled Salon', ownerName: 'Prefilled Owner', email: 'prefill@polished.test' }
  }));
  await page.reload({ waitUntil: 'networkidle0' });

  const filled = await page.evaluate(() => ({
    salonName: document.getElementById('salonName').value,
    ownerName: document.getElementById('ownerName').value,
    email: document.getElementById('email').value,
    noteVisible: !document.querySelector('[data-prefill-note]').hidden,
    note: document.querySelector('[data-prefill-note]').textContent
  }));

  assert.equal(filled.salonName, 'Prefilled Salon');
  assert.equal(filled.ownerName, 'Prefilled Owner');
  assert.equal(filled.email, 'prefill@polished.test');
  assert.equal(filled.noteVisible, true, 'the visitor is told, and can change any of it');
  assert.match(filled.note, /already completed on this device/);

  /* The report is told which FIELDS were prefilled, never their values. */
  await page.evaluate(() => {
    window.__sent = [];
    window.CEDSubmission.submitAssessment = async payload => {
      window.__sent.push(JSON.parse(JSON.stringify(payload)));
      return { status: 'sent', submissionId: payload.submissionId };
    };
  });
  await completeReview(page, { keepPrefilledContact: true });
  const prefilled = await page.evaluate(() => window.__sent[0].serviceMix.prefilledFields);
  assert.deepEqual(prefilled.sort(), ['email', 'ownerName', 'salonName']);
  await close();
});

it('a saved draft with empty contact keys does not block Growth Review prefill', async () => {
  const { page, close } = await openPage();
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('cedServiceMixReview'));
    saved.contact = { salonName: '', ownerName: '', email: '' };
    localStorage.setItem('cedServiceMixReview', JSON.stringify(saved));
    window.CEDContinuation.storeContinuation({
      token: '1.opaque.growth.token',
      prefill: {
        salonName: 'Continued Salon', ownerName: 'Continued Owner',
        email: 'continued@polished.test'
      }
    });
  });
  await page.reload({ waitUntil: 'networkidle0' });

  const filled = await page.evaluate(() => ({
    salonName: document.getElementById('salonName').value,
    ownerName: document.getElementById('ownerName').value,
    email: document.getElementById('email').value
  }));
  assert.deepEqual(filled, {
    salonName: 'Continued Salon', ownerName: 'Continued Owner',
    email: 'continued@polished.test'
  });
  await close();
});

it('a prefill with no context is never used', async () => {
  const { page, close } = await openPage();
  await page.evaluate(() => localStorage.setItem('ced:continuation',
    JSON.stringify({ v: 1, prefill: { email: 'orphan@polished.test' } })));
  await page.reload({ waitUntil: 'networkidle0' });

  const state = await page.evaluate(() => ({
    email: document.getElementById('email').value,
    noteVisible: !document.querySelector('[data-prefill-note]').hidden
  }));
  assert.equal(state.email, '', 'contact data with no context to bind it is not read');
  assert.equal(state.noteVisible, false);
  await close();
});

it('a double click submits once', async () => {
  const { page, close } = await openPage();

  await page.evaluate(() => {
    window.__sent = [];
    let release;
    window.__release = () => release();
    const held = new Promise(resolve => { release = resolve; });
    window.CEDSubmission.submitAssessment = async payload => {
      window.__sent.push(payload.submissionId);
      await held;
      return { status: 'sent', submissionId: payload.submissionId };
    };
  });

  await clickAction(page, 'start');
  await addStarter(page, 'Gel manicure');
  await addStarter(page, 'Acrylic full set');
  await clickAction(page, 'to-details');
  await fillFigures(page);
  await page.evaluate(() => {
    const radio = document.querySelector('#coverage-all_offerings');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clickAction(page, 'to-contact');
  await page.type('#salonName', 'Polished Test Salon');
  await page.type('#email', 'owner@polished.test');
  await page.evaluate(() => {
    const box = document.querySelector('#consentResults');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });

  /* Two submits, back to back, with the transport still holding the first. */
  await page.evaluate(() => {
    const form = document.querySelector('[data-contact-form]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  const duringFlight = await page.evaluate(() => ({
    sent: window.__sent.length,
    buttonDisabled: document.querySelector('[data-action="submit"]').disabled
  }));
  assert.equal(duringFlight.sent, 1, 'one result, one submission');
  assert.equal(duringFlight.buttonDisabled, true, 'and the button is disabled while it flies');

  await page.evaluate(() => window.__release());
  await page.waitForFunction(
    () => !document.querySelector('[data-step-id="results"]').hidden, { timeout: 15000 });
  await close();
});

it('the delivery note says what actually happened, and promises no email', async () => {
  const { page, close } = await openPage();
  await page.evaluate(() => {
    window.CEDSubmission.submitAssessment = async payload =>
      ({ status: 'sent', submissionId: payload.submissionId });
  });
  await completeReview(page);

  const note = await page.$eval('[data-delivery-note]', el => el.textContent);
  /* There is no tested delivery path in this repository, so the page does not
     claim one. */
  assert.equal(/on their way by email|we have emailed|check your inbox/i.test(note), false,
    'the page must not promise a delivery it cannot make');
  assert.match(note, /saved to your Business Record/i);
  await close();
});


/* ---------- "this is not my business", in a real browser ---------- */

it('rejecting the context clears the fields, the prefill and the token', async () => {
  const { page, pageErrors, close } = await openPage();

  await page.evaluate(() => window.CEDContinuation.storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', ownerName: 'Someone Else',
               email: 'someone@elsewhere.test' }
  }));
  await page.reload({ waitUntil: 'networkidle0' });

  /* Reached the way a visitor reaches it, so the control is actually on
     screen when it is clicked — focus management is only observable there. */
  await completeReview(page, { stopAtContact: true });

  const before = await page.evaluate(() => ({
    offered: !document.querySelector('[data-action="not-my-business"]').hidden,
    salonName: document.getElementById('salonName').value
  }));
  assert.equal(before.offered, true, 'offered only when something was prefilled');
  assert.equal(before.salonName, 'Someone Elses Salon');

  await page.evaluate(() => document.querySelector('[data-action="not-my-business"]').click());

  const after = await page.evaluate(() => ({
    salonName: document.getElementById('salonName').value,
    ownerName: document.getElementById('ownerName').value,
    email: document.getElementById('email').value,
    noteHidden: document.querySelector('[data-prefill-note]').hidden,
    buttonHidden: document.querySelector('[data-action="not-my-business"]').hidden,
    stored: localStorage.getItem('ced:continuation'),
    focused: document.activeElement.id
  }));

  assert.equal(after.salonName, '', "another business's details must not stay in the form");
  assert.equal(after.ownerName, '');
  assert.equal(after.email, '');
  assert.equal(after.noteHidden, true);
  assert.equal(after.buttonHidden, true);
  assert.equal(after.stored, null, 'the token goes with the prefill');
  assert.equal(after.focused, 'salonName', 'and the visitor is put where they now have to type');
  assert.deepEqual(pageErrors, []);
  await close();
});

it('a review completed after rejecting the context sends no context and claims no prefill', async () => {
  const { page, close } = await openPage();

  await page.evaluate(() => window.CEDContinuation.storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', ownerName: 'Someone Else',
               email: 'someone@elsewhere.test' }
  }));
  await page.reload({ waitUntil: 'networkidle0' });

  await page.evaluate(() => {
    window.__sent = [];
    window.CEDSubmission.submitAssessment = async (payload, options) => {
      window.__sent.push({
        payload: JSON.parse(JSON.stringify(payload)),
        sentContinuation: typeof options.continuationToken === 'function'
          ? options.continuationToken(payload) : (options.continuationToken || null)
      });
      return { status: 'sent', submissionId: payload.submissionId };
    };
    document.querySelector('[data-action="not-my-business"]').click();
  });

  await completeReview(page);

  const sent = await page.evaluate(() => window.__sent[0]);
  assert.equal(sent.sentContinuation, null);
  assert.deepEqual(sent.payload.serviceMix.prefilledFields, []);
  assert.equal(JSON.stringify(sent.payload).includes('Someone Elses Salon'), false);
  assert.equal(JSON.stringify(sent.payload).includes('someone@elsewhere.test'), false);
  await close();
});

it('typing a different business over the prefill drops the context by itself', async () => {
  const { page, close } = await openPage();

  await page.evaluate(() => window.CEDContinuation.storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', ownerName: 'Someone Else',
               email: 'someone@elsewhere.test' }
  }));
  await page.reload({ waitUntil: 'networkidle0' });

  await page.evaluate(() => {
    window.__sent = [];
    window.CEDSubmission.submitAssessment = async (payload, options) => {
      window.__sent.push({
        payload: JSON.parse(JSON.stringify(payload)),
        sentContinuation: typeof options.continuationToken === 'function'
          ? options.continuationToken(payload) : (options.continuationToken || null)
      });
      return { status: 'sent', submissionId: payload.submissionId };
    };
  });

  /* The visitor clears the prefilled fields and types their own details —
     saying the same thing as the button, more quietly. */
  await completeReview(page, { clearContactFirst: true });

  const sent = await page.evaluate(() => window.__sent[0]);
  assert.equal(sent.sentContinuation, null,
    'a submission for a different business must not borrow the old token');
  assert.deepEqual(sent.payload.serviceMix.prefilledFields, []);
  assert.equal(sent.payload.contact.salonName, 'Polished Test Salon');
  await close();
});

it('start fresh rotates the assessment session, not just the token', async () => {
  const { page, pageErrors, close } = await openPage();

  await page.evaluate(() => window.CEDContinuation.storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', ownerName: 'Someone Else',
               email: 'someone@elsewhere.test' }
  }));
  await page.reload({ waitUntil: 'networkidle0' });
  await completeReview(page, { stopAtContact: true });

  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('cedNailServiceMixReview')).assessmentSessionId);

  await page.evaluate(() => document.querySelector('[data-action="not-my-business"]').click());

  const after = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('cedNailServiceMixReview'));
    return {
      sessionId: saved.assessmentSessionId,
      submissionId: saved.submissionId,
      fingerprint: saved.submissionFingerprint,
      completedAt: saved.completedAt,
      contact: saved.contact,
      prefilledFields: saved.prefilledFields,
      offerings: saved.offerings.length,
      context: localStorage.getItem('ced:continuation')
    };
  });

  assert.notEqual(after.sessionId, before,
    'the server had already resolved the old session to the previous business');
  assert.equal(after.submissionId, null);
  assert.equal(after.fingerprint, null);
  assert.equal(after.completedAt, null);
  assert.deepEqual(after.contact, {});
  assert.deepEqual(after.prefilledFields, []);
  assert.equal(after.context, null);
  assert.equal(after.offerings, 3, 'the work the visitor did survives');
  assert.deepEqual(pageErrors, []);
  await close();
});

it('a review submitted after start fresh names the new journey', async () => {
  const { page, close } = await openPage();

  await page.evaluate(() => window.CEDContinuation.storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', ownerName: 'Someone Else',
               email: 'someone@elsewhere.test' }
  }));
  await page.reload({ waitUntil: 'networkidle0' });

  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('cedNailServiceMixReview')).assessmentSessionId);

  await page.evaluate(() => {
    window.__sent = [];
    window.CEDSubmission.submitAssessment = async (payload, options) => {
      window.__sent.push({
        payload: JSON.parse(JSON.stringify(payload)),
        sentContinuation: typeof options.continuationToken === 'function'
          ? options.continuationToken(payload) : (options.continuationToken || null)
      });
      return { status: 'sent', submissionId: payload.submissionId };
    };
  });

  await completeReview(page, { stopAtContact: true });
  await page.evaluate(() => document.querySelector('[data-action="not-my-business"]').click());
  await page.type('#salonName', 'Polished Test Salon');
  await page.type('#ownerName', 'Test Owner');
  await page.type('#email', 'owner@polished.test');
  await page.evaluate(() => {
    const box = document.querySelector('#consentResults');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-contact-form]')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(
    () => !document.querySelector('[data-step-id="results"]').hidden, { timeout: 15000 });

  const sent = await page.evaluate(() => window.__sent[0]);
  assert.equal(sent.sentContinuation, null);
  assert.notEqual(sent.payload.assessmentSessionId, original,
    'the payload must not name the journey the visitor just disowned');
  assert.deepEqual(sent.payload.serviceMix.prefilledFields, []);
  await close();
});

it('typing over a prefilled business name rotates the session in the page too', async () => {
  const { page, close } = await openPage();

  await page.evaluate(() => window.CEDContinuation.storeContinuation({
    token: '1.opaque.growth.token',
    prefill: { salonName: 'Someone Elses Salon', ownerName: 'Someone Else',
               email: 'someone@elsewhere.test' }
  }));
  await page.reload({ waitUntil: 'networkidle0' });

  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('cedNailServiceMixReview')).assessmentSessionId);

  await page.evaluate(() => {
    window.__sent = [];
    window.CEDSubmission.submitAssessment = async (payload, options) => {
      window.__sent.push({
        payload: JSON.parse(JSON.stringify(payload)),
        sentContinuation: typeof options.continuationToken === 'function'
          ? options.continuationToken(payload) : (options.continuationToken || null)
      });
      return { status: 'sent', submissionId: payload.submissionId };
    };
  });

  await completeReview(page, { clearContactFirst: true });

  const sent = await page.evaluate(() => window.__sent[0]);
  assert.notEqual(sent.payload.assessmentSessionId, original,
    'the silent path must protect exactly as much as the button');
  assert.equal(sent.sentContinuation, null);
  assert.deepEqual(sent.payload.serviceMix.prefilledFields, []);
  await close();
});
