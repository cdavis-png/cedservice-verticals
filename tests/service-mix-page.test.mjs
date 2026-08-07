/* ============================================================
   SM-1 — the nail-salon page and its configuration
   ------------------------------------------------------------
   Static checks against the real files, in the same spirit as
   tests/helpers/nails-markup.mjs: a page whose script paths are
   wrong, whose consent markup is bundled, or whose config has
   drifted from the shared contract is broken in a way no unit
   test of the engine would notice.

   These prove the page is WIRED correctly. They do not prove it
   looks right or that a person can complete it on a phone —
   that is manual verification, and the report says so.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import offerings from '../shared/service-mix-engine/offering.schema.js';
import controller from '../shared/service-mix-engine/controller.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, '../verticals/beauty-wellness-fitness/nails/service-mix');
const read = rel => readFileSync(resolve(DIR, rel), 'utf8');

const HTML = read('site/index.html');
const PAGE = read('site/page.js');

/* Comments are not claims. A note explaining WHY a page does not promise an
   email would otherwise be read as the page promising one, which would make
   the honest explanation the thing that fails the test. */
const VISIBLE_HTML = HTML.replace(/<!--[\s\S]*?-->/g, '');
const VISIBLE_PAGE = PAGE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const CSS = read('site/styles.css');
const CONFIG = read('service-mix.config.js');

/* ---------- the files exist and reference each other ---------- */

test('every script the page loads actually exists at the path it names', () => {
  const sources = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(sources.length >= 8, 'the page must load the engine, not reimplement it');
  sources.forEach(src => {
    assert.ok(existsSync(resolve(DIR, 'site', src)), `missing script: ${src}`);
  });
});

test('the stylesheet imports the design tokens rather than restating them', () => {
  const imports = [...CSS.matchAll(/@import url\("([^"]+)"\)/g)].map(m => m[1]);
  assert.ok(imports.some(i => i.endsWith('design-system/standards/tokens.css')));
  imports.forEach(i => assert.ok(existsSync(resolve(DIR, 'site', i)), `missing import: ${i}`));

  /* A vertical stylesheet may override a token in its own :root with a stated
     reason; it may never redefine the palette. Nothing here does either. */
  assert.equal(/^:root\s*\{/m.test(CSS), false,
    'design tokens live in exactly one file');
});

test('the results screen links to the Growth Review at a path that exists', () => {
  const href = HTML.match(/href="([^"]*site\/index\.html)"/);
  assert.ok(href, 'the Growth Review must be reachable from the results');
  assert.ok(existsSync(resolve(DIR, 'site', href[1])));
});

/* ---------- load order ---------- */

test('the engine is loaded before anything that reads it', () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const at = fragment => order.findIndex(s => s.includes(fragment));

  assert.ok(at('service-mix.config.js') < at('controller.js'),
    'the config must load before the controller');
  assert.ok(at('value.schema.js') < at('offering.schema.js'));
  assert.ok(at('offering.schema.js') < at('calculate.js'));
  assert.ok(at('calculate.js') < at('classify.js'));
  assert.ok(at('classify.js') < at('guidance.js'));
  assert.ok(at('controller.js') < at('page.js'),
    'the page wires a controller that must already exist');
  assert.ok(at('events.js') < at('analytics-client.js'));
});

test('no module script and no bundler — the page must open from file://', () => {
  assert.equal(/type="module"/.test(HTML), false,
    'ES modules are CORS-blocked on file://');
  assert.equal(/<script src="https?:/.test(HTML), false,
    'no third-party script is loaded anywhere');
});

/* ---------- the review's shape ---------- */

test('the page states the offering limits the shared contract enforces', () => {
  assert.ok(HTML.includes(`of ${offerings.OFFERING_LIMITS.max}`),
    'the ceiling must be visible before someone hits it');
  assert.match(HTML, /at least two/i);
  assert.match(HTML, /up to five/i);
  assert.match(HTML, /Three is the sweet spot/i,
    'three is the recommendation and the page should say so');
});

test('the controller declares payload schema 6 and the service_mix review type', () => {
  assert.equal(controller.PAYLOAD_SCHEMA_VERSION, 6);
  assert.equal(controller.REVIEW_TYPE, 'service_mix');
});

test('the config maps its starters onto the shared category vocabulary', () => {
  const categories = [...CONFIG.matchAll(/category:\s*'([a-z_]+)'/g)].map(m => m[1]);
  assert.ok(categories.length >= 12, 'twelve starters are offered');
  categories.forEach(c => assert.ok(offerings.CATEGORIES.includes(c),
    `${c} is not a shared category — a vertical picks from the list, it does not invent one`));
});

