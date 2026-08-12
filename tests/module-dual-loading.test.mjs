/* ============================================================
   Dual loading — the property the require repair must not break
   ------------------------------------------------------------
   Five shared modules resolved their dependencies through a
   variable:

     const req = name => (typeof module !== 'undefined' && module.exports)
       ? require(name) : null;

   That indirection was not arbitrary. These files are DUAL: the
   server loads them as CommonJS, and the browser loads three of
   them as classic <script> tags, where `require` does not exist.
   A bare literal `require` at module scope would have thrown a
   ReferenceError on the page.

   The repair keeps the guard and moves only the SPECIFIER from a
   variable to a literal, so a tracer can follow it:

     const isCjs = typeof module !== 'undefined' && !!module.exports;
     const x = isCjs ? require('./literal.js')
                     : (typeof window !== 'undefined' ? window.CEDx : null);

   `require` is still evaluated only when isCjs is true, and
   `typeof module` never throws on an undeclared identifier.

   THIS FILE HOLDS BOTH HALVES OF THAT CLAIM:

     · the CommonJS half — each module resolves its real
       dependencies and exposes its real API;
     · the BROWSER half — each browser-loaded module is executed
       in a context with no `module` and no `require` at all, and
       must attach itself to `window` without throwing.

   The browser half is the one that would have caught a careless
   repair, and it is the reason the guard is tested rather than
   trusted. tests/service-mix-*.test.mjs already cover what these
   modules COMPUTE; this file covers how they LOAD.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require_ = createRequire(import.meta.url);

/* The four modules the repair touches downstream of review-registry.js,
   with the global each attaches itself to in a browser. `browser: true`
   marks the three the service-mix page loads as classic scripts — see
   verticals/beauty-wellness-fitness/nails/service-mix/site/index.html. */
const MODULES = [
  { file: 'shared/service-mix-engine/generate-service-mix-bir.js',
    global: 'CEDServiceMixBir', browser: false },
  { file: 'shared/service-mix-engine/calculate.js',
    global: 'CEDServiceMixCalculate', browser: true },
  { file: 'shared/service-mix-engine/classify.js',
    global: 'CEDServiceMixClassify', browser: true },
  { file: 'shared/service-mix-engine/guidance.js',
    global: 'CEDServiceMixGuidance', browser: true }
];

/* ---------- the server half ---------- */

test('each repaired module loads under CommonJS and exposes a real API', () => {
  for (const { file } of MODULES) {
    const loaded = require_(join(ROOT, file));
    assert.equal(typeof loaded, 'object', `${file} exports an object`);
    assert.ok(Object.keys(loaded).length > 0, `${file} exports something`);
  }
});

test('review-registry resolves BOTH engines under CommonJS', () => {
  /* The registry is the routing table: which engine generates, which
     validator checks, which BIR version each produces. If a literal require
     were mistyped, the module would still load and the entry would silently
     be null — so the entries are asserted, not merely the module. */
  const registry = require_(join(ROOT, 'shared/business-intelligence/review-registry.js'));
  const growth = registry.entryFor('growth_review');
  const serviceMix = registry.entryFor('service_mix');

  assert.ok(growth, 'growth_review is registered');
  assert.ok(serviceMix, 'service_mix is registered');
  assert.equal(typeof growth.generate, 'function', 'the Growth generator resolved');
  assert.equal(typeof serviceMix.generate, 'function', 'the Service Mix generator resolved');
  assert.notEqual(growth.generate, serviceMix.generate, 'they are different engines');

  /* The versions the registry is the authority for. Growth stays at 4 and
     Service Mix at 5 — if a mistyped literal left an engine unresolved these
     would be the first things to go wrong. */
  assert.equal(registry.birSchemaVersionFor('growth_review'), 4);
  assert.equal(registry.birSchemaVersionFor('service_mix'), 5);
});

/* ---------- the browser half ---------- */

/* The service-mix engine's classic-script load order, exactly as
   verticals/beauty-wellness-fitness/nails/service-mix/site/index.html lists
   it. Order matters on a page: classify.js reads
   window.CEDServiceMixOffering at module scope, so loading it alone would
   fail for a reason that has nothing to do with `require`. Replicating the
   real sequence is what makes this test about the thing it claims. */
const BROWSER_LOAD_ORDER = [
  'shared/service-mix-engine/value.schema.js',
  'shared/service-mix-engine/offering.schema.js',
  'shared/service-mix-engine/calculate.js',
  'shared/service-mix-engine/classify.js',
  'shared/service-mix-engine/guidance.js'
];

/* A classic-script context: no `module`, no `exports`, no `require`. Nothing
   is provided that a real page would not provide, because the whole point is
   to fail the way a page would fail. */
const freshBrowserContext = () => {
  const windowObj = {};
  return { windowObj, context: vm.createContext({ window: windowObj, globalThis: windowObj, console }) };
};

test('the whole engine loads as classic scripts with no module, no exports and no require', () => {
  const { windowObj, context } = freshBrowserContext();

  for (const file of BROWSER_LOAD_ORDER) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.doesNotThrow(
      () => vm.runInContext(source, context, { timeout: 5000 }),
      `${file} must not throw when loaded as a classic script — `
      + 'an unguarded require() here is a ReferenceError on the page');
  }

  /* And each of the repaired browser modules really attached itself. */
  for (const { file, global } of MODULES.filter(m => m.browser)) {
    assert.ok(windowObj[global], `${file} attaches window.${global} in a browser`);
  }

  /* The context genuinely had no CommonJS: if `module` had leaked in, every
     guard above would have taken the server branch and proved nothing. */
  assert.equal(typeof context.module, 'undefined', 'no module in a browser context');
  assert.equal(typeof context.require, 'undefined', 'no require in a browser context');
});

test('the guard is a typeof check, so an undeclared module identifier cannot throw', () => {
  /* `typeof module` is safe on an undeclared identifier; a bare `module` is
     not. Every repaired file must use the typeof form. */
  const files = [...MODULES.map(m => m.file), 'shared/business-intelligence/review-registry.js'];
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.match(source, /typeof module !== 'undefined'/,
      `${file} guards its require with a typeof check`);
  }
});

test('a require specifier is never assembled from a variable in these modules', () => {
  /* The narrow, file-local restatement of the rule
     tests/function-bundle-contract.test.mjs enforces across the whole traced
     graph. Kept here too so that editing one of these five files fails the
     test that sits next to it. */
  const files = [...MODULES.map(m => m.file), 'shared/business-intelligence/review-registry.js'];
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    assert.equal(/\brequire\s*\(\s*[A-Za-z_$]/.test(source), false,
      `${file} must call require() with a literal path, never a variable`);
  }
});