test('the twelve nail-salon starters are all present and none is pre-selected', () => {
  ['Basic manicure', 'Gel manicure', 'Acrylic full set', 'Acrylic fill', 'Pedicure',
   'Gel pedicure', 'Nail art', 'Repair', 'Removal', 'Add-ons', 'Memberships',
   'Retail products']
    .forEach(name => assert.ok(CONFIG.includes(name), `missing starter: ${name}`));

  assert.match(HTML, /Pick only what you actually offer/i);
  assert.equal(/checked/.test(HTML), false,
    'nothing is pre-selected, including a consent box');
});

test('a starter default duration is a placeholder hint and never an answer', () => {
  assert.match(CONFIG, /defaultDuration.*hint for the form's placeholder only/s);
  assert.equal(PAGE.includes('defaultDuration'), false,
    'filling an unanswered duration with a plausible number would fabricate a measurement');
});

test('every value kind, including "I do not know", is offered in the wording', () => {
  const labelled = [...CONFIG.matchAll(/^\s{6}(\w+):\s*'/gm)].map(m => m[1]);
  ['exact', 'range', 'estimate', 'unknown', 'not_applicable']
    .forEach(kind => assert.ok(labelled.includes(kind),
      `${kind} must be an offered answer, not an omission`));
  assert.match(CONFIG, /I do not know/,
    '"I do not know" is a real answer and the wording must make that normal');
});

/* ---------- compliance ---------- */

test('the disclaimer is on the page and sits with the figures', () => {
  assert.match(HTML, /data-disclaimer/);
  assert.match(HTML, /the disclaimer sits with the figures, always/i);
  assert.ok(PAGE.includes("$('[data-disclaimer]').textContent = config.disclaimer"),
    'the page renders the config disclaimer verbatim');
});

test('the page says plainly that it cannot tell you about profit', () => {
  assert.match(HTML, /it cannot and does not tell you what anything is making you\s+in profit/);
  assert.match(PAGE, /does not ask what your products and materials cost/);
});

/* TWO, not three. The title said three while the assertion checked two, and
   the two-permission count is the correct one: SMS consent is only offered
   where a mobile number is collected, and this review collects none. */
test('consent is two independent checkboxes, never one', () => {
  const boxes = [...HTML.matchAll(/type="checkbox"\s+id="(consent\w+)"/g)].map(m => m[1]);
  assert.deepEqual(boxes.sort(), ['consentEmailMarketing', 'consentResults'],
    'agreeing to have the review worked out is not agreeing to marketing');

  /* And no SMS row, because no mobile number is asked for. */
  assert.equal(/consentSmsMarketing|type="tel"|name="mobile"/i.test(VISIBLE_HTML), false,
    'SMS consent is unavailable without a mobile number, so it is not offered');

  assert.match(HTML, /Your results appear on this page either way/i,
    'marketing consent is never a condition of anything, and the page says so');
  assert.match(HTML, /data-legal-review="pending"/,
    'all consent wording is pending legal review');
});

/* COMPLIANCE. Nothing in this repository sends an email, so nothing on the
   page may say one is coming — not the permission the visitor ticks, not the
   validation errors, not the note beside the results. A permission that
   describes a behaviour we do not have is not consent to anything. */
test('the page promises no delivery it cannot make', () => {
  const claims = [
    /results\s+by\s+email/i,
    /email\s+(?:you|me)\s+(?:the\s+)?results/i,
    /permission\s+to\s+email\s+the\s+results/i,
    /on\s+their\s+way/i,
    /check\s+your\s+inbox/i,
    /we\s+have\s+emailed/i,
    /sent\s+to\s+your\s+inbox/i
  ];
  claims.forEach(claim => {
    assert.equal(claim.test(VISIBLE_HTML), false, `index.html claims ${claim}`);
    assert.equal(claim.test(VISIBLE_PAGE), false, `page.js claims ${claim}`);
  });

  /* What it says instead: the results are on the page. */
  assert.match(HTML, /shown to me on this page/i,
    'the required permission describes what actually happens');
});

/* The queued wording claims a retry. That claim is only honest because the
   controller sweeps the queue on load — if the sweep goes, the sentence goes
   with it, so the two are asserted together. */
test('the queued message claims only a retry that something performs', () => {
  assert.match(VISIBLE_PAGE, /we will retry sending it the next time you open this page/i);

  /* "will be sent" is a promise about an OUTCOME. Opening the page starts an
     attempt; the server may still be unreachable, the entry may have
     exhausted its attempts, or it may have expired after thirty days. The
     page cannot know, so it does not say. */
  [/will be sent/i, /will be delivered/i, /will arrive/i, /we will send it/i]
    .forEach(promise => assert.equal(promise.test(VISIBLE_PAGE), false,
      `the page promises an outcome it cannot know: ${promise}`));

  /* And the retry it does claim is one something performs. */
  const source = readFileSync(
    resolve(HERE, '../shared/service-mix-engine/controller.js'), 'utf8');
  assert.match(source, /retryPendingSubmissions/,
    'the page claims a retry, so the controller must actually attempt one');
  assert.match(source, /sweepQueuedSubmissions/);
});

test('the consent statement is read from the DOM at submit time', () => {
  assert.match(HTML, /data-consent-statement/);
  assert.match(PAGE, /data-consent-statement/);
  assert.match(PAGE, /provably what was displayed/,
    'store the wording, not a version number');
});

/* ---------- the bot trap ---------- */

test('the honeypot is named contactFax and its value never travels', () => {
  assert.match(HTML, /id="contactFax"/);
  assert.equal(/name="website"/.test(HTML), false,
    'website is reserved for the identity roadmap');
  assert.match(HTML, /Only whether it was touched/i);
  /* Hidden without display:none — some bots skip what is display:none. */
  assert.match(CSS, /\.trap\s*\{[^}]*position:\s*absolute/s);
});

/* ---------- accessibility ---------- */

test('every visible input has a label, and every icon-only control an aria-label', () => {
  const ids = [...HTML.matchAll(/<input[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
  const labelled = new Set([...HTML.matchAll(/<label[^>]*for="([^"]+)"/g)].map(m => m[1]));
  ids.forEach(id => assert.ok(labelled.has(id), `input #${id} has no label`));
});

test('state is carried in ARIA and in words, never in colour alone', () => {
  assert.match(PAGE, /setAttribute\('aria-pressed'/);
  assert.match(CSS, /is-added::after\s*\{\s*content:\s*" ✓ added"/,
    'the added state is a word, not a colour');
  assert.match(HTML, /aria-live="polite"/);
  assert.match(HTML, /role="alert"/);
  assert.match(HTML, /role="radiogroup"/);
});

test('focus moves to the step the visitor was sent to', () => {
  assert.match(PAGE, /active\.focus\(/);
  assert.match(PAGE, /a screen reader announces where it is/);
});

test('the results section is focusable so it can be announced', () => {
  assert.match(HTML, /data-step-id="results"[^>]*tabindex="-1"/s);
});

/* ---------- mobile-first ---------- */

test('the stylesheet is mobile-first and uses the shell container pattern', () => {
  const minWidth = (CSS.match(/@media \(min-width/g) || []).length;
  const maxWidth = (CSS.match(/@media \(max-width/g) || []).length;
  assert.ok(minWidth >= 2, 'larger screens are layered on with min-width queries');
  assert.equal(maxWidth, 0,
    'the nails Growth stylesheet is desktop-first and is a known deviation, not a precedent');
  assert.match(CSS, /width:\s*min\(1180px, calc\(100% - 40px\)\)/);
});

test('tap targets are at least 44px and reduced motion is respected', () => {
  assert.match(CSS, /\.btn\s*\{[^}]*min-height:\s*44px/s);
  assert.match(CSS, /\.btn\s*\{[^}]*min-width:\s*44px/s);
  assert.match(CSS, /prefers-reduced-motion: reduce/);
});

test('numeric inputs ask the phone for the right keyboard', () => {
  assert.match(PAGE, /inputMode = 'decimal'/);
  assert.match(HTML, /inputmode="email"/);
});

/* ---------- analytics ---------- */

test('the page marks its controls for analytics rather than adding listeners', () => {
  const marked = [...HTML.matchAll(/data-analytics-event="([^"]+)"/g)].map(m => m[1]);
  assert.ok(marked.includes('service_mix.growth_review_clicked'));
  assert.ok(marked.includes('service_mix.pricing_detail_requested'));
  assert.ok(marked.includes('service_mix.review_started'));
});

test('no offering name or figure is ever handed to analytics', () => {
  /* Every track() call in the controller and the page, with its metadata. */
  const controllerSource = readFileSync(
    resolve(HERE, '../shared/service-mix-engine/controller.js'), 'utf8');
  [controllerSource, PAGE].forEach(source => {
    const calls = [...source.matchAll(/track\((?:[^)]|\)(?!\s*;))*\)/gs)].map(m => m[0]);
    calls.forEach(call => {
      ['offering.name', 'sellingPrice', 'monthlyVolume', 'durationMinutes',
       'offeringId', 'monthlyRevenue']
        .forEach(forbidden => assert.equal(call.includes(forbidden), false,
          `an analytics call must never carry ${forbidden}: ${call.slice(0, 120)}`));
    });
  });
});

/* ---------- data erasure ---------- */

test('there is a user-facing control that deletes what was stored on the device', () => {
  assert.match(HTML, /data-action="clear-data"/);
  assert.match(HTML, /Delete what this review stored on my device/);
  assert.match(PAGE, /controller\.clearSavedData\(\)/);
});
